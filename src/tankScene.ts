import * as THREE from 'three'
import { courseSpawn } from './course'
import type { RemoteFlight } from './network'
import type { Powerup } from './powerup'
import type { TankState } from './tank'
import { terrainHeight } from './terrain'
import { tankWeaponConfig, writeTurretAim } from './tankWeapon'
import { buildTank } from './vehicles'
import { assistAim } from './weapon'
import { createWorld, RETICLE_RANGE, type ReticleTint, type SceneHandlers } from './world'

export type { ReticleTint, SceneHandlers } from './world'

/**
 * The tank's rig: a hull that sits on the terrain and a turret that aims independently of it. The
 * shared stage (terrain, peers, power-ups, the weapon rig) lives in `world.ts`.
 */
export function createTankScene(container: HTMLElement, handlers: SceneHandlers = {}) {
    const tank = buildTank()
    const world = createWorld(container, {
        vehicle: tank.group,
        muzzle: tank.muzzle,
        kind: 'tank',
        config: tankWeaponConfig,
        handlers,
    })

    const aimDirection = new THREE.Vector3()
    const reticleAim = new THREE.Vector3()
    const reticlePosition = new THREE.Vector3()

    const cameraTarget = new THREE.Vector3(
        courseSpawn.x - Math.sin(courseSpawn.yaw) * 11,
        terrainHeight(courseSpawn.x, courseSpawn.z) + 5.5,
        courseSpawn.z + Math.cos(courseSpawn.yaw) * 11,
    )
    world.camera.position.copy(cameraTarget)
    let cameraYaw = courseSpawn.yaw
    let lastFrameTime = 0

    function render(state: TankState, elapsed: number, nextRing: number, remotes: RemoteFlight[] = [], fire = false, reticleTint: ReticleTint = 'off', powerups: Powerup[] = []) {
        const dt = Math.min(elapsed - lastFrameTime, 0.05)
        lastFrameTime = elapsed
        // Peers first: their avatars are placed and their cosmetic shots replayed, which also rebuilds
        // the bullet target list that the aim assist and the hit test below both read.
        world.syncRemotes(remotes, elapsed, dt)
        world.syncPowerups(powerups, elapsed, dt)
        world.setActiveRing(nextRing)

        // Hull: heading from the sim, pitch and roll from the slope it is sitting on. Shake is a
        // small rattle offset so a hit reads without moving the whole vehicle.
        tank.group.position.set(
            state.x + Math.sin(elapsed * 92) * state.shake * 0.18,
            state.y + Math.cos(elapsed * 71) * state.shake * 0.12,
            state.z + Math.sin(elapsed * 83) * state.shake * 0.18,
        )
        tank.group.rotation.order = 'YXZ'
        tank.group.rotation.set(state.hullPitch, -state.hullYaw, state.hullRoll)
        // The turret rides on top of the hull, aimed entirely from its own angles.
        tank.turret.rotation.order = 'YXZ'
        tank.turret.rotation.x = state.turretPitch
        tank.turret.rotation.y = -state.turretYaw

        const angle = Math.atan2(Math.sin(state.hullYaw - cameraYaw), Math.cos(state.hullYaw - cameraYaw))
        cameraYaw += angle * (1 - Math.exp(-2.3 * dt))
        cameraTarget.set(state.x - Math.sin(cameraYaw) * 11, state.y + 5.5, state.z + Math.cos(cameraYaw) * 11)
        world.camera.position.lerp(cameraTarget, 1 - Math.exp(-3 * dt))
        world.camera.lookAt(state.x + Math.sin(cameraYaw) * 9, state.y + 1.6, state.z - Math.cos(cameraYaw) * 9)
        tank.group.updateMatrixWorld(true)

        // Fire down the barrel's real axis — turret yaw and elevation composed with the hull's roll
        // and slope — so the round always leaves exactly where the barrel is drawn.
        tank.muzzle.getWorldPosition(reticlePosition)
        writeTurretAim(state, aimDirection)
        if (fire) {
            if (world.weapon.fire(assistAim(reticlePosition, aimDirection, world.hitTargets, tankWeaponConfig))) {
                handlers.onShot?.(reticlePosition)
            }
        }
        // Reticle marks the exact spot the next round reaches at RETICLE_RANGE metres, drop included.
        const drop = 0.5 * tankWeaponConfig.gravity * (RETICLE_RANGE / tankWeaponConfig.speed) ** 2
        reticlePosition.addScaledVector(writeTurretAim(state, reticleAim), RETICLE_RANGE)
        reticlePosition.y -= drop
        world.reticle.position.copy(reticlePosition)
        world.reticle.visible = !state.dead
        world.tintReticle(reticleTint)
        for (const hit of world.weapon.update(dt, terrainHeight, world.hitTargets)) handlers.onHit?.(hit.targetId)
        world.present()
    }

    function dispose() {
        tank.dispose()
        world.dispose()
    }

    return {
        render,
        dispose,
        /** Smoothed yaw the chase camera is looking along, in radians. The HUD aims relative to it. */
        cameraYaw: () => cameraYaw,
        rounds: () => world.weapon.rounds,
        addRounds: (amount: number) => world.weapon.addRounds(amount),
        resetRounds: () => world.weapon.resetRounds(),
    }
}
