import * as THREE from 'three'
import { createFlapDetector, stepFlapDetector, type FlapDetector } from './audio'
import { courseRings } from './course'
import type { RemoteFlight } from './network'
import type { Powerup } from './powerup'
import { terrainHeight } from './terrain'
import { buildFlyer, buildTank } from './vehicles'
import type { VehicleKind } from './vehicle'
import { createWeaponRig, weaponConfig, type BulletTarget, type WeaponConfig, type WeaponRig } from './weapon'

/** Radius of the sphere bullets test against a bird, in metres. */
const BIRD_HIT_RADIUS = 1.5
/** Radius of the sphere bullets test against a tank; a hull is a much bigger target than a bird. */
const TANK_HIT_RADIUS = 2.4
/** How far above a vehicle's origin its hit sphere sits, in metres (a tank's origin is at the ground). */
const BIRD_HIT_OFFSET_Y = 0
const TANK_HIT_OFFSET_Y = 0.9
/** Vertical offset a bird avatar is drawn at, so its body centre matches the flight position. */
const BIRD_AVATAR_OFFSET_Y = 1.1
/** Seconds for a peer's hit shake to fade; mirrors `shakeTime` in flight.ts. */
const REMOTE_SHAKE_TIME = 0.4
/** Tumble rate for a bird its owner reported dead, in radians per second. */
const DEATH_SPIN_RATE = 9
/** Metres downrange at which the reticle marks the predicted round position. */
export const RETICLE_RANGE = 45
/** Sprite scale that holds the reticle at a constant size on screen. */
const RETICLE_SCALE = 0.1

/** Colour the aim reticle is tinted to, driven by the App's body-mode auto-fire state. */
export type ReticleTint = 'off' | 'seeking' | 'locked' | 'firing'

/** Tint and opacity of the reticle per auto-fire state. */
const RETICLE_STYLES: Record<ReticleTint, { color: number; opacity: number }> = {
    off: { color: 0xf2fbf6, opacity: 0.6 },
    seeking: { color: 0x8fd0e8, opacity: 0.85 },
    locked: { color: 0xffd98a, opacity: 1 },
    firing: { color: 0xff9152, opacity: 1 },
}

/**
 * Draws the aim reticle as a ring with four ticks. The texture stays white (with a dark halo so it
 * reads over both the pale sky and the ground) and is tinted per auto-fire state.
 */
function createReticleTexture(): THREE.CanvasTexture {
    const size = 64
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (context) {
        const center = size / 2
        context.lineCap = 'round'
        const stroke = (width: number, color: string) => {
            context.strokeStyle = color
            context.lineWidth = width
            context.beginPath()
            context.arc(center, center, 20, 0, Math.PI * 2)
            context.moveTo(center, 3)
            context.lineTo(center, 12)
            context.moveTo(center, size - 3)
            context.lineTo(center, size - 12)
            context.moveTo(3, center)
            context.lineTo(12, center)
            context.moveTo(size - 3, center)
            context.lineTo(size - 12, center)
            context.stroke()
        }
        stroke(9, '#0e241c')
        stroke(4, '#ffffff')
    }
    return new THREE.CanvasTexture(canvas)
}

/** A plain 3D point. Event handlers read the numbers immediately, before the scratch vector is reused. */
export interface PointLike {
    x: number
    y: number
    z: number
}

export interface SceneHandlers {
    /** Called when a round fired by this client strikes another vehicle, so the hit can be reported. */
    onHit?: (victimId: number) => void
    /** Every round that actually leaves a muzzle, local and remote, with its world spawn point. */
    onShot?: (origin: PointLike) => void
    /** One wing downstroke, with the bird's world position; `intensity` is `0..1`. */
    onFlap?: (position: PointLike, intensity: number) => void
    /** A round stopping on terrain or a vehicle; `energy` is its speed as a fraction of muzzle speed. */
    onImpact?: (position: PointLike, energy: number) => void
}

export interface WorldOptions {
    /** The local vehicle's root object, added to the scene by the world. */
    vehicle: THREE.Object3D
    /** Muzzle of the local vehicle's gun, used by the weapon rig as the spawn point for rounds. */
    muzzle: THREE.Object3D
    /** Which kind the local vehicle is; peers of the other kind are built lazily as clones. */
    kind: VehicleKind
    /** Ballistics for the local gun. Defaults to the bird's gun. */
    config?: WeaponConfig
    handlers?: SceneHandlers
}

export interface World {
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    renderer: THREE.WebGLRenderer
    weapon: WeaponRig
    reticle: THREE.Sprite
    reticleMaterial: THREE.SpriteMaterial
    /**
     * Live peers as bullet targets, rebuilt by `syncRemotes` each frame. The local rig must call
     * `syncRemotes` before it fires, so the aim assist and the hit test read identical positions.
     */
    hitTargets: BulletTarget[]
    /**
     * Adds/removes peer avatars, animates them, replays their cosmetic shots, rebuilds the hit
     * target list and emits remote flap sounds. `dt` drives the hit shake.
     */
    syncRemotes: (remotes: RemoteFlight[], elapsed: number, dt: number) => void
    /** Places, bobs and retires the server-owned power-up visuals, bursting any that are taken. */
    syncPowerups: (powerups: Powerup[], elapsed: number, dt: number) => void
    /** Highlights the course ring the player is currently chasing. */
    setActiveRing: (nextRing: number) => void
    /** Applies the reticle tint for the given auto-fire state. */
    tintReticle: (tint: ReticleTint) => void
    /** Draws one frame. */
    present: () => void
    dispose: () => void
}

/**
 * Builds everything the two vehicle rigs share: the renderer, camera, lights, terrain and trees, the
 * weapon rig, the reticle, the peer avatars, the power-ups and the course markers. The rigs own only
 * their own vehicle, its camera placement and its aiming.
 */
export function createWorld(container: HTMLElement, options: WorldOptions): World {
    const { vehicle, muzzle, kind } = options
    const handlers = options.handlers ?? {}
    const config = options.config ?? weaponConfig

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#d3e8df')
    scene.fog = new THREE.FogExp2('#d3e8df', 0.004)
    const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1300)
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.6
    container.appendChild(renderer.domElement)

    scene.add(new THREE.HemisphereLight('#fff8dd', '#577d6d', 2.3))
    const sun = new THREE.DirectionalLight('#fff2cf', 2.8)
    sun.position.set(-60, 90, -80)
    scene.add(sun)

    const earth = new THREE.PlaneGeometry(900, 900, 100, 100)
    earth.rotateX(-Math.PI / 2)
    const position = earth.getAttribute('position')
    if (!position) throw new Error('Terrain geometry has no position attribute')
    for (let index = 0; index < position.count; index++) {
        position.setY(index, terrainHeight(position.getX(index), position.getZ(index)))
    }
    earth.computeVertexNormals()
    const lowland = new THREE.Color('#698967')
    const hillside = new THREE.Color('#a2b780')
    const crest = new THREE.Color('#d3c9a4')
    const groundColor = new THREE.Color()
    const colors: number[] = []
    for (let index = 0; index < position.count; index++) {
        const height = position.getY(index)
        groundColor.copy(lowland).lerp(hillside, THREE.MathUtils.clamp((height + 8) / 23, 0, 1))
        groundColor.lerp(crest, THREE.MathUtils.clamp((height - 9) / 18, 0, 0.7))
        colors.push(groundColor.r, groundColor.g, groundColor.b)
    }
    earth.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    const landMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })
    const land = new THREE.Mesh(earth, landMaterial)
    scene.add(land)

    const trunkGeometry = new THREE.CylinderGeometry(0.16, 0.23, 1.6, 5)
    const crownGeometry = new THREE.ConeGeometry(1.4, 4.4, 6)
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#785c47', flatShading: true })
    const crownMaterials = ['#406b55', '#527c5a', '#627a48'].map((color) => new THREE.MeshStandardMaterial({ color, flatShading: true }))
    for (let index = 0; index < 125; index++) {
        const x = Math.sin(index * 53.47) * 350
        const z = Math.cos(index * 29.61) * 350
        if (Math.hypot(x, z) < 22) continue
        const scale = 0.8 + (index % 6) * 0.12
        const tree = new THREE.Group()
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial)
        trunk.position.y = 0.8
        const crown = new THREE.Mesh(crownGeometry, crownMaterials[index % crownMaterials.length]!)
        crown.position.y = 3.15
        tree.add(trunk, crown)
        tree.position.set(x, terrainHeight(x, z), z)
        tree.scale.setScalar(scale)
        scene.add(tree)
    }

    scene.add(vehicle)
    const weapon = createWeaponRig(scene, muzzle, { onImpact: (impact, energy) => handlers.onImpact?.(impact, energy) }, config)

    const reticleTexture = createReticleTexture()
    const reticleMaterial = new THREE.SpriteMaterial({
        map: reticleTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
        toneMapped: false,
    })
    const reticle = new THREE.Sprite(reticleMaterial)
    reticle.scale.set(RETICLE_SCALE, RETICLE_SCALE, 1)
    reticle.frustumCulled = false
    reticle.renderOrder = 3
    scene.add(reticle)

    // Peer avatars. The local kind reuses the local vehicle as its prototype; the other kind is built
    // on first sight, so a solo session never pays for a mesh it will not draw.
    const prototypeDisposers = new Map<VehicleKind, () => void>()
    const kindPrototypes = new Map<VehicleKind, THREE.Object3D>()
    kindPrototypes.set(kind, vehicle)
    /** Build (once) a prototype to clone avatars of `target` from. */
    function prototypeFor(target: VehicleKind): THREE.Object3D {
        const existing = kindPrototypes.get(target)
        if (existing) return existing
        const rig = target === 'tank' ? buildTank() : buildFlyer()
        prototypeDisposers.set(target, rig.dispose)
        kindPrototypes.set(target, rig.group)
        return rig.group
    }

    const remoteVehicles = new Map<number, THREE.Object3D>()
    const remoteMuzzles = new Map<number, THREE.Object3D>()
    /** Last health reported per peer, used to arm their hit shake. */
    const remoteHealth = new Map<number, number>()
    /** Decaying hit-shake intensity per peer. */
    const remoteShake = new Map<number, number>()
    /** Latest reported horizontal velocity per peer, in m/s, used to lead aim-assisted shots. */
    const remoteVelocityX = new Map<number, number>()
    const remoteVelocityZ = new Map<number, number>()
    /** Wing-beat detector per peer (birds only), so a remote downstroke plays its whoosh. */
    const remoteFlaps = new Map<number, FlapDetector>()
    const remoteBadgeGeometry = new THREE.SphereGeometry(0.18, 8, 6)
    const remoteBadgeMaterial = new THREE.MeshBasicMaterial({ color: '#45dbbb' })
    /** Reused target objects and the per-frame view handed to the weapon; no per-frame allocation. */
    const hitTargetPool: BulletTarget[] = []
    const hitTargets: BulletTarget[] = []

    // Power-ups: emissive cores inside a spinning ring, so they read as collectible against the sky.
    const powerupCoreGeometry = new THREE.OctahedronGeometry(0.85, 0)
    const powerupCoreMaterial = new THREE.MeshStandardMaterial({
        color: '#ffe9a8', emissive: '#ffab3d', emissiveIntensity: 1.8, roughness: 0.25, metalness: 0.1,
    })
    const powerupRingGeometry = new THREE.TorusGeometry(1.4, 0.1, 8, 32)
    const powerupRingMaterial = new THREE.MeshBasicMaterial({
        color: '#ffd27a', toneMapped: false, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })
    /** One visual per live slot, keyed by the server's slot id. */
    const powerupVisuals = new Map<number, { group: THREE.Group; core: THREE.Mesh; ring: THREE.Mesh }>()
    // Pooled pickup bursts: a ring that expands and fades where a power-up was just collected.
    const burstGeometry = new THREE.RingGeometry(0.6, 0.95, 24)
    burstGeometry.rotateX(-Math.PI / 2)
    const burstPool = Array.from({ length: 4 }, () => {
        const material = new THREE.MeshBasicMaterial({
            color: '#ffe6a0', toneMapped: false, transparent: true, opacity: 0.9,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
        const mesh = new THREE.Mesh(burstGeometry, material)
        mesh.visible = false
        mesh.frustumCulled = false
        scene.add(mesh)
        return { mesh, material, age: 0, life: 0.5 }
    })
    let burstCursor = 0
    function spawnPickupBurst(x: number, y: number, z: number) {
        const burst = burstPool[burstCursor % burstPool.length]!
        burstCursor += 1
        burst.age = 0
        burst.mesh.position.set(x, y, z)
        burst.mesh.visible = true
    }

    const courseMarkers = courseRings.map((ring) => {
        const color = ring.kind === 'start' ? '#45dbbb' : ring.kind === 'finish' ? '#ffd07e' : '#e4f5ee'
        const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, roughness: 0.3 })
        const marker = new THREE.Group()
        marker.position.set(ring.x, ring.y, ring.z)
        marker.rotation.y = Math.atan2(-ring.forwardX, -ring.forwardZ)
        marker.add(new THREE.Mesh(new THREE.TorusGeometry(ring.radius, 0.18, 10, 64), material))
        if (ring.kind !== 'checkpoint') {
            marker.add(new THREE.Mesh(new THREE.TorusGeometry(ring.radius + 0.35, 0.07, 8, 64), material))
        }
        const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), material)
        beacon.position.y = ring.radius + 0.75
        marker.add(beacon)
        scene.add(marker)
        return material
    })

    const remoteAim = new THREE.Vector3()
    const remoteOrigin = new THREE.Vector3()
    const remoteQuaternion = new THREE.Quaternion()

    function resize() {
        const width = container.clientWidth
        const height = container.clientHeight
        if (!width || !height) return
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    resize()

    /** Rebuilds the target list from the live peer avatars; wrecks cannot be hit again. */
    function refreshHitTargets() {
        hitTargets.length = 0
        for (const [id, avatar] of remoteVehicles) {
            if ((remoteHealth.get(id) ?? 0) <= 0) continue
            const remoteKind = avatar.userData.kind as VehicleKind | undefined
            let target = hitTargetPool[hitTargets.length]
            if (!target) {
                target = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: BIRD_HIT_RADIUS }
                hitTargetPool.push(target)
            }
            target.id = id
            target.x = avatar.position.x
            target.y = avatar.position.y + (remoteKind === 'tank' ? TANK_HIT_OFFSET_Y : BIRD_HIT_OFFSET_Y)
            target.z = avatar.position.z
            target.radius = remoteKind === 'tank' ? TANK_HIT_RADIUS : BIRD_HIT_RADIUS
            // Velocity is what turns the aim assist into a lead rather than a plain nudge.
            target.vx = remoteVelocityX.get(id) ?? 0
            target.vy = 0
            target.vz = remoteVelocityZ.get(id) ?? 0
            hitTargets.push(target)
        }
    }

    function syncRemotes(remotes: RemoteFlight[], elapsed: number, dt: number) {
        const active = new Set(remotes.map((remote) => remote.id))
        for (const [id, avatar] of remoteVehicles) {
            if (!active.has(id)) {
                scene.remove(avatar)
                remoteVehicles.delete(id)
                remoteMuzzles.delete(id)
                remoteHealth.delete(id)
                remoteShake.delete(id)
                remoteFlaps.delete(id)
                remoteVelocityX.delete(id)
                remoteVelocityZ.delete(id)
            }
        }
        for (const remote of remotes) {
            const remoteKind: VehicleKind = remote.kind
            let avatar = remoteVehicles.get(remote.id)
            if (!avatar || (avatar.userData.kind as VehicleKind) !== remoteKind) {
                if (avatar) scene.remove(avatar)
                avatar = prototypeFor(remoteKind).clone(true)
                avatar.userData.kind = remoteKind
                const badge = new THREE.Mesh(remoteBadgeGeometry, remoteBadgeMaterial)
                badge.position.y = remoteKind === 'tank' ? 1.9 : 2.35
                avatar.add(badge)
                scene.add(avatar)
                remoteVehicles.set(remote.id, avatar)
                remoteMuzzles.delete(remote.id)
                const avatarMuzzle = avatar.getObjectByName('muzzle')
                if (avatarMuzzle) remoteMuzzles.set(remote.id, avatarMuzzle)
            }
            // Arm a shake when a peer's reported health drops, and tumble a bird while it is dead.
            const lastHealth = remoteHealth.get(remote.id)
            if (lastHealth !== undefined && remote.flight.health < lastHealth) remoteShake.set(remote.id, 1)
            remoteHealth.set(remote.id, remote.flight.health)
            // The wire carries heading and airspeed, which is all the assist needs to lead a shot.
            remoteVelocityX.set(remote.id, Math.sin(remote.flight.yaw) * remote.flight.speed)
            remoteVelocityZ.set(remote.id, -Math.cos(remote.flight.yaw) * remote.flight.speed)
            const peerShake = Math.max(0, (remoteShake.get(remote.id) ?? 0) - dt / REMOTE_SHAKE_TIME)
            remoteShake.set(remote.id, peerShake)
            const dying = remote.flight.health <= 0
            const peerTumble = dying ? elapsed * DEATH_SPIN_RATE : 0
            const bobY = remoteKind === 'tank' ? 0 : BIRD_AVATAR_OFFSET_Y
            avatar.position.set(
                remote.flight.x + Math.sin(elapsed * 92 + remote.id) * peerShake * 0.3,
                remote.flight.y + bobY + Math.cos(elapsed * 71 + remote.id) * peerShake * 0.25,
                remote.flight.z + Math.sin(elapsed * 83 + remote.id) * peerShake * 0.3,
            )
            if (remoteKind === 'tank') {
                // Hull heading plus its own slope; the turret is aimed from the wire angles below.
                avatar.rotation.order = 'YXZ'
                avatar.rotation.set(
                    remote.flight.hullPitch,
                    -remote.flight.yaw,
                    remote.flight.hullRoll,
                )
                const turret = avatar.getObjectByName('turret')
                if (turret) {
                    turret.rotation.order = 'YXZ'
                    turret.rotation.x = remote.flight.turretPitch
                    turret.rotation.y = -remote.flight.turretYaw
                }
            } else {
                avatar.rotation.set(
                    dying ? peerTumble * 0.6 : 0,
                    -remote.flight.yaw + (dying ? peerTumble * 0.5 : 0),
                    dying ? peerTumble : remote.flight.bank,
                )
            }
            // Replicate a peer's shot cosmetically: every client simulates every avatar's rounds
            // locally, so no bullet state travels on the wire. The shared rig throttles this to
            // that shooter's own fire interval rather than the 20 Hz packet rate.
            if (remote.fire) {
                const avatarMuzzle = remoteMuzzles.get(remote.id)
                if (avatarMuzzle) {
                    avatar.updateMatrixWorld(true)
                    avatarMuzzle.getWorldPosition(remoteOrigin)
                    avatarMuzzle.getWorldQuaternion(remoteQuaternion)
                    remoteAim.set(0, 0, -1).applyQuaternion(remoteQuaternion)
                    if (weapon.fire(remoteAim, remoteOrigin, remote.id)) handlers.onShot?.(remoteOrigin)
                }
            }
            if (remoteKind === 'tank') continue
            // Remote birds report each shoulder angle, so flapping is visible instead of guessed.
            const fallback = Math.sin(elapsed * 12) * (remote.flap ? 0.55 : 0.07) - (1 - remote.spread) * 0.85
            let peerWing = 0
            for (let index = 0; index < 2; index++) {
                const side = index === 0 ? -1 : 1
                const reported = index === 0 ? remote.flight.wingLeft : remote.flight.wingRight
                const wingAngle = Number.isFinite(reported) ? reported : fallback
                peerWing += wingAngle
                const shoulder = avatar.children[index + 2]!
                const lag = wingAngle - shoulder.rotation.z * side
                const tip = THREE.MathUtils.clamp(-0.1 + wingAngle * 0.3 - lag * 0.65, -0.65, 0.65)
                shoulder.rotation.z += (side * wingAngle - shoulder.rotation.z) * 0.25
                const elbow = shoulder.children[1]
                if (elbow) elbow.rotation.z += (side * tip - elbow.rotation.z) * 0.16
            }
            let peerFlap = remoteFlaps.get(remote.id)
            if (!peerFlap) {
                peerFlap = createFlapDetector()
                remoteFlaps.set(remote.id, peerFlap)
            }
            const peerStroke = stepFlapDetector(peerFlap, peerWing / 2)
            if (peerStroke !== null && !dying) handlers.onFlap?.(avatar.position, peerStroke)
        }
        refreshHitTargets()
    }

    function syncPowerups(powerups: Powerup[], elapsed: number, dt: number) {
        const activeSlots = new Set<number>()
        for (const powerup of powerups) {
            activeSlots.add(powerup.slot)
            let visual = powerupVisuals.get(powerup.slot)
            if (!visual) {
                const core = new THREE.Mesh(powerupCoreGeometry, powerupCoreMaterial)
                const ring = new THREE.Mesh(powerupRingGeometry, powerupRingMaterial)
                ring.rotation.x = Math.PI / 2
                const group = new THREE.Group()
                group.add(core, ring)
                group.frustumCulled = false
                scene.add(group)
                visual = { group, core, ring }
                powerupVisuals.set(powerup.slot, visual)
            }
            visual.group.position.set(powerup.x, powerup.y + Math.sin(elapsed * 1.7 + powerup.slot) * 0.45, powerup.z)
            visual.core.rotation.y = elapsed * 1.4 + powerup.slot
            visual.ring.rotation.z = elapsed * 0.9
        }
        for (const [slot, visual] of powerupVisuals) {
            if (activeSlots.has(slot)) continue
            spawnPickupBurst(visual.group.position.x, visual.group.position.y, visual.group.position.z)
            scene.remove(visual.group)
            powerupVisuals.delete(slot)
        }
        for (const burst of burstPool) {
            if (!burst.mesh.visible) continue
            burst.age += dt
            if (burst.age >= burst.life) {
                burst.mesh.visible = false
                continue
            }
            const progress = burst.age / burst.life
            burst.mesh.scale.setScalar(1 + progress * 3.4)
            burst.material.opacity = 0.9 * (1 - progress)
        }
    }

    function setActiveRing(nextRing: number) {
        courseMarkers.forEach((material, index) => { material.emissiveIntensity = index === nextRing ? 1.8 : 0.4 })
    }

    function tintReticle(tint: ReticleTint) {
        const style = RETICLE_STYLES[tint]
        reticleMaterial.color.setHex(style.color)
        reticleMaterial.opacity = style.opacity
    }

    function present() {
        renderer.render(scene, camera)
    }

    function dispose() {
        observer.disconnect()
        weapon.dispose()
        reticleTexture.dispose()
        reticleMaterial.dispose()
        remoteBadgeGeometry.dispose()
        remoteBadgeMaterial.dispose()
        powerupCoreGeometry.dispose()
        powerupRingGeometry.dispose()
        powerupCoreMaterial.dispose()
        powerupRingMaterial.dispose()
        burstGeometry.dispose()
        burstPool.forEach((burst) => burst.material.dispose())
        powerupVisuals.forEach((visual) => scene.remove(visual.group))
        powerupVisuals.clear()
        for (const [id, avatar] of remoteVehicles) {
            scene.remove(avatar)
            remoteVehicles.delete(id)
        }
        for (const disposer of prototypeDisposers.values()) disposer()
        prototypeDisposers.clear()
        scene.traverse((object) => {
            if (object instanceof THREE.Mesh) object.geometry.dispose()
        })
        const disposed = new Set<THREE.Material>([
            landMaterial, trunkMaterial, ...crownMaterials, ...courseMarkers,
        ])
        for (const material of disposed) material.dispose()
        renderer.dispose()
        renderer.domElement.remove()
    }

    return {
        scene,
        camera,
        renderer,
        weapon,
        reticle,
        reticleMaterial,
        hitTargets,
        syncRemotes,
        syncPowerups,
        setActiveRing,
        tintReticle,
        present,
        dispose,
    }
}
