import { describe, expect, it } from 'vitest'

import { ALTITUDE_BAND, altitudeBand, createMinimap, RADAR_RANGE, radarPoint } from '../minimap'
import type { RemoteFlight } from '../network'

/** Minimal 2D context that records the blips `createMinimap` fills. */
function stubContext() {
    const blips: { x: number; y: number; radius: number; fill: string; alpha: number }[] = []
    let current: { x: number; y: number; radius: number } | null = null
    const context = {
        globalAlpha: 1,
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        setTransform: () => { },
        clearRect: () => { },
        beginPath: () => { current = null },
        closePath: () => { },
        moveTo: () => { },
        lineTo: () => { },
        stroke: () => { },
        fillText: () => { },
        arc(x: number, y: number, radius: number) { current = { x, y, radius } },
        fill() {
            // The scope disc is also filled; only small arcs are contact blips.
            if (current && current.radius <= 5) blips.push({ ...current, fill: context.fillStyle, alpha: context.globalAlpha })
        },
    }
    return { context, blips }
}

function contact(id: number, x: number, y: number, z: number, health = 100): RemoteFlight {
    return {
        id, spread: 1, flap: false, fire: false,
        flight: { x, y, z, yaw: 0, bank: 0, speed: 10, flying: true, wingLeft: 0, wingRight: 0, health },
    }
}

function minimapFor() {
    const canvas = document.createElement('canvas')
    const { context, blips } = stubContext()
    // jsdom has no canvas package, so hand the minimap a recording context instead.
    canvas.getContext = (() => context) as unknown as HTMLCanvasElement['getContext']
    return { minimap: createMinimap(canvas), blips }
}

describe('radar projection', () => {
    const origin = { x: 0, z: 0, yaw: 0 }

    it('puts a bird directly ahead at the top of the scope', () => {
        const point = radarPoint(origin, { x: 0, z: -40 })
        expect(point.x).toBeCloseTo(0, 6)
        expect(point.y).toBeCloseTo(-40 / RADAR_RANGE, 6)
        expect(point.distance).toBeCloseTo(40, 6)
        expect(point.clamped).toBe(false)
    })

    it('places a bird behind the local one at the bottom', () => {
        const point = radarPoint(origin, { x: 0, z: 60 })
        expect(point.y).toBeCloseTo(60 / RADAR_RANGE, 6)
    })

    it('keeps a bird on the local right-hand side to the right', () => {
        const point = radarPoint(origin, { x: 30, z: 0 })
        expect(point.x).toBeCloseTo(30 / RADAR_RANGE, 6)
        expect(point.y).toBeCloseTo(0, 6)
    })

    it('rotates the scope so the local heading always points up', () => {
        // Facing +X, so a bird further along +X is dead ahead.
        const east = { x: 100, z: 0, yaw: Math.PI / 2 }
        const point = radarPoint(east, { x: 140, z: 0 })
        expect(point.x).toBeCloseTo(0, 6)
        expect(point.y).toBeCloseTo(-40 / RADAR_RANGE, 6)
    })

    it('pins distant birds to the rim while keeping their bearing', () => {
        const point = radarPoint(origin, { x: 0, z: 900 })
        expect(point.clamped).toBe(true)
        expect(point.distance).toBeCloseTo(900, 6)
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 6)
        expect(point.y).toBeCloseTo(1, 6)
    })

    it('bands contacts by height relative to the local bird', () => {
        expect(altitudeBand(ALTITUDE_BAND + 1)).toBe('above')
        expect(altitudeBand(-ALTITUDE_BAND - 1)).toBe('below')
        expect(altitudeBand(0)).toBe('level')
        expect(altitudeBand(ALTITUDE_BAND)).toBe('level')
        expect(altitudeBand(-ALTITUDE_BAND)).toBe('level')
    })
})

describe('createMinimap drawing', () => {
    const local = { x: 0, y: 50, z: 0, yaw: 0 }

    it('draws one blip per peer, ahead of the local bird at the top', () => {
        const { minimap, blips } = minimapFor()
        minimap.draw(local, [contact(1, 0, 50, -75)])
        expect(blips).toHaveLength(1)
        expect(blips[0]!.x).toBeCloseTo(95, 6)
        expect(blips[0]!.y).toBeLessThan(95)
        expect(blips[0]!.fill).toBe('#8de3b0')
        expect(blips[0]!.alpha).toBe(1)
    })

    it('colours blips by relative altitude and dims wrecked peers', () => {
        const { minimap, blips } = minimapFor()
        minimap.draw(local, [
            contact(1, 0, 50, -30),
            contact(2, 0, 90, -30),
            contact(3, 0, 10, -30),
            contact(4, 0, 50, -30, 0),
        ])
        expect(blips.map((blip) => blip.fill)).toEqual(['#8de3b0', '#f0c16a', '#8fd0e8', '#e0886f'])
    })

    it('pins out-of-range peers to the rim with a faded blip', () => {
        const { minimap, blips } = minimapFor()
        minimap.draw(local, [contact(1, 0, 50, -900)])
        expect(blips[0]!.radius).toBeCloseTo(3.5, 6)
        expect(blips[0]!.alpha).toBe(0.5)
        expect(Math.hypot(blips[0]!.x - 95, blips[0]!.y - 95)).toBeCloseTo(83.6, 3)
    })

    it('draws no blips with no peers', () => {
        const { minimap, blips } = minimapFor()
        minimap.draw(local)
        expect(blips).toHaveLength(0)
    })
})
