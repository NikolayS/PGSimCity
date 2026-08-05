import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { renderAction } from '../core/actions'
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
  disk: 'v.slot_retention',
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
  it('makes a missing synchronous standby actionable from the registered remedy', () => {
    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.sync_remote')!

    expect(verdict.fix).toBe(renderAction('restoreSynchronousCommitAvailability'))
    expect(verdict.fix).toMatch(
      /enable and repair the named standby|name another streaming standby|clear synchronous_standby_names|synchronous_commit=local/is,
    )
    expect(verdict.knobs.map(({ key }) => key)).toEqual(expect.arrayContaining([
      'synchronousCommit',
      'synchronousStandbyNames',
      'standbyAEnabled',
      'standbyBEnabled',
    ]))
  })

  it('reports the observed row-lock wait mode without turning it into DDL', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    sim.state.locks.push({
      holder: 0,
      waiter: 1,
      table: 0,
      mode: 'ShareLock',
      ageSec: 7,
    })
    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.lock_holder')!
    const copy = [verdict.title, verdict.because, verdict.mechanism, verdict.fix].join('\n')

    expect(verdict.evidence(sim.state, collector)).toContainEqual(
      expect.objectContaining({ label: 'waited mode', value: 'ShareLock' }),
    )
    expect(copy).not.toMatch(/holds an ACCESS EXCLUSIVE lock|this is DDL/i)
    expect(verdict.fix).toMatch(/end the holder.*transaction/is)
    expect(verdict.fix).toMatch(/AccessExclusiveLock.*DDL.*lock_timeout/is)
    const control = verdict.knobs.find((knob) => knob.key === 'lockContention')!
    expect(control.guc).toBe('an open blocking transaction')
    expect(control.help).toMatch(/row-conflict waits.*transactions.*deadlocks/is)
    expect(control.help).toMatch(/AccessExclusiveLock.*DDL.*lock_timeout/is)
  })

  it('routes a filling disk through replication-slot retention evidence', () => {
    const symptom = SYMPTOMS.find((candidate) => candidate.id === 'disk')
    expect(symptom).toBeDefined()
    const step = symptom ? NODES.get(symptom.entry) : undefined
    expect(step?.kind).toBe('step')
    if (!step || step.kind !== 'step') return

    expect(step.projection).toBe('slots')
    expect(step.sql).toMatch(/wal_status[\s\S]*safe_wal_size[\s\S]*max_slot_wal_keep_size/i)
    expect(step.sqlCompatibility).toMatchObject({ from: 18 })
    expect(step.sqlCompatibility?.alternatives).toContainEqual(
      expect.objectContaining({ from: 17, to: 17 }),
    )

    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const slot = sim.state.replication.physicalSlots[1]
    slot.active = false
    slot.retainedBytes = 128 * 1024 * 1024
    slot.restartLsn = sim.state.wal.insertLsn - slot.retainedBytes
    const retention = step.branches.find((branch) => branch.next === 'v.slot_retention')
    expect(retention?.test(sim.state, collector)).toBe(true)
    slot.active = true
    expect(retention?.test(sim.state, collector)).toBe(true)

    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.slot_retention')!
    const copy = [verdict.because, verdict.mechanism, verdict.fix].join('\n')
    expect(copy).toMatch(/reserved.*extended.*unreserved.*lost/is)
    expect(verdict.fix).toMatch(/dropping.*does not delete.*WAL/is)
    expect(verdict.fix).toMatch(/base backup.*only.*unavailable.*every source/is)
  })

  it('states that checkpoint-counter correlation narrows rather than concludes', () => {
    const step = ALL_STEPS.find((candidate) => candidate.id === 'stall.2')!
    const branch = step.branches.find((candidate) => candidate.next === 'v.ckpt_storm')!
    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.ckpt_storm')!

    expect(branch.label).toMatch(/narrows/i)
    expect(branch.label).toMatch(/does not (?:establish|conclude)/i)
    expect(verdict.because).toMatch(/counters alone neither establish/i)
  })

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
    expect(step.branches.find((branch) => branch.next === 'replica.replay-state')?.test(sim.state, collector)).toBe(true)
    expect(step.branches.find((branch) => branch.next === 'v.rep_ok')?.test(sim.state, collector)).toBe(false)
    const replayState = NODES.get('replica.replay-state')
    expect(replayState?.kind).toBe('step')
    if (!replayState || replayState.kind !== 'step') return
    expect(replayState.branches.find((branch) => branch.next === 'v.replay')?.test(sim.state, collector)).toBe(true)
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

  it('does not mistake a small client workload for exhausted PostgreSQL capacity', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    sim.setKnob('clientConnections', 4)
    for (let index = 0; index < sim.state.backends.length; index++) {
      const backend = sim.state.backends[index]
      backend.active = index < 4
      backend.state = index < 4 ? 'exec_cpu' : 'free'
    }
    sim.state.stats.activeBackends = 4
    sim.state.pooler.serverCapacity = 4

    const slow = ALL_STEPS.find((step) => step.id === 'slow.1')
    const saturation = slow?.branches.find((branch) => branch.next === 'v.saturation')
    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.saturation')

    expect(saturation?.test(sim.state, collector)).toBe(false)
    expect(verdict?.evidence(sim.state, collector)).toContainEqual(
      expect.objectContaining({ label: 'PostgreSQL backends', value: '4 of 16' }),
    )
    expect(verdict?.resolved?.(sim.state, collector).ok).toBe(true)

    for (const backend of sim.state.backends) {
      backend.active = false
      backend.state = 'free'
    }
    sim.state.stats.activeBackends = 0
    sim.state.pooler.serverCapacity = 1
    expect(saturation?.test(sim.state, collector)).toBe(false)
  })
})
