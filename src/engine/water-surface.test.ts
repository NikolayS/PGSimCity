import { describe, expect, it } from 'vitest'

import { ATMOSPHERE, DAY_PALETTE } from '../core/themes'
import { perceptualColorDistance } from './color-grade'
import { POOL_CAUSTIC_PEAK, POOL_NIGHT_RADIANCE_CAP, poolGlint } from './water'

/** Blend `hex` toward white by `amount` in display space: the caustic veil at its peak. */
function veiled(hex: number, amount: number): number {
  const channel = (shift: number) => {
    const value = (hex >> shift) & 255
    return Math.round(value + (255 - value) * amount)
  }
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

describe('buffer pool water surface', () => {
  it('keeps every mirrored signal and every glint under the bloom threshold where bloom runs', () => {
    // A neon reflected in the pool is the same fact twice; only the original glows.
    expect(POOL_NIGHT_RADIANCE_CAP).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(poolGlint(false)).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(poolGlint(true)).toBeGreaterThan(poolGlint(false))
  })

  it('cannot make one page state read as another through a caustic line', () => {
    /* The tiles under the water carry state in their colour. A caustic lifts
     * the tile beneath it and leaves its neighbour alone, so the worst case is
     * one state fully veiled against another not veiled at all. */
    const states = ['bufClean', 'bufDirty', 'bufPinned', 'bufFree'] as const
    for (const a of states) {
      for (const b of states) {
        if (a === b) continue
        const clear = perceptualColorDistance(DAY_PALETTE[a], DAY_PALETTE[b])
        const through = perceptualColorDistance(veiled(DAY_PALETTE[a], POOL_CAUSTIC_PEAK), DAY_PALETTE[b])
        expect(through, `${a} veiled vs ${b}`).toBeGreaterThanOrEqual(0.045)
        // And it never costs more than a fifth of the separation the pair had.
        expect(through, `${a} veiled vs ${b}`).toBeGreaterThan(clear * 0.8)
      }
    }
  })

  it('keeps the caustic veil a hint, not a layer', () => {
    expect(POOL_CAUSTIC_PEAK).toBeGreaterThan(0)
    expect(POOL_CAUSTIC_PEAK).toBeLessThanOrEqual(0.08)
  })
})
