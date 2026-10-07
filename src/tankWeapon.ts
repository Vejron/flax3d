import { weaponConfig, type Vec3, type WeaponConfig } from './weapon'

/**
 * The tank's AA gun. Built by spreading the bird's config so any future ballistics field is
 * inherited, then overriding the handful that make a turret feel different: a heavier, flatter,
 * faster round and a slower, thumpier cycle of fire.
 */
export const tankWeaponConfig: WeaponConfig = {
    ...weaponConfig,
    /** Muzzle speed in m/s. Higher than the bird's 55, so the drop over a long shot is gentler. */
    speed: 90,
    /** Downward acceleration on the round, in m/s². Kept under the bird's 24 to flatten the arc. */
    gravity: 18,
    /** Tighter than the bird's 0.05: a turret is steadier than a flapping bird. */
    spread: 0.03,
    /** Slower cycle than the bird's 0.11, so the AA gun hits harder but rattles less. */
    fireInterval: 0.16,
    /** Aim assist reaches further, since the turret is often tracking a fast crossing bird. */
    aimAssistCone: 6,
    aimAssistRange: 90,
    /** A heavy shell: fewer rounds carried and a smaller magazine than the bird's gun. */
    magazineSize: 60,
    pickupRounds: 60,
    maxRounds: 180,
    /** Longer tracer streak, so the heavier round reads at range. */
    tracerLength: 4,
}

/**
 * The orientation the barrel hangs off: the hull it is mounted on, plus the turret's own angles.
 * `TankState` already carries exactly these fields, so a tank state can be passed straight in.
 */
export interface TurretPose {
    /** Hull heading, in radians. */
    hullYaw: number
    /** Hull pitch from the terrain, in radians; nose up is positive. */
    hullPitch: number
    /** Hull roll from the terrain, in radians; right side up is positive. */
    hullRoll: number
    /** Turret bearing relative to the hull, in radians. */
    turretYaw: number
    /** Barrel elevation relative to the hull, in radians. */
    turretPitch: number
}

/**
 * Writes the barrel's world direction into `out`: the turret's own yaw and elevation composed with
 * the hull's roll, pitch and heading, in the same order the rig builds them (a `YXZ` hull containing
 * a `YXZ` turret).
 *
 * Composing the hull matters: on a slope the barrel visibly tilts with the hull, so an aim that
 * ignored hull pitch and roll would send rounds somewhere other than where the barrel points. The
 * bird's `writeAimFromYaw` is the same idea for a mount whose pitch is a constant.
 */
export function writeTurretAim<T extends Vec3>(pose: TurretPose, out: T): T {
    // The turret's own rotation: elevation about X, then bearing about Y.
    const cosPitch = Math.cos(pose.turretPitch)
    const sinPitch = Math.sin(pose.turretPitch)
    let x = cosPitch * Math.sin(pose.turretYaw)
    let y = sinPitch
    let z = -cosPitch * Math.cos(pose.turretYaw)

    // Hull roll about Z, then hull pitch about X, then hull heading about Y.
    const cosRoll = Math.cos(pose.hullRoll)
    const sinRoll = Math.sin(pose.hullRoll)
    const rolledX = x * cosRoll - y * sinRoll
    y = x * sinRoll + y * cosRoll
    x = rolledX

    const cosHullPitch = Math.cos(pose.hullPitch)
    const sinHullPitch = Math.sin(pose.hullPitch)
    const pitchedY = y * cosHullPitch - z * sinHullPitch
    z = y * sinHullPitch + z * cosHullPitch
    y = pitchedY

    const cosYaw = Math.cos(pose.hullYaw)
    const sinYaw = Math.sin(pose.hullYaw)
    out.x = x * cosYaw - z * sinYaw
    out.y = y
    out.z = x * sinYaw + z * cosYaw
    return out
}
