import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/theme'
import type { ThemeApi } from '../core/types'
import {
  ESTABLISHING_BAND,
  SLONIK_LINK_OPACITY,
  applySkyAtmosphere,
  cloudElevations,
  createSky,
  dayHazeMix,
  daySkyRamp,
} from './sky'

const DEG = Math.PI / 180
/** The shader works in dome height, not degrees. */
const h = (deg: number): number => Math.sin(deg * DEG)

/** Relative luminance of an sRGB hex, for "paler / darker" claims. */
const luma = (hex: number): number =>
  (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255

/** The dome colour before the sun terms: the ramp, then the below-horizon haze. */
function domeColor(elevationDeg: number): THREE.Color {
  const air = ATMOSPHERE.day
  const out = new THREE.Color(air.skyHorizon).lerp(new THREE.Color(air.skyZenith), daySkyRamp(h(elevationDeg)))
  return out.lerp(new THREE.Color(air.skyHaze), dayHazeMix(h(elevationDeg)))
}

/** Effective visibility: an object is only drawn if every ancestor is too. */
function shows(obj: THREE.Object3D | undefined): boolean {
  for (let node = obj; node; node = node.parent ?? undefined) if (!node.visible) return false
  return obj !== undefined
}

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

    // The flattened copy drives the low horizon glow and must not drift.
    const flat = material.uniforms.uSunFlat.value as THREE.Vector2
    const flatExpected = new THREE.Vector2(expected.x, expected.z).normalize()
    expect(flat.dot(flatExpected)).toBeGreaterThan(0.999999)

    ;(sky.userData.dispose as () => void)()
  })

  it('lands real saturation inside the first 20 degrees and never plateaus', () => {
    // Half the ramp has to be spent by 20°, or the only blue in the sky sits
    // above where anyone is looking.
    expect(daySkyRamp(h(10))).toBeGreaterThan(0.25)
    expect(daySkyRamp(h(20))).toBeGreaterThan(0.5)

    // Strictly increasing all the way to the zenith — a painted ceiling is the
    // failure this pins. The 45°→90° stretch is the one that used to be flat.
    const steps = [0, 5, 10, 20, 30, 45, 60, 75, 90]
    for (let i = 1; i < steps.length; i++) {
      expect(daySkyRamp(h(steps[i]))).toBeGreaterThan(daySkyRamp(h(steps[i - 1])) + 0.004)
    }
    expect(daySkyRamp(h(90))).toBe(1)
  })

  it('pales the band below the horizon instead of darkening it', () => {
    // The establishing camera sees NOTHING else. Below the apparent horizon
    // there is distance, and distance is paler — the old multiply-down was a
    // night idiom applied to daylight.
    const top = domeColor(ESTABLISHING_BAND.topDeg)
    const bottom = domeColor(ESTABLISHING_BAND.bottomDeg)

    expect(luma(bottom.getHex())).toBeGreaterThan(luma(top.getHex()))
    expect(luma(domeColor(-24).getHex())).toBeGreaterThan(luma(bottom.getHex()))
    // And it keeps getting darker upward, which is the whole gradient.
    expect(luma(domeColor(20).getHex())).toBeLessThan(luma(top.getHex()))

    // Readable structure, not one flat wash — in BOTH slices, including the
    // desktop's, which is under 5° tall and is the harder of the two.
    expect(luma(bottom.getHex()) - luma(top.getHex())).toBeGreaterThan(0.09)
    const dTop = domeColor(ESTABLISHING_BAND.desktopTopDeg)
    const dBottom = domeColor(ESTABLISHING_BAND.desktopBottomDeg)
    expect(luma(dBottom.getHex()) - luma(dTop.getHex())).toBeGreaterThan(0.035)
  })

  it('pins the below-horizon haze to the colour the scene fog fades onto', () => {
    expect(ATMOSPHERE.day.skyHaze).toBe(ATMOSPHERE.day.fogColor)
    expect(luma(ATMOSPHERE.day.skyHaze)).toBeGreaterThan(luma(ATMOSPHERE.day.skyHorizon))
    expect(luma(ATMOSPHERE.day.skyHorizon)).toBeGreaterThan(luma(ATMOSPHERE.day.skyZenith))
  })

  it('puts cloud inside the band the establishing camera can actually see', () => {
    // The desktop slice, because it is the tighter of the two and a cloud that
    // clears it clears the phone's as well. Half a degree of margin for the
    // instance's own angular height.
    const inBand = cloudElevations().filter(
      (deg) => deg < ESTABLISHING_BAND.desktopTopDeg - 0.5 && deg > ESTABLISHING_BAND.desktopBottomDeg + 0.5,
    )
    expect(inBand.length).toBeGreaterThanOrEqual(3)
    // …and still keep a high bank for anyone who orbits or looks up.
    expect(cloudElevations().filter((deg) => deg > 10).length).toBeGreaterThanOrEqual(4)
  })

  it('keeps stars out of day and drops the cloud layer on both rescue tiers', () => {
    const sky = createSky({} as ThemeApi)
    const stars = sky.getObjectByName('sky.stars')
    const clouds = sky.getObjectByName('sky.clouds') as THREE.Mesh<THREE.InstancedBufferGeometry>

    expect(clouds.geometry.isInstancedBufferGeometry).toBe(true)
    expect(clouds.geometry.instanceCount).toBe(cloudElevations().length)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'medium')
    expect(stars?.visible).toBe(false)
    expect(clouds?.visible).toBe(true)

    // Transparent fill, measured at 30% of the frame in software WebGL. The
    // two tiers that exist to rescue a struggling machine do not pay for it.
    for (const level of ['low', 'reduced'] as const) {
      applySkyAtmosphere(sky, ATMOSPHERE.day, level)
      expect(clouds?.visible).toBe(false)
    }

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

  it('cannot be drawn in daylight, whoever owns the parenting', () => {
    // Today this rests on an implicit parent link to sky.stars. Assert the
    // behaviour instead, so a refactor that reparents the links has to keep it.
    const sky = createSky({} as ThemeApi)
    const slonik = sky.getObjectByName('sky.slonik')

    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high')
    expect(shows(slonik)).toBe(true)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'high')
    expect(shows(slonik)).toBe(false)

    ;(sky.userData.dispose as () => void)()
  })
})
