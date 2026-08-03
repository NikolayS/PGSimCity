import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createCollector } from '../observability/collector'
import { PROJECTIONS } from '../observability/views'
import { createSim } from './model'

describe('live PostgreSQL oracle findings', () => {
  it('uses stale reltuples, not the live tuple counter, for the vacuum threshold', () => {
    const sim = createSim(createBus())
    const table = sim.state.tables[0]
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('autovacuumScaleFactor', 0.2)
    table.reltuples = 1_000
    table.liveTuples = 1_700
    table.deadTuples = 300

    sim.update(1 / 30)

    expect(table.vacuumThreshold).toBe(250)
    expect(table.deadTuples).toBeGreaterThan(table.vacuumThreshold)
    expect(table.deadTuples).toBeLessThan(50 + 0.2 * table.liveTuples)
  })

  it('caps the PostgreSQL 18 vacuum threshold at 100 million tuples', () => {
    const sim = createSim(createBus())
    const table = sim.state.tables[0]
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('autovacuumScaleFactor', 0.2)
    table.reltuples = 1_000_000_000

    sim.update(1 / 30)

    expect(table.vacuumThreshold).toBe(100_000_000)
  })

  it('counts an idle timer expiry without inventing a completed checkpoint', () => {
    const sim = createSim(createBus())
    const checkpoint = sim.state.checkpoint
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('bgwriterEnabled', false)
    sim.state.buffers.dirty.fill(0)
    sim.state.wal.insertLsn = checkpoint.redoLsn
    sim.state.wal.writeLsn = checkpoint.redoLsn
    sim.state.wal.flushLsn = checkpoint.redoLsn
    checkpoint.nextInSec = 0
    const completedBefore = checkpoint.count

    sim.update(1 / 30)

    expect(checkpoint.phase).toBe('idle')
    expect(checkpoint.numTimed).toBe(1)
    expect(checkpoint.numDone).toBe(0)
    expect(checkpoint.count).toBe(completedBefore)
  })

  it('collects timer expiries and completions as independent counters', () => {
    const sim = createSim(createBus())
    const checkpoint = sim.state.checkpoint
    const collector = createCollector(sim)

    checkpoint.numTimed += 1
    collector.sample()

    expect(collector.total.ckptTimed).toBe(1)
    expect(collector.total.ckptRequested).toBe(0)
    expect(collector.total.ckptDone).toBe(0)

    const projection = PROJECTIONS.checkpointer(sim.state, collector, 'total')
    const row = projection.rows.find((candidate) => candidate.key === 'ckpt')!
    expect(projection.cols.map((column) => column.key)).toContain('num_done')
    expect(row.cells.num_timed).toMatchObject({ v: '1' })
    expect(row.cells.num_done).toMatchObject({ v: '0' })
    expect(projection.caption).toContain('num_done says no checkpoint has completed')
  })
})
