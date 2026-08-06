import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/theme'
import { clockAtmosphereAt } from '../core/themes'
import { moonPhaseAt } from '../core/moon-phase'
import type { ThemeApi } from '../core/types'
import {
  ESTABLISHING_BAND,
  MOON_ANGULAR_DIAMETER_DEG,
  MOON_RADIANCE,
  SLONIK_LINK_OPACITY,
  SUN_ANGULAR_DIAMETER_DEG,
  applySkyAtmosphere,
  cloudAngularWidths,
  cloudElevations,
  createSky,
  dayScatteringPhase,
  dayHazeMix,
  daySkyRamp,
  moonDiscLight,
  solarTransmittance,
  sunDiscHorizonFraction,
  skyMoonVisible,
  skyScatteringEnabled,
} from './sky'

const DEG = Math.PI / 180
const FIXED_SKY_DATE = new Date('2024-04-19T12:00:00Z')
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
  it('draws a deliberately legible sun that reddens, dims, and sets at the horizon', () => {
    expect(SUN_ANGULAR_DIAMETER_DEG).toBe(1.5)

    const noon = solarTransmittance(62)
    const golden = solarTransmittance(8.4)
    const horizon = solarTransmittance(0.5)
    expect(golden[0]).toBeLessThan(noon[0])
    expect(horizon[0]).toBeLessThan(golden[0])
    expect(golden[2] / golden[0]).toBeLessThan(noon[2] / noon[0])
    expect(horizon[2] / horizon[0]).toBeLessThan(golden[2] / golden[0])

    const radius = SUN_ANGULAR_DIAMETER_DEG / 2
    expect(sunDiscHorizonFraction(radius)).toBe(1)
    expect(sunDiscHorizonFraction(0)).toBeCloseTo(0.5, 12)
    expect(sunDiscHorizonFraction(-radius)).toBe(0)
    expect(sunDiscHorizonFraction(-radius - 0.01)).toBe(0)
  })

  it('uses forward Mie and wavelength-sensitive Rayleigh scattering only on upper day tiers', () => {
    const towardSun = dayScatteringPhase(0.995)
    const acrossSun = dayScatteringPhase(0)
    const awayFromSun = dayScatteringPhase(-0.995)

    // Rayleigh is symmetric and blue-weighted; Mie is strongly forward so the
    // low sun owns a halo instead of merely sitting on a vertical colour ramp.
    expect(towardSun.rayleigh).toBeCloseTo(awayFromSun.rayleigh, 12)
    expect(towardSun.rayleighBlue / towardSun.rayleighRed).toBeGreaterThan(4)
    expect(towardSun.mie).toBeGreaterThan(acrossSun.mie * 20)
    expect(acrossSun.mie).toBeGreaterThan(awayFromSun.mie)

    expect(skyScatteringEnabled(ATMOSPHERE.day, 'medium')).toBe(true)
    expect(skyScatteringEnabled(ATMOSPHERE.day, 'high')).toBe(true)
    expect(skyScatteringEnabled(ATMOSPHERE.day, 'ultra')).toBe(true)
    expect(skyScatteringEnabled(ATMOSPHERE.day, 'low')).toBe(false)
    expect(skyScatteringEnabled(ATMOSPHERE.day, 'reduced')).toBe(false)
    expect(skyScatteringEnabled(ATMOSPHERE.night, 'ultra')).toBe(false)
  })

  it('places the sun on the incoming direction of the daylight key', () => {
    const sky = createSky({} as ThemeApi)
    applySkyAtmosphere(sky, ATMOSPHERE.day, 'high', FIXED_SKY_DATE)

    const dome = sky.getObjectByName('sky.dome') as THREE.Mesh
    const material = dome.material as THREE.ShaderMaterial
    const actual = material.uniforms.uSunDirection.value as THREE.Vector3
    const expected = new THREE.Vector3(...ATMOSPHERE.day.sunDirection).normalize()

    expect(actual.dot(expected)).toBeGreaterThan(0.999999)
    expect(material.uniforms.uDaylight.value).toBe(1)
    expect(material.uniforms.uScattering.value).toBe(1)

    // The flattened copy drives the low horizon glow and must not drift.
    const flat = material.uniforms.uSunFlat.value as THREE.Vector2
    const flatExpected = new THREE.Vector2(expected.x, expected.z).normalize()
    expect(flat.dot(flatExpected)).toBeGreaterThan(0.999999)

    const clouds = sky.getObjectByName('sky.clouds') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
    const cloudSun = clouds.material.uniforms.uSunDirection.value as THREE.Vector3
    expect(cloudSun.dot(expected)).toBeGreaterThan(0.999999)
    expect(clouds.material.uniforms.uCloudLight.value).toBeInstanceOf(THREE.Color)
    expect(clouds.material.uniforms.uCloudShade.value).toBeInstanceOf(THREE.Color)

    ;(sky.userData.dispose as () => void)()
  })

  it('uses the true local-clock solar direction and removes the disc once it has set', () => {
    const sky = createSky({} as ThemeApi)
    const dome = sky.getObjectByName('sky.dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>

    const beforeSunset = clockAtmosphereAt(17 * 60 + 55)
    applySkyAtmosphere(sky, beforeSunset, 'high', FIXED_SKY_DATE)
    const actual = dome.material.uniforms.uSunDirection.value as THREE.Vector3
    expect(actual.dot(new THREE.Vector3(...beforeSunset.sunDirection).normalize())).toBeGreaterThan(0.999999)
    expect(dome.material.uniforms.uSunVisible.value).toBe(1)

    const afterSunset = clockAtmosphereAt(18 * 60 + 5)
    applySkyAtmosphere(sky, afterSunset, 'high', FIXED_SKY_DATE)
    expect(dome.material.uniforms.uSunVisible.value).toBe(0)

    ;(sky.userData.dispose as () => void)()
  })

  it('keeps the legacy dome path for night and both rescue tiers', () => {
    const sky = createSky({} as ThemeApi)
    const dome = sky.getObjectByName('sky.dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>

    for (const level of ['low', 'reduced'] as const) {
      applySkyAtmosphere(sky, ATMOSPHERE.day, level, FIXED_SKY_DATE)
      expect(dome.material.uniforms.uScattering.value).toBe(0)
    }
    applySkyAtmosphere(sky, ATMOSPHERE.night, 'ultra', FIXED_SKY_DATE)
    expect(dome.material.uniforms.uScattering.value).toBe(0)

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

  it('gives the existing instanced layer enough angular presence to read as weather', () => {
    const widths = cloudAngularWidths()
    expect(widths.filter((deg) => deg >= 11).length).toBeGreaterThanOrEqual(6)
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(15)
  })

  it('keeps stars out of day and drops the cloud layer on both rescue tiers', () => {
    const sky = createSky({} as ThemeApi)
    const stars = sky.getObjectByName('sky.stars')
    const clouds = sky.getObjectByName('sky.clouds') as THREE.Mesh<THREE.InstancedBufferGeometry>

    expect(clouds.geometry.isInstancedBufferGeometry).toBe(true)
    expect(clouds.geometry.instanceCount).toBe(cloudElevations().length)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'medium', FIXED_SKY_DATE)
    expect(stars?.visible).toBe(false)
    expect(clouds?.visible).toBe(true)

    // Transparent fill, measured at 30% of the frame in software WebGL. The
    // two tiers that exist to rescue a struggling machine do not pay for it.
    for (const level of ['low', 'reduced'] as const) {
      applySkyAtmosphere(sky, ATMOSPHERE.day, level, FIXED_SKY_DATE)
      expect(clouds?.visible).toBe(false)
    }

    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high', FIXED_SKY_DATE)
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

    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high', FIXED_SKY_DATE)
    expect(shows(slonik)).toBe(true)

    applySkyAtmosphere(sky, ATMOSPHERE.day, 'high', FIXED_SKY_DATE)
    expect(shows(slonik)).toBe(false)

    ;(sky.userData.dispose as () => void)()
  })
})

describe('date-driven moon', () => {
  const waxingGibbous = new Date('2024-04-19T12:00:00Z')

  it('follows the established legibility scale and uses informational bloom only', () => {
    expect(MOON_ANGULAR_DIAMETER_DEG).toBe(SUN_ANGULAR_DIAMETER_DEG)
    expect(MOON_RADIANCE).toBeGreaterThan(1)
    expect(MOON_RADIANCE).toBeLessThan(2)
  })

  it('derives angular separation and illumination from the same phase', () => {
    const sky = createSky({} as ThemeApi)
    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high', waxingGibbous)

    const moonMesh = sky.getObjectByName('sky.moon') as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
    const moon = moonMesh.position.clone().normalize()
    const sun = moonMesh.material.uniforms.uSunDirection.value as THREE.Vector3
    const phase = moonPhaseAt(waxingGibbous)

    expect(moonMesh.geometry).toBeInstanceOf(THREE.SphereGeometry)
    expect(moon.length()).toBeCloseTo(1, 12)
    expect(moon.dot(sun)).toBeCloseTo(Math.cos(phase.cycle * Math.PI * 2), 12)
    expect(moonMesh.material.uniforms.uMoonIlluminated.value).toBeCloseTo(phase.illuminatedFraction, 12)

    ;(sky.userData.dispose as () => void)()
  })

  it('puts the lit half of the disc on the side facing the sun', () => {
    const moon = [0, 0, 1] as const
    const quarterSun = [1, 0, 0] as const

    expect(moonDiscLight(moon, quarterSun, 0.65, 0)).toBeGreaterThan(0)
    expect(moonDiscLight(moon, quarterSun, -0.65, 0)).toBeLessThan(0)
    expect(moonDiscLight(moon, quarterSun, 0, 0)).toBeCloseTo(0, 12)
  })

  it('follows explicit night and the clock theme night path at every tier', () => {
    expect(skyMoonVisible(ATMOSPHERE.night)).toBe(true)
    expect(skyMoonVisible(clockAtmosphereAt(0))).toBe(true)
    expect(skyMoonVisible(ATMOSPHERE.day)).toBe(false)
    expect(skyMoonVisible(clockAtmosphereAt(12 * 60))).toBe(false)

    const sky = createSky({} as ThemeApi)
    const moon = sky.getObjectByName('sky.moon') as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
    for (const level of ['low', 'reduced', 'medium', 'high', 'ultra'] as const) {
      applySkyAtmosphere(sky, ATMOSPHERE.night, level, waxingGibbous)
      expect(moon.visible).toBe(true)
    }
    applySkyAtmosphere(sky, ATMOSPHERE.day, 'ultra', waxingGibbous)
    expect(moon.visible).toBe(false)

    ;(sky.userData.dispose as () => void)()
  })

  it('keeps phase work out of the per-frame callback and reuses its uniforms', () => {
    const sky = createSky({} as ThemeApi)
    applySkyAtmosphere(sky, ATMOSPHERE.night, 'high', waxingGibbous)
    const dome = sky.getObjectByName('sky.dome') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
    const moon = sky.getObjectByName('sky.moon') as THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
    const position = moon.position
    const before = position.toArray()
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(10, 20, 30)

    for (let i = 0; i < 3; i++) {
      dome.onBeforeRender(
        {} as THREE.WebGLRenderer,
        {} as THREE.Scene,
        camera,
        dome.geometry,
        dome.material,
        sky as THREE.Group,
      )
      expect(moon.position).toBe(position)
      expect(position.toArray()).toEqual(before)
    }

    ;(sky.userData.dispose as () => void)()
  })
})
