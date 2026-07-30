import { describe, expect, it } from 'vitest'

import { FIDELITY_PRESETS, QUALITY_PRESETS } from './renderer'
import type { QualitySettings } from '../core/types'

describe('quality degradation ladder', () => {
  it('spends cheaper reductions before disabling bloom', () => {
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
    expect(presets.slice(0, bloomOff - 1)).toContainEqual(
      expect.objectContaining({
        bloom: true,
        pixelRatio: expect.any(Number),
      }),
    )
    expect(lastBloomOn.pixelRatio).toBeLessThan(presets[0].pixelRatio)
    expect(lastBloomOn.maxParticles).toBeLessThan(presets[0].maxParticles)
    expect(lastBloomOn.maxLabels).toBeLessThan(presets[0].maxLabels)
  })
})

describe('rendering fidelity ladder', () => {
  it('keeps low and reduced on the existing rendering path', () => {
    for (const level of ['low', 'reduced'] as const) {
      expect(FIDELITY_PRESETS[level]).toEqual(
        expect.objectContaining({
          environment: false,
          ambientOcclusion: false,
          aoScale: 0,
          aoSamples: 0,
          shadowMapSize: 1024,
        }),
      )
    }
  })

  it('adds progressively sampled AO and higher-resolution upper-tier shadows', () => {
    const medium = FIDELITY_PRESETS.medium
    const high = FIDELITY_PRESETS.high
    const ultra = FIDELITY_PRESETS.ultra

    expect(medium.environment).toBe(true)
    expect(medium.ambientOcclusion).toBe(true)
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
})
