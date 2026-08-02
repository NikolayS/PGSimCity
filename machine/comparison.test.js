import { describe, expect, it } from 'vitest'

import {
  comparisonSnapshot,
  createSynchronousCommitComparison,
} from './comparison.js'

const WRITE_REPORT = Object.freeze({
  source: 'postgres',
  sql: 'UPDATE accounts SET updated_at = updated_at WHERE id = 42;',
  error: null,
  results: [{
    source: 'postgres',
    fields: [],
    rows: [],
    affectedRows: 1,
  }],
  plan: {
    source: 'postgres',
    planningTimeMs: 0.3,
    executionTimeMs: 1.4,
    buffers: {
      source: 'postgres',
      sharedHits: 5,
      sharedReads: 0,
    },
    root: {
      nodeType: 'ModifyTable',
      operation: 'Update',
      actualRows: 0,
      actualLoops: 1,
    },
  },
})

describe('Machine synchronous_commit modelled replay', () => {
  it('holds one PostgreSQL execution fixed and models both commit policies', () => {
    const comparison = createSynchronousCommitComparison(WRITE_REPORT)
    const [control, treatment] = comparison.lanes

    expect(comparison).not.toHaveProperty('changed')
    expect(comparison.modelledSetting).toBe('synchronous_commit')
    expect(control.setting).toEqual({ synchronous_commit: 'on' })
    expect(treatment.setting).toEqual({ synchronous_commit: 'off' })
    expect(control.replay.sql).toBe(treatment.replay.sql)
    expect(control.replay.receipt).toBe(treatment.replay.receipt)
    expect(control.replay.stages.filter((stage) => !['commit', 'return'].includes(stage.id)))
      .toEqual(treatment.replay.stages.filter((stage) => !['commit', 'return'].includes(stage.id)))

    const controlCommit = control.replay.stages.find((stage) => stage.id === 'commit')
    const treatmentCommit = treatment.replay.stages.find((stage) => stage.id === 'commit')
    const controlReturn = control.replay.stages.find((stage) => stage.id === 'return')
    const treatmentReturn = treatment.replay.stages.find((stage) => stage.id === 'return')
    expect(controlCommit.source).toBe('model')
    expect(treatmentCommit.source).toBe('model')
    expect(treatmentCommit.durationMs).toBeLessThan(controlCommit.durationMs)
    expect(treatmentCommit.flushContinuesAfterAck).toBe(true)
    expect(treatmentCommit.backgroundFlushDurationMs).toBe(controlCommit.durationMs)
    expect(treatmentCommit.measurement).toMatch(/recent ACKs at risk until flush/i)
    expect(treatment.replay.acknowledgementOrigin).toBe('wal_buffers')
    expect(treatmentReturn.clientReturnDurationMs).toBe(controlReturn.durationMs)
    expect(treatmentReturn.clientReturnDurationMs)
      .toBeLessThan(treatment.replay.backgroundFlushDurationMs)
  })

  it('names the finding at the first aligned moment the runs diverge', () => {
    const comparison = createSynchronousCommitComparison(WRITE_REPORT)
    const snapshot = comparisonSnapshot(comparison, comparison.observationAtMs)

    expect(snapshot.lanes.map((lane) => lane.stage.id)).toEqual(['commit', 'return'])
    expect(snapshot.findingVisible).toBe(true)
    expect(comparison.finding).toMatch(/acknowledges before the local WAL flush/i)
    expect(comparison.finding).toMatch(/WAL still flushes/i)
    expect(comparison.finding).toMatch(/crash can lose acknowledged commits/i)
    expect(comparison.finding).toMatch(/roughly 3.*wal_writer_delay/i)
    expect(comparison.finding).toMatch(/transactions stay atomic/i)
    expect(comparison.finding).toMatch(/not fsync\s*=\s*off/i)
    expect(comparison.replayDisclosure).toMatch(/not SET or re-executed in PGlite/i)
    expect(comparison.evidenceSource).toBe('model')
  })

  it('finishes the deferred WAL flush before the off lane ends', () => {
    const comparison = createSynchronousCommitComparison(WRITE_REPORT)
    const treatmentReplay = comparison.lanes[1].replay
    const commitIndex = treatmentReplay.stages.findIndex((stage) => stage.id === 'commit')
    const commitStage = treatmentReplay.stages[commitIndex]
    const ackAtMs = treatmentReplay.stages
      .slice(0, commitIndex + 1)
      .reduce((total, stage) => total + (stage.skipped ? 0 : stage.durationMs), 0)
    const flushCompletesAtMs = ackAtMs + commitStage.backgroundFlushDurationMs

    expect(flushCompletesAtMs).toBeLessThan(treatmentReplay.durationMs)
    expect(comparisonSnapshot(comparison, flushCompletesAtMs).lanes[1]).toMatchObject({
      stage: { id: 'return' },
      complete: false,
    })
  })
})
