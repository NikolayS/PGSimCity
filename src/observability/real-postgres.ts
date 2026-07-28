import type { QueryKind } from '../core/types'

export type DataSource = 'postgres' | 'model'

export type CityRelation =
  | 'accounts'
  | 'orders'
  | 'events'
  | 'sessions'
  | 'documents'

export const SEEDED_RELATIONS: readonly CityRelation[] = [
  'accounts',
  'orders',
  'events',
  'sessions',
  'documents',
]

export interface RealBufferCounters {
  source: 'postgres'
  sharedHits: number
  sharedReads: number
}

export interface RealPlanNode {
  nodeType: string
  operation: string | null
  relationName: string | null
  alias: string | null
  indexName: string | null
  startupCost: number
  totalCost: number
  planRows: number
  actualRows: number
  actualLoops: number
  actualTotalTimeMs: number
  sharedHits: number
  sharedReads: number
  children: RealPlanNode[]
}

export interface RealPlan {
  source: 'postgres'
  planningTimeMs: number
  executionTimeMs: number
  buffers: RealBufferCounters
  root: RealPlanNode
}

export interface RealResultSet {
  source: 'postgres'
  fields: { name: string; dataTypeId: number }[]
  rows: Record<string, unknown>[]
  affectedRows: number | null
}

export interface RealPostgresError {
  source: 'postgres'
  severity: string
  code: string
  message: string
  detail: string | null
  hint: string | null
  position: string | null
}

export interface RealQueryReport {
  source: 'postgres'
  sql: string
  serverVersion: string
  results: RealResultSet[]
  plan: RealPlan | null
  error: RealPostgresError | null
}

export interface RealPostgresSource {
  readonly serverVersion: string
  query(sql: string): Promise<RealQueryReport>
  close(): Promise<void>
}

export interface CityModelTarget {
  kind: QueryKind
  relation: CityRelation
}

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

function walkPlan(node: RealPlanNode, visit: (candidate: RealPlanNode) => void): void {
  visit(node)
  for (const child of node.children) walkPlan(child, visit)
}

function relationInPlan(plan: RealPlan): CityRelation | null {
  let relation: CityRelation | null = null
  walkPlan(plan.root, (node) => {
    if (
      relation === null
      && node.relationName !== null
      && SEEDED_RELATIONS.includes(node.relationName as CityRelation)
    ) {
      relation = node.relationName as CityRelation
    }
  })
  return relation
}

function operationInPlan(plan: RealPlan): string {
  let operation = plan.root.operation ?? ''
  walkPlan(plan.root, (node) => {
    if (!operation && node.operation) operation = node.operation
  })
  return operation.toLowerCase()
}

/**
 * Select the closest path the finite city model can animate.
 *
 * This mapping never changes the plan data. It only chooses a modelled interior
 * to place beside the authoritative plan.
 */
export function cityRelationForPlan(
  plan: RealPlan,
  sql: string,
): CityModelTarget | null {
  const relation = relationInPlan(plan)
  if (!relation) return null

  const operation = operationInPlan(plan)
  const firstWord = /^[\s(]*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? ''
  if (operation === 'insert' || firstWord === 'insert') return { kind: 'insert', relation }
  if (operation === 'update' || firstWord === 'update') return { kind: 'update', relation }
  if (operation === 'delete' || firstWord === 'delete') return { kind: 'delete', relation }

  let aggregate = false
  let indexAccess = false
  walkPlan(plan.root, (node) => {
    aggregate ||= node.nodeType.includes('Aggregate')
    indexAccess ||= node.nodeType.includes('Index') || node.nodeType.includes('Bitmap')
  })
  if (aggregate) return { kind: 'aggregate', relation }
  return { kind: indexAccess ? 'select_idx' : 'select_seq', relation }
}

/** Kept here so importing the Query flow never imports the WASM package eagerly. */
export async function loadRealPostgres(): Promise<RealPostgresSource> {
  const runtime = await import('./real-postgres-runtime')
  return runtime.createPgliteSource(parseExplainJson)
}
