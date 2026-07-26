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

  it('gives daylight a saturated zenith above the named horizon blue', () => {
    expect(ATMOSPHERE.day.skyHorizon).toBe(0xbcdcf2)
    expect(ATMOSPHERE.day.skyZenith).not.toBe(ATMOSPHERE.day.skyHorizon)
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
