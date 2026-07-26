import * as THREE from 'three'
import type { Bus, SimState } from '../core/types'
import { clamp, clamp01, damp, easeInOutCubic } from '../core/util'
import { CITY } from '../world/layout'
import type { AudioApi, Gait, Surface } from './audio'
import { createMoveResult } from './collision'
import type { CollisionWorld, MoveResult } from './collision'

/* ============================================================================
 * THE PEDESTRIAN
 *
 * Orbit shows you the city. Fly shows you the city faster. Neither of them can
 * teach you what it is like to be 1.7 m tall inside shared_buffers while the
 * clock sweep goes past overhead. This is the third camera: a body.
 *
 * It is a kinematic capsule, not a physics object. Horizontal velocity chases a
 * target velocity at a fixed acceleration — 28 m/s² on the ground so a change
 * of direction is instant, 5 m/s² in the air so a jump is a decision you commit
 * to. Vertical motion is one number and a gravity of 22 m/s², which is more
 * than Earth on purpose: at 9.8 a first-person jump hangs like the Moon.
 *
 * Head bob is driven by DISTANCE TRAVELLED, not by time. That single choice is
 * why it stops dead when you stop, why it slows down when you edge sideways
 * along a railing, and why running does not look like walking played fast.
 *
 * Nothing here allocates per frame. Everything mutable is hoisted.
 * ==========================================================================*/

export interface WalkOptions {
  camera: THREE.PerspectiveCamera
  /** Element that owns pointer lock — the renderer's canvas. */
  dom: HTMLElement
  collision: CollisionWorld
  audio: AudioApi
  sim: SimState
  bus: Bus
  /** Overrides for any of the feel numbers. */
  tuning?: Partial<WalkTuning>
  /** Where the fade overlay is attached. Defaults to document.body. */
  overlayRoot?: HTMLElement
}

export interface WalkTuning {
  eyeStand: number
  eyeCrouch: number
  capsuleRadius: number
  capsuleHeight: number
  capsuleHeightCrouch: number
  stepHeight: number
  speedWalk: number
  speedRun: number
  speedCrouch: number
  accelGround: number
  accelAir: number
  gravity: number
  jumpHeight: number
  lookSensitivity: number
  /** Touch look sensitivity in degrees per centimetre of finger travel. */
  touchLookSensitivity: number
  pitchLimit: number
  bobAmplitude: number
  /** Metres of travel per full bob cycle. */
  bobWavelength: number
  /** Longest drop-in flight, in seconds. A short drop takes proportionally less. */
  descentDuration: number
}

/** What exit() hands back to the camera rig. */
export interface WalkExitView {
  position: [number, number, number]
  target: [number, number, number]
}

export interface WalkController {
  readonly enabled: boolean
  /** Drop into the city. Resolves when the descent finishes. */
  enter(from?: THREE.Vector3): Promise<void>
  /** Stand back up. Returns a vantage point for the camera rig. */
  exit(): WalkExitView
  update(dt: number): void
  readonly grounded: boolean
  readonly gait: Gait
  readonly submerged: boolean
  readonly surface: Surface
  /** Horizontal speed, m/s. */
  readonly speed: number
  /** Cumulative horizontal body travel, in metres. */
  readonly distance: number
  /** Live feet position. Do not mutate. */
  readonly position: THREE.Vector3
  /** Analogue touch movement: both axes are in the range -1..1. */
  setTouchMove(strafe: number, forward: number): void
  /** Relative touch look travel measured in CSS centimetres. */
  addTouchLook(xCm: number, yCm: number): void
  /** Press/release. Holding this while swimming rises toward the surface. */
  setTouchJump(pressed: boolean): void
  /** Touch stance. The UI toggles this on land and holds it to dive. */
  setTouchCrouch(pressed: boolean): void
  dispose(): void
}

/* --------------------------------------------------------------------------
 * Feel. Every number here was tuned by walking around, not derived.
 * ------------------------------------------------------------------------*/

const DEFAULT_TUNING: WalkTuning = {
  eyeStand: 1.7,
  eyeCrouch: 1.1,
  capsuleRadius: 0.35,
  capsuleHeight: 1.8,
  capsuleHeightCrouch: 1.25,
  stepHeight: 0.45,
  speedWalk: 2.4,
  speedRun: 6.5,
  speedCrouch: 1.1,
  accelGround: 28,
  accelAir: 5,
  gravity: 22,
  jumpHeight: 0.9,
  lookSensitivity: 0.0022,
  touchLookSensitivity: 18,
  pitchLimit: 1.4835, // 85°
  bobAmplitude: 0.035,
  bobWavelength: 1.55,
  descentDuration: 0.9,
}

/** How far the ground may drop away under a grounded walker before they fall. */
const GROUND_SNAP = 0.55
/** …and how close a falling walker must be to a surface to land on it. */
const AIR_SNAP = 0.08
/**
 * How far ABOVE the feet a grounded walker still accepts a surface. A ramp
 * rises into you as you walk up it, so without this you walk *at* the slope
 * instead of onto it — and the faster you run the sooner it stops you. It stays
 * well under stepHeight, or it becomes a way to climb walls.
 */
const SLOPE_TOL = 0.12
/**
 * Longest physics step. The most important number in this file.
 *
 * Integrate a 100 ms frame in one go and gravity moves the feet 0.11 m before
 * anything goes looking for the floor — further than the ground query's 0.05 m
 * of upward tolerance. The floor you were standing on is now ABOVE the search
 * window, so it is not found, so you fall; next frame you are deeper and it is
 * further above you. One long frame and the city has no floor at all, which is
 * exactly what "there is no floor — it feels like flying" looks like from the
 * inside. Sub-stepping makes the walk identical at 12 fps and at 144.
 */
const MAX_STEP = 1 / 50
/** Cap the substeps so a tab that was asleep cannot stall the frame. */
const MAX_SUBSTEPS = 6
/** Jump pressed slightly before landing still counts. */
const JUMP_BUFFER = 0.13
/** Walking off a ledge leaves you a moment to jump. */
const COYOTE = 0.11
/** Below this the world has clearly lost you. */
const VOID_Y = -90
/** No ground for this long and we start to suspect you are falling forever. */
const LOST_GROUND = 2.0
/** …and this long with nothing underfoot settles it. */
const LOST_GROUND_HARD = 6.0
/** Sway is a fraction of the vertical bob. */
const SWAY_RATIO = 0.6
/** Bob amplitude chases the walk speed at this rate — fast enough to read as instant. */
const BOB_SETTLE = 11
/** Crouch/stand eye transition. */
const EYE_RATE = 13
/** Fade-to-black, hold, fade-back. */
const FADE_OUT = 0.18
const FADE_IN = 0.45
const DEG_TO_RAD = Math.PI / 180

/** The shared-buffer grid's exact outside edge. */
const POOL_HALF = ((CITY.buf.grid - 1) * CITY.buf.pitch + CITY.buf.tile) / 2
/** The deck is a real lower boundary; buffer instances remain deliberately non-solid. */
const POOL_BOTTOM = CITY.deck.top
/** Top of the conceptual water volume: the tallest ordinary usage_count column. */
const POOL_SURFACE = CITY.buf.baseY + CITY.buf.maxRise + 0.4
/** Swimming is slower to start and stop than walking. */
const SWIM_SPEED = 1.55
const SWIM_ACCEL = 2.35
const SWIM_VERTICAL_SETTLE = 3.2
const SWIM_SINK = 0.16
const SWIM_LOOK_RISE = 1.42
const SWIM_KEY_RISE = 0.9
const SWIM_KEY_SINK = 0.72

/**
 * The respawn pad. The buffer grid reaches z = ±46.1 (31 * 2.9 / 2 + tile / 2)
 * and the raised inner deck ends at z = 50.5, so z = 48 is a four-metre band of
 * clear deck at y = 3.7, right at the south edge of the grid, facing north
 * straight up it. (The outer promenade beyond z = 50.5 sits 0.70 m lower — a
 * step you have to jump, which is why the pad is not out there.)
 */
const SAFE_X = 0
const SAFE_Z = 48
const SAFE_Y = CITY.deck.top + 0.7
/** Facing: yaw 0 looks down -Z in three's convention, i.e. north, up the grid. */
const SAFE_YAW = 0

/**
 * The last stretch of a drop-in is a real fall under real gravity: 3.2 m takes
 * 0.54 s and arrives at 8.4 m/s, hard enough to trigger the landing dip.
 * Arriving is not the same as being placed, and that difference is most of what
 * makes a floor feel like a floor.
 */
const DROP_IN = 3.2
/** A respawn is a smaller version of the same idea. */
const RESPAWN_DROP = 1.2
/**
 * A drop-in point has to have the city within this radius. The ground plate
 * runs out past 600 m in every direction, so "the ray found a surface" is not
 * the same as "a person would want to stand here": land in the empty outfield
 * and there is nothing to walk past, which reads exactly like flying.
 */
const LANDING_NEAR = 60
/** Offsets probed around a candidate landing to prove it is a floor, not a post. */
const STAND_PROBE: readonly number[] = [1.2, 0, -1.2, 0, 0, 1.2, 0, -1.2]
/** How far a probe may differ from the middle and still be the same surface. */
const STAND_TOL = 0.6
/** Pitch is level by this fraction of the drop-in: you arrive facing the city. */
const PITCH_LEVEL_BY = 0.45
/** Drop-in flight time per metre travelled, on top of a fixed minimum. */
const DESCENT_PER_M = 0.0022
const DESCENT_MIN = 0.3

/** Fallback landing pads for enter(), nearest-first, when nothing is underfoot. */
const LANDING_PADS: readonly [number, number, number][] = [
  [SAFE_X, SAFE_Y, SAFE_Z],
  [0, SAFE_Y, -48],
  [-66, CITY.deck.top, 0],
  [66, CITY.deck.top, 0],
  [0, 0, CITY.backend.z + 26],
  [0, 0, -180],
  [CITY.pit.x + 30, 0, 0],
  [-CITY.pit.x - 30, 0, 0],
]

/* --------------------------------------------------------------------------
 * Module-scope scratch.
 * ------------------------------------------------------------------------*/

const _from = new THREE.Vector3()
const _to = new THREE.Vector3()
const _probe = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _eye = new THREE.Vector3()

const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'KeyC', 'ShiftLeft', 'ShiftRight',
])

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/* ==========================================================================*/

export function createWalkController(opts: WalkOptions): WalkController {
  const { camera, dom, collision, audio, sim, bus } = opts
  const T: WalkTuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) }
  const jumpSpeed = Math.sqrt(2 * T.gravity * T.jumpHeight)
  const poolSurfaceFeet = POOL_SURFACE - T.eyeStand + 0.12
  const noBob = prefersReducedMotion()

  /* ---- state -------------------------------------------------------------*/

  let enabled = false
  let grounded = false
  let swimming = false
  let submerged = false
  let gait: Gait = 'walk'
  let surface: Surface = 'ground'

  /** Feet. The camera sits eyeNow above this. */
  const pos = new THREE.Vector3(SAFE_X, SAFE_Y, SAFE_Z)
  const vel = new THREE.Vector3() // x and z only
  let vy = 0

  let yaw = SAFE_YAW
  let pitch = 0
  let lookX = 0
  let lookY = 0
  let touchLookX = 0
  let touchLookY = 0
  let locked = false
  let dragLook = false
  let touchStrafe = 0
  let touchForward = 0
  let touchJump = false
  let touchCrouch = false

  let crouching = false
  let running = false
  let eyeNow = T.eyeStand
  let capsuleH = T.capsuleHeight

  let bobPhase = 0
  let bobAmp = 0
  let landDip = 0

  let coyoteT = 0
  let jumpBufferT = 0
  let lostGroundT = 0

  // descent
  let descending = false
  let descentT = 0
  let descentDur = DEFAULT_TUNING.descentDuration
  const descentFrom = new THREE.Vector3()
  const descentTo = new THREE.Vector3()
  let descentPitch0 = 0
  let descentYaw = 0
  let descentResolve: (() => void) | null = null

  // respawn fade
  let fadeT = -1
  let fadePending = false

  const keys = new Set<string>()
  const mv: MoveResult = createMoveResult()
  const padUsed = new Uint8Array(LANDING_PADS.length)
  let disposed = false
  /** Ground covered this frame, summed over the substeps. Drives the head bob. */
  let frameTravel = 0
  /** Cumulative body travel. Audio cadence consumes this, just as bob consumes distance. */
  let distanceTravelled = 0
  const audioStep = {
    distance: 0,
    speed: 0,
    gait: 'walk' as Gait,
    grounded: false,
    surface: 'ground' as Surface,
    submerged: false,
  }

  camera.rotation.order = 'YXZ'

  function inPoolXZ(x: number, z: number): boolean {
    return x >= -POOL_HALF && x <= POOL_HALF && z >= -POOL_HALF && z <= POOL_HALF
  }

  /* ---- fade overlay ------------------------------------------------------*/

  const overlayRoot = opts.overlayRoot ?? (typeof document !== 'undefined' ? document.body : null)
  let fade: HTMLElement | null = null
  if (overlayRoot && typeof document !== 'undefined') {
    fade = document.createElement('div')
    fade.className = 'walk-fade'
    fade.style.cssText =
      'position:fixed;inset:0;background:#05070c;opacity:0;pointer-events:none;z-index:60;display:none'
    overlayRoot.appendChild(fade)
  }

  let poolReadout: HTMLElement | null = null
  let poolTitle: HTMLElement | null = null
  let poolState: HTMLElement | null = null
  let swimVeil: HTMLElement | null = null
  let poolReadoutT = 0
  let lastPoolTile = -1
  let lastPoolKey = ''
  let lastVeil = ''
  if (overlayRoot && typeof document !== 'undefined') {
    swimVeil = document.createElement('div')
    swimVeil.style.cssText =
      'position:absolute;inset:0;pointer-events:none;z-index:16;opacity:0;transition:opacity 180ms ease;' +
      'box-shadow:inset 0 0 110px rgba(45,82,180,.36);background:linear-gradient(rgba(30,55,125,.05),rgba(12,25,76,.12))'
    overlayRoot.appendChild(swimVeil)

    poolReadout = document.createElement('aside')
    poolReadout.hidden = true
    poolReadout.style.cssText =
      'position:absolute;left:50%;bottom:76px;transform:translateX(-50%);z-index:25;pointer-events:none;' +
      'min-width:310px;max-width:calc(100% - 36px);padding:9px 13px;border:1px solid rgba(123,108,255,.42);' +
      'border-left:3px solid rgba(123,108,255,.9);border-radius:3px;background:rgba(6,10,20,.82);' +
      'box-shadow:0 8px 28px rgba(0,0,0,.28);font-family:ui-monospace,SFMono-Regular,Menlo,monospace'
    poolTitle = document.createElement('div')
    poolTitle.style.cssText = 'color:#dbe7ff;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase'
    poolState = document.createElement('div')
    poolState.style.cssText = 'margin-top:4px;color:#8fa5c4;font-size:11px;line-height:1.35'
    poolReadout.append(poolTitle, poolState)
    overlayRoot.appendChild(poolReadout)
  }

  function updatePoolReadout(dt: number): void {
    const veil = submerged ? '1' : swimming ? '0.35' : '0'
    if (swimVeil && veil !== lastVeil) {
      lastVeil = veil
      swimVeil.style.opacity = veil
    }
    if (!poolReadout || !poolTitle || !poolState) return
    if (!swimming) {
      poolReadout.hidden = true
      poolReadoutT = 0
      lastPoolTile = -1
      lastPoolKey = ''
      return
    }
    poolReadout.hidden = false
    poolReadoutT -= dt
    if (poolReadoutT > 0) return
    poolReadoutT = 0.15

    const centreHalf = ((CITY.buf.grid - 1) * CITY.buf.pitch) / 2
    let col = Math.round((pos.x + centreHalf) / CITY.buf.pitch)
    let row = Math.round((pos.z + centreHalf) / CITY.buf.pitch)
    if (col < 0) col = 0
    else if (col >= CITY.buf.grid) col = CITY.buf.grid - 1
    if (row < 0) row = 0
    else if (row >= CITY.buf.grid) row = CITY.buf.grid - 1
    const tile = row * CITY.buf.grid + col
    const b = sim.buffers
    const active = tile < b.size
    const valid = active && b.valid[tile] !== 0
    const state = !active ? 'inactive' : !valid ? 'free' : b.dirty[tile] !== 0 ? 'dirty' : 'clean'
    const pinned = active && b.pinned[tile] !== 0
    const usage = active ? b.usage[tile] : 0
    const rel = valid && b.rel[tile] < sim.tables.length ? sim.tables[b.rel[tile]].def.name : 'no relation'
    const block = valid ? b.blk[tile] : 0
    const size = Math.max(1, b.size)
    const clockDistance = active ? (tile - b.clockHand + size) % size : 0
    const key = `${state}|${pinned ? 1 : 0}|${usage}|${rel}|${block}|${clockDistance}`
    if (tile !== lastPoolTile) {
      lastPoolTile = tile
      poolTitle.textContent = `Buffer pool (shared_buffers) · frame ${String(tile).padStart(4, '0')}`
    }
    if (key !== lastPoolKey) {
      lastPoolKey = key
      const pin = pinned ? ' · PINNED' : ''
      const owner = valid ? ` · ${rel} block ${block}` : ''
      const clock = active ? (clockDistance === 0 ? ' · CLOCK SWEEP HERE' : ` · clock +${clockDistance}`) : ''
      poolState.textContent = `${state.toUpperCase()}${pin} · usage_count ${usage} → height${owner}${clock}`
      poolState.style.color =
        state === 'dirty' ? '#ff6b82' : state === 'clean' ? '#69bfff' : pinned ? '#ffd36a' : '#8fa5c4'
    }
  }
  function setFade(a: number): void {
    if (!fade) return
    if (a <= 0.001) {
      fade.style.display = 'none'
      fade.style.opacity = '0'
    } else {
      fade.style.display = 'block'
      fade.style.opacity = a.toFixed(3)
    }
  }

  /* ---- input -------------------------------------------------------------*/

  function onKeyDown(e: KeyboardEvent): void {
    if (!enabled || isTypingTarget(e.target)) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (!MOVE_CODES.has(e.code)) return
    keys.add(e.code)
    if (e.code === 'Space') {
      jumpBufferT = JUMP_BUFFER
      e.preventDefault()
    }
    if (e.code.startsWith('Arrow')) e.preventDefault()
  }

  function onKeyUp(e: KeyboardEvent): void {
    keys.delete(e.code)
  }

  function onBlur(): void {
    keys.clear()
    dragLook = false
    lookX = 0
    lookY = 0
    resetTouchInput()
  }

  function onPointerDown(e: PointerEvent): void {
    if (!enabled) return
    // Touch look is owned by ui/touchpad.ts. Pointer lock is unavailable on
    // iOS Safari and a relative drag already supplies exactly the input needed.
    if (e.pointerType === 'touch') return
    if (e.button === 0 && !locked) requestLock()
    dragLook = true
  }

  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return
    if (locked) {
      lookX += e.movementX
      lookY += e.movementY
    } else if (dragLook) {
      lookX += e.movementX
      lookY += e.movementY
    }
  }

  function onPointerUp(): void {
    dragLook = false
  }

  function onLockChange(): void {
    locked = typeof document !== 'undefined' && document.pointerLockElement === dom
    if (!locked) dragLook = false
  }

  function requestLock(): void {
    if (locked || disposed) return
    const el = dom as HTMLElement & { requestPointerLock?: () => unknown }
    if (typeof el.requestPointerLock !== 'function') return
    try {
      const p = el.requestPointerLock()
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {})
    } catch {
      /* the browser wants a gesture first — drag-look still works */
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
  }
  if (typeof document !== 'undefined') document.addEventListener('pointerlockchange', onLockChange)
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerup', onPointerUp)
  dom.addEventListener('pointercancel', onPointerUp)

  /* ---- helpers -----------------------------------------------------------*/

  function axisForward(): number {
    return clamp(
      (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) +
        touchForward,
      -1,
      1,
    )
  }
  function axisStrafe(): number {
    return clamp(
      (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) +
        touchStrafe,
      -1,
      1,
    )
  }

  function keyboardMoving(): boolean {
    return (
      keys.has('KeyW') ||
      keys.has('KeyA') ||
      keys.has('KeyS') ||
      keys.has('KeyD') ||
      keys.has('ArrowUp') ||
      keys.has('ArrowDown') ||
      keys.has('ArrowLeft') ||
      keys.has('ArrowRight')
    )
  }

  function resetTouchInput(): void {
    touchStrafe = 0
    touchForward = 0
    touchLookX = 0
    touchLookY = 0
    touchJump = false
    touchCrouch = false
  }

  function setTouchMove(strafe: number, forward: number): void {
    touchStrafe = clamp(strafe, -1, 1)
    touchForward = clamp(forward, -1, 1)
  }

  function addTouchLook(xCm: number, yCm: number): void {
    if (!enabled || descending) return
    const radiansPerCm = T.touchLookSensitivity * DEG_TO_RAD
    touchLookX += xCm * radiansPerCm
    touchLookY += yCm * radiansPerCm
  }

  function setTouchJump(pressed: boolean): void {
    if (pressed && !touchJump) jumpBufferT = JUMP_BUFFER
    touchJump = pressed
  }

  function setTouchCrouch(pressed: boolean): void {
    touchCrouch = pressed
  }

  /** Ground under an arbitrary XZ, searching a generous vertical window. */
  function probeGround(x: number, y: number, z: number, drop: number): number | null {
    _probe.set(x, y, z)
    return collision.groundAt(_probe, drop)
  }

  /**
   * Could a person stand here? A surface is only a floor if it is still there a
   * stride away in every direction. A mast top, a plinth cap or the rim of a
   * lamp post passes the downward ray and fails this.
   */
  function standable(x: number, y: number, z: number): boolean {
    let ok = 0
    for (let i = 0; i < STAND_PROBE.length; i += 2) {
      const g = probeGround(x + STAND_PROBE[i], y + 0.6, z + STAND_PROBE[i + 1], 1.8)
      if (g !== null && Math.abs(g - y) <= STAND_TOL) ok++
    }
    return ok >= 3
  }

  /**
   * Where should a drop-in land? Straight down from the camera — if what is
   * down there is a floor AND the city is within sight of it. Otherwise the
   * nearest landing pad that passes the same two tests.
   */
  function findLanding(x: number, y: number, z: number, out: THREE.Vector3): void {
    const straight = probeGround(x, y, z, Math.max(4, y - VOID_Y))
    if (straight !== null && collision.solidNear(x, z, LANDING_NEAR) && standable(x, straight, z)) {
      out.set(x, straight, z)
      return
    }
    padUsed.fill(0)
    for (let k = 0; k < LANDING_PADS.length; k++) {
      let bestD = Infinity
      let bestI = -1
      for (let i = 0; i < LANDING_PADS.length; i++) {
        if (padUsed[i] === 1) continue
        const p = LANDING_PADS[i]
        const dx = p[0] - x
        const dz = p[2] - z
        const d = dx * dx + dz * dz
        if (d < bestD) {
          bestD = d
          bestI = i
        }
      }
      if (bestI < 0) break
      padUsed[bestI] = 1
      const pad = LANDING_PADS[bestI]
      const g = probeGround(pad[0], pad[1] + 4, pad[2], 12)
      if (g !== null && standable(pad[0], g, pad[2])) {
        out.set(pad[0], g, pad[2])
        return
      }
    }
    // Every pad is buried under something new. The plaza is still the plaza.
    out.set(SAFE_X, SAFE_Y, SAFE_Z)
  }

  function respawn(reason: string): void {
    const g = probeGround(SAFE_X, SAFE_Y + 4, SAFE_Z, 12)
    // Just above the deck, not on it: the short fall and its thump are the
    // receipt that says the floor they are back on is a real one.
    pos.set(SAFE_X, (g ?? SAFE_Y) + RESPAWN_DROP, SAFE_Z)
    vel.set(0, 0, 0)
    vy = 0
    grounded = false
    swimming = false
    submerged = false
    gait = 'walk'
    surface = 'ground'
    lostGroundT = 0
    coyoteT = 0
    bobAmp = 0
    landDip = 0
    bus.emit('toast', { text: reason, kind: 'warn', ms: 2600 })
  }

  let pendingReason = ''

  function startRespawn(reason: string): void {
    if (fadeT >= 0) return
    fadeT = 0
    fadePending = true
    // Freeze immediately so the fall does not continue behind the fade.
    vel.set(0, 0, 0)
    vy = 0
    if (!fade) {
      // No DOM to fade with (headless / harness): teleport straight away.
      fadeT = -1
      fadePending = false
      respawn(reason)
      return
    }
    pendingReason = reason
  }

  function tickFade(dt: number): void {
    if (fadeT < 0) return
    fadeT += dt
    if (fadePending) {
      if (fadeT >= FADE_OUT) {
        setFade(1)
        respawn(pendingReason)
        fadePending = false
        fadeT = 0
      } else {
        setFade(fadeT / FADE_OUT)
      }
      return
    }
    if (fadeT >= FADE_IN) {
      setFade(0)
      fadeT = -1
      return
    }
    setFade(1 - fadeT / FADE_IN)
  }

  /* ---- enter / exit ------------------------------------------------------*/

  function enter(from?: THREE.Vector3): Promise<void> {
    if (enabled) return Promise.resolve()
    enabled = true
    keys.clear()
    resetTouchInput()
    lookX = 0
    lookY = 0

    const src = from ?? camera.position
    descentFrom.copy(src)

    // Keep the yaw the user already had; a drop-in should not spin them round.
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
    descentYaw = Math.atan2(-_fwd.x, -_fwd.z)
    descentPitch0 = Math.asin(clamp(_fwd.y, -1, 1))

    collision.stepHeight = T.stepHeight
    findLanding(src.x, src.y, src.z, _probe)
    // The flight ends DROP_IN metres up, in the air, with gravity switched on:
    // the walker finishes the trip by falling and landing on the floor itself.
    pos.set(_probe.x, _probe.y + DROP_IN, _probe.z)
    vel.set(0, 0, 0)
    vy = 0
    grounded = false
    swimming = false
    submerged = false
    gait = 'walk'
    lostGroundT = 0
    crouching = false
    running = false
    eyeNow = T.eyeStand
    capsuleH = T.capsuleHeight
    bobPhase = 0
    bobAmp = 0
    landDip = 0
    frameTravel = 0
    distanceTravelled = 0
    yaw = descentYaw
    pitch = descentPitch0

    descentTo.set(pos.x, pos.y + T.eyeStand, pos.z)
    // A five-metre hop and a two-hundred-metre plunge cannot take the same time.
    descentDur = clamp(
      DESCENT_MIN + descentFrom.distanceTo(descentTo) * DESCENT_PER_M,
      DESCENT_MIN,
      T.descentDuration,
    )
    descending = true
    descentT = 0

    const touchControls =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches
    bus.emit('toast', {
      text: touchControls
        ? 'On foot — left thumb moves, right thumb looks. Jump rises in water; crouch toggles or dives. Tap Exit to leave.'
        : 'On foot — WASD or arrows to walk, Shift to run, Space to jump, C to crouch. Press G to stand back up.',
      kind: 'info',
      ms: 5200,
    })

    return new Promise<void>((resolve) => {
      descentResolve = resolve
    })
  }

  function finishDescent(): void {
    descending = false
    descentT = 0
    // Hand over to physics in mid-air, looking at the horizon. The dip comes
    // when the feet arrive, not when the flight ends.
    pitch = 0
    vy = 0
    grounded = false
    lostGroundT = 0
    const r = descentResolve
    descentResolve = null
    if (r) r()
  }

  function exit(): WalkExitView {
    const wasEnabled = enabled
    enabled = false
    if (descending) finishDescent()
    keys.clear()
    resetTouchInput()
    if (typeof document !== 'undefined' && document.pointerLockElement === dom) document.exitPointerLock()
    setFade(0)
    fadeT = -1
    fadePending = false
    swimming = false
    submerged = false
    gait = 'walk'
    updatePoolReadout(0)

    // Stand up and back off: 60 m up, 60 m back along the way we were looking.
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1) // horizontal view dir
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1)
    _fwd.normalize()
    const tx = pos.x
    const ty = pos.y + 6
    const tz = pos.z
    if (!wasEnabled) {
      // exit() on an inactive controller still returns something sane.
      return { position: [tx, ty + 60, tz + 60], target: [tx, ty, tz] }
    }
    return {
      position: [tx - _fwd.x * 60, ty + 60, tz - _fwd.z * 60],
      target: [tx + _fwd.x * 12, ty, tz + _fwd.z * 12],
    }
  }

  /* ---- the frame ---------------------------------------------------------*/

  function tickDescent(dt: number): void {
    descentT += dt
    const t = clamp01(descentT / descentDur)
    const kxz = easeInOutCubic(t)
    // Vertical uses a power curve so the fall accelerates into the ground —
    // easing out on Y reads as being lowered on a wire, not dropping in.
    const ky = Math.pow(t, 1.7)
    camera.position.x = descentFrom.x + (descentTo.x - descentFrom.x) * kxz
    camera.position.z = descentFrom.z + (descentTo.z - descentFrom.z) * kxz
    camera.position.y = descentFrom.y + (descentTo.y - descentFrom.y) * ky
    // Level the head early. You came from a camera staring down at the model;
    // the first thing a body wants is the horizon, and it wants it before it
    // lands, not after.
    pitch = descentPitch0 * (1 - easeInOutCubic(clamp01(t / PITCH_LEVEL_BY)))
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    camera.updateMatrixWorld()
    if (t >= 1) finishDescent()
  }

  /**
   * One physics step, never longer than MAX_STEP. The look angles are resolved
   * once per frame, in update(), and read from here.
   */
  function step(d: number): void {
    const nextSwimming =
      inPoolXZ(pos.x, pos.z) && pos.y >= POOL_BOTTOM - 0.05 && pos.y <= POOL_SURFACE
    if (nextSwimming !== swimming) {
      swimming = nextSwimming
      if (swimming) {
        audio.splash(clamp01(0.18 + Math.abs(vy) / 11))
        grounded = false
        coyoteT = 0
        lostGroundT = 0
        surface = 'water'
      } else {
        submerged = false
      }
    }

    /* --- stance ---------------------------------------------------------- */
    const touchMagnitude = Math.min(1, Math.hypot(touchForward, touchStrafe))
    crouching = !swimming && (keys.has('KeyC') || touchCrouch)
    running =
      !swimming &&
      !crouching &&
      (keys.has('ShiftLeft') ||
        keys.has('ShiftRight') ||
        (!keyboardMoving() && touchMagnitude > T.speedWalk / T.speedRun))
    const eyeTarget = crouching ? T.eyeCrouch : T.eyeStand
    eyeNow = damp(eyeNow, eyeTarget, EYE_RATE, d)
    capsuleH = crouching ? T.capsuleHeightCrouch : T.capsuleHeight

    /* --- wish direction, in yaw space ------------------------------------ */
    const fA = axisForward()
    const sA = axisStrafe()
    const inputMagnitude = Math.min(1, Math.hypot(fA, sA))
    const touchDriven = !keyboardMoving() && (Math.abs(touchForward) > 1e-5 || Math.abs(touchStrafe) > 1e-5)
    const targetSpeed = swimming
      ? SWIM_SPEED * inputMagnitude
      : crouching
        ? T.speedCrouch * inputMagnitude
        : touchDriven
          ? T.speedRun * inputMagnitude
          : running
            ? T.speedRun
            : T.speedWalk
    // yaw 0 looks down -Z: forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    const sy = Math.sin(yaw)
    const cy = Math.cos(yaw)
    let wx = 0
    let wz = 0
    if (fA !== 0 || sA !== 0) {
      wx = -sy * fA + cy * sA
      wz = -cy * fA - sy * sA
      const len = Math.sqrt(wx * wx + wz * wz)
      if (len > 1e-6) {
        wx = (wx / len) * targetSpeed
        wz = (wz / len) * targetSpeed
      }
    }

    /* --- accelerate ------------------------------------------------------ */
    const accel = (swimming ? SWIM_ACCEL : grounded ? T.accelGround : T.accelAir) * d
    let dvx = wx - vel.x
    let dvz = wz - vel.z
    const dv = Math.sqrt(dvx * dvx + dvz * dvz)
    if (dv <= accel || dv < 1e-6) {
      vel.x = wx
      vel.z = wz
    } else {
      vel.x += (dvx / dv) * accel
      vel.z += (dvz / dv) * accel
    }

    /* --- jump ------------------------------------------------------------ */
    if (jumpBufferT > 0) jumpBufferT -= d
    if (swimming) coyoteT = 0
    else if (grounded) coyoteT = COYOTE
    else if (coyoteT > 0) coyoteT -= d
    if (!swimming && jumpBufferT > 0 && coyoteT > 0 && !crouching) {
      vy = jumpSpeed
      grounded = false
      coyoteT = 0
      jumpBufferT = 0
      audio.jump()
    }

    /* --- horizontal move, with slide and step-up ------------------------- */
    _from.copy(pos)
    _to.set(pos.x + vel.x * d, pos.y, pos.z + vel.z * d)
    collision.move(_from, _to, T.capsuleRadius, capsuleH, mv)
    // Kill the component of velocity that hit a wall, or the walker grinds
    // along it at full speed and the bob never settles.
    if (mv.hitX) vel.x = 0
    if (mv.hitZ) vel.z = 0
    frameTravel += Math.hypot(mv.position.x - pos.x, mv.position.z - pos.z)
    pos.x = mv.position.x
    pos.z = mv.position.z
    // Step-up is for someone walking up a kerb, not for someone falling past
    // one: in the air, the ground query is the only thing that may stop a fall.
    if (mv.stepped > 0 && grounded) pos.y = mv.position.y

    /* --- vertical -------------------------------------------------------- */
    if (swimming) {
      const vy0 = vy
      const lookRise = Math.max(0, Math.sin(pitch)) * inputMagnitude * SWIM_LOOK_RISE
      let targetVy = -SWIM_SINK + lookRise
      if (keys.has('Space') || touchJump) targetVy += SWIM_KEY_RISE
      if (keys.has('KeyC') || touchCrouch) targetVy -= SWIM_KEY_SINK
      vy = damp(vy, targetVy, SWIM_VERTICAL_SETTLE, d)
      pos.y += (vy0 + vy) * 0.5 * d
      const ascentSpeed = vy > 0 ? vy : 0
      if (pos.y < POOL_BOTTOM) {
        pos.y = POOL_BOTTOM
        if (vy < 0) vy = 0
      } else if (pos.y > poolSurfaceFeet) {
        pos.y = poolSurfaceFeet
        if (vy > 0) vy = 0
      }
      const nextSubmerged = pos.y + eyeNow < POOL_SURFACE
      if (submerged && !nextSubmerged) {
        audio.splash(clamp01(0.24 + ascentSpeed * 0.42 + Math.hypot(vel.x, vel.z) * 0.12))
      }
      submerged = nextSubmerged
      grounded = false
      lostGroundT = 0
      surface = 'water'
      return
    }

    const wasGrounded = grounded
    const yBefore = pos.y
    const vy0 = vy
    vy -= T.gravity * d
    // Trapezoid, not Euler. Under constant acceleration this is exact, which is
    // the difference between a jump that peaks at 0.90 m and one that peaks at
    // 0.85 m and changes height when the frame rate does.
    pos.y += (vy0 + vy) * 0.5 * d

    /*
     * SWEEP, DO NOT SAMPLE. Ask what was under the feet across the whole step,
     * not what is under them at the end of it: probe from where they started —
     * plus a little slope tolerance, so a ramp rising into you still counts as
     * ground — and look down past where they ended. The window is
     *
     *     [ pos.y - snap , yBefore + slopeTol + GROUND_TOL ]
     *
     * so the floor you were standing on can never end up above the search and
     * be missed. Sampling at the new position is how a walker used to sink
     * through the plaza deck, one long frame at a time, until nothing was left
     * underneath them at all.
     */
    const fell = yBefore - pos.y
    const snap = wasGrounded ? GROUND_SNAP : AIR_SNAP
    const slopeTol = wasGrounded ? SLOPE_TOL : 0
    _probe.set(pos.x, yBefore + slopeTol, pos.z)
    const g = collision.groundAt(_probe, (fell > 0 ? fell : 0) + snap + slopeTol)
    if (g !== null && vy <= 0) {
      if (!wasGrounded && vy < -6) landDip = clamp01(-vy / 14) * 0.11
      surface = collision.groundSurface
      if (!wasGrounded) audio.land(-vy)
      pos.y = g
      vy = 0
      grounded = true
      lostGroundT = 0
    } else {
      grounded = false
      lostGroundT += d
    }

    /* --- safety net ------------------------------------------------------ */
    if (pos.y < VOID_Y) {
      startRespawn('You fell out of the world — back on the plaza.')
    } else if (lostGroundT > LOST_GROUND) {
      // Two seconds of air is usually a bug — but stepping off the plaza into
      // the excavation is a legitimate 55 m dive that takes 2.2 s. One deep
      // probe (at most once a second, only while falling) tells them apart.
      if (lostGroundT > LOST_GROUND_HARD || collision.groundAt(pos, 400) === null) {
        startRespawn('Lost the ground — back on the plaza.')
      } else {
        lostGroundT = LOST_GROUND * 0.5
      }
    }

  }

  /**
   * The frame. Look is resolved once; the body is integrated in fixed steps;
   * the camera is placed once, at the end.
   */
  function update(dt: number): void {
    if (!enabled) return
    const d = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0
    if (d === 0) return

    if (descending) {
      lookX = 0
      lookY = 0
      touchLookX = 0
      touchLookY = 0
      tickDescent(d)
      return
    }

    tickFade(d)

    /* --- look ------------------------------------------------------------ */
    yaw -= lookX * T.lookSensitivity + touchLookX
    pitch -= lookY * T.lookSensitivity + touchLookY
    lookX = 0
    lookY = 0
    touchLookX = 0
    touchLookY = 0
    pitch = clamp(pitch, -T.pitchLimit, T.pitchLimit)
    // Wrap yaw so it never grows without bound over a long session.
    if (yaw > Math.PI) yaw -= Math.PI * 2
    else if (yaw < -Math.PI) yaw += Math.PI * 2

    /* --- the body, in fixed steps ---------------------------------------- */
    frameTravel = 0
    let steps = d > MAX_STEP ? Math.ceil(d / MAX_STEP) : 1
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS
    const sd = d / steps
    for (let i = 0; i < steps; i++) step(sd)
    distanceTravelled += frameTravel

    /* --- head bob, driven by distance ------------------------------------ */
    const sy = Math.sin(yaw)
    const cy = Math.cos(yaw)
    const speed = Math.hypot(vel.x, vel.z)
    audioStep.distance = distanceTravelled
    audioStep.speed = speed
    gait = swimming ? 'swim' : crouching ? 'crouch' : running ? 'run' : 'walk'
    audioStep.gait = gait
    audioStep.grounded = grounded
    audioStep.surface = swimming ? 'water' : surface
    audioStep.submerged = submerged
    audio.step(d, audioStep)
    let bobY = 0
    let bobX = 0
    if (!noBob) {
      if (grounded && frameTravel > 1e-5) {
        bobPhase += (frameTravel / T.bobWavelength) * Math.PI * 2
        if (bobPhase > Math.PI * 2) bobPhase -= Math.PI * 2
      }
      const ampTarget = grounded ? T.bobAmplitude * clamp01(speed / T.speedWalk) : 0
      bobAmp = damp(bobAmp, ampTarget, BOB_SETTLE, d)
      // Vertical at twice the sway frequency: two footfalls per stride.
      bobY = Math.sin(bobPhase * 2) * bobAmp
      bobX = Math.sin(bobPhase) * bobAmp * SWAY_RATIO
    }
    if (landDip > 1e-4) landDip = damp(landDip, 0, 9, d)
    else landDip = 0

    /* --- drive the camera ------------------------------------------------ */
    _right.set(cy, 0, -sy)
    _eye.set(pos.x, pos.y + eyeNow + bobY - landDip, pos.z)
    _eye.addScaledVector(_right, bobX)
    camera.position.copy(_eye)
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    camera.updateMatrixWorld()
    updatePoolReadout(d)
  }

  /* ---- lifecycle ---------------------------------------------------------*/

  function dispose(): void {
    disposed = true
    if (descentResolve) {
      const r = descentResolve
      descentResolve = null
      r()
    }
    enabled = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerlockchange', onLockChange)
      if (document.pointerLockElement === dom) document.exitPointerLock()
    }
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('pointermove', onPointerMove)
    dom.removeEventListener('pointerup', onPointerUp)
    dom.removeEventListener('pointercancel', onPointerUp)
    keys.clear()
    resetTouchInput()
    if (fade && fade.parentNode) fade.parentNode.removeChild(fade)
    fade = null
    if (poolReadout && poolReadout.parentNode) poolReadout.parentNode.removeChild(poolReadout)
    if (swimVeil && swimVeil.parentNode) swimVeil.parentNode.removeChild(swimVeil)
    poolReadout = null
    poolTitle = null
    poolState = null
    swimVeil = null
  }

  return {
    get enabled(): boolean {
      return enabled
    },
    enter,
    exit,
    update,
    get grounded(): boolean {
      return grounded
    },
    get gait(): Gait {
      return gait
    },
    get submerged(): boolean {
      return submerged
    },
    get surface(): Surface {
      return swimming ? 'water' : surface
    },
    get speed(): number {
      return Math.hypot(vel.x, vel.z)
    },
    get distance(): number {
      return distanceTravelled
    },
    get position(): THREE.Vector3 {
      return pos
    },
    setTouchMove,
    addTouchLook,
    setTouchJump,
    setTouchCrouch,
    dispose,
  }
}
