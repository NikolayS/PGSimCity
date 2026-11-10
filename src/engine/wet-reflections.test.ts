import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/themes'
import type { QualityLevel } from '../core/types'
import { groundWetness } from '../world/ground-surface'
import {
  WET_MARCH_GROWTH,
  WET_MARCH_START,
  WET_NIGHT_RADIANCE_CAP,
  WET_PLATE_BAND,
  WET_REFLECTION_PRESETS,
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
  })

  it('confines the mirror to the plate, below the district plinth tops', () => {
    // Plinths stand 0.1 m proud of the plate (world/ground.ts).
    expect(WET_PLATE_BAND).toBeLessThan(0.1)
    expect(WET_PLATE_BAND).toBeGreaterThan(0.035)
  })
})
