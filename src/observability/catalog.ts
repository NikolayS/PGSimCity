/* ============================================================================
 * THE INSTRUMENT CATALOG
 *
 * Every name in this file was checked against postgresql.org/docs/current
 * (PostgreSQL 18.4) while it was being written. The rule is absolute: if a
 * column, view, function or enum value appears here, it exists. Where a name
 * changed between releases the change is recorded in `version`, because a
 * reader on 15 who copies an 18 query and gets "column does not exist" has been
 * failed by us, not by their server.
 *
 * `coverage` is the honesty field. PGSimCity is a model, not a server:
 *   live    — every column shown is produced by the running model
 *   partial — the view is real, the model fills some columns and blanks others
 *   absent  — the view is real and the model has nothing to put in it
 * Nothing in this project ever invents a number to fill a column.
 * ==========================================================================*/

export type Subsystem =
  | 'backends'
  | 'buffers'
  | 'wal'
  | 'checkpoint'
  | 'bgwriter'
  | 'vacuum'
  | 'replication'
  | 'locks'
  | 'storage'
  | 'config'

export type Coverage = 'live' | 'partial' | 'absent'

export interface CatalogEntry {
  /** exactly as you would type it */
  id: string
  kind: 'view' | 'function' | 'extension'
  /** major version in which this object first appeared, as a sortable number */
  since: number
  subsystem: Subsystem
  /** one line: what it is for */
  what: string
  /** verified column list — the whole list, in catalog order */
  columns: string[]
  docs: string
  coverage: Coverage
  /** why the coverage is what it is */
  coverageNote?: string
  /** what changed, and in which release */
  version?: string
  /** key into views.ts PROJECTIONS, when the model can render it */
  projection?: string
  /** component id in the city that this instrument watches */
  city?: string
}

const M = 'https://www.postgresql.org/docs/current/monitoring-stats.html'

export const CATALOG: CatalogEntry[] = [
  {
    id: 'pg_stat_activity',
    kind: 'view',
    since: 8.1,
    subsystem: 'backends',
    what: 'One row per server process: what it is doing and what it is waiting for.',
    columns: [
      'datid', 'datname', 'pid', 'leader_pid', 'usesysid', 'usename', 'application_name',
      'client_addr', 'client_hostname', 'client_port', 'backend_start', 'xact_start',
      'query_start', 'state_change', 'wait_event_type', 'wait_event', 'state',
      'backend_xid', 'backend_xmin', 'query_id', 'query', 'backend_type',
    ],
    docs: `${M}#MONITORING-PG-STAT-ACTIVITY-VIEW`,
    coverage: 'partial',
    coverageNote:
      'The model has sixteen backend slots and drives state, wait_event_type, wait_event, backend_xid, backend_xmin, xact_start and query from the same state machine the city draws. It has no users, no client addresses and no query_id, so those columns are blank rather than fabricated.',
    version:
      'wait_event_type and wait_event arrived in 9.6 — before that a waiting backend only showed waiting = true. query_id needs compute_query_id and arrived in 14. leader_pid arrived in 13. Watch the wait event *names* across releases too: PostgreSQL 17 started generating them from a table and normalised the capitalisation, so the WAL flush wait is WALSync on 16 and older and WalSync from 17 on. A dashboard filtering on the old spelling does not error on a new server — it silently matches nothing and reports zero.',
    projection: 'activity',
    city: 'backend.row',
  },
  {
    id: 'pg_stat_database',
    kind: 'view',
    since: 8.1,
    subsystem: 'backends',
    what: 'Cluster-wide totals per database, counted since the last stats reset.',
    columns: [
      'datid', 'datname', 'numbackends', 'xact_commit', 'xact_rollback', 'blks_read',
      'blks_hit', 'tup_returned', 'tup_fetched', 'tup_inserted', 'tup_updated',
      'tup_deleted', 'conflicts', 'temp_files', 'temp_bytes', 'deadlocks',
      'checksum_failures', 'checksum_last_failure', 'blk_read_time', 'blk_write_time',
      'session_time', 'active_time', 'idle_in_transaction_time', 'sessions',
      'sessions_abandoned', 'sessions_fatal', 'sessions_killed',
      'parallel_workers_to_launch', 'parallel_workers_launched', 'stats_reset',
    ],
    docs: `${M}#MONITORING-PG-STAT-DATABASE-VIEW`,
    coverage: 'partial',
    coverageNote:
      'numbackends, xact_commit, xact_rollback, blks_read, blks_hit and the tup_* counters are real model output. The model has no temp files, no deadlocks, no checksums and no session timers.',
    version:
      'blk_read_time and blk_write_time only move when track_io_timing is on, and it is off by default. session_time and the sessions_* counters arrived in 14; the parallel_workers_* counters in 18.',
    projection: 'database',
    city: 'stats.collector',
  },
  {
    id: 'pg_stat_all_tables',
    kind: 'view',
    since: 8.1,
    subsystem: 'storage',
    what: 'Per-table access and maintenance counters. Where bloat becomes visible.',
    columns: [
      'relid', 'schemaname', 'relname', 'seq_scan', 'last_seq_scan', 'seq_tup_read',
      'idx_scan', 'last_idx_scan', 'idx_tup_fetch', 'n_tup_ins', 'n_tup_upd', 'n_tup_del',
      'n_tup_hot_upd', 'n_tup_newpage_upd', 'n_live_tup', 'n_dead_tup',
      'n_mod_since_analyze', 'n_ins_since_vacuum', 'last_vacuum', 'last_autovacuum',
      'last_analyze', 'last_autoanalyze', 'vacuum_count', 'autovacuum_count',
      'analyze_count', 'autoanalyze_count', 'total_vacuum_time', 'total_autovacuum_time',
      'total_analyze_time', 'total_autoanalyze_time',
    ],
    docs: `${M}#MONITORING-PG-STAT-ALL-TABLES-VIEW`,
    coverage: 'partial',
    coverageNote:
      'The model tracks five tables with real seq_scan, idx_scan, n_tup_ins/upd/del, n_tup_hot_upd, n_live_tup, n_dead_tup and last_autovacuum. It never ANALYZEs, so the analyze columns stay blank.',
    version:
      'last_seq_scan, last_idx_scan and n_tup_newpage_upd arrived in 16. The four total_*_time columns arrived in 18.',
    projection: 'tables',
    city: 'storage.datadir',
  },
  {
    id: 'pg_stat_bgwriter',
    kind: 'view',
    since: 8.3,
    subsystem: 'bgwriter',
    what: 'What the background writer cleaned, and how many buffers were allocated.',
    columns: ['buffers_clean', 'maxwritten_clean', 'buffers_alloc', 'stats_reset'],
    docs: `${M}#MONITORING-PG-STAT-BGWRITER-VIEW`,
    coverage: 'partial',
    coverageNote:
      'buffers_clean and buffers_alloc are model output. maxwritten_clean would need the bgwriter to hit bgwriter_lru_maxpages and stop early, which the model does not track separately.',
    version:
      'This view used to carry the checkpoint counters too. PostgreSQL 17 moved checkpoints_timed, checkpoints_req, checkpoint_write_time, checkpoint_sync_time and buffers_checkpoint into pg_stat_checkpointer, and moved buffers_backend and buffers_backend_fsync into pg_stat_io. Most tuning advice online still points at the old columns.',
    projection: 'bgwriter',
    city: 'bgwriter',
  },
  {
    id: 'pg_stat_checkpointer',
    kind: 'view',
    since: 17,
    subsystem: 'checkpoint',
    what: 'Why checkpoints happen, how many pages they write, and how long they take.',
    columns: [
      'num_timed', 'num_requested', 'num_done', 'restartpoints_timed', 'restartpoints_req',
      'restartpoints_done', 'write_time', 'sync_time', 'buffers_written', 'slru_written',
      'stats_reset',
    ],
    docs: `${M}#MONITORING-PG-STAT-CHECKPOINTER-VIEW`,
    coverage: 'partial',
    coverageNote:
      'num_timed, num_requested, buffers_written and write_time come straight from the model checkpointer. The model has no standby restartpoints and does not separate sync_time from write_time.',
    version:
      'New in 17, split out of pg_stat_bgwriter. On 16 and older use checkpoints_timed and checkpoints_req in pg_stat_bgwriter — the same two numbers under different names. num_done and slru_written arrived in 18.',
    projection: 'checkpointer',
    city: 'checkpointer',
  },
  {
    id: 'pg_stat_wal',
    kind: 'view',
    since: 14,
    subsystem: 'wal',
    what: 'How much WAL you are generating, and how much of it is full-page images.',
    columns: ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'stats_reset'],
    docs: `${M}#MONITORING-PG-STAT-WAL-VIEW`,
    coverage: 'partial',
    coverageNote:
      'wal_bytes is the model LSN advance, which is exact. wal_records and wal_fpi are derived from the model — one record per tuple operation plus one per commit, and full-page images taken from the post-checkpoint burst the model actually simulates. Treat them as shaped, not measured.',
    version:
      'New in 14. PostgreSQL 18 removed wal_write, wal_sync, wal_write_time and wal_sync_time from this view; WAL I/O is now reported by pg_stat_io with object = \'wal\'.',
    projection: 'wal',
    city: 'wal.vault',
  },
  {
    id: 'pg_stat_io',
    kind: 'view',
    since: 16,
    subsystem: 'buffers',
    what: 'I/O broken down by who did it. The view that names the process hurting you.',
    columns: [
      'backend_type', 'object', 'context', 'reads', 'read_bytes', 'read_time', 'writes',
      'write_bytes', 'write_time', 'writebacks', 'writeback_time', 'extends',
      'extend_bytes', 'extend_time', 'hits', 'evictions', 'reuses', 'fsyncs', 'fsync_time',
      'stats_reset',
    ],
    docs: `${M}#MONITORING-PG-STAT-IO-VIEW`,
    coverage: 'partial',
    coverageNote:
      'The model genuinely distinguishes who moved each page — client backend, checkpointer or background writer — so reads, writes, hits and evictions are real. The timing columns need track_io_timing and the model has no clock on individual I/Os.',
    version:
      'New in 16, and the single biggest improvement to Postgres observability in years. Before 16, the closest signal is buffers_backend in pg_stat_bgwriter, which tells you backends wrote pages but not which relation, context or operation. PostgreSQL 18 replaced op_bytes with the per-operation read_bytes, write_bytes and extend_bytes.',
    projection: 'io',
    city: 'shared.buffers',
  },
  {
    id: 'pg_stat_replication',
    kind: 'view',
    since: 9.1,
    subsystem: 'replication',
    what: 'One row per walsender: four LSN positions and three lag intervals.',
    columns: [
      'pid', 'usesysid', 'usename', 'application_name', 'client_addr', 'client_hostname',
      'client_port', 'backend_start', 'backend_xmin', 'state', 'sent_lsn', 'write_lsn',
      'flush_lsn', 'replay_lsn', 'write_lag', 'flush_lag', 'replay_lag', 'sync_priority',
      'sync_state',
    ],
    docs: `${M}#MONITORING-PG-STAT-REPLICATION-VIEW`,
    coverage: 'live',
    coverageNote:
      'The model runs a real streaming standby with four separate LSN positions, a wire with latency, and a single-threaded replay process. Every position and lag shown here is produced by it.',
    version:
      'write_lag, flush_lag and replay_lag arrived in 10. Before that you had to compute lag yourself from the LSNs.',
    projection: 'replication',
    city: 'walsender',
  },
  {
    id: 'pg_stat_progress_vacuum',
    kind: 'view',
    since: 9.6,
    subsystem: 'vacuum',
    what: 'What a running VACUUM is doing right now, phase by phase.',
    columns: [
      'pid', 'datid', 'datname', 'relid', 'phase', 'heap_blks_total', 'heap_blks_scanned',
      'heap_blks_vacuumed', 'index_vacuum_count', 'max_dead_tuple_bytes',
      'dead_tuple_bytes', 'num_dead_item_ids', 'indexes_total', 'indexes_processed',
      'delay_time',
    ],
    docs: 'https://www.postgresql.org/docs/current/progress-reporting.html',
    coverage: 'partial',
    coverageNote:
      'The model runs up to three autovacuum workers through the real phase sequence, so pid, relid, phase, the heap block counters and index_vacuum_count are live. It does not model the dead-tuple store, so the byte columns are blank.',
    version:
      'PostgreSQL 17 replaced max_dead_tuples and num_dead_tuples with max_dead_tuple_bytes, dead_tuple_bytes and num_dead_item_ids, and added indexes_total and indexes_processed. delay_time arrived in 18. On 16 and older, expect the two older columns instead.',
    projection: 'progress_vacuum',
    city: 'autovac.launcher',
  },
  {
    id: 'pg_locks',
    kind: 'view',
    since: 8.1,
    subsystem: 'locks',
    what: 'Every lock currently held or awaited, with the process that wants it.',
    columns: [
      'locktype', 'database', 'relation', 'page', 'tuple', 'virtualxid', 'transactionid',
      'classid', 'objid', 'objsubid', 'virtualtransaction', 'pid', 'mode', 'granted',
      'fastpath', 'waitstart',
    ],
    docs: 'https://www.postgresql.org/docs/current/view-pg-locks.html',
    coverage: 'partial',
    coverageNote:
      'The model takes one real relation-level ACCESS EXCLUSIVE lock and queues real waiters behind it, so locktype, relation, pid, mode, granted and waitstart are live. It has no transaction-id or tuple locks.',
    version:
      'waitstart arrived in 14. Before that you had to join to pg_stat_activity.query_start to guess how long a waiter had been queued.',
    projection: 'locks',
    city: 'lock.manager',
  },
  {
    id: 'pg_blocking_pids',
    kind: 'function',
    since: 9.6,
    subsystem: 'locks',
    what: 'Given a pid, the pids blocking it. Turns a lock table into a culprit.',
    columns: ['pg_blocking_pids ( integer ) → integer[]'],
    docs: 'https://www.postgresql.org/docs/current/functions-info.html',
    coverage: 'live',
    coverageNote: 'The model knows exactly which slot holds the lock every waiter is queued behind.',
    version:
      'New in 9.6, and it replaced a decade of hand-written self-joins against pg_locks. It is expensive — it takes the lock manager\'s shared state briefly — so do not put it in a dashboard that polls every second.',
    projection: 'locks',
    city: 'lock.manager',
  },
  {
    id: 'pg_buffercache',
    kind: 'extension',
    since: 8.1,
    subsystem: 'buffers',
    what: 'One row per shared buffer. What is actually cached, and how hot it is.',
    columns: [
      'bufferid', 'relfilenode', 'reltablespace', 'reldatabase', 'relforknumber',
      'relblocknumber', 'isdirty', 'usagecount', 'pinning_backends',
    ],
    docs: 'https://www.postgresql.org/docs/current/pgbuffercache.html',
    coverage: 'live',
    coverageNote:
      'The city\'s 1,024 buffer tiles are the model\'s buffer pool, frame for frame. isdirty and usagecount here are the same bytes the plaza is drawing.',
    version:
      'pg_buffercache_summary() and pg_buffercache_usage_counts() arrived in 16 and are far cheaper than scanning the view — the view takes a lock on every buffer header. Do not run it in a loop on a large pool.',
    projection: 'buffercache',
    city: 'shared.buffers',
  },
  {
    id: 'pg_settings',
    kind: 'view',
    since: 7.4,
    subsystem: 'config',
    what: 'The running configuration. Half of every diagnosis ends here.',
    columns: [
      'name', 'setting', 'unit', 'category', 'short_desc', 'extra_desc', 'context',
      'vartype', 'source', 'min_val', 'max_val', 'enumvals', 'boot_val', 'reset_val',
      'sourcefile', 'sourceline', 'pending_restart',
    ],
    docs: 'https://www.postgresql.org/docs/current/view-pg-settings.html',
    coverage: 'partial',
    coverageNote:
      'These are the model\'s own knobs, reported under the real GUC names. Changing one here changes the running model, exactly as a SET or a reload would.',
    projection: 'settings',
  },
  {
    id: 'pg_current_wal_lsn',
    kind: 'function',
    since: 10,
    subsystem: 'wal',
    what: 'Where the WAL write position is right now. The yardstick for every lag number.',
    columns: [
      'pg_current_wal_lsn () → pg_lsn',
      'pg_current_wal_insert_lsn () → pg_lsn',
      'pg_current_wal_flush_lsn () → pg_lsn',
      'pg_wal_lsn_diff ( lsn1 pg_lsn, lsn2 pg_lsn ) → numeric',
      'pg_walfile_name ( lsn pg_lsn ) → text',
    ],
    docs: 'https://www.postgresql.org/docs/current/functions-admin.html',
    coverage: 'live',
    coverageNote:
      'The model keeps three separate WAL positions — insert, write and flush — because the difference between them is the whole point of the commit path.',
    version:
      'Renamed in 10. On 9.6 and older these were pg_current_xlog_location(), pg_current_xlog_insert_location() and pg_xlog_location_diff().',
    projection: 'wal_lsn',
    city: 'wal.vault',
  },
  {
    id: 'pg_replication_slots',
    kind: 'view',
    since: 9.4,
    subsystem: 'replication',
    what: 'Slots pin WAL until a consumer confirms it. An abandoned one fills your disk.',
    columns: [
      'slot_name', 'plugin', 'slot_type', 'datoid', 'database', 'temporary', 'active',
      'active_pid', 'xmin', 'catalog_xmin', 'restart_lsn', 'confirmed_flush_lsn',
      'wal_status', 'safe_wal_size', 'two_phase', 'two_phase_at', 'inactive_since',
      'conflicting', 'invalidation_reason', 'failover', 'synced',
    ],
    docs: 'https://www.postgresql.org/docs/current/view-pg-replication-slots.html',
    coverage: 'partial',
    coverageNote:
      'The model creates a logical slot when wal_level = logical and advances its confirmed_flush_lsn. It never lets a slot go stale, so you cannot watch wal_status decay here — that is the one failure this model will not show you.',
    version:
      'wal_status and safe_wal_size arrived in 13 and are the columns to alert on: reserved → extended → unreserved → lost. inactive_since arrived in 17.',
    projection: 'slots',
    city: 'logical.decoder',
  },
  {
    id: 'pg_stat_statements',
    kind: 'extension',
    since: 8.4,
    subsystem: 'backends',
    what: 'Cumulative timing per normalised statement. The first thing to install.',
    columns: [
      'userid', 'dbid', 'toplevel', 'queryid', 'query', 'plans', 'total_plan_time',
      'min_plan_time', 'max_plan_time', 'mean_plan_time', 'stddev_plan_time', 'calls',
      'total_exec_time', 'min_exec_time', 'max_exec_time', 'mean_exec_time',
      'stddev_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read',
      'shared_blks_dirtied', 'shared_blks_written', 'local_blks_hit', 'local_blks_read',
      'local_blks_dirtied', 'local_blks_written', 'temp_blks_read', 'temp_blks_written',
      'shared_blk_read_time', 'shared_blk_write_time', 'local_blk_read_time',
      'local_blk_write_time', 'temp_blk_read_time', 'temp_blk_write_time', 'wal_records',
      'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'jit_functions', 'jit_generation_time',
      'jit_inlining_count', 'jit_inlining_time', 'jit_optimization_count',
      'jit_optimization_time', 'jit_emission_count', 'jit_emission_time',
      'jit_deform_count', 'jit_deform_time', 'parallel_workers_to_launch',
      'parallel_workers_launched', 'stats_since', 'minmax_stats_since',
    ],
    docs: 'https://www.postgresql.org/docs/current/pgstatstatements.html',
    coverage: 'absent',
    coverageNote:
      'The model has no per-statement history, and this page will not fake one. That absence is instructive: pg_stat_statements is not installed by default either, and on a server without it every "which query got slow" investigation degrades into sampling pg_stat_activity and hoping you catch the query in the act.',
    version:
      'total_time became total_exec_time in 13 when planning time was split out. The blk timing columns were renamed with a shared_/local_/temp_ prefix in 17.',
  },
  {
    id: 'pg_stat_slru',
    kind: 'view',
    since: 13,
    subsystem: 'buffers',
    what: 'The small fixed caches — commit log, subtransactions, multixact — outside shared_buffers.',
    columns: [
      'name', 'blks_zeroed', 'blks_hit', 'blks_read', 'blks_written', 'blks_exists',
      'flushes', 'truncates', 'stats_reset',
    ],
    docs: `${M}#MONITORING-PG-STAT-SLRU-VIEW`,
    coverage: 'absent',
    coverageNote:
      'The city draws the commit-log SLRU as a building, but the model does not count its page hits and misses, so there is nothing honest to put in these columns.',
    version:
      'New in 13. In 17 the SLRU caches became individually sizeable (commit_timestamp_buffers, multixact_offset_buffers and friends), which made this view actionable rather than merely interesting.',
    city: 'clog.slru',
  },
]

export const BY_ID = new Map(CATALOG.map((e) => [e.id, e]))

/** Longest name we ever have to reserve space for. */
export const CATALOG_SUBSYSTEMS: { id: Subsystem; label: string }[] = [
  { id: 'backends', label: 'Sessions & activity' },
  { id: 'buffers', label: 'Buffers & I/O' },
  { id: 'wal', label: 'Write-ahead log' },
  { id: 'checkpoint', label: 'Checkpoints' },
  { id: 'bgwriter', label: 'Background writer' },
  { id: 'vacuum', label: 'Vacuum' },
  { id: 'replication', label: 'Replication' },
  { id: 'locks', label: 'Locks' },
  { id: 'storage', label: 'Tables & storage' },
  { id: 'config', label: 'Configuration' },
]

/** Versions offered in the version rail, newest first. */
export const VERSIONS = [18, 17, 16, 15, 14, 13, 12] as const
