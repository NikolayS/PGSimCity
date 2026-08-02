import { describe, expect, it } from 'vitest'

import {
  BOUNCE_PALETTE_KEYS,
  DAY_PALETTE,
  NIGHT_PALETTE,
  clockAtmosphereAt,
  clockPaletteAt,
} from '../core/themes'
import {
  HEIGHT_FOG_MAX,
  GOLDEN_HOUR_GRADE,
  gradeDaylightHex,
  gradeDaylightHexWithHeightFog,
  gradeDaylightHexWithScatter,
  foggedNightHex,
  heightFogAmount,
  perceptualColorDistance,
} from './color-grade'
import { LIGHT_SHAFT_COLOR, LIGHT_SHAFT_PRESETS } from './light-shafts'
import { FIDELITY_PRESETS } from './renderer'

const SEMANTIC = [
  'wal',
  'bufDirty',
  'vacuum',
  'checkpoint',
  'bgwriter',
  'replication',
  'storage',
  'index',
  'lock',
  'shmem',
] as const

describe('golden-hour colour grade', () => {
  it('contains lift, gamma, gain, a midtone saturation curve and a restrained vignette', () => {
    expect(GOLDEN_HOUR_GRADE.lift).toBeGreaterThan(0)
    expect(GOLDEN_HOUR_GRADE.gamma).not.toBe(1)
    expect(GOLDEN_HOUR_GRADE.gain).not.toBe(1)
    expect(GOLDEN_HOUR_GRADE.midtoneSaturation).toBeGreaterThan(1)
    expect(GOLDEN_HOUR_GRADE.vignette).toBeGreaterThan(0)
    expect(GOLDEN_HOUR_GRADE.vignette).toBeLessThanOrEqual(0.1)
  })

  it('keeps every semantic colour identifiable from all nine neighbours after grading', () => {
    const graded = SEMANTIC.map((key) => [key, gradeDaylightHex(DAY_PALETTE[key])] as const)
    expect(new Set(graded.map(([, hex]) => hex)).size).toBe(SEMANTIC.length)

    for (let i = 0; i < graded.length; i++) {
      for (let j = i + 1; j < graded.length; j++) {
        const distance = perceptualColorDistance(graded[i][1], graded[j][1])
        expect(distance, `${graded[i][0]} vs ${graded[j][0]}`).toBeGreaterThan(0.045)
      }
    }
  })

  it('keeps every semantic colour identifiable inside the strongest shaft', () => {
    const graded = SEMANTIC.map(
      (key) =>
        [
          key,
          gradeDaylightHexWithScatter(
            DAY_PALETTE[key],
            LIGHT_SHAFT_COLOR,
            LIGHT_SHAFT_PRESETS.ultra.strength,
          ),
        ] as const,
    )
    expect(new Set(graded.map(([, hex]) => hex)).size).toBe(SEMANTIC.length)

    for (let i = 0; i < graded.length; i++) {
      for (let j = i + 1; j < graded.length; j++) {
        const distance = perceptualColorDistance(graded[i][1], graded[j][1])
        expect(distance, `${graded[i][0]} vs ${graded[j][0]}`).toBeGreaterThan(0.045)
      }
    }
  })

  it('keeps every semantic colour identifiable through the strongest high-tier height haze', () => {
    const graded = SEMANTIC.map(
      (key) =>
        [
          key,
          gradeDaylightHexWithHeightFog(
            DAY_PALETTE[key],
            DAY_PALETTE.fog,
            HEIGHT_FOG_MAX * FIDELITY_PRESETS.ultra.aerialPerspective,
          ),
        ] as const,
    )

    for (let i = 0; i < graded.length; i++) {
      for (let j = i + 1; j < graded.length; j++) {
        const distance = perceptualColorDistance(graded[i][1], graded[j][1])
        expect(distance, `${graded[i][0]} vs ${graded[j][0]}`).toBeGreaterThan(0.045)
      }
    }
  })

  it('does not turn a neutral surface into orange soup', () => {
    const hex = gradeDaylightHex(0x808080)
    const channels = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(3)
  })

  it('darkens only the frame edge with the vignette', () => {
    const center = gradeDaylightHex(0x8090a0, 0)
    const corner = gradeDaylightHex(0x8090a0, 1)
    const luma = (hex: number): number =>
      0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)
    expect(luma(corner)).toBeLessThan(luma(center))
  })
})

describe('height-sensitive aerial perspective', () => {
  it('thickens with distance near grade, thins with altitude, and stays capped', () => {
    const nearby = heightFogAmount(40, 1.7, 0, 0.0014, 0.018)
    const distant = heightFogAmount(360, 1.7, 0, 0.0014, 0.018)
    const elevated = heightFogAmount(360, 180, 120, 0.0014, 0.018)
    const extreme = heightFogAmount(4000, 1.7, 0, 0.0014, 0.018)

    expect(nearby).toBeGreaterThan(0)
    expect(distant).toBeGreaterThan(nearby)
    expect(elevated).toBeLessThan(distant)
    expect(extreme).toBe(HEIGHT_FOG_MAX)
  })
})

describe('local-clock colour separation', () => {
  for (const [level, fidelity] of Object.entries(FIDELITY_PRESETS)) {
    it(`keeps night semantic colours above their floor through ${level} height haze`, () => {
      const colors = SEMANTIC.map((key) =>
        foggedNightHex(
          NIGHT_PALETTE[key],
          NIGHT_PALETTE.fog,
          HEIGHT_FOG_MAX * fidelity.aerialPerspective,
        ),
      )

      for (let i = 0; i < colors.length; i++) {
        for (let j = i + 1; j < colors.length; j++) {
          const distance = perceptualColorDistance(colors[i], colors[j])
          expect(distance, `${SEMANTIC[i]} vs ${SEMANTIC[j]}`).toBeGreaterThanOrEqual(0.038)
        }
      }
    })
  }

  it('keeps all ten semantic colours distinct across the complete sun path', () => {
    for (let minutes = 0; minutes < 1440; minutes += 10) {
      const palette = clockPaletteAt(minutes)
      const daylight = clockAtmosphereAt(minutes).daylight
      const colors = BOUNCE_PALETTE_KEYS.map((key) =>
        daylight ? gradeDaylightHex(palette[key]) : palette[key],
      )

      for (let i = 0; i < colors.length; i++) {
        for (let j = i + 1; j < colors.length; j++) {
          const distance = perceptualColorDistance(colors[i], colors[j])
          expect(
            distance,
            `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} ${BOUNCE_PALETTE_KEYS[i]} vs ${BOUNCE_PALETTE_KEYS[j]}`,
          ).toBeGreaterThanOrEqual(0.038)
        }
      }
    }
  })
})
