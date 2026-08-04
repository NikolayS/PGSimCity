import { CLAIM_VALUES } from '../core/claims'
import { DEFAULT_KNOBS } from '../core/types'

export const POSTGRESQL_WAIT_EVENTS = {
  walSync: { type: 'IO', name: 'WalSync' },
  syncRep: { type: 'IPC', name: 'SyncRep' },
  relation: { type: 'Lock', name: 'relation' },
  vacuumDelay: { type: 'Timeout', name: 'VacuumDelay' },
  dataFileRead: { type: 'IO', name: 'DataFileRead' },
  dataFileWrite: { type: 'IO', name: 'DataFileWrite' },
} as const

const expected = (
  value: string | number,
  unit: string,
  compare: 'text' | 'number' | 'bytes' | 'duration',
  display = `${value}${unit}`,
) => ({ value, unit, compare, display })

export type PostgreSqlGucContext = 'postmaster' | 'sighup' | 'user' | 'superuser'

interface GucContextExpectation {
  context: PostgreSqlGucContext
  from?: number
  to?: number
}

interface GucContextClaim {
  setting: string
  cityClaim: string
  expected: GucContextExpectation | readonly GucContextExpectation[]
}

const stableContext = (context: PostgreSqlGucContext): GucContextExpectation => ({ context })
const stableContextClaim = 'Same context on PostgreSQL 13, 17, and 18'

/*
 * This is the complete pg_settings.context surface stated or operationally
 * implied by the city. Version changes belong in data so the live oracle sees
 * them on both sides of the boundary.
 */
export const POSTGRESQL_GUC_CONTEXTS = [
  { setting: 'shared_buffers', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'wal_buffers', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'max_connections', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'max_locks_per_transaction', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'max_prepared_transactions', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'max_wal_senders', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'max_replication_slots', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'checkpoint_timeout', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'checkpoint_completion_target', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'max_wal_size', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'bgwriter_lru_maxpages', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'bgwriter_delay', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'synchronous_commit', cityClaim: stableContextClaim, expected: stableContext('user') },
  { setting: 'synchronous_standby_names', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'wal_level', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'full_page_writes', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'autovacuum', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  { setting: 'autovacuum_vacuum_scale_factor', cityClaim: stableContextClaim, expected: stableContext('sighup') },
  {
    setting: 'autovacuum_max_workers',
    cityClaim: 'PostgreSQL 17 and earlier: postmaster; PostgreSQL 18 and later: sighup',
    expected: [
      { from: 13, to: 17, context: 'postmaster' },
      { from: 18, context: 'sighup' },
    ],
  },
  { setting: 'track_io_timing', cityClaim: stableContextClaim, expected: stableContext('superuser') },
  { setting: 'logging_collector', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
  { setting: 'shared_preload_libraries', cityClaim: stableContextClaim, expected: stableContext('postmaster') },
] as const satisfies readonly GucContextClaim[]

export function postgresGucContext(
  setting: (typeof POSTGRESQL_GUC_CONTEXTS)[number]['setting'],
  major = CLAIM_VALUES.postgresqlVersion.major,
): PostgreSqlGucContext {
  const claim = POSTGRESQL_GUC_CONTEXTS.find((candidate) => candidate.setting === setting)
  if (!claim) throw new Error(`No registered pg_settings.context claim for ${setting}`)
  const variants = (Array.isArray(claim.expected)
    ? claim.expected
    : [claim.expected]) as readonly GucContextExpectation[]
  const match = variants.find((candidate) =>
    (candidate.from === undefined || major >= candidate.from)
    && (candidate.to === undefined || major <= candidate.to))
  if (!match) throw new Error(`No pg_settings.context claim for ${setting} on PostgreSQL ${major}`)
  return match.context
}

/*
 * Mechanically checkable PostgreSQL facts are data here, not branches in the
 * harness. Some entries describe stock defaults stated in prose; the explicit
 * city-model entries preserve intentional teaching-scale divergences.
 */
export const POSTGRESQL_ORACLE_CLAIMS = {
  gucContexts: POSTGRESQL_GUC_CONTEXTS,
  gucDefaults: [
    {
      id: 'postgres-default/recovery_target_timeline',
      setting: 'recovery_target_timeline',
      cityClaim: 'PostgreSQL default',
      expected: expected(CLAIM_VALUES.timelineRecovery.defaultTarget, '', 'text'),
    },
    {
      id: 'postgres-default/hash_mem_multiplier',
      setting: 'hash_mem_multiplier',
      cityClaim: 'PostgreSQL default; 2.0 since PostgreSQL 15',
      expected: [
        { from: 13, to: 14, ...expected(1, '', 'number') },
        { from: 15, ...expected(CLAIM_VALUES.workMem.hashMemMultiplier, '', 'number') },
      ],
    },
    {
      id: 'postgres-default/work_mem',
      setting: 'work_mem',
      cityClaim: 'PostgreSQL default',
      expected: expected(CLAIM_VALUES.workMem.defaultMiB, 'MB', 'bytes'),
    },
    {
      id: 'postgres-default/wal_level',
      setting: 'wal_level',
      cityClaim: 'PostgreSQL default',
      expected: expected(DEFAULT_KNOBS.walLevel, '', 'text'),
    },
    {
      id: 'postgres-default/synchronous_commit',
      setting: 'synchronous_commit',
      cityClaim: 'PostgreSQL default',
      expected: expected(DEFAULT_KNOBS.synchronousCommit, '', 'text'),
    },
    {
      id: 'postgres-default/join_collapse_limit',
      setting: 'join_collapse_limit',
      cityClaim: 'PostgreSQL 18 default',
      expected: expected(8, '', 'number'),
    },
    {
      id: 'postgres-default/geqo_threshold',
      setting: 'geqo_threshold',
      cityClaim: 'PostgreSQL 18 default',
      expected: expected(12, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_scale_factor',
      setting: 'autovacuum_vacuum_scale_factor',
      cityClaim: 'PostgreSQL default',
      expected: expected(0.2, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_threshold',
      setting: 'autovacuum_vacuum_threshold',
      cityClaim: 'PostgreSQL default',
      expected: expected(50, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_max_threshold',
      setting: 'autovacuum_vacuum_max_threshold',
      cityClaim: 'PostgreSQL default since PostgreSQL 18',
      expected: [{ from: 18, ...expected(100_000_000, '', 'number') }],
    },
    {
      id: 'postgres-default/autovacuum_analyze_scale_factor',
      setting: 'autovacuum_analyze_scale_factor',
      cityClaim: 'PostgreSQL default',
      expected: expected(0.1, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_insert_threshold',
      setting: 'autovacuum_vacuum_insert_threshold',
      cityClaim: 'PostgreSQL default since PostgreSQL 13',
      expected: expected(1000, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_insert_scale_factor',
      setting: 'autovacuum_vacuum_insert_scale_factor',
      cityClaim: 'PostgreSQL default since PostgreSQL 13',
      expected: expected(0.2, '', 'number'),
    },
    {
      id: 'postgres-default/bgwriter_lru_maxpages',
      setting: 'bgwriter_lru_maxpages',
      cityClaim: 'PostgreSQL default',
      expected: expected(DEFAULT_KNOBS.bgwriterLruMaxpages, '', 'number'),
    },
    {
      id: 'postgres-default/bgwriter_delay',
      setting: 'bgwriter_delay',
      cityClaim: 'PostgreSQL default',
      expected: expected(200, 'ms', 'duration'),
    },
    {
      id: 'postgres-default/bgwriter_lru_multiplier',
      setting: 'bgwriter_lru_multiplier',
      cityClaim: 'PostgreSQL default',
      expected: expected(2, '', 'number'),
    },
    {
      id: 'postgres-default/checkpoint_timeout',
      setting: 'checkpoint_timeout',
      cityClaim: 'PostgreSQL default stated beside the scaled city clock',
      expected: expected(5, 'min', 'duration'),
    },
    {
      id: 'postgres-default/checkpoint_completion_target',
      setting: 'checkpoint_completion_target',
      cityClaim: 'PostgreSQL default; 0.9 since PostgreSQL 14',
      expected: [
        { from: 13, to: 13, ...expected(0.5, '', 'number') },
        { from: 14, ...expected(DEFAULT_KNOBS.checkpointCompletionTarget, '', 'number') },
      ],
    },
    {
      id: 'postgres-default/max_wal_size',
      setting: 'max_wal_size',
      cityClaim: 'PostgreSQL default',
      expected: expected(1, 'GB', 'bytes'),
    },
    {
      id: 'postgres-default/min_wal_size',
      setting: 'min_wal_size',
      cityClaim: 'PostgreSQL default',
      expected: expected(80, 'MB', 'bytes'),
    },
    {
      id: 'postgres-default/shared_buffers',
      setting: 'shared_buffers',
      cityClaim: 'PostgreSQL default',
      expected: expected(128, 'MB', 'bytes'),
    },
    {
      id: 'postgres-default/wal_buffers',
      setting: 'wal_buffers',
      cityClaim: 'PostgreSQL default auto-sizing sentinel',
      expected: {
        ...expected(-1, '', 'number', '-1'),
        serverField: 'boot_val',
      },
    },
    {
      id: 'postgres-default/wal_writer_delay',
      setting: 'wal_writer_delay',
      cityClaim: 'PostgreSQL default',
      expected: expected(200, 'ms', 'duration'),
    },
    {
      id: 'postgres-default/full_page_writes',
      setting: 'full_page_writes',
      cityClaim: 'PostgreSQL default',
      expected: expected('on', '', 'text'),
    },
    {
      id: 'postgres-default/autovacuum_max_workers',
      setting: 'autovacuum_max_workers',
      cityClaim: 'PostgreSQL default',
      expected: expected(3, '', 'number'),
    },
    {
      id: 'postgres-default/autovacuum_vacuum_max_threshold',
      setting: 'autovacuum_vacuum_max_threshold',
      cityClaim: 'PostgreSQL 18 default',
      expected: { from: 18, ...expected(100_000_000, '', 'number') },
    },
    {
      id: 'postgres-default/track_io_timing',
      setting: 'track_io_timing',
      cityClaim: 'PostgreSQL default',
      expected: expected('off', '', 'text'),
    },
    {
      id: 'city-model/checkpoint_timeout',
      setting: 'checkpoint_timeout',
      cityClaim: 'PGSimCity model default',
      registeredDivergence: 'Teaching-scale model clock',
      expected: expected(CLAIM_VALUES.checkpointPolicy.defaultTimeoutSeconds, 's', 'duration'),
    },
    {
      id: 'city-model/max_wal_size',
      setting: 'max_wal_size',
      cityClaim: 'PGSimCity model default',
      registeredDivergence: 'Teaching-scale WAL volume',
      expected: expected(CLAIM_VALUES.checkpointPolicy.defaultMaxWalSizeMiB, 'MB', 'bytes'),
    },
    {
      id: 'city-model/shared_buffers',
      setting: 'shared_buffers',
      cityClaim: 'PGSimCity model default',
      registeredDivergence: 'Teaching-scale visible buffer sample',
      expected: expected(DEFAULT_KNOBS.sharedBuffers, 'MB', 'bytes'),
    },
    {
      id: 'city-model/autovacuum_vacuum_scale_factor',
      setting: 'autovacuum_vacuum_scale_factor',
      cityClaim: 'PGSimCity model default',
      registeredDivergence: 'Teaching-scale visible maintenance cadence',
      expected: expected(DEFAULT_KNOBS.autovacuumScaleFactor, '', 'number'),
    },
  ],
  waitEvents: {
    relation: 'pg_catalog.pg_wait_events',
    since: 17,
    events: [
      {
        id: 'wal-sync',
        cityClaim: 'the local WAL fsync wait is IO/WALSync through PostgreSQL 16 and IO/WalSync from PostgreSQL 17',
        expected: [
          { from: 13, to: 16, type: 'IO', name: 'WALSync' },
          { from: 17, ...POSTGRESQL_WAIT_EVENTS.walSync },
        ],
      },
      {
        id: 'sync-rep',
        cityClaim: 'a commit waiting for synchronous replication reports IPC/SyncRep',
        expected: POSTGRESQL_WAIT_EVENTS.syncRep,
      },
      {
        id: 'relation-lock',
        cityClaim: 'a heavyweight relation-lock wait reports Lock/relation',
        expected: POSTGRESQL_WAIT_EVENTS.relation,
      },
      {
        id: 'vacuum-delay',
        cityClaim: 'a cost-throttled vacuum worker reports Timeout/VacuumDelay',
        expected: POSTGRESQL_WAIT_EVENTS.vacuumDelay,
      },
      {
        id: 'data-file-read',
        cityClaim: 'a data-file read wait reports IO/DataFileRead',
        expected: POSTGRESQL_WAIT_EVENTS.dataFileRead,
      },
      {
        id: 'data-file-write',
        cityClaim: 'a data-file write wait reports IO/DataFileWrite',
        expected: POSTGRESQL_WAIT_EVENTS.dataFileWrite,
      },
      {
        id: 'client-read',
        cityClaim: 'a backend waiting for client input reports Client/ClientRead',
        expected: { type: 'Client', name: 'ClientRead' },
      },
      {
        id: 'client-write',
        cityClaim: 'a backend waiting to send to its client reports Client/ClientWrite',
        expected: { type: 'Client', name: 'ClientWrite' },
      },
      {
        id: 'wal-writer-main',
        cityClaim: 'the idle WAL writer reports Activity/WalWriterMain',
        expected: { type: 'Activity', name: 'WalWriterMain' },
      },
      {
        id: 'transactionid-lock',
        cityClaim: 'a row conflict can wait on Lock/transactionid',
        expected: { type: 'Lock', name: 'transactionid' },
      },
      {
        id: 'buffer-mapping',
        cityClaim: 'buffer mapping contention reports LWLock/BufferMapping',
        expected: { type: 'LWLock', name: 'BufferMapping' },
      },
      {
        id: 'wal-write',
        cityClaim: 'WAL-buffer write contention can report LWLock/WALWrite',
        expected: { type: 'LWLock', name: 'WALWrite' },
      },
      {
        id: 'wal-buffer-mapping',
        cityClaim: 'WAL-buffer mapping contention can report LWLock/WALBufMapping',
        expected: { type: 'LWLock', name: 'WALBufMapping' },
      },
      {
        id: 'xact-buffer',
        cityClaim: 'pg_xact page I/O can report LWLock/XactBuffer',
        expected: { type: 'LWLock', name: 'XactBuffer' },
      },
      {
        id: 'xact-slru',
        cityClaim: 'pg_xact cache access can report LWLock/XactSLRU',
        expected: { type: 'LWLock', name: 'XactSLRU' },
      },
      {
        id: 'subtrans-buffer',
        cityClaim: 'pg_subtrans page I/O can report LWLock/SubtransBuffer',
        expected: { type: 'LWLock', name: 'SubtransBuffer' },
      },
      {
        id: 'subtrans-slru',
        cityClaim: 'pg_subtrans cache access can report LWLock/SubtransSLRU',
        expected: { type: 'LWLock', name: 'SubtransSLRU' },
      },
    ],
  },
  autovacuumThreshold: {
    relation: 'oracle_autovacuum_threshold',
    reltuples: 1_000,
    liveTuples: 1_700,
    deadTuples: 300,
    baseThreshold: 50,
    scaleFactor: 0.2,
  },
  checkpointTimerSkip: {
    since: 18,
    timeoutSeconds: 30,
  },
  operatorAdvice: {
    statementTimeout: {
      timeoutMs: 100,
      idleMs: 500,
    },
    physicalSlotDrop: {
      slot: 'oracle_standby_slot',
      relation: 'oracle_slot_rows',
      rows: 120_000,
      payloadMd5Repeats: 18,
      minimumRetainedBytes: 64 * 1024 * 1024,
    },
  },
  storageMvcc: {
    lockOnlyXmax: {
      extension: 'pageinspect',
      relation: 'oracle_lock_only',
    },
    hotSummarizingIndex: {
      since: 16,
      rows: 5_000,
      brinRelation: 'hot_brin',
      btreeRelation: 'hot_btree',
    },
    reindexHeap: {
      relation: 'oracle_reindex',
    },
    toastTupleTarget: {
      defaultTarget: 2_000,
      raisedTarget: 4_000,
      valueBytes: 3_000,
    },
    readOnlyXid: {
      function: 'pg_current_xact_id()',
    },
    pageLayout: {
      relation: 'oracle_page_layout',
      headerRelation: 'oracle_tuple_header_layout',
      pageHeaderBytes: 24,
      linePointerBytes: 4,
      fixedTupleHeaderBytes: 23,
      nullableColumns: 17,
    },
    linePointerLifecycle: {
      relation: 'oracle_line_pointer_lifecycle',
    },
    deletingXmax: {
      relation: 'oracle_deleting_xmax',
    },
    multiXact: {
      relation: 'oracle_multixact',
    },
    removalHorizon: {
      relation: 'oracle_removal_horizon',
    },
    visibilityMap: {
      relation: 'oracle_visibility_map',
    },
    preparedHorizon: {
      gid: 'oracle_prepared_horizon',
    },
  },
  walSegment: {
    defaultBytes: CLAIM_VALUES.walSegment.bytes,
    alternateMiB: 32,
    configurableClaim: 'WAL segment size is selected at initdb time with --wal-segsize',
    qualifiedFixedSurfaces: CLAIM_VALUES.walSegment.qualifiedProseSurfaces,
    unqualifiedFixedSurfaces: [],
  },
  latencyWaitMappings: {
    relation: POSTGRESQL_WAIT_EVENTS.relation,
    synchronousReplication: POSTGRESQL_WAIT_EVENTS.syncRep,
    poolWaitName: 'PoolSlot',
  },
  connectionLocal: {
    advisoryLockKey: 818_204,
    preparedStatement: 'oracle_session_plan',
    listenChannel: 'oracle_session_channel',
  },
  workMemExecution: {
    spillWorkMemKiB: 64,
    hashWorkMemMiB: 1,
    hashMultipliers: [1, CLAIM_VALUES.workMem.hashMemMultiplier],
    sortRows: 40_000,
    hashRows: 80_000,
    concurrentBackends: 2,
  },
  nativeRecovery: {
    logicalDependencyType: 'oracle_mood',
    logicalDependencyTable: 'oracle_dependency_table',
  },
  timelineRecovery: {
    historyFile: CLAIM_VALUES.timelineRecovery.historyFile,
    latest: CLAIM_VALUES.timelineRecovery.defaultTarget,
    current: 'current',
  },
  vacuumReclaim: {
    rows: 24_000,
    payloadBytes: 768,
  },
  asynchronousCommit: {
    walWriterDelayMs: 200,
    crashWalWriterDelayMs: 10_000,
    lossWindowMultiplier: 3,
  },
  partialIndexBehavior: {
    rows: 2_000,
    owner: 'account-42',
  },
  pgStatIo: {
    relation: 'pg_catalog.pg_stat_io',
    since: 16,
    operationColumns: [
      'reads', 'writes', 'writebacks', 'extends', 'hits', 'evictions', 'reuses', 'fsyncs',
    ],
    projectionRows: [
      {
        backendType: 'client backend',
        object: 'relation',
        context: 'normal',
        operations: ['reads', 'hits'],
      },
      {
        backendType: 'checkpointer',
        object: 'relation',
        context: 'normal',
        operations: ['writes', 'writebacks', 'fsyncs'],
      },
      {
        backendType: 'background writer',
        object: 'relation',
        context: 'normal',
        operations: ['writes', 'writebacks', 'fsyncs'],
      },
    ],
  },
} as const
