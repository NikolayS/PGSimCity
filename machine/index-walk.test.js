import { describe, expect, it } from 'vitest'

import { parseExplainJson } from '../src/observability/real-postgres.ts'
import { createPgliteSource } from '../src/observability/real-postgres-runtime.ts'

import {
  INDEX_WALK_CLAIM,
  INDEX_WALK_STEPS,
  createIndexWalkEvidence,
  indexWalkFinding,
  matchingIndexWalkStep,
} from './index-walk.js'

function report({
  sql,
  nodeType,
  indexName = null,
  rows = [{ id: 42, balance: '1042.00' }],
  hits = 0,
  reads = 0,
}) {
  return {
    source: 'postgres',
    sql,
    error: null,
    results: [{
      source: 'postgres',
      fields: Object.keys(rows[0] ?? {}).map((name) => ({ name, dataTypeId: 25 })),
      rows,
      affectedRows: null,
    }],
    plan: {
      source: 'postgres',
      planningTimeMs: 0.1,
      executionTimeMs: 0.2,
      buffers: { source: 'postgres', sharedHits: hits, sharedReads: reads },
      root: {
        nodeType,
        operation: null,
        relationName: nodeType.includes('Scan') ? 'accounts' : null,
        alias: nodeType.includes('Scan') ? 'accounts' : null,
        indexName,
        actualRows: rows.length,
        actualLoops: 1,
        children: [],
      },
    },
  }
}

describe('Machine first index walk', () => {
  it('orders one constant, one catalog read, and two comparable lookups', () => {
    expect(INDEX_WALK_STEPS.map((step) => step.id)).toEqual([
      'constant',
      'catalog',
      'indexed',
      'unindexed',
    ])
    expect(INDEX_WALK_STEPS[1].sql).toContain('pg_catalog.pg_class')
    expect(INDEX_WALK_STEPS[1].sql).toContain('pg_catalog.pg_index')
    expect(INDEX_WALK_STEPS[2].sql).toMatch(/WHERE id = 42/)
    expect(INDEX_WALK_STEPS[3].sql).toMatch(/WHERE owner = 'account-42'/)
  })

  it('reports every full index definition with its access method and validity', () => {
    const sql = INDEX_WALK_STEPS[1].sql

    expect(sql).toBe(INDEX_WALK_CLAIM.catalogSql)
    expect(sql).toMatch(/am\.amname AS access_method/)
    expect(sql).toMatch(/WHEN i\.indisvalid THEN 'valid'/)
    expect(sql).toMatch(/ELSE 'INVALID'/)
    expect(sql).toMatch(/pg_catalog\.pg_get_indexdef\(i\.indexrelid\) AS index_definition/)
    expect(sql).not.toMatch(/pg_get_indexdef\([^)]*,/)
    expect(sql).not.toMatch(/AND i\.indisvalid/)
    expect(sql).toMatch(/ORDER BY c\.relname/)
  })

  it('shows complete definitions for seeded PostgreSQL indexes', async () => {
    const source = await createPgliteSource(parseExplainJson)
    try {
      const catalog = await source.query(INDEX_WALK_STEPS[1].sql)

      expect(catalog.error).toBeNull()
      expect(catalog.results.at(-1)?.rows).toEqual([
        {
          index_name: 'accounts_balance_updated_cover_idx',
          access_method: 'btree',
          validity: 'valid',
          index_definition: 'CREATE INDEX accounts_balance_updated_cover_idx ON public.accounts USING btree (balance, updated_at) INCLUDE (owner)',
        },
        {
          index_name: 'accounts_lower_owner_idx',
          access_method: 'btree',
          validity: 'valid',
          index_definition: 'CREATE INDEX accounts_lower_owner_idx ON public.accounts USING btree (lower(owner))',
        },
        {
          index_name: 'accounts_pkey',
          access_method: 'btree',
          validity: 'valid',
          index_definition: 'CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id)',
        },
      ])

      const unindexed = await source.query(INDEX_WALK_STEPS[3].sql)
      expect(unindexed.error).toBeNull()
      expect(unindexed.plan?.root.nodeType).toBe('Seq Scan')
    } finally {
      await source.close()
    }
  }, 30_000)

  it('recognizes a reader-owned SELECT 1 as the first measured step', () => {
    const first = report({ sql: '  SELECT 1; ', nodeType: 'Result', rows: [{ '?column?': 1 }] })

    expect(matchingIndexWalkStep(first)).toBe('constant')
    expect(createIndexWalkEvidence('constant', first)).toEqual({
      source: 'postgres',
      stepId: 'constant',
      node: 'Result',
      index: null,
      rows: 1,
      sharedHits: 0,
      sharedReads: 0,
      summary: 'Result · 1 row · hit 0 / read 0',
    })
  })

  it('retains the catalog row and the access node from each later execution', () => {
    const catalog = report({
      sql: INDEX_WALK_STEPS[1].sql,
      nodeType: 'Nested Loop',
      rows: [{
        index_name: 'accounts_pkey',
        access_method: 'btree',
        validity: 'valid',
        index_definition: 'CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id)',
      }],
      hits: 18,
    })
    const indexed = report({
      sql: INDEX_WALK_STEPS[2].sql,
      nodeType: 'Index Scan',
      indexName: 'accounts_pkey',
      hits: 3,
    })
    const unindexed = report({
      sql: INDEX_WALK_STEPS[3].sql,
      nodeType: 'Seq Scan',
      hits: 16,
    })

    expect(createIndexWalkEvidence('catalog', catalog).summary)
      .toBe('accounts_pkey · valid btree · 1 catalog row')
    expect(createIndexWalkEvidence('indexed', indexed).summary)
      .toBe('Index Scan · accounts_pkey · 1 row · hit 3 / read 0')
    expect(createIndexWalkEvidence('unindexed', unindexed).summary)
      .toBe('Seq Scan · 1 row · hit 16 / read 0')
  })

  it('states the finding only when all measured evidence supports it', () => {
    const evidence = [
      createIndexWalkEvidence('constant', report({
        sql: INDEX_WALK_STEPS[0].sql,
        nodeType: 'Result',
        rows: [{ answer: 1 }],
      })),
      createIndexWalkEvidence('catalog', report({
        sql: INDEX_WALK_STEPS[1].sql,
        nodeType: 'Nested Loop',
        rows: [{
          index_name: 'accounts_pkey',
          access_method: 'btree',
          validity: 'valid',
          index_definition: 'CREATE UNIQUE INDEX accounts_pkey ON public.accounts USING btree (id)',
        }],
      })),
      createIndexWalkEvidence('indexed', report({
        sql: INDEX_WALK_STEPS[2].sql,
        nodeType: 'Index Scan',
        indexName: 'accounts_pkey',
        hits: 3,
      })),
      createIndexWalkEvidence('unindexed', report({
        sql: INDEX_WALK_STEPS[3].sql,
        nodeType: 'Seq Scan',
        hits: 16,
      })),
    ]

    expect(indexWalkFinding(evidence)).toEqual({
      supported: true,
      text: INDEX_WALK_CLAIM.finding,
    })
    expect(indexWalkFinding(evidence.slice(0, 3))).toEqual({
      supported: false,
      text: INDEX_WALK_CLAIM.incomplete,
    })
  })
})
