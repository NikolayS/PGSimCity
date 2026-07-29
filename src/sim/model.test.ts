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

describe('WAL workload response', () => {
  function measuredWalRate(tps: number): number {
    const sim = createSim(createBus())
    sim.setKnob('tps', tps)
    sim.setKnob('writeRatio', 0.06)
    advanceTo(sim, sim.state.t + 300)
    const startLsn = sim.state.wal.insertLsn

    advanceTo(sim, sim.state.t + 60)

    return (sim.state.wal.insertLsn - startLsn) / 60
  }

  it('scales WAL bytes per second approximately with transaction rate', { timeout: 15_000 }, () => {
    const lowRate = measuredWalRate(10)
    const highRate = measuredWalRate(100)
    const ratio = highRate / lowRate

    expect(ratio, `10 TPS: ${lowRate}; 100 TPS: ${highRate}`).toBeGreaterThan(4)
    expect(ratio).toBeLessThan(15)
  })

  it('drains wal_buffers after a sustained write load drops to 1 tps', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1000)
    sim.setKnob('writeRatio', 0.06)

    const highLoadStartLsn = sim.state.wal.insertLsn
    advanceTo(sim, sim.state.t + 180)
    expect(sim.state.wal.insertLsn - highLoadStartLsn).toBeGreaterThan(
      sim.state.wal.bufferCapacity,
    )

    sim.setKnob('tps', 1)
    advanceTo(sim, sim.state.t + 10)
    let maxBufferBytes = 0
    const deadline = sim.state.t + 50
    while (sim.state.t < deadline) {
      sim.update(1 / 30)
      maxBufferBytes = Math.max(maxBufferBytes, sim.state.wal.bufferBytes)
    }

    expect(maxBufferBytes).toBeLessThan(
      sim.state.wal.bufferCapacity * 0.1,
    )
  })
})
