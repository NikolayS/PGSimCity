export const versions = ['18', '17', '16', '15', '14', '13', '12', '11', '10', '9.6', '9.5'] as const

export type PgVersion = (typeof versions)[number]
export type GroupId = 'query' | 'memory' | 'process' | 'wal' | 'replication' | 'storage'
export type ProbeKind = 'view' | 'function' | 'extension' | 'command'

export interface Group {
  id: GroupId
  label: string
  color: string
}

export interface SystemNode {
  id: string
  label: string
  group: GroupId
  x: number
  y: number
  width: number
  height: number
  depth: number
  description: string
}

export interface Probe {
  id: string
  name: string
  kind: ProbeKind
  targets: readonly string[]
  since: PgVersion
  until?: PgVersion
  side: 'left' | 'right' | 'bottom'
  order: number
  summary: string
  columns?: readonly string[]
  tip?: string
}

export const groups: readonly Group[] = [
  { id: 'query', label: 'query lifecycle', color: '#f1cb57' },
  { id: 'memory', label: 'memory & I/O', color: '#d7d9df' },
  { id: 'process', label: 'server processes', color: '#e27e8a' },
  { id: 'wal', label: 'WAL & logging', color: '#3eb2ba' },
  { id: 'replication', label: 'replication', color: '#70a0d4' },
  { id: 'storage', label: 'storage', color: '#9bbfba' },
] as const

export const nodes: readonly SystemNode[] = [
  {
    id: 'clients',
    label: 'Client backends',
    group: 'query',
    x: 8,
    y: 7,
    width: 34,
    height: 9,
    depth: 4,
    description: 'One backend process per direct client connection: authentication, session state, and transaction state.',
  },
  {
    id: 'planning',
    label: 'Query planning',
    group: 'query',
    x: 8,
    y: 17.5,
    width: 34,
    height: 9,
    depth: 5,
    description: 'Parse, rewrite, plan, and choose access paths before the executor runs.',
  },
  {
    id: 'execution',
    label: 'Query execution',
    group: 'query',
    x: 8,
    y: 28,
    width: 34,
    height: 9,
    depth: 6,
    description: 'The executor consumes the plan tree, coordinates waits, and reads or changes tuples.',
  },
  {
    id: 'index-usage',
    label: 'Indexes usage',
    group: 'process',
    x: 8,
    y: 38.5,
    width: 16.5,
    height: 9,
    depth: 3,
    description: 'Index scan frequency, tuples read, tuples fetched, and the I/O beneath those access paths.',
  },
  {
    id: 'table-usage',
    label: 'Tables usage',
    group: 'process',
    x: 25.5,
    y: 38.5,
    width: 16.5,
    height: 9,
    depth: 3,
    description: 'Sequential scans, tuple churn, vacuum state, and heap-level I/O.',
  },
  {
    id: 'buffers-io',
    label: 'Buffers I/O',
    group: 'process',
    x: 8,
    y: 49,
    width: 34,
    height: 8,
    depth: 4,
    description: 'The observable path between relation access, shared buffers, and the operating system.',
  },
  {
    id: 'shared-buffers',
    label: 'Shared buffers',
    group: 'memory',
    x: 43.5,
    y: 7,
    width: 17,
    height: 42,
    depth: 12,
    description: 'The shared page cache used by every backend and most server processes.',
  },
  {
    id: 'slru',
    label: 'SLRU caches',
    group: 'memory',
    x: 43.5,
    y: 50.5,
    width: 17,
    height: 8.5,
    depth: 5,
    description: 'Small shared caches for transaction status, subtransactions, multixacts, notifications, and commit timestamps.',
  },
  {
    id: 'postmaster',
    label: 'Postmaster',
    group: 'process',
    x: 62,
    y: 7,
    width: 30,
    height: 11,
    depth: 7,
    description: 'The parent process: accepts connections, starts children, and supervises the cluster.',
  },
  {
    id: 'background-workers',
    label: 'Background workers',
    group: 'process',
    x: 62,
    y: 19.5,
    width: 30,
    height: 11,
    depth: 6,
    description: 'Built-in and extension background processes registered with the postmaster.',
  },
  {
    id: 'autovacuum-launcher',
    label: 'Autovacuum launcher',
    group: 'process',
    x: 62,
    y: 32,
    width: 30,
    height: 11,
    depth: 5,
    description: 'Schedules autovacuum workers across databases.',
  },
  {
    id: 'autovacuum-workers',
    label: 'Autovacuum workers',
    group: 'process',
    x: 62,
    y: 44.5,
    width: 30,
    height: 11,
    depth: 4,
    description: 'Vacuum and analyze tables, maintain visibility, and prevent transaction ID wraparound.',
  },
  {
    id: 'wal',
    label: 'Write-ahead log',
    group: 'wal',
    x: 8,
    y: 60.5,
    width: 84,
    height: 8,
    depth: 8,
    description: 'The durability stream: WAL records must reach durable storage before related data pages.',
  },
  {
    id: 'logger',
    label: 'Logger process',
    group: 'wal',
    x: 8,
    y: 70,
    width: 84,
    height: 8,
    depth: 5,
    description: 'Collects stderr and csvlog/jsonlog output into server log files when enabled.',
  },
  {
    id: 'logical-replication',
    label: 'Logical replication',
    group: 'wal',
    x: 8,
    y: 79.5,
    width: 16.5,
    height: 9,
    depth: 5,
    description: 'Decoding, publications, subscriptions, and apply workers for row-level replication.',
  },
  {
    id: 'wal-sender',
    label: 'WAL sender',
    group: 'wal',
    x: 25.5,
    y: 79.5,
    width: 16.5,
    height: 9,
    depth: 6,
    description: 'Streams physical WAL or logical decoding output to a receiver.',
  },
  {
    id: 'wal-archiver',
    label: 'WAL archiver',
    group: 'wal',
    x: 43,
    y: 79.5,
    width: 16.5,
    height: 9,
    depth: 5,
    description: 'Copies completed WAL segments to the configured archive.',
  },
  {
    id: 'background-writer',
    label: 'Background writer',
    group: 'replication',
    x: 60.5,
    y: 79.5,
    width: 15,
    height: 9,
    depth: 5,
    description: 'Writes reusable dirty buffers gradually to reduce backend write bursts.',
  },
  {
    id: 'checkpointer',
    label: 'Checkpointer',
    group: 'replication',
    x: 76.5,
    y: 79.5,
    width: 15.5,
    height: 9,
    depth: 7,
    description: 'Coordinates checkpoints and guarantees dirty pages preceding the redo point reach storage.',
  },
  {
    id: 'network',
    label: 'Network',
    group: 'memory',
    x: 8,
    y: 90,
    width: 42,
    height: 7,
    depth: 3,
    description: 'Client and replication transport outside the Postgres process.',
  },
  {
    id: 'storage',
    label: 'Storage',
    group: 'memory',
    x: 51,
    y: 90,
    width: 41,
    height: 7,
    depth: 3,
    description: 'Filesystem and block-device persistence beneath Postgres.',
  },
  {
    id: 'wal-receiver',
    label: 'WAL receiver',
    group: 'wal',
    x: 8,
    y: 98.5,
    width: 34,
    height: 8,
    depth: 5,
    description: 'Receives a WAL stream from the primary and writes it locally.',
  },
  {
    id: 'recovery',
    label: 'Recovery process',
    group: 'wal',
    x: 8,
    y: 108,
    width: 34,
    height: 8,
    depth: 6,
    description: 'Replays WAL during crash recovery or on a physical standby.',
  },
  {
    id: 'data-files',
    label: 'Tables / indexes data files',
    group: 'storage',
    x: 58,
    y: 98.5,
    width: 34,
    height: 17.5,
    depth: 8,
    description: 'Relation forks, tablespaces, temporary files, and the physical database layout.',
  },
] as const

export const probes: readonly Probe[] = [
  { id: 'activity', name: 'pg_stat_activity', kind: 'view', targets: ['clients', 'execution', 'postmaster'], since: '9.5', side: 'left', order: 10, summary: 'One row per server process with session, transaction, query, state, and wait information.', columns: ['pid', 'datname', 'usename', 'state', 'query_start', 'wait_event_type', 'wait_event', 'query_id'], tip: 'Join blocked sessions to pg_blocking_pids(pid); never infer blocking from age alone.' },
  { id: 'ssl', name: 'pg_stat_ssl', kind: 'view', targets: ['clients'], since: '9.5', side: 'left', order: 20, summary: 'TLS state and certificate details for each connected backend.', columns: ['pid', 'ssl', 'version', 'cipher', 'bits', 'client_dn'] },
  { id: 'gssapi', name: 'pg_stat_gssapi', kind: 'view', targets: ['clients'], since: '12', side: 'left', order: 30, summary: 'GSSAPI authentication and encryption state for connected clients.', columns: ['pid', 'gss_authenticated', 'principal', 'encrypted'] },
  { id: 'backend-memory', name: 'pg_backend_memory_contexts', kind: 'view', targets: ['clients', 'shared-buffers'], since: '14', side: 'left', order: 40, summary: 'Memory-context tree for the current backend.', columns: ['name', 'ident', 'parent', 'level', 'total_bytes', 'free_bytes', 'used_bytes'], tip: 'This is backend-local. Use pg_log_backend_memory_contexts() to request another backend’s tree in the server log.' },
  { id: 'log-backend-memory', name: 'pg_log_backend_memory_contexts()', kind: 'function', targets: ['clients', 'logger'], since: '14', side: 'left', order: 50, summary: 'Ask a backend to dump its memory contexts to the server log.', columns: ['pid'], tip: 'The output goes to the server log; the function does not return the memory tree.' },
  { id: 'explain', name: 'EXPLAIN (ANALYZE, BUFFERS)', kind: 'command', targets: ['planning', 'execution', 'buffers-io'], since: '9.5', side: 'left', order: 60, summary: 'Plan shape, estimates, actual rows, timing, loops, and buffer traffic.', columns: ['cost', 'rows', 'actual time', 'actual rows', 'loops', 'shared hit/read/dirtied/written'], tip: 'ANALYZE executes the statement. Use a transaction and ROLLBACK for risky writes.' },
  { id: 'statements', name: 'pg_stat_statements', kind: 'extension', targets: ['planning', 'execution', 'buffers-io', 'wal'], since: '9.5', side: 'left', order: 70, summary: 'Aggregated planning and execution statistics by normalized statement fingerprint.', columns: ['queryid', 'calls', 'total_exec_time', 'rows', 'shared_blks_hit', 'shared_blks_read', 'wal_bytes'], tip: 'Enable track_io_timing for meaningful I/O time. Reset deliberately; the counters are cumulative.' },
  { id: 'prepared', name: 'pg_prepared_statements', kind: 'view', targets: ['planning'], since: '9.5', side: 'left', order: 80, summary: 'Prepared statements visible in the current session.', columns: ['name', 'statement', 'prepare_time', 'parameter_types', 'from_sql', 'generic_plans', 'custom_plans'] },
  { id: 'locks', name: 'pg_locks', kind: 'view', targets: ['execution'], since: '9.5', side: 'left', order: 90, summary: 'Held and awaited heavyweight, predicate, relation, page, tuple, and transaction locks.', columns: ['locktype', 'database', 'relation', 'page', 'tuple', 'transactionid', 'pid', 'mode', 'granted', 'waitstart'], tip: 'A row with granted = false is the waiter. Determine blockers with pg_blocking_pids(), not a hand-rolled self join.' },
  { id: 'blocking', name: 'pg_blocking_pids()', kind: 'function', targets: ['execution'], since: '9.6', side: 'left', order: 100, summary: 'Returns the PIDs directly blocking a server process.', columns: ['pid'], tip: 'This understands lock queue ordering and parallel-query leaders; it is safer than joining pg_locks yourself.' },
  { id: 'progress-index', name: 'pg_stat_progress_create_index', kind: 'view', targets: ['execution', 'index-usage'], since: '12', side: 'left', order: 110, summary: 'Phase and counters for CREATE INDEX and REINDEX.', columns: ['pid', 'command', 'phase', 'blocks_total', 'blocks_done', 'tuples_total', 'tuples_done'] },
  { id: 'index-stats', name: 'pg_stat_all_indexes', kind: 'view', targets: ['index-usage'], since: '9.5', side: 'left', order: 120, summary: 'Index scans and tuple access counters for every index.', columns: ['relname', 'indexrelname', 'idx_scan', 'last_idx_scan', 'idx_tup_read', 'idx_tup_fetch'], tip: 'Low idx_scan is not enough to drop an index; check constraint use, write cost, and a representative stats window.' },
  { id: 'index-io', name: 'pg_statio_all_indexes', kind: 'view', targets: ['index-usage', 'buffers-io'], since: '9.5', side: 'left', order: 130, summary: 'Index block reads and shared-buffer hits.', columns: ['relname', 'indexrelname', 'idx_blks_read', 'idx_blks_hit'] },
  { id: 'table-stats', name: 'pg_stat_all_tables', kind: 'view', targets: ['table-usage', 'autovacuum-workers'], since: '9.5', side: 'left', order: 140, summary: 'Scans, tuple churn, dead-row estimates, and vacuum/analyze history by table.', columns: ['seq_scan', 'idx_scan', 'n_tup_ins', 'n_tup_upd', 'n_dead_tup', 'last_autovacuum', 'autovacuum_count'], tip: 'n_dead_tup is an estimate. For wraparound safety, inspect relfrozenxid age as well.' },
  { id: 'table-io', name: 'pg_statio_all_tables', kind: 'view', targets: ['table-usage', 'buffers-io'], since: '9.5', side: 'left', order: 150, summary: 'Heap, index, TOAST, and visibility-map block reads and hits.', columns: ['heap_blks_read', 'heap_blks_hit', 'idx_blks_read', 'idx_blks_hit', 'toast_blks_read', 'tidx_blks_hit'] },
  { id: 'database', name: 'pg_stat_database', kind: 'view', targets: ['clients', 'buffers-io'], since: '9.5', side: 'right', order: 10, summary: 'Database-wide workload, cache, conflict, temporary-file, deadlock, and session counters.', columns: ['numbackends', 'xact_commit', 'xact_rollback', 'blks_read', 'blks_hit', 'temp_bytes', 'deadlocks', 'sessions_abandoned'], tip: 'Most fields are cumulative since stats_reset. Compare rates over time, not raw totals.' },
  { id: 'monitor', name: 'pg_stat_monitor', kind: 'extension', targets: ['planning', 'execution'], since: '11', side: 'left', order: 160, summary: 'Bucketed statement statistics with plan and client dimensions.', columns: ['bucket', 'queryid', 'planid', 'calls', 'total_exec_time', 'application_name'] },
  { id: 'wait-sampling', name: 'pg_wait_sampling', kind: 'extension', targets: ['execution'], since: '9.5', side: 'left', order: 170, summary: 'Sampled wait-event history and profiles.', columns: ['pid', 'ts', 'event_type', 'event', 'queryid'], tip: 'Sampling gives distributions. pg_stat_activity gives only the current state.' },
  { id: 'kcache', name: 'pg_stat_kcache', kind: 'extension', targets: ['execution', 'buffers-io'], since: '9.5', side: 'left', order: 180, summary: 'Operating-system CPU, reads, writes, faults, and context switches by statement.', columns: ['queryid', 'user_time', 'system_time', 'reads', 'writes', 'minflts', 'nvcsws'] },
  { id: 'buffercache', name: 'pg_buffercache', kind: 'extension', targets: ['shared-buffers'], since: '9.5', side: 'right', order: 20, summary: 'A live inventory of pages occupying shared buffers.', columns: ['bufferid', 'relfilenode', 'reltablespace', 'reldatabase', 'relforknumber', 'relblocknumber', 'isdirty', 'usagecount'], tip: 'Scanning the view takes buffer-header locks. Do not poll it aggressively on a busy cluster.' },
  { id: 'stat-io', name: 'pg_stat_io', kind: 'view', targets: ['shared-buffers', 'buffers-io', 'storage'], since: '16', side: 'right', order: 30, summary: 'Cluster-wide I/O operations and timing by backend type, object, and context.', columns: ['backend_type', 'object', 'context', 'reads', 'read_time', 'writes', 'write_time', 'extends', 'fsyncs'], tip: 'Enable track_io_timing. High reads can be healthy; latency and context tell you whether they hurt.' },
  { id: 'shmem', name: 'pg_shmem_allocations', kind: 'view', targets: ['shared-buffers'], since: '13', side: 'right', order: 40, summary: 'Named allocations in the main shared-memory segment.', columns: ['name', 'off', 'size', 'allocated_size'] },
  { id: 'slru-stat', name: 'pg_stat_slru', kind: 'view', targets: ['slru'], since: '13', side: 'right', order: 50, summary: 'Access, hit, read, write, flush, and truncate counters for each SLRU cache.', columns: ['name', 'blks_zeroed', 'blks_hit', 'blks_read', 'blks_written', 'flushes', 'truncates'] },
  { id: 'settings', name: 'pg_settings', kind: 'view', targets: ['postmaster'], since: '9.5', side: 'right', order: 60, summary: 'Runtime configuration values, sources, units, bounds, and restart requirements.', columns: ['name', 'setting', 'unit', 'source', 'pending_restart'], tip: 'The source column is often the fastest way to find why the running value differs from the file you edited.' },
  { id: 'backend-start', name: 'pg_postmaster_start_time()', kind: 'function', targets: ['postmaster'], since: '9.5', side: 'right', order: 70, summary: 'Timestamp when the postmaster started.', columns: ['timestamptz'] },
  { id: 'backend-type', name: 'backend_type', kind: 'view', targets: ['background-workers', 'postmaster'], since: '10', side: 'right', order: 80, summary: 'pg_stat_activity classification for client, maintenance, WAL, parallel, and extension processes.', columns: ['backend_type'] },
  { id: 'vacuum-progress', name: 'pg_stat_progress_vacuum', kind: 'view', targets: ['autovacuum-workers', 'table-usage'], since: '12', side: 'right', order: 90, summary: 'Current VACUUM phase and heap/index progress counters.', columns: ['pid', 'relid', 'phase', 'heap_blks_total', 'heap_blks_scanned', 'heap_blks_vacuumed', 'index_vacuum_count'], tip: 'No row means no VACUUM is currently reporting progress; it does not mean autovacuum is disabled.' },
  { id: 'analyze-progress', name: 'pg_stat_progress_analyze', kind: 'view', targets: ['autovacuum-workers', 'table-usage'], since: '13', side: 'right', order: 100, summary: 'Current ANALYZE phase and sample progress.', columns: ['pid', 'relid', 'phase', 'sample_blks_total', 'sample_blks_scanned', 'ext_stats_total', 'ext_stats_computed'] },
  { id: 'wal-stat', name: 'pg_stat_wal', kind: 'view', targets: ['wal'], since: '14', side: 'right', order: 110, summary: 'Cluster-wide WAL records, full-page images, bytes, writes, syncs, and timing.', columns: ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full', 'wal_write', 'wal_sync', 'wal_write_time', 'wal_sync_time'], tip: 'wal_buffers_full increasing rapidly is evidence that WAL buffers are too small or flushes cannot keep up.' },
  { id: 'current-lsn', name: 'pg_current_wal_lsn()', kind: 'function', targets: ['wal'], since: '10', side: 'right', order: 120, summary: 'Current WAL write location on a primary.', columns: ['pg_lsn'] },
  { id: 'lsn-diff', name: 'pg_wal_lsn_diff()', kind: 'function', targets: ['wal', 'wal-sender', 'wal-receiver', 'recovery'], since: '10', side: 'right', order: 130, summary: 'Byte distance between two WAL locations.', columns: ['lsn1', 'lsn2'], tip: 'Byte lag is concrete. Time lag can be NULL or misleading when the primary is idle.' },
  { id: 'archiver-stat', name: 'pg_stat_archiver', kind: 'view', targets: ['wal-archiver'], since: '9.5', side: 'right', order: 140, summary: 'Successful and failed WAL archive attempts and their most recent files.', columns: ['archived_count', 'last_archived_wal', 'last_archived_time', 'failed_count', 'last_failed_wal', 'stats_reset'], tip: 'One old failure is history. A growing failed_count or stale last_archived_time while WAL advances is an incident.' },
  { id: 'logfile', name: 'pg_current_logfile()', kind: 'function', targets: ['logger'], since: '10', side: 'right', order: 150, summary: 'Path of the current log collector output file.', columns: ['text'] },
  { id: 'logdir', name: 'pg_ls_logdir()', kind: 'function', targets: ['logger'], since: '10', side: 'right', order: 160, summary: 'Files, sizes, and modification times in log_directory.', columns: ['name', 'size', 'modification'] },
  { id: 'replication-stat', name: 'pg_stat_replication', kind: 'view', targets: ['wal-sender', 'network'], since: '9.5', side: 'right', order: 170, summary: 'One row per WAL sender with state, LSN positions, sync state, and reply time.', columns: ['pid', 'application_name', 'client_addr', 'state', 'sent_lsn', 'write_lsn', 'flush_lsn', 'replay_lsn', 'sync_state'], tip: 'Keep sent/write/flush/replay separate. They identify network, receiver disk, and replay bottlenecks.' },
  { id: 'slots', name: 'pg_replication_slots', kind: 'view', targets: ['logical-replication', 'wal-sender'], since: '9.5', side: 'right', order: 180, summary: 'Physical and logical replication slots and the WAL/catalog state they retain.', columns: ['slot_name', 'slot_type', 'active', 'restart_lsn', 'confirmed_flush_lsn', 'wal_status', 'safe_wal_size'], tip: 'An inactive slot can fill the disk. Alert on retained bytes, not merely active = false.' },
  { id: 'slot-stat', name: 'pg_stat_replication_slots', kind: 'view', targets: ['logical-replication'], since: '14', side: 'right', order: 190, summary: 'Logical decoding spill, stream, transaction, and byte counters by slot.', columns: ['slot_name', 'spill_txns', 'spill_bytes', 'stream_txns', 'stream_bytes', 'total_txns', 'total_bytes'] },
  { id: 'subscription', name: 'pg_stat_subscription', kind: 'view', targets: ['logical-replication', 'network'], since: '10', side: 'right', order: 200, summary: 'Logical subscription workers and their receive/apply positions.', columns: ['subid', 'subname', 'worker_type', 'pid', 'received_lsn', 'last_msg_send_time', 'latest_end_lsn'] },
  { id: 'subscription-stats', name: 'pg_stat_subscription_stats', kind: 'view', targets: ['logical-replication'], since: '15', side: 'right', order: 210, summary: 'Logical replication apply errors and conflict counters by subscription.', columns: ['subid', 'apply_error_count', 'sync_error_count', 'stats_reset'] },
  { id: 'receiver-stat', name: 'pg_stat_wal_receiver', kind: 'view', targets: ['wal-receiver', 'network'], since: '9.6', side: 'right', order: 220, summary: 'The standby WAL receiver connection and latest receive positions.', columns: ['pid', 'status', 'receive_start_lsn', 'written_lsn', 'flushed_lsn', 'latest_end_lsn', 'sender_host'] },
  { id: 'recovery-prefetch', name: 'pg_stat_recovery_prefetch', kind: 'view', targets: ['recovery', 'storage'], since: '15', side: 'right', order: 230, summary: 'WAL-replay block prefetch activity and misses during recovery.', columns: ['stats_reset', 'prefetch', 'hit', 'skip_init', 'skip_new', 'skip_fpw', 'skip_rep', 'wal_distance', 'block_distance', 'io_depth'] },
  { id: 'conflicts', name: 'pg_stat_database_conflicts', kind: 'view', targets: ['recovery'], since: '9.5', side: 'right', order: 240, summary: 'Standby query cancellations caused by recovery conflicts.', columns: ['datname', 'confl_tablespace', 'confl_lock', 'confl_snapshot', 'confl_bufferpin', 'confl_deadlock', 'confl_active_logicalslot'] },
  { id: 'bgwriter-stat', name: 'pg_stat_bgwriter', kind: 'view', targets: ['background-writer', 'shared-buffers'], since: '9.5', side: 'right', order: 250, summary: 'Background writer cleaning and allocation-pressure counters.', columns: ['buffers_clean', 'maxwritten_clean', 'buffers_alloc'], tip: 'From PG17, checkpoint counters moved to pg_stat_checkpointer. Version-aware tooling must not assume the old shape.' },
  { id: 'checkpointer-stat', name: 'pg_stat_checkpointer', kind: 'view', targets: ['checkpointer', 'storage'], since: '17', side: 'right', order: 260, summary: 'Checkpoint counts, timing, buffers written, and sync work.', columns: ['num_timed', 'num_requested', 'write_time', 'sync_time', 'buffers_written', 'slru_written'], tip: 'A high requested/timed ratio usually means WAL volume or manual checkpoints are forcing the schedule.' },
  { id: 'basebackup-progress', name: 'pg_stat_progress_basebackup', kind: 'view', targets: ['network', 'storage'], since: '13', side: 'bottom', order: 10, summary: 'Current base backup phase and bytes streamed.', columns: ['pid', 'phase', 'backup_total', 'backup_streamed', 'tablespaces_total', 'tablespaces_streamed'] },
  { id: 'relation-path', name: 'pg_relation_filepath()', kind: 'function', targets: ['data-files'], since: '9.5', side: 'bottom', order: 20, summary: 'Relative filesystem path for a relation’s main fork.', columns: ['relation regclass'], tip: 'Do not manipulate relation files directly. The path is for diagnosis, not DIY storage surgery.' },
  { id: 'sizes', name: 'pg_total_relation_size()', kind: 'function', targets: ['data-files', 'storage'], since: '9.5', side: 'bottom', order: 30, summary: 'Total bytes for a table including indexes and TOAST.', columns: ['relation regclass'] },
  { id: 'waldir', name: 'pg_ls_waldir()', kind: 'function', targets: ['wal', 'storage'], since: '10', side: 'bottom', order: 40, summary: 'Files, sizes, and modification times in pg_wal.', columns: ['name', 'size', 'modification'] },
  { id: 'file-stat', name: 'pg_stat_file()', kind: 'function', targets: ['storage', 'data-files'], since: '9.5', side: 'bottom', order: 50, summary: 'Metadata for a file visible to the server process.', columns: ['size', 'access', 'modification', 'change', 'creation', 'isdir'], tip: 'Access is privilege-restricted for good reason; never expose arbitrary server file access to application roles.' },
] as const

export const flows: readonly (readonly [string, string, string])[] = [
  ['clients', 'planning', 'SQL'],
  ['planning', 'execution', 'plan'],
  ['execution', 'index-usage', 'scan'],
  ['execution', 'table-usage', 'scan'],
  ['index-usage', 'buffers-io', 'pages'],
  ['table-usage', 'buffers-io', 'pages'],
  ['buffers-io', 'shared-buffers', 'cache'],
  ['execution', 'wal', 'changes'],
  ['shared-buffers', 'storage', 'dirty pages'],
  ['wal', 'wal-sender', 'stream'],
  ['wal', 'wal-archiver', 'archive'],
  ['wal-sender', 'network', 'WAL'],
  ['network', 'wal-receiver', 'WAL'],
  ['wal-receiver', 'recovery', 'replay'],
  ['recovery', 'data-files', 'pages'],
  ['checkpointer', 'shared-buffers', 'flush'],
  ['checkpointer', 'storage', 'sync'],
] as const

export function versionNumber(version: PgVersion): number {
  return Number(version)
}

export function probeAvailable(probe: Probe, version: PgVersion): boolean {
  const selected = versionNumber(version)
  return selected >= versionNumber(probe.since) && (!probe.until || selected <= versionNumber(probe.until))
}
