/**
 * The vehicle kinds the game can spawn. Kept in its own module so `flight.ts`, `tank.ts` and
 * `network.ts` can all name the type without importing each other (which would be a cycle).
 */

export type VehicleKind = 'bird' | 'tank'

/**
 * Wire value for each kind. This is half of the contract with `Position.kind` in
 * `server/src/main.rs`; the server only range-checks it and relays it verbatim.
 */
export const VEHICLE_WIRE: Record<VehicleKind, number> = { bird: 0, tank: 1 }

/** Decodes a wire `kind` byte. Anything unrecognised is treated as a bird, so a future kind
 *  degrades to the existing avatar instead of breaking the relay. */
export function vehicleFromWire(value: number): VehicleKind {
    return value === VEHICLE_WIRE.tank ? 'tank' : 'bird'
}
