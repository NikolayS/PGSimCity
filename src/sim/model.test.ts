import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import {
  PG_PAGE_BYTES,
  SHARED_BUFFERS_FULL_SAMPLE_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../core/types'
import { createSim } from './model'
import type { PageWriteObservation } from './model'
import {
  AGGREGATE_TEST_STEP,
  createAggregateSim,
  FRAME_TEST_STEP,
} from './test-support'

type Sim = ReturnType<typeof createAggregateSim>

function advanceTo(sim: Sim, seconds: number, step = AGGREGATE_TEST_STEP): void {
  while (sim.state.t < seconds) {
    sim.update(Math.min(step, seconds - sim.state.t))
  }
}

function workingSetPages(sim: Sim): number {
  return sim.state.tables.reduce((total, table) => total + table.pages + table.indexPages, 0)
}

function declaredWorkingSetPages(sim: Sim): number {
  return sim.state.tables.reduce(
    (total, table) =>
      total + table.def.pages + table.def.indexes.reduce((sum, index) => sum + index.pages, 0),
    0,
  )
}

function poolPages(sim: Sim): number {
  return Math.floor((sim.state.knobs.sharedBuffers * 1024 * 1024) / PG_PAGE_BYTES)
}

function runBufferWorkload(sharedBuffers: number, seconds = 200): Sim {
  const sim = createAggregateSim()
  sim.setKnob('sharedBuffers', sharedBuffers)
  sim.setKnob('tps', 800)
  sim.setKnob('writeRatio', 0.5)
  advanceTo(sim, seconds)
  return sim
}

describe('buffer cache', () => {
  it('keeps a hot default cache while the cold tail evicts and the slider still matters', { timeout: 30_000 }, () => {
    const minimum = createAggregateSim()
    minimum.setKnob('sharedBuffers', SHARED_BUFFERS_MIN_MIB)
    advanceTo(minimum, 5 * 60, FRAME_TEST_STEP)

    const defaultPool = createAggregateSim()
    advanceTo(defaultPool, 5 * 60, FRAME_TEST_STEP)

    const fullSample = createAggregateSim()
    fullSample.setKnob('sharedBuffers', SHARED_BUFFERS_FULL_SAMPLE_MIB)
    advanceTo(fullSample, 5 * 60, FRAME_TEST_STEP)

    expect.soft(defaultPool.state.stats.cacheHitPct).toBeGreaterThanOrEqual(98)
    expect.soft(defaultPool.state.buffers.evictions).toBeGreaterThan(0)
    expect.soft(fullSample.state.stats.cacheHitPct - minimum.state.stats.cacheHitPct).toBeGreaterThan(5)
  })

  it('reaches a production-like hit ratio once the full working set is warm', { timeout: 15_000 }, () => {
    const sim = createAggregateSim()

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
    const sim = createSim(createBus())
    sim.setKnob('sharedBuffers', SHARED_BUFFERS_MIN_MIB)
    sim.setKnob('tps', 800)
    sim.setKnob('writeRatio', 0.5)
    advanceTo(sim, 60)

    expect(sim.state.buffers.evictions).toBeGreaterThan(100)
  })

  it('makes client backends write dirty victims without the bgwriter', () => {
    const sim = createSim(createBus())

    sim.runScenario('no-bgwriter')
    advanceTo(sim, 60)

    expect(sim.state.buffers.dirtyEvictions).toBeGreaterThan(0)
  })

  it('keeps a dirty victim mapped until its backend write completes', () => {
    let backendWrites = 0
    let unmappedWrites = 0
    const sim = createSim(createBus(), {
      scheduledBackups: false,
      pageWriteObserver: (write) => {
        if (write.path !== 'backend' || !write.afterWalWait) return
        backendWrites++
        if (!write.tagMapped) unmappedWrites++
      },
    })
    sim.runScenario('no-bgwriter')
    sim.setKnob('synchronousCommit', 'off')

    advanceTo(sim, 120, FRAME_TEST_STEP)

    expect(backendWrites).toBeGreaterThan(0)
    expect(unmappedWrites).toBe(0)
  })
})

describe('WAL workload response', () => {
  it('never writes a page before WAL covers its content on any writer path', { timeout: 15_000 }, () => {
    const paths = new Set<PageWriteObservation['path']>()
    const violations: PageWriteObservation[] = []
    const sim = createSim(createBus(), {
      scheduledBackups: false,
      pageWriteObserver: (write) => {
        paths.add(write.path)
        if (write.pageLsnOwners !== 0 || write.pageLsn > write.flushLsn) {
          violations.push({ ...write })
        }
      },
    })
    sim.runScenario('checkpoint-storm')

    advanceTo(sim, 180, FRAME_TEST_STEP)

    expect.soft([...paths].sort()).toEqual(['backend', 'bgwriter', 'checkpointer'])
    expect(violations).toEqual([])
  })

  function measuredWalRate(tps: number): number {
    const sim = createAggregateSim()
    sim.setKnob('tps', tps)
    sim.setKnob('writeRatio', 0.06)
    advanceTo(sim, sim.state.t + 60, FRAME_TEST_STEP)
    const startLsn = sim.state.wal.insertLsn

    advanceTo(sim, sim.state.t + 30, FRAME_TEST_STEP)

    return (sim.state.wal.insertLsn - startLsn) / 30
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
    sim.setKnob('sharedBuffers', 128)
    sim.setKnob('tps', 1000)
    sim.setKnob('writeRatio', 1)

    const highLoadStartLsn = sim.state.wal.insertLsn
    advanceTo(sim, sim.state.t + 60)
    expect(sim.state.wal.insertLsn - highLoadStartLsn).toBeGreaterThan(
      sim.state.wal.bufferCapacity,
    )

    sim.setKnob('tps', 1)
    advanceTo(sim, sim.state.t + 10)
    let maxBufferBytes = 0
    const deadline = sim.state.t + 10
    while (sim.state.t < deadline) {
      sim.update(FRAME_TEST_STEP)
      maxBufferBytes = Math.max(maxBufferBytes, sim.state.wal.bufferBytes)
    }

    expect(maxBufferBytes).toBeLessThan(
      sim.state.wal.bufferCapacity * 0.1,
    )
  })
})
