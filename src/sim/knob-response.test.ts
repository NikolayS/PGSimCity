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
  'shared.buffers::Pool size',
  'os.cache::shared_buffers',
])

const METRIC_INVARIANTS = new Set([
  'shmem.deck::WAL buffers',
  'shmem.deck::Lock waits',
])

const READOUT_MOVES = new Set([
  'shmem.deck',
  'shared.buffers',
])

export const VACUOUS_SHARED_BUFFER_ASSERTIONS: readonly string[] = []

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

function hardValue(key: keyof Knobs): Knobs[keyof Knobs] {
  const meta = KNOB_META.find((candidate) => candidate.key === key)
  if (!meta) throw new Error(`missing knob metadata for ${key}`)
  const current = DEFAULT_KNOBS[key]
  if (meta.kind === 'toggle') return !current
  if (meta.kind === 'select') {
    const option = meta.options?.find((candidate) => candidate.value !== current)
    if (!option) throw new Error(`no alternate option for ${key}`)
    return option.value as Knobs[keyof Knobs]
  }
  if (meta.max !== undefined && meta.max !== current) return meta.max
  if (meta.min !== undefined) return meta.min
  throw new Error(`no hard step for ${key}`)
}

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
    for (const key of Object.keys(DEFAULT_KNOBS) as (keyof Knobs)[]) {
      snapshots.set(`hard:${key}`, makeSnapshots(defs, key, hardValue(key)))
    }
  }, 30_000)

  afterAll(() => {
    for (const module of modules) module.dispose?.()
    globalThis.DOMParser = nativeDomParser
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  it('hard-steps every knob and snapshots every metric and readout', () => {
    expect(new Set(KNOB_META.map((meta) => meta.key))).toEqual(new Set(Object.keys(DEFAULT_KNOBS)))
    for (const key of Object.keys(DEFAULT_KNOBS) as (keyof Knobs)[]) {
      const snapshot = snapshots.get(`hard:${key}`)
      expect(snapshot, `${key} was not stepped`).toBeDefined()
      expect(snapshot!.metrics.size).toBeGreaterThan(200)
      expect(snapshot!.readouts.size).toBeGreaterThan(100)
      expect([...snapshot!.metrics.values()].every((value) => typeof value === 'string')).toBe(true)
      expect([...snapshot!.readouts.values()].every((value) => typeof value === 'string')).toBe(true)
    }
  })

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
    for (const [key, before] of base.metrics) {
      const label = key.slice(key.indexOf('::') + 2)
      if (!/\bpool\b/i.test(label) && label !== 'shared_buffers') continue
      expect(metricContract(key), `${key} needs a moves-with declaration`).toBe('moves-with: sharedBuffers')
      expect(target.metrics.get(key), `${key} must move with sharedBuffers`).not.toBe(before)
    }
  })

  it('exercises real sample travel across the 8x pool step', () => {
    const base = snapshots.get('sharedBuffers:base')!.state
    const target = snapshots.get('sharedBuffers:target')!.state

    expect(base.buffers.sampleFrames).toBeLessThan(target.buffers.sampleFrames)
    expect(target.buffers.sampleFrames).toBeLessThan(N_BUFFERS)
    expect(base.buffers.usedCount).not.toBe(target.buffers.usedCount)
    expect(base.buffers.dirtyCount).not.toBe(target.buffers.dirtyCount)
    expect(VACUOUS_SHARED_BUFFER_ASSERTIONS).toEqual([])
  })
})
