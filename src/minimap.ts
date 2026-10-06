import type { RemoteFlight } from './network'
import type { Powerup } from './powerup'

/** World metres covered by the radar radius before a contact is pinned to the rim. */
export const RADAR_RANGE = 150
/** Vertical metres before a contact reads as above or below the local bird rather than level. */
export const ALTITUDE_BAND = 6

export interface RadarLocal {
    x: number
    y: number
    z: number
    yaw: number
}

export type AltitudeBand = 'above' | 'level' | 'below'

/** Blip colours, mirrored by the legend swatches in `App.vue`. */
export const BAND_COLORS: Record<AltitudeBand, string> = {
    above: '#f0c16a',
    level: '#8de3b0',
    below: '#8fd0e8',
}

const WRECK_COLOR = '#e0886f'
/** Blip colour for a floating power-up, mirrored by the legend swatch in `App.vue`. */
export const POWERUP_COLOR = '#ffd27a'

/** Classifies a contact by its height relative to the local bird. */
export function altitudeBand(deltaY: number): AltitudeBand {
    if (deltaY > ALTITUDE_BAND) return 'above'
    if (deltaY < -ALTITUDE_BAND) return 'below'
    return 'level'
}

export interface RadarPoint {
    /** Normalised scope offset, −1..1; positive is to the local bird's right. */
    x: number
    /** Normalised scope offset, −1..1; negative is ahead (canvas convention). */
    y: number
    /** True ground-plane distance in metres, before any rim clamping. */
    distance: number
    /** Set when the contact was beyond `range` and pushed out to the rim. */
    clamped: boolean
}

/**
 * Projects a world position onto the radar scope in normalised units, rotated so the local bird's
 * heading always points up. `y` follows the canvas convention, where negative is up. Contacts past
 * `range` are pinned to the rim so their bearing stays readable and are flagged `clamped`.
 */
export function radarPoint(
    local: Pick<RadarLocal, 'x' | 'z' | 'yaw'>,
    target: Pick<RadarLocal, 'x' | 'z'>,
    range = RADAR_RANGE,
): RadarPoint {
    const dx = target.x - local.x
    const dz = target.z - local.z
    const sin = Math.sin(local.yaw)
    const cos = Math.cos(local.yaw)
    // Local heading is (sin yaw, -cos yaw) and its right-hand side is (cos yaw, sin yaw).
    const right = dx * cos + dz * sin
    const forward = dx * sin - dz * cos
    const distance = Math.hypot(right, forward)
    const scale = distance > range ? range / distance : 1
    return { x: (right * scale) / range, y: (-forward * scale) / range, distance, clamped: distance > range }
}

/**
 * Draws a heading-up radar: the local bird sits at the centre and nearby peers appear relative to
 * it, coloured by their height. The scope is intentionally cheap — one canvas, no per-frame
 * allocations beyond the caller's `remotes` array.
 */
export function createMinimap(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d')
    let size = 0
    let ratio = 0

    function fit() {
        const css = canvas.clientWidth || canvas.clientHeight || 190
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        if (css === size && dpr === ratio) return
        size = css
        ratio = dpr
        canvas.width = Math.round(css * dpr)
        canvas.height = Math.round(css * dpr)
    }

    function draw(local: RadarLocal, remotes: RemoteFlight[] = [], powerups: Powerup[] = []) {
        if (!context) return
        fit()
        const center = size / 2
        const radius = center - size * 0.06
        context.setTransform(ratio, 0, 0, ratio, 0, 0)
        context.clearRect(0, 0, size, size)

        context.beginPath()
        context.arc(center, center, radius, 0, Math.PI * 2)
        context.fillStyle = 'rgba(12, 34, 27, 0.78)'
        context.fill()

        context.lineWidth = 1
        context.strokeStyle = 'rgba(190, 215, 190, 0.28)'
        for (const fraction of [1 / 3, 2 / 3, 1]) {
            context.beginPath()
            context.arc(center, center, radius * fraction, 0, Math.PI * 2)
            context.stroke()
        }
        context.strokeStyle = 'rgba(190, 215, 190, 0.14)'
        context.beginPath()
        context.moveTo(center - radius, center)
        context.lineTo(center + radius, center)
        context.moveTo(center, center - radius)
        context.lineTo(center, center + radius)
        context.stroke()

        // Heading-up: world north (−Z) swings around the rim as the local bird turns.
        context.fillStyle = 'rgba(217, 241, 220, 0.72)'
        context.font = `700 ${Math.max(8, Math.round(size * 0.06))}px 'Space Grotesk', sans-serif`
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText('N', center - Math.sin(local.yaw) * radius * 0.84, center - Math.cos(local.yaw) * radius * 0.84)

        for (const remote of remotes) {
            const { x, y, z, health } = remote.flight
            const point = radarPoint(local, { x, z })
            const px = center + point.x * radius
            const py = center + point.y * radius
            const wreck = health <= 0
            context.globalAlpha = point.clamped ? 0.5 : 1
            context.beginPath()
            context.arc(px, py, point.clamped ? 3.5 : 4.5, 0, Math.PI * 2)
            context.fillStyle = wreck ? WRECK_COLOR : BAND_COLORS[altitudeBand(y - local.y)]
            context.fill()
            context.lineWidth = 1
            context.strokeStyle = 'rgba(12, 34, 27, 0.85)'
            context.stroke()
            if (wreck) {
                context.beginPath()
                context.moveTo(px - 3, py - 3)
                context.lineTo(px + 3, py + 3)
                context.moveTo(px + 3, py - 3)
                context.lineTo(px - 3, py + 3)
                context.stroke()
            }
        }

        // Power-ups keep their bearing even when beyond the scope, so they read as a destination.
        for (const powerup of powerups) {
            const point = radarPoint(local, powerup)
            const px = center + point.x * radius
            const py = center + point.y * radius
            context.globalAlpha = point.clamped ? 0.45 : 0.9
            context.beginPath()
            context.moveTo(px, py - 5)
            context.lineTo(px + 5, py)
            context.lineTo(px, py + 5)
            context.lineTo(px - 5, py)
            context.closePath()
            context.fillStyle = POWERUP_COLOR
            context.fill()
            context.lineWidth = 1
            context.strokeStyle = 'rgba(12, 34, 27, 0.85)'
            context.stroke()
        }

        // The local bird is the fixed reference at the centre, always pointing up.
        context.globalAlpha = 1
        context.beginPath()
        context.moveTo(center, center - 7)
        context.lineTo(center - 5.5, center + 5.5)
        context.lineTo(center + 5.5, center + 5.5)
        context.closePath()
        context.fillStyle = '#f7f7ed'
        context.fill()
        context.strokeStyle = 'rgba(12, 34, 27, 0.85)'
        context.stroke()
    }

    function dispose() {
        context?.clearRect(0, 0, canvas.width, canvas.height)
    }

    return { draw, dispose }
}
