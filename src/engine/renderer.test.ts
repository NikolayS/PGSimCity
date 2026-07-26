import { describe, expect, it } from 'vitest'

import { QUALITY_PRESETS } from './renderer'
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
