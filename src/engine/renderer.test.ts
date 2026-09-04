import { describe, expect, it } from 'vitest'

import { AO_BLEND_INTENSITY, FIDELITY_PRESETS, QUALITY_PRESETS, ShadowRefreshSchedule } from './renderer'
import { LIGHT_SHAFT_PRESETS } from './light-shafts'
import type { QualitySettings } from '../core/types'

describe('quality degradation ladder', () => {
  it('degrades decoration without removing semantic labels or route particles', () => {
    const presets = Object.values(QUALITY_PRESETS).reverse()
    const bloomOff = presets.findIndex((preset) => !preset.bloom)

    expect(bloomOff).toBeGreaterThan(0)

    const lastBloomOn = presets[bloomOff - 1]
    const firstBloomOff = presets[bloomOff]
    const renderCost = (preset: QualitySettings) => ({
      pixelRatio: preset.pixelRatio,
      maxParticles: preset.maxParticles,
      maxLabels: preset.maxLabels,
      antialias: preset.antialias,
      shadows: preset.shadows,
    })

    expect(renderCost(firstBloomOff)).toEqual(renderCost(lastBloomOn))
    expect(new Set(presets.map((preset) => preset.maxParticles))).toHaveLength(1)
    expect(new Set(presets.map((preset) => preset.maxLabels))).toHaveLength(1)
    expect(presets.slice(0, bloomOff - 1)).toContainEqual(
      expect.objectContaining({
        bloom: true,
        pixelRatio: expect.any(Number),
      }),
    )
    expect(lastBloomOn.pixelRatio).toBeLessThan(presets[0].pixelRatio)
    expect(lastBloomOn.antialias).toBe(false)
    expect(lastBloomOn.shadows).toBe(false)
  })
})

describe('animated shadow refresh', () => {
  it('refreshes on first use and bounds medium redraws independently of frame rate', () => {
    for (const fps of [30, 60, 120]) {
      const schedule = new ShadowRefreshSchedule()
      const interval = FIDELITY_PRESETS.medium.shadowUpdateInterval
      expect(schedule.advance(0, interval)).toBe(true)
      let refreshes = 0
      for (let frame = 0; frame < fps; frame++) {
        if (schedule.advance(1 / fps, interval)) refreshes++
      }
      expect(refreshes).toBeGreaterThanOrEqual(7)
      expect(refreshes).toBeLessThanOrEqual(8)
    }
  })

  it('uses the new tier budget immediately and does not replay missed refreshes', () => {
    const schedule = new ShadowRefreshSchedule()
    expect(schedule.advance(0, 1 / 8)).toBe(true)
    expect(schedule.advance(0.01, 1 / 8)).toBe(false)
    expect(schedule.advance(0.01, 0)).toBe(true)
    expect(schedule.advance(4, 1 / 8)).toBe(true)
    expect(schedule.advance(0.01, 1 / 8)).toBe(false)
  })
})

describe('rendering fidelity ladder', () => {
  it('grounds daylight more strongly while keeping night AO subordinate to neon', () => {
    // Relational, not pinned: AO grounds daylight and stays subordinate to night
    // neon. A pinned constant here would be Rule 9 in miniature -- it asserts the
    // value someone happened to ship, not the property the ladder must hold.
    expect(AO_BLEND_INTENSITY.day).toBeGreaterThan(AO_BLEND_INTENSITY.night)
    expect(AO_BLEND_INTENSITY.day).toBeLessThanOrEqual(1)
    expect(AO_BLEND_INTENSITY.night).toBeLessThan(0.5)
  })

  it('keeps low and reduced on the existing rendering path', () => {
    for (const level of ['low', 'reduced'] as const) {
      expect(FIDELITY_PRESETS[level]).toEqual(
        expect.objectContaining({
          environment: false,
          reflectionScale: 0,
          ambientOcclusion: false,
          aerialPerspective: 0,
          aoScale: 0,
          aoSamples: 0,
          shadowMapSize: 1024,
        }),
      )
      expect(LIGHT_SHAFT_PRESETS[level].scale).toBe(0)
    }
  })

  it('adds progressively sampled AO and higher-resolution upper-tier shadows', () => {
    const medium = FIDELITY_PRESETS.medium
    const high = FIDELITY_PRESETS.high
    const ultra = FIDELITY_PRESETS.ultra

    expect(medium.environment).toBe(true)
    expect(medium.reflectionScale).toBe(0.25)
    expect(high.reflectionScale).toBe(0.5)
    expect(ultra.reflectionScale).toBe(0.5)
    expect(medium.ambientOcclusion).toBe(true)
    expect(medium.aerialPerspective).toBeGreaterThan(0)
    expect(high.aerialPerspective).toBeGreaterThan(medium.aerialPerspective)
    expect(ultra.aerialPerspective).toBeGreaterThanOrEqual(high.aerialPerspective)
    expect(medium.aoScale).toBeGreaterThan(0)
    expect(medium.aoSamples).toBeGreaterThan(0)
    expect(high.aoScale).toBeGreaterThan(medium.aoScale)
    expect(high.aoSamples).toBeGreaterThan(medium.aoSamples)
    expect(ultra.aoScale).toBeGreaterThan(high.aoScale)
    expect(ultra.aoSamples).toBeGreaterThan(high.aoSamples)
    expect(high.shadowMapSize).toBeGreaterThan(medium.shadowMapSize)
    expect(ultra.shadowMapSize).toBeGreaterThanOrEqual(high.shadowMapSize)
    expect(ultra.shadowRadius).toBeGreaterThan(high.shadowRadius)
  })

  it('retains medium sun shadows with a reduced refresh budget', () => {
    expect(QUALITY_PRESETS.medium.shadows).toBe(true)
    expect(FIDELITY_PRESETS.medium.shadowMapSize).toBeLessThan(FIDELITY_PRESETS.high.shadowMapSize)
    expect(FIDELITY_PRESETS.medium.shadowUpdateInterval).toBeGreaterThanOrEqual(0.1)
    expect(FIDELITY_PRESETS.high.shadowUpdateInterval).toBeLessThan(FIDELITY_PRESETS.medium.shadowUpdateInterval)
    expect(FIDELITY_PRESETS.ultra.shadowUpdateInterval).toBe(0)
  })
})
