import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef, WorldContext } from '../core/types'
import { createSim } from '../sim/model'
import { DOCS_STORAGE } from '../ui/docs-storage'
import { installTestDom } from '../../test/dom'
import { createStorage } from './storage'

const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

describe('heap geometry claims', () => {
  it('describes the file-length encoding used for page count', () => {
    installTestDom({ canvas2d: true })
    const bus = createBus()
    const sim = createSim(bus, { scheduledBackups: false })
    const theme = createTheme()
    const components = new Map<string, ComponentDef>()
    const ctx: WorldContext = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
      quality: {
        level: 'low', pixelRatio: 1, bloom: false, shadows: false,
        maxParticles: 1, maxLabels: 1, antialias: false,
      },
      register: (component) => components.set(component.id, component),
      flow: () => undefined,
      theme,
    }
    const module = createStorage(ctx)
    disposers.push(() => {
      module.dispose?.()
      theme.dispose()
    })

    const table = components.get('storage.table.accounts')?.object
    const shell = table?.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh)
    expect(shell).toBeDefined()
    sim.state.tables[0].pages = 1024
    module.update(1, sim.state, 1)
    const shortHeight = shell!.scale.y
    const shortLength = shell!.scale.z
    sim.state.tables[0].pages = 100_000
    module.update(1, sim.state, 2)

    expect(shell!.scale.y).toBe(shortHeight)
    expect(shell!.scale.z).toBeGreaterThan(shortLength)

    const doc = DOCS_STORAGE.find((entry) => entry.id === 'storage.table')
    const claim = doc?.sections.find((section) => section.heading === 'In the real thing')?.body ?? ''
    expect(claim).toContain('footprint length is its page count')
    expect(claim).not.toContain('height is its page count')
  })
})
