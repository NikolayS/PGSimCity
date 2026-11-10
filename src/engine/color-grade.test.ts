import { describe, expect, it } from 'vitest'

import {
  createTheme,
  setBloomAvailable,
  setThemeMode,
} from '../core/theme'
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
  gradeDaylightHexWithEffects,
  gradeDaylightHexWithHeightFog,
  gradeDaylightHexWithScatter,
  foggedNightHex,
  heightFogAmount,
  perceptualColorDistance,
} from './color-grade'
import { LIGHT_SHAFT_COLOR, LIGHT_SHAFT_PRESETS } from './light-shafts'
import { FIDELITY_PRESETS, QUALITY_PRESETS } from './renderer'

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

const QUALITY_LEVELS = ['low', 'reduced', 'medium', 'high', 'ultra'] as const

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

  for (const level of QUALITY_LEVELS) {
    for (const mode of ['day', 'night'] as const) {
      it(`keeps all 45 ${mode} semantic pairs distinct at ${level}`, () => {
        const preset = QUALITY_PRESETS[level]
        const fidelity = FIDELITY_PRESETS[level]
        setThemeMode(mode, { persist: false })
        setBloomAvailable(preset.bloom)
        const theme = createTheme()
        const materials = SEMANTIC.map((key) => theme.neon(NIGHT_PALETTE[key], 1))

        try {
          const colors = materials.map((material) => {
            const hex = material.color.getHex()
            return mode === 'day'
              ? gradeDaylightHexWithEffects(
                  hex,
                  DAY_PALETTE.fog,
                  HEIGHT_FOG_MAX * fidelity.aerialPerspective,
                  LIGHT_SHAFT_COLOR,
                  LIGHT_SHAFT_PRESETS[level].strength,
                )
              : foggedNightHex(
                  hex,
                  NIGHT_PALETTE.fog,
                  HEIGHT_FOG_MAX * fidelity.aerialPerspective,
                )
          })
          for (let i = 0; i < colors.length; i++) {
            for (let j = i + 1; j < colors.length; j++) {
              const distance = perceptualColorDistance(colors[i], colors[j])
              expect(distance, `${SEMANTIC[i]} vs ${SEMANTIC[j]}`).toBeGreaterThanOrEqual(
                mode === 'day' ? 0.045 : 0.038,
              )
            }
          }
        } finally {
          theme.dispose()
          setBloomAvailable(true)
          setThemeMode('night', { persist: false })
        }
      })
    }
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

describe('film lens', () => {
  it('leaves the centre of the frame, where the palette is read, untouched', async () => {
    const { FILM_LENS, filmVignette } = await import('./color-grade')
    for (const strength of [FILM_LENS.dayVignette, FILM_LENS.nightVignette]) {
      expect(filmVignette(0, strength)).toBe(1)
      expect(filmVignette(0.18, strength)).toBe(1)
      expect(filmVignette(1, strength)).toBeCloseTo(1 - strength, 10)
      let previous = 1
      for (let edge = 0; edge <= 1.0001; edge += 0.02) {
        const value = filmVignette(edge, strength)
        expect(value).toBeLessThanOrEqual(previous)
        previous = value
      }
    }
  })

  it('keeps grain an order of magnitude below the semantic separation margin', async () => {
    const { FILM_LENS } = await import('./color-grade')
    // Half the peak-to-peak amplitude in display space, against the 0.045 OKLab floor.
    expect(FILM_LENS.grain / 2).toBeLessThan(0.02)
    expect(FILM_LENS.grain).toBeGreaterThan(0)
  })

  it('runs after tone mapping and display encoding, never before the grade', async () => {
    const { GoldenHourOutputPass } = await import('./color-grade')
    const pass = new GoldenHourOutputPass()
    const source = pass.material.fragmentShader
    const lens = source.lastIndexOf('pgFilmLens( gl_FragColor.rgb, vUv )')
    expect(lens).toBeGreaterThan(source.indexOf('sRGBTransferOETF( gl_FragColor )'))
    expect(lens).toBeGreaterThan(source.indexOf('pgGoldenHourGrade( gl_FragColor.rgb, vUv )'))
    pass.setFilm(0.03, 0.2, false)
    expect(pass.uniforms.pgFilmTime.value).toBe(0)
    pass.dispose()
  })

  it('holds scene grey fixed under the contrast curve', async () => {
    const { GOLDEN_HOUR_GRADE } = await import('./color-grade')
    const curve = (tone: number) =>
      GOLDEN_HOUR_GRADE.pivot * Math.pow(tone / GOLDEN_HOUR_GRADE.pivot, GOLDEN_HOUR_GRADE.contrast)
    expect(curve(GOLDEN_HOUR_GRADE.pivot)).toBeCloseTo(GOLDEN_HOUR_GRADE.pivot, 12)
    expect(curve(0.05)).toBeLessThan(0.05)
    expect(curve(0.6)).toBeGreaterThan(0.6)
    expect(GOLDEN_HOUR_GRADE.contrast).toBeGreaterThan(1)
  })
})

describe('night haze light scatter', () => {
  it('grows with path length between its near share and one', async () => {
    const { LIGHT_SCATTER, lightScatterShare } = await import('./color-grade')
    expect(lightScatterShare(0)).toBe(LIGHT_SCATTER.nearShare)
    expect(lightScatterShare(LIGHT_SCATTER.nearMetres)).toBe(LIGHT_SCATTER.nearShare)
    expect(lightScatterShare(LIGHT_SCATTER.farMetres)).toBe(1)
    expect(lightScatterShare(1e6)).toBe(1)
    let previous = 0
    for (let metres = 0; metres <= 1000; metres += 25) {
      const share = lightScatterShare(metres)
      expect(share).toBeGreaterThanOrEqual(previous)
      previous = share
    }
  })

  it('has no source of its own: without the bloom chain or scene depth it is off', async () => {
    const { GoldenHourOutputPass } = await import('./color-grade')
    const pass = new GoldenHourOutputPass()
    expect(pass.uniforms.pgScatterStrength.value).toBe(0)
    pass.setLightScatter(null, 0.4)
    expect(pass.uniforms.pgScatterWide.value).toBeNull()
    // The term reads only the wide blur: it can spread a signal, never make one.
    const source = pass.material.fragmentShader
    const body = source.slice(source.indexOf('vec3 pgLightScatter'), source.indexOf('uniform float pgFilmGrain'))
    expect(body).toContain('texture2D( pgScatterWide, uv )')
    expect(body).not.toContain('tDiffuse')
    expect(source.indexOf('pgLightScatter( gl_FragColor.rgb, vUv )')).toBeLessThan(source.indexOf('// tone mapping'))
    pass.dispose()
  })

  it('pools light on the paving and platforms only, from a tighter blur than the haze', async () => {
    const { GoldenHourOutputPass, LIGHT_SCATTER } = await import('./color-grade')
    const pass = new GoldenHourOutputPass()
    const source = pass.material.fragmentShader
    expect(source).toContain(`abs( ( pgCameraWorld * view ).y ) < ${LIGHT_SCATTER.plateBand.toFixed(3)}`)
    // District platforms stand 0.1 m proud; a kerb or a wall base must stay out.
    expect(LIGHT_SCATTER.plateBand).toBeGreaterThan(0.1)
    expect(LIGHT_SCATTER.plateBand).toBeLessThan(0.6)
    const wide = { name: 'wide' } as never
    const mid = { name: 'mid' } as never
    pass.setLightScatter(wide, 0.4, mid, LIGHT_SCATTER.groundPool)
    expect(pass.uniforms.pgScatterMid.value).toBe(mid)
    expect(pass.uniforms.pgGroundPool.value).toBe(LIGHT_SCATTER.groundPool)
    // No bloom chain, no pool: the paving has no light of its own.
    pass.setLightScatter(null, 0.4, mid, LIGHT_SCATTER.groundPool)
    expect(pass.uniforms.pgGroundPool.value).toBe(0)
    pass.dispose()
  })
})
