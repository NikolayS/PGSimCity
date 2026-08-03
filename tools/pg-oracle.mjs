#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
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

    await symlink(path.join(REPO_ROOT, 'node_modules'), path.join(buildDir, 'node_modules'), 'dir')
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
    diagnosticSql: sources.diagnosticSql,
  }
}

export function expectedForMajor(claim, major) {
  const variants = Array.isArray(claim.expected) ? claim.expected : [claim.expected]
  return variants.find((variant) =>
    (variant.from === undefined || major >= variant.from)
    && (variant.to === undefined || major <= variant.to)) ?? null
}

export function diagnosticSqlForMajor(entry, major) {
  return entry.variants.find((variant) =>
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

export function verdictForComparison(matches, registeredDivergence = false) {
  if (!registeredDivergence) return matches ? 'MATCH' : 'DIVERGES'
  return matches ? 'UNEXPECTED MATCH' : 'REGISTERED DIVERGENCE'
}

function result(claim, city, server, matches, registeredDivergence = false) {
  return {
    claim,
    city,
    server,
    verdict: verdictForComparison(matches, registeredDivergence),
  }
}

export function oracleSummary(rows) {
  const unexpectedRows = rows.filter((row) =>
    row.verdict === 'DIVERGES' || row.verdict === 'UNEXPECTED MATCH')
  return {
    matches: rows.filter((row) => row.verdict === 'MATCH').length,
    registered: rows.filter((row) => row.verdict === 'REGISTERED DIVERGENCE').length,
    unexpected: unexpectedRows.length,
    unexpectedRows,
  }
}

export async function checkDiagnosticSql(psql, registry, major) {
  const results = []
  for (const entry of registry.diagnosticSql) {
    const variant = diagnosticSqlForMajor(entry, major)
    if (!variant) {
      results.push(result(
        `diagnostic-sql/${entry.id}`,
        `executes on PostgreSQL ${major}`,
        'no SQL variant registered for this major',
        false,
      ))
      continue
    }
    const execution = await psql(variant.sql, { allowFailure: true })
    const detail = execution.code === 0
      ? 'executed successfully'
      : execution.stderr.trim() || execution.stdout.trim() || `psql exited ${execution.code}`
    results.push(result(
      `diagnostic-sql/${entry.id}`,
      `executes on PostgreSQL ${major}`,
      detail,
      execution.code === 0,
    ))
  }
  return results
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
      `${claim.cityClaim}: ${displayExpected(expected)}${claim.registeredDivergence ? `; registered difference: ${claim.registeredDivergence}` : ''}`,
      server
        ? `${serverField === 'setting' ? 'SHOW' : serverField} ${server[serverField]}${serverField === 'setting' && server.unit ? ` ${server.unit}` : ''} (${server.source})`
        : 'setting is absent',
      compareSetting(expected, server),
      Boolean(claim.registeredDivergence),
    ))
  }
  return results
}

export async function checkGucContexts(query, registry, major) {
  const claims = registry.claims.gucContexts
  const names = [...new Set(claims.map((claim) => claim.setting))]
  const rows = await query(`
    SELECT name, context
      FROM pg_catalog.pg_settings
     WHERE name IN (${names.map(sqlLiteral).join(', ')})`)
  const byName = new Map(rows.map((row) => [row.name, row]))
  const results = []
  for (const claim of claims) {
    const expected = expectedForMajor(claim, major)
    if (!expected) continue
    const server = byName.get(claim.setting)
    results.push(result(
      `GUC-context/${claim.setting}`,
      `${claim.cityClaim}: ${expected.context}`,
      server?.context ?? 'setting is absent',
      server?.context === expected.context,
    ))
  }
  return results
}

export function hotUpdateChecks(rows, major, since, expectedUpdates) {
  const byName = new Map(rows.map((row) => [row.relname, row]))
  const check = (relation, expectedHot, reason) => {
    const row = byName.get(relation)
    const updates = Number(row?.n_tup_upd)
    const hot = Number(row?.n_tup_hot_upd)
    const newPage = row?.n_tup_newpage_upd === null || row?.n_tup_newpage_upd === undefined
      ? null
      : Number(row.n_tup_newpage_upd)
    return result(
      `HOT/${relation}`,
      `${expectedUpdates} updates; ${expectedHot} HOT (${reason})`,
      row
        ? `n_tup_upd ${updates}, n_tup_hot_upd ${hot}, n_tup_newpage_upd ${newPage ?? 'not available'}`
        : 'statistics row is absent',
      updates === expectedUpdates
        && hot === expectedHot
        && (newPage === null || newPage === 0),
    )
  }

  return [
    check(
      'hot_brin',
      major >= since ? expectedUpdates : 0,
      major >= since
        ? `summarizing indexes allow HOT since PostgreSQL ${since}`
        : `summarizing indexes block HOT before PostgreSQL ${since}`,
    ),
    check('hot_btree', 0, 'an ordinary B-tree covers the changed column'),
  ]
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

async function checkStatementTimeout(psql, registry, port) {
  const claim = registry.claims.operatorAdvice.statementTimeout
  const applicationName = 'oracle_statement_timeout'
  const connection = [
    'host=127.0.0.1',
    `port=${port}`,
    'dbname=postgres',
    'user=postgres',
    `application_name=${applicationName}`,
  ].join(' ')
  const execution = await psql(`
    CREATE EXTENSION IF NOT EXISTS dblink;
    SELECT public.dblink_connect('timeout_idle', ${sqlLiteral(connection)});
    SELECT public.dblink_exec(
      'timeout_idle',
      ${sqlLiteral(`SET statement_timeout = '${claim.timeoutMs}ms'`)}
    );
    SELECT public.dblink_exec(
      'timeout_idle',
      'BEGIN ISOLATION LEVEL REPEATABLE READ'
    );
    CREATE TEMP TABLE oracle_timeout_snapshot AS
    SELECT snapshot
      FROM public.dblink(
        'timeout_idle',
        'SELECT pg_catalog.pg_current_snapshot()::text'
      ) AS observed(snapshot text);
    SELECT pg_catalog.pg_sleep(${claim.idleMs / 1_000});
    SELECT pg_catalog.json_build_object(
             'state', activity.state,
             'idle_ms', pg_catalog.round(
               extract(epoch FROM pg_catalog.clock_timestamp() - activity.state_change)
                 * 1000
             ),
             'snapshot', snapshot.snapshot
           )::text
      FROM pg_catalog.pg_stat_activity AS activity
      CROSS JOIN oracle_timeout_snapshot AS snapshot
     WHERE activity.application_name = ${sqlLiteral(applicationName)};
    SELECT public.dblink_disconnect('timeout_idle');`)
  const json = execution.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'))
  const observation = json ? JSON.parse(json) : null
  const remainedIdle = observation?.state === 'idle in transaction'
    && Number(observation?.idle_ms) >= claim.idleMs
  return [result(
    'timeout/statement-timeout-does-not-end-idle-transaction',
    `${claim.timeoutMs} ms statement_timeout does not end a transaction idle between statements`,
    observation
      ? `${observation.state} after ${observation.idle_ms} ms idle; snapshot ${observation.snapshot}`
      : 'idle transaction observation is absent',
    remainedIdle,
  )]
}

async function checkPhysicalSlotDrop(pgBin, psql, query, registry, port, scratch) {
  const claim = registry.claims.operatorAdvice.physicalSlotDrop
  const standbyDir = path.join(scratch, 'standby')
  const standbySocket = path.join(scratch, 'standby-socket')
  const standbyLog = path.join(scratch, 'standby.log')
  const standbyPort = await freePort()
  let standbyStarted = false

  const stopStandby = async () => {
    if (!standbyStarted) return
    await run(path.join(pgBin, 'pg_ctl'), [
      '-D', standbyDir, '-m', 'fast', '-w', 'stop',
    ], { allowFailure: true })
    standbyStarted = false
  }
  const startStandby = async (slot) => {
    const slotOption = slot ? ` -c primary_slot_name=${slot}` : ''
    await run(path.join(pgBin, 'pg_ctl'), [
      '-D', standbyDir,
      '-l', standbyLog,
      '-o', `-h 127.0.0.1 -p ${standbyPort} -k ${standbySocket}${slotOption}`,
      '-w', 'start',
    ])
    standbyStarted = true
  }
  const standbyQuery = async (sql) => {
    const body = sql.trim().replace(/;+\s*$/u, '')
    const execution = await run(path.join(pgBin, 'psql'), [
      '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
      '-h', '127.0.0.1', '-p', String(standbyPort),
      '-U', 'postgres', '-d', 'postgres',
      '-c', `SELECT COALESCE(json_agg(oracle_row), '[]'::json) FROM (${body}) AS oracle_row;`,
    ])
    return JSON.parse(execution.stdout.trim() || '[]')
  }

  try {
    await psql(`
      CREATE TABLE public.${claim.relation} (
        id integer PRIMARY KEY,
        payload text NOT NULL
      )`)
    await run(path.join(pgBin, 'pg_basebackup'), [
      '-D', standbyDir,
      '-R',
      '-X', 'stream',
      '--checkpoint=fast',
      '-h', '127.0.0.1',
      '-p', String(port),
      '-U', 'postgres',
    ])
    await mkdir(standbySocket)
    await psql(`SELECT * FROM pg_catalog.pg_create_physical_replication_slot(${sqlLiteral(claim.slot)})`)
    await startStandby(claim.slot)
    const active = await pollRow(
      query,
      `SELECT active FROM pg_catalog.pg_replication_slots WHERE slot_name = ${sqlLiteral(claim.slot)}`,
      (row) => row?.active === true,
      15_000,
    )
    if (active?.active !== true) throw new Error(`${claim.slot} did not become active`)
    await stopStandby()
    await pollRow(
      query,
      `SELECT active FROM pg_catalog.pg_replication_slots WHERE slot_name = ${sqlLiteral(claim.slot)}`,
      (row) => row?.active === false,
      10_000,
    )

    await psql(`
      SET synchronous_commit = off;
      INSERT INTO public.${claim.relation}
      SELECT value, pg_catalog.repeat(pg_catalog.md5(value::text), ${claim.payloadMd5Repeats})
        FROM pg_catalog.generate_series(1, ${claim.rows}) AS value;
      CHECKPOINT`)
    const [before] = await query(`
      SELECT slot.slot_name,
             pg_catalog.pg_wal_lsn_diff(
               pg_catalog.pg_current_wal_lsn(),
               slot.restart_lsn
             )::bigint AS retained_bytes,
             wal.wal_files,
             wal.pg_wal_bytes
        FROM pg_catalog.pg_replication_slots AS slot
        CROSS JOIN LATERAL (
          SELECT pg_catalog.count(*)::integer AS wal_files,
                 pg_catalog.sum(size)::bigint AS pg_wal_bytes
            FROM pg_catalog.pg_ls_waldir()
        ) AS wal
       WHERE slot.slot_name = ${sqlLiteral(claim.slot)}`)

    await psql(`SELECT pg_catalog.pg_drop_replication_slot(${sqlLiteral(claim.slot)})`)
    const [after] = await query(`
      SELECT pg_catalog.count(*)::integer AS wal_files,
             pg_catalog.sum(size)::bigint AS pg_wal_bytes
        FROM pg_catalog.pg_ls_waldir()`)

    await startStandby(null)
    let standby = null
    const replayDeadline = performance.now() + 30_000
    while (performance.now() < replayDeadline) {
      ;[standby] = await standbyQuery(`
        SELECT pg_catalog.pg_is_in_recovery() AS still_standby,
               (SELECT pg_catalog.count(*) FROM public.${claim.relation})::integer AS replayed_rows`)
      if (standby?.still_standby === true && Number(standby?.replayed_rows) === claim.rows) break
      await delay(250)
    }
    const [receiver] = await query(`
      SELECT application_name, state, replay_lsn
        FROM pg_catalog.pg_stat_replication
       ORDER BY pid
       LIMIT 1`)
    const [slotAfter] = await query(`
      SELECT pg_catalog.count(*)::integer AS slots
        FROM pg_catalog.pg_replication_slots
       WHERE slot_name = ${sqlLiteral(claim.slot)}`)

    const retained = Number(before?.retained_bytes)
    const walUnchanged = Number(before?.pg_wal_bytes) === Number(after?.pg_wal_bytes)
      && Number(before?.wal_files) === Number(after?.wal_files)
    const resumed = standby?.still_standby === true
      && Number(standby?.replayed_rows) === claim.rows
      && receiver?.state === 'streaming'
      && Number(slotAfter?.slots) === 0
    const transcript = before && after && standby && receiver
      ? `before drop: wal_files ${before.wal_files}, pg_wal_bytes ${before.pg_wal_bytes}, retained_bytes ${before.retained_bytes}; after drop: wal_files ${after.wal_files}, pg_wal_bytes ${after.pg_wal_bytes}; restart without primary_slot_name: still_standby ${standby.still_standby}, replayed_rows ${standby.replayed_rows}, application_name ${receiver.application_name}, state ${receiver.state}, replay_lsn ${receiver.replay_lsn}; no base backup after drop`
      : 'physical standby observation is incomplete'
    return [result(
      'replication/drop-physical-slot-keeps-available-wal',
      'dropping an inactive physical slot removes its retention guarantee without deleting WAL or requiring an immediate base backup',
      transcript,
      retained >= claim.minimumRetainedBytes && walUnchanged && resumed,
    )]
  } finally {
    await stopStandby()
  }
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

async function checkStorageMvcc(psql, query, registry, major) {
  const claim = registry.claims.storageMvcc
  const lock = claim.lockOnlyXmax
  await psql(`CREATE EXTENSION IF NOT EXISTS ${lock.extension}`)
  await psql(`
    CREATE TABLE public.${lock.relation} (
      id integer PRIMARY KEY,
      note text NOT NULL
    );
    INSERT INTO public.${lock.relation} VALUES (1, 'still live')`)
  await psql(`
    BEGIN;
    SELECT * FROM public.${lock.relation} WHERE id = 1 FOR UPDATE;
    COMMIT`)
  const statusExpression = major >= 14
    ? 'pg_catalog.pg_xact_status(h.t_xmax::text::xid8)'
    : 'pg_catalog.txid_status(h.t_xmax::text::bigint)'
  const [lockRow] = await query(`
    SELECT h.lp,
           h.t_xmin::text AS t_xmin,
           h.t_xmax::text AS t_xmax,
           ${statusExpression} AS xmax_status,
           h.t_ctid::text AS t_ctid,
           pg_catalog.array_to_string(
             (public.heap_tuple_infomask_flags(h.t_infomask, h.t_infomask2)).raw_flags,
             ', '
           ) AS flags,
           (SELECT note FROM public.${lock.relation} WHERE id = 1) AS live_note
      FROM public.heap_page_items(public.get_raw_page('public.${lock.relation}', 0)) AS h
     WHERE h.lp = 1`)
  const lockFlags = String(lockRow?.flags ?? '')
  const lockOnly = lockRow?.xmax_status === 'committed'
    && lockRow?.live_note === 'still live'
    && lockFlags.includes('HEAP_XMAX_LOCK_ONLY')

  const hot = claim.hotSummarizingIndex
  await psql(`
    CREATE TABLE public.${hot.brinRelation} (
      id integer PRIMARY KEY,
      payload integer NOT NULL,
      filler text NOT NULL
    ) WITH (fillfactor = 50, autovacuum_enabled = false);
    CREATE TABLE public.${hot.btreeRelation} (
      id integer PRIMARY KEY,
      payload integer NOT NULL,
      filler text NOT NULL
    ) WITH (fillfactor = 50, autovacuum_enabled = false);
    INSERT INTO public.${hot.brinRelation}
    SELECT value, value, repeat('x', 32)
      FROM pg_catalog.generate_series(1, ${hot.rows}) AS value;
    INSERT INTO public.${hot.btreeRelation}
    SELECT value, value, repeat('x', 32)
      FROM pg_catalog.generate_series(1, ${hot.rows}) AS value;
    CREATE INDEX ${hot.brinRelation}_payload_idx
      ON public.${hot.brinRelation} USING brin (payload) WITH (pages_per_range = 32);
    CREATE INDEX ${hot.btreeRelation}_payload_idx
      ON public.${hot.btreeRelation} (payload)`)
  await psql(`UPDATE public.${hot.brinRelation} SET payload = payload + 100000`)
  await psql(`UPDATE public.${hot.btreeRelation} SET payload = payload + 100000`)

  const newPageProjection = major >= 16 ? 's.n_tup_newpage_upd' : 'NULL::bigint'
  let hotRows = []
  for (let attempt = 0; attempt < 20; attempt++) {
    hotRows = await query(`
      SELECT c.relname,
             s.n_tup_upd,
             s.n_tup_hot_upd,
             ${newPageProjection} AS n_tup_newpage_upd
        FROM pg_catalog.pg_stat_user_tables AS s
        JOIN pg_catalog.pg_class AS c ON c.oid = s.relid
       WHERE c.relname IN ('${hot.brinRelation}', '${hot.btreeRelation}')
       ORDER BY c.relname`)
    if (hotRows.length === 2
      && hotRows.every((row) => Number(row.n_tup_upd) === hot.rows)) break
    await delay(100)
  }

  const brinSummaryRows = await query(`
    WITH pages AS (
      SELECT block_number,
             public.get_raw_page(
               'public.${hot.brinRelation}_payload_idx',
               block_number::integer
             ) AS page
        FROM pg_catalog.generate_series(
          0,
          pg_catalog.pg_relation_size('public.${hot.brinRelation}_payload_idx')
            / current_setting('block_size')::integer - 1
        ) AS block_number
    ), regular_pages AS (
      SELECT block_number, page
        FROM pages
       WHERE public.brin_page_type(page) = 'regular'
    )
    SELECT items.itemoffset,
           items.blknum,
           items.value
      FROM regular_pages
      CROSS JOIN LATERAL public.brin_page_items(
        regular_pages.page,
        'public.${hot.brinRelation}_payload_idx'::regclass
      ) AS items
     WHERE items.attnum = 1
     ORDER BY items.blknum`)
  const summary = brinSummaryRows
    .map((row) => `${row.itemoffset}:${row.blknum}:${row.value}`)
    .join(' | ')
  const summaryMaintained = brinSummaryRows.some((row) => String(row.value).includes('105000'))

  const reindex = claim.reindexHeap
  await psql(`
    CREATE TABLE public.${reindex.relation} (id integer, payload text NOT NULL);
    INSERT INTO public.${reindex.relation} VALUES (1, 'one'), (2, 'two');
    CREATE INDEX ${reindex.relation}_payload_idx ON public.${reindex.relation} (payload)`)
  const [reindexBefore] = await query(`
    SELECT pg_catalog.pg_relation_filenode('public.${reindex.relation}'::regclass)::text AS heap,
           pg_catalog.pg_relation_filenode('public.${reindex.relation}_payload_idx'::regclass)::text AS index`)
  await psql(`REINDEX TABLE public.${reindex.relation}`)
  const [reindexAfter] = await query(`
    SELECT pg_catalog.pg_relation_filenode('public.${reindex.relation}'::regclass)::text AS heap,
           pg_catalog.pg_relation_filenode('public.${reindex.relation}_payload_idx'::regclass)::text AS index`)
  const heapPreserved = reindexBefore?.heap === reindexAfter?.heap
    && reindexBefore?.index !== reindexAfter?.index

  const toast = claim.toastTupleTarget
  await psql(`
    CREATE TABLE public.oracle_toast_value (payload text NOT NULL);
    INSERT INTO public.oracle_toast_value
    SELECT pg_catalog.left(pg_catalog.string_agg(pg_catalog.md5(value::text), ''), ${toast.valueBytes})
      FROM pg_catalog.generate_series(1, 100) AS value;
    CREATE TABLE public.oracle_toast_default (payload text NOT NULL);
    ALTER TABLE public.oracle_toast_default ALTER COLUMN payload SET STORAGE EXTERNAL;
    CREATE TABLE public.oracle_toast_raised (payload text NOT NULL)
      WITH (toast_tuple_target = ${toast.raisedTarget});
    ALTER TABLE public.oracle_toast_raised ALTER COLUMN payload SET STORAGE EXTERNAL;
    CREATE TABLE public.oracle_toast_compressed (payload text NOT NULL);
    INSERT INTO public.oracle_toast_default SELECT payload FROM public.oracle_toast_value;
    INSERT INTO public.oracle_toast_raised SELECT payload FROM public.oracle_toast_value;
    INSERT INTO public.oracle_toast_compressed VALUES (repeat('compress me ', 300))`)
  const toastRows = await query(`
    SELECT relation,
           raw_size,
           logical_size,
           toast_heap_bytes
      FROM (
        SELECT 'default-external' AS relation,
               pg_catalog.octet_length(items.t_attrs[1]) AS raw_size,
               (SELECT pg_catalog.octet_length(payload) FROM public.oracle_toast_default) AS logical_size,
               pg_catalog.pg_relation_size(c.reltoastrelid) AS toast_heap_bytes
          FROM public.heap_page_item_attrs(
                 public.get_raw_page('public.oracle_toast_default', 0),
                 'public.oracle_toast_default'::regclass,
                 false
               ) AS items
          CROSS JOIN pg_catalog.pg_class AS c
         WHERE c.oid = 'public.oracle_toast_default'::regclass
        UNION ALL
        SELECT 'raised-inline',
               pg_catalog.octet_length(items.t_attrs[1]),
               (SELECT pg_catalog.octet_length(payload) FROM public.oracle_toast_raised),
               pg_catalog.pg_relation_size(c.reltoastrelid)
          FROM public.heap_page_item_attrs(
                 public.get_raw_page('public.oracle_toast_raised', 0),
                 'public.oracle_toast_raised'::regclass,
                 false
               ) AS items
          CROSS JOIN pg_catalog.pg_class AS c
         WHERE c.oid = 'public.oracle_toast_raised'::regclass
        UNION ALL
        SELECT 'compressed-inline',
               pg_catalog.octet_length(items.t_attrs[1]),
               (SELECT pg_catalog.octet_length(payload) FROM public.oracle_toast_compressed),
               pg_catalog.pg_relation_size(c.reltoastrelid)
          FROM public.heap_page_item_attrs(
                 public.get_raw_page('public.oracle_toast_compressed', 0),
                 'public.oracle_toast_compressed'::regclass,
                 false
               ) AS items
          CROSS JOIN pg_catalog.pg_class AS c
         WHERE c.oid = 'public.oracle_toast_compressed'::regclass
      ) AS observations
     ORDER BY relation`)
  const toastByName = new Map(toastRows.map((row) => [row.relation, row]))
  const defaultExternal = toastByName.get('default-external')
  const raisedInline = toastByName.get('raised-inline')
  const compressedInline = toastByName.get('compressed-inline')
  const targetChangesStorage = Number(defaultExternal?.raw_size) < 100
    && Number(defaultExternal?.toast_heap_bytes) > 0
    && Number(raisedInline?.raw_size) > toast.valueBytes
    && Number(raisedInline?.toast_heap_bytes) === 0
    && Number(defaultExternal?.logical_size) === toast.valueBytes
    && Number(raisedInline?.logical_size) === toast.valueBytes
  const threeReadPaths = Number(raisedInline?.raw_size) > toast.valueBytes
    && Number(compressedInline?.raw_size) > 20
    && Number(compressedInline?.raw_size) < 500
    && Number(compressedInline?.toast_heap_bytes) === 0
    && Number(defaultExternal?.raw_size) < 100
    && Number(defaultExternal?.toast_heap_bytes) > 0
  const toastSummary = toastRows
    .map((row) => `${row.relation}: raw ${row.raw_size}, logical ${row.logical_size}, toast heap ${row.toast_heap_bytes}`)
    .join(' | ')

  const [snapshot] = await query(`
    SELECT pg_catalog.split_part(pg_catalog.pg_current_snapshot()::text, ':', 1)::bigint AS snapshot_xmin,
           xmin::text::bigint AS tuple_xmin,
           note
      FROM public.${lock.relation}
     WHERE id = 1`)
  const oldCreatorVisible = snapshot?.note === 'still live'
    && Number(snapshot?.tuple_xmin) < Number(snapshot?.snapshot_xmin)

  const readOnly = await psql(`
    BEGIN READ ONLY;
    SELECT current_setting('transaction_read_only'), ${claim.readOnlyXid.function}::text`)
  const readOnlyObservation = readOnly.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^on\|\d+$/u.test(line)) ?? ''

  return [
    result(
      'MVCC/committed-lock-only-xmax',
      'committed HEAP_XMAX_LOCK_ONLY leaves the tuple live',
      lockRow
        ? `lp ${lockRow.lp}, t_xmin ${lockRow.t_xmin}, t_xmax ${lockRow.t_xmax}, xmax_status ${lockRow.xmax_status}, t_ctid ${lockRow.t_ctid}, flags ${lockFlags}, row ${lockRow.live_note}`
        : 'heap tuple is absent',
      lockOnly,
    ),
    ...hotUpdateChecks(hotRows, major, hot.since, hot.rows),
    result(
      'HOT/BRIN-summary-maintenance',
      'the BRIN summary includes the updated upper bound 105000',
      summary || 'no BRIN summary rows',
      summaryMaintained,
    ),
    result(
      'storage/REINDEX-TABLE-heap-filnode',
      'REINDEX TABLE changes the index filenode but preserves the heap filenode',
      `heap ${reindexBefore?.heap} -> ${reindexAfter?.heap}; index ${reindexBefore?.index} -> ${reindexAfter?.index}`,
      heapPreserved,
    ),
    result(
      'TOAST/toast_tuple_target',
      `${toast.valueBytes}-byte value external at the default target and inline at ${toast.raisedTarget}`,
      toastSummary,
      targetChangesStorage,
    ),
    result(
      'TOAST/wide-value-storage-paths',
      'wide datums can be inline uncompressed, inline compressed, or out of line',
      toastSummary,
      threeReadPaths,
    ),
    result(
      'MVCC/snapshot-xmin-is-not-oldest-visible-creator',
      'a snapshot sees a committed tuple whose creator XID is older than snapshot xmin',
      snapshot
        ? `snapshot xmin ${snapshot.snapshot_xmin}, visible tuple xmin ${snapshot.tuple_xmin}, note ${snapshot.note}`
        : 'visible tuple is absent',
      oldCreatorVisible,
    ),
    result(
      'MVCC/read-only-assigned-xid',
      'BEGIN READ ONLY can hold an assigned XID after pg_current_xact_id()',
      readOnlyObservation || 'read-only XID observation is absent',
      readOnlyObservation.length > 0,
    ),
  ]
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
      created_at timestamptz NOT NULL,
      metadata jsonb NOT NULL
    );
    INSERT INTO oracle_fixture.accounts
      (id, tenant_id, owner, balance, email, deleted_at, created_at, metadata)
    VALUES
      (1, 10, 'duplicate', 100, 'one@example.test', NULL, '2026-01-01', '{"tier":"a"}'),
      (2, 10, 'duplicate', 200, 'two@example.test', now(), '2026-01-02', '{"tier":"b"}'),
      (3, 20, 'unique', 300, 'three@example.test', NULL, '2026-01-03', '{"tier":"a"}');
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
    CREATE INDEX accounts_created_brin_idx
      ON oracle_fixture.accounts USING brin (created_at);
  `)
  await psql(
    'CREATE UNIQUE INDEX CONCURRENTLY accounts_invalid_owner_idx ON oracle_fixture.accounts (owner);',
    { allowFailure: true },
  )
}

const INDEX_ROW_FIELDS = [
  'access_method',
  'uniqueness',
  'validity',
  'predicate',
  'index_definition',
]

function sameIndexRow(cityRow, serverRow) {
  return Boolean(
    cityRow
    && serverRow
    && INDEX_ROW_FIELDS.every((field) => cityRow[field] === serverRow[field]),
  )
}

function indexRowSummary(row) {
  if (!row) return 'index row is absent'
  return [
    `${row.index_name}: ${row.validity} ${row.uniqueness} ${row.access_method}`,
    row.predicate ? `predicate ${row.predicate}` : 'all rows',
    row.index_definition,
  ].join('; ')
}

export function indexWalkAttributeChecks(cityRows, serverRows, catalogSql) {
  const cityByName = new Map(cityRows.map((row) => [row.index_name, row]))
  const serverByName = new Map(serverRows.map((row) => [row.index_name, row]))
  const attribute = (id, name, validate) => {
    const cityRow = cityByName.get(name)
    const serverRow = serverByName.get(name)
    return result(
      `index-walk/${id}`,
      indexRowSummary(cityRow),
      indexRowSummary(serverRow),
      sameIndexRow(cityRow, serverRow)
        && validate(cityRow)
        && validate(serverRow),
    )
  }

  const nonBtree = [
    ['accounts_hash_idx', 'hash'],
    ['accounts_metadata_gin_idx', 'gin'],
    ['accounts_created_brin_idx', 'brin'],
  ]
  const cityNonBtree = nonBtree.map(([name]) => cityByName.get(name))
  const serverNonBtree = nonBtree.map(([name]) => serverByName.get(name))
  const inventsKeyPosition = /\bposition\b|WITH\s+ORDINALITY|pg_get_indexdef\s*\([^,()]+,\s*/iu
    .test(catalogSql)
  const nonBtreeMatches = nonBtree.every(([name, method]) => {
    const cityRow = cityByName.get(name)
    const serverRow = serverByName.get(name)
    return sameIndexRow(cityRow, serverRow)
      && cityRow?.access_method === method
      && serverRow?.access_method === method
      && String(cityRow?.index_definition).includes(`USING ${method}`)
      && String(serverRow?.index_definition).includes(`USING ${method}`)
  })

  return [
    attribute('composite-key-order', 'accounts_tenant_owner_idx', (row) =>
      /USING btree \(tenant_id, owner\)/u.test(String(row?.index_definition))),
    attribute('include-columns', 'accounts_owner_include_idx', (row) =>
      /USING btree \(owner\) INCLUDE \(balance, email\)/u.test(String(row?.index_definition))),
    attribute('expression-key', 'accounts_lower_owner_idx', (row) =>
      /USING btree \(lower\(owner\)\)/u.test(String(row?.index_definition))),
    attribute('partial-predicate', 'accounts_open_balance_idx', (row) =>
      Boolean(row?.predicate)
      && /deleted_at IS NULL/u.test(String(row.predicate))
      && /\bWHERE\b/u.test(String(row.index_definition))),
    result(
      'index-walk/non-btree-access-method',
      `${cityNonBtree.map(indexRowSummary).join(' | ')}; key position projected: ${inventsKeyPosition ? 'yes' : 'no'}`,
      serverNonBtree.map(indexRowSummary).join(' | '),
      nonBtreeMatches && !inventsKeyPosition,
    ),
    attribute('collation', 'accounts_collate_idx', (row) =>
      /COLLATE "C"/u.test(String(row?.index_definition))),
    attribute('operator-class', 'accounts_opclass_idx', (row) =>
      /\btext_pattern_ops\b/u.test(String(row?.index_definition))),
    attribute('key-ordering', 'accounts_desc_idx', (row) =>
      /\bDESC NULLS LAST\b/u.test(String(row?.index_definition))),
    attribute('combined-modifiers', 'accounts_modifiers_idx', (row) =>
      /COLLATE "C" text_pattern_ops DESC/u.test(String(row?.index_definition))),
    attribute('uniqueness', 'accounts_pkey', (row) =>
      row?.uniqueness === 'unique'
      && /^CREATE UNIQUE INDEX\b/u.test(String(row.index_definition))),
    attribute('invalid-index', 'accounts_invalid_owner_idx', (row) =>
      row?.validity === 'INVALID'),
  ]
}

async function checkIndexWalk(psql, query, registry) {
  await prepareIndexFixture(psql)
  const described = await psql('\\d oracle_fixture.accounts', { tuplesOnly: false })
  const cityRows = await query(registry.indexWalk.catalogSql)
  const serverRows = await query(`
    SELECT c.relname AS index_name,
           am.amname AS access_method,
           CASE WHEN i.indisunique THEN 'unique' ELSE 'non-unique' END AS uniqueness,
           CASE WHEN i.indisvalid THEN 'valid' ELSE 'INVALID' END AS validity,
           pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
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

  const cityInvalid = cityRows.find((row) => row.validity === 'INVALID')
  const cityDescribeLine = cityInvalid
    ? formatDescribeIndex({
      Name: cityInvalid.index_name,
      Primary: false,
      Unique: cityInvalid.uniqueness === 'unique',
      Valid: false,
      Definition: cityInvalid.index_definition,
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
    ...indexWalkAttributeChecks(cityRows, serverRows, registry.indexWalk.catalogSql),
    result(
      'psql-describe/invalid-index',
      cityDescribeLine || 'invalid index is absent',
      serverDescribeLine || 'psql did not display the invalid index',
      cityDescribeLine.length > 0 && cityDescribeLine === serverDescribeLine,
    ),
  ]
}

async function runChecks(server, registry, major, pgBin) {
  const checks = [
    ['version', () => checkVersion(server.query, registry, major)],
    ['GUC defaults', () => checkGucDefaults(server.query, registry, major)],
    ['GUC contexts', () => checkGucContexts(server.query, registry, major)],
    ['catalog shapes', () => checkCatalog(server.psql, server.query, registry, major)],
    ['diagnostic SQL', () => checkDiagnosticSql(server.psql, registry, major)],
    ['wait events', () => checkWaitEvents(server.query, registry, major)],
    ['checkpoint timer skip', () => checkCheckpointTimerSkip(server.psql, server.query, registry, major)],
    ['statement timeout', () => checkStatementTimeout(server.psql, registry, server.port)],
    ['physical slot drop', () => checkPhysicalSlotDrop(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
      server.scratch,
    )],
    ['autovacuum threshold', () => checkAutovacuumThreshold(server.psql, server.query, registry)],
    ['storage and MVCC', () => checkStorageMvcc(server.psql, server.query, registry, major)],
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
  for (const binary of ['initdb', 'pg_basebackup', 'pg_ctl', 'psql', 'postgres']) {
    try {
      await access(path.join(pgBin, binary))
    } catch {
      throw new Error(`PostgreSQL ${major} binary is missing: ${path.join(pgBin, binary)}`)
    }
  }

  const execution = await withThrowawayCluster(pgBin, async (server) => ({
    results: await runChecks(server, registry, major, pgBin),
    port: server.port,
    scratch: server.scratch,
  }))
  const elapsed = (performance.now() - startedAt) / 1000
  const summary = oracleSummary(execution.results)
  const registeredRows = execution.results.filter(
    (row) => row.verdict === 'REGISTERED DIVERGENCE',
  )

  console.log(`# PGSimCity PostgreSQL ${major} oracle`)
  console.log('')
  console.log(`Throwaway cluster used probed port ${execution.port}; ${execution.scratch} was removed before this report.`)
  console.log(`Checks: ${execution.results.length} total · ${summary.matches} match · ${summary.registered} registered divergences · ${summary.unexpected} unexpected.`)
  console.log('')
  console.log(process.env.PG_ORACLE_ALL === '1' ? '## All observations' : '## Unexpected results')
  console.log('')
  console.log(markdownTable(
    process.env.PG_ORACLE_ALL === '1' ? execution.results : summary.unexpectedRows,
  ))
  if (process.env.PG_ORACLE_ALL !== '1' && registeredRows.length > 0) {
    console.log('')
    console.log('## Registered model divergences')
    console.log('')
    console.log(markdownTable(registeredRows))
  }
  console.log('')
  console.log(`Wall time: ${elapsed.toFixed(2)} s`)
  if (summary.unexpected > 0) process.exitCode = 1
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
