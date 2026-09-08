import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import { N_BACKEND_SLOTS } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createBackends } from './backends'
import { CITY, backendX } from './layout'

const disposers: (() => void)[] = []
afterEach(() => { while (disposers.length) disposers.pop()!() })

function fixture() {
  installTestDom({ canvas2d: true })
  const bus = createBus(), sim = createSim(bus), theme = createTheme()
  const module = createBackends({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), bus,
    sim: sim.state, theme,
    quality: { level: 'high', pixelRatio: 1, bloom: true, shadows: true, maxParticles: 1, maxLabels: 1, antialias: true },
    register: () => {}, flow: () => {},
  })
  disposers.push(() => { module.dispose?.(); theme.dispose() })
  const meshes: THREE.InstancedMesh[] = []
  module.group.traverse((object) => {
    if (object instanceof THREE.InstancedMesh) meshes.push(object)
  })
  const byMaterial = (name: string) => meshes.filter((mesh) => !Array.isArray(mesh.material) && mesh.material.name === name)
  return { module, byMaterial }
}

describe('backend process architecture', () => {
  it('recesses the central service spine while retaining the status facade on each side', () => {
    const { byMaterial } = fixture()
    const shaft = byMaterial('backends.shaft')[0]
    const transform = new THREE.Matrix4()
    shaft.getMatrixAt(0, transform)
    const center = new THREE.Vector3().setFromMatrixPosition(transform)
    const ray = new THREE.Raycaster()
    function faceDepth(offset: number) {
      ray.set(new THREE.Vector3(backendX(0) + offset, center.y, CITY.backend.z + 20), new THREE.Vector3(0, 0, -1))
      return ray.intersectObject(shaft)[0].point.z
    }
    expect(faceDepth(0)).toBeLessThan(faceDepth(CITY.backend.w * 0.25) - 0.5)
    expect(faceDepth(CITY.backend.w * 0.34)).toBeCloseTo(CITY.backend.z + CITY.backend.w / 2, 3)
  })

  it('keeps the supporting silhouette visible at city distance without extra material batches', () => {
    const { module, byMaterial } = fixture()
    module.setDetail?.(0)
    const structure = byMaterial('backends.struct')[0]
    const shaft = byMaterial('backends.shaft')[0]
    expect(structure.visible).toBe(true)
    const transform = new THREE.Matrix4()
    const scale = new THREE.Vector3(), position = new THREE.Vector3()
    let buttresses = 0
    for (let i = 0; i < structure.count; i++) {
      structure.getMatrixAt(i, transform)
      scale.setFromMatrixScale(transform)
      position.setFromMatrixPosition(transform)
      if (scale.y > 4 && scale.x < 2) buttresses++
    }
    expect(buttresses).toBe(N_BACKEND_SLOTS * 4)
    expect(byMaterial('backends.struct')).toHaveLength(3) // structure, existing memory ticks and temporary files
    expect(byMaterial('backends.shaft')).toHaveLength(1)
    expect(shaft.count).toBe(N_BACKEND_SLOTS)
    expect(structure.count).toBeLessThanOrEqual(N_BACKEND_SLOTS * 8)
  })

  it('keeps every structural mass in its plinth envelope and leaves private-memory sightlines open', () => {
    const { byMaterial } = fixture()
    const structure = byMaterial('backends.struct')[0]
    const transform = new THREE.Matrix4()
    const scale = new THREE.Vector3(), position = new THREE.Vector3()
    for (let i = 0; i < structure.count; i++) {
      structure.getMatrixAt(i, transform)
      scale.setFromMatrixScale(transform)
      position.setFromMatrixPosition(transform)
      const slot = Math.round((position.x + CITY.backend.span / 2) / (CITY.backend.span / (N_BACKEND_SLOTS - 1)))
      const offset = position.x - backendX(slot)
      expect(Math.abs(offset) + scale.x / 2).toBeLessThanOrEqual(CITY.backend.w / 2 + 1.61)
      expect(Math.abs(position.z - CITY.backend.z) + scale.z / 2).toBeLessThanOrEqual(CITY.backend.w / 2 + 1.61)
      if (scale.y > 4) {
        // The reservoir occupies the positive-z face, x = 3.4 ± 1.35 m.
        expect(offset + scale.x / 2 < 2 || offset - scale.x / 2 > 4.75 || position.z + scale.z / 2 < CITY.backend.z + 5).toBe(true)
      }
    }
  })
})
