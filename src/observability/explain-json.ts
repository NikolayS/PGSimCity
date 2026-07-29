import type { RealPlan, RealPlanNode } from './real-postgres'

type JsonRecord = Record<string, unknown>

const recordOf = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null

const numberOf = (value: unknown): number =>
  typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : 0

const stringOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function planNodeOf(value: unknown): RealPlanNode {
  const node = recordOf(value)
  if (!node || typeof node['Node Type'] !== 'string') {
    throw new Error('PostgreSQL returned an EXPLAIN document without a plan node')
  }
  const rawChildren = Array.isArray(node.Plans) ? node.Plans : []
  return {
    nodeType: node['Node Type'],
    operation: stringOf(node.Operation),
    relationName: stringOf(node['Relation Name']),
    alias: stringOf(node.Alias),
    indexName: stringOf(node['Index Name']),
    startupCost: numberOf(node['Startup Cost']),
    totalCost: numberOf(node['Total Cost']),
    planRows: numberOf(node['Plan Rows']),
    actualRows: numberOf(node['Actual Rows']),
    actualLoops: numberOf(node['Actual Loops']),
    actualTotalTimeMs: numberOf(node['Actual Total Time']),
    sharedHits: numberOf(node['Shared Hit Blocks']),
    sharedReads: numberOf(node['Shared Read Blocks']),
    children: rawChildren.map(planNodeOf),
  }
}

function explainDocument(value: unknown): JsonRecord {
  let parsed = value
  if (typeof parsed === 'string') parsed = JSON.parse(parsed) as unknown
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  const document = recordOf(first)
  if (!document) throw new Error('PostgreSQL returned an invalid EXPLAIN JSON document')
  return document
}

/** Convert PostgreSQL's JSON format into data that has no DOM or drawing dependency. */
export function parseExplainJson(value: unknown): RealPlan {
  const document = explainDocument(value)
  const root = planNodeOf(document.Plan)
  return {
    source: 'postgres',
    planningTimeMs: numberOf(document['Planning Time']),
    executionTimeMs: numberOf(document['Execution Time']),
    buffers: {
      source: 'postgres',
      sharedHits: root.sharedHits,
      sharedReads: root.sharedReads,
    },
    root,
  }
}
