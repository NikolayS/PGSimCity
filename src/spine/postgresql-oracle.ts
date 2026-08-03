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

/*
 * Mechanically checkable PostgreSQL facts are data here, not branches in the
 * harness. Some entries describe stock defaults stated in prose; the explicit
 * city-model entries preserve intentional teaching-scale divergences.
 */
export const POSTGRESQL_ORACLE_CLAIMS = {
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
      cityClaim: 'PostgreSQL 18.3 default',
      expected: expected(8, '', 'number'),
    },
    {
      id: 'postgres-default/geqo_threshold',
      setting: 'geqo_threshold',
      cityClaim: 'PostgreSQL 18.3 default',
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
      expected: expected(CLAIM_VALUES.checkpointPolicy.defaultTimeoutSeconds, 's', 'duration'),
    },
    {
      id: 'city-model/max_wal_size',
      setting: 'max_wal_size',
      cityClaim: 'PGSimCity model default',
      expected: expected(CLAIM_VALUES.checkpointPolicy.defaultMaxWalSizeMiB, 'MB', 'bytes'),
    },
    {
      id: 'city-model/shared_buffers',
      setting: 'shared_buffers',
      cityClaim: 'PGSimCity model default',
      expected: expected(DEFAULT_KNOBS.sharedBuffers, 'MB', 'bytes'),
    },
    {
      id: 'city-model/autovacuum_vacuum_scale_factor',
      setting: 'autovacuum_vacuum_scale_factor',
      cityClaim: 'PGSimCity model default',
      expected: expected(DEFAULT_KNOBS.autovacuumScaleFactor, '', 'number'),
    },
  ],
  waitEvents: {
    relation: 'pg_catalog.pg_wait_events',
    since: 17,
    events: Object.values(POSTGRESQL_WAIT_EVENTS),
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
