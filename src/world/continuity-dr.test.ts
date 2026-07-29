import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef, FlowRequest, QualitySettings, WorldContext } from '../core/types'
import { createSim } from '../sim/model'
import { createContinuity } from './continuity'

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

describe('continuity DR-only projection', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

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
  })

  afterAll(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  it('registers DR mechanisms and emits no Patroni, failover, or second-standby traffic', () => {
    const bus = createBus()
    const sim = createSim(bus)
    const theme = createTheme()
    const defs: ComponentDef[] = []
    const flows: FlowRequest[] = []
    const ctx: WorldContext = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
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
      flow: (request) => flows.push(request),
    }
    const continuity = createContinuity(ctx)

    expect(defs.map((def) => def.id)).toEqual([
      'archive.gate',
      'timeline.yard',
      'object.store',
      'backup.vault',
      'backup.host',
      'recovery.ground',
      'recovery.clock',
      'restore.winch',
      'recovery.replay',
      'ha.endpoint',
      'ha.dcs',
      'ha.rejoin',
      'standby.b',
    ])
    expect(
      defs
        .filter((def) => def.id.startsWith('ha.') || def.id === 'standby.b')
        .every((def) => def.readout === undefined),
    ).toBe(true)

    sim.startBaseBackup()
    for (let i = 0; i < 900; i++) {
      sim.update(1 / 30)
      continuity.update(1 / 30, sim.state, sim.state.t)
    }

    expect(flows.some((flow) => flow.route === 'backup.take')).toBe(true)
    expect(flows.some((flow) => flow.route === 'backup.store')).toBe(true)
    expect(
      flows.some((flow) =>
        flow.route.startsWith('ha.')
        || flow.route === 'net.streamB'
        || flow.route === 'net.ackB'
        || flow.route === 'replicaB.apply'),
    ).toBe(false)

    continuity.dispose?.()
    theme.dispose()
  })
})
