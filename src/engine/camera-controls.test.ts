import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import type { Bus } from '../core/types'
import { installTestDom } from '../../test/dom'
import { CITY } from '../world/layout'
import { createCameraRig, type CameraRig } from './camera'

vi.mock('../world/slonik', () => ({
  PLAN_UP: [0, 1],
  sampleOutline: () => [-100, -100, 100, -100, 100, 100, -100, 100],
}))

interface RigFixture {
  camera: THREE.PerspectiveCamera
  dom: HTMLElement
  bus: Bus
  rig: CameraRig
}

function createRigFixture(): RigFixture {
  const testDom = installTestDom()
  const dom = testDom.mount('camera-surface') as unknown as HTMLElement
  Object.defineProperties(dom, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
    getBoundingClientRect: {
      value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    },
    setPointerCapture: { value: () => {} },
    releasePointerCapture: { value: () => {} },
    hasPointerCapture: { value: () => false },
  })
  const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 3000)
  const bus = createBus()
  const rig = createCameraRig(camera, dom, bus)
  return { camera, dom, bus, rig }
}

function pointer(
  type: string,
  init: {
    pointerId?: number
    pointerType?: string
    button?: number
    clientX: number
    clientY: number
    shiftKey?: boolean
  },
): Event {
  const event = new Event(type, { cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? 'mouse' },
    button: { value: init.button ?? 0 },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
    movementX: { value: 0 },
    movementY: { value: 0 },
    shiftKey: { value: init.shiftKey ?? false },
    ctrlKey: { value: false },
    metaKey: { value: false },
  })
  return event
}

function drag(
  dom: HTMLElement,
  opts: { button: number; shiftKey?: boolean; from?: [number, number]; to?: [number, number] },
): void {
  const [x0, y0] = opts.from ?? [280, 260]
  const [x1, y1] = opts.to ?? [340, 305]
  dom.dispatchEvent(
    pointer('pointerdown', {
      button: opts.button,
      clientX: x0,
      clientY: y0,
      shiftKey: opts.shiftKey,
    }),
  )
  dom.dispatchEvent(
    pointer('pointermove', {
      button: opts.button,
      clientX: x1,
      clientY: y1,
      shiftKey: opts.shiftKey,
    }),
  )
}

function wheel(dom: HTMLElement, deltaY: number, at: [number, number] = [400, 300]): void {
  const event = new Event('wheel', { cancelable: true })
  Object.defineProperties(event, {
    deltaY: { value: deltaY },
    deltaMode: { value: 0 },
    clientX: { value: at[0] },
    clientY: { value: at[1] },
  })
  dom.dispatchEvent(event)
}

function key(type: 'keydown' | 'keyup', code: string, shiftKey = false): Event {
  const event = new Event(type, { cancelable: true })
  Object.defineProperties(event, {
    code: { value: code },
    key: { value: code.startsWith('Arrow') ? code : code.replace('Key', '') },
    shiftKey: { value: shiftKey },
    altKey: { value: false },
    ctrlKey: { value: false },
    metaKey: { value: false },
    repeat: { value: false },
  })
  return event
}

function groundPointAt(camera: THREE.PerspectiveCamera, clientX: number, clientY: number): THREE.Vector3 {
  const origin = camera.position.clone()
  const direction = new THREE.Vector3(clientX / 400 - 1, 1 - clientY / 300, 0.5)
    .unproject(camera)
    .sub(origin)
    .normalize()
  const distance = -origin.y / direction.y
  expect(distance).toBeGreaterThan(0)
  return origin.addScaledVector(direction, distance)
}

function expectAtScreenPoint(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3,
  clientX: number,
  clientY: number,
  tolerance = 1e-6,
): void {
  const projected = point.clone().project(camera)
  expect(Math.hypot(projected.x - (clientX / 400 - 1), projected.y - (1 - clientY / 300))).toBeLessThan(tolerance)
}

function signedYawAround(
  anchor: THREE.Vector3,
  before: THREE.Vector3,
  after: THREE.Vector3,
): number {
  const ax = before.x - anchor.x
  const az = before.z - anchor.z
  const bx = after.x - anchor.x
  const bz = after.z - anchor.z
  return Math.atan2(az * bx - ax * bz, ax * bx + az * bz)
}

function signedTiltAround(anchor: THREE.Vector3, before: THREE.Vector3, after: THREE.Vector3): number {
  const elevation = (point: THREE.Vector3): number => Math.atan2(
    point.y - anchor.y,
    Math.hypot(point.x - anchor.x, point.z - anchor.z),
  )
  return elevation(after) - elevation(before)
}

function screenErrorPx(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3,
  clientX: number,
  clientY: number,
): number {
  const projected = point.clone().project(camera)
  return Math.hypot(
    (projected.x - (clientX / 400 - 1)) * 400,
    (projected.y - (1 - clientY / 300)) * 300,
  )
}

function beginTwoFingerGesture(fixture: RigFixture, a: [number, number], b: [number, number]): void {
  fixture.dom.dispatchEvent(
    pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: a[0], clientY: a[1] }),
  )
  fixture.dom.dispatchEvent(
    pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: b[0], clientY: b[1] }),
  )
  fixture.dom.dispatchEvent(
    pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: a[0], clientY: a[1] }),
  )
  fixture.dom.dispatchEvent(
    pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: b[0], clientY: b[1] }),
  )
  fixture.rig.update(1 / 60)
}

function moveTouch(fixture: RigFixture, pointerId: number, point: [number, number]): void {
  fixture.dom.dispatchEvent(
    pointer('pointermove', {
      pointerId,
      pointerType: 'touch',
      clientX: point[0],
      clientY: point[1],
    }),
  )
}

function settlePointerBatch(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function moveTouchPair(
  fixture: RigFixture,
  a: [number, number],
  b: [number, number],
  updateAfterEachEvent = false,
): void {
  moveTouch(fixture, 1, a)
  if (updateAfterEachEvent) fixture.rig.update(1 / 60)
  moveTouch(fixture, 2, b)
  fixture.rig.update(1 / 60)
}

function rotatePoint(point: [number, number], centre: [number, number], angle: number): [number, number] {
  const dx = point[0] - centre[0]
  const dy = point[1] - centre[1]
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return [centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos]
}

interface GestureMeasurement {
  yaw: number
  distance: number
  anchorError: number
  position: THREE.Vector3
  pivot: THREE.Vector3
  quaternion: THREE.Quaternion
}

function measureParallelSwipe(
  fixture: RigFixture,
  distance: number,
  steps: number,
  interleaved: boolean,
): GestureMeasurement {
  fixture.rig.focusOn(
    { target: [1210, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
    { instant: true },
  )
  const anchor = groundPointAt(fixture.camera, 400, 300)
  const eyeBefore = fixture.camera.position.clone()
  beginTwoFingerGesture(fixture, [350, 300], [450, 300])

  for (let step = 1; step <= steps; step++) {
    const dx = (distance * step) / steps
    fixture.dom.dispatchEvent(
      pointer('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 350 + dx,
        clientY: 300,
      }),
    )
    if (interleaved) fixture.rig.update(1 / 60)
    fixture.dom.dispatchEvent(
      pointer('pointermove', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 450 + dx,
        clientY: 300,
      }),
    )
    fixture.rig.update(1 / 60)
  }

  return {
    yaw: signedYawAround(anchor, eyeBefore, fixture.camera.position),
    distance: fixture.camera.position.distanceTo(fixture.rig.pivot),
    anchorError: screenErrorPx(fixture.camera, anchor, 400, 300),
    position: fixture.camera.position.clone(),
    pivot: fixture.rig.pivot.clone(),
    quaternion: fixture.camera.quaternion.clone(),
  }
}

type GestureUpdateCadence = 'event' | 'pair' | 'end'

function measureMixedSwipe(fixture: RigFixture, cadence: GestureUpdateCadence): GestureMeasurement {
  fixture.rig.focusOn(
    { target: [1210, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
    { instant: true },
  )
  const anchor = groundPointAt(fixture.camera, 400, 300)
  const eyeBefore = fixture.camera.position.clone()
  beginTwoFingerGesture(fixture, [350, 300], [450, 300])

  for (let step = 1; step <= 10; step++) {
    const progress = step / 10
    const midpoint = 400 + 60 * progress
    const halfSpan = 50 + 12.5 * progress
    moveTouch(fixture, 1, [midpoint - halfSpan, 300])
    if (cadence === 'event') fixture.rig.update(1 / 60)
    moveTouch(fixture, 2, [midpoint + halfSpan, 300])
    if (cadence !== 'end') fixture.rig.update(1 / 60)
  }
  if (cadence === 'end') fixture.rig.update(1 / 60)

  return {
    yaw: signedYawAround(anchor, eyeBefore, fixture.camera.position),
    distance: fixture.camera.position.distanceTo(fixture.rig.pivot),
    anchorError: screenErrorPx(fixture.camera, anchor, 400, 300),
    position: fixture.camera.position.clone(),
    pivot: fixture.rig.pivot.clone(),
    quaternion: fixture.camera.quaternion.clone(),
  }
}

function measureTerminalSwipe(
  fixture: RigFixture,
  terminalEvent: 'pointerup' | 'pointercancel',
): GestureMeasurement {
  fixture.rig.focusOn(
    { target: [1210, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
    { instant: true },
  )
  const anchor = groundPointAt(fixture.camera, 400, 300)
  const eyeBefore = fixture.camera.position.clone()
  beginTwoFingerGesture(fixture, [350, 300], [450, 300])

  for (let step = 1; step <= 20; step++) {
    const dx = (60 * step) / 20
    moveTouch(fixture, 1, [350 + dx, 300])
    moveTouch(fixture, 2, [450 + dx, 300])
  }
  fixture.dom.dispatchEvent(
    pointer(terminalEvent, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 410,
      clientY: 300,
    }),
  )
  fixture.rig.update(1 / 60)

  return {
    yaw: signedYawAround(anchor, eyeBefore, fixture.camera.position),
    distance: fixture.camera.position.distanceTo(fixture.rig.pivot),
    anchorError: screenErrorPx(fixture.camera, anchor, 400, 300),
    position: fixture.camera.position.clone(),
    pivot: fixture.rig.pivot.clone(),
    quaternion: fixture.camera.quaternion.clone(),
  }
}

describe('map camera mouse controls', () => {
  let fixture: RigFixture

  beforeEach(() => {
    fixture = createRigFixture()
  })

  afterEach(() => {
    fixture.rig.dispose()
  })

  it('plain left-drag pans without rotating', () => {
    const pivotBefore = fixture.rig.pivot.clone()
    const rotationBefore = fixture.camera.quaternion.clone()

    drag(fixture.dom, { button: 0 })
    fixture.rig.update(1 / 60)

    expect(fixture.rig.pivot.distanceTo(pivotBefore)).toBeGreaterThan(0.1)
    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeLessThan(1e-8)
  })

  it('shift + left-drag rotates and tilts around the ground under the cursor', () => {
    const anchor = groundPointAt(fixture.camera, 280, 260)
    const rotationBefore = fixture.camera.quaternion.clone()

    drag(fixture.dom, { button: 0, shiftKey: true })
    fixture.rig.update(1 / 60)

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
    expectAtScreenPoint(fixture.camera, anchor, 280, 260)
  })

  it('turns from a keyboard-only orbit sequence without losing the viewport-centre anchor', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const rotationBefore = fixture.camera.quaternion.clone()

    window.dispatchEvent(key('keydown', 'ArrowLeft', true))
    fixture.rig.update(0.1)
    window.dispatchEvent(key('keyup', 'ArrowLeft'))

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
    expectAtScreenPoint(fixture.camera, anchor, 400, 300)
  })

  it('looks around in fly mode from the same keyboard-only turn and tilt chords', () => {
    fixture.rig.setMode('fly')
    const rotationBefore = fixture.camera.quaternion.clone()

    window.dispatchEvent(key('keydown', 'ArrowLeft', true))
    window.dispatchEvent(key('keydown', 'ArrowUp', true))
    fixture.rig.update(0.1)
    window.dispatchEvent(key('keyup', 'ArrowLeft'))
    window.dispatchEvent(key('keyup', 'ArrowUp'))

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
  })

  it.each([
    { place: 'centre', x: 0, distance: 48 },
    { place: 'centre', x: 0, distance: 180 },
    { place: 'centre', x: 0, distance: 620 },
    { place: 'edge', x: 1195, distance: 48 },
    { place: 'edge', x: 1195, distance: 180 },
    { place: 'edge', x: 1195, distance: 620 },
  ])('keeps the viewport-centre ground point fixed after rotation at the $place from distance $distance', ({ place, x, distance }) => {
    fixture.rig.focusOn({ target: [x, 18, 0], distance, dir: [-0.35, 0.55, 0.76] }, { instant: true })
    const anchor = groundPointAt(fixture.camera, 400, 300)
    if (place === 'edge') expect(anchor.x).toBeGreaterThan(1200)

    drag(fixture.dom, { button: 0, shiftKey: true, from: [400, 300], to: [424, 318] })
    fixture.rig.update(1 / 60)

    expectAtScreenPoint(fixture.camera, anchor, 400, 300)
  })

  it('keeps the picked ground point fixed through a cursor zoom at the map edge', () => {
    const cursor: [number, number] = [650, 390]
    fixture.rig.focusOn({ target: [1195, 0, 0], distance: 80, dir: [-0.35, 0.55, 0.76] }, { instant: true })
    const anchor = groundPointAt(fixture.camera, cursor[0], cursor[1])
    expect(anchor.x).toBeGreaterThan(1200)

    wheel(fixture.dom, 650, cursor)
    for (let frame = 0; frame < 45; frame++) {
      fixture.rig.update(1 / 60)
      expectAtScreenPoint(fixture.camera, anchor, cursor[0], cursor[1])
    }
    expect(fixture.camera.position.x).toBeLessThanOrEqual(1200)
  })

  it('clips an edge rotation at the eye bound without moving its ground anchor', () => {
    fixture.rig.focusOn({ target: [1210, 0, 0], distance: 48, dir: [-1, 0.5, 0] }, { instant: true })
    const anchor = groundPointAt(fixture.camera, 400, 300)

    drag(fixture.dom, { button: 0, shiftKey: true, from: [400, 300], to: [250, 300] })
    fixture.rig.update(1 / 60)

    expect(anchor.x).toBeGreaterThan(1200)
    expect(fixture.camera.position.x).toBeLessThanOrEqual(1200)
    expectAtScreenPoint(fixture.camera, anchor, 400, 300)
  })

  it('keeps grabbed ground under the cursor throughout a close high-tilt pan', () => {
    const from: [number, number] = [360, 390]
    fixture.rig.focusOn({ target: [0, 0, 0], distance: 36, dir: [-0.2, 0.18, 0.96] }, { instant: true })
    const anchor = groundPointAt(fixture.camera, from[0], from[1])
    fixture.dom.dispatchEvent(pointer('pointerdown', { button: 0, clientX: from[0], clientY: from[1] }))

    for (const to of [[400, 400], [455, 415], [510, 430]] as const) {
      fixture.dom.dispatchEvent(pointer('pointermove', { button: 0, clientX: to[0], clientY: to[1] }))
      fixture.rig.update(1 / 60)
      expectAtScreenPoint(fixture.camera, anchor, to[0], to[1])
    }
  })

  it('does not tilt the orbit eye below the ground', () => {
    fixture.rig.focusOn({ target: [0, 0, 0], distance: 40, dir: [0, 0.2, 1] }, { instant: true })

    drag(fixture.dom, { button: 0, shiftKey: true, from: [400, 300], to: [400, -1000] })
    fixture.rig.update(1 / 60)

    expect(fixture.camera.position.y).toBeGreaterThanOrEqual(0)
  })

  it('allows an out-of-bounds scripted framing to rotate back toward the city', () => {
    fixture.rig.focusOn({ target: [0, 0, 0], distance: 1000, dir: [0, 0.95, 0.31] }, { instant: true })
    const eyeBefore = fixture.camera.position.clone()
    const rotationBefore = fixture.camera.quaternion.clone()
    expect(eyeBefore.y).toBeGreaterThan(900)

    drag(fixture.dom, { button: 0, shiftKey: true, from: [400, 300], to: [400, 240] })
    fixture.rig.update(1 / 60)

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
    expect(fixture.camera.position.y).toBeLessThan(eyeBefore.y)
  })

  it('produces the same two-finger result regardless of pointermove ordering', () => {
    const batched = measureParallelSwipe(fixture, 180, 12, false)
    fixture.rig.dispose()
    fixture = createRigFixture()
    const interleaved = measureParallelSwipe(fixture, 180, 12, true)

    expect(interleaved.position.distanceTo(batched.position)).toBeLessThan(1e-6)
    expect(interleaved.pivot.distanceTo(batched.pivot)).toBeLessThan(1e-6)
    expect(Math.abs(interleaved.yaw - batched.yaw)).toBeLessThan(1e-10)
    expect(Math.abs(1 - Math.abs(interleaved.quaternion.dot(batched.quaternion)))).toBeLessThan(1e-12)
    expect(Math.abs(interleaved.distance - batched.distance)).toBeLessThan(1e-8)
    expect(interleaved.anchorError).toBeLessThan(1e-5)
  })

  it('does not add off-centre midpoint travel to pivot-twist yaw', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const turn = Math.PI / 3
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const rotate = (x: number, y: number): [number, number] => {
      const dx = x - 400
      const dy = y - 100
      return [400 + dx * cos - dy * sin, 100 + dx * sin + dy * cos]
    }
    const a = rotate(350, 300)
    const b = rotate(450, 300)

    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: a[0], clientY: a[1] }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: b[0], clientY: b[1] }),
    )
    fixture.rig.update(1 / 60)

    const yaw = signedYawAround(anchor, eyeBefore, fixture.camera.position)
    expect(yaw).toBeGreaterThan(0)
    expect(yaw / turn).toBeGreaterThan(0.8)
    expect(yaw / turn).toBeLessThan(1.2)
    expectAtScreenPoint(fixture.camera, anchor, 400, 300)
  })

  it('keeps asymmetric diagonal pinch free of yaw and tilt', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const distanceBefore = fixture.camera.position.distanceTo(fixture.rig.pivot)
    beginTwoFingerGesture(fixture, [360, 260], [440, 340])

    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 340, clientY: 240 }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 462, clientY: 362 }),
    )
    fixture.rig.update(1 / 60)

    const yaw = signedYawAround(anchor, eyeBefore, fixture.camera.position)
    const tilt = signedTiltAround(anchor, eyeBefore, fixture.camera.position)
    expect(Math.abs(yaw)).toBeLessThan((Math.PI / 180) * 0.1)
    expect(Math.abs(tilt)).toBeLessThan((Math.PI / 180) * 0.1)
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeLessThan(distanceBefore * 0.8)
  })

  it('rotates monotonically with an interleaved parallel two-finger swipe', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const yawByDistance: number[] = []
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])

    for (let step = 1; step <= 4; step++) {
      fixture.dom.dispatchEvent(
        pointer('pointermove', {
          pointerId: 1,
          pointerType: 'touch',
          clientX: 350 + step * 15,
          clientY: 300,
        }),
      )
      fixture.rig.update(1 / 60)
      fixture.dom.dispatchEvent(
        pointer('pointermove', {
          pointerId: 2,
          pointerType: 'touch',
          clientX: 450 + step * 15,
          clientY: 300,
        }),
      )
      fixture.rig.update(1 / 60)
      yawByDistance.push(signedYawAround(anchor, eyeBefore, fixture.camera.position))
    }

    for (const yaw of yawByDistance) expect(yaw).toBeLessThan(0)
    for (let i = 1; i < yawByDistance.length; i++) {
      expect(Math.abs(yawByDistance[i])).toBeGreaterThan(Math.abs(yawByDistance[i - 1]))
    }
    expectAtScreenPoint(fixture.camera, anchor, 400, 300)
  })

  it.each([
    { first: 1, second: 2 },
    { first: 2, second: 1 },
  ])('keeps every half-delivered parallel-swipe frame free of dolly when pointer $first moves first', ({ first, second }) => {
    fixture.rig.focusOn(
      { target: [1210, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
      { instant: true },
    )
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    const startDistance = fixture.camera.position.distanceTo(fixture.rig.pivot)
    let largestDistanceError = 0

    for (let step = 1; step <= 12; step++) {
      const dx = (180 * step) / 12
      const positions: Record<number, [number, number]> = {
        1: [350 + dx, 300],
        2: [450 + dx, 300],
      }
      moveTouch(fixture, first, positions[first])
      fixture.rig.update(1 / 60)
      largestDistanceError = Math.max(
        largestDistanceError,
        Math.abs(fixture.camera.position.distanceTo(fixture.rig.pivot) - startDistance),
      )
      moveTouch(fixture, second, positions[second])
      fixture.rig.update(1 / 60)
      largestDistanceError = Math.max(
        largestDistanceError,
        Math.abs(fixture.camera.position.distanceTo(fixture.rig.pivot) - startDistance),
      )
    }

    expect(largestDistanceError).toBeLessThan(startDistance * 1e-6)
  })

  it('tracks a pinch continuously while its second contact stays stationary', async () => {
    fixture.rig.focusOn(
      { target: [0, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
      { instant: true },
    )
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])

    for (const x of [335, 320, 300]) {
      moveTouch(fixture, 1, [x, 300])
      await settlePointerBatch()
      fixture.rig.update(1 / 60)

      const span = 450 - x
      expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(
        (48 * 100) / span,
        10,
      )
    }
  })

  it('does not freeze when one moving contact stops reporting', async () => {
    fixture.rig.focusOn(
      { target: [0, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
      { instant: true },
    )
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    moveTouchPair(fixture, [340, 300], [460, 300])

    for (const x of [325, 310, 300]) {
      moveTouch(fixture, 1, [x, 300])
      await settlePointerBatch()
      fixture.rig.update(1 / 60)

      const span = 460 - x
      expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(
        (48 * 100) / span,
        10,
      )
    }
  })

  it('is independent of whether rendering follows every event, every pair, or only the endpoint', () => {
    const everyEvent = measureMixedSwipe(fixture, 'event')
    fixture.rig.dispose()
    fixture = createRigFixture()
    const everyPair = measureMixedSwipe(fixture, 'pair')
    fixture.rig.dispose()
    fixture = createRigFixture()
    const endpointOnly = measureMixedSwipe(fixture, 'end')

    expect(Math.abs(everyEvent.yaw)).toBeGreaterThan(Math.PI / 8)
    for (const measurement of [everyPair, endpointOnly]) {
      expect(Math.abs(measurement.yaw - everyEvent.yaw)).toBeLessThan(1e-6)
      expect(measurement.position.distanceTo(everyEvent.position)).toBeLessThan(1e-5)
      expect(measurement.pivot.distanceTo(everyEvent.pivot)).toBeLessThan(1e-5)
      expect(Math.abs(measurement.distance - everyEvent.distance)).toBeLessThan(1e-6)
    }
  })

  it('changes from an early pinch to a later decisive twist', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const distanceBefore = fixture.camera.position.distanceTo(fixture.rig.pivot)
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])

    for (const span of [104, 107, 108]) {
      moveTouchPair(fixture, [400 - span / 2, 300], [400 + span / 2, 300])
    }
    const turn = Math.PI / 3
    for (let step = 1; step <= 4; step++) {
      const angle = (turn * step) / 4
      moveTouchPair(
        fixture,
        rotatePoint([346, 300], [400, 300], angle),
        rotatePoint([454, 300], [400, 300], angle),
      )
    }

    const yaw = signedYawAround(anchor, eyeBefore, fixture.camera.position)
    expect(yaw / turn).toBeGreaterThan(0.75)
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeLessThan(distanceBefore)
  })

  it('does not let early span settling hijack a later parallel swipe', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])

    for (const span of [104, 107, 108]) {
      moveTouchPair(fixture, [400 - span / 2, 300], [400 + span / 2, 300])
    }
    for (let step = 1; step <= 4; step++) {
      const dx = (60 * step) / 4
      moveTouchPair(fixture, [346 + dx, 300], [454 + dx, 300])
    }

    const yaw = signedYawAround(anchor, eyeBefore, fixture.camera.position)
    expect(yaw).toBeLessThan(-Math.PI / 8)
  })

  it('does not let early twist noise hijack a later pinch', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const distanceBefore = fixture.camera.position.distanceTo(fixture.rig.pivot)
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])

    for (const degrees of [7, 8]) {
      const angle = THREE.MathUtils.degToRad(degrees)
      moveTouchPair(
        fixture,
        rotatePoint([350, 300], [400, 300], angle),
        rotatePoint([450, 300], [400, 300], angle),
      )
    }
    const noiseAngle = THREE.MathUtils.degToRad(8)
    for (const span of [150, 225, 300]) {
      moveTouchPair(
        fixture,
        rotatePoint([400 - span / 2, 300], [400, 300], noiseAngle),
        rotatePoint([400 + span / 2, 300], [400, 300], noiseAngle),
      )
    }

    const yaw = signedYawAround(anchor, eyeBefore, fixture.camera.position)
    expect(Math.abs(yaw)).toBeLessThan(THREE.MathUtils.degToRad(1))
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeLessThan(distanceBefore * 0.55)
  })

  it('does not turn short-span contact settling into retained swipe yaw', () => {
    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const distanceBefore = fixture.camera.position.distanceTo(fixture.rig.pivot)
    beginTwoFingerGesture(fixture, [390, 300], [410, 300])

    for (const dx of [1.5, 2]) {
      moveTouchPair(fixture, [390 + dx, 300], [410 + dx, 300])
    }
    for (const span of [30, 45, 60]) {
      moveTouchPair(fixture, [402 - span / 2, 300], [402 + span / 2, 300])
    }

    expect(Math.abs(signedYawAround(anchor, eyeBefore, fixture.camera.position))).toBeLessThan(
      THREE.MathUtils.degToRad(0.1),
    )
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeLessThan(distanceBefore * 0.55)
  })

  it('changes continuously across the swipe-pinch classification boundary', () => {
    const yawByTranslation: number[] = []
    for (let translation = 55; translation <= 65; translation++) {
      if (yawByTranslation.length > 0) {
        fixture.rig.dispose()
        fixture = createRigFixture()
      }
      const anchor = groundPointAt(fixture.camera, 400, 300)
      const eyeBefore = fixture.camera.position.clone()
      beginTwoFingerGesture(fixture, [350, 300], [450, 300])
      for (const progress of [0.5, 1]) {
        const midpoint = 400 + translation * progress
        const halfSpan = 50 + 20 * progress
        moveTouchPair(
          fixture,
          [midpoint - halfSpan, 300],
          [midpoint + halfSpan, 300],
        )
      }
      yawByTranslation.push(signedYawAround(anchor, eyeBefore, fixture.camera.position))
    }

    const onePixelYaw = (Math.PI * 2) / fixture.dom.clientHeight
    let largestAdjacentChange = 0
    for (let i = 1; i < yawByTranslation.length; i++) {
      largestAdjacentChange = Math.max(
        largestAdjacentChange,
        Math.abs(yawByTranslation[i] - yawByTranslation[i - 1]),
      )
    }
    expect(Math.max(...yawByTranslation.map(Math.abs))).toBeGreaterThan(onePixelYaw * 10)
    expect(largestAdjacentChange).toBeLessThan(onePixelYaw * 6)
  })

  it.each(['pointerup', 'pointercancel'] as const)(
    'commits coherent queued motion before %s removes a contact',
    (terminalEvent) => {
      const rendered = measureParallelSwipe(fixture, 60, 20, false)
      fixture.rig.dispose()
      fixture = createRigFixture()
      const terminal = measureTerminalSwipe(fixture, terminalEvent)

      expect(Math.abs(terminal.yaw)).toBeGreaterThan(Math.PI / 8)
      expect(Math.abs(terminal.yaw - rendered.yaw)).toBeLessThan(1e-6)
      expect(terminal.position.distanceTo(rendered.position)).toBeLessThan(1e-5)
      expect(terminal.pivot.distanceTo(rendered.pivot)).toBeLessThan(1e-5)
      expect(Math.abs(terminal.distance - rendered.distance)).toBeLessThan(1e-6)
    },
  )

  it.each([
    { terminalEvent: 'pointerup' as const, pointerId: 1 },
    { terminalEvent: 'pointerup' as const, pointerId: 2 },
    { terminalEvent: 'pointercancel' as const, pointerId: 1 },
    { terminalEvent: 'pointercancel' as const, pointerId: 2 },
  ])('preserves stationary-anchor motion when pointer $pointerId ends with $terminalEvent', ({
    terminalEvent,
    pointerId,
  }) => {
    fixture.rig.focusOn(
      { target: [0, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
      { instant: true },
    )
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    moveTouch(fixture, 1, [300, 300])
    fixture.dom.dispatchEvent(
      pointer(terminalEvent, {
        pointerId,
        pointerType: 'touch',
        clientX: pointerId === 1 ? 300 : 450,
        clientY: 300,
      }),
    )
    fixture.rig.update(1 / 60)

    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(32, 10)
  })

  it('rebases cleanly when a third contact replaces a gesture owner', () => {
    fixture.rig.focusOn(
      { target: [0, 0, 0], distance: 48, dir: [-0.6, 0.5, 0.8] },
      { instant: true },
    )
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    fixture.dom.dispatchEvent(
      pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 550, clientY: 300 }),
    )
    moveTouchPair(fixture, [300, 300], [450, 300])
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(32, 10)

    fixture.dom.dispatchEvent(
      pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 300 }),
    )
    const rebasedDistance = fixture.camera.position.distanceTo(fixture.rig.pivot)
    expect(rebasedDistance).toBeCloseTo(32, 10)

    moveTouch(fixture, 2, [440, 300])
    moveTouch(fixture, 3, [560, 300])
    fixture.rig.update(1 / 60)

    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(
      rebasedDistance * (100 / 120),
      10,
    )
  })

  it('starts clean after a cancelled two-finger gesture', () => {
    measureTerminalSwipe(fixture, 'pointercancel')
    fixture.dom.dispatchEvent(
      pointer('pointercancel', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 510,
        clientY: 300,
      }),
    )

    const anchor = groundPointAt(fixture.camera, 400, 300)
    const eyeBefore = fixture.camera.position.clone()
    const distanceBefore = fixture.camera.position.distanceTo(fixture.rig.pivot)
    beginTwoFingerGesture(fixture, [350, 300], [450, 300])
    moveTouchPair(fixture, [300, 300], [500, 300])

    expect(Math.abs(signedYawAround(anchor, eyeBefore, fixture.camera.position))).toBeLessThan(
      THREE.MathUtils.degToRad(0.1),
    )
    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeLessThan(distanceBefore * 0.6)
  })

  it('returns the remaining finger to one-finger pan after a two-finger gesture', () => {
    fixture.dom.dispatchEvent(
      pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 300, clientY: 300 }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 300 }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 390, clientY: 325 }),
    )
    fixture.rig.update(1 / 60)
    fixture.dom.dispatchEvent(
      pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 390, clientY: 325 }),
    )
    const pivotBefore = fixture.rig.pivot.clone()
    const rotationBefore = fixture.camera.quaternion.clone()

    fixture.dom.dispatchEvent(
      pointer('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 340, clientY: 315 }),
    )
    fixture.rig.update(1 / 60)

    expect(fixture.rig.pivot.distanceTo(pivotBefore)).toBeGreaterThan(0.1)
    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeLessThan(1e-8)
  })

  it('does not coast after a reduced-motion rotate drag is released', () => {
    fixture.rig.dispose()
    fixture.rig = createCameraRig(fixture.camera, fixture.dom, fixture.bus, { reducedMotion: true })
    drag(fixture.dom, { button: 0, shiftKey: true })
    fixture.rig.update(1 / 60)
    fixture.dom.dispatchEvent(pointer('pointerup', { button: 0, clientX: 340, clientY: 305 }))
    const rotationAtRelease = fixture.camera.quaternion.clone()

    for (let frame = 0; frame < 30; frame++) fixture.rig.update(1 / 60)

    expect(fixture.camera.quaternion.angleTo(rotationAtRelease)).toBeLessThan(1e-10)
  })

  it('does not coast after a reduced-motion pan drag is released', () => {
    fixture.rig.dispose()
    fixture.rig = createCameraRig(fixture.camera, fixture.dom, fixture.bus, { reducedMotion: true })
    drag(fixture.dom, { button: 0 })
    fixture.rig.update(1 / 60)
    fixture.dom.dispatchEvent(pointer('pointerup', { button: 0, clientX: 340, clientY: 305 }))
    const pivotAtRelease = fixture.rig.pivot.clone()

    for (let frame = 0; frame < 30; frame++) fixture.rig.update(1 / 60)

    expect(fixture.rig.pivot.distanceTo(pivotAtRelease)).toBeLessThan(1e-10)
  })

  it('stops an active focus move when the guided tour exits', () => {
    fixture.rig.focusOn({ target: [200, 12, 80], distance: 60 })
    fixture.rig.update(0.1)
    expect(fixture.rig.scripted).toBe(true)

    fixture.bus.emit('tour:stop', {})
    const positionAtExit = fixture.camera.position.clone()
    const rotationAtExit = fixture.camera.quaternion.clone()
    fixture.rig.update(0.5)

    expect(fixture.rig.scripted).toBe(false)
    expect(fixture.camera.position.distanceTo(positionAtExit)).toBeLessThan(1e-10)
    expect(fixture.camera.quaternion.angleTo(rotationAtExit)).toBeLessThan(1e-10)
  })

  it('right-drag does not move the camera', () => {
    const pivotBefore = fixture.rig.pivot.clone()
    const positionBefore = fixture.camera.position.clone()
    const rotationBefore = fixture.camera.quaternion.clone()

    drag(fixture.dom, { button: 2 })
    fixture.rig.update(1 / 60)

    expect(fixture.rig.pivot.distanceTo(pivotBefore)).toBeLessThan(1e-8)
    expect(fixture.camera.position.distanceTo(positionBefore)).toBeLessThan(1e-8)
    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeLessThan(1e-8)
  })

  it('keeps a non-empty city frame throughout the full wheel zoom range', () => {
    const plazaTop = CITY.buf.baseY + CITY.buf.maxRise
    for (const deltaY of [10_000, -250, -250, -250, -250, -250, -250, -250, -250, -250, -10_000]) {
      wheel(fixture.dom, deltaY)
      for (let frame = 0; frame < 180; frame++) fixture.rig.update(1 / 60)

      expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeGreaterThanOrEqual(24)
      expect(fixture.camera.position.y).toBeGreaterThan(plazaTop)
    }
  })

  it('keeps scripted component focus outside the same readable floor', () => {
    fixture.rig.focusOn(
      { target: [0, 0, 0], distance: 8, dir: [0, 1, 0] },
      { instant: true },
    )

    expect(fixture.camera.position.distanceTo(fixture.rig.pivot)).toBeCloseTo(24, 8)
  })

  it('announces fly controls on entry, not after returning to orbit', () => {
    const messages: string[] = []
    fixture.bus.on('toast', ({ text }) => messages.push(text))

    fixture.rig.setMode('fly')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('Fly mode')

    fixture.rig.setMode('orbit')
    expect(messages).toHaveLength(1)
  })
})
