<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Camera, CameraOff, Crosshair, Keyboard, MoveUp, RotateCcw, SlidersHorizontal, Target, Wind, X } from 'lucide-vue-next'
import type { Pose, PoseDetector } from '@tensorflow-models/pose-detection'
import { createAudio, type FlightAudio } from './audio'
import { advanceCourse, courseRings, courseSpawn, type CourseProgress } from './course'
import { applyHit, flightConfig, initialFlightState, respawnFlight, stepFlight, type FlightConfig, type FlightControls } from './flight'
import { createMinimap } from './minimap'
import { FlightNetwork, type RemoteFlight } from './network'
import { PoseControls, type HeadPose } from './poseControls'
import { powerupConfig, withinPickupRange } from './powerup'
import { createScene, terrainHeight, type ReticleTint } from './scene'
import { headAimOffset, updateAutoFire, type AutoFireTarget, weaponConfig } from './weapon'

const viewport = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const skeleton = ref<HTMLCanvasElement | null>(null)
const radar = ref<HTMLCanvasElement | null>(null)
const flight = ref({ ...initialFlightState(terrainHeight(courseSpawn.x, courseSpawn.z)), ...courseSpawn })
const course = ref<CourseProgress>({ nextRing: 0, laps: 0 })
const cameraStatus = ref<'off' | 'loading' | 'tracking' | 'lost'>('off')
const error = ref('')
const networkStatus = ref('SOLO')
const nearbyPlayers = ref(0)
const latencyMs = ref<number | null>(null)
const controls = ref<FlightControls>({ flap: false, steer: 0, spread: 1 })
const liftOutput = ref(0)
const settingsOpen = ref(false)
// Hidden by default so the sky stays clear; the header "Flight controls" button toggles it.
const instructionsOpen = ref(false)
// Body-mode auto-fire: opt-in, and inert unless pose tracking is live.
const autoFireEnabled = ref(false)
const autoFireLocked = ref(false)
const autoFireFiring = ref(false)
// Rounds are owner-local like health; the HUD mirrors the weapon rig's magazine each frame.
const ammoRounds = ref(weaponConfig.magazineSize)
const tuning = reactive<FlightConfig>({ ...flightConfig })
type TuningField = { key: keyof FlightConfig; label: string; min: number; max: number; step: number }
const settingGroups: { title: string; fields: TuningField[] }[] = [
  {
    title: 'Air & lift', fields: [
      { key: 'maxSpeed', label: 'Max speed', min: 6, max: 60, step: 0.5 },
      { key: 'gravity', label: 'Gravity', min: 1, max: 20, step: 0.1 },
      { key: 'glideLift', label: 'Glide lift', min: 0, max: 0.2, step: 0.005 },
      { key: 'passiveSink', label: 'Coasting sink', min: 0, max: 6, step: 0.1 },
      { key: 'maxGlideLift', label: 'Lift cap', min: 0, max: 40, step: 0.5 },
      { key: 'wingDrag', label: 'Wing drag', min: 0, max: 0.02, step: 0.0005 },
      { key: 'baseDrag', label: 'Base drag', min: 0, max: 2, step: 0.05 },
      { key: 'diveAcceleration', label: 'Dive acceleration', min: 0, max: 1, step: 0.02 },
    ]
  },
  {
    title: 'Wingbeats', fields: [
      { key: 'maxWingPower', label: 'Power cap', min: 0.5, max: 6, step: 0.1 },
      { key: 'wingPowerLift', label: 'Flap lift', min: 0, max: 40, step: 0.25 },
      { key: 'wingPowerThrust', label: 'Flap thrust', min: 0, max: 5, step: 0.1 },
      { key: 'keyboardFlapLift', label: 'Button lift', min: 0, max: 6, step: 0.1 },
      { key: 'keyboardFlapThrust', label: 'Button thrust', min: 0, max: 4, step: 0.1 },
      { key: 'maxPoweredClimbSpeed', label: 'Flap climb cap', min: 1, max: 20, step: 0.5 },
    ]
  },
  {
    title: 'Ground & takeoff', fields: [
      { key: 'takeoffCharge', label: 'Required energy', min: 0.2, max: 3, step: 0.05 },
      { key: 'chargeDecay', label: 'Energy decay', min: 0, max: 0.2, step: 0.005 },
      { key: 'chargeFromWingPower', label: 'Wingbeat charge', min: 0.5, max: 8, step: 0.1 },
      { key: 'chargePerKeyboardFlap', label: 'Button charge', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'takeoffSpeed', label: 'Launch speed', min: 3, max: 20, step: 0.5 },
      { key: 'takeoffLift', label: 'Launch lift', min: 1, max: 12, step: 0.25 },
      { key: 'groundFlapThrust', label: 'Ground flap thrust', min: 0, max: 60, step: 0.5 },
      { key: 'groundDrag', label: 'Ground drag', min: 0, max: 8, step: 0.05 },
      { key: 'landingSpeedRetention', label: 'Landing speed kept', min: 0, max: 1, step: 0.05 },
    ]
  },
  {
    title: 'Handling & limits', fields: [
      { key: 'turnRate', label: 'Turn rate', min: 0, max: 2, step: 0.05 },
      { key: 'speedTurnRate', label: 'Speed turning', min: 0, max: 0.2, step: 0.005 },
      { key: 'bankAngle', label: 'Bank angle', min: 0, max: 1, step: 0.01 },
      { key: 'bankResponse', label: 'Bank response', min: 0.5, max: 15, step: 0.5 },
      { key: 'minSpeed', label: 'Min airspeed', min: 0, max: 10, step: 0.1 },
      { key: 'maxClimbSpeed', label: 'Climb speed cap', min: 2, max: 25, step: 0.5 },
      { key: 'maxDiveSpeed', label: 'Descent speed cap', min: 5, max: 40, step: 0.5 },
      { key: 'maxTimeStep', label: 'Time step cap', min: 0.01, max: 0.1, step: 0.005 },
    ]
  },
  {
    title: 'Combat', fields: [
      { key: 'maxHealth', label: 'Max health', min: 25, max: 200, step: 5 },
      { key: 'damagePerHit', label: 'Damage per hit', min: 5, max: 100, step: 5 },
      { key: 'respawnDelay', label: 'Respawn delay', min: 0.5, max: 8, step: 0.5 },
      { key: 'autoFireRange', label: 'Auto-fire range', min: 10, max: 150, step: 5 },
      { key: 'autoFireAngle', label: 'Auto-fire cone', min: 2, max: 45, step: 1 },
      { key: 'autoFireDwell', label: 'Auto-fire dwell', min: 0, max: 1, step: 0.05 },
    ]
  },
]
const wingPose = ref<{ leftWing: number; rightWing: number } | null>(null)
const headPose = ref<HeadPose | null>(null)
const seconds = ref(0)
const mode = computed(() => flight.value.dead ? 'ELIMINATED' : flight.value.flying ? 'IN FLIGHT' : 'ON THE GROUND')
const healthPercent = computed(() => Math.max(0, Math.min(100, (flight.value.health / tuning.maxHealth) * 100)))
const ammoLow = computed(() => ammoRounds.value > 0 && ammoRounds.value <= 30)
const outOfAmmo = computed(() => ammoRounds.value <= 0)
const latencyClass = computed(() => latencyMs.value === null ? '' : latencyMs.value > 250 ? 'latency-bad' : latencyMs.value > 120 ? 'latency-warn' : '')
const altitude = computed(() => Math.max(0, flight.value.y - terrainHeight(flight.value.x, flight.value.z)))
const autoFireStatus = computed(() => {
  if (!autoFireEnabled.value) return 'OFF'
  if (cameraStatus.value !== 'tracking' || !flight.value.flying || flight.value.dead) return 'IDLE'
  if (!autoFireLocked.value) return 'SEEKING'
  return autoFireFiring.value ? 'FIRING' : 'LOCKING'
})
// The reticle is pale normally, cyan while armed and scanning, amber on lock, hot orange on fire.
const reticleTint = computed<ReticleTint>(() => {
  if (!autoFireEnabled.value || cameraStatus.value !== 'tracking') return 'off'
  if (autoFireFiring.value) return 'firing'
  if (autoFireLocked.value) return 'locked'
  return 'seeking'
})
const poseControls = new PoseControls()
const keys = new Set<string>()
let stream: MediaStream | null = null
let detector: PoseDetector | null = null
let latestPose: Pose | null = null
let lastPoseAt = 0
let flapQueued = false
let fireQueued = false
let pointerFiring = false
let renderFrame = 0
let poseFrame = 0
let lastFrame = 0
let scene: ReturnType<typeof createScene> | null = null
let minimap: ReturnType<typeof createMinimap> | null = null
let audio: FlightAudio | null = null
let running = false
let network: FlightNetwork | null = null
let reconnectTimer = 0
/** Reused auto-fire target views; the objects survive frames, mirroring the scene's hit pool. */
const autoFireTargetPool: AutoFireTarget[] = []
const autoFireTargets: AutoFireTarget[] = []
/** Seconds the lock cone has been held; reset whenever auto-fire is not active. */
let autoFireLock = 0
/** Power-up slots already reported to the server, so one fly-through is reported only once. */
const reportedPickups = new Set<number>()

function connectNetwork() {
  if (!running) return
  network?.close()
  networkStatus.value = 'CONNECTING'
  network = new FlightNetwork((status) => {
    if (!running) return
    networkStatus.value = status
    if (status === 'SOLO' && !reconnectTimer) {
      reconnectTimer = window.setTimeout(() => { reconnectTimer = 0; connectNetwork() }, 3000)
    }
  })
  network.connect().catch(() => {
    if (running && !reconnectTimer) {
      networkStatus.value = 'SOLO'
      reconnectTimer = window.setTimeout(() => { reconnectTimer = 0; connectNetwork() }, 3000)
    }
  })
}

/**
 * Browsers only let an `AudioContext` start from a user gesture, so every input path pokes this.
 * It is cheap once running and simply builds the (still suspended) graph the first time.
 */
function resumeAudio() { void audio?.resume() }

function keyDown(event: KeyboardEvent) {
  resumeAudio()
  if (event.code === 'Escape') settingsOpen.value = false
  if (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea')) return
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault()
  if (event.code === 'Space' && !event.repeat) flapQueued = true
  keys.add(event.code)
}

function keyUp(event: KeyboardEvent) { keys.delete(event.code) }

function flap() { resumeAudio(); flapQueued = true }

function startFiring() { resumeAudio(); pointerFiring = true; fireQueued = true }

function stopFiring() { pointerFiring = false }

/** Refills the pooled auto-fire target list, dropping peers whose wreck is still on the field. */
function refreshAutoFireTargets(remotes: RemoteFlight[]) {
  autoFireTargets.length = 0
  for (const remote of remotes) {
    if (remote.flight.health <= 0) continue
    let target = autoFireTargetPool[autoFireTargets.length]
    if (!target) {
      target = { x: 0, y: 0, z: 0 }
      autoFireTargetPool.push(target)
    }
    target.x = remote.flight.x
    target.y = remote.flight.y
    target.z = remote.flight.z
    autoFireTargets.push(target)
  }
}

function resetTuning() { Object.assign(tuning, flightConfig) }

function displayValue(field: TuningField) {
  const decimals = field.step.toString().split('.')[1]?.length ?? 0
  return tuning[field.key].toFixed(decimals)
}

function drawSkeleton(pose: Pose | null) {
  const canvas = skeleton.value
  const source = video.value
  if (!canvas || !source || !source.videoWidth || !source.videoHeight) return
  if (canvas.width !== source.videoWidth || canvas.height !== source.videoHeight) {
    canvas.width = source.videoWidth
    canvas.height = source.videoHeight
  }
  const context = canvas.getContext('2d')
  if (!context) return
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (!pose) return
  const points = new Map(pose.keypoints.filter((point) => (point.score ?? 0) >= 0.4).map((point) => [point.name, point]))
  const bones = [
    ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'], ['left_shoulder', 'left_hip'],
    ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'], ['left_hip', 'left_knee'],
    ['right_hip', 'right_knee'], ['left_knee', 'left_ankle'], ['right_knee', 'right_ankle'],
  ]
  context.strokeStyle = '#e7f4c4'
  context.lineWidth = Math.max(3, canvas.width / 120)
  context.lineCap = 'round'
  for (const [start, end] of bones) {
    const from = points.get(start)
    const to = points.get(end)
    if (!from || !to) continue
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }
  for (const point of points.values()) {
    context.beginPath()
    context.arc(point.x, point.y, Math.max(4, canvas.width / 100), 0, Math.PI * 2)
    context.fillStyle = '#eab56c'
    context.fill()
  }
}

function frame(now: number) {
  if (!running) return
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0.016
  lastFrame = now
  seconds.value += dt
  const tracked = cameraStatus.value === 'tracking' && now - lastPoseAt < 700
  const input: FlightControls = tracked
    ? { ...controls.value, flap: flapQueued, flapPower: now - lastPoseAt < 150 ? controls.value.flapPower : 0 }
    : { flap: flapQueued, steer: Number(keys.has('ArrowRight') || keys.has('KeyD')) - Number(keys.has('ArrowLeft') || keys.has('KeyA')), spread: keys.has('ArrowDown') || keys.has('KeyS') ? 0 : 1 }
  flapQueued = false
  const previousFlight = flight.value
  let next = stepFlight(previousFlight, input, dt, terrainHeight, tuning)
  // Hits are reported by shooters, but the victim owns its own health, so damage is applied here.
  const incoming = network?.takeDamage() ?? 0
  if (incoming > 0) next = applyHit(next, incoming * tuning.damagePerHit, tuning)
  let respawned = false
  if (next.dead && next.respawn <= 0) {
    next = respawnFlight(terrainHeight(courseSpawn.x, courseSpawn.z), courseSpawn)
    respawned = true
    // A rebuilt bird carries a full magazine.
    scene?.resetRounds()
  }
  flight.value = next
  course.value = respawned ? { nextRing: 0, laps: course.value.laps } : advanceCourse(course.value, previousFlight, next)
  liftOutput.value += ((input.flap ? 1 : Math.min(1, (input.flapPower ?? 0) / tuning.maxWingPower)) - liftOutput.value) * Math.min(1, dt * 12)
  const remotes = network?.remotes(now) ?? []
  nearbyPlayers.value = remotes.length
  const rtt = network?.latencyMs ?? null
  if (rtt !== latencyMs.value) latencyMs.value = rtt
  // Power-ups: report a fly-through once, then bank the rounds the server confirms. The server
  // owns the field, so a pickup only lands after it rebroadcasts the taken event to everyone.
  const powerups = network?.powerups() ?? []
  for (const powerup of powerups) {
    if (reportedPickups.has(powerup.slot) || !withinPickupRange(flight.value, powerup, powerupConfig.pickupRadius)) continue
    reportedPickups.add(powerup.slot)
    network?.reportPickup(powerup.slot)
  }
  // A slot that leaves the field may be collected again once it respawns somewhere else.
  for (const slot of reportedPickups) {
    if (!powerups.some((powerup) => powerup.slot === slot)) reportedPickups.delete(slot)
  }
  const collected = network?.takePickups() ?? []
  if (collected.length > 0) {
    scene?.addRounds(collected.length * weaponConfig.pickupRounds)
    audio?.pickup(flight.value)
  }
  ammoRounds.value = scene?.rounds() ?? ammoRounds.value
  // Body mode leaves no free hand for the trigger: open up while a live rival sits in the cone.
  // The cone follows the same head-aim offset the shot does, so the gate and the round agree.
  const liveHead = tracked && now - lastPoseAt < 200 ? headPose.value : null
  const aimHead = headAimOffset(liveHead)
  const autoFireActive = autoFireEnabled.value && tracked && flight.value.flying && !flight.value.dead
  if (autoFireActive) {
    refreshAutoFireTargets(remotes)
    const gate = updateAutoFire(autoFireLock, dt, flight.value, flight.value.yaw, autoFireTargets, {
      range: tuning.autoFireRange,
      halfAngle: (tuning.autoFireAngle * Math.PI) / 180,
      dwell: tuning.autoFireDwell,
      yawOffset: aimHead.yaw,
      pitchOffset: aimHead.pitch,
    })
    autoFireLock = gate.lock
    autoFireLocked.value = gate.locked
    autoFireFiring.value = gate.fire
  } else {
    autoFireLock = 0
    autoFireLocked.value = false
    autoFireFiring.value = false
  }
  // A dry magazine silences the local trigger, and with it the `fire` flag peers would replay.
  const firing = ammoRounds.value > 0 && (keys.has('KeyF') || fireQueued || pointerFiring || autoFireFiring.value)
  fireQueued = false
  if (ammoRounds.value <= 0) autoFireFiring.value = false
  // Wind and the listener both follow the bird, so the mix is always centred on the player.
  audio?.update(flight.value, flight.value.yaw, Math.hypot(flight.value.speed, flight.value.verticalSpeed))
  minimap?.draw(flight.value, remotes, powerups)
  const wings = scene?.render(flight.value, seconds.value, input, tracked ? wingPose.value : null, liveHead, course.value.nextRing, remotes, firing, reticleTint.value, powerups)
  network?.send(flight.value, input, wings ?? { left: 0, right: 0 }, now, firing)
  renderFrame = requestAnimationFrame(frame)
}

async function detectPose() {
  if (!detector || !video.value || !stream) return
  try {
    const poses = await detector.estimatePoses(video.value, { flipHorizontal: false })
    if (!stream) return
    latestPose = poses[0] ?? null
    drawSkeleton(latestPose)
    const input = latestPose && poseControls.update(latestPose, performance.now())
    if (input) {
      controls.value = input
      wingPose.value = { leftWing: input.leftWing, rightWing: input.rightWing }
      headPose.value = input.head
      lastPoseAt = performance.now()
      cameraStatus.value = 'tracking'
    } else {
      cameraStatus.value = 'lost'
      controls.value.flapPower = 0
      wingPose.value = null
      headPose.value = null
    }
  } catch {
    cameraStatus.value = 'lost'
  }
  if (stream) poseFrame = requestAnimationFrame(detectPose)
}

async function startCamera() {
  resumeAudio()
  if (cameraStatus.value === 'loading' || stream) return
  cameraStatus.value = 'loading'
  error.value = ''
  try {
    const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
    stream = media
    if (!video.value) throw new Error('Camera preview is unavailable')
    video.value.srcObject = media
    await video.value.play()
    const tf = await import('@tensorflow/tfjs-core')
    await import('@tensorflow/tfjs-backend-webgl')
    const poseDetection = await import('@tensorflow-models/pose-detection')
    await tf.setBackend('webgl')
    await tf.ready()
    detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
    })
    cameraStatus.value = 'lost'
    detectPose()
  } catch (cause) {
    stopCamera()
    error.value = cause instanceof Error ? cause.message : 'Unable to start camera'
  }
}

function stopCamera() {
  cancelAnimationFrame(poseFrame)
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  drawSkeleton(null)
  if (video.value) video.value.srcObject = null
  detector?.dispose()
  detector = null
  latestPose = null
  wingPose.value = null
  headPose.value = null
  controls.value = { flap: false, steer: 0, spread: 1 }
  cameraStatus.value = 'off'
}

function calibrate() { if (latestPose) poseControls.calibrate(latestPose) }

onMounted(() => {
  audio = createAudio()
  if (viewport.value) scene = createScene(viewport.value, {
    onHit: (victimId) => network?.reportHit(victimId),
    onShot: (origin) => audio?.shot(origin),
    onFlap: (position, intensity) => audio?.flap(position, intensity),
    onImpact: (position, energy) => audio?.impact(position, energy),
  })
  if (radar.value) minimap = createMinimap(radar.value)
  running = true
  renderFrame = requestAnimationFrame(frame)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('pointerdown', resumeAudio)
  window.addEventListener('pointerup', stopFiring)
  window.addEventListener('pointercancel', stopFiring)
  connectNetwork()
})

onBeforeUnmount(() => {
  running = false
  clearTimeout(reconnectTimer)
  network?.close()
  cancelAnimationFrame(renderFrame)
  stopCamera()
  audio?.dispose()
  audio = null
  minimap?.dispose()
  minimap = null
  scene?.dispose()
  window.removeEventListener('keydown', keyDown)
  window.removeEventListener('keyup', keyUp)
  window.removeEventListener('pointerdown', resumeAudio)
  window.removeEventListener('pointerup', stopFiring)
  window.removeEventListener('pointercancel', stopFiring)
})
</script>

<template>
  <main class="game">
    <div ref="viewport" class="viewport" aria-label="3D flight scene" @pointerdown="startFiring" />
    <div v-if="autoFireEnabled && cameraStatus === 'tracking'" class="autofire-lock"
      :class="{ locked: autoFireLocked, firing: autoFireFiring }" role="status">
      <Target :size="14" /> AUTO-FIRE · {{ autoFireStatus }}
    </div>
    <div class="grain" aria-hidden="true" />
    <header class="topbar">
      <div class="brand"><span class="brand-mark">F<span>·</span></span><span>FLAX <small>FLIGHT LAB</small></span>
      </div>
      <div class="flight-status"><span class="status-light" :class="{ active: flight.flying }" />{{ mode }} · {{
        networkStatus === 'CONNECTED' ? `${nearbyPlayers + 1} ONLINE · ` : networkStatus }}<span
          v-if="networkStatus === 'CONNECTED'" class="latency" :class="latencyClass">{{ latencyMs ?? '--' }} ms</span>
      </div>
      <div class="top-actions">
        <div class="top-readout health-readout" :class="{ low: healthPercent <= 30 }">
          <span>{{ flight.dead ? 'RESPAWN' : 'INTEGRITY' }}</span>
          <strong>{{ flight.dead ? flight.respawn.toFixed(1) : Math.round(flight.health) }}<small>{{ flight.dead ? 's' :
            '%' }}</small></strong>
        </div>
        <div class="top-readout ammo-readout" :class="{ low: ammoLow, empty: outOfAmmo }">
          <span>{{ outOfAmmo ? 'EMPTY' : 'AMMO' }}</span>
          <strong>{{ ammoRounds }}<small v-if="!outOfAmmo"> rds</small></strong>
        </div>
        <div class="top-readout altitude-readout"><span>ALTITUDE</span><strong>{{ altitude.toFixed(1) }}
            <small>m</small></strong></div>
        <button class="settings-toggle" type="button" title="Flight controls" aria-label="Flight controls"
          :aria-expanded="instructionsOpen" @click="instructionsOpen = !instructionsOpen">
          <Keyboard :size="19" />
        </button>
        <button class="settings-toggle" type="button" title="Flight settings" aria-label="Flight settings"
          :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
          <SlidersHorizontal :size="19" />
        </button>
      </div>
    </header>
    <section v-show="!settingsOpen" class="radar-panel" aria-label="Player radar">
      <div class="radar-head">
        <span>RADAR</span>
        <strong>{{ nearbyPlayers }}<small>{{ nearbyPlayers === 1 ? 'CONTACT' : 'CONTACTS' }}</small></strong>
      </div>
      <canvas ref="radar" class="radar-scope" role="img"
        :aria-label="`Radar: ${nearbyPlayers} nearby player${nearbyPlayers === 1 ? '' : 's'}`" />
      <div class="radar-legend">
        <span><i class="radar-dot level" />LEVEL</span>
        <span><i class="radar-dot above" />ABOVE</span>
        <span><i class="radar-dot below" />BELOW</span>
        <span><i class="radar-dot tank" />TANK</span>
        <span><i class="radar-dot powerup" />POWER-UP</span>
      </div>
    </section>
    <section class="dashboard" aria-label="Flight instruments">
      <div class="metric"><span>01 / AIRSPEED</span><strong>{{ Math.round(flight.speed * 3.6) }}<small>
            km/h</small></strong></div>
      <div class="metric"><span>02 / HEADING</span><strong>{{ ((flight.yaw * 180 / Math.PI + 360) % 360).toFixed(0)
      }}<small>°</small></strong></div>
      <div class="metric course-metric"><span>03 / COURSE</span><strong>{{ courseRings[course.nextRing]?.kind ===
        'checkpoint' ?
        `${course.nextRing} / ${courseRings.length - 2}` : courseRings[course.nextRing]?.kind?.toUpperCase() }}<small>
            · {{ course.laps }} {{ course.laps === 1 ? 'lap' : 'laps' }}</small></strong></div>
      <div class="charge">
        <span>{{ flight.flying ? 'LIFT OUTPUT' : 'TAKEOFF ENERGY' }}</span>
        <div class="charge-track">
          <div :style="{ width: `${(flight.flying ? liftOutput : flight.charge / tuning.takeoffCharge) * 100}%` }" />
        </div>
        <small>{{ flight.flying ? 'KEEP YOUR WINGS WIDE TO GLIDE' : 'FLAP TO TAKE OFF' }}</small>
      </div>
      <div class="charge integrity" :class="{ low: healthPercent <= 30 }">
        <span>{{ flight.dead ? `RESPAWN IN ${flight.respawn.toFixed(1)}s` : 'INTEGRITY' }}</span>
        <div class="charge-track">
          <div :style="{ width: `${healthPercent}%` }" />
        </div>
        <small>{{ flight.dead ? 'REBUILDING AIRFRAME' : flight.health < tuning.maxHealth ? 'TAKING FIRE — BREAK OFF'
          : 'AIRFRAME INTACT' }}</small>
      </div>
    </section>
    <div class="bottom-area">
      <section class="camera-panel" aria-label="Camera controls">
        <div class="preview" :class="{ enabled: cameraStatus !== 'off' }">
          <video ref="video" autoplay muted playsinline aria-label="Live webcam preview" />
          <canvas ref="skeleton" class="skeleton" aria-hidden="true" />
          <div v-if="cameraStatus === 'off'" class="preview-empty">
            <Camera :size="26" /><span>CAMERA OFF</span>
          </div>
          <span v-else class="tracking-label"><span class="status-light"
              :class="{ active: cameraStatus === 'tracking' }" />{{ cameraStatus === 'tracking' ? 'TRACKING' :
                cameraStatus === 'loading' ? 'LOADING MODEL' : 'FINDING POSE' }}</span>
        </div>
        <div class="camera-actions">
          <div><strong>BODY CONTROL</strong><small>{{ cameraStatus === 'off' ? 'KEYBOARD MODE ACTIVE' : cameraStatus ===
            'tracking' ? 'ARMS IN VIEW' : 'SHOW BOTH ARMS' }}</small></div>
          <button v-if="cameraStatus === 'off'" class="camera-button" type="button" title="Turn on camera"
            @click="startCamera">
            <Camera :size="17" /> START CAMERA
          </button>
          <div v-else class="camera-buttons">
            <button type="button" title="Calibrate neutral wing pose" :disabled="cameraStatus !== 'tracking'"
              @click="calibrate">
              <Crosshair :size="18" /><span class="sr-only">Calibrate</span>
            </button>
            <button class="autofire-toggle" type="button" :class="{ active: autoFireEnabled }"
              :aria-pressed="autoFireEnabled" :disabled="cameraStatus !== 'tracking'"
              title="Auto-fire while a rival is in the lock cone" @click="autoFireEnabled = !autoFireEnabled">
              <Target :size="18" /><span class="sr-only">Auto-fire</span>
            </button>
            <button type="button" title="Turn off camera" @click="stopCamera">
              <CameraOff :size="18" /><span class="sr-only">Turn off camera</span>
            </button>
          </div>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </section>
      <section v-if="instructionsOpen" class="instruction-panel" aria-label="Flight controls">
        <div class="instruction-heading">
          <Wind :size="18" /> <span>{{ cameraStatus === 'tracking' ? 'FLY WITH YOUR BODY' : 'FLY WITH YOUR KEYBOARD'
          }}</span>
        </div>
        <div class="instructions" v-if="cameraStatus === 'tracking'">
          <div><span>01</span> Raise & lower both arms <strong>FLAP</strong></div>
          <div><span>02</span> Hold wings level <strong>GLIDE</strong></div>
          <div><span>03</span> Tilt one wing <strong>STEER</strong></div>
          <div><span>04</span> Angle wings down <strong>DIVE</strong></div>
          <div><span>05</span> Aim at a rival <strong>AUTO-FIRE</strong></div>
        </div>
        <div class="instructions" v-else>
          <div><kbd>SPACE</kbd> Tap to flap <strong>TAKE OFF</strong></div>
          <div><kbd>←</kbd><kbd>→</kbd> or A / D <strong>STEER</strong></div>
          <div><kbd>↓</kbd> or S to angle wings down <strong>DIVE</strong></div>
          <div><kbd>F</kbd> or click the sky <strong>FIRE GUN</strong></div>
        </div>
        <div class="action-buttons">
          <button class="flap-button" type="button" title="Flap wings" @click="flap">
            <MoveUp :size="18" /> FLAP
          </button>
          <button class="fire-button" type="button" title="Fire gun" @pointerdown="startFiring" @pointerup="stopFiring"
            @pointerleave="stopFiring">
            <Crosshair :size="18" /> FIRE
          </button>
        </div>
      </section>
    </div>
    <aside v-if="settingsOpen" class="settings-panel" aria-label="Flight tuning">
      <div class="settings-header">
        <div><span>FLIGHT LAB / SETTINGS</span>
          <h2>Flight tuning</h2>
        </div>
        <button type="button" title="Close settings" aria-label="Close settings" @click="settingsOpen = false">
          <X :size="20" />
        </button>
      </div>
      <div class="settings-body">
        <details v-for="(group, index) in settingGroups" :key="group.title" class="settings-group" :open="index === 0">
          <summary>{{ group.title }} <span>{{ group.fields.length }}</span></summary>
          <div v-for="field in group.fields" :key="field.key" class="setting-row">
            <label :for="`setting-${field.key}`">{{ field.label }} <output :for="`setting-${field.key}`">{{
              displayValue(field) }}</output></label>
            <input :id="`setting-${field.key}`" v-model.number="tuning[field.key]" type="range" :min="field.min"
              :max="field.max" :step="field.step" />
          </div>
        </details>
      </div>
      <button class="settings-reset" type="button" @click="resetTuning">
        <RotateCcw :size="16" /> RESET DEFAULTS
      </button>
    </aside>
  </main>
</template>
