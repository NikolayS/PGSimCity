import * as THREE from 'three'
import type { Bus, CameraApi, CameraMode, FocusSpec } from '../core/types'
import { clamp, clamp01, damp, easeInOutCubic, lerp, reduceMotion } from '../core/util'
import { ANCHOR } from '../world/layout'
import { PLAN_UP, sampleOutline } from '../world/slonik'

/* ============================================================================
 * THE CAMERA RIG
 *
 * One kinematic state, four modes.
 *
 *   orbit  — the default. A pivot in the world, a spherical offset around it.
 *            Drag is 1:1; release glides; the wheel dollies toward the cursor
 *            ray, not toward the pivot, which is the difference between "CAD
 *            toy" and "architectural walkthrough".
 *   fly    — pointer-locked yaw/pitch with accelerated view-space translation.
 *   focus  — a scripted tween to frame a component.
 *   tour   — a scripted CatmullRom path with a parallel look-at path.
 *
 * The orbit state is kept continuously valid *during* scripted moves (pivot is
 * re-derived from the live camera transform every frame), so release() is a
 * pure mode flip with zero snap. That is the whole trick: the user can grab the
 * camera at any instant of any animation and nothing jumps.
 *
 * Everything mutable is hoisted; update() allocates nothing.
 * ==========================================================================*/

export interface CameraRig extends CameraApi {
  home(instant?: boolean): void
  /** Straight down on the whole plate — the shot the Slonik outline is cut for. */
  plan(instant?: boolean): void
  setPivot(p: THREE.Vector3 | [number, number, number]): void
  readonly pivot: THREE.Vector3
  readonly speed: number
}

/* --------------------------------------------------------------------------
 * Tuning. Every number here is a feel decision.
 * ------------------------------------------------------------------------*/

/** The central plaza loses all readable geometry below this orbit range. */
const MIN_DIST = 24
/** Far enough out to hold the whole plate — which is now ~1.3 km corner to corner. */
const MAX_DIST = 1650
/** Never flip over the poles; 3.05 rad lets you get well under the city to
 *  look up into the storage excavation. */
const PHI_MIN = 0.03
const PHI_MAX = 3.05

/** Orbit inertia decay (1/s). ~0.25 s to settle. */
const SPIN_DECAY = 13
const PAN_DECAY = 13
/** How fast the smoothed (non-1:1) quantities chase their target. */
const DOLLY_RATE = 12
const PIVOT_RATE = 18
/** Velocity estimator responsiveness while dragging. */
const VEL_TRACK = 26

/** Keyboard translation acceleration (1/s). */
const KEY_ACCEL = 9
/** Fly look sensitivity, radians per pixel. */
const LOOK_SENS = 0.0022
const PITCH_LIMIT = 1.5359 // 88°
const MIN_FLY_SPEED = 4
const MAX_FLY_SPEED = 400
const DEFAULT_FLY_SPEED = 46

const BOOST = 3
const PRECISION = 0.25

/** Wheel: exp(px * k). One notch (~100px) ≈ 22%. */
const ZOOM_K = 0.002
const SPEED_K = 0.0018

const FOCUS_DUR = 1.05
/** Upward framing bias for auto-derived focus directions. */
const FOCUS_UP_BIAS = 0.436 // 25°
/** Fraction of a tour path spent easing in / out. */
const PATH_EASE = 0.18

/**
 * The establishing shot. From the north-west, high enough that the whole
 * surface reads at once: maintenance yard (west) on the right of frame, WAL
 * district (east) on the left, backend row across the middle, plaza dead
 * centre, and the excavation opening below it. Aim point is pulled slightly
 * west of the origin so the landfill and the archive store sit symmetrically
 * inside the horizontal FOV.
 */
const HOME_POS = new THREE.Vector3(-218, 216, -342)
const HOME_PIVOT = new THREE.Vector3(-18, 0, -16)

/**
 * THE OVERVIEW SHOT — straight down on the plate.
 *
 * The ground plate is cut to the Slonik outline and this is the framing it was
 * drawn for. Two things make it work and neither is arbitrary:
 *
 *  - the camera is tipped ~5° off vertical, and the *azimuth* of that tip sets
 *    which world direction lands at the top of frame. The rig always uses world
 *    up for roll, so screen-up is the horizontal part of `dir`, negated. Putting
 *    the camera slightly north-west therefore puts world south-east at the top
 *    — which is the elephant's own up, so the mark stands upright and faces
 *    left, exactly as it is drawn, rather than lying on its side.
 *  - the distance is derived from the plate's extent along the two screen axes
 *    (see PLAN_SPAN), not guessed, and it backs off on a narrow window the same
 *    way the establishing shot does.
 */
/** Tip off vertical. Small enough to read as plan, big enough to set the roll. */
const PLAN_TILT = 0.1
const PLAN_DIR = new THREE.Vector3(-PLAN_UP[0] * PLAN_TILT, 1, -PLAN_UP[1] * PLAN_TILT).normalize()

/**
 * Pivot and spans measured off the outline itself rather than written down.
 * Screen-right in a top-down view is world up rotated -90° in (x, z), so the
 * plate's extent along those two axes *is* its extent on screen — and the shot
 * stays correct if the outline is ever redrawn.
 */
const PLAN_FRAME = (() => {
  const ring = sampleOutline(10)
  const ux = PLAN_UP[0]
  const uz = PLAN_UP[1]
  const rx = -uz
  const rz = ux
  let a0 = Infinity
  let a1 = -Infinity
  let b0 = Infinity
  let b1 = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    const a = ring[i] * rx + ring[i + 1] * rz
    const b = ring[i] * ux + ring[i + 1] * uz
    if (a < a0) a0 = a
    if (a > a1) a1 = a
    if (b < b0) b0 = b
    if (b > b1) b1 = b
  }
  const ac = (a0 + a1) / 2
  const bc = (b0 + b1) / 2
  return {
    pivot: new THREE.Vector3(ac * rx + bc * ux, 0, ac * rz + bc * uz),
    spanX: (a1 - a0) * 1.06,
    spanY: (b1 - b0) * 1.06,
  }
})()
/** Space occupied by the persistent top and bottom instruments, including
 * their HUD gaps. The side panels are removed for this preset by the UI. */
const PLAN_HUD_VERTICAL = 152

const CITY_CENTER = new THREE.Vector3(ANCHOR.cityCenter[0], ANCHOR.cityCenter[1], ANCHOR.cityCenter[2])
const WORLD_UP = new THREE.Vector3(0, 1, 0)

/** Below this speed² a velocity is dust: snap it to zero so nothing creeps. */
const DEAD_VEL = 1e-4

/**
 * One box for the eye and the pivot alike, a little larger than the ground
 * plane. It is only enforced against *user-driven* motion: a scripted move or a
 * re-adopted pivot is never yanked back, which would show up as a snap.
 */
const LIMIT_XZ = 1200
const LIMIT_Y_LO = -300
const LIMIT_Y_HI = 900

/* --------------------------------------------------------------------------
 * Module-scope scratch. Nothing below allocates per frame.
 * ------------------------------------------------------------------------*/

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _upv = new THREE.Vector3()
const _sph = new THREE.Spherical()
const _q1 = new THREE.Quaternion()
const _m4 = new THREE.Matrix4()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')

const MOVE_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Space', 'PageUp', 'PageDown',
])

const FLY_ONLY_CODES = new Set(['Space', 'KeyE', 'KeyC', 'KeyQ'])

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

/** Wheel deltas normalised to CSS pixels. */
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 16
  if (e.deltaMode === 2) return e.deltaY * 100
  return e.deltaY
}

/**
 * Arc-length reparameterisation with smoothstep ramps at the ends only:
 * constant speed through the middle of a tour shot, no dead-stop feel.
 * ∫ smoothstep = x³ − x⁴/2, which is 0.5 at x = 1.
 */
function easeEnds(t: number): number {
  const a = PATH_EASE
  const total = 1 - a
  const u = clamp01(t)
  if (u < a) {
    const x = u / a
    return (a * (x * x * x - (x * x * x * x) / 2)) / total
  }
  if (u < 1 - a) return (a / 2 + (u - a)) / total
  const x = (1 - u) / a
  return (total - a * (x * x * x - (x * x * x * x) / 2)) / total
}

/* ==========================================================================*/

export function createCameraRig(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  bus: Bus,
): CameraRig {
  /* ---- state -------------------------------------------------------------*/

  let mode: CameraMode = 'orbit'
  /** The mode we hand control back to when a scripted move ends. */
  let userMode: 'orbit' | 'fly' = 'orbit'

  // orbit: `pivot`/`dist` chase their targets; theta/phi are driven directly so
  // dragging is exactly 1:1.
  const pivot = HOME_PIVOT.clone()
  const pivotT = HOME_PIVOT.clone()
  let theta = 0
  let phi = 1
  let dist = 400
  let distT = 400

  let velTheta = 0
  let velPhi = 0
  const velPivot = new THREE.Vector3()
  const kbVel = new THREE.Vector3()

  // fly
  let yaw = 0
  let pitch = 0
  let flySpeed = DEFAULT_FLY_SPEED
  let toastedSpeed = DEFAULT_FLY_SPEED
  const flyVel = new THREE.Vector3()

  // viewport
  let viewW = Math.max(1, domElement.clientWidth || window.innerWidth)
  let viewH = Math.max(1, domElement.clientHeight || window.innerHeight)

  // pending input, consumed in update()
  let inRotX = 0
  let inRotY = 0
  let inPanX = 0
  let inPanY = 0
  let inLookX = 0
  let inLookY = 0
  let pendingZoom = 1
  let zoomNdcX = 0
  let zoomNdcY = 0

  let dragOrbit = false
  let dragPan = false
  let dragLook = false
  let panGestureAnnounced = false
  let rotateGestureAnnounced = false
  let locked = false
  let disposed = false
  let activePreset: 'plan' | null = null

  // scripted moves
  let tweenT = 0
  let tweenDur = FOCUS_DUR
  const tweenP0 = new THREE.Vector3()
  const tweenP1 = new THREE.Vector3()
  const tweenQ0 = new THREE.Quaternion()
  const tweenQ1 = new THREE.Quaternion()
  const tweenTarget = new THREE.Vector3()
  let tweenD0 = 0
  let tweenD1 = 0

  let pathPos: THREE.CatmullRomCurve3 | null = null
  let pathLook: THREE.CatmullRomCurve3 | null = null
  const pathLookFixed = new THREE.Vector3()
  let pathT = 0
  let pathDur = 1
  let pathResolve: (() => void) | null = null

  // touch
  const ptrIds: number[] = []
  const ptrX = new Map<number, number>()
  const ptrY = new Map<number, number>()
  let pinchActive = false
  let pinchDist = 0
  let pinchMx = 0
  let pinchMy = 0
  /** Two-finger twist, radians, for yaw. NaN until the gesture has a reference. */
  let pinchAngle = 0

  const keys = new Set<string>()
  let shiftDown = false
  let altDown = false

  camera.up.copy(WORLD_UP)
  camera.rotation.order = 'YXZ'

  /* ---- helpers -----------------------------------------------------------*/

  function setMode_(m: CameraMode): void {
    if (m === mode) return
    mode = m
    if (m === 'orbit' || m === 'fly') userMode = m
    bus.emit('camera:mode', { mode: m })
  }

  const scriptedNow = () => mode === 'focus' || mode === 'tour'

  /**
   * Rebuild the orbit state from wherever the camera currently is, putting the
   * pivot `d` units ahead of the eye. The eye position is preserved exactly:
   * when the polar clamp bites (you came out of fly mode staring at the sky) it
   * moves the *pivot*, never the camera, so nothing jumps under the user.
   */
  function adoptOrbit(d: number): void {
    const dd = clamp(d, MIN_DIST, MAX_DIST)
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
    _v1.copy(_fwd).multiplyScalar(-dd) // pivot → eye
    _sph.setFromVector3(_v1)
    theta = _sph.theta
    phi = clamp(_sph.phi, PHI_MIN, PHI_MAX)
    dist = dd
    distT = dd
    _sph.radius = dd
    _sph.phi = phi
    _sph.theta = theta
    _v2.setFromSpherical(_sph)
    pivot.copy(camera.position).sub(_v2)
    pivotT.copy(pivot)
  }

  /** Applied only where the user actively drives the pivot. */
  function clampPivotTarget(): void {
    pivotT.x = clamp(pivotT.x, -LIMIT_XZ, LIMIT_XZ)
    pivotT.y = clamp(pivotT.y, LIMIT_Y_LO, LIMIT_Y_HI)
    pivotT.z = clamp(pivotT.z, -LIMIT_XZ, LIMIT_XZ)
  }

  function syncOrbitFromCamera(d: number): void {
    adoptOrbit(d)
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
  }

  function syncFlyFromCamera(): void {
    _euler.setFromQuaternion(camera.quaternion, 'YXZ')
    yaw = _euler.y
    pitch = clamp(_euler.x, -PITCH_LIMIT, PITCH_LIMIT)
    flyVel.set(0, 0, 0)
  }

  /** Drop the scripted move and settle its promise. Does not touch the transform. */
  function cancelScript(): void {
    const resolve = pathResolve
    pathResolve = null
    pathPos = null
    pathLook = null
    tweenT = tweenDur
    if (resolve) resolve()
  }

  function setActivePreset(next: 'plan' | null): void {
    if (next === activePreset) return
    activePreset = next
    bus.emit('camera:preset', { preset: next })
  }

  function requestLock(): void {
    if (locked || disposed) return
    const el = domElement as HTMLElement & { requestPointerLock?: () => unknown }
    if (typeof el.requestPointerLock !== 'function') return
    try {
      const p = el.requestPointerLock()
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {})
    } catch {
      /* browser refused (no gesture / iframe) — drag-look still works */
    }
  }

  /* ---- input -------------------------------------------------------------*/

  function interrupt(): void {
    setActivePreset(null)
    // Any user input during a scripted move hands control straight back.
    if (scriptedNow()) release()
  }

  function ndcFromEvent(e: { clientX: number; clientY: number }): void {
    const r = domElement.getBoundingClientRect()
    zoomNdcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    zoomNdcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1)
  }

  function onPointerDown(e: PointerEvent): void {
    // Right-click belongs to the contextual UI in every camera mode. Do not
    // capture it, cancel a scripted shot, or let it enter a look integrator.
    if (e.pointerType !== 'touch' && e.button === 2) return

    interrupt()
    if (ptrIds.length === 0) {
      panGestureAnnounced = false
      rotateGestureAnnounced = false
    }
    ptrIds.push(e.pointerId)
    ptrX.set(e.pointerId, e.clientX)
    ptrY.set(e.pointerId, e.clientY)
    if (typeof domElement.setPointerCapture === 'function') {
      try {
        domElement.setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone */
      }
    }

    if (e.pointerType === 'touch' && ptrIds.length >= 2) {
      // Second finger: stop panning and start a pinch on the next move. Keep
      // dragOrbit ON, because twist and tilt feed the same rotate integrator a
      // mouse drag does — without it inRotX/inRotY accumulate and are thrown
      // away, which is exactly why touch could zoom and pan but never turn.
      dragOrbit = true
      dragPan = false
      pinchActive = false
      return
    }

    if (mode === 'fly') {
      if (e.button === 0 && !locked) requestLock()
      dragLook = true
      if (e.button !== 0) e.preventDefault()
      return
    }

    // Google Maps convention, not CAD convention. This reads as a city seen from
    // above, so left-drag grabs the ground and moves it — the thing every map
    // does — and shift+left swings the camera around. Ctrl/Cmd+left is the same
    // orbit alias for anyone arriving with model-viewer habits, middle-drag
    // keeps its pan muscle memory, and right-click remains entirely available
    // to the contextual UI, which is the point of moving rotation off it.
    if (e.button === 0) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) dragOrbit = true
      else dragPan = true
    } else if (e.button === 1) {
      dragPan = true
      e.preventDefault()
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const id = e.pointerId
    const px = ptrX.get(id)
    const py = ptrY.get(id)
    if (px === undefined || py === undefined) {
      // not a tracked pointer: only pointer-locked look uses raw movement
      if (locked && mode === 'fly') {
        inLookX += e.movementX
        inLookY += e.movementY
      }
      return
    }
    const dx = e.clientX - px
    const dy = e.clientY - py
    ptrX.set(id, e.clientX)
    ptrY.set(id, e.clientY)

    // two-finger: pinch dolly + midpoint pan
    if (ptrIds.length >= 2) {
      const ax = ptrX.get(ptrIds[0])
      const ay = ptrY.get(ptrIds[0])
      const bx = ptrX.get(ptrIds[1])
      const by = ptrY.get(ptrIds[1])
      if (ax === undefined || ay === undefined || bx === undefined || by === undefined) return
      const sx = ax - bx
      const sy = ay - by
      const d = Math.sqrt(sx * sx + sy * sy) || 1
      const mx = (ax + bx) * 0.5
      const my = (ay + by) * 0.5
      // Map gestures, the set every phone user already knows: pinch to zoom,
      // twist to swing the camera round, and drag both fingers up or down to
      // tilt. Panning stays on one finger, so nothing here has to compete with
      // it and each gesture stays unambiguous.
      const ang = Math.atan2(sy, sx)
      if (pinchActive) {
        pendingZoom *= clamp(pinchDist / d, 0.5, 2)
        ndcFromEvent({ clientX: mx, clientY: my })

        // twist -> yaw. Shortest-arc difference so crossing PI does not spin.
        let dAng = ang - pinchAngle
        if (dAng > Math.PI) dAng -= Math.PI * 2
        else if (dAng < -Math.PI) dAng += Math.PI * 2
        // inRotX is consumed as (2*PI*inRotX)/viewH radians, so convert back.
        // Negated: screen Y points down, so a visually clockwise twist gives a
        // POSITIVE atan2 delta, and feeding that straight in turned the city
        // against the fingers. The map has to follow the hand.
        inRotX -= (dAng * viewH) / (Math.PI * 2)

        // both fingers moving together vertically -> tilt
        const dMidY = my - pinchMy
        inRotY += dMidY
        if (!rotateGestureAnnounced && (Math.abs(dAng) > 1e-4 || Math.abs(dMidY) > 0.1)) {
          rotateGestureAnnounced = true
          bus.emit('camera:gesture', { kind: 'rotate', pointer: 'touch' })
        }
      }
      pinchDist = d
      pinchMx = mx
      pinchMy = my
      pinchAngle = ang
      pinchActive = true
      return
    }

    if (mode === 'fly') {
      if (locked) {
        inLookX += e.movementX
        inLookY += e.movementY
      } else if (dragLook) {
        inLookX += dx
        inLookY += dy
      }
      return
    }

    if (dragOrbit) {
      inRotX += dx
      inRotY += dy
      if (!rotateGestureAnnounced && (dx !== 0 || dy !== 0)) {
        rotateGestureAnnounced = true
        bus.emit('camera:gesture', { kind: 'rotate', pointer: e.pointerType === 'touch' ? 'touch' : 'mouse' })
      }
    } else if (dragPan) {
      inPanX += dx
      inPanY += dy
      if (!panGestureAnnounced && (dx !== 0 || dy !== 0)) {
        panGestureAnnounced = true
        bus.emit('camera:gesture', { kind: 'pan', pointer: e.pointerType === 'touch' ? 'touch' : 'mouse' })
      }
    }
  }

  function endPointer(e: PointerEvent): void {
    const i = ptrIds.indexOf(e.pointerId)
    if (i >= 0) ptrIds.splice(i, 1)
    ptrX.delete(e.pointerId)
    ptrY.delete(e.pointerId)
    if (typeof domElement.releasePointerCapture === 'function' && domElement.hasPointerCapture?.(e.pointerId)) {
      try {
        domElement.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
    if (ptrIds.length < 2) pinchActive = false
    if (ptrIds.length === 0) {
      dragOrbit = false
      dragPan = false
      dragLook = false
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    interrupt()
    const px = wheelPixels(e)
    if (mode === 'fly') {
      flySpeed = clamp(flySpeed * Math.exp(-px * SPEED_K), MIN_FLY_SPEED, MAX_FLY_SPEED)
      const ratio = flySpeed / toastedSpeed
      if (ratio > 1.6 || ratio < 1 / 1.6) {
        toastedSpeed = flySpeed
        bus.emit('toast', { text: `Fly speed ${Math.round(flySpeed)} u/s`, kind: 'info', ms: 900 })
      }
      return
    }
    pendingZoom *= Math.exp(px * ZOOM_K)
    ndcFromEvent(e)
  }

  function onContextMenu(e: Event): void {
    e.preventDefault()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return
    shiftDown = e.shiftKey
    altDown = e.altKey
    if (e.code === 'Home') {
      e.preventDefault()
      home(false)
      return
    }
    // O for overview. A camera framing, so it is bound here with Home rather
    // than in the HUD — nothing else in the app claims the key.
    if (e.code === 'KeyO' && !e.repeat) {
      e.preventDefault()
      plan(false)
      return
    }
    if (!MOVE_CODES.has(e.code)) return
    // Space / E / C / Q only mean "move" in fly mode — in orbit they belong to
    // whatever the HUD binds them to.
    if (FLY_ONLY_CODES.has(e.code) && mode !== 'fly' && !(mode === 'tour' && userMode === 'fly')) return
    interrupt()
    keys.add(e.code)
    // otherwise the page scrolls under us
    if (e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'PageUp' || e.code === 'PageDown') {
      e.preventDefault()
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    shiftDown = e.shiftKey
    altDown = e.altKey
    keys.delete(e.code)
  }

  function onBlur(): void {
    keys.clear()
    shiftDown = false
    altDown = false
    dragOrbit = false
    dragPan = false
    dragLook = false
    pinchActive = false
    ptrIds.length = 0
    ptrX.clear()
    ptrY.clear()
  }

  function onLockChange(): void {
    locked = document.pointerLockElement === domElement
    if (!locked) dragLook = false
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('pointerup', endPointer)
  domElement.addEventListener('pointercancel', endPointer)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  domElement.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('pointerlockchange', onLockChange)
  const offCameraPresetRequest = bus.on('ui:camera-preset', ({ preset }) => {
    if (preset === 'plan') plan()
  })

  const prevTouchAction = domElement.style.touchAction
  domElement.style.touchAction = 'none'

  /* ---- orbit -------------------------------------------------------------*/

  /** Signed keyboard axes, shared by both modes. */
  function axisForward(): number {
    return (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0)
  }
  function axisStrafe(): number {
    return (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
  }
  /**
   * PageUp/PageDown change altitude in both modes; Space/E/C/Q are fly-only so
   * they can never fight a HUD binding while the user is just looking around.
   */
  function axisVertical(fly: boolean): number {
    let up = keys.has('PageUp') ? 1 : 0
    let down = keys.has('PageDown') ? 1 : 0
    if (fly) {
      if (keys.has('KeyE') || (keys.has('Space') && !shiftDown)) up = 1
      if (keys.has('KeyC') || keys.has('KeyQ') || (keys.has('Space') && shiftDown)) down = 1
    }
    return up - down
  }
  function speedScale(): number {
    return (shiftDown ? BOOST : 1) * (altDown ? PRECISION : 1)
  }

  /** Dolly toward the cursor ray. Keeping the point under the cursor put is the
   *  single biggest quality-of-life difference from a plain distance zoom. */
  function applyZoom(): void {
    if (pendingZoom === 1) return
    const dOld = distT
    const dNew = clamp(dOld * pendingZoom, MIN_DIST, MAX_DIST)
    pendingZoom = 1
    if (dNew === dOld) return

    _v1.set(zoomNdcX, zoomNdcY, 0.5).unproject(camera).sub(camera.position)
    if (_v1.lengthSq() > 1e-8) {
      _v1.normalize()
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
      // pivot' = pivot + (dOld - dNew) * (ray - view)  — derived from holding the
      // cursor ray fixed while the distance changes.
      _v1.sub(_fwd).multiplyScalar(dOld - dNew)
      const maxShift = dOld * 0.75
      if (_v1.lengthSq() > maxShift * maxShift) _v1.setLength(maxShift)
      pivotT.add(_v1)
      clampPivotTarget()
    }
    distT = dNew
  }

  function tickOrbit(dt: number, sdt: number): void {
    inLookX = 0
    inLookY = 0

    /* rotate — 1:1 while dragging, inertial afterwards */
    if (dragOrbit) {
      const kx = (Math.PI * 2 * inRotX) / viewH
      const ky = (Math.PI * 2 * inRotY) / viewH
      theta -= kx
      phi -= ky
      velTheta = damp(velTheta, -kx / sdt, VEL_TRACK, sdt)
      velPhi = damp(velPhi, -ky / sdt, VEL_TRACK, sdt)
    } else {
      theta += velTheta * dt
      phi += velPhi * dt
      velTheta = damp(velTheta, 0, SPIN_DECAY, dt)
      velPhi = damp(velPhi, 0, SPIN_DECAY, dt)
      if (velTheta < 1e-4 && velTheta > -1e-4) velTheta = 0
      if (velPhi < 1e-4 && velPhi > -1e-4) velPhi = 0
    }
    inRotX = 0
    inRotY = 0

    const clampedPhi = clamp(phi, PHI_MIN, PHI_MAX)
    if (clampedPhi !== phi) {
      phi = clampedPhi
      velPhi = 0
    }

    /* pan — screen-space 1:1 in the camera plane */
    const wpp = (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(dist, 1)) / viewH
    _right.setFromMatrixColumn(camera.matrixWorld, 0)
    _upv.setFromMatrixColumn(camera.matrixWorld, 1)
    if (dragPan) {
      _v1.set(0, 0, 0)
      _v1.addScaledVector(_right, -inPanX * wpp)
      _v1.addScaledVector(_upv, inPanY * wpp)
      pivot.add(_v1)
      pivotT.add(_v1)
      clampPivotTarget()
      _v2.copy(_v1).divideScalar(sdt)
      velPivot.x = damp(velPivot.x, _v2.x, VEL_TRACK, sdt)
      velPivot.y = damp(velPivot.y, _v2.y, VEL_TRACK, sdt)
      velPivot.z = damp(velPivot.z, _v2.z, VEL_TRACK, sdt)
    } else if (velPivot.lengthSq() > DEAD_VEL) {
      pivot.addScaledVector(velPivot, dt)
      pivotT.addScaledVector(velPivot, dt)
      clampPivotTarget()
      velPivot.multiplyScalar(Math.exp(-PAN_DECAY * dt))
    } else {
      velPivot.set(0, 0, 0)
    }
    inPanX = 0
    inPanY = 0

    /* keyboard translation — arrows + WASD walk the model, PageUp/Dn change altitude */
    const fA = axisForward()
    const sA = axisStrafe()
    const vA = axisVertical(false)
    _v1.set(0, 0, 0)
    if (fA !== 0 || sA !== 0 || vA !== 0) {
      _fwd.setFromMatrixColumn(camera.matrixWorld, 2).negate()
      _fwd.y = 0
      if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1)
      _fwd.normalize()
      _v3.copy(_right)
      _v3.y = 0
      if (_v3.lengthSq() < 1e-8) _v3.set(1, 0, 0)
      _v3.normalize()
      _v1.addScaledVector(_fwd, fA).addScaledVector(_v3, sA)
      _v1.y += vA
      if (_v1.lengthSq() > 1e-8) _v1.normalize().multiplyScalar(clamp(dist * 0.5, 8, 420) * speedScale())
    }
    kbVel.x = damp(kbVel.x, _v1.x, KEY_ACCEL, dt)
    kbVel.y = damp(kbVel.y, _v1.y, KEY_ACCEL, dt)
    kbVel.z = damp(kbVel.z, _v1.z, KEY_ACCEL, dt)
    if (kbVel.lengthSq() > DEAD_VEL) {
      pivot.addScaledVector(kbVel, dt)
      pivotT.addScaledVector(kbVel, dt)
      clampPivotTarget()
    } else if (_v1.lengthSq() === 0) {
      kbVel.set(0, 0, 0) // no residual drift once the key is up
    }

    applyZoom()

    /* smoothed quantities chase their targets */
    distT = clamp(distT, MIN_DIST, MAX_DIST)
    dist = damp(dist, distT, DOLLY_RATE, dt)
    pivot.lerp(pivotT, 1 - Math.exp(-PIVOT_RATE * dt))

    applyOrbitTransform()
  }

  function applyOrbitTransform(): void {
    _sph.radius = dist
    _sph.phi = phi
    _sph.theta = theta
    camera.position.setFromSpherical(_sph).add(pivot)
    camera.up.copy(WORLD_UP)
    camera.lookAt(pivot)
    camera.updateMatrixWorld()
  }

  /* ---- fly ---------------------------------------------------------------*/

  function tickFly(dt: number): void {
    yaw -= inLookX * LOOK_SENS
    pitch -= inLookY * LOOK_SENS
    inLookX = 0
    inLookY = 0
    pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT)
    // Euler YXZ: yaw then pitch, third term always 0 — roll is structurally
    // impossible, which is what keeps fly mode from feeling like a plane.
    camera.rotation.set(pitch, yaw, 0, 'YXZ')
    camera.updateMatrixWorld()

    // orbit-only input is meaningless here; drop it rather than let it queue up
    inRotX = 0
    inRotY = 0
    inPanX = 0
    inPanY = 0
    pendingZoom = 1

    const fA = axisForward()
    const sA = axisStrafe()
    const vA = axisVertical(true)
    _v1.set(0, 0, 0)
    if (fA !== 0 || sA !== 0 || vA !== 0) {
      _fwd.setFromMatrixColumn(camera.matrixWorld, 2).negate()
      _right.setFromMatrixColumn(camera.matrixWorld, 0)
      _v1.addScaledVector(_fwd, fA).addScaledVector(_right, sA)
      _v1.y += vA
      if (_v1.lengthSq() > 1e-8) _v1.normalize().multiplyScalar(flySpeed * speedScale())
    }
    flyVel.x = damp(flyVel.x, _v1.x, KEY_ACCEL, dt)
    flyVel.y = damp(flyVel.y, _v1.y, KEY_ACCEL, dt)
    flyVel.z = damp(flyVel.z, _v1.z, KEY_ACCEL, dt)
    if (flyVel.lengthSq() < DEAD_VEL && _v1.lengthSq() === 0) flyVel.set(0, 0, 0)
    camera.position.addScaledVector(flyVel, dt)
    camera.position.x = clamp(camera.position.x, -LIMIT_XZ, LIMIT_XZ)
    camera.position.y = clamp(camera.position.y, LIMIT_Y_LO, LIMIT_Y_HI)
    camera.position.z = clamp(camera.position.z, -LIMIT_XZ, LIMIT_XZ)
    camera.updateMatrixWorld()
  }

  /* ---- scripted ----------------------------------------------------------*/

  function tickFocus(dt: number): void {
    tweenT += dt
    const k = easeInOutCubic(clamp01(tweenT / tweenDur))
    camera.position.lerpVectors(tweenP0, tweenP1, k)
    camera.quaternion.slerpQuaternions(tweenQ0, tweenQ1, k)
    camera.updateMatrixWorld()
    adoptOrbit(lerp(tweenD0, tweenD1, k))
    if (tweenT >= tweenDur) {
      pivot.copy(tweenTarget)
      pivotT.copy(tweenTarget)
      dist = clamp(tweenD1, MIN_DIST, MAX_DIST)
      distT = dist
      _v1.copy(camera.position).sub(pivot)
      _sph.setFromVector3(_v1)
      theta = _sph.theta
      phi = clamp(_sph.phi, PHI_MIN, PHI_MAX)
      velTheta = 0
      velPhi = 0
      velPivot.set(0, 0, 0)
      kbVel.set(0, 0, 0)
      setMode_('orbit')
      applyOrbitTransform()
    }
  }

  function tickPath(dt: number): void {
    const curve = pathPos
    if (!curve) {
      cancelScript()
      setMode_(userMode)
      return
    }
    pathT += dt
    const u = clamp01(pathT / pathDur)
    const s = easeEnds(u)
    curve.getPointAt(s, camera.position)
    if (pathLook) pathLook.getPointAt(s, _v2)
    else _v2.copy(pathLookFixed)

    _m4.lookAt(camera.position, _v2, WORLD_UP)
    _q1.setFromRotationMatrix(_m4)
    // Damped slerp: the framing swings in, it never whips.
    camera.quaternion.slerp(_q1, 1 - Math.exp(-9 * dt))
    camera.updateMatrixWorld()
    adoptOrbit(camera.position.distanceTo(_v2))

    if (u >= 1) {
      const back = userMode
      cancelScript()
      if (back === 'fly') syncFlyFromCamera()
      setMode_(back)
    }
  }

  /* ---- public API --------------------------------------------------------*/

  function focusOn(spec: FocusSpec, opts?: { instant?: boolean; duration?: number }, preservePreset = false): void {
    if (!preservePreset) setActivePreset(null)
    if (scriptedNow()) cancelScript()

    tweenTarget.set(spec.target[0], spec.target[1], spec.target[2])
    const d = clamp(spec.distance, MIN_DIST, MAX_DIST)

    // Direction FROM target TO camera.
    if (spec.dir) {
      _v1.set(spec.dir[0], spec.dir[1], spec.dir[2])
      if (_v1.lengthSq() < 1e-8) _v1.set(0, 0.5, 1)
      _v1.normalize()
    } else {
      // Derive from the current view so the move reads as "step around and in",
      // then bias upward — a slight top-down angle always frames better.
      _v1.copy(camera.position).sub(tweenTarget)
      if (_v1.lengthSq() < 1e-6) _v1.set(0, 0.5, 1)
      _v1.normalize()
      _v2.set(_v1.x, 0, _v1.z)
      if (_v2.lengthSq() < 1e-8) {
        _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
        _v2.set(-_fwd.x, 0, -_fwd.z)
        if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1)
      }
      _v2.normalize()
      const elev = clamp(Math.asin(clamp(_v1.y, -1, 1)) * 0.45 + FOCUS_UP_BIAS, 0.14, 1.2)
      _v1.copy(_v2).multiplyScalar(Math.cos(elev))
      _v1.y = Math.sin(elev)
      _v1.normalize()
    }

    tweenP1.copy(tweenTarget).addScaledVector(_v1, d)
    _m4.lookAt(tweenP1, tweenTarget, WORLD_UP)
    tweenQ1.setFromRotationMatrix(_m4)

    // A visitor who asked for reduced motion gets a cut, not a flight: a
    // scripted camera move across the whole city is exactly the kind of motion
    // the preference exists to stop.
    if (opts?.instant || reduceMotion()) {
      camera.position.copy(tweenP1)
      camera.quaternion.copy(tweenQ1)
      camera.updateMatrixWorld()
      pivot.copy(tweenTarget)
      pivotT.copy(tweenTarget)
      dist = d
      distT = d
      _v2.copy(camera.position).sub(pivot)
      _sph.setFromVector3(_v2)
      theta = _sph.theta
      phi = clamp(_sph.phi, PHI_MIN, PHI_MAX)
      velTheta = 0
      velPhi = 0
      velPivot.set(0, 0, 0)
      kbVel.set(0, 0, 0)
      flyVel.set(0, 0, 0)
      setMode_('orbit')
      applyOrbitTransform()
      return
    }

    tweenP0.copy(camera.position)
    tweenQ0.copy(camera.quaternion)
    // Shortest arc: three's slerp already handles the sign, but make it explicit
    // so a 180° framing change never rolls through the pole.
    if (tweenQ0.dot(tweenQ1) < 0) tweenQ1.set(-tweenQ1.x, -tweenQ1.y, -tweenQ1.z, -tweenQ1.w)
    tweenD0 = clamp(camera.position.distanceTo(tweenTarget), MIN_DIST, MAX_DIST)
    tweenD1 = d
    tweenT = 0
    tweenDur = Math.max(0.05, opts?.duration ?? FOCUS_DUR)
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
    flyVel.set(0, 0, 0)
    setMode_('focus')
  }

  function flyPath(
    points: [number, number, number][],
    lookAt: [number, number, number][],
    duration: number,
  ): Promise<void> {
    setActivePreset(null)
    if (scriptedNow()) cancelScript()
    if (!points || points.length < 2) return Promise.resolve()

    const pts: THREE.Vector3[] = []
    for (let i = 0; i < points.length; i++) pts.push(new THREE.Vector3(points[i][0], points[i][1], points[i][2]))
    pathPos = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5)
    pathPos.getLength() // force the arc-length table now, not mid-flight

    if (lookAt && lookAt.length >= 2) {
      const lpts: THREE.Vector3[] = []
      for (let i = 0; i < lookAt.length; i++) lpts.push(new THREE.Vector3(lookAt[i][0], lookAt[i][1], lookAt[i][2]))
      pathLook = new THREE.CatmullRomCurve3(lpts, false, 'catmullrom', 0.5)
      pathLook.getLength()
    } else {
      pathLook = null
      if (lookAt && lookAt.length === 1) pathLookFixed.set(lookAt[0][0], lookAt[0][1], lookAt[0][2])
      else pathLookFixed.copy(CITY_CENTER)
    }

    pathT = 0
    pathDur = Math.max(0.1, duration)
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
    flyVel.set(0, 0, 0)
    setMode_('tour')

    return new Promise<void>((resolve) => {
      pathResolve = resolve
    })
  }

  function release(): void {
    setActivePreset(null)
    if (!scriptedNow()) {
      velTheta = 0
      velPhi = 0
      return
    }
    const back = userMode
    cancelScript()
    if (back === 'fly') syncFlyFromCamera()
    // orbit state has been tracked every frame of the move: nothing to snap.
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
    flyVel.set(0, 0, 0)
    setMode_(back)
  }

  function setMode(m: CameraMode): void {
    setActivePreset(null)
    if (m === mode) return
    if (m === 'focus' || m === 'tour') return // scripted modes are entered by focusOn/flyPath
    if (scriptedNow()) {
      release()
      if (m === mode) return
    }
    if (m === 'walk') {
      // engine/walk.ts owns camera.position and rotation from here. Zero every
      // integrator first so nothing is still coasting underneath the walker.
      dropPendingInput()
      flyVel.set(0, 0, 0)
      setMode_('walk')
      return
    }
    if (m === 'orbit') {
      syncOrbitFromCamera(clamp(dist, 25, 420))
      applyOrbitTransform()
    } else {
      syncFlyFromCamera()
      if (locked) {
        /* keep the lock */
      } else {
        bus.emit('toast', {
          text: 'Fly mode — click to look, WASD / arrows to move, Esc to release',
          kind: 'info',
          ms: 2600,
        })
      }
    }
    setMode_(m)
  }

  function home(instant = false): void {
    _v1.copy(HOME_POS).sub(HOME_PIVOT)
    // The shot is framed for a landscape window; the FOV is vertical, so on a
    // narrow one we have to back off or the WAL district falls off the edge.
    const d = _v1.length() * clamp(1.6 / Math.max(camera.aspect, 0.4), 1, 2.4)
    _v1.normalize()
    if (mode === 'fly') setMode('orbit')
    focusOn(
      {
        target: [HOME_PIVOT.x, HOME_PIVOT.y, HOME_PIVOT.z],
        distance: d,
        dir: [_v1.x, _v1.y, _v1.z],
      },
      { instant, duration: 1.25 },
    )
  }

  /**
   * Frame the whole plate from directly overhead. Distance is whatever it takes
   * to fit the plate in both screen axes at the current aspect, so the shot is
   * correct on a phone and on an ultrawide.
   */
  function plan(instant = false): void {
    const tanV = Math.tan((camera.fov * Math.PI) / 360)
    const aspect = Math.max(camera.aspect, 0.35)
    const usableH = Math.max(viewH * 0.55, viewH - PLAN_HUD_VERTICAL)
    const verticalFit = (PLAN_FRAME.spanY / 2 / tanV) * (viewH / usableH)
    const d = Math.max(verticalFit, PLAN_FRAME.spanX / 2 / (tanV * aspect))
    if (mode === 'fly') setMode('orbit')
    setActivePreset('plan')
    focusOn(
      {
        target: [PLAN_FRAME.pivot.x, PLAN_FRAME.pivot.y, PLAN_FRAME.pivot.z],
        distance: clamp(d, MIN_DIST, MAX_DIST),
        dir: [PLAN_DIR.x, PLAN_DIR.y, PLAN_DIR.z],
      },
      { instant, duration: 1.4 },
      true,
    )
    bus.emit('toast', { text: 'Overview — the plate is the PostgreSQL elephant', kind: 'info', ms: 2600 })
  }

  function setPivot(p: THREE.Vector3 | [number, number, number]): void {
    setActivePreset(null)
    if (Array.isArray(p)) pivotT.set(p[0], p[1], p[2])
    else pivotT.copy(p)
    clampPivotTarget()
    velPivot.set(0, 0, 0)
  }

  function update(dt: number): void {
    // A tab that was hidden hands us a huge dt; clamp so nothing teleports.
    const d = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0
    const sdt = d > 1e-4 ? d : 1e-4
    if (mode === 'walk') {
      // The pedestrian writes the transform this frame. Keep re-deriving the
      // orbit state from it — the same trick the scripted modes use — so that
      // standing back up is a mode flip with no snap.
      dropPendingInput()
      syncOrbitFromCamera(clamp(dist, 25, 420))
      return
    }
    if (mode === 'focus') {
      dropPendingInput()
      tickFocus(d)
    } else if (mode === 'tour') {
      dropPendingInput()
      tickPath(d)
    } else if (mode === 'fly') tickFly(d)
    else tickOrbit(d, sdt)
  }

  /** Scripted moves swallow input; anything that mattered already called release(). */
  function dropPendingInput(): void {
    inRotX = 0
    inRotY = 0
    inPanX = 0
    inPanY = 0
    inLookX = 0
    inLookY = 0
    pendingZoom = 1
  }

  function resize(w: number, h: number): void {
    viewW = Math.max(1, w)
    viewH = Math.max(1, h)
    camera.aspect = viewW / viewH
    camera.updateProjectionMatrix()
  }

  function dispose(): void {
    disposed = true
    cancelScript()
    domElement.removeEventListener('pointerdown', onPointerDown)
    domElement.removeEventListener('pointermove', onPointerMove)
    domElement.removeEventListener('pointerup', endPointer)
    domElement.removeEventListener('pointercancel', endPointer)
    domElement.removeEventListener('wheel', onWheel)
    domElement.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('pointerlockchange', onLockChange)
    offCameraPresetRequest()
    domElement.style.touchAction = prevTouchAction
    if (document.pointerLockElement === domElement) document.exitPointerLock()
    keys.clear()
    ptrIds.length = 0
    ptrX.clear()
    ptrY.clear()
  }

  // Boot straight into the establishing shot so the very first rendered frame
  // is already the right picture; main.ts calls home(true) again after load.
  syncOrbitFromCamera(400)
  pivot.copy(HOME_PIVOT)
  pivotT.copy(HOME_PIVOT)
  _v1.copy(HOME_POS).sub(HOME_PIVOT)
  dist = _v1.length()
  distT = dist
  _sph.setFromVector3(_v1)
  theta = _sph.theta
  phi = clamp(_sph.phi, PHI_MIN, PHI_MAX)
  applyOrbitTransform()
  syncFlyFromCamera()

  const rig: CameraRig = {
    camera,
    get mode(): CameraMode {
      return mode
    },
    set mode(m: CameraMode) {
      setMode(m)
    },
    setMode,
    focusOn,
    flyPath,
    release,
    update,
    get altitude(): number {
      return camera.position.distanceTo(CITY_CENTER)
    },
    get scripted(): boolean {
      return mode === 'focus' || mode === 'tour'
    },
    resize,
    dispose,
    home,
    plan,
    setPivot,
    get pivot(): THREE.Vector3 {
      return pivot
    },
    get speed(): number {
      return flySpeed
    },
  }
  return rig
}
