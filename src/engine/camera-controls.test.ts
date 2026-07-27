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

function wheel(dom: HTMLElement, deltaY: number): void {
  const event = new Event('wheel', { cancelable: true })
  Object.defineProperties(event, {
    deltaY: { value: deltaY },
    deltaMode: { value: 0 },
    clientX: { value: 400 },
    clientY: { value: 300 },
  })
  dom.dispatchEvent(event)
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

  it('shift + left-drag rotates and tilts without panning', () => {
    const pivotBefore = fixture.rig.pivot.clone()
    const rotationBefore = fixture.camera.quaternion.clone()

    drag(fixture.dom, { button: 0, shiftKey: true })
    fixture.rig.update(1 / 60)

    expect(fixture.camera.quaternion.angleTo(rotationBefore)).toBeGreaterThan(0.01)
    expect(fixture.rig.pivot.distanceTo(pivotBefore)).toBeLessThan(1e-8)
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
