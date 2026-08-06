import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import {
  N_BACKEND_SLOTS,
  N_BUFFERS,
  N_VAC_WORKERS,
  N_WAL_SEG_SLOTS,
} from '../core/types'
import type { BackendState, Knobs, SimApi, SimState } from '../core/types'
import { createSim } from './model'

const MIB = 1024 * 1024
const SOAK_SECONDS = 2 * 60 * 60
const SAMPLE_SECONDS = 10
const UPDATE_SECONDS = 2 / 3
const MAX_HISTORY = 120

interface SoakConfiguration {
  name: string
  knobs: Partial<Knobs>
}

interface SoakReport {
  name: string
  elapsed: number
  commits: number
  firstQuarterTps: number
  lastQuarterTps: number
  minimumMinuteTps: number
  maxBackendStagnation: { seconds: number; state: BackendState; slot: number }
  internalSizes: {
    lifetimePageTrackingEntries: number
    bufferMappings: number
    fpiTrackedPages: number
    fpiSizeDecreases: number
    traceRequests: number
  }
  maxima: {
    archiveQueue: number
    backups: number
    deadTuples: number
    locks: number
    poolQueue: number
    slotRetentionBytes: number
    tablePages: number
    walSegments: number
  }
  poolQueueBound: number
  deadTupleDecreaseSamples: number
  quarterEnds: {
    commits: number
    deadTuples: number
    tablePages: number
    walSegments: number
  }[]
}

const CONFIGURATIONS: SoakConfiguration[] = [
  { name: 'default', knobs: {} },
  {
    name: 'write-heavy direct',
    knobs: {
      tps: 300,
      writeRatio: 0.7,
      updateRatio: 0.8,
      sharedBuffers: 512,
      checkpointTimeout: 120,
      maxWalSize: 256,
    },
  },
  {
    name: 'transaction pool overload',
    knobs: {
      tps: 300,
      clientConnections: 96,
      poolMode: 'transaction',
      defaultPoolSize: 6,
      maxClientConn: 100,
      queryWaitTimeout: 5,
      writeRatio: 0.4,
    },
  },
  {
    name: 'session pool overload',
    knobs: {
      tps: 200,
      clientConnections: 64,
      poolMode: 'session',
      defaultPoolSize: 8,
      maxClientConn: 100,
      queryWaitTimeout: 5,
      writeRatio: 0.4,
    },
  },
  {
    name: 'remote apply',
    knobs: {
      tps: 80,
      writeRatio: 0.5,
      synchronousCommit: 'remote_apply',
      synchronousStandbyNames: 'standbyA',
      standbyANetworkLag: 150,
    },
  },
]

function applyKnobs(sim: SimApi, knobs: Partial<Knobs>): void {
  for (const key of Object.keys(knobs) as (keyof Knobs)[]) {
    sim.setKnob(key, knobs[key] as never)
  }
}

function totalDeadTuples(state: SimState): number {
  return state.tables.reduce((total, table) => total + table.deadTuples, 0)
}

function totalTablePages(state: SimState): number {
  return state.tables.reduce((total, table) => total + table.pages + table.indexPages, 0)
}

function maxSlotRetention(state: SimState): number {
  return Math.max(...state.replication.physicalSlots.map((slot) => slot.retainedBytes))
}

function assertFinitePublicState(value: unknown, path = 'state', seen = new Set<object>()): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} became ${String(value)}`)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return
    const numbers = value as unknown as ArrayLike<number>
    for (let i = 0; i < numbers.length; i++) {
      if (!Number.isFinite(numbers[i])) throw new Error(`${path}.${i} became ${String(numbers[i])}`)
    }
    return
  }
  for (const [key, child] of Object.entries(value)) {
    assertFinitePublicState(child, `${path}.${key}`, seen)
  }
}

function assertArrayBounds(state: SimState, context: string): void {
  const lengths = state.stats.history
  expect.soft(state.backends, `${context}: backend slots`).toHaveLength(N_BACKEND_SLOTS)
  expect.soft(state.autovac.workers, `${context}: autovacuum workers`).toHaveLength(N_VAC_WORKERS)
  expect.soft(state.wal.segments, `${context}: visible WAL slots`).toHaveLength(N_WAL_SEG_SLOTS)
  expect.soft(state.pooler.sessionPendingTransactions, `${context}: session queue slots`)
    .toHaveLength(N_BACKEND_SLOTS)
  expect.soft(state.buffers.valid, `${context}: buffer validity array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.dirty, `${context}: buffer dirty array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.pinned, `${context}: buffer pin array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.usage, `${context}: buffer usage array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.rel, `${context}: buffer relation array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.lastTouch, `${context}: buffer timestamp array`).toHaveLength(N_BUFFERS)
  expect.soft(state.buffers.blk, `${context}: buffer block array`).toHaveLength(N_BUFFERS)
  for (const [name, history] of Object.entries(lengths)) {
    expect.soft(history.length, `${context}: ${name} history length`).toBeLessThanOrEqual(MAX_HISTORY)
  }
  expect.soft(state.locks.length, `${context}: lock edges`).toBeLessThanOrEqual(12)
  expect.soft(state.disasterRecovery.backups.length, `${context}: retained backups`)
    .toBeLessThanOrEqual(state.knobs.backupRetention)
  for (const backup of state.disasterRecovery.backups) {
    expect.soft(backup.walRanges.length, `${context}: ${backup.label} timeline WAL ranges`)
      .toBeLessThanOrEqual(2)
  }
  for (const table of state.tables) {
    expect.soft(table.liveTuples, `${context}: ${table.def.name} live tuples`).toBeGreaterThanOrEqual(0)
    expect.soft(table.deadTuples, `${context}: ${table.def.name} dead tuples`).toBeGreaterThanOrEqual(0)
    expect.soft(
      table.liveTuples + table.deadTuples,
      `${context}: ${table.def.name} tuple storage exceeded its heap pages`,
    ).toBeLessThanOrEqual(table.pages * table.def.tuplesPerPage + 1e-6)
    expect.soft(table.mvcc.versions.length, `${context}: ${table.def.name} MVCC witnesses`)
      .toBeLessThanOrEqual(24)
    expect.soft(table.mvcc.earlierSnapshot.inProgress.length, `${context}: old snapshot XIDs`)
      .toBeLessThanOrEqual(N_BACKEND_SLOTS)
    expect.soft(table.mvcc.laterSnapshot.inProgress.length, `${context}: new snapshot XIDs`)
      .toBeLessThanOrEqual(N_BACKEND_SLOTS)
  }
}

function assertPositionConsistency(state: SimState, context: string): void {
  const { wal } = state
  expect.soft(wal.insertLsn, `${context}: insert >= write`).toBeGreaterThanOrEqual(wal.writeLsn)
  expect.soft(wal.writeLsn, `${context}: write >= flush`).toBeGreaterThanOrEqual(wal.flushLsn)
  expect.soft(wal.bufferBytes, `${context}: wal_buffers non-negative`).toBeGreaterThanOrEqual(0)
  expect.soft(wal.bufferBytes, `${context}: wal_buffers capacity`).toBeLessThanOrEqual(wal.bufferCapacity)
  expect.soft(state.checkpoint.redoLsn, `${context}: checkpoint redo <= insert`)
    .toBeLessThanOrEqual(wal.insertLsn)
  expect.soft(state.checkpoint.completedRedoLsn, `${context}: completed redo <= redo`)
    .toBeLessThanOrEqual(state.checkpoint.redoLsn)
  expect.soft(state.highAvailability.timeline.newHistoryEndLsn, `${context}: live timeline end`)
    .toBe(wal.insertLsn)

  for (const standby of state.replication.standbys) {
    expect.soft(standby.sentLsn, `${context}: ${standby.nodeId} sent <= primary flush`)
      .toBeLessThanOrEqual(wal.flushLsn)
    expect.soft(standby.receivedLsn, `${context}: ${standby.nodeId} received <= sent`)
      .toBeLessThanOrEqual(standby.sentLsn)
    expect.soft(standby.writtenLsn, `${context}: ${standby.nodeId} written <= received`)
      .toBeLessThanOrEqual(standby.receivedLsn)
    expect.soft(standby.flushedLsn, `${context}: ${standby.nodeId} flushed <= written`)
      .toBeLessThanOrEqual(standby.writtenLsn)
    expect.soft(standby.appliedLsn, `${context}: ${standby.nodeId} applied <= flushed`)
      .toBeLessThanOrEqual(standby.flushedLsn)
    expect.soft(standby.lagBytes, `${context}: ${standby.nodeId} byte lag`)
      .toBe(Math.max(0, wal.flushLsn - standby.appliedLsn))
  }

  for (const slot of state.replication.physicalSlots) {
    expect.soft(slot.restartLsn, `${context}: ${slot.name} restart <= insert`)
      .toBeLessThanOrEqual(wal.insertLsn)
    expect.soft(slot.retainedBytes, `${context}: ${slot.name} retained bytes`)
      .toBe(Math.max(0, wal.insertLsn - slot.restartLsn))
  }
}

function runSoak(configuration: SoakConfiguration): SoakReport {
  const internalSizes = {
    lifetimePageTrackingEntries: 0,
    bufferMappings: 0,
    fpiTrackedPages: 0,
    fpiSizeDecreases: 0,
    traceRequests: 0,
  }
  let previousFpiSize = 0
  const sim = createSim(createBus(), {
    maxStep: 1 / 15,
    stateSizeObserver: (size) => {
      internalSizes.lifetimePageTrackingEntries = Math.max(
        internalSizes.lifetimePageTrackingEntries,
        size.lifetimePageTrackingEntries,
      )
      internalSizes.bufferMappings = Math.max(internalSizes.bufferMappings, size.bufferMappings)
      internalSizes.fpiTrackedPages = Math.max(internalSizes.fpiTrackedPages, size.fpiTrackedPages)
      internalSizes.traceRequests = Math.max(internalSizes.traceRequests, size.traceRequests)
      if (size.fpiTrackedPages < previousFpiSize) internalSizes.fpiSizeDecreases++
      previousFpiSize = size.fpiTrackedPages
    },
  })
  applyKnobs(sim, configuration.knobs)
  const startedAt = sim.state.t
  const startedRealT = sim.state.realT
  const startedCommits = sim.state.stats.commits
  const finishAt = startedAt + SOAK_SECONDS
  const poolQueueBound = sim.state.knobs.poolMode === 'disabled'
    ? 0
    : sim.state.knobs.poolMode === 'session'
      ? sim.state.pooler.acceptedClients
      : sim.state.knobs.queryWaitTimeout > 0
        ? sim.state.knobs.tps * (sim.state.knobs.queryWaitTimeout + 1)
          + sim.state.pooler.acceptedClients
        : Number.POSITIVE_INFINITY
  const quarterSeconds = SOAK_SECONDS / 4
  let nextSampleAt = startedAt
  let firstQuarterCommits = -1
  let thirdQuarterCommits = -1
  let maxBackendStagnation = { seconds: 0, state: 'free' as BackendState, slot: -1 }
  const backendSamples = sim.state.backends.map((backend) => ({
    state: backend.state,
    query: backend.query,
    progress: backend.progress,
    stateT: backend.stateT,
    stagnant: 0,
  }))
  const maxima = {
    archiveQueue: 0,
    backups: 0,
    deadTuples: 0,
    locks: 0,
    poolQueue: 0,
    slotRetentionBytes: 0,
    tablePages: 0,
    walSegments: 0,
  }
  const quarterEnds: SoakReport['quarterEnds'] = []
  let nextQuarter = 1
  let previousInsertLsn = sim.state.wal.insertLsn
  let previousCommits = sim.state.stats.commits
  let previousXid = sim.state.xid
  let previousArchiveLsn = sim.state.disasterRecovery.archive.archivedThroughLsn
  let previousCompletedRedoLsn = sim.state.checkpoint.completedRedoLsn
  const previousStandbyLsns = sim.state.replication.standbys.map((standby) => ({
    sent: standby.sentLsn,
    received: standby.receivedLsn,
    written: standby.writtenLsn,
    flushed: standby.flushedLsn,
    applied: standby.appliedLsn,
  }))
  let previousDeadTuples = totalDeadTuples(sim.state)
  let deadTupleDecreaseSamples = 0
  let nextRateAt = startedAt + 60
  let rateCommits = startedCommits
  let minimumMinuteTps = Number.POSITIVE_INFINITY

  while (sim.state.t < finishAt) {
    sim.update(Math.min(UPDATE_SECONDS, finishAt - sim.state.t))
    if (firstQuarterCommits < 0 && sim.state.t >= startedAt + quarterSeconds) {
      firstQuarterCommits = sim.state.stats.commits
    }
    if (thirdQuarterCommits < 0 && sim.state.t >= startedAt + quarterSeconds * 3) {
      thirdQuarterCommits = sim.state.stats.commits
    }
    while (nextQuarter <= 4 && sim.state.t >= startedAt + quarterSeconds * nextQuarter) {
      quarterEnds.push({
        commits: sim.state.stats.commits - startedCommits,
        deadTuples: totalDeadTuples(sim.state),
        tablePages: totalTablePages(sim.state),
        walSegments: sim.state.wal.segmentCount,
      })
      nextQuarter++
    }
    if (sim.state.t >= nextRateAt) {
      minimumMinuteTps = Math.min(
        minimumMinuteTps,
        (sim.state.stats.commits - rateCommits) / 60,
      )
      rateCommits = sim.state.stats.commits
      nextRateAt += 60
    }
    if (sim.state.t + 1e-9 < nextSampleAt) continue
    nextSampleAt += SAMPLE_SECONDS

    const context = `${configuration.name} at ${(sim.state.t - startedAt).toFixed(1)}s`
    assertFinitePublicState(sim.state)
    assertArrayBounds(sim.state, context)
    assertPositionConsistency(sim.state, context)
    expect.soft(sim.state.wal.insertLsn, `${context}: WAL insert LSN regressed`)
      .toBeGreaterThanOrEqual(previousInsertLsn)
    expect.soft(sim.state.stats.commits, `${context}: commits regressed`)
      .toBeGreaterThanOrEqual(previousCommits)
    expect.soft(sim.state.xid, `${context}: xid regressed`).toBeGreaterThanOrEqual(previousXid)
    expect.soft(
      sim.state.disasterRecovery.archive.archivedThroughLsn,
      `${context}: archive frontier regressed`,
    ).toBeGreaterThanOrEqual(previousArchiveLsn)
    expect.soft(
      sim.state.checkpoint.completedRedoLsn,
      `${context}: completed checkpoint redo regressed`,
    ).toBeGreaterThanOrEqual(previousCompletedRedoLsn)
    expect.soft(
      sim.state.realT - startedRealT,
      `${context}: wall/model clocks diverged at timeScale=1`,
    ).toBeCloseTo(sim.state.t - startedAt, 6)
    previousInsertLsn = sim.state.wal.insertLsn
    previousCommits = sim.state.stats.commits
    previousXid = sim.state.xid
    previousArchiveLsn = sim.state.disasterRecovery.archive.archivedThroughLsn
    previousCompletedRedoLsn = sim.state.checkpoint.completedRedoLsn

    for (let index = 0; index < sim.state.replication.standbys.length; index++) {
      const standby = sim.state.replication.standbys[index]
      const previous = previousStandbyLsns[index]
      expect.soft(standby.sentLsn, `${context}: ${standby.nodeId} sent LSN regressed`)
        .toBeGreaterThanOrEqual(previous.sent)
      expect.soft(standby.receivedLsn, `${context}: ${standby.nodeId} receive LSN regressed`)
        .toBeGreaterThanOrEqual(previous.received)
      expect.soft(standby.writtenLsn, `${context}: ${standby.nodeId} write LSN regressed`)
        .toBeGreaterThanOrEqual(previous.written)
      expect.soft(standby.flushedLsn, `${context}: ${standby.nodeId} flush LSN regressed`)
        .toBeGreaterThanOrEqual(previous.flushed)
      expect.soft(standby.appliedLsn, `${context}: ${standby.nodeId} replay LSN regressed`)
        .toBeGreaterThanOrEqual(previous.applied)
      previous.sent = standby.sentLsn
      previous.received = standby.receivedLsn
      previous.written = standby.writtenLsn
      previous.flushed = standby.flushedLsn
      previous.applied = standby.appliedLsn
    }

    const deadTuples = totalDeadTuples(sim.state)
    if (deadTuples < previousDeadTuples - 1) deadTupleDecreaseSamples++
    previousDeadTuples = deadTuples

    for (const backend of sim.state.backends) {
      const tracked = backendSamples[backend.slot]
      const waiting = backend.active
        && backend.state !== 'idle'
        && backend.state !== 'idle_in_xact'
      if (
        waiting
        && backend.state === tracked.state
        && backend.query === tracked.query
        && backend.stateT >= tracked.stateT
        && Math.abs(backend.progress - tracked.progress) < 1e-6
      ) tracked.stagnant += SAMPLE_SECONDS
      else tracked.stagnant = 0
      tracked.state = backend.state
      tracked.query = backend.query
      tracked.progress = backend.progress
      tracked.stateT = backend.stateT
      if (tracked.stagnant > maxBackendStagnation.seconds) {
        maxBackendStagnation = {
          seconds: tracked.stagnant,
          state: backend.state,
          slot: backend.slot,
        }
      }
    }
    maxima.archiveQueue = Math.max(maxima.archiveQueue, sim.state.wal.archiveQueue)
    maxima.backups = Math.max(maxima.backups, sim.state.disasterRecovery.backups.length)
    maxima.deadTuples = Math.max(maxima.deadTuples, totalDeadTuples(sim.state))
    maxima.locks = Math.max(maxima.locks, sim.state.locks.length)
    maxima.poolQueue = Math.max(maxima.poolQueue, sim.state.stats.poolerQueuedTransactions)
    maxima.slotRetentionBytes = Math.max(maxima.slotRetentionBytes, maxSlotRetention(sim.state))
    maxima.tablePages = Math.max(maxima.tablePages, totalTablePages(sim.state))
    maxima.walSegments = Math.max(maxima.walSegments, sim.state.wal.segmentCount)
  }

  const finishedCommits = sim.state.stats.commits
  sim.setKnob('poolMode', 'transaction')
  sim.setKnob('defaultPoolSize', 4)
  sim.update(UPDATE_SECONDS)
  expect.soft(sim.state.pooler.mode, `${configuration.name}: pool mode remained interactive`)
    .toBe('transaction')
  expect.soft(sim.state.pooler.serverLimit, `${configuration.name}: pool size remained interactive`)
    .toBe(4)
  sim.setKnob('defaultPoolSize', 9)
  sim.update(UPDATE_SECONDS)
  expect.soft(sim.state.pooler.serverLimit, `${configuration.name}: second pool resize took effect`)
    .toBe(9)

  const firstQuarterTps = (firstQuarterCommits - startedCommits) / quarterSeconds
  const lastQuarterTps = (finishedCommits - thirdQuarterCommits) / quarterSeconds
  return {
    name: configuration.name,
    elapsed: SOAK_SECONDS,
    commits: finishedCommits - startedCommits,
    firstQuarterTps,
    lastQuarterTps,
    minimumMinuteTps,
    maxBackendStagnation,
    internalSizes,
    maxima,
    poolQueueBound,
    deadTupleDecreaseSamples,
    quarterEnds,
  }
}

describe('long model-time soak', () => {
  it('keeps healthy workloads live, bounded, and internally consistent for hours', { timeout: 300_000 }, () => {
    const reports = CONFIGURATIONS.map(runSoak)
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env
    if (env?.SOAK_REPORT === '1') console.info('model time soak', JSON.stringify(reports, null, 2))
    for (const report of reports) {
      expect.soft(report.commits, `${report.name}: no completed work`).toBeGreaterThan(0)
      expect.soft(report.lastQuarterTps, `${report.name}: throughput stopped`).toBeGreaterThan(0)
      expect.soft(report.minimumMinuteTps, `${report.name}: a full minute completed no work`)
        .toBeGreaterThan(0)
      expect.soft(
        report.lastQuarterTps,
        `${report.name}: throughput decayed from ${report.firstQuarterTps} to ${report.lastQuarterTps}`,
      ).toBeGreaterThanOrEqual(report.firstQuarterTps * 0.5)
      expect.soft(
        report.maxBackendStagnation.seconds,
        `${report.name}: slot ${report.maxBackendStagnation.slot} stopped progressing in ${report.maxBackendStagnation.state}`,
      ).toBeLessThan(60)
      expect.soft(report.maxima.archiveQueue, `${report.name}: healthy archive backlog`).toBeLessThan(16)
      expect.soft(report.maxima.walSegments, `${report.name}: healthy pg_wal retention`)
        .toBeLessThan(32)
      expect.soft(report.maxima.slotRetentionBytes, `${report.name}: healthy physical-slot retention`)
        .toBeLessThan(64 * MIB)
      expect.soft(report.maxima.poolQueue, `${report.name}: live pool queue exceeded its wait window`)
        .toBeLessThanOrEqual(report.poolQueueBound)
      expect.soft(report.deadTupleDecreaseSamples, `${report.name}: dead tuples only ratcheted upward`)
        .toBeGreaterThan(0)
      expect.soft(
        report.internalSizes.lifetimePageTrackingEntries,
        `${report.name}: unused exact-page access ledger retained entries for the life of the model`,
      ).toBe(0)
      expect.soft(report.internalSizes.bufferMappings, `${report.name}: buffer hash size`)
        .toBeLessThanOrEqual(N_BUFFERS)
      expect.soft(report.internalSizes.fpiSizeDecreases, `${report.name}: FPI page ledger only grew`)
        .toBeGreaterThan(0)
      expect.soft(report.internalSizes.traceRequests, `${report.name}: trace request queue`)
        .toBe(0)
    }
  })
})
