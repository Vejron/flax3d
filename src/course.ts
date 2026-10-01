import type { FlightState } from './flight'
import { terrainHeight } from './terrain'

export const courseRings = [
    { x: 0, z: -20, kind: 'start' },
    { x: 52, z: -40, kind: 'checkpoint' },
    { x: 40, z: -78, kind: 'checkpoint' },
    { x: -36, z: -82, kind: 'checkpoint' },
    { x: -56, z: -48, kind: 'checkpoint' },
    { x: -12, z: -20, kind: 'finish' },
].map((ring, index, rings) => {
    const previous = rings[(index + rings.length - 1) % rings.length]!
    const next = rings[(index + 1) % rings.length]!
    const length = Math.hypot(next.x - previous.x, next.z - previous.z)
    return {
        ...ring,
        y: terrainHeight(ring.x, ring.z) + 6,
        radius: 4.5,
        forwardX: (next.x - previous.x) / length,
        forwardZ: (next.z - previous.z) / length,
    }
})

const startRing = courseRings[0]!
export const courseSpawn = {
    x: startRing.x - startRing.forwardX * 20,
    z: startRing.z - startRing.forwardZ * 20,
    yaw: Math.atan2(startRing.forwardX, -startRing.forwardZ),
}

export interface CourseProgress {
    nextRing: number
    laps: number
}

export function advanceCourse(progress: CourseProgress, previous: FlightState, current: FlightState): CourseProgress {
    const ring = courseRings[progress.nextRing]
    if (!ring || !current.flying) return progress
    const before = (previous.x - ring.x) * ring.forwardX + (previous.z - ring.z) * ring.forwardZ
    const after = (current.x - ring.x) * ring.forwardX + (current.z - ring.z) * ring.forwardZ
    if (before >= 0 || after < 0) return progress
    const fraction = -before / (after - before)
    const x = previous.x + (current.x - previous.x) * fraction
    const z = previous.z + (current.z - previous.z) * fraction
    const y = previous.y + (current.y - previous.y) * fraction + 1.1
    const lateral = (x - ring.x) * -ring.forwardZ + (z - ring.z) * ring.forwardX
    if (Math.hypot(lateral, y - ring.y) > ring.radius - 0.5) return progress
    const nextRing = progress.nextRing + 1
    return nextRing === courseRings.length
        ? { nextRing: 0, laps: progress.laps + 1 }
        : { ...progress, nextRing }
}