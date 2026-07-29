import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { knobMeta } from '../src/ui/content'
import { createKnobControl } from '../src/ui/controls'
import { createWorldHandleUi } from '../src/ui/world-handles'
import type { WorldHandleBinding } from '../src/world/handles'
import type { WalkController } from '../src/engine/walk'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { all: () => [], get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

function binding(
  key: WorldHandleBinding['key'],
  x: number,
  z: number,
): WorldHandleBinding {
  return {
    id: `handle.${key}`,
    key,
    guc: key,
    owner: 'test owner',
    x,
    z,
  }
}

function walk(position: THREE.Vector3): WalkController {
  return {
    enabled: true,
    position,
  } as unknown as WalkController
}

function keyDown(code: string): Event {
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: false },
    ctrlKey: { value: false },
    metaKey: { value: false },
    altKey: { value: false },
  })
  return event
}

describe('walk-up world handles', () => {
  it('reveals only the nearest handle inside its operating radius', () => {
    installTestDom()
    const ctx = context()
    const position = new THREE.Vector3(30, 0, 30)
    const ui = createWorldHandleUi({
      ctx,
      walk: walk(position),
      handles: [
        binding('autovacuum', 0, 0),
        binding('bgwriterEnabled', 5, 0),
      ],
    })
    const root = document.querySelector<HTMLElement>('.world-handle-prompt')!

    ui.update(0)
    expect(root.hidden).toBe(true)

    position.set(4, 0, 0)
    ui.update(0)
    expect(root.hidden).toBe(false)
    expect(root.textContent).toContain('bgwriterEnabled')
    expect(root.textContent).toContain('ON')

    ui.dispose()
  })

  it('uses E and the touch-sized button to change the same knob as the rail', () => {
    installTestDom()
    const ctx = context()
    const handle = binding('autovacuum', 0, 0)
    const ui = createWorldHandleUi({
      ctx,
      walk: walk(new THREE.Vector3(1, 0, 0)),
      handles: [handle],
    })
    const rail = createKnobControl(ctx, knobMeta('autovacuum')!)
    const setKnob = vi.spyOn(ctx.sim, 'setKnob')

    ui.update(0)
    const button = document.querySelector<HTMLButtonElement>('.world-handle-prompt__action')!
    expect(button.getAttribute('aria-label')).toContain('Turn autovacuum off')

    const keyboard = keyDown('KeyE')
    window.dispatchEvent(keyboard)
    expect(keyboard.defaultPrevented).toBe(true)
    expect(setKnob).toHaveBeenLastCalledWith('autovacuum', false, 'user')
    expect(ctx.sim.state.knobs.autovacuum).toBe(false)

    rail.sync(true)
    const railInput = rail.root.querySelector('input') as HTMLInputElement
    expect(railInput.checked).toBe(false)

    ui.update(0)
    expect(button.textContent).toContain('OFF')
    expect(button.getAttribute('aria-label')).toContain('Turn autovacuum on')
    button.click()
    expect(setKnob).toHaveBeenLastCalledWith('autovacuum', true, 'user')
    expect(ctx.sim.state.knobs.autovacuum).toBe(true)

    rail.dispose()
    ui.dispose()
  })

  it('does not operate a handle outside walk mode or through key repeat', () => {
    installTestDom()
    const ctx = context()
    const position = new THREE.Vector3(0, 0, 0)
    const walker = walk(position)
    const ui = createWorldHandleUi({
      ctx,
      walk: walker,
      handles: [binding('fullPageWrites', 0, 0)],
    })
    ui.update(0)

    Object.defineProperty(walker, 'enabled', { value: false })
    const event = keyDown('KeyE')
    window.dispatchEvent(event)
    expect(ctx.sim.state.knobs.fullPageWrites).toBe(true)

    ui.dispose()
  })
})
