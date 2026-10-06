import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

import { assistAim, createBullet, createGun, createWeaponRig, gunPitch, interceptTime, scatter, stepBullet, terrainNormal, updateAutoFire, weaponConfig, writeAimFromYaw } from '../weapon'
import { flightConfig } from '../flight'

describe('weapon ballistics', () => {
    const flat = () => 0
    const openSky = () => -1000

    it('drops a bullet under gravity while it keeps its forward speed', () => {
        let bullet = createBullet({ x: 0, y: 1000, z: 0 }, { x: 0, y: 0, z: -1 })
        const height = bullet.position.y
        for (let step = 0; step < 20; step++) {
            const result = stepBullet(bullet, 0.05, openSky)
            expect(result.impact).toBeNull()
            bullet = result.bullet
        }
        const drop = height - bullet.position.y
        const ideal = 0.5 * weaponConfig.gravity * 1 ** 2
        expect(drop).toBeGreaterThan(ideal)
        expect(drop).toBeLessThan(ideal * 1.3)
        expect(bullet.position.z).toBeCloseTo(-weaponConfig.speed, 5)
        expect(bullet.position.x).toBe(0)
    })

    it('stops a bullet on the terrain and reports the surface', () => {
        let bullet = createBullet({ x: 0, y: 8, z: 0 }, { x: 0, y: 0, z: -1 })
        let impact = null
        for (let step = 0; step < 200 && !impact; step++) {
            const result = stepBullet(bullet, 0.05, flat)
            bullet = result.bullet
            impact = result.impact
            if (result.dead) break
        }
        expect(impact).not.toBeNull()
        expect(impact!.position.y).toBeCloseTo(0, 6)
        expect(impact!.normal.y).toBeGreaterThan(0.99)
        expect(impact!.speed).toBeGreaterThan(weaponConfig.speed * 0.5)
    })

    it('samples the path closely enough to catch a fast vertical round', () => {
        const result = stepBullet(createBullet({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }), 0.05, flat)
        expect(result.impact).not.toBeNull()
        expect(result.dead).toBe(true)
    })

    it('recycles a bullet that misses the ground before it hits the kill altitude', () => {
        let bullet = createBullet({ x: 0, y: 1000, z: 0 }, { x: 0, y: 1, z: 0 })
        let dead = false
        let impact = null
        for (let step = 0; step < 200; step++) {
            const result = stepBullet(bullet, 0.05, openSky)
            bullet = result.bullet
            impact = result.impact
            if (result.dead) {
                dead = true
                break
            }
        }
        expect(dead).toBe(true)
        expect(impact).toBeNull()
        expect(bullet.age).toBeGreaterThanOrEqual(weaponConfig.life)
    })

    it('builds a terrain normal that tilts against the slope', () => {
        const level = terrainNormal(0, 0, flat)
        expect(level.y).toBeCloseTo(1, 6)
        const slope = terrainNormal(0, 0, (x) => x * 0.2)
        expect(slope.x).toBeLessThan(0)
        expect(slope.y).toBeGreaterThan(0)
        expect(Math.hypot(slope.x, slope.y, slope.z)).toBeCloseTo(1, 6)
    })

    it('keeps scattered shots inside the aim cone', () => {
        let seed = 1
        const random = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648
            return seed / 2147483648
        }
        const direction = new THREE.Vector3(0.3, 0.4, -1).normalize()
        let widest = 0
        for (let shot = 0; shot < 200; shot++) {
            const scattered = scatter(direction, 0.05, random)
            const length = Math.hypot(scattered.x, scattered.y, scattered.z)
            const dot = (scattered.x * direction.x + scattered.y * direction.y + scattered.z * direction.z) / length
            const angle = Math.acos(Math.min(1, dot))
            widest = Math.max(widest, angle)
            expect(angle).toBeLessThanOrEqual(0.0501)
        }
        expect(widest).toBeGreaterThan(0.01)
    })

    it('pools its meshes and releases them on dispose', () => {
        const scene = new THREE.Scene()
        const muzzle = new THREE.Object3D()
        scene.add(muzzle)
        muzzle.updateMatrixWorld(true)
        const before = scene.children.length

        const rig = createWeaponRig(scene, muzzle)
        expect(scene.children.length).toBe(before + 3)

        expect(rig.fire(new THREE.Vector3(0, 0.5, -1))).toBe(true)
        expect(rig.fire(new THREE.Vector3(0, 0.5, -1))).toBe(false)
        rig.update(weaponConfig.fireInterval, flat)
        expect(rig.fire(new THREE.Vector3(0, 0.5, -1))).toBe(true)
        for (let step = 0; step < 30; step++) rig.update(0.05, flat)

        rig.dispose()
        expect(scene.children.length).toBe(before)
    })

    it('gives every shooter its own cooldown so a peer cannot silence the local gun', () => {
        const scene = new THREE.Scene()
        const muzzle = new THREE.Object3D()
        scene.add(muzzle)
        muzzle.updateMatrixWorld(true)
        const rig = createWeaponRig(scene, muzzle)
        const aim = new THREE.Vector3(0, 1, 0)

        expect(rig.fire(aim)).toBe(true)
        expect(rig.fire(aim)).toBe(false)
        expect(rig.fire(aim, muzzle.position, 7)).toBe(true)
        expect(rig.fire(aim, muzzle.position, 8)).toBe(true)
        expect(rig.fire(aim, muzzle.position, 7)).toBe(false)

        rig.dispose()
    })

    it('exposes a named muzzle on a cloned avatar so peers can spawn shots from it', () => {
        const flyer = new THREE.Group()
        flyer.position.set(3, 5, -2)
        flyer.rotation.set(0, -0.7, 0.1)
        const gun = createGun(flyer)
        const avatar = flyer.clone(true)
        flyer.updateMatrixWorld(true)

        const cloneMuzzle = avatar.getObjectByName('muzzle')
        expect(cloneMuzzle).toBeDefined()
        expect(cloneMuzzle).not.toBe(gun.muzzle)

        const world = new THREE.Vector3()
        gun.muzzle.getWorldPosition(world)
        expect(Number.isFinite(world.x)).toBe(true)
        expect(world.y).toBeGreaterThan(5)

        gun.dispose()
    })

    it('detects a bird in flight before the ground behind it', () => {
        const target = { id: 3, x: 0, y: 0, z: -15, radius: 1.5 }
        let bullet = createBullet({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })
        let hit = null
        for (let step = 0; step < 40 && !hit; step++) {
            const result = stepBullet(bullet, 0.05, () => -500, weaponConfig, [target])
            bullet = result.bullet
            hit = result.hit
        }
        expect(hit).not.toBeNull()
        expect(hit!.targetId).toBe(3)
        // Sparks spray back toward the shooter.
        expect(hit!.normal.z).toBeGreaterThan(0.9)
    })

    it('only lets the local shooter wound a bird', () => {
        const scene = new THREE.Scene()
        const muzzle = new THREE.Object3D()
        scene.add(muzzle)
        muzzle.updateMatrixWorld(true)
        const rig = createWeaponRig(scene, muzzle)
        const aim = new THREE.Vector3(0, 0, -1)
        const target = { id: 5, x: 0, y: 0, z: -10, radius: 1.5 }

        expect(rig.fire(aim)).toBe(true)
        const local = rig.update(0.2, () => -100, [target])
        expect(local).toHaveLength(1)
        expect(local[0]!.targetId).toBe(5)

        // A peer's round is only decorative here, so it must not wound anyone on this client.
        expect(rig.fire(aim, muzzle.position, 7)).toBe(true)
        expect(rig.update(0.2, () => -100, [target])).toHaveLength(0)

        rig.dispose()
    })
})

describe('shot spread and aim assist', () => {
    const origin = { x: 0, y: 0, z: 0 }
    const ahead = { x: 0, y: 0, z: -1 }
    const radiansToDegrees = (radians: number) => (radians * 180) / Math.PI
    const angleBetween = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
        const dot = a.x * b.x + a.y * b.y + a.z * b.z
        return Math.acos(Math.min(1, Math.max(-1, dot)))
    }
    /** A point `degrees` off the aim line, `distance` metres ahead. */
    const offAxis = (degrees: number, distance = 50) => ({
        x: Math.sin((degrees * Math.PI) / 180) * distance,
        y: 0,
        z: -Math.cos((degrees * Math.PI) / 180) * distance,
    })
    const unit = (point: { x: number; y: number; z: number }) => {
        const length = Math.hypot(point.x, point.y, point.z) || 1
        return { x: point.x / length, y: point.y / length, z: point.z / length }
    }

    it('scatters the shipped gun enough to miss at range', () => {
        // Keeping gunfights from ending in one burst is the whole point of the spread: at 60 m the
        // cone has to be wider than the 1.5 m body hit sphere (BIRD_HIT_RADIUS in `scene.ts`) or
        // every round lands and the assist below would make it worse.
        expect(Math.tan(weaponConfig.spread) * 60).toBeGreaterThan(1.5)
    })

    it('removes the configured fraction of the aim error', () => {
        const error = 4
        const target = offAxis(error)
        const assisted = assistAim(origin, ahead, [target])
        // The error is measured to the target, not to where the raw shot used to point.
        const remaining = radiansToDegrees(angleBetween(assisted, unit(target)))
        expect(remaining).toBeCloseTo(error * (1 - weaponConfig.aimAssistStrength), 1)
        // The shot moved off the raw aim line, part of the way toward the rival.
        expect(radiansToDegrees(angleBetween(ahead, assisted)))
            .toBeCloseTo(error * weaponConfig.aimAssistStrength, 1)
        expect(assisted.x).toBeGreaterThan(0)
    })

    it('leaves the shot alone with no rival worth helping with', () => {
        expect(assistAim(origin, ahead, [])).toEqual(ahead)
        // Wider of the axis than the assist looks.
        expect(assistAim(origin, ahead, [offAxis(weaponConfig.aimAssistCone + 6)])).toEqual(ahead)
        // Past the assist range.
        expect(assistAim(origin, ahead, [{ x: 0, y: 0, z: -(weaponConfig.aimAssistRange + 10) }])).toEqual(ahead)
        // Behind the bird.
        expect(assistAim(origin, ahead, [{ x: 0, y: 0, z: 20 }])).toEqual(ahead)
    })

    it('never bends past the rival it is helping aim at', () => {
        const target = offAxis(3.5, 30)
        const maxed = assistAim(origin, ahead, [target], { ...weaponConfig, aimAssistStrength: 4 })
        const toTarget = unit(target)
        expect(maxed.x).toBeCloseTo(toTarget.x, 6)
        expect(maxed.z).toBeCloseTo(toTarget.z, 6)
    })

    it('prefers the rival closest to the line of fire', () => {
        const closer = offAxis(3, 40)
        const wider = offAxis(-4.5, 40)
        expect(assistAim(origin, ahead, [wider, closer]).x).toBeGreaterThan(0)
        expect(assistAim(origin, ahead, [closer, wider]).x).toBeGreaterThan(0)
    })

    it('is inert when the strength is zero', () => {
        expect(assistAim(origin, ahead, [offAxis(4)], { ...weaponConfig, aimAssistStrength: 0 })).toEqual(ahead)
    })

    it('solves the intercept time for a moving rival', () => {
        // Straight ahead and still: just the distance over the muzzle speed.
        expect(interceptTime({ x: 0, y: 0, z: -55 }, { x: 0, y: 0, z: 0 }, weaponConfig.speed)).toBeCloseTo(1, 6)
        // Crossing at 20 m/s from 30 m out: the classic lead quadratic, ~0.586 s.
        expect(interceptTime({ x: 0, y: 0, z: -30 }, { x: 20, y: 0, z: 0 }, weaponConfig.speed)).toBeCloseTo(0.5855, 3)
        // Outrunning the round leaves no intercept at all.
        expect(interceptTime({ x: 0, y: 0, z: -30 }, { x: 0, y: 0, z: -100 }, weaponConfig.speed)).toBeNull()
    })

    it('leads a crossing rival by the full flight time', () => {
        const crossing = { x: 0, y: 0, z: -30, vx: 20, vy: 0, vz: 0 }
        const assisted = assistAim(origin, ahead, [crossing], { ...weaponConfig, aimAssistStrength: 1 })
        const flight = interceptTime({ x: 0, y: 0, z: -30 }, { x: 20, y: 0, z: 0 }, weaponConfig.speed)!
        const leadPoint = unit({ x: 20 * flight, y: 0, z: -30 })
        expect(radiansToDegrees(angleBetween(assisted, leadPoint))).toBeCloseTo(0, 4)
        // Aimed ahead of the bird, on the side it is travelling toward, not at where it is now.
        expect(assisted.x).toBeGreaterThan(0.3)
    })

    it('forgives aim error without giving the lead away', () => {
        const error = 4
        const crossing = { ...offAxis(error), vx: 20, vy: 0, vz: 0 }
        const assisted = assistAim(origin, ahead, [crossing])
        const flight = interceptTime(offAxis(error), { x: 20, y: 0, z: 0 }, weaponConfig.speed)!
        const leadPoint = unit({ x: offAxis(error).x + 20 * flight, y: 0, z: offAxis(error).z })
        // The residual is exactly the un-forgiven slice of the aim error, with the lead intact.
        expect(radiansToDegrees(angleBetween(assisted, leadPoint)))
            .toBeCloseTo(error * (1 - weaponConfig.aimAssistStrength), 1)
    })

    it('adds no lead to a rival that is not moving', () => {
        const assisted = assistAim(origin, ahead, [offAxis(3)])
        const nudged = radiansToDegrees(angleBetween(ahead, assisted))
        expect(nudged).toBeCloseTo(3 * weaponConfig.aimAssistStrength, 1)
    })
})

describe('weapon magazine', () => {
    const flat = () => 0
    const aim = new THREE.Vector3(0, 0, -1)

    function rig() {
        const scene = new THREE.Scene()
        const muzzle = new THREE.Object3D()
        scene.add(muzzle)
        muzzle.updateMatrixWorld(true)
        return createWeaponRig(scene, muzzle)
    }

    it('starts full and spends exactly one round per shot', () => {
        const weapon = rig()
        expect(weapon.rounds).toBe(weaponConfig.magazineSize)
        expect(weapon.fire(aim)).toBe(true)
        expect(weapon.rounds).toBe(weaponConfig.magazineSize - 1)
        // The cooldown still throttles, so a second pull in the same instant spends nothing.
        expect(weapon.fire(aim)).toBe(false)
        expect(weapon.rounds).toBe(weaponConfig.magazineSize - 1)
        weapon.dispose()
    })

    it('goes dry at zero and fires again the moment it is topped up', () => {
        const weapon = rig()
        for (let shot = 0; shot < weaponConfig.magazineSize; shot++) {
            expect(weapon.fire(aim)).toBe(true)
            weapon.update(weaponConfig.fireInterval, flat)
        }
        expect(weapon.rounds).toBe(0)
        // A refused shot must not arm the cooldown, or the refilled gun would feel unresponsive.
        expect(weapon.fire(aim)).toBe(false)
        weapon.addRounds(weaponConfig.pickupRounds)
        expect(weapon.fire(aim)).toBe(true)
        weapon.dispose()
    })

    it('stacks pickups up to the cap and refills on reset', () => {
        const weapon = rig()
        weapon.addRounds(weaponConfig.pickupRounds)
        expect(weapon.rounds).toBe(200)
        weapon.addRounds(weaponConfig.pickupRounds)
        expect(weapon.rounds).toBe(weaponConfig.maxRounds)
        weapon.addRounds(weaponConfig.pickupRounds)
        expect(weapon.rounds).toBe(weaponConfig.maxRounds)
        weapon.addRounds(-50)
        expect(weapon.rounds).toBe(weaponConfig.maxRounds)
        weapon.resetRounds()
        expect(weapon.rounds).toBe(weaponConfig.magazineSize)
        weapon.dispose()
    })

    it('never spends the local magazine on a peer\u2019s cosmetic shot', () => {
        const weapon = rig()
        expect(weapon.fire(aim, new THREE.Vector3(), 7)).toBe(true)
        expect(weapon.fire(aim, new THREE.Vector3(), 8)).toBe(true)
        expect(weapon.rounds).toBe(weaponConfig.magazineSize)
        weapon.dispose()
    })
})

describe('auto-fire cone', () => {
    // Read the shipped defaults straight from the config so a retune cannot leave this suite
    // testing a cone the game no longer ships — which is how an unusable default slipped through.
    const halfAngle = (flightConfig.autoFireAngle * Math.PI) / 180
    const options = { range: flightConfig.autoFireRange, halfAngle, dwell: flightConfig.autoFireDwell }
    const origin = { x: 0, y: 0, z: 0 }
    /** A point `distance` metres along an axis pitched `pitch` above the horizon, dead ahead. */
    const along = (pitch: number, distance: number) => ({
        x: 0,
        y: Math.sin(pitch) * distance,
        z: -Math.cos(pitch) * distance,
    })

    it('shares one pitched aim axis between the gun and the cone', () => {
        const aim = writeAimFromYaw(0, { x: 0, y: 0, z: 0 })
        expect(Math.hypot(aim.x, aim.y, aim.z)).toBeCloseTo(1, 6)
        expect(aim.y).toBeCloseTo(Math.sin(gunPitch), 6)
        expect(aim.z).toBeCloseTo(-Math.cos(gunPitch), 6)
        const turned = writeAimFromYaw(Math.PI / 2, { x: 0, y: 0, z: 0 })
        expect(turned.x).toBeCloseTo(Math.cos(gunPitch), 6)
        expect(turned.z).toBeCloseTo(0, 6)
    })

    it('locks a bird on the gun axis and ignores one behind or out of range', () => {
        const onAxis = along(gunPitch, 40)
        expect(updateAutoFire(0, 0.05, origin, 0, [onAxis], options).locked).toBe(true)
        // Same distance, reversed: behind the bird.
        expect(updateAutoFire(0, 0.05, origin, 0, [{ x: 0, y: 0, z: 40 }], options).locked).toBe(false)
        // Directly ahead but past the cone's length.
        expect(updateAutoFire(0, 0.05, origin, 0, [along(gunPitch, options.range + 20)], options).locked).toBe(false)
    })

    it('tolerates the cone half-angle but not a bird a little wider', () => {
        const inside = along(gunPitch + halfAngle * 0.9, 35)
        const outside = along(gunPitch + halfAngle * 1.5, 35)
        expect(updateAutoFire(0, 0.05, origin, 0, [inside], options).locked).toBe(true)
        expect(updateAutoFire(0, 0.05, origin, 0, [outside], options).locked).toBe(false)
    })

    it('leaves a usable window below the bird, not just above it', () => {
        // The cone axis is pitched up by `gunPitch`, so a half-angle that barely exceeds that pitch
        // makes the gate one-sided: a rival level with the bird squeaks in, one slightly lower is
        // invisible. These two cases pin the shipped default as usable in both directions.
        const below = { x: 0, y: -10, z: -Math.sqrt(50 ** 2 - 10 ** 2) }
        const above = { x: 0, y: 20, z: -Math.sqrt(50 ** 2 - 20 ** 2) }
        expect(updateAutoFire(0, 0.05, origin, 0, [below], options).locked).toBe(true)
        expect(updateAutoFire(0, 0.05, origin, 0, [above], options).locked).toBe(true)
        // Still no lock on a rival behind the bird.
        expect(updateAutoFire(0, 0.05, origin, 0, [{ x: 0, y: -10, z: 48 }], options).locked).toBe(false)
    })

    it('opens fire only after the cone is held for the dwell, and resets when it is lost', () => {
        const target = along(gunPitch, 30)
        let state = updateAutoFire(0, 0.1, origin, 0, [target], options)
        expect(state.locked).toBe(true)
        expect(state.lock).toBeCloseTo(0.1, 6)
        expect(state.fire).toBe(false)

        state = updateAutoFire(state.lock, 0.1, origin, 0, [target], options)
        expect(state.lock).toBeCloseTo(0.2, 6)
        expect(state.fire).toBe(true)

        // A beat with an empty sky clears the timer and shuts the trigger again.
        state = updateAutoFire(state.lock, 0.05, origin, 0, [], options)
        expect(state.locked).toBe(false)
        expect(state.fire).toBe(false)
        expect(state.lock).toBe(0)
    })
})
