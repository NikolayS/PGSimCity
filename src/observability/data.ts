export type CategoryId = 'traffic' | 'query' | 'memory' | 'durability' | 'maintenance' | 'replication' | 'host'

export interface Category {
  id: CategoryId
  label: string
  color: number
}

export interface Probe {
  name: string
  kind: 'view' | 'function' | 'extension' | 'tool'
  note: string
}

export interface Subsystem {
  id: string
  label: string
  short: string
  category: CategoryId
  position: readonly [number, number, number]
  size: readonly [number, number, number]
  description: string
  probes: readonly Probe[]
}

export const categories: readonly Category[] = [
  { id: 'traffic', label: 'Traffic', color: 0x58d7ff },
  { id: 'query', label: 'Query', color: 0xb78cff },
  { id: 'memory', label: 'Memory & I/O', color: 0x56e6a5 },
  { id: 'durability', label: 'Durability', color: 0xffb94c },
  { id: 'maintenance', label: 'Maintenance', color: 0xff6fae },
  { id: 'replication', label: 'Replication', color: 0x7c9cff },
  { id: 'host', label: 'Host', color: 0xc4cedf },
] as const

export const subsystems: readonly Subsystem[] = [
  {
    id: 'postmaster',
    label: 'Postmaster',
    short: 'PM',
    category: 'traffic',
    position: [-13, 4.5, 6],
    size: [3.6, 9, 3.6],
    description: 'The parent process: starts the cluster, accepts connections, and supervises every server process.',
    probes: [
      { name: 'pg_postmaster_start_time()', kind: 'function', note: 'Cluster process start time.' },
      { name: 'pg_control_system()', kind: 'function', note: 'Control-file identity and state.' },
      { name: 'pg_settings', kind: 'view', note: 'The active server configuration.' },
    ],
  },
  {
    id: 'clients',
    label: 'Client backends',
    short: 'CLIENTS',
    category: 'traffic',
    position: [-13, 5.5, -5],
    size: [5.2, 11, 4.2],
    description: 'Sessions, states, transactions, and the network edge where application traffic enters Postgres.',
    probes: [
      { name: 'pg_stat_activity', kind: 'view', note: 'One row per server process and current activity.' },
      { name: 'pg_stat_database', kind: 'view', note: 'Database-wide workload and conflict counters.' },
      { name: 'pg_stat_ssl', kind: 'view', note: 'TLS details for connected backends.' },
      { name: 'pg_stat_gssapi', kind: 'view', note: 'GSSAPI authentication and encryption state.' },
    ],
  },
  {
    id: 'planner',
    label: 'Query planning',
    short: 'PLAN',
    category: 'query',
    position: [-7, 6.5, -5],
    size: [4.4, 13, 4.4],
    description: 'Parse, rewrite, cost, and choose a plan before execution begins.',
    probes: [
      { name: 'EXPLAIN', kind: 'tool', note: 'The chosen plan and its cost model.' },
      { name: 'pg_stat_statements', kind: 'extension', note: 'Normalized statement planning and execution statistics.' },
      { name: 'pg_prepared_statements', kind: 'view', note: 'Prepared statements visible in the current session.' },
    ],
  },
  {
    id: 'executor',
    label: 'Query execution',
    short: 'EXEC',
    category: 'query',
    position: [-1, 7.5, -5],
    size: [4.8, 15, 4.8],
    description: 'The live plan tree reads tuples, joins, sorts, aggregates, waits, and returns rows.',
    probes: [
      { name: 'EXPLAIN (ANALYZE, BUFFERS)', kind: 'tool', note: 'Actual row counts, timing, and buffer traffic.' },
      { name: 'pg_stat_progress_*', kind: 'view', note: 'Progress for long-running maintenance and utility commands.' },
      { name: 'pg_stat_user_functions', kind: 'view', note: 'Tracked function calls and execution time.' },
      { name: 'pg_stat_kcache', kind: 'extension', note: 'Per-query operating-system resource usage.' },
    ],
  },
  {
    id: 'locks',
    label: 'Locks & waits',
    short: 'LOCKS',
    category: 'query',
    position: [-5, 4, 3],
    size: [4.2, 8, 4.2],
    description: 'Coordination between concurrent backends: heavyweight locks, blockers, and wait events.',
    probes: [
      { name: 'pg_locks', kind: 'view', note: 'Outstanding and granted heavyweight locks.' },
      { name: 'pg_blocking_pids()', kind: 'function', note: 'Direct blockers for a backend PID.' },
      { name: 'wait_event / wait_event_type', kind: 'view', note: 'What an active process is waiting for.' },
      { name: 'pg_wait_sampling', kind: 'extension', note: 'Sampled wait-event history and profiles.' },
    ],
  },
  {
    id: 'indexes',
    label: 'Indexes',
    short: 'INDEX',
    category: 'memory',
    position: [5, 4.5, -8],
    size: [4.2, 9, 4.2],
    description: 'Index access paths, scan frequency, tuple fetches, and block-level I/O.',
    probes: [
      { name: 'pg_stat_all_indexes', kind: 'view', note: 'Scans and tuples read/fetched per index.' },
      { name: 'pg_statio_all_indexes', kind: 'view', note: 'Index block reads and cache hits.' },
      { name: 'pg_index_size()', kind: 'function', note: 'On-disk size of one index.' },
    ],
  },
  {
    id: 'tables',
    label: 'Tables',
    short: 'HEAP',
    category: 'memory',
    position: [5, 4.5, -2],
    size: [5.2, 9, 5.2],
    description: 'Heap access, tuple churn, dead rows, sequential scans, and table-level I/O.',
    probes: [
      { name: 'pg_stat_all_tables', kind: 'view', note: 'Scans, tuple churn, vacuum, and analyze state.' },
      { name: 'pg_statio_all_tables', kind: 'view', note: 'Heap, index, TOAST, and visibility-map I/O.' },
      { name: 'pg_table_size()', kind: 'function', note: 'Table storage excluding indexes.' },
      { name: 'pgstattuple', kind: 'extension', note: 'Physical tuple and free-space inspection.' },
    ],
  },
  {
    id: 'shared-buffers',
    label: 'Shared buffers',
    short: 'BUFFERS',
    category: 'memory',
    position: [5, 3.5, 5],
    size: [6.4, 7, 6.4],
    description: 'Postgres shared page cache: the working set between executor and storage.',
    probes: [
      { name: 'pg_buffercache', kind: 'extension', note: 'Inspect individual shared-buffer slots.' },
      { name: 'pg_stat_io', kind: 'view', note: 'I/O operations and timing by backend and object context.' },
      { name: 'pg_stat_database', kind: 'view', note: 'Database-wide block hits and reads.' },
    ],
  },
  {
    id: 'memory',
    label: 'Shared memory',
    short: 'SHMEM',
    category: 'memory',
    position: [0, 3.5, 8],
    size: [4.8, 7, 4.8],
    description: 'Shared allocations and SLRU caches used for transaction status, commit timestamps, and multixacts.',
    probes: [
      { name: 'pg_shmem_allocations', kind: 'view', note: 'Named shared-memory allocations.' },
      { name: 'pg_stat_slru', kind: 'view', note: 'Access, hit, read, write, and flush counters by SLRU.' },
    ],
  },
  {
    id: 'wal',
    label: 'Write-ahead log',
    short: 'WAL',
    category: 'durability',
    position: [12, 5.5, 1],
    size: [5.4, 11, 5.4],
    description: 'The durability stream: records changes before dirty data pages can reach permanent storage.',
    probes: [
      { name: 'pg_stat_wal', kind: 'view', note: 'WAL records, bytes, full-page images, writes, and syncs.' },
      { name: 'pg_current_wal_lsn()', kind: 'function', note: 'Current insert position in the WAL stream.' },
      { name: 'pg_wal_lsn_diff()', kind: 'function', note: 'Byte distance between two WAL positions.' },
      { name: 'pg_stat_archiver', kind: 'view', note: 'Archive success, failure, and last archived file.' },
    ],
  },
  {
    id: 'checkpointer',
    label: 'Checkpointer',
    short: 'CKPT',
    category: 'maintenance',
    position: [12, 4.5, 8],
    size: [4.2, 9, 4.2],
    description: 'Coordinates checkpoints and pushes dirty shared buffers toward durable storage.',
    probes: [
      { name: 'pg_stat_checkpointer', kind: 'view', note: 'Checkpoint timing and buffer-write counters.' },
      { name: 'pg_stat_bgwriter', kind: 'view', note: 'Background writer activity and allocation pressure.' },
    ],
  },
  {
    id: 'autovacuum',
    label: 'Autovacuum',
    short: 'VACUUM',
    category: 'maintenance',
    position: [0, 5, 15],
    size: [5, 10, 5],
    description: 'Reclaims dead tuples, advances freeze horizons, refreshes statistics, and prevents wraparound.',
    probes: [
      { name: 'pg_stat_progress_vacuum', kind: 'view', note: 'Live VACUUM phase and progress.' },
      { name: 'pg_stat_all_tables', kind: 'view', note: 'Dead tuples and last vacuum/analyze times.' },
      { name: 'pg_stat_progress_analyze', kind: 'view', note: 'Live ANALYZE phase and progress.' },
    ],
  },
  {
    id: 'replication',
    label: 'Replication',
    short: 'REPLICA',
    category: 'replication',
    position: [20, 6, 1],
    size: [5.6, 12, 5.6],
    description: 'WAL senders, receivers, slots, apply workers, and the lag between primary and replicas.',
    probes: [
      { name: 'pg_stat_replication', kind: 'view', note: 'Sender state and write/flush/replay positions.' },
      { name: 'pg_stat_wal_receiver', kind: 'view', note: 'Receiver connection and latest message state.' },
      { name: 'pg_replication_slots', kind: 'view', note: 'Slot retention, restart LSN, and activity.' },
      { name: 'pg_stat_subscription', kind: 'view', note: 'Logical subscription workers and received LSNs.' },
    ],
  },
  {
    id: 'storage',
    label: 'Storage files',
    short: 'PGDATA',
    category: 'durability',
    position: [12, 2.5, 15],
    size: [7.2, 5, 7.2],
    description: 'Heap, index, WAL, temporary, and configuration files below the database engine.',
    probes: [
      { name: 'pg_relation_filepath()', kind: 'function', note: 'Relative path for a relation fork.' },
      { name: 'pg_stat_file()', kind: 'function', note: 'File size, timestamps, and type.' },
      { name: 'pg_ls_waldir()', kind: 'function', note: 'WAL directory contents.' },
      { name: 'pg_database_size()', kind: 'function', note: 'Total disk space used by a database.' },
    ],
  },
  {
    id: 'logging',
    label: 'Logging',
    short: 'LOG',
    category: 'host',
    position: [6, 8, 15],
    size: [4.2, 16, 4.2],
    description: 'The server log is the event stream for errors, slow statements, checkpoints, connections, and more.',
    probes: [
      { name: 'pg_current_logfile()', kind: 'function', note: 'Current collector log path.' },
      { name: 'pg_ls_logdir()', kind: 'function', note: 'Server log directory contents.' },
      { name: 'pgBadger', kind: 'tool', note: 'Offline log analysis and reporting.' },
    ],
  },
  {
    id: 'host',
    label: 'Operating system',
    short: 'HOST',
    category: 'host',
    position: [20, 2.5, 12],
    size: [6.8, 5, 6.8],
    description: 'CPU, memory, scheduler, filesystem, block device, and network truth outside the Postgres process.',
    probes: [
      { name: 'iostat', kind: 'tool', note: 'Block-device throughput, latency, and saturation.' },
      { name: 'vmstat', kind: 'tool', note: 'CPU, run queue, memory, paging, and I/O overview.' },
      { name: 'pidstat', kind: 'tool', note: 'Per-process CPU, I/O, faults, and scheduling.' },
      { name: 'perf', kind: 'tool', note: 'CPU sampling and kernel/user stack profiling.' },
    ],
  },
] as const

export const connections: readonly (readonly [string, string])[] = [
  ['postmaster', 'clients'],
  ['postmaster', 'autovacuum'],
  ['postmaster', 'checkpointer'],
  ['clients', 'planner'],
  ['planner', 'executor'],
  ['executor', 'locks'],
  ['executor', 'indexes'],
  ['executor', 'tables'],
  ['indexes', 'shared-buffers'],
  ['tables', 'shared-buffers'],
  ['shared-buffers', 'memory'],
  ['shared-buffers', 'wal'],
  ['shared-buffers', 'storage'],
  ['wal', 'storage'],
  ['wal', 'replication'],
  ['checkpointer', 'shared-buffers'],
  ['checkpointer', 'storage'],
  ['autovacuum', 'tables'],
  ['clients', 'logging'],
  ['executor', 'logging'],
  ['storage', 'host'],
  ['replication', 'host'],
] as const
