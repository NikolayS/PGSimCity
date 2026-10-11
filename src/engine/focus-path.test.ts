import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { makeRng } from '../core/util'
import {
  BASELINE_FOCUS_DURATION,
  FocusMove,
  POLISH_FOCUS_TIMING,
  focusEase,
  focusPeakSpeedRatio,
  polishFocusDuration,
} from './focus-path'
import type { FocusStyle } from './focus-path'

const UP = new THREE.Vector3(0, 1, 0)
const SAMPLES = 40

function aim(eye: THREE.Vector3, at: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, at, UP))
}

interface Case {
  p0: THREE.Vector3
  look0: THREE.Vector3
  p1: THREE.Vector3
  target: THREE.Vector3
}

function begin(style: FocusStyle, c: Case): FocusMove {
  const move = new FocusMove()
  move.begin(style, c.p0, aim(c.p0, c.look0), c.p0.distanceTo(c.target), c.p1, aim(c.p1, c.target), c.target)
  return move
}

/** Degrees between the view axis and the subject at each sample. */
function framingErrors(move: FocusMove, target: THREE.Vector3): number[] {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const forward = new THREE.Vector3()
  const toTarget = new THREE.Vector3()
  const errors: number[] = []
  for (let i = 0; i <= SAMPLES; i++) {
    move.sample(i / SAMPLES, position, quaternion)
    forward.set(0, 0, -1).applyQuaternion(quaternion)
    toTarget.subVectors(target, position).normalize()
    errors.push(THREE.MathUtils.radToDeg(forward.angleTo(toTarget)))
  }
  return errors
}

/** City-scale moves from a seeded generator: eyes 60–360 m up, subjects on the plate. */
function seededCases(count: number, centred: boolean): Case[] {
  const rand = makeRng(0x5eed)
  const cases: Case[] = []
  for (let i = 0; i < count; i++) {
    const target = new THREE.Vector3((rand() - 0.5) * 600, rand() * 40, (rand() - 0.5) * 600)
    const p0 = new THREE.Vector3((rand() - 0.5) * 800, 60 + rand() * 300, (rand() - 0.5) * 800)
    const look0 = centred ? target.clone() : new THREE.Vector3((rand() - 0.5) * 600, 0, (rand() - 0.5) * 600)
    const dir = new THREE.Vector3(rand() - 0.5, 0.2 + rand() * 0.8, rand() - 0.5).normalize()
    const p1 = target.clone().addScaledVector(dir, 30 + rand() * 200)
    cases.push({ p0, look0, p1, target })
  }
  return cases
}

describe('polished focus framing', () => {
  it('keeps a subject that starts centred exactly centred for the whole move', () => {
    let baselineWorst = 0
    let aimed = 0
    for (const c of seededCases(120, true)) {
      const polish = begin('polish', c)
      if (!polish.aimed) continue
      aimed++
      expect(Math.max(...framingErrors(polish, c.target))).toBeLessThan(0.01)
      baselineWorst = Math.max(baselineWorst, ...framingErrors(begin('baseline', c), c.target))
    }
    expect(aimed).toBeGreaterThan(90)
    // The defect being addressed: independent lerp/slerp lets the subject drift.
    expect(baselineWorst).toBeGreaterThan(10)
  })

  /* Not strictly monotone: the eye's own motion can open the angle by a few
   * degrees before the aim catches up. Baseline swings by tens of degrees. */
  it('swings an off-centre subject at most a few degrees past where it started', () => {
    let baselineSwing = 0
    for (const c of seededCases(200, false)) {
      const polish = begin('polish', c)
      if (!polish.aimed) continue
      const errors = framingErrors(polish, c.target)
      expect(Math.max(...errors) - errors[0]).toBeLessThan(5)
      expect(errors[SAMPLES]).toBeLessThan(1e-3)
      const baseline = framingErrors(begin('baseline', c), c.target)
      baselineSwing = Math.max(baselineSwing, Math.max(...baseline) - baseline[0])
    }
    expect(baselineSwing).toBeGreaterThan(20)
  })

  it('starts on the current pose and ends on the same pose as baseline', () => {
    const c = seededCases(1, false)[0]
    const polish = begin('polish', c)
    const baseline = begin('baseline', c)
    expect(polish.aimed).toBe(true)
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const bp = new THREE.Vector3()
    const bq = new THREE.Quaternion()

    polish.sample(0, p, q)
    expect(p.distanceTo(c.p0)).toBeLessThan(1e-9)
    expect(q.angleTo(aim(c.p0, c.look0))).toBeLessThan(1e-5)

    polish.sample(1, p, q)
    baseline.sample(1, bp, bq)
    expect(p.equals(bp)).toBe(true)
    expect(q.equals(bq)).toBe(true)
  })

  it('falls back to the baseline slerp where lookAt cannot steer', () => {
    const target = new THREE.Vector3(0, 0, 0)
    // Subject directly behind the eye: the aim would pass through the eye.
    const reverse: Case = {
      p0: new THREE.Vector3(0, 80, 200),
      look0: new THREE.Vector3(0, 0, 400),
      p1: new THREE.Vector3(0, 60, 120),
      target,
    }
    expect(begin('polish', reverse).aimed).toBe(false)

    // Plan view: straight down has no yaw for lookAt to keep.
    const plan: Case = {
      p0: new THREE.Vector3(0, 900, 0.01),
      look0: target,
      p1: new THREE.Vector3(80, 120, 80),
      target,
    }
    expect(begin('polish', plan).aimed).toBe(false)

    // Rolled start orientation: lookAt would snap the horizon on frame one.
    const rolled = new FocusMove()
    const p0 = new THREE.Vector3(0, 80, 200)
    const q0 = aim(p0, target).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.2))
    const p1 = new THREE.Vector3(40, 60, 100)
    rolled.begin('polish', p0, q0, p0.distanceTo(target), p1, aim(p1, target), target)
    expect(rolled.aimed).toBe(false)

    expect(begin('baseline', seededCases(1, true)[0]).aimed).toBe(false)
  })
})

describe('polished focus timing', () => {
  it('has a lower peak speed than baseline for every travel distance', () => {
    for (const travel of [1, 10, 40, 120, 400, 900, 2000]) {
      const baselinePeak = (focusPeakSpeedRatio('baseline') * travel) / BASELINE_FOCUS_DURATION
      const polishPeak = (focusPeakSpeedRatio('polish') * travel) / polishFocusDuration(travel)
      expect(polishPeak, `${travel} m`).toBeLessThan(baselinePeak)
    }
  })

  it('reports peak ratios that match the ease curves themselves', () => {
    for (const style of ['baseline', 'polish'] as const) {
      let peak = 0
      const h = 1e-4
      for (let u = h; u < 1 - h; u += 1e-3) {
        peak = Math.max(peak, (focusEase(style, u + h) - focusEase(style, u - h)) / (2 * h))
      }
      expect(peak).toBeCloseTo(focusPeakSpeedRatio(style), 2)
      expect(focusEase(style, 0)).toBe(0)
      expect(focusEase(style, 1)).toBeCloseTo(1, 12)
    }
  })

  it('grows monotonically with travel inside a bounded window', () => {
    let previous = 0
    for (let travel = 0; travel <= 3000; travel += 25) {
      const d = polishFocusDuration(travel)
      expect(d).toBeGreaterThanOrEqual(previous)
      expect(d).toBeGreaterThanOrEqual(POLISH_FOCUS_TIMING.min)
      expect(d).toBeLessThanOrEqual(POLISH_FOCUS_TIMING.max)
      previous = d
    }
  })
})
