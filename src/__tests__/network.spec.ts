import { describe, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

import { initialFlightState } from '../flight'
import { encodeTankUpdate, encodeUpdate, FlightNetwork } from '../network'
import { initialTankState } from '../tank'

/**
 * Pins the exact bytes the server must decode. The matching Rust test is
 * `decodes_a_client_update_fixture` in `server/src/main.rs`; keep the two in sync.
 */
const FIXTURE = [
    147, 6, 7, 220, 0, 18, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 0, 209,
    254, 32, 205, 5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82, 0, 0, 0, 0, 195, 100,
]

/** The same contract for a tank update; the Rust counterpart is `decodes_a_client_tank_fixture`. */
const TANK_FIXTURE = [
    147, 6, 9, 220, 0, 18, 205, 8, 2, 205, 1, 69, 209, 240, 21, 209, 251, 80, 1, 0, 209,
    254, 162, 194, 205, 3, 232, 194, 0, 0, 205, 2, 88, 205, 1, 94, 120, 208, 186, 195, 100,
]

describe('FlightNetwork wire format', () => {
    it('encodes a position update as a fixed-point MessagePack array', () => {
        const flight = {
            ...initialFlightState(0),
            x: 12.34, y: -45.5, z: 9, yaw: 1.571, bank: -0.48, speed: 15, flying: true,
        }
        const bytes = encodeUpdate(7, flight, { flap: false, steer: 0, spread: 1 }, { left: -0.25, right: 0.85 }, true)
        expect(Array.from(bytes)).toEqual(FIXTURE)
    })

    it('carries the trigger flag just before the health field', () => {
        const flight = initialFlightState(0)
        const input = { flap: false, steer: 0, spread: 1 }
        const wings = { left: 0, right: 0 }
        const held = (decode(encodeUpdate(1, flight, input, wings, true)) as [number, number, number[]])[2]!
        const idle = (decode(encodeUpdate(1, flight, input, wings, false)) as [number, number, number[]])[2]!
        expect(held).toHaveLength(18)
        expect(held[16]).toBe(true)
        expect(idle[16]).toBe(false)
    })

    it('tags a bird update with kind 0 and a tank update with kind 1', () => {
        const bird = (decode(encodeUpdate(1, initialFlightState(0), { flap: false, steer: 0, spread: 1 }, { left: 0, right: 0 }, false)) as [number, number, number[]])[2]!
        const tank = (decode(encodeTankUpdate(1, initialTankState(0), false)) as [number, number, number[]])[2]!
        expect(bird[4]).toBe(0)
        expect(tank[4]).toBe(1)
    })

    it('clamps health into the last position field', () => {
        const flight = { ...initialFlightState(0), health: 40 }
        const input = { flap: false, steer: 0, spread: 1 }
        const wings = { left: 0, right: 0 }
        const position = (decode(encodeUpdate(1, flight, input, wings, false)) as [number, number, number[]])[2]!
        expect(position[17]).toBe(40)
        const overcharged = (decode(encodeUpdate(1, { ...flight, health: 250 }, input, wings, false)) as [number, number, number[]])[2]!
        expect(overcharged[17]).toBe(100)
    })

    it('encodes a tank update as a signed fixed-point MessagePack array', () => {
        const tank = {
            ...initialTankState(0),
            x: 20.5, y: 3.25, z: -40.75, hullYaw: -1.2,
            turretYaw: 0.6, turretPitch: 0.35, hullPitch: 0.12, hullRoll: -0.07, speed: -3.5,
        }
        expect(Array.from(encodeTankUpdate(9, tank, true))).toEqual(TANK_FIXTURE)
    })

    it('reports hits and only takes damage addressed to this client', () => {
        const network = new FlightNetwork(() => { })
        const sent: number[][] = []
        ;(network as unknown as { writer: { write: (bytes: Uint8Array) => Promise<void> } }).writer = {
            write: async (bytes: Uint8Array) => { sent.push(decode(bytes) as number[]) },
        }
        network.reportHit(9)
        expect(sent).toEqual([[0, 9]])
        network.reportHit(Number.NaN)
        expect(sent).toHaveLength(1)

        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        handle(new Uint8Array(encode([0, 7])))
        handle(new Uint8Array(encode([3, 4, 9])))
        handle(new Uint8Array(encode([3, 4, 7])))
        handle(new Uint8Array(encode([3, 4, 7])))
        expect(network.takeDamage()).toBe(2)
        expect(network.takeDamage()).toBe(0)
    })

    it('tracks server-owned power-ups and credits only this client\u2019s pickups', () => {
        const network = new FlightNetwork(() => { })
        const sent: number[][] = []
        ;(network as unknown as { writer: { write: (bytes: Uint8Array) => Promise<void> } }).writer = {
            write: async (bytes: Uint8Array) => { sent.push(decode(bytes) as number[]) },
        }
        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        // The server assigns this client id 7 before the field is announced, in centimetres.
        handle(new Uint8Array(encode([0, 7])))
        handle(new Uint8Array(encode([5, 0, 1200, 4500, -300])))
        handle(new Uint8Array(encode([5, 1, -2500, 8000, 900])))
        expect(network.powerups()).toEqual([
            { slot: 0, x: 12, y: 45, z: -3 },
            { slot: 1, x: -25, y: 80, z: 9 },
        ])

        network.reportPickup(0)
        expect(sent).toEqual([[2, 0]])

        // A peer collecting slot 1 clears it here but pays this client nothing.
        handle(new Uint8Array(encode([6, 1, 9])))
        expect(network.takePickups()).toEqual([])
        expect(network.powerups()).toEqual([{ slot: 0, x: 12, y: 45, z: -3 }])

        // Our own confirmed pickup clears the field everywhere and is drained exactly once.
        handle(new Uint8Array(encode([6, 0, 7])))
        expect(network.powerups()).toEqual([])
        expect(network.takePickups()).toEqual([0])
        expect(network.takePickups()).toEqual([])
    })

    it('probes the round trip at most once per interval and reports the smoothed latency', () => {
        const network = new FlightNetwork(() => { })
        const sent: number[][] = []
        ;(network as unknown as { writer: { write: (bytes: Uint8Array) => Promise<void> } }).writer = {
            write: async (bytes: Uint8Array) => { sent.push(decode(bytes) as number[]) },
        }
        const flight = initialFlightState(0)
        const input = { flap: false, steer: 0, spread: 1 }
        const wings = { left: 0, right: 0 }
        network.send(flight, input, wings, 1000)
        network.send(flight, input, wings, 1050)
        const pings = sent.filter(([tag]) => tag === 1)
        expect(pings).toHaveLength(1)
        const nonce = pings[0]![1]!

        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        const now = vi.spyOn(performance, 'now').mockReturnValue(1080)
        handle(new Uint8Array(encode([4, nonce + 1])))
        expect(network.latencyMs).toBeNull()
        handle(new Uint8Array(encode([4, nonce])))
        expect(network.latencyMs).toBe(80)
        now.mockRestore()
    })

    it('stays well under the 512 byte datagram limit', () => {
        const flight = { ...initialFlightState(0), x: -449.99, y: 299.99, z: -449.99, yaw: -3.14159, speed: 24, flying: true }
        const bytes = encodeUpdate(4294967295, flight, { flap: true, steer: 1, spread: 0.5 }, { left: -0.85, right: 0.85 }, true)
        expect(bytes.byteLength).toBeLessThan(64)
    })

    it('wraps yaw so the milliradian field never overflows', () => {
        const flight = { ...initialFlightState(0), yaw: 12_345.678 }
        const bytes = encodeUpdate(1, flight, { flap: false, steer: 0, spread: 1 }, { left: 0, right: 0 }, false)
        const position = (decode(bytes) as [number, number, number[]])[2]!
        expect(Math.abs(position[3]!)).toBeLessThanOrEqual(3142)
    })

    it('surfaces a peer trigger pull from a relayed state event', () => {
        const network = new FlightNetwork(() => { })
        // [ x, y, z, yaw, kind, bank, speed, flying, spread, flap, wingLeft, wingRight,
        //   turretYaw, turretPitch, hullPitch, hullRoll, fire, health ]
        const position = [1234, -4550, 900, 0, 0, 0, 1500, true, 1000, false, -250, 850, 0, 0, 0, 0, true, 100]
        const event = new Uint8Array(encode([1, 42, 1, position]))
        ;(network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(event)
        const remotes = network.remotes(performance.now())
        expect(remotes).toHaveLength(1)
        expect(remotes[0]!.id).toBe(42)
        expect(remotes[0]!.kind).toBe('bird')
        expect(remotes[0]!.fire).toBe(true)
        expect(remotes[0]!.flight.wingLeft).toBeCloseTo(-0.25, 6)
    })

    it('decodes a relayed tank peer, turret angles included', () => {
        const network = new FlightNetwork(() => { })
        const position = [2050, 325, -4075, -1200, 1, 0, -350, false, 1000, false, 0, 0, 600, 350, 120, -70, true, 100]
        const event = new Uint8Array(encode([1, 7, 1, position]))
        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        handle(event)
        const [remote] = network.remotes(performance.now())
        expect(remote!.kind).toBe('tank')
        expect(remote!.flight.speed).toBeCloseTo(-3.5, 6)
        expect(remote!.flight.turretYaw).toBeCloseTo(0.6, 6)
        expect(remote!.flight.turretPitch).toBeCloseTo(0.35, 6)
        expect(remote!.flight.hullPitch).toBeCloseTo(0.12, 6)
        expect(remote!.flight.hullRoll).toBeCloseTo(-0.07, 6)
    })

    it('interpolates remote motion from the buffered history, not the newest packet', () => {
        const network = new FlightNetwork(() => { })
        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        const clock = vi.spyOn(performance, 'now')
        const state = (x: number, sequence: number) =>
            new Uint8Array(encode([1, 42, sequence, [x, 0, 0, 0, 0, 0, 0, true, 1000, false, 0, 0, 0, 0, 0, 0, false, 100]]))
        clock.mockReturnValue(1000); handle(state(100, 1))
        clock.mockReturnValue(1050); handle(state(200, 2))
        clock.mockReturnValue(1100); handle(state(300, 3))
        // The interval settles at 50 ms, so playback sits 100 ms behind: at t=1125 the render cursor
        // is halfway between the 1000 (x=1 m) and 1050 (x=2 m) snapshots, behind the newest x=3 m.
        const [remote] = network.remotes(1125)
        expect(remote!.flight.x).toBeCloseTo(1.5, 6)
        clock.mockRestore()
    })

    it('holds the playback rate steady when a datagram is dropped', () => {
        const network = new FlightNetwork(() => { })
        const handle = (bytes: Uint8Array) => (network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(bytes)
        const clock = vi.spyOn(performance, 'now')
        const state = (x: number, sequence: number) =>
            new Uint8Array(encode([1, 42, sequence, [x, 0, 0, 0, 0, 0, 0, true, 1000, false, 0, 0, 0, 0, 0, 0, false, 100]]))
        clock.mockReturnValue(1000); handle(state(100, 1))
        clock.mockReturnValue(1050); handle(state(200, 2))
        // Sequence 3 is lost, so the next datagram arrives a full 100 ms later. That gap is a drop,
        // not a slower sender, so the interval stays 50 ms and playback is not dragged to half speed.
        clock.mockReturnValue(1150); handle(state(400, 4))
        const [remote] = network.remotes(1250)
        expect(remote!.flight.x).toBeCloseTo(4, 6)
        clock.mockRestore()
    })
})
