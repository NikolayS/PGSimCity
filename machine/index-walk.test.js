import { describe, expect, it } from 'vitest'

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
    expect(INDEX_WALK_STEPS[1].sql).toContain('pg_catalog.pg_attribute')
    expect(INDEX_WALK_STEPS[1].sql).toContain('pg_catalog.pg_index')
    expect(INDEX_WALK_STEPS[2].sql).toMatch(/WHERE id = 42/)
    expect(INDEX_WALK_STEPS[3].sql).toMatch(/WHERE owner = 'account-42'/)
  })

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
      rows: [{ index_name: 'accounts_pkey', indexed_column: 'id' }],
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
      .toBe('accounts_pkey · column id · 1 catalog row')
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
        rows: [{ index_name: 'accounts_pkey', indexed_column: 'id' }],
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
