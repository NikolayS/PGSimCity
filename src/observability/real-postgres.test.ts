import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CLAIM_VALUES } from '../core/claims'
import type { RealPostgresSource } from './real-postgres'
import {
  cityRelationForPlan,
  parseExplainJson,
} from './real-postgres'
import { createPgliteSource } from './real-postgres-runtime'

const EXPLAIN_FIXTURE = [
  {
    Plan: {
      'Node Type': 'Aggregate',
      'Startup Cost': 18.2,
      'Total Cost': 18.21,
      'Plan Rows': 1,
      'Actual Rows': 1,
      'Actual Loops': 1,
      'Actual Total Time': 0.181,
      'Shared Hit Blocks': 7,
      'Shared Read Blocks': 2,
      Plans: [
        {
          'Node Type': 'Bitmap Heap Scan',
          'Relation Name': 'orders',
          Alias: 'orders',
          'Startup Cost': 4.2,
          'Total Cost': 17.9,
          'Plan Rows': 12,
          'Actual Rows': 9,
          'Actual Loops': 1,
          'Actual Total Time': 0.15,
          'Shared Hit Blocks': 7,
          'Shared Read Blocks': 2,
        },
      ],
    },
    'Planning Time': 0.31,
    'Execution Time': 0.24,
  },
]

describe('real PostgreSQL plan data', () => {
  it('keeps real plan values and provenance in a layout-free record', () => {
    const plan = parseExplainJson(EXPLAIN_FIXTURE)

    expect(plan.source).toBe('postgres')
    expect(plan.planningTimeMs).toBe(0.31)
    expect(plan.executionTimeMs).toBe(0.24)
    expect(plan.buffers).toEqual({
      source: 'postgres',
      sharedHits: 7,
      sharedReads: 2,
    })
    expect(plan.root.nodeType).toBe('Aggregate')
    expect(plan.root.children[0]).toMatchObject({
      nodeType: 'Bitmap Heap Scan',
      relationName: 'orders',
      planRows: 12,
      actualRows: 9,
      sharedHits: 7,
      sharedReads: 2,
    })
  })

  it('maps the real plan to the closest city relation and model grammar', () => {
    const plan = parseExplainJson(EXPLAIN_FIXTURE)

    expect(cityRelationForPlan(plan, 'SELECT count(*) FROM orders')).toEqual({
      kind: 'aggregate',
      relation: 'orders',
    })
  })
})

describe.sequential('PGlite source', () => {
  let source: RealPostgresSource

  beforeAll(async () => {
    source = await createPgliteSource(parseExplainJson)
  }, 30_000)

  afterAll(async () => {
    await source.close()
  })

  it('seeds the five city relations and returns real results and a real plan', async () => {
    expect(source.serverVersion).toBe(CLAIM_VALUES.pgliteVersion.postgresqlVersion)
    expect(source.versionText).toMatch(
      new RegExp(`^${CLAIM_VALUES.pgliteVersion.reportedPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    )

    const catalog = await source.query(
      `SELECT tablename
       FROM pg_catalog.pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename`,
    )

    expect(catalog.error).toBeNull()
    expect(catalog.results.at(-1)?.rows.map((row) => row.tablename)).toEqual([
      'accounts',
      'documents',
      'events',
      'orders',
      'sessions',
    ])

    const report = await source.query('SELECT id, balance FROM accounts WHERE id = 42')

    expect(report.source).toBe('postgres')
    expect(report.error).toBeNull()
    expect(report.results[0]?.rows).toEqual([{ id: 42, balance: '1042.00' }])
    expect(report.plan?.source).toBe('postgres')
    expect(report.plan?.root.actualRows).toBe(1)
    expect(report.plan?.root.nodeType).toMatch(/Index/)
  }, 30_000)

  it('returns PostgreSQL syntax and catalog errors with their SQLSTATEs', async () => {
    const syntax = await source.query('SELEC 1')
    const missing = await source.query('SELECT * FROM table_that_does_not_exist')

    expect(syntax.error).toMatchObject({
      source: 'postgres',
      severity: 'ERROR',
      code: '42601',
    })
    expect(syntax.error?.message).toMatch(/syntax error/i)
    expect(missing.error).toMatchObject({
      source: 'postgres',
      severity: 'ERROR',
      code: '42P01',
    })
    expect(missing.error?.message).toContain('table_that_does_not_exist')
  })

  it('executes a submitted statement exactly once', async () => {
    const sequenceName = 'review2_execution_proof'
    await source.query(`CREATE SEQUENCE ${sequenceName}`)

    const next = await source.query(
      `SELECT nextval('${sequenceName}') AS next_value`,
    )
    const last = await source.query(
      `SELECT last_value FROM ${sequenceName}`,
    )

    expect(Number(next.results[0]?.rows[0]?.next_value)).toBe(1)
    expect(Number(last.results[0]?.rows[0]?.last_value)).toBe(1)
  })

  it('uses the analyzed DML execution for both its result count and visible state', async () => {
    await source.query('CREATE TABLE review2_dml_proof (value integer NOT NULL)')

    const insert = await source.query('INSERT INTO review2_dml_proof VALUES (1)')
    const update = await source.query(
      'UPDATE review2_dml_proof SET value = value + 1',
    )
    const state = await source.query('SELECT value FROM review2_dml_proof')

    expect(insert.error).toBeNull()
    expect(insert.results[0]?.affectedRows).toBe(1)
    expect(update.error).toBeNull()
    expect(update.results[0]?.affectedRows).toBe(1)
    expect(state.results[0]?.rows).toEqual([{ value: 2 }])
  })
})
