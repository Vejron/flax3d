import * as THREE from 'three'
import { createFlapDetector, stepFlapDetector, type FlapDetector } from './audio'
import { courseRings, courseSpawn } from './course'
import type { FlightControls, FlightState } from './flight'
import type { RemoteFlight } from './network'
import type { Powerup } from './powerup'
import { terrainHeight } from './terrain'
import { assistAim, createGun, createWeaponRig, type BulletTarget, weaponConfig, writeAimFromYaw } from './weapon'

/** Radius of the sphere bullets test against a bird, in metres. */
const BIRD_HIT_RADIUS = 1.5
/** Seconds for a peer's hit shake to fade; mirrors `shakeTime` in flight.ts. */
const REMOTE_SHAKE_TIME = 0.4
/** Tumble rate for a bird its owner reported dead, in radians per second. */
const DEATH_SPIN_RATE = 9
/** Metres downrange at which the reticle marks the predicted round position. */
const RETICLE_RANGE = 45
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
    /** Called when a round fired by this client strikes another bird, so the hit can be reported. */
    onHit?: (victimId: number) => void
    /** Every round that actually leaves a muzzle, local and remote, with its world spawn point. */
    onShot?: (origin: PointLike) => void
    /** One wing downstroke, with the bird's world position; `intensity` is `0..1`. */
    onFlap?: (position: PointLike, intensity: number) => void
    /** A round stopping on terrain or a bird; `energy` is its speed as a fraction of muzzle speed. */
    onImpact?: (position: PointLike, energy: number) => void
}

export { terrainHeight } from './terrain'

export function createScene(container: HTMLElement, handlers: SceneHandlers = {}) {
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
    const land = new THREE.Mesh(earth, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }))
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

    const flyer = new THREE.Group()
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#f7eee1', roughness: 0.62, side: THREE.DoubleSide })
    const wingMaterial = new THREE.MeshStandardMaterial({ color: '#d76748', roughness: 0.8, side: THREE.DoubleSide })
    const featherMaterial = new THREE.MeshStandardMaterial({ color: '#b95743', roughness: 0.85, side: THREE.DoubleSide })
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2.3, 5), bodyMaterial)
    body.rotation.x = -Math.PI / 2
    flyer.add(body)
    const head = new THREE.Group()
    head.position.set(0, 0.25, -0.65)
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.38, 12, 8), bodyMaterial)
    skull.position.set(0, 0.22, -0.2)
    head.add(skull)
    const beakMaterial = new THREE.MeshStandardMaterial({ color: '#efb669', roughness: 0.7 })
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.62, 5), beakMaterial)
    beak.rotation.x = -Math.PI / 2
    beak.position.set(0, 0.14, -0.62)
    head.add(beak)
    const eyeMaterial = new THREE.MeshStandardMaterial({ color: '#273c35', roughness: 0.4 })
    for (const side of [-1, 1]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), eyeMaterial)
        eye.position.set(side * 0.31, 0.29, -0.34)
        head.add(eye)
    }
    flyer.add(head)
    const wings: { shoulder: THREE.Group; elbow: THREE.Group; side: number }[] = []
    for (const side of [-1, 1]) {
        const innerShape = new THREE.Shape()
        innerShape.moveTo(0, -0.12)
        innerShape.lineTo(side * 0.55, -0.32)
        innerShape.lineTo(side * 1.45, -0.12)
        innerShape.lineTo(side * 1.45, 0.58)
        innerShape.lineTo(side * 1.22, 0.74)
        innerShape.lineTo(side * 1.12, 0.65)
        innerShape.lineTo(side * 0.85, 0.88)
        innerShape.lineTo(side * 0.76, 0.71)
        innerShape.lineTo(side * 0.46, 0.85)
        innerShape.lineTo(0, 0.48)
        const innerGeometry = new THREE.ShapeGeometry(innerShape)
        innerGeometry.rotateX(Math.PI / 2)

        const outerShape = new THREE.Shape()
        outerShape.moveTo(0, 0)
        outerShape.lineTo(side * 0.65, -0.18)
        outerShape.lineTo(side * 1.54, 0.04)
        outerShape.lineTo(side * 1.75, 0.3)
        outerShape.lineTo(side * 1.49, 0.35)
        outerShape.lineTo(side * 1.62, 0.58)
        outerShape.lineTo(side * 1.28, 0.53)
        outerShape.lineTo(side * 1.32, 0.78)
        outerShape.lineTo(side * 0.98, 0.61)
        outerShape.lineTo(side * 0.91, 0.84)
        outerShape.lineTo(side * 0.61, 0.62)
        outerShape.lineTo(0, 0.7)
        const outerGeometry = new THREE.ShapeGeometry(outerShape)
        outerGeometry.rotateX(Math.PI / 2)

        const shoulder = new THREE.Group()
        shoulder.position.set(side * 0.18, 0, -0.5)
        shoulder.add(new THREE.Mesh(innerGeometry, wingMaterial))
        const elbow = new THREE.Group()
        elbow.position.set(side * 1.45, 0, -0.62)
        elbow.add(new THREE.Mesh(outerGeometry, featherMaterial))
        shoulder.add(elbow)
        wings.push({ shoulder, elbow, side })
        flyer.add(shoulder)
    }
    // The gun is added last so the wing shoulder groups keep their child indices.
    const gun = createGun(flyer)
    scene.add(flyer)
    const weapon = createWeaponRig(scene, gun.muzzle, { onImpact: (position, energy) => handlers.onImpact?.(position, energy) })
    // Screen-space aim reticle: a billboarded sprite, tinted by the auto-fire state each frame.
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
    const remoteFlyers = new Map<number, THREE.Group>()
    // Remote shots reuse the shared weapon rig, so each avatar only needs its muzzle transform.
    const remoteMuzzles = new Map<number, THREE.Object3D>()
    /** Last health reported per peer, used to arm their hit shake. */
    const remoteHealth = new Map<number, number>()
    /** Decaying hit-shake intensity per peer. */
    const remoteShake = new Map<number, number>()
    /** Latest reported horizontal velocity per peer, in m/s, used to lead aim-assisted shots. */
    const remoteVelocityX = new Map<number, number>()
    const remoteVelocityZ = new Map<number, number>()
    /** Wing-beat detector per peer, so a remote downstroke plays its whoosh at the right moment. */
    const remoteFlaps = new Map<number, FlapDetector>()
    /** Wing-beat detector for the local bird. */
    const localFlap = createFlapDetector()
    /** Reused target objects and the per-frame view handed to the weapon; no per-frame allocation. */
    const hitTargetPool: BulletTarget[] = []
    const hitTargets: BulletTarget[] = []
    const remoteBadgeGeometry = new THREE.SphereGeometry(0.18, 8, 6)
    const remoteBadgeMaterial = new THREE.MeshBasicMaterial({ color: '#45dbbb' })

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

    const trailSamples = 64
    const trailMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
    const trails = wings.map(({ elbow, side }) => {
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(trailSamples * 6), 3).setUsage(THREE.DynamicDrawUsage))
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(trailSamples * 8), 4).setUsage(THREE.DynamicDrawUsage))
        const indices: number[] = []
        for (let index = 0; index < trailSamples - 1; index++) {
            const vertex = index * 2
            indices.push(vertex, vertex + 1, vertex + 2, vertex + 1, vertex + 3, vertex + 2)
        }
        geometry.setIndex(indices)
        geometry.setDrawRange(0, 0)
        const ribbon = new THREE.Mesh(geometry, trailMaterial)
        ribbon.frustumCulled = false
        ribbon.renderOrder = 1
        scene.add(ribbon)
        return { elbow, side, geometry, points: [] as THREE.Vector3[] }
    })
    const trailDirection = new THREE.Vector3()
    const trailView = new THREE.Vector3()
    const trailSide = new THREE.Vector3()
    const aimDirection = new THREE.Vector3()
    const reticleAim = new THREE.Vector3()
    const reticlePosition = new THREE.Vector3()
    const remoteAim = new THREE.Vector3()
    const remoteOrigin = new THREE.Vector3()
    const remoteQuaternion = new THREE.Quaternion()
    /** Reused point handed to the shot handler, so no event allocates per frame. */
    const shotPoint = { x: 0, y: 0, z: 0 }

    const cameraTarget = new THREE.Vector3(
        courseSpawn.x - Math.sin(courseSpawn.yaw) * 12,
        terrainHeight(courseSpawn.x, courseSpawn.z) + 7,
        courseSpawn.z + Math.cos(courseSpawn.yaw) * 12,
    )
    camera.position.copy(cameraTarget)
    let cameraYaw = courseSpawn.yaw
    let lastCameraTime = 0
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

    let lastFlapAt = -Infinity
    /** Rebuilds the target list from the live peer avatars; wrecks cannot be hit again. */
    function refreshHitTargets() {
        hitTargets.length = 0
        for (const [id, avatar] of remoteFlyers) {
            if ((remoteHealth.get(id) ?? 0) <= 0) continue
            let target = hitTargetPool[hitTargets.length]
            if (!target) {
                target = { id, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, radius: BIRD_HIT_RADIUS }
                hitTargetPool.push(target)
            }
            target.id = id
            target.x = avatar.position.x
            target.y = avatar.position.y
            target.z = avatar.position.z
            // Velocity is what turns the aim assist into a lead rather than a plain nudge.
            target.vx = remoteVelocityX.get(id) ?? 0
            target.vy = 0
            target.vz = remoteVelocityZ.get(id) ?? 0
            hitTargets.push(target)
        }
    }
    function render(state: FlightState, elapsed: number, input: FlightControls, poseWings: { leftWing: number; rightWing: number } | null, poseHead: { yaw: number; tilt: number } | null, nextRing: number, remotes: RemoteFlight[] = [], fire = false, reticleTint: ReticleTint = 'off', powerups: Powerup[] = []) {
        const dt = Math.min(elapsed - lastCameraTime, 0.05)
        lastCameraTime = elapsed
        const active = new Set(remotes.map((remote) => remote.id))
        for (const [id, avatar] of remoteFlyers) {
            if (!active.has(id)) {
                scene.remove(avatar)
                remoteFlyers.delete(id)
                remoteMuzzles.delete(id)
                remoteHealth.delete(id)
                remoteShake.delete(id)
                remoteFlaps.delete(id)
                remoteVelocityX.delete(id)
                remoteVelocityZ.delete(id)
            }
        }
        for (const remote of remotes) {
            let avatar = remoteFlyers.get(remote.id)
            if (!avatar) {
                avatar = flyer.clone(true)
                const badge = new THREE.Mesh(remoteBadgeGeometry, remoteBadgeMaterial)
                badge.position.y = 2.35
                avatar.add(badge)
                scene.add(avatar)
                remoteFlyers.set(remote.id, avatar)
                const avatarMuzzle = avatar.getObjectByName('muzzle')
                if (avatarMuzzle) remoteMuzzles.set(remote.id, avatarMuzzle)
            }
            // Arm a shake when a peer's reported health drops, and tumble it while it is dead.
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
            avatar.position.set(
                remote.flight.x + Math.sin(elapsed * 92 + remote.id) * peerShake * 0.3,
                remote.flight.y + 1.1 + Math.cos(elapsed * 71 + remote.id) * peerShake * 0.25,
                remote.flight.z + Math.sin(elapsed * 83 + remote.id) * peerShake * 0.3,
            )
            avatar.rotation.set(
                dying ? peerTumble * 0.6 : 0,
                -remote.flight.yaw + (dying ? peerTumble * 0.5 : 0),
                dying ? peerTumble : remote.flight.bank,
            )
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
            // Remote peers report each shoulder angle, so flapping is visible instead of guessed.
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
        courseMarkers.forEach((material, index) => { material.emissiveIntensity = index === nextRing ? 1.8 : 0.4 })
        if (input.flap) lastFlapAt = elapsed
        const beat = Math.sin(Math.min(1, (elapsed - lastFlapAt) / 0.45) * Math.PI * 2) * 0.62
        const localWings = { left: 0, right: 0 }
        for (const { shoulder, elbow, side } of wings) {
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
        head.rotation.y += ((poseHead?.yaw ?? 0) - head.rotation.y) * 0.18
        head.rotation.z += ((poseHead?.tilt ?? 0) - head.rotation.z) * 0.18
        // A hit rattles the whole bird; a dying one tumbles instead of banking.
        const tumble = state.dead ? state.spin : 0
        flyer.position.set(
            state.x + Math.sin(elapsed * 92) * state.shake * 0.3,
            state.y + 1.1 + Math.cos(elapsed * 71) * state.shake * 0.25,
            state.z + Math.sin(elapsed * 83) * state.shake * 0.3,
        )
        flyer.rotation.set(
            state.dead ? tumble * 0.6 : Math.sin(elapsed * 2) * 0.025,
            -state.yaw + (state.dead ? tumble * 0.5 : 0),
            state.dead ? tumble : state.bank,
        )
        const angle = Math.atan2(Math.sin(state.yaw - cameraYaw), Math.cos(state.yaw - cameraYaw))
        cameraYaw += angle * (1 - Math.exp(-2.3 * dt))
        cameraTarget.set(state.x - Math.sin(cameraYaw) * 12, state.y + 7, state.z + Math.cos(cameraYaw) * 12)
        camera.position.lerp(cameraTarget, 1 - Math.exp(-3 * dt))
        camera.lookAt(state.x + Math.sin(cameraYaw) * 7, state.y + 1, state.z - Math.cos(cameraYaw) * 7)
        flyer.updateMatrixWorld(true)
        // The bird is placed before its flap whoosh is sounded, so the position is never a frame stale.
        if (localStroke !== null && !state.dead) handlers.onFlap?.(flyer.position, localStroke)
        // Fire along the bird's heading, tilted up by the gun mount; gravity provides the drop.
        // `writeAimFromYaw` is shared with the auto-fire cone so the two axes cannot drift apart,
        // and `assistAim` then bends the round slightly toward a rival already near the line, which
        // is what makes gunnery workable while the pilot is flapping. Refreshed here so the assist
        // and the hit test below read exactly the same target positions.
        refreshHitTargets()
        gun.muzzle.getWorldPosition(reticlePosition)
        if (fire) {
            writeAimFromYaw(state.yaw, aimDirection)
            if (weapon.fire(assistAim(reticlePosition, aimDirection, hitTargets))) {
                shotPoint.x = reticlePosition.x
                shotPoint.y = reticlePosition.y
                shotPoint.z = reticlePosition.z
                handlers.onShot?.(shotPoint)
            }
        }
        // Reticle marks the exact spot the next round reaches at RETICLE_RANGE metres, gravity drop
        // included, so the player can see where a shot is actually going.
        const drop = 0.5 * weaponConfig.gravity * (RETICLE_RANGE / weaponConfig.speed) ** 2
        reticlePosition.addScaledVector(writeAimFromYaw(state.yaw, reticleAim), RETICLE_RANGE)
        reticlePosition.y -= drop
        reticle.position.copy(reticlePosition)
        reticle.visible = !state.dead
        const style = RETICLE_STYLES[reticleTint]
        reticleMaterial.color.setHex(style.color)
        reticleMaterial.opacity = style.opacity
        for (const hit of weapon.update(dt, terrainHeight, hitTargets)) handlers.onHit?.(hit.targetId)
        for (const trail of trails) {
            if (!state.flying || state.speed < 4) {
                trail.points.length = 0
                trail.geometry.setDrawRange(0, 0)
                continue
            }
            const tip = trail.elbow.localToWorld(new THREE.Vector3(trail.side * 1.65, 0, 0.3))
            if (!trail.points.length || trail.points[0]!.distanceToSquared(tip) > 0.02) trail.points.unshift(tip)
            if (trail.points.length > trailSamples) trail.points.length = trailSamples
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
                trailView.subVectors(camera.position, point).normalize()
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
        // Power-ups bob and spin so they read as pickups; a slot leaving the list means someone
        // (possibly this client) collected it, which fires a burst at its last position.
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
        renderer.render(scene, camera)
        return localWings
    }

    function dispose() {
        observer.disconnect()
        weapon.dispose()
        gun.dispose()
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
        scene.traverse((object) => {
            if (object instanceof THREE.Mesh) object.geometry.dispose()
        })
            ;[bodyMaterial, wingMaterial, featherMaterial, beakMaterial, eyeMaterial, trunkMaterial, trailMaterial, ...courseMarkers, ...crownMaterials, land.material].forEach((material) => material.dispose())
        renderer.dispose()
        renderer.domElement.remove()
    }

    return {
        render,
        dispose,
        rounds: () => weapon.rounds,
        addRounds: (amount: number) => weapon.addRounds(amount),
        resetRounds: () => weapon.resetRounds(),
    }
}