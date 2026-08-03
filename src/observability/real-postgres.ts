import type { QueryKind } from '../core/types'
import { parseExplainJson } from './explain-json'

export { parseExplainJson } from './explain-json'

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
  readonly versionText: string
  query(sql: string): Promise<RealQueryReport>
  close(): Promise<void>
}

export interface CityModelTarget {
  kind: QueryKind
  relation: CityRelation
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
