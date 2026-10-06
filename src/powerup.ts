/**
 * Shared power-up rules and the one place the pickup geometry is defined. The server owns the
 * authoritative field (where each slot sits and when it respawns); this module holds the values
 * both sides must agree on plus the pure proximity test the local client runs each frame.
 */

/** A power-up as delivered by the server. `slot` is its stable id; positions are world metres. */
export interface Powerup {
    slot: number
    x: number
    y: number
    z: number
}

/** A plain 3D point, so the proximity test does not depend on THREE or the flight types. */
export interface PowerupPoint {
    x: number
    y: number
    z: number
}

export const powerupConfig = {
    /** Slots the server keeps on the field. Each reappears ~`respawnSeconds` after it is taken. */
    slots: 2,
    /** Seconds between a slot being collected and it reappearing somewhere else. */
    respawnSeconds: 10,
    /** Horizontal radius of the random spawn disc around the origin, in metres. */
    spawnRadius: 300,
    /** Lowest spawn altitude above the terrain, in metres. */
    minAltitude: 13,
    /** Highest spawn altitude above the terrain, in metres. */
    maxAltitude: 80,
    /** How close a bird must fly to collect one, in metres. */
    pickupRadius: 4,
}

export type PowerupConfig = typeof powerupConfig

/** True when `position` is inside the collection sphere of `powerup`. */
export function withinPickupRange(
    position: PowerupPoint,
    powerup: PowerupPoint,
    radius: number = powerupConfig.pickupRadius,
): boolean {
    const dx = position.x - powerup.x
    const dy = position.y - powerup.y
    const dz = position.z - powerup.z
    return dx * dx + dy * dy + dz * dz <= radius * radius
}
