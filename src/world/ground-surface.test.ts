import { describe, expect, it } from 'vitest'

import {
  GROUND_SURFACE_CHANNELS,
  GROUND_SURFACE_HEIGHT_METRES,
  GROUND_SURFACE_MAX_SLOPE,
  GROUND_SURFACE_SIZE,
  GROUND_SURFACE_WORLD_METRES,
  createGroundSurfaceData,
  groundSurfaceDetail,
} from './ground-surface'

describe('procedural ground surface', () => {
  it('builds one deterministic, materially varied tile without an image asset', () => {
    const a = createGroundSurfaceData()
    const b = createGroundSurfaceData()

    expect(a).toEqual(b)
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a).toHaveLength(GROUND_SURFACE_SIZE * GROUND_SURFACE_SIZE * GROUND_SURFACE_CHANNELS)

    let lo = 255
    let hi = 0
    let sum = 0
    const values = new Set<number>()
    for (let i = 0; i < a.length; i += GROUND_SURFACE_CHANNELS) {
      const sample = a[i + 2]
      lo = Math.min(lo, sample)
      hi = Math.max(hi, sample)
      sum += sample
      values.add(sample)
    }

    expect(hi - lo).toBeGreaterThan(70)
    expect(values.size).toBeGreaterThan(48)
    const pixels = a.length / GROUND_SURFACE_CHANNELS
    expect(sum / pixels).toBeGreaterThan(95)
    expect(sum / pixels).toBeLessThan(170)
  })

  it('packs finite-difference normals and roughness from that same height field', () => {
    const data = createGroundSurfaceData()
    const texelMetres = GROUND_SURFACE_WORLD_METRES / GROUND_SURFACE_SIZE
    let tilted = 0
    let roughLo = 255
    let roughHi = 0
    let heightRoughCovariance = 0
    let heightMean = 0
    let roughMean = 0
    const pixels = GROUND_SURFACE_SIZE * GROUND_SURFACE_SIZE

    for (let i = 0; i < data.length; i += GROUND_SURFACE_CHANNELS) {
      const nx = (data[i] / 127.5 - 1) * GROUND_SURFACE_MAX_SLOPE
      const nz = (data[i + 1] / 127.5 - 1) * GROUND_SURFACE_MAX_SLOPE
      if (Math.hypot(nx, nz) > 0.002) tilted++
      roughLo = Math.min(roughLo, data[i + 3])
      roughHi = Math.max(roughHi, data[i + 3])
      heightMean += data[i + 2] / pixels
      roughMean += data[i + 3] / pixels
    }
    for (let i = 0; i < data.length; i += GROUND_SURFACE_CHANNELS) {
      heightRoughCovariance +=
        (data[i + 2] - heightMean) * (data[i + 3] - roughMean)
    }

    expect(GROUND_SURFACE_HEIGHT_METRES).toBeGreaterThanOrEqual(0.02)
    expect(GROUND_SURFACE_HEIGHT_METRES).toBeLessThanOrEqual(0.06)
    expect(texelMetres).toBeGreaterThan(GROUND_SURFACE_HEIGHT_METRES * 6)
    expect(tilted / pixels).toBeGreaterThan(0.6)
    expect(roughHi - roughLo).toBeGreaterThan(24)
    expect(heightRoughCovariance).toBeGreaterThan(0)
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
