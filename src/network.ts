import { decode, encode } from '@msgpack/msgpack'
import type { FlightControls, FlightState } from './flight'
import type { Powerup } from './powerup'

export interface RemoteFlight {
    id: number
    flight: Pick<FlightState, 'x' | 'y' | 'z' | 'yaw' | 'bank' | 'speed' | 'flying' | 'health'> & { wingLeft: number; wingRight: number }
    spread: number
    flap: boolean
    /** True while this peer is holding the trigger; drives a cosmetic shot on each client. */
    fire: boolean
}

export interface WingAngles {
    left: number
    right: number
}

/** Position updates are sent at 20 Hz; remote motion is played back from a buffered history. */
const SEND_INTERVAL_MS = 50
/** Assumed send interval until a second snapshot has been measured. */
const DEFAULT_INTERVAL_MS = 100
/** Render remote motion this many smoothed intervals behind the newest snapshot, so a late or
 *  dropped datagram is absorbed by the buffer instead of stalling or speeding up playback. */
const INTERP_DELAY_INTERVALS = 2
/** Snapshot history kept per player; a few intervals is ample to bracket the render cursor. */
const MAX_SNAPSHOTS = 8
/** A gap this many times the smoothed interval is treated as a dropped datagram, not a slower
 *  sender, so it never widens the render window. */
const LOSS_GAP_FACTOR = 1.5
/** Weight of each accepted arrival gap in the smoothed send interval. */
const INTERVAL_SMOOTHING = 0.1
/** The latency probe is sent once a second; the smoothed round trip is what the HUD shows. */
const PING_INTERVAL_MS = 1000
/** Weight of each new sample in the smoothed latency, so one slow packet barely moves it. */
const LATENCY_SMOOTHING = 0.3

/**
 * Wire format: MessagePack arrays of fixed-point integers, so both languages encode identically and
 * packets stay small. Units are documented in NETWORKING.md and must match `server/src/main.rs`.
 */
const MESSAGE_VERSION = 5
const POSITION_FIELDS = 13
const CM = 100
const MRAD = 1000
/** A tap lasts a single frame, so hold the trigger on for a few updates to survive lost datagrams. */
const FIRE_REPEAT_UPDATES = 3

/** Tag for a client's hit report: `[0, victimId]`, which cannot be confused with an update. */
const MESSAGE_HIT = 0
/** Tag for a client's latency probe: `[1, nonce]`, echoed back by the server as a pong. */
const MESSAGE_PING = 1
/** Tag for a client's pickup report: `[2, slot]`, validated and rebroadcast by the server. */
const MESSAGE_PICKUP = 2

const EVENT_WELCOME = 0
const EVENT_STATE = 1
const EVENT_LEAVE = 2
const EVENT_HIT = 3
const EVENT_PONG = 4
/** A power-up appeared (or reappeared) at a world position, in centimetres. */
const EVENT_POWERUP_SPAWN = 5
/** A power-up was collected; `taker` is the player id that got it. */
const EVENT_POWERUP_TAKEN = 6

const quantize = (value: number, scale: number) => (Number.isFinite(value) ? Math.round(value * scale) : 0)

/** yaw is unbounded locally; wrapping it keeps a 16-bit milliradian field precise. */
const normalizeYaw = (yaw: number) => Math.atan2(Math.sin(yaw), Math.cos(yaw))

/** Keep a measured send interval inside the range a real sender can produce. */
const clampInterval = (ms: number) => Math.min(300, Math.max(40, ms))

type WireValue = number | boolean

function encodePosition(flight: FlightState, input: FlightControls, wings: WingAngles, fire: boolean): WireValue[] {
    return [
        quantize(flight.x, CM), quantize(flight.y, CM), quantize(flight.z, CM),
        quantize(normalizeYaw(flight.yaw), MRAD), quantize(flight.bank, MRAD),
        quantize(flight.speed, CM),
        flight.flying,
        quantize(input.spread, MRAD),
        input.flap,
        quantize(wings.left, MRAD), quantize(wings.right, MRAD),
        fire,
        Math.max(0, Math.min(100, Math.round(flight.health))),
    ]
}

type DecodedPosition = RemoteFlight['flight'] & { spread: number; flap: boolean; fire: boolean }

/** One relayed snapshot, stamped with the local time it arrived. */
interface Snapshot {
    at: number
    remote: RemoteFlight
}

/** Per-player playback state: a short snapshot history plus the smoothed send interval (ms). */
interface RemoteTrack {
    snapshots: Snapshot[]
    interval: number
    sequence: number
    receivedAt: number
}

/** Encodes one position update. Exported so tests can pin the exact wire bytes. */
export function encodeUpdate(sequence: number, flight: FlightState, input: FlightControls, wings: WingAngles, fire: boolean): Uint8Array {
    return encode([MESSAGE_VERSION, sequence, encodePosition(flight, input, wings, fire)])
}

function decodePosition(raw: unknown): DecodedPosition | null {
    if (!Array.isArray(raw) || raw.length !== POSITION_FIELDS) return null
    const numbers = [raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[7], raw[9], raw[10], raw[12]]
    if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value))) return null
    const scale = (index: number, factor: number) => (raw[index] as number) / factor
    return {
        x: scale(0, CM), y: scale(1, CM), z: scale(2, CM),
        yaw: scale(3, MRAD), bank: scale(4, MRAD), speed: scale(5, CM),
        flying: raw[6] === true,
        spread: scale(7, MRAD),
        flap: raw[8] === true,
        wingLeft: scale(9, MRAD), wingRight: scale(10, MRAD),
        fire: raw[11] === true,
        health: Math.max(0, Math.min(100, raw[12] as number)),
    }
}

export class FlightNetwork {
    private transport: WebTransport | null = null
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
    private players = new Map<number, RemoteTrack>()
    private id: number | null = null
    private sequence = 0
    private stopped = false
    private lastSent = 0
    private fireRepeat = 0
    private damagePending = 0
    private lastPingAt = 0
    private pingNonce = 0
    private pendingPing: { nonce: number; sentAt: number } | null = null
    private latency: number | null = null
    /** Live power-ups by slot id, in metres; the server owns their positions and lifecycle. */
    private powerupField = new Map<number, Powerup>()
    /** Slots this client collected since the last drain; only the taker credits ammo. */
    private selfPickups: number[] = []

    constructor(private onStatus: (status: 'CONNECTED' | 'SOLO') => void) { }

    async connect() {
        if (!('WebTransport' in window)) throw new Error('WebTransport is not supported')
        let options: WebTransportOptions = {}
        if (import.meta.env.DEV) {
            const response = await fetch('/local-certificate-hash')
            if (!response.ok) throw new Error('Flight server is unavailable')
            const hash: unknown = await response.json()
            if (!Array.isArray(hash) || hash.length !== 32 || !hash.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
                throw new Error('Invalid flight server certificate hash')
            }
            options = { serverCertificateHashes: [{ algorithm: 'sha-256', value: new Uint8Array(hash) }] }
        }
        if (this.stopped) return
        const url = import.meta.env.DEV ? 'https://127.0.0.1:8698/transport' : `https://${location.hostname}:${location.port || '443'}/transport`
        const connection = new WebTransport(url, options)
        this.transport = connection
        try {
            await connection.ready
            if (this.stopped) { connection.close(); return }
            this.writer = connection.datagrams.writable.getWriter()
            this.onStatus('CONNECTED')
            void this.receive(connection)
            void this.receiveReliable(connection)
            void connection.closed.then(() => { if (this.transport === connection) this.disconnect() }, () => { if (this.transport === connection) this.disconnect() })
        } catch (error) {
            connection.close()
            this.disconnect()
            throw error
        }
    }

    private async receive(connection: WebTransport) {
        const reader = connection.datagrams.readable.getReader()
        try {
            while (!this.stopped) {
                const { value, done } = await reader.read()
                if (done) break
                this.handleEvent(value)
            }
        } catch {
        } finally {
            reader.releaseLock()
            if (this.transport === connection) this.disconnect()
        }
    }

    private async receiveReliable(connection: WebTransport) {
        const reader = connection.incomingUnidirectionalStreams.getReader()
        try {
            while (!this.stopped) {
                const { value, done } = await reader.read()
                if (done) break
                const bytes = await new Response(value).arrayBuffer()
                if (bytes.byteLength <= 512) this.handleEvent(new Uint8Array(bytes))
            }
        } catch {
        } finally {
            reader.releaseLock()
        }
    }

    private handleEvent(bytes: Uint8Array) {
        let message: unknown
        try { message = decode(bytes) } catch { return }
        if (!Array.isArray(message)) return
        if (message[0] === EVENT_WELCOME && message.length === 2 && Number.isSafeInteger(message[1])) {
            this.id = message[1] as number
            this.players.delete(this.id)
        } else if (message[0] === EVENT_LEAVE && message.length === 2 && Number.isSafeInteger(message[1])) {
            this.players.delete(message[1] as number)
        } else if (message[0] === EVENT_HIT && message.length === 3 && message[2] === this.id) {
            // The server stamps the shooter id; we only care that we are the victim. The victim owns
            // its own health, so damage is applied here rather than by the shooter.
            this.damagePending += 1
        } else if (message[0] === EVENT_PONG && message.length === 2 && Number.isSafeInteger(message[1])) {
            // Our own nonce comes back, so the elapsed time is the full round trip. A stale pong (the
            // nonce does not match the packet in flight) is ignored.
            if (this.pendingPing && message[1] === this.pendingPing.nonce) {
                const rtt = Math.max(0, performance.now() - this.pendingPing.sentAt)
                this.latency = this.latency === null ? rtt : this.latency * (1 - LATENCY_SMOOTHING) + rtt * LATENCY_SMOOTHING
                this.pendingPing = null
            }
        } else if (message[0] === EVENT_POWERUP_SPAWN && message.length === 5) {
            const [slot, x, y, z] = [message[1], message[2], message[3], message[4]]
            if (![slot, x, y, z].every((value) => typeof value === 'number' && Number.isFinite(value))) return
            const id = slot as number
            this.powerupField.set(id, { slot: id, x: (x as number) / CM, y: (y as number) / CM, z: (z as number) / CM })
        } else if (message[0] === EVENT_POWERUP_TAKEN && message.length === 3) {
            const slot = message[1]
            const taker = message[2]
            if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(taker)) return
            this.powerupField.delete(slot as number)
            // Everyone clears the pickup from the field; only the taker gains the rounds.
            if (taker === this.id) this.selfPickups.push(slot as number)
        } else if (message[0] === EVENT_STATE && message.length === 4) {
            const id = message[1]
            const sequence = message[2]
            if (!Number.isSafeInteger(id) || id === this.id || !Number.isSafeInteger(sequence)) return
            const position = decodePosition(message[3])
            if (!position) return
            const playerId = id as number
            const now = performance.now()
            let track = this.players.get(playerId)
            if (!track) {
                track = { snapshots: [], interval: DEFAULT_INTERVAL_MS, sequence: -1, receivedAt: now }
                this.players.set(playerId, track)
            }
            if (track.snapshots.length > 0 && (sequence as number) <= track.sequence) return
            if (track.snapshots.length > 0) {
                const gap = now - track.receivedAt
                // A gap far wider than the smoothed interval means a datagram was lost, not that the
                // sender slowed down; folding it in would halve the playback rate for the next window.
                // The first measured gap is trusted outright so playback reaches the right rate at once.
                if (gap <= track.interval * LOSS_GAP_FACTOR) {
                    track.interval = track.snapshots.length === 1
                        ? clampInterval(gap)
                        : clampInterval(track.interval * (1 - INTERVAL_SMOOTHING) + gap * INTERVAL_SMOOTHING)
                }
            }
            track.sequence = sequence as number
            track.receivedAt = now
            track.snapshots.push({
                at: now,
                remote: { id: playerId, flight: position, spread: position.spread, flap: position.flap, fire: position.fire },
            })
            if (track.snapshots.length > MAX_SNAPSHOTS) track.snapshots.shift()
        }
    }

    send(flight: FlightState, input: FlightControls, wings: WingAngles, now: number, fire = false) {
        if (!this.writer || now - this.lastSent < SEND_INTERVAL_MS) return
        this.lastSent = now
        // Datagrams are unreliable and sent at 20 Hz, so a one-frame trigger pull is repeated
        // across a few updates; otherwise remote clients would miss most single shots.
        if (fire) this.fireRepeat = FIRE_REPEAT_UPDATES
        const shot = fire || this.fireRepeat > 0
        if (this.fireRepeat > 0) this.fireRepeat -= 1
        const message = encodeUpdate(++this.sequence, flight, input, wings, shot)
        void this.writer.write(message).catch(() => this.disconnect())
        if (now - this.lastPingAt >= PING_INTERVAL_MS) {
            // Probe the round trip so the HUD can show a smoothed latency. Like everything else this
            // rides a datagram, so loss just costs one sample and the next probe covers it.
            this.lastPingAt = now
            this.pingNonce = (this.pingNonce + 1) >>> 0
            this.pendingPing = { nonce: this.pingNonce, sentAt: now }
            void this.writer.write(encode([MESSAGE_PING, this.pingNonce])).catch(() => this.disconnect())
        }
    }

    /**
     * Reports that one of this client's rounds struck `victimId`. The server relays it to the
     * victim, which applies the damage — so no health value is ever trusted from a shooter.
     */
    reportHit(victimId: number) {
        if (!this.writer || !Number.isSafeInteger(victimId) || victimId === this.id) return
        void this.writer.write(encode([MESSAGE_HIT, victimId])).catch(() => this.disconnect())
    }

    /** Hits taken since the last call; the caller converts them into damage. */
    takeDamage() {
        const received = this.damagePending
        this.damagePending = 0
        return received
    }

    /**
     * Reports flying into power-up `slot`. The server validates the claim and rebroadcasts a
     * `taken` event, so the pickup only lands (and only credits ammo) once it is confirmed.
     */
    reportPickup(slot: number) {
        if (!this.writer || !Number.isSafeInteger(slot) || slot < 0) return
        void this.writer.write(encode([MESSAGE_PICKUP, slot])).catch(() => this.disconnect())
    }

    /** Live power-ups on the field, in metres. A fresh array, so the caller may keep it. */
    powerups(): Powerup[] {
        return [...this.powerupField.values()]
    }

    /** Slots this client collected since the last call; the caller adds the rounds. */
    takePickups(): number[] {
        if (!this.selfPickups.length) return []
        const taken = this.selfPickups
        this.selfPickups = []
        return taken
    }

    /** Smoothed round-trip time to the server in whole milliseconds, or null before the first pong. */
    get latencyMs(): number | null {
        return this.latency === null ? null : Math.round(this.latency)
    }

    remotes(now: number): RemoteFlight[] {
        const result: RemoteFlight[] = []
        for (const [id, track] of this.players) {
            if (now - track.receivedAt > 3000) { this.players.delete(id); continue }
            const snapshots = track.snapshots
            if (snapshots.length === 0) continue
            // Play the buffer back a couple of intervals behind the newest snapshot. That jitter
            // margin is what keeps a late, bursty or dropped datagram from freezing the motion or
            // making it race to catch up; the cost is the same delay on every remote avatar.
            const renderTime = now - track.interval * INTERP_DELAY_INTERVALS
            let older = snapshots[0]!
            let newer = snapshots[Math.min(1, snapshots.length - 1)]!
            for (let index = 0; index < snapshots.length - 1; index++) {
                if (snapshots[index]!.at > renderTime) break
                older = snapshots[index]!
                newer = snapshots[index + 1]!
            }
            const span = newer.at - older.at
            const fraction = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.at) / span)) : 1
            const previous = older.remote.flight
            const current = newer.remote.flight
            const angle = Math.atan2(Math.sin(current.yaw - previous.yaw), Math.cos(current.yaw - previous.yaw))
            result.push({
                ...newer.remote, flight: {
                    ...current,
                    x: previous.x + (current.x - previous.x) * fraction,
                    y: previous.y + (current.y - previous.y) * fraction,
                    z: previous.z + (current.z - previous.z) * fraction,
                    yaw: previous.yaw + angle * fraction,
                    bank: previous.bank + (current.bank - previous.bank) * fraction,
                    wingLeft: previous.wingLeft + (current.wingLeft - previous.wingLeft) * fraction,
                    wingRight: previous.wingRight + (current.wingRight - previous.wingRight) * fraction,
                }
            })
        }
        return result
    }

    private disconnect() {
        if (!this.transport) return
        this.players.clear()
        this.powerupField.clear()
        this.selfPickups.length = 0
        this.damagePending = 0
        this.latency = null
        this.pendingPing = null
        this.lastPingAt = 0
        try { this.writer?.releaseLock() } catch { /* Pending writes settle on transport close. */ }
        this.writer = null
        this.transport.close()
        this.transport = null
        this.id = null
        this.onStatus('SOLO')
    }

    close() {
        this.stopped = true
        this.transport?.close()
        this.disconnect()
    }
}