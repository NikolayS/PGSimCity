import { describe, expect, it } from 'vitest'

import { DAY_PALETTE } from '../core/themes'
import { gradeDaylightHex, perceptualColorDistance } from '../engine/color-grade'
import {
  MAX_BLEED,
  SEMANTIC_BOUNCE_KEYS,
  decodeTransportByte,
  encodeTransportByte,
  mixBoundaryColor,
} from './baked-light'
import {
  BAKED_LIGHT_BASE64,
  BAKED_LIGHT_BAKE_MS,
  BAKED_LIGHT_BYTES,
  BAKED_LIGHT_ENTRIES,
} from './baked-light-data'

describe('baked indirect-light transport', () => {
  it('ships a complete compact bake rather than computing one at boot', () => {
    const bytes = Uint8Array.from(atob(BAKED_LIGHT_BASE64), (value) => value.charCodeAt(0))
    expect(BAKED_LIGHT_ENTRIES.length).toBeGreaterThan(100)
    expect(bytes.byteLength).toBe(BAKED_LIGHT_BYTES)
    expect(BAKED_LIGHT_BYTES).toBeLessThan(64 * 1024)
    expect(BAKED_LIGHT_BAKE_MS).toBeLessThan(1000)

    let end = 0
    for (const entry of BAKED_LIGHT_ENTRIES) {
      expect(entry.offset).toBe(end)
      end += entry.count * (entry.instanced ? 12 : 2)
    }
    expect(end).toBe(BAKED_LIGHT_BYTES)
  })

  it('round-trips a semantic source and keeps transfer below the hue-safety cap', () => {
    for (let source = 0; source < SEMANTIC_BOUNCE_KEYS.length; source++) {
      const encoded = encodeTransportByte(source, 1)
      const decoded = decodeTransportByte(encoded)
      expect(decoded.source).toBe(source)
      expect(decoded.weight).toBeCloseTo(MAX_BLEED, 5)
    }
  })

  it('keeps all 45 semantic pairs distinct under worst-case mutual boundary bleed', () => {
    const colors = SEMANTIC_BOUNCE_KEYS.map((key) => DAY_PALETTE[key])
    let pairs = 0
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        const a = gradeDaylightHex(mixBoundaryColor(colors[i], colors[j], MAX_BLEED))
        const b = gradeDaylightHex(mixBoundaryColor(colors[j], colors[i], MAX_BLEED))
        expect(
          perceptualColorDistance(a, b),
          `${SEMANTIC_BOUNCE_KEYS[i]} vs ${SEMANTIC_BOUNCE_KEYS[j]}`,
        ).toBeGreaterThan(0.045)
        pairs++
      }
    }
    expect(pairs).toBe(45)
  })

  it('protects the three strongest district boundaries from hue takeover', () => {
    const boundaries = [
      ['shmem', 'wal'],
      ['shmem', 'vacuum'],
      ['storage', 'shmem'],
    ] as const
    for (const [receiver, neighbour] of boundaries) {
      const mixed = mixBoundaryColor(
        DAY_PALETTE[receiver],
        DAY_PALETTE[neighbour],
        MAX_BLEED,
      )
      expect(
        perceptualColorDistance(mixed, DAY_PALETTE[receiver]),
        `${receiver} boundary`,
      ).toBeLessThan(
        perceptualColorDistance(mixed, DAY_PALETTE[neighbour]),
      )
    }
  })
})
