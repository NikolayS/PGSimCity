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

describe('map camera mouse controls', () => {
  let fixture: RigFixture

  beforeEach(() => {
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
    fixture = { camera, dom, bus, rig }
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

  it('rotates with a two-finger touch twist', () => {
    const rotationBefore = fixture.camera.quaternion.clone()
    fixture.dom.dispatchEvent(
      pointer('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 300,
        clientY: 300,
      }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 400,
        clientY: 300,
      }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: 300,
        clientY: 300,
      }),
    )
    fixture.dom.dispatchEvent(
      pointer('pointermove', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: 380,
        clientY: 330,
      }),
    )
    fixture.rig.update(1 / 60)

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
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
