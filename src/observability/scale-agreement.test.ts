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
import { createCollector } from './collector'
import { ALL_VERDICTS } from './paths'
import { VITALS } from './ui'
import type { Cell, Projection } from './views'
import { PROJECTIONS } from './views'

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
    sim.state.replication.connected = false
    sim.state.wal.insertLsn = 30_000
    sim.state.replication.flushLsn = 8_000
    sim.state.replication.replayLsn = 2_000

    expect(walsenderReadout(sim.state)).toContain(`physical slot holding ${fmtBytes(22_000)}`)
  })

  it('renders replication lag from the same byte and time values', () => {
    const sim = createSim(createBus())
    sim.state.replication.lagBytes = 1_234_567
    sim.state.replication.lagSec = 3.25
    const collector = createCollector(sim)
    const bytes = fmtBytes(sim.state.replication.lagBytes)
    const replication = PROJECTIONS.replication(sim.state, collector, 'total')

    expect(metric('net.wire', 'Lag', sim.state)).toContain(bytes)
    expect(metric('startup.proc', 'Behind by', sim.state)).toContain(bytes)
    expect(standbyReadout(sim.state)).toContain(bytes)
    expect(lsnRulerReadout(sim.state)).toContain(bytes)
    expect(text(row(replication, 'standby1').behind)).toBe(bytes)
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
