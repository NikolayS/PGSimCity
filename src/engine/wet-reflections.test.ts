import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/themes'
import type { QualityLevel } from '../core/types'
import { groundWetness, wetMirrorShare } from '../world/ground-surface'
import {
  WET_MARCH_GROWTH,
  WET_MARCH_START,
  WET_NIGHT_RADIANCE_CAP,
  WET_PLATE_BAND,
  WET_REFLECTION_PRESETS,
  capMirroredRadiance,
  wetReflectionReach,
} from './wet-reflections'

const LEVELS: readonly QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']

describe('wet-ground reflections', () => {
  it('marches exactly where the paving is wet, and nowhere else', () => {
    for (const level of LEVELS) {
      const { steps, scale } = WET_REFLECTION_PRESETS[level]
      expect(steps > 0, level).toBe(groundWetness(level) > 0)
      expect(scale > 0, level).toBe(steps > 0)
      expect(scale, level).toBeLessThanOrEqual(1)
    }
  })

  it('never spends more on a lower tier than on a higher one', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      const lower = WET_REFLECTION_PRESETS[LEVELS[i - 1]]
      const higher = WET_REFLECTION_PRESETS[LEVELS[i]]
      expect(higher.steps).toBeGreaterThanOrEqual(lower.steps)
      expect(higher.scale).toBeGreaterThanOrEqual(lower.scale)
    }
  })

  it('sums the geometric march to the reach the fade is authored against', () => {
    expect(wetReflectionReach(0)).toBe(0)
    expect(wetReflectionReach(1)).toBeCloseTo(WET_MARCH_START, 10)
    expect(wetReflectionReach(2)).toBeCloseTo(WET_MARCH_START * (1 + WET_MARCH_GROWTH), 10)
    let previous = 0
    for (let steps = 1; steps <= 32; steps++) {
      const reach = wetReflectionReach(steps)
      expect(reach).toBeGreaterThan(previous)
      previous = reach
    }
  })

  it('reaches a backend tower from across a street at every tier that runs', () => {
    for (const level of LEVELS) {
      const { steps } = WET_REFLECTION_PRESETS[level]
      if (steps > 0) expect(wetReflectionReach(steps), level).toBeGreaterThan(60)
    }
  })

  it('caps mirrored night radiance below the bloom threshold', () => {
    // A reflected neon is the same fact seen twice; only the original may glow.
    expect(WET_NIGHT_RADIANCE_CAP).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    // Fresnel tops out at one, so the largest composited mirror is cap x share.
    expect(WET_NIGHT_RADIANCE_CAP * wetMirrorShare(1, 1)).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
  })

  it('caps a mirrored signal without changing its hue', () => {
    // WAL amber at neon intensity: a per-channel clamp made this warn yellow.
    const wal: [number, number, number] = [1.7, 0.74, 0.07]
    const capped = capMirroredRadiance(wal, WET_NIGHT_RADIANCE_CAP)
    expect(Math.max(...capped)).toBeCloseTo(WET_NIGHT_RADIANCE_CAP, 10)
    expect(capped[1] / capped[0]).toBeCloseTo(wal[1] / wal[0], 10)
    expect(capped[2] / capped[0]).toBeCloseTo(wal[2] / wal[0], 10)
    // Anything already under the cap is the same fact, untouched.
    expect(capMirroredRadiance([0.3, 0.2, 0.1], WET_NIGHT_RADIANCE_CAP)).toEqual([0.3, 0.2, 0.1])
    expect(capMirroredRadiance([0, 0, 0], WET_NIGHT_RADIANCE_CAP)).toEqual([0, 0, 0])
  })

  it('confines the mirror to the plate, below the district plinth tops', () => {
    // Plinths stand 0.1 m proud of the plate (world/ground.ts).
    expect(WET_PLATE_BAND).toBeLessThan(0.1)
    expect(WET_PLATE_BAND).toBeGreaterThan(0.035)
  })
})
