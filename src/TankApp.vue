<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Crosshair, Keyboard, RotateCcw, SlidersHorizontal, X } from 'lucide-vue-next'
import { createAudio, type FlightAudio } from './audio'
import { courseSpawn } from './course'
import { createMinimap } from './minimap'
import { FlightNetwork } from './network'
import { applyTankHit, respawnTank, stepTank, tankConfig, turretElevation as barrelElevation, wrapAngle, type TankConfig } from './tank'
import { createTankScene } from './tankScene'
import { tankWeaponConfig } from './tankWeapon'
import { terrainHeight } from './terrain'

const viewport = ref<HTMLElement | null>(null)
const radar = ref<HTMLCanvasElement | null>(null)
const tank = ref(respawnTank(terrainHeight(courseSpawn.x, courseSpawn.z), { x: courseSpawn.x, z: courseSpawn.z, hullYaw: courseSpawn.yaw }))
const networkStatus = ref('SOLO')
const nearbyPlayers = ref(0)
const latencyMs = ref<number | null>(null)
const settingsOpen = ref(false)
const instructionsOpen = ref(true)
const ammoRounds = ref(tankWeaponConfig.magazineSize)
const seconds = ref(0)
const tuning = reactive<TankConfig>({ ...tankConfig })

type TuningField = { key: keyof TankConfig; label: string; min: number; max: number; step: number }
const settingGroups: { title: string; fields: TuningField[] }[] = [
    {
        title: 'Driving', fields: [
            { key: 'maxSpeed', label: 'Top speed', min: 4, max: 30, step: 0.5 },
            { key: 'maxReverseSpeed', label: 'Reverse speed', min: 1, max: 12, step: 0.5 },
            { key: 'accel', label: 'Acceleration', min: 0.4, max: 8, step: 0.1 },
            { key: 'brake', label: 'Braking', min: 0.2, max: 6, step: 0.1 },
            { key: 'turnRate', label: 'Turn rate', min: 0.1, max: 3, step: 0.05 },
            { key: 'turnSpeedRef', label: 'Turn ramp speed', min: 1, max: 12, step: 0.5 },
        ]
    },
    {
        title: 'Turret & terrain', fields: [
            { key: 'turretSlewRate', label: 'Traverse rate', min: 0.2, max: 6, step: 0.1 },
            { key: 'turretPitchMin', label: 'Min elevation', min: -0.6, max: 0, step: 0.02 },
            { key: 'turretPitchMax', label: 'Max elevation', min: 0.2, max: 1.5, step: 0.02 },
            { key: 'slopeResponse', label: 'Slope response', min: 0.5, max: 20, step: 0.5 },
            { key: 'maxSlope', label: 'Max slope', min: 0.1, max: 1.4, step: 0.02 },
        ]
    },
    {
        title: 'Combat', fields: [
            { key: 'maxHealth', label: 'Max health', min: 25, max: 100, step: 5 },
            { key: 'damagePerHit', label: 'Damage per hit', min: 5, max: 100, step: 5 },
            { key: 'respawnDelay', label: 'Respawn delay', min: 0.5, max: 10, step: 0.5 },
        ]
    },
]
const AMMO_LOW = 15
const KEY_TRAVERSE_RATE = 1.1
/** How far the turret traverses either side of the view when the cursor sits at a screen edge. */
const AIM_TRAVERSE = Math.PI / 2
/** Barrel elevation with the cursor at the middle of the screen, in radians (about 25°, up at the sky). */
const AIM_ELEVATION_CENTRE = 0.44
/** How much a full screen height adds to or removes from that, before the config clamps it. */
const AIM_ELEVATION_SPAN = 1

const mode = computed(() => tank.value.dead ? 'ELIMINATED' : tank.value.speed === 0 ? 'HOLDING' : 'ROLLING')
const healthPercent = computed(() => Math.max(0, Math.min(100, (tank.value.health / tuning.maxHealth) * 100)))
const ammoLow = computed(() => ammoRounds.value > 0 && ammoRounds.value <= AMMO_LOW)
const outOfAmmo = computed(() => ammoRounds.value <= 0)
const latencyClass = computed(() => latencyMs.value === null ? '' : latencyMs.value > 250 ? 'latency-bad' : latencyMs.value > 120 ? 'latency-warn' : '')
const turretBearing = computed(() => ((wrapAngle(tank.value.hullYaw + tank.value.turretYaw) * 180 / Math.PI + 360) % 360))
const turretElevation = computed(() => (barrelElevation(tank.value) * 180 / Math.PI))
/**
 * Aim is a pure function of where the cursor sits in the viewport, quoted relative to the chase
 * camera: horizontal position spans `AIM_TRAVERSE` either side of the view, vertical position spans
 * the barrel's elevation range. Because the camera follows the hull, turning the tank carries the
 * turret round with the view instead of swinging the aim across the screen.
 *
 * Nothing is accumulated and there is no baseline to keep in step, which is the point: leaving the
 * window and returning can only ever put the aim where the cursor now is. An earlier version summed
 * per-event deltas, and a single event measured from a stale baseline sent the turret somewhere the
 * player never pointed at.
 */
const cursorX = ref(0.5)
const cursorY = ref(0.5)
/** Keyboard aiming, added on top of the cursor so both inputs drive one aim. */
const aimYawBias = ref(0)
const aimPitchBias = ref(0)

const keys = new Set<string>()
let pointerFiring = false
let fireQueued = false
let renderFrame = 0
let lastFrame = 0
let scene: ReturnType<typeof createTankScene> | null = null
let minimap: ReturnType<typeof createMinimap> | null = null
let audio: FlightAudio | null = null
let running = false
let network: FlightNetwork | null = null
let reconnectTimer = 0

function clampElevation(radians: number) {
    return Math.max(tuning.turretPitchMin, Math.min(tuning.turretPitchMax, radians))
}

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

function resumeAudio() { void audio?.resume() }

function keyDown(event: KeyboardEvent) {
    resumeAudio()
    if (event.code === 'Escape') settingsOpen.value = false
    if (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea')) return
    if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault()
    if (event.code === 'Space' && !event.repeat) fireQueued = true
    keys.add(event.code)
}

function keyUp(event: KeyboardEvent) { keys.delete(event.code) }

/**
 * The turret follows the cursor's position in the viewport directly. Nothing is remembered between
 * events, so a move that arrives after the pointer left the window simply places the turret where the
 * cursor now is instead of measuring against a position from the other side of the screen.
 */
function pointerMove(event: PointerEvent) {
    const rect = viewport.value?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return
    cursorX.value = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    cursorY.value = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
}

/** Firing takes the cursor position too, so the first shot of a click lands where the click was. */
function pointerDown(event: PointerEvent) {
    pointerMove(event)
    startFiring()
}

function startFiring() { resumeAudio(); pointerFiring = true; fireQueued = true }
function stopFiring() { pointerFiring = false }

function resetTuning() { Object.assign(tuning, tankConfig) }

function displayValue(field: TuningField) {
    const decimals = field.step.toString().split('.')[1]?.length ?? 0
    return tuning[field.key].toFixed(decimals)
}

function frame(now: number) {
    if (!running) return
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 0.016
    lastFrame = now
    seconds.value += dt
    // Keyboard fallback for the turret: its own bias on top of the cursor, so both drive one aim.
    if (keys.has('KeyQ')) aimYawBias.value = Math.max(-Math.PI, aimYawBias.value - KEY_TRAVERSE_RATE * dt)
    if (keys.has('KeyE')) aimYawBias.value = Math.min(Math.PI, aimYawBias.value + KEY_TRAVERSE_RATE * dt)
    if (keys.has('KeyR')) aimPitchBias.value = Math.min(1.5, aimPitchBias.value + KEY_TRAVERSE_RATE * dt)
    if (keys.has('KeyF')) aimPitchBias.value = Math.max(-1.5, aimPitchBias.value - KEY_TRAVERSE_RATE * dt)
    const throttle = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'))
    const steer = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'))
    // The bearing is quoted from the camera's heading, so turning the hull carries the turret round
    // with the view and the aim stays where the player put it.
    const cameraYaw = scene?.cameraYaw() ?? tank.value.hullYaw
    const bearing = wrapAngle(cameraYaw + (cursorX.value - 0.5) * 2 * AIM_TRAVERSE + aimYawBias.value)
    const elevation = clampElevation(AIM_ELEVATION_CENTRE + (0.5 - cursorY.value) * 2 * AIM_ELEVATION_SPAN + aimPitchBias.value)
    let next = stepTank(tank.value, {
        throttle,
        steer,
        turretBearing: bearing,
        turretPitch: elevation,
    }, dt, terrainHeight, tuning)
    // Hits are reported by shooters, but the victim owns its own health, so damage lands here.
    const incoming = network?.takeDamage() ?? 0
    if (incoming > 0) next = applyTankHit(next, incoming * tuning.damagePerHit, tuning)
    if (next.dead && next.respawn <= 0) {
        next = respawnTank(terrainHeight(courseSpawn.x, courseSpawn.z), { x: courseSpawn.x, z: courseSpawn.z, hullYaw: courseSpawn.yaw }, tuning)
        scene?.resetRounds()
    }
    tank.value = next
    const remotes = network?.remotes(now) ?? []
    nearbyPlayers.value = remotes.length
    const rtt = network?.latencyMs ?? null
    if (rtt !== latencyMs.value) latencyMs.value = rtt
    ammoRounds.value = scene?.rounds() ?? ammoRounds.value
    // A dry magazine silences the trigger, and with it the `fire` flag peers would replay.
    const firing = ammoRounds.value > 0 && (fireQueued || pointerFiring || keys.has('Space'))
    fireQueued = false
    const powerups = network?.powerups() ?? []
    audio?.update(next, next.hullYaw, Math.abs(next.speed))
    minimap?.draw({ x: next.x, y: next.y, z: next.z, yaw: next.hullYaw }, remotes, powerups)
    scene?.render(next, seconds.value, -1, remotes, firing, firing ? 'firing' : 'off', powerups)
    network?.sendTank(next, now, firing)
    renderFrame = requestAnimationFrame(frame)
}

onMounted(() => {
    audio = createAudio()
    if (viewport.value) scene = createTankScene(viewport.value, {
        onHit: (victimId) => network?.reportHit(victimId),
        onShot: (origin) => audio?.shot(origin),
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
        <div ref="viewport" class="viewport" aria-label="3D tank scene" @pointermove="pointerMove"
            @pointerdown="pointerDown" />
        <div class="grain" aria-hidden="true" />
        <header class="topbar">
            <div class="brand"><span class="brand-mark">F<span>·</span></span><span>FLAX <small>ARMOR
                        DIVISION</small></span>
            </div>
            <div class="flight-status"><span class="status-light" :class="{ active: !tank.dead }" />{{ mode }} · {{
                networkStatus === 'CONNECTED' ? `${nearbyPlayers + 1} ONLINE · ` : networkStatus }}<span
                    v-if="networkStatus === 'CONNECTED'" class="latency" :class="latencyClass">{{ latencyMs ?? '--' }}
                    ms</span>
            </div>
            <div class="top-actions">
                <div class="top-readout health-readout" :class="{ low: healthPercent <= 30 }">
                    <span>{{ tank.dead ? 'RESPAWN' : 'INTEGRITY' }}</span>
                    <strong>{{ tank.dead ? tank.respawn.toFixed(1) : Math.round(tank.health) }}<small>{{ tank.dead ? 's'
                        :
                        '%' }}</small></strong>
                </div>
                <div class="top-readout ammo-readout" :class="{ low: ammoLow, empty: outOfAmmo }">
                    <span>{{ outOfAmmo ? 'EMPTY' : 'AMMO' }}</span>
                    <strong>{{ ammoRounds }}<small v-if="!outOfAmmo"> rds</small></strong>
                </div>
                <div class="top-readout altitude-readout"><span>SPEED</span><strong>{{ (Math.abs(tank.speed) *
                    3.6).toFixed(0) }}
                        <small>km/h</small></strong></div>
                <button class="settings-toggle" type="button" title="Tank controls" aria-label="Tank controls"
                    :aria-expanded="instructionsOpen" @click="instructionsOpen = !instructionsOpen">
                    <Keyboard :size="19" />
                </button>
                <button class="settings-toggle" type="button" title="Tank settings" aria-label="Tank settings"
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
        <section class="dashboard" aria-label="Tank instruments">
            <div class="metric"><span>01 / GROUND SPEED</span><strong>{{ Math.round(Math.abs(tank.speed) * 3.6)
            }}<small>
                        km/h</small></strong></div>
            <div class="metric"><span>02 / HULL HEADING</span><strong>{{ ((tank.hullYaw * 180 / Math.PI + 360) %
                360).toFixed(0)
                    }}<small>°</small></strong></div>
            <div class="metric"><span>03 / TURRET</span><strong>{{ turretBearing.toFixed(0) }}<small>° · {{
                turretElevation.toFixed(0) }}° elev</small></strong></div>
            <div class="charge integrity" :class="{ low: healthPercent <= 30 }">
                <span>{{ tank.dead ? `RESPAWN IN ${tank.respawn.toFixed(1)}s` : 'INTEGRITY' }}</span>
                <div class="charge-track">
                    <div :style="{ width: `${healthPercent}%` }" />
                </div>
                <small>{{ tank.dead ? 'REBUILDING HULL' : tank.health < tuning.maxHealth ? 'TAKING FIRE — MANEUVER'
                    : 'ARMOUR INTACT' }}</small>
            </div>
        </section>
        <div class="bottom-area">
            <section v-if="instructionsOpen" class="instruction-panel" aria-label="Tank controls">
                <div class="instruction-heading">
                    <Crosshair :size="18" /> <span>DRIVE THE HULL, AIM THE TURRET</span>
                </div>
                <div class="instructions">
                    <div><kbd>W</kbd><kbd>S</kbd> or <kbd>↑</kbd><kbd>↓</kbd> <strong>THROTTLE / REVERSE</strong></div>
                    <div><kbd>A</kbd><kbd>D</kbd> or <kbd>←</kbd><kbd>→</kbd> <strong>STEER HULL</strong></div>
                    <div><span>MOUSE</span> Move across the sky <strong>TRAVERSE TURRET</strong></div>
                    <div><kbd>Q</kbd><kbd>E</kbd> bearing · <kbd>R</kbd><kbd>F</kbd> elevation <strong>KEYBOARD
                            AIM</strong></div>
                    <div><kbd>SPACE</kbd> or click the sky <strong>FIRE GUN</strong></div>
                </div>
                <div class="action-buttons">
                    <button class="fire-button" type="button" title="Fire gun" @pointerdown="startFiring"
                        @pointerup="stopFiring" @pointerleave="stopFiring">
                        <Crosshair :size="18" /> FIRE
                    </button>
                </div>
            </section>
        </div>
        <aside v-if="settingsOpen" class="settings-panel" aria-label="Tank tuning">
            <div class="settings-header">
                <div><span>FLAX ARMOR / SETTINGS</span>
                    <h2>Tank tuning</h2>
                </div>
                <button type="button" title="Close settings" aria-label="Close settings" @click="settingsOpen = false">
                    <X :size="20" />
                </button>
            </div>
            <div class="settings-body">
                <details v-for="(group, index) in settingGroups" :key="group.title" class="settings-group"
                    :open="index === 0">
                    <summary>{{ group.title }} <span>{{ group.fields.length }}</span></summary>
                    <div v-for="field in group.fields" :key="field.key" class="setting-row">
                        <label :for="`setting-${field.key}`">{{ field.label }} <output :for="`setting-${field.key}`">{{
                            displayValue(field) }}</output></label>
                        <input :id="`setting-${field.key}`" v-model.number="tuning[field.key]" type="range"
                            :min="field.min" :max="field.max" :step="field.step" />
                    </div>
                </details>
            </div>
            <button class="settings-reset" type="button" @click="resetTuning">
                <RotateCcw :size="16" /> RESET DEFAULTS
            </button>
        </aside>
    </main>
</template>
