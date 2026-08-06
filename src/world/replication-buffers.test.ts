import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import { N_BUFFERS } from '../core/types'
import type { ComponentDef, WorldContext } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createReplication } from './replication'

const disposers: (() => void)[] = []

afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

describe('standby_a buffer geometry', () => {
  it('lights only frames that are valid in the standby buffer model', () => {
    installTestDom({ canvas2d: true })
    const bus = createBus()
    const sim = createSim(bus)
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
    const module = createReplication(ctx)
    disposers.push(() => {
      module.dispose?.()
      theme.dispose()
    })

    const pool = sim.state.cluster.nodes[1].buffers
    pool.valid.fill(0)
    pool.dirty.fill(0)
    module.update(1, sim.state, 1)

    const component = components.get('replica.buffers')
    const tiles = component?.object.children.find(
      (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh
        && child.count === N_BUFFERS,
    )
    expect(tiles).toBeDefined()
    const color = new THREE.Color()
    const emptyColors = new Set<number>()
    for (let index = 0; index < N_BUFFERS; index += 73) {
      tiles!.getColorAt(index, color)
      emptyColors.add(color.getHex())
    }
    expect(emptyColors.size).toBe(1)

    pool.valid[3] = 1
    pool.rel[3] = 1
    pool.lastTouch[3] = sim.state.t
    module.update(1, sim.state, 2)
    tiles!.getColorAt(3, color)
    expect(emptyColors.has(color.getHex())).toBe(false)
  })
})
