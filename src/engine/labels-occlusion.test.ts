import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createCollisionWorld } from './collision'
import { installTestDom } from '../../test/dom'
import { Registry } from '../core/registry'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { createLabels, LABEL_OCCLUSION_BUDGET, isLabelAnchorOccluded } from './labels'

describe('floating label occlusion', () => {
  it('hides an object label only when a solid box lies before its anchor', () => {
    const collision = createCollisionWorld()
    const camera = new THREE.Vector3(0, 2, 0)
    const anchor = new THREE.Vector3(0, 2, 12)

    collision.addBox(
      new THREE.Box3(new THREE.Vector3(-2, 0, 4), new THREE.Vector3(2, 6, 7)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(true)

    collision.clear()
    collision.addBox(
      new THREE.Box3(new THREE.Vector3(4, 0, 4), new THREE.Vector3(7, 6, 7)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(false)

    collision.clear()
    collision.addBox(
      new THREE.Box3(new THREE.Vector3(-2, 0, 10), new THREE.Vector3(2, 6, 14)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(false)
    collision.dispose()
  })

  it('amortises visibility work to three object labels per frame', () => {
    expect(LABEL_OCCLUSION_BUDGET).toBe(3)
  })
})


it.each([60, 900])('retains qualified selected context at distance %s, then hides it on deselect', distance => {
  const dom = installTestDom()
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const registry = new Registry(), bus = createBus(), sim = createSim(bus)
  const object = new THREE.Group()
  registry.register({ id: 'test.component', name: 'Selected component', role: 'test', kind: 'process',
    district: 'backends', object, tier: 1, labelAt: [0, 0, 0], color: 0x00ffff,
    focus: { target: [0, 0, 0], distance: 40 } })
  const labels = createLabels(container as unknown as HTMLElement, registry, bus, { occluded: () => true })
  labels.resize(1280, 900)
  const camera = new THREE.PerspectiveCamera(50, 1280 / 900, 0.1, 2000)
  camera.position.set(0, 20, distance); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  const tick = () => { for (let i = 0; i < 12; i++) labels.update(0.2, camera, sim.state) }
  tick()
  bus.emit('select', { id: 'test.component' }); tick()
  const label = (labels.group.children.find(o => (o as THREE.Object3D & { element?: HTMLElement }).element?.dataset.id === 'test.component') as THREE.Object3D & { element: HTMLElement }).element
  expect(label.classList.contains('is-on')).toBe(true)
  expect(label.textContent).toContain('behind structure')
  expect((label.querySelector('.lbl__occlusion') as HTMLElement).hidden).toBe(false)
  bus.emit('select', { id: null }); tick()
  expect(label.classList.contains('is-on')).toBe(false)
  expect((label.querySelector('.lbl__occlusion') as HTMLElement).hidden).toBe(true)
  for (const child of labels.group.children) {
    const element = (child as THREE.Object3D & { element: HTMLElement }).element
    Object.defineProperty(element, 'ownerDocument', { value: { defaultView: { Element: element.constructor } } })
  }
  labels.dispose()
})

it('continues refreshing ordinary anchors while three distinct context targets remain', () => {
  const dom = installTestDom(), registry = new Registry(), bus = createBus(), sim = createSim(bus)
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  for (let i = 0; i < 4; i++) {
    registry.register({ id: 'item' + i, name: 'Item ' + i, role: 'test', kind: 'process',
      district: 'backends', object: new THREE.Group(), tier: 1, labelAt: [i * 2, 0, 0],
      color: 0xffff00, focus: { target: [i * 2, 0, 0], distance: 40 } })
  }
  const checked: number[] = []
  const labels = createLabels(container as unknown as HTMLElement, registry, bus, {
    occluded: (_camera, anchor) => { checked.push(anchor.x); return false },
  })
  labels.resize(1280, 900)
  const camera = new THREE.PerspectiveCamera(50, 1280 / 900, 0.1, 2000)
  camera.position.set(0, 20, 60); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  for (let i = 0; i < 12; i++) labels.update(0.2, camera, sim.state)
  bus.emit('select', { id: 'item0' })
  bus.emit('hover', { id: 'item1' })
  bus.emit('focus', { id: 'item2' })
  checked.length = 0
  for (let i = 0; i < 12; i++) {
    const before = checked.length
    labels.update(0.2, camera, sim.state)
    expect(checked.length - before).toBeLessThanOrEqual(LABEL_OCCLUSION_BUDGET)
  }
  expect(checked).toContain(6)
  for (const child of labels.group.children) {
    const element = (child as THREE.Object3D & { element: HTMLElement }).element
    Object.defineProperty(element, 'ownerDocument', { value: { defaultView: { Element: element.constructor } } })
  }
  labels.dispose()
})

it('never forces a selected annotation through a full-screen explanation', () => {
  const dom = installTestDom(), registry = new Registry(), bus = createBus(), sim = createSim(bus)
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  const disclosure = dom.document.createElement('div')
  disclosure.id = 'city-version-provenance'
  disclosure.getBoundingClientRect = () => ({ x: 0, y: 0, toJSON: () => ({}), left: 0, top: 0, right: 1280, bottom: 900, width: 1280, height: 900 })
  dom.document.body.appendChild(disclosure)
  registry.register({ id: 'item', name: 'Selected item', role: 'test', kind: 'process',
    district: 'backends', object: new THREE.Group(), tier: 1, labelAt: [0, 0, 0],
    color: 0xffff00, focus: { target: [0, 0, 0], distance: 40 } })
  const labels = createLabels(container as unknown as HTMLElement, registry, bus, { occluded: () => false })
  labels.resize(1280, 900)
  const camera = new THREE.PerspectiveCamera(50, 1280 / 900, 0.1, 2000)
  camera.position.set(0, 20, 60); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  bus.emit('select', { id: 'item' })
  for (let i = 0; i < 12; i++) labels.update(0.2, camera, sim.state)
  const label = (labels.group.children.find(o => (o as THREE.Object3D & { element?: HTMLElement }).element?.dataset.id === 'item') as THREE.Object3D & { element: HTMLElement }).element
  expect(label.classList.contains('is-on')).toBe(false)
  disclosure.getBoundingClientRect = () => ({ x: 0, y: 0, toJSON: () => ({}), left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 })
  for (let i = 0; i < 12; i++) labels.update(0.2, camera, sim.state)
  expect(label.classList.contains('is-on')).toBe(true)
  for (const child of labels.group.children) {
    const element = (child as THREE.Object3D & { element: HTMLElement }).element
    Object.defineProperty(element, 'ownerDocument', { value: { defaultView: { Element: element.constructor } } })
  }
  labels.dispose()
})
