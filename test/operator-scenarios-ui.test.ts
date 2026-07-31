import { beforeEach, describe, expect, it } from 'vitest'
import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { createHud } from '../src/ui/hud'
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

function advanceUntilReady(ctx: UiContext): void {
  const deadline = ctx.sim.state.t + 240
  while (ctx.sim.state.scenarioDecision?.phase !== 'ready' && ctx.sim.state.t < deadline) {
    ctx.sim.update(1 / 30)
  }
  expect(ctx.sim.state.scenarioDecision?.phase).toBe('ready')
}

describe('operator scenario dock', () => {
  beforeEach(() => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
  })

  it('reveals choices from live instruments without creating a modal', () => {
    const ctx = context()
    const hud = createHud(ctx)
    ctx.sim.runScenario('slot-pressure')

    const dock = document.querySelector<HTMLElement>('.hud-decision')!
    expect(dock.hidden).toBe(true)
    advanceUntilReady(ctx)
    hud.update(0.2, 0.2)

    expect(dock.hidden).toBe(false)
    expect(dock.getAttribute('aria-modal')).toBeNull()
    expect(dock.textContent).toContain('standby_b_slot')
    expect(dock.textContent).toContain('pg_wal')
    expect(dock.textContent).toContain('Add 512 MiB capacity')
    expect(dock.textContent).toContain('Drop standby_b_slot')

    document.querySelector<HTMLButtonElement>(
      '[data-scenario-choice="drop-replication-slot"]',
    )!.click()
    hud.update(0.2, 0.2)
    expect(dock.textContent).toContain('base backup')
    expect(dock.textContent).toContain('Rebuild standby_b')
    expect(dock.textContent).not.toMatch(/points|score|badge/i)

    hud.dispose()
  })

  it('routes each scenario choice through the shared decision controls', () => {
    for (const [scenario, expectedChoices] of [
      ['slot-pressure', ['add-wal-capacity', 'drop-replication-slot']],
      ['vacuum-blockade', ['terminate-transaction', 'wait-for-transaction']],
      ['failover-candidate', ['promote-standby-a', 'promote-standby-b']],
    ] as const) {
      const ctx = context()
      const hud = createHud(ctx)
      ctx.sim.runScenario(scenario)
      advanceUntilReady(ctx)
      hud.update(0.2, 0.2)

      const choices = Array.from(
        document.querySelectorAll<HTMLElement>('[data-scenario-choice]'),
      ).map((node) => node.dataset.scenarioChoice)
      expect(choices).toEqual(expectedChoices)
      document.querySelector<HTMLButtonElement>(
        `[data-scenario-choice="${expectedChoices[0]}"]`,
      )!.click()
      expect(ctx.sim.state.scenarioDecision?.choice).toBe(expectedChoices[0])

      hud.dispose()
    }
  })
})
