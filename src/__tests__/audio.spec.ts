import { describe, expect, it } from 'vitest'

import { audioConfig, createAudio, createFlapDetector, stepFlapDetector, windFilterFrequency, windLevel } from '../audio'

describe('audio wind mapping', () => {
    it('rises from an idle breeze toward a capped ceiling as airspeed climbs', () => {
        expect(windLevel(0)).toBeCloseTo(audioConfig.windIdle, 6)
        expect(windLevel(10)).toBeCloseTo(audioConfig.windIdle + 10 * audioConfig.windPerSpeed, 6)
        expect(windLevel(10)).toBeGreaterThan(windLevel(5))
        expect(windLevel(1000)).toBe(audioConfig.windMax)
    })

    it('treats negative and non-finite airspeeds as a standstill', () => {
        expect(windLevel(-8)).toBeCloseTo(audioConfig.windIdle, 6)
        expect(windLevel(Number.NaN)).toBeCloseTo(audioConfig.windIdle, 6)
        expect(windFilterFrequency(Number.NaN)).toBe(audioConfig.windFilterIdle)
    })

    it('opens the wind lowpass with airspeed and clamps it at the ceiling', () => {
        expect(windFilterFrequency(0)).toBe(audioConfig.windFilterIdle)
        expect(windFilterFrequency(10)).toBeCloseTo(audioConfig.windFilterIdle + 10 * audioConfig.windFilterPerSpeed, 6)
        expect(windFilterFrequency(1000)).toBe(audioConfig.windFilterMax)
    })

    it('honours a custom config so the mix can be retuned in one place', () => {
        const config = { ...audioConfig, windIdle: 0, windPerSpeed: 0.1, windMax: 5, windFilterIdle: 100, windFilterPerSpeed: 10, windFilterMax: 400 }
        expect(windLevel(10, config)).toBeCloseTo(1, 6)
        expect(windFilterFrequency(10, config)).toBe(200)
    })
})

describe('flap detection', () => {
    it('starts silent with the wings level', () => {
        expect(createFlapDetector()).toEqual({ angle: 0, peak: 0 })
    })

    it('reports exactly one downstroke for a full up-and-down beat', () => {
        const detector = createFlapDetector()
        const angles = [0, 0.3, 0.62, 0.3, 0, -0.3, -0.62, -0.3, 0]
        const strokes = angles.map((angle) => stepFlapDetector(detector, angle))
        expect(strokes.filter((stroke) => stroke !== null)).toHaveLength(1)
        // The whoosh lands as the wings sweep down through the crossing, not on the way up.
        expect(strokes[2]).toBeNull()
        expect(strokes[4]).toBe(1)
    })

    it('reports one stroke per beat across a steady wingbeat', () => {
        const detector = createFlapDetector()
        const angles = [0, 0.62, 0, -0.62, 0, 0.62, 0]
        expect(angles.map((angle) => stepFlapDetector(detector, angle)).filter((stroke) => stroke !== null)).toHaveLength(2)
    })

    it('scales the intensity with the stroke amplitude', () => {
        const detector = createFlapDetector()
        ;[0, 0.3].forEach((angle) => stepFlapDetector(detector, angle))
        expect(stepFlapDetector(detector, 0)).toBeCloseTo((0.3 - 0.05) / 0.5, 6)
    })

    it('stays silent for a folded glide and for a small flutter below the stroke threshold', () => {
        const glide = createFlapDetector()
        for (const angle of [-0.85, -0.85, -0.85]) expect(stepFlapDetector(glide, angle)).toBeNull()
        const flutter = createFlapDetector()
        for (const angle of [0, 0.07, 0, 0.07, 0, -0.07, 0]) expect(stepFlapDetector(flutter, angle)).toBeNull()
    })

    it('ignores a non-finite angle without corrupting the running state', () => {
        const detector = createFlapDetector()
        expect(stepFlapDetector(detector, Number.NaN)).toBeNull()
        expect(detector).toEqual({ angle: 0, peak: 0 })
    })
})

describe('audio engine construction', () => {
    it('degrades to null where Web Audio is unavailable', () => {
        // jsdom has no Web Audio, which is exactly the path the app relies on in tests.
        expect('AudioContext' in window).toBe(false)
        expect(createAudio()).toBeNull()
    })
})
