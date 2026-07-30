import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import type { SimState } from '../core/types'
import { createSim } from '../sim/model'
import type { AudioApi } from './audio'
import { createCollisionWorld } from './collision'
import { createWalkController } from './walk'

function fakeAudio(): AudioApi {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(),
    preferred: false,
    enabled: true,
    volume: 0.35,
    step: vi.fn(),
    land: vi.fn(),
    jump: vi.fn(),
    splash: vi.fn<(intensity: number) => void>(),
    dispose: vi.fn(),
  }
}

function floor(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(100, 100))
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(300, 0, 0)
  mesh.updateMatrixWorld(true)
  return mesh
}

describe('first-person embodiment', () => {
  it('grounds one directional body shadow at the walker feet and removes it on dispose', () => {
    const bus = createBus()
    const collision = createCollisionWorld()
    const ground = floor()
    collision.addWalkable(ground, 'ground')
    collision.addBox(new THREE.Box3(
      new THREE.Vector3(310, 0, -1),
      new THREE.Vector3(311, 2, 1),
    ))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(300, 4, 8)
    const walk = createWalkController({
      camera,
      dom: new EventTarget() as HTMLElement,
      collision,
      audio: fakeAudio(),
      sim: createSim(bus).state as SimState,
      bus,
      scene,
    })
    const shadow = scene.getObjectByName('walk:body-shadow')!

    expect(shadow).toBeInstanceOf(THREE.Mesh)
    expect(shadow.visible).toBe(false)
    const geometry = (shadow as THREE.Mesh).geometry
    geometry.computeBoundingBox()
    const bounds = geometry.boundingBox!
    expect((bounds.max.x - bounds.min.x) * shadow.scale.x).toBeLessThan(0.75)
    expect((bounds.max.z - bounds.min.z) * shadow.scale.z).toBeLessThan(1.6)

    void walk.enter(new THREE.Vector3(300, 3.2, 8))
    for (let i = 0; i < 24; i++) walk.update(0.1)
    expect(walk.grounded).toBe(true)
    expect(shadow.visible).toBe(true)
    expect(shadow.position.x).toBeCloseTo(walk.position.x, 5)
    expect(shadow.position.y).toBeCloseTo(walk.position.y + 0.018, 5)
    expect(shadow.position.z).toBeCloseTo(walk.position.z, 5)

    walk.setTouchMove(0, 0.25)
    let minFeetY = walk.position.y
    for (let i = 0; i < 20; i++) {
      walk.update(1 / 50)
      minFeetY = Math.min(minFeetY, walk.position.y)
    }
    expect(walk.gait).toBe('walk')
    expect(walk.grounded).toBe(true)
    expect(minFeetY).toBeCloseTo(0, 5)
    expect(shadow.position.z).toBeCloseTo(walk.position.z, 5)

    walk.setTouchMove(0, 1)
    for (let i = 0; i < 20; i++) {
      walk.update(1 / 50)
      minFeetY = Math.min(minFeetY, walk.position.y)
    }
    expect(walk.gait).toBe('run')
    expect(walk.grounded).toBe(true)
    expect(minFeetY).toBeCloseTo(0, 5)
    expect(shadow.position.z).toBeCloseTo(walk.position.z, 5)

    walk.exit()
    expect(shadow.visible).toBe(false)
    walk.dispose()
    expect(scene.getObjectByName('walk:body-shadow')).toBeUndefined()
    collision.dispose()
    ground.geometry.dispose()
  })

  it('keeps the grounded shadow when reduced motion removes view bob', () => {
    const bus = createBus()
    const collision = createCollisionWorld()
    const ground = floor()
    collision.addWalkable(ground, 'ground')
    collision.addBox(new THREE.Box3(
      new THREE.Vector3(310, 0, -1),
      new THREE.Vector3(311, 2, 1),
    ))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(300, 4, 8)
    const walk = createWalkController({
      camera,
      dom: new EventTarget() as HTMLElement,
      collision,
      audio: fakeAudio(),
      sim: createSim(bus).state as SimState,
      bus,
      scene,
      reducedMotion: true,
    })
    void walk.enter(new THREE.Vector3(300, 3.2, 8))
    for (let i = 0; i < 24; i++) walk.update(0.1)
    walk.setTouchMove(0, 0.37)

    for (let i = 0; i < 30; i++) {
      walk.update(1 / 50)
      expect(camera.position.y - walk.position.y).toBeCloseTo(1.7, 8)
    }
    expect(scene.getObjectByName('walk:body-shadow')?.visible).toBe(true)

    walk.dispose()
    collision.dispose()
    ground.geometry.dispose()
  })
})
