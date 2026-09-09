import * as THREE from 'three'
import { expect, it, vi } from 'vitest'
import { createWalkShadow } from './walk-shadow'

it('keeps feet on the surface while crouching and preserves an invisible shadow caster', () => {
  const body = createWalkShadow()
  const pos = new THREE.Vector3(5, 2, -4)
  body.update(pos, 0, false, 0, 0)
  const standing = new THREE.Box3().setFromObject(body.group)
  body.update(pos, Math.PI / 2, true, 0, 0)
  const crouching = new THREE.Box3().setFromObject(body.group)
  expect(standing.min.y).toBeCloseTo(pos.y, 6)
  expect(crouching.min.y).toBeCloseTo(pos.y, 6)
  expect(crouching.max.y - pos.y).toBeLessThan(standing.max.y - pos.y)
  expect(crouching.max.y - pos.y).toBeGreaterThan(1.2)
  body.group.traverse(obj => {
    if (!(obj instanceof THREE.Mesh)) return
    const mat = obj.material as THREE.MeshStandardMaterial
    expect(mat.userData.pgNoSurface).toBe(true)
    expect(mat.colorWrite).toBe(false)
    expect(mat.depthWrite).toBe(false)
    expect(obj.castShadow).toBe(true)
  })
  body.dispose()
})

it('uses travel-driven limb motion and releases each shared resource exactly once', () => {
  const body = createWalkShadow()
  const pos = new THREE.Vector3()
  const scene = new THREE.Scene()
  scene.add(body.group)
  const limb = body.group.getObjectByName('walk:shadow-left-leg')!
  body.update(pos, 0, false, Math.PI / 2, 1)
  expect(limb.rotation.x).toBeGreaterThan(0)
  body.update(pos, 0, false, Math.PI / 2, 0)
  expect(limb.rotation.x).toBe(0)
  const resources = new Set<THREE.BufferGeometry | THREE.Material>()
  body.group.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      resources.add(obj.geometry)
      resources.add(obj.material as THREE.Material)
    }
  })
  const disposals = [...resources].map(r => vi.spyOn(r, 'dispose'))
  body.dispose()
  expect(scene.children).toHaveLength(0)
  for (const disposal of disposals) expect(disposal).toHaveBeenCalledTimes(1)
})
