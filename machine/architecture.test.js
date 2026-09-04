import { describe, expect, it } from 'vitest'

import {
  ARCHITECTURE_LAYOUT,
  STATEMENT_EXECUTOR_RETURN_ROUTE,
  activeStatementStageIndex,
  bufferAccessSummary,
  contains,
  createStatementReplay,
  nextStatementStageIndex,
  statementReturnRouteId,
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
  const resultOnly = () => createStatementReplay({
    ...REPORT,
    sql: 'SELECT 1;',
    plan: {
      ...REPORT.plan,
      buffers: { source: 'postgres', sharedHits: 0, sharedReads: 0 },
      root: { nodeType: 'Result', actualRows: 1, actualLoops: 1 },
    },
  })

  it('skips unsupported shared-buffer access for a measured Result-only query', () => {
    const replay = resultOnly()
    expect(replay.stages.filter((stage) => stage.skipped).map((stage) => stage.id))
      .toEqual(['buffer', 'kernel', 'disk'])
    const executeIndex = replay.stages.findIndex((stage) => stage.id === 'execute')
    expect(replay.stages[nextStatementStageIndex(replay, executeIndex)].id).toBe('return')
    const throughExecution = replay.stages.slice(0, executeIndex + 1)
      .reduce((sum, stage) => sum + stage.durationMs, 0)
    expect(replay.stages[activeStatementStageIndex(replay, throughExecution)].id).toBe('return')
  })

  it('returns a measured no-shared-access result directly from the executor', () => {
    expect(statementReturnRouteId(resultOnly())).toBe('returnFromExecutor')
    expect(STATEMENT_EXECUTOR_RETURN_ROUTE[0]).toEqual([600, 211])
    expect(STATEMENT_EXECUTOR_RETURN_ROUTE.at(-1)).toEqual([124, 128])
    expect(Math.max(...STATEMENT_EXECUTOR_RETURN_ROUTE.map((point) => point[1])))
      .toBeLessThan(ARCHITECTURE_LAYOUT.sharedMemory.y)
  })

  it.each([[1, 0, 'returnFromBuffer'], [0, 1, 'returnFromDisk'], [12, 3, 'returnFromDisk']])(
    'preserves the measured route for %i hits and %i reads', (sharedHits, sharedReads, route) => {
      const replay = createStatementReplay({
        ...REPORT,
        plan: { ...REPORT.plan, buffers: { sharedHits, sharedReads }, root: { nodeType: 'Result' } },
      })
      expect(replay.stages.find((stage) => stage.id === 'buffer').skipped).toBe(false)
      expect(statementReturnRouteId(replay)).toBe(route)
    },
  )

  it.each([null, {}, { sharedHits: 0 }, { sharedHits: 0, sharedReads: NaN }])(
    'does not treat unavailable counters as measured zero: %j', (buffers) => {
      const replay = createStatementReplay({ ...REPORT, plan: { ...REPORT.plan, buffers } })
      const stage = replay.stages.find((stage) => stage.id === 'buffer')
      expect(stage.skipped).toBe(false)
      expect(stage.source).toBe('model')
      expect(stage.measurement).toBe('buffer counts unavailable')
      expect(statementReturnRouteId(replay)).toBe('returnFromBuffer')
    },
  )

  it.each(['on', 'off'])('preserves the modelled write return path with synchronous_commit=%s', (setting) => {
    const replay = createStatementReplay({
      ...REPORT,
      plan: { ...REPORT.plan, root: { nodeType: 'ModifyTable', operation: 'Update' } },
    })
    expect(statementReturnRouteId({ ...replay, synchronousCommit: setting }))
      .toBe(setting === 'off' ? 'returnFromWal' : 'returnFromCommit')
  })

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
