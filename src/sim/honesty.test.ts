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

  it('continues client throughput while vacuum scans the enlarged relations', () => {
    const sim = createSim(createBus())
    sim.runScenario('steady-state')

    advanceBy(sim, 60)

    expect(sim.state.autovac.workers.some((worker) => worker.active)).toBe(true)
    expect(sim.state.stats.tps).toBeGreaterThan(10)
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
    const sessions = sim.state.tables.findIndex((table) => table.def.id === 'sessions')

    advanceBy(sim, 70)

    expect(sim.state.scenario).toBe('bloat-and-vacuum')
    expect(sim.state.scenarioT).toBeCloseTo(70, 6)
    expect(sim.state.autovac.enabled).toBe(true)
    expect(sim.state.knobs.autovacuum).toBe(true)

    advanceBy(sim, 18)
    expect(sim.state.autovac.totalRuns).toBeGreaterThan(runsBefore)
    expect(sim.state.autovac.workers.some((worker) => worker.active && worker.table === sessions)).toBe(true)
  })
})

describe('no-bgwriter scenario', () => {
  it('keeps backend dirty-victim writes moving until the bgwriter returns', () => {
    const sim = createSim(createBus())
    sim.runScenario('no-bgwriter')
    advanceBy(sim, 30)
    const writesAtThirty = sim.state.buffers.dirtyEvictions

    advanceBy(sim, 25)

    expect(sim.state.buffers.dirtyEvictions).toBeGreaterThan(writesAtThirty)
  })

  it('turns the bgwriter back on at the narrated beat', () => {
    const sim = createSim(createBus())
    sim.runScenario('no-bgwriter')

    advanceBy(sim, 64)

    expect(sim.state.knobs.bgwriterEnabled).toBe(true)
    expect(sim.state.bgwriter.enabled).toBe(true)
  })
})
