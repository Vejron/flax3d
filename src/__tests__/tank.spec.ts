import { describe, expect, it } from 'vitest'

import { applyTankHit, initialTankState, respawnTank, stepTank, tankConfig, turretElevation, wrapAngle, type TankControls, type TankState } from '../tank'

const flat = () => 0
const step = 1 / 60
const idle: TankControls = { throttle: 0, steer: 0, turretBearing: 0, turretPitch: 0 }

/** Runs the sim for `seconds`, feeding the same controls every frame. */
function run(state: TankState, controls: TankControls, seconds: number, terrain: (x: number, z: number) => number = flat): TankState {
    let current = state
    const frames = Math.round(seconds / step)
    for (let frame = 0; frame < frames; frame++) current = stepTank(current, controls, step, terrain)
    return current
}

describe('tank', () => {
    it('accelerates toward top speed and coasts back down when the throttle is released', () => {
        const rolling = run(initialTankState(0), { ...idle, throttle: 1 }, 1)
        expect(rolling.speed).toBeGreaterThan(10)
        expect(rolling.speed).toBeLessThanOrEqual(tankConfig.maxSpeed)

        const coasting = run(rolling, idle, 3)
        expect(coasting.speed).toBeLessThan(1)
        expect(coasting.speed).toBeLessThan(rolling.speed)
    })

    it('cannot pivot while stationary', () => {
        const parked = run(initialTankState(0), { ...idle, steer: 1 }, 1)
        expect(parked.hullYaw).toBe(0)
        expect(parked.speed).toBe(0)
    })

    it('turns only once the hull is rolling', () => {
        const rolling = run(initialTankState(0), { ...idle, throttle: 1 }, 1)
        const turning = run(rolling, { ...idle, throttle: 1, steer: 1 }, 1)
        expect(turning.hullYaw).toBeGreaterThan(0)
    })

    it('reverses and inverts the steering while backing up', () => {
        const backing = run(initialTankState(0), { ...idle, throttle: -1 }, 1)
        expect(backing.speed).toBeLessThan(0)
        expect(backing.speed).toBeGreaterThanOrEqual(-tankConfig.maxReverseSpeed)

        const turning = run(backing, { ...idle, throttle: -1, steer: 1 }, 1)
        expect(turning.hullYaw).toBeLessThan(0)
    })

    it('stays glued to the terrain surface', () => {
        const hill = (x: number, z: number) => Math.sin(x * 0.1) + Math.cos(z * 0.1)
        const moved = run(initialTankState(0), { ...idle, throttle: 1 }, 2, hill)
        // A hull pointing down -Z drives along Z, so the ground under it really does change.
        expect(moved.z).toBeLessThan(-5)
        expect(moved.y).toBeCloseTo(hill(moved.x, moved.z), 6)
    })

    it('adopts the terrain slope as roll and pitch with the correct sign', () => {
        // Ground rising to the right rolls the hull right side up.
        const rightHigher = run(initialTankState(0), idle, 2, (x) => x * 0.2)
        expect(rightHigher.hullRoll).toBeCloseTo(Math.atan(0.2), 2)
        expect(rightHigher.hullPitch).toBeCloseTo(0, 3)

        // Ground rising ahead of a hull pointing down -Z pitches the nose up.
        const aheadHigher = run(initialTankState(0), idle, 2, (_x, z) => z * -0.2)
        expect(aheadHigher.hullPitch).toBeCloseTo(Math.atan(0.2), 2)
    })

    it('clamps the adopted slope so a cliff cannot point the hull at the sky', () => {
        const cliff = run(initialTankState(0), idle, 5, (x) => x * 4)
        expect(cliff.hullRoll).toBeLessThanOrEqual(tankConfig.maxSlope + 1e-6)
    })

    it('traverses the turret at a bounded rate instead of snapping to the command', () => {
        const oneFrame = stepTank(initialTankState(0), { ...idle, turretBearing: Math.PI / 2 }, step, flat)
        expect(oneFrame.turretYaw).toBeCloseTo(tankConfig.turretSlewRate * step, 6)

        const settled = run(initialTankState(0), { ...idle, turretBearing: Math.PI / 2 }, 2)
        expect(settled.turretYaw).toBeCloseTo(Math.PI / 2, 3)
    })

    it('takes the shortest way round when the bearing crosses the seam', () => {
        const nearPi = { ...initialTankState(0), turretYaw: 3 }
        // Commanding -3.0 rad is just past the seam, so a correct traverse moves positively.
        const traversing = stepTank(nearPi, { ...idle, turretBearing: -3 }, step, flat)
        expect(traversing.turretYaw).toBeGreaterThan(3)
    })

    it('clamps turret elevation between the configured limits', () => {
        const skyward = run(initialTankState(0), { ...idle, turretPitch: 5 }, 3)
        expect(skyward.turretPitch).toBeCloseTo(tankConfig.turretPitchMax, 4)
        const depressed = run(skyward, { ...idle, turretPitch: -5 }, 4)
        expect(depressed.turretPitch).toBeCloseTo(tankConfig.turretPitchMin, 4)
    })

    it('holds the commanded elevation above the horizon while the hull climbs a slope', () => {
        // The hull noses up on this grade, which must not drag the aim up with it.
        const uphill = (_x: number, z: number) => z * -0.2
        const settled = run(initialTankState(0), { ...idle, turretPitch: 0.5 }, 2, uphill)
        expect(settled.hullPitch).toBeGreaterThan(0.1)
        expect(turretElevation(settled)).toBeCloseTo(0.5, 2)
        // The stored angle is hull-relative, so the hull has taken up the difference.
        expect(settled.turretPitch).toBeCloseTo(0.5 - settled.hullPitch, 3)
    })

    it('holds a world bearing on the turret while the hull turns beneath it', () => {
        // Hold bearing 0 (straight up the world's -Z) and turn the hull away from it.
        const turning = run(initialTankState(0), { ...idle, throttle: 1, steer: 1, turretBearing: 0 }, 3)
        expect(Math.abs(turning.hullYaw)).toBeGreaterThan(0.5)
        // The turret compensates, so its absolute bearing stays on target rather than on the nose.
        expect(wrapAngle(turning.hullYaw + turning.turretYaw)).toBeCloseTo(0, 2)
    })

    it('sits inert while wrecked and counts down to a respawn', () => {
        const alive = initialTankState(0)
        const wrecked = applyTankHit(alive, tankConfig.maxHealth)
        expect(wrecked.dead).toBe(true)
        expect(wrecked.health).toBe(0)
        expect(wrecked.respawn).toBeCloseTo(tankConfig.respawnDelay, 6)

        const waiting = run(wrecked, { ...idle, throttle: 1 }, 1)
        expect(waiting.speed).toBe(0)
        expect(waiting.x).toBe(wrecked.x)
        expect(waiting.z).toBe(wrecked.z)
        expect(waiting.respawn).toBeCloseTo(tankConfig.respawnDelay - 1, 4)
    })

    it('ignores damage once wrecked and revives at the spawn point', () => {
        const wrecked = applyTankHit(initialTankState(0), tankConfig.maxHealth)
        expect(applyTankHit(wrecked, 10)).toBe(wrecked)

        const revived = respawnTank(0, { x: 12, z: -8, hullYaw: 1.2 })
        expect(revived.health).toBe(tankConfig.maxHealth)
        expect(revived.dead).toBe(false)
        expect(revived).toMatchObject({ x: 12, z: -8, hullYaw: 1.2, turretYaw: 0, speed: 0 })
    })

    it('wraps angles into a single turn', () => {
        expect(wrapAngle(Math.PI * 2.5)).toBeCloseTo(Math.PI * 0.5, 6)
        expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI * 0.5, 6)
    })
})
