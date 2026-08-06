import { CLAIM_VALUES } from './claims'

const MODEL = CLAIM_VALUES.moonPhase
const DAY_MS = 86_400_000
const EPOCH_MS = Date.parse(MODEL.epochUtc)

export interface MoonPhase {
  /** Lunation progress: new 0, first quarter 0.25, full 0.5, last quarter 0.75. */
  cycle: number
  illuminatedFraction: number
  waxing: boolean
}

/** Allocation-free scalar form used by renderer update transactions. */
export function moonPhaseCycleAt(date: Date): number {
  const lunations = (date.getTime() - EPOCH_MS) / (MODEL.synodicMonthDays * DAY_MS)
  return lunations - Math.floor(lunations)
}

/**
 * Mean-lunation estimate, not an ephemeris. MODEL owns the epoch, period and
 * ±0.5-day modern-date qualification validated against USNO primary phases.
 */
export function moonPhaseAt(date: Date): MoonPhase {
  const cycle = moonPhaseCycleAt(date)
  return {
    cycle,
    illuminatedFraction: (1 - Math.cos(cycle * Math.PI * 2)) * 0.5,
    // Civil Date has millisecond precision; absorb its sub-millisecond rounding
    // at the mathematical full-moon boundary rather than mislabeling it waxing.
    waxing: cycle < 0.5 - 1e-9,
  }
}
