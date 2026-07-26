import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'

function advanceBy(sim: ReturnType<typeof createSim>, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 30, target - sim.state.t))
}

describe('honest state readouts', () => {
  it('keeps the warmed cache-hit gauge below a value that rounds to 100.0%', () => {
    const sim = createSim(createBus())
    sim.runScenario('steady-state')
    advanceBy(sim, 80)

    expect(sim.state.stats.cacheHitPct).toBeLessThan(99.95)
  })
})

describe('bloat-and-vacuum scenario', () => {
  it('preserves and honestly narrates an in-flight worker when autovacuum is turned off', () => {
    const bus = createBus()
    const sim = createSim(bus)
    let opening = ''
    bus.on('narrate', (beat) => {
      if (beat?.title === 'An UPDATE does not update') opening = beat.body
    })
    for (let i = 0; i < 60 * 30 && !sim.state.autovac.workers.some((worker) => worker.active); i++) {
      sim.update(1 / 30)
    }
    const activeBefore = sim.state.autovac.workers
      .filter((worker) => worker.active)
      .map((worker) => worker.slot)

    expect(activeBefore.length).toBeGreaterThan(0)
    sim.runScenario('bloat-and-vacuum')

    expect(sim.state.autovac.enabled).toBe(false)
    expect(sim.state.autovac.workers.filter((worker) => worker.active).map((worker) => worker.slot)).toEqual(activeBefore)
    expect(opening).toContain('already running')
  })

  it('turns autovacuum on for a passive viewer at the narrated beat', () => {
    const sim = createSim(createBus())
    sim.runScenario('bloat-and-vacuum')
    const runsBefore = sim.state.autovac.totalRuns

    advanceBy(sim, 70)

    expect(sim.state.scenario).toBe('bloat-and-vacuum')
    expect(sim.state.scenarioT).toBeCloseTo(70, 6)
    expect(sim.state.autovac.enabled).toBe(true)
    expect(sim.state.knobs.autovacuum).toBe(true)

    advanceBy(sim, 18)
    expect(sim.state.autovac.totalRuns).toBeGreaterThan(runsBefore)
  })
})
