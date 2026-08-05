/*
 * Cross-surface facts and conventions that have drifted before. Values live
 * here; the surface list is the contract exercised by test/claims-spine.test.ts.
 * Keep this list deliberately small and evidence-led.
 */

import { MACHINE_SYNCHRONOUS_COMMIT_COMPARISON } from '../spine/machine-comparison'
import { MACHINE_INDEX_WALK } from '../spine/machine-index-walk'
import { MVCC_VOCABULARY } from '../spine/mvcc-vocabulary'
import { PGLITE_VERSION } from '../spine/pglite-version'
import { CITY_ARCHITECTURE_CLAIMS } from '../spine/city-architecture'
import { BUILD_LABEL } from './build'

const KIB = 1024
const MIB = KIB * KIB
const MODEL_MILLISECOND_UNIT = 'model ms'
const POSTGRESQL_MAJOR = 18
const POSTGRESQL_REFERENCE_MINOR = 4
const MODEL_CONNECTION_RESERVATIONS = {
  superuser: 3,
  reserved: 0,
} as const
const PGBOUNCER_POOL_MODE_CLAIM = {
  modes: ['session', 'transaction', 'statement'],
  releaseBoundary: {
    session: 'client disconnect',
    transaction: 'transaction finish',
    statement: 'query finish',
  },
  statementTransactionError: {
    severity: 'FATAL',
    sqlstate: '08P01',
    message: 'transaction blocks not allowed in statement pooling mode',
    consequence: 'PgBouncer closes the client connection',
    verifiedAgainst: 'PgBouncer 1.25.2',
  },
  sources: [
    { label: 'PgBouncer pool_mode configuration', url: 'https://www.pgbouncer.org/config#pool_mode' },
    { label: 'PgBouncer pooling-mode feature map', url: 'https://www.pgbouncer.org/features.html' },
    { label: 'PgBouncer 1.25.2 transaction-block rejection', url: 'https://github.com/pgbouncer/pgbouncer/blob/pgbouncer_1_25_2/src/server.c#L396' },
  ],
} as const

declare const registeredClaimValueBrand: unique symbol

/** A claim-bearing primitive that cannot be replaced by an unowned literal. */
export type RegisteredClaimValue<Path extends string, Value> = Value & {
  readonly [registeredClaimValueBrand]: Path
}

function registeredClaimValue<const Path extends string, Value>(
  _path: Path,
  value: Value,
): RegisteredClaimValue<Path, Value> {
  return value as RegisteredClaimValue<Path, Value>
}

export function ordinaryConnectionCapacity(
  maxConnections: number,
  superuserReservedConnections: number,
  reservedConnections: number,
): number {
  return Math.max(
    0,
    maxConnections - superuserReservedConnections - reservedConnections,
  )
}

const VACUUM_TRUNCATION_LOCK = {
  mode: 'ACCESS EXCLUSIVE',
  attempt: 'non-blocking',
  consequence: 'If the lock cannot be acquired immediately, vacuum gives up on truncation rather than waiting, and the space is not returned to the filesystem this time.',
} as const

const POSTGRESQL_VERSION = {
  major: POSTGRESQL_MAJOR,
  referenceMinor: POSTGRESQL_REFERENCE_MINOR,
  majorLabel: `PostgreSQL ${POSTGRESQL_MAJOR}`,
  referenceLabel: `PostgreSQL ${POSTGRESQL_MAJOR}.${POSTGRESQL_REFERENCE_MINOR}`,
  manualBase: `https://www.postgresql.org/docs/${POSTGRESQL_MAJOR}/`,
  sourceBranch: `REL_${POSTGRESQL_MAJOR}_STABLE`,
} as const

const POSTGRESQL_VERSION_CLAIM_SURFACES = [
  { source: 'src/ui/panel.ts', correctionPaths: 1, label: 'City inspector and component docs' },
  { source: 'src/ui/controls.ts', correctionPaths: 1, label: 'City control console' },
  { source: 'src/ui/anatomy.ts', correctionPaths: 1, label: 'City physical anatomy' },
  { source: 'src/ui/hud.ts', correctionPaths: 2, label: 'City latency and operator verdict panels' },
  { source: 'src/ui/tour.ts', correctionPaths: 2, label: 'City tour chapters and scenario beats' },
  { source: 'src/ui/control-center.ts', correctionPaths: 1, label: 'City control center' },
  { source: 'src/ui/help.ts', correctionPaths: 1, label: 'City help and reading guide' },
  { source: 'src/ui/city-words.ts', correctionPaths: 1, label: 'City in words' },
  { source: 'src/main.ts', correctionPaths: 1, label: 'City viewport and world claims' },
  { source: 'src/observability/main.ts', correctionPaths: 1, label: 'Diagnose and Query flow cards' },
  { source: 'machine/magnum.js', correctionPaths: 4, label: 'Machine workbench, boards, and lessons' },
] as const

const WAL_SEGMENT_POSTGRESQL_DISCLOSURE = [
  'PostgreSQL default: 16 MiB',
  'Selected at initdb with --wal-segsize',
  'Changing it requires reinitialising the cluster',
  'pg_settings shows wal_segment_size',
  'WAL filenames and pg_walfile_name arithmetic use that configured size',
] as const

const WAL_SEGMENT_QUALIFIED_PROSE_SURFACES = [
  'src/world/wal.ts WAL-vault role',
  'src/world/continuity.ts archive-silo plate',
  'src/ui/docs-storage.ts WAL-vault summary',
] as const

export const CLAIM_VALUES = {
  appVersion: {
    label: BUILD_LABEL,
  },
  walSegment: {
    bytes: registeredClaimValue('walSegment.bytes', 16 * MIB),
    label: '16 MiB',
    modelDisclosure: 'PGSimCity models 16 MiB WAL segments',
    postgresqlDisclosure: WAL_SEGMENT_POSTGRESQL_DISCLOSURE,
    qualifiedProseSurfaces: WAL_SEGMENT_QUALIFIED_PROSE_SURFACES,
  },
  bufferSample: {
    gridWidth: registeredClaimValue('bufferSample.gridWidth', 32),
    capacityFrames: registeredClaimValue('bufferSample.capacityFrames', 32 * 32),
    defaultActiveFrames: registeredClaimValue('bufferSample.defaultActiveFrames', 256),
  },
  bulkReadRing: {
    modelFrames: registeredClaimValue('bulkReadRing.modelFrames', 32),
    disclosure: 'fixed 32-frame ring',
    diagnoseDisclosure: 'fixed 32-frame approximation',
  },
  checkpointPolicy: {
    defaultTimeoutSeconds: 60,
    defaultMaxWalSizeMiB: 256,
    partners: ['maxWalSize', 'checkpointTimeout'],
  },
  standbyNames: {
    internal: ['standbyA', 'standbyB'],
    display: ['standby_a', 'standby_b'],
  },
  physicalReplicationLink: {
    bytesPerSec: registeredClaimValue('physicalReplicationLink.bytesPerSec', 24 * MIB),
    label: '24 MiB/s',
    disclosure: 'PGSimCity gives each physical standby link a fixed 24 MiB/s teaching capacity for the ordinary sequential WAL byte stream, including segment-switch padding. This scaled constant is not a production estimate, measurement, or benchmark.',
  },
  modelDuration: {
    shortUnit: 'model s',
    millisecondUnit: MODEL_MILLISECOND_UNIT,
    prose: 'model time',
  },
  modelLatency: {
    unit: MODEL_MILLISECOND_UNIT,
    quantiles: ['p50', 'p99'],
    windowTrips: registeredClaimValue('modelLatency.windowTrips', 512),
    disclosure: 'weighted rolling window of 512 completed backend trips',
    componentDisclosure: 'each modeled component is its own weighted quantile',
    taxonomyDisclosure: 'Pool-slot wait is a client-side PgBouncer queue estimate (transaction/statement hand-off or initial session assignment) and is not visible in pg_stat_activity; buffer-read phase is the synthetic exec_io phase, not accumulated DataFileRead events; dirty-victim I/O is trip attribution rather than a distinct live activity state; temp-file I/O is attributed inside the fixed sort/hash-aggregate teaching phase rather than projected as live PostgreSQL wait events; commit durability is an umbrella for WalSync or SyncRep; relation lock maps directly to Lock/relation; active / unclassified is a non-wait residual containing CPU, parse, result-send and unclassified WAL-buffer stalls, which PostgreSQL reports separately as waits such as LWLock/WALWrite',
    batchDisclosure: 'transactions carried by one backend trip share one latency observation, so within-batch variance is not modeled',
    resolutionDisclosure: '30 Hz integration quantizes observations to 33.33 model ms steps',
  },
  pgBouncerPoolModes: PGBOUNCER_POOL_MODE_CLAIM,
  connectionPooler: {
    pgBouncerDefaults: {
      poolMode: 'session',
      defaultPoolSize: 20,
      maxClientConn: 100,
      queryWaitTimeoutSeconds: 120,
    },
    modelDefaultPoolSize: 8,
    concurrencyTarget: registeredClaimValue('connectionPooler.concurrencyTarget', 8),
    modelConnectionReservations: MODEL_CONNECTION_RESERVATIONS,
    poolModeTradeoff: `Session pooling keeps one server connection for the client session and preserves PostgreSQL features, but it cannot multiplex idle client sessions. Transaction pooling releases the server connection after each transaction. It cannot preserve arbitrary session state across transactions: SET/RESET and session-level advisory locks cannot span them; SQL PREPARE is incompatible and protocol-level named prepared statements need PgBouncer max_prepared_statements tracking; LISTEN subscriptions do not work, although NOTIFY can still be sent. Statement pooling releases the server after every statement; PgBouncer's configuration describes that boundary as query finish. PgBouncer documents it as transaction pooling with a stricter twist, so the transaction-mode restrictions still apply and no session state can be relied on across queries. It enforces autocommit by disallowing transactions that span statements. In ${PGBOUNCER_POOL_MODE_CLAIM.statementTransactionError.verifiedAgainst}, BEGIN receives ${PGBOUNCER_POOL_MODE_CLAIM.statementTransactionError.severity} SQLSTATE ${PGBOUNCER_POOL_MODE_CLAIM.statementTransactionError.sqlstate}, “${PGBOUNCER_POOL_MODE_CLAIM.statementTransactionError.message}”, and PgBouncer closes the client connection.`,
    absent: [
      'multi-statement workload generation beyond rejecting the two modeled open-transaction controls',
      'production session-lifetime distribution and reconnect backoff',
      'session variables and SET/RESET effects',
      'advisory-lock ownership across transactions',
      'prepared-statement tracking',
      'LISTEN registrations and NOTIFY delivery',
      'per-user and per-database pools, reserve pools and pool queues',
      'PgBouncer authentication, TLS, DNS, cancellation forwarding and admin console',
      'pgcat and Odyssey runtime behavior',
    ],
    coverageDisclosure: 'PGSimCity models one PgBouncer-shaped user/database pool: client admission, persistent PostgreSQL server connections, transaction- and statement-mode queue age, query_wait_timeout disconnects, statement-mode rejection of the city’s two open-transaction controls, and session clients bound for a fixed fifteen-model-second connection lifetime. Each ordinary pooled backend visit represents a batch of one or more single-statement transactions, sized from the offered rate; the model realizes every constituent transaction boundary and statement boundary together at the end of that visit. Transaction and statement modes therefore have the same queue timing in this workload, while statement mode still rejects the city’s two open-transaction controls; the model does not fabricate a timing difference between them. The tps control is aggregate work assigned to the admitted cohort, so changing refused socket count alone does not rescale it; session mode admits only the bound sessions’ share. The connection-storm scenario’s uncalibrated pressure curve follows active PostgreSQL backends only. Production session-lifetime distributions, client identities, reconnect backoff and all session-level SQL state are absent; queue time is a modelled client-side estimate, not a PgBouncer timing sample.',
    plateLabel: 'PgBouncer · pool_mode',
  },
  workMem: {
    defaultMiB: 4,
    hashMemMultiplier: 2,
    hashMemMultiplierDefaultSince: 15,
    spillExample: {
      lowMiB: 2,
      highMiB: 4,
      partialHashWorkingSetMiB: 6,
      aggregateSortWorkingSetMiB: 3,
      finalizeHashWorkingSetMiB: 1,
    },
    spillSlowdown: 10,
    nodeDisclosure: 'work_mem is a per-node allowance, not a per-query or per-connection cap; eligible nodes and concurrent backends multiply it',
    coverageDisclosure: 'The city models fixed Sort and HashAggregate nodes only. It has no join nodes, hash-join spill, parallel workers, cost-based plan selection, or planner response to work_mem.',
  },
  restoreDrill: {
    levels: {
      table: {
        label: 'One-table smoke',
        rank: 1,
        cadence: 'nightly example',
        supports: 'The modeled full-cluster backup fetch and archived-WAL replay encountered a transaction-end record whose timestamp crossed the selected recovery target, and the accounts smoke check found its expected row witness.',
        limits: 'It does not test the other tables, compare restored bytes with the manifest, prove every row or business invariant is correct, exercise failover, promotion, or service cutover, or measure production hardware.',
      },
      cluster: {
        label: 'Full-cluster smoke',
        rank: 2,
        cadence: 'monthly example',
        supports: 'The modeled full-cluster backup fetch and archived-WAL replay encountered a transaction-end record whose timestamp crossed the selected recovery target, and every modeled table returned its expected smoke-check row witness.',
        limits: 'It does not compare restored bytes with the manifest, prove every row or business invariant is correct, exercise failover, promotion, or service cutover, or measure production hardware.',
      },
      verified: {
        label: 'Checksums + smoke',
        rank: 3,
        cadence: 'quarterly example',
        supports: 'The modeled full-cluster backup fetch and archived-WAL replay encountered a transaction-end record whose timestamp crossed the selected recovery target, the restored-object digest matched its manifest, and every modeled table returned its expected smoke-check row witness.',
        limits: 'It does not prove every row or business invariant is correct, exercise failover, promotion, or service cutover, or measure production hardware.',
      },
    },
    physicalScopeDisclosure: 'All three levels fetch and replay the full WAL-G physical backup. A physical backup cannot restore one table selectively in place into a running cluster. Restore the cluster to a scratch host, then extract the table logically with pg_dump -t, COPY, postgres_fdw, or logical replication and load it into production; this does not require a pre-existing logical archive. A periodic logical dump is not a PITR substitute and restores only to its snapshot instant. pg_restore -t does not restore dependent objects automatically, so restoring into a clean database may require those objects separately.',
    checksumDisclosure: 'The checksum phase compares a deterministic modeled restored-object digest with its manifest; it does not hash real files. pg_verifybackup checks restored backup files against backup_manifest, pgBackRest verify checks repository backup integrity, and pg_checksums or pg_amcheck can inspect a restored host with different scopes. WAL-G backup-push --verify checks page checksums while taking the backup, not after restore.',
    smokeDisclosure: 'The smoke phase checks one modeled expected row witness with a targeted three-block read per selected table; it does not execute PostgreSQL, scan the relation, or reconstruct every row.',
    timeDisclosure: 'Restore-to-target time is model time at fixed teaching rates, not production RTO. Its clock starts before WAL-G backup-fetch, then includes archived-WAL fetch and replay until recovery encounters a transaction-end record whose timestamp crosses the selected target. It excludes promotion, recovery_target_action, endpoint cutover, client reconnection, and service restoration.',
    cadenceDisclosure: 'Nightly, monthly, and quarterly are comparison examples, not recommendations. The operator must choose, fund, record, and review the cadence against the required recovery objectives.',
  },
  timelineRecovery: {
    modeledForkDepth: 1,
    defaultTarget: 'latest',
    historyFile: '00000002.history',
    plate: 'one-fork model · pre-fork backup stays usable · fork-segment copy carries parent tail',
    crossingDisclosure: 'recovery_target_timeline=latest means the latest timeline found in the archive. From a timeline-1 backup, an archived 00000002.history makes timeline 2 discoverable; if that file is absent, timeline 1 remains latest and its archived divergent tail can still contain the target. When recovery does follow timeline 2, WAL unique to timeline 1 after the fork is not part of that history.',
    defaultDisclosure: 'PostgreSQL 18 defaults recovery_target_timeline to latest; latest has been the default since PostgreSQL 12. PostgreSQL 11 and older defaulted to current. With current, PostgreSQL stays on the timeline current when the base backup was taken and replays that timeline’s archived WAL: if it encounters a transaction-end record whose timestamp crosses the target, recovery succeeds; otherwise it reports that the target was not reached after replaying as far as the archive goes.',
    absent: ['backup manifests with more than two WAL ranges', 'numeric timeline targets', 'multiple-fork trees', 'timeline-history parsing', 'restore-side credentials and object GET failures', 'wider recovery_target_* interactions'],
    coverageDisclosure: 'PGSimCity models one fork only: timeline 1 to timeline 2, including a standby backup manifest with one WAL range on each side of that fork. Backup manifests with more than two WAL ranges, numeric timeline targets, multiple-fork trees, timeline-history parsing, restore-side credentials or object GET failures, and the wider interactions among recovery_target_* settings are absent.',
  },
  vacuumReclaim: {
    plateLines: [
      'space stays unless the tail is empty',
      'ACCESS EXCLUSIVE · non-blocking · no lock, no shrink',
    ],
    truncationLock: VACUUM_TRUNCATION_LOCK,
    rule: `Vacuum reuses space inside the table. It only shortens the file if the very last pages are entirely empty. To truncate that tail, vacuum briefly tries to acquire ${VACUUM_TRUNCATION_LOCK.mode} in a ${VACUUM_TRUNCATION_LOCK.attempt} lock attempt. ${VACUUM_TRUNCATION_LOCK.consequence}`,
  },
  mvccVocabulary: MVCC_VOCABULARY,
  cityComponentRoute: {
    hashPrefix: '#/c/',
  },
  cityArchitecture: CITY_ARCHITECTURE_CLAIMS,
  componentNaming: {
    panelTitleOwner: 'registry.name',
  },
  eventConvention: {
    emitterMethod: 'emit',
    handlerMethods: ['on', 'once'],
    browserPrefix: 'pgsimcity:',
  },
  diagnoseBranchGates: {
    connectionSpareSlots: {
      threshold: 1,
      source: 'activity.rows',
      branches: ['slow.1→v.saturation'],
    },
    lockWaitShare: {
      threshold: 0.25,
      source: 'activity.rows',
      branches: ['slow.1→lock.1'],
    },
    ioWaitShare: {
      threshold: 0.3,
      source: 'activity.rows',
      branches: ['slow.1→io.1'],
    },
    commitWaitShare: {
      threshold: 0.25,
      source: 'activity.rows',
      branches: ['slow.1→commit.1'],
    },
    walSyncWaitFloor: {
      threshold: 1,
      source: 'activity.rows',
      branches: ['commit.1→v.sync_local', 'commit.1→v.commit_ok'],
    },
    activeWorkFloor: {
      threshold: 3,
      source: 'activity.rows',
      branches: ['slow.1→v.idle'],
    },
    requestedCheckpointShare: {
      threshold: 0.2,
      source: 'checkpointer.counters',
      branches: ['stall.1→stall.2', 'stall.1→v.ckpt_ok'],
    },
    slotRetainedBytes: {
      threshold: 16 * MIB,
      source: 'slots.rows',
      branches: ['disk.1→v.slot_retention', 'disk.1→v.no_slot_retention'],
    },
    deadTupleRatio: {
      threshold: 0.02,
      source: 'tables.rows',
      branches: ['bloat.1→bloat.2', 'bloat.1→bloat.autovacuum', 'bloat.1→v.no_bloat'],
    },
    clientBackendWriteShare: {
      threshold: 0.2,
      source: 'io.rows',
      branches: ['io.1→v.backend_writes', 'io.1→v.io_ok'],
    },
    cacheHitPercent: {
      threshold: 92,
      source: 'io.rows',
      branches: ['io.1→io.2', 'io.1→v.io_ok'],
    },
    coldBufferShare: {
      threshold: 0.55,
      source: 'buffercache.rows',
      branches: ['io.2→v.small_pool', 'io.2→v.io_ok'],
    },
    replayStageGapBytes: {
      threshold: 256 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→replica.replay-state', 'replica.1→v.rep_ok'],
    },
    senderStageGapBytes: {
      threshold: 512 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→v.network'],
    },
    currentPositionGapBytes: {
      threshold: 512 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→v.rep_ok'],
    },
    healthyReplaySeconds: {
      threshold: 2,
      source: 'replication.standbys',
      branches: [],
    },
    resolvedSenderGapBytes: {
      threshold: 256 * KIB,
      source: 'replication.standbys',
      branches: [],
    },
  },
  postgresqlVersion: POSTGRESQL_VERSION,
  pgliteVersion: PGLITE_VERSION,
  markdownRendering: {
    owner: 'mdToHtml',
  },
  reviewStatus: {
    rounds: 4,
    summary: 'Four review rounds',
    bootLabel: 'Early, reviewed prototype.',
  },
} as const

export type ClaimDisclosureSurface =
  | {
    kind: 'markdown-blockquote'
    file: 'README.md'
    anchor: string
  }
  | {
    kind: 'diagnose-verdict'
    id: string
    field: 'because' | 'mechanism' | 'fix'
  }
  | {
    kind: 'inspector-section'
    doc: string
    section: string
  }
  | {
    kind: 'inspector-visible'
    doc: string
    marker: string
  }
  | {
    kind: 'hud-visible'
    marker: string
  }
  | {
    kind: 'tour-chapter'
    id: string
  }

type DisclosureFields<Value extends Record<string, unknown>> = {
  [Field in keyof Value as Value[Field] extends string ? Field : never]?:
    readonly ClaimDisclosureSurface[]
}

function registeredDisclosures<
  const Value extends Record<string, unknown>,
  const Fields extends DisclosureFields<Value>,
>(_value: Value, fields: Fields): Fields {
  return fields
}

export function claimDisclosureSurfaceLabel(surface: ClaimDisclosureSurface): string {
  if (surface.kind === 'markdown-blockquote') {
    return `${surface.file}:blockquote containing ${surface.anchor}`
  }
  if (surface.kind === 'diagnose-verdict') {
    return `Diagnose:${surface.id}.${surface.field}`
  }
  if (surface.kind === 'inspector-section') {
    return `inspector:${surface.doc}/${surface.section}`
  }
  if (surface.kind === 'inspector-visible') {
    return `inspector:${surface.doc}/[data-disclosure=${surface.marker}]`
  }
  if (surface.kind === 'hud-visible') {
    return `HUD:[data-disclosure=${surface.marker}]`
  }
  return `tour:${surface.id}`
}

export const CLAIMS = {
  appVersion: {
    owner: 'src/core/build.ts#BUILD_LABEL',
    value: CLAIM_VALUES.appVersion,
    surfaces: ['help:build marker', 'Diagnose:build marker', 'corrections:issue body'],
  },
  walSegment: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.walSegment',
    value: CLAIM_VALUES.walSegment,
    surfaces: [
      'model:wal.segmentSize',
      'world:wal.vault plate',
      ...CLAIM_VALUES.walSegment.qualifiedProseSurfaces,
    ],
  },
  bufferSample: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.bufferSample',
    value: CLAIM_VALUES.bufferSample,
    surfaces: ['model:default active frames', 'world:shared_buffers plate', 'prose:sample disclosure'],
  },
  bulkReadRing: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.bulkReadRing',
    value: CLAIM_VALUES.bulkReadRing,
    surfaces: ['model:bulk-read ring', 'README:bulk-read disclosure', 'Diagnose:cache verdict'],
    disclosures: registeredDisclosures(CLAIM_VALUES.bulkReadRing, {
      disclosure: [
        {
          kind: 'markdown-blockquote',
          file: 'README.md',
          anchor: "PostgreSQL 18's bulk-read strategy",
        },
      ],
    }),
  },
  checkpointPolicy: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.checkpointPolicy',
    value: CLAIM_VALUES.checkpointPolicy,
    surfaces: ['model:knob defaults', 'controls:checkpoint dials', 'Diagnose:checkpoint controls'],
  },
  standbyNames: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.standbyNames',
    value: CLAIM_VALUES.standbyNames,
    surfaces: ['model:physical standbys', 'controls:synchronous standby choices', 'Diagnose:replication rows'],
  },
  physicalReplicationLink: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.physicalReplicationLink',
    value: CLAIM_VALUES.physicalReplicationLink,
    surfaces: ['model:physical walsender transport', 'prose:replication link scope'],
    disclosures: registeredDisclosures(CLAIM_VALUES.physicalReplicationLink, {
      disclosure: [
        { kind: 'inspector-section', doc: 'net.wire', section: 'What the city models' },
      ],
    }),
  },
  modelDuration: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.modelDuration',
    value: CLAIM_VALUES.modelDuration,
    surfaces: ['shared:trace duration formatter', 'Query flow:duration readout', 'Diagnose:lock duration'],
  },
  modelLatency: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.modelLatency',
    value: CLAIM_VALUES.modelLatency,
    surfaces: ['model:latency quantiles', 'HUD:latency vital', 'prose:latency observability'],
    disclosures: registeredDisclosures(CLAIM_VALUES.modelLatency, {
      disclosure: [
        { kind: 'inspector-section', doc: 'checkpointer', section: 'What the city measures' },
      ],
      taxonomyDisclosure: [
        { kind: 'inspector-section', doc: 'bgwriter', section: 'What the city measures' },
        { kind: 'hud-visible', marker: 'work-mem-latency-scope' },
      ],
    }),
  },
  pgBouncerPoolModes: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.pgBouncerPoolModes',
    value: CLAIM_VALUES.pgBouncerPoolModes,
    surfaces: ['contracts:PoolMode', 'controls:pool_mode choices', 'Diagnose:pool_mode choices', 'model:release boundary and transaction-block rejection', 'inspector:pooling-mode behavior'],
  },
  connectionPooler: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.connectionPooler',
    value: CLAIM_VALUES.connectionPooler,
    surfaces: ['model:pooler admission and concurrency cap', 'controls:PgBouncer settings', 'world:PgBouncer gate', 'scenario:connection storm', 'Diagnose:connection saturation verdict', 'prose:pooling tradeoff and absences', 'HUD:pool-slot latency'],
    disclosures: registeredDisclosures(CLAIM_VALUES.connectionPooler, {
      coverageDisclosure: [
        { kind: 'diagnose-verdict', id: 'v.saturation', field: 'mechanism' },
        { kind: 'inspector-section', doc: 'client.pool', section: 'What the city models' },
        { kind: 'inspector-section', doc: 'client.pooler', section: 'What the city leaves absent' },
        { kind: 'inspector-visible', doc: 'client.pool', marker: 'connection-pooler-model-scope' },
        { kind: 'inspector-visible', doc: 'client.pooler', marker: 'connection-pooler-model-scope' },
        { kind: 'inspector-visible', doc: 'client.pooler', marker: 'pool-mode-cost' },
      ],
    }),
  },
  workMem: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.workMem',
    value: CLAIM_VALUES.workMem,
    surfaces: ['model:Sort and HashAggregate spill', 'controls:work_mem dial', 'world:private memory and temp files', 'prose:work_mem limits'],
    disclosures: registeredDisclosures(CLAIM_VALUES.workMem, {
      coverageDisclosure: [
        { kind: 'inspector-section', doc: 'backend.localmem', section: 'What the city models' },
        { kind: 'inspector-section', doc: 'planner.executor', section: 'What the city models' },
        { kind: 'inspector-section', doc: 'planner.plantree', section: 'What the city shows' },
        { kind: 'inspector-visible', doc: 'backend.localmem', marker: 'work-mem-model-scope' },
        { kind: 'tour-chapter', id: 'backend' },
      ],
    }),
  },
  restoreDrill: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.restoreDrill',
    value: CLAIM_VALUES.restoreDrill,
    surfaces: ['model:restore-drill evidence rank', 'inspector:restore-drill evidence', 'prose:restore-drill limits'],
    disclosures: registeredDisclosures(CLAIM_VALUES.restoreDrill, {
      physicalScopeDisclosure: [
        { kind: 'inspector-section', doc: 'recovery.ground', section: 'Cost and cadence are policy' },
        { kind: 'inspector-visible', doc: 'recovery.ground', marker: 'restore-drill-physical-scope' },
      ],
      checksumDisclosure: [
        { kind: 'inspector-section', doc: 'recovery.ground', section: 'Checksum names matter' },
      ],
      smokeDisclosure: [
        { kind: 'inspector-section', doc: 'recovery.ground', section: 'Checksum names matter' },
        { kind: 'inspector-visible', doc: 'recovery.ground', marker: 'restore-drill-smoke' },
      ],
      timeDisclosure: [
        { kind: 'inspector-visible', doc: 'recovery.ground', marker: 'restore-drill-time' },
      ],
      cadenceDisclosure: [
        { kind: 'inspector-section', doc: 'recovery.ground', section: 'Cost and cadence are policy' },
        { kind: 'inspector-visible', doc: 'recovery.ground', marker: 'restore-drill-cadence' },
      ],
    }),
  },
  timelineRecovery: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.timelineRecovery',
    value: CLAIM_VALUES.timelineRecovery,
    surfaces: ['model:timeline-aware archive and restore', 'controls:recovery_target_timeline', 'world:timeline switchyard plate', 'prose:timeline recovery scope'],
    disclosures: registeredDisclosures(CLAIM_VALUES.timelineRecovery, {
      coverageDisclosure: [
        { kind: 'inspector-section', doc: 'timeline.yard', section: 'Restore follows history; it never merges it' },
        { kind: 'inspector-section', doc: 'recovery.ground', section: 'Crossing the one modeled fork' },
        { kind: 'inspector-section', doc: 'recovery.clock', section: 'Choosing the history' },
        { kind: 'inspector-visible', doc: 'timeline.yard', marker: 'one-fork-timeline-recovery-visible-scope' },
        { kind: 'inspector-visible', doc: 'recovery.ground', marker: 'one-fork-timeline-recovery-visible-scope' },
        { kind: 'inspector-visible', doc: 'recovery.clock', marker: 'one-fork-timeline-recovery-visible-scope' },
        { kind: 'inspector-visible', doc: 'recovery.clock', marker: 'recovery-target-timeline-scope' },
      ],
    }),
  },
  vacuumReclaim: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.vacuumReclaim',
    value: CLAIM_VALUES.vacuumReclaim,
    surfaces: ['model:vacuum truncate phase', 'world:landfill plate', 'tour:vacuum chapter', 'prose:vacuum docs'],
  },
  mvccVocabulary: {
    owner: 'src/spine/mvcc-vocabulary.ts#MVCC_VOCABULARY',
    value: CLAIM_VALUES.mvccVocabulary,
    surfaces: ['world/anatomy:labels and tooltips', 'docs/Diagnose/scenarios:explanatory prose'],
  },
  cityComponentRoute: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.cityComponentRoute',
    value: CLAIM_VALUES.cityComponentRoute,
    surfaces: ['Diagnose:city links', 'tour:component targets', 'scenario:focus targets', 'city:component registry'],
  },
  cityArchitecture: {
    owner: 'src/spine/city-architecture.ts#CITY_ARCHITECTURE_CLAIMS',
    value: CLAIM_VALUES.cityArchitecture,
    surfaces: ['layout:district bounds, anchors and routes', 'city:City in words', 'ACCESSIBILITY:text-first route'],
  },
  componentNaming: {
    owner: 'src/core/registry.ts#ComponentDef.name',
    value: CLAIM_VALUES.componentNaming,
    surfaces: ['city:component registry names', 'inspector:panel headings'],
  },
  eventConvention: {
    owner: 'src/core/types.ts#BusEvents',
    value: CLAIM_VALUES.eventConvention,
    surfaces: ['source:event emitters', 'source:event handlers', 'browser:CustomEvent bridge'],
  },
  diagnoseBranchGates: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.diagnoseBranchGates',
    value: CLAIM_VALUES.diagnoseBranchGates,
    surfaces: ['Diagnose:result-grid warning ranges', 'Diagnose:path branch predicates', 'Diagnose:verdict resolution'],
  },
  postgresqlVersion: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.postgresqlVersion',
    value: CLAIM_VALUES.postgresqlVersion,
    surfaces: ['README:target declaration', 'city:visible teaching target', 'Machine:model teaching target', 'Diagnose:visible teaching target and catalog prose', 'tour:version-specific claims', 'docs:manual and source links'],
    claimSurfaces: POSTGRESQL_VERSION_CLAIM_SURFACES,
  },
  pgliteVersion: {
    owner: 'src/spine/pglite-version.ts#PGLITE_VERSION',
    value: CLAIM_VALUES.pgliteVersion,
    surfaces: ['dependency:package-lock', 'PGlite:SELECT version()', 'Machine:separate engine provenance'],
  },
  markdownRendering: {
    owner: 'src/ui/content.ts#mdToHtml',
    value: CLAIM_VALUES.markdownRendering,
    surfaces: ['inspector:document body', 'tour:chapter body'],
  },
  reviewStatus: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.reviewStatus',
    value: CLAIM_VALUES.reviewStatus,
    surfaces: ['README:trust statement', 'index:boot honesty'],
  },
  machineSynchronousCommitComparison: {
    owner: 'src/spine/machine-comparison.ts#MACHINE_SYNCHRONOUS_COMMIT_COMPARISON',
    value: MACHINE_SYNCHRONOUS_COMMIT_COMPARISON,
    surfaces: [
      'model:off bypasses commit_wait',
      'Machine:comparison experiment',
      'Machine:comparison finding and P/M disclosure',
    ],
  },
  machineIndexWalk: {
    owner: 'src/spine/machine-index-walk.ts#MACHINE_INDEX_WALK',
    value: MACHINE_INDEX_WALK,
    surfaces: [
      'Machine:index walk sequence',
      'Machine:index walk measured finding',
      'Machine:index walk P/M disclosures',
    ],
  },
  postgresqlOracle: {
    owner: 'src/core/claims.ts#CLAIMS.postgresqlOracle',
    value: {
      oracleSources: [
        {
          role: 'claims',
          owner: 'src/spine/postgresql-oracle.ts#POSTGRESQL_ORACLE_CLAIMS',
        },
        {
          role: 'catalog',
          owner: 'src/observability/catalog.ts#CATALOG',
        },
        {
          role: 'indexWalk',
          owner: 'src/spine/machine-index-walk.ts#MACHINE_INDEX_WALK',
        },
        {
          role: 'diagnosticSql',
          owner: 'src/observability/paths.ts#DIAGNOSTIC_SQL',
        },
        {
          role: 'actions',
          owner: 'src/core/actions.ts#ACTIONS',
        },
        {
          role: 'walSegment',
          owner: 'src/core/claims.ts#CLAIM_VALUES.walSegment',
        },
        {
          role: 'modelLatency',
          owner: 'src/core/claims.ts#CLAIM_VALUES.modelLatency',
        },
        {
          role: 'connectionPooler',
          owner: 'src/core/claims.ts#CLAIM_VALUES.connectionPooler',
        },
        {
          role: 'workMem',
          owner: 'src/core/claims.ts#CLAIM_VALUES.workMem',
        },
        {
          role: 'restoreDrill',
          owner: 'src/core/claims.ts#CLAIM_VALUES.restoreDrill',
        },
        {
          role: 'timelineRecovery',
          owner: 'src/core/claims.ts#CLAIM_VALUES.timelineRecovery',
        },
        {
          role: 'vacuumReclaim',
          owner: 'src/core/claims.ts#CLAIM_VALUES.vacuumReclaim',
        },
        {
          role: 'mvccVocabulary',
          owner: 'src/spine/mvcc-vocabulary.ts#MVCC_VOCABULARY',
        },
        {
          role: 'machineSynchronousCommitComparison',
          owner: 'src/spine/machine-comparison.ts#MACHINE_SYNCHRONOUS_COMMIT_COMPARISON',
        },
        {
          role: 'machineIndexWalk',
          owner: 'src/spine/machine-index-walk.ts#MACHINE_INDEX_WALK',
        },
      ],
    },
    surfaces: ['registry:mechanically checkable PostgreSQL facts', 'tool:throwaway PostgreSQL oracle'],
  },
} as const

export type ClaimId = keyof typeof CLAIMS
