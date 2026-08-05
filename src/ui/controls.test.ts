import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { N_BACKEND_SLOTS } from '../core/types'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import {
  applyKnob,
  createControls,
  KNOB_PREFERENCES_STORAGE_KEY,
  loadKnobPreferences,
} from './controls'
import type { UiContext } from './uikit'

type Sim = ReturnType<typeof createSim>

const STEP = 1 / 30

function advance(sim: Sim, seconds: number): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) sim.update(Math.min(STEP, until - sim.state.t))
}

function storeKnobs(knobs: Record<string, unknown>): void {
  window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({
    tps: 1_200,
    writeRatio: 1,
    ...knobs,
  }))
}

function expectSustainedCommits(sim: Sim): void {
  advance(sim, 15)
  const before = sim.state.stats.commits
  advance(sim, 5)
  expect(sim.state.stats.commits - before).toBeGreaterThan(0)
  expect(sim.state.backends.filter((backend) => backend.state === 'commit_wait'))
    .not.toHaveLength(N_BACKEND_SLOTS)
}

function controlsContext(sim: Sim, bus: ReturnType<typeof createBus>): UiContext {
  return {
    sim,
    bus,
    registry: { get: () => undefined },
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 100,
      maxLabels: 20,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  } as unknown as UiContext
}

describe('persisted knob-set safety', () => {
  it('keeps a real restored set from waiting forever for its disabled synchronous standby', () => {
    installTestDom()
    storeKnobs({ standbyAEnabled: false })
    const sim = createSim(createBus(), { scheduledBackups: false })

    loadKnobPreferences(sim)

    expect(JSON.parse(window.localStorage.getItem(KNOB_PREFERENCES_STORAGE_KEY) ?? '{}'))
      .toMatchObject({ synchronousStandbyNames: 'none', standbyAEnabled: false })
    expectSustainedCommits(sim)
  })

  it.each([
    ['a disabled standby_b selected by name', {
      synchronousCommit: 'remote_write',
      synchronousStandbyNames: 'standbyB',
      standbyBEnabled: false,
    }],
    ['physical replication absent at wal_level=minimal', {
      synchronousCommit: 'remote_apply',
      walLevel: 'minimal',
    }],
  ])('reconciles %s through the same restore path', (_case, stored) => {
    installTestDom()
    storeKnobs(stored)
    const sim = createSim(createBus(), { scheduledBackups: false })

    loadKnobPreferences(sim)

    expectSustainedCommits(sim)
  })

  it.each(['off', 'local'] as const)(
    'does not rewrite an unavailable standby when synchronous_commit=%s cannot enter SyncRep',
    (synchronousCommit) => {
      installTestDom()
      storeKnobs({ synchronousCommit, standbyAEnabled: false })
      const sim = createSim(createBus(), { scheduledBackups: false })

      const result = loadKnobPreferences(sim)

      expect(result.synchronousStandby).toBeNull()
      expect(sim.state.knobs.synchronousStandbyNames).toBe('standbyA')
      expectSustainedCommits(sim)
    },
  )

  it('persists the model rejection of open transactions under statement pooling', () => {
    installTestDom()
    storeKnobs({
      poolMode: 'statement',
      longRunningXact: true,
      lockContention: true,
    })
    const sim = createSim(createBus(), { scheduledBackups: false })

    loadKnobPreferences(sim)

    expect(sim.state.knobs.longRunningXact).toBe(false)
    expect(sim.state.knobs.lockContention).toBe(false)
    expect(JSON.parse(window.localStorage.getItem(KNOB_PREFERENCES_STORAGE_KEY) ?? '{}'))
      .not.toMatchObject({ longRunningXact: true, lockContention: true })
  })

  it('announces a changed saved setting and opens the exact recovery control', () => {
    const dom = installTestDom()
    dom.mount('hud-left')
    storeKnobs({ standbyAEnabled: false })
    const bus = createBus()
    const messages: { text: string; action?: { label: string; consoleKey?: string } }[] = []
    bus.on('toast', ({ text, action }) => messages.push({ text, action }))
    const sim = createSim(bus, { scheduledBackups: false })

    const controls = createControls(controlsContext(sim, bus))

    expect(sim.state.knobs.synchronousStandbyNames).toBe('none')
    expect(messages.map(({ text }) => text).join('\n')).toMatch(
      /saved settings.*standby_a.*loaded with synchronous_standby_names empty.*local durability/is,
    )
    const action = messages.find(({ action }) => action?.consoleKey)?.action
    expect(action).toMatchObject({ label: 'Open sync controls', consoleKey: 'synchronousStandbyNames' })

    bus.emit('ui:console', { open: true, key: 'synchronousStandbyNames' })
    const target = document.querySelector<HTMLElement>('[data-knob="synchronousStandbyNames"]')
    expect(document.querySelector('.pgc-host')?.classList.contains('is-open')).toBe(true)
    expect(target?.closest('.pg-collapse')?.classList.contains('is-open')).toBe(true)
    expect(document.activeElement).toBe(target?.querySelector('select'))
    controls.dispose()
  })

  it('still allows a reader to create the real SyncRep outage deliberately and tells them how out', () => {
    installTestDom()
    const bus = createBus()
    const messages: { text: string; action?: { label: string } }[] = []
    bus.on('toast', ({ text, action }) => messages.push({ text, action }))
    const sim = createSim(bus, { scheduledBackups: false })
    applyKnob(sim, 'tps', 1_200)
    applyKnob(sim, 'writeRatio', 1)
    applyKnob(sim, 'standbyAEnabled', false)

    advance(sim, 15)
    const commits = sim.state.stats.commits
    advance(sim, 5)

    expect(sim.state.backends.filter((backend) => backend.state === 'commit_wait'))
      .toHaveLength(N_BACKEND_SLOTS)
    expect(sim.state.stats.commits).toBe(commits)
    expect(messages.map(({ text }) => text).join('\n')).toMatch(
      /enable.*standby|name another.*standby|synchronous_standby_names.*clear|synchronous_commit=local/is,
    )
    expect(messages.some(({ action }) => action?.label.match(/sync.*controls/i))).toBe(true)
  })
})
