export interface FlightState {
    x: number
    y: number
    z: number
    yaw: number
    bank: number
    speed: number
    verticalSpeed: number
    charge: number
    flying: boolean
    /** Remaining hit points; the owning client is authoritative over its own value. */
    health: number
    /** True from the killing blow until the respawn timer expires. */
    dead: boolean
    /** Seconds left before respawning; only counts down once the wreck is on the ground. */
    respawn: number
    /** Accumulated tumble angle used by the renderer while dying. */
    spin: number
    /** Hit-shake intensity in `0..1`, decaying over `shakeTime`. */
    shake: number
}

export interface FlightControls {
    flap: boolean
    flapPower?: number
    steer: number
    spread: number
}

export const flightConfig = {
    maxTimeStep: 0.05,
    gravity: 9.8,
    minSpeed: 3,
    maxSpeed: 24,
    maxClimbSpeed: 8,
    maxDiveSpeed: 22,
    takeoffCharge: 1,
    chargeDecay: 0.04,
    chargeFromWingPower: 2.4,
    chargePerKeyboardFlap: 0.24,
    takeoffSpeed: 8,
    takeoffLift: 5.5,
    groundFlapThrust: 20,
    groundDrag: 3.5,
    landingSpeedRetention: 0.15,
    maxWingPower: 3,
    wingPowerLift: 30,
    wingPowerThrust: 1.8,
    keyboardFlapLift: 4.4,
    keyboardFlapThrust: 1.3,
    maxPoweredClimbSpeed: 9,
    turnRate: 0.45,
    speedTurnRate: 0.055,
    bankAngle: 0.48,
    bankResponse: 5,
    diveAcceleration: 0.8,
    baseDrag: 0.1,
    wingDrag: 0.0035,
    glideLift: 0.075,
    passiveSink: 2.5,
    maxGlideLift: 22,
    maxHealth: 100,
    damagePerHit: 25,
    respawnDelay: 2.5,
    shakeTime: 0.4,
    deathSpinRate: 9,
    deathFallSpeed: 40,
    deathDrag: 1.6,
    /** Length of the body-mode auto-fire lock cone, in metres. */
    autoFireRange: 60,
    /** Half-angle of the body-mode auto-fire lock cone, in degrees. */
    autoFireAngle: 12,
    /** Seconds the cone must be held before auto-fire opens up. */
    autoFireDwell: 0.2,
}

export type FlightConfig = typeof flightConfig

export function initialFlightState(ground: number): FlightState {
    return {
        x: 0, y: ground, z: 0, yaw: 0, bank: 0, speed: 0, verticalSpeed: 0, charge: 0, flying: false,
        health: flightConfig.maxHealth, dead: false, respawn: 0, spin: 0, shake: 0,
    }
}

/** Puts a fresh, fully repaired bird back at a spawn point. */
export function respawnFlight(ground: number, spawn: { x: number; z: number; yaw: number }): FlightState {
    return { ...initialFlightState(ground), x: spawn.x, z: spawn.z, yaw: spawn.yaw }
}

/**
 * Applies one or more incoming hits. Damage is reported by the shooter's client, so this runs on
 * the victim: it owns its own health and decides when it dies. A killing blow starts the wreck
 * falling and arms the respawn timer.
 */
export function applyHit(state: FlightState, damage: number, config: FlightConfig = flightConfig): FlightState {
    if (state.dead || !Number.isFinite(damage) || damage <= 0) return state
    const health = Math.max(0, state.health - damage)
    if (health > 0) return { ...state, health, shake: 1 }
    return { ...state, health: 0, shake: 1, dead: true, respawn: config.respawnDelay, flying: false, charge: 0 }
}

export function stepFlight(
    state: FlightState,
    controls: FlightControls,
    seconds: number,
    terrainHeight: (x: number, z: number) => number,
    config: FlightConfig = flightConfig,
): FlightState {
    const dt = Math.min(Math.max(seconds, 0), config.maxTimeStep)
    const next = { ...state }
    next.shake = Math.max(0, next.shake - dt / config.shakeTime)

    if (next.dead) {
        // No control authority while dying: gravity takes over, drag bleeds off the remaining
        // speed and the body tumbles. The respawn timer only starts once the wreck is grounded.
        next.verticalSpeed = Math.max(-config.deathFallSpeed, next.verticalSpeed - config.gravity * dt)
        next.speed = Math.max(0, next.speed * (1 - config.deathDrag * dt))
        next.spin += config.deathSpinRate * dt
        next.x += Math.sin(next.yaw) * next.speed * dt
        next.z -= Math.cos(next.yaw) * next.speed * dt
        next.y += next.verticalSpeed * dt
        const wreckGround = terrainHeight(next.x, next.z)
        if (next.y <= wreckGround) {
            next.y = wreckGround
            next.verticalSpeed = 0
            next.speed = 0
            next.respawn = Math.max(0, next.respawn - dt)
        }
        return next
    }

    const spread = Math.max(0, Math.min(1, controls.spread))
    const steer = Math.max(-1, Math.min(1, controls.steer))
    const flapPower = Math.max(0, Math.min(config.maxWingPower, controls.flapPower ?? 0))
    const groundFlapPower = Math.min(1, flapPower / Math.max(0.25, spread))

    if (!next.flying) {
        next.charge = Math.min(config.takeoffCharge, Math.max(0, next.charge - config.chargeDecay * dt) + groundFlapPower * dt * config.chargeFromWingPower + (controls.flap ? config.chargePerKeyboardFlap : 0))
        next.speed = Math.min(config.maxSpeed, Math.max(0, next.speed + groundFlapPower * dt * config.groundFlapThrust + (controls.flap ? config.keyboardFlapThrust : 0) - config.groundDrag * dt))
        if (next.charge >= config.takeoffCharge) {
            next.flying = true
            next.speed = Math.max(next.speed, Math.min(config.maxSpeed, config.takeoffSpeed))
            next.verticalSpeed = config.takeoffLift
            next.charge = 0
        }
    } else {
        next.verticalSpeed = Math.min(config.maxPoweredClimbSpeed, next.verticalSpeed + flapPower * dt * config.wingPowerLift + (controls.flap ? config.keyboardFlapLift : 0))
        next.speed = Math.min(config.maxSpeed, next.speed + flapPower * dt * config.wingPowerThrust + (controls.flap ? config.keyboardFlapThrust : 0))
    }

    next.yaw += steer * (config.turnRate + next.speed * config.speedTurnRate) * dt
    next.bank += (steer * -config.bankAngle - next.bank) * Math.min(1, dt * config.bankResponse)
    const previousVerticalSpeed = next.verticalSpeed
    const glideLift = spread * Math.min(config.maxGlideLift, next.speed ** 2 * config.glideLift)
    const slowFlight = Math.max(0, Math.min(1, (config.takeoffSpeed + 4 - next.speed) / 4))
    const sink = flapPower || controls.flap ? 0 : config.passiveSink * slowFlight
    next.verticalSpeed = Math.min(config.maxClimbSpeed, Math.max(-config.maxDiveSpeed, next.verticalSpeed + (glideLift - config.gravity - sink) * dt))
    const averageDescentSpeed = Math.max(0, -(previousVerticalSpeed + next.verticalSpeed) / 2)
    const diveGain = next.flying ? (1 - spread) * averageDescentSpeed * config.diveAcceleration : 0
    if (next.flying) {
        const drag = config.baseDrag + spread * next.speed ** 2 * config.wingDrag
        next.speed = Math.min(config.maxSpeed, Math.max(config.minSpeed, next.speed + (diveGain - drag) * dt))
    }
    next.x += Math.sin(next.yaw) * next.speed * dt
    next.z -= Math.cos(next.yaw) * next.speed * dt
    if (next.flying) next.y += next.verticalSpeed * dt

    if (state.flying && next.flying && !controls.flap && flapPower === 0) {
        const passiveDrag = config.baseDrag + spread * next.speed ** 2 * config.wingDrag
        const kineticBudget = Math.max(0, state.speed ** 2 + state.verticalSpeed ** 2 - 2 * passiveDrag * state.speed * dt)
        const kineticEnergy = next.speed ** 2 + next.verticalSpeed ** 2
        const altitudeChange = 2 * config.gravity * next.verticalSpeed * dt
        if (kineticEnergy + altitudeChange > kineticBudget && kineticEnergy > 0) {
            const scale = Math.min(1, (Math.sqrt(altitudeChange ** 2 + 4 * kineticEnergy * kineticBudget) - altitudeChange) / (2 * kineticEnergy))
            next.speed *= scale
            next.verticalSpeed *= scale
            next.y = state.y + next.verticalSpeed * dt
        }
    }

    const ground = terrainHeight(next.x, next.z)
    if (next.y <= ground) {
        if (next.flying) {
            next.speed *= config.landingSpeedRetention
            next.charge = 0
        }
        next.y = ground
        next.flying = false
        next.verticalSpeed = 0
        next.bank = 0
    }
    return next
}