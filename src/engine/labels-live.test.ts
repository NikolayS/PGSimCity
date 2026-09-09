import { expect, it } from 'vitest'
import * as THREE from 'three'
import { installTestDom } from '../../test/dom'
import { createBus } from '../core/bus'
import { Registry } from '../core/registry'
import type { ComponentDef } from '../core/types'
import { createSim } from '../sim/model'
import { createLabels } from './labels'

it('keeps a moving worker label attached and honors an explicit label anchor', () => {
  installTestDom()
  const registry = new Registry(), bus = createBus(), sim = createSim(bus)
  const target: [number, number, number] = [-222, 2, -26]
  const def: ComponentDef = {
    id: 'autovac.worker.0', name: 'worker 0', role: 'worker', kind: 'process',
    district: 'maintenance', object: new THREE.Group(), tier: 1,
    focus: { target, distance: 38 },
  }
  registry.register(def)
  const labels = createLabels(document.createElement('div'), registry, bus, { occluded: () => false })
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 2000)
  camera.position.set(0, 100, 200)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const anchor = (): THREE.Object3D => labels.group.children.find(o =>
    (o as THREE.Object3D & { element?: HTMLElement }).element?.dataset.id === def.id)!
  try {
    labels.update(.2, camera, sim.state)
    expect(anchor().position.toArray()).toEqual(target)
    target.splice(0, 3, 34, -27, -50)
    labels.update(.2, camera, sim.state)
    expect(anchor().position.toArray()).toEqual(target)
    def.labelAt = [40, -20, -45]
    labels.update(.2, camera, sim.state)
    expect(anchor().position.toArray()).toEqual(def.labelAt)
    target[0] = -222
    labels.update(.2, camera, sim.state)
    expect(anchor().position.toArray()).toEqual(def.labelAt)
    delete def.labelAt
    labels.update(.2, camera, sim.state)
    expect(anchor().position.toArray()).toEqual(target)
  } finally {
    // The lightweight DOM lacks ownerDocument; real CSS2DObject cleanup uses it.
    for (const object of labels.group.children) {
      const element = (object as THREE.Object3D & { element?: HTMLElement }).element
      if (element) Object.defineProperty(element, 'ownerDocument', { value: { defaultView: { Element } } })
    }
    labels.dispose()
  }
})
