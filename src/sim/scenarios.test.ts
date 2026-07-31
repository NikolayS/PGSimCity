import { describe, expect, it } from 'vitest'

import { SCENARIOS, SCENARIO_NARRATION_SECONDS } from './scenarios'

describe('scenario timelines', () => {
  it('advertises the complete beat timeline in the same seconds used by narration', () => {
    for (const scenario of SCENARIOS) {
      const beats = scenario.beats ?? []
      if (scenario.decision) {
        expect(beats, `${scenario.id} must be discovered before explanation`).toHaveLength(0)
        expect(scenario.duration, scenario.id).toBe(0)
        expect(scenario.decision.revealAt, scenario.id).toBeGreaterThan(0)
        continue
      }
      expect(beats[0]?.[0], scenario.id).toBe(0)

      let intervals = 0
      for (let index = 0; index < beats.length; index++) {
        const start = beats[index][0]
        const end = beats[index + 1]?.[0] ?? scenario.duration
        const interval = end - start
        expect(interval, `${scenario.id} beat ${index + 1}`).toBeGreaterThanOrEqual(
          SCENARIO_NARRATION_SECONDS,
        )
        intervals += interval
      }

      expect(intervals, scenario.id).toBe(scenario.duration)
    }
  })
})
