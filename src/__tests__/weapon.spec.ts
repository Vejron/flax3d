import { describe, it, expect } from 'vitest'
import * as THREE from 'three'

import { createBullet, createGun, createWeaponRig, scatter, stepBullet, terrainNormal, weaponConfig } from '../weapon'

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
        const result = stepBullet(createBullet({ x: 0, y: 4, z: 0 }, { x: 0, y: -1, z: 0 }), 0.05, flat)
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
})
