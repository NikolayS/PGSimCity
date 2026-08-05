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

export interface CameraRigOptions {
  /** Test override; production follows the live media-query preference. */
  reducedMotion?: boolean
}

type TouchGestureIntent = 'pending' | 'swipe' | 'twist' | 'pinch'

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
/** Keyboard turn/tilt speed, radians per second. */
const KEY_LOOK_RATE = 1.45
/** Keyboard orbit zoom exponent per second. */
const KEY_ZOOM_RATE = 2.2
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

/* Gesture evidence uses contact geometry, not delivered events or rendered
 * frames. Six percent of the starting span clears proportional placement
 * jitter; 1.5x acquires an intent, while a competing 2x signal releases it.
 * Output cross-fades from equal evidence to 2x, so either threshold is smooth. */
const TOUCH_INTENT_FRACTION = 0.06
const TOUCH_DOMINANCE = 1.5
const TOUCH_RELEASE_DOMINANCE = 2
const TOUCH_TWIST_ANGLE = TOUCH_INTENT_FRACTION * 2
/* Beyond about 21 degrees the changing contact axis is unambiguously a twist,
 * even off-centre where its midpoint legitimately travels farther than its span. */
const TOUCH_DECISIVE_TWIST_ANGLE = TOUCH_TWIST_ANGLE * 3

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

/** User motion is bounded by the eye. The picked ground point is never clamped. */
const LIMIT_XZ = 1200
const LIMIT_Y_LO = -300
const LIMIT_Y_HI = 900
const GROUND_Y = 0
const ORBIT_EYE_MIN_Y = 0.01

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
  'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract',
])

const FLY_ONLY_CODES = new Set(['Space', 'KeyE', 'KeyC', 'KeyQ'])
const ORBIT_ONLY_CODES = new Set(['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract'])

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
  options: CameraRigOptions = {},
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
  let panNdcX = 0
  let panNdcY = 0
  let inputNdcX = 0
  let inputNdcY = 0

  let dragOrbit = false
  let dragPan = false
  let dragLook = false
  let keyboardOrbit = false
  let panGestureAnnounced = false
  let rotateGestureAnnounced = false
  let locked = false
  let disposed = false
  let activePreset: 'plan' | null = null
  const rotateAnchor = new THREE.Vector3()
  const panAnchor = new THREE.Vector3()
  let rotateAnchorValid = false
  let panAnchorValid = false
  let zoomAnchored = false

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
  const touchReported = new Set<number>()
  let touchCommitTimer: number | null = null
  let touchFrameActive = false
  let touchPrevDist = 0
  let touchPrevMx = 0
  let touchPrevMy = 0
  let touchPrevAngle = 0
  let touchStartDist = 0
  let touchStartMx = 0
  let touchStartMy = 0
  let touchAngleTotal = 0
  const touchBasePivot = new THREE.Vector3()
  const touchBasePivotT = new THREE.Vector3()
  let touchBaseTheta = 0
  let touchBasePhi = 0
  let touchBaseDist = 0
  let touchScale = 1
  let touchYaw = 0
  let touchTilt = 0
  let touchTransformDirty = false
  let touchIntent: TouchGestureIntent = 'pending'

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
  const motionReduced = () => options.reducedMotion ?? reduceMotion()

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
    zoomAnchored = false
  }

  function userEyeViolation(p: THREE.Vector3): number {
    const dx = Math.max(-LIMIT_XZ - p.x, 0, p.x - LIMIT_XZ)
    const dy = Math.max(ORBIT_EYE_MIN_Y - p.y, 0, p.y - LIMIT_Y_HI)
    const dz = Math.max(-LIMIT_XZ - p.z, 0, p.z - LIMIT_XZ)
    return dx * dx + dy * dy + dz * dz
  }

  /** Translate the whole orbit frame, clipping the motion where the eye meets its bounds. */
  function translateOrbit(delta: THREE.Vector3): void {
    delta.x = clamp(camera.position.x + delta.x, -LIMIT_XZ, LIMIT_XZ) - camera.position.x
    delta.y = clamp(camera.position.y + delta.y, ORBIT_EYE_MIN_Y, LIMIT_Y_HI) - camera.position.y
    delta.z = clamp(camera.position.z + delta.z, -LIMIT_XZ, LIMIT_XZ) - camera.position.z
    camera.position.add(delta)
    pivot.add(delta)
    pivotT.add(delta)
  }

  /** Ray/ground-plane intersection. The caller owns `out`; `_v3` is scratch. */
  function pickGround(ndcX: number, ndcY: number, out: THREE.Vector3): boolean {
    _v3.set(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position)
    if (_v3.y >= -1e-8 || camera.position.y < GROUND_Y) return false
    const t = (GROUND_Y - camera.position.y) / _v3.y
    if (t < 0) return false
    out.copy(camera.position).addScaledVector(_v3, t)
    return true
  }

  function pickGroundOrCentre(ndcX: number, ndcY: number, out: THREE.Vector3): boolean {
    return pickGround(ndcX, ndcY, out) || pickGround(0, 0, out)
  }

  /** Largest prefix of a user rotation whose eye remains inside the bounds. */
  function allowedRotationFraction(axis: THREE.Vector3, angle: number): number {
    const startViolation = userEyeViolation(camera.position)
    _q1.setFromAxisAngle(axis, angle)
    _v1.copy(camera.position).sub(rotateAnchor).applyQuaternion(_q1).add(rotateAnchor)
    if (userEyeViolation(_v1) <= startViolation) return 1
    if (startViolation > 0) return 0

    let lo = 0
    let hi = 1
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) * 0.5
      _q1.setFromAxisAngle(axis, angle * mid)
      _v1.copy(camera.position).sub(rotateAnchor).applyQuaternion(_q1).add(rotateAnchor)
      if (userEyeViolation(_v1) === 0) lo = mid
      else hi = mid
    }
    return lo
  }

  /** Rotate eye and look target together, preserving the picked point's screen position. */
  function rotateOrbit(axis: THREE.Vector3, angle: number): boolean {
    if (!rotateAnchorValid || Math.abs(angle) < 1e-12) return true
    const fraction = allowedRotationFraction(axis, angle)
    if (fraction <= 0) return false
    _q1.setFromAxisAngle(axis, angle * fraction)
    camera.position.sub(rotateAnchor).applyQuaternion(_q1).add(rotateAnchor)
    pivot.sub(rotateAnchor).applyQuaternion(_q1).add(rotateAnchor)
    pivotT.sub(rotateAnchor).applyQuaternion(_q1).add(rotateAnchor)
    camera.up.copy(WORLD_UP)
    camera.lookAt(pivot)
    camera.updateMatrixWorld()

    _v1.copy(camera.position).sub(pivot)
    _sph.setFromVector3(_v1)
    theta = _sph.theta
    phi = _sph.phi
    dist = _sph.radius
    distT = dist
    return fraction > 1 - 1e-6
  }

  function syncOrbitFromCamera(d: number): void {
    adoptOrbit(d)
    rotateAnchorValid = false
    panAnchorValid = false
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

  function readEventNdc(e: { clientX: number; clientY: number }): void {
    const r = domElement.getBoundingClientRect()
    inputNdcX = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1
    inputNdcY = -(((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1)
  }

  function ndcFromEvent(e: { clientX: number; clientY: number }): void {
    readEventNdc(e)
    zoomNdcX = inputNdcX
    zoomNdcY = inputNdcY
  }

  function beginRotateAt(e: { clientX: number; clientY: number }): void {
    readEventNdc(e)
    beginRotateAtNdc(inputNdcX, inputNdcY)
  }

  function beginRotateAtNdc(ndcX: number, ndcY: number): void {
    pivotT.copy(pivot)
    distT = dist
    zoomAnchored = false
    panAnchorValid = false
    velPivot.set(0, 0, 0)
    kbVel.set(0, 0, 0)
    rotateAnchorValid = pickGroundOrCentre(ndcX, ndcY, rotateAnchor)
    if (!rotateAnchorValid) {
      rotateAnchor.copy(pivot)
      rotateAnchorValid = true
    }
  }

  function beginPanAt(e: { clientX: number; clientY: number }): void {
    readEventNdc(e)
    panNdcX = inputNdcX
    panNdcY = inputNdcY
    pivotT.copy(pivot)
    distT = dist
    zoomAnchored = false
    rotateAnchorValid = false
    velTheta = 0
    velPhi = 0
    velPivot.set(0, 0, 0)
    panAnchorValid = pickGround(panNdcX, panNdcY, panAnchor)
  }

  function cancelTouchGestureCommit(): void {
    if (touchCommitTimer !== null) {
      window.clearTimeout(touchCommitTimer)
      touchCommitTimer = null
    }
  }

  function clearTouchGesture(): void {
    cancelTouchGestureCommit()
    touchFrameActive = false
    touchReported.clear()
    touchScale = 1
    touchYaw = 0
    touchTilt = 0
    touchTransformDirty = false
    touchAngleTotal = 0
    touchIntent = 'pending'
    velTheta = 0
    velPhi = 0
  }

  function beginTouchGesture(ax: number, ay: number, bx: number, by: number): void {
    cancelTouchGestureCommit()
    const sx = ax - bx
    const sy = ay - by
    touchPrevDist = Math.sqrt(sx * sx + sy * sy) || 1
    touchPrevMx = (ax + bx) * 0.5
    touchPrevMy = (ay + by) * 0.5
    touchPrevAngle = Math.atan2(sy, sx)
    touchStartDist = touchPrevDist
    touchStartMx = touchPrevMx
    touchStartMy = touchPrevMy
    touchBasePivot.copy(pivot)
    touchBasePivotT.copy(pivotT)
    touchBaseTheta = theta
    touchBasePhi = phi
    touchBaseDist = dist
    touchFrameActive = true
    touchScale = 1
    touchYaw = 0
    touchTilt = 0
    touchTransformDirty = false
    touchAngleTotal = 0
    touchIntent = 'pending'
    touchReported.clear()
  }

  function touchEvidence(intent: TouchGestureIntent, translation: number, radial: number, twist: number): number {
    if (intent === 'swipe') return translation
    if (intent === 'pinch') return radial
    if (intent === 'twist') return twist
    return 0
  }

  function classifyTouchGesture(
    translation: number,
    radial: number,
    twistAngle: number,
  ): TouchGestureIntent {
    const threshold = touchStartDist * TOUCH_INTENT_FRACTION
    const twist = twistAngle * touchStartDist * 0.5
    if (
      twistAngle >= TOUCH_DECISIVE_TWIST_ANGLE
      && radial <= twist * TOUCH_RELEASE_DOMINANCE
    ) return 'twist'
    if (translation >= threshold && translation > Math.max(radial, twist) * TOUCH_DOMINANCE) return 'swipe'
    if (radial >= threshold && radial > Math.max(translation, twist) * TOUCH_DOMINANCE) return 'pinch'
    if (twist >= threshold && twist > Math.max(translation, radial) * TOUCH_DOMINANCE) return 'twist'
    return 'pending'
  }

  function updateTouchIntent(translation: number, radial: number, twistAngle: number): void {
    const candidate = classifyTouchGesture(translation, radial, twistAngle)
    if (candidate === 'pending' || candidate === touchIntent) return
    if (touchIntent === 'pending') {
      touchIntent = candidate
      return
    }

    const twist = twistAngle * touchStartDist * 0.5
    const candidateEvidence = touchEvidence(candidate, translation, radial, twist)
    const activeEvidence = touchEvidence(touchIntent, translation, radial, twist)
    const decisiveTwist = candidate === 'twist' && twistAngle >= TOUCH_DECISIVE_TWIST_ANGLE
    if (decisiveTwist || candidateEvidence > activeEvidence * TOUCH_RELEASE_DOMINANCE) {
      touchIntent = candidate
    }
  }

  function evidenceWeight(value: number, threshold: number): number {
    return clamp01((value - threshold) / threshold)
  }

  function dominanceWeight(primary: number, competing: number): number {
    if (primary <= competing) return 0
    if (competing <= 1e-9) return 1
    return clamp01((primary / competing - 1) / (TOUCH_RELEASE_DOMINANCE - 1))
  }

  function hystereticDominanceWeight(
    intent: TouchGestureIntent,
    primary: number,
    competing: number,
  ): number {
    const weight = dominanceWeight(primary, competing)
    if (touchIntent !== intent || competing <= 1e-9) return weight
    const ratio = primary / competing
    const releaseRatio = 1 / TOUCH_RELEASE_DOMINANCE
    const acquireWeight = dominanceWeight(TOUCH_DOMINANCE, 1)
    const heldWeight = acquireWeight * clamp01(
      (ratio - releaseRatio) / (TOUCH_DOMINANCE - releaseRatio),
    )
    return Math.max(weight, heldWeight)
  }

  /** Commit one mutually-current pair; no render tick may mix contact epochs. */
  function commitTouchGesture(ax: number, ay: number, bx: number, by: number): void {
    const sx = ax - bx
    const sy = ay - by
    const distance = Math.sqrt(sx * sx + sy * sy) || 1
    const mx = (ax + bx) * 0.5
    const my = (ay + by) * 0.5
    const angle = Math.atan2(sy, sx)
    const dMidX = mx - touchPrevMx
    const dMidY = my - touchPrevMy
    let dAngle = angle - touchPrevAngle
    if (dAngle > Math.PI) dAngle -= Math.PI * 2
    else if (dAngle < -Math.PI) dAngle += Math.PI * 2

    touchAngleTotal += dAngle
    const totalMidX = mx - touchStartMx
    const totalMidY = my - touchStartMy
    const translation = Math.hypot(totalMidX, totalMidY)
    const radial = Math.abs(distance - touchStartDist)
    const twistAngle = Math.abs(touchAngleTotal)
    const twistTravel = twistAngle * touchStartDist * 0.5
    const moved = dMidX !== 0 || dMidY !== 0 || distance !== touchPrevDist || dAngle !== 0
    if (moved) updateTouchIntent(translation, radial, twistAngle)

    const threshold = touchStartDist * TOUCH_INTENT_FRACTION
    const swipeWeight = evidenceWeight(translation, threshold)
      * hystereticDominanceWeight('swipe', translation, radial)
    const twistEvidence = evidenceWeight(twistTravel, threshold)
    const twistDominance = hystereticDominanceWeight(
      'twist',
      twistTravel,
      Math.max(translation, radial),
    )
    const decisiveTwist = clamp01(
      (twistAngle - TOUCH_TWIST_ANGLE) / (TOUCH_DECISIVE_TWIST_ANGLE - TOUCH_TWIST_ANGLE),
    )
    const twistWeight = twistEvidence * Math.max(twistDominance, decisiveTwist)
    const parallelWeight = swipeWeight * (1 - twistWeight)
    touchYaw = touchAngleTotal * twistWeight - (Math.PI * 2 * totalMidX * parallelWeight) / viewH
    touchTilt = -(Math.PI * 2 * totalMidY * parallelWeight) / viewH
    if (
      !rotateGestureAnnounced
      && (Math.abs(touchYaw) > 1e-4 || Math.abs(touchTilt) > 1e-4)
    ) {
      rotateGestureAnnounced = true
      bus.emit('camera:gesture', { kind: 'rotate', pointer: 'touch' })
    }
    touchScale = touchStartDist / distance
    touchTransformDirty ||= moved

    touchPrevDist = distance
    touchPrevMx = mx
    touchPrevMy = my
    touchPrevAngle = angle
  }

  function commitCoherentTouchGesture(force = false): void {
    if (!touchFrameActive || ptrIds.length < 2) return
    const aId = ptrIds[0]
    const bId = ptrIds[1]
    if (touchReported.size === 0) return
    if (!force && (!touchReported.has(aId) || !touchReported.has(bId))) return
    const ax = ptrX.get(aId)
    const ay = ptrY.get(aId)
    const bx = ptrX.get(bId)
    const by = ptrY.get(bId)
    if (ax === undefined || ay === undefined || bx === undefined || by === undefined) return
    cancelTouchGestureCommit()
    touchReported.clear()
    commitTouchGesture(ax, ay, bx, by)
  }

  function settleTouchGestureBatch(): void {
    touchCommitTimer = null
    commitCoherentTouchGesture(true)
  }

  function scheduleTouchGestureCommit(): void {
    if (touchCommitTimer !== null) return
    /* A zero-delay task lets co-timestamped pointer tasks finish in delivery
     * order. At that boundary a missing owner did not move, so its last
     * coordinate is current rather than stale. */
    touchCommitTimer = window.setTimeout(settleTouchGestureBatch, 0)
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
      // The first two contacts own one gesture until either is released.
      dragOrbit = true
      dragPan = false
      if (ptrIds.length === 2) {
        const ax = ptrX.get(ptrIds[0]) ?? e.clientX
        const ay = ptrY.get(ptrIds[0]) ?? e.clientY
        const bx = ptrX.get(ptrIds[1]) ?? e.clientX
        const by = ptrY.get(ptrIds[1]) ?? e.clientY
        beginRotateAt({ clientX: (ax + bx) * 0.5, clientY: (ay + by) * 0.5 })
        beginTouchGesture(ax, ay, bx, by)
      }
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
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        dragOrbit = true
        beginRotateAt(e)
      } else {
        dragPan = true
        beginPanAt(e)
      }
    } else if (e.button === 1) {
      dragPan = true
      beginPanAt(e)
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
    ptrX.set(id, e.clientX)
    ptrY.set(id, e.clientY)

    if (ptrIds.length >= 2) {
      const owner = ptrIds.indexOf(id)
      if (owner >= 0 && owner < 2) {
        touchReported.add(id)
        commitCoherentTouchGesture()
        if (touchReported.size > 0) scheduleTouchGestureCommit()
      }
      return
    }

    const dx = e.clientX - px
    const dy = e.clientY - py

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
      readEventNdc(e)
      panNdcX = inputNdcX
      panNdcY = inputNdcY
      if (!panGestureAnnounced && (dx !== 0 || dy !== 0)) {
        panGestureAnnounced = true
        bus.emit('camera:gesture', { kind: 'pan', pointer: e.pointerType === 'touch' ? 'touch' : 'mouse' })
      }
    }
  }

  function endPointer(e: PointerEvent): void {
    const wasMultiPointer = ptrIds.length >= 2
    const i = ptrIds.indexOf(e.pointerId)
    if (wasMultiPointer && i >= 0 && i < 2) {
      // A cancellation flushes already-delivered motion; its coordinates are
      // not a new hardware sample and are unreliable on some WebKit paths.
      if (e.type === 'pointerup') {
        ptrX.set(e.pointerId, e.clientX)
        ptrY.set(e.pointerId, e.clientY)
      }
      touchReported.add(e.pointerId)
      commitCoherentTouchGesture(true)
      if (mode === 'orbit') applyTouchTransform()
    }
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
    if (ptrIds.length >= 2) {
      if (i < 0 || i >= 2) return
      const ax = ptrX.get(ptrIds[0])
      const ay = ptrY.get(ptrIds[0])
      const bx = ptrX.get(ptrIds[1])
      const by = ptrY.get(ptrIds[1])
      if (ax !== undefined && ay !== undefined && bx !== undefined && by !== undefined) {
        beginRotateAt({ clientX: (ax + bx) * 0.5, clientY: (ay + by) * 0.5 })
        beginTouchGesture(ax, ay, bx, by)
      }
      return
    }
    clearTouchGesture()
    if (wasMultiPointer && ptrIds.length === 1 && mode === 'orbit') {
      const remaining = ptrIds[0]
      const x = ptrX.get(remaining)
      const y = ptrY.get(remaining)
      dragOrbit = false
      dragLook = false
      if (x !== undefined && y !== undefined) {
        dragPan = true
        beginPanAt({ clientX: x, clientY: y })
      }
      return
    }
    if (ptrIds.length === 0) {
      dragOrbit = false
      dragPan = false
      dragLook = false
      panAnchorValid = false
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
    if (
      ORBIT_ONLY_CODES.has(e.code)
      && mode !== 'orbit'
      && !(scriptedNow() && userMode === 'orbit')
    ) return
    interrupt()
    keys.add(e.code)
    // otherwise the page scrolls under us
    if (
      e.code === 'Space'
      || e.code.startsWith('Arrow')
      || e.code === 'PageUp'
      || e.code === 'PageDown'
      || ORBIT_ONLY_CODES.has(e.code)
    ) {
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
    keyboardOrbit = false
    clearTouchGesture()
    panAnchorValid = false
    rotateAnchorValid = false
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
  const offTourStop = bus.on('tour:stop', () => release())

  const prevTouchAction = domElement.style.touchAction
  domElement.style.touchAction = 'none'

  /* ---- orbit -------------------------------------------------------------*/

  /** Signed keyboard axes, shared by both modes. */
  function axisForward(): number {
    return (
      keys.has('KeyW') || (!shiftDown && keys.has('ArrowUp')) ? 1 : 0
    ) - (
      keys.has('KeyS') || (!shiftDown && keys.has('ArrowDown')) ? 1 : 0
    )
  }
  function axisStrafe(): number {
    return (
      keys.has('KeyD') || (!shiftDown && keys.has('ArrowRight')) ? 1 : 0
    ) - (
      keys.has('KeyA') || (!shiftDown && keys.has('ArrowLeft')) ? 1 : 0
    )
  }
  function axisTurn(): number {
    if (!shiftDown) return 0
    return (keys.has('ArrowLeft') ? 1 : 0) - (keys.has('ArrowRight') ? 1 : 0)
  }
  function axisTilt(): number {
    if (!shiftDown) return 0
    return (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0)
  }
  function axisZoom(): number {
    return (
      keys.has('Equal') || keys.has('NumpadAdd') ? 1 : 0
    ) - (
      keys.has('Minus') || keys.has('NumpadSubtract') ? 1 : 0
    )
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

  function allowedZoomScale(anchor: THREE.Vector3, scale: number): number {
    const startViolation = userEyeViolation(camera.position)
    _v2.copy(camera.position).sub(anchor).multiplyScalar(scale).add(anchor)
    if (userEyeViolation(_v2) <= startViolation) return scale
    if (startViolation > 0) return 1

    let lo = 0
    let hi = 1
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) * 0.5
      const q = lerp(1, scale, mid)
      _v2.copy(camera.position).sub(anchor).multiplyScalar(q).add(anchor)
      if (userEyeViolation(_v2) === 0) lo = mid
      else hi = mid
    }
    return lerp(1, scale, lo)
  }

  /** Dolly about the picked ground point; matched damping keeps it under the cursor. */
  function applyZoom(): void {
    if (pendingZoom === 1) return
    const requestedDist = clamp(distT * pendingZoom, MIN_DIST, MAX_DIST)
    pendingZoom = 1
    if (Math.abs(requestedDist - dist) < 1e-10) return

    rotateAnchorValid = false
    velTheta = 0
    velPhi = 0
    if (pickGroundOrCentre(zoomNdcX, zoomNdcY, _v1)) {
      const scale = allowedZoomScale(_v1, requestedDist / dist)
      pivotT.copy(pivot).sub(_v1).multiplyScalar(scale).add(_v1)
      distT = dist * scale
      zoomAnchored = true
    } else {
      _v2.set(zoomNdcX, zoomNdcY, 0.5).unproject(camera).sub(camera.position)
      if (_v2.lengthSq() < 1e-8) return
      _v2.normalize()
      _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
      _v2.sub(_fwd).multiplyScalar(dist - requestedDist)
      pivotT.copy(pivot).add(_v2)
      distT = requestedDist
      zoomAnchored = true
    }
  }

  /** Rebuild from the gesture baseline so partial contact delivery cannot leave path-dependent motion. */
  function applyTouchTransform(): void {
    if (!touchTransformDirty || !touchFrameActive || !rotateAnchorValid) return
    touchTransformDirty = false
    pivot.copy(touchBasePivot)
    pivotT.copy(touchBasePivotT)
    theta = touchBaseTheta
    phi = touchBasePhi
    dist = touchBaseDist
    distT = touchBaseDist
    zoomAnchored = false
    velTheta = 0
    velPhi = 0
    applyOrbitTransform()

    const requestedDist = clamp(touchBaseDist * touchScale, MIN_DIST, MAX_DIST)
    const scale = allowedZoomScale(rotateAnchor, requestedDist / touchBaseDist)
    if (Math.abs(scale - 1) >= 1e-12) {
      pivot.sub(rotateAnchor).multiplyScalar(scale).add(rotateAnchor)
      pivotT.sub(rotateAnchor).multiplyScalar(scale).add(rotateAnchor)
      dist = touchBaseDist * scale
      distT = dist
      applyOrbitTransform()
    }
    if (touchYaw !== 0) rotateOrbit(WORLD_UP, touchYaw)
    if (touchTilt !== 0) {
      _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
      const limitedTilt = clamp(phi + touchTilt, PHI_MIN, PHI_MAX) - phi
      if (limitedTilt !== 0) rotateOrbit(_right, limitedTilt)
    }
  }

  function tickOrbit(dt: number, sdt: number): void {
    inLookX = 0
    inLookY = 0
    applyTouchTransform()

    /* rotate eye and look target around the ground pick made at drag start */
    let yawStep = 0
    let pitchStep = 0
    if (dragOrbit && !touchFrameActive) {
      const kx = (Math.PI * 2 * inRotX) / viewH
      const ky = (Math.PI * 2 * inRotY) / viewH
      yawStep = -kx
      pitchStep = -ky
      velTheta = damp(velTheta, -kx / sdt, VEL_TRACK, sdt)
      velPhi = damp(velPhi, -ky / sdt, VEL_TRACK, sdt)
    } else if (!motionReduced()) {
      yawStep = velTheta * dt
      pitchStep = velPhi * dt
      velTheta = damp(velTheta, 0, SPIN_DECAY, dt)
      velPhi = damp(velPhi, 0, SPIN_DECAY, dt)
      if (velTheta < 1e-4 && velTheta > -1e-4) velTheta = 0
      if (velPhi < 1e-4 && velPhi > -1e-4) velPhi = 0
    } else {
      velTheta = 0
      velPhi = 0
    }
    const keyTurn = axisTurn()
    const keyTilt = axisTilt()
    if (!dragOrbit && (keyTurn !== 0 || keyTilt !== 0)) {
      if (!keyboardOrbit) beginRotateAtNdc(0, 0)
      keyboardOrbit = true
      yawStep += keyTurn * KEY_LOOK_RATE * dt
      pitchStep += keyTilt * KEY_LOOK_RATE * dt
    } else {
      keyboardOrbit = false
    }
    inRotX = 0
    inRotY = 0

    if (yawStep !== 0 && !rotateOrbit(WORLD_UP, yawStep)) velTheta = 0
    if (pitchStep !== 0) {
      _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
      const limitedPitch = clamp(phi + pitchStep, PHI_MIN, PHI_MAX) - phi
      if (limitedPitch !== pitchStep) velPhi = 0
      if (!rotateOrbit(_right, limitedPitch)) velPhi = 0
    }

    /* pan by solving the current cursor ray back to the ground grabbed on down */
    const wpp = (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(dist, 1)) / viewH
    _right.setFromMatrixColumn(camera.matrixWorld, 0)
    _upv.setFromMatrixColumn(camera.matrixWorld, 1)
    if (dragPan) {
      if (panAnchorValid && pickGround(panNdcX, panNdcY, _v2)) {
        _v1.copy(panAnchor).sub(_v2)
        _v1.y = 0
      } else {
        _v1.set(0, 0, 0)
        _v1.addScaledVector(_right, -inPanX * wpp)
        _v1.addScaledVector(_upv, inPanY * wpp)
      }
      translateOrbit(_v1)
      camera.updateMatrixWorld()
      _v2.copy(_v1).divideScalar(sdt)
      velPivot.x = damp(velPivot.x, _v2.x, VEL_TRACK, sdt)
      velPivot.y = damp(velPivot.y, _v2.y, VEL_TRACK, sdt)
      velPivot.z = damp(velPivot.z, _v2.z, VEL_TRACK, sdt)
    } else if (!motionReduced() && velPivot.lengthSq() > DEAD_VEL) {
      _v1.copy(velPivot).multiplyScalar(dt)
      translateOrbit(_v1)
      if (
        (camera.position.x <= -LIMIT_XZ && velPivot.x < 0)
        || (camera.position.x >= LIMIT_XZ && velPivot.x > 0)
      ) velPivot.x = 0
      if (
        (camera.position.y <= ORBIT_EYE_MIN_Y && velPivot.y < 0)
        || (camera.position.y >= LIMIT_Y_HI && velPivot.y > 0)
      ) velPivot.y = 0
      if (
        (camera.position.z <= -LIMIT_XZ && velPivot.z < 0)
        || (camera.position.z >= LIMIT_XZ && velPivot.z > 0)
      ) velPivot.z = 0
      camera.updateMatrixWorld()
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
      if (zoomAnchored) {
        pivotT.copy(pivot)
        distT = dist
        zoomAnchored = false
      }
      _v1.copy(kbVel).multiplyScalar(dt)
      translateOrbit(_v1)
      camera.updateMatrixWorld()
      rotateAnchorValid = false
    } else if (_v1.lengthSq() === 0) {
      kbVel.set(0, 0, 0) // no residual drift once the key is up
    }

    const zoomAxis = axisZoom()
    if (zoomAxis !== 0) {
      pendingZoom *= Math.exp(-zoomAxis * KEY_ZOOM_RATE * dt)
      zoomNdcX = 0
      zoomNdcY = 0
    }
    applyZoom()

    /* smoothed quantities chase their targets */
    distT = clamp(distT, MIN_DIST, MAX_DIST)
    const pivotRate = zoomAnchored ? DOLLY_RATE : PIVOT_RATE
    dist = damp(dist, distT, DOLLY_RATE, dt)
    pivot.lerp(pivotT, 1 - Math.exp(-pivotRate * dt))
    if (zoomAnchored && Math.abs(dist - distT) < 1e-6 && pivot.distanceToSquared(pivotT) < 1e-12) {
      dist = distT
      pivot.copy(pivotT)
      zoomAnchored = false
    }

    applyOrbitTransform()
  }

  function applyOrbitTransform(): void {
    _sph.radius = dist
    _sph.phi = phi
    _sph.theta = theta
    camera.position.setFromSpherical(_sph).add(pivot)
    camera.up.copy(WORLD_UP)
    camera.lookAt(pivot)
    camera.quaternion.normalize()
    camera.updateMatrixWorld()
  }

  /* ---- fly ---------------------------------------------------------------*/

  function tickFly(dt: number): void {
    yaw -= inLookX * LOOK_SENS
    pitch -= inLookY * LOOK_SENS
    yaw += axisTurn() * KEY_LOOK_RATE * dt
    pitch += axisTilt() * KEY_LOOK_RATE * dt
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
    rotateAnchorValid = false
    panAnchorValid = false
    zoomAnchored = false
    keyboardOrbit = false

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
    if (opts?.instant || motionReduced()) {
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
    if (back === 'orbit') applyOrbitTransform()
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
    if (zoomAnchored) {
      pivotT.copy(pivot)
      distT = dist
      zoomAnchored = false
    }
    if (Array.isArray(p)) _v1.set(p[0], p[1], p[2])
    else _v1.copy(p)
    _v2.copy(_v1).sub(pivot)
    _v2.x = clamp(camera.position.x + _v2.x, -LIMIT_XZ, LIMIT_XZ) - camera.position.x
    _v2.y = clamp(camera.position.y + _v2.y, ORBIT_EYE_MIN_Y, LIMIT_Y_HI) - camera.position.y
    _v2.z = clamp(camera.position.z + _v2.z, -LIMIT_XZ, LIMIT_XZ) - camera.position.z
    pivotT.copy(pivot).add(_v2)
    velPivot.set(0, 0, 0)
    rotateAnchorValid = false
    zoomAnchored = false
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
    touchTransformDirty = false
    rotateAnchorValid = false
    panAnchorValid = false
    zoomAnchored = false
    keyboardOrbit = false
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
    cancelTouchGestureCommit()
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
    offTourStop()
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
