import { describe, expect, it } from 'vitest'

import { powerupConfig, withinPickupRange } from '../powerup'

describe('power-up pickup', () => {
    const powerup = { slot: 0, x: 10, y: 30, z: -20 }

    it('collects only inside the pickup sphere', () => {
        expect(withinPickupRange({ x: 10, y: 30, z: -20 }, powerup)).toBe(true)
        expect(withinPickupRange({ x: 10 + powerupConfig.pickupRadius - 0.01, y: 30, z: -20 }, powerup)).toBe(true)
        expect(withinPickupRange({ x: 10 + powerupConfig.pickupRadius + 0.01, y: 30, z: -20 }, powerup)).toBe(false)
        // The test is 3D, so skimming far above one does not count.
        expect(withinPickupRange({ x: 10, y: 30 + powerupConfig.pickupRadius + 1, z: -20 }, powerup)).toBe(false)
    })

    it('honours an explicit radius', () => {
        expect(withinPickupRange({ x: 20, y: 30, z: -20 }, powerup, 5)).toBe(false)
        expect(withinPickupRange({ x: 20, y: 30, z: -20 }, powerup, 10)).toBe(true)
    })
})
