import { describe, expect, it } from 'vitest'

import { ATMOSPHERE } from '../core/themes'

import {
  GROUND_SURFACE_CHANNELS,
  GROUND_SURFACE_HEIGHT_METRES,
  GROUND_SURFACE_MAX_SLOPE,
  GROUND_SURFACE_SIZE,
  GROUND_SURFACE_WORLD_METRES,
  WET_DAMP_MIRROR,
  WET_FIELD_GLSL,
  WET_FRESNEL_FLOOR,
  WET_POOL_MIRROR,
  createGroundSurfaceData,
  groundGlint,
  groundSkyFill,
  groundSurfaceDetail,
  groundWetness,
  wetMirrorShare,
  groundSurveyDetail,
} from './ground-surface'

describe('procedural ground surface', () => {
  it('reveals survey detail near the street and retires it continuously at city altitude', () => {
    expect(groundSurveyDetail(0)).toBe(1)
    expect(groundSurveyDetail(40)).toBe(1)
    expect(groundSurveyDetail(320)).toBe(0)
    expect(groundSurveyDetail(1650)).toBe(0)
    let previous = 1
    for (let height = 0; height <= 400; height += 5) {
      const detail = groundSurveyDetail(height)
      expect(detail).toBeGreaterThanOrEqual(0)
      expect(detail).toBeLessThanOrEqual(previous)
      expect(previous - detail).toBeLessThan(0.03)
      expect(groundSurveyDetail(-height)).toBe(detail)
      previous = detail
    }
  })

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

  it('spends rain-wet paving only on the tiers that already sample the aggregate', () => {
    expect(groundWetness('low')).toBe(0)
    expect(groundWetness('reduced')).toBe(0)
    expect(groundWetness('medium')).toBe(0)
    expect(groundWetness('high')).toBe(1)
    expect(groundWetness('ultra')).toBe(1)
  })

  it('keeps a mirrored moon below the night bloom threshold', () => {
    // Glow is reserved for meaning; standing water is weather.
    expect(groundGlint(false)).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(groundGlint(true)).toBeGreaterThan(groundGlint(false))
  })

  it('returns the horizon glow from wet paving only as the sun leaves', () => {
    expect(groundSkyFill(1)).toBe(0)
    expect(groundSkyFill(0)).toBeGreaterThan(0)
    expect(groundSkyFill(0)).toBeLessThan(1)
    expect(groundSkyFill(0.5)).toBeLessThan(groundSkyFill(0))
    expect(groundSkyFill(-3)).toBe(groundSkyFill(0))
    expect(groundSkyFill(9)).toBe(0)
  })

  it('makes standing water a stronger mirror than damp paving, and neither a full one', () => {
    expect(WET_POOL_MIRROR).toBeGreaterThan(WET_DAMP_MIRROR)
    expect(WET_POOL_MIRROR).toBeLessThan(1)
    expect(WET_DAMP_MIRROR).toBeGreaterThan(0)
    expect(WET_FRESNEL_FLOOR).toBeGreaterThanOrEqual(0.02)
    expect(WET_FRESNEL_FLOOR).toBeLessThan(0.2)
  })

  it('never lets the mirror replace more than the whole pixel, or bloom', () => {
    /* The share was once a sum that reached 1.42 where a pool sat in damp
     * paving: the blend subtracted the paving and a capped reflection crossed
     * the bloom threshold anyway. */
    let peak = 0
    for (let damp = 0; damp <= 1.0001; damp += 0.05) {
      for (let pool = 0; pool <= 1.0001; pool += 0.05) {
        peak = Math.max(peak, wetMirrorShare(damp, pool))
      }
    }
    expect(peak).toBeLessThanOrEqual(WET_POOL_MIRROR)
    expect(wetMirrorShare(1, 1)).toBe(WET_POOL_MIRROR)
    expect(wetMirrorShare(1, 0)).toBe(WET_DAMP_MIRROR)
    expect(wetMirrorShare(0, 0)).toBe(0)
    expect(WET_FIELD_GLSL).toContain(`mix( damp * ${WET_DAMP_MIRROR.toFixed(3)}, ${WET_POOL_MIRROR.toFixed(3)}, pool )`)
  })

  it('floods standing water only inside paving that is already damp', () => {
    const steps = /smoothstep\( ([0-9.]+), ([0-9.]+), level \),\s+smoothstep\( ([0-9.]+), ([0-9.]+), level \)/.exec(
      WET_FIELD_GLSL,
    )
    expect(steps).not.toBeNull()
    const [dampLo, dampHi, poolLo, poolHi] = steps!.slice(1).map(Number)
    expect(dampLo).toBeLessThan(dampHi)
    expect(poolLo).toBeGreaterThanOrEqual(dampHi)
    expect(poolHi).toBeGreaterThan(poolLo)
    // Weather may darken and mirror; it may never emit.
    expect(WET_FIELD_GLSL).not.toContain('emissive')
  })
})
