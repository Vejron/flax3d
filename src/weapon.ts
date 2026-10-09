import * as THREE from 'three'

/**
 * Plain 3D vector used by the projectile simulation. Kept free of THREE types so
 * the ballistics can be unit tested without a WebGL context.
 */
export interface Vec3 {
    x: number
    y: number
    z: number
}

export interface Bullet {
    position: Vec3
    velocity: Vec3
    age: number
    /** Network id of the shooter. Only the local shooter's rounds can damage other birds. */
    owner: number
}

export const weaponConfig = {
    /** Muzzle speed in metres per second. */
    speed: 55,
    /** Downward acceleration applied to every bullet, in m/s². This is what produces the drop. */
    gravity: 24,
    /** Seconds a bullet stays alive before it is recycled. */
    life: 4,
    /**
     * Aim scatter half-angle in radians. This is the "you cannot just hold the trigger" dial: at
     * 0.05 rad (~2.9 degrees) a round can wander about 1.5 m at 30 m and 2.9 m at 60 m, so a burst
     * lands a fraction of its shots instead of sawing a rival in half in one pass.
     */
    spread: 0.05,
    /**
     * Soft aim assist, in degrees: the widest angular error that still attracts a shot toward a
     * rival. Paired with `aimAssistStrength` it sharpens a near miss without ever flying the bullet
     * for the player, so the spread above still decides each individual round.
     */
    aimAssistCone: 5,
    /** Metres within which a rival can attract aim assist. */
    aimAssistRange: 70,
    /** Fraction of the aiming error the assist removes, `0..1`. Kept partial so it stays soft. */
    aimAssistStrength: 0.6,
    /**
     * Fraction of the tracked head turn applied to the aim, `0..1`. The head yaw is measured against
     * the shoulders (which steer the bird), so this lets a glance fine-tune the shot without
     * wrestling the flight path. Zero disables head aiming entirely.
     */
    headAimGain: 0.7,
    /** Largest head-driven yaw offset from the flight heading, in radians (~26 degrees). */
    headAimYawLimit: 0.45,
    /** Largest head-driven pitch offset added to the gun mount, in radians (~14 degrees). */
    headAimPitchLimit: 0.25,
    /** Seconds between shots while the trigger is held. */
    fireInterval: 0.11,
    /** Hard cap on live bullets; the pool never grows past this. */
    maxBullets: 160,
    /** Longest distance between collision samples, in metres. */
    substep: 0.5,
    /** Safety cap on samples per frame so a stalled tab cannot hang the loop. */
    maxSubsteps: 24,
    /** Bullets below this altitude are recycled without an impact effect. */
    killAltitude: -60,
    /** Length of the tracer streak drawn behind each bullet, in metres. */
    tracerLength: 3.2,
    /** Pooled impact rings. */
    maxImpacts: 24,
    /** Lifetime of an impact ring, in seconds. */
    impactLife: 0.45,
    /** Pooled sparks shared by every impact. */
    maxSparks: 320,
    /** Sparks emitted per impact. */
    sparksPerImpact: 14,
    /** Rounds in a full magazine. The gun refuses to fire once this reaches zero. */
    magazineSize: 100,
    /** Rounds granted by one power-up pickup. Ammo stacks, up to `maxRounds`. */
    pickupRounds: 100,
    /** Hard cap on carried rounds, so stacked pickups cannot grow without bound. */
    maxRounds: 300,
}

export type WeaponConfig = typeof weaponConfig

export interface BulletImpact {
    position: Vec3
    normal: Vec3
    velocity: Vec3
    speed: number
}

/** A point aim assist can attract a shot toward. */
export interface AimTarget {
    x: number
    y: number
    z: number
    /** Velocity in m/s when known; the assist leads the shot to where the target will be. */
    vx?: number
    vy?: number
    vz?: number
}

/** A bird that bullets owned by the local shooter can hit. */
export interface BulletTarget extends AimTarget {
    id: number
    radius: number
}

/** A round that struck a bird; the shooter reports it so the victim can apply the damage. */
export interface BulletHit extends BulletImpact {
    targetId: number
}

export interface BulletStep {
    bullet: Bullet
    impact: BulletImpact | null
    hit: BulletHit | null
    dead: boolean
}

/** Builds a bullet travelling at the configured muzzle speed along `direction`. */
export function createBullet(origin: Vec3, direction: Vec3, config: WeaponConfig = weaponConfig, owner = 0): Bullet {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1
    return {
        position: { ...origin },
        velocity: {
            x: (direction.x / length) * config.speed,
            y: (direction.y / length) * config.speed,
            z: (direction.z / length) * config.speed,
        },
        age: 0,
        owner,
    }
}

/**
 * Offsets a direction within a cone of `spread` radians. The offset is always
 * tangential to the aim, so the shot never gets shorter, only wider.
 */
export function scatter(direction: Vec3, spread: number, random: () => number = Math.random): Vec3 {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1
    const x = direction.x / length
    const y = direction.y / length
    const z = direction.z / length
    let ox = random() - 0.5
    let oy = random() - 0.5
    let oz = random() - 0.5
    const along = ox * x + oy * y + oz * z
    ox -= along * x
    oy -= along * y
    oz -= along * z
    const tangent = Math.hypot(ox, oy, oz) || 1
    const angle = spread * random()
    return { x: x + (ox / tangent) * angle, y: y + (oy / tangent) * angle, z: z + (oz / tangent) * angle }
}

/**
 * Flight time for a round of `speed` m/s to intercept a target `p` metres away from the muzzle that
 * is moving at constant velocity `v`, solving `|p + v·t| = speed·t`. Returns the earliest positive
 * root, or `null` when the target outruns the round so no intercept exists.
 */
export function interceptTime(p: Vec3, v: Vec3, speed: number): number | null {
    const a = v.x * v.x + v.y * v.y + v.z * v.z - speed * speed
    const b = 2 * (p.x * v.x + p.y * v.y + p.z * v.z)
    const c = p.x * p.x + p.y * p.y + p.z * p.z
    const roots: number[] = []
    if (Math.abs(a) < 1e-9) {
        // Matched speeds collapse the quadratic to a straight line.
        if (Math.abs(b) > 1e-9) roots.push(-c / b)
    } else {
        const discriminant = b * b - 4 * a * c
        if (discriminant < 0) return null
        const root = Math.sqrt(discriminant)
        roots.push((-b - root) / (2 * a), (-b + root) / (2 * a))
    }
    let soonest = Infinity
    for (const t of roots) if (t > 0 && t < soonest) soonest = t
    return Number.isFinite(soonest) ? soonest : null
}

/** Unit vector in the direction `(x, y, z)`. */
function unit(x: number, y: number, z: number): Vec3 {
    const length = Math.hypot(x, y, z) || 1
    return { x: x / length, y: y / length, z: z / length }
}

/** Cross product of two plain vectors. */
function cross(a: Vec3, b: Vec3): Vec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

/** Spherical interpolation from unit `a` to unit `b` by `t`, so `t` is the exact fraction moved. */
function slerpDirection(a: Vec3, b: Vec3, t: number): Vec3 {
    const cos = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z))
    const angle = Math.acos(cos)
    const sinAngle = Math.sin(angle)
    if (sinAngle < 1e-6) return { x: b.x, y: b.y, z: b.z }
    const from = Math.sin((1 - t) * angle) / sinAngle
    const to = Math.sin(t * angle) / sinAngle
    return unit(a.x * from + b.x * to, a.y * from + b.y * to, a.z * from + b.z * to)
}

/** Rotates unit `v` about unit `axis` by `angle` radians (Rodrigues' rotation formula). */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const kxv = cross(axis, v)
    const along = axis.x * v.x + axis.y * v.y + axis.z * v.z
    const scale = along * (1 - cos)
    return unit(
        v.x * cos + kxv.x * sin + axis.x * scale,
        v.y * cos + kxv.y * sin + axis.y * scale,
        v.z * cos + kxv.z * sin + axis.z * scale,
    )
}

/**
 * Soft aim assist. If the rival nearest the line of fire sits within `aimAssistCone` degrees and
 * `aimAssistRange` metres, the shot is swung `aimAssistStrength` of the way onto it and then led in
 * full to where that rival will be when the round arrives.
 *
 * The two halves are deliberately separate. The aim forgiveness is partial, so the player still has
 * to point at the rival; the lead is total, because a crossing bird at 20 m/s travels many metres
 * during the round's flight and a partial lead would just miss anyway. Gravity and `scatter` still
 * apply on top, so even a led shot is not a guaranteed hit. A rival behind the bird, out of range,
 * or wider of the axis than the cone is ignored entirely.
 */
export function assistAim(
    origin: Vec3,
    direction: Vec3,
    targets: readonly AimTarget[],
    config: WeaponConfig = weaponConfig,
): Vec3 {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1
    const raw: Vec3 = { x: direction.x / length, y: direction.y / length, z: direction.z / length }
    const strength = Math.min(1, Math.max(0, config.aimAssistStrength))
    if (strength === 0 || targets.length === 0) return raw

    const cosLimit = Math.cos((config.aimAssistCone * Math.PI) / 180)
    const rangeSquared = config.aimAssistRange * config.aimAssistRange
    let bestCos = cosLimit
    let rx = 0
    let ry = 0
    let rz = 0
    let vx = 0
    let vy = 0
    let vz = 0
    for (const target of targets) {
        const tx = target.x - origin.x
        const ty = target.y - origin.y
        const tz = target.z - origin.z
        const distanceSquared = tx * tx + ty * ty + tz * tz
        if (distanceSquared === 0 || distanceSquared > rangeSquared) continue
        const distance = Math.sqrt(distanceSquared)
        const cos = (raw.x * tx + raw.y * ty + raw.z * tz) / distance
        // Only the rival closest to the line of fire attracts the shot, so the help never jumps
        // between targets mid-burst.
        if (cos <= bestCos) continue
        bestCos = cos
        rx = tx
        ry = ty
        rz = tz
        vx = target.vx ?? 0
        vy = target.vy ?? 0
        vz = target.vz ?? 0
    }
    if (bestCos <= cosLimit) return raw

    // Forgive `strength` of the aiming error. Slerp, so the fraction really is exact.
    let aim = slerpDirection(raw, unit(rx, ry, rz), strength)

    // Then lead in full: rotate by the angle separating "where it is" from "where it will be".
    // Rotating (rather than re-blending toward the lead point) keeps the forgiveness above intact;
    // blending would scale the lead down and leave a crossing target untouched.
    const flight = interceptTime({ x: rx, y: ry, z: rz }, { x: vx, y: vy, z: vz }, config.speed)
    if (flight === null || flight <= 0) return aim
    const toNow = unit(rx, ry, rz)
    const toLead = unit(rx + vx * flight, ry + vy * flight, rz + vz * flight)
    const axis = cross(toNow, toLead)
    const axisLength = Math.hypot(axis.x, axis.y, axis.z)
    if (axisLength < 1e-9) return aim
    const leadAngle = Math.atan2(axisLength, toNow.x * toLead.x + toNow.y * toLead.y + toNow.z * toLead.z)
    aim = rotateAbout(aim, { x: axis.x / axisLength, y: axis.y / axisLength, z: axis.z / axisLength }, leadAngle)
    return aim
}

/** Terrain surface normal from finite differences of the height field. */
export function terrainNormal(x: number, z: number, terrainHeight: (x: number, z: number) => number): Vec3 {
    const delta = 0.6
    const dx = (terrainHeight(x + delta, z) - terrainHeight(x - delta, z)) / (2 * delta)
    const dz = (terrainHeight(x, z + delta) - terrainHeight(x, z - delta)) / (2 * delta)
    const length = Math.hypot(dx, 1, dz) || 1
    return { x: -dx / length, y: 1 / length, z: -dz / length }
}

/**
 * Advances one bullet with gravity and walks the travelled segment in small
 * samples so a fast round cannot tunnel through a hill or a bird. Returns the
 * new state, any terrain impact, any bird hit, and whether it should be recycled.
 */
export function stepBullet(
    bullet: Bullet,
    seconds: number,
    terrainHeight: (x: number, z: number) => number,
    config: WeaponConfig = weaponConfig,
    targets?: BulletTarget[],
): BulletStep {
    const age = bullet.age + Math.max(0, seconds)
    const velocity = { ...bullet.velocity }
    velocity.y -= config.gravity * Math.max(0, seconds)
    const travelled = Math.hypot(velocity.x, velocity.y, velocity.z) * Math.max(0, seconds)
    const steps = Math.max(1, Math.min(config.maxSubsteps, Math.ceil(travelled / config.substep)))
    const step = Math.max(0, seconds) / steps
    const position = { ...bullet.position }
    let impact: BulletImpact | null = null
    let hit: BulletHit | null = null

    for (let index = 0; index < steps; index++) {
        const next = {
            x: position.x + velocity.x * step,
            y: position.y + velocity.y * step,
            z: position.z + velocity.z * step,
        }
        const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
        if (targets) {
            for (const target of targets) {
                const dx = next.x - target.x
                const dy = next.y - target.y
                const dz = next.z - target.z
                if (dx * dx + dy * dy + dz * dz > target.radius * target.radius) continue
                const inverse = 1 / (speed || 1)
                hit = {
                    targetId: target.id,
                    position: { ...next },
                    // Sparks spray back toward the shooter.
                    normal: { x: -velocity.x * inverse, y: -velocity.y * inverse, z: -velocity.z * inverse },
                    velocity: { ...velocity },
                    speed,
                }
                position.x = next.x
                position.y = next.y
                position.z = next.z
                break
            }
            if (hit) break
        }
        const ground = terrainHeight(next.x, next.z)
        if (next.y <= ground) {
            // Interpolate the crossing so the impact sits on the surface, not below it.
            const above = position.y - terrainHeight(position.x, position.z)
            const below = next.y - ground
            const fraction = above - below > 1e-6 ? Math.min(1, Math.max(0, above / (above - below))) : 1
            const hit = {
                x: position.x + (next.x - position.x) * fraction,
                y: position.y + (next.y - position.y) * fraction,
                z: position.z + (next.z - position.z) * fraction,
            }
            impact = {
                position: hit,
                normal: terrainNormal(hit.x, hit.z, terrainHeight),
                velocity: { ...velocity },
                speed: Math.hypot(velocity.x, velocity.y, velocity.z),
            }
            position.x = hit.x
            position.y = hit.y
            position.z = hit.z
            break
        }
        position.x = next.x
        position.y = next.y
        position.z = next.z
    }

    return {
        bullet: { position, velocity, age, owner: bullet.owner },
        impact,
        hit,
        dead: impact !== null || hit !== null || age >= config.life || position.y < config.killAltitude,
    }
}

/**
 * Upward tilt of the gun mount, in radians. Applied to the beak muzzle marker and to the local shot
 * direction, so a peer's cosmetic tracer leaves at the same lift the round does.
 */
export const gunPitch = THREE.MathUtils.degToRad(10)

/** Head-driven aim offsets, in radians, added on top of the flight heading and the gun mount. */
export interface HeadAim {
    yaw: number
    pitch: number
}

/**
 * Scales a tracked head pose into the offsets the shot uses. The pose is measured against the
 * player's shoulders, so a head turn reads as "aim left or right of the flight path". Offsets are
 * clamped so a glance can never swing the shot far off the heading, and a missing pose (tracking
 * lost) leaves the round on the flight heading.
 */
export function headAimOffset(head: { yaw: number; pitch?: number } | null | undefined, config: WeaponConfig = weaponConfig): HeadAim {
    const gain = config.headAimGain
    const clampOffset = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value))
    return {
        yaw: clampOffset((head?.yaw ?? 0) * gain, config.headAimYawLimit),
        pitch: clampOffset((head?.pitch ?? 0) * gain, config.headAimPitchLimit),
    }
}

/**
 * Writes the local shot direction into `out`: the bird's heading pitched up by the gun mount, plus
 * any head-driven offset. The beak muzzle marker, the local shot and the body-mode auto-fire cone
 * all use this, so the volume the player aims into can never disagree with where the round goes.
 */
export function writeAimFromYaw<T extends Vec3>(yaw: number, out: T, yawOffset = 0, pitchOffset = 0): T {
    const heading = yaw + yawOffset
    const pitch = gunPitch + pitchOffset
    const cosPitch = Math.cos(pitch)
    out.x = Math.sin(heading) * cosPitch
    out.y = Math.sin(pitch)
    out.z = -Math.cos(heading) * cosPitch
    return out
}

/** Shape of the auto-fire trigger volume: `range` is its length and `halfAngle` sets its width. */
export interface AutoFireOptions {
    /** Maximum lock distance in metres. */
    range: number
    /** Cone half-angle in radians. */
    halfAngle: number
    /** Seconds of continuous alignment required before the first shot. */
    dwell: number
    /** Head-driven yaw offset added to the cone axis, so the gate follows the gaze aim. */
    yawOffset?: number
    /** Head-driven pitch offset added to the gun mount. */
    pitchOffset?: number
}

/** A bird the cone can lock; positions are raw flight coordinates (no avatar offset). */
export interface AutoFireTarget {
    x: number
    y: number
    z: number
}

export interface AutoFireResult {
    /** Seconds the cone has been held; carry this into the next call. */
    lock: number
    /** True while a target sits inside the forward cone. */
    locked: boolean
    /** True once the cone has been held for `dwell` seconds, so the trigger should be pulled now. */
    fire: boolean
}

/** Scratch aim reused by `updateAutoFire` so the frame loop allocates nothing. */
const autoFireAim: Vec3 = { x: 0, y: 0, z: 0 }

/**
 * Advances the auto-fire trigger volume one frame. A target is locked while it sits inside a cone
 * of `range` metres and `halfAngle` radians around the gun axis; `fire` only opens up once the cone
 * has been held for `dwell` seconds. `targets` must already exclude wrecks. The caller owns `lock`
 * between frames and must reset it whenever the cone is switched off.
 */
export function updateAutoFire(
    lock: number,
    seconds: number,
    origin: Vec3,
    yaw: number,
    targets: readonly AutoFireTarget[],
    options: AutoFireOptions,
): AutoFireResult {
    const aim = writeAimFromYaw(yaw, autoFireAim, options.yawOffset ?? 0, options.pitchOffset ?? 0)
    const cosLimit = Math.cos(options.halfAngle)
    const rangeSquared = options.range * options.range
    let locked = false
    for (const target of targets) {
        const dx = target.x - origin.x
        const dy = target.y - origin.y
        const dz = target.z - origin.z
        const distanceSquared = dx * dx + dy * dy + dz * dz
        if (distanceSquared > rangeSquared) continue
        const distance = Math.sqrt(distanceSquared)
        if (distance === 0) {
            locked = true
            break
        }
        if ((dx * aim.x + dy * aim.y + dz * aim.z) / distance >= cosLimit) {
            locked = true
            break
        }
    }
    const next = locked ? lock + Math.max(0, seconds) : 0
    return { lock: next, locked, fire: locked && next >= options.dwell }
}

interface ImpactVisual {
    position: THREE.Vector3
    normal: THREE.Vector3
    age: number
    life: number
    scale: number
}

interface Spark {
    position: THREE.Vector3
    velocity: THREE.Vector3
    age: number
    life: number
    heat: number
}

export interface WeaponRig {
    /**
     * Fires one round if that shooter's trigger has cooled down. `origin` defaults to the local
     * muzzle, so remote callers pass their own muzzle position and network id.
     */
    fire: (direction: Vec3, origin?: THREE.Vector3, shooter?: number) => boolean
    /**
     * Integrates bullets, refreshes tracers, and ages the impact effects. Only rounds owned by the
     * local shooter test `targets`. The returned array is reused until the next call, so read it now.
     */
    update: (seconds: number, terrainHeight: (x: number, z: number) => number, targets?: BulletTarget[]) => BulletHit[]    /** Rounds left in the local shooter's magazine. */
    readonly rounds: number
    /** Adds `amount` rounds from a pickup, clamped to `weaponConfig.maxRounds`. */
    addRounds: (amount: number) => void
    /** Refills the magazine to `weaponConfig.magazineSize`; used on respawn. */
    resetRounds: () => void    /** Releases every GPU resource the rig owns. */
    dispose: () => void
}

/** Optional observers the rig calls as effects happen; used to drive the positional sound engine. */
export interface WeaponEvents {
    /**
     * A round ending on terrain or a bird. `energy` is its impact speed as a fraction of the muzzle
     * speed, so a target near the muzzle and a long lob can be told apart. Read the values here.
     */
    onImpact?: (position: Vec3, energy: number) => void
}

/** Cooldown key for the player's own gun; remote peers use their network id. */
const LOCAL_SHOOTER = 0

/**
 * Renders and simulates the gun. Everything is pooled: bullets are a single
 * instanced tracer mesh, impact rings are an instanced mesh, and sparks live in
 * one Points buffer. Nothing is allocated per shot, and `dispose` frees it all.
 *
 * `config` defaults to the bird's gun, so the tank can mount the same rig with its own AA tuning
 * (see `tankWeaponConfig`) without changing anything about the bird.
 */
export function createWeaponRig(scene: THREE.Scene, muzzle: THREE.Object3D, events: WeaponEvents = {}, config: WeaponConfig = weaponConfig): WeaponRig {
    const bullets: Bullet[] = []
    const impacts: ImpactVisual[] = []
    const sparks: Spark[] = []
    /** Cooldown per shooter, so one player's burst never silences another's gun. */
    const cooldowns = new Map<number, number>()
    /** Bird hits found this frame. Reused every update so the loop allocates nothing. */
    const hits: BulletHit[] = []
    let flash = 0
    /** Rounds left for the local shooter. Remote shooters never draw from it. */
    let rounds = config.magazineSize

    const bulletGeometry = new THREE.CylinderGeometry(0.02, 0.07, 1, 6, 1, true)
    const bulletMaterial = new THREE.MeshBasicMaterial({
        color: '#ffe9a8',
        toneMapped: false,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
    })
    const bulletMesh = new THREE.InstancedMesh(bulletGeometry, bulletMaterial, config.maxBullets)
    bulletMesh.frustumCulled = false
    bulletMesh.count = 0
    bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(bulletMesh)

    const flashGeometry = new THREE.SphereGeometry(0.2, 8, 6)
    const flashMaterial = new THREE.MeshBasicMaterial({
        color: '#ffd27a',
        toneMapped: false,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
    })
    const flashMesh = new THREE.Mesh(flashGeometry, flashMaterial)
    flashMesh.visible = false
    muzzle.add(flashMesh)

    const ringGeometry = new THREE.RingGeometry(0.32, 0.46, 18)
    ringGeometry.rotateX(-Math.PI / 2)
    const ringMaterial = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        toneMapped: false,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
    })
    const ringMesh = new THREE.InstancedMesh(ringGeometry, ringMaterial, config.maxImpacts)
    ringMesh.frustumCulled = false
    ringMesh.count = 0
    ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    scene.add(ringMesh)

    const sparkPositions = new Float32Array(config.maxSparks * 3)
    const sparkColors = new Float32Array(config.maxSparks * 3)
    const sparkPositionAttribute = new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage)
    const sparkColorAttribute = new THREE.BufferAttribute(sparkColors, 3).setUsage(THREE.DynamicDrawUsage)
    const sparkGeometry = new THREE.BufferGeometry()
    sparkGeometry.setAttribute('position', sparkPositionAttribute)
    sparkGeometry.setAttribute('color', sparkColorAttribute)
    const sparkMaterial = new THREE.PointsMaterial({
        size: 0.3,
        vertexColors: true,
        toneMapped: false,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    })
    const sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial)
    sparkPoints.frustumCulled = false
    sparkPoints.renderOrder = 2
    for (let index = 0; index < config.maxSparks; index++) sparkPositions[index * 3 + 1] = -9999
    scene.add(sparkPoints)

    const up = new THREE.Vector3(0, 1, 0)
    const aim = new THREE.Vector3()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()
    const matrix = new THREE.Matrix4()
    const color = new THREE.Color()
    const spread = new THREE.Vector3()

    function spawnImpact(hit: BulletImpact) {
        if (impacts.length >= config.maxImpacts) impacts.shift()
        impacts.push({
            position: new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z),
            normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
            age: 0,
            life: config.impactLife,
            scale: THREE.MathUtils.clamp(hit.speed / config.speed, 0.6, 1.6),
        })

        const burst = THREE.MathUtils.clamp(hit.speed / config.speed, 0.4, 1.4)
        for (let index = 0; index < config.sparksPerImpact; index++) {
            if (sparks.length >= config.maxSparks) sparks.shift()
            // Spray a cone of debris around the surface normal.
            spread
                .set(
                    hit.normal.x + (Math.random() - 0.5) * 1.15,
                    hit.normal.y + (Math.random() - 0.5) * 1.15 + 0.35,
                    hit.normal.z + (Math.random() - 0.5) * 1.15,
                )
                .normalize()
            const launch = (2.2 + Math.random() * 4.6) * burst
            sparks.push({
                position: new THREE.Vector3(hit.position.x, hit.position.y, hit.position.z),
                velocity: new THREE.Vector3(spread.x * launch, spread.y * launch, spread.z * launch),
                age: 0,
                life: 0.24 + Math.random() * 0.4,
                heat: Math.random(),
            })
        }
    }

    function fire(direction: Vec3, origin?: THREE.Vector3, shooter = LOCAL_SHOOTER) {
        if ((cooldowns.get(shooter) ?? 0) > 0) return false
        // Only the local shooter draws from the magazine; a peer's rounds are decorative replays, so
        // gating here is what guarantees the wire `fire` flag never claims a shot the gun never made.
        if (shooter === LOCAL_SHOOTER && rounds <= 0) return false
        cooldowns.set(shooter, config.fireInterval)
        const from = origin ?? muzzle.getWorldPosition(position)
        const target = scatter(direction, config.spread)
        if (bullets.length >= config.maxBullets) bullets.shift()
        bullets.push(createBullet({ x: from.x, y: from.y, z: from.z }, target, config, shooter))
        // The flash mesh is parented to the local muzzle, so only light it for the local gun.
        if (shooter === LOCAL_SHOOTER) {
            rounds -= 1
            flash = 1
            flashMesh.visible = true
        }
        return true
    }

    function update(seconds: number, terrainHeight: (x: number, z: number) => number, targets?: BulletTarget[]) {
        hits.length = 0
        cooldowns.forEach((remaining, shooter) => cooldowns.set(shooter, Math.max(0, remaining - seconds)))
        if (flash > 0) {
            flash = Math.max(0, flash - seconds * 18)
            flashMaterial.opacity = 0.9 * flash
            flashMesh.scale.set(1 + flash, 1 + flash, 1.8 + flash * 2.6)
            if (flash === 0) flashMesh.visible = false
        }

        for (let index = bullets.length - 1; index >= 0; index--) {
            const bullet = bullets[index]!
            // A peer's round is decorative on our screen, so only our own shots can wound a bird.
            const result = stepBullet(bullet, seconds, terrainHeight, config, bullet.owner === LOCAL_SHOOTER ? targets : undefined)
            if (result.impact) {
                spawnImpact(result.impact)
                events.onImpact?.(result.impact.position, THREE.MathUtils.clamp(result.impact.speed / config.speed, 0.2, 1.4))
            }
            if (result.hit) {
                spawnImpact(result.hit)
                events.onImpact?.(result.hit.position, THREE.MathUtils.clamp(result.hit.speed / config.speed, 0.2, 1.4))
                hits.push(result.hit)
            }
            if (result.dead) bullets.splice(index, 1)
            else bullets[index] = result.bullet
        }

        bulletMesh.count = bullets.length
        for (let index = 0; index < bullets.length; index++) {
            const bullet = bullets[index]!
            aim.set(bullet.velocity.x, bullet.velocity.y, bullet.velocity.z).normalize()
            quaternion.setFromUnitVectors(up, aim)
            position
                .set(bullet.position.x, bullet.position.y, bullet.position.z)
                .addScaledVector(aim, -config.tracerLength * 0.5)
            scale.set(1, config.tracerLength, 1)
            matrix.compose(position, quaternion, scale)
            bulletMesh.setMatrixAt(index, matrix)
        }
        bulletMesh.instanceMatrix.needsUpdate = true

        for (let index = impacts.length - 1; index >= 0; index--) {
            const impact = impacts[index]!
            impact.age += seconds
            if (impact.age >= impact.life) {
                impacts.splice(index, 1)
                continue
            }
            const progress = impact.age / impact.life
            const grow = impact.scale * (0.35 + progress * 1.5)
            quaternion.setFromUnitVectors(up, impact.normal)
            position.copy(impact.position)
            scale.set(grow, 1, grow)
            matrix.compose(position, quaternion, scale)
            ringMesh.setMatrixAt(index, matrix)
            const fade = (1 - progress) ** 1.6
            color.setRGB(fade, fade * 0.82, fade * 0.5)
            ringMesh.setColorAt(index, color)
        }
        ringMesh.count = impacts.length
        ringMesh.instanceMatrix.needsUpdate = true
        if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true

        for (let index = sparks.length - 1; index >= 0; index--) {
            const spark = sparks[index]!
            spark.age += seconds
            if (spark.age >= spark.life) {
                sparks.splice(index, 1)
                continue
            }
            spark.velocity.y -= config.gravity * seconds * 0.7
            spark.position.addScaledVector(spark.velocity, seconds)
        }
        for (let index = 0; index < config.maxSparks; index++) {
            const spark = sparks[index]
            if (!spark) {
                sparkPositions[index * 3] = 0
                sparkPositions[index * 3 + 1] = -9999
                sparkPositions[index * 3 + 2] = 0
                sparkColors[index * 3] = 0
                sparkColors[index * 3 + 1] = 0
                sparkColors[index * 3 + 2] = 0
                continue
            }
            sparkPositions[index * 3] = spark.position.x
            sparkPositions[index * 3 + 1] = spark.position.y
            sparkPositions[index * 3 + 2] = spark.position.z
            const fade = (1 - spark.age / spark.life) ** 1.4
            // White-hot at first, cooling to ember orange.
            sparkColors[index * 3] = fade
            sparkColors[index * 3 + 1] = fade * (0.55 + spark.heat * 0.35)
            sparkColors[index * 3 + 2] = fade * (0.12 + spark.heat * 0.25)
        }
        sparkPositionAttribute.needsUpdate = true
        sparkColorAttribute.needsUpdate = true
        return hits
    }

    function dispose() {
        muzzle.remove(flashMesh)
        scene.remove(bulletMesh)
        scene.remove(ringMesh)
        scene.remove(sparkPoints)
        bulletMesh.dispose()
        ringMesh.dispose()
        bulletGeometry.dispose()
        bulletMaterial.dispose()
        flashGeometry.dispose()
        flashMaterial.dispose()
        ringGeometry.dispose()
        ringMaterial.dispose()
        sparkGeometry.dispose()
        sparkMaterial.dispose()
        bullets.length = 0
        impacts.length = 0
        sparks.length = 0
        hits.length = 0
    }

    return {
        fire,
        update,
        dispose,
        get rounds() { return rounds },
        addRounds(amount: number) {
            if (!Number.isFinite(amount) || amount <= 0) return
            rounds = Math.min(config.maxRounds, rounds + Math.floor(amount))
        },
        resetRounds() {
            rounds = config.magazineSize
        },
    }
}
