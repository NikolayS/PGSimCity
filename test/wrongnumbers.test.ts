import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createTheme } from '../src/core/theme'
import type { ComponentDef, SimState, WorldContext, WorldFactory, WorldModule } from '../src/core/types'
import { createSim, walTriggerBytes } from '../src/sim/model'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'
import { createBackends } from '../src/world/backends'
import { createMaintenance } from '../src/world/maintenance'
import { installTestDom } from './dom'

const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function installCanvasDom(): void {
  const dom = installTestDom()
  const originalCreate = dom.document.createElement.bind(dom.document)
  const gradient = { addColorStop() {} }
  const canvasContext = new Proxy(
    {
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as Record<PropertyKey, unknown>,
    {
      get(target, key) {
        return target[key] ?? (() => undefined)
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    },
  )

  Object.defineProperty(dom.document, 'createElement', {
    configurable: true,
    value(tag: string) {
      const element = originalCreate(tag)
      if (tag.toLowerCase() === 'canvas') {
        Object.defineProperty(element, 'getContext', {
          configurable: true,
          value: () => canvasContext,
        })
      }
      return element
    },
  })
}

function registerWorld(
  factory: WorldFactory,
  state: SimState,
): { components: Map<string, ComponentDef>; module: WorldModule } {
  installCanvasDom()
  const theme = createTheme()
  const components = new Map<string, ComponentDef>()
  const ctx: WorldContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    bus: createBus(),
    sim: state,
    quality: {
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    },
    register: (component) => components.set(component.id, component),
    flow: () => undefined,
    theme,
  }
  const module = factory(ctx)
  disposers.push(() => {
    module.dispose?.()
    theme.dispose()
  })
  return { components, module }
}

function docById(id: string) {
  const doc = [...DOCS_MEMORY, ...DOCS_STORAGE].find((entry) => entry.id === id)
  expect(doc, `missing documentation for ${id}`).toBeDefined()
  return doc!
}

function metricValue(id: string, label: string, state: SimState): string {
  const metric = docById(id).metrics?.find((entry) => entry.label === label)
  expect(metric, `missing ${label} metric for ${id}`).toBeDefined()
  return metric!.get(state)
}

describe('readouts agree with their panels', () => {
  it('uses walTriggerBytes in the idle checkpointer race display', () => {
    const sim = createSim(createBus())
    const state = sim.state
    const { components } = registerWorld(createMaintenance, state)
    const trigger = walTriggerBytes(state.knobs)
    state.wal.insertLsn = state.checkpoint.redoLsn + trigger * 0.8
    state.checkpoint.phase = 'idle'
    state.checkpoint.nextInSec = state.knobs.checkpointTimeout * 0.4

    expect(components.get('checkpointer')!.readout!(state)).toContain('(max_wal_size 80%)')
  })

  it('reports the configured pool rather than the visualization sample as pool size', () => {
    const sim = createSim(createBus())
    sim.setKnob('sharedBuffers', 2048)

    expect(metricValue('shared.buffers', 'Pool size', sim.state)).toBe('2.0 GiB (262,144 pages)')
  })

  it('names occupied backend slots without calling idle connections busy', () => {
    const sim = createSim(createBus())
    const state = sim.state
    for (let i = 0; i < state.backends.length; i++) {
      state.backends[i].active = i < 10
      state.backends[i].state = i < 3 ? 'exec_cpu' : 'idle'
    }
    state.stats.activeBackends = 10
    const { components } = registerWorld(createBackends, state)

    expect(components.get('backend.row')!.readout!(state)).toContain('10 of 16 slots occupied')
    expect(metricValue('backend.row', 'Active', state)).toBe('3 running')
    expect(metricValue('backend.row', 'Idle', state)).toBe('7')
  })

  it('discloses the compressed checkpoint_timeout clock', () => {
    const section = docById('checkpointer').sections.find(
      (entry) => entry.heading === 'Time-triggered or WAL-triggered',
    )

    expect(section?.body).toContain(
      "PGSimCity uses 60 seconds instead of PostgreSQL's 5-minute default so the cycle is visible; only the checkpoint clock is compressed.",
    )
  })

  it('rebases the scenario countdown when checkpoint_timeout increases', () => {
    const sim = createSim(createBus())
    const oldTimeout = sim.state.knobs.checkpointTimeout
    const oldRemaining = sim.state.checkpoint.nextInSec
    const elapsed = oldTimeout - oldRemaining

    sim.runScenario('checkpoint-storm')

    expect(sim.state.checkpoint.nextInSec).toBeCloseTo(300 - elapsed, 6)
  })
})
