import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { poolBytes, poolPages } from '../core/types'
import { fmtBytes, fmtLsn, fmtNum } from '../core/util'
import { createSim } from '../sim/model'
import { DOCS } from '../ui/content'
import { vitalValue } from '../ui/hud'
import { lsnRulerReadout, standbyReadout } from '../world/replication'
import { procArrayReadout, sharedBuffersReadout, shmemDeckReadout } from '../world/shmem'
import { diskArrayReadout } from '../world/storage'
import { walsenderReadout } from '../world/wal'
import { objectStoreReadout, standbyBReadout } from '../world/continuity'
import { createCollector } from './collector'
import { ALL_STEPS, ALL_VERDICTS } from './paths'
import { VITALS } from './ui'
import type { Cell, Projection } from './views'
import { collectorCacheHitPercent, PROJECTIONS } from './views'

class SvgElement {
  readonly nodeType = 1
  readonly style: Readonly<Record<string, string>> = {}

  constructor(
    readonly nodeName: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly childNodes: readonly SvgElement[] = [],
  ) {}

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name)
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getAttributeNS(_namespace: string, name: string): string | null {
    return this.getAttribute(name)
  }

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class TestDomParser {
  parseFromString(value: string): Document {
    const paths = [...value.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
      (match) => new SvgElement('path', { d: match[1] }),
    )
    return {
      documentElement: new SvgElement('svg', {}, paths),
      querySelectorAll: () => [],
    } as unknown as Document
  }
}

const nativeDomParser = globalThis.DOMParser
globalThis.DOMParser = TestDomParser as unknown as typeof DOMParser
const { worldGroundReadout, worldPitReadout } = await import('../world/ground')
globalThis.DOMParser = nativeDomParser

function text(cell: Cell | string | undefined): string {
  if (cell === undefined) throw new Error('projection cell is missing')
  return typeof cell === 'string' ? cell : cell.v
}

function row(projection: Projection, key: string): Record<string, Cell | string> {
  const found = projection.rows.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`projection row ${key} is missing`)
  return found.cells
}

function metric(id: string, label: string, state: ReturnType<typeof createSim>['state']): string {
  const doc = DOCS.find((candidate) => candidate.id === id)
  const found = doc?.metrics?.find((candidate) => candidate.label === label)
  if (!found) throw new Error(`metric ${id}::${label} is missing`)
  return found.get(state)
}

function advance(sim: ReturnType<typeof createSim>, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 30, target - sim.state.t))
}

function advanceUntil(
  sim: ReturnType<typeof createSim>,
  done: () => boolean,
  timeoutSec = 90,
): void {
  const deadline = sim.state.t + timeoutSec
  while (!done() && sim.state.t < deadline) sim.update(1 / 30)
  if (!done()) throw new Error(`condition was not reached within ${timeoutSec}s`)
}

function advanceWithCollector(
  sim: ReturnType<typeof createSim>,
  collector: ReturnType<typeof createCollector>,
  seconds: number,
): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) {
    sim.update(Math.min(1 / 30, target - sim.state.t))
    collector.sample()
  }
}

function takeBackup(sim: ReturnType<typeof createSim>): void {
  if (!sim.startBaseBackup()) throw new Error('base backup did not start')
  const deadline = sim.state.t + 240
  while (sim.state.disasterRecovery.backup.status !== 'idle' && sim.state.t < deadline) {
    sim.update(1 / 30)
  }
  if (sim.state.disasterRecovery.backup.status !== 'idle') {
    throw new Error('base backup did not complete')
  }
}

describe('cross-surface scale agreement', () => {
  it('renders shared_buffers from one real pool quantity on every surface', () => {
    const sim = createSim(createBus())
    sim.setKnob('sharedBuffers', 768)
    const collector = createCollector(sim)
    const bytes = fmtBytes(poolBytes(sim.state.knobs))
    const pages = String(poolPages(sim.state.knobs))
    const settings = PROJECTIONS.settings(sim.state, collector, 'total')

    for (const value of [
      metric('world.pit', 'Buffer pool', sim.state),
      metric('shmem.deck', 'Buffer pool', sim.state),
      metric('shared.buffers', 'Pool size', sim.state),
      metric('os.cache', 'shared_buffers', sim.state),
      shmemDeckReadout(sim.state),
      sharedBuffersReadout(sim.state),
    ]) {
      expect(value).toContain(bytes)
    }
    expect(text(row(settings, 'shared_buffers').setting)).toBe(pages)
  })

  it('keeps dirty sample-frame counts identical in docs, HUD and observability', () => {
    const sim = createSim(createBus())
    advance(sim, 30)
    const collector = createCollector(sim)
    const dirty = fmtNum(sim.state.buffers.dirtyCount)
    const observability = VITALS.find((vital) => vital.key === 'dirty')

    expect(metric('world.pit', 'Dirty sample', sim.state)).toContain(dirty)
    expect(metric('shared.buffers', 'Dirty sample', sim.state)).toContain(dirty)
    expect(metric('bgwriter', 'Dirty sample frames', sim.state)).toContain(dirty)
    expect(vitalValue('dirty', sim.state).text).toBe(dirty)
    expect(observability?.read(sim, collector).v).toBe(String(sim.state.buffers.dirtyCount))
  })

  it('uses page units and the same current read rate in docs, world and pg_stat_io', () => {
    const sim = createSim(createBus())
    sim.state.stats.ioReadPerSec = 1041
    const collector = createCollector(sim)
    const reads = fmtNum(sim.state.stats.ioReadPerSec)
    const io = PROJECTIONS.io(sim.state, collector, 'rate')

    expect(metric('world.pit', 'Reads', sim.state)).toBe(`${reads} pages/s`)
    expect(worldPitReadout(sim.state)).toContain(`${reads} read pages/s`)
    expect(diskArrayReadout(sim.state)).toContain(`${reads} read pages/s`)
    expect(text(row(io, 'client').reads)).toBe(`${reads}/s`)
  })

  it('leaves sample-scale counters out of full-stream PostgreSQL columns', () => {
    const sim = createSim(createBus())
    advance(sim, 30)
    const collector = createCollector(sim)
    const bgwriter = PROJECTIONS.bgwriter(sim.state, collector, 'total')
    const checkpointer = PROJECTIONS.checkpointer(sim.state, collector, 'total')
    const io = PROJECTIONS.io(sim.state, collector, 'total')

    expect(text(row(bgwriter, 'bgw').buffers_clean)).toBe('null')
    expect(text(row(checkpointer, 'ckpt').buffers_written)).toBe('null')
    expect(text(row(io, 'client').writes)).toBe('null')
    expect(text(row(io, 'client').evictions)).toBe('null')
    expect(text(row(io, 'client').reads)).not.toBe('null')
    expect(text(row(io, 'client').hits)).not.toBe('null')
  })

  it('projects modeled spills through pg_stat_database temp counters', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    sim.state.workMem.tempFiles += 3
    sim.state.workMem.tempBytes += 9 * 1024 * 1024
    collector.sample()
    const database = PROJECTIONS.database(sim.state, collector, 'total')

    expect(text(row(database, 'pgsimcity').temp_files)).toBe('3')
    expect(text(row(database, 'pgsimcity').temp_bytes)).toBe(fmtBytes(9 * 1024 * 1024))
    expect(database.caption).toContain('log_temp_files')
  })

  it('uses current insert LSN for every logical-slot retained-WAL rendering', () => {
    const sim = createSim(createBus())
    sim.setKnob('walLevel', 'logical')
    sim.state.wal.insertLsn = 30_000
    sim.state.wal.flushLsn = 25_000
    sim.state.replication.logicalSlotLsn = 8_000
    const collector = createCollector(sim)
    const retained = fmtBytes(22_000)
    const slots = PROJECTIONS.slots(sim.state, collector, 'total')

    expect(metric('logical.decoder', 'WAL held by the slot', sim.state)).toBe(retained)
    expect(metric('subscriber', 'WAL retained for it', sim.state)).toBe(retained)
    expect(text(row(slots, 'sub').retained)).toBe(retained)
  })

  it('uses the standby flush position for disconnected physical-slot retention', () => {
    const sim = createSim(createBus())
    sim.state.replication.standbys[0].connected = false
    sim.state.wal.insertLsn = 30_000
    sim.state.replication.physicalSlots[0].restartLsn = 8_000
    sim.state.replication.physicalSlots[0].retainedBytes = 22_000
    sim.state.replication.physicalSlots[1].retainedBytes = 0

    expect(walsenderReadout(sim.state)).toContain(`largest slot hold ${fmtBytes(22_000)}`)
  })

  it('renders replication lag from the same byte and time values', () => {
    const sim = createSim(createBus())
    const standby = sim.state.replication.standbys[0]
    standby.lagBytes = 1_234_567
    standby.lagSec = 3.25
    standby.appliedLsn = sim.state.wal.writeLsn - standby.lagBytes
    const collector = createCollector(sim)
    const bytes = fmtBytes(standby.lagBytes)
    const replication = PROJECTIONS.replication(sim.state, collector, 'total')

    expect(metric('net.wire', 'Lag', sim.state)).toContain(bytes)
    expect(metric('startup.proc', 'Behind by', sim.state)).toContain(bytes)
    expect(standbyReadout(sim.state)).toContain(bytes)
    expect(lsnRulerReadout(sim.state)).toContain(bytes)
    expect(text(row(replication, 'standbyA').behind)).toBe(bytes)
  })

  it('shows absence instead of zero replay lag when no standby is connected', () => {
    const sim = createSim(createBus())
    sim.setKnob('standbyAEnabled', false)
    sim.setKnob('standbyBEnabled', false)
    advance(sim, 1)
    const collector = createCollector(sim)
    const diagnoseLag = VITALS.find((vital) => vital.key === 'lag')
    const replication = PROJECTIONS.replication(sim.state, collector, 'total')

    expect(replication.rows).toHaveLength(0)
    expect(replication.empty).toMatch(/gone, not that lag is zero/i)
    expect(vitalValue('lag', sim.state).text).toBe('—')
    expect(diagnoseLag?.read(sim, collector)).toEqual({ v: '—', tone: '' })
    expect(lsnRulerReadout(sim.state)).toMatch(/standby_a offline/i)
    expect(metric('standby.b', 'Lag', sim.state)).toBe('—')
  })

  it('reports standby_a as the primary after a successful switchover', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    advance(sim, 35)
    expect(sim.startSwitchover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

    expect(sim.state.highAvailability.currentLeader).toBe('standbyA')
    expect(sim.state.cluster.nodes[1].role).toBe('primary')
    expect(standbyReadout(sim.state)).toContain('promoted primary')
    expect(standbyReadout(sim.state)).not.toContain('offline')
    expect(lsnRulerReadout(sim.state)).toContain('standby_a is primary')
    expect(metric('walreceiver', 'Link', sim.state)).toBe('stopped — standby_a is primary')
    expect(metric('replica.standby', 'State', sim.state)).toBe('primary — accepting writes')
    expect(metric('replica.buffers', 'Standby', sim.state)).toBe('promoted primary')
    advance(sim, 10)
    expect(metric('replica.storage', 'Applied through', sim.state))
      .toBe(fmtLsn(sim.state.cluster.nodes[1].dataDirectory.appliedLsn))
    expect(metric('replica.storage', 'Divergence', sim.state)).toBe('0 B')
  })

  it('uses standby_b as the primary reference after it is promoted', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyBNetworkLag', 900)
    advance(sim, 35)
    expect(sim.startFailover('standbyB')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

    expect(sim.state.highAvailability.currentLeader).toBe('standbyB')
    expect(sim.state.cluster.nodes[2].role).toBe('primary')
    expect(standbyBReadout(sim.state)).toContain('promoted primary')
    expect(metric('standby.b', 'Role', sim.state)).toBe('primary — accepting writes')
    expect(metric('standby.b.storage', 'Primary at', sim.state)).toBe(fmtLsn(sim.state.wal.insertLsn))
    expect(sim.state.cluster.nodes[0].dataDirectory.appliedLsn).not.toBe(sim.state.wal.insertLsn)
    expect(walsenderReadout(sim.state)).toContain('current primary standby_b sees standbyB as leader')
  })

  it('keeps Diagnose cache evidence on the same time scopes as its route and grid', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    const collector = createCollector(sim)
    advanceWithCollector(sim, collector, 300)
    sim.setKnob('sharedBuffers', 128)
    sim.setKnob('tps', 600)
    sim.setKnob('writeRatio', 0)
    sim.setKnob('seqScanRatio', 0.1)
    advanceWithCollector(sim, collector, 2)

    const cumulative = collectorCacheHitPercent(collector)
    const rolling = sim.state.stats.cacheHitPct
    const ioStep = ALL_STEPS.find((step) => step.id === 'io.1')
    const ioOk = ALL_VERDICTS.find((verdict) => verdict.id === 'v.io_ok')
    const evidence = ioOk?.evidence(sim.state, collector) ?? []
    const database = PROJECTIONS.database(sim.state, collector, 'total')

    expect(cumulative).toBeGreaterThan(90)
    expect(rolling).toBeLessThan(90)
    expect(ioStep?.branches.find((branch) => branch.next === 'v.io_ok')?.test(sim.state, collector)).toBe(true)
    expect(text(row(database, 'pgsimcity').hit_ratio)).toBe(`${cumulative.toFixed(1)}%`)
    expect(evidence.find((item) => item.label === 'hit ratio since stats reset')?.value)
      .toBe(`${cumulative.toFixed(1)}%`)
    expect(evidence.find((item) => item.label === 'rolling hit ratio · ~50s')?.value)
      .toBe(`${rolling.toFixed(1)}%`)
  })

  it('reports retained WAL objects rather than lifetime archive successes', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('backupRetention', 1)
    takeBackup(sim)
    advance(sim, 8)
    takeBackup(sim)

    const oldest = sim.state.disasterRecovery.backups[0]
    const segmentSize = sim.state.wal.segmentSize
    const retained = Math.max(
      0,
      Math.floor(sim.state.disasterRecovery.archive.archivedThroughLsn / segmentSize)
        - Math.floor(oldest.startLsn / segmentSize),
    )

    expect(sim.state.disasterRecovery.expiredBackups).toBe(1)
    expect(retained).toBeLessThan(sim.state.wal.archived)
    expect(metric('object.store', 'Segments held', sim.state)).toBe(fmtNum(retained))
    expect(metric('object.store', 'Archive size', sim.state)).toBe(fmtBytes(retained * segmentSize))
    expect(objectStoreReadout(sim.state)).toContain(`${retained} WAL objects`)
    expect(objectStoreReadout(sim.state)).not.toContain(`${sim.state.wal.archived} WAL objects`)
  })

  it('uses the model data-directory estimate for both standby storage inspectors', () => {
    const sim = createSim(createBus())
    advance(sim, 30)
    const standbyABytes = sim.state.cluster.nodes[1].dataDirectory.bytes
    const standbyBBytes = sim.state.cluster.nodes[2].dataDirectory.bytes

    expect(standbyABytes).toBe(standbyBBytes)
    expect(metric('replica.storage', 'Aggregate size projection', sim.state))
      .toBe(fmtBytes(standbyABytes))
    expect(metric('standby.b.storage', 'Size', sim.state))
      .toBe(fmtBytes(standbyBBytes))
  })

  it('uses running statements, not occupied slots, for every active-backend label', () => {
    const sim = createSim(createBus())
    const state = sim.state
    for (let i = 0; i < state.backends.length; i++) {
      state.backends[i].active = i < 10
      state.backends[i].state = i < 3 ? 'exec_cpu' : i < 5 ? 'blocked' : 'idle'
    }
    state.stats.activeBackends = 10
    state.stats.runningBackends = 5
    const collector = createCollector(sim)
    const active = fmtNum(state.stats.runningBackends)
    const noLocks = ALL_VERDICTS.find((verdict) => verdict.id === 'v.no_locks')
    const activeEvidence = noLocks?.evidence(state, collector).find((item) => item.label === 'active backends')

    expect(metric('backend.row', 'Active', state)).toContain(active)
    expect(metric('stats.collector', 'Active backends', state)).toContain(active)
    expect(worldGroundReadout(state)).toContain(`${active} active`)
    expect(procArrayReadout(state)).toContain(`${active} active`)
    expect(activeEvidence?.value).toBe(String(state.stats.runningBackends))
    expect(state.stats.activeBackends).toBeGreaterThan(state.stats.runningBackends)
  })

  it('measures crash recovery from the completed redo point through durable flush', () => {
    const sim = createSim(createBus())
    sim.state.checkpoint.completedRedoLsn = 10_000
    sim.state.checkpoint.redoLsn = 20_000
    sim.state.wal.flushLsn = 30_000
    sim.state.wal.insertLsn = 40_000

    expect(metric('startup.proc', 'Crash recovery from', sim.state)).toBe(
      `${fmtLsn(sim.state.checkpoint.completedRedoLsn)} (${fmtBytes(20_000)} of WAL)`,
    )
  })
})
