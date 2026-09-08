import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { FlowRequest, WorldFactory } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createBackends } from './backends'
import { createWal } from './wal'
import { createShmem } from './shmem'
import { createContinuity } from './continuity'

it.each<[string, WorldFactory]>([['backends', createBackends], ['WAL', createWal], ['shared memory', createShmem], ['standby B', createContinuity]])(
  '%s cannot generate transport from an unchanged model', (_name, factory) => {
    installTestDom({ canvas2d: true })
    const bus = createBus(), sim = createSim(bus), theme = createTheme(), flows: FlowRequest[] = []
    sim.setKnob('walLevel', 'logical')
    for (let i = 0; i < 300; i++) sim.update(1 / 30)
    sim.state.replication.standbys[1].replayPaused = true
    for (const backend of sim.state.backends) if (backend) backend.state = 'exec_io'
    const module = factory({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), bus, sim: sim.state, theme,
      quality: { level: 'low', pixelRatio: 1, bloom: false, shadows: false, maxParticles: 64, maxLabels: 1, antialias: false },
      register: () => {}, flow: (request) => flows.push(request) })
    try {
      module.update(0, sim.state, sim.state.t)
      flows.length = 0
      for (let i = 0; i < 90; i++) module.update(1 / 30, sim.state, sim.state.t + i / 30)
      expect(flows).toEqual([])
    } finally { module.dispose?.(); theme.dispose() }
  },
)
