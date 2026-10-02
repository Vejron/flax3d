import { describe, expect, it } from 'vitest'
import { decode, encode } from '@msgpack/msgpack'

import { initialFlightState } from '../flight'
import { encodeUpdate, FlightNetwork } from '../network'

/**
 * Pins the exact bytes the server must decode. The matching Rust test is
 * `decodes_a_client_update_fixture` in `server/src/main.rs`; keep the two in sync.
 */
const FIXTURE = [
    147, 4, 7, 156, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 209, 254, 32, 205,
    5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82, 195,
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
        expect(held).toHaveLength(12)
        expect(held[11]).toBe(true)
        expect(idle[11]).toBe(false)
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
        // [ x, y, z, yaw, bank, speed, flying, spread, flap, wingLeft, wingRight, fire ]
        const position = [1234, -4550, 900, 0, 0, 1500, true, 1000, false, -250, 850, true]
        const event = new Uint8Array(encode([1, 42, 1, position]))
        ;(network as unknown as { handleEvent: (bytes: Uint8Array) => void }).handleEvent(event)
        const remotes = network.remotes(performance.now())
        expect(remotes).toHaveLength(1)
        expect(remotes[0]!.id).toBe(42)
        expect(remotes[0]!.fire).toBe(true)
        expect(remotes[0]!.flight.wingLeft).toBeCloseTo(-0.25, 6)
    })
})
