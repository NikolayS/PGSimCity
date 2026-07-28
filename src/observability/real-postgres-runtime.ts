import { PGlite } from '@electric-sql/pglite'
import initdbWasmUrl from '../../node_modules/@electric-sql/pglite/dist/initdb.wasm?url'
import fsBundleUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.data?url'
import pgliteWasmUrl from '../../node_modules/@electric-sql/pglite/dist/pglite.wasm?url'

import type {
  RealPlan,
  RealPostgresError,
  RealPostgresSource,
  RealQueryReport,
  RealResultSet,
} from './real-postgres'

const SEED_SQL = `
CREATE TABLE accounts (
  id integer PRIMARY KEY,
  owner text NOT NULL,
  balance numeric(12, 2) NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE orders (
  id integer PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id),
  status text NOT NULL,
  total numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX orders_customer_id_idx ON orders(account_id);

CREATE TABLE events (
  id integer PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX events_created_at_idx ON events(created_at);

CREATE TABLE sessions (
  id integer PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE documents (
  id integer PRIMARY KEY,
  account_id integer NOT NULL REFERENCES accounts(id),
  title text NOT NULL,
  body text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX documents_gin ON documents USING gin(search);

INSERT INTO accounts
SELECT
  id,
  'account-' || id,
  (1000 + id)::numeric(12, 2),
  timestamptz '2026-01-01 00:00:00+00' + id * interval '1 minute'
FROM generate_series(1, 2000) AS id;

INSERT INTO orders
SELECT
  id,
  1 + (id % 2000),
  (ARRAY['new', 'paid', 'packed', 'shipped'])[1 + (id % 4)],
  (10 + (id % 900) / 10.0)::numeric(12, 2),
  timestamptz '2026-02-01 00:00:00+00' + id * interval '2 minutes'
FROM generate_series(1, 6000) AS id;

INSERT INTO events
SELECT
  id,
  1 + (id % 2000),
  (ARRAY['login', 'view', 'purchase'])[1 + (id % 3)],
  jsonb_build_object('sequence', id, 'source', 'seed'),
  timestamptz '2026-03-01 00:00:00+00' + id * interval '30 seconds'
FROM generate_series(1, 8000) AS id;

INSERT INTO sessions
SELECT
  id,
  1 + (id % 2000),
  timestamptz '2026-07-01 00:00:00+00' + id * interval '5 minutes',
  timestamptz '2026-06-01 00:00:00+00' + id * interval '1 minute',
  jsonb_build_object('device', (ARRAY['web', 'mobile'])[1 + (id % 2)])
FROM generate_series(1, 1200) AS id;

INSERT INTO documents
SELECT
  id,
  1 + (id % 2000),
  'PostgreSQL note ' || id,
  repeat('buffers indexes write-ahead log vacuum ', 80) || id
FROM generate_series(1, 500) AS id;

ANALYZE;
`

interface PGliteResult {
  rows: Record<string, unknown>[]
  affectedRows?: number
  fields: { name: string; dataTypeID: number }[]
}

interface PostgresErrorLike {
  message?: unknown
  severity?: unknown
  code?: unknown
  detail?: unknown
  hint?: unknown
  position?: unknown
}

interface BrowserArtifacts {
  pgliteWasmModule: WebAssembly.Module
  initdbWasmModule: WebAssembly.Module
  fsBundle: Blob
}

async function fetchAsset(url: string, label: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (cause) {
    throw new Error(`${label} could not be fetched`, { cause })
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return response
}

async function loadBrowserArtifacts(): Promise<BrowserArtifacts> {
  const [postgresResponse, initdbResponse, dataResponse] = await Promise.all([
    fetchAsset(pgliteWasmUrl, 'PostgreSQL WebAssembly'),
    fetchAsset(initdbWasmUrl, 'initdb WebAssembly'),
    fetchAsset(fsBundleUrl, 'PostgreSQL filesystem bundle'),
  ])
  const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
    WebAssembly.compileStreaming(Promise.resolve(postgresResponse)),
    WebAssembly.compileStreaming(Promise.resolve(initdbResponse)),
    dataResponse.blob(),
  ])
  return { pgliteWasmModule, initdbWasmModule, fsBundle }
}

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

function postgresError(error: unknown): RealPostgresError {
  const candidate =
    typeof error === 'object' && error !== null ? error as PostgresErrorLike : {}
  return {
    source: 'postgres',
    severity: optionalString(candidate.severity) ?? 'ERROR',
    code: optionalString(candidate.code) ?? 'XXXXX',
    message: optionalString(candidate.message) ?? String(error),
    detail: optionalString(candidate.detail),
    hint: optionalString(candidate.hint),
    position: optionalString(candidate.position),
  }
}

const toResult = (result: PGliteResult): RealResultSet => ({
  source: 'postgres',
  fields: result.fields.map((field) => ({
    name: field.name,
    dataTypeId: field.dataTypeID,
  })),
  rows: result.rows,
  affectedRows: result.affectedRows ?? null,
})

function mayHavePlan(sql: string): boolean {
  const withoutLeadingComments = sql
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, '')
    .toLowerCase()
  return /^(?:select|with|values|table|insert|update|delete|merge)\b/u.test(withoutLeadingComments)
}

async function explain(
  db: PGlite,
  sql: string,
  parsePlan: (value: unknown) => RealPlan,
): Promise<RealPlan | null> {
  if (!mayHavePlan(sql)) return null
  let transactionOpen = false
  try {
    await db.exec('BEGIN')
    transactionOpen = true
    const explained = await db.query<Record<string, unknown>>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    )
    await db.exec('ROLLBACK')
    transactionOpen = false
    return parsePlan(explained.rows[0]?.['QUERY PLAN'])
  } catch {
    if (transactionOpen) {
      try {
        await db.exec('ROLLBACK')
      } catch {
        /* PostgreSQL already ended the failed transaction. */
      }
    }
    return null
  }
}

export async function createPgliteSource(
  parsePlan: (value: unknown) => RealPlan,
): Promise<RealPostgresSource> {
  const browserArtifacts =
    typeof window === 'undefined' ? undefined : await loadBrowserArtifacts()
  const db = await PGlite.create('memory://', browserArtifacts)
  await db.exec(SEED_SQL)
  const versionResult = await db.query<{ server_version: string }>('SHOW server_version')
  const serverVersion = versionResult.rows[0]?.server_version ?? 'unknown'

  return {
    serverVersion,
    async query(sql: string): Promise<RealQueryReport> {
      const plan = await explain(db, sql, parsePlan)
      try {
        const results = await db.exec(sql) as PGliteResult[]
        return {
          source: 'postgres',
          sql,
          serverVersion,
          results: results.map(toResult),
          plan,
          error: null,
        }
      } catch (error) {
        return {
          source: 'postgres',
          sql,
          serverVersion,
          results: [],
          plan: null,
          error: postgresError(error),
        }
      }
    },
    close: () => db.close(),
  }
}
