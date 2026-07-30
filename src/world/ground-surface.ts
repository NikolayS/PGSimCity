import type { QualityLevel } from '../core/types'
import type { ThemeMode } from '../core/themes'

/** Power-of-two so WebGL can build a complete mip chain for the repeating tile. */
export const GROUND_SURFACE_SIZE = 128
/** RG are the tangent normal, B preserves the old albedo signal, A is roughness. */
export const GROUND_SURFACE_CHANNELS = 4
/** The shader repeats one tile over this many world metres. */
export const GROUND_SURFACE_WORLD_METRES = 52
/** Aggregate relief is restrained because the ground is usually seen obliquely. */
export const GROUND_SURFACE_HEIGHT_METRES = 0.045
/** Narrow encoding preserves sub-degree aggregate slopes in eight-bit RG. */
export const GROUND_SURFACE_MAX_SLOPE = 0.12
const ROUGHNESS_MIN = 0.72
const ROUGHNESS_MAX = 0.94

/**
 * Tileable aggregate and curing variation for the civic paving. The original
 * height is retained in B while RG and A derive its normal and roughness.
 * Integer-frequency waves meet at the wrap; sparse chips prevent camouflage.
 */
export function createGroundSurfaceData(size = GROUND_SURFACE_SIZE): Uint8Array {
  const height = new Uint8Array(size * size)
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
      height[y * size + x] = Math.max(0, Math.min(255, Math.round(value)))
    }
  }

  const data = new Uint8Array(size * size * GROUND_SURFACE_CHANNELS)
  const texelMetres = GROUND_SURFACE_WORLD_METRES / size
  const heightPerSample = GROUND_SURFACE_HEIGHT_METRES / 255
  for (let y = 0; y < size; y++) {
    const ym = (y + size - 1) % size
    const yp = (y + 1) % size
    for (let x = 0; x < size; x++) {
      const xm = (x + size - 1) % size
      const xp = (x + 1) % size
      const centre = height[y * size + x]
      const dx = ((height[y * size + xp] - height[y * size + xm]) * heightPerSample) / (2 * texelMetres)
      const dz = ((height[yp * size + x] - height[ym * size + x]) * heightPerSample) / (2 * texelMetres)
      const invLength = 1 / Math.hypot(dx, 1, dz)
      const offset = (y * size + x) * GROUND_SURFACE_CHANNELS
      const nx = Math.max(-GROUND_SURFACE_MAX_SLOPE, Math.min(GROUND_SURFACE_MAX_SLOPE, -dx * invLength))
      const nz = Math.max(-GROUND_SURFACE_MAX_SLOPE, Math.min(GROUND_SURFACE_MAX_SLOPE, -dz * invLength))
      data[offset] = Math.round((nx / GROUND_SURFACE_MAX_SLOPE * 0.5 + 0.5) * 255)
      data[offset + 1] = Math.round((nz / GROUND_SURFACE_MAX_SLOPE * 0.5 + 0.5) * 255)
      data[offset + 2] = centre
      data[offset + 3] = Math.round((ROUGHNESS_MIN + (centre / 255) * (ROUGHNESS_MAX - ROUGHNESS_MIN)) * 255)
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
