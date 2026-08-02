import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import { DEFAULT_KNOBS, N_BUFFERS } from '../core/types'
import type { ComponentDef, Knobs, QualitySettings, SimState, WorldContext, WorldModule } from '../core/types'
import { DOCS, KNOB_META } from '../ui/content'
import { createSim } from './model'

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
  parseFromString(text: string): Document {
    const paths = [...text.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
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

const { createGround } = await import('../world/ground')
const { createShmem } = await import('../world/shmem')
const { createClients } = await import('../world/clients')
const { createBackends } = await import('../world/backends')
const { createWal } = await import('../world/wal')
const { createStorage } = await import('../world/storage')
const { createMaintenance } = await import('../world/maintenance')
const { createReplication } = await import('../world/replication')
const { createPlanner } = await import('../world/planner')
const { createContinuity } = await import('../world/continuity')

type Contract =
  | 'moves-with: sharedBuffers'
  | 'invariant-under: sharedBuffers'
  | 'unrelated'

interface Snapshots {
  state: SimState
  metrics: Map<string, string>
  readouts: Map<string, string>
}

const METRIC_MOVES = new Set([
  'world.pit::Buffer pool',
  'shmem.deck::Buffer pool',
  'shmem.deck::WAL buffers',
  'shared.buffers::Pool size',
  'os.cache::shared_buffers',
])

const METRIC_INVARIANTS = new Set([
  'shmem.deck::Lock waits',
])

const READOUT_MOVES = new Set([
  'shmem.deck',
  'shared.buffers',
])

function metricContract(key: string): Contract {
  if (METRIC_MOVES.has(key)) return 'moves-with: sharedBuffers'
  if (METRIC_INVARIANTS.has(key)) return 'invariant-under: sharedBuffers'
  return 'unrelated'
}

function readoutContract(key: string): Contract {
  return READOUT_MOVES.has(key) ? 'moves-with: sharedBuffers' : 'unrelated'
}

function fakeCanvas(): HTMLCanvasElement {
  const gradient = { addColorStop: () => undefined }
  const context = new Proxy(
    {
      canvas: undefined as unknown,
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: (value: string) => ({ width: value.length * 12 }),
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property)
        return () => undefined
      },
      set(target, property, value) {
        Reflect.set(target, property, value)
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D
  const canvas = {
    width: 1,
    height: 1,
    style: {},
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement
  ;(context as unknown as { canvas: HTMLCanvasElement }).canvas = canvas
  return canvas
}

function step(sim: ReturnType<typeof createSim>, count = 900): void {
  for (let i = 0; i < count; i++) sim.update(1 / 30)
}

function metricSnapshot(state: SimState): Map<string, string> {
  const result = new Map<string, string>()
  for (const doc of DOCS) {
    for (const metric of doc.metrics ?? []) {
      result.set(`${doc.id}::${metric.label}`, metric.get(state))
    }
  }
  return result
}

function readoutSnapshot(defs: readonly ComponentDef[], state: SimState): Map<string, string> {
  const result = new Map<string, string>()
  for (const def of defs) {
    if (def.readout) result.set(def.id, def.readout(state))
  }
  return result
}

function makeSnapshots(
  defs: readonly ComponentDef[],
  key?: keyof Knobs,
  value?: Knobs[keyof Knobs],
): Snapshots {
  const sim = createSim(createBus())
  if (key !== undefined) {
    sim.setKnob(key, value as never)
    if (key === 'sharedBuffers') {
      sim.setKnob('tps', 800)
      sim.setKnob('writeRatio', 0.5)
      sim.setKnob('bgwriterEnabled', false)
    }
  }
  step(sim)
  return {
    state: sim.state,
    metrics: metricSnapshot(sim.state),
    readouts: readoutSnapshot(defs, sim.state),
  }
}

type Sim = ReturnType<typeof createSim>

interface ResponseContract {
  target: Knobs[keyof Knobs]
  measure(value: never): unknown
}

function advance(sim: Sim, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 15, target - sim.state.t))
}

function advanceUntil(sim: Sim, done: () => boolean, limit = 360): void {
  const deadline = sim.state.t + limit
  while (!done() && sim.state.t < deadline) sim.update(1 / 15)
  if (!done()) throw new Error(`condition was not reached within ${limit}s`)
}

function setWorkload(sim: Sim, tps = 2_000): void {
  sim.setKnob('tps', tps)
  sim.setKnob('writeRatio', 1)
  sim.setKnob('synchronousCommit', 'local')
}

function takeBackup(sim: Sim): void {
  if (!sim.startBaseBackup()) throw new Error('base backup did not start')
  advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'idle')
}

function failedOver(value: boolean, key: 'walLogHints' | 'oldPrimaryDataIntact' | 'rewindWalRetained'): Sim {
  const sim = createSim(createBus())
  sim.setKnob('standbyBEnabled', false)
  setWorkload(sim)
  if (key === 'walLogHints') sim.setKnob(key, value)
  sim.setKnob('standbyANetworkLag', 400)
  advance(sim, 35)
  if (!sim.startFailover('standbyA')) throw new Error('failover did not start')
  advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete', 60)
  if (key !== 'walLogHints') sim.setKnob(key, value)
  return sim
}

const RESPONSE_CONTRACTS = {
  tps: {
    target: 5_000,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('tps', value)
      advance(sim, 20)
      return sim.state.stats.commits
    },
  },
  writeRatio: {
    target: 1,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1_000)
      sim.setKnob('writeRatio', value)
      advance(sim, 20)
      return sim.state.wal.insertLsn
    },
  },
  updateRatio: {
    target: 1,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 1_000)
      sim.setKnob('updateRatio', value)
      advance(sim, 20)
      return sim.state.stats.tupUpdated + sim.state.stats.tupDeleted
    },
  },
  seqScanRatio: {
    target: 1,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1_000)
      sim.setKnob('writeRatio', 0)
      sim.setKnob('seqScanRatio', value)
      advance(sim, 20)
      return sim.state.tables.reduce((total, table) => total + table.seqScans, 0)
    },
  },
  sharedBuffers: {
    target: 64 * 1_024,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('sharedBuffers', value)
      return sim.state.buffers.sampleFrames
    },
  },
  checkpointTimeout: {
    target: 15,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('maxWalSize', 2_048)
      sim.setKnob('checkpointTimeout', value)
      advance(sim, 40)
      return sim.state.checkpoint.count
    },
  },
  checkpointCompletionTarget: {
    target: 0.1,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 5_000)
      sim.setKnob('checkpointTimeout', 15)
      sim.setKnob('maxWalSize', 2_048)
      sim.setKnob('checkpointCompletionTarget', value)
      advanceUntil(sim, () => sim.state.checkpoint.phase === 'writing', 25)
      // Isolate the pacing knob after the write set has been captured.
      sim.setKnob('tps', 1)
      advance(sim, 6)
      return sim.state.checkpoint.buffersWritten
    },
  },
  maxWalSize: {
    target: 2_048,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 5_000)
      sim.setKnob('checkpointTimeout', 600)
      sim.setKnob('maxWalSize', value)
      advance(sim, 300)
      return sim.state.checkpoint.count
    },
  },
  bgwriterEnabled: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('bgwriterEnabled', value)
      return sim.state.bgwriter.enabled
    },
  },
  bgwriterLruMaxpages: {
    target: 0,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 5_000)
      sim.setKnob('sharedBuffers', 128)
      sim.setKnob('bgwriterLruMaxpages', value)
      advance(sim, 30)
      return sim.state.bgwriter.cleanedTotal
    },
  },
  synchronousCommit: {
    target: 'off',
    measure(value: Knobs['synchronousCommit']) {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1_000)
      sim.setKnob('writeRatio', 1)
      sim.setKnob('standbyANetworkLag', 400)
      sim.setKnob('synchronousCommit', value)
      advance(sim, 20)
      return sim.state.stats.commits
    },
  },
  synchronousStandbyNames: {
    target: 'none',
    measure(value: Knobs['synchronousStandbyNames']) {
      const sim = createSim(createBus())
      sim.setKnob('synchronousStandbyNames', value)
      advance(sim, 1)
      return sim.state.replication.standbys.map((standby) => standby.mode).join('/')
    },
  },
  walLevel: {
    target: 'minimal',
    measure(value: Knobs['walLevel']) {
      const sim = createSim(createBus())
      sim.setKnob('walLevel', value)
      advance(sim, 1)
      return sim.state.replication.standbys.map((standby) => standby.connected)
    },
  },
  fullPageWrites: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      setWorkload(sim, 2_000)
      sim.setKnob('fullPageWrites', value)
      advance(sim, 30)
      return sim.state.wal.insertLsn
    },
  },
  autovacuum: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('autovacuum', value)
      return sim.state.autovac.enabled
    },
  },
  autovacuumScaleFactor: {
    target: 0.5,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('autovacuumScaleFactor', value)
      advance(sim, 1)
      return sim.state.tables.map((table) => table.vacuumThreshold)
    },
  },
  longRunningXact: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('longRunningXact', value)
      advance(sim, 12)
      return sim.state.oldestSnapshotAge
    },
  },
  lockContention: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1_000)
      sim.setKnob('lockContention', value)
      advance(sim, 12)
      return sim.state.locks.length
    },
  },
  standbyAEnabled: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('standbyAEnabled', value)
      advance(sim, 1)
      return sim.state.replication.standbys[0].connected
    },
  },
  standbyANetworkLag: {
    target: 400,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('standbyANetworkLag', value)
      advance(sim, 1)
      return sim.state.replication.standbys[0].networkLagMs
    },
  },
  standbyASlowApply: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      setWorkload(sim)
      sim.setKnob('standbyASlowApply', value)
      advance(sim, 35)
      return sim.state.replication.standbys[0].lagBytes
    },
  },
  standbyBEnabled: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('standbyBEnabled', value)
      advance(sim, 1)
      return sim.state.replication.standbys[1].connected
    },
  },
  standbyBNetworkLag: {
    target: 400,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('standbyBNetworkLag', value)
      advance(sim, 1)
      return sim.state.replication.standbys[1].networkLagMs
    },
  },
  standbyBSlowApply: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      setWorkload(sim)
      sim.setKnob('standbyBSlowApply', value)
      advance(sim, 35)
      return sim.state.replication.standbys[1].lagBytes
    },
  },
  standbyALongQuery: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('standbyALongQuery', value)
      advance(sim, 12)
      return sim.state.oldestSnapshotAge
    },
  },
  standbyBLongQuery: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('standbyBLongQuery', value)
      advance(sim, 12)
      return sim.state.oldestSnapshotAge
    },
  },
  walGArchiveCredentialsValid: {
    target: false,
    measure(value: boolean) {
      const sim = createSim(createBus())
      setWorkload(sim, 5_000)
      sim.setKnob('walGArchiveCredentialsValid', value)
      advance(sim, 60)
      return sim.state.disasterRecovery.archive.failedAttempts
    },
  },
  walGDownloadConcurrency: {
    target: 1,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 1_600)
      takeBackup(sim)
      advance(sim, 24)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      sim.setKnob('walGDownloadConcurrency', value)
      if (!sim.startPointInTimeRestore(2)) throw new Error('point-in-time restore did not start')
      advance(sim, 1)
      return sim.state.disasterRecovery.restore.backupBytesFetched
    },
  },
  backupRetention: {
    target: 1,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('backupRetention', value)
      takeBackup(sim)
      advance(sim, 8)
      takeBackup(sim)
      return sim.state.disasterRecovery.backups.length
    },
  },
  recoveryTargetAge: {
    target: 300,
    measure(value: number) {
      const sim = createSim(createBus())
      setWorkload(sim, 1_600)
      takeBackup(sim)
      advance(sim, 60)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      sim.setKnob('recoveryTargetAge', value)
      return sim.startPointInTimeRestore()
    },
  },
  restoreDrillFault: {
    target: 'corrupt_object',
    measure(value: Knobs['restoreDrillFault']) {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('restoreDrillFault', value)
      takeBackup(sim)
      const backup = sim.state.disasterRecovery.backups[0]
      return backup.objectDigest === backup.manifestDigest
    },
  },
  haPartition: {
    target: 'isolate_node',
    measure(value: Knobs['haPartition']) {
      const sim = createSim(createBus())
      sim.setKnob('haPartition', value)
      return sim.state.highAvailability.patroni.agents.map((agent) => agent.reachableDcsMembers)
    },
  },
  walLogHints: {
    target: false,
    measure(value: boolean) {
      return failedOver(value, 'walLogHints').state.highAvailability.rejoin.blockChangeTrackingAvailable
    },
  },
  oldPrimaryDataIntact: {
    target: false,
    measure(value: boolean) {
      const sim = failedOver(value, 'oldPrimaryDataIntact')
      if (!sim.startPgRewind()) throw new Error('pg_rewind did not start')
      advanceUntil(sim, () => ['complete', 'failed'].includes(sim.state.highAvailability.rejoin.status))
      return sim.state.highAvailability.rejoin.status
    },
  },
  rewindWalRetained: {
    target: false,
    measure(value: boolean) {
      const sim = failedOver(value, 'rewindWalRetained')
      if (!sim.startPgRewind()) throw new Error('pg_rewind did not start')
      advanceUntil(sim, () => ['complete', 'failed'].includes(sim.state.highAvailability.rejoin.status))
      return sim.state.highAvailability.rejoin.status
    },
  },
  timeScale: {
    target: 5,
    measure(value: number) {
      const sim = createSim(createBus())
      sim.setKnob('timeScale', value)
      sim.update(0.5)
      return sim.state.realT
    },
  },
  paused: {
    target: true,
    measure(value: boolean) {
      const sim = createSim(createBus())
      sim.setKnob('paused', value)
      sim.update(0.5)
      return sim.state.t
    },
  },
} satisfies Record<keyof Knobs, ResponseContract>

describe('knob-response contract', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const defs: ComponentDef[] = []
  const modules: WorldModule[] = []
  const snapshots = new Map<string, Snapshots>()

  beforeAll(() => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          if (tag !== 'canvas') throw new Error(`unexpected headless element: ${tag}`)
          return fakeCanvas()
        },
        documentElement: { dataset: {}, style: {} },
      },
    })

    const theme = createTheme()
    const ctx: WorldContext = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus: createBus(),
      sim: createSim(createBus()).state,
      quality: {
        level: 'low',
        pixelRatio: 1,
        bloom: false,
        shadows: false,
        maxParticles: 64,
        maxLabels: 32,
        antialias: false,
      } satisfies QualitySettings,
      theme,
      register: (def) => defs.push(def),
      flow: () => undefined,
    }

    const factories = [
      createGround,
      createShmem,
      createClients,
      createBackends,
      createWal,
      createStorage,
      createMaintenance,
      createReplication,
      createPlanner,
      createContinuity,
    ]
    for (const factory of factories) modules.push(factory(ctx))
    modules.push({ id: 'test-theme', group: new THREE.Group(), update: () => undefined, dispose: () => theme.dispose() })

    snapshots.set('sharedBuffers:base', makeSnapshots(defs, 'sharedBuffers', 128))
    snapshots.set('sharedBuffers:target', makeSnapshots(defs, 'sharedBuffers', 1024))
    snapshots.set('hard:standbyAEnabled', makeSnapshots(defs, 'standbyAEnabled', false))
    snapshots.set('hard:walLevel', makeSnapshots(defs, 'walLevel', 'minimal'))
  }, 30_000)

  afterAll(() => {
    for (const module of modules) module.dispose?.()
    globalThis.DOMParser = nativeDomParser
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  it('makes every knob change a declared model output', () => {
    expect(new Set(KNOB_META.map((meta) => meta.key))).toEqual(new Set(Object.keys(DEFAULT_KNOBS)))
    for (const key of Object.keys(DEFAULT_KNOBS) as (keyof Knobs)[]) {
      const contract = RESPONSE_CONTRACTS[key]
      const before = contract.measure(DEFAULT_KNOBS[key] as never)
      const after = contract.measure(contract.target as never)
      expect(after, `${key} did not change its declared model output`).not.toEqual(before)
    }
  }, 30_000)

  it('enforces every declared shared_buffers response', () => {
    const base = snapshots.get('sharedBuffers:base')!
    const target = snapshots.get('sharedBuffers:target')!

    for (const [key, before] of base.metrics) {
      const contract = metricContract(key)
      const after = target.metrics.get(key)
      expect(after, `${key} has no target snapshot`).toBeTypeOf('string')
      if (contract === 'moves-with: sharedBuffers') {
        expect(after, `${key} must move with sharedBuffers`).not.toBe(before)
      } else if (contract === 'invariant-under: sharedBuffers') {
        expect(after, `${key} must be invariant under sharedBuffers`).toBe(before)
      }
    }

    for (const [key, before] of base.readouts) {
      const contract = readoutContract(key)
      const after = target.readouts.get(key)
      expect(after, `${key} has no target snapshot`).toBeTypeOf('string')
      if (contract === 'moves-with: sharedBuffers') {
        expect(after, `${key} must move with sharedBuffers`).not.toBe(before)
      }
    }
  })

  it('requires every pool-size metric to move when shared_buffers moves 8x', () => {
    const base = snapshots.get('sharedBuffers:base')!
    const target = snapshots.get('sharedBuffers:target')!
    let inspected = 0
    for (const [key, before] of base.metrics) {
      const label = key.slice(key.indexOf('::') + 2)
      if (!/\bpool\b/i.test(label) && label !== 'shared_buffers') continue
      inspected++
      expect(metricContract(key), `${key} needs a moves-with declaration`).toBe('moves-with: sharedBuffers')
      expect(target.metrics.get(key), `${key} must move with sharedBuffers`).not.toBe(before)
    }
    expect(inspected).toBeGreaterThan(0)
  })

  it('exercises real sample travel across the 8x pool step', () => {
    const base = snapshots.get('sharedBuffers:base')!.state
    const target = snapshots.get('sharedBuffers:target')!.state

    expect(base.buffers.sampleFrames).toBeLessThan(target.buffers.sampleFrames)
    expect(target.buffers.sampleFrames).toBeLessThan(N_BUFFERS)
    expect(base.buffers.usedCount).not.toBe(target.buffers.usedCount)
    expect(base.buffers.dirtyCount).not.toBe(target.buffers.dirtyCount)
  })

  it('does not advertise standby reads when replication is unavailable', () => {
    const disabled = snapshots.get('hard:standbyAEnabled')!
    const minimal = snapshots.get('hard:walLevel')!

    expect(disabled.state.replication.standbys[0].connected).toBe(false)
    expect(disabled.readouts.get('replica.client')).toBe('no standby — reads unavailable')
    expect(minimal.state.knobs.walLevel).toBe('minimal')
    expect(minimal.state.replication.standbys[0].connected).toBe(false)
    expect(minimal.readouts.get('replica.client')).toBe('no standby — reads unavailable')
  })
})
