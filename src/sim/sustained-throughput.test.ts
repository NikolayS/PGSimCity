import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { FRAME_TEST_STEP } from './test-support'

type Sim = ReturnType<typeof createSim>

function advanceTo(sim: Sim, seconds: number): void {
  while (sim.state.t < seconds) {
    sim.update(FRAME_TEST_STEP)
  }
}

describe('free-running throughput', () => {
  it('continues completing work after scheduled maintenance', () => {
    const sim = createSim(createBus())

    advanceTo(sim, 35)
    const baselineStart = sim.state.stats.commits
    advanceTo(sim, 55)
    const baselineCommits = sim.state.stats.commits - baselineStart
    const baselineTps = baselineCommits / 20

    advanceTo(sim, 90)
    const sustainedStart = sim.state.stats.commits
    advanceTo(sim, 105)
    const sustainedCommits = sim.state.stats.commits - sustainedStart
    const sustainedTps = sustainedCommits / 15

    expect(
      sustainedTps,
      `steady throughput fell from ${baselineTps} to ${sustainedTps} tps`,
    ).toBeGreaterThan(baselineTps * 0.5)
  })
})
