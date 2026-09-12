import { beforeEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createInspector } from './panel'
import type { UiContext } from './uikit'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: {
      get: (id: string) => id === 'wal.vault'
        ? { id, name: 'pg_wal', role: 'write-ahead log', kind: 'storage', color: 0, object: {} }
        : undefined,
    } as unknown as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high', pixelRatio: 1, bloom: true, shadows: true,
      maxParticles: 100, maxLabels: 100, antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

describe('inspector navigation', () => {
  beforeEach(() => {
    const dom = installTestDom()
    dom.mount('hud-right')
  })

  it('gives related components separate inspect and locate actions', () => {
    const ctx = context()
    const selected: (string | null)[] = []
    const focused: (string | null)[] = []
    const events: string[] = []
    ctx.bus.on('select', ({ id }) => {
      selected.push(id)
      events.push(`select:${id}`)
    })
    ctx.bus.on('focus', ({ id }) => {
      focused.push(id)
      events.push(`focus:${id}`)
    })
    const inspector = createInspector(ctx)

    ctx.bus.emit('select', { id: 'walwriter' })
    const inspect = [...document.querySelectorAll<HTMLButtonElement>('.pgc-see__inspect')]
      .find((button) => button.dataset.relatedInspect === 'wal.vault')!
    const locate = [...document.querySelectorAll<HTMLButtonElement>('.pgc-see__locate')]
      .find((button) => button.dataset.relatedLocate === 'wal.vault')!

    expect(inspect.textContent).toBe('pg_wal')
    expect(locate.textContent).toBe('Locate')
    expect(locate.disabled).toBe(false)
    events.length = 0
    locate.click()
    expect(focused).toEqual(['wal.vault'])
    expect(selected).toEqual(['walwriter', 'wal.vault'])
    expect(events).toEqual(['select:wal.vault', 'focus:wal.vault'])

    ctx.bus.emit('select', { id: 'walwriter' })
    const inspectAgain = [...document.querySelectorAll<HTMLButtonElement>('.pgc-see__inspect')]
      .find((button) => button.dataset.relatedInspect === 'wal.vault')!
    events.length = 0
    inspectAgain.click()
    expect(selected.at(-1)).toBe('wal.vault')
    expect(focused).toEqual(['wal.vault'])
    expect(events).toEqual(['select:wal.vault'])
    inspector.dispose()
  })

  it('keeps missing city targets inspectable but disables Locate', () => {
    const ctx = context()
    const inspector = createInspector(ctx)

    ctx.bus.emit('select', { id: 'walwriter' })

    expect(document.querySelector<HTMLButtonElement>('[data-related-inspect="checkpointer"]')!.disabled).toBe(false)
    const locate = document.querySelector<HTMLButtonElement>('[data-related-locate="checkpointer"]')!
    expect(locate.disabled).toBe(true)
    expect(locate.getAttribute('aria-label')).toContain('no city location')
    inspector.dispose()
  })

  it('returns through inspector history, then returns to the city without changing the model', () => {
    const ctx = context()
    const selected: (string | null)[] = []
    const focused: (string | null)[] = []
    ctx.bus.on('select', ({ id }) => selected.push(id))
    ctx.bus.on('focus', ({ id }) => focused.push(id))
    const inspector = createInspector(ctx)
    const before = { t: ctx.sim.state.t, knobs: { ...ctx.sim.state.knobs } }

    ctx.bus.emit('select', { id: 'walwriter' })
    ;[...document.querySelectorAll<HTMLButtonElement>('.pgc-see__inspect')]
      .find((button) => button.dataset.relatedInspect === 'wal.vault')!.click()
    document.querySelector<HTMLButtonElement>('.pgc-insp__back')!.click()

    expect(document.querySelector('.pgc-insp__title')?.textContent).toBe('WAL writer')
    expect(focused).toEqual([])

    document.querySelector<HTMLButtonElement>('.pgc-insp__city')!.click()
    expect(focused).toEqual(['world.ground'])
    expect(selected.at(-1)).toBeNull()
    expect(document.querySelector('#pgc-inspector-panel')?.getAttribute('aria-hidden')).toBe('true')
    expect(document.querySelector('#pgc-inspector-tab')?.getAttribute('aria-expanded')).toBe('false')
    expect({ t: ctx.sim.state.t, knobs: ctx.sim.state.knobs }).toEqual(before)
    inspector.dispose()
  })
})
