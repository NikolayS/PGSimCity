import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import type { QueryKind, TraceRecord, TraceStop } from '../core/types'
import { traceStopBit } from '../core/model-helpers'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createHud } from './hud'
import { createTour } from './tour'
import type { UiContext } from './uikit'
import { createTraceDwell, MIN_DWELL_S } from './trace-dwell'
import { TRACE_COPY } from './trace-copy'

const STOPS: TraceStop[] = [
  'connect',
  'parse_plan',
  'fetch',
  'work',
  'wal',
  'commit',
  'send',
  'done',
]

function record(): TraceRecord {
  return {
    slot: 0,
    query: 'update' satisfies QueryKind,
    table: 3,
    sql: 'UPDATE sessions SET updated_at = now(), status = $1 WHERE id = ANY ($2)',
    stop: 'connect',
    stopT: 0,
    visited: traceStopBit('connect'),
    trips: 0,
    lastXid: 0,
    lastPlanLabel: '',
    lastPlanRows: 0,
    lastPlanCost: 0,
    rowsSent: 0,
    buffersHit: 0,
    buffersRead: 0,
    walBytes: 0,
    walFpiBytes: 0,
    deadMade: 0,
    lastTripSec: 0,
  }
}

function drive(frameWallSeconds: number): void {
  const trace = record()
  const dwell = createTraceDwell(trace)
  const seenCards = new Set<TraceStop>()
  let simElapsed = 0
  let entered = 0

  while (entered < STOPS.length - 1 || dwell.stop !== 'done') {
    simElapsed += 0.1
    while (entered < STOPS.length - 1 && simElapsed >= (entered + 1) * 0.1) {
      entered++
      trace.stop = STOPS[entered]
      trace.stopT = simElapsed
      trace.visited |= traceStopBit(trace.stop)
    }

    dwell.update(trace, 0.1, frameWallSeconds)
    expect(dwell.stop).not.toBeNull()
    expect(trace.visited & traceStopBit(dwell.stop)).not.toBe(0)
    seenCards.add(dwell.stop)
  }

  expect(dwell.stop).toBe('done')
  expect(dwell.wallSinceChange).toBeLessThan(MIN_DWELL_S)
  expect(seenCards.has('connect')).toBe(true)
}

describe('trace narration dwell', () => {
  it('never goes blank or ahead at the measured 1.85 fps', () => {
    drive(0.54)
  })

  it('never goes blank or ahead at 60 fps', () => {
    drive(1 / 60)
  })

  it('jumps to the current stop instead of replaying a backlog', () => {
    const trace = record()
    const dwell = createTraceDwell(trace)

    trace.visited |= traceStopBit('parse_plan') | traceStopBit('fetch') | traceStopBit('work')
    trace.stop = 'work'
    dwell.update(trace, 0.1, MIN_DWELL_S)

    expect(dwell.stop).toBe('work')
  })
})

describe('trace narration copy', () => {
  const kinds: QueryKind[] = [
    'select_idx',
    'select_seq',
    'aggregate',
    'insert',
    'update',
    'delete',
  ]

  for (const kind of kinds) {
    it(`keeps every ${kind} stop concise`, () => {
      const trace = record()
      trace.query = kind
      for (const stop of [...STOPS, 'blocked'] satisfies TraceStop[]) {
        const copy = TRACE_COPY[stop]
        expect(copy.title.length).toBeLessThanOrEqual(28)
        expect(copy.line(trace).length).toBeLessThanOrEqual(90)
        expect(copy.hint.length).toBeLessThanOrEqual(60)
      }
    })
  }
})

function uiContext(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 1.85,
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

describe('trace UI spine', () => {
  it('keeps the entry permanent, offers six statements, and restores its knobs', () => {
    const dom = installTestDom()
    for (const id of [
      'tour-layer',
      'canvas-root',
      'hud-top',
      'hud-bottom',
      'toast-stack',
      'compass',
    ]) dom.mount(id)
    window.localStorage.setItem('pgsimcity.seen', '1')

    const ctx = uiContext()
    ctx.sim.setKnob('tps', 77)
    ctx.sim.setKnob('timeScale', 0.5)
    const hud = createHud(ctx)
    const tour = createTour(ctx)

    const open = document.querySelector<HTMLButtonElement>('.hud-trace-open')!
    expect(open.textContent).toContain('Run a query')
    open.click()

    const picker = document.querySelector<HTMLElement>('.trace-picker')!
    expect(picker.hidden).toBe(false)
    const choices = document.querySelectorAll<HTMLButtonElement>('.trace-picker__choice')
    expect(choices).toHaveLength(6)
    choices[4].click()

    expect(ctx.sim.state.knobs.tps).toBe(18)
    expect(ctx.sim.state.knobs.timeScale).toBe(0.05)
    expect(document.querySelector('.tour-narrate__stretch')?.textContent).toContain('2,000×')

    for (let tick = 0; tick < 900; tick++) {
      ctx.sim.update(1 / 30)
      tour.update(0.1, 0.54)
      hud.update(0.1, 0.54)
      if (ctx.sim.state.trace.stop === 'done') break
    }
    for (let frame = 0; frame < 5; frame++) {
      tour.update(0.1, 0.54)
      hud.update(0.1, 0.54)
    }

    expect(document.querySelector('.tour-narrate__title')?.textContent).toBe('The trip is complete')
    expect(document.querySelector<HTMLButtonElement>('.tour-narrate__again')?.hidden).toBe(false)
    expect(document.querySelectorAll('.hud-trace__stop.is-visited')).toHaveLength(8)

    document.querySelector<HTMLButtonElement>('.tour-narrate__close')!.click()
    expect(ctx.sim.state.knobs.tps).toBe(77)
    expect(ctx.sim.state.knobs.timeScale).toBe(0.5)

    tour.dispose()
    hud.dispose()
  })
})
