import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import type { ThemeApi } from '../core/types'
import { SLONIK_LINK_OPACITY, createSky } from './sky'

describe('Slonik asterism', () => {
  it('is a visible-but-faint part of the night-only starfield', () => {
    const sky = createSky({} as ThemeApi)
    const stars = sky.getObjectByName('sky.stars')
    const slonik = sky.getObjectByName('sky.slonik') as THREE.LineSegments

    expect(SLONIK_LINK_OPACITY).toBeGreaterThanOrEqual(0.2)
    expect(SLONIK_LINK_OPACITY).toBeLessThan(0.35)
    expect(slonik.parent).toBe(stars)
    expect((slonik.material as THREE.LineBasicMaterial).opacity).toBe(SLONIK_LINK_OPACITY)

    ;(sky.userData.dispose as () => void)()
  })
})
