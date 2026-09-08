import * as THREE from 'three'
import { expect, it } from 'vitest'
import { DAY_PALETTE, hslOf } from '../src/core/themes'
import { paintSceneMaterial } from '../src/core/theme'
import { createWalkCityHarness } from './walk-harness'

it('keeps actual district paving subordinate to semantic state across theme round trips', async () => {
  const city = await createWalkCityHarness()
  try {
    const pairs = [['clients', 'client'], ['backends', 'backend'], ['wal', 'wal'],
      ['maintenance', 'vacuum'], ['replication', 'replication'], ['shmem', 'shmem']] as const
    for (const [district, key] of pairs) {
      const zone = city.scene.getObjectByName(`ground.zone.${district}`) as THREE.Mesh
      const material = zone.material as THREE.MeshStandardMaterial
      const authored = material.color.getHex()
      paintSceneMaterial(material, 'day')
      const day = material.color.getHex()
      expect(hslOf(day)[1], district).toBeLessThan(hslOf(DAY_PALETTE[key])[1] * .45)
      expect(material.emissive.getHex(), district).toBe(0)
      paintSceneMaterial(material, 'night')
      expect(material.color.getHex(), district).toBe(authored)
      paintSceneMaterial(material, 'day')
      expect(material.color.getHex(), district).toBe(day)
    }
  } finally { city.dispose() }
})

it('leaves the live buffer basin open through the actual district zoning layer', async () => {
  const city = await createWalkCityHarness()
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  try {
    city.scene.updateMatrixWorld(true)
    const zone = city.scene.getObjectByName('ground.zone.shmem') as THREE.Mesh
    // Zoning is intentionally non-pickable. Test the triangles a renderer sees.
    const proxy = new THREE.Mesh(zone.geometry, material)
    proxy.applyMatrix4(zone.matrixWorld)
    proxy.updateMatrixWorld(true)
    const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0))
    for (const x of [-45, 0, 45]) for (const z of [-45, 0, 45]) {
      ray.ray.origin.set(x, 20, z)
      expect(ray.intersectObject(proxy), `buffer at ${x},${z}`).toHaveLength(0)
    }
    ray.ray.origin.set(65, 20, 0)
    expect(ray.intersectObject(proxy).length).toBeGreaterThan(0)
  } finally { material.dispose(); city.dispose() }
})
