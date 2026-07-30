import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import { createTheme } from '../src/core/theme'
import type { ComponentDef, FlowRequest, QualitySettings, WorldContext } from '../src/core/types'
import { createSim } from '../src/sim/model'
import { knobMeta } from '../src/ui/content'
import { createKnobControl } from '../src/ui/controls'
import { createWorldHandleSites } from '../src/ui/world-handles'
import type { UiContext } from '../src/ui/uikit'
import { createWorldHandles } from '../src/world/handles'
import { installTestDom } from './dom'

const QUALITY: QualitySettings = {
  level: 'high',
  pixelRatio: 1,
  bloom: true,
  shadows: true,
  maxParticles: 2400,
  maxLabels: 90,
  antialias: true,
}

function harness(): {
  world: WorldContext
  ui: UiContext
  theme: ReturnType<typeof createTheme>
} {
  installTestDom({ canvas2d: true })
  const bus = createBus()
  const sim = createSim(bus)
  const theme = createTheme()
  const registry = {
    all: () => [],
    get: () => undefined,
    register: (_def: ComponentDef) => {},
  }
  return {
    world: {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
      quality: QUALITY,
      theme,
      register: registry.register,
      flow: (_req: FlowRequest) => {},
    },
    ui: {
      bus,
      sim,
      registry: registry as unknown as UiContext['registry'],
      getFps: () => 60,
      getQuality: () => QUALITY,
      getFlowStats: () => ({ active: 0, dropped: 0 }),
    },
    theme,
  }
}

describe('autovacuum world handle', () => {
  it('is the only handle built in this pass and publishes one walk-up binding', () => {
    const h = harness()
    const module = createWorldHandles(h.world)

    expect(module.handles).toHaveLength(1)
    expect(module.handles[0]).toMatchObject({
      id: 'handle.autovacuum',
      key: 'autovacuum',
      guc: 'autovacuum',
      owner: 'autovacuum launcher',
    })
    expect(module.group.getObjectByName('handle.bgwriter')).toBeUndefined()
    expect(module.group.getObjectByName('handle.full-page-writes')).toBeUndefined()
    expect(module.group.userData.collisionBoxes).toHaveLength(1)

    module.dispose?.()
    h.theme.dispose()
  })

  it('reads as an autovacuum control from the plaza approach', () => {
    const h = harness()
    const module = createWorldHandles(h.world)
    const root = module.group.getObjectByName('handle.autovacuum')!
    const bounds = new THREE.Box3().setFromObject(root)

    expect(bounds.max.y - bounds.min.y).toBeGreaterThan(12)
    expect(root.getObjectByName('handle.autovacuum.beacon')).toBeDefined()

    module.dispose?.()
    h.theme.dispose()
  })

  it('shows the same state as the knob in its lever and lamps', () => {
    const h = harness()
    const module = createWorldHandles(h.world)
    const lever = module.group.getObjectByName('handle.autovacuum.lever')!
    const onLamp = module.group.getObjectByName('handle.autovacuum.lamp.on')!
    const offLamp = module.group.getObjectByName('handle.autovacuum.lamp.off')!

    module.update(0, h.ui.sim.state, h.ui.sim.state.t)
    expect(lever.rotation.z).toBeLessThan(0)
    expect(onLamp.visible).toBe(true)
    expect(offLamp.visible).toBe(false)

    h.ui.sim.setKnob('autovacuum', false, 'user')
    module.update(0, h.ui.sim.state, h.ui.sim.state.t)
    expect(lever.rotation.z).toBeGreaterThan(0)
    expect(onLamp.visible).toBe(false)
    expect(offLamp.visible).toBe(true)

    module.dispose?.()
    h.theme.dispose()
  })

  it('binds the lever to the same user-setting path as the control rail', () => {
    const h = harness()
    const module = createWorldHandles(h.world)
    const [site] = createWorldHandleSites(h.ui, module.handles)
    const rail = createKnobControl(h.ui, knobMeta('autovacuum')!)
    const setKnob = vi.spyOn(h.ui.sim, 'setKnob')

    expect(site.state()).toBe('on')
    site.operate()
    expect(setKnob).toHaveBeenLastCalledWith('autovacuum', false, 'user')
    expect(site.state()).toBe('off')

    rail.sync(true)
    const railInput = rail.root.querySelector('input') as HTMLInputElement
    expect(railInput.checked).toBe(false)

    railInput.checked = true
    railInput.dispatchEvent(new Event('input'))
    expect(site.state()).toBe('on')

    rail.dispose()
    module.dispose?.()
    h.theme.dispose()
  })
})
