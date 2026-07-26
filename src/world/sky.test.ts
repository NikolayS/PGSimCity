import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/theme'
import type { ThemeApi } from '../core/types'
import { SLONIK_LINK_OPACITY, applySkyAtmosphere, createSky } from './sky'

describe('day sky', () => {
  it('places the sun on the incoming direction of the daylight key', () => {
    const sky = createSky({} as ThemeApi)
    applySkyAtmosphere(sky, ATMOSPHERE.day, 'high')

    const dome = sky.getObjectByName('sky.dome') as THREE.Mesh
    const material = dome.material as THREE.ShaderMaterial
    const actual = material.uniforms.uSunDirection.value as THREE.Vector3
    const expected = new THREE.Vector3(...ATMOSPHERE.day.keyPos)
      .sub(new THREE.Vector3(...ATMOSPHERE.day.keyTarget))
      .normalize()

    expect(actual.dot(expected)).toBeGreaterThan(0.999999)
    expect(material.uniforms.uDaylight.value).toBe(1)

    ;(sky.userData.dispose as () => void)()
  })

  it('keeps stars out of day and gates the single cloud layer only at low', () => {
    const sky = createSky({} as ThemeApi)
    const stars = sky.getObjectByName('sky.stars')
    const clouds = sky.getObjectByName('sky.clouds') as THREE.Mesh<THREE.InstancedBufferGeometry>

    expect(clouds.geometry.isInstancedBufferGeometry).toBe(true)
    expect(clouds.geometry.instanceCount).toBe(7)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'reduced')
    expect(stars?.visible).toBe(false)
    expect(clouds?.visible).toBe(true)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'low')
    expect(clouds?.visible).toBe(false)

    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high')
    expect(stars?.visible).toBe(true)
    expect(clouds?.visible).toBe(false)

    ;(sky.userData.dispose as () => void)()
  })
})

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
