import type { QueryKind } from '../core/types'
import { TABLES } from '../world/layout'
export {
  PRESENTED_TRACE_STAGES as CONTROL_TRACE_STAGES,
  traceStageState,
} from '../sim/trace-presentation'

export interface ModelStatement {
  kind: QueryKind
  table: string
  tableIndex: number
  sql: string
}

export type ModelStatementResult =
  | ModelStatement
  | { error: string }

const GRAMMAR_ERROR =
  'This model traces SELECT, INSERT, UPDATE, and DELETE statements against the five city tables.'

function relationFor(sql: string, operation: string): string | null {
  const unquoted = sql.replaceAll('"', '')
  let match: RegExpMatchArray | null = null
  if (operation === 'insert') match = unquoted.match(/\binto\s+(?:public\.)?([a-z_][a-z0-9_]*)/i)
  else if (operation === 'update') match = unquoted.match(/^\s*update\s+(?:public\.)?([a-z_][a-z0-9_]*)/i)
  else match = unquoted.match(/\bfrom\s+(?:public\.)?([a-z_][a-z0-9_]*)/i)
  return match?.[1]?.toLowerCase() ?? null
}

/**
 * The prompt accepts SQL text, but the city has six model paths rather than a
 * PostgreSQL parser. Keep the mapping small enough that every accepted shape
 * can be named honestly in the interface.
 */
export function classifyModelStatement(input: string): ModelStatementResult {
  const sql = input.trim().replace(/;+\s*$/, '')
  const operation = sql.match(/^([a-z]+)/i)?.[1]?.toLowerCase()
  if (
    operation !== 'select'
    && operation !== 'insert'
    && operation !== 'update'
    && operation !== 'delete'
  ) {
    return { error: GRAMMAR_ERROR }
  }

  const table = relationFor(sql, operation)
  const tableIndex = TABLES.findIndex((candidate) => candidate.id === table)
  if (tableIndex < 0) {
    return {
      error: `The city model only contains ${TABLES.map((candidate) => candidate.name).join(', ')}.`,
    }
  }

  let kind: QueryKind
  if (operation === 'insert' || operation === 'update' || operation === 'delete') {
    kind = operation
  } else if (/\b(group\s+by|count\s*\(|sum\s*\(|avg\s*\(|min\s*\(|max\s*\()/i.test(sql)) {
    kind = 'aggregate'
  } else if (/\bwhere\b[\s\S]*\bid\s*=/i.test(sql)) {
    kind = 'select_idx'
  } else {
    kind = 'select_seq'
  }

  return { kind, table: TABLES[tableIndex].id, tableIndex, sql }
}
