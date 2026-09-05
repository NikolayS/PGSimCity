import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyBoxBevelDetail, pairBoxGeometries } from '../core/beveled-box'
import { bakeSceneIndirect, disposeBakedIndirect, installBakedIndirect } from './baked-light'
import type { BakedLightPayload } from './baked-light'

const fixture = vi.hoisted(() => ({ payload: null as BakedLightPayload | null }))
vi.mock('./baked-light-data', () => ({
  get BAKED_LIGHT_VERSION() { return fixture.payload!.version },
  get BAKED_LIGHT_ENTRIES() { return fixture.payload!.entries },
  get BAKED_LIGHT_BASE64() { return fixture.payload!.base64 },
  get BAKED_LIGHT_BYTES() { return fixture.payload!.byteLength },
  get BAKED_LIGHT_BAKE_MS() { return fixture.payload!.bakeMs },
}))

describe('baked lighting through geometry quality changes', () => {
  it('installs a canonical bake into reduced startup geometry without changing the selected tier', () => {
    const scene = new THREE.Scene()
    const pair = pairBoxGeometries(4, 8, 4)
    const material = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(pair.beveled, material)
    scene.add(mesh)
    fixture.payload = bakeSceneIndirect(scene)
    const canonical = fixture.payload
    applyBoxBevelDetail(scene, 'reduced')
    const reduced = bakeSceneIndirect(scene)
    expect(reduced.entries).toEqual(canonical.entries)
    expect(reduced.base64).toEqual(canonical.base64)
    expect(installBakedIndirect(scene).installed).toBe(true)
    expect(bakeSceneIndirect(scene).entries).toEqual(canonical.entries)
    expect(mesh.geometry.getAttribute('position').count).toBe(pair.plain.getAttribute('position').count)
    expect(mesh.geometry.getAttribute('pgBakeSky').count).toBe(pair.plain.getAttribute('position').count)
    applyBoxBevelDetail(scene, 'high')
    expect(mesh.geometry.getAttribute('pgBakeSky').count).toBe(pair.beveled.getAttribute('position').count)
    disposeBakedIndirect(scene)
    pair.plain.dispose()
    pair.beveled.dispose()
    material.dispose()
  })

  it('retains mesh-specific instance transport when shared boxes change detail', () => {
    const scene = new THREE.Scene()
    const pair = pairBoxGeometries(1, 1, 1)
    const material = new THREE.MeshStandardMaterial()
    const a = new THREE.InstancedMesh(pair.beveled, material, 2)
    const b = new THREE.InstancedMesh(pair.beveled, material, 1)
    a.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 1, 0))
    a.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 3, 0))
    b.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 1, 0))
    scene.add(a, b)
    fixture.payload = bakeSceneIndirect(scene)
    expect(installBakedIndirect(scene).installed).toBe(true)
    const aSky = Array.from(a.geometry.getAttribute('pgBakeSkyA').array)
    const bSky = Array.from(b.geometry.getAttribute('pgBakeSkyA').array)
    for (const level of ['low', 'medium', 'high', 'ultra', 'reduced', 'low'] as const) {
      applyBoxBevelDetail(scene, level)
      expect(a.geometry.getAttribute('pgBakeSkyA')?.count).toBe(2)
      expect(b.geometry.getAttribute('pgBakeSkyA')?.count).toBe(1)
      expect(Array.from(a.geometry.getAttribute('pgBakeSkyA').array)).toEqual(aSky)
      expect(Array.from(b.geometry.getAttribute('pgBakeSkyA').array)).toEqual(bSky)
    }
    expect(pair.plain.getAttribute('pgBakeSkyA')).toBeUndefined()
    expect(pair.beveled.getAttribute('pgBakeSkyA')).toBeUndefined()
    const aPair = a.geometry.userData.pgBoxPair
    const disposePlain = vi.spyOn(aPair.plain, 'dispose')
    const disposeBeveled = vi.spyOn(aPair.beveled, 'dispose')
    disposeBakedIndirect(scene)
    expect(disposePlain).toHaveBeenCalledOnce()
    expect(disposeBeveled).toHaveBeenCalledOnce()
    expect(a.geometry).toBe(pair.beveled)
    pair.plain.dispose()
    pair.beveled.dispose()
    a.dispose()
    b.dispose()
    material.dispose()
  })

  it('maps per-vertex transfer to lower-detail faces and restores the original high-detail values', () => {
    const scene = new THREE.Scene()
    const pair = pairBoxGeometries(4, 8, 4)
    const material = new THREE.MeshStandardMaterial()
    const mesh = new THREE.Mesh(pair.beveled, material)
    const floorMaterial = new THREE.MeshStandardMaterial()
    floorMaterial.userData.pgSurface = false
    const floor = new THREE.Mesh(new THREE.BoxGeometry(20, 0.5, 20), floorMaterial)
    floor.position.y = -4.5
    scene.add(mesh, floor)
    fixture.payload = bakeSceneIndirect(scene)
    expect(installBakedIndirect(scene).installed).toBe(true)
    const highValues = Array.from(mesh.geometry.getAttribute('pgBakeSky').array)
    applyBoxBevelDetail(scene, 'low')
    const sky = mesh.geometry.getAttribute('pgBakeSky')
    const transfer = mesh.geometry.getAttribute('pgBakeTransfer')
    const normals = mesh.geometry.getAttribute('normal')
    expect(sky.count).toBe(mesh.geometry.getAttribute('position').count)
    expect(transfer.count).toBe(sky.count)
    const top: number[] = [], bottom: number[] = []
    for (let i = 0; i < sky.count; i++) {
      if (normals.getY(i) > 0.99) top.push(sky.getX(i))
      if (normals.getY(i) < -0.99) bottom.push(sky.getX(i))
    }
    expect(Math.min(...top)).toBeGreaterThan(Math.max(...bottom))
    applyBoxBevelDetail(scene, 'medium')
    applyBoxBevelDetail(scene, 'high')
    expect(Array.from(mesh.geometry.getAttribute('pgBakeSky').array)).toEqual(highValues)
    disposeBakedIndirect(scene)
    pair.plain.dispose()
    pair.beveled.dispose()
    floor.geometry.dispose()
    floorMaterial.dispose()
    material.dispose()
  })
})
