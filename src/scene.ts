import * as THREE from 'three'
import { createFlapDetector, stepFlapDetector } from './audio'
import { courseSpawn } from './course'
import type { FlightControls, FlightState } from './flight'
import type { RemoteFlight } from './network'
import type { HeadPose } from './poseControls'
import type { Powerup } from './powerup'
import { terrainHeight } from './terrain'
import { buildFlyer } from './vehicles'
import { assistAim, headAimOffset, weaponConfig, writeAimFromYaw } from './weapon'
import { createWorld, RETICLE_RANGE, type ReticleTint, type SceneHandlers } from './world'

export type { ReticleTint, SceneHandlers } from './world'
export { terrainHeight } from './terrain'

/** Number of samples kept in each wingtip trail ribbon. */
const TRAIL_SAMPLES = 64

/**
 * The bird's rig: everything specific to flying — the wing beat, the wingtip trails, the beak
 * muzzle and a chase camera behind the bird. The shared stage (terrain, peers, power-ups, the
 * weapon rig) lives in `world.ts`.
 */
export function createScene(container: HTMLElement, handlers: SceneHandlers = {}) {
    const flyer = buildFlyer()
    const world = createWorld(container, {
        vehicle: flyer.group,
        muzzle: flyer.muzzle,
        kind: 'bird',
        config: weaponConfig,
        handlers,
    })

    const trailMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    const trails = flyer.wings.map(({ elbow, side }) => {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 6), 3).setUsage(THREE.DynamicDrawUsage))
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_SAMPLES * 8), 4).setUsage(THREE.DynamicDrawUsage))
        const indices: number[] = []
        for (let index = 0; index < TRAIL_SAMPLES - 1; index++) {
            const vertex = index * 2
            indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2)
        }
        geometry.setIndex(indices)
        geometry.setDrawRange(0, 0)
        const ribbon = new THREE.Mesh(geometry, trailMaterial)
        ribbon.frustumCulled = false
        ribbon.renderOrder = 1
        world.scene.add(ribbon)
        return { elbow, side, ribbon, geometry, points: [] as THREE.Vector3[] }
    })
    const trailDirection = new THREE.Vector3()
    const trailView = new THREE.Vector3()
    const trailSide = new THREE.Vector3()
    const aimDirection = new THREE.Vector3()
    const reticleAim = new THREE.Vector3()
    const reticlePosition = new THREE.Vector3()

    const cameraTarget = new THREE.Vector3(
        courseSpawn.x - Math.sin(courseSpawn.yaw) * 12,
        terrainHeight(courseSpawn.x, courseSpawn.z) + 7,
        courseSpawn.z + Math.cos(courseSpawn.yaw) * 12,
    )
    world.camera.position.copy(cameraTarget)
    let cameraYaw = courseSpawn.yaw
    let lastCameraTime = 0

    let lastFlapAt = -Infinity
    /** Wing-beat detector for the local bird. */
    const localFlap = createFlapDetector()

    function render(state: FlightState, elapsed: number, input: FlightControls, poseWings: { leftWing: number; rightWing: number } | null, poseHead: HeadPose | null, nextRing: number, remotes: RemoteFlight[] = [], fire = false, reticleTint: ReticleTint = 'off', powerups: Powerup[] = []) {
        const dt = Math.min(elapsed - lastCameraTime, 0.05)
        lastCameraTime = elapsed
        // Peers first: their avatars are placed and their cosmetic shots replayed, which also rebuilds
        // the bullet target list that the aim assist and the hit test below both read.
        world.syncRemotes(remotes, elapsed, dt)
        world.syncPowerups(powerups, elapsed, dt)
        world.setActiveRing(nextRing)

        if (input.flap) lastFlapAt = elapsed
        const beat = Math.sin(Math.min(1, (elapsed - lastFlapAt) / 0.45) * Math.PI * 2) * 0.62
        const localWings = { left: 0, right: 0 }
        for (const { shoulder, elbow, side } of flyer.wings) {
            const angle = poseWings ? (side < 0 ? poseWings.leftWing : poseWings.rightWing) : beat - (1 - input.spread) * 0.85
            const lag = angle - shoulder.rotation.z * side
            const tip = THREE.MathUtils.clamp(-0.1 + angle * 0.3 - lag * 0.65, -0.65, 0.65)
            shoulder.rotation.z += (side * angle - shoulder.rotation.z) * 0.25
            elbow.rotation.z += (side * tip - elbow.rotation.z) * 0.16
            const current = shoulder.rotation.z * side
            if (side < 0) localWings.left = current
            else localWings.right = current
        }
        const localStroke = stepFlapDetector(localFlap, (localWings.left + localWings.right) / 2)
        // Head aim: the same clamped offset the shot uses turns the head, so the beak leads the
        // round. Yaw is negated because the model's local forward is -Z (see `vehicles.ts`).
        const headAim = headAimOffset(poseHead)
        flyer.head.rotation.x += (headAim.pitch - flyer.head.rotation.x) * 0.18
        flyer.head.rotation.y += (-headAim.yaw - flyer.head.rotation.y) * 0.18
        flyer.head.rotation.z += ((poseHead?.tilt ?? 0) - flyer.head.rotation.z) * 0.18
        // A hit rattles the whole bird; a dying one tumbles instead of banking.
        const tumble = state.dead ? state.spin : 0
        flyer.group.position.set(
            state.x + Math.sin(elapsed * 92) * state.shake * 0.3,
            state.y + 1.1 + Math.cos(elapsed * 71) * state.shake * 0.25,
            state.z + Math.sin(elapsed * 83) * state.shake * 0.3,
        )
        flyer.group.rotation.set(
            state.dead ? tumble * 0.6 : Math.sin(elapsed * 2) * 0.025,
            -state.yaw + (state.dead ? tumble * 0.5 : 0),
            state.dead ? tumble : state.bank,
        )
        const angle = Math.atan2(Math.sin(state.yaw - cameraYaw), Math.cos(state.yaw - cameraYaw))
        cameraYaw += angle * (1 - Math.exp(-2.3 * dt))
        cameraTarget.set(state.x - Math.sin(cameraYaw) * 12, state.y + 7, state.z + Math.cos(cameraYaw) * 12)
        world.camera.position.lerp(cameraTarget, 1 - Math.exp(-3 * dt))
        world.camera.lookAt(state.x + Math.sin(cameraYaw) * 7, state.y + 1, state.z - Math.cos(cameraYaw) * 7)
        flyer.group.updateMatrixWorld(true)
        // The bird is placed before its flap whoosh is sounded, so the position is never a frame stale.
        if (localStroke !== null && !state.dead) handlers.onFlap?.(flyer.group.position, localStroke)
        // Fire along the bird's heading, lifted by the gun mount and slewed by the pilot's head;
        // gravity provides the drop. `writeAimFromYaw` is shared with the auto-fire cone so the two
        // axes cannot drift apart, and `assistAim` then bends the round slightly toward a rival
        // already near the line, which is what makes gunnery workable while the pilot is flapping.
        flyer.muzzle.getWorldPosition(reticlePosition)
        if (fire) {
            writeAimFromYaw(state.yaw, aimDirection, headAim.yaw, headAim.pitch)
            if (world.weapon.fire(assistAim(reticlePosition, aimDirection, world.hitTargets))) {
                handlers.onShot?.(reticlePosition)
            }
        }
        // Reticle marks the exact spot the next round reaches at RETICLE_RANGE metres, gravity drop
        // included, so the player can see where a shot is actually going.
        const drop = 0.5 * weaponConfig.gravity * (RETICLE_RANGE / weaponConfig.speed) ** 2
        reticlePosition.addScaledVector(writeAimFromYaw(state.yaw, reticleAim, headAim.yaw, headAim.pitch), RETICLE_RANGE)
        reticlePosition.y -= drop
        world.reticle.position.copy(reticlePosition)
        world.reticle.visible = !state.dead
        world.tintReticle(reticleTint)
        for (const hit of world.weapon.update(dt, terrainHeight, world.hitTargets)) handlers.onHit?.(hit.targetId)
        for (const trail of trails) {
            if (!state.flying || state.speed < 4) {
                trail.points.length = 0
                trail.geometry.setDrawRange(0, 0)
                continue
            }
            const tip = trail.elbow.localToWorld(new THREE.Vector3(trail.side * 1.65, 0, 0.3))
            if (!trail.points.length || trail.points[0]!.distanceToSquared(tip) > 0.02) trail.points.unshift(tip)
            if (trail.points.length > TRAIL_SAMPLES) trail.points.length = TRAIL_SAMPLES
            const length = Math.min(12, (state.speed - 3) * 0.6)
            const positions = trail.geometry.getAttribute('position') as THREE.BufferAttribute
            const colors = trail.geometry.getAttribute('color') as THREE.BufferAttribute
            let distance = 0
            let count = 0
            for (let index = 0; index < trail.points.length; index++) {
                const point = trail.points[index]!
                if (index) distance += point.distanceTo(trail.points[index - 1]!)
                if (distance > length) break
                const progress = distance / length
                const neighbor = trail.points[Math.min(index + 1, trail.points.length - 1)]!
                trailDirection.subVectors(point, neighbor).normalize()
                trailView.subVectors(world.camera.position, point).normalize()
                trailSide.crossVectors(trailDirection, trailView).normalize().multiplyScalar(0.04 + 0.065 * (1 - progress))
                positions.setXYZ(index * 2, point.x + trailSide.x, point.y + trailSide.y, point.z + trailSide.z)
                positions.setXYZ(index * 2 + 1, point.x - trailSide.x, point.y - trailSide.y, point.z - trailSide.z)
                const opacity = 0.72 * (1 - progress) ** 1.7
                colors.setXYZW(index * 2, 0.86, 0.97, 1, opacity)
                colors.setXYZW(index * 2 + 1, 0.86, 0.97, 1, opacity)
                count++
            }
            positions.needsUpdate = true
            colors.needsUpdate = true
            trail.geometry.setDrawRange(0, Math.max(0, count - 1) * 6)
        }
        world.present()
        return localWings
    }

    function dispose() {
        trails.forEach((trail) => {
            world.scene.remove(trail.ribbon)
            trail.geometry.dispose()
        })
        trailMaterial.dispose()
        flyer.dispose()
        world.dispose()
    }

    return {
        render,
        dispose,
        rounds: () => world.weapon.rounds,
        addRounds: (amount: number) => world.weapon.addRounds(amount),
        resetRounds: () => world.weapon.resetRounds(),
    }
}
