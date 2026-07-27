import { describe, expect, it } from 'vitest'
import {
  ATMOSPHERE,
  DAY_PALETTE,
  NIGHT_PALETTE,
  dayEmissive,
  dayInkOpacity,
  daySurface,
  exactDay,
  hslOf,
} from './themes'

describe('daylight rendering contract', () => {
  it('keeps night untouched and gives daylight the sun-only effects', () => {
    expect(ATMOSPHERE.night.shadows).toBe(false)
    expect(ATMOSPHERE.night.bloomEnabled).toBe(true)
    expect(ATMOSPHERE.night.stars).toBe(true)
    expect(ATMOSPHERE.night.daylight).toBe(false)

    expect(ATMOSPHERE.day.shadows).toBe(true)
    expect(ATMOSPHERE.day.bloomEnabled).toBe(false)
    expect(ATMOSPHERE.day.stars).toBe(false)
    expect(ATMOSPHERE.day.daylight).toBe(true)
    expect(ATMOSPHERE.day.toneMapping).toBe('neutral')
  })

  it('stacks the daylight dome darkest at the zenith and palest below the horizon', () => {
    const air = ATMOSPHERE.day
    const luma = (hex: number): number =>
      0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)
    // Zenith < horizon < below-horizon haze. Any other order is a sky that gets
    // darker as it goes down, which is the night idiom and reads as a grey wall.
    expect(luma(air.skyZenith)).toBeLessThan(luma(air.skyHorizon))
    expect(luma(air.skyHorizon)).toBeLessThan(luma(air.skyHaze))
    const [, zenithSaturation] = hslOf(air.skyZenith)
    const [, horizonSaturation] = hslOf(air.skyHorizon)
    expect(zenithSaturation).toBeGreaterThan(horizonSaturation)
  })

  it('fades distance onto the sky, and lets the plate read the fog in daylight', () => {
    expect(ATMOSPHERE.day.fogColor).toBe(ATMOSPHERE.day.skyHaze)
    expect(ATMOSPHERE.night.fogColor).toBe(ATMOSPHERE.night.skyHaze)
    // The near half of the city used to receive literally no fog: at 2.0/2.0
    // over CITY.fog (220/1150) the curve did not start until 440.
    //
    // Both bounds are load-bearing, and they pull against each other. The city
    // is framed from two distances — the desktop home camera is 450 units from
    // the city centre, the phone's is 1071 — so fog tight enough to give the
    // desktop real depth is measured at over half strength on the phone, where
    // it erases the district hues that carry the meaning.
    const near = 220 * ATMOSPHERE.day.fogNearScale
    const far = 1150 * ATMOSPHERE.day.fogFarScale
    const fogAt = (depth: number): number => (depth - near) / (far - near)
    expect(near).toBeLessThan(400)
    expect(fogAt(840)).toBeGreaterThan(0.2) // desktop: the far side of the city
    expect(fogAt(1071)).toBeLessThan(0.4) // phone: districts keep their colour
    // The Slonik plate silhouette depends on this number at night. Do not move it.
    expect(ATMOSPHERE.night.plateFogScale).toBe(0.32)
    expect(ATMOSPHERE.day.plateFogScale).toBeGreaterThan(ATMOSPHERE.night.plateFogScale)
  })

  it('leaves night exactly where it was when day gained its own atmosphere', () => {
    // Night is the older, better-developed theme and the day work must be a
    // pure addition to it. These are the values the renderer resolved before
    // fogColor and plateFogScale existed: fog.color came from COLOR.fog, which
    // in night mode is NIGHT_PALETTE.fog, and ground.ts held FOG_K = 0.32.
    const night = ATMOSPHERE.night
    expect(night.fogColor).toBe(NIGHT_PALETTE.fog)
    expect(night.plateFogScale).toBe(0.32)
    expect(night.fogNearScale).toBe(1)
    expect(night.fogFarScale).toBe(1)
    expect(night.skyZenith).toBe(0x030408)
    expect(night.skyHorizon).toBe(0x19273f)
    expect(night.skyGlow).toBe(0x573c14)
    expect(night.daylight).toBe(false)
    expect(night.clouds).toBe(false)
  })

  it('maps the district meanings to their hand-picked day colors', () => {
    const keys = ['client', 'backend', 'shmem', 'wal', 'storage', 'vacuum', 'replication'] as const
    for (const key of keys) expect(exactDay(NIGHT_PALETTE[key])).toBe(DAY_PALETTE[key])
    expect(new Set(keys.map((key) => DAY_PALETTE[key])).size).toBe(keys.length)
  })

  it('lifts authored navy structure into light stone and removes dark emissive fill', () => {
    const [, saturation, lightness] = hslOf(daySurface(0x101827))
    expect(lightness).toBeGreaterThanOrEqual(0.48)
    expect(saturation).toBeGreaterThan(0.1)
    expect(dayEmissive(0x0a1220)).toBe(0)
  })

  it('turns blueprint hairlines into opaque daylight ink', () => {
    expect(dayInkOpacity(0.2)).toBeGreaterThanOrEqual(0.6)
    expect(dayInkOpacity(0.8)).toBe(1)
  })
})
