import { describe, it, expect, vi } from 'vitest'

import { mount } from '@vue/test-utils'
import type { Pose } from '@tensorflow-models/pose-detection'
import App from '../App.vue'
import { advanceCourse, courseRings, courseSpawn } from '../course'
import { flightConfig, initialFlightState, stepFlight } from '../flight'
import { PoseControls } from '../poseControls'
import { terrainHeight as rollingTerrainHeight } from '../terrain'

vi.mock('../scene', () => ({
  createScene: () => ({ render: () => { }, dispose: () => { } }),
  terrainHeight: () => 0,
}))
vi.stubGlobal('requestAnimationFrame', () => 1)
vi.stubGlobal('cancelAnimationFrame', () => { })

describe('App', () => {
  it('mounts renders properly', () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('FLIGHT LAB')
    expect(wrapper.text()).toContain('START CAMERA')
    wrapper.unmount()
  })

  it('changes flight tuning live and restores defaults', async () => {
    const wrapper = mount(App)
    await wrapper.get('button[aria-label="Flight settings"]').trigger('click')
    expect(wrapper.find('aside[aria-label="Flight tuning"]').exists()).toBe(true)
    await wrapper.get('#setting-maxSpeed').setValue('32')
    expect(wrapper.get('output[for="setting-maxSpeed"]').text()).toBe('32.0')
    expect(flightConfig.maxSpeed).toBe(24)
    await wrapper.get('.settings-reset').trigger('click')
    expect(wrapper.get('output[for="setting-maxSpeed"]').text()).toBe('24.0')
    wrapper.unmount()
  })
})

describe('flight', () => {
  const flatGround = () => 0

  it('moves on the ground and launches after five normally spaced Space presses', () => {
    let state = initialFlightState(0)
    for (let press = 0; press < 4; press++) {
      state = stepFlight(state, { flap: true, steer: 0, spread: 1 }, 0.05, flatGround)
      expect(state.flying).toBe(false)
      for (let frame = 0; frame < 4; frame++) {
        state = stepFlight(state, { flap: false, steer: 0, spread: 1 }, 0.05, flatGround)
      }
    }
    expect(state.speed).toBeGreaterThan(0)
    expect(state.z).toBeLessThan(0)
    state = stepFlight(state, { flap: true, steer: 0, spread: 1 }, 0.05, flatGround)
    expect(state.flying).toBe(true)
    expect(state.y).toBeGreaterThan(0)
  })

  it('glides farther with extended wings and turns when steering', () => {
    const airborne = { ...initialFlightState(0), flying: true, y: 20, speed: 12 }
    const glide = stepFlight(airborne, { flap: false, steer: 1, spread: 1 }, 0.05, flatGround)
    const dive = stepFlight(airborne, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    expect(glide.y).toBeGreaterThan(dive.y)
    expect(glide.yaw).toBeGreaterThan(0)
  })

  it('builds ground speed gradually and gains lift from continuous wing power', () => {
    const ground = initialFlightState(0)
    const small = stepFlight(ground, { flap: false, flapPower: 0.2, steer: 0, spread: 1 }, 0.05, flatGround)
    const strong = stepFlight(ground, { flap: false, flapPower: 1.2, steer: 0, spread: 1 }, 0.05, flatGround)
    expect(small.speed).toBeGreaterThan(0)
    expect(strong.speed).toBeGreaterThan(small.speed)
    expect(small.y).toBe(0)
    let state = ground
    for (let count = 0; count < 120 && !state.flying; count++) {
      state = stepFlight(state, { flap: false, flapPower: 0.3, steer: 0, spread: 1 }, 0.05, flatGround)
    }
    expect(state.flying).toBe(true)
    const airborne = { ...ground, y: 20, speed: 10, flying: true }
    const powered = stepFlight(airborne, { flap: false, flapPower: 0.8, steer: 0, spread: 1 }, 0.05, flatGround)
    const gliding = stepFlight(airborne, { flap: false, flapPower: 0, steer: 0, spread: 1 }, 0.05, flatGround)
    expect(powered.y).toBeGreaterThan(gliding.y)
    expect(powered.speed).toBeGreaterThan(gliding.speed)
  })

  it('takes off with intermittent moderate pose flaps', () => {
    let state = initialFlightState(0)
    for (let frame = 0; frame < 300 && !state.flying; frame++) {
      state = stepFlight(state, { flap: false, flapPower: frame % 3 === 0 ? 0.3 : 0, steer: 0, spread: 1 }, 0.05, flatGround)
    }
    expect(state.flying).toBe(true)
    expect(state.speed).toBeGreaterThanOrEqual(flightConfig.takeoffSpeed - 1)
  })

  it('lifts off from repeated modest tracked downstrokes with partially folded arms', () => {
    const adapter = new PoseControls()
    const trackedPose = (wristHeight: number): Pose => ({
      keypoints: [
        { name: 'left_shoulder', x: 100, y: 100, score: 0.95 },
        { name: 'right_shoulder', x: 200, y: 100, score: 0.95 },
        { name: 'left_wrist', x: 50, y: wristHeight, score: 0.95 },
        { name: 'right_wrist', x: 250, y: wristHeight, score: 0.95 },
      ],
    })
    let state = initialFlightState(0)
    for (let stroke = 0; stroke < 35 && !state.flying; stroke++) {
      for (const [phase, wristHeight] of [20, 28].entries()) {
        const input = adapter.update(trackedPose(wristHeight), (stroke * 2 + phase + 1) * 100)
        for (let frame = 0; frame < 2; frame++) {
          state = stepFlight(state, input!, 0.05, flatGround)
        }
      }
    }
    expect(state.flying).toBe(true)
  })

  it('takes four to six hard pose flaps to launch and stays aloft after the bump', () => {
    const adapter = new PoseControls()
    const trackedPose = (wristHeight: number): Pose => ({
      keypoints: [
        { name: 'left_shoulder', x: 100, y: 100, score: 0.95 },
        { name: 'right_shoulder', x: 200, y: 100, score: 0.95 },
        { name: 'left_wrist', x: 50, y: wristHeight, score: 0.95 },
        { name: 'right_wrist', x: 250, y: wristHeight, score: 0.95 },
      ],
    })
    let state = initialFlightState(0)
    let launchedAt = 0
    for (let stroke = 1; stroke <= 6; stroke++) {
      for (const [phase, wristHeight] of [20, 150].entries()) {
        const input = adapter.update(trackedPose(wristHeight), ((stroke - 1) * 2 + phase + 1) * 100)!
        for (let frame = 0; frame < 2; frame++) {
          state = stepFlight(state, input, 0.05, flatGround)
        }
      }
      if (state.flying && !launchedAt) launchedAt = stroke
    }
    expect(launchedAt).toBeGreaterThanOrEqual(4)
    expect(launchedAt).toBeLessThanOrEqual(6)
    expect(state.y).toBeGreaterThan(0.1)
    for (let frame = 0; frame < 8; frame++) {
      state = stepFlight(state, { flap: false, steer: 0, spread: 1 }, 0.05, flatGround)
    }
    expect(state.flying).toBe(true)
  })

  it('uses the same flap physics once airborne regardless of altitude', () => {
    const controls = { flap: false, flapPower: 0.3, steer: 0, spread: 1 }
    const start = { ...initialFlightState(0), flying: true, speed: 8 }
    const low = stepFlight({ ...start, y: 0.5 }, controls, 0.05, flatGround)
    const clear = stepFlight({ ...start, y: 20 }, controls, 0.05, flatGround)
    expect(low.verticalSpeed).toBeCloseTo(clear.verticalSpeed)
    expect(low.speed).toBeCloseTo(clear.speed)
  })

  it('sinks when coasting but climbs decisively with stronger repeated flaps', () => {
    const start = { ...initialFlightState(0), flying: true, y: 100, speed: 10 }
    const coastInput = { flap: false, steer: 0, spread: 1 }
    let coasting = start
    let modest = start
    let hard = start
    for (let frame = 0; frame < 40; frame++) {
      coasting = stepFlight(coasting, coastInput, 0.05, flatGround)
      modest = stepFlight(modest, { ...coastInput, flapPower: frame % 6 < 2 ? 0.3 : 0 }, 0.05, flatGround)
      hard = stepFlight(hard, { ...coastInput, flapPower: frame % 6 < 2 ? 1.2 : 0 }, 0.05, flatGround)
    }
    expect(coasting.y).toBeLessThan(start.y - 7)
    expect(modest.y).toBeGreaterThan(coasting.y)
    expect(hard.y).toBeGreaterThan(start.y + 8)
    expect(hard.y).toBeGreaterThan(modest.y + 8)
  })

  it('turns a down-wing dive into bounded speed and spends that speed on a pull-out', () => {
    const start = { ...initialFlightState(0), y: 150, flying: true, speed: 8, verticalSpeed: -2 }
    let dive = start
    for (let frame = 0; frame < 45; frame++) {
      dive = stepFlight(dive, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    }
    expect(dive.y).toBeLessThan(start.y)
    expect(dive.speed).toBeGreaterThan(start.speed)
    expect(dive.speed).toBeLessThanOrEqual(flightConfig.maxSpeed)

    let pullOut = dive
    let climbed = false
    for (let frame = 0; frame < 80; frame++) {
      pullOut = stepFlight(pullOut, { flap: false, steer: 0, spread: 1 }, 0.05, flatGround)
      if (pullOut.verticalSpeed > 0) climbed = true
    }
    expect(climbed).toBe(true)
    expect(pullOut.speed).toBeLessThan(dive.speed)
  })

  it('does not create energy while climbing without flapping', () => {
    const start = { ...initialFlightState(0), y: 100, flying: true, speed: 24, verticalSpeed: 6 }
    const next = stepFlight(start, { flap: false, steer: 0, spread: 1 }, 0.05, () => -100)
    const energy = (state: typeof start) => flightConfig.gravity * state.y + (state.speed ** 2 + state.verticalSpeed ** 2) / 2
    expect(next.y).toBeGreaterThan(start.y)
    expect(energy(next)).toBeLessThan(energy(start))
  })

  it('loses energy across repeated unpowered dives and pull-outs', () => {
    const energy = (state: ReturnType<typeof initialFlightState>) =>
      flightConfig.gravity * state.y + (state.speed ** 2 + state.verticalSpeed ** 2) / 2
    let state = { ...initialFlightState(0), y: 1000, flying: true, speed: 18 }
    const startingEnergy = energy(state)
    for (let frame = 0; frame < 240; frame++) {
      const next = stepFlight(state, { flap: false, steer: 0, spread: frame % 80 < 40 ? 0 : 1 }, 0.05, () => -1000)
      expect(energy(next)).toBeLessThanOrEqual(energy(state) + 0.001)
      state = next
    }
    expect(energy(state)).toBeLessThan(startingEnergy - 10)
  })

  it('starts gaining dive speed when falling and retains forward momentum on landing', () => {
    const level = { ...initialFlightState(0), y: 10, flying: true, speed: 10, verticalSpeed: 0 }
    const tucked = stepFlight(level, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    const gliding = stepFlight(level, { flap: false, steer: 0, spread: 1 }, 0.05, flatGround)
    expect(tucked.verticalSpeed).toBeLessThan(0)
    expect(tucked.speed).toBeGreaterThan(level.speed)
    expect(tucked.speed).toBeGreaterThan(gliding.speed)
    const landed = stepFlight({ ...level, y: 0.01, verticalSpeed: -5 }, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    expect(landed.flying).toBe(false)
    expect(landed.speed).toBeGreaterThan(0)
    expect(landed.speed).toBeLessThan(level.speed * 0.25)
    const rolling = stepFlight(landed, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    expect(rolling.speed).toBeLessThan(landed.speed)
    expect(rolling.z).toBeLessThan(landed.z)
    let stopped = landed
    for (let frame = 0; frame < 25; frame++) {
      stopped = stepFlight(stopped, { flap: false, steer: 0, spread: 0 }, 0.05, flatGround)
    }
    expect(stopped.speed).toBe(0)
  })

  it('uses configurable speed, lift, and drag without changing default tuning', () => {
    const airborne = { ...initialFlightState(0), y: 30, flying: true, speed: 14, verticalSpeed: -2 }
    const input = { flap: false, steer: 0, spread: 1 }
    const standard = stepFlight(airborne, input, 0.05, flatGround)
    const tuned = stepFlight(airborne, input, 0.05, flatGround, {
      ...flightConfig,
      maxSpeed: 10,
      wingDrag: flightConfig.wingDrag * 2,
    })
    const moreLift = stepFlight(airborne, input, 0.05, flatGround, {
      ...flightConfig,
      glideLift: flightConfig.glideLift * 2,
    })
    expect(tuned.speed).toBeLessThanOrEqual(10)
    expect(tuned.speed).toBeLessThan(standard.speed)
    expect(moreLift.verticalSpeed).toBeGreaterThan(standard.verticalSpeed)
    expect(flightConfig.maxSpeed).toBe(24)
  })
})

describe('terrain', () => {
  it('starts smooth and rises into rolling hills', () => {
    expect(rollingTerrainHeight(0, 0)).toBeCloseTo(0)
    expect(Math.abs(rollingTerrainHeight(2, -2))).toBeLessThan(1)
    expect(rollingTerrainHeight(0, -80)).toBeGreaterThan(rollingTerrainHeight(0, 0) + 10)
    expect(Math.abs(rollingTerrainHeight(90, -80) - rollingTerrainHeight(0, -80))).toBeGreaterThan(3)
  })
})

describe('course', () => {
  it('requires ordered forward crossings through each ring opening to complete a lap', () => {
    const flight = { ...initialFlightState(0), flying: true }
    let progress = { nextRing: 0, laps: 0 }
    const crossing = (index: number, offsetX = 0, offsetY = 0) => {
      const ring = courseRings[index]!
      return [
        { ...flight, x: ring.x - ring.forwardX * 2 - ring.forwardZ * offsetX, y: ring.y - 1.1 + offsetY, z: ring.z - ring.forwardZ * 2 + ring.forwardX * offsetX },
        { ...flight, x: ring.x + ring.forwardX * 2 - ring.forwardZ * offsetX, y: ring.y - 1.1 + offsetY, z: ring.z + ring.forwardZ * 2 + ring.forwardX * offsetX },
      ] as const
    }
    const [earlyStart, earlyEnd] = crossing(courseRings.length - 1)
    expect(advanceCourse(progress, earlyStart, earlyEnd)).toEqual(progress)
    const [missStart, missEnd] = crossing(0, 5)
    expect(advanceCourse(progress, missStart, missEnd)).toEqual(progress)
    for (let index = 0; index < courseRings.length; index++) {
      const [before, after] = crossing(index)
      expect(advanceCourse(progress, after, before)).toEqual(progress)
      progress = advanceCourse(progress, before, after)
    }
    expect(progress).toEqual({ nextRing: 0, laps: 1 })
    const finish = courseRings[courseRings.length - 1]!
    const start = courseRings[0]!
    const width = Math.max(...courseRings.map((ring) => ring.x)) - Math.min(...courseRings.map((ring) => ring.x))
    expect(width).toBeGreaterThanOrEqual(108)
    expect(Math.hypot(start.x - finish.x, start.z - finish.z)).toBeLessThan(20)
    expect((start.x - finish.x) * finish.forwardX + (start.z - finish.z) * finish.forwardZ).toBeGreaterThan(0)
    expect((courseSpawn.x - start.x) * start.forwardX + (courseSpawn.z - start.z) * start.forwardZ).toBeCloseTo(-20)
    expect(Math.sin(courseSpawn.yaw) * start.forwardX - Math.cos(courseSpawn.yaw) * start.forwardZ).toBeCloseTo(1)
    const [nextStart, nextEnd] = crossing(0)
    expect(advanceCourse(progress, nextStart, nextEnd)).toEqual({ nextRing: 1, laps: 1 })
  })
})

describe('pose controls', () => {
  function pose(leftY: number, rightY: number, score = 0.95): Pose {
    return {
      keypoints: [
        { name: 'left_shoulder', x: 100, y: 100, score },
        { name: 'right_shoulder', x: 200, y: 100, score },
        { name: 'left_elbow', x: 45, y: leftY, score },
        { name: 'right_elbow', x: 255, y: rightY, score },
        { name: 'left_wrist', x: 0, y: leftY, score },
        { name: 'right_wrist', x: 300, y: rightY, score },
      ]
    }
  }

  it('reduces lift area continuously as wings point down', () => {
    const settledSpread = (trackedPose: Pose) => {
      const adapter = new PoseControls()
      let spread = 0
      for (let frame = 0; frame < 16; frame++) {
        spread = adapter.update(trackedPose, (frame + 1) * 100)?.spread ?? 0
      }
      return spread
    }
    const level = settledSpread(pose(100, 100))
    const diagonal = settledSpread(pose(200, 200))
    const downPose = pose(200, 200)
    downPose.keypoints.find((point) => point.name === 'left_wrist')!.x = 100
    downPose.keypoints.find((point) => point.name === 'right_wrist')!.x = 200
    const down = settledSpread(downPose)
    expect(level).toBeGreaterThan(diagonal)
    expect(diagonal).toBeGreaterThan(down)
  })

  it('tracks wings from shoulder and wrist without using elbows', () => {
    const adapter = new PoseControls()
    const straight = pose(100, 100)
    const level = adapter.update(straight, 100)
    expect(level?.leftWing).toBeCloseTo(0)

    const bent = pose(100, 100)
    bent.keypoints.find((point) => point.name === 'left_elbow')!.y = 175
    expect(adapter.update(bent, 200)?.leftWing).toBeCloseTo(level?.leftWing ?? Infinity)
    bent.keypoints.find((point) => point.name === 'left_elbow')!.score = 0.1
    bent.keypoints.find((point) => point.name === 'left_wrist')!.y = 145
    const lowered = adapter.update(bent, 300)
    expect(lowered?.leftWing).toBeLessThan(-0.3)
    expect(lowered?.rightWing).toBeCloseTo(0)
  })

  it('scales downstroke power with speed, including small strokes, and ignores jitter', () => {
    const adapter = new PoseControls()
    const raised = adapter.update(pose(20, 20), 500)
    expect(raised?.flapPower).toBe(0)
    expect(raised?.leftWing).toBeGreaterThan(0)
    expect(raised?.rightWing).toBeGreaterThan(0)
    const small = adapter.update(pose(28, 28), 600)
    expect(small?.flapPower).toBeGreaterThan(0.2)
    const large = adapter.update(pose(58, 58), 700)
    expect(large?.flapPower).toBeGreaterThan(small?.flapPower ?? Infinity)
    expect(adapter.update(pose(58, 58), 800)?.flapPower).toBe(0)
    expect(adapter.update(pose(58.5, 58.5), 900)?.flapPower).toBe(0)
    const rightBank = adapter.update(pose(60, 150), 900)
    expect(rightBank?.steer).toBeGreaterThan(0)
    expect(rightBank?.leftWing).toBeGreaterThan(rightBank?.rightWing ?? Infinity)
    const leftBank = adapter.update(pose(150, 60), 920)
    expect(leftBank?.steer).toBeLessThan(0)
    expect(adapter.update(pose(120, 120, 0.2), 950)).toBeNull()
    expect(adapter.update(pose(140, 140), 1050)?.flapPower).toBe(0)
  })

  it('detects a hard downstroke on a slower camera', () => {
    const adapter = new PoseControls()
    adapter.update(pose(20, 20), 100)
    expect(adapter.update(pose(140, 140), 450)?.flapPower).toBeGreaterThan(0)
  })

  it('follows confident face landmarks and releases the head when they disappear', () => {
    const adapter = new PoseControls()
    const centered = pose(100, 100)
    centered.keypoints.push(
      { name: 'nose', x: 150, y: 50, score: 0.9 },
      { name: 'left_ear', x: 120, y: 60, score: 0.9 },
      { name: 'right_ear', x: 180, y: 60, score: 0.9 },
    )
    const neutral = adapter.update(centered, 100)?.head
    expect(neutral?.yaw).toBeCloseTo(0)
    expect(neutral?.tilt).toBeCloseTo(0)
    centered.keypoints.find((point) => point.name === 'nose')!.x = 170
    centered.keypoints.find((point) => point.name === 'right_ear')!.y = 72
    const turned = adapter.update(centered, 150)?.head
    expect(turned?.yaw).toBeLessThan(0)
    expect(turned?.tilt).toBeLessThan(0)
    centered.keypoints.find((point) => point.name === 'nose')!.score = 0.2
    expect(adapter.update(centered, 200)?.head).toBeNull()
  })
})
