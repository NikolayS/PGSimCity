import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef, FlowRequest, QualitySettings, WorldContext } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createControlCenterWorld } from './control-center'

const QUALITY: QualitySettings = {
  level: 'high',
  pixelRatio: 1,
  bloom: true,
  shadows: true,
  maxParticles: 2400,
  maxLabels: 90,
  antialias: true,
}

describe('postmaster entrance geometry', () => {
  it('opens paired leaves outward and keeps the threshold fixed', () => {
    installTestDom({ canvas2d: true })
    const bus = createBus()
    const sim = createSim(bus)
    const theme = createTheme()
    const context: WorldContext = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
      quality: QUALITY,
      theme,
      register: (_def: ComponentDef) => {},
      flow: (_req: FlowRequest) => {},
    }
    const module = createControlCenterWorld(context)
    const left = module.group.getObjectByName('control-center:door-left')!
    const right = module.group.getObjectByName('control-center:door-right')!
    const threshold = module.group.getObjectByName('control-center:door-threshold')!
    const reveal = module.group.getObjectByName('control-center:door-reveal') as THREE.Mesh

    expect(left).toBeInstanceOf(THREE.Group)
    expect(right).toBeInstanceOf(THREE.Group)
    expect(threshold).toBeInstanceOf(THREE.Object3D)
    expect((reveal.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x000000)
    expect(reveal.position.z).toBeGreaterThan(12.5)
    expect(left.rotation.y).toBeCloseTo(0, 8)
    expect(right.rotation.y).toBeCloseTo(0, 8)

    module.door.setOpenness(0.5)
    expect(left.rotation.y).toBeLessThan(-0.5)
    expect(right.rotation.y).toBeGreaterThan(0.5)
    expect(threshold.rotation.y).toBe(0)

    module.door.setOpenness(1)
    expect(left.rotation.y).toBeLessThan(-Math.PI / 2)
    expect(right.rotation.y).toBeGreaterThan(Math.PI / 2)

    module.dispose?.()
    theme.dispose()
  })
})
