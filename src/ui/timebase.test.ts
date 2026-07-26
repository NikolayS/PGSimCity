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

  it('advances tour chapters by elapsed wall time at two frames per second', () => {
    const ctx = context()
    const chapters: number[] = []
    ctx.bus.on('tour:chapter', ({ index }) => chapters.push(index))
    const tour = createTour(ctx)

    ctx.bus.emit('tour:start', {})
    for (let frame = 0; frame < 32; frame++) tour.update(0.1, 0.5)

    expect(chapters).toEqual([0, 1])
    tour.dispose()
  })

  it('holds scenario narration for simulation time, including while paused', () => {
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
    expect(card.classList.contains('is-out')).toBe(true)
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
})
