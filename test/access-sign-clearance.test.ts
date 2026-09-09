import * as THREE from 'three'
import { expect, it } from 'vitest'
import { markedTextPlanes } from '../src/world/text-plane'
import { createWalkCityHarness } from './walk-harness'
import { enumerateColliders } from './visual-sweep-browser'

it('keeps close north fingerpost reading positions outside service-road curbs', async () => {
  const city = await createWalkCityHarness()
  try {
    city.scene.updateMatrixWorld(true)
    const colliders = enumerateColliders(city.collision.debugMesh())
    const centers: THREE.Vector3[] = []
    city.scene.traverse((object) => {
      for (const record of markedTextPlanes(object)) {
        const center = new THREE.Vector3().fromArray(record.center).applyMatrix4(object.matrixWorld)
        if (record.text === 'SHARED MEMORY  44 m' && record.normal[0] < -.9 && center.z < -100) centers.push(center)
      }
    })
    expect(centers).toHaveLength(1)
    for (const center of centers) {
      for (const distance of [1, 2, 3, 4, 8, 12]) {
        const x = center.x - distance
        const z = center.z
        const feet = city.collision.groundAt(new THREE.Vector3(x, center.y + 4, z), 60)
        expect(feet).not.toBeNull()
        const overlaps = colliders.filter((box) => {
          if (box.max.y <= feet! + .001 || box.min.y >= feet! + 1.799) return false
          const dx = Math.max(box.min.x - x, 0, x - box.max.x)
          const dz = Math.max(box.min.z - z, 0, z - box.max.z)
          return Math.hypot(dx, dz) < .3499
        })
        expect(overlaps, `reading capsule at ${distance} m`).toEqual([])
      }
    }
  } finally {
    city.dispose()
  }
})
