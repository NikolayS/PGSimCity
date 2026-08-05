import * as THREE from 'three'
import { expect, it } from 'vitest'

import { MAP_TEXT_LAYER, markedTextPlanes } from '../src/world/text-plane'
import { createWalkCityHarness } from './walk-harness'

const MAP_NORMAL_DOT = 0.8

it('keeps every production text record on the layer its orientation requires', async () => {
  const city = await createWalkCityHarness({ includeControlCenter: true })
  try {
    const normal = new THREE.Vector3()
    const normalMatrix = new THREE.Matrix3()
    const failures: string[] = []
    let records = 0
    let walkRecords = 0
    let mapRecords = 0

    city.scene.updateMatrixWorld(true)
    city.scene.traverse((object) => {
      normalMatrix.getNormalMatrix(object.matrixWorld)
      for (const record of markedTextPlanes(object)) {
        records++
        normal.fromArray(record.normal).applyMatrix3(normalMatrix).normalize()
        const mapOnly = record.fixed && Math.abs(normal.y) > MAP_NORMAL_DOT
        const onMapLayer = object.layers.isEnabled(MAP_TEXT_LAYER)
        const onWalkLayer = object.layers.isEnabled(0)
        if (mapOnly) {
          mapRecords++
          if (!onMapLayer || onWalkLayer) {
            failures.push(`${record.text}: horizontal plan text is not orbit-only`)
          }
        } else {
          walkRecords++
          if (!onWalkLayer || onMapLayer) {
            failures.push(`${record.text}: walking-reader text is on the orbit-only layer`)
          }
        }
      }
    })

    expect(records, 'the layer audit must enumerate the production label set').toBeGreaterThan(100)
    expect(walkRecords, 'the city must retain a substantial walking-reader label set').toBeGreaterThan(75)
    expect(mapRecords, 'the audit must retain map-scale horizontal plan text').toBeGreaterThan(5)
    expect(failures).toEqual([])
  } finally {
    city.dispose()
  }
})
