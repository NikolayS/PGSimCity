import type { QualityLevel } from '../core/types'
import type { ThemeMode } from '../core/themes'

/** Power-of-two so WebGL can build a complete mip chain for the repeating tile. */
export const GROUND_SURFACE_SIZE = 128

/**
 * One-channel, tileable aggregate and curing variation for the civic paving.
 * Integer-frequency waves meet exactly at the wrap; the sparse chips keep the
 * result from looking like procedural camouflage at walking distance.
 */
export function createGroundSurfaceData(size = GROUND_SURFACE_SIZE): Uint8Array {
  const data = new Uint8Array(size * size)
  const tau = Math.PI * 2

  for (let y = 0; y < size; y++) {
    const v = (y / size) * tau
    for (let x = 0; x < size; x++) {
      const u = (x / size) * tau
      const broad = Math.sin(u * 3 + Math.sin(v * 2) * 0.9)
      const cross = Math.sin(u * 7 - v * 5 + Math.sin(u + v) * 0.7)
      const grain = Math.cos(u * 13 + v * 11)

      // Integer hashing supplies occasional pale aggregate and dark pinholes.
      // It is decoration of the albedo, never a semantic or emissive channel.
      let hash = Math.imul(x + 17, 0x45d9f3b) ^ Math.imul(y + 31, 0x119de1f3)
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b)
      const chip = (hash >>> 0) / 0xffffffff
      const aggregate = chip > 0.982 ? 38 : chip < 0.014 ? -34 : 0

      const value = 132 + broad * 29 + cross * 17 + grain * 8 + aggregate
      data[y * size + x] = Math.max(0, Math.min(255, Math.round(value)))
    }
  }

  return data
}

/**
 * Rescue tiers keep the original plate, medium gets geometry-scale joints, and
 * only the two top tiers sample aggregate over the full ground framebuffer.
 */
export function groundSurfaceDetail(mode: ThemeMode, quality: QualityLevel): 0 | 1 | 2 {
  if (mode === 'night' || quality === 'low' || quality === 'reduced') return 0
  return quality === 'medium' ? 1 : 2
}
