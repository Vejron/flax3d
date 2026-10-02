import type { FlightControls, FlightState } from './flight'

export interface RemoteFlight {
    id: number
    flight: Pick<FlightState, 'x' | 'y' | 'z' | 'yaw' | 'bank' | 'speed' | 'flying'>
    spread: number
    flap: boolean
}

type StateEvent = { type: 'state'; id: number; sequence: number; position: RemoteFlight['flight'] & { spread: number; flap: boolean } }
type NetworkEvent = StateEvent | { type: 'welcome' | 'leave'; id: number }

export class FlightNetwork {
    private transport: WebTransport | null = null
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
    private players = new Map<number, { previous: RemoteFlight; current: RemoteFlight; receivedAt: number; sequence: number }>()
    private id: number | null = null
    private sequence = 0
    private stopped = false
    private lastSent = 0

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
        let event: NetworkEvent
        try { event = JSON.parse(new TextDecoder().decode(bytes)) as NetworkEvent } catch { return }
        if (!Number.isSafeInteger(event.id)) return
        if (event.type === 'welcome') {
            this.id = event.id
            this.players.delete(event.id)
        } else if (event.type === 'leave') {
            this.players.delete(event.id)
        } else if (event.type === 'state' && event.id !== this.id && Number.isSafeInteger(event.sequence)) {
            const position = event.position
            if (!position || ![position.x, position.y, position.z, position.yaw, position.bank, position.speed, position.spread].every(Number.isFinite)) return
            const current: RemoteFlight = { id: event.id, flight: position, spread: position.spread, flap: position.flap }
            const last = this.players.get(event.id)
            if (last && event.sequence <= last.sequence) return
            this.players.set(event.id, { previous: last?.current ?? current, current, receivedAt: performance.now(), sequence: event.sequence })
        }
    }

    send(flight: FlightState, input: FlightControls, now: number) {
        if (!this.writer || now - this.lastSent < 100) return
        this.lastSent = now
        const position = {
            x: flight.x, y: flight.y, z: flight.z, yaw: flight.yaw, bank: flight.bank,
            speed: flight.speed, flying: flight.flying, spread: input.spread, flap: input.flap
        }
        void this.writer.write(new TextEncoder().encode(JSON.stringify({ v: 1, sequence: ++this.sequence, position }))).catch(() => this.disconnect())
    }

    remotes(now: number): RemoteFlight[] {
        const result: RemoteFlight[] = []
        for (const [id, player] of this.players) {
            if (now - player.receivedAt > 3000) { this.players.delete(id); continue }
            const fraction = Math.max(0, Math.min(1, (now - player.receivedAt) / 100))
            const previous = player.previous.flight
            const current = player.current.flight
            const angle = Math.atan2(Math.sin(current.yaw - previous.yaw), Math.cos(current.yaw - previous.yaw))
            result.push({
                ...player.current, flight: {
                    ...current,
                    x: previous.x + (current.x - previous.x) * fraction,
                    y: previous.y + (current.y - previous.y) * fraction,
                    z: previous.z + (current.z - previous.z) * fraction,
                    yaw: previous.yaw + angle * fraction,
                    bank: previous.bank + (current.bank - previous.bank) * fraction,
                }
            })
        }
        return result
    }

    private disconnect() {
        if (!this.transport) return
        this.players.clear()
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