import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import type { ComponentDoc, SyncCommit } from '../core/types'
import { PROJECTIONS } from '../observability/views'
import { DOCS_STORAGE } from '../ui/docs-storage'
import { createSim } from './model'
import { AGGREGATE_TEST_STEP, createAggregateSim } from './test-support'

const MIB = 1024 * 1024

type Sim = ReturnType<typeof createAggregateSim>

function advanceBy(sim: Sim, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, target - sim.state.t))
  }
}

function doc(id: string): ComponentDoc {
  const found = DOCS_STORAGE.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing component doc ${id}`)
  return found
}

function metric(component: ComponentDoc, label: string, sim: Sim): string {
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
  const sim = createAggregateSim()
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
    sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
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
    const standbyA = replication.standbys[0]
    expect(standbyA.connected).toBe(false)
    expect(replication.logicalEnabled).toBe(false)
    expect(replication.logicalChangesPerSec).toBeLessThan(0.1)
    expect(replication.logicalSlotLsn).toBe(wal.insertLsn)
    expect(standbyA.sentLsn).toBe(wal.flushLsn)
    expect(standbyA.writtenLsn).toBe(wal.flushLsn)
    expect(standbyA.flushedLsn).toBe(wal.flushLsn)
    expect(standbyA.appliedLsn).toBe(wal.flushLsn)
    expect(standbyA.lagBytes).toBe(0)
    expect(standbyA.lagSec).toBe(0)
  })

  it('bounds pg_wal by checkpoint retention when replication is impossible', { timeout: 20_000 }, () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('walLevel', 'minimal')

    advanceBy(sim, 600)

    expect(sim.state.wal.segmentCount * sim.state.wal.segmentSize).toBeLessThanOrEqual(
      sim.state.knobs.maxWalSize * 2 * MIB,
    )
  })

  it('keeps a disconnected standby at its own durable position for slot accounting', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    advanceBy(sim, 40)

    const standbyA = sim.state.replication.standbys[0]
    const durableAtDisconnect = standbyA.flushedLsn
    sim.setKnob('standbyAEnabled', false)
    advanceBy(sim, 5)

    const { replication, wal } = sim.state
    expect(standbyA.connected).toBe(false)
    expect(standbyA.flushedLsn).toBe(durableAtDisconnect)
    expect(wal.flushLsn).toBeGreaterThan(durableAtDisconnect)
    expect(replication.physicalSlots[0].active).toBe(false)
    expect(replication.physicalSlots[0].retainedBytes).toBeGreaterThan(0)
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
    const sim = createAggregateSim()
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
      sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
      ioReadTotal += sim.state.stats.ioReadPerSec
      samples++
    }

    expect(ioReadTotal / samples).toBeLessThanOrEqual(225)
  })

  it('paces vacuum heap scans instead of discounting their I/O', () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuumScaleFactor', 0)
    sim.setKnob('fullPageWrites', false)

    const deadline = sim.state.t + 20
    let worker = sim.state.autovac.workers.find(
      (candidate) => candidate.active && candidate.phase === 'scan_heap' && candidate.progress < 0.8,
    )
    while (!worker && sim.state.t < deadline) {
      sim.update(AGGREGATE_TEST_STEP)
      worker = sim.state.autovac.workers.find(
        (candidate) => candidate.active && candidate.phase === 'scan_heap' && candidate.progress < 0.8,
      )
    }

    expect(worker, 'no vacuum worker entered scan_heap').toBeDefined()
    if (!worker) return
    const scanning = sim.state.autovac.workers
      .filter((candidate) => candidate.active && candidate.phase === 'scan_heap' && candidate.progress < 0.8)
      .map((candidate) => {
        const table = sim.state.tables[candidate.table]
        const visibleHeapShare = table.def.id === 'events' ? 0.15 : 1
        return {
          worker: candidate,
          table: table.def.id,
          scannedPages: Math.max(1, Math.round(table.pages * visibleHeapShare)),
          progressBefore: candidate.progress,
        }
      })

    advanceBy(sim, 1)

    let processedPagesPerSec = 0
    for (const sample of scanning) {
      expect(sample.worker.phase).toBe('scan_heap')
      const workerPagesPerSec =
        (sample.worker.progress - sample.progressBefore) * sample.scannedPages
      processedPagesPerSec += workerPagesPerSec
      expect(
        workerPagesPerSec,
        `${sample.table} vacuum processed ${workerPagesPerSec} heap pages/s`,
      ).toBeLessThanOrEqual(75.5)
    }
    expect(
      sim.state.stats.ioReadPerSec,
      `reported ${sim.state.stats.ioReadPerSec} reads/s while vacuum processed ${processedPagesPerSec}`,
    ).toBeGreaterThanOrEqual(processedPagesPerSec * 0.8)
  })
})

describe('backend dirty-eviction cost', () => {
  function tracedScanSeconds(dirty: boolean): number {
    const sim = createSim(createBus())
    sim.setKnob('tps', 0)
    sim.setKnob('sharedBuffers', 128)
    sim.setKnob('bgwriterEnabled', false)
    advanceBy(sim, 30)

    const { buffers } = sim.state
    buffers.valid.fill(1, 0, buffers.sampleFrames)
    buffers.dirty.fill(dirty ? 1 : 0, 0, buffers.sampleFrames)
    buffers.pinned.fill(0, 0, buffers.sampleFrames)
    buffers.usage.fill(0, 0, buffers.sampleFrames)

    sim.request('select_seq', 3)
    let started = false
    for (let tick = 0; tick < 1800; tick++) {
      sim.update(1 / 30)
      if (sim.state.trace.stop !== 'done') started = true
      else if (started) break
    }
    return sim.state.trace.lastTripSec
  }

  it('charges the requesting backend for synchronously writing dirty victims', () => {
    const clean = tracedScanSeconds(false)
    const dirty = tracedScanSeconds(true)

    expect(
      dirty,
      `clean pool=${clean}s; dirty pool=${dirty}s`,
    ).toBeGreaterThan(clean + 0.02)
  })

  function bgwriterReading(maxpages: number, enabled = true): {
    backendWritesPerSec: number
    cleanedPerSec: number
  } {
    const sim = createAggregateSim()
    sim.setKnob('sharedBuffers', 512)
    sim.setKnob('tps', 1500)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('seqScanRatio', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('bgwriterEnabled', enabled)
    sim.setKnob('bgwriterLruMaxpages', maxpages)
    advanceBy(sim, 300)

    const backendStart = sim.state.buffers.dirtyEvictions
    const cleanedStart = sim.state.bgwriter.cleanedTotal
    advanceBy(sim, 120)
    return {
      backendWritesPerSec:
        (sim.state.buffers.dirtyEvictions - backendStart) / 120,
      cleanedPerSec:
        (sim.state.bgwriter.cleanedTotal - cleanedStart) / 120,
    }
  }

  it('lets a working bgwriter spare backends', { timeout: 15_000 }, () => {
    const disabled = bgwriterReading(400, false)
    const enabled = bgwriterReading(400, true)

    expect.soft(
      enabled.backendWritesPerSec,
      `off=${disabled.backendWritesPerSec}; on=${enabled.backendWritesPerSec}`,
    ).toBeLessThan(disabled.backendWritesPerSec * 0.7)
  })

  it('lets bgwriter_lru_maxpages bind under a churning workload', { timeout: 15_000 }, () => {
    const capped = bgwriterReading(100)
    const raised = bgwriterReading(400)

    expect.soft(
      raised.cleanedPerSec,
      `100=${capped.cleanedPerSec}; 400=${raised.cleanedPerSec}`,
    ).toBeGreaterThan(capped.cleanedPerSec * 1.2)
    expect(
      raised.backendWritesPerSec,
      `100=${capped.backendWritesPerSec}; 400=${raised.backendWritesPerSec}`,
    ).toBeLessThan(capped.backendWritesPerSec * 0.9)
  })
})

describe('wal_buffers auto-tuning', () => {
  it('derives capacity from shared_buffers with PostgreSQL bounds', () => {
    const sim = createSim(createBus())

    expect(sim.state.wal.bufferCapacity).toBe(16 * MIB)
    sim.setKnob('sharedBuffers', 128)
    expect(sim.state.wal.bufferCapacity).toBe(4 * MIB)
    sim.setKnob('sharedBuffers', 1)
    expect(sim.state.wal.bufferCapacity).toBe(64 * 1024)
    sim.setKnob('sharedBuffers', 64 * 1024)
    expect(sim.state.wal.bufferCapacity).toBe(16 * MIB)
    sim.setKnob('sharedBuffers', 2 * 1024)
    expect(sim.state.wal.bufferCapacity).toBe(16 * MIB)
  })
})

describe('replication timing units', () => {
  function meanReplayLag(sim: Sim, seconds: number): number {
    let total = 0
    let samples = 0
    const until = sim.state.t + seconds
    while (sim.state.t < until) {
      sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
      total += sim.state.replication.standbys[0].lagSec
      samples++
    }
    return total / samples
  }

  it('reports replay_lag in real seconds while packet travel stays visible', { timeout: 15_000 }, () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('autovacuum', false)
    sim.setKnob('standbyANetworkLag', 400)
    advanceBy(sim, 300)

    const stretched = meanReplayLag(sim, 60)
    expect(stretched).toBeGreaterThan(0.35)
    expect(stretched).toBeLessThan(0.6)

    sim.setKnob('standbyANetworkLag', 0)
    advanceBy(sim, 300)
    expect(meanReplayLag(sim, 60)).toBeLessThan(0.05)
  })
})

describe('synchronous_commit guarantees', () => {
  function meanCommitWaiters(mode: SyncCommit): number {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('autovacuum', false)
    sim.setKnob('standbyANetworkLag', 50)
    sim.setKnob('synchronousCommit', mode)
    advanceBy(sim, 10)

    let waiters = 0
    let samples = 0
    const until = sim.state.t + 20
    while (sim.state.t < until) {
      sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
      waiters += sim.state.backends.filter((backend) => backend.state === 'commit_wait').length
      samples++
    }
    return waiters / samples
  }

  it('forms the off < local < remote_write < on < remote_apply commit-wait ladder', () => {
    const off = meanCommitWaiters('off')
    const local = meanCommitWaiters('local')
    const remoteWrite = meanCommitWaiters('remote_write')
    const on = meanCommitWaiters('on')
    const remoteApply = meanCommitWaiters('remote_apply')

    expect.soft(local, `off=${off}; local=${local}`).toBeGreaterThan(off)
    expect.soft(remoteWrite, `local=${local}; remote_write=${remoteWrite}`).toBeGreaterThan(local)
    expect.soft(on, `remote_write=${remoteWrite}; on=${on}`).toBeGreaterThan(remoteWrite)
    expect(
      remoteApply,
      `on=${on}; remote_apply=${remoteApply}`,
    ).toBeGreaterThan(on)
  })
})

describe('checkpoint_timeout full-page-image amortisation', () => {
  function checkpointReading(timeout: number): {
    checkpoints: number
    fpiShare: number
    walBytesPerSec: number
  } {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('updateRatio', 1)
    sim.setKnob('seqScanRatio', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('maxWalSize', 4096)
    sim.setKnob('checkpointTimeout', timeout)
    advanceBy(sim, 400)

    const checkpointStart = sim.state.checkpoint.count
    const lsnStart = sim.state.wal.insertLsn
    let fpiShare = 0
    let samples = 0
    const until = sim.state.t + 400
    while (sim.state.t < until) {
      sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
      fpiShare += sim.state.wal.fpwBurst
      samples++
    }
    return {
      checkpoints: sim.state.checkpoint.count - checkpointStart,
      fpiShare: fpiShare / samples,
      walBytesPerSec: (sim.state.wal.insertLsn - lsnStart) / 400,
    }
  }

  it('re-touches a warm write band so longer intervals amortise page images', { timeout: 20_000 }, () => {
    const short = checkpointReading(15)
    const long = checkpointReading(120)

    expect.soft(long.checkpoints).toBeLessThan(short.checkpoints / 3)
    expect.soft(
      long.fpiShare,
      `15s=${short.fpiShare}; 120s=${long.fpiShare}`,
    ).toBeLessThan(short.fpiShare * 0.85)
    expect.soft(
      long.fpiShare * long.walBytesPerSec,
      `15s=${short.fpiShare * short.walBytesPerSec}; 120s=${long.fpiShare * long.walBytesPerSec}`,
    ).toBeLessThan(short.fpiShare * short.walBytesPerSec * 0.6)
    expect(
      long.walBytesPerSec,
      `15s=${short.walBytesPerSec}; 120s=${long.walBytesPerSec}`,
    ).toBeLessThan(short.walBytesPerSec * 0.8)
  })
})

describe('hot_standby_feedback gating', () => {
  it('cannot pin xmin without a connected standby', () => {
    const sim = createSim(createBus())
    sim.setKnob('standbyAEnabled', false)
    advanceBy(sim, 1)
    sim.setKnob('standbyALongQuery', true)

    advanceBy(sim, 30)

    expect(sim.state.oldestSnapshotAge).toBeLessThanOrEqual(2)
  })

  it('releases xmin when the standby disconnects while feedback is active', () => {
    const sim = createSim(createBus())
    sim.setKnob('standbyALongQuery', true)
    advanceBy(sim, 10)
    expect(sim.state.oldestSnapshotAge).toBeGreaterThan(9)

    sim.setKnob('standbyAEnabled', false)
    advanceBy(sim, 1)

    expect(sim.state.oldestSnapshotAge).toBeLessThanOrEqual(2)
  })
})
