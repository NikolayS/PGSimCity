import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import { setThemeMode, storedThemeMode, themeMode } from '../src/core/theme'
import {
  DEFAULT_KNOBS,
  SHARED_BUFFERS_MAX_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../src/core/types'
import { createSim } from '../src/sim/model'
import { knobMeta } from '../src/ui/content'
import { createKnobControl } from '../src/ui/controls'
import { createHud } from '../src/ui/hud'
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

describe('theme toggle entry point', () => {
  beforeEach(() => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
    setThemeMode('night', { persist: false })
  })

  it('changes and persists the visible HUD theme control', () => {
    const hud = createHud(context())
    const button = document.querySelector('#hud-top .hud-theme') as HTMLButtonElement | null

    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('Night')
    expect(button!.title).toContain('(N)')
    expect(themeMode()).toBe('night')

    button!.dispatchEvent(new Event('click'))

    expect(themeMode()).toBe('day')
    expect(document.documentElement.dataset.theme).toBe('day')
    expect(storedThemeMode()).toBe('day')
    expect(button!.textContent).toContain('Day')
    hud.dispose()
  })

  it('exposes working touch routes for labels and camera presets', () => {
    const ctx = context()
    const labels = vi.fn()
    const presets = vi.fn()
    const focuses = vi.fn()
    ;(ctx.bus as unknown as { on(type: string, fn: (payload: unknown) => void): () => void }).on(
      'ui:labels',
      labels,
    )
    ;(ctx.bus as unknown as { on(type: string, fn: (payload: unknown) => void): () => void }).on(
      'ui:camera-preset',
      presets,
    )
    ctx.bus.on('focus', focuses)

    const hud = createHud(ctx)
    const view = document.querySelector('.hud-view-toggle') as HTMLButtonElement | null
    expect(view).not.toBeNull()
    view!.dispatchEvent(new Event('click'))

    const panel = document.querySelector('.hud-view-panel') as HTMLElement | null
    expect(panel).not.toBeNull()
    expect(panel!.hidden).toBe(false)

    const labelToggle = document.querySelector('[data-view-action="labels"]') as HTMLButtonElement | null
    const home = document.querySelector('[data-view-action="home"]') as HTMLButtonElement | null
    const overview = document.querySelector('[data-view-action="overview"]') as HTMLButtonElement | null
    expect(labelToggle).not.toBeNull()
    expect(home).not.toBeNull()
    expect(overview).not.toBeNull()

    labelToggle!.dispatchEvent(new Event('click'))
    expect(document.body.classList.contains('pg-labels-off')).toBe(true)
    expect(labels).toHaveBeenCalledWith({ on: false })

    home!.dispatchEvent(new Event('click'))
    expect(focuses).toHaveBeenCalledWith({ id: 'world.ground' })

    overview!.dispatchEvent(new Event('click'))
    expect(presets).toHaveBeenCalledWith({ preset: 'plan' })
    hud.dispose()
  })

  it('exposes every hidden-phone district destination as a button', () => {
    const ctx = context()
    const focuses: string[] = []
    ctx.bus.on('focus', ({ id }) => {
      if (id) focuses.push(id)
    })
    const hud = createHud(ctx)
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-view-district]'),
    )

    expect(buttons).toHaveLength(8)
    for (const button of buttons) button.dispatchEvent(new Event('click'))
    expect(focuses).toEqual([
      'client.pool',
      'backend.row',
      'shared.buffers',
      'wal.vault',
      'storage.datadir',
      'checkpointer',
      'autovac.launcher',
      'replica.standby',
    ])
    hud.dispose()
  })
})
