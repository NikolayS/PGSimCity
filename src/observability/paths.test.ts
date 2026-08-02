import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { DEFAULT_KNOBS } from '../core/types'
import type { Knobs, SimApi, SimState } from '../core/types'
import { createSim } from '../sim/model'
import { SCENARIOS } from '../sim/scenarios'
import { createCollector } from './collector'
import type { Collector } from './collector'
import { ALL_STEPS, ALL_VERDICTS, NODES, SYMPTOMS } from './paths'
import { activityWaitCounts, PROJECTIONS, PROJECTION_SOURCES } from './views'

const INTENDED_VERDICT = {
  slow: 'v.saturation',
  stall: 'v.ckpt_storm',
  bloat: 'v.xmin',
  reads: 'v.backend_writes',
  blocked: 'v.lock_holder',
  replica: 'v.replay',
  commit: 'v.sync_remote',
  normal: 'v.baseline',
} as const

function stage(
  sim: SimApi,
  scenarioId: string | null,
  stageKnobs: Partial<Knobs> = {},
): void {
  const scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId)
  expect(scenario, `missing scenario ${scenarioId}`).toBeDefined()
  for (const [key, value] of Object.entries(DEFAULT_KNOBS)) {
    if (key === 'timeScale' || key === 'paused') continue
    sim.setKnob(key as keyof Knobs, value as Knobs[keyof Knobs])
  }
  for (const [key, value] of Object.entries(scenario!.knobs)) {
    if (value !== undefined) sim.setKnob(key as keyof Knobs, value as Knobs[keyof Knobs])
  }
  for (const [key, value] of Object.entries(stageKnobs)) {
    if (value !== undefined) sim.setKnob(key as keyof Knobs, value as Knobs[keyof Knobs])
  }
}

function advance(sim: SimApi, collector: Collector, seconds: number): void {
  const dt = 1 / 30
  const steps = Math.round(seconds / dt)
  for (let index = 0; index < steps; index++) {
    sim.update(dt)
    if (index % 3 === 0) collector.sample()
  }
  collector.sample()
}

function settle(
  sim: SimApi,
  collector: Collector,
  ready: (state: SimState) => boolean,
): void {
  const dt = 1 / 30
  const steps = Math.round(30 / dt)
  for (let index = 0; index < steps && !ready(sim.state); index++) {
    sim.update(dt)
    if (index % 3 === 0) collector.sample()
  }
  collector.sample()
}

function stagedPath(symptomId: keyof typeof INTENDED_VERDICT) {
  const symptom = SYMPTOMS.find((candidate) => candidate.id === symptomId)
  expect(symptom, `missing symptom ${symptomId}`).toBeDefined()
  const sim = createSim(createBus())
  const collector = createCollector(sim)
  stage(sim, 'steady-state')
  collector.reset()
  advance(sim, collector, 60)
  stage(sim, symptom!.scenario, symptom!.stageKnobs)
  collector.reset()
  advance(sim, collector, symptom!.warmSeconds ?? 90)
  return { symptom: symptom!, sim, collector }
}

function reachableVerdicts(
  entry: string,
  sim: SimApi,
  collector: Collector,
): Set<string> {
  const verdicts = new Set<string>()
  const visited = new Set<string>()

  const walk = (nodeId: string): void => {
    if (visited.has(nodeId)) return
    visited.add(nodeId)
    const node = NODES.get(nodeId)
    expect(node, `missing diagnostic node ${nodeId}`).toBeDefined()
    if (!node) return
    if (node.kind === 'verdict') {
      verdicts.add(node.id)
      return
    }
    if (node.settle) settle(sim, collector, node.settle)
    const matching = node.branches.filter((branch) => branch.test(sim.state, collector))
    expect(
      matching,
      `${node.id} has no reachable branch in its staged state`,
    ).not.toHaveLength(0)
    for (const branch of matching) walk(branch.next)
  }

  walk(entry)
  return verdicts
}

describe('diagnostic path contracts', () => {
  it('reports cost-based autovacuum sleeps as Timeout/VacuumDelay', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    sim.setKnob('tps', 450)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('updateRatio', 1)
    sim.setKnob('seqScanRatio', 0)

    let vacuumDelay = false
    for (let i = 0; i < 60 * 30 && !vacuumDelay; i++) {
      const phaseBefore = sim.state.autovac.workers.map((worker) => worker.phase)
      const progressBefore = sim.state.autovac.workers.map((worker) => worker.progress)
      sim.update(1 / 30)
      const delayedWorker = sim.state.autovac.workers.find((worker) => worker.vacuumDelay)
      if (!delayedWorker) continue
      expect(delayedWorker.phase).toBe(phaseBefore[delayedWorker.slot])
      expect(delayedWorker.progress).toBe(progressBefore[delayedWorker.slot])
      const rows = PROJECTIONS.activity(sim.state, collector, 'total').rows
      vacuumDelay = rows.some((row) => {
        const backendType = row.cells.backend_type
        const waitType = row.cells.wait_event_type
        const waitEvent = row.cells.wait_event
        return typeof backendType === 'object'
          && backendType.v === 'autovacuum worker'
          && typeof waitType === 'object'
          && waitType.v === 'Timeout'
          && typeof waitEvent === 'object'
          && waitEvent.v === 'VacuumDelay'
      })
    }

    expect(vacuumDelay).toBe(true)
  })

  it('buckets dirty-victim WAL durability waits as I/O, not commit waits', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    for (const candidate of sim.state.backends) {
      candidate.active = false
      candidate.state = 'free'
    }
    const backend = sim.state.backends[0]
    backend.active = true
    backend.state = 'eviction_flush'

    expect(activityWaitCounts(sim.state, collector)).toMatchObject({
      total: 1,
      io: 1,
      commit: 0,
    })

    const commitStep = ALL_STEPS.find((step) => step.id === 'commit.1')
    const localWalSync = commitStep?.branches.find((branch) => branch.next === 'v.sync_local')
    const noWait = commitStep?.branches.find((branch) => branch.next === 'v.commit_ok')
    expect(localWalSync?.test(sim.state, collector)).toBe(true)
    expect(noWait?.test(sim.state, collector)).toBe(false)
  })

  it('keeps every staged path connected to its intended verdict', () => {
    for (const symptomId of Object.keys(INTENDED_VERDICT) as (keyof typeof INTENDED_VERDICT)[]) {
      const { symptom, sim, collector } = stagedPath(symptomId)
      const reachable = reachableVerdicts(symptom.entry, sim, collector)
      expect.soft(
        reachable,
        `${symptomId} reached ${[...reachable].join(', ') || 'no verdict'}`,
      ).toContain(INTENDED_VERDICT[symptomId])
    }
  }, 15_000)

  it('reads per-standby branch facts from the same rows as pg_stat_replication', () => {
    for (const step of ALL_STEPS) {
      for (const branch of step.branches) {
        expect(branch.source, `${step.id}: ${branch.label}`).toBe(
          PROJECTION_SOURCES[step.projection],
        )
      }
    }

    const { sim, collector } = stagedPath('replica')
    const rows = PROJECTIONS.replication(sim.state, collector, 'total').rows
    expect(rows.map((row) => row.key)).toEqual(['standbyA', 'standbyB'])
    expect(rows.find((row) => row.key === 'standbyB')?.cells.behind).not.toEqual({
      v: '0 B',
      tone: 'ok',
    })

    const step = NODES.get('replica.1')
    expect(step?.kind).toBe('step')
    if (!step || step.kind !== 'step') return
    expect(step.branches.find((branch) => branch.next === 'v.replay')?.test(sim.state, collector)).toBe(true)
    expect(step.branches.find((branch) => branch.next === 'v.rep_ok')?.test(sim.state, collector)).toBe(false)
  })

  it('reports baseline health from the worst connected standby beside the two-row grid', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const [standbyA, standbyB] = sim.state.replication.standbys
    standbyA.lagBytes = 0
    standbyA.lagSec = 0
    standbyB.lagBytes = 17 * 1024 * 1024
    standbyB.lagSec = 4.25
    const baseline = ALL_VERDICTS.find((verdict) => verdict.id === 'v.baseline')

    const evidence = baseline?.evidence(sim.state, collector)
    const grid = PROJECTIONS.replication(sim.state, collector, 'total')

    expect(grid.rows.find((row) => row.key === 'standbyB')?.cells.behind).toMatchObject({ v: '17.0 MiB' })
    expect(evidence?.find((item) => item.label === 'worst connected standby')?.value).toBe('standby_b')
    expect(evidence?.find((item) => item.label === 'model replay delay')?.value).toBe('4.25 s')
  })

  it('stages a genuinely healthy cache reading for the baseline lesson', () => {
    const { sim, collector } = stagedPath('normal')
    const row = PROJECTIONS.database(sim.state, collector, 'total').rows[0]
    const cell = row.cells.hit_ratio
    const displayed = Number.parseFloat(typeof cell === 'string' ? cell : cell.v)

    expect(sim.state.stats.cacheHitPct).toBeGreaterThanOrEqual(95)
    expect(displayed).toBeGreaterThanOrEqual(95)
  })
})
