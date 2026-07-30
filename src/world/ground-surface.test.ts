import { describe, expect, it } from 'vitest'

import {
  GROUND_SURFACE_SIZE,
  createGroundSurfaceData,
  groundSurfaceDetail,
} from './ground-surface'

describe('procedural ground surface', () => {
  it('builds one deterministic, materially varied tile without an image asset', () => {
    const a = createGroundSurfaceData()
    const b = createGroundSurfaceData()

    expect(a).toEqual(b)
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a).toHaveLength(GROUND_SURFACE_SIZE * GROUND_SURFACE_SIZE)

    let lo = 255
    let hi = 0
    let sum = 0
    const values = new Set<number>()
    for (const sample of a) {
      lo = Math.min(lo, sample)
      hi = Math.max(hi, sample)
      sum += sample
      values.add(sample)
    }

    expect(hi - lo).toBeGreaterThan(70)
    expect(values.size).toBeGreaterThan(48)
    expect(sum / a.length).toBeGreaterThan(95)
    expect(sum / a.length).toBeLessThan(170)
  })

  it('leaves night and both rescue tiers on their established cheap surface', () => {
    expect(groundSurfaceDetail('night', 'ultra')).toBe(0)
    expect(groundSurfaceDetail('day', 'low')).toBe(0)
    expect(groundSurfaceDetail('day', 'reduced')).toBe(0)
    expect(groundSurfaceDetail('day', 'medium')).toBe(1)
    expect(groundSurfaceDetail('day', 'high')).toBe(2)
    expect(groundSurfaceDetail('day', 'ultra')).toBe(2)
  })
})
