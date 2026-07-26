import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createCollisionWorld } from './collision'
import { LABEL_OCCLUSION_BUDGET, isLabelAnchorOccluded } from './labels'

describe('floating label occlusion', () => {
  it('hides an object label only when a solid box lies before its anchor', () => {
    const collision = createCollisionWorld()
    const camera = new THREE.Vector3(0, 2, 0)
    const anchor = new THREE.Vector3(0, 2, 12)

    collision.addBox(
      new THREE.Box3(new THREE.Vector3(-2, 0, 4), new THREE.Vector3(2, 6, 7)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(true)

    collision.clear()
    collision.addBox(
      new THREE.Box3(new THREE.Vector3(4, 0, 4), new THREE.Vector3(7, 6, 7)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(false)

    collision.clear()
    collision.addBox(
      new THREE.Box3(new THREE.Vector3(-2, 0, 10), new THREE.Vector3(2, 6, 14)),
    )
    expect(isLabelAnchorOccluded(collision, camera, anchor)).toBe(false)
    collision.dispose()
  })

  it('amortises visibility work to three object labels per frame', () => {
    expect(LABEL_OCCLUSION_BUDGET).toBe(3)
  })
})
