import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import {
  DEFAULT_KNOBS,
  SHARED_BUFFERS_MAX_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../src/core/types'
import { createSim } from '../src/sim/model'
import { knobMeta } from '../src/ui/content'
import { createKnobControl } from '../src/ui/controls'
import { createInspector } from '../src/ui/panel'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as UiContext['registry'],
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

describe('shared_buffers control', () => {
  beforeEach(() => {
    installTestDom()
  })

  it('uses the declared MiB range in the native slider', () => {
    const ctx = context()
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    expect(input.min).toBe(String(SHARED_BUFFERS_MIN_MIB))
    expect(input.max).toBe(String(SHARED_BUFFERS_MAX_MIB))
    expect(input.value).toBe(String(DEFAULT_KNOBS.sharedBuffers))
  })

  it('round-trips values across the entire declared range without model clamping', () => {
    const ctx = context()
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    for (const value of [128, 512, 1024, 2048, 8192, 32768, 65536]) {
      ctx.sim.setKnob('sharedBuffers', value)
      control.sync(true)
      expect(ctx.sim.state.knobs.sharedBuffers).toBe(value)
      expect(Number(input.value)).toBe(value)
      input.dispatchEvent(new Event('input'))
      expect(ctx.sim.state.knobs.sharedBuffers).toBe(value)
    }
  })

  it('does not change a 2 GiB setting when the untouched control is first activated', () => {
    const ctx = context()
    const setKnob = vi.spyOn(ctx.sim, 'setKnob')
    const control = createKnobControl(ctx, knobMeta('sharedBuffers')!)
    const input = control.root.querySelector('input[type="range"]') as unknown as HTMLInputElement

    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
    expect(setKnob).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('pointerdown'))
    window.dispatchEvent(new Event('pointerup'))
    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
    expect(setKnob).not.toHaveBeenCalled()

    input.dispatchEvent(new Event('input'))
    expect(ctx.sim.state.knobs.sharedBuffers).toBe(2048)
  })
})

describe('storage anatomy entry points', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('hud-right')
  })

  it('renders reachable page and directory actions in the data-directory inspector', () => {
    const ctx = context()
    const opened: { view: 'page' | 'directory'; id?: string }[] = []
    ctx.bus.on('anatomy:open', (event) => opened.push(event))
    createInspector(ctx)

    ctx.bus.emit('select', { id: 'storage.datadir' })
    const directory = document.querySelector('[data-anatomy-entry="directory"] button') as HTMLButtonElement | null
    const page = document.querySelector('[data-anatomy-entry="page"] button') as HTMLButtonElement | null
    expect(directory).not.toBeNull()
    expect(page).not.toBeNull()

    directory!.click()
    page!.click()
    expect(opened).toEqual([
      { view: 'directory', id: 'storage.datadir' },
      { view: 'page', id: 'storage.datadir' },
    ])
  })

  it.each([
    ['heap files', 'storage.table.accounts'],
    ['indexes', 'storage.index.accounts_pkey'],
    ['TOAST', 'storage.toast'],
  ])('offers and activates page anatomy from %s', (_label, id) => {
    const ctx = context()
    const opened = vi.fn()
    ctx.bus.on('anatomy:open', opened)
    createInspector(ctx)

    ctx.bus.emit('select', { id })
    const button = document.querySelector('[data-anatomy-entry="page"] button') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()
    expect(opened).toHaveBeenCalledWith({ view: 'page', id })
  })
})
