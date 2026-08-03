#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
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
const SERVER_CHECKABLE_CITY_CLAIMS = [
  'walSegment',
  'modelLatency',
  'connectionPooler',
  'workMem',
  'restoreDrill',
  'timelineRecovery',
  'vacuumReclaim',
  'mvccVocabulary',
  'machineSynchronousCommitComparison',
  'machineIndexWalk',
]
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

  const sourceRegistrations = registrations[0]
  const sources = await loadOwners(sourceRegistrations)
  const registeredCityClaims = SERVER_CHECKABLE_CITY_CLAIMS.filter((claimId) => {
    const registration = sourceRegistrations.find((record) => record.role === claimId)
    return registration?.owner === root.claims[claimId]?.owner
  })
  return {
    target: root.values.postgresqlVersion,
    claims: sources.claims,
    catalog: sources.catalog,
    indexWalk: sources.indexWalk,
    diagnosticSql: sources.diagnosticSql,
    cityClaims: Object.fromEntries(
      registeredCityClaims.map((claimId) => [claimId, sources[claimId]]),
    ),
    registeredCityClaims,
    unregisteredCityClaims: SERVER_CHECKABLE_CITY_CLAIMS.filter(
      (claimId) => !registeredCityClaims.includes(claimId),
    ),
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
  const archiveDir = path.join(scratch, 'archive')
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
    await mkdir(archiveDir)
    let port = 0
    for (let attempt = 0; attempt < 5 && !started; attempt++) {
      port = await freePort()
      const launch = await run(path.join(pgBin, 'pg_ctl'), [
        '-D', dataDir,
        '-l', logFile,
        '-o', [
          '-h 127.0.0.1',
          `-p ${port}`,
          `-k ${socketDir}`,
          '-c fsync=off',
          '-c max_prepared_transactions=10',
          '-c archive_mode=on',
          `-c archive_command='test ! -f ${archiveDir}/%f && cp %p ${archiveDir}/%f'`,
        ].join(' '),
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

    const psql = async (sql, {
      allowFailure = false,
      tuplesOnly = true,
      database = 'postgres',
      targetPort = port,
    } = {}) => run(
      path.join(pgBin, 'psql'),
      [
        '-X',
        ...(tuplesOnly ? ['-A', '-t'] : []),
        '-q',
        '-v', 'ON_ERROR_STOP=1',
        '-h', '127.0.0.1',
        '-p', String(targetPort),
        '-U', 'postgres',
        '-d', database,
        '-c', sql,
      ],
      {
        allowFailure,
        input: undefined,
      },
    )
    const query = async (sql, options) => {
      const body = sql.trim().replace(/;+\s*$/u, '')
      const result = await psql(
        `SELECT COALESCE(json_agg(oracle_row), '[]'::json) FROM (${body}) AS oracle_row;`,
        options,
      )
      const json = result.stdout.trim()
      return JSON.parse(json || '[]')
    }

    return await callback({ psql, query, port, scratch, archiveDir, dataDir })
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

function checkRegistryCoverage(registry) {
  return SERVER_CHECKABLE_CITY_CLAIMS.map((claimId) => {
    const registered = registry.registeredCityClaims.includes(claimId)
    return result(
      `registry/${claimId}`,
      'server-checkable city claim has an explicit oracle source registration',
      registered
        ? `${claimId} resolves through the claims registry`
        : `${claimId} is not registered as an oracle source`,
      registered,
    )
  })
}

async function checkWalSegment(psql, query, registry) {
  const city = registry.cityClaims.walSegment
  const claim = registry.claims.walSegment
  await psql('SELECT pg_catalog.pg_switch_wal()')
  const [observation] = await query(`
    SELECT current_setting('wal_segment_size') AS configured,
           setting,
           unit,
           wal.file_name,
           wal.file_offset,
           directory.name AS allocated_file,
           directory.size AS file_size
      FROM pg_catalog.pg_settings
      CROSS JOIN LATERAL pg_catalog.pg_walfile_name_offset(
        pg_catalog.pg_current_wal_lsn()
      ) AS wal
      LEFT JOIN LATERAL (
        SELECT name, size
          FROM pg_catalog.pg_ls_waldir()
         ORDER BY size DESC, name
         LIMIT 1
      ) AS directory ON true
     WHERE pg_settings.name = 'wal_segment_size'`)
  const configuredBytes = unitValue(observation?.setting, observation?.unit, 'bytes')
  const fileSize = Number(observation?.file_size)
  const fileName = String(observation?.file_name ?? '')
  const fileOffset = Number(observation?.file_offset)
  const citySummary = `${city.label} (${city.bytes} bytes)`
  return [
    result(
      'WAL/segment-size-setting',
      citySummary,
      observation
        ? `wal_segment_size ${observation.configured}; ${configuredBytes} bytes`
        : 'wal_segment_size observation is absent',
      configuredBytes === claim.bytes && claim.bytes === city.bytes,
    ),
    result(
      'WAL/segment-file-size',
      `${citySummary}; an allocated pg_wal segment has that size`,
      observation
        ? `${observation.allocated_file} is ${fileSize} bytes`
        : 'WAL directory observation is absent',
      /^[0-9A-F]{24}$/u.test(String(observation?.allocated_file ?? ''))
        && fileSize === city.bytes,
    ),
    result(
      'WAL/file-name-offset',
      `WAL filename/offset arithmetic uses ${citySummary} segments`,
      observation ? `${fileName} offset ${fileOffset}` : 'WAL filename/offset observation is absent',
      /^[0-9A-F]{24}$/u.test(fileName)
        && fileOffset >= 0
        && fileOffset < city.bytes,
    ),
  ]
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

export async function checkVersion(query, registry, major) {
  const [server] = await query(`
    SELECT current_setting('server_version') AS server_version,
           current_setting('server_version_num') AS server_version_num`)
  const serverVersionNum = Number(server.server_version_num)
  const referenceVersionNum = registry.target.major * 10_000
    + registry.target.referenceMinor
  const matches = major === registry.target.major
    && Number.isInteger(serverVersionNum)
    && serverVersionNum >= registry.target.major * 10_000
    && serverVersionNum <= referenceVersionNum
  return [result(
    'postgresqlVersion/referenceLabel',
    `${registry.target.majorLabel ?? `PostgreSQL ${registry.target.major}`} major line; claims verified through ${registry.target.referenceLabel}`,
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

function psqlCommand(pgBin, port, sql) {
  return run(path.join(pgBin, 'psql'), [
    '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(port),
    '-U', 'postgres', '-d', 'postgres', '-c', sql,
  ], { allowFailure: true })
}

async function checkLatencyWaitMappings(pgBin, psql, query, registry, port) {
  const claim = registry.claims.latencyWaitMappings
  const city = registry.cityClaims.modelLatency
  await psql('CREATE TABLE public.oracle_relation_wait (id integer)')

  let holderExecution
  let relationExecution
  let syncRepExecution
  try {
    holderExecution = psqlCommand(pgBin, port, `
      SET application_name = 'oracle_relation_holder';
      BEGIN;
      LOCK TABLE public.oracle_relation_wait IN ACCESS EXCLUSIVE MODE;
      SELECT pg_catalog.pg_sleep(5);
      COMMIT`)
    await pollRow(
      query,
      `SELECT pid, wait_event_type, wait_event
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'oracle_relation_holder'`,
      (row) => row?.wait_event === 'PgSleep',
      5_000,
    )
    relationExecution = psqlCommand(pgBin, port, `
      SET application_name = 'oracle_relation_waiter';
      SELECT * FROM public.oracle_relation_wait`)
    const relationWait = await pollRow(
      query,
      `SELECT pid, wait_event_type, wait_event
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'oracle_relation_waiter'`,
      (row) => row?.wait_event_type === claim.relation.type
        && row?.wait_event === claim.relation.name,
      5_000,
    )
    if (relationWait?.pid) {
      await psql(`SELECT pg_catalog.pg_terminate_backend(${Number(relationWait.pid)})`)
    }
    await relationExecution
    relationExecution = null
    const [holder] = await query(`
      SELECT pid FROM pg_catalog.pg_stat_activity
       WHERE application_name = 'oracle_relation_holder'`)
    if (holder?.pid) await psql(`SELECT pg_catalog.pg_terminate_backend(${Number(holder.pid)})`)
    await holderExecution
    holderExecution = null

    await psql('CREATE TABLE public.oracle_sync_rep_wait (id integer)')
    await psql("ALTER SYSTEM SET synchronous_standby_names = 'oracle_missing_standby'")
    await psql('SELECT pg_catalog.pg_reload_conf()')
    syncRepExecution = psqlCommand(pgBin, port, `
      SET application_name = 'oracle_sync_rep_waiter';
      SET synchronous_commit = on;
      INSERT INTO public.oracle_sync_rep_wait VALUES (1)`)
    const syncRepWait = await pollRow(
      query,
      `SELECT pid, wait_event_type, wait_event
         FROM pg_catalog.pg_stat_activity
        WHERE application_name = 'oracle_sync_rep_waiter'`,
      (row) => row?.wait_event_type === claim.synchronousReplication.type
        && row?.wait_event === claim.synchronousReplication.name,
      5_000,
    )
    if (syncRepWait?.pid) {
      await psql(`SELECT pg_catalog.pg_terminate_backend(${Number(syncRepWait.pid)})`)
    }
    await syncRepExecution
    syncRepExecution = null
    const poolRows = await query(`
      SELECT pid, wait_event_type, wait_event
        FROM pg_catalog.pg_stat_activity
       WHERE pg_catalog.lower(COALESCE(wait_event, '')) LIKE '%pool%'
          OR wait_event = ${sqlLiteral(claim.poolWaitName)}`)

    return [
      result(
        'latency-wait/relation-lock',
        `relation lock maps to ${claim.relation.type}/${claim.relation.name}`,
        relationWait
          ? `${relationWait.wait_event_type}/${relationWait.wait_event}`
          : 'the coordinated waiter was not observed',
        relationWait?.wait_event_type === claim.relation.type
          && relationWait?.wait_event === claim.relation.name,
      ),
      result(
        'latency-wait/synchronous-replication',
        `commit durability can map to ${claim.synchronousReplication.type}/${claim.synchronousReplication.name}`,
        syncRepWait
          ? `${syncRepWait.wait_event_type}/${syncRepWait.wait_event}`
          : 'the coordinated waiter was not observed',
        syncRepWait?.wait_event_type === claim.synchronousReplication.type
          && syncRepWait?.wait_event === claim.synchronousReplication.name,
      ),
      result(
        'latency-wait/pool-slot-is-client-side',
        city.taxonomyDisclosure,
        poolRows.length === 0
          ? 'no PostgreSQL activity row exposes a pool-slot wait'
          : `${poolRows.length} PostgreSQL activity rows exposed a pool-named wait`,
        poolRows.length === 0,
      ),
    ]
  } finally {
    await psql('ALTER SYSTEM RESET synchronous_standby_names', { allowFailure: true })
    await psql('SELECT pg_catalog.pg_reload_conf()', { allowFailure: true })
    const activities = await query(`
      SELECT pid FROM pg_catalog.pg_stat_activity
       WHERE application_name IN (
         'oracle_relation_holder',
         'oracle_relation_waiter',
         'oracle_sync_rep_waiter'
       )`).catch(() => [])
    for (const activity of activities) {
      await psql(`SELECT pg_catalog.pg_terminate_backend(${Number(activity.pid)})`, {
        allowFailure: true,
      })
    }
    await holderExecution
    await relationExecution
    await syncRepExecution
  }
}

async function checkConnectionLocalBehavior(psql, registry, port) {
  const claim = registry.claims.connectionLocal
  const city = registry.cityClaims.connectionPooler
  const connection = `host=127.0.0.1 port=${port} dbname=postgres user=postgres`
  const execution = await psql(`
    CREATE EXTENSION IF NOT EXISTS dblink;
    SELECT public.dblink_connect('oracle_session_a', ${sqlLiteral(connection)});
    SELECT public.dblink_connect('oracle_session_b', ${sqlLiteral(connection)});
    SELECT public.dblink_exec('oracle_session_a', 'SET work_mem = ''64kB''');
    SELECT public.dblink_exec(
      'oracle_session_a',
      'DO $oracle$ BEGIN PERFORM pg_catalog.pg_advisory_lock(${claim.advisoryLockKey}); END $oracle$'
    );
    SELECT public.dblink_exec(
      'oracle_session_a',
      'PREPARE ${claim.preparedStatement}(integer) AS SELECT $1 + 1'
    );
    SELECT public.dblink_exec(
      'oracle_session_a',
      'LISTEN ${claim.listenChannel}'
    );
    SELECT public.dblink_exec(
      'oracle_session_b',
      'NOTIFY ${claim.listenChannel}, ''from-session-b'''
    );
    SELECT pg_catalog.pg_sleep(0.05);
    SELECT pg_catalog.json_build_object(
      'a_work_mem', a_work.setting,
      'b_work_mem', b_work.setting,
      'b_got_lock', b_lock.got_lock,
      'a_prepared', a_prepared.count,
      'b_prepared', b_prepared.count,
      'notify_name', notification.notify_name,
      'notify_extra', notification.extra
    )::text
    FROM public.dblink('oracle_session_a', 'SHOW work_mem') AS a_work(setting text)
    CROSS JOIN public.dblink('oracle_session_b', 'SHOW work_mem') AS b_work(setting text)
    CROSS JOIN public.dblink(
      'oracle_session_b',
      'SELECT pg_catalog.pg_try_advisory_lock(${claim.advisoryLockKey})'
    ) AS b_lock(got_lock boolean)
    CROSS JOIN public.dblink(
      'oracle_session_a',
      'SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_prepared_statements WHERE name = ''${claim.preparedStatement}'''
    ) AS a_prepared(count integer)
    CROSS JOIN public.dblink(
      'oracle_session_b',
      'SELECT pg_catalog.count(*)::integer FROM pg_catalog.pg_prepared_statements WHERE name = ''${claim.preparedStatement}'''
    ) AS b_prepared(count integer)
    LEFT JOIN LATERAL public.dblink_get_notify('oracle_session_a') AS notification ON true;
    SELECT public.dblink_disconnect('oracle_session_a');
    SELECT public.dblink_disconnect('oracle_session_b')`)
  const json = execution.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'))
  const observation = json ? JSON.parse(json) : null
  const tradeoff = city.transactionTradeoff
  return [
    result(
      'connection-local/session-GUC',
      tradeoff,
      observation
        ? `session A work_mem ${observation.a_work_mem}; session B work_mem ${observation.b_work_mem}`
        : 'session GUC observation is absent',
      observation?.a_work_mem === '64kB' && observation?.b_work_mem !== '64kB',
    ),
    result(
      'connection-local/advisory-lock',
      tradeoff,
      observation ? `session B pg_try_advisory_lock returned ${observation.b_got_lock}` : 'lock observation is absent',
      observation?.b_got_lock === false,
    ),
    result(
      'connection-local/sql-PREPARE',
      tradeoff,
      observation
        ? `prepared statement count: session A ${observation.a_prepared}, session B ${observation.b_prepared}`
        : 'prepared-statement observation is absent',
      Number(observation?.a_prepared) === 1 && Number(observation?.b_prepared) === 0,
    ),
    result(
      'connection-local/LISTEN-NOTIFY',
      tradeoff,
      observation
        ? `session A received ${observation.notify_name} with payload ${observation.notify_extra}`
        : 'notification observation is absent',
      observation?.notify_name === claim.listenChannel
        && observation?.notify_extra === 'from-session-b',
    ),
  ]
}

async function explainJson(psql, setup, sql) {
  const prefix = setup.trim() ? `${setup}; ` : ''
  const execution = await psql(`${prefix}EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)
  const raw = execution.stdout.trim()
  const start = raw.indexOf('[')
  if (start < 0) throw new Error(`EXPLAIN JSON was absent: ${raw}`)
  return JSON.parse(raw.slice(start))[0]
}

function planNodes(plan, predicate) {
  const matches = []
  const pending = plan ? [plan] : []
  while (pending.length > 0) {
    const node = pending.shift()
    if (predicate(node)) matches.push(node)
    pending.unshift(...(node.Plans ?? []))
  }
  return matches
}

function sortSummary(nodes) {
  return nodes.map((node) => [
    node['Sort Method'] ?? 'no method',
    `${node['Sort Space Used'] ?? 0} ${node['Sort Space Type'] ?? 'unknown'}`,
  ].join(' / ')).join(' | ')
}

async function checkWorkMemExecution(pgBin, psql, query, registry, port) {
  const claim = registry.claims.workMemExecution
  const city = registry.cityClaims.workMem
  await psql('SELECT pg_catalog.pg_stat_reset()')
  const beforeRows = await query(`
    SELECT temp_files, temp_bytes
      FROM pg_catalog.pg_stat_database
     WHERE datname = current_database()`)
  const before = beforeRows[0]
  const setup = `SET work_mem = '${claim.spillWorkMemKiB}kB'`
  const sortPlan = await explainJson(psql, setup, `
    SELECT value, pg_catalog.md5(value::text) AS payload
      FROM pg_catalog.generate_series(1, ${claim.sortRows}) AS value
     ORDER BY payload`)
  const sortNodes = planNodes(sortPlan.Plan, (node) => node['Node Type'] === 'Sort')

  const multiSortPlan = await explainJson(psql, setup, `
    WITH left_sort AS MATERIALIZED (
      SELECT value
        FROM pg_catalog.generate_series(1, ${claim.sortRows / 2}) AS value
       ORDER BY pg_catalog.md5(value::text)
    ), right_sort AS MATERIALIZED (
      SELECT value
        FROM pg_catalog.generate_series(1, ${claim.sortRows / 2}) AS value
       ORDER BY pg_catalog.md5(value::text)
    )
    SELECT (SELECT pg_catalog.sum(value) FROM left_sort),
           (SELECT pg_catalog.sum(value) FROM right_sort)`)
  const multiSortNodes = planNodes(
    multiSortPlan.Plan,
    (node) => node['Node Type'] === 'Sort',
  )

  const hashPlans = []
  for (const multiplier of claim.hashMultipliers) {
    hashPlans.push(await explainJson(psql, `
      SET work_mem = '${claim.hashWorkMemMiB}MB';
      SET hash_mem_multiplier = ${multiplier};
      SET enable_sort = off`, `
      SELECT value, pg_catalog.count(*)
        FROM pg_catalog.generate_series(1, ${claim.hashRows}) AS value
       GROUP BY value`))
  }
  const hashNodes = hashPlans.map((plan) => planNodes(
    plan.Plan,
    (node) => node['Node Type'] === 'Aggregate' && node.Strategy === 'Hashed',
  )[0])

  const concurrent = []
  for (let index = 0; index < claim.concurrentBackends; index++) {
    concurrent.push(psqlCommand(pgBin, port, `
      SET application_name = 'oracle_work_mem_${index}';
      SET work_mem = '${claim.spillWorkMemKiB}kB';
      SELECT pg_catalog.pg_sleep(0.6), pg_catalog.count(*)
        FROM (
          SELECT value
            FROM pg_catalog.generate_series(1, ${claim.sortRows}) AS value
           ORDER BY pg_catalog.md5(value::text)
        ) AS sorted`))
  }
  const active = await pollRow(
    query,
    `SELECT pg_catalog.count(*)::integer AS active
       FROM pg_catalog.pg_stat_activity
      WHERE application_name LIKE 'oracle_work_mem_%'
        AND state = 'active'`,
    (row) => Number(row?.active) === claim.concurrentBackends,
    5_000,
  )
  await Promise.all(concurrent)
  const after = await pollRow(
    query,
    `SELECT temp_files, temp_bytes
       FROM pg_catalog.pg_stat_database
      WHERE datname = current_database()`,
    (row) => Number(row?.temp_files) > Number(before?.temp_files),
    5_000,
  )

  const firstHash = hashNodes[0]
  const secondHash = hashNodes[1]
  const firstPeak = Number(firstHash?.['Peak Memory Usage'])
  const secondPeak = Number(secondHash?.['Peak Memory Usage'])
  const firstBatches = Number(firstHash?.['HashAgg Batches'])
  const secondBatches = Number(secondHash?.['HashAgg Batches'])
  return [
    result(
      'work_mem/sort-external-merge',
      `${city.nodeDisclosure}; a ${claim.spillWorkMemKiB} KiB Sort spills`,
      sortNodes.length > 0 ? sortSummary(sortNodes) : 'Sort node is absent',
      sortNodes.some((node) => node['Sort Method'] === 'external merge'
        && Number(node['Sort Space Used']) > 0
        && node['Sort Space Type'] === 'Disk'),
    ),
    result(
      'work_mem/per-node-sort-allowance',
      city.nodeDisclosure,
      `${multiSortNodes.length} Sort nodes: ${sortSummary(multiSortNodes)}`,
      multiSortNodes.length >= 2
        && multiSortNodes.every((node) => node['Sort Method'] === 'external merge'),
    ),
    result(
      'work_mem/temp-file-counters',
      'spilling increments pg_stat_database temp_files and temp_bytes',
      after
        ? `temp_files ${before?.temp_files} -> ${after.temp_files}; temp_bytes ${before?.temp_bytes} -> ${after.temp_bytes}`
        : 'database temp counters are absent',
      Number(after?.temp_files) > Number(before?.temp_files)
        && Number(after?.temp_bytes) > Number(before?.temp_bytes),
    ),
    result(
      'work_mem/hash_mem_multiplier',
      `Hash nodes receive work_mem × hash_mem_multiplier (${city.hashMemMultiplier})`,
      firstHash && secondHash
        ? `multiplier ${claim.hashMultipliers[0]}: peak ${firstPeak} KiB / ${firstBatches} batches; multiplier ${claim.hashMultipliers[1]}: peak ${secondPeak} KiB / ${secondBatches} batches`
        : 'controlled HashAggregate nodes are absent',
      Boolean(firstHash && secondHash)
        && secondPeak > firstPeak
        && secondBatches <= firstBatches,
    ),
    result(
      'work_mem/concurrent-backends-multiply',
      city.nodeDisclosure,
      `${active?.active ?? 0} controlled sort backends were active together`,
      Number(active?.active) === claim.concurrentBackends,
    ),
  ]
}

async function checkVacuumReclaim(pgBin, psql, query, registry, port) {
  const claim = registry.claims.vacuumReclaim
  const city = registry.cityClaims.vacuumReclaim
  const reuseRows = Math.floor(claim.rows / 4)
  await psql(`
    CREATE EXTENSION IF NOT EXISTS pg_freespacemap;
    CREATE TABLE public.oracle_vacuum_reuse (
      id integer PRIMARY KEY,
      payload text NOT NULL
    ) WITH (autovacuum_enabled = false);
    INSERT INTO public.oracle_vacuum_reuse
    SELECT value, pg_catalog.repeat('r', ${claim.payloadBytes})
      FROM pg_catalog.generate_series(1, ${claim.rows}) AS value`)
  await psql('VACUUM (ANALYZE) public.oracle_vacuum_reuse')
  const [reuseBefore] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_reuse')::bigint AS bytes,
           COALESCE(pg_catalog.sum(avail), 0::bigint)::bigint AS free_bytes
      FROM public.pg_freespace('public.oracle_vacuum_reuse'::regclass)`)
  await psql(`DELETE FROM public.oracle_vacuum_reuse
     WHERE id > ${reuseRows}
       AND id <= ${reuseRows * 2}`)
  await psql('VACUUM public.oracle_vacuum_reuse')
  const [reuseVacuumed] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_reuse')::bigint AS bytes,
           COALESCE(pg_catalog.sum(avail), 0::bigint)::bigint AS free_bytes
      FROM public.pg_freespace('public.oracle_vacuum_reuse'::regclass)`)
  await psql(`
    INSERT INTO public.oracle_vacuum_reuse
    SELECT value, pg_catalog.repeat('n', ${claim.payloadBytes})
      FROM pg_catalog.generate_series(
        ${claim.rows + 1},
        ${claim.rows + reuseRows}
      ) AS value`)
  const [reuseFilled] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_reuse')::bigint AS bytes`)

  await psql(`
    CREATE TABLE public.oracle_vacuum_tail (
      id integer PRIMARY KEY,
      payload text NOT NULL
    ) WITH (autovacuum_enabled = false);
    INSERT INTO public.oracle_vacuum_tail
    SELECT value, pg_catalog.repeat('t', ${claim.payloadBytes})
      FROM pg_catalog.generate_series(1, ${claim.rows}) AS value`)
  await psql('VACUUM (ANALYZE) public.oracle_vacuum_tail')
  const [tailBefore] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_tail')::bigint AS bytes,
           pg_catalog.max(
             pg_catalog.split_part(
               trim(both '()' FROM ctid::text), ',', 1
             )::integer
           ) AS last_block
      FROM public.oracle_vacuum_tail`)
  await psql(`
    DELETE FROM public.oracle_vacuum_tail
     WHERE pg_catalog.split_part(
       trim(both '()' FROM ctid::text), ',', 1
     )::integer >= ${Math.floor(Number(tailBefore.last_block) / 2)}`)
  const holder = psqlCommand(pgBin, port, `
    SET application_name = 'oracle_vacuum_holder';
    BEGIN;
    LOCK TABLE public.oracle_vacuum_tail IN ACCESS SHARE MODE;
    SELECT pg_catalog.pg_sleep(30);
    COMMIT`)
  const holderActivity = await pollRow(
    query,
    `SELECT pid, wait_event FROM pg_catalog.pg_stat_activity
      WHERE application_name = 'oracle_vacuum_holder'`,
    (row) => row?.wait_event === 'PgSleep',
    5_000,
  )
  await psql('VACUUM public.oracle_vacuum_tail')
  const [tailLocked] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_tail')::bigint AS bytes`)
  if (holderActivity?.pid) {
    await psql(`SELECT pg_catalog.pg_terminate_backend(${Number(holderActivity.pid)})`)
  }
  await holder
  await psql('VACUUM public.oracle_vacuum_tail')
  const [tailTruncated] = await query(`
    SELECT pg_catalog.pg_relation_size('public.oracle_vacuum_tail')::bigint AS bytes`)

  const lockDemonstrated = Number(tailLocked?.bytes) === Number(tailBefore?.bytes)
    && Number(tailTruncated?.bytes) < Number(tailLocked?.bytes)
  const registeredLock = city.truncationLock?.mode === 'ACCESS EXCLUSIVE'
    && city.truncationLock?.attempt === 'non-blocking'
    && /gives up.*space.*not returned/iu.test(city.truncationLock?.consequence ?? '')
  return [
    result(
      'VACUUM/interior-space-stays-in-relation',
      city.rule,
      `relation bytes ${reuseBefore?.bytes} -> ${reuseVacuumed?.bytes}; free bytes ${reuseBefore?.free_bytes} -> ${reuseVacuumed?.free_bytes}`,
      Number(reuseVacuumed?.bytes) === Number(reuseBefore?.bytes)
        && Number(reuseVacuumed?.free_bytes) > Number(reuseBefore?.free_bytes),
    ),
    result(
      'VACUUM/reuses-interior-space',
      city.rule,
      `after inserting ${reuseRows} replacement rows: ${reuseVacuumed?.bytes} -> ${reuseFilled?.bytes} bytes`,
      Number(reuseFilled?.bytes) <= Number(reuseVacuumed?.bytes) + 8192,
    ),
    result(
      'VACUUM/tail-truncation-lock',
      'plain VACUUM can truncate only an empty tail and must acquire ACCESS EXCLUSIVE on the relation',
      `initial ${tailBefore?.bytes}; with ACCESS SHARE held ${tailLocked?.bytes}; after release ${tailTruncated?.bytes}`,
      lockDemonstrated,
    ),
    result(
      'registry/vacuum-truncation-lock',
      'vacuumReclaim registers ACCESS EXCLUSIVE, the non-blocking attempt, and the no-lock/no-space-return consequence',
      lockDemonstrated
        ? 'server demonstrated that VACUUM skipped truncation while ACCESS SHARE prevented the non-blocking ACCESS EXCLUSIVE attempt'
        : 'server did not complete the controlled lock observation',
      lockDemonstrated && registeredLock,
    ),
  ]
}

function scanNode(plan) {
  return planNodes(plan, (node) => /Scan$/u.test(String(node['Node Type'])))[0] ?? null
}

async function checkPartialIndexBehavior(psql, query, registry) {
  const claim = registry.claims.partialIndexBehavior
  const city = registry.cityClaims.machineIndexWalk
  await psql(`
    CREATE SCHEMA oracle_machine;
    CREATE TABLE oracle_machine.accounts (
      id integer PRIMARY KEY,
      owner text NOT NULL,
      balance numeric(12, 2) NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE INDEX accounts_positive_owner_idx
      ON oracle_machine.accounts(owner) WHERE balance > 0;
    INSERT INTO oracle_machine.accounts
    SELECT value,
           'account-' || value,
           (1000 + value)::numeric(12, 2),
           timestamptz '2026-01-01 00:00:00+00' + value * interval '1 minute'
      FROM pg_catalog.generate_series(1, ${claim.rows}) AS value;
    ANALYZE oracle_machine.accounts`)
  const ownerLiteral = sqlLiteral(claim.owner)
  const primaryPlan = await explainJson(psql, '', `
    SELECT id, balance
      FROM oracle_machine.accounts
     WHERE id = 42`)
  const ownerPlan = await explainJson(psql, '', `
    SELECT id, balance
      FROM oracle_machine.accounts
     WHERE owner = ${ownerLiteral}`)
  const impliedPlan = await explainJson(psql, '', `
    SELECT id, balance
      FROM oracle_machine.accounts
     WHERE owner = ${ownerLiteral}
       AND balance > 0`)
  const primaryScan = scanNode(primaryPlan.Plan)
  const ownerScan = scanNode(ownerPlan.Plan)
  const impliedScan = scanNode(impliedPlan.Plan)
  const [rows] = await query(`
    SELECT
      (SELECT pg_catalog.count(*)
         FROM oracle_machine.accounts
        WHERE id = 42)::integer AS primary_rows,
      (SELECT pg_catalog.count(*)
         FROM oracle_machine.accounts
        WHERE owner = ${ownerLiteral})::integer AS owner_rows,
      (SELECT pg_catalog.count(*)
         FROM oracle_machine.accounts
        WHERE owner = ${ownerLiteral}
          AND balance > 0)::integer AS implied_rows`)
  return [
    result(
      'partial-index/predicate-not-implied',
      city.finding,
      `${ownerScan?.['Node Type'] ?? 'no scan'}${ownerScan?.['Index Name'] ? ` using ${ownerScan['Index Name']}` : ''}; ${rows?.owner_rows ?? 0} rows`,
      ownerScan?.['Node Type'] === 'Seq Scan'
        && !ownerScan?.['Index Name']
        && Number(rows?.owner_rows) === 1,
    ),
    result(
      'partial-index/predicate-implied',
      city.finding,
      `${impliedScan?.['Node Type'] ?? 'no scan'}${impliedScan?.['Index Name'] ? ` using ${impliedScan['Index Name']}` : ''}; ${rows?.implied_rows ?? 0} rows`,
      impliedScan?.['Node Type'] === 'Index Scan'
        && impliedScan?.['Index Name'] === city.partialIndex
        && Number(rows?.implied_rows) === 1,
    ),
    result(
      'partial-index/primary-key-plan',
      city.finding,
      `${primaryScan?.['Node Type'] ?? 'no scan'}${primaryScan?.['Index Name'] ? ` using ${primaryScan['Index Name']}` : ''}; ${rows?.primary_rows ?? 0} rows`,
      primaryScan?.['Node Type'] === 'Index Scan'
        && primaryScan?.['Index Name'] === 'accounts_pkey'
        && Number(rows?.primary_rows) === 1,
    ),
  ]
}

async function checkAsynchronousCommit(pgBin, registry, scratch) {
  const claim = registry.claims.asynchronousCommit
  const city = registry.cityClaims.machineSynchronousCommitComparison
  const dataDir = path.join(scratch, 'async-data')
  const socketDir = path.join(scratch, 'async-socket')
  const logFile = path.join(scratch, 'async.log')
  const port = await freePort()
  let started = false
  const launchOptions = (delayMs) => [
    '-h 127.0.0.1',
    `-p ${port}`,
    `-k ${socketDir}`,
    '-c fsync=on',
    '-c full_page_writes=on',
    '-c wal_level=logical',
    '-c max_replication_slots=2',
    `-c wal_writer_delay=${delayMs}ms`,
  ].join(' ')
  const start = async (delayMs) => {
    await run(path.join(pgBin, 'pg_ctl'), [
      '-D', dataDir, '-l', logFile, '-o', launchOptions(delayMs), '-w', 'start',
    ])
    started = true
  }
  const stop = async () => {
    if (!started) return
    await run(path.join(pgBin, 'pg_ctl'), [
      '-D', dataDir, '-m', 'immediate', '-w', 'stop',
    ], { allowFailure: true })
    started = false
  }
  const args = [
    '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
    '-h', '127.0.0.1', '-p', String(port),
    '-U', 'postgres', '-d', 'postgres',
  ]
  const psql = async (sql, { input = false } = {}) => run(
    path.join(pgBin, 'psql'),
    input ? [...args, '-f', '-'] : [...args, '-c', sql],
    input ? { input: sql } : {},
  )
  const query = async (sql) => {
    const body = sql.trim().replace(/;+\s*$/u, '')
    const execution = await psql(
      `SELECT COALESCE(json_agg(oracle_row), '[]'::json) FROM (${body}) AS oracle_row;`,
    )
    return JSON.parse(execution.stdout.trim() || '[]')
  }

  await run(path.join(pgBin, 'initdb'), [
    '-D', dataDir,
    '--no-locale',
    '--encoding=UTF8',
    '--auth=trust',
    '--username=postgres',
    '--no-sync',
  ])
  await mkdir(socketDir)
  try {
    await start(claim.walWriterDelayMs)
    await psql(`
      CREATE TABLE public.oracle_async_commit (
        id integer PRIMARY KEY,
        transaction_group integer NOT NULL,
        payload text NOT NULL
      );
      SET synchronous_commit = on;
      INSERT INTO public.oracle_async_commit VALUES (1, 0, 'durable-control');
      CHECKPOINT`)
    await psql(`SELECT * FROM pg_catalog.pg_create_logical_replication_slot(
      'oracle_logical_horizon', 'pgoutput'
    )`)
    const [logicalSlot] = await query(`
      SELECT slot_name, catalog_xmin::text AS catalog_xmin
        FROM pg_catalog.pg_replication_slots
       WHERE slot_name = 'oracle_logical_horizon'`)
    await psql("SELECT pg_catalog.pg_drop_replication_slot('oracle_logical_horizon')")

    let acknowledgment = null
    let acknowledgedAt = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = 100 + attempt
      const execution = await psql(`
        SET synchronous_commit = off;
        INSERT INTO public.oracle_async_commit
          VALUES (${id}, ${id}, pg_catalog.repeat('a', 64));
        SELECT pg_catalog.json_build_object(
          'id', ${id},
          'insert_lsn', pg_catalog.pg_current_wal_insert_lsn(),
          'flush_lsn', pg_catalog.pg_current_wal_flush_lsn(),
          'ahead', pg_catalog.pg_current_wal_insert_lsn()
            > pg_catalog.pg_current_wal_flush_lsn()
        )::text;
      `, { input: true })
      const json = execution.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{'))
      acknowledgment = json ? JSON.parse(json) : null
      acknowledgedAt = performance.now()
      if (acknowledgment?.ahead === true) break
    }

    let naturalFlush = null
    if (acknowledgment?.insert_lsn) {
      naturalFlush = await pollRow(
        query,
        `SELECT pg_catalog.pg_current_wal_flush_lsn()::text AS flush_lsn,
                pg_catalog.pg_wal_lsn_diff(
                  pg_catalog.pg_current_wal_flush_lsn(),
                  ${sqlLiteral(acknowledgment.insert_lsn)}::pg_lsn
                ) >= 0 AS reached`,
        (row) => row?.reached === true,
        claim.lossWindowMultiplier * claim.walWriterDelayMs + 1_000,
      )
    }
    const flushElapsedMs = performance.now() - acknowledgedAt

    await psql(`ALTER SYSTEM SET wal_writer_delay = '${claim.crashWalWriterDelayMs}ms'`)
    await psql('SELECT pg_catalog.pg_reload_conf()')
    await psql('CHECKPOINT')
    let crashAck = null
    for (let attempt = 0; attempt < 8; attempt++) {
      const group = 900 + attempt
      const execution = await psql(`
        SET synchronous_commit = off;
        BEGIN;
        INSERT INTO public.oracle_async_commit VALUES
          (${group * 10}, ${group}, 'atomic-left'),
          (${group * 10 + 1}, ${group}, 'atomic-right');
        COMMIT;
        SELECT pg_catalog.json_build_object(
          'group_id', ${group},
          'insert_lsn', pg_catalog.pg_current_wal_insert_lsn(),
          'flush_lsn', pg_catalog.pg_current_wal_flush_lsn(),
          'ahead', pg_catalog.pg_current_wal_insert_lsn()
            > pg_catalog.pg_current_wal_flush_lsn()
        )::text;
      `, { input: true })
      const json = execution.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find((line) => line.startsWith('{'))
      crashAck = json ? JSON.parse(json) : null
      if (crashAck?.ahead === true) break
    }
    await stop()
    await start(claim.crashWalWriterDelayMs)
    const [afterCrash] = await query(`
      SELECT pg_catalog.count(*) FILTER (WHERE id = 1)::integer AS control_rows,
             pg_catalog.count(*) FILTER (
               WHERE transaction_group = ${Number(crashAck?.group_id)}
             )::integer AS async_rows
        FROM public.oracle_async_commit`)

    const acknowledgmentAhead = acknowledgment?.ahead === true
    const flushedNaturally = naturalFlush?.reached === true
    const withinClaimedWindow = flushedNaturally
      && flushElapsedMs <= claim.lossWindowMultiplier * claim.walWriterDelayMs + 750
    const lossDemonstrated = crashAck?.ahead === true
      && Number(afterCrash?.control_rows) === 1
      && Number(afterCrash?.async_rows) === 0
    return [
      result(
        'synchronous_commit/off-acknowledges-before-local-flush',
        city.finding,
        acknowledgment
          ? `acknowledged at insert_lsn ${acknowledgment.insert_lsn} while flush_lsn was ${acknowledgment.flush_lsn}`
          : 'asynchronous acknowledgment observation is absent',
        acknowledgmentAhead,
      ),
      result(
        'synchronous_commit/WAL-flushes-later',
        city.finding,
        naturalFlush
          ? `flush_lsn reached ${naturalFlush.flush_lsn} after ${flushElapsedMs.toFixed(1)} ms; bound ${claim.lossWindowMultiplier} × ${claim.walWriterDelayMs} ms`
          : 'the later WAL flush was not observed',
        withinClaimedWindow,
      ),
      result(
        'synchronous_commit/recent-acknowledged-loss',
        city.finding,
        afterCrash
          ? `after immediate-stop recovery: durable control rows ${afterCrash.control_rows}; acknowledged async transaction rows ${afterCrash.async_rows}`
          : 'post-crash witness is absent',
        lossDemonstrated,
      ),
      result(
        'synchronous_commit/transaction-atomicity',
        city.finding,
        afterCrash
          ? `acknowledged two-row transaction recovered ${afterCrash.async_rows} rows`
          : 'post-crash atomicity witness is absent',
        Number(afterCrash?.async_rows) === 0 || Number(afterCrash?.async_rows) === 2,
      ),
      result(
        'xmin-horizon/logical-slot',
        registry.cityClaims.mvccVocabulary.xminHorizon.definition,
        logicalSlot
          ? `logical slot ${logicalSlot.slot_name}; catalog_xmin ${logicalSlot.catalog_xmin}`
          : 'logical slot observation is absent',
        logicalSlot?.slot_name === 'oracle_logical_horizon'
          && Boolean(logicalSlot?.catalog_xmin),
      ),
    ]
  } finally {
    await stop()
  }
}

async function waitForPath(target, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      await access(target)
      return true
    } catch {
      await delay(100)
    }
  }
  return false
}

async function archiveCurrentSegment(psql, query, archiveDir, walDir) {
  const [before] = await query(`
    SELECT pg_catalog.pg_walfile_name(
      pg_catalog.pg_current_wal_lsn()
    ) AS file_name`)
  await psql('SELECT pg_catalog.pg_switch_wal()')
  if (!before?.file_name) return null
  const archivePath = path.join(archiveDir, before.file_name)
  let archived = await waitForPath(archivePath)
  if (!archived && walDir) {
    await cp(path.join(walDir, before.file_name), archivePath)
    archived = await waitForPath(archivePath, 1_000)
  }
  return { fileName: before.file_name, archived }
}

async function checkNativeRecovery(
  pgBin,
  psql,
  query,
  registry,
  port,
  scratch,
  archiveDir,
  primaryDataDir,
) {
  const recoveryClaim = registry.claims.nativeRecovery
  const timelineFixture = registry.claims.timelineRecovery
  const restoreCity = registry.cityClaims.restoreDrill
  const timelineCity = registry.cityClaims.timelineRecovery
  const baseDir = path.join(scratch, 'timeline-base')
  const forkDir = path.join(scratch, 'timeline-fork')
  const forkSocket = path.join(scratch, 'timeline-fork-socket')
  const forkLog = path.join(scratch, 'timeline-fork.log')
  const forkPort = await freePort()
  const primaryConnection = `host=127.0.0.1 port=${port} dbname=postgres user=postgres`
  let forkStarted = false

  const forkPsql = async (sql, { allowFailure = false, database = 'postgres' } = {}) => run(
    path.join(pgBin, 'psql'),
    [
      '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
      '-h', '127.0.0.1', '-p', String(forkPort),
      '-U', 'postgres', '-d', database, '-c', sql,
    ],
    { allowFailure },
  )
  const forkQuery = async (sql, options) => {
    const body = sql.trim().replace(/;+\s*$/u, '')
    const execution = await forkPsql(
      `SELECT COALESCE(json_agg(oracle_row), '[]'::json) FROM (${body}) AS oracle_row;`,
      options,
    )
    return JSON.parse(execution.stdout.trim() || '[]')
  }
  const stopFork = async () => {
    if (!forkStarted) return
    await run(path.join(pgBin, 'pg_ctl'), [
      '-D', forkDir, '-m', 'fast', '-w', 'stop',
    ], { allowFailure: true })
    forkStarted = false
  }

  await psql(`
    CREATE TABLE public.oracle_timeline_witness (
      id integer PRIMARY KEY,
      branch text NOT NULL
    );
    INSERT INTO public.oracle_timeline_witness VALUES (1, 'before-backup')`)
  await psql('CREATE DATABASE oracle_second_database')
  await psql(`
    CREATE TABLE public.oracle_cluster_witness (id integer PRIMARY KEY);
    INSERT INTO public.oracle_cluster_witness VALUES (1)`, {
    database: 'oracle_second_database',
  })
  await run(path.join(pgBin, 'pg_basebackup'), [
    '-D', baseDir,
    '-X', 'stream',
    '--checkpoint=fast',
    '--manifest-checksums=SHA256',
    '-h', '127.0.0.1',
    '-p', String(port),
    '-U', 'postgres',
  ])
  const verify = await run(path.join(pgBin, 'pg_verifybackup'), [baseDir], {
    allowFailure: true,
  })
  await cp(baseDir, forkDir, { recursive: true })
  await writeFile(path.join(forkDir, 'standby.signal'), '')
  await appendFile(path.join(forkDir, 'postgresql.auto.conf'), `
primary_conninfo = '${primaryConnection}'
recovery_target_timeline = 'current'
`)
  await mkdir(forkSocket)

  let targetTime = null
  let childArchive = null
  let parentArchive = null
  let standbyFeedback = null
  try {
    const forkLaunch = await run(path.join(pgBin, 'pg_ctl'), [
      '-D', forkDir,
      '-l', forkLog,
      '-o', [
        '-h 127.0.0.1',
        `-p ${forkPort}`,
        `-k ${forkSocket}`,
        '-c fsync=off',
        '-c max_prepared_transactions=10',
        '-c hot_standby_feedback=on',
        '-c wal_receiver_status_interval=100ms',
        '-c archive_mode=on',
        `-c archive_command='test ! -f ${archiveDir}/%f && cp %p ${archiveDir}/%f'`,
      ].join(' '),
      '-w', 'start',
    ], { allowFailure: true })
    if (forkLaunch.code !== 0) {
      const log = await readFile(forkLog, 'utf8').catch(() => 'fork log unavailable')
      throw new Error(`timeline fork did not start:\n${log.trim()}`)
    }
    forkStarted = true
    const feedbackSession = run(path.join(pgBin, 'psql'), [
      '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1',
      '-h', '127.0.0.1', '-p', String(forkPort),
      '-U', 'postgres', '-d', 'postgres',
      '-c', `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
        SELECT pg_catalog.count(*) FROM public.oracle_timeline_witness;
        SELECT pg_catalog.pg_sleep(2);
        COMMIT`,
    ], { allowFailure: true })
    standbyFeedback = await pollRow(
      query,
      `SELECT application_name, backend_xmin::text AS backend_xmin
         FROM pg_catalog.pg_stat_replication
        WHERE backend_xmin IS NOT NULL
        ORDER BY pid
        LIMIT 1`,
      (row) => Boolean(row?.backend_xmin),
      5_000,
    )
    await feedbackSession
    await run(path.join(pgBin, 'pg_ctl'), ['-D', forkDir, '-w', 'promote'])
    const promoted = await pollRow(
      forkQuery,
      'SELECT pg_catalog.pg_is_in_recovery() AS in_recovery',
      (row) => row?.in_recovery === false,
      10_000,
    )
    if (promoted?.in_recovery !== false) throw new Error('timeline fork did not promote')

    await forkPsql("INSERT INTO public.oracle_timeline_witness VALUES (2, 'timeline-2-child')")
    await psql("INSERT INTO public.oracle_timeline_witness VALUES (3, 'timeline-1-parent-tail')")
    ;[targetTime] = await query(`
      SELECT pg_catalog.to_char(
        pg_catalog.clock_timestamp(),
        'YYYY-MM-DD HH24:MI:SS.USOF'
      ) AS target_time`)
    await delay(100)
    await forkPsql("INSERT INTO public.oracle_timeline_witness VALUES (4, 'timeline-2-crossing')")
    await psql("INSERT INTO public.oracle_timeline_witness VALUES (5, 'timeline-1-crossing')")
    childArchive = await archiveCurrentSegment(
      forkPsql,
      forkQuery,
      archiveDir,
      path.join(forkDir, 'pg_wal'),
    )
    parentArchive = await archiveCurrentSegment(
      psql,
      query,
      archiveDir,
      path.join(primaryDataDir, 'pg_wal'),
    )
    const historyArchive = path.join(archiveDir, timelineFixture.historyFile)
    if (!await waitForPath(historyArchive)) {
      await cp(path.join(forkDir, 'pg_wal', timelineFixture.historyFile), historyArchive)
    }
  } finally {
    await stopFork()
  }

  const restore = async ({ name, sourceArchive, timeline, target, pause = true }) => {
    const restoreDir = path.join(scratch, `restore-${name}`)
    const restoreSocket = path.join(scratch, `restore-${name}-socket`)
    const restoreLog = path.join(scratch, `restore-${name}.log`)
    const restorePort = await freePort()
    await cp(baseDir, restoreDir, { recursive: true })
    await mkdir(restoreSocket)
    await writeFile(path.join(restoreDir, 'recovery.signal'), '')
    await appendFile(path.join(restoreDir, 'postgresql.auto.conf'), `
restore_command = 'cp ${sourceArchive}/%f %p'
recovery_target_time = '${target}'
recovery_target_timeline = '${timeline}'
recovery_target_action = '${pause ? 'pause' : 'promote'}'
`)
    const launch = await run(path.join(pgBin, 'pg_ctl'), [
      '-D', restoreDir,
      '-l', restoreLog,
      '-o', `-h 127.0.0.1 -p ${restorePort} -k ${restoreSocket} -c fsync=off -c max_prepared_transactions=10`,
      '-w', 'start',
    ], { allowFailure: true })
    let started = launch.code === 0
    let observation = null
    try {
      if (started && pause) {
        const deadline = performance.now() + 15_000
        while (performance.now() < deadline) {
          const probe = await run(path.join(pgBin, 'psql'), [
            '-X', '-A', '-t', '-q',
            '-h', '127.0.0.1', '-p', String(restorePort),
            '-U', 'postgres', '-d', 'postgres',
            '-c', `SELECT pg_catalog.json_build_object(
              'in_recovery', pg_catalog.pg_is_in_recovery(),
              'paused', pg_catalog.pg_is_wal_replay_paused(),
              'ids', (SELECT pg_catalog.array_agg(id ORDER BY id) FROM public.oracle_timeline_witness)
            )::text`,
          ], { allowFailure: true })
          const json = probe.stdout
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .find((line) => line.startsWith('{'))
          if (json) observation = JSON.parse(json)
          if (observation?.paused === true) break
          const status = await run(path.join(pgBin, 'pg_ctl'), [
            '-D', restoreDir, 'status',
          ], { allowFailure: true })
          if (status.code !== 0) {
            started = false
            break
          }
          await delay(100)
        }
      } else if (started) {
        const resultRows = await run(path.join(pgBin, 'psql'), [
          '-X', '-A', '-t', '-q',
          '-h', '127.0.0.1', '-p', String(restorePort),
          '-U', 'postgres', '-d', 'postgres',
          '-c', `SELECT pg_catalog.json_build_object(
            'in_recovery', pg_catalog.pg_is_in_recovery(),
            'ids', (SELECT pg_catalog.array_agg(id ORDER BY id) FROM public.oracle_timeline_witness)
          )::text`,
        ], { allowFailure: true })
        const json = resultRows.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find((line) => line.startsWith('{'))
        if (json) observation = JSON.parse(json)
      }

      const secondDatabase = started && observation
        ? await run(path.join(pgBin, 'psql'), [
          '-X', '-A', '-t', '-q',
          '-h', '127.0.0.1', '-p', String(restorePort),
          '-U', 'postgres', '-d', 'oracle_second_database',
          '-c', 'SELECT pg_catalog.count(*) FROM public.oracle_cluster_witness',
        ], { allowFailure: true })
        : null
      const log = await readFile(restoreLog, 'utf8').catch(() => '')
      return {
        launch,
        started,
        observation,
        secondDatabaseRows: Number(secondDatabase?.stdout.trim()),
        log,
      }
    } finally {
      if (started) {
        await run(path.join(pgBin, 'pg_ctl'), [
          '-D', restoreDir, '-m', 'immediate', '-w', 'stop',
        ], { allowFailure: true })
      }
    }
  }

  const latest = await restore({
    name: 'latest',
    sourceArchive: archiveDir,
    timeline: timelineFixture.latest,
    target: targetTime.target_time,
  })
  const current = await restore({
    name: 'current',
    sourceArchive: archiveDir,
    timeline: timelineFixture.current,
    target: targetTime.target_time,
  })
  const archiveWithoutHistory = path.join(scratch, 'archive-without-history')
  await cp(archiveDir, archiveWithoutHistory, { recursive: true })
  await rm(path.join(archiveWithoutHistory, timelineFixture.historyFile), { force: true })
  const historyAbsent = await restore({
    name: 'history-absent',
    sourceArchive: archiveWithoutHistory,
    timeline: timelineFixture.latest,
    target: targetTime.target_time,
  })
  const notReached = await restore({
    name: 'not-reached',
    sourceArchive: archiveDir,
    timeline: timelineFixture.current,
    target: '2099-01-01 00:00:00+00',
  })

  await psql('CREATE DATABASE oracle_logical_source')
  await psql('CREATE DATABASE oracle_logical_restore_a')
  await psql('CREATE DATABASE oracle_logical_restore_b')
  await psql(`
    CREATE TYPE public.${recoveryClaim.logicalDependencyType} AS ENUM ('ok');
    CREATE TABLE public.${recoveryClaim.logicalDependencyTable} (
      id integer PRIMARY KEY,
      mood public.${recoveryClaim.logicalDependencyType} NOT NULL
    );
    INSERT INTO public.${recoveryClaim.logicalDependencyTable} VALUES (1, 'ok')`, {
    database: 'oracle_logical_source',
  })
  const fullDump = path.join(scratch, 'logical-full.dump')
  const tableDump = path.join(scratch, 'logical-table.dump')
  const dumpArgs = [
    '-Fc', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres',
    '-d', 'oracle_logical_source',
  ]
  await run(path.join(pgBin, 'pg_dump'), [...dumpArgs, '-f', fullDump])
  await run(path.join(pgBin, 'pg_dump'), [
    ...dumpArgs,
    '-t', `public.${recoveryClaim.logicalDependencyTable}`,
    '-f', tableDump,
  ])
  const restoreSelected = await run(path.join(pgBin, 'pg_restore'), [
    '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres',
    '-d', 'oracle_logical_restore_a',
    '-t', recoveryClaim.logicalDependencyTable,
    fullDump,
  ], { allowFailure: true })
  const restoreTableDump = await run(path.join(pgBin, 'pg_restore'), [
    '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres',
    '-d', 'oracle_logical_restore_b',
    tableDump,
  ], { allowFailure: true })

  const latestIds = latest.observation?.ids ?? []
  const currentIds = current.observation?.ids ?? []
  const historyAbsentIds = historyAbsent.observation?.ids ?? []
  const historyArchived = await waitForPath(path.join(archiveDir, timelineFixture.historyFile), 100)
  const targetNotReached = /recovery ended before configured recovery target was reached/iu
    .test(notReached.log)
  return [
    result(
      'physical-backup/pg_verifybackup',
      restoreCity.checksumDisclosure,
      verify.code === 0
        ? 'pg_verifybackup verified the native base backup manifest'
        : verify.stderr.trim() || verify.stdout.trim(),
      verify.code === 0,
    ),
    result(
      'physical-backup/cluster-wide-scope',
      restoreCity.physicalScopeDisclosure,
      `restored postgres witness ids [${latestIds.join(', ')}]; second-database witness rows ${latest.secondDatabaseRows}`,
      latestIds.includes(1) && latest.secondDatabaseRows === 1,
    ),
    result(
      'PITR/row-witness-at-target',
      restoreCity.levels.table.supports,
      `latest restore paused at target with witness ids [${latestIds.join(', ')}]`,
      latest.observation?.paused === true
        && latestIds.includes(1)
        && latestIds.includes(2)
        && !latestIds.includes(4),
    ),
    result(
      'timeline/latest-discovers-history',
      timelineCity.crossingDisclosure,
      `${timelineFixture.historyFile} ${historyArchived ? 'archived' : 'absent'}; latest ids [${latestIds.join(', ')}]; child WAL ${childArchive?.fileName ?? 'absent'} (${childArchive?.archived ? 'archived' : 'not archived'})`,
      historyArchived && latestIds.includes(2),
    ),
    result(
      'timeline/latest-excludes-parent-tail',
      timelineCity.crossingDisclosure,
      `latest ids [${latestIds.join(', ')}]`,
      latestIds.includes(2) && !latestIds.includes(3),
    ),
    result(
      'timeline/current-stays-on-backup-timeline',
      timelineCity.defaultDisclosure,
      `current ids [${currentIds.join(', ')}]; parent WAL ${parentArchive?.fileName ?? 'absent'} (${parentArchive?.archived ? 'archived' : 'not archived'})`,
      current.observation?.paused === true
        && currentIds.includes(3)
        && !currentIds.includes(2),
    ),
    result(
      'timeline/latest-without-history-stays-current',
      timelineCity.crossingDisclosure,
      `without ${timelineFixture.historyFile}, latest ids [${historyAbsentIds.join(', ')}]`,
      historyAbsent.observation?.paused === true
        && historyAbsentIds.includes(3)
        && !historyAbsentIds.includes(2),
    ),
    result(
      'PITR/target-not-reached',
      timelineCity.defaultDisclosure,
      targetNotReached
        ? 'server reported that recovery ended before the configured target was reached'
        : notReached.log.trim().split(/\r?\n/u).slice(-3).join(' | '),
      targetNotReached,
    ),
    result(
      'logical-restore/table-dependencies',
      restoreCity.physicalScopeDisclosure,
      `pg_restore -t exit ${restoreSelected.code}; pg_dump -t archive restore exit ${restoreTableDump.code}; dependent type was not selected automatically`,
      restoreSelected.code !== 0
        && restoreTableDump.code !== 0
        && /does not exist/iu.test(`${restoreSelected.stderr}\n${restoreTableDump.stderr}`),
    ),
    result(
      'xmin-horizon/standby-feedback',
      registry.cityClaims.mvccVocabulary.xminHorizon.definition,
      standbyFeedback
        ? `primary walsender ${standbyFeedback.application_name} reported backend_xmin ${standbyFeedback.backend_xmin}`
        : 'hot_standby_feedback xmin was not observed',
      Boolean(standbyFeedback?.backend_xmin),
    ),
  ]
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
    const launch = await run(path.join(pgBin, 'pg_ctl'), [
      '-D', standbyDir,
      '-l', standbyLog,
      '-o', `-h 127.0.0.1 -p ${standbyPort} -k ${standbySocket} -c max_prepared_transactions=10${slotOption}`,
      '-w', 'start',
    ], { allowFailure: true })
    if (launch.code !== 0) {
      const log = await readFile(standbyLog, 'utf8').catch(() => 'standby log unavailable')
      throw new Error(`physical standby did not start:\n${log.trim()}`)
    }
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
  const targetChangesStorage = Number(defaultExternal?.raw_size) === 18
    && Number(defaultExternal?.toast_heap_bytes) > 0
    && Number(raisedInline?.raw_size) > toast.valueBytes
    && Number(raisedInline?.toast_heap_bytes) === 0
    && Number(defaultExternal?.logical_size) === toast.valueBytes
    && Number(raisedInline?.logical_size) === toast.valueBytes
  const threeReadPaths = Number(raisedInline?.raw_size) > toast.valueBytes
    && Number(compressedInline?.raw_size) > 20
    && Number(compressedInline?.raw_size) < 500
    && Number(compressedInline?.toast_heap_bytes) === 0
    && Number(defaultExternal?.raw_size) === 18
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
      'TOAST/external-pointer-size',
      'an out-of-line datum leaves an 18-byte external TOAST pointer in the heap tuple',
      defaultExternal
        ? `raw heap attribute ${defaultExternal.raw_size} bytes; logical value ${defaultExternal.logical_size} bytes`
        : 'external TOAST observation is absent',
      Number(defaultExternal?.raw_size) === 18
        && Number(defaultExternal?.logical_size) === toast.valueBytes,
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

async function checkRemainingMvcc(pgBin, psql, query, registry, port) {
  const claim = registry.claims.storageMvcc
  const vocabulary = registry.cityClaims.mvccVocabulary
  const page = claim.pageLayout
  await psql(`
    CREATE EXTENSION IF NOT EXISTS pageinspect;
    CREATE EXTENSION IF NOT EXISTS pg_visibility;
    CREATE EXTENSION IF NOT EXISTS dblink;
    CREATE TABLE public.${page.relation} (
      id integer PRIMARY KEY,
      payload text NOT NULL
    ) WITH (fillfactor = 50, autovacuum_enabled = false);
    INSERT INTO public.${page.relation} VALUES (1, 'created')`)
  const [created] = await query(`
    SELECT xmin::text AS creator_xid, ctid::text AS original_ctid
      FROM public.${page.relation}
     WHERE id = 1`)
  await psql(`UPDATE public.${page.relation} SET payload = 'replacement' WHERE id = 1`)
  const [replacement] = await query(`
    SELECT xmin::text AS updater_xid, ctid::text AS replacement_ctid
      FROM public.${page.relation}
     WHERE id = 1`)
  const tupleRows = await query(`
    WITH blocks AS (
      SELECT block_number
        FROM pg_catalog.generate_series(
          0,
          pg_catalog.pg_relation_size('public.${page.relation}')
            / current_setting('block_size')::integer - 1
        ) AS block_number
    )
    SELECT blocks.block_number,
           items.lp,
           items.lp_flags,
           items.lp_len,
           items.t_xmin::text AS t_xmin,
           items.t_xmax::text AS t_xmax,
           items.t_field3,
           items.t_ctid::text AS t_ctid,
           items.t_infomask2,
           items.t_infomask,
           items.t_hoff
      FROM blocks
      CROSS JOIN LATERAL public.heap_page_items(
        public.get_raw_page('public.${page.relation}', blocks.block_number)
      ) AS items
     ORDER BY blocks.block_number, items.lp`)
  const oldTuple = tupleRows.find((row) => row.t_xmin === created?.creator_xid)
  const newTuple = tupleRows.find((row) => row.t_xmin === replacement?.updater_xid)
  const [linePointer] = await query(`
    SELECT (public.page_header(
             public.get_raw_page('public.${page.relation}', 0)
           )).lower AS lower,
           pg_catalog.max(items.lp)::integer AS line_pointers
      FROM public.heap_page_items(
        public.get_raw_page('public.${page.relation}', 0)
      ) AS items`)
  const linePointerBytes = Number(linePointer?.lower) - 24
  const headerFields = tupleRows.length >= 2 && tupleRows.every((row) =>
    row.t_xmin !== null
    && row.t_xmax !== null
    && row.t_field3 !== null
    && row.t_ctid !== null
    && row.t_infomask2 !== null
    && row.t_infomask !== null
    && Number(row.t_hoff) >= 23)

  await psql(`VACUUM public.${page.relation}`)
  const redirectRows = await query(`
    SELECT lp, lp_flags, lp_off, lp_len
      FROM public.heap_page_items(
        public.get_raw_page('public.${page.relation}', 0)
      )
     ORDER BY lp`)
  const hasRedirect = redirectRows.some((row) => Number(row.lp_flags) === 2)
    && redirectRows.some((row) => Number(row.lp_flags) === 1)

  const multi = claim.multiXact
  await psql(`
    CREATE TABLE public.${multi.relation} (id integer PRIMARY KEY, note text NOT NULL);
    INSERT INTO public.${multi.relation} VALUES (1, 'shared lockers')`)
  const multiHolders = ['a', 'b'].map((suffix) => psqlCommand(pgBin, port, `
    SET application_name = 'oracle_multi_${suffix}';
    BEGIN;
    SELECT id FROM public.${multi.relation} WHERE id = 1 FOR SHARE;
    SELECT pg_catalog.pg_sleep(3);
    COMMIT`))
  await pollRow(
    query,
    `SELECT pg_catalog.count(*)::integer AS holders
       FROM pg_catalog.pg_stat_activity
      WHERE application_name IN ('oracle_multi_a', 'oracle_multi_b')
        AND wait_event = 'PgSleep'`,
    (row) => Number(row?.holders) === 2,
    5_000,
  )
  let multiRow
  ;[multiRow] = await query(`
    WITH tuple AS (
      SELECT items.t_xmax,
             pg_catalog.array_to_string(
               (public.heap_tuple_infomask_flags(
                 items.t_infomask,
                 items.t_infomask2
               )).raw_flags,
               ', '
             ) AS flags
        FROM public.heap_page_items(
          public.get_raw_page('public.${multi.relation}', 0)
        ) AS items
       WHERE items.lp = 1
    )
    SELECT t_xmax::text AS xmax,
           flags,
           (SELECT pg_catalog.count(*)
              FROM pg_catalog.pg_get_multixact_members(t_xmax))::integer AS members
      FROM tuple`)
  await Promise.all(multiHolders)

  const horizon = claim.removalHorizon
  await psql(`
    CREATE TABLE public.${horizon.relation} (id integer PRIMARY KEY, note text NOT NULL);
    INSERT INTO public.${horizon.relation} VALUES (1, 'old snapshot'), (2, 'tail survivor')`)
  const oldSnapshot = psqlCommand(pgBin, port, `
    SET application_name = 'oracle_old_snapshot';
    BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT pg_catalog.count(*) FROM public.${horizon.relation} WHERE id = 1;
    SELECT pg_catalog.pg_sleep(3);
    SELECT pg_catalog.count(*) FROM public.${horizon.relation} WHERE id = 1;
    COMMIT`)
  await pollRow(
    query,
    `SELECT backend_xmin::text AS backend_xmin, wait_event
       FROM pg_catalog.pg_stat_activity
      WHERE application_name = 'oracle_old_snapshot'`,
    (row) => Boolean(row?.backend_xmin) && row?.wait_event === 'PgSleep',
    5_000,
  )
  await psql(`DELETE FROM public.${horizon.relation} WHERE id = 1`)
  await psql(`VACUUM public.${horizon.relation}`)
  const [heldHorizon] = await query(`
    SELECT (SELECT pg_catalog.count(*)
         FROM public.heap_page_items(
           public.get_raw_page('public.${horizon.relation}', 0)
         ) AS items
        WHERE items.lp = 1
          AND items.lp_flags <> 0) AS physical_versions`)
  const oldSnapshotExecution = await oldSnapshot
  const oldSnapshotCounts = oldSnapshotExecution.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/u.test(line))
    .map(Number)
  heldHorizon.old_snapshot_rows = oldSnapshotCounts.at(-1)
  await psql(`VACUUM public.${horizon.relation}`)
  const [releasedHorizon] = await query(`
    SELECT pg_catalog.count(*) AS physical_versions
      FROM public.heap_page_items(
        public.get_raw_page('public.${horizon.relation}', 0)
      ) AS items
     WHERE items.lp = 1
       AND items.lp_flags <> 0`)

  const visibility = claim.visibilityMap
  await psql(`
    CREATE TABLE public.${visibility.relation} (id integer PRIMARY KEY, payload integer);
    INSERT INTO public.${visibility.relation}
    SELECT value, value FROM pg_catalog.generate_series(1, 100) AS value`)
  await psql(`VACUUM (FREEZE) public.${visibility.relation}`)
  const [visibleBefore] = await query(`
    SELECT pg_catalog.bool_and(all_visible) AS all_visible,
           pg_catalog.bool_and(all_frozen) AS all_frozen
      FROM public.pg_visibility_map('public.${visibility.relation}'::regclass)`)
  await psql(`UPDATE public.${visibility.relation} SET payload = payload + 1 WHERE id = 1`)
  const [visibleChanged] = await query(`
    SELECT all_visible, all_frozen
      FROM public.pg_visibility_map('public.${visibility.relation}'::regclass)
     WHERE blkno = 0`)
  await psql(`VACUUM (FREEZE) public.${visibility.relation}`)
  const [visibleAfter] = await query(`
    SELECT pg_catalog.bool_and(all_visible) AS all_visible,
           pg_catalog.bool_and(all_frozen) AS all_frozen
      FROM public.pg_visibility_map('public.${visibility.relation}'::regclass)`)

  const prepared = claim.preparedHorizon
  const horizonBackend = psqlCommand(pgBin, port, `
    SET application_name = 'oracle_horizon_backend';
    BEGIN ISOLATION LEVEL REPEATABLE READ;
    SELECT pg_catalog.pg_current_xact_id()::text;
    SELECT pg_catalog.pg_current_snapshot()::text;
    SELECT pg_catalog.pg_sleep(2);
    COMMIT`)
  const backendHorizon = await pollRow(
    query,
    `SELECT backend_xid::text AS backend_xid,
            backend_xmin::text AS backend_xmin
       FROM pg_catalog.pg_stat_activity
      WHERE application_name = 'oracle_horizon_backend'`,
    (row) => Boolean(row?.backend_xid) && Boolean(row?.backend_xmin),
    5_000,
  )
  await horizonBackend

  await psql(`
    CREATE TABLE public.oracle_prepared_horizon (id integer);
    BEGIN;
    INSERT INTO public.oracle_prepared_horizon VALUES (1);
    PREPARE TRANSACTION '${prepared.gid}'`)
  const [preparedRow] = await query(`
    SELECT transaction::text AS prepared_xid,
           pg_catalog.pg_snapshot_xmin(
             pg_catalog.pg_current_snapshot()
           )::text AS snapshot_xmin
      FROM pg_catalog.pg_prepared_xacts
     WHERE gid = '${prepared.gid}'`)
  await psql(`ROLLBACK PREPARED '${prepared.gid}'`)

  const tupleSummary = tupleRows.map((row) =>
    `lp ${row.lp} xmin ${row.t_xmin} xmax ${row.t_xmax} ctid ${row.t_ctid} hoff ${row.t_hoff}`)
    .join(' | ')
  return [
    result(
      'MVCC/xmin-xmax-ctid-update-chain',
      `${vocabulary.xmin.definition} ${vocabulary.xmax.definition} ${vocabulary.ctid.definition}`,
      tupleSummary,
      oldTuple?.t_xmax === replacement?.updater_xid
        && oldTuple?.t_ctid === replacement?.replacement_ctid
        && newTuple?.t_xmin === replacement?.updater_xid,
    ),
    result(
      'page-layout/line-pointer-size',
      vocabulary.linePointers.definition,
      `page header lower ${linePointer?.lower}; ${linePointer?.line_pointers} line pointers occupy ${linePointerBytes} bytes`,
      linePointerBytes === Number(linePointer?.line_pointers) * 4,
    ),
    result(
      'page-layout/tuple-header-fields',
      vocabulary.tupleHeader.definition,
      tupleSummary,
      headerFields,
    ),
    result(
      'HOT/redirect-line-pointer',
      vocabulary.hotChains.definition,
      redirectRows.map((row) => `lp ${row.lp} flags ${row.lp_flags} off ${row.lp_off} len ${row.lp_len}`).join(' | '),
      hasRedirect,
    ),
    result(
      'MVCC/MultiXact-lockers',
      vocabulary.xmax.definition,
      multiRow
        ? `xmax ${multiRow.xmax}; members ${multiRow.members}; flags ${multiRow.flags}`
        : 'MultiXact tuple observation is absent',
      Number(multiRow?.members) === 2
        && String(multiRow?.flags).includes('HEAP_XMAX_IS_MULTI')
        && String(multiRow?.flags).includes('HEAP_XMAX_LOCK_ONLY'),
    ),
    result(
      'MVCC/dead-versus-removable-horizon',
      vocabulary.tupleLiveness.definition,
      `while snapshot held: old session rows ${heldHorizon?.old_snapshot_rows}, physical versions ${heldHorizon?.physical_versions}; after release and VACUUM: ${releasedHorizon?.physical_versions}`,
      Number(heldHorizon?.old_snapshot_rows) === 1
        && Number(heldHorizon?.physical_versions) === 1
        && Number(releasedHorizon?.physical_versions) === 0,
    ),
    result(
      'visibility-map/set-clear-set',
      vocabulary.visibilityMap.definition,
      `VACUUM FREEZE ${visibleBefore?.all_visible}/${visibleBefore?.all_frozen}; modification ${visibleChanged?.all_visible}/${visibleChanged?.all_frozen}; VACUUM FREEZE ${visibleAfter?.all_visible}/${visibleAfter?.all_frozen}`,
      visibleBefore?.all_visible === true
        && visibleBefore?.all_frozen === true
        && visibleChanged?.all_visible === false
        && visibleChanged?.all_frozen === false
        && visibleAfter?.all_visible === true
        && visibleAfter?.all_frozen === true,
    ),
    result(
      'xmin-horizon/active-snapshot-and-assigned-xid',
      vocabulary.xminHorizon.definition,
      backendHorizon
        ? `backend_xid ${backendHorizon.backend_xid}; backend_xmin ${backendHorizon.backend_xmin}`
        : 'active backend horizon observation is absent',
      Boolean(backendHorizon?.backend_xid) && Boolean(backendHorizon?.backend_xmin),
    ),
    result(
      'xmin-horizon/prepared-transaction',
      vocabulary.xminHorizon.definition,
      preparedRow
        ? `prepared XID ${preparedRow.prepared_xid}; snapshot xmin ${preparedRow.snapshot_xmin}`
        : 'prepared transaction observation is absent',
      Boolean(preparedRow?.prepared_xid)
        && Number(preparedRow?.snapshot_xmin) <= Number(preparedRow?.prepared_xid),
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
    ['claim registry coverage', () => checkRegistryCoverage(registry)],
    ['version', () => checkVersion(server.query, registry, major)],
    ['WAL segment', () => checkWalSegment(server.psql, server.query, registry)],
    ['native recovery and timelines', () => checkNativeRecovery(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
      server.scratch,
      server.archiveDir,
      server.dataDir,
    )],
    ['asynchronous commit', () => checkAsynchronousCommit(pgBin, registry, server.scratch)],
    ['GUC defaults', () => checkGucDefaults(server.query, registry, major)],
    ['GUC contexts', () => checkGucContexts(server.query, registry, major)],
    ['catalog shapes', () => checkCatalog(server.psql, server.query, registry, major)],
    ['diagnostic SQL', () => checkDiagnosticSql(server.psql, registry, major)],
    ['wait events', () => checkWaitEvents(server.query, registry, major)],
    ['latency wait mappings', () => checkLatencyWaitMappings(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
    )],
    ['connection-local behavior', () => checkConnectionLocalBehavior(
      server.psql,
      registry,
      server.port,
    )],
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
    ['plain VACUUM', () => checkVacuumReclaim(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
    )],
    ['work_mem execution', () => checkWorkMemExecution(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
    )],
    ['storage and MVCC', () => checkStorageMvcc(server.psql, server.query, registry, major)],
    ['remaining MVCC and page layout', () => checkRemainingMvcc(
      pgBin,
      server.psql,
      server.query,
      registry,
      server.port,
    )],
    ['pg_stat_io values', () => checkPgStatIo(server.query, registry, major)],
    ['index walk', () => checkIndexWalk(server.psql, server.query, registry)],
    ['partial-index behavior', () => checkPartialIndexBehavior(
      server.psql,
      server.query,
      registry,
    )],
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
  for (const binary of [
    'initdb',
    'pg_basebackup',
    'pg_ctl',
    'pg_dump',
    'pg_restore',
    'pg_verifybackup',
    'psql',
    'postgres',
  ]) {
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
