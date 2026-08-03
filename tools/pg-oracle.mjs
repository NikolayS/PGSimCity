#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { formatDescribeIndex } from '../machine/psql.js'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLAIMS_OWNER = 'src/core/claims.ts#CLAIMS'
const VALUES_OWNER = 'src/core/claims.ts#CLAIM_VALUES'
let activeCleanup = null

function ownerParts(owner) {
  const marker = owner.lastIndexOf('#')
  if (marker <= 0 || marker === owner.length - 1) {
    throw new Error(`Invalid registered claim owner: ${owner}`)
  }
  return {
    source: owner.slice(0, marker),
    exportPath: owner.slice(marker + 1).split('.'),
  }
}

function resolveExport(moduleExports, exportPath, owner) {
  let value = moduleExports
  for (const key of exportPath) value = value?.[key]
  if (value === undefined) throw new Error(`Registered claim owner did not resolve: ${owner}`)
  return value
}

async function loadOwners(records) {
  const buildDir = await mkdtemp(path.join(tmpdir(), 'pgsimcity-oracle-claims-'))
  try {
    const sources = [...new Set(records.map((record) => ownerParts(record.owner).source))]
    const program = ts.createProgram({
      rootNames: sources.map((source) => path.join(REPO_ROOT, source)),
      options: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        rootDir: REPO_ROOT,
        outDir: buildDir,
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
      },
    })
    const emitted = program.emit()
    if (emitted.emitSkipped) {
      const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics)
      const summary = ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 10), {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => REPO_ROOT,
        getNewLine: () => '\n',
      })
      throw new Error(`Could not load registered TypeScript claims:\n${summary}`)
    }

    const require = createRequire(path.join(buildDir, 'oracle-loader.cjs'))
    const modules = new Map()
    const loaded = {}
    for (const record of records) {
      const { source, exportPath } = ownerParts(record.owner)
      let moduleExports = modules.get(source)
      if (!moduleExports) {
        const emittedPath = path.join(buildDir, source).replace(/\.ts$/u, '.js')
        moduleExports = require(emittedPath)
        modules.set(source, moduleExports)
      }
      loaded[record.role] = resolveExport(moduleExports, exportPath, record.owner)
    }
    return loaded
  } finally {
    await rm(buildDir, { recursive: true, force: true })
  }
}

export async function loadOracleRegistry() {
  const root = await loadOwners([
    { role: 'claims', owner: CLAIMS_OWNER },
    { role: 'values', owner: VALUES_OWNER },
  ])
  const registrations = Object.values(root.claims)
    .map((claim) => claim?.value?.oracleSources)
    .filter(Boolean)
  if (registrations.length !== 1) {
    throw new Error(`Expected one oracle source registration, found ${registrations.length}`)
  }

  const sources = await loadOwners(registrations[0])
  return {
    target: root.values.postgresqlVersion,
    claims: sources.claims,
    catalog: sources.catalog,
    indexWalk: sources.indexWalk,
  }
}

export function expectedForMajor(claim, major) {
  const variants = Array.isArray(claim.expected) ? claim.expected : [claim.expected]
  return variants.find((variant) =>
    (variant.from === undefined || major >= variant.from)
    && (variant.to === undefined || major <= variant.to)) ?? null
}

function unitValue(rawValue, rawUnit, kind) {
  const value = Number(rawValue)
  if (!Number.isFinite(value)) return Number.NaN
  const unit = String(rawUnit ?? '')
  if (kind === 'bytes') {
    const factors = {
      '': 1,
      B: 1,
      kB: 1024,
      '8kB': 8 * 1024,
      MB: 1024 ** 2,
      GB: 1024 ** 3,
      TB: 1024 ** 4,
    }
    return factors[unit] === undefined ? Number.NaN : value * factors[unit]
  }
  if (kind === 'duration') {
    const factors = {
      us: 0.001,
      ms: 1,
      s: 1000,
      min: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    }
    return factors[unit] === undefined ? Number.NaN : value * factors[unit]
  }
  return value
}

export function compareSetting(expected, server) {
  if (!server) return false
  const serverValue = server[expected.serverField ?? 'setting'] ?? server.boot_val
  if (expected.compare === 'text') {
    return String(expected.value).toLowerCase() === String(serverValue).toLowerCase()
  }
  const left = unitValue(expected.value, expected.unit, expected.compare)
  const right = unitValue(serverValue, server.unit, expected.compare)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-12
}

function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/gu, '<br>')
}

export function markdownTable(rows) {
  const lines = [
    '| Claim | City says | Server said | Verdict |',
    '|---|---|---|---|',
  ]
  for (const row of rows) {
    lines.push(`| ${markdownCell(row.claim)} | ${markdownCell(row.city)} | ${markdownCell(row.server)} | ${markdownCell(row.verdict)} |`)
  }
  return lines.join('\n')
}

function run(file, args, { input, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      const result = { code, signal, stdout, stderr }
      if (code === 0 || allowFailure) resolve(result)
      else {
        const detail = stderr.trim() || stdout.trim() || `exit ${code}${signal ? ` (${signal})` : ''}`
        reject(new Error(`${path.basename(file)} failed: ${detail}`))
      }
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = probe.address()
      probe.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

async function withThrowawayCluster(pgBin, callback) {
  const scratch = await mkdtemp(path.join(tmpdir(), `pgsimcity-oracle-${process.pid}-`))
  const dataDir = path.join(scratch, 'data')
  const socketDir = path.join(scratch, 'socket')
  const logFile = path.join(scratch, 'postgres.log')
  let initialized = false
  let started = false
  let cleaned = false

  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    if (initialized) {
      await run(path.join(pgBin, 'pg_ctl'), [
        '-D', dataDir, '-m', 'immediate', '-w', 'stop',
      ], { allowFailure: true })
    }
    await rm(scratch, { recursive: true, force: true })
  }
  activeCleanup = cleanup

  try {
    await run(path.join(pgBin, 'initdb'), [
      '-D', dataDir,
      '--no-locale',
      '--encoding=UTF8',
      '--auth=trust',
      '--username=postgres',
      '--no-sync',
    ])
    initialized = true
    await mkdir(socketDir)
    let port = 0
    for (let attempt = 0; attempt < 5 && !started; attempt++) {
      port = await freePort()
      const launch = await run(path.join(pgBin, 'pg_ctl'), [
        '-D', dataDir,
        '-l', logFile,
        '-o', `-h 127.0.0.1 -p ${port} -k ${socketDir} -c fsync=off`,
        '-w', 'start',
      ], { allowFailure: true })
      started = launch.code === 0
      if (!started) {
        await run(path.join(pgBin, 'pg_ctl'), [
          '-D', dataDir, '-m', 'immediate', '-w', 'stop',
        ], { allowFailure: true })
      }
    }
    if (!started) {
      const log = await readFile(logFile, 'utf8').catch(() => 'server log unavailable')
      throw new Error(`PostgreSQL did not start after five free-port probes:\n${log.trim()}`)
    }

    const psql = async (sql, { allowFailure = false, tuplesOnly = true } = {}) => run(
      path.join(pgBin, 'psql'),
      [
        '-X',
        ...(tuplesOnly ? ['-A', '-t'] : []),
        '-q',
        '-v', 'ON_ERROR_STOP=1',
        '-h', '127.0.0.1',
        '-p', String(port),
        '-U', 'postgres',
        '-d', 'postgres',
        '-c', sql,
      ],
      { allowFailure },
    )
    const query = async (sql) => {
      const body = sql.trim().replace(/;+\s*$/u, '')
      const result = await psql(
        `SELECT COALESCE(json_agg(oracle_row), '[]'::json) FROM (${body}) AS oracle_row;`,
      )
      const json = result.stdout.trim()
      return JSON.parse(json || '[]')
    }

    return await callback({ psql, query, port, scratch })
  } finally {
    await cleanup()
    if (activeCleanup === cleanup) activeCleanup = null
  }
}

function result(claim, city, server, matches) {
  return { claim, city, server, verdict: matches ? 'MATCH' : 'DIVERGES' }
}

function displayExpected(expected) {
  return expected.display ?? `${expected.value}${expected.unit ?? ''}`
}

async function checkVersion(query, registry, major) {
  const [server] = await query(`
    SELECT current_setting('server_version') AS server_version,
           current_setting('server_version_num') AS server_version_num`)
  const expected = registry.target.referenceLabel.replace(/^PostgreSQL\s+/u, '')
  const matches = major === registry.target.major
    && String(server.server_version).startsWith(expected)
  return [result(
    'postgresqlVersion/referenceLabel',
    registry.target.referenceLabel,
    `PostgreSQL ${server.server_version} (${server.server_version_num})`,
    matches,
  )]
}

async function checkGucDefaults(query, registry, major) {
  const claims = registry.claims.gucDefaults
  const names = [...new Set(claims.map((claim) => claim.setting))]
  const rows = await query(`
    SELECT name, setting, unit, vartype, boot_val, reset_val, source
      FROM pg_catalog.pg_settings
     WHERE name IN (${names.map(sqlLiteral).join(', ')})`)
  const byName = new Map(rows.map((row) => [row.name, row]))
  const results = []
  for (const claim of claims) {
    const expected = expectedForMajor(claim, major)
    if (!expected) continue
    const server = byName.get(claim.setting)
    const serverField = expected.serverField ?? 'setting'
    results.push(result(
      `GUC/${claim.id}`,
      `${claim.cityClaim}: ${displayExpected(expected)}`,
      server
        ? `${serverField === 'setting' ? 'SHOW' : serverField} ${server[serverField]}${serverField === 'setting' && server.unit ? ` ${server.unit}` : ''} (${server.source})`
        : 'setting is absent',
      compareSetting(expected, server),
    ))
  }
  return results
}

async function relationColumns(query, relation) {
  return query(`
    SELECT a.attname
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = pg_catalog.to_regclass(${sqlLiteral(relation)})
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY a.attnum`)
}

function shapeDifference(expected, actual) {
  const missing = expected.filter((name) => !actual.includes(name))
  const extra = actual.filter((name) => !expected.includes(name))
  const orderDiffers = missing.length === 0
    && extra.length === 0
    && expected.some((name, index) => actual[index] !== name)
  const parts = []
  if (missing.length > 0) parts.push(`missing [${missing.join(', ')}]`)
  if (extra.length > 0) parts.push(`extra [${extra.join(', ')}]`)
  if (orderDiffers) parts.push('same names, different catalog order')
  return parts.join('; ') || `${actual.length} columns match in catalog order`
}

async function checkCatalog(psql, query, registry, major) {
  const entries = registry.catalog.filter((entry) => entry.id.startsWith('pg_stat_'))
  for (const entry of entries.filter((candidate) => candidate.kind === 'extension')) {
    await psql(`CREATE EXTENSION IF NOT EXISTS ${entry.id};`, { allowFailure: true })
  }

  const results = []
  for (const entry of entries) {
    const relation = entry.kind === 'extension' ? entry.id : `pg_catalog.${entry.id}`
    const [presence] = await query(`
      SELECT pg_catalog.to_regclass(${sqlLiteral(relation)})::text AS relation`)
    const exists = presence.relation !== null
    const expectedExists = major >= entry.since
    if (!expectedExists || !exists) {
      results.push(result(
        `catalog/${entry.id}`,
        expectedExists ? `exists since PostgreSQL ${entry.since}` : `absent before PostgreSQL ${entry.since}`,
        exists ? `exists as ${presence.relation}` : 'absent',
        exists === expectedExists,
      ))
      continue
    }

    const actual = (await relationColumns(query, relation)).map((row) => row.attname)
    const same = entry.columns.length === actual.length
      && entry.columns.every((name, index) => actual[index] === name)
    results.push(result(
      `catalog/${entry.id}`,
      `PostgreSQL ${registry.target.major} shape: ${entry.columns.join(', ')}`,
      same ? `${actual.length} columns match in catalog order` : shapeDifference(entry.columns, actual),
      same,
    ))
  }
  return results
}

async function checkWaitEvents(query, registry, major) {
  const claim = registry.claims.waitEvents
  const [presence] = await query(`
    SELECT pg_catalog.to_regclass(${sqlLiteral(claim.relation)})::text AS relation`)
  const exists = presence.relation !== null
  if (major < claim.since || !exists) {
    return [result(
      'wait-events/pg_wait_events',
      major < claim.since
        ? `absent before PostgreSQL ${claim.since}`
        : `exists since PostgreSQL ${claim.since}`,
      exists ? `exists as ${presence.relation}` : 'absent',
      exists === (major >= claim.since),
    )]
  }

  const rows = await query('SELECT type, name FROM pg_catalog.pg_wait_events')
  const actual = new Set(rows.map((row) => `${row.type}/${row.name}`))
  return claim.events.map((event) => {
    const name = `${event.type}/${event.name}`
    return result(`wait-event/${name}`, name, actual.has(name) ? name : 'absent', actual.has(name))
  })
}

async function checkPgStatIo(query, registry, major) {
  const claim = registry.claims.pgStatIo
  if (major < claim.since) return []
  const rows = await query(`SELECT * FROM ${claim.relation}`)
  return claim.projectionRows.map((projection) => {
    const row = rows.find((candidate) =>
      candidate.backend_type === projection.backendType
      && candidate.object === projection.object
      && candidate.context === projection.context)
    const operations = row
      ? claim.operationColumns.filter((column) => Object.hasOwn(row, column) && row[column] !== null)
      : []
    const missing = projection.operations.filter((operation) => !operations.includes(operation))
    const dimension = `${projection.backendType}/${projection.object}/${projection.context}`
    return result(
      `pg_stat_io/${dimension}`,
      `dimension exists; non-null ops ${projection.operations.join(', ')}`,
      row ? `non-null ops ${operations.join(', ') || 'none'}` : 'dimension is absent',
      Boolean(row) && missing.length === 0,
    )
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollRow(query, sql, ready, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let row = null
  while (performance.now() < deadline) {
    ;[row] = await query(sql)
    if (ready(row)) return row
    await delay(250)
  }
  return row
}

async function checkCheckpointTimerSkip(psql, query, registry, major) {
  const claim = registry.claims.checkpointTimerSkip
  if (major < claim.since) return []

  await psql(`ALTER SYSTEM SET checkpoint_timeout = '${claim.timeoutSeconds}s'`)
  await psql('SELECT pg_catalog.pg_reload_conf()')
  await psql('CHECKPOINT')
  await psql(`SELECT pg_catalog.pg_stat_reset_shared('checkpointer')`)
  const row = await pollRow(
    query,
    'SELECT num_timed, num_requested, num_done, buffers_written FROM pg_catalog.pg_stat_checkpointer',
    (candidate) => Number(candidate?.num_timed) > 0,
    (claim.timeoutSeconds + 8) * 1_000,
  )
  const skipped = Number(row?.num_timed) > 0
    && Number(row?.num_requested) === 0
    && Number(row?.num_done) === 0
  return [result(
    'pg_stat_checkpointer/timer-expiry-skip',
    'num_timed counts idle timer expiries; num_done remains zero when the checkpoint is skipped',
    row
      ? `num_timed ${row.num_timed}, num_requested ${row.num_requested}, num_done ${row.num_done}, buffers_written ${row.buffers_written}`
      : 'no pg_stat_checkpointer row',
    skipped,
  )]
}

async function checkAutovacuumThreshold(psql, query, registry) {
  const claim = registry.claims.autovacuumThreshold
  await psql("ALTER SYSTEM SET autovacuum_naptime = '1s'")
  await psql('SELECT pg_catalog.pg_reload_conf()')
  await psql(`
    CREATE TABLE public.${claim.relation} (
      id integer PRIMARY KEY,
      payload integer NOT NULL
    ) WITH (
      autovacuum_enabled = false,
      autovacuum_vacuum_threshold = ${claim.baseThreshold},
      autovacuum_vacuum_scale_factor = ${claim.scaleFactor},
      autovacuum_vacuum_insert_threshold = 1000,
      autovacuum_vacuum_insert_scale_factor = ${claim.scaleFactor}
    )`)
  await psql(`
    INSERT INTO public.${claim.relation}
    SELECT value, 0 FROM pg_catalog.generate_series(1, ${claim.reltuples}) AS value`)
  await psql(`VACUUM (ANALYZE) public.${claim.relation}`)
  await psql(`
    INSERT INTO public.${claim.relation}
    SELECT value, 0
      FROM pg_catalog.generate_series(${claim.reltuples + 1}, ${claim.liveTuples}) AS value`)
  await psql(`
    UPDATE public.${claim.relation}
       SET payload = payload + 1
     WHERE id <= ${claim.deadTuples}`)

  const [before] = await query(`
    SELECT c.reltuples::bigint AS reltuples,
           s.n_live_tup,
           s.n_dead_tup,
           s.autovacuum_count
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_stat_all_tables AS s ON s.relid = c.oid
     WHERE c.oid = 'public.${claim.relation}'::regclass`)
  const reltuplesThreshold = claim.baseThreshold + claim.scaleFactor * Number(before.reltuples)
  const liveThreshold = claim.baseThreshold + claim.scaleFactor * Number(before.n_live_tup)
  const sourceDistinguishes = Number(before.n_dead_tup) > reltuplesThreshold
    && Number(before.n_dead_tup) < liveThreshold

  await psql(`ALTER TABLE public.${claim.relation} SET (autovacuum_enabled = true)`)
  const after = await pollRow(
    query,
    `SELECT autovacuum_count FROM pg_catalog.pg_stat_all_tables WHERE relid = 'public.${claim.relation}'::regclass`,
    (candidate) => Number(candidate?.autovacuum_count) > Number(before.autovacuum_count),
    12_000,
  )
  const launched = Number(after?.autovacuum_count) > Number(before.autovacuum_count)
  return [result(
    'autovacuum/reltuples-threshold-source',
    `dead ${claim.deadTuples} crosses the reltuples threshold but not the n_live_tup threshold; autovacuum launches`,
    `reltuples ${before.reltuples}, n_live_tup ${before.n_live_tup}, n_dead_tup ${before.n_dead_tup}; thresholds ${reltuplesThreshold}/${liveThreshold}; autovacuum ${launched ? 'launched' : 'did not launch'}`,
    sourceDistinguishes && launched,
  )]
}

async function prepareIndexFixture(psql) {
  await psql(`
    CREATE SCHEMA oracle_fixture;
    ALTER ROLE postgres SET search_path = oracle_fixture, pg_catalog;
    CREATE TABLE oracle_fixture.accounts (
      id integer PRIMARY KEY,
      tenant_id integer NOT NULL,
      owner text NOT NULL,
      balance numeric NOT NULL,
      email text NOT NULL,
      deleted_at timestamptz,
      metadata jsonb NOT NULL
    );
    INSERT INTO oracle_fixture.accounts
      (id, tenant_id, owner, balance, email, deleted_at, metadata)
    VALUES
      (1, 10, 'duplicate', 100, 'one@example.test', NULL, '{"tier":"a"}'),
      (2, 10, 'duplicate', 200, 'two@example.test', now(), '{"tier":"b"}'),
      (3, 20, 'unique', 300, 'three@example.test', NULL, '{"tier":"a"}');
    CREATE INDEX accounts_tenant_owner_idx
      ON oracle_fixture.accounts (tenant_id, owner);
    CREATE INDEX accounts_owner_include_idx
      ON oracle_fixture.accounts (owner) INCLUDE (balance, email);
    CREATE INDEX accounts_lower_owner_idx
      ON oracle_fixture.accounts ((lower(owner)));
    CREATE INDEX accounts_open_balance_idx
      ON oracle_fixture.accounts (balance) WHERE deleted_at IS NULL;
    CREATE INDEX accounts_hash_idx
      ON oracle_fixture.accounts USING hash (owner);
    CREATE INDEX accounts_collate_idx
      ON oracle_fixture.accounts (owner COLLATE "C");
    CREATE INDEX accounts_opclass_idx
      ON oracle_fixture.accounts (owner text_pattern_ops);
    CREATE INDEX accounts_desc_idx
      ON oracle_fixture.accounts (balance DESC NULLS LAST);
    CREATE INDEX accounts_modifiers_idx
      ON oracle_fixture.accounts (owner COLLATE "C" text_pattern_ops DESC);
    CREATE INDEX accounts_metadata_gin_idx
      ON oracle_fixture.accounts USING gin (metadata);
  `)
  await psql(
    'CREATE UNIQUE INDEX CONCURRENTLY accounts_invalid_owner_idx ON oracle_fixture.accounts (owner);',
    { allowFailure: true },
  )
}

async function checkIndexWalk(psql, query, registry) {
  await prepareIndexFixture(psql)
  const described = await psql('\\d oracle_fixture.accounts', { tuplesOnly: false })
  const cityRows = await query(registry.indexWalk.catalogSql)
  const serverRows = await query(`
    SELECT c.relname AS index_name,
           am.amname AS access_method,
           CASE WHEN i.indisvalid THEN 'valid' ELSE 'INVALID' END AS validity,
           pg_catalog.pg_get_indexdef(i.indexrelid) AS index_definition
      FROM pg_catalog.pg_index AS i
      JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_class AS t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_am AS am ON am.oid = c.relam
     WHERE n.nspname = 'oracle_fixture'
       AND t.relname = 'accounts'
     ORDER BY c.relname`)

  const citedColumns = [...new Set(
    [...registry.indexWalk.catalogSql.matchAll(/\bi\.([a-z_][a-z0-9_]*)/giu)]
      .map((match) => match[1]),
  )].sort()
  const pgIndexColumns = await query(`
    SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type
      FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = 'pg_catalog.pg_index'::regclass
       AND a.attnum > 0
       AND NOT a.attisdropped`)
  const columnTypes = new Map(pgIndexColumns.map((row) => [row.attname, row.data_type]))
  const missingColumns = citedColumns.filter((name) => !columnTypes.has(name))

  const definitionMismatches = serverRows.filter((serverRow) => {
    const cityRow = cityRows.find((candidate) => candidate.index_name === serverRow.index_name)
    return !cityRow
      || cityRow.access_method !== serverRow.access_method
      || cityRow.validity !== serverRow.validity
      || cityRow.index_definition !== serverRow.index_definition
  })
  const expectedClauses = ['WHERE ', 'USING hash', 'COLLATE "C"', 'text_pattern_ops', 'DESC NULLS LAST']
  const missingClauses = expectedClauses.filter((clause) =>
    !cityRows.some((row) => String(row.index_definition).includes(clause)))
  const invalidServer = serverRows.filter((row) => row.validity === 'INVALID')
  const invalidMismatches = invalidServer.filter((serverRow) => {
    const cityRow = cityRows.find((candidate) => candidate.index_name === serverRow.index_name)
    return !cityRow || cityRow.validity !== 'INVALID'
  })
  const invalidDefinition = invalidServer[0]
  const cityDescribeLine = invalidDefinition
    ? formatDescribeIndex({
      Name: invalidDefinition.index_name,
      Primary: false,
      Unique: true,
      Valid: false,
      Definition: invalidDefinition.index_definition,
    }).trim()
    : ''
  const serverDescribeLine = described.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.includes('accounts_invalid_owner_idx')) ?? ''

  return [
    result(
      'pg_index/cited-columns',
      citedColumns.join(', '),
      missingColumns.length > 0
        ? `missing ${missingColumns.join(', ')}`
        : citedColumns.map((name) => `${name}:${columnTypes.get(name)}`).join(', '),
      missingColumns.length === 0,
    ),
    result(
      'index-walk/full-definitions',
      'full definitions retain predicates, access methods, collations, operator classes, and ordering',
      definitionMismatches.length > 0 || missingClauses.length > 0
        ? `${definitionMismatches.length} definition mismatches; missing clauses ${missingClauses.join(', ') || 'none'}`
        : `${serverRows.length} authoritative definitions match with every usability clause`,
      definitionMismatches.length === 0 && missingClauses.length === 0,
    ),
    result(
      'index-walk/invalid-index',
      'retains rows with indisvalid = false and labels them INVALID',
      invalidMismatches.length > 0
        ? `invalid index missing or mislabeled: ${invalidMismatches.map((row) => row.index_name).join(', ')}`
        : `${invalidServer.length} invalid index row retained and labeled INVALID`,
      invalidServer.length > 0 && invalidMismatches.length === 0,
    ),
    result(
      'psql-describe/invalid-index',
      cityDescribeLine || 'invalid index is absent',
      serverDescribeLine || 'psql did not display the invalid index',
      cityDescribeLine.length > 0 && cityDescribeLine === serverDescribeLine,
    ),
  ]
}

async function runChecks(server, registry, major) {
  const checks = [
    ['version', () => checkVersion(server.query, registry, major)],
    ['GUC defaults', () => checkGucDefaults(server.query, registry, major)],
    ['catalog shapes', () => checkCatalog(server.psql, server.query, registry, major)],
    ['wait events', () => checkWaitEvents(server.query, registry, major)],
    ['checkpoint timer skip', () => checkCheckpointTimerSkip(server.psql, server.query, registry, major)],
    ['autovacuum threshold', () => checkAutovacuumThreshold(server.psql, server.query, registry)],
    ['pg_stat_io values', () => checkPgStatIo(server.query, registry, major)],
    ['index walk', () => checkIndexWalk(server.psql, server.query, registry)],
  ]
  const results = []
  for (const [name, check] of checks) {
    try {
      results.push(...await check())
    } catch (error) {
      results.push(result(`oracle/${name}`, 'check completes', error.message, false))
    }
  }
  return results
}

function parseMajor(registry) {
  const raw = process.env.PG_VERSION ?? String(registry.target.major)
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`PG_VERSION must be a PostgreSQL major number, received ${JSON.stringify(raw)}`)
  }
  return Number(raw)
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: PG_VERSION=18 node tools/pg-oracle.mjs\nSet PG_ORACLE_ALL=1 to print matches as well as divergences.')
    return
  }

  const startedAt = performance.now()
  const registry = await loadOracleRegistry()
  const major = parseMajor(registry)
  const pgBin = `/usr/lib/postgresql/${major}/bin`
  for (const binary of ['initdb', 'pg_ctl', 'psql', 'postgres']) {
    try {
      await access(path.join(pgBin, binary))
    } catch {
      throw new Error(`PostgreSQL ${major} binary is missing: ${path.join(pgBin, binary)}`)
    }
  }

  const execution = await withThrowawayCluster(pgBin, async (server) => ({
    results: await runChecks(server, registry, major),
    port: server.port,
    scratch: server.scratch,
  }))
  const elapsed = (performance.now() - startedAt) / 1000
  const divergences = execution.results.filter((row) => row.verdict === 'DIVERGES')
  const matches = execution.results.length - divergences.length

  console.log(`# PGSimCity PostgreSQL ${major} oracle`)
  console.log('')
  console.log(`Throwaway cluster used probed port ${execution.port}; ${execution.scratch} was removed before this report.`)
  console.log(`Checks: ${execution.results.length} total · ${matches} match · ${divergences.length} diverge.`)
  console.log('')
  console.log(process.env.PG_ORACLE_ALL === '1' ? '## All observations' : '## Divergences')
  console.log('')
  console.log(markdownTable(process.env.PG_ORACLE_ALL === '1' ? execution.results : divergences))
  console.log('')
  console.log(`Wall time: ${elapsed.toFixed(2)} s`)
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await activeCleanup?.()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  main().catch(async (error) => {
    await activeCleanup?.()
    console.error(`pg-oracle: ${error.message}`)
    process.exitCode = 1
  })
}
