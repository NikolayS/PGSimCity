import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { cityComponentHref, cityComponentId } from '../src/core/city-route'
import {
  CLAIMS,
  CLAIM_VALUES,
} from '../src/core/claims'
import { MACHINE_SYNCHRONOUS_COMMIT_COMPARISON } from '../src/spine/machine-comparison'
import { MACHINE_INDEX_WALK } from '../src/spine/machine-index-walk'
import { POSTGRESQL_ORACLE_CLAIMS } from '../src/spine/postgresql-oracle'
import type { ClaimId } from '../src/core/claims'
import { DESTINATIONS } from '../src/core/destinations'
import { formatModelMilliseconds } from '../src/core/trace-presentation'
import { N_BACKEND_SLOTS, N_BUFFERS } from '../src/core/types'
import { createBus } from '../src/core/bus'
import { CATALOG } from '../src/observability/catalog'
import { createCollector } from '../src/observability/collector'
import { ALL_STEPS, ALL_VERDICTS, SYMPTOMS } from '../src/observability/paths'
import { PROJECTIONS } from '../src/observability/views'
import {
  MODEL_BACKEND_CONCURRENCY_TARGET,
  MODEL_BULK_READ_RING_FRAMES,
  MODEL_LATENCY_WINDOW_TRIPS,
  createSim,
} from '../src/sim/model'
import { SCENARIOS } from '../src/sim/scenarios'
import { CHAPTERS } from '../src/ui/tour'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'
import { KNOB_META, doc, mdToHtml } from '../src/ui/content'
import { MODEL_LATENCY_VITAL_LABEL, emitLoose } from '../src/ui/hud'
import { createInspector } from '../src/ui/panel'
import type { UiContext } from '../src/ui/uikit'
import { VACUUM_RECLAIM_PLATE_LINES } from '../src/world/maintenance'
import { CONNECTION_POOLER_PLATE_LABEL } from '../src/world/clients'
import { TIMELINE_RECOVERY_PLATE_LABEL, WAL_ARCHIVE_SILO_PLATE_LINES } from '../src/world/continuity'
import { SHARED_BUFFER_SAMPLE_PLATE_LABEL } from '../src/world/shmem'
import { WAL_SEGMENT_PLATE_LABEL, WAL_SEGMENT_SIZE_PLATE_LABEL, WAL_VAULT_ROLE } from '../src/world/wal'
import { installTestDom } from './dom'
import { createWalkCityHarness } from './walk-harness'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function agrees<T>(claimId: ClaimId, surface: string, actual: T, expected: T): void {
  expect(
    actual,
    `${claimId}: ${surface} disagrees with ${CLAIMS[claimId].owner}`,
  ).toEqual(expected)
}

function storageDocCopy(id: string): string {
  const entry = DOCS_STORAGE.find((candidate) => candidate.id === id)
  expect(entry, `missing documentation surface ${id}`).toBeDefined()
  return [entry!.tldr, ...entry!.sections.map((section) => section.body)].join('\n')
}

interface SourceFile {
  surface: string
  text: string
}

function sourceFiles(directory = new URL('../src/', import.meta.url), prefix = 'src'): SourceFile[] {
  const files: SourceFile[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const surface = `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      files.push(...sourceFiles(new URL(`${entry.name}/`, directory), surface))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push({ surface, text: readFileSync(new URL(entry.name, directory), 'utf8') })
    }
  }
  return files
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length
}

describe('claims and conventions spine', () => {
  it('owns exactly the twenty-six drift-prone contracts across both passes', () => {
    expect(Object.keys(CLAIMS)).toEqual([
      'appVersion',
      'walSegment',
      'bufferSample',
      'bulkReadRing',
      'checkpointPolicy',
      'standbyNames',
      'modelDuration',
      'modelLatency',
      'connectionPooler',
      'workMem',
      'restoreDrill',
      'timelineRecovery',
      'vacuumReclaim',
      'mvccVocabulary',
      'cityComponentRoute',
      'cityArchitecture',
      'componentNaming',
      'eventConvention',
      'diagnoseBranchGates',
      'postgresqlVersion',
      'pgliteVersion',
      'markdownRendering',
      'reviewStatus',
      'machineSynchronousCommitComparison',
      'machineIndexWalk',
      'postgresqlOracle',
    ])
    for (const claim of Object.values(CLAIMS)) {
      expect(claim.owner).not.toBe('')
      expect(claim.surfaces.length).toBeGreaterThan(1)
    }
  })

  it('keeps the WAL-segment model, painted vault, and prose on 16 MiB', () => {
    const state = createSim(createBus()).state
    agrees('walSegment', 'model:wal.segmentSize', state.wal.segmentSize, CLAIM_VALUES.walSegment.bytes)
    agrees('walSegment', 'world:wal.vault size plate', WAL_SEGMENT_SIZE_PLATE_LABEL, CLAIM_VALUES.walSegment.label)
    expect(WAL_SEGMENT_PLATE_LABEL, 'walSegment: world:wal.vault plate omits the owned label')
      .toContain(CLAIM_VALUES.walSegment.label)
    expect(storageDocCopy('wal.vault'), 'walSegment: prose:WAL vault disagrees with the painted vault')
      .toContain(CLAIM_VALUES.walSegment.modelDisclosure)
  })

  it('qualifies every fixed-size WAL prose surface with the initdb scope', () => {
    const required = [
      'PostgreSQL default',
      'initdb',
      'reinitialising',
      'pg_settings',
      'wal_segment_size',
      'WAL filenames',
      'pg_walfile_name arithmetic',
    ]
    const ownedDisclosure = CLAIM_VALUES.walSegment.postgresqlDisclosure.join('\n')
    const sources = {
      'src/world/wal.ts WAL-vault role': WAL_VAULT_ROLE,
      'src/world/continuity.ts archive-silo plate': WAL_ARCHIVE_SILO_PLATE_LINES.join('\n'),
      'src/ui/docs-storage.ts WAL-vault summary': DOCS_STORAGE.find((entry) => entry.id === 'wal.vault')?.tldr ?? '',
    }
    const missing = [
      ...required.filter((phrase) => !ownedDisclosure.includes(phrase)).map((phrase) => `owned disclosure: ${phrase}`),
      ...Object.entries(sources).flatMap(([surface, copy]) =>
        CLAIM_VALUES.walSegment.postgresqlDisclosure
          .filter((sentence) => !copy.includes(sentence))
          .map((sentence) => `${surface}: ${sentence}`)),
    ]

    expect(Object.keys(sources)).toEqual([...CLAIM_VALUES.walSegment.qualifiedProseSurfaces])
    expect(POSTGRESQL_ORACLE_CLAIMS.walSegment.qualifiedFixedSurfaces)
      .toEqual(CLAIM_VALUES.walSegment.qualifiedProseSurfaces)
    expect(POSTGRESQL_ORACLE_CLAIMS.walSegment.unqualifiedFixedSurfaces).toEqual([])
    expect(missing, 'walSegment: fixed-size prose is missing the owned PostgreSQL scope').toEqual([])
  })

  it('distinguishes the 1,024-frame capacity from 256 active default frames', () => {
    const state = createSim(createBus()).state
    agrees('bufferSample', 'model:default active frames', state.buffers.sampleFrames, CLAIM_VALUES.bufferSample.defaultActiveFrames)
    agrees('bufferSample', 'model:sample capacity', N_BUFFERS, CLAIM_VALUES.bufferSample.capacityFrames)
    expect(state.cluster.nodes.map((node) => node.buffers.sampleFrames), 'bufferSample: model:node samples disagree')
      .toEqual(Array(3).fill(CLAIM_VALUES.bufferSample.defaultActiveFrames))
    expect(SHARED_BUFFER_SAMPLE_PLATE_LABEL, 'bufferSample: world:shared_buffers plate disagrees')
      .toContain(`UP TO ${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')} FRAMES`)

    const hint = KNOB_META.find((knob) => knob.key === 'sharedBuffers')?.hint ?? ''
    expect(hint, 'bufferSample: controls:shared_buffers hint omits the default active sample')
      .toContain(String(CLAIM_VALUES.bufferSample.defaultActiveFrames))
    const postgresDefault = POSTGRESQL_ORACLE_CLAIMS.gucDefaults.find(
      (claim) => claim.id === 'postgres-default/shared_buffers',
    )
    const modelDefault = POSTGRESQL_ORACLE_CLAIMS.gucDefaults.find(
      (claim) => claim.id === 'city-model/shared_buffers',
    )
    expect(postgresDefault, 'bufferSample: oracle lacks the PostgreSQL default').toBeDefined()
    expect(modelDefault, 'bufferSample: oracle lacks the city model default').toBeDefined()
    expect(Array.isArray(postgresDefault!.expected)).toBe(false)
    expect(Array.isArray(modelDefault!.expected)).toBe(false)
    const postgresValue = postgresDefault!.expected as { value: string | number, unit: string }
    const modelValue = modelDefault!.expected as { value: string | number, unit: string }
    expect(postgresValue.unit).toBe('MB')
    expect(modelValue.unit).toBe('MB')
    const readmeDefaultBoundary = `${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')} representative frames (${CLAIM_VALUES.bufferSample.defaultActiveFrames} active at the ${Number(modelValue.value) / 1024} GiB model default; ${CLAIM_VALUES.postgresqlVersion.majorLabel} defaults to ${postgresValue.value} MiB)`
    expect(read('README.md'), 'bufferSample: README:buffer-pool row disagrees with the oracle')
      .toContain(readmeDefaultBoundary)
    expect(storageDocCopy('standby.b'), 'bufferSample: prose:standby sample disclosure disagrees')
      .toContain(`${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')}-frame sample capacity; at the default 2 GiB setting ${CLAIM_VALUES.bufferSample.defaultActiveFrames} frames are active`)
  })

  it('keeps the historical bulk-read approximation explicit on every surface', () => {
    agrees(
      'bulkReadRing',
      'model:bulk-read ring',
      MODEL_BULK_READ_RING_FRAMES,
      CLAIM_VALUES.bulkReadRing.modelFrames,
    )
    expect(read('README.md'), 'bulkReadRing: README:bulk-read disclosure disagrees')
      .toContain(CLAIM_VALUES.bulkReadRing.disclosure)
    const cacheVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.io_ok')
    expect(cacheVerdict?.mechanism, 'bulkReadRing: Diagnose:cache verdict omits the fixed approximation')
      .toContain(CLAIM_VALUES.bulkReadRing.diagnoseDisclosure)
  })

  it('keeps max_wal_size beside checkpoint_timeout in the model and both dial sets', () => {
    const state = createSim(createBus()).state
    agrees(
      'checkpointPolicy',
      'model:checkpoint_timeout default',
      state.knobs.checkpointTimeout,
      CLAIM_VALUES.checkpointPolicy.defaultTimeoutSeconds,
    )
    agrees(
      'checkpointPolicy',
      'model:max_wal_size default',
      state.knobs.maxWalSize,
      CLAIM_VALUES.checkpointPolicy.defaultMaxWalSizeMiB,
    )

    const controlPartners = KNOB_META
      .filter((knob) => CLAIM_VALUES.checkpointPolicy.partners.some((key) => key === knob.key))
    expect(controlPartners.map((knob) => knob.key), 'checkpointPolicy: controls:checkpoint dials disagree')
      .toEqual(CLAIM_VALUES.checkpointPolicy.partners)
    expect(controlPartners.map((knob) => knob.group), 'checkpointPolicy: controls:dials are not siblings')
      .toEqual(['checkpoint', 'checkpoint'])

    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.ckpt_storm')
    expect(verdict?.knobs.slice(0, 2).map((knob) => knob.key), 'checkpointPolicy: Diagnose:checkpoint controls disagree')
      .toEqual(CLAIM_VALUES.checkpointPolicy.partners)
  })

  it('keeps internal standby IDs and reader-facing names paired', () => {
    const sim = createSim(createBus())
    const expected = CLAIM_VALUES.standbyNames.internal.map((id, index) => [
      id,
      CLAIM_VALUES.standbyNames.display[index],
    ])
    agrees(
      'standbyNames',
      'model:physical standbys',
      sim.state.replication.standbys.map((standby) => [standby.nodeId, standby.applicationName]),
      expected,
    )

    const control = KNOB_META.find((knob) => knob.key === 'synchronousStandbyNames')
    expect(control?.options?.slice(1).map((option) => option.label.split(' — ')[0]), 'standbyNames: controls:standby choices disagree')
      .toEqual(CLAIM_VALUES.standbyNames.display)

    const rows = PROJECTIONS.replication(sim.state, createCollector(sim), 'total').rows
    expect(rows.map((row) => row.cells.application_name), 'standbyNames: Diagnose:replication rows disagree')
      .toEqual(CLAIM_VALUES.standbyNames.display)
  })

  it('labels deliberately stretched durations as model time', () => {
    expect(formatModelMilliseconds(12), 'modelDuration: Query flow:duration readout disagrees')
      .toBe(`12 ${CLAIM_VALUES.modelDuration.millisecondUnit}`)

    const sim = createSim(createBus())
    const lockVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.lock_holder')
    const oldest = lockVerdict?.evidence(sim.state, createCollector(sim))
      .find((item) => item.label === 'oldest wait')?.value
    expect(oldest, 'modelDuration: Diagnose:lock duration disagrees')
      .toBe(`0 ${CLAIM_VALUES.modelDuration.shortUnit}`)
    expect(storageDocCopy('net.wire'), 'modelDuration: prose:network duration omits the convention')
      .toContain(CLAIM_VALUES.modelDuration.prose)
  })

  it('keeps rolling latency quantiles and units aligned across model, HUD, and prose', () => {
    agrees(
      'modelLatency',
      'shared:model-duration unit',
      CLAIM_VALUES.modelLatency.unit,
      CLAIM_VALUES.modelDuration.millisecondUnit,
    )
    agrees(
      'modelLatency',
      'model:rolling window',
      MODEL_LATENCY_WINDOW_TRIPS,
      CLAIM_VALUES.modelLatency.windowTrips,
    )
    const sim = createSim(createBus())
    for (let i = 0; i < 1800; i++) sim.update(1 / 30)
    agrees(
      'modelLatency',
      'model:quantile names',
      Object.keys(sim.state.stats.latency).filter((key) => key === 'p50' || key === 'p99'),
      CLAIM_VALUES.modelLatency.quantiles,
    )
    expect(MODEL_LATENCY_VITAL_LABEL, 'modelLatency: HUD unit disagrees')
      .toContain(CLAIM_VALUES.modelLatency.unit)
    expect(storageDocCopy('checkpointer'), 'modelLatency: prose omits the owned window')
      .toContain(CLAIM_VALUES.modelLatency.disclosure)
    expect(storageDocCopy('bgwriter'), 'modelLatency: prose omits per-component quantiles')
      .toContain(CLAIM_VALUES.modelLatency.componentDisclosure)
    expect(storageDocCopy('bgwriter'), 'modelLatency: prose omits component taxonomy')
      .toContain(CLAIM_VALUES.modelLatency.taxonomyDisclosure)
    expect(storageDocCopy('bgwriter'), 'modelLatency: prose omits within-batch limitation')
      .toContain(CLAIM_VALUES.modelLatency.batchDisclosure)
    expect(storageDocCopy('bgwriter'), 'modelLatency: prose omits integration resolution')
      .toContain(CLAIM_VALUES.modelLatency.resolutionDisclosure)
    const stall = SYMPTOMS.find((symptom) => symptom.id === 'stall')
    expect(stall?.sub, 'modelLatency: Diagnose:stall still denies the model quantiles')
      .toContain(`rolling p50/p99 in ${CLAIM_VALUES.modelLatency.unit}`)
    const commitChapter = CHAPTERS.find((chapter) => chapter.id === 'commit')
    expect(commitChapter?.body, 'modelLatency: tour:commit omits the visible quantiles')
      .toContain(`rolling p50/p99 in ${CLAIM_VALUES.modelLatency.unit}`)
  })

  it('keeps the pooler cap, costs, absences, controls, world, and scenario aligned', () => {
    const claim = CLAIM_VALUES.connectionPooler
    const sim = createSim(createBus())
    agrees(
      'connectionPooler',
      'model:stock pool mode',
      sim.state.knobs.poolMode,
      'disabled',
    )
    agrees(
      'connectionPooler',
      'model:teaching pool size',
      sim.state.knobs.defaultPoolSize,
      claim.modelDefaultPoolSize,
    )
    agrees(
      'connectionPooler',
      'model:backend-concurrency knee',
      MODEL_BACKEND_CONCURRENCY_TARGET,
      claim.concurrencyTarget,
    )
    agrees(
      'connectionPooler',
      'model:PgBouncer max_client_conn default',
      sim.state.knobs.maxClientConn,
      claim.pgBouncerDefaults.maxClientConn,
    )
    agrees(
      'connectionPooler',
      'model:PgBouncer query_wait_timeout default',
      sim.state.knobs.queryWaitTimeout,
      claim.pgBouncerDefaults.queryWaitTimeoutSeconds,
    )
    expect(CONNECTION_POOLER_PLATE_LABEL).toContain('PgBouncer')
    expect(CONNECTION_POOLER_PLATE_LABEL).toContain('pool_mode')

    const poolMode = KNOB_META.find((knob) => knob.key === 'poolMode')
    const poolSize = KNOB_META.find((knob) => knob.key === 'defaultPoolSize')
    const clientLimit = KNOB_META.find((knob) => knob.key === 'maxClientConn')
    const waitTimeout = KNOB_META.find((knob) => knob.key === 'queryWaitTimeout')
    expect(poolMode?.options?.map((option) => option.value))
      .toEqual(['disabled', 'session', 'transaction'])
    expect(poolMode?.hint).toContain(claim.transactionTradeoff)
    expect(poolMode?.hint).toContain(claim.coverageDisclosure)
    expect(poolSize?.hint).toContain(String(claim.pgBouncerDefaults.defaultPoolSize))
    expect(clientLimit?.hint).toContain(String(claim.pgBouncerDefaults.maxClientConn))
    expect(waitTimeout?.hint).toContain(String(claim.pgBouncerDefaults.queryWaitTimeoutSeconds))
    for (const control of [poolMode, poolSize, clientLimit, waitTimeout]) {
      expect(control?.disclosure).toBeTruthy()
    }

    const pooler = doc('client.pooler')
    const copy = [
      pooler?.tldr ?? '',
      ...(pooler?.sections.map((section) => section.body) ?? []),
    ].join('\n')
    expect(copy).toContain(claim.transactionTradeoff)
    expect(copy).toContain(claim.coverageDisclosure)
    expect(copy).toMatch(/pg_stat_activity.*server process/is)
    expect(copy).toMatch(/pgcat.*Odyssey/is)
    expect(copy).toMatch(/connect.*authentication.*backend[- ]startup/is)
    expect(copy).toMatch(/query_wait_timeout.*120.*disconnect/is)
    expect(copy).toMatch(/cl_active.*cl_waiting.*sv_active.*sv_idle/is)
    expect(copy).toMatch(/cl_active.*idle clients/is)
    expect(copy).not.toMatch(/not a speed feature/i)
    expect(copy).not.toMatch(/client_active|client_waiting|server_active|server_idle/i)
    expect(claim.absent).toEqual([
      'PgBouncer statement pool mode',
      'production session-lifetime distribution and reconnect backoff',
      'session variables and SET/RESET effects',
      'advisory-lock ownership across transactions',
      'prepared-statement tracking',
      'LISTEN registrations and NOTIFY delivery',
      'per-user and per-database pools, reserve pools and pool queues',
      'PgBouncer authentication, TLS, DNS, cancellation forwarding and admin console',
      'pgcat and Odyssey runtime behavior',
    ])

    const scenario = SCENARIOS.find((candidate) => candidate.id === 'connection-storm')
    const scenarioCopy = scenario?.beats?.flatMap((beat) => beat.slice(1)).join('\n') ?? ''
    expect(scenario?.knobs.poolMode).toBe('disabled')
    expect(scenario?.knobs.clientConnections).toBe(N_BACKEND_SLOTS)
    expect(scenarioCopy).toMatch(/Pool-slot queue/i)
    expect(scenarioCopy).toMatch(/SET\/RESET.*advisory lock.*PREPARE.*LISTEN/is)
    expect(scenarioCopy).toMatch(/cl_active.*cl_waiting.*sv_active.*sv_idle/is)
    expect(scenarioCopy).not.toMatch(/not a speed feature|client_active|server_active/i)

    const connections = doc('client.pool')
    const connectionCopy = [
      connections?.tldr ?? '',
      ...(connections?.sections.map((section) => section.body) ?? []),
    ].join('\n')
    expect(connectionCopy).toMatch(/configured ceiling.*startup allocation/is)
    expect(connectionCopy).toMatch(/runtime cost.*actually connected backends.*contention/is)
    expect(connectionCopy).not.toMatch(/every snapshot and every lock lookup more expensive/i)
  })

  it('keeps work_mem per-node math and model limits aligned across surfaces', () => {
    const sim = createSim(createBus())
    agrees(
      'workMem',
      'model:work_mem default',
      sim.state.knobs.workMem,
      CLAIM_VALUES.workMem.defaultMiB,
    )
    expect(CLAIM_VALUES.workMem.hashMemMultiplier).toBe(2)
    expect(CLAIM_VALUES.workMem.hashMemMultiplierDefaultSince).toBe(15)

    const control = KNOB_META.find((knob) => knob.key === 'workMem')
    expect(control?.hint, 'workMem: controls omit the per-node allowance')
      .toContain('Per eligible executor node')
    expect(control?.hint, 'workMem: controls omit hash_mem_multiplier')
      .toContain('hash_mem_multiplier')

    const localMemory = doc('backend.localmem')
    const copy = [
      localMemory?.tldr ?? '',
      ...(localMemory?.sections.map((section) => section.body) ?? []),
    ].join('\n')
    expect(copy, 'workMem: prose omits the owned per-node disclosure')
      .toContain(CLAIM_VALUES.workMem.nodeDisclosure.split(';')[0])
    expect(copy, 'workMem: prose omits model coverage limits')
      .toContain(CLAIM_VALUES.workMem.coverageDisclosure)
    expect(copy, 'workMem: prose omits log_temp_files').toContain('log_temp_files')
    expect(copy, 'workMem: prose omits pg_stat_database temp counters')
      .toContain('pg_stat_database.temp_files')

    expect(read('src/world/backends.ts'), 'workMem: world still invents timed spills')
      .toContain('The model decides whether bytes exist')
    expect(read('src/world/storage.ts'), 'workMem: temp bay omits cumulative counters')
      .toContain('temp_files /')
    expect(read('src/ui/docs-memory.ts'), 'workMem: planner limitation was removed')
      .toContain('no SQL grammar, catalog analysis, rewrite rules, prepared-plan cache or cost-based plan selection')
  })

  it('keeps restore-drill proof levels ordered and explicit on every surface', () => {
    const levels = CLAIM_VALUES.restoreDrill.levels
    expect(levels.table.rank).toBeLessThan(levels.cluster.rank)
    expect(levels.cluster.rank).toBeLessThan(levels.verified.rank)

    const sim = createSim(createBus())
    agrees(
      'restoreDrill',
      'model:restore-drill evidence rank',
      sim.state.disasterRecovery.drill.evidenceRank,
      levels.verified.rank,
    )
    const restoreDoc = DOCS_STORAGE.find((entry) => entry.id === 'recovery.ground')
    const timingMetric = restoreDoc?.metrics?.find(
      (metric) => metric.label === 'Restore-to-target time',
    )
    expect(timingMetric?.get(sim.state)).toBe('not measured')
    expect(sim.startRestoreDrill('verified')).toBe(false)
    expect(sim.state.disasterRecovery.drill.estimatedRestoreToTargetSec).toBe(0)
    expect(timingMetric?.get(sim.state)).toBe('not measured')

    const copy = storageDocCopy('recovery.ground')
    for (const level of Object.values(levels)) {
      expect(copy, `restoreDrill: prose omits the supported claim for ${level.label}`)
        .toContain(level.supports)
      expect(copy, `restoreDrill: prose omits the limit for ${level.label}`)
        .toContain(level.limits)
    }
    expect(copy).toContain(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure)
    expect(copy).toContain(CLAIM_VALUES.restoreDrill.checksumDisclosure)
    expect(copy).toContain(CLAIM_VALUES.restoreDrill.smokeDisclosure)
    expect(copy).toContain(CLAIM_VALUES.restoreDrill.cadenceDisclosure)

    expect(levels.table.limits).toContain('business invariant')
    expect(levels.table.limits).toContain('failover')
    expect(levels.cluster.limits).toContain('business invariant')
    expect(levels.cluster.limits).toContain('failover')
    expect(levels.table.supports).not.toContain('recovery startup')
    expect(levels.cluster.supports).not.toContain('recovery startup')

    expect(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure).toMatch(/scratch host/i)
    expect(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure)
      .toMatch(/does not require a pre-existing logical archive/i)
    expect(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure).toMatch(/pg_dump -t|COPY/i)
    expect(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure).toMatch(/no PITR|not a PITR/i)
    expect(CLAIM_VALUES.restoreDrill.physicalScopeDisclosure)
      .toMatch(/pg_restore -t.*depend/i)

    expect(CLAIM_VALUES.restoreDrill.checksumDisclosure).toMatch(/pg_verifybackup/i)
    expect(CLAIM_VALUES.restoreDrill.checksumDisclosure).toMatch(/pgBackRest verify/i)
    expect(CLAIM_VALUES.restoreDrill.checksumDisclosure)
      .toMatch(/backup-push --verify.*taking the backup/i)
    expect(CLAIM_VALUES.restoreDrill.timeDisclosure).toMatch(/restore-to-target time/i)
    expect(CLAIM_VALUES.restoreDrill.timeDisclosure).toMatch(/starts before.*backup-fetch/i)
    expect(CLAIM_VALUES.restoreDrill.timeDisclosure)
      .toMatch(/promotion.*endpoint.*client reconnection.*service restoration/i)

    installTestDom()
    const mount = document.createElement('div')
    mount.id = 'hud-right'
    document.body.append(mount)
    const bus = createBus()
    const ctx: UiContext = {
      bus,
      sim: createSim(bus),
      registry: { get: () => undefined } as UiContext['registry'],
      getFps: () => 60,
      getQuality: () => ({
        level: 'high',
        pixelRatio: 1,
        bloom: true,
        shadows: true,
        maxParticles: 1,
        maxLabels: 1,
        antialias: true,
      }),
      getFlowStats: () => ({ active: 0, dropped: 0 }),
    }
    const inspector = createInspector(ctx)
    try {
      bus.emit('select', { id: 'recovery.ground' })
      const evidence = document.querySelector('[data-restore-drill="control"]')
      expect(evidence?.textContent, 'restoreDrill: inspector omits the default supported claim')
        .toContain(levels.verified.supports)
      expect(evidence?.textContent, 'restoreDrill: inspector omits the default limit')
        .toContain(levels.verified.limits)
      expect(evidence?.querySelectorAll('[data-disclosure]')).not.toHaveLength(0)
      const proof = evidence?.querySelector<HTMLElement>('.pgc-drill__proof')
      const limits = evidence?.querySelector<HTMLElement>('.pgc-drill__limits')
      expect(proof?.dataset.disclosure).toBeUndefined()
      expect(limits?.dataset.disclosure).toBe('restore-drill-limits')
    } finally {
      inspector.dispose()
    }
  })

  it('keeps one-fork timeline recovery explicit across model, controls, world, and prose', () => {
    const timeline = CLAIM_VALUES.timelineRecovery
    expect(timeline.modeledForkDepth).toBe(1)
    expect(timeline.absent).toEqual([
      'backup manifests with more than two WAL ranges',
      'numeric timeline targets',
      'multiple-fork trees',
      'timeline-history parsing',
      'restore-side credentials and object GET failures',
      'wider recovery_target_* interactions',
    ])
    const sim = createSim(createBus())
    agrees(
      'timelineRecovery',
      'model:recovery_target_timeline default',
      sim.state.knobs.recoveryTargetTimeline,
      timeline.defaultTarget,
    )
    agrees(
      'timelineRecovery',
      'world:timeline switchyard plate',
      TIMELINE_RECOVERY_PLATE_LABEL,
      timeline.plate,
    )
    expect(
      TIMELINE_RECOVERY_PLATE_LABEL,
      'timelineRecovery: the plate qualifies backup usability only in collapsed prose',
    ).toMatch(/one-fork model.*pre-fork backup stays usable/i)

    const control = KNOB_META.find((knob) => knob.key === 'recoveryTargetTimeline')
    expect(control?.options?.map((option) => option.value)).toEqual(['latest', 'current'])
    expect(control?.hint).toContain(timeline.historyFile)
    expect(
      control?.hint,
      'timelineRecovery: the control hint omits the scope of the behavior it presents',
    ).toContain(timeline.coverageDisclosure)
    expect(timeline.defaultDisclosure).toMatch(
      /current.*base backup.*archived WAL.*transaction-end record.*crosses the target/i,
    )
    expect(timeline.defaultDisclosure).not.toMatch(/timeline mismatch|preflight/i)

    for (const id of ['timeline.yard', 'recovery.ground', 'recovery.clock']) {
      const copy = storageDocCopy(id)
      expect(copy, `${id} omits pre-fork backup usability`).toContain(
        timeline.crossingDisclosure,
      )
      expect(copy, `${id} omits one-fork coverage`).toContain(timeline.coverageDisclosure)
      expect(copy, `${id} still teaches the false current preflight rejection`).not.toMatch(
        /current produces a timeline-named FAIL before|timeline mismatch.*current/i,
      )
    }

    installTestDom()
    const mount = document.createElement('div')
    mount.id = 'hud-right'
    document.body.append(mount)
    const bus = createBus()
    const ctx: UiContext = {
      bus,
      sim: createSim(bus),
      registry: { get: () => undefined } as UiContext['registry'],
      getFps: () => 60,
      getQuality: () => ({
        level: 'high',
        pixelRatio: 1,
        bloom: true,
        shadows: true,
        maxParticles: 1,
        maxLabels: 1,
        antialias: true,
      }),
      getFlowStats: () => ({ active: 0, dropped: 0 }),
    }
    const inspector = createInspector(ctx)
    try {
      bus.emit('select', { id: 'timeline.yard' })
      const panel = document.querySelector(
        '[data-disclosure="one-fork-timeline-recovery-scope"]',
      )
      expect(panel).not.toBeNull()
      const visibleScope = panel?.querySelector(
        '[data-disclosure="one-fork-timeline-recovery-visible-scope"]',
      )
      expect(visibleScope?.textContent).toBe(timeline.coverageDisclosure)
      expect(visibleScope?.closest('details')).toBeNull()
      expect(panel?.childNodes[0]).toBe(visibleScope)
      expect(panel?.querySelector('[data-correction-path="true"]')).not.toBeNull()
    } finally {
      inspector.dispose()
    }
  })

  it('keeps vacuum truncation qualified on the model, plate, tour, and docs', () => {
    expect(CLAIM_VALUES.vacuumReclaim).toMatchObject({
      truncationLock: {
        mode: 'ACCESS EXCLUSIVE',
        attempt: 'non-blocking',
        consequence: expect.stringMatching(/gives up.*space.*not returned/iu),
      },
    })
    agrees(
      'vacuumReclaim',
      'world:landfill plate',
      VACUUM_RECLAIM_PLATE_LINES,
      CLAIM_VALUES.vacuumReclaim.plateLines,
    )
    expect(VACUUM_RECLAIM_PLATE_LINES.join(' '), 'vacuumReclaim: world:landfill plate omits the non-blocking truncation lock')
      .toMatch(/ACCESS EXCLUSIVE.*non-blocking/iu)
    const vacuumChapter = CHAPTERS.find((chapter) => chapter.id === 'vacuum')
    expect(vacuumChapter?.body, 'vacuumReclaim: tour:vacuum chapter disagrees')
      .toContain(CLAIM_VALUES.vacuumReclaim.rule)
    expect(vacuumChapter?.body, 'vacuumReclaim: tour:vacuum chapter omits the failed-lock consequence')
      .toMatch(/non-blocking.*gives up.*space.*not returned/iu)
    expect(storageDocCopy('autovac.worker'), 'vacuumReclaim: prose:vacuum docs omit trailing-empty-page rule')
      .toContain('only shortens the file if the very last pages are entirely empty')
    for (const id of ['storage.table', 'autovac.worker', 'landfill']) {
      expect(storageDocCopy(id), `vacuumReclaim: prose:${id} omits the non-blocking truncation lock`)
        .toMatch(/ACCESS EXCLUSIVE.*(?:non-blocking|does not wait|abandon).*space.*(?:stays|not returned)/isu)
    }
    const horizonDoc = DOCS_MEMORY.find((candidate) => candidate.id === 'xmin.horizon')
    const horizonCopy = horizonDoc
      ? [horizonDoc.tldr, ...horizonDoc.sections.map((section) => section.body)].join('\n')
      : ''
    expect(horizonCopy, 'vacuumReclaim: prose:xmin horizon omits the non-blocking truncation lock')
      .toMatch(/ACCESS EXCLUSIVE.*(?:non-blocking|does not wait|abandon).*space.*(?:stays|not returned)/isu)
    const bloatScenario = SCENARIOS.find((scenario) => scenario.id === 'bloat-and-vacuum')
    expect(JSON.stringify(bloatScenario?.beats), 'vacuumReclaim: scenario:bloat omits the non-blocking truncation lock')
      .toMatch(/ACCESS EXCLUSIVE.*non-blocking.*gives up.*space.*not returned/iu)
    const noBloatVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.no_bloat')
    expect(noBloatVerdict?.mechanism, 'vacuumReclaim: Diagnose:no-bloat verdict disagrees')
      .toContain(CLAIM_VALUES.vacuumReclaim.rule)
    expect(read('src/sim/scenarios.ts'), 'vacuumReclaim: model:vacuum narration omits its tail-density simplification')
      .toContain('truncation uses a tail-density heuristic')
  })

  it('keeps every Diagnose city-link producer connected to the city hash consumer', () => {
    const targets = [...ALL_STEPS, ...ALL_VERDICTS, ...CATALOG]
      .map((entry) => entry.city)
      .filter((id): id is string => Boolean(id))
    expect(targets.length).toBeGreaterThanOrEqual(36)

    for (const id of targets) {
      const href = cityComponentHref(id, '../')
      expect(href, `cityComponentRoute: Diagnose:city link for ${id} uses the wrong convention`)
        .toBe(`../${CLAIM_VALUES.cityComponentRoute.hashPrefix}${id}`)
      expect(cityComponentId(href.slice(3)), `cityComponentRoute: city:hash consumer rejects ${id}`)
        .toBe(id)
      expect(doc(id), `cityComponentRoute: ${id} has no selectable city component document`).toBeDefined()
    }
  })

  it('uses the owned markdown renderer for inspector and tour prose', () => {
    agrees(
      'markdownRendering',
      'renderer owner',
      CLAIMS.markdownRendering.value.owner,
      'mdToHtml',
    )
    expect(mdToHtml('turn **on** `synchronous_commit`'), 'markdownRendering: inspector:document body disagrees')
      .toBe('turn <strong>on</strong> <code>synchronous_commit</code>')
    expect(CHAPTERS[6].body, 'markdownRendering: tour:chapter body has no markdown to exercise')
      .toContain('`synchronous_commit`')
  })

  it('keeps the reviewed status aligned between README and boot screen', () => {
    expect(read('README.md'), 'reviewStatus: README:trust statement disagrees')
      .toContain(CLAIM_VALUES.reviewStatus.summary)
    const index = read('index.html')
    expect(index, 'reviewStatus: index:boot honesty still says unreviewed').not.toMatch(/unreviewed/i)
    expect(index, 'reviewStatus: index:boot honesty disagrees')
      .toContain(`<strong>${CLAIM_VALUES.reviewStatus.bootLabel}</strong>`)
  })

  it('keeps the Machine comparison attached to the modeled asynchronous acknowledgement claim', () => {
    agrees(
      'machineSynchronousCommitComparison',
      'Machine:comparison claim',
      CLAIMS.machineSynchronousCommitComparison.value,
      MACHINE_SYNCHRONOUS_COMMIT_COMPARISON,
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.evidenceSource).toBe('model')
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.finding).toContain('WAL still flushes later')
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.finding).toContain(
      'crash can lose acknowledged commits',
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.finding).toContain(
      'roughly 3 × wal_writer_delay',
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.finding).toContain(
      'Transactions stay atomic',
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.pgliteDisclosure).toContain(
      'cannot measure this difference',
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.replayDisclosure).toContain(
      'not SET or re-executed in PGlite',
    )
    expect(read('machine/comparison.js'), 'Machine:comparison does not consume the owned claim')
      .toContain('MACHINE_SYNCHRONOUS_COMMIT_COMPARISON as claim')
    const roadmap = read('ROADMAP.md')
    expect(roadmap, 'Machine:comparison remains described as future work')
      .toContain('**Shipped — controlled comparison.**')
    expect(roadmap, 'Machine:comparison roadmap still claims two PostgreSQL executions')
      .toMatch(/one PostgreSQL execution report/i)
  })

  it('keeps the Machine index walk attached to its sequential P/M boundary', () => {
    agrees(
      'machineIndexWalk',
      'Machine:index walk claim',
      CLAIMS.machineIndexWalk.value,
      MACHINE_INDEX_WALK,
    )
    expect(MACHINE_INDEX_WALK.finding).toContain('accounts_pkey')
    expect(MACHINE_INDEX_WALK.finding).toContain('Index Scan')
    expect(MACHINE_INDEX_WALK.finding).toContain('Seq Scan')
    expect(MACHINE_INDEX_WALK.sequenceDisclosure).toContain('one after another')
    expect(MACHINE_INDEX_WALK.sequenceDisclosure).toContain('one in-memory PGlite connection')
    expect(MACHINE_INDEX_WALK.modelDisclosure).toContain('M board motion')
    expect(MACHINE_INDEX_WALK.modelDisclosure).toContain('no concurrency')
    expect(MACHINE_INDEX_WALK.modelDisclosure).toContain('no device latency')
    expect(read('machine/index-walk.js'), 'Machine:index walk does not consume the owned claim')
      .toContain('MACHINE_INDEX_WALK as claim')
  })

  it('uses each registered destination name as its inspector panel title', async () => {
    const city = await createWalkCityHarness()
    let inspector: ReturnType<typeof createInspector> | undefined
    try {
      const mount = document.createElement('div')
      mount.id = 'hud-right'
      document.body.append(mount)
      const bus = createBus()
      const sim = createSim(bus)
      const ctx: UiContext = {
        bus,
        sim,
        registry: city.registry,
        getFps: () => 60,
        getQuality: () => ({
          level: 'high',
          pixelRatio: 1,
          bloom: true,
          shadows: true,
          maxParticles: 1,
          maxLabels: 1,
          antialias: true,
        }),
        getFlowStats: () => ({ active: 0, dropped: 0 }),
      }
      inspector = createInspector(ctx)

      for (const destination of DESTINATIONS) {
        const registered = city.registry.get(destination.id)
        expect(registered, `componentNaming: city registry has no ${destination.id} for inspector:panel heading`)
          .toBeDefined()
        bus.emit('select', { id: destination.id })
        expect.soft(
          document.querySelector('.pgc-insp__title')?.textContent,
          `componentNaming: inspector:panel heading for ${destination.id} disagrees with ${CLAIMS.componentNaming.owner} "${registered?.name}"`,
        ).toBe(registered?.name)
      }
    } finally {
      inspector?.dispose()
      city.dispose()
    }
  })

  it('resolves every deep link, tour target, and scenario focus in the city registry', async () => {
    const city = await createWalkCityHarness()
    try {
      const targets: { producer: string; id: string }[] = [
        ...DESTINATIONS.map((destination) => ({
          producer: `navigation:destination ${destination.district}`,
          id: destination.id,
        })),
        ...CHAPTERS.flatMap((chapter) => [
          ...(chapter.focus ? [{ producer: `tour:${chapter.id}.focus`, id: chapter.focus }] : []),
          ...(chapter.look ?? []).map(([, id], index) => ({
            producer: `tour:${chapter.id}.look[${index}]`,
            id,
          })),
        ]),
        ...SCENARIOS.flatMap((scenario) => scenario.focus
          ? [{ producer: `scenario:${scenario.id}.focus`, id: scenario.focus }]
          : []),
        ...ALL_STEPS.flatMap((step) => step.city
          ? [{ producer: `Diagnose:step ${step.id}.city`, id: step.city }]
          : []),
        ...ALL_VERDICTS.flatMap((verdict) => verdict.city
          ? [{ producer: `Diagnose:verdict ${verdict.id}.city`, id: verdict.city }]
          : []),
        ...CATALOG.flatMap((entry) => entry.city
          ? [{ producer: `Diagnose:catalog ${entry.id}.city`, id: entry.city }]
          : []),
      ]

      for (const target of targets) {
        expect.soft(
          city.registry.get(target.id),
          `cityComponentRoute: ${target.producer} emits "${target.id}" but city:component registry has no matching consumer`,
        ).toBeDefined()
      }
    } finally {
      city.dispose()
    }
  })

  it('keeps every production event emitter connected to a source handler', () => {
    installTestDom()
    const convention = CLAIM_VALUES.eventConvention
    const emitters = new Map<string, string[]>()
    const handlers = new Map<string, string[]>()
    const record = (map: Map<string, string[]>, event: string, surface: string): void => {
      const list = map.get(event) ?? []
      list.push(surface)
      map.set(event, list)
    }

    const emitterPattern = new RegExp(`\\.${convention.emitterMethod}\\(\\s*['"]([^'"]+)['"]`, 'g')
    const handlerPattern = new RegExp(`\\.(?:${convention.handlerMethods.join('|')})\\(\\s*['"]([^'"]+)['"]`, 'g')
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(emitterPattern)) {
        record(emitters, match[1], `${file.surface}:${lineOf(file.text, match.index)}`)
      }
      for (const match of file.text.matchAll(/emitLoose\(\s*[^,]+,\s*['"]([^'"]+)['"]/g)) {
        record(emitters, match[1], `${file.surface}:${lineOf(file.text, match.index)}`)
      }
      for (const match of file.text.matchAll(handlerPattern)) {
        record(handlers, match[1], `${file.surface}:${lineOf(file.text, match.index)}`)
      }
    }

    for (const [event, surfaces] of emitters) {
      expect.soft(
        handlers.get(event),
        `eventConvention: emitters ${surfaces.join(', ')} publish "${event}" but source:handlers has no matching consumer under ${CLAIMS.eventConvention.owner}`,
      ).toBeDefined()
    }

    const bus = createBus()
    let handled: unknown
    let bridged: unknown
    bus.on('ui:palette', (payload) => { handled = payload })
    window.addEventListener(`${convention.browserPrefix}palette`, (event) => {
      bridged = (event as CustomEvent).detail
    }, { once: true })
    emitLoose(bus, 'ui:palette', { open: true })
    expect(
      handled,
      `eventConvention: source:emitLoose emitter disagrees with source:ui:palette handler under ${CLAIMS.eventConvention.owner}`,
    ).toEqual({ open: true })
    expect(
      bridged,
      `eventConvention: browser:CustomEvent bridge disagrees with source:emitLoose and ${CLAIMS.eventConvention.owner}.browserPrefix`,
    ).toEqual({ open: true })
  })

  it('uses the pg_stat_io warning range for its client-backend-write branch', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const warningShare = CLAIM_VALUES.diagnoseBranchGates.clientBackendWriteShare.threshold + 0.01
    collector.total.backendWrites = warningShare * 100
    collector.total.ckptBuffers = 0
    collector.total.bgwClean = (1 - warningShare) * 100
    const projection = PROJECTIONS.io(sim.state, collector, 'total')
    const step = ALL_STEPS.find((candidate) => candidate.id === 'io.1')
    const branch = step?.branches.find((candidate) => candidate.next === 'v.backend_writes')

    expect(projection.rows.find((row) => row.key === 'client')?.tone).toBe('warn')
    expect(
      branch?.test(sim.state, collector),
      'diagnoseBranchGates: Diagnose:io.1 → v.backend_writes disagrees with Diagnose:pg_stat_io client-backend-write warning range',
    ).toBe(true)
  })

  it('keeps table and replication evidence boundaries disjoint from healthy verdicts', () => {
    const tableSim = createSim(createBus())
    const tableCollector = createCollector(tableSim)
    for (const table of tableSim.state.tables) {
      table.deadTuples = 0
      table.lastVacuum = 0
    }
    const table = tableSim.state.tables[0]
    table.liveTuples = 979
    table.deadTuples = 21
    table.lastVacuum = 1
    const tableRow = PROJECTIONS.tables(tableSim.state, tableCollector, 'total').rows
      .find((row) => row.key === table.def.id)
    const bloatBranch = ALL_STEPS.find((step) => step.id === 'bloat.1')?.branches
      .find((branch) => branch.next === 'bloat.2')
    expect(
      tableRow?.tone,
      'diagnoseBranchGates: Diagnose:pg_stat_all_tables 2% warning disagrees with Diagnose:bloat.1 → bloat.2 dead-tuple gate',
    ).toBe('warn')
    expect(
      bloatBranch?.test(tableSim.state, tableCollector),
      'diagnoseBranchGates: Diagnose:bloat.1 → bloat.2 disagrees with Diagnose:pg_stat_all_tables dead-tuple warning range',
    ).toBe(true)

    const replicaSim = createSim(createBus())
    const replicaCollector = createCollector(replicaSim)
    const [standby, extra] = replicaSim.state.replication.standbys
    const primary = replicaSim.state.wal.writeLsn
    standby.enabled = true
    standby.connected = true
    standby.sentLsn = primary
    standby.writtenLsn = primary
    standby.flushedLsn = primary
    standby.appliedLsn = primary - CLAIM_VALUES.diagnoseBranchGates.replayStageGapBytes.threshold - 1
    extra.enabled = false
    const replica = ALL_STEPS.find((step) => step.id === 'replica.1')
    const replay = replica?.branches.find((branch) => branch.next === 'v.replay')
    const healthy = replica?.branches.find((branch) => branch.next === 'v.rep_ok')
    expect(
      replay?.test(replicaSim.state, replicaCollector),
      'diagnoseBranchGates: Diagnose:replica.1 → v.replay rejects a replay-stage gap above its registered evidence boundary',
    ).toBe(true)
    expect(
      healthy?.test(replicaSim.state, replicaCollector),
      'diagnoseBranchGates: Diagnose:replica.1 → v.rep_ok overlaps Diagnose:replica.1 → v.replay between its registered stage and position boundaries',
    ).toBe(false)
  })

  it('registers every non-zero Diagnose branch range with its evidence source', () => {
    const actual = new Map(
      ALL_STEPS.flatMap((step) => step.branches.map((branch) => [
        `${step.id}→${branch.next}`,
        branch,
      ] as const)),
    )

    for (const [gate, contract] of Object.entries(CLAIM_VALUES.diagnoseBranchGates)) {
      for (const surface of contract.branches) {
        const branch = actual.get(surface)
        expect(branch, `diagnoseBranchGates: Diagnose:${surface} is named by ${CLAIMS.diagnoseBranchGates.owner} but has no branch surface`)
          .toBeDefined()
        expect.soft(
          branch?.gates,
          `diagnoseBranchGates: Diagnose:${surface} disagrees with ${CLAIMS.diagnoseBranchGates.owner}.${gate}`,
        ).toContain(gate)
        expect.soft(
          branch?.source,
          `diagnoseBranchGates: Diagnose:${surface} evidence source disagrees with ${CLAIMS.diagnoseBranchGates.owner}.${gate}`,
        ).toBe(contract.source)
      }
    }

    for (const [surface, branch] of actual) {
      const hasUnownedNonZeroRange = /(?:<|>)=?\s*(?:0\.\d*[1-9]|[1-9]\d*)/.test(branch.test.toString())
      expect.soft(
        hasUnownedNonZeroRange && !branch.gates?.length,
        `diagnoseBranchGates: Diagnose:${surface} has a non-zero range but bypasses ${CLAIMS.diagnoseBranchGates.owner}`,
      ).toBe(false)
    }
  })

  it('pins target-version prose, manual links, and source links to the reviewed point release', () => {
    const owner = CLAIMS.postgresqlVersion.owner
    const version = CLAIM_VALUES.postgresqlVersion
    const files = [
      { surface: 'README.md', text: read('README.md') },
      { surface: 'observability/README.md', text: read('observability/README.md') },
      ...sourceFiles(),
    ]

    for (const { surface, text } of files) {
      for (const match of text.matchAll(/PostgreSQL (\d+\.\d+)/g)) {
        expect.soft(
          match[0],
          `postgresqlVersion: ${surface}:${lineOf(text, match.index)} cites ${match[0]} and disagrees with ${owner}`,
        ).toBe(version.referenceLabel)
      }
      expect.soft(
        text,
        `postgresqlVersion: ${surface}:manual links use docs/current and disagree with ${owner}`,
      ).not.toContain('postgresql.org/docs/current')
      expect.soft(
        text,
        `postgresqlVersion: ${surface}:source links use master and disagree with ${owner}`,
      ).not.toMatch(/github\.com\/postgres\/postgres\/(?:blob|tree)\/master/)
    }
    expect(read('README.md'), `postgresqlVersion: README:source branch disagrees with ${owner}`)
      .toContain(version.sourceBranch)
    expect(read('observability/README.md'), `postgresqlVersion: Diagnose:manual path disagrees with ${owner}`)
      .toContain(`postgresql.org/docs/${version.major}`)

    const city = read('index.html')
    expect(city, `postgresqlVersion: city:visible teaching target disagrees with ${owner}`)
      .toContain(`This city's model and explanations describe ${version.referenceLabel}.`)
    expect(city, 'postgresqlVersion: city:visible teaching target lacks a disclosure marker')
      .toContain('data-disclosure="city-postgresql-version"')

    const machine = read('machine/index.html')
    expect(machine, `postgresqlVersion: Machine:model teaching target disagrees with ${owner}`)
      .toContain(`Model and explanations: ${version.referenceLabel}`)
    expect(machine, 'postgresqlVersion: Machine:model teaching target lacks a disclosure marker')
      .toContain('data-disclosure="machine-postgresql-version"')

    const diagnose = read('src/observability/main.ts')
    expect(diagnose, `postgresqlVersion: Diagnose:visible teaching target bypasses ${owner}`)
      .toContain('CLAIM_VALUES.postgresqlVersion.referenceLabel')
    expect(diagnose, 'postgresqlVersion: Diagnose:visible teaching target lacks a disclosure marker')
      .toContain("disclosure: 'diagnose-postgresql-version'")

    const pglite = CLAIM_VALUES.pgliteVersion
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, { version?: string }>
    }
    agrees(
      'pgliteVersion',
      'dependency:package-lock',
      lock.packages['node_modules/@electric-sql/pglite']?.version,
      pglite.packageVersion,
    )
    expect(machine, `pgliteVersion: Machine:separate engine provenance disagrees with ${CLAIMS.pgliteVersion.owner}`)
      .toContain(`PGlite engine: ${pglite.reportedPrefix}`)
    expect(machine, 'pgliteVersion: Machine:separate engine provenance does not name its evidence')
      .toContain('checked separately with SELECT version()')
  })
})
