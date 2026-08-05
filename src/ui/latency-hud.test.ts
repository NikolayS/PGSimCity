import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import { CLAIM_VALUES } from '../core/claims'
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

  it('replaces cache hit with disclosed p50/p99 model-time distributions', () => {
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
    expect(panel.textContent).toContain('Modeled backend-trip latency')
    expect(panel.textContent).toContain('p99 modeled component quantiles')
    expect(panel.textContent).toContain('Pool-slot queue')
    expect(panel.textContent).toContain('Buffer-read phase')
    expect(panel.textContent).toContain('Dirty-victim I/O')
    expect(panel.textContent).toContain('Temp-file I/O')
    expect(panel.textContent).toContain('Commit durability')
    expect(panel.textContent).toContain('Relation lock wait')
    expect(panel.textContent).toContain('p99 non-wait residual')
    expect(panel.textContent).toContain('Active / unclassified')
    expect(panel.textContent).not.toContain('Running / other')
    expect(panel.textContent).toContain(CLAIM_VALUES.modelLatency.taxonomyDisclosure)
    expect(panel.textContent).toContain('within-batch variance is not modeled')
    expect(panel.textContent).toContain('33.33 model ms steps')
    expect(panel.querySelector('[data-disclosure="work-mem-latency-scope"]')).not.toBeNull()
    expect(panel.textContent).toContain('mean_exec_time and stddev_exec_time, not percentiles')
    expect(panel.querySelector('a[href*="pg-stat-monitor"]')).not.toBeNull()
    hud.dispose()
  })

  it('turns a remedial toast action into an exact console-control request', () => {
    const ctx = context()
    const requests: { open?: boolean; key?: string }[] = []
    ctx.bus.on('ui:console', (request) => requests.push(request))
    const hud = createHud(ctx)

    ctx.bus.emit('toast', {
      text: 'Commits are waiting for an unavailable synchronous standby.',
      kind: 'warn',
      action: { label: 'Open sync controls', consoleKey: 'synchronousStandbyNames' },
    })
    document.querySelector<HTMLButtonElement>('.hud-toast')?.click()

    expect(requests).toEqual([{ open: true, key: 'synchronousStandbyNames' }])
    hud.dispose()
  })
})
