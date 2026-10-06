/**
 * Procedural sound engine built on the Web Audio API. Every voice is synthesised from one looping
 * noise buffer plus a few oscillators, so there are no assets to load and each voice can be driven
 * continuously by gameplay state: the wind tracks the listener's airspeed, and flap whooshes and
 * gunshots are placed on a `PannerNode` so a shot behind the bird really does arrive from behind.
 *
 * `createAudio` returns `null` on platforms without Web Audio (notably jsdom, so the unit tests
 * keep working) and the whole engine is created lazily inside `resume`, because browsers only allow
 * an `AudioContext` to start from a user gesture.
 */

/** Plain 3D vector accepted by the positional voices; kept free of THREE so audio stays testable. */
export interface Vec3 {
    x: number
    y: number
    z: number
}

export const audioConfig = {
    /** Master output level. */
    master: 0.85,
    /** Airspeed-independent wind floor, so a bird parked on the ground still hears a breeze. */
    windIdle: 0.01,
    /** Wind gain added per metre/second of airspeed. */
    windPerSpeed: 0.02,
    /** Wind gain ceiling, so a screaming dive cannot blow out the mix. */
    windMax: 0.4,
    /** Lowpass corner of the wind voice at zero airspeed, in Hz. */
    windFilterIdle: 380,
    /** Lowpass corner added per metre per second of airspeed, in Hz. */
    windFilterPerSpeed: 58,
    /** Lowpass corner ceiling, in Hz. */
    windFilterMax: 2600,
    /** Time constant used to chase a new wind level, in seconds. */
    windSmoothing: 0.28,
    /** Peak gain of one flap whoosh. */
    flapGain: 0.45,
    /** Seconds a flap whoosh lasts. */
    flapDuration: 0.32,
    /** Peak gain of a gunshot. */
    shotGain: 0.55,
    /** Seconds a gunshot lasts. */
    shotDuration: 0.3,
    /** Peak gain of an impact tick. */
    impactGain: 0.4,
    /** Seconds an impact tick lasts. */
    impactDuration: 0.16,
    /** Peak gain of a power-up pickup chime. */
    pickupGain: 0.35,
    /** Seconds the pickup chime lasts. */
    pickupDuration: 0.26,
    /** Distance at which a positional sound plays at full gain, in metres. */
    refDistance: 9,
    /** How quickly a positional sound fades with distance. */
    rolloff: 1.15,
    /** Distance beyond which a positional sound is effectively silent, in metres. */
    maxDistance: 240,
    /** Hard cap on simultaneous positional voices, so a bullet storm cannot exhaust the audio thread. */
    maxVoices: 24,
    /** Height above the bird's origin the listener's ear sits at, in metres. */
    listenerHeight: 1.1,
}

export type AudioConfig = typeof audioConfig

/** Wind noise level for a given airspeed, in `windIdle..windMax`. */
export function windLevel(speed: number, config: AudioConfig = audioConfig): number {
    const value = Number.isFinite(speed) ? Math.max(0, speed) : 0
    return Math.min(config.windMax, config.windIdle + value * config.windPerSpeed)
}

/** Lowpass corner for the wind voice at a given airspeed, in Hz. */
export function windFilterFrequency(speed: number, config: AudioConfig = audioConfig): number {
    const value = Number.isFinite(speed) ? Math.max(0, speed) : 0
    return Math.min(config.windFilterMax, config.windFilterIdle + value * config.windFilterPerSpeed)
}

/** Mean wing angle a downstroke must fall through to be counted, in radians. */
export const FLAP_CROSSING = 0.05
/** How far above the crossing the wings must have risen for the stroke to count, in radians. */
export const FLAP_MIN_STROKE = 0.18
/** Stroke amplitude that maps to a full-volume whoosh, in radians. */
export const FLAP_FULL_STROKE = 0.5

/** Rolling state of one bird's wing beat, used to find the top of each downstroke. */
export interface FlapDetector {
    /** Mean wing angle on the previous frame. */
    angle: number
    /** Highest mean wing angle seen since the last reported downstroke. */
    peak: number
}

export function createFlapDetector(): FlapDetector {
    return { angle: 0, peak: 0 }
}

/**
 * Feeds one frame of mean wing angle to the detector and returns the intensity (`0..1`) of a
 * downstroke on the frame the wings cross back below `FLAP_CROSSING`, or `null` while they are
 * rising, holding a glide or folded. Pure, so the beat logic is unit tested without any audio.
 */
export function stepFlapDetector(state: FlapDetector, angle: number): number | null {
    if (!Number.isFinite(angle)) return null
    let stroke: number | null = null
    if (state.angle > FLAP_CROSSING && angle <= FLAP_CROSSING && state.peak >= FLAP_CROSSING + FLAP_MIN_STROKE) {
        stroke = Math.min(1, (state.peak - FLAP_CROSSING) / FLAP_FULL_STROKE)
        state.peak = angle
    } else if (angle > state.peak) {
        state.peak = angle
    }
    state.angle = angle
    return stroke
}

export interface FlightAudio {
    /** Builds and resumes the context. Must be called from a user gesture; safe to call often. */
    resume: () => Promise<void>
    /** True once the context is running and the wind voice is audible. */
    readonly running: boolean
    /** Follows the local bird: moves the listener, then sets the wind voice from the airspeed. */
    update: (position: Vec3, yaw: number, airspeed: number) => void
    /** One gunshot at a world position; distance and direction come from the listener. */
    shot: (origin: Vec3) => void
    /** One wing downstroke at a world position; `intensity` is `0..1`. */
    flap: (position: Vec3, intensity: number) => void
    /** A round stopping on terrain or a bird; `energy` is its speed as a fraction of muzzle speed. */
    impact: (position: Vec3, energy: number) => void
    /** A power-up collected at a world position. */
    pickup: (position: Vec3) => void
    /** Stops every voice and closes the context. */
    dispose: () => void
}

/** A transient sound: one gain bus, the nodes to release with it, and the sources that end it. */
interface Voice {
    at: number
    input: GainNode
    nodes: AudioNode[]
    sources: AudioScheduledSourceNode[]
}

export function createAudio(): FlightAudio | null {
    const Constructor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Constructor) return null
    // Bound to a non-optional const so the closures below can construct it without re-narrowing.
    const createContext: () => AudioContext = () => new Constructor()

    let context: AudioContext | null = null
    let master: GainNode | null = null
    let noise: AudioBuffer | null = null
    let wind: { source: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null
    let hasListenerPosition = false
    let hasPannerPosition = false
    let activeVoices = 0
    let disposed = false

    /** Two seconds of white noise, looped and filtered by every voice, so nothing is downloaded. */
    function buildNoise(target: AudioContext): AudioBuffer {
        const length = Math.floor(target.sampleRate * 2)
        const buffer = target.createBuffer(1, length, target.sampleRate)
        const data = buffer.getChannelData(0)
        for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1
        return buffer
    }

    /** Loud, airy wind: noise through a lowpass whose corner opens up with airspeed. */
    function createWind(target: AudioContext, output: AudioNode) {
        const source = target.createBufferSource()
        source.buffer = noise
        source.loop = true
        const filter = target.createBiquadFilter()
        filter.type = 'lowpass'
        filter.frequency.value = audioConfig.windFilterIdle
        filter.Q.value = 0.6
        const gain = target.createGain()
        gain.gain.value = 0.0001
        source.connect(filter)
        filter.connect(gain)
        gain.connect(output)
        source.start()
        return { source, filter, gain }
    }

    function ensureGraph(): AudioContext | null {
        if (disposed) return null
        if (context) return context
        const created = createContext()
        context = created
        master = created.createGain()
        master.gain.value = audioConfig.master
        // A gentle limiter keeps a close-range burst from clipping the whole mix.
        const limiter = created.createDynamicsCompressor()
        limiter.threshold.value = -12
        limiter.knee.value = 24
        limiter.ratio.value = 6
        limiter.attack.value = 0.003
        limiter.release.value = 0.25
        master.connect(limiter)
        limiter.connect(created.destination)
        noise = buildNoise(created)
        hasListenerPosition = 'positionX' in created.listener
        hasPannerPosition = 'positionX' in created.createPanner()
        wind = createWind(created, master)
        return created
    }

    async function resume() {
        const target = ensureGraph()
        if (!target) return
        if (target.state === 'suspended') {
            try {
                await target.resume()
            } catch {
                // Some other gesture will retry; the graph is already built and simply stays silent.
            }
        }
    }

    function placePanner(panner: PannerNode, origin: Vec3) {
        if (hasPannerPosition) {
            panner.positionX.value = origin.x
            panner.positionY.value = origin.y
            panner.positionZ.value = origin.z
        } else {
            const legacy = panner as unknown as { setPosition: (x: number, y: number, z: number) => void }
            legacy.setPosition(origin.x, origin.y, origin.z)
        }
    }

    function moveListener(position: Vec3, yaw: number) {
        if (!context) return
        const listener = context.listener
        const x = position.x
        const y = position.y + audioConfig.listenerHeight
        const z = position.z
        const forwardX = Math.sin(yaw)
        const forwardZ = -Math.cos(yaw)
        if (hasListenerPosition) {
            listener.positionX.value = x
            listener.positionY.value = y
            listener.positionZ.value = z
            listener.forwardX.value = forwardX
            listener.forwardY.value = 0
            listener.forwardZ.value = forwardZ
            listener.upX.value = 0
            listener.upY.value = 1
            listener.upZ.value = 0
        } else {
            const legacy = listener as unknown as {
                setPosition: (x: number, y: number, z: number) => void
                setOrientation: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void
            }
            legacy.setPosition(x, y, z)
            legacy.setOrientation(forwardX, 0, forwardZ, 0, 1, 0)
        }
    }

    /** Allocates a voice panned at `origin` (or centred when omitted), or `null` when saturated. */
    function createVoice(origin: Vec3 | null): Voice | null {
        if (!context || !master || activeVoices >= audioConfig.maxVoices) return null
        const voice: Voice = { at: context.currentTime, input: context.createGain(), nodes: [], sources: [] }
        voice.nodes.push(voice.input)
        if (origin) {
            const panner = context.createPanner()
            panner.panningModel = 'HRTF'
            panner.distanceModel = 'inverse'
            panner.refDistance = audioConfig.refDistance
            panner.rolloffFactor = audioConfig.rolloff
            panner.maxDistance = audioConfig.maxDistance
            placePanner(panner, origin)
            voice.input.connect(panner)
            panner.connect(master)
            voice.nodes.push(panner)
        } else {
            voice.input.connect(master)
        }
        activeVoices += 1
        return voice
    }

    /** Releases the voice once its last source has ended, so nothing leaks per shot. */
    function finishVoice(voice: Voice) {
        if (!voice.sources.length) {
            releaseVoice(voice)
            return
        }
        let pending = voice.sources.length
        const done = () => {
            pending -= 1
            if (pending <= 0) releaseVoice(voice)
        }
        for (const source of voice.sources) source.onended = done
    }

    function releaseVoice(voice: Voice) {
        for (const node of voice.nodes) node.disconnect()
        activeVoices = Math.max(0, activeVoices - 1)
    }

    /** Adds a filtered, enveloped burst of the shared noise buffer to a voice. */
    function addNoise(voice: Voice, options: {
        at: number
        duration: number
        gain: number
        type: BiquadFilterType
        frequency: number
        endFrequency?: number
        q?: number
        attack?: number
    }) {
        if (!context || !noise) return
        const source = context.createBufferSource()
        source.buffer = noise
        source.loop = true
        const filter = context.createBiquadFilter()
        filter.type = options.type
        filter.frequency.setValueAtTime(options.frequency, options.at)
        if (options.endFrequency !== undefined) {
            filter.frequency.exponentialRampToValueAtTime(Math.max(30, options.endFrequency), options.at + options.duration)
        }
        filter.Q.value = options.q ?? 0.9
        const envelope = context.createGain()
        const peak = Math.max(0.0001, options.gain)
        envelope.gain.setValueAtTime(0.0001, options.at)
        envelope.gain.exponentialRampToValueAtTime(peak, options.at + (options.attack ?? 0.005))
        envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration)
        source.connect(filter)
        filter.connect(envelope)
        envelope.connect(voice.input)
        const offset = Math.random() * Math.max(0, noise.duration - options.duration - 0.05)
        source.start(options.at, offset)
        source.stop(options.at + options.duration + 0.03)
        voice.sources.push(source)
        voice.nodes.push(source, filter, envelope)
    }

    /** Adds a decaying sine sweep to a voice; the low thump under a gunshot and an impact. */
    function addTone(voice: Voice, options: { at: number; duration: number; frequency: number; endFrequency: number; gain: number }) {
        if (!context) return
        const oscillator = context.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(options.frequency, options.at)
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.endFrequency), options.at + options.duration)
        const envelope = context.createGain()
        envelope.gain.setValueAtTime(0.0001, options.at)
        envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, options.gain), options.at + 0.004)
        envelope.gain.exponentialRampToValueAtTime(0.0001, options.at + options.duration)
        oscillator.connect(envelope)
        envelope.connect(voice.input)
        oscillator.start(options.at)
        oscillator.stop(options.at + options.duration + 0.03)
        voice.sources.push(oscillator)
        voice.nodes.push(oscillator, envelope)
    }

    function update(position: Vec3, yaw: number, airspeed: number) {
        if (!context || !wind) return
        moveListener(position, yaw)
        const now = context.currentTime
        wind.gain.gain.setTargetAtTime(windLevel(airspeed), now, audioConfig.windSmoothing)
        wind.filter.frequency.setTargetAtTime(windFilterFrequency(airspeed), now, audioConfig.windSmoothing)
    }

    function shot(origin: Vec3) {
        const voice = createVoice(origin)
        if (!voice) return
        const { at } = voice
        // A sharp high crack, a body of lowpassed noise and a short sub thump give the shot weight.
        addNoise(voice, { at, duration: 0.07, gain: audioConfig.shotGain, type: 'highpass', frequency: 1600, endFrequency: 900, attack: 0.001 })
        addNoise(voice, { at, duration: audioConfig.shotDuration, gain: audioConfig.shotGain * 0.8, type: 'lowpass', frequency: 900, endFrequency: 260 })
        addTone(voice, { at, duration: 0.13, frequency: 90, endFrequency: 46, gain: audioConfig.shotGain * 0.7 })
        finishVoice(voice)
    }

    function flap(position: Vec3, intensity: number) {
        const voice = createVoice(position)
        if (!voice) return
        const { at } = voice
        const level = audioConfig.flapGain * Math.max(0.15, Math.min(1, intensity))
        // One slow whoosh: a lowpassed body plus a band-passed swish sweeping down.
        addNoise(voice, { at, duration: audioConfig.flapDuration, gain: level, type: 'lowpass', frequency: 700, endFrequency: 180, q: 1.4, attack: 0.02 })
        addNoise(voice, { at: at + 0.01, duration: audioConfig.flapDuration * 0.7, gain: level * 0.5, type: 'bandpass', frequency: 900, endFrequency: 300, q: 1.1, attack: 0.01 })
        finishVoice(voice)
    }

    function impact(position: Vec3, energy: number) {
        const voice = createVoice(position)
        if (!voice) return
        const { at } = voice
        const level = audioConfig.impactGain * Math.max(0.25, Math.min(1.2, energy))
        addNoise(voice, { at, duration: audioConfig.impactDuration, gain: level, type: 'bandpass', frequency: 420, endFrequency: 160, attack: 0.001 })
        addTone(voice, { at, duration: 0.09, frequency: 150, endFrequency: 70, gain: level * 0.5 })
        finishVoice(voice)
    }

    function pickup(position: Vec3) {
        const voice = createVoice(position)
        if (!voice) return
        const { at } = voice
        // A bright rising two-tone ping, so a pickup cuts through the wind and reads as a reward.
        addTone(voice, { at, duration: audioConfig.pickupDuration, frequency: 660, endFrequency: 1320, gain: audioConfig.pickupGain })
        addTone(voice, { at: at + 0.08, duration: audioConfig.pickupDuration, frequency: 990, endFrequency: 1980, gain: audioConfig.pickupGain * 0.8 })
        finishVoice(voice)
    }

    function dispose() {
        disposed = true
        if (wind) {
            try {
                wind.source.stop()
            } catch {
                // The source may already have ended; disconnecting below is enough.
            }
            wind.source.disconnect()
            wind.filter.disconnect()
            wind.gain.disconnect()
            wind = null
        }
        if (context) {
            void context.close().catch(() => { })
        }
        context = null
        master = null
        noise = null
        activeVoices = 0
    }

    return {
        resume,
        get running() {
            return context !== null && context.state === 'running'
        },
        update,
        shot,
        flap,
        impact,
        pickup,
        dispose,
    }
}
