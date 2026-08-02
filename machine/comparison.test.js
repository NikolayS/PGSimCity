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

describe('Machine synchronous_commit experiment', () => {
  it('holds one PostgreSQL execution fixed and changes only the commit policy', () => {
    const comparison = createSynchronousCommitComparison(WRITE_REPORT)
    const [control, treatment] = comparison.lanes

    expect(control.setting).toEqual({ synchronous_commit: 'on' })
    expect(treatment.setting).toEqual({ synchronous_commit: 'off' })
    expect(control.replay.sql).toBe(treatment.replay.sql)
    expect(control.replay.receipt).toBe(treatment.replay.receipt)
    expect(control.replay.stages.filter((stage) => stage.id !== 'commit'))
      .toEqual(treatment.replay.stages.filter((stage) => stage.id !== 'commit'))

    const controlCommit = control.replay.stages.find((stage) => stage.id === 'commit')
    const treatmentCommit = treatment.replay.stages.find((stage) => stage.id === 'commit')
    expect(controlCommit.source).toBe('model')
    expect(treatmentCommit.source).toBe('model')
    expect(treatmentCommit.durationMs).toBeLessThan(controlCommit.durationMs)
    expect(treatmentCommit.flushContinuesAfterAck).toBe(true)
    expect(treatmentCommit.backgroundFlushDurationMs).toBe(controlCommit.durationMs)
    expect(treatment.replay.acknowledgementOrigin).toBe('wal_buffers')
  })

  it('names the finding at the first aligned moment the runs diverge', () => {
    const comparison = createSynchronousCommitComparison(WRITE_REPORT)
    const snapshot = comparisonSnapshot(comparison, comparison.observationAtMs)

    expect(snapshot.lanes.map((lane) => lane.stage.id)).toEqual(['commit', 'return'])
    expect(snapshot.findingVisible).toBe(true)
    expect(comparison.finding).toMatch(/acknowledges before the local WAL flush/i)
    expect(comparison.finding).toMatch(/WAL still flushes/i)
    expect(comparison.evidenceSource).toBe('model')
  })
})
