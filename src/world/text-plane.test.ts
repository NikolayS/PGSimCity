import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { MAP_TEXT_LAYER, markTextPlane } from './text-plane'

describe('text plane camera layers', () => {
  it('keeps wall signs in the city layer and isolates fixed map-floor lettering', () => {
    const wall = new THREE.Object3D()
    const floor = new THREE.Object3D()
    floor.rotation.x = -Math.PI / 2

    markTextPlane(wall, 'pedestrian sign')
    markTextPlane(floor, 'city plan')

    expect(wall.layers.isEnabled(0)).toBe(true)
    expect(wall.layers.isEnabled(MAP_TEXT_LAYER)).toBe(false)
    expect(floor.layers.isEnabled(0)).toBe(false)
    expect(floor.layers.isEnabled(MAP_TEXT_LAYER)).toBe(true)
  })
})
