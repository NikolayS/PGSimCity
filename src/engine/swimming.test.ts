import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import type { SimState } from '../core/types'
import { createSim } from '../sim/model'
import { CITY } from '../world/layout'
import type { AudioApi } from './audio'
import { createCollisionWorld } from './collision'
import { createBufferWater } from './water'
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

describe('buffer-pool swimming', () => {
  it('makes crossing the surface an audio and visual event and keeps water movement dense', () => {
    const bus = createBus()
    const audio = fakeAudio()
    const visualSplash = vi.fn()
    const collision = createCollisionWorld()
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 30, 40)
    const dom = new EventTarget() as HTMLElement
    const walk = createWalkController({
      camera,
      dom,
      collision,
      audio,
      sim: createSim(bus).state as SimState,
      bus,
      water: { splash: visualSplash },
    })

    void walk.enter()
    for (let i = 0; i < 12; i++) walk.update(0.1)

    walk.position.set(0, CITY.deck.top + 1, 0)
    walk.setTouchMove(0, 1)
    walk.update(0.1)
    expect(walk.gait).toBe('swim')
    expect(walk.submerged).toBe(true)
    expect(audio.splash).toHaveBeenCalledTimes(1)
    expect(visualSplash).toHaveBeenCalledTimes(1)

    walk.setTouchMove(0, 0)
    const moving = walk.speed
    walk.update(0.1)
    expect(walk.speed).toBeGreaterThan(0)
    expect(walk.speed).toBeLessThan(moving)

    walk.position.set(60, CITY.deck.top + 1, 0)
    walk.update(0.1)
    expect(audio.splash).toHaveBeenCalledTimes(2)
    expect(visualSplash).toHaveBeenCalledTimes(2)

    walk.dispose()
    collision.dispose()
  })

  it('renders a readable top boundary and replaces long-range air clarity underwater', () => {
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const water = createBufferWater(scene)
    const surface = water.group.getObjectByName('buffer.water.surface') as THREE.Mesh

    expect(surface).toBeInstanceOf(THREE.Mesh)
    expect((surface.material as THREE.MeshBasicMaterial).side).toBe(THREE.DoubleSide)

    water.update(0.5, true)
    expect((scene.fog as THREE.Fog).far).toBeLessThan(90)
    water.splash(0, 0, 1)
    expect(water.group.children.some((child) => child.name === 'buffer.water.ripple' && child.visible)).toBe(true)

    water.dispose()
  })
})
