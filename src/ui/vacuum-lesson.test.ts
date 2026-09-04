import { afterEach, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createVacuumLesson, type VacuumLessonModule, type VacuumLessonOptions, type VacuumLessonProgress } from './vacuum-lesson'
import { VACUUM_EVIDENCE } from './vacuum-lesson-state'
import type { UiContext } from './uikit'

const modules: VacuumLessonModule[] = []

function fixture(level: 'high' | 'reduced' = 'high', options: VacuumLessonOptions = {}) {
  installTestDom()
  const bus = createBus()
  const sim = createSim(bus, { maxStep: 1 / 3, scheduledBackups: false })
  const ctx = {
    bus, sim, registry: { get: () => undefined },
    getFps: () => 60,
    getQuality: () => ({ level }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  } as unknown as UiContext
  const lesson = createVacuumLesson(ctx, options)
  modules.push(lesson)
  return { sim, bus, lesson }
}

function button(selector: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(selector)!
}

function advanceUntil(
  f: ReturnType<typeof fixture>,
  done: () => boolean,
  limit = 900,
): void {
  const end = f.sim.state.t + limit
  while (!done() && f.sim.state.t < end) {
    f.sim.update(1 / 3)
    f.lesson.update(1 / 3)
  }
  expect(done()).toBe(true)
}

function investigate(f: ReturnType<typeof fixture>): void {
  advanceUntil(f, () => f.sim.state.scenarioDecision?.phase === 'ready')
  for (const id of VACUUM_EVIDENCE) {
    button(`[data-vacuum-evidence="${id}"]`).click()
    expect(button('[data-vacuum-record]').disabled).toBe(false)
    button('[data-vacuum-record]').click()
  }
  button('[data-vacuum-cause="snapshot"]').click()
}

afterEach(() => {
  while (modules.length) modules.pop()!.dispose()
})

describe('vacuum lesson in the live model', () => {
  it('positions its desktop panel below the measured wrapped toolbar', () => {
    const f = fixture()
    const hud = document.createElement('div')
    hud.id = 'hud-top'
    hud.getBoundingClientRect = () => ({ bottom: 138 }) as DOMRect
    document.body.append(hud)
    f.lesson.open()
    const panel = document.querySelector<HTMLElement>('.vacuum-lesson')!
    const style = panel.style as unknown as Record<string, string>
    expect(style['--vacuum-top']).toBe('150px')
    hud.getBoundingClientRect = () => ({ bottom: 182 }) as DOMRect
    window.dispatchEvent(new Event('resize'))
    expect(style['--vacuum-top']).toBe('194px')
  })

  it('requires evidence, then waits for real cleanup and an explicit recovery check', () => {
    const f = fixture()
    f.lesson.open('challenge')
    expect(f.sim.state.scenario).toBe('vacuum-blockade')
    expect(button('[data-vacuum-action="terminate"]').disabled).toBe(true)
    button('[data-vacuum-action="terminate"]').click()
    expect(f.sim.state.knobs.longRunningXact).toBe(true)
    investigate(f)
    expect(document.querySelector('[data-vacuum-notebook]')!.textContent).toContain('Authored scenario context')
    expect(button('[data-vacuum-action="terminate"]').disabled).toBe(false)
    button('[data-vacuum-action="terminate"]').click()
    expect(f.sim.state.knobs.longRunningXact).toBe(false)
    expect(document.querySelector<HTMLElement>('.vacuum-lesson')!.dataset.phase).toBe('observing')
    button('[data-vacuum-verify]').click()
    expect(document.querySelector<HTMLElement>('.vacuum-lesson')!.dataset.phase).toBe('observing')
    advanceUntil(f, () => f.sim.state.scenarioDecision?.phase === 'recovered')
    expect(document.querySelector<HTMLElement>('.vacuum-lesson')!.dataset.phase).toBe('observing')
    button('[data-vacuum-verify]').click()
    expect(document.querySelector<HTMLElement>('.vacuum-lesson')!.dataset.phase).toBe('complete')
    expect(document.querySelector('[data-vacuum-result]')!.textContent).toMatch(/cleanup has resumed/i)
    expect(document.querySelector('[data-disclosure="vacuum-model"]')!.textContent).toMatch(/sampled|representative/)
  })

  it('retains the notebook and personal notes while inspecting a representative page', () => {
    const f = fixture()
    const opens: string[] = []
    f.bus.on('anatomy:open', ({ id }) => opens.push(id ?? ''))
    f.lesson.open()
    investigate(f)
    const notebook = document.querySelector('[data-vacuum-notebook]')!.textContent
    const notes = document.querySelector<HTMLTextAreaElement>('[data-vacuum-notes]')!
    notes.value = 'Check the snapshot before tuning vacuum.'
    button('[data-vacuum-page]').click()
    f.lesson.update(3600)
    expect(opens).toEqual(['storage.table.sessions'])
    expect(document.querySelector('[data-vacuum-notebook]')!.textContent).toBe(notebook)
    expect(notes.value).toBe('Check the snapshot before tuning vacuum.')
    expect(f.lesson.isOpen()).toBe(true)
  })

  it('lets a learner observe waiting, release the transaction, and verify recovery', () => {
    const f = fixture()
    f.lesson.open()
    investigate(f)
    button('[data-vacuum-action="wait"]').click()
    expect(f.sim.state.knobs.longRunningXact).toBe(true)
    button('[data-vacuum-recover]').click()
    expect(f.sim.state.knobs.longRunningXact).toBe(false)
    advanceUntil(f, () => f.sim.state.scenarioDecision?.phase === 'recovered')
    button('[data-vacuum-verify]').click()
    expect(document.querySelector<HTMLElement>('.vacuum-lesson')!.dataset.phase).toBe('complete')
  })

  it('restores its own knobs and focus on close without resetting relation history', () => {
    const f = fixture()
    f.sim.setKnob('tps', 321)
    f.sim.setKnob('timeScale', 0.5)
    f.sim.setKnob('paused', true)
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    f.lesson.open()
    advanceUntil(f, () => f.sim.state.scenarioT > 2)
    const time = f.sim.state.t
    f.lesson.close()
    expect(f.sim.state.scenario).toBeNull()
    expect(f.sim.state.knobs.tps).toBe(321)
    expect(f.sim.state.knobs.timeScale).toBe(0.5)
    expect(f.sim.state.knobs.paused).toBe(true)
    expect(f.sim.state.t).toBe(time)
    expect(document.activeElement).toBe(opener)
    expect(document.body.classList.contains('pg-vacuum-lesson')).toBe(false)
  })

  it('does not end a replacement scenario or restore pre-lesson settings over a reset', () => {
    const f = fixture()
    f.sim.setKnob('timeScale', 0.5)
    f.lesson.open()
    f.sim.runScenario('bloat-and-vacuum')
    expect(f.lesson.isOpen()).toBe(false)
    expect(f.sim.state.scenario).toBe('bloat-and-vacuum')
    f.lesson.open()
    f.sim.reset()
    expect(f.lesson.isOpen()).toBe(false)
    expect(f.sim.state.scenario).toBeNull()
    expect(f.sim.state.knobs.timeScale).toBe(1)
  })

  it('does not undo a time control the reader changed outside the lesson', () => {
    const f = fixture()
    f.sim.setKnob('timeScale', 0.5)
    f.lesson.open()
    f.sim.setKnob('timeScale', 2, 'user')
    f.lesson.close()
    expect(f.sim.state.knobs.timeScale).toBe(2)
  })

  it('keeps a reduced-motion city paused and changes focus instantly', () => {
    const f = fixture('reduced')
    const focuses: { id: string | null; instant?: boolean }[] = []
    f.bus.on('focus', (event) => focuses.push(event))
    f.sim.setKnob('paused', true)
    f.lesson.open()
    expect(f.sim.state.knobs.paused).toBe(true)
    expect(focuses.at(-1)).toEqual({ id: 'storage.table.sessions', instant: true })
    button('[data-vacuum-pause]').click()
    expect(f.sim.state.knobs.paused).toBe(false)
    f.lesson.close()
    expect(f.sim.state.knobs.paused).toBe(true)
  })

  it('reports only fixed progress events and mode, with completion gated by actual cleanup', () => {
    const events: VacuumLessonProgress[] = []
    const f = fixture('high', { onProgress: (progress) => events.push(progress) })
    f.lesson.open('challenge')
    investigate(f)
    button('[data-vacuum-hint]').click()
    button('[data-vacuum-action="terminate"]').click()
    button('[data-vacuum-verify]').click()
    expect(events).toEqual([
      { event: 'started', mode: 'challenge' },
      ...VACUUM_EVIDENCE.map(() => ({ event: 'evidence-collected', mode: 'challenge' })),
      { event: 'hint-used', mode: 'challenge' },
    ])
    advanceUntil(f, () => f.sim.state.scenarioDecision?.phase === 'recovered')
    button('[data-vacuum-verify]').click()
    expect(events.at(-1)).toEqual({ event: 'recovery-verified', mode: 'guided' })
    expect(events.every((event) => Object.keys(event).sort().join(',') === 'event,mode')).toBe(true)
  })

  it('keeps the lesson usable when an optional analytics callback fails', () => {
    const f = fixture('high', { onProgress: () => { throw new Error('Analytics unavailable') } })
    expect(() => f.lesson.open()).not.toThrow()
    expect(f.lesson.isOpen()).toBe(true)
    expect(f.sim.state.scenario).toBe('vacuum-blockade')
  })
})
