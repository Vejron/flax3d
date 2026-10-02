import { describe, expect, it } from 'vitest'
import { decode } from '@msgpack/msgpack'

import { initialFlightState } from '../flight'
import { encodeUpdate } from '../network'

/**
 * Pins the exact bytes the server must decode. The matching Rust test is
 * `decodes_a_client_update_fixture` in `server/src/main.rs`; keep the two in sync.
 */
const FIXTURE = [
    147, 3, 7, 155, 205, 4, 210, 209, 238, 58, 205, 3, 132, 205, 6, 35, 209, 254, 32, 205,
    5, 220, 195, 205, 3, 232, 194, 209, 255, 6, 205, 3, 82,
]

describe('FlightNetwork wire format', () => {
    it('encodes a position update as a fixed-point MessagePack array', () => {
        const flight = {
            ...initialFlightState(0),
            x: 12.34, y: -45.5, z: 9, yaw: 1.571, bank: -0.48, speed: 15, flying: true,
        }
        const bytes = encodeUpdate(7, flight, { flap: false, steer: 0, spread: 1 }, { left: -0.25, right: 0.85 })
        expect(Array.from(bytes)).toEqual(FIXTURE)
    })

    it('stays well under the 512 byte datagram limit', () => {
        const flight = { ...initialFlightState(0), x: -449.99, y: 299.99, z: -449.99, yaw: -3.14159, speed: 24, flying: true }
        const bytes = encodeUpdate(4294967295, flight, { flap: true, steer: 1, spread: 0.5 }, { left: -0.85, right: 0.85 })
        expect(bytes.byteLength).toBeLessThan(64)
    })

    it('wraps yaw so the milliradian field never overflows', () => {
        const flight = { ...initialFlightState(0), yaw: 12_345.678 }
        const bytes = encodeUpdate(1, flight, { flap: false, steer: 0, spread: 1 }, { left: 0, right: 0 })
        const position = (decode(bytes) as [number, number, number[]])[2]!
        expect(Math.abs(position[3]!)).toBeLessThanOrEqual(3142)
    })
})
