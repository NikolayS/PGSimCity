import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createHud } from './hud'
import type { UiContext } from './uikit'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 60,
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

describe('latency HUD', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces cache hit with p50/p99 model time and opens the p99 wait anatomy', () => {
    const ctx = context()
    const hud = createHud(ctx)
    for (let i = 0; i < 1800; i++) {
      ctx.sim.update(1 / 30)
      hud.update(1 / 30)
    }

    const vitals = Array.from(document.querySelectorAll<HTMLButtonElement>('.hud-vital'))
    expect(vitals.some((vital) => vital.textContent?.includes('Cache hit'))).toBe(false)
    const latency = vitals.find((vital) => vital.textContent?.includes('Latency p50'))!
    expect(latency.textContent).toMatch(/Latency p50 \/ p99 · model ms/i)
    expect(latency.textContent).toMatch(/\d/)

    latency.click()
    const panel = document.getElementById('hud-latency-panel')!
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('p99 trip anatomy')
    expect(panel.textContent).toContain('Dirty victim write')
    expect(panel.textContent).toContain('Commit wait')
    expect(panel.textContent).toContain('Lock wait')
    expect(panel.textContent).toContain('mean_exec_time and stddev_exec_time, not percentiles')
    expect(panel.querySelector('a[href*="pg-stat-monitor"]')).not.toBeNull()
    hud.dispose()
  })
})
