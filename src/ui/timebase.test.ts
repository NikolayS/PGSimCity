import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createFrameTimebase, wallDelta } from '../core/timebase'
import { createHud } from './hud'
import { createTour } from './tour'
import type { UiContext } from './uikit'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 2,
    getQuality: () => ({
      level: 'low',
      pixelRatio: 0.6,
      bloom: false,
      shadows: false,
      maxParticles: 1,
      maxLabels: 1,
      antialias: false,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

describe('user-facing timebase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const dom = installTestDom()
    dom.mount('tour-layer')
    dom.mount('canvas-root')
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for reader action even after the chapter duration elapses', () => {
    const ctx = context()
    const chapters: number[] = []
    ctx.bus.on('tour:chapter', ({ index }) => chapters.push(index))
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', {})
    for (let frame = 0; frame < 32; frame++) tour.update(0.1, 0.5)

    expect(chapters).toEqual([0])
    expect(document.querySelector('.tour-card__n')?.textContent).toBe('1')
    expect(document.querySelector('.tour-card__of')?.textContent).toBe('of 14')
    tour.dispose()
  })

  it('advances by elapsed wall time after the reader opts into play mode', () => {
    const ctx = context()
    const chapters: number[] = []
    ctx.bus.on('tour:chapter', ({ index }) => chapters.push(index))
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', {})
    document.querySelector<HTMLButtonElement>('.tour-btn--play')!.click()
    for (let frame = 0; frame < 32; frame++) tour.update(0.1, 0.5)

    expect(chapters).toEqual([0, 1])
    tour.dispose()
  })

  it('restores the previous chapter scenario and staged view', () => {
    const ctx = context()
    const focuses: (string | null)[] = []
    ctx.bus.on('focus', ({ id }) => focuses.push(id))
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', { chapter: 6 })
    document.querySelector<HTMLButtonElement>('.tour-next')!.click()
    expect(ctx.sim.state.scenario).toBe('checkpoint-storm')

    document.querySelector<HTMLButtonElement>('.tour-prev')!.click()

    expect(document.querySelector('.tour-card__n')?.textContent).toBe('7')
    expect(document.querySelector('.tour-card__of')?.textContent).toBe('of 14')
    expect(ctx.sim.state.scenario).toBeNull()
    expect(ctx.sim.state.knobs.synchronousCommit).toBe('off')
    expect(focuses.at(-1)).toBe('walwriter')
    tour.dispose()
  })

  it('renders the tour body with the shared inline-markdown rules', () => {
    const ctx = context()
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', { chapter: 6 })

    expect(document.querySelector<HTMLElement>('.tour-card__body')?.innerHTML)
      .toContain('<code>synchronous_commit</code>')
    tour.dispose()
  })

  it('preserves the knob baseline across forward and backward clicks', () => {
    const ctx = context()
    ctx.sim.setKnob('tps', 321)
    ctx.sim.setKnob('writeRatio', 0.21)
    ctx.sim.setKnob('sharedBuffers', 1536)
    ctx.sim.setKnob('maxWalSize', 384)
    ctx.sim.setKnob('synchronousCommit', 'local')
    const baseline = { ...ctx.sim.state.knobs }
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', { chapter: 6 })
    const next = document.querySelector<HTMLButtonElement>('.tour-next')!
    const previous = document.querySelector<HTMLButtonElement>('.tour-prev')!
    next.click()
    next.click()
    previous.click()
    previous.click()
    next.click()
    document.querySelector<HTMLButtonElement>('[data-mode-exit="guided-tour"]')!.click()

    expect(ctx.sim.state.knobs).toEqual(baseline)
    tour.dispose()
  })

  it('keeps scenario narration until reader dismissal, including while paused', () => {
    const ctx = context()
    const tour = createTour(ctx)

    ctx.sim.runScenario('checkpoint-storm')
    const card = document.querySelector('.tour-narrate')!
    expect(card.classList.contains('is-live')).toBe(true)

    vi.advanceTimersByTime(10_000)
    expect(card.classList.contains('is-live')).toBe(true)

    for (let frame = 0; frame < 271; frame++) {
      ctx.sim.update(1 / 30)
      tour.update(1 / 30)
    }
    expect(card.classList.contains('is-live')).toBe(true)
    expect(card.classList.contains('is-out')).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-scenario-note="dismiss"]')!.click()
    expect(card.classList.contains('is-live')).toBe(false)
    tour.dispose()
  })

  it('repaints the scenario clock on each low-frame-rate update', () => {
    const ctx = context()
    const hud = createHud(ctx)
    const clock = createFrameTimebase(ctx.sim.update)

    ctx.sim.runScenario('checkpoint-storm')
    clock.advance(wallDelta(1), false, 1)
    hud.update(0.1, 1)

    expect(document.querySelector('.hud-now__time')?.textContent).toBe('0:01 / 2:00')
    hud.dispose()
  })

  it('gives the brand and checkpoint controls separate rows at 1280px', () => {
    const hud = createHud(context())

    expect(document.querySelector('.hud-bar')?.classList.contains('is-stacked')).toBe(true)
    hud.dispose()
  })
})
