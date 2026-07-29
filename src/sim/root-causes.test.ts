import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import type { ComponentDoc } from '../core/types'
import { PROJECTIONS } from '../observability/views'
import { DOCS_STORAGE } from '../ui/docs-storage'
import { createSim } from './model'

const MIB = 1024 * 1024

function advanceBy(sim: ReturnType<typeof createSim>, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 30, target - sim.state.t))
}

function doc(id: string): ComponentDoc {
  const found = DOCS_STORAGE.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing component doc ${id}`)
  return found
}

function metric(component: ComponentDoc, label: string, sim: ReturnType<typeof createSim>): string {
  const found = component.metrics?.find((candidate) => candidate.label === label)
  if (!found) throw new Error(`missing ${component.id} metric ${label}`)
  return found.get(sim.state)
}

interface WorkloadReading {
  walBytesPerSec: number
  tps: number
  fpiShare: number
}

function measureWalWorkload(
  autovacuum: boolean,
  fullPageWrites = true,
): WorkloadReading {
  const sim = createSim(createBus())
  sim.setKnob('tps', 300)
  sim.setKnob('writeRatio', 0.6)
  sim.setKnob('autovacuum', autovacuum)
  if (!fullPageWrites) sim.setKnob('fullPageWrites', false)
  advanceBy(sim, 300)

  const startLsn = sim.state.wal.insertLsn
  const startCommits = sim.state.stats.commits
  let fpiShareTotal = 0
  let samples = 0
  const until = sim.state.t + 200
  while (sim.state.t < until) {
    sim.update(Math.min(1 / 30, until - sim.state.t))
    fpiShareTotal += sim.state.wal.fpwBurst
    samples++
  }

  return {
    walBytesPerSec: (sim.state.wal.insertLsn - startLsn) / 200,
    tps: (sim.state.stats.commits - startCommits) / 200,
    fpiShare: fpiShareTotal / samples,
  }
}

describe('replication state normalization', () => {
  it('removes impossible physical and logical replication state at wal_level=minimal', { timeout: 15_000 }, () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('walLevel', 'logical')
    advanceBy(sim, 40)

    expect(sim.state.replication.logicalChangesPerSec).toBeGreaterThan(0)

    sim.setKnob('walLevel', 'minimal')
    advanceBy(sim, 5)

    const { replication, wal } = sim.state
    expect(replication.connected).toBe(false)
    expect(replication.logicalEnabled).toBe(false)
    expect(replication.logicalChangesPerSec).toBeLessThan(0.1)
    expect(replication.logicalSlotLsn).toBe(wal.insertLsn)
    expect(replication.sentLsn).toBe(wal.flushLsn)
    expect(replication.writeLsn).toBe(wal.flushLsn)
    expect(replication.flushLsn).toBe(wal.flushLsn)
    expect(replication.replayLsn).toBe(wal.flushLsn)
    expect(replication.lagBytes).toBe(0)
    expect(replication.lagSec).toBe(0)
  })

  it('bounds pg_wal by checkpoint retention when replication is impossible', { timeout: 20_000 }, () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('walLevel', 'minimal')

    advanceBy(sim, 600)

    expect(sim.state.wal.segmentCount * sim.state.wal.segmentSize).toBeLessThanOrEqual(
      sim.state.knobs.maxWalSize * 2 * MIB,
    )
  })

  it('reports no lag and no stale replay position for an absent standby', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    advanceBy(sim, 40)

    sim.setKnob('replicaEnabled', false)
    advanceBy(sim, 5)

    const { replication, wal } = sim.state
    expect(replication.connected).toBe(false)
    expect(replication.sentLsn).toBe(wal.flushLsn)
    expect(replication.writeLsn).toBe(wal.flushLsn)
    expect(replication.flushLsn).toBe(wal.flushLsn)
    expect(replication.replayLsn).toBe(wal.flushLsn)
    expect(replication.lagBytes).toBe(0)
    expect(replication.lagSec).toBe(0)
  })

  it('keeps the docs and PostgreSQL projections empty when replication cannot exist', () => {
    const sim = createSim(createBus())
    sim.setKnob('walLevel', 'logical')
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    advanceBy(sim, 40)
    sim.setKnob('walLevel', 'minimal')
    advanceBy(sim, 5)

    const decoder = doc('logical.decoder')
    const subscriber = doc('subscriber')
    const startup = doc('startup.proc')
    const replication = PROJECTIONS.replication(sim.state, undefined as never, 'rate')
    const slots = PROJECTIONS.slots(sim.state, undefined as never, 'rate')

    expect(replication.rows).toHaveLength(0)
    expect(slots.rows).toHaveLength(0)
    expect(metric(decoder, 'Changes / s', sim)).toBe('0')
    expect(metric(decoder, 'WAL held by the slot', sim)).toBe('nothing — no slot exists')
    expect(metric(subscriber, 'Changes / s', sim)).toBe('0')
    expect(metric(subscriber, 'WAL retained for it', sim)).toBe('nothing — no subscription exists')
    expect(metric(startup, 'Behind by', sim)).toBe('—')
  })
})

describe('autovacuum cost balance', () => {
  it('keeps vacuum WAL and I/O subordinate to the workload that created the garbage', { timeout: 30_000 }, () => {
    const withoutVacuum = measureWalWorkload(false)
    const withVacuum = measureWalWorkload(true)

    expect.soft(
      withVacuum.walBytesPerSec,
      `without=${withoutVacuum.walBytesPerSec}; with=${withVacuum.walBytesPerSec}`,
    ).toBeLessThan(withoutVacuum.walBytesPerSec * 1.3)
    expect.soft(
      withVacuum.tps,
      `without=${withoutVacuum.tps}; with=${withVacuum.tps}`,
    ).toBeGreaterThan(withoutVacuum.tps * 0.94)
    expect(
      Math.abs(withVacuum.fpiShare - withoutVacuum.fpiShare),
      `without=${withoutVacuum.fpiShare}; with=${withVacuum.fpiShare}`,
    ).toBeLessThan(0.15)
  })

  it('keeps full-page-write protection visible without a large throughput penalty', { timeout: 30_000 }, () => {
    const withoutImages = measureWalWorkload(true, false)
    const withImages = measureWalWorkload(true, true)

    expect.soft(
      withImages.walBytesPerSec / withoutImages.walBytesPerSec,
      `without=${withoutImages.walBytesPerSec}; with=${withImages.walBytesPerSec}`,
    ).toBeGreaterThan(1.4)
    expect.soft(
      withImages.walBytesPerSec / withoutImages.walBytesPerSec,
      `without=${withoutImages.walBytesPerSec}; with=${withImages.walBytesPerSec}`,
    ).toBeLessThan(4)
    expect(
      withImages.tps,
      `without=${withoutImages.tps}; with=${withImages.tps}`,
    ).toBeGreaterThan(withoutImages.tps * 0.9)
  })

  it('caps the vacuum fleet at one quarter of device read capacity', { timeout: 20_000 }, () => {
    const sim = createSim(createBus())
    sim.setKnob('autovacuum', false)
    sim.setKnob('tps', 500)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('updateRatio', 1)
    advanceBy(sim, 600)

    sim.setKnob('tps', 0)
    advanceBy(sim, 60)
    sim.setKnob('autovacuum', true)
    advanceBy(sim, 15)

    expect(sim.state.autovac.workers.filter((worker) => worker.active)).toHaveLength(3)

    let ioReadTotal = 0
    let samples = 0
    const until = sim.state.t + 60
    while (sim.state.t < until) {
      sim.update(Math.min(1 / 30, until - sim.state.t))
      ioReadTotal += sim.state.stats.ioReadPerSec
      samples++
    }

    expect(ioReadTotal / samples).toBeLessThanOrEqual(225)
  })
})

describe('hot_standby_feedback gating', () => {
  it('cannot pin xmin without a connected standby', () => {
    const sim = createSim(createBus())
    sim.setKnob('replicaEnabled', false)
    advanceBy(sim, 1)
    sim.setKnob('standbyLongQuery', true)

    advanceBy(sim, 30)

    expect(sim.state.oldestSnapshotAge).toBeLessThanOrEqual(2)
  })

  it('releases xmin when the standby disconnects while feedback is active', () => {
    const sim = createSim(createBus())
    sim.setKnob('standbyLongQuery', true)
    advanceBy(sim, 10)
    expect(sim.state.oldestSnapshotAge).toBeGreaterThan(9)

    sim.setKnob('replicaEnabled', false)
    advanceBy(sim, 1)

    expect(sim.state.oldestSnapshotAge).toBeLessThanOrEqual(2)
  })
})
