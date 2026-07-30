import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  BOX_BEVEL_METRES,
  applyBoxBevelDetail,
  boxBevelDetail,
  createBeveledBoxGeometry,
  pairBoxGeometries,
} from './beveled-box'

describe('build-time box bevels', () => {
  it('adds one flat chamfer face per edge and corner at the requested size', () => {
    const geometry = createBeveledBoxGeometry(10, 8, 6, BOX_BEVEL_METRES)
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const triangles = geometry.getIndex()!.count / 3

    expect(triangles).toBe(44)

    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.min.toArray()).toEqual([-5, -4, -3])
    expect(geometry.boundingBox!.max.toArray()).toEqual([5, 4, 3])

    let hasInset = false
    let hasEdgeNormal = false
    for (let i = 0; i < position.count; i++) {
      if (Math.abs(Math.abs(position.getX(i)) - (5 - BOX_BEVEL_METRES)) < 1e-6) hasInset = true
      const components = [Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i))]
      if (components.filter((component) => component > 0.6).length === 2) hasEdgeNormal = true
    }
    expect(hasInset).toBe(true)
    expect(hasEdgeNormal).toBe(true)
  })

  it('keeps the rescue tiers on twelve-triangle boxes', () => {
    expect(boxBevelDetail('low')).toBe(0)
    expect(boxBevelDetail('reduced')).toBe(0)
    expect(boxBevelDetail('medium')).toBe(0)
    expect(boxBevelDetail('high')).toBe(1)
    expect(boxBevelDetail('ultra')).toBe(1)
  })

  it('swaps paired city boxes without touching unpaired semantic tiles', () => {
    const pair = pairBoxGeometries(1, 1, 1)
    const city = new THREE.Group()
    const structure = new THREE.InstancedMesh(pair.beveled, new THREE.MeshBasicMaterial(), 10)
    const semanticGeometry = new THREE.BoxGeometry(1, 1, 1)
    const semantic = new THREE.Mesh(semanticGeometry, new THREE.MeshBasicMaterial())
    city.add(structure, semantic)

    const low = applyBoxBevelDetail(city, 'low')
    expect(structure.geometry).toBe(pair.plain)
    expect(semantic.geometry).toBe(semanticGeometry)
    expect(low).toEqual({ boxes: 10, triangles: 120, triangleDelta: 0 })

    const high = applyBoxBevelDetail(city, 'high')
    expect(structure.geometry).toBe(pair.beveled)
    expect(semantic.geometry).toBe(semanticGeometry)
    expect(high).toEqual({ boxes: 10, triangles: 440, triangleDelta: 320 })
  })
})
