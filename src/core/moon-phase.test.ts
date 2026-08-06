import { describe, expect, it } from 'vitest'

import { CLAIM_VALUES } from './claims'
import { moonPhaseAt } from './moon-phase'

const PRIMARY_PHASES = [
  ['2000-01-06T18:14:00Z', 0],
  ['2000-01-21T04:40:00Z', 0.5],
  ['2010-01-15T07:11:00Z', 0],
  ['2010-01-30T06:18:00Z', 0.5],
  ['2024-04-08T18:21:00Z', 0],
  ['2024-04-23T23:49:00Z', 0.5],
  ['2030-12-24T17:32:00Z', 0],
  ['2030-12-09T22:40:00Z', 0.5],
] as const

function phaseErrorDays(actual: number, expected: number): number {
  let cycles = actual - expected
  cycles -= Math.round(cycles)
  return Math.abs(cycles * CLAIM_VALUES.moonPhase.synodicMonthDays)
}

describe('mean lunar phase', () => {
  it('lands on real USNO new and full moons within its disclosed tolerance', () => {
    for (const [iso, expected] of PRIMARY_PHASES) {
      const actual = moonPhaseAt(new Date(iso)).cycle
      expect(
        phaseErrorDays(actual, expected),
        `${iso} is outside the mean-lunation model's disclosed timing tolerance`,
      ).toBeLessThanOrEqual(CLAIM_VALUES.moonPhase.timingToleranceDays)
    }
  })

  it('is a deterministic pure function of the supplied date', () => {
    const date = new Date('2024-04-16T06:21:00Z')
    const before = date.getTime()

    expect(moonPhaseAt(date)).toEqual(moonPhaseAt(new Date(before)))
    expect(date.getTime()).toBe(before)
  })

  it('derives illumination and waxing state from the same phase cycle', () => {
    const epoch = moonPhaseAt(new Date(CLAIM_VALUES.moonPhase.epochUtc))
    const quarter = moonPhaseAt(new Date(
      Date.parse(CLAIM_VALUES.moonPhase.epochUtc)
      + CLAIM_VALUES.moonPhase.synodicMonthDays * 0.25 * 86_400_000,
    ))
    const full = moonPhaseAt(new Date(
      Date.parse(CLAIM_VALUES.moonPhase.epochUtc)
      + CLAIM_VALUES.moonPhase.synodicMonthDays * 0.5 * 86_400_000,
    ))

    expect(epoch).toEqual({ cycle: 0, illuminatedFraction: 0, waxing: true })
    expect(quarter.illuminatedFraction).toBeCloseTo(0.5, 8)
    expect(quarter.waxing).toBe(true)
    expect(full.illuminatedFraction).toBeCloseTo(1, 12)
    expect(full.waxing).toBe(false)
  })
})
