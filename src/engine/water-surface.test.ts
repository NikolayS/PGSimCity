import { describe, expect, it } from 'vitest'

import { ATMOSPHERE, NIGHT_PALETTE } from '../core/themes'
import { perceptualColorDistance } from './color-grade'
import { POOL_CAUSTIC_PEAK, POOL_NIGHT_RADIANCE_CAP, POOL_SURFACE_FRAGMENT, poolGlint, poolGlintCover, poolMirrorEnabled } from './water'

type Rgb = [number, number, number]

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toDisplay = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function linear(hex: number): Rgb {
  return [toLinear(((hex >> 16) & 255) / 255), toLinear(((hex >> 8) & 255) / 255), toLinear((hex & 255) / 255)]
}

function hex(rgb: Rgb): number {
  const channel = (v: number) => Math.round(Math.min(1, Math.max(0, toDisplay(v))) * 255)
  return (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2])
}

/* The tiles a reader sees, not palette swatches: shmem.ts writes the night
 * palette colour times a per-state level, and in daylight theme.ts
 * (VCOLOR_BODY) re-decides its value while keeping its hue. */
const TILE_LEVELS = { cleanCold: ['bufClean', 0.26], cleanHot: ['bufClean', 0.42], dirty: ['bufDirty', 0.46], free: ['bufFree', 0.8] } as const
type Tile = keyof typeof TILE_LEVELS

function nightTile(tile: Tile): Rgb {
  const [key, level] = TILE_LEVELS[tile]
  const c = linear(NIGHT_PALETTE[key])
  return [c[0] * level, c[1] * level, c[2] * level]
}

function dayTile(tile: Tile): Rgb {
  const c = nightTile(tile)
  const peak = Math.max(c[0], c[1], c[2], 1e-4)
  const luminance = Math.min(1, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
  const value = 0.46 + (0.04 - 0.46) * luminance ** 0.45
  const hued = Math.min(1, Math.max(0, (peak - 0.02) * 6))
  return [0, 1, 2].map((i) => value + ((c[i] / peak) * value - value) * hued) as Rgb
}

/** What the surface shader does: blend toward the key light, in linear light. */
function veiled(tile: Rgb, key: number, amount: number): Rgb {
  const k = linear(key)
  return [0, 1, 2].map((i) => tile[i] + (k[i] - tile[i]) * amount) as Rgb
}

const STATES: readonly [Tile, Tile][] = [
  ['cleanCold', 'dirty'], ['cleanHot', 'dirty'], ['cleanCold', 'free'], ['cleanHot', 'free'], ['dirty', 'free'],
]

describe('buffer pool water surface', () => {
  it('keeps every mirrored signal and every glint under the bloom threshold where bloom runs', () => {
    // A neon reflected in the pool is the same fact twice; only the original glows.
    expect(POOL_NIGHT_RADIANCE_CAP).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(poolGlint(false)).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(poolGlint(true)).toBeGreaterThan(poolGlint(false))
  })

  it('caps the mirror and the glint together, not each alone', () => {
    /* Two terms each under the threshold can still sum past it at the exact
     * specular peak. The cap has to be the last thing that touches radiance. */
    const glint = POOL_SURFACE_FRAGMENT.indexOf('float sparkle = min( glint * uGlint, uGlintCover );')
    const cap = POOL_SURFACE_FRAGMENT.lastIndexOf('uRadianceCap /')
    expect(glint).toBeGreaterThan(-1)
    expect(cap).toBeGreaterThan(glint)
  })

  it('cannot make one page state read as another through a caustic line', () => {
    /* A caustic lifts the tile beneath it and leaves its neighbour alone, so
     * the worst case is one state fully veiled against another not at all. */
    const key = ATMOSPHERE.day.keyColor
    for (const pair of STATES) {
      for (const [a, b] of [pair, [pair[1], pair[0]]] as const) {
        const clear = perceptualColorDistance(hex(dayTile(a)), hex(dayTile(b)))
        const through = perceptualColorDistance(hex(veiled(dayTile(a), key, POOL_CAUSTIC_PEAK)), hex(dayTile(b)))
        expect(through, `${a} veiled vs ${b}`).toBeGreaterThanOrEqual(0.045)
        // And it never costs more than a fifth of the separation the pair had.
        expect(through, `${a} veiled vs ${b}`).toBeGreaterThan(clear * 0.8)
      }
    }
  })

  it('cannot blank or restate a page tile under the brightest sparkle', () => {
    /* Glitter stacks on a caustic line. Even then the tile beneath keeps its
     * own state: day against the 0.045 floor, night against 0.038. */
    const cases = [
      { tile: dayTile, key: ATMOSPHERE.day.keyColor, cover: poolGlintCover(true), caustic: POOL_CAUSTIC_PEAK, floor: 0.045 },
      { tile: nightTile, key: ATMOSPHERE.night.keyColor, cover: poolGlintCover(false), caustic: 0, floor: 0.038 },
    ]
    for (const { tile, key, cover, caustic, floor } of cases) {
      expect(cover).toBeLessThanOrEqual(0.25)
      for (const pair of STATES) {
        for (const [a, b] of [pair, [pair[1], pair[0]]] as const) {
          const lit = veiled(veiled(tile(a), key, caustic), key, cover)
          expect(perceptualColorDistance(hex(lit), hex(tile(b))), `${a} under glitter vs ${b}`).toBeGreaterThanOrEqual(floor)
          // It still reads as itself: nearer its own clear state than the other's.
          expect(perceptualColorDistance(hex(lit), hex(tile(a)))).toBeLessThan(perceptualColorDistance(hex(lit), hex(tile(b))))
        }
      }
    }
  })

  it('mirrors nothing at night, where a reflection would carry another district\'s hue onto the tiles', () => {
    for (const scale of [0.25, 0.5]) {
      expect(poolMirrorEnabled(scale, false, true)).toBe(false)
      expect(poolMirrorEnabled(scale, true, true)).toBe(true)
    }
    expect(poolMirrorEnabled(0, true, true)).toBe(false)
    expect(poolMirrorEnabled(0.5, true, false)).toBe(false)
  })

  it('keeps the caustic veil a hint, not a layer', () => {
    expect(POOL_CAUSTIC_PEAK).toBeGreaterThan(0)
    expect(POOL_CAUSTIC_PEAK).toBeLessThanOrEqual(0.08)
  })
})
