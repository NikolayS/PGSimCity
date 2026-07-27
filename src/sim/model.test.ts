import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import {
  PG_PAGE_BYTES,
  SHARED_BUFFERS_FULL_SAMPLE_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../core/types'
import { createSim } from './model'

function advanceTo(sim: ReturnType<typeof createSim>, seconds: number): void {
  while (sim.state.t < seconds) sim.update(1 / 30)
}

function workingSetPages(sim: ReturnType<typeof createSim>): number {
  return sim.state.tables.reduce((total, table) => total + table.pages + table.indexPages, 0)
}

function declaredWorkingSetPages(sim: ReturnType<typeof createSim>): number {
  return sim.state.tables.reduce(
    (total, table) =>
      total + table.def.pages + table.def.indexes.reduce((sum, index) => sum + index.pages, 0),
    0,
  )
}

function poolPages(sim: ReturnType<typeof createSim>): number {
  return Math.floor((sim.state.knobs.sharedBuffers * 1024 * 1024) / PG_PAGE_BYTES)
}

function runBufferWorkload(sharedBuffers: number, seconds = 200): ReturnType<typeof createSim> {
  const sim = createSim(createBus())
  sim.setKnob('sharedBuffers', sharedBuffers)
  sim.setKnob('tps', 800)
  sim.setKnob('writeRatio', 0.5)
  advanceTo(sim, seconds)
  return sim
}

describe('buffer cache', () => {
  it('keeps a hot default cache while the cold tail evicts and the slider still matters', { timeout: 30_000 }, () => {
    const minimum = createSim(createBus())
    minimum.setKnob('sharedBuffers', SHARED_BUFFERS_MIN_MIB)
    advanceTo(minimum, 10 * 60)

    const defaultPool = createSim(createBus())
    advanceTo(defaultPool, 10 * 60)

    const fullSample = createSim(createBus())
    fullSample.setKnob('sharedBuffers', SHARED_BUFFERS_FULL_SAMPLE_MIB)
    advanceTo(fullSample, 10 * 60)

    expect.soft(defaultPool.state.stats.cacheHitPct).toBeGreaterThanOrEqual(98)
    expect.soft(defaultPool.state.buffers.evictions).toBeGreaterThan(0)
    expect.soft(fullSample.state.stats.cacheHitPct - minimum.state.stats.cacheHitPct).toBeGreaterThan(5)
  })

  it('reaches a production-like hit ratio once the full working set is warm', { timeout: 15_000 }, () => {
    const sim = createSim(createBus())

    sim.setKnob('sharedBuffers', SHARED_BUFFERS_FULL_SAMPLE_MIB)
    expect(declaredWorkingSetPages(sim)).toBe(poolPages(sim))
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

  it('improves materially between the slider minimum and 8 GiB', { timeout: 15_000 }, () => {
    const minimum = runBufferWorkload(SHARED_BUFFERS_MIN_MIB)
    const fullSample = runBufferWorkload(SHARED_BUFFERS_FULL_SAMPLE_MIB)

    expect(fullSample.state.stats.cacheHitPct - minimum.state.stats.cacheHitPct).toBeGreaterThan(5)
  })

  it('evicts frames at the slider minimum under a write-heavy load', () => {
    const sim = runBufferWorkload(SHARED_BUFFERS_MIN_MIB, 60)

    expect(sim.state.buffers.evictions).toBeGreaterThan(100)
  })

  it('makes client backends write dirty victims without the bgwriter', () => {
    const sim = createSim(createBus())

    sim.runScenario('no-bgwriter')
    advanceTo(sim, 60)

    expect(sim.state.buffers.dirtyEvictions).toBeGreaterThan(0)
  })
})
