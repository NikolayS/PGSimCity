import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import { installTestDom } from '../../test/dom'
import { createCameraRig, type CameraRig } from './camera'
import type { FocusStyle } from './focus-path'

vi.mock('../world/slonik', () => ({
  PLAN_UP: [0, 1],
  sampleOutline: () => [-100, -100, 100, -100, 100, 100, -100, 100],
}))

let rigs: CameraRig[] = []

function createRig(reducedMotion = false): { camera: THREE.PerspectiveCamera; rig: CameraRig } {
  const testDom = installTestDom()
  const dom = testDom.mount('camera-surface') as unknown as HTMLElement
  Object.defineProperties(dom, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, width: 800, height: 600 }) },
    setPointerCapture: { value: () => {} },
    releasePointerCapture: { value: () => {} },
    hasPointerCapture: { value: () => false },
  })
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 3000)
  const rig = createCameraRig(camera, dom, createBus(), { reducedMotion })
  rigs.push(rig)
  return { camera, rig }
}

afterEach(() => {
  for (const rig of rigs) rig.dispose()
  rigs = []
})

/** Degrees between the view axis and `target`. */
function framingError(camera: THREE.PerspectiveCamera, target: THREE.Vector3): number {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const toTarget = target.clone().sub(camera.position).normalize()
  return THREE.MathUtils.radToDeg(forward.angleTo(toTarget))
}

/** Re-frame the subject already at the centre of the view from a new side. */
function worstDriftDuringRefocus(style: FocusStyle): number {
  const { camera, rig } = createRig()
  rig.focusStyle = style
  const subject = rig.pivot.clone()
  expect(framingError(camera, subject)).toBeLessThan(0.01)
  rig.focusOn({ target: [subject.x, subject.y, subject.z], distance: 90, dir: [-1, 0.6, -0.2] })
  let worst = 0
  for (let i = 0; i < 200 && rig.mode === 'focus'; i++) {
    rig.update(1 / 60)
    worst = Math.max(worst, framingError(camera, subject))
  }
  expect(rig.mode).toBe('orbit')
  return worst
}

describe('focus style switching', () => {
  it('changes nothing about the current view when toggled', () => {
    const { camera, rig } = createRig()
    rig.update(1 / 60)
    const position = camera.position.clone()
    const quaternion = camera.quaternion.clone()
    const pivot = rig.pivot.clone()
    rig.focusStyle = 'polish'
    rig.update(1 / 60)
    rig.focusStyle = 'baseline'
    rig.update(1 / 60)
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-9)
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-9)
    expect(rig.pivot.distanceTo(pivot)).toBeLessThan(1e-9)
    expect(rig.mode).toBe('orbit')
  })

  it('keeps a centred subject centred through a real polished refocus', () => {
    expect(worstDriftDuringRefocus('polish')).toBeLessThan(0.05)
    expect(worstDriftDuringRefocus('baseline')).toBeGreaterThan(1)
  })

  it('keeps a close centred subject framed even inside the orbit minimum', () => {
    const { camera, rig } = createRig()
    const subject = new THREE.Vector3(0, 0, 0)
    camera.position.set(0, 8, 8)
    camera.lookAt(subject)
    rig.focusStyle = 'polish'
    rig.focusOn({ target: [0, 0, 0], distance: 90, dir: [-1, 0.6, -0.2] })
    let worst = 0
    for (let i = 0; i < 200 && rig.mode === 'focus'; i++) {
      rig.update(1 / 60)
      worst = Math.max(worst, framingError(camera, subject))
    }
    expect(worst).toBeLessThan(0.05)
  })

  it('lets a move already in flight finish on the path it started', () => {
    const run = (switchMidway: boolean): THREE.Vector3[] => {
      const { camera, rig } = createRig()
      rig.focusStyle = 'polish'
      rig.focusOn({ target: [60, 0, -40], distance: 120, dir: [0.3, 0.7, 1] }, { duration: 1 })
      const samples: THREE.Vector3[] = []
      for (let i = 0; i < 30; i++) {
        if (switchMidway && i === 10) rig.focusStyle = 'baseline'
        rig.update(1 / 30)
        samples.push(camera.position.clone())
      }
      return samples
    }
    const steady = run(false)
    const switched = run(true)
    for (let i = 0; i < steady.length; i++) expect(switched[i].distanceTo(steady[i])).toBeLessThan(1e-9)
  })

  it('still cuts instantly for a reader who asked for reduced motion', () => {
    const { camera, rig } = createRig(true)
    rig.focusStyle = 'polish'
    rig.focusOn({ target: [60, 0, -40], distance: 120, dir: [0.3, 0.7, 1] })
    expect(rig.mode).toBe('orbit')
    expect(framingError(camera, new THREE.Vector3(60, 0, -40))).toBeLessThan(0.01)
  })

  it('honours a caller-supplied duration instead of the travel-scaled one', () => {
    const { rig } = createRig()
    rig.focusStyle = 'polish'
    rig.focusOn({ target: [10, 0, 10], distance: 100, dir: [0, 1, 1] }, { duration: 2.5 })
    for (let i = 0; i < 120; i++) rig.update(1 / 60)
    expect(rig.mode).toBe('focus')
    for (let i = 0; i < 40; i++) rig.update(1 / 60)
    expect(rig.mode).toBe('orbit')
  })
})
