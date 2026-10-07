import { terrainNormal } from './weapon'

/**
 * Ground-vehicle state, deliberately shaped like `FlightState` so the two can share a relay: the
 * hull owns a position and heading, while the turret carries its own bearing so it can be aimed
 * independently of where the hull is pointing.
 */
export interface TankState {
    x: number
    y: number
    z: number
    /** Absolute heading of the hull, in radians. Grows without bound like the bird's yaw. */
    hullYaw: number
    /** Turret bearing relative to the hull, in radians; wrapped to `[-π, π)`. */
    turretYaw: number
    /** Turret elevation in radians; negative depresses the barrel. */
    turretPitch: number
    /** Hull pitch adopted from the terrain slope, in radians; nose up is positive. */
    hullPitch: number
    /** Hull roll adopted from the terrain slope, in radians; right side up is positive. */
    hullRoll: number
    /** Signed ground speed in m/s; negative reverses. */
    speed: number
    /** Remaining hit points; the owning client is authoritative over its own value. */
    health: number
    /** True from the killing blow until the respawn timer expires. */
    dead: boolean
    /** Seconds left before respawning. A tank is already grounded, so this always counts down. */
    respawn: number
    /** Hit-shake intensity in `0..1`, decaying over `shakeTime`. */
    shake: number
}

export interface TankControls {
    /** `-1..1`; negative drives in reverse. */
    throttle: number
    /** `-1..1`; only bites while the hull is rolling, and inverts when backing up. */
    steer: number
    /** Absolute world bearing the turret should point at, in radians. */
    turretBearing: number
    /**
     * Barrel elevation above the horizon the turret should hold, in radians. Compensated for the
     * hull's own slope, so the aim stays put while the tank drives over terrain. Clamped by the
     * config.
     */
    turretPitch: number
}

export const tankConfig = {
    maxTimeStep: 0.05,
    /** Top forward speed on the ground, in m/s. */
    maxSpeed: 14,
    /** Top reverse speed, in m/s. */
    maxReverseSpeed: 5,
    /** Rate the hull approaches its commanded speed while powered, per second. */
    accel: 2.4,
    /** Rate the hull bleeds speed off with the throttle released, per second. */
    brake: 1.6,
    /** Yaw rate at full lock, in rad/s. */
    turnRate: 1.1,
    /** Speed at which steering reaches full authority, in m/s. */
    turnSpeedRef: 4,
    /** Rate the hull settles onto the terrain slope, per second. */
    slopeResponse: 6,
    /** Steepest slope the hull will visibly adopt, in radians. */
    maxSlope: 0.7,
    /** Turret traverse rate, in rad/s. */
    turretSlewRate: 2.4,
    /** Lowest barrel elevation above the horizon, in radians (negative depresses the barrel). */
    turretPitchMin: -0.14,
    /** Highest barrel elevation above the horizon, in radians. */
    turretPitchMax: 1.4,
    maxHealth: 100,
    damagePerHit: 20,
    respawnDelay: 3,
    shakeTime: 0.4,
}

export type TankConfig = typeof tankConfig

/** Wraps an angle into `[-π, π)`, so a slew always takes the short way round. */
export function wrapAngle(angle: number): number {
    return Math.atan2(Math.sin(angle), Math.cos(angle))
}

/** Moves `current` toward `target` by at most `maxDelta`, so a rate-limited axis can never snap. */
function slew(current: number, target: number, maxDelta: number): number {
    const delta = target - current
    if (Math.abs(delta) <= maxDelta) return target
    return current + Math.sign(delta) * maxDelta
}

/**
 * Slews an angle toward `target` by at most `maxDelta`, taking the shortest way round. Without the
 * wrap, commanding a bearing across the `±π` seam would traverse the long way round the hull.
 */
function slewAngle(current: number, target: number, maxDelta: number): number {
    const delta = wrapAngle(target - current)
    return wrapAngle(current + Math.sign(delta) * Math.min(Math.abs(delta), maxDelta))
}

/** Clamps a barrel elevation to the configured limits. */
function clampPitch(elevation: number, config: TankConfig): number {
    return Math.max(config.turretPitchMin, Math.min(config.turretPitchMax, elevation))
}

/** The barrel's elevation above the horizon, in radians. Includes the hull slope it rides on, so
 *  the HUD reports where the gun actually points rather than the angle relative to the hull. */
export function turretElevation(state: TankState): number {
    return state.hullPitch + state.turretPitch
}

/** Clamps a slope angle to the steepest the hull is allowed to adopt. */
function clampSlope(angle: number, limit: number): number {
    return Math.max(-limit, Math.min(limit, angle))
}

export function initialTankState(ground: number, config: TankConfig = tankConfig): TankState {
    return {
        x: 0, y: ground, z: 0, hullYaw: 0, turretYaw: 0, turretPitch: 0, hullPitch: 0, hullRoll: 0,
        speed: 0, health: config.maxHealth, dead: false, respawn: 0, shake: 0,
    }
}

/** Puts a fresh, fully repaired hull back at a spawn point. */
export function respawnTank(ground: number, spawn: { x: number; z: number; hullYaw: number }, config: TankConfig = tankConfig): TankState {
    return { ...initialTankState(ground, config), x: spawn.x, z: spawn.z, hullYaw: spawn.hullYaw }
}

/**
 * Applies one or more incoming hits. Damage is reported by the shooter's client, so this runs on the
 * victim: it owns its own health and decides when it dies, exactly like `applyHit` for the bird.
 */
export function applyTankHit(state: TankState, damage: number, config: TankConfig = tankConfig): TankState {
    if (state.dead || !Number.isFinite(damage) || damage <= 0) return state
    const health = Math.max(0, state.health - damage)
    if (health > 0) return { ...state, health, shake: 1 }
    return { ...state, health: 0, shake: 1, dead: true, respawn: config.respawnDelay, speed: 0 }
}

/**
 * Advances the hull and turret one frame. The hull is kinematic — terrain following plus speed and
 * heading — while the turret is a rate-limited axis, which is what makes it feel independent of the
 * body instead of welded to the hull heading.
 */
export function stepTank(
    state: TankState,
    controls: TankControls,
    seconds: number,
    terrainHeight: (x: number, z: number) => number,
    config: TankConfig = tankConfig,
): TankState {
    const dt = Math.min(Math.max(seconds, 0), config.maxTimeStep)
    const next = { ...state }
    next.shake = Math.max(0, next.shake - dt / config.shakeTime)

    if (next.dead) {
        // A knocked-out hull is inert where it stopped; only the respawn timer moves.
        next.speed = 0
        next.respawn = Math.max(0, next.respawn - dt)
        return next
    }

    const throttle = Math.max(-1, Math.min(1, controls.throttle))
    const steer = Math.max(-1, Math.min(1, controls.steer))

    // Ease toward the commanded speed, so releasing the throttle coasts rather than stopping dead.
    const target = throttle >= 0 ? throttle * config.maxSpeed : throttle * config.maxReverseSpeed
    const rate = throttle !== 0 ? config.accel : config.brake
    next.speed += (target - next.speed) * Math.min(1, rate * dt)
    if (Math.abs(next.speed) < 0.02) next.speed = 0

    // Steering only bites while the hull is rolling, and inverts in reverse like a real vehicle.
    const authority = Math.min(1, Math.abs(next.speed) / config.turnSpeedRef)
    next.hullYaw += steer * config.turnRate * authority * dt * (next.speed < 0 ? -1 : 1)

    next.x += Math.sin(next.hullYaw) * next.speed * dt
    next.z -= Math.cos(next.hullYaw) * next.speed * dt
    next.y = terrainHeight(next.x, next.z)

    // The turret traverses toward the commanded bearing at a fixed rate, so it lags the pointer the
    // way a real traverse does and can never snap instantaneously.
    const bearing = wrapAngle(controls.turretBearing - next.hullYaw)
    next.turretYaw = slewAngle(next.turretYaw, bearing, config.turretSlewRate * dt)
    // `controls.turretPitch` is the elevation the player wants above the horizon, so the hull's own
    // pitch is subtracted here: driving up a slope must not drag the aim off the target with it.
    const pitch = clampPitch(clampPitch(controls.turretPitch, config) - next.hullPitch, config)
    next.turretPitch = slew(next.turretPitch, pitch, config.turretSlewRate * dt)

    // Read the ground normal and project it into the hull frame: the component along the hull's
    // forward axis becomes pitch, the component along its right axis becomes roll.
    const normal = terrainNormal(next.x, next.z, terrainHeight)
    const forwardX = Math.sin(next.hullYaw)
    const forwardZ = -Math.cos(next.hullYaw)
    const rightX = Math.cos(next.hullYaw)
    const rightZ = Math.sin(next.hullYaw)
    const slopePitch = Math.atan2(-(normal.x * forwardX + normal.z * forwardZ), normal.y)
    const slopeRoll = Math.atan2(-(normal.x * rightX + normal.z * rightZ), normal.y)
    const response = Math.min(1, config.slopeResponse * dt)
    next.hullPitch += (clampSlope(slopePitch, config.maxSlope) - next.hullPitch) * response
    next.hullRoll += (clampSlope(slopeRoll, config.maxSlope) - next.hullRoll) * response

    return next
}
