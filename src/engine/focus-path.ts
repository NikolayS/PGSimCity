import * as THREE from 'three'
import { clamp, clamp01, easeInOutCubic } from '../core/util'

/* ============================================================================
 * Scripted focus moves.
 *
 * Baseline lerps the eye and slerps the orientation independently, so the
 * subject can drift off-centre mid-move even when it started centred. The
 * polished path instead interpolates the point being looked at, from the
 * current view toward the subject, and aims along it: a subject already in the
 * centre of the view stays exactly there while the camera moves. It reuses the
 * tour's constant-speed easing and scales duration with travel. Both styles end
 * on the identical pose; the polished one is opt-in (?visual=polish).
 * ==========================================================================*/

export type FocusStyle = 'baseline' | 'polish'

/** Fraction of a move spent accelerating, and again decelerating. */
export const PATH_EASE = 0.18

/**
 * Arc-length reparameterisation with smoothstep ramps at the ends only:
 * constant speed through the middle of a shot, no dead-stop feel.
 * ∫ smoothstep = x³ − x⁴/2, which is 0.5 at x = 1.
 */
export function easeEnds(t: number, a = PATH_EASE): number {
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

/** Baseline's fixed scripted-focus duration, seconds. */
export const BASELINE_FOCUS_DURATION = 1.05

export const POLISH_FOCUS_TIMING = {
  /** Shortest move: a near-zero reframe still reads as motion, not a cut. */
  min: 0.7,
  /** Longest move: the reader is waiting, so a cross-city flight stays brisk. */
  max: 1.35,
  /** Seconds added per doubling of travel beyond `reference` metres. */
  perDoubling: 0.17,
  reference: 30,
} as const

/** Duration for a move whose eye or look point travels `travel` metres. */
export function polishFocusDuration(travel: number): number {
  const t = POLISH_FOCUS_TIMING
  const doublings = Math.log2(1 + Math.max(0, travel) / t.reference)
  return clamp(t.min + t.perDoubling * doublings, t.min, t.max)
}

/** Normalised ease for a style; both satisfy f(0) = 0 and f(1) = 1. */
export function focusEase(style: FocusStyle, u: number): number {
  return style === 'polish' ? easeEnds(u) : easeInOutCubic(u)
}

/** Peak speed of an ease curve as a multiple of the move's average speed. */
export function focusPeakSpeedRatio(style: FocusStyle): number {
  // easeInOutCubic peaks at 3x mid-move; easeEnds' flat middle is 1 / (1 - a).
  return style === 'polish' ? 1 / (1 - PATH_EASE) : 3
}

/** A polished aim is only used when both endpoints are steerable by lookAt. */
const MAX_START_ROLL_RAD = THREE.MathUtils.degToRad(0.5)
const MIN_TURN_DOT = -0.2
const MAX_VERTICAL = 0.98

const UP = new THREE.Vector3(0, 1, 0)
const _m4 = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _fwd0 = new THREE.Vector3()
const _fwd1 = new THREE.Vector3()
const _look = new THREE.Vector3()

/** Endpoint data captured once at the start of a move; sampled every frame. */
export class FocusMove {
  style: FocusStyle = 'baseline'
  /** Whether the polished aim is in use for this move. */
  aimed = false
  readonly p0 = new THREE.Vector3()
  readonly p1 = new THREE.Vector3()
  readonly q0 = new THREE.Quaternion()
  readonly q1 = new THREE.Quaternion()
  readonly look0 = new THREE.Vector3()
  readonly look1 = new THREE.Vector3()

  /**
   * `d0` is the subject's distance from the starting eye: the starting look
   * point sits that far along the current view, so the first frame is unchanged.
   */
  begin(
    style: FocusStyle,
    p0: THREE.Vector3,
    q0: THREE.Quaternion,
    d0: number,
    p1: THREE.Vector3,
    q1: THREE.Quaternion,
    target: THREE.Vector3,
  ): void {
    this.style = style
    this.p0.copy(p0)
    this.q0.copy(q0)
    this.p1.copy(p1)
    this.q1.copy(q1)
    this.look1.copy(target)
    _fwd0.set(0, 0, -1).applyQuaternion(q0)
    this.look0.copy(p0).addScaledVector(_fwd0, Math.max(1e-3, d0))
    this.aimed = style === 'polish' && this.canAim()
  }

  /** Larger of eye travel and look-point travel, metres. */
  travel(): number {
    return Math.max(this.p0.distanceTo(this.p1), this.look0.distanceTo(this.look1))
  }

  /** Writes the pose at normalised time `u` into `position` and `quaternion`. */
  sample(u: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    if (u >= 1) {
      position.copy(this.p1)
      quaternion.copy(this.q1)
      return
    }
    const k = focusEase(this.style, u)
    position.lerpVectors(this.p0, this.p1, k)
    if (!this.aimed) {
      quaternion.slerpQuaternions(this.q0, this.q1, k)
      return
    }
    _look.lerpVectors(this.look0, this.look1, k)
    _m4.lookAt(position, _look, UP)
    quaternion.setFromRotationMatrix(_m4)
  }

  /** Distance from `position` to the interpolated look point at time `u`. */
  lookDistance(u: number, position: THREE.Vector3): number {
    _look.lerpVectors(this.look0, this.look1, focusEase(this.style, u))
    return position.distanceTo(_look)
  }

  /* lookAt cannot express roll, a turn through the reverse direction makes
   * the interpolated aim pass through the eye, and near-vertical views lose
   * yaw. Any of those falls back to the baseline slerp for the whole move. */
  private canAim(): boolean {
    _m4.lookAt(this.p0, this.look0, UP)
    _q.setFromRotationMatrix(_m4)
    if (_q.angleTo(this.q0) > MAX_START_ROLL_RAD) return false
    _fwd0.subVectors(this.look0, this.p0).normalize()
    _fwd1.subVectors(this.look1, this.p1)
    if (_fwd1.lengthSq() < 1e-8) return false
    _fwd1.normalize()
    if (Math.abs(_fwd0.y) > MAX_VERTICAL || Math.abs(_fwd1.y) > MAX_VERTICAL) return false
    return _fwd0.dot(_fwd1) > MIN_TURN_DOT
  }
}
