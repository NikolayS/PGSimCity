import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { findSkylineRoofs, silhouetteDetailBudget } from './silhouette'

describe('skyline silhouette detail budget', () => {
  it('costs the rescue tiers no geometry and scales deliberately above them', () => {
    expect(silhouetteDetailBudget('low')).toBe(0)
    expect(silhouetteDetailBudget('reduced')).toBe(0)
    expect(silhouetteDetailBudget('medium')).toBeGreaterThan(0)
    expect(silhouetteDetailBudget('high')).toBeGreaterThan(silhouetteDetailBudget('medium'))
    expect(silhouetteDetailBudget('ultra')).toBeGreaterThan(silhouetteDetailBudget('high'))
  })

  it('finds roofs inside instanced building batches at build time', () => {
    const scene = new THREE.Scene()
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial()
    const buildings = new THREE.InstancedMesh(geometry, material, 2)
    const matrix = new THREE.Matrix4()
    const rotation = new THREE.Quaternion()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3(12, 18, 10)
    matrix.compose(position.set(-20, 9, -40), rotation, scale)
    buildings.setMatrixAt(0, matrix)
    matrix.compose(position.set(20, 12, -40), rotation, scale.set(10, 24, 14))
    buildings.setMatrixAt(1, matrix)
    scene.add(buildings)

    const roofs = findSkylineRoofs(scene)
    expect(roofs).toHaveLength(2)
    expect(roofs.map((roof) => roof.y).sort((a, b) => a - b)).toEqual([18, 24])

    geometry.dispose()
    material.dispose()
  })
})
