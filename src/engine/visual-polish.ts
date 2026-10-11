import { mix } from '../core/themes'
import { GOLDEN_HOUR_GRADE } from './color-grade'
import type { DaylightGrade } from './color-grade'

/* ============================================================================
 * Opt-in visual comparison (?visual=polish).
 *
 * The default renderer is the baseline and is never altered by this module.
 * Polish changes only light balance, the day grade, AO weight and scripted
 * camera easing: no geometry, palette, fog, sky, sun direction, bloom, flow or
 * simulation value. Every daylight change is scaled by the theme's daylight
 * blend, so night is exactly baseline and local-clock twilight is continuous.
 *
 * Design note (measured with the Lambert model in visual-polish.test.ts): the
 * home shot looks south-east with the sun behind the camera, so roof, north
 * and west faces are all sunlit and the roof and west wall land within 1.06x
 * of each other. Orbiting to the back-lit side, both shade walls get only the
 * hemisphere and baseline's back fill, within 1.03x. Polish re-aims the
 * existing fill to the sun's flank (south-west, perpendicular to its azimuth),
 * low and near-neutral, so every three-quarter view gets a third distinct
 * value without brightening roofs, where most state fields lie.
 * ==========================================================================*/

export type VisualMode = 'baseline' | 'polish'

export const VISUAL_QUERY_KEY = 'visual'

/** Unknown or absent values keep the baseline; only the exact token opts in. */
export function visualModeFromSearch(search: string): VisualMode {
  return new URLSearchParams(search).get(VISUAL_QUERY_KEY) === 'polish' ? 'polish' : 'baseline'
}

/**
 * The switch appears only on a comparison URL: ?visual=polish, or the
 * ?visual=baseline it records after a toggle, so a reload keeps the switch.
 */
export function visualComparisonRequested(search: string): boolean {
  const value = new URLSearchParams(search).get(VISUAL_QUERY_KEY)
  return value === 'polish' || value === 'baseline'
}

/** The same query string with the mode recorded, so a reload keeps the choice. */
export function searchWithVisualMode(search: string, mode: VisualMode): string {
  const params = new URLSearchParams(search)
  params.set(VISUAL_QUERY_KEY, mode)
  return `?${params.toString()}`
}

/** Full-daylight targets; intermediate daylight interpolates toward them. */
export const POLISH_DAYLIGHT = {
  /** Directional fill strength (baseline 0.28, which is mostly hue, not light). */
  fillIntensity: 0.3,
  /** Near-neutral cool: sky-side, far less saturated than baseline's 0x769bc6. */
  fillColor: 0xc6d4e4,
  /* Aimed at the renderer's fill target (0, 0, 20) from the sun's south-west
   * flank, about 11 degrees up: perpendicular to the key's azimuth. */
  fillPos: [-390, 100, 333] as readonly [number, number, number],
  /** Slightly firmer sun shadows for contact grounding (baseline 0.84). */
  shadowIntensity: 0.9,
  /** Full weight of the existing GTAO result in daylight (baseline 0.9). */
  aoBlend: 1,
} as const

/* Removing the black lift is the only grade change: lift is a uniform haze
 * over every shadow, which is the washed-out look this mode exists to test. */
export const POLISHED_DAYLIGHT_GRADE: DaylightGrade = {
  ...GOLDEN_HOUR_GRADE,
  lift: 0,
}

export interface LightBalance {
  hemiIntensity: number
  fillIntensity: number
  fillColor: number
  fillPos: [number, number, number]
  shadowIntensity: number
  aoBlend: number
}

/**
 * Writes the polished balance for `daylight` in [0, 1] into `out`. At zero
 * daylight the result equals `base` exactly; called on mode and theme changes,
 * never per frame. The hemisphere is deliberately left as baseline.
 */
export function polishLightBalance(out: LightBalance, base: Readonly<LightBalance>, daylight: number): LightBalance {
  const w = daylight <= 0 ? 0 : daylight >= 1 ? 1 : daylight
  const p = POLISH_DAYLIGHT
  out.hemiIntensity = base.hemiIntensity
  out.fillIntensity = base.fillIntensity + (p.fillIntensity - base.fillIntensity) * w
  out.fillColor = mix(base.fillColor, p.fillColor, w)
  for (let i = 0; i < 3; i++) out.fillPos[i] = base.fillPos[i] + (p.fillPos[i] - base.fillPos[i]) * w
  out.shadowIntensity = base.shadowIntensity + Math.max(0, p.shadowIntensity - base.shadowIntensity) * w
  out.aoBlend = base.aoBlend + Math.max(0, p.aoBlend - base.aoBlend) * w
  return out
}

/** The grade the output pass should carry for a mode. */
export function daylightGradeFor(mode: VisualMode): DaylightGrade {
  return mode === 'polish' ? POLISHED_DAYLIGHT_GRADE : GOLDEN_HOUR_GRADE
}
