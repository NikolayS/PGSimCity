import { describe, expect, it } from 'vitest'

import {
  ARCHITECTURE_LAYOUT,
  activeStatementStageIndex,
  bufferAccessSummary,
  contains,
  createStatementReplay,
  nextStatementStageIndex,
} from './architecture.js'

describe('Machine measured buffer access', () => {
  it.each([
    [0, 0, 'none', 'NO SHARED-BUFFER ACCESSES REPORTED'],
    [1, 0, 'hit', 'ALL HIT IN SHARED_BUFFERS'],
    [0, 1, 'read', 'READ BELOW SHARED_BUFFERS'],
    [12, 3, 'read', 'READ BELOW SHARED_BUFFERS'],
  ])('describes %i hits and %i reads', (sharedHits, sharedReads, reach, description) => {
    expect(bufferAccessSummary({ sharedHits, sharedReads })).toEqual({
      reach,
      text: `P MEASURED · HIT ${sharedHits} · READ ${sharedReads} · ${description}`,
    })
  })
})

const REPORT = Object.freeze({
  source: 'postgres',
  sql: 'SELECT * FROM accounts WHERE id = 42;',
  error: null,
  results: [
    {
      source: 'postgres',
      fields: [{ name: 'id', dataTypeId: 23 }],
      rows: [{ id: 42 }],
      affectedRows: null,
    },
  ],
  plan: {
    source: 'postgres',
    planningTimeMs: 0.35,
    executionTimeMs: 1.8,
    buffers: {
      source: 'postgres',
      sharedHits: 12,
      sharedReads: 3,
    },
    root: {
      nodeType: 'Index Scan',
      actualRows: 1,
      actualLoops: 1,
    },
  },
})

describe('Magnum PostgreSQL architecture containment', () => {
  it('puts every shared structure inside one visible shared-memory segment', () => {
    const { sharedMemory, bufferPool, walBuffers, procArray, lockTable, pgXact } =
      ARCHITECTURE_LAYOUT

    expect([
      bufferPool,
      walBuffers,
      procArray,
      lockTable,
      pgXact,
    ].every((box) => contains(sharedMemory, box))).toBe(true)
  })

  it('keeps backend-private memory outside shared memory', () => {
    const { sharedMemory, privateMemory } = ARCHITECTURE_LAYOUT

    expect(contains(sharedMemory, privateMemory)).toBe(false)
    expect(privateMemory.y + privateMemory.height).toBeLessThan(sharedMemory.y)
  })
})

describe('Magnum statement replay', () => {
  it('turns the submitted SQL and its EXPLAIN report into one ordered trip', () => {
    const replay = createStatementReplay(REPORT)

    expect(replay.sql).toBe(REPORT.sql)
    expect(replay.stages.map((stage) => stage.id)).toEqual([
      'client',
      'backend',
      'parse',
      'rewrite',
      'plan',
      'execute',
      'buffer',
      'kernel',
      'disk',
      'return',
    ])
    expect(replay.stages.find((stage) => stage.id === 'buffer')?.measurement).toBe(
      '12 hits · 3 reads',
    )
    expect(replay.stages.find((stage) => stage.id === 'disk')?.source).toBe('model')
  })

  it('leaves a receipt containing the measured PostgreSQL values unchanged', () => {
    const replay = createStatementReplay(REPORT)

    expect(replay.receipt).toEqual({
      source: 'postgres',
      sharedHits: 12,
      sharedReads: 3,
      planningTimeMs: 0.35,
      executionTimeMs: 1.8,
      rows: 1,
      rowLabel: 'RESULT ROWS',
      planNode: 'Index Scan',
    })
  })

  it('uses the command result count for DML rather than ModifyTable output tuples', () => {
    const replay = createStatementReplay({
      ...REPORT,
      sql: 'UPDATE accounts SET balance = balance + 1 WHERE id = 42;',
      results: [{
        source: 'postgres',
        fields: [],
        rows: [],
        affectedRows: 1,
      }],
      plan: {
        ...REPORT.plan,
        root: {
          nodeType: 'ModifyTable',
          operation: 'Update',
          actualRows: 0,
          actualLoops: 1,
        },
      },
    })

    expect(replay.receipt.rows).toBe(1)
    expect(replay.receipt.rowLabel).toBe('ROWS AFFECTED')
    expect(replay.stages.slice(-3).map((stage) => stage.id)).toEqual([
      'wal',
      'commit',
      'return',
    ])
    expect(replay.stages.find((stage) => stage.id === 'wal')?.source).toBe('model')
    expect(replay.stages.find((stage) => stage.id === 'commit')?.source).toBe('model')
    expect(replay.stages.find((stage) => stage.id === 'return')?.measurement).toBe(
      '1 row affected',
    )
  })

  it('skips the kernel and disk leg when PostgreSQL reports no shared reads', () => {
    const replay = createStatementReplay({
      ...REPORT,
      plan: {
        ...REPORT.plan,
        buffers: {
          source: 'postgres',
          sharedHits: 15,
          sharedReads: 0,
        },
      },
    })

    expect(
      replay.stages
        .filter((stage) => stage.skipped)
        .map((stage) => stage.id),
    ).toEqual(['kernel', 'disk'])
    expect(nextStatementStageIndex(replay, 6)).toBe(9)
  })

  it('uses measured planning versus execution time to weight the human-paced replay', () => {
    const replay = createStatementReplay(REPORT)
    const plan = replay.stages.find((stage) => stage.id === 'plan')
    const execute = replay.stages.find((stage) => stage.id === 'execute')

    expect(execute.durationMs).toBeGreaterThan(plan.durationMs)
    expect(activeStatementStageIndex(replay, 0)).toBe(0)
    expect(activeStatementStageIndex(replay, replay.durationMs)).toBe(9)
  })
})
