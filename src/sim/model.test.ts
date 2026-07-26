import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { PG_PAGE_BYTES } from '../core/types'
import { createSim } from './model'

function advanceTo(sim: ReturnType<typeof createSim>, seconds: number): void {
  while (sim.state.t < seconds) sim.update(1 / 30)
}

function workingSetPages(sim: ReturnType<typeof createSim>): number {
  return sim.state.tables.reduce((total, table) => total + table.pages + table.indexPages, 0)
}

function poolPages(sim: ReturnType<typeof createSim>): number {
  return Math.floor((sim.state.knobs.sharedBuffers * 1024 * 1024) / PG_PAGE_BYTES)
}

describe('buffer cache', () => {
  it('reaches a production-like hit ratio once the default working set is warm', () => {
    const sim = createSim(createBus())

    expect(workingSetPages(sim)).toBeLessThan(poolPages(sim))
    advanceTo(sim, 5 * 60)

    expect(sim.state.stats.cacheHitPct).toBeGreaterThanOrEqual(98)
  })

  it('drops the hit ratio when shared_buffers cannot hold the working set', () => {
    const sim = createSim(createBus())

    sim.runScenario('cache-thrash')
    expect(workingSetPages(sim)).toBeGreaterThan(poolPages(sim))
    advanceTo(sim, sim.state.t + 60)

    expect(sim.state.stats.cacheHitPct).toBeLessThan(85)
  })
})
