import { describe, expect, it, vi } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

import { initialFlightState } from '../flight'
import { encodeUpdate, FlightNetwork } from '../network'

/**
 * Pins the exact bytes the server must decode. The matching Rust test is
 * `decodes_a_client_update_fixture` in `server/src/main.rs`; keep the two in sync.
 */
const FIXTURE = [
    147, 5, 7, 157, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 209, 254, 32, 205,
    5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82, 195, 100,
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

    it('carries the trigger flag as the last position field', () => {
        const flight = initialFlightState(0)
        const input = { flap: false, steer: 0, spread: 1 }
        const wings = { left: 0, right: 0 }
        const held = (decode(encodeUpdate(1, flight, input, wings, true)) as [number, number, number[]])[2]!
        const idle = (decode(encodeUpdate(1, flight, input, wings, false)) as [number, number, number[]])[2]!
        expect(held).toHaveLength(13)
        expect(held[11]).toBe(true)
        expect(idle[11]).toBe(false)
    })

    it('clamps health into the last position field', () => {
        const flight = { ...initialFlightState(0), health: 40 }
        const input = { flap: false, steer: 0, spread: 1 }
        const wings = { left: 0, right: 0 }
        const position = (decode(encodeUpdate(1, flight, input, wings, false)) as [number, number, number[]])[2]!
        expect(position[12]).toBe(40)
        const overcharged = (decode(encodeUpdate(1, { ...flight, health: 250 }, input, wings, false)) as [number, number, number[]])[2]!
        expect(overcharged[12]).toBe(100)
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
        // [ x, y, z, yaw, bank, speed, flying, spread, flap, wingLeft, wingRight, fire, health ]
        const position = [1234, -4550, 900, 0, 0, 1500, true, 1000, false, -250, 850, true, 100]
        const event = new Uint8Array(encode([1, 42, 1, position]))
        ;(network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(event)
        const remotes = network.remotes(performance.now())
        expect(remotes).toHaveLength(1)
        expect(remotes[0]!.id).toBe(42)
        expect(remotes[0]!.fire).toBe(true)
        expect(remotes[0]!.flight.wingLeft).toBeCloseTo(-0.25, 6)
    })
})
