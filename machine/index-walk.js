import { MACHINE_INDEX_WALK as claim } from '../src/spine/machine-index-walk.ts'

export const INDEX_WALK_CLAIM = claim

export const INDEX_WALK_STEPS = Object.freeze([
  Object.freeze({
    id: 'constant',
    number: '01',
    title: 'Start without a table',
    displaySql: 'SELECT 1;',
    sql: 'SELECT 1 AS answer;',
    lesson: 'A SELECT can return through a Result node without touching a relation.',
  }),
  Object.freeze({
    id: 'catalog',
    number: '02',
    title: 'Ask the catalogs',
    displaySql: 'pg_index + pg_get_indexdef',
    sql: claim.catalogSql,
    lesson: 'The catalogs report which indexed path exists before a lookup runs.',
  }),
  Object.freeze({
    id: 'indexed',
    number: '03',
    title: 'Use the indexed column',
    displaySql: 'WHERE id = 42',
    sql: 'SELECT id, balance FROM accounts WHERE id = 42;',
    lesson: 'EXPLAIN reports whether PostgreSQL actually chose accounts_pkey.',
  }),
  Object.freeze({
    id: 'unindexed',
    number: '04',
    title: 'Omit the partial-index predicate',
    displaySql: "WHERE owner = 'account-42'",
    sql: "SELECT id, balance FROM accounts WHERE owner = 'account-42';",
    lesson: 'The owner index is partial: without balance > 0, it is not a path for this query.',
  }),
])

function sqlKey(sql) {
  return String(sql ?? '')
    .trim()
    .replace(/;\s*$/u, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase()
}

function resultRows(report) {
  return report?.results?.at(-1)?.rows ?? []
}

function scanNode(root) {
  if (!root) return null
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.shift()
    if (/scan$/iu.test(String(node?.nodeType ?? ''))) return node
    pending.unshift(...(node?.children ?? []))
  }
  return null
}

function measuredBlocks(report) {
  return {
    sharedHits: Number(report?.plan?.buffers?.sharedHits) || 0,
    sharedReads: Number(report?.plan?.buffers?.sharedReads) || 0,
  }
}

function rowLabel(count) {
  return `${count} ${count === 1 ? 'row' : 'rows'}`
}

export function matchingIndexWalkStep(report) {
  if (!report || report.error || !report.plan) return null
  const key = sqlKey(report.sql)
  if (/^select 1(?: as [a-z_][a-z0-9_]*)?$/u.test(key)) return 'constant'
  return INDEX_WALK_STEPS.find((step) => sqlKey(step.sql) === key)?.id ?? null
}

export function createIndexWalkEvidence(stepId, report) {
  if (!report || report.error || !report.plan) return null
  const rows = resultRows(report)
  const { sharedHits, sharedReads } = measuredBlocks(report)

  if (stepId === 'catalog') {
    const primaryKey = rows.find((row) => row.index_name === 'accounts_pkey')
    const partial = rows.find((row) => row.index_name === claim.partialIndex)
    const index = String(primaryKey?.index_name ?? '')
    const accessMethod = String(primaryKey?.access_method ?? '')
    const validity = String(primaryKey?.validity ?? '')
    const definition = String(primaryKey?.index_definition ?? '')
    const partialIndex = String(partial?.index_name ?? '')
    const partialAccessMethod = String(partial?.access_method ?? '')
    const partialUniqueness = String(partial?.uniqueness ?? '')
    const partialValidity = String(partial?.validity ?? '')
    const partialPredicate = String(partial?.predicate ?? '')
    const partialDefinition = String(partial?.index_definition ?? '')
    return Object.freeze({
      source: 'postgres',
      stepId,
      node: null,
      index: index || null,
      accessMethod: accessMethod || null,
      validity: validity || null,
      definition: definition || null,
      partialIndex: partialIndex || null,
      partialAccessMethod: partialAccessMethod || null,
      partialUniqueness: partialUniqueness || null,
      partialValidity: partialValidity || null,
      partialPredicate: partialPredicate || null,
      partialDefinition: partialDefinition || null,
      rows: rows.length,
      sharedHits,
      sharedReads,
      summary:
        `${partialIndex || 'no seeded partial-index row'}`
        + ` · ${partialValidity || 'unknown validity'} ${partialUniqueness || 'unknown uniqueness'} ${partialAccessMethod || 'unknown method'}`
        + ` · PARTIAL: ${partialPredicate || 'predicate unavailable'}`
        + ` · ${rows.length} catalog ${rows.length === 1 ? 'row' : 'rows'}`,
    })
  }

  const access = stepId === 'constant' ? report.plan.root : scanNode(report.plan.root)
  const node = String(access?.nodeType ?? report.plan.root?.nodeType ?? 'Plan')
  const index = access?.indexName ? String(access.indexName) : null
  const indexLabel = index ? ` · ${index}` : ''
  return Object.freeze({
    source: 'postgres',
    stepId,
    node,
    index,
    rows: rows.length,
    sharedHits,
    sharedReads,
    summary:
      `${node}${indexLabel} · ${rowLabel(rows.length)}`
      + ` · hit ${sharedHits} / read ${sharedReads}`,
  })
}

export function indexWalkFinding(evidence) {
  const byStep = new Map(
    evidence.filter(Boolean).map((entry) => [entry.stepId, entry]),
  )
  const constant = byStep.get('constant')
  const catalog = byStep.get('catalog')
  const indexed = byStep.get('indexed')
  const unindexed = byStep.get('unindexed')
  const supported = Boolean(
    constant?.node === 'Result'
    && catalog?.index === 'accounts_pkey'
    && catalog?.accessMethod === 'btree'
    && catalog?.validity === 'valid'
    && /\bUSING btree \(id\)$/u.test(catalog?.definition ?? '')
    && catalog?.partialIndex === claim.partialIndex
    && catalog?.partialAccessMethod === 'btree'
    && catalog?.partialUniqueness === 'non-unique'
    && catalog?.partialValidity === 'valid'
    && /\bbalance\s*>\s*\(?0\b/u.test(catalog?.partialPredicate ?? '')
    && /\bUSING btree \(owner\) WHERE /u.test(catalog?.partialDefinition ?? '')
    && indexed?.node === 'Index Scan'
    && indexed?.index === 'accounts_pkey'
    && indexed?.rows === 1
    && unindexed?.node === 'Seq Scan'
    && unindexed?.rows === 1,
  )
  return Object.freeze({
    supported,
    text: supported ? claim.finding : claim.incomplete,
  })
}
