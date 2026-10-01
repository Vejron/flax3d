<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Camera, CameraOff, Crosshair, MoveUp, RotateCcw, SlidersHorizontal, Wind, X } from 'lucide-vue-next'
import type { Pose, PoseDetector } from '@tensorflow-models/pose-detection'
import { advanceCourse, courseRings, type CourseProgress } from './course'
import { flightConfig, initialFlightState, stepFlight, type FlightConfig, type FlightControls } from './flight'
import { PoseControls } from './poseControls'
import { createScene, terrainHeight } from './scene'

const viewport = ref<HTMLElement | null>(null)
const video = ref<HTMLVideoElement | null>(null)
const skeleton = ref<HTMLCanvasElement | null>(null)
const flight = ref(initialFlightState(terrainHeight(0, 0)))
const course = ref<CourseProgress>({ nextRing: 0, laps: 0 })
const cameraStatus = ref<'off' | 'loading' | 'tracking' | 'lost'>('off')
const error = ref('')
const controls = ref<FlightControls>({ flap: false, steer: 0, spread: 1 })
const liftOutput = ref(0)
const settingsOpen = ref(false)
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
]
const wingPose = ref<{ leftWing: number; rightWing: number } | null>(null)
const headPose = ref<{ yaw: number; tilt: number } | null>(null)
const seconds = ref(0)
const mode = computed(() => flight.value.flying ? 'IN FLIGHT' : 'ON THE GROUND')
const altitude = computed(() => Math.max(0, flight.value.y - terrainHeight(flight.value.x, flight.value.z)))
const poseControls = new PoseControls()
const keys = new Set<string>()
let stream: MediaStream | null = null
let detector: PoseDetector | null = null
let latestPose: Pose | null = null
let lastPoseAt = 0
let flapQueued = false
let renderFrame = 0
let poseFrame = 0
let lastFrame = 0
let scene: ReturnType<typeof createScene> | null = null
let running = false

function keyDown(event: KeyboardEvent) {
  if (event.code === 'Escape') settingsOpen.value = false
  if (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea')) return
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault()
  if (event.code === 'Space' && !event.repeat) flapQueued = true
  keys.add(event.code)
}

function keyUp(event: KeyboardEvent) { keys.delete(event.code) }

function flap() { flapQueued = true }

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
  flight.value = stepFlight(previousFlight, input, dt, terrainHeight, tuning)
  course.value = advanceCourse(course.value, previousFlight, flight.value)
  liftOutput.value += ((input.flap ? 1 : Math.min(1, (input.flapPower ?? 0) / tuning.maxWingPower)) - liftOutput.value) * Math.min(1, dt * 12)
  scene?.render(flight.value, seconds.value, input, tracked ? wingPose.value : null, tracked && now - lastPoseAt < 200 ? headPose.value : null, course.value.nextRing)
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
  if (viewport.value) scene = createScene(viewport.value)
  running = true
  renderFrame = requestAnimationFrame(frame)
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
})

onBeforeUnmount(() => {
  running = false
  cancelAnimationFrame(renderFrame)
  stopCamera()
  scene?.dispose()
  window.removeEventListener('keydown', keyDown)
  window.removeEventListener('keyup', keyUp)
})
</script>

<template>
  <main class="game">
    <div ref="viewport" class="viewport" aria-label="3D flight scene" />
    <div class="grain" aria-hidden="true" />
    <header class="topbar">
      <div class="brand"><span class="brand-mark">F<span>·</span></span><span>FLAX <small>FLIGHT LAB</small></span>
      </div>
      <div class="flight-status"><span class="status-light" :class="{ active: flight.flying }" />{{ mode }}</div>
      <div class="top-actions">
        <div class="top-readout"><span>ALTITUDE</span><strong>{{ altitude.toFixed(1) }} <small>m</small></strong></div>
        <button class="settings-toggle" type="button" title="Flight settings" aria-label="Flight settings"
          :aria-expanded="settingsOpen" @click="settingsOpen = !settingsOpen">
          <SlidersHorizontal :size="19" />
        </button>
      </div>
    </header>
    <div class="horizon-label" aria-hidden="true"><span>▲</span> OPEN SKY</div>
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
            <button type="button" title="Turn off camera" @click="stopCamera">
              <CameraOff :size="18" /><span class="sr-only">Turn off camera</span>
            </button>
          </div>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </section>
      <section class="instruction-panel" aria-label="Flight controls">
        <div class="instruction-heading">
          <Wind :size="18" /> <span>{{ cameraStatus === 'tracking' ? 'FLY WITH YOUR BODY' : 'FLY WITH YOUR KEYBOARD'
          }}</span>
        </div>
        <div class="instructions" v-if="cameraStatus === 'tracking'">
          <div><span>01</span> Raise & lower both arms <strong>FLAP</strong></div>
          <div><span>02</span> Hold wings level <strong>GLIDE</strong></div>
          <div><span>03</span> Tilt one wing <strong>STEER</strong></div>
          <div><span>04</span> Angle wings down <strong>DIVE</strong></div>
        </div>
        <div class="instructions" v-else>
          <div><kbd>SPACE</kbd> Tap to flap <strong>TAKE OFF</strong></div>
          <div><kbd>←</kbd><kbd>→</kbd> or A / D <strong>STEER</strong></div>
          <div><kbd>↓</kbd> or S to angle wings down <strong>DIVE</strong></div>
        </div>
        <button class="flap-button" type="button" title="Flap wings" @click="flap">
          <MoveUp :size="18" /> FLAP
        </button>
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

<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');

:root {
  font-family: 'DM Sans', sans-serif;
  color: #f7f7ed;
  background: #547767;
  font-synthesis: none;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

button {
  font: inherit;
  cursor: pointer;
}

button:disabled {
  opacity: .45;
  cursor: not-allowed;
}

.game {
  position: relative;
  width: 100%;
  min-height: 620px;
  height: 100dvh;
  overflow: hidden;
  background: #9ec5ad;
}

.viewport,
.viewport canvas,
.grain {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.grain {
  pointer-events: none;
  opacity: .14;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.22'/%3E%3C/svg%3E");
}

.topbar {
  position: absolute;
  inset: 0 0 auto;
  padding: 27px 34px;
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 18px;
  background: linear-gradient(180deg, #18382e99, transparent);
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  font: 700 20px 'Space Grotesk', sans-serif;
}

.brand small {
  display: block;
  margin-top: 5px;
  font: 600 9px 'DM Sans', sans-serif;
  letter-spacing: 2px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border: 2px solid #f7f7ed;
  font-size: 29px;
}

.brand-mark span {
  color: #efb669;
}

.flight-status {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 10px 14px;
  border: 1px solid #f7f7ed88;
  background: #203c34a8;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.2px;
}

.top-actions {
  display: flex;
  align-items: start;
  gap: 15px;
}

.settings-toggle,
.settings-header button {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: 1px solid #f7f7ed88;
  background: #203c34a8;
  color: #f7f7ed;
}

.settings-panel {
  position: absolute;
  z-index: 5;
  right: 18px;
  top: 83px;
  bottom: 18px;
  display: flex;
  flex-direction: column;
  width: min(350px, calc(100% - 36px));
  color: #233d32;
  background: #f5f2e5;
  border: 1px solid #fff9;
  box-shadow: 0 15px 40px #17352b55;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  gap: 15px;
  align-items: start;
  padding: 19px 19px 15px;
  border-bottom: 1px solid #c2d0c1;
}

.settings-header span {
  color: #9d623e;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.4px;
}

.settings-header h2 {
  margin: 5px 0 0;
  font: 600 21px 'Space Grotesk', sans-serif;
}

.settings-header button {
  width: 30px;
  height: 30px;
  border-color: #b8cbb9;
  color: #233d32;
  background: transparent;
}

.settings-body {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 19px;
}

.settings-group {
  border-bottom: 1px solid #c2d0c1;
}

.settings-group summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  font: 700 11px 'DM Sans', sans-serif;
  letter-spacing: .5px;
  cursor: pointer;
  list-style: none;
}

.settings-group summary::-webkit-details-marker {
  display: none;
}

.settings-group summary span {
  color: #a35f3b;
  font-size: 10px;
}

.settings-group[open] summary {
  padding-bottom: 10px;
}

.setting-row {
  padding: 8px 0 12px;
}

.setting-row label {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 11px;
  font-weight: 600;
}

.setting-row output {
  font: 700 11px 'Space Grotesk', sans-serif;
  color: #ac6440;
}

.setting-row input {
  display: block;
  width: 100%;
  margin: 9px 0 0;
  accent-color: #cd6748;
  cursor: pointer;
}

.settings-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 47px;
  flex: none;
  border: 0;
  border-top: 1px solid #c2d0c1;
  background: #e8eddf;
  color: #233d32;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
}

.status-light {
  display: inline-block;
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #efa968;
}

.status-light.active {
  background: #adf0a6;
  box-shadow: 0 0 10px #adf0a6;
}

.top-readout {
  min-width: 116px;
  text-align: right;
}

.top-readout span,
.metric span,
.charge>span {
  display: block;
  font: 700 10px 'DM Sans', sans-serif;
  letter-spacing: 1.5px;
}

.top-readout strong {
  display: block;
  font: 600 27px 'Space Grotesk', sans-serif;
}

.top-readout strong small,
.metric strong small {
  font-size: 12px;
  font-weight: 500;
}

.horizon-label {
  position: absolute;
  top: 28%;
  left: 50%;
  transform: translateX(-50%);
  color: #315a49;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 2px;
  white-space: nowrap;
  opacity: .7;
}

.horizon-label span {
  display: block;
  text-align: center;
  font-size: 15px;
}

.dashboard {
  position: absolute;
  left: 34px;
  top: 25%;
  width: 191px;
  padding: 18px 20px;
  background: #16382ee0;
  border: 1px solid #d9f1dc55;
  backdrop-filter: blur(12px);
}

.metric {
  margin-bottom: 21px;
}

.metric span,
.charge>span {
  color: #b6d6be;
}

.metric strong {
  display: block;
  margin-top: 3px;
  font: 600 36px 'Space Grotesk', sans-serif;
  line-height: 1.1;
}

.course-metric strong small {
  display: block;
  margin-top: 4px;
}

.charge {
  border-top: 1px solid #ffffff44;
  padding-top: 17px;
}

.charge-track {
  margin: 12px 0 7px;
  height: 6px;
  background: #739482;
}

.charge-track>div {
  height: 100%;
  background: #eab56c;
  transition: width .2s;
}

.charge small {
  font-size: 8px;
  font-weight: 700;
  letter-spacing: .6px;
  color: #c9e0ca;
}

.bottom-area {
  position: absolute;
  bottom: 28px;
  left: 34px;
  right: 34px;
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 20px;
  pointer-events: none;
}

.bottom-area>* {
  pointer-events: auto;
}

.camera-panel {
  width: 255px;
  background: #18382fee;
  border: 1px solid #bed7be77;
}

.preview {
  height: 140px;
  position: relative;
  background: #244538;
  overflow: hidden;
}

.preview video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.skeleton {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
  pointer-events: none;
}

.preview-empty {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 7px;
  color: #a5c5aa;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.6px;
}

.preview:not(.enabled) video {
  display: none;
}

.tracking-label {
  position: absolute;
  bottom: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  background: #1b372dd9;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
}

.camera-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  padding: 13px 12px;
}

.camera-actions strong,
.camera-actions small {
  display: block;
  white-space: nowrap;
}

.camera-actions strong {
  font-size: 10px;
  letter-spacing: 1px;
}

.camera-actions small {
  margin-top: 4px;
  color: #b3d3b8;
  font-size: 8px;
  letter-spacing: .5px;
}

.camera-button,
.camera-buttons button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: #ebba77;
  border: 0;
  color: #2b362e;
  font-size: 9px;
  font-weight: 700;
  white-space: nowrap;
}

.camera-button {
  padding: 10px;
}

.camera-buttons {
  display: flex;
  gap: 5px;
}

.camera-buttons button {
  width: 32px;
  height: 32px;
}

.error {
  margin: 0;
  padding: 0 12px 12px;
  font-size: 11px;
  color: #f7baab;
}

.instruction-panel {
  min-width: 285px;
  max-width: 370px;
  padding: 18px 21px 17px;
  color: #233d32;
  background: #f5f2e5ef;
  border: 1px solid #fff9;
  backdrop-filter: blur(12px);
}

.instruction-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 13px;
  border-bottom: 1px solid #b5c7b8;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
}

.instructions {
  padding: 11px 0 5px;
}

.instructions>div {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 29px;
  font-size: 11px;
}

.instructions span {
  color: #bf774e;
  font-size: 10px;
  font-weight: 700;
}

.instructions strong {
  margin-left: auto;
  color: #a35f3b;
  font-size: 9px;
  letter-spacing: .6px;
}

kbd {
  display: inline-grid;
  place-items: center;
  min-width: 25px;
  padding: 4px;
  background: #dfe5d9;
  border: 1px solid #bbcbb9;
  font: 700 10px 'DM Sans', sans-serif;
}

.flap-button {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 36px;
  margin-top: 7px;
  border: 0;
  background: #cd6748;
  color: #fff9ea;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
}

button:hover:not(:disabled) {
  filter: brightness(1.09);
}

button:focus-visible {
  outline: 3px solid #eab56c;
  outline-offset: 2px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 700px) {
  .game {
    min-height: 560px;
  }

  .topbar {
    padding: 16px;
    align-items: center;
  }

  .brand {
    font-size: 16px;
  }

  .brand-mark {
    width: 34px;
    height: 34px;
    font-size: 24px;
  }

  .brand small {
    font-size: 7px;
  }

  .flight-status {
    display: none;
  }

  .top-readout {
    min-width: 82px;
  }

  .top-actions {
    align-items: center;
    gap: 9px;
  }

  .settings-toggle {
    width: 34px;
    height: 34px;
  }

  .settings-panel {
    top: 65px;
    right: 8px;
    bottom: 8px;
    width: min(350px, calc(100% - 16px));
  }

  .top-readout strong {
    font-size: 21px;
  }

  .dashboard {
    top: 18%;
    left: 16px;
    width: 133px;
    padding: 12px;
  }

  .metric {
    margin-bottom: 10px;
  }

  .metric strong {
    font-size: 25px;
  }

  .charge {
    padding-top: 10px;
  }

  .charge small {
    display: none;
  }

  .bottom-area {
    left: 12px;
    right: 12px;
    bottom: 12px;
    align-items: stretch;
    flex-direction: column;
    gap: 7px;
  }

  .camera-panel {
    width: 100%;
    display: flex;
    min-height: 72px;
  }

  .preview {
    width: 96px;
    height: auto;
    flex: none;
  }

  .preview-empty span,
  .tracking-label {
    font-size: 7px;
  }

  .tracking-label {
    left: 2px;
    bottom: 4px;
    padding: 3px;
  }

  .camera-actions {
    width: 100%;
  }

  .instruction-panel {
    min-width: 0;
    max-width: none;
    padding: 10px 13px;
  }

  .instruction-heading {
    padding-bottom: 6px;
  }

  .instructions {
    padding: 5px 0;
  }

  .instructions>div {
    min-height: 25px;
  }

  .flap-button {
    margin-top: 4px;
  }
}
</style>
