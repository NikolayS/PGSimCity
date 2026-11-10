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

/** Street-scale survey marks retire smoothly as the camera rises above them. */
export function groundSurveyDetail(cameraHeight: number): number {
  const t = Math.max(0, Math.min(1, (Math.abs(cameraHeight) - 40) / 280))
  return 1 - t * t * (3 - 2 * t)
}

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

/**
 * Rain-wet paving costs two noise fields over the largest surface in frame, so
 * only the tiers that already pay for the aggregate lookup receive it.
 */
export function groundWetness(quality: QualityLevel): number {
  return quality === 'high' || quality === 'ultra' ? 1 : 0
}

/**
 * Peak radiance of the key light mirrored in standing water. Night stays below
 * the bloom threshold: a moon glint must never glow like a semantic signal.
 */
export function groundGlint(daylight: boolean): number {
  return daylight ? 2.4 : 0.55
}

/** Fresnel floor of the stylized water film; real water is 0.02 and reads as dry from orbit. */
export const WET_FRESNEL_FLOOR = 0.08
/** Share of the mirrored radiance kept by standing water and by merely damp paving. */
export const WET_POOL_MIRROR = 0.92
export const WET_DAMP_MIRROR = 0.5

/**
 * One wetness field for every consumer. The plate shades with it and the
 * reflection pass masks with it, so a mirrored building can only ever appear
 * where the paving already shows standing water.
 */
export const WET_FIELD_GLSL = /* glsl */ `
float wetHash( vec2 p ) {
  p = fract( p * vec2( 0.1031, 0.1030 ) );
  p += dot( p, p.yx + 33.33 );
  return fract( ( p.x + p.y ) * p.x );
}

float wetNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( wetHash( i ), wetHash( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( wetHash( i + vec2( 0.0, 1.0 ) ), wetHash( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y
  );
}

// Rotated lacunarity hides the lattice; four octaves is the whole budget.
float wetFbm( vec2 p ) {
  float sum = 0.0;
  float amp = 0.5;
  for ( int i = 0; i < 4; i++ ) {
    sum += amp * wetNoise( p );
    p = mat2( 1.6, 1.2, -1.2, 1.6 ) * p;
    amp *= 0.5;
  }
  return sum;
}

// x: broad tone, y: fine tone, z: damp paving, w: standing water.
vec4 wetField( vec2 p, float viewDistance ) {
  float broad = wetFbm( p / 96.0 + 7.3 );
  float fine = wetFbm( p / 13.0 - 3.1 );
  float nearFine = 1.0 - smoothstep( 260.0, 900.0, viewDistance );
  float level = broad * 0.78 + fine * 0.22 * nearFine + 0.11 * ( 1.0 - nearFine );
  return vec4(
    broad,
    ( fine - 0.47 ) * nearFine,
    smoothstep( 0.30, 0.44, level ),
    smoothstep( 0.46, 0.51, level )
  );
}

vec3 wetSky( vec3 mirror, vec3 sunDirection, vec3 zenith, vec3 horizon, vec3 glow ) {
  float sunward = max( dot( mirror, sunDirection ), 0.0 );
  return mix( horizon, zenith, pow( clamp( mirror.y, 0.0, 1.0 ), 0.6 ) ) + glow * pow( sunward, 18.0 ) * 0.55;
}

float wetFresnel( float cosine ) {
  return ${WET_FRESNEL_FLOOR.toFixed(3)} + ${(1 - WET_FRESNEL_FLOOR).toFixed(3)} * pow( 1.0 - clamp( cosine, 0.0, 1.0 ), 5.0 );
}

float wetMirror( float damp, float pool ) {
  return pool * ${WET_POOL_MIRROR.toFixed(3)} + damp * ${WET_DAMP_MIRROR.toFixed(3)};
}
`

/**
 * Diffuse return of the horizon's glow from wet paving. Daylight needs none:
 * its mirror term already carries a bright sky. `daylight` is 0 at night, 1 by day.
 */
export function groundSkyFill(daylight: number): number {
  return 0.55 * (1 - Math.max(0, Math.min(1, daylight)))
}
