import { describe, expect, it } from 'vitest'

import { ATMOSPHERE, DAY_PALETTE, clockAtmosphereAt, clockSunAt } from '../core/themes'
import type { Atmosphere } from '../core/themes'
import {
  GOLDEN_HOUR_GRADE,
  gradeDaylightHex,
  gradeLitDaylightHex,
  oklab,
  perceptualColorDistance,
} from './color-grade'
import type { DaylightGrade } from './color-grade'
import { AO_BLEND_INTENSITY } from './renderer'
import {
  POLISHED_DAYLIGHT_GRADE,
  POLISH_DAYLIGHT,
  daylightGradeFor,
  polishLightBalance,
  searchWithVisualMode,
  visualComparisonRequested,
  visualModeFromSearch,
} from './visual-polish'
import type { LightBalance } from './visual-polish'

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

type Vec = readonly [number, number, number]

/* ---------------------------------------------------------------------------
 * A Lambert model of the three dynamic lights, in three r185's convention: a
 * directional light contributes colour × intensity × max(0, n·l); the
 * hemisphere contributes mix(ground, sky, n.y / 2 + 1 / 2) × intensity. The
 * environment map and baked bounce are omitted, so these are relative
 * readings for comparing two rigs, not absolute screen values.
 * -------------------------------------------------------------------------*/

const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const linear = (hex: number): Vec => [
  srgbToLinear(((hex >> 16) & 255) / 255),
  srgbToLinear(((hex >> 8) & 255) / 255),
  srgbToLinear((hex & 255) / 255),
]
const luminance = (c: Vec): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const normalize = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const FACES = {
  roof: [0, 1, 0],
  north: [0, 0, -1],
  east: [1, 0, 0],
  south: [0, 0, 1],
  west: [-1, 0, 0],
} as const satisfies Record<string, Vec>
type Face = keyof typeof FACES
const WALLS = ['north', 'east', 'south', 'west'] as const

/** Three-quarter views: a roof and two walls. North-west is the home shot. */
const VIEWS = {
  northWestHome: ['north', 'west'],
  northEast: ['north', 'east'],
  southEast: ['south', 'east'],
  southWest: ['south', 'west'],
} as const satisfies Record<string, readonly [Face, Face]>
type View = keyof typeof VIEWS

interface Rig {
  air: Atmosphere
  balance: LightBalance
}

function baseBalance(air: Atmosphere): LightBalance {
  return {
    hemiIntensity: air.hemiIntensity,
    fillIntensity: air.fillIntensity,
    fillColor: air.fillColor,
    fillPos: [air.fillPos[0], air.fillPos[1], air.fillPos[2]],
    shadowIntensity: air.shadowIntensity,
    aoBlend: air.daylight ? AO_BLEND_INTENSITY.day : AO_BLEND_INTENSITY.night,
  }
}

function rig(air: Atmosphere, polished: boolean, daylight = 1): Rig {
  const base = baseBalance(air)
  return { air, balance: polished ? polishLightBalance({ ...base, fillPos: [0, 0, 0] }, base, daylight) : base }
}

function irradiance({ air, balance }: Rig, n: Vec): Vec {
  const key = normalize([
    air.keyPos[0] - air.keyTarget[0],
    air.keyPos[1] - air.keyTarget[1],
    air.keyPos[2] - air.keyTarget[2],
  ])
  // The renderer aims the fill at (0, 0, 20).
  const fill = normalize([balance.fillPos[0], balance.fillPos[1], balance.fillPos[2] - 20])
  const sky = linear(air.hemiSky)
  const ground = linear(air.hemiGround)
  const keyColor = linear(air.keyColor)
  const fillColor = linear(balance.fillColor)
  const w = n[1] * 0.5 + 0.5
  const kd = Math.max(0, dot(n, key)) * air.keyIntensity
  const fd = Math.max(0, dot(n, fill)) * balance.fillIntensity
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    out[i] = balance.hemiIntensity * (ground[i] + (sky[i] - ground[i]) * w) + keyColor[i] * kd + fillColor[i] * fd
  }
  return out
}

const day = ATMOSPHERE.day
const baselineDay = rig(day, false)
const polishedDay = rig(day, true)
const lum = (r: Rig, face: Face): number => luminance(irradiance(r, FACES[face]))

/** Smallest step between the three visible face values: below ~1.1 two read as one. */
function separation(r: Rig, view: View): number {
  const [a, b] = VIEWS[view]
  const t = [lum(r, 'roof'), lum(r, a), lum(r, b)].sort((x, y) => x - y)
  return Math.min(t[1] / t[0], t[2] / t[1])
}
const viewNames = Object.keys(VIEWS) as View[]
const allFaces = Object.keys(FACES) as Face[]

/** Both rigs share baseline's sunlit-roof exposure, so a white roof reads ~1. */
const EXPOSURE = 1 / lum(baselineDay, 'roof')
const exposed = (r: Rig, face: Face): Vec => {
  const e = irradiance(r, FACES[face])
  return [e[0] * EXPOSURE, e[1] * EXPOSURE, e[2] * EXPOSURE]
}

function chroma(c: Vec): number {
  // OKLab chroma of the light's own colour, scaled to unit luminance.
  const l = luminance(c)
  const enc = (v: number): number => {
    const x = Math.min(1, v / l / 1.2)
    return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255)
  }
  const [, a, b] = oklab((enc(c[0]) << 16) | (enc(c[1]) << 8) | enc(c[2]))
  return Math.hypot(a, b)
}

function hueDegrees(hex: number): number {
  const [, a, b] = oklab(hex)
  return (Math.atan2(b, a) * 180) / Math.PI
}

function hueDrift(a: number, b: number): number {
  const d = Math.abs(hueDegrees(a) - hueDegrees(b)) % 360
  return d > 180 ? 360 - d : d
}

function minPairDistance(hexes: number[]): number {
  let min = Infinity
  for (let i = 0; i < hexes.length; i++) {
    for (let j = i + 1; j < hexes.length; j++) min = Math.min(min, perceptualColorDistance(hexes[i], hexes[j]))
  }
  return min
}

describe('comparison mode selection', () => {
  it('stays on baseline unless the URL asks for exactly ?visual=polish', () => {
    expect(visualModeFromSearch('')).toBe('baseline')
    expect(visualModeFromSearch('?visual=baseline')).toBe('baseline')
    expect(visualModeFromSearch('?visual=POLISH')).toBe('baseline')
    expect(visualModeFromSearch('?visual=1')).toBe('baseline')
    expect(visualModeFromSearch('?visuals=polish')).toBe('baseline')
    expect(visualModeFromSearch('?visual=polish')).toBe('polish')
    expect(visualModeFromSearch('?seed=7&visual=polish')).toBe('polish')
  })

  it('offers the switch only on a comparison URL', () => {
    expect(visualComparisonRequested('')).toBe(false)
    expect(visualComparisonRequested('?seed=7')).toBe(false)
    expect(visualComparisonRequested('?visual=1')).toBe(false)
    expect(visualComparisonRequested('?visual=polish')).toBe(true)
    // What a toggle records: reloading it must keep the switch.
    expect(visualComparisonRequested('?visual=baseline')).toBe(true)
  })

  it('records a toggle without disturbing other query state', () => {
    const next = new URLSearchParams(searchWithVisualMode('?seed=7&visual=polish', 'baseline'))
    expect(next.get('seed')).toBe('7')
    expect(next.get('visual')).toBe('baseline')
    expect(visualModeFromSearch(searchWithVisualMode('?seed=7', 'polish'))).toBe('polish')
  })
})

describe('polished light balance is an overlay, never a new palette', () => {
  it('is exactly baseline at night and wherever the local clock has no daylight', () => {
    const night = baseBalance(ATMOSPHERE.night)
    expect(polishLightBalance({ ...night, fillPos: [0, 0, 0] }, night, 0)).toEqual(night)
    for (let minutes = 0; minutes < 1440; minutes += 30) {
      if (clockSunAt(minutes).daylight > 0) continue
      const base = baseBalance(clockAtmosphereAt(minutes))
      expect(polishLightBalance({ ...base, fillPos: [0, 0, 0] }, base, 0), `minute ${minutes}`).toEqual(base)
    }
  })

  it('moves every value monotonically between baseline and target as daylight rises', () => {
    const base = baseBalance(day)
    const at = (w: number) => polishLightBalance({ ...base, fillPos: [0, 0, 0] }, base, w)
    let previous = at(0)
    for (let i = 1; i <= 10; i++) {
      const next = at(i / 10)
      expect(next.hemiIntensity).toBe(base.hemiIntensity)
      expect(next.fillIntensity).toBeGreaterThanOrEqual(previous.fillIntensity)
      expect(next.shadowIntensity).toBeGreaterThanOrEqual(previous.shadowIntensity)
      expect(next.aoBlend).toBeGreaterThanOrEqual(previous.aoBlend)
      expect(next.fillPos[0]).toBeLessThanOrEqual(previous.fillPos[0])
      previous = next
    }
    expect(previous.fillIntensity).toBe(POLISH_DAYLIGHT.fillIntensity)
    expect(previous.fillColor).toBe(POLISH_DAYLIGHT.fillColor)
    expect(previous.fillPos).toEqual([...POLISH_DAYLIGHT.fillPos])
  })

  it('aims the fill at the sun\'s flank, perpendicular to its azimuth', () => {
    const sun = normalize([day.keyPos[0] - day.keyTarget[0], 0, day.keyPos[2] - day.keyTarget[2]])
    const p = POLISH_DAYLIGHT.fillPos
    const fill = normalize([p[0], 0, p[2] - 20])
    expect(Math.abs(dot(sun, fill))).toBeLessThan(0.02)
  })

  it('never changes the sun, fog, sky, bloom or tone mapping', () => {
    // The overlay's whole surface: anything else in Atmosphere is untouched.
    expect(Object.keys(baseBalance(day)).sort()).toEqual(
      ['aoBlend', 'fillColor', 'fillIntensity', 'fillPos', 'hemiIntensity', 'shadowIntensity'],
    )
  })
})

describe('polished daylight balance (Lambert model of the dynamic lights)', () => {
  it('documents the baseline defect: some three-quarter view merges two faces', () => {
    expect(Math.min(...viewNames.map((v) => separation(baselineDay, v)))).toBeLessThan(1.05)
    // The home shot itself: roof and west wall nearly the same value.
    expect(separation(baselineDay, 'northWestHome')).toBeLessThan(1.07)
  })

  it('raises the worst and the mean face separation across views', () => {
    const worst = (r: Rig) => Math.min(...viewNames.map((v) => separation(r, v)))
    const mean = (r: Rig) => viewNames.reduce((sum, v) => sum + separation(r, v), 0) / viewNames.length
    expect(worst(polishedDay)).toBeGreaterThan(worst(baselineDay) + 0.03)
    expect(mean(polishedDay)).toBeGreaterThan(mean(baselineDay) + 0.05)
    expect(separation(polishedDay, 'northWestHome')).toBeGreaterThan(separation(baselineDay, 'northWestHome'))
  })

  it('costs no view more than 1% of its separation', () => {
    for (const v of viewNames) {
      expect(separation(polishedDay, v), v).toBeGreaterThan(separation(baselineDay, v) * 0.99)
    }
  })

  it('leaves sunlit horizontal surfaces, where most state fields lie, within 1%', () => {
    expect(Math.abs(lum(polishedDay, 'roof') / lum(baselineDay, 'roof') - 1)).toBeLessThan(0.01)
  })

  it('adds no new highlight and does not crush the darkest wall', () => {
    const extreme = (r: Rig, pick: (...v: number[]) => number) => pick(...allFaces.map((f) => lum(r, f)))
    expect(extreme(polishedDay, Math.max)).toBeLessThanOrEqual(extreme(baselineDay, Math.max) + 1e-9)
    expect(extreme(polishedDay, Math.min)).toBeGreaterThanOrEqual(extreme(baselineDay, Math.min) * 0.85)
  })

  it('tints the shade no more than baseline does', () => {
    for (const face of WALLS) {
      expect(chroma(irradiance(polishedDay, FACES[face])), face).toBeLessThanOrEqual(
        chroma(irradiance(baselineDay, FACES[face])) + 1e-9,
      )
    }
  })

  it('keeps semantic colours as separable and as true to hue as baseline on every face', () => {
    for (const face of allFaces) {
      const lit = (r: Rig, grade: DaylightGrade = GOLDEN_HOUR_GRADE) =>
        SEMANTIC.map((key) => gradeLitDaylightHex(DAY_PALETTE[key], exposed(r, face), grade))
      const before = lit(baselineDay)
      const after = lit(polishedDay, POLISHED_DAYLIGHT_GRADE)
      expect(minPairDistance(after), face).toBeGreaterThanOrEqual(minPairDistance(before) * 0.95)
      for (let i = 0; i < SEMANTIC.length; i++) {
        const swatch = DAY_PALETTE[SEMANTIC[i]]
        expect(hueDrift(after[i], swatch), `${face} ${SEMANTIC[i]}`).toBeLessThanOrEqual(
          hueDrift(before[i], swatch) + 2,
        )
      }
    }
  })
})

describe('polished daylight grade', () => {
  it('changes only the black lift', () => {
    expect({ ...POLISHED_DAYLIGHT_GRADE, lift: GOLDEN_HOUR_GRADE.lift }).toEqual(GOLDEN_HOUR_GRADE)
    expect(POLISHED_DAYLIGHT_GRADE.lift).toBe(0)
    expect(daylightGradeFor('baseline')).toBe(GOLDEN_HOUR_GRADE)
    expect(daylightGradeFor('polish')).toBe(POLISHED_DAYLIGHT_GRADE)
  })

  it('keeps black black, where baseline lifts it into haze', () => {
    expect(gradeDaylightHex(0x000000, 0, POLISHED_DAYLIGHT_GRADE)).toBe(0x000000)
    expect(gradeDaylightHex(0x000000, 0, GOLDEN_HOUR_GRADE)).toBeGreaterThan(0)
  })

  it('keeps all 45 semantic pairs distinct and a neutral surface neutral', () => {
    const graded = SEMANTIC.map((key) => gradeDaylightHex(DAY_PALETTE[key], 0, POLISHED_DAYLIGHT_GRADE))
    expect(minPairDistance(graded)).toBeGreaterThan(0.045)
    const grey = gradeDaylightHex(0x808080, 0, POLISHED_DAYLIGHT_GRADE)
    const channels = [(grey >> 16) & 255, (grey >> 8) & 255, grey & 255]
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThanOrEqual(3)
  })
})
