import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createTour } from './tour'
import type { UiContext, UiModule } from './uikit'

const modules: UiModule[] = []

function fixture(): UiContext {
  const bus = createBus()
  return {
    bus, sim: createSim(bus), registry: { get: () => undefined },
    getFps: () => 60, getQuality: () => ({ level: 'high' }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  } as unknown as UiContext
}

beforeEach(() => {
  vi.useFakeTimers()
  const dom = installTestDom()
  dom.mount('tour-layer')
})

afterEach(() => {
  while (modules.length) modules.pop()!.dispose()
  vi.useRealTimers()
})

describe('first investigation invitation', () => {
  it('keeps scenario explanations beyond their former model-time expiry', () => {
    const ctx = fixture()
    const tour = createTour(ctx, { onInvestigate: vi.fn() })
    modules.push(tour)
    ctx.sim.runScenario('steady-state')
    ctx.sim.update(1 / 30)
    const title = document.querySelector('.tour-narrate__title')!.textContent
    for (let frame = 0; frame < 300; frame++) {
      ctx.sim.update(1 / 30)
      tour.update(1 / 30)
    }
    vi.advanceTimersByTime(1000)
    expect(document.querySelector('.tour-narrate')!.classList.contains('is-live')).toBe(true)
    expect(document.querySelector('.tour-narrate__title')!.textContent).toBe(title)
  })

  it('queues later beats without replacing the reader’s current explanation and can reopen history', () => {
    const ctx = fixture()
    modules.push(createTour(ctx, { onInvestigate: vi.fn() }))
    ctx.bus.emit('narrate', { title: 'First explanation', body: 'First complete qualification.', seconds: 9 })
    ctx.bus.emit('narrate', { title: 'Second explanation', body: 'Second complete qualification.', seconds: 9 })
    expect(document.querySelector('.tour-narrate__title')!.textContent).toBe('First explanation')
    document.querySelector<HTMLButtonElement>('[data-scenario-note="next"]')!.click()
    expect(document.querySelector('.tour-narrate__body')!.textContent).toBe('Second complete qualification.')
    document.querySelector<HTMLButtonElement>('[data-scenario-note="previous"]')!.click()
    expect(document.querySelector('.tour-narrate__title')!.textContent).toBe('First explanation')
    document.querySelector<HTMLButtonElement>('[data-scenario-note="dismiss"]')!.click()
    vi.advanceTimersByTime(1000)
    expect(document.querySelector('.tour-narrate')!.classList.contains('is-live')).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-scenario-history]')!.click()
    expect(document.querySelector('.tour-narrate__title')!.textContent).toBe('First explanation')
    expect(document.querySelector('.tour-narrate__body')!.textContent).toBe('First complete qualification.')
  })

  it('keeps a dismissed scenario quiet while retaining later notes and their disclosure', () => {
    const ctx = fixture()
    modules.push(createTour(ctx, { onInvestigate: vi.fn() }))
    ctx.sim.runScenario('work-mem-spill')
    document.querySelector<HTMLButtonElement>('[data-scenario-note="dismiss"]')!.click()
    ctx.bus.emit('narrate', { title: 'Later note', body: 'Full scope qualification.', seconds: 9 })
    expect(document.querySelector('.tour-narrate')!.classList.contains('is-live')).toBe(false)
    ctx.sim.runScenario(null)
    document.querySelector<HTMLButtonElement>('[data-scenario-history]')!.click()
    document.querySelector<HTMLButtonElement>('[data-scenario-note="next"]')!.click()
    expect(document.querySelector('.tour-narrate__body')!.textContent).toBe('Full scope qualification.')
    expect(document.querySelector<HTMLElement>('.tour-narrate__body')!.dataset.disclosure).toBe('work-mem-scenario-narration')
    ctx.sim.reset()
    expect(document.querySelector<HTMLButtonElement>('[data-scenario-history]')!.hidden).toBe(true)
    expect(document.querySelector('.tour-narrate')!.classList.contains('is-live')).toBe(false)
  })

  it('keeps the offer until the reader acts, then opens the investigation', () => {
    const ctx = fixture()
    const investigate = vi.fn()
    modules.push(createTour(ctx, { onInvestigate: investigate }))
    const start = document.querySelector<HTMLButtonElement>('.tour-first__go')!
    expect(start.textContent).toContain('Investigate a growing table')
    expect(window.localStorage.getItem('pgsimcity.seen')).toBeNull()
    vi.advanceTimersByTime(120_000)
    expect(document.querySelector('.tour-first')!.classList.contains('is-live')).toBe(true)
    start.click()
    expect(investigate).toHaveBeenCalledTimes(1)
    expect(document.body.classList.contains('pg-tour')).toBe(false)
    expect(document.querySelector('.tour-first')!.classList.contains('is-live')).toBe(false)
    expect(window.localStorage.getItem('pgsimcity.seen')).toBe('1')
  })

  it('preserves the self-paced tour as a secondary choice', () => {
    const ctx = fixture()
    const investigate = vi.fn()
    modules.push(createTour(ctx, { onInvestigate: investigate }))
    document.querySelector<HTMLButtonElement>('.tour-first__tour')!.click()
    expect(investigate).not.toHaveBeenCalled()
    expect(document.body.classList.contains('pg-tour')).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.tour-next'))
  })

  it('remembers an explicit choice to explore freely', () => {
    const ctx = fixture()
    modules.push(createTour(ctx, { onInvestigate: vi.fn() }))
    document.querySelector<HTMLButtonElement>('.tour-first__no')!.click()
    modules.pop()!.dispose()
    modules.push(createTour(ctx, { onInvestigate: vi.fn() }))
    expect(document.querySelector('.tour-first')!.classList.contains('is-live')).toBe(false)
  })

  it('ends a query trace and restores its baseline when another lesson takes over', () => {
    const ctx = fixture()
    ctx.sim.setKnob('tps', 321)
    ctx.sim.setKnob('timeScale', 0.5)
    modules.push(createTour(ctx))
    ctx.bus.emit('trace:open', {})
    document.querySelector<HTMLButtonElement>('.trace-picker__choice')!.click()
    expect(ctx.sim.state.knobs.tps).toBe(18)
    ctx.bus.emit('tour:stop', {})
    expect(ctx.sim.state.knobs.tps).toBe(321)
    expect(ctx.sim.state.knobs.timeScale).toBe(0.5)
    expect(document.body.classList.contains('pg-trace')).toBe(false)
  })
})
