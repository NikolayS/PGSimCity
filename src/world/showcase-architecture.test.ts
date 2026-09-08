import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme, setThemeMode } from '../core/theme'
import type { WorldFactory } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createWal } from './wal'
import { createShmem } from './shmem'
import { ANCHOR, CITY, walSegZ } from './layout'

const dispose: (() => void)[] = []
afterEach(() => { while (dispose.length) dispose.pop()!() })
function fixture(factory: WorldFactory, level: 'low' | 'high' = 'low') {
  installTestDom({ canvas2d: true })
  const bus = createBus(), sim = createSim(bus), theme = createTheme()
  const module = factory({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), bus,
    sim: sim.state, theme, quality: { level, pixelRatio: 1, bloom: false, shadows: false,
      maxParticles: 1, maxLabels: 1, antialias: false }, register: () => {}, flow: () => {} })
  dispose.push(() => { module.dispose?.(); theme.dispose() })
  module.setDetail?.(0)
  module.group.updateMatrixWorld(true)
  return module
}

describe('city-scale architectural hierarchy', () => {
  it('does not paint simulated shadows from nonexistent uprights across buffer state', () => {
    const module = fixture(createShmem, 'high')
    expect(module.group.getObjectByName('shmem.rakingShadows')).toBeUndefined()
    const receiver = module.group.getObjectByName('shmem.tileShadows') as THREE.InstancedMesh
    expect(receiver.material).toBeInstanceOf(THREE.ShadowMaterial)
    expect(receiver.receiveShadow).toBe(true)
    expect(receiver.castShadow).toBe(false)
    setThemeMode('day', { persist: false })
    expect(receiver.visible).toBe(true)
    setThemeMode('night', { persist: false })
    expect(receiver.visible).toBe(false)
    const lowReceiver = fixture(createShmem).group.getObjectByName('shmem.tileShadows')!
    setThemeMode('day', { persist: false })
    expect(lowReceiver.visible).toBe(false)
    setThemeMode('night', { persist: false })
  })

  it('gives WAL an open peaked skyline without roofing over the segment bays', () => {
    const module = fixture(createWal)
    const roof = module.group.getObjectByName('wal.vault.trusses')
    expect(roof).toBeDefined()
    expect(roof!.visible).toBe(true)
    const bounds = new THREE.Box3().setFromObject(roof!)
    expect(bounds.max.y).toBeGreaterThan(26)
    expect(bounds.min.y).toBeGreaterThan(18)
    expect(bounds.min.x).toBeGreaterThanOrEqual(ANCHOR.walVault[0] - 14)
    expect(bounds.max.x).toBeLessThanOrEqual(ANCHOR.walVault[0] + 14)
    // The center of every occupied bay must remain visible from above.
    const ray = new THREE.Raycaster()
    for (let i = 0; i < 14; i++) {
      ray.set(new THREE.Vector3(ANCHOR.walVault[0], 40, walSegZ(i)), new THREE.Vector3(0, -1, 0))
      expect(ray.intersectObject(roof!)).toHaveLength(0)
    }
  })

  it('gives the buffer deck structural depth while leaving the sampled pool open', () => {
    const module = fixture(createShmem)
    const body = module.group.getObjectByName('shmem.deck.body')!
    const bounds = new THREE.Box3().setFromObject(body)
    expect(bounds.max.y - bounds.min.y).toBeGreaterThanOrEqual(5)
    expect(bounds.max.y).toBeLessThan(CITY.deck.top)
    expect(bounds.min.x).toBeGreaterThanOrEqual(-CITY.deck.w / 2)
    expect(bounds.max.x).toBeLessThanOrEqual(CITY.deck.w / 2)
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, -1, 0))
    expect(ray.intersectObject(body)).toHaveLength(0)
    expect(body.visible).toBe(true)
  })
})
