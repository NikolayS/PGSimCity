import { poolBytes, poolPages } from '../core/types'
import { CLAIM_VALUES } from '../core/claims'
import type { BackendSim, BackendState, BookRef, ComponentDoc, DocRef, PlanNode, SimState, TableSim } from '../core/types'
import { fmtBytes, fmtDuration, fmtLsn, fmtNum, fmtPct } from '../core/util'

/* ============================================================================
 * DOCS_MEMORY — the running server.
 *
 * The cluster, the postmaster, the backends, the shared memory segment, and the
 * query lab. This is the half of the city that lives in RAM.
 * ==========================================================================*/

/* ------------------------------ helpers ------------------------------ */

const nz = (v: number | undefined | null): number =>
  typeof v === 'number' && isFinite(v) ? v : 0

const ratio = (a: number, b: number): number => (b > 0 ? nz(a) / b : 0)

const poolSize = (s: SimState): string => fmtBytes(poolBytes(s.knobs))

/** Count active backends sitting in any of the given states. */
function nIn(s: SimState, ...states: BackendState[]): number {
  let n = 0
  for (const b of s.backends ?? []) {
    if (b && b.active && states.includes(b.state)) n++
  }
  return n
}

function countBackends(s: SimState, pred: (b: BackendSim) => boolean): number {
  let n = 0
  for (const b of s.backends ?? []) {
    if (b && pred(b)) n++
  }
  return n
}

function sumTables(s: SimState, f: (t: TableSim) => number): number {
  let n = 0
  for (const t of s.tables ?? []) {
    if (t) n += nz(f(t))
  }
  return n
}

function worstBloat(s: SimState): { name: string; bloat: number } {
  let best = { name: '—', bloat: 0 }
  for (const t of s.tables ?? []) {
    if (t && nz(t.bloat) > best.bloat) best = { name: t.def?.name ?? '?', bloat: nz(t.bloat) }
  }
  return best
}

function firstPlan(s: SimState): PlanNode | null {
  for (const b of s.backends ?? []) {
    if (b && b.active && b.plan) return b.plan
  }
  return null
}

function countPlanNodes(n: PlanNode | null | undefined, depth = 0): number {
  if (!n || depth > 32) return 0
  let c = 1
  for (const kid of n.children ?? []) c += countPlanNodes(kid, depth + 1)
  return c
}

/** States that mean "this backend is doing work right now". */
const BUSY: BackendState[] = ['parse', 'plan', 'exec_cpu', 'exec_io', 'sort', 'wal_insert', 'eviction_flush', 'commit_wait', 'blocked', 'sending']

/* ---------------------------- reference helpers ---------------------------
 * The reading list under each component. Every entry here was checked against
 * the thing it points at — the manual page title, the file on the target branch, the
 * function name inside it, the chapter number on interdb.jp. A reference
 * nobody checked is worse than no reference, so where a book genuinely has no
 * chapter on a subject, the field is simply absent.
 * -------------------------------------------------------------------------*/

const DOCS_BASE = CLAIM_VALUES.postgresqlVersion.manualBase
const SRC_BASE = 'https://github.com/postgres/postgres/blob/'
const SUZUKI_BASE = 'https://www.interdb.jp/pg/'

/** A page of the PostgreSQL manual. `page` may carry a #ANCHOR. */
const manual = (page: string, label: string): DocRef => ({ label, url: DOCS_BASE + page })

/** A file on the owned PostgreSQL branch, with the functions worth opening. */
const srcFile = (path: string, symbol?: string): DocRef => ({
  label: path,
  url: `${SRC_BASE}${CLAIM_VALUES.postgresqlVersion.sourceBranch}/${path}`,
  symbol,
})

/** A chapter of Hironobu Suzuki's *The Internals of PostgreSQL*, free online. */
const suzuki = (n: number, label: string): DocRef & { chapter: string } => ({
  chapter: String(n),
  label,
  url: `${SUZUKI_BASE}pgsql${String(n).padStart(2, '0')}/index.html`,
})

/**
 * A chapter of Egor Rogov's *PostgreSQL 14 Internals*. A book: cited, never
 * linked. Chapters are named, not numbered — the publisher's own contents list
 * gives the titles, and a chapter number nobody re-checked is exactly the kind
 * of confident wrong detail this apparatus exists to avoid.
 */
const ROGOV_EDITION = 'PostgreSQL 14 Internals — Egor Rogov, Postgres Professional'
const R_MVCC = 'Part I. Isolation and MVCC'
const R_WAL = 'Part II. Buffer Cache and WAL'
const R_LOCKS = 'Part III. Locks'
const R_EXEC = 'Part IV. Query Execution'
const rogov = (part: string, chapter: string, confidence?: string): BookRef => ({
  edition: ROGOV_EDITION,
  part,
  chapter,
  confidence,
})

/* ------------------------------ the docs ------------------------------ */

export const DOCS_MEMORY: ComponentDoc[] = [
  /* ======================================================================
   * The world
   * ====================================================================*/
  {
    id: 'world.ground',
    title: 'PGSimCity',
    subtitle: 'one cluster — one postmaster, one shared memory segment, one data directory',
    tldr: 'One data directory, one shared memory segment, and a separate OS process for every connection.',
    sections: [
      {
        heading: 'What a cluster actually is',
        body:
          "A Postgres *cluster* has nothing to do with a group of machines. It is one data directory, one supervisor process listening on one port, one shared memory segment, and any number of databases living inside it. `initdb` creates the directory; `pg_ctl start` launches the supervisor; everything else in this city is either a process attached to that segment or a file under that directory. When people say a Postgres server, this is the thing they mean.",
      },
      {
        heading: 'One process per connection',
        body:
          'When a client connects, the supervisor forks a brand new operating system process to serve it, and that process serves only that connection until it disconnects. There is no thread pool, no dispatcher, no work queue. A backend is a full Unix process with its own address space, its own file descriptors, and its own scheduler entry. This design is old, it is deliberate, and it is the single fact that explains most of Postgres behaviour.',
      },
      {
        heading: 'Why that decision explains everything else',
        body:
          "Because backends are processes, every memory setting that is not in the shared segment is *per process*: `work_mem` is charged per operation per backend, not per server. Because they are separate address spaces, there is no shared plan cache and no shared catalog cache — each backend warms its own. Because forking plus authentication plus catalog loading is expensive, connection poolers exist. And because one process writing off the end of an array can corrupt shared memory that everyone else is using, a crash in any backend takes the whole cluster down and restarts it.",
      },
      {
        heading: 'The two things that are not ephemeral',
        body:
          'Processes come and go; two things persist. The shared memory segment holds `shared_buffers`, the WAL buffers, the process array, the lock tables, the SLRU caches and the cumulative statistics — it is sized at startup and cannot grow. The data directory holds `base/` (one subdirectory per database), `global/` (cluster-wide catalogs), `pg_wal/` (the write-ahead log) and `pg_xact/` (commit status). Durability is entirely a story about getting the right bytes from the first into the second in the right order.',
      },
      {
        heading: 'What you would see in production',
        body:
          'On a real box, `ps` shows one `postgres` parent and a long list of children: `checkpointer`, `background writer`, `walwriter`, `autovacuum launcher`, `logical replication launcher`, plus one process per client. `pg_stat_activity` has exactly one row per backend. If the Linux OOM killer picks off any one of those children, every connection dies at once and the server log says the database system is in recovery mode. That is not a bug; it is the price of the shared segment.',
      },
      {
        heading: 'What the city represents',
        body:
          'The city uses buildings for PostgreSQL processes and files, but the engine stores aggregate counters, fixed backend activity slots, representative buffer/WAL samples and selected maintenance/replication state. It does not create operating-system processes, address spaces, sockets, shared-memory mappings or a filesystem, and those architectural metaphors do not add their real resource costs.',
      },
    ],
    metrics: [
      { label: 'Backend slots', get: (s) => `${fmtNum(nz(s.stats?.activeBackends))} / ${fmtNum(nz(s.maxConnections))}`, hint: 'modeled occupied slots / fixed capacity' },
      { label: 'Throughput', get: (s) => `${fmtNum(nz(s.stats?.tps))} tps` },
      { label: 'Uptime', get: (s) => fmtDuration(nz(s.t)), hint: 'simulated time since startup' },
      { label: 'Next xid', get: (s) => fmtNum(nz(s.xid)) },
      { label: 'Cache hit', get: (s) => fmtPct(nz(s.buffers?.hitRatio)), hint: 'pages found in shared_buffers' },
    ],
    knobs: ['tps', 'writeRatio', 'paused'],
    see: ['postmaster', 'shmem.deck', 'backend.row', 'world.pit'],
    source: ['src/backend/postmaster/postmaster.c'],
    refs: {
      docs: [
        manual('creating-cluster.html', '18.2. Creating a Database Cluster'),
        manual('tutorial-arch.html', '1.2. Architectural Fundamentals'),
      ],
      source: [srcFile('src/backend/postmaster/postmaster.c', 'PostmasterMain')],
      suzuki: suzuki(1, 'Database Cluster, Databases and Tables'),
      rogov: rogov(R_MVCC, 'Introduction — data organization, processes and memory'),
    },
  },

  {
    id: 'world.pit',
    title: 'The Excavation',
    subtitle: 'the boundary between memory and disk',
    tldr: 'Everything above the line is RAM, everything below is durable — and the gap is a hundred thousand times.',
    sections: [
      {
        heading: 'One line, two worlds',
        body:
          'Postgres moves data in fixed 8 KiB pages, and a page can be served from three places: `shared_buffers`, the operating system page cache, or the storage device. Those are layers, not alternatives — Postgres does ordinary buffered file I/O, so a page pulled into `shared_buffers` usually leaves a copy in the OS cache, with a version on disk underneath it (an older one, until the dirty page is written back). What decides your latency is the shallowest layer that still holds the page. Reading a page from shared memory is a pointer dereference measured in nanoseconds. Reading it from the OS cache costs a syscall and a copy, typically single-digit microseconds. Reading it from an NVMe device is typically tens to hundreds of microseconds, and from network storage, milliseconds. Those gaps are not a detail of the implementation — they are the shape of every performance problem you will ever have.',
      },
      {
        heading: 'Why almost every question reduces to this',
        body:
          'When a query is slow, there are only a few candidate answers, and most of them are about this boundary: the page was not cached and had to be fetched; there were far more pages than expected because the estimate was wrong; the page was dirty and someone had to write it before it could be reused; or the transaction had to wait for bytes to be flushed before it could report success. Everything else — planning, locking, parsing — is usually noise next to crossing this line.',
      },
      {
        heading: 'The direction of travel matters',
        body:
          "Pages come *up* lazily: nothing is preloaded, a page is read when someone asks for it. Pages go *down* reluctantly: a modified page can sit dirty in memory for a long time, because writing it early wastes I/O if it will be modified again. What is not lazy is the write-ahead log. The rule is that the WAL record describing a change must reach durable storage before the changed data page may be written down. That ordering is the whole reason a crash is survivable, and it is why the WAL district gets its own dedicated processes.",
      },
      {
        heading: 'What you would see in production',
        body:
          'A cache miss is not the end of the world; a *storm* of them is. In `pg_stat_io` you can see reads attributed to client backends and to autovacuum workers separately — and note that the checkpointer and the background writer never read pages at all, so their `reads` cells are NULL. When a table stops fitting in memory, latency does not degrade gently — it steps, because a plan that was doing random index lookups against RAM is now doing random reads against a device. The same query, the same plan, ten to a hundred times slower.',
      },
      {
        heading: 'What the city measures',
        body:
          'The excavation receives representative shared-buffer-miss routes and exposes sampled read/write rates, shared storage pressure and rolling model-time latency quantiles. The buffer-read value is the p99 of that component’s own distribution, not one total-p99 trip’s anatomy. The OS-cache branch is a renderer choice only: it does not keep kernel-cache contents, change model duration or distinguish a device read. Nothing here is calibrated device latency, and fixed plan templates cannot become slower because estimates changed.',
      },
    ],
    metrics: [
      { label: 'Buffer pool', get: poolSize, hint: 'shared_buffers; the plaza is a representative frame sample' },
      { label: 'Hit ratio', get: (s) => fmtPct(nz(s.buffers?.hitRatio)) },
      { label: 'Reads', get: (s) => `${fmtNum(nz(s.stats?.ioReadPerSec))} pages/s`, hint: 'modeled shared-buffer-miss reads; OS-cache animation does not alter this counter' },
      {
        label: 'Writes (sample)',
        get: (s) => `${fmtNum(nz(s.stats?.ioWritePerSec))} frames/s`,
        hint: 'write activity inside the representative sample, not a full-stream page rate',
      },
      {
        label: 'Dirty sample',
        get: (s) => `${fmtNum(nz(s.buffers?.dirtyCount))} (${fmtPct(ratio(nz(s.buffers?.dirtyCount), nz(s.buffers?.sampleFrames)))})`,
        hint: 'sampled frames modified in memory, not yet written',
      },
    ],
    knobs: ['sharedBuffers', 'seqScanRatio', 'checkpointTimeout'],
    see: ['shared.buffers', 'buf.mapping', 'world.ground'],
    source: ['src/backend/storage/buffer/bufmgr.c', 'src/backend/storage/smgr/md.c'],
    refs: {
      docs: [
        manual('runtime-config-resource.html', '19.4. Resource Consumption'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_io'),
      ],
      source: [
        srcFile('src/backend/storage/buffer/bufmgr.c', 'ReadBuffer_common, FlushBuffer'),
        srcFile('src/backend/storage/smgr/md.c', 'mdreadv, mdwritev'),
      ],
      suzuki: suzuki(8, 'Buffer Manager (§8.1, §8.4)'),
      rogov: rogov(R_WAL, 'Buffer Cache — cache hits and cache misses'),
    },
  },

  /* ======================================================================
   * Clients and the front door
   * ====================================================================*/
  {
    id: 'client.pool',
    title: 'Client Connections',
    subtitle: 'application traffic, and what each connection costs',
    tldr: 'A connection is an OS process, a shared-memory slot and a few megabytes — not a cheap handle.',
    sections: [
      {
        heading: 'What a connection costs',
        body:
          'Opening a connection means a TCP handshake, an authentication exchange, a `fork()`, and then the new backend loading enough catalog rows to be able to parse a query at all. Once running it holds an OS process, a slot in the process array, a lock table budget, and its own catalog and plan caches which grow as it sees new queries. A busy connection that has been alive for a day can hold a surprising amount of private memory, and none of it is shared with the other thousand connections doing the same thing.',
      },
      {
        heading: 'Why poolers exist',
        body:
          'Applications open connections per worker thread and hold them idle, so a fleet of app servers can easily demand thousands of connections from a database with sixteen cores. PostgreSQL can accept them and then spend time context switching and contending over shared structures instead of running queries. PgBouncer transaction mode multiplexes many client connections onto fewer PostgreSQL backends. It does not change an assigned statement’s plan or executor cost, but connection reuse removes repeated connect, authentication and backend-startup work, while bounding actual backend concurrency can reduce elapsed time during overload.',
      },
      {
        heading: 'max_connections is a memory commitment',
        body:
          'It is not a rate limit, it is a sizing parameter. Several fixed-size shared memory structures are allocated at startup in proportion to the configured ceiling — the process array, the heavyweight lock table (`max_locks_per_transaction` multiplied by the connection budget), predicate lock space, and per-backend slots. That startup allocation is why changing it requires a restart. Runtime cost instead follows actually connected backends and contention: `GetSnapshotData` walks active ProcArray entries, and a larger preallocated lock table does not by itself make every hash lookup slower.',
      },
      {
        heading: 'What you would see in production',
        body:
          "The classic shape is a system that is fine at 200 connections and falls over at 600, with CPU dominated by system time and `pg_stat_activity` full of sessions in state 'idle'. Idle is not free: an idle session still owns a process and a slot, and an idle session inside a transaction is far worse — it holds its locks and, once it has written anything or is holding a snapshot open, holds back cleanup for every table in its database. Set `idle_in_transaction_session_timeout` so a forgotten transaction cannot do that indefinitely.",
      },
      {
        heading: 'What the city models',
        body:
          `The city has sixteen backend slots, a fixed startup cadence, direct and pooled client admission, one PgBouncer-shaped pool and achieved TPS. In the connection-storm experiment it charges an uncalibrated concurrency-pressure curve from the PostgreSQL backends actually connected, never from rejected or pool-waiting clients, and attributes modeled transaction hand-off or initial session-assignment wait to the Latency vital. That experiment removes its modeled direct connection churn when pooling is enabled, but the city does not separately price TCP, authentication, backend memory, catalog or plan-cache warming, real operating-system scheduling or ProcArray scans. ${CLAIM_VALUES.connectionPooler.coverageDisclosure}`,
      },
    ],
    metrics: [
      { label: 'Connections', get: (s) => `${fmtNum(nz(s.stats?.activeBackends))} / ${fmtNum(nz(s.maxConnections))}` },
      { label: 'Slots used', get: (s) => fmtPct(ratio(nz(s.stats?.activeBackends), nz(s.maxConnections))) },
      { label: 'Idle', get: (s) => fmtNum(nIn(s, 'idle')), hint: "connected, no query running" },
      { label: 'Idle in transaction', get: (s) => fmtNum(nIn(s, 'idle_in_xact')), hint: 'holding locks and possibly the horizon' },
      { label: 'Offered load', get: (s) => `${fmtNum(nz(s.knobs?.tps))} tps` },
      { label: 'Application clients', get: (s) => fmtNum(s.pooler.clientConnections) },
      { label: 'Pool mode', get: (s) => s.pooler.mode },
    ],
    knobs: ['tps', 'clientConnections', 'poolMode', 'defaultPoolSize', 'maxClientConn', 'queryWaitTimeout', 'writeRatio'],
    see: ['client.pooler', 'conn.gate', 'postmaster', 'backend.row', 'xmin.horizon'],
    source: ['src/backend/postmaster/postmaster.c'],
    refs: {
      docs: [manual('runtime-config-connection.html', '19.3. Connections and Authentication — max_connections')],
      source: [srcFile('src/backend/postmaster/postmaster.c', 'BackendStartup')],
      suzuki: suzuki(2, 'Process and Memory Architecture'),
    },
  },

  {
    id: 'client.pooler',
    title: 'PgBouncer Pooler',
    subtitle: 'many client connections, few PostgreSQL server processes',
    tldr: 'A pooler bounds PostgreSQL concurrency and moves excess work into an explicit client-side queue.',
    sections: [
      {
        heading: 'What pooling can and cannot speed up',
        body:
          'PgBouncer does not change the plan or executor cost of a statement after a server connection accepts it. Reusing connections does remove repeated connect, authentication and backend-startup cost, and limiting active PostgreSQL backends can reduce an individual query’s elapsed time during overload. When demand exceeds the server pool, clients wait for a pool slot instead of creating another PostgreSQL process.',
      },
      {
        heading: 'Transaction versus session pooling',
        body: CLAIM_VALUES.connectionPooler.transactionTradeoff,
      },
      {
        heading: 'The queue and connection controls',
        body:
          `PgBouncer's \`pool_mode\` chooses the release boundary and defaults to \`${CLAIM_VALUES.connectionPooler.pgBouncerDefaults.poolMode}\`. \`default_pool_size\` targets server connections per user/database pair and defaults to ${CLAIM_VALUES.connectionPooler.pgBouncerDefaults.defaultPoolSize}; \`max_client_conn\` caps client connections across the PgBouncer process and defaults to ${CLAIM_VALUES.connectionPooler.pgBouncerDefaults.maxClientConn}. \`query_wait_timeout\` defaults to ${CLAIM_VALUES.connectionPooler.pgBouncerDefaults.queryWaitTimeoutSeconds} seconds: expiry disconnects the waiting client, while zero queues indefinitely. PgBouncer does not coordinate its target with PostgreSQL \`max_connections\`. All user/database pools, reserve connections, PgBouncer processes and bypass clients must collectively leave PostgreSQL headroom, including slots protected by \`superuser_reserved_connections\` and \`reserved_connections\`.`,
      },
      {
        heading: 'How an operator sees the boundary',
        body:
          'PgBouncer SHOW POOLS reports `cl_active`, `cl_waiting`, `sv_active` and `sv_idle`. `cl_active` includes idle clients that have no query waiting, not only clients executing a statement. PostgreSQL `pg_stat_activity` still has one row per PostgreSQL server process, not one row per application client. A larger PgBouncer client count beside fewer PostgreSQL client backends is evidence that multiplexing is working. pgcat and Odyssey are alternatives with different feature sets; this city does not model either implementation.',
      },
      {
        heading: 'What the city leaves absent',
        body: `${CLAIM_VALUES.connectionPooler.coverageDisclosure} Explicitly absent: ${CLAIM_VALUES.connectionPooler.absent.join('; ')}.`,
      },
    ],
    metrics: [
      { label: 'Mode', get: (s) => s.pooler.mode },
      { label: 'Clients', get: (s) => `${fmtNum(s.pooler.acceptedClients)} admitted · ${fmtNum(s.pooler.refusedClients)} refused` },
      { label: 'Bound sessions', get: (s) => fmtNum(s.pooler.boundClients), hint: 'session mode only; binding lasts for the modeled client connection lifetime' },
      { label: 'Waiting', get: (s) => `${fmtNum(s.pooler.waitingClients)} clients` },
      { label: 'Queued transactions', get: (s) => fmtNum(s.stats.poolerQueuedTransactions) },
      { label: 'Wait timeouts', get: (s) => `${fmtNum(s.stats.poolerQueryWaitTimeouts)} queries · ${fmtNum(s.pooler.disconnectedClients)} clients disconnected`, hint: 'cumulative since reset; query_wait_timeout=0 disables expiry' },
      { label: 'PostgreSQL backends', get: (s) => `${fmtNum(s.pooler.serverConnections)} / ${fmtNum(s.pooler.serverCapacity)} capacity` },
      { label: 'PgBouncer server target', get: (s) => `${fmtNum(s.pooler.serverLimit)} · ${fmtNum(s.pooler.serverConnectionErrors)} unavailable` },
      { label: 'Pool-slot p99', get: (s) => `${fmtNum(s.stats.latency.p99.waits.poolSlotMs)} model ms`, hint: 'transaction hand-off or initial session-assignment estimate; absent in direct mode' },
    ],
    knobs: ['clientConnections', 'poolMode', 'defaultPoolSize', 'maxClientConn', 'queryWaitTimeout'],
    see: ['client.pool', 'postmaster', 'backend.row'],
    refs: {
      docs: [
        { label: 'PgBouncer configuration', url: 'https://www.pgbouncer.org/config' },
        { label: 'PgBouncer feature map by pool mode', url: 'https://www.pgbouncer.org/features.html' },
        manual('monitoring-stats.html', '27.2.3. pg_stat_activity — one row per server process'),
      ],
      source: [],
    },
  },

  {
    id: 'conn.gate',
    title: 'The Gate',
    subtitle: 'authentication and pg_hba.conf',
    tldr: 'Every connection is matched against pg_hba.conf top to bottom, and the first matching line decides.',
    sections: [
      {
        heading: 'How the decision is made',
        body:
          'Before a backend runs a single query it must be told who it is. The file `pg_hba.conf` — host-based authentication — is a list of rules with five fields: connection type, database, user, client address, and method. Postgres walks it from the top and the *first* line that matches all four selectors wins. If that line rejects the connection, no later line can save it, which is why an over-broad rule near the top is the usual cause of an authentication mystery.',
      },
      {
        heading: 'The methods that matter',
        body:
          'Use `scram-sha-256` for passwords; `md5` is long superseded and should not be used for new deployments. `peer` and `trust` skip passwords entirely — `peer` matches the operating system user on a local socket, which is normal for a local superuser shell, while `trust` means literally anyone who can reach the port. `cert`, `ldap` and `gss` exist for the environments that need them. Whatever you choose, TLS is a separate axis: `hostssl` versus `host` decides whether the connection must be encrypted.',
      },
      {
        heading: 'What you would see in production',
        body:
          'Changes take effect on reload, not restart: `SELECT pg_reload_conf()` or a SIGHUP. Before reloading, check your edit against the parsed view `pg_hba_file_rules`, which shows exactly how the server understood each line and flags the ones it could not parse. When a client is refused, the server log has the real reason — the message the client receives is deliberately vague.',
      },
      {
        heading: 'What the city models',
        body:
          'The gate admits work only when a fixed backend slot is available and counts accepted starts. It has no `pg_hba.conf` rules, users, databases, addresses, TLS, credentials, authentication methods or authentication failures; every non-capacity verdict is absent.',
      },
    ],
    metrics: [
      { label: 'Connected', get: (s) => fmtNum(nz(s.stats?.activeBackends)) },
      { label: 'Free slots', get: (s) => fmtNum(Math.max(0, nz(s.maxConnections) - nz(s.stats?.activeBackends))) },
      { label: 'Arrival rate', get: (s) => `${fmtNum(nz(s.knobs?.tps))} tps` },
    ],
    knobs: ['tps'],
    see: ['client.pool', 'postmaster', 'backend.slot'],
    source: ['src/backend/postmaster/postmaster.c'],
    refs: {
      docs: [
        manual('auth-pg-hba-conf.html', '20.1. The pg_hba.conf File'),
        manual('auth-methods.html', '20.3. Authentication Methods'),
      ],
      source: [
        srcFile('src/backend/libpq/hba.c', 'parse_hba_line, check_hba'),
        srcFile('src/backend/libpq/auth.c', 'ClientAuthentication'),
      ],
    },
  },

  /* ======================================================================
   * Postmaster
   * ====================================================================*/
  {
    id: 'postmaster',
    title: 'Postmaster',
    subtitle: 'supervisor process — forks everything, owns no data',
    tldr: 'It listens, forks a backend per connection, supervises the background processes, and rebuilds the world after a crash.',
    sections: [
      {
        heading: 'What it actually does',
        body:
          'The postmaster is the process you start and the one whose pid is in `postmaster.pid`. Its job list is short: create the shared memory segment, start the fixed background processes, listen on the socket, and for each accepted connection start a child that will handle it. That child reads the startup packet, selects the `pg_hba.conf` rule and authenticates the client before entering the query loop. The postmaster does not authenticate the user, parse SQL or read tables; everything a user experiences is done by one of its children.',
      },
      {
        heading: 'Why it deliberately touches nothing',
        body:
          'The postmaster creates shared memory before forking so every child inherits the same mapping, but it goes out of its way not to read or write the structures inside it. The reason is availability: if the supervisor itself could be corrupted by a bad page or a stuck lock, there would be nobody left to restart the system. It keeps its own state minimal so that it can survive anything its children do to themselves.',
      },
      {
        heading: 'Crash and restart',
        body:
          "When any child exits abnormally — a segmentation fault, a `SIGKILL` from the OOM killer, an `immediate` shutdown — the postmaster assumes shared memory may now be inconsistent. It sends SIGQUIT to every remaining child, waits for them to go, resets the shared segment and starts crash recovery from the last checkpoint. This is why one killed backend disconnects every session in the cluster. `restart_after_crash` controls whether it comes back automatically; leave it on unless something outside is managing failover.",
      },
      {
        heading: 'What you would see in production',
        body:
          'In the server log this looks like a terse sequence: a message that a server process was terminated by signal 9, then that the server is terminating all other active server processes, then that all connections were closed because another server process exited abnormally, then the database system is in recovery mode. Applications see every connection drop at the same instant. Recovery time is bounded by how much WAL was written since the last checkpoint, which is exactly what `checkpoint_timeout` and `max_wal_size` are trading against.',
      },
      {
        heading: 'What the city models',
        body:
          'A connection pulse starts one backend after a fixed delay. Socket negotiation, startup packets, database selection, `pg_hba.conf`, authentication methods, process memory and failure during startup are not simulated.',
      },
    ],
    metrics: [
      { label: 'Children', get: (s) => `${fmtNum(nz(s.stats?.activeBackends))} backends` },
      { label: 'Slots', get: (s) => `${fmtNum(nz(s.stats?.activeBackends))} / ${fmtNum(nz(s.maxConnections))}` },
      { label: 'Autovacuum', get: (s) => (s.autovac?.enabled ? 'launcher running' : 'off'), hint: 'the launcher is a postmaster child' },
      {
        label: 'Standby A',
        get: (s) => {
          const standbyA = s.replication.standbys[0]
          return standbyA.connected ? 'streaming' : standbyA.enabled ? 'disconnected' : 'none'
        },
      },
      { label: 'Uptime', get: (s) => fmtDuration(nz(s.t)) },
    ],
    knobs: ['tps', 'autovacuum', 'standbyAEnabled'],
    see: ['conn.gate', 'backend.row', 'shmem.deck', 'world.ground'],
    source: ['src/backend/postmaster/postmaster.c'],
    refs: {
      docs: [
        manual('tutorial-arch.html', '1.2. Architectural Fundamentals'),
        manual('runtime-config-connection.html', '19.3. Connections and Authentication'),
      ],
      source: [
        srcFile('src/backend/postmaster/postmaster.c', 'PostmasterMain, BackendStartup, HandleChildCrash'),
        srcFile('src/backend/tcop/backend_startup.c', 'BackendMain, BackendInitialize'),
        srcFile('src/backend/libpq/auth.c', 'ClientAuthentication'),
      ],
      suzuki: suzuki(2, 'Process and Memory Architecture (§2.1)'),
      rogov: rogov(R_MVCC, 'Introduction — processes and memory'),
    },
  },

  /* ======================================================================
   * Backends
   * ====================================================================*/
  {
    id: 'backend.row',
    title: 'Backend District',
    subtitle: 'one OS process per connection',
    tldr: 'Each tower is one backend process: private memory of its own, one shared memory segment between them all.',
    sections: [
      {
        heading: 'Peers, not workers',
        body:
          'There is no coordinator here. Each backend received its socket from the postmaster and from then on runs independently: it parses, plans, executes, writes WAL, and even writes dirty pages to disk when it has to. Nothing routes work between them. Two backends only interact through shared memory — the buffer pool, the lock tables, the process array — and through the short-lived lightweight locks that protect those structures.',
      },
      {
        heading: 'Private memory versus shared memory',
        body:
          'Everything a backend allocates for its own query lives in its own address space: the plan, the tuple slots, the sort space, the catalog cache, the plan cache. That memory is invisible to the rest of the cluster and is returned to the OS when the process exits. The only memory they share is the one segment mapped at startup. This is the reason `work_mem` is dangerous at scale and `shared_buffers` is not: one is multiplied by concurrency, the other is fixed.',
      },
      {
        heading: 'What concurrency really costs',
        body:
          'More backends do not mean more throughput past a point. Each running backend competes for CPU, for the same buffer mapping partition locks, and for the same lock table partitions; each transaction takes snapshots that must scan the process array. Past roughly a small multiple of the core count, added connections increase latency without increasing completed work — the classic throughput curve that rises, flattens, and then falls.',
      },
      {
        heading: 'What you would see in production',
        body:
          'One row per backend in `pg_stat_activity`, with `state`, `wait_event_type` and `wait_event` telling you what each one is doing right now. Grouping that view by wait event is the fastest diagnostic in Postgres: a wall of `LWLock` says shared memory contention, a wall of `Lock` says one transaction is blocking many, and a wall of `IO` says you have left the memory side of the excavation.',
      },
      {
        heading: 'What the city charges and leaves out',
        body:
          `The city has sixteen fixed slots, a fixed fork cadence and, when the application fleet exceeds max_connections, an uncalibrated pressure curve once more than ${CLAIM_VALUES.connectionPooler.concurrencyTarget} PostgreSQL backends are active. That aggregate curve makes a concurrency cap measurable but does not identify a PostgreSQL wait. Backend memory, authentication, real scheduler/context-switch work, shared-lock contention and ProcArray scans remain absent.`,
      },
    ],
    metrics: [
      { label: 'Active', get: (s) => `${fmtNum(nIn(s, ...BUSY))} running` },
      { label: 'Idle', get: (s) => fmtNum(nIn(s, 'idle')) },
      { label: 'Idle in transaction', get: (s) => fmtNum(nIn(s, 'idle_in_xact')) },
      { label: 'Blocked on a lock', get: (s) => fmtNum(nIn(s, 'blocked')) },
      { label: 'Slots in use', get: (s) => `${fmtNum(countBackends(s, (b) => b.active))} / ${fmtNum((s.backends ?? []).length)}` },
    ],
    knobs: ['tps', 'writeRatio', 'updateRatio'],
    see: ['backend.slot', 'backend.localmem', 'shmem.deck', 'postmaster'],
    source: ['src/backend/postmaster/postmaster.c', 'src/backend/executor/execMain.c'],
    refs: {
      docs: [
        manual('tutorial-arch.html', '1.2. Architectural Fundamentals'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_activity'),
      ],
      source: [
        srcFile('src/backend/postmaster/postmaster.c', 'BackendStartup'),
        srcFile('src/backend/tcop/postgres.c', 'PostgresMain'),
      ],
      suzuki: suzuki(2, 'Process and Memory Architecture (§2.1)'),
      rogov: rogov(R_MVCC, 'Introduction — processes and memory'),
    },
  },

  {
    id: 'backend.slot',
    title: 'Backend',
    subtitle: 'one connection, one process, one transaction at a time',
    tldr: 'A single backend process: parse, rewrite, plan, execute, commit — then wait for the next statement.',
    sections: [
      {
        heading: 'The loop it runs',
        body:
          'After the fork and authentication, a backend enters a loop it will run until the client disconnects: read a message from the socket, and if it is a query, parse the text, rewrite it against views and policies, plan it, execute it, stream the rows back, then send ready-for-query and wait. In the extended protocol the client can split this into Parse, Bind and Execute and reuse a prepared statement, which skips the parse and often the planning too. Between statements the backend is idle and holds nothing but its process, its caches and its connection.',
      },
      {
        heading: 'Every state this tower can be in',
        body:
          "The tower uses simulated phases: `parse`, `plan`, `exec_cpu`, `exec_io`, `sort`, `wal_insert`, `commit_wait`, `blocked` and `sending`. They make a statement's path visible, but they are not values of `pg_stat_activity.state`. In a real server, `state` and the independently reported `wait_event_type` / `wait_event` must be read together: an active backend may move between CPU or runnable work, instrumented waits and work with no exposed wait event while remaining `active` throughout.",
      },
      {
        heading: 'Idle in transaction, and why it is dangerous',
        body:
          "`idle in transaction` means the client ran `BEGIN`, did some work, and then went away to do something else — an HTTP call, a queue publish, a garbage collection pause. The transaction is still open, so every lock it took is still held. Whether it also blocks cleanup depends on what it holds: if it has written anything, its transaction id is still marked running and the cleanup horizon for every table in that database cannot advance past it; if it is in `REPEATABLE READ` or `SERIALIZABLE`, or it left a cursor open, its snapshot pins the horizon the same way. A read-only `READ COMMITTED` session sitting between statements holds neither — which is why `backend_xid` and `backend_xmin` in `pg_stat_activity`, and not the `idle in transaction` state on its own, tell you who is holding the line. Minutes of that on a busy table produce bloat that outlives the incident by weeks. Set `idle_in_transaction_session_timeout`, and in modern versions `transaction_timeout` (PG 17) as a backstop for transactions that are slow rather than idle.",
      },
      {
        heading: 'What you would see in production',
        body:
          "`pg_stat_activity.state` reports the real states: 'active', 'idle', 'idle in transaction', 'idle in transaction (aborted)'. When state is 'active' the interesting column is not `state` but `wait_event_type` plus `wait_event` — a backend that is active and waiting on `IO:DataFileRead` has a very different problem from one waiting on `Lock:transactionid`. `backend_xid` tells you whether it has written anything yet; `backend_xmin` tells you what it is pinning.",
      },
      {
        heading: 'Where the model simplifies',
        body:
          "In the real thing these phases overlap and interleave far more than one tower can show: WAL records are inserted throughout execution rather than in a distinct phase, and a single statement can bounce between CPU and I/O thousands of times. The city does not parse arbitrary SQL, resolve catalogs, rewrite views, cache prepared plans or cost alternatives; six fixed statement templates select its phases and plan shapes. `pg_stat_activity.state` reports coarser activity states, with wait events as a separate dimension.",
      },
    ],
    metrics: [
      { label: 'Slots in use', get: (s) => `${fmtNum(countBackends(s, (b) => b.active))} / ${fmtNum((s.backends ?? []).length)}` },
      { label: 'Running', get: (s) => fmtNum(nIn(s, ...BUSY)) },
      { label: 'Waiting on I/O', get: (s) => fmtNum(nIn(s, 'exec_io', 'eviction_flush')) },
      { label: 'Committing', get: (s) => fmtNum(nIn(s, 'commit_wait')), hint: 'waiting for WAL flush and any synchronous standby' },
      { label: 'Idle in transaction', get: (s) => fmtNum(nIn(s, 'idle_in_xact')) },
    ],
    knobs: ['tps', 'longRunningXact', 'lockContention'],
    see: ['backend.localmem', 'planner.lab', 'xmin.horizon', 'lock.manager'],
    source: ['src/backend/postmaster/postmaster.c', 'src/backend/executor/execMain.c', 'src/backend/parser/analyze.c'],
    refs: {
      docs: [
        manual('protocol-flow.html', '54.2. Message Flow'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — backend_xid, backend_xmin'),
      ],
      source: [
        srcFile('src/backend/tcop/postgres.c', 'PostgresMain, exec_simple_query'),
        srcFile('src/backend/utils/time/snapmgr.c', 'SnapshotResetXmin'),
      ],
      suzuki: suzuki(2, 'Process and Memory Architecture'),
      rogov: rogov(R_MVCC, 'Snapshots', 'cited for the horizon claim only — Rogov has no backend-lifecycle chapter'),
    },
  },

  {
    id: 'backend.localmem',
    title: 'Local Memory',
    subtitle: 'work_mem, maintenance_work_mem, temp_buffers',
    tldr: 'work_mem is per operation per backend, not per query and not per server — that is the whole footgun.',
    sections: [
      {
        heading: 'The unit that catches everyone',
        body:
          'A backend allocates its private memory in contexts that are reset when a query ends, so leaks are rare. What is not rare is misjudging the multiplier. In PostgreSQL 18.3, `work_mem` defaults to 4 MiB per eligible executor node, not per query and not per connection. PostgreSQL 13 added `hash_mem_multiplier`; its default has been 2.0 since PostgreSQL 15, so a hash node may use `work_mem × 2`. Three hash nodes plus one sort therefore have nominal allowances around seven times `work_mem`, and concurrently active nodes can overlap. Parallel workers often make their own allocations, but Parallel Hash uses a shared hash table rather than one full private copy per worker. Size for the actual plan nodes, workers and concurrent backends instead of multiplying by one slogan.',
      },
      {
        heading: 'What happens when it is not enough',
        body:
          'Nothing fails. A sort that does not fit switches from in-memory quicksort to an external merge, writing runs under `base/pgsql_tmp` and merging them back. The same fixed operation can cross that boundary with one more row and become an order of magnitude slower without changing its SQL or plan shape. `EXPLAIN (ANALYZE)` tells you outright: `Sort Method: quicksort  Memory: NkB` becomes `Sort Method: external merge  Disk: NkB`. Hash operations can batch and spill too; in real PostgreSQL that includes hash joins, but this city has no join nodes. Set `log_temp_files` to log completed temp files, watch `pg_stat_database.temp_files` and `temp_bytes` as cumulative totals, and use `temp_file_limit` as a guardrail against one process filling the volume.',
      },
      {
        heading: 'The other two budgets',
        body:
          '`maintenance_work_mem` (default 64 MiB) is used by `VACUUM`, `CREATE INDEX` and `ALTER TABLE`, not by ordinary queries — there are few of these running at once, so it can be far larger than `work_mem`, and index builds get dramatically faster with more of it. Autovacuum workers use `autovacuum_work_mem` if it is set, otherwise the same value, multiplied by `autovacuum_max_workers`. `temp_buffers` (default 8 MiB) is a per-session cache for temporary tables only; it is allocated lazily and cannot be changed once the session has touched a temp table.',
      },
      {
        heading: 'What you would see in production',
        body:
          'The failure mode is a pair of cliffs. Too little memory makes one node spill; too much global `work_mem` lets several nodes, workers and concurrent backends allocate a multiple large enough to exhaust the server. Prefer raising it for the specific transaction that needs it (`SET LOCAL work_mem` inside the report transaction) over raising it globally. Lower concurrency and fewer memory-hungry plan nodes are equally real levers. In PostgreSQL 17 the vacuum side got better too: dead tuple tracking was rewritten into a compact structure, so `maintenance_work_mem` above 1 GiB is finally useful to `VACUUM`.',
      },
      {
        heading: 'What the city models',
        body:
          `${CLAIM_VALUES.workMem.nodeDisclosure}. The fixed query templates contain Sort and HashAggregate nodes with explicit teaching working sets. Each node receives its own allowance; HashAggregate receives \`work_mem × ${CLAIM_VALUES.workMem.hashMemMultiplier.toFixed(1)}\`. Crossing that allowance changes the node’s displayed EXPLAIN-style method, creates modeled temp files and bytes, adds shared storage pressure, and attributes the added model time to temp-file I/O in the Latency vital. One spilling modeled node creates one modeled temp file per represented statement; real PostgreSQL may use several files and passes. ${CLAIM_VALUES.workMem.coverageDisclosure}`,
      },
    ],
    metrics: [
      { label: 'Eligible nodes', get: (s) => `${fmtNum(s.workMem.activeNodes)} (${fmtNum(s.workMem.activeSortNodes)} sort / ${fmtNum(s.workMem.activeHashNodes)} hash)`, hint: 'fixed-template nodes carried by statements in the combined teaching phase; this is not simultaneous node execution' },
      { label: 'Private bytes', get: (s) => `${fmtBytes(s.workMem.activeUsedBytes)} / ${fmtBytes(s.workMem.activeAllowanceBytes)} allowances`, hint: 'sum across active eligible nodes; nominal allowances are not a promise that every node peaks together' },
      { label: 'Spilling nodes', get: (s) => fmtNum(s.workMem.spillingNodes) },
      { label: 'temp_files', get: (s) => fmtNum(s.workMem.tempFiles), hint: 'modeled cumulative pg_stat_database counter' },
      { label: 'temp_bytes', get: (s) => fmtBytes(s.workMem.tempBytes), hint: 'modeled cumulative pg_stat_database counter' },
    ],
    knobs: ['workMem', 'seqScanRatio', 'tps'],
    see: ['backend.slot', 'planner.planner', 'planner.executor', 'shared.buffers'],
    refs: {
      docs: [
        manual('runtime-config-resource.html#GUC-WORK-MEM', '19.4. Resource Consumption — work_mem'),
        manual('sql-explain.html', 'EXPLAIN'),
      ],
      source: [
        srcFile('src/backend/utils/sort/tuplesort.c', 'tuplesort_begin_common, inittapes'),
        srcFile('src/backend/executor/nodeHash.c', 'ExecHashTableCreate, ExecHashIncreaseNumBatches'),
      ],
      suzuki: suzuki(2, 'Process and Memory Architecture (§2.2, the local memory area)'),
      rogov: rogov(R_EXEC, 'Merging and Sorting; Hashing'),
    },
  },

  /* ======================================================================
   * Shared memory
   * ====================================================================*/
  {
    id: 'shmem.deck',
    title: 'Shared Memory',
    subtitle: 'one segment, mapped by every process, fixed at startup',
    tldr: 'One fixed-size segment created before the first fork — every process sees it at the same address.',
    sections: [
      {
        heading: 'What lives in here',
        body:
          'The buffer pool and its descriptors take most of it. Alongside them: the WAL buffers, the process array with one entry per possible backend, the heavyweight lock table and the predicate lock table, the array of lightweight locks, the SLRU caches for commit status and multixacts, replication slot state, background worker slots, and since PG 15 the cumulative statistics. Every one of these is a fixed-size array or hash table, sized from `postgresql.conf` at startup.',
      },
      {
        heading: 'Why it cannot grow',
        body:
          'The postmaster maps the segment once and then forks; every child inherits the same mapping at the same address, so a pointer to a buffer descriptor means the same thing in every process. Growing the segment would mean remapping it in every existing backend at a moment when they might be in the middle of using it. So the size is computed once at startup, and the parameters it is derived from — `shared_buffers`, `max_connections`, `max_locks_per_transaction`, `max_prepared_transactions`, `max_wal_senders`, `max_replication_slots` — all require a restart.',
      },
      {
        heading: 'Huge pages and the OS view',
        body:
          'On Linux this is anonymous shared memory, and with tens of gigabytes of it the page tables alone become expensive — every backend maps the whole segment, so 4 KiB pages mean a great many page table entries per process. `huge_pages = try` is the default; setting it to `on` and reserving the pages properly is close to free performance on large instances. Since PG 15 the server will tell you exactly how many to reserve: `SHOW shared_memory_size_in_huge_pages`.',
      },
      {
        heading: 'The exception: dynamic shared memory',
        body:
          'Parallel query needs a communication area whose size is not known until a plan runs, so it does not come from this segment. Parallel workers attach a *dynamic* shared memory segment created for that one query, holding the tuple queues and any shared hash table. It is created when the Gather node starts and destroyed when the query ends — the only shared memory in Postgres that appears and disappears at runtime.',
      },
      {
        heading: 'What the city models',
        body:
          'The deck groups model structures that are shared TypeScript state: the buffer sample, WAL ring, backend/xid projection, direct lock waiters and cumulative counters. It does not allocate a shared-memory segment, map it into processes, size structures from all PostgreSQL settings, use huge pages or create dynamic shared memory for the illustrative Gather plan nodes.',
      },
    ],
    metrics: [
      { label: 'Buffer pool', get: poolSize, hint: 'shared_buffers; the visual sample is shown separately in the plaza' },
      { label: 'WAL buffers', get: (s) => fmtBytes(nz(s.wal?.bufferCapacity)) },
      { label: 'Proc slots', get: (s) => `${fmtNum(nz(s.stats?.activeBackends))} / ${fmtNum(nz(s.maxConnections))}` },
      { label: 'Lock waits', get: (s) => fmtNum((s.locks ?? []).length), hint: 'edges currently in the wait-for graph' },
    ],
    knobs: ['sharedBuffers'],
    see: ['shared.buffers', 'proc.array', 'lock.manager', 'wal.buffers'],
    refs: {
      docs: [
        manual('kernel-resources.html', '18.4. Managing Kernel Resources'),
        manual('runtime-config-resource.html', '19.4. Resource Consumption — huge_pages, shared_memory_type'),
      ],
      source: [
        srcFile('src/backend/storage/ipc/ipci.c', 'CalculateShmemSize, CreateSharedMemoryAndSemaphores'),
        srcFile('src/backend/storage/ipc/shmem.c', 'ShmemInitStruct'),
      ],
      suzuki: suzuki(2, 'Process and Memory Architecture (§2.2)'),
      rogov: rogov(R_MVCC, 'Introduction — processes and memory'),
    },
  },

  {
    id: 'shared.buffers',
    title: 'Shared Buffers',
    subtitle: 'the page cache Postgres owns',
    tldr: 'A fixed array of 8 KiB frames that every page must pass through to be read or modified.',
    sections: [
      {
        heading: 'What it actually is',
        body:
          'A single array of 8 KiB frames, and a parallel array of descriptors — one per frame — holding the page identity (relation, fork, block number), a reference count, a usage count and flags such as dirty and valid. No process reads or writes a data page anywhere else. To read a row you find or load its page here; to modify a row you modify the copy here and mark the frame dirty. Writing to disk is a separate concern handled later by somebody else. The default `shared_buffers` of 128 MiB is a starting value chosen to boot anywhere, not a recommendation.',
      },
      {
        heading: 'Pins, content locks and usage counts',
        body:
          'Before touching a page a backend *pins* it, which increments the reference count and guarantees the frame will not be recycled underneath it. A pin says nothing about the contents, so a second, shorter lock protects those: shared for readers, exclusive for writers, held only while the page is actually being examined or changed. Pinning also bumps the frame usage count, which saturates at 5. Pins are the reason a hot page never gets evicted mid-scan, and a page somebody else has pinned is the reason vacuum sometimes leaves dead tuples behind: pruning a page needs a *cleanup lock* — the exclusive content lock plus the only pin on the frame — so a page still pinned when vacuum arrives, classically by a cursor paused on it, keeps its corpses until a later pass.',
      },
      {
        heading: 'Finding a victim: the clock sweep',
        body:
          'When a page is not present, someone must give up a frame. The free list only holds frames that have never been used or were released by a `DROP` or `TRUNCATE`, so in a warm system it is empty and the allocator runs a clock sweep instead: it walks the descriptor array in a circle, decrementing each usage count it passes, and takes the first frame it finds with usage count zero and no pins. A page at usage count 1 is decremented to zero on one encounter and becomes eligible on a later encounter only if it remains unpinned and untouched. Frequently used pages keep getting bumped and survive. There is no LRU list, no timestamps, and no global lock — approximation is the point.',
      },
      {
        heading: 'When the backend has to write',
        body:
          "If the victim frame is dirty, the backend that wanted a *read* has to write that page out first, and then wait for its own read. This is the single most important thing to understand about the write path: it makes an unrelated query pay for someone else's earlier update, and the latency shows up in a query that never wrote anything. Avoiding it is exactly the job of the checkpointer and the background writer. In PG 16 and later, `pg_stat_io` breaks writes down by the process that did them, so you can see this directly; PG 17 removed the older `buffers_backend` counters from `pg_stat_bgwriter` in favour of it. A steady stream of writes attributed to client backends means the cleaners are not keeping up.",
      },
      {
        heading: 'Sizing it honestly',
        body:
          'Postgres reads through the OS page cache, so a page can be cached twice — once here, once by the kernel. That double buffering wastes some RAM, but the OS cache is not the enemy: it can satisfy a shared-buffer miss without physical device I/O. 25% of system RAM is a traditional starting point; larger values are common on dedicated machines, but returns fall off and the checkpointer must scan more buffer descriptors. Buffer-pool capacity does not determine how many pages are dirty: workload, background writing, checkpoint pacing and dirtying rate do. Do not tune to a hit ratio — a 99% hit ratio on a badly estimated plan reading a million pages is worse than 90% on a plan reading a hundred. PostgreSQL 18 also protects the pool during a large sequential scan with a bulk-read ring: `GetAccessStrategy(BAS_BULKREAD)` starts at 256 KiB, adds space for `io_combine_limit × effective_io_concurrency`, and applies pin and one-eighth-of-`shared_buffers` caps. With PostgreSQL 18.3 defaults and 8 KiB blocks that is about 2.25 MiB, not a fixed 256 KiB. PGSimCity’s current TypeScript buffer sample still uses the historical fixed 32-frame ring, so its animation teaches cache isolation but does not reproduce PostgreSQL 18’s numeric ring sizing.',
      },
      {
        heading: 'What the city measures',
        body:
          'The engine models a representative buffer sample, tags, pins, usage counts, page LSNs, dirty victims, a clock sweep and background cleaning. It does not model content-lock acquisition, cleanup-lock failure or per-page visibility checks. A backend dirty-victim eviction waits for the shared WAL flush when its page LSN is not durable, then adds representative page-write time to that statement and increments sampled counters; rolling p50/p99 model-time quantiles expose each component’s own distribution. There is no calibrated storage time, and the OS-cache route does not change the cost.',
      },
    ],
    metrics: [
      {
        label: 'Pool size',
        get: (s) => `${fmtBytes(poolBytes(s.knobs))} (${poolPages(s.knobs).toLocaleString()} pages)`,
      },
      { label: 'Sample in use', get: (s) => fmtPct(ratio(nz(s.buffers?.usedCount), nz(s.buffers?.sampleFrames))) },
      {
        label: 'Dirty sample',
        get: (s) => `${fmtNum(nz(s.buffers?.dirtyCount))} (${fmtPct(ratio(nz(s.buffers?.dirtyCount), nz(s.buffers?.sampleFrames)))})`,
      },
      { label: 'Hit ratio', get: (s) => fmtPct(nz(s.buffers?.hitRatio)) },
      {
        label: 'Backend writes',
        get: (s) => fmtNum(nz(s.buffers?.dirtyEvictions)),
        hint: 'dirty pages a backend had to write itself before it could read',
      },
    ],
    knobs: ['sharedBuffers', 'bgwriterEnabled', 'bgwriterLruMaxpages', 'seqScanRatio'],
    see: ['buf.mapping', 'world.pit', 'backend.localmem', 'shmem.deck'],
    source: ['src/backend/storage/buffer/bufmgr.c', 'src/backend/storage/buffer/freelist.c'],
    refs: {
      docs: [
        manual('runtime-config-resource.html#GUC-SHARED-BUFFERS', '19.4. Resource Consumption — shared_buffers'),
        manual('pgbuffercache.html', 'F.25. pg_buffercache'),
      ],
      source: [
        srcFile('src/backend/storage/buffer/bufmgr.c', 'BufferAlloc, PinBuffer, FlushBuffer, BufferSync'),
        srcFile('src/backend/storage/buffer/freelist.c', 'StrategyGetBuffer, ClockSweepTick, GetBufferFromRing'),
      ],
      suzuki: suzuki(8, 'Buffer Manager'),
      rogov: rogov(R_WAL, 'Buffer Cache'),
    },
  },

  {
    id: 'buf.mapping',
    title: 'Buffer Mapping',
    subtitle: 'the hash table from page identity to buffer',
    tldr: 'A partitioned hash table that turns (relation, fork, block) into a buffer id, or tells you it is not there.',
    sections: [
      {
        heading: 'The lookup nobody thinks about',
        body:
          'A backend asking for block 4711 of a table does not know where that page is in memory, or whether it is in memory at all. The buffer mapping table answers that: the key is the buffer tag (relation identity, fork number, block number) and the value is the frame index. Every single page access — hit or miss — starts with a probe of this table, which makes it one of the hottest data structures in the server.',
      },
      {
        heading: 'Why it is split into partitions',
        body:
          'A single lock over one hash table would serialise every buffer access in the cluster. Instead the table is divided into 128 partitions, each with its own lightweight lock, chosen by hashing the tag. A hit takes the partition lock in shared mode, finds the entry, pins the buffer and releases. A miss is more work: allocate a victim through the clock sweep, take the *old* page partition lock to remove it and the new one to insert, then read. That two-lock dance is why misses are not just slower because of the I/O.',
      },
      {
        heading: 'What contention looks like',
        body:
          'Because partitions are chosen by hash, contention is not usually about one hot block — it is about volume. Thousands of backends doing tens of thousands of buffer lookups each per second will collide on partition locks regardless of which pages they want. You see it as `LWLock` in `wait_event_type` with `BufferMapping` in `wait_event`, together with high CPU and system time and throughput that stops rising with load. The realistic remedies are fewer connections doing more work each, and plans that touch fewer pages.',
      },
      {
        heading: 'What you would see in production',
        body:
          'The most common trigger is a plan flip that turns a cheap index lookup into a sequential scan on a hot table across every connection at once. Nothing is on disk, the hit ratio still looks fantastic, and yet the system is saturated: it is spending its time in the mapping table and in memory copies. Look at `blks_hit` in `pg_stat_database` rather than the hit ratio — buffer hits are cheap, but a hundred million of them per second is not.',
      },
      {
        heading: 'What the city models',
        body:
          'The engine uses a direct in-memory page-key map for its representative buffer sample and counts hits and misses. It does not model 128 buffer-mapping partitions, lightweight locks, lock modes, lookup contention, memory-copy cost or a workload-wide cost from those probes. Its fixed plan mix cannot flip because this table became contended.',
      },
    ],
    metrics: [
      { label: 'Lookups', get: (s) => fmtNum(nz(s.buffers?.hits) + nz(s.buffers?.misses)), hint: 'cumulative probes: hits plus misses' },
      { label: 'Misses', get: (s) => fmtNum(nz(s.buffers?.misses)) },
      { label: 'Hit ratio', get: (s) => fmtPct(nz(s.buffers?.hitRatio)) },
      { label: 'Sample evictions', get: (s) => fmtNum(nz(s.buffers?.evictions)), hint: 'sample frames recycled by the clock sweep' },
      { label: 'Sample clock hand', get: (s) => `${fmtNum(nz(s.buffers?.clockHand))} / ${fmtNum(nz(s.buffers?.sampleFrames))}` },
    ],
    knobs: ['sharedBuffers', 'tps', 'seqScanRatio'],
    see: ['shared.buffers', 'lock.manager', 'world.pit'],
    source: ['src/backend/storage/buffer/bufmgr.c', 'src/backend/storage/buffer/freelist.c'],
    refs: {
      docs: [
        manual('monitoring-stats.html#WAIT-EVENT-LWLOCK-TABLE', '27.2. The Cumulative Statistics System — LWLock wait events'),
        manual('pgbuffercache.html', 'F.25. pg_buffercache'),
      ],
      source: [
        srcFile('src/backend/storage/buffer/buf_table.c', 'BufTableLookup, BufTableInsert, BufTableDelete'),
        srcFile('src/backend/storage/buffer/bufmgr.c', 'BufferAlloc'),
      ],
      suzuki: suzuki(8, 'Buffer Manager (§8.2, §8.3)'),
      rogov: rogov(R_WAL, 'Buffer Cache'),
    },
  },

  {
    id: 'proc.array',
    title: 'ProcArray',
    subtitle: 'who is running, and what each one can see',
    tldr: 'One entry per backend, and the source of every snapshot — the list of transactions that were running at an instant.',
    sections: [
      {
        heading: 'What a snapshot is',
        body:
          'Postgres does not overwrite a row version’s user-column values during an `UPDATE`; it writes a new version and leaves the old one. Tuple headers, hint bits and page metadata can still be modified in place. Deciding which version a query may see is the job of a snapshot, and a snapshot is three things: `xmin`, the oldest transaction still running; `xmax`, the first transaction id not yet assigned; and the list of transaction ids in between that were in progress at that instant. Anything older than `xmin` is settled, anything at or above `xmax` had not started, and the list covers the middle.',
      },
      {
        heading: 'How a row version is judged',
        body:
          'Each row version carries `xmin` (the transaction that created it) and `xmax` (the transaction that deleted or superseded it, if any). A version is visible if its creator committed and is visible to your snapshot, and its deleter either does not exist, aborted, or is not visible to your snapshot. That test needs commit status, which comes from the commit log, cached and then cached again in the row itself as a hint bit. Your own open transaction is the one case the snapshot does not decide: you do see rows your earlier statements inserted and you no longer see rows they deleted, although nothing has committed — that is settled by the command counters `cmin` and `cmax`, checked before any commit status is consulted. Ordinary MVCC reads do not block ordinary row-version changes merely to preserve visibility; explicit table locks, row-locking reads, unique checks and foreign-key interactions still can block.',
      },
      {
        heading: 'Why taking one has to be cheap',
        body:
          'In `READ COMMITTED` — the default — every statement takes a fresh snapshot. At a few thousand statements per second across hundreds of connections, that is a shared data structure being scanned constantly. Historically this scan was the scalability wall at high connection counts; PG 14 reworked the array so that snapshot building touches compact, contiguous data instead of chasing per-backend structures, which measurably raised the ceiling. It is still a reason to keep connection counts sane.',
      },
      {
        heading: 'Isolation levels in one paragraph',
        body:
          '`READ COMMITTED` takes a new snapshot per statement, so a long transaction sees the world move under it between statements. `REPEATABLE READ` takes one snapshot at the first statement and keeps it for the whole transaction — stable, but it can fail with a serialization error on write conflicts. `SERIALIZABLE` adds predicate locking on top to detect dangerous read/write patterns and aborts one of the participants. All three read the same row versions through the same mechanism; only the snapshot policy differs.',
      },
      {
        heading: 'What you would see in production',
        body:
          '`pg_stat_activity.backend_xid` is set only once a transaction has written something — read-only transactions do not consume transaction ids. `backend_xmin` is the xmin horizon of that one backend — how far back it is pinning cleanup for every table in its database. `SELECT pg_current_snapshot()` returns the raw `xmin:xmax:in-progress` triple if you want to see one directly.',
      },
      {
        heading: 'What the city models',
        body:
          'The city assigns transaction ids to modeled writes, displays backend slots and computes an aggregate xmin horizon from its scripted pins. It does not build snapshots, scan the ProcArray, store in-progress xid lists, evaluate tuple visibility from a snapshot or charge snapshot acquisition cost. More displayed slots therefore do not make every statement slower.',
      },
    ],
    metrics: [
      {
        label: 'In transaction',
        get: (s) => fmtNum(countBackends(s, (b) => b.active && b.state !== 'idle' && nz(b.xid) > 0)),
        hint: 'backends assigned an xid — i.e. inside a transaction that has written',
      },
      { label: 'Next xid', get: (s) => fmtNum(nz(s.xid)) },
      { label: 'xmin horizon', get: (s) => fmtNum(nz(s.xminHorizon)) },
      { label: 'Horizon lag', get: (s) => `${fmtNum(Math.max(0, nz(s.xid) - nz(s.xminHorizon)))} xids` },
      { label: 'Oldest snapshot', get: (s) => fmtDuration(nz(s.oldestSnapshotAge)) },
    ],
    knobs: ['tps', 'longRunningXact'],
    see: ['xmin.horizon', 'clog.slru', 'shmem.deck', 'backend.slot'],
    source: ['src/backend/storage/ipc/procarray.c'],
    refs: {
      docs: [
        manual('mvcc.html', 'Chapter 13. Concurrency Control'),
        manual('transaction-iso.html', '13.2. Transaction Isolation'),
      ],
      source: [
        srcFile('src/backend/storage/ipc/procarray.c', 'GetSnapshotData'),
        srcFile('src/backend/utils/time/snapmgr.c', 'GetTransactionSnapshot, SnapshotResetXmin'),
      ],
      suzuki: suzuki(5, 'Concurrency Control (§5.5, §5.6)'),
      rogov: rogov(R_MVCC, 'Snapshots'),
    },
  },

  {
    id: 'xmin.horizon',
    title: 'The xmin Horizon',
    subtitle: 'the oldest thing anybody might still need to see',
    tldr: 'Vacuum may only remove row versions dead to everyone — one old transaction pins that line for every table in its database.',
    sections: [
      {
        heading: 'What the horizon is',
        body:
          'Vacuum derives cleanup cutoffs from several candidates, including active snapshot xmins, assigned transaction XIDs, prepared transactions, replication-slot xmins and standby feedback. A dead row version can be removed only once its deleting transaction committed and no relevant cutoff says somebody could still need it. This is not a per-table rule: one old candidate can retain versions across a database, while catalog cutoffs can have cluster-wide reach.',
      },
      {
        heading: 'The most destructive mistake in Postgres',
        body:
          'A session runs `BEGIN`, issues one query, and then blocks on something outside the database. Or a reporting query runs for four hours. Or a replication slot was created for a subscriber that no longer exists. While that lasts, autovacuum still runs, still reads every table, still costs I/O — and removes almost nothing. Tables grow, indexes grow, and the sequential scans that used to be fast get slower in proportion. When the culprit finally goes away, the bloat does not: `VACUUM` reclaims space *inside* the files for reuse, and only ever returns space to the filesystem by truncating empty pages at the very end of a table.',
      },
      {
        heading: 'The five things that pin it',
        body:
          'Common causes are a long-running snapshot or assigned XID; an idle transaction that actually retains one of those; a replication slot with an old `xmin` or `catalog_xmin`; an abandoned prepared transaction; or standby feedback carrying an old xmin. Under READ COMMITTED, merely being idle in a transaction does not necessarily retain the previous command’s snapshot, so inspect the reported XIDs/xmins instead of classifying by state alone.',
      },
      {
        heading: 'How to find the culprit',
        body:
          'Start with `pg_stat_activity` rows where either `backend_xmin` or `backend_xid` is non-null. Then inspect `pg_prepared_xacts`, slot `xmin`/`catalog_xmin`, and `pg_stat_replication.backend_xmin` for standby feedback. Treat `n_dead_tup` as estimated pressure and compare physical size trends. Verbose vacuum output can report row versions that are dead but not yet removable and the cutoff it used.',
      },
      {
        heading: 'What to do about it',
        body:
          'Prevention beats cure: set `idle_in_transaction_session_timeout` to something in the minutes, `statement_timeout` on the application role, and in PG 17 and later `transaction_timeout` for transactions that are neither idle nor a single long statement. Monitor for replication slots with no consumer and resolve them according to ownership and recovery intent. If you must cure a verified abandoned session, `pg_terminate_backend()` aborts its transaction. Repacking with `VACUUM FULL` holds `ACCESS EXCLUSIVE` for the rewrite; `pg_repack` instead takes brief `ACCESS EXCLUSIVE` locks at setup and final swap, holds `SHARE UPDATE EXCLUSIVE` through much of the copy, and needs room for the shadow copy.',
      },
    ],
    metrics: [
      { label: 'Oldest snapshot', get: (s) => fmtDuration(nz(s.oldestSnapshotAge)) },
      { label: 'Horizon lag', get: (s) => `${fmtNum(Math.max(0, nz(s.xid) - nz(s.xminHorizon)))} xids` },
      {
        label: 'Vacuum stalled',
        get: (s) => `${fmtNum((s.autovac?.workers ?? []).filter((w) => w && w.active && w.stalledByHorizon).length)} workers`,
        hint: 'workers that found dead row versions they are not yet allowed to remove',
      },
      { label: 'Dead row versions', get: (s) => fmtNum(sumTables(s, (t) => t.deadTuples)), hint: 'across all tables' },
      {
        label: 'Worst table',
        get: (s) => {
          const w = worstBloat(s)
          return `${w.name} ${fmtPct(w.bloat)}`
        },
        hint: 'highest fraction of dead row versions',
      },
    ],
    knobs: ['longRunningXact', 'autovacuum', 'autovacuumScaleFactor'],
    see: ['proc.array', 'autovac.worker', 'storage.table', 'backend.slot'],
    source: ['src/backend/storage/ipc/procarray.c', 'src/backend/access/heap/vacuumlazy.c', 'src/backend/commands/vacuum.c'],
    refs: {
      docs: [
        manual('routine-vacuuming.html', '24.1. Routine Vacuuming'),
        manual('mvcc-intro.html', '13.1. Introduction'),
        { label: 'pg_repack documentation — locking and operation', url: 'https://reorg.github.io/pg_repack/' },
      ],
      source: [
        srcFile('src/backend/storage/ipc/procarray.c', 'ComputeXidHorizons, GetOldestNonRemovableTransactionId'),
        srcFile('src/backend/access/heap/heapam_visibility.c', 'HeapTupleSatisfiesVacuum'),
      ],
      suzuki: suzuki(5, 'Concurrency Control (§5.5, §5.7)'),
      rogov: rogov(R_MVCC, 'Snapshots — the database horizon'),
    },
  },

  {
    id: 'lock.manager',
    title: 'Lock Manager',
    subtitle: 'heavyweight locks, wait queues and deadlock detection',
    tldr: 'A partitioned table of table-level locks held to end of transaction, with a wait queue and a deadlock detector.',
    sections: [
      {
        heading: 'Three different things called locks',
        body:
          '*Heavyweight* locks are what this building holds: locks on tables, transaction ids, advisory keys and similar objects, tracked in a shared hash table, held until the end of the transaction, visible in `pg_locks`, and subject to deadlock detection. *Row* locks are not stored here at all — they live in the row version itself. *Lightweight* locks protect shared memory structures such as buffer mapping partitions for a few instructions at a time; they are not in `pg_locks`, have no queue you can inspect, and have no deadlock detection because the code is written to always take them in the same order. Confusing the three is the source of most lock folklore.',
      },
      {
        heading: 'Modes and the conflict table',
        body:
          'There are eight table-level modes, from `ACCESS SHARE` (taken by `SELECT`) through `ROW EXCLUSIVE` (`INSERT`, `UPDATE`, `DELETE`) and `SHARE UPDATE EXCLUSIVE` (`VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY`) up to `ACCESS EXCLUSIVE` (`ALTER TABLE`, `DROP`, `VACUUM FULL`), which conflicts with everything including plain reads. Two `ROW EXCLUSIVE` holders coexist happily — ordinary concurrent writes to the same table do not block on each other at this level. What blocks is DDL.',
      },
      {
        heading: 'Partitions, fast path, and where the cost is',
        body:
          'The lock table is split into 16 partitions by lock tag hash, each with its own lightweight lock, and it is sized at startup as `max_locks_per_transaction` (default 64) multiplied by the connection budget — an average, not a per-transaction hard limit. To avoid the shared table entirely, each backend can record a small number of weak relation locks in a private fast-path array; historically that was 16 slots, and recent versions scale it with `max_locks_per_transaction`. Queries touching hundreds of partitions blow past the fast path and start contending on the partition locks, which shows up as `LWLock:LockManager`.',
      },
      {
        heading: 'Waiting, and how row conflicts really work',
        body:
          'A lock request that conflicts goes onto that lock tag queue in arrival order, and — this is the part that hurts — later requests queue behind it even if they would not have conflicted with the current holder. So a brief `ALTER TABLE` waiting behind a long `SELECT` blocks every subsequent query on that table. For row-level conflicts, the waiter finds the blocking transaction id in the row header and takes a `ShareLock` on that transaction id, which is released when the transaction ends. That is why `wait_event` reads `Lock:transactionid` when two sessions update the same row.',
      },
      {
        heading: 'Deadlocks, and what you would see',
        body:
          'Postgres does not prevent deadlocks, it detects them. A backend that has waited `deadlock_timeout` (default 1s) builds the wait-for graph, and if it finds a cycle one transaction is aborted with SQLSTATE `40P01 deadlock_detected`. SQLSTATE `40001 serialization_failure` is a different condition, although applications commonly retry both at the whole-transaction boundary. Deadlocks are usually an application ordering bug. Operationally: set `lock_timeout` on sessions that run DDL, turn on `log_lock_waits`, and diagnose live incidents with `pg_blocking_pids(pid)` joined against `pg_stat_activity`.',
      },
      {
        heading: 'What the city models',
        body:
          'One scripted backend holds `ACCESS EXCLUSIVE` on one table and affected model statements wait directly on that holder. The city has no lock-mode conflict table, waiter-to-waiter queue fairness, row locks, deadlock graph or general timeout setting. The lock-pileup scenario alone applies a fixed 15 model-second release; there is no `lock_timeout` knob.',
      },
    ],
    metrics: [
      { label: 'Blocked backends', get: (s) => fmtNum(nIn(s, 'blocked')) },
      { label: 'Wait edges', get: (s) => fmtNum((s.locks ?? []).length), hint: 'holder to waiter pairs in pg_locks terms' },
      {
        label: 'Oldest model wait',
        get: (s) => {
          let m = 0
          for (const l of s.locks ?? []) if (l && nz(l.ageSec) > m) m = nz(l.ageSec)
          return `${fmtDuration(m)} model time`
        },
      },
      {
        label: 'Contended table',
        get: (s) => {
          const l = (s.locks ?? [])[0]
          if (!l) return '—'
          const t = (s.tables ?? [])[l.table]
          return `${t?.def?.name ?? '?'} (${l.mode})`
        },
      },
    ],
    knobs: ['lockContention', 'tps', 'updateRatio'],
    see: ['backend.slot', 'proc.array', 'storage.table', 'buf.mapping'],
    source: ['src/backend/storage/lmgr/lock.c'],
    refs: {
      docs: [
        manual('explicit-locking.html', '13.3. Explicit Locking'),
        manual('view-pg-locks.html', '53.13. pg_locks'),
        manual('runtime-config-locks.html', '19.12. Lock Management'),
        manual('errcodes-appendix.html', 'Appendix A. PostgreSQL Error Codes'),
      ],
      source: [
        srcFile('src/backend/storage/lmgr/lock.c', 'LockAcquire, LockRelease'),
        srcFile('src/backend/storage/lmgr/deadlock.c', 'DeadLockCheck'),
        srcFile('src/backend/storage/lmgr/proc.c', 'ProcSleep'),
      ],
      rogov: rogov(R_LOCKS, 'Relation-Level Locks; Row-Level Locks; Locks in Memory'),
    },
  },

  {
    id: 'clog.slru',
    title: 'Commit Log & SLRU',
    subtitle: 'two bits per transaction, and the caches in front of them',
    tldr: 'pg_xact stores two bits per transaction — in progress, committed, aborted — and visibility checks read it constantly.',
    sections: [
      {
        heading: 'Two bits, and why they are enough',
        body:
          'Commit status lives in `pg_xact`: two bits per transaction id, meaning in progress, committed, aborted, or sub-committed. Two bits means 32768 transactions fit in one 8 KiB page and about a million in one 256 KiB segment file, so even a very busy database keeps its recent commit history in a handful of pages. When a visibility check finds a row version whose creating transaction it does not recognise, this is where it looks, through a small shared cache called an SLRU.',
      },
      {
        heading: 'Hint bits, and the bulk-load surprise',
        body:
          'Consulting the commit log for every row of every scan would be far too slow, so the first reader to resolve a transaction id writes the answer back into the row header as a hint bit. That makes every subsequent read free — and it makes the page *dirty*, because the page changed. This is why a plain `SELECT` immediately after a large `COPY` or bulk `INSERT` is slower than the same `SELECT` a minute later, and why it generates write I/O without writing any data. If data checksums are on (or `wal_log_hints`), the first hint-bit change to a page after a checkpoint also writes a full-page image to the WAL.',
      },
      {
        heading: 'The other SLRUs',
        body:
          '`pg_subtrans` maps subtransactions to their parents — a transaction with more than 64 live subtransactions (savepoints, or PL/pgSQL blocks with exception handlers in a loop) overflows its cached list and forces every visibility check into this SLRU, a genuine performance cliff. `pg_multixact` handles rows locked by several transactions at once. `pg_commit_ts` records commit timestamps if enabled. All of them are small fixed caches in shared memory; PG 17 made their sizes configurable with parameters such as `transaction_buffers` and `subtransaction_buffers` and reduced their internal lock contention.',
      },
      {
        heading: 'What you would see in production',
        body:
          'Wait events named after the SLRUs mean a working set of transaction ids larger than the cache, typically from very long transactions coexisting with a high commit rate, or from subtransaction overflow. There is no `SLRU` wait event type: `wait_event_type` is `LWLock`, and the names are `XactBuffer` and `XactSLRU` for `pg_xact`, `SubtransBuffer` and `SubtransSLRU` for `pg_subtrans` — the `…Buffer` events are waits on page I/O, the `…SLRU` events waits to reach the cache itself. PG 17 renamed the sizing parameters to `transaction_buffers` and `subtransaction_buffers`, but the wait events kept the older `Xact` and `Subtrans` spellings. `pg_stat_slru` gives the hit and read counts for each cache directly. Vacuum eventually truncates `pg_xact` as the frozen transaction id advances, which is one of the quieter reasons vacuum is not optional.',
      },
      {
        heading: 'What the city models',
        body:
          'The city increments transaction ids and can derive how many two-bit status pages that range would occupy. It has no SLRU buffers, status lookups, hint-bit reads, cache hits, cache misses, eviction or I/O cost.',
      },
    ],
    metrics: [
      { label: 'Commits', get: (s) => fmtNum(nz(s.stats?.commits)) },
      { label: 'Rollbacks', get: (s) => fmtNum(nz(s.stats?.rollbacks)) },
      { label: 'Next xid', get: (s) => fmtNum(nz(s.xid)) },
      {
        label: 'pg_xact pages',
        get: (s) => `${fmtNum(Math.ceil(nz(s.xid) / 32768))} pages`,
        hint: '32768 transactions per 8 KiB page at two bits each',
      },
      { label: 'Commit rate', get: (s) => `${fmtNum(nz(s.stats?.tps))} /s` },
    ],
    knobs: ['tps', 'writeRatio'],
    see: ['proc.array', 'xmin.horizon', 'shmem.deck'],
    source: ['src/backend/access/transam/clog.c', 'src/backend/access/transam/slru.c', 'src/backend/access/heap/heapam.c'],
    refs: {
      docs: [
        manual('storage-file-layout.html', '66.1. Database File Layout'),
        manual('runtime-config-resource.html', '19.4. Resource Consumption — transaction_buffers, subtransaction_buffers'),
      ],
      source: [
        srcFile('src/backend/access/transam/clog.c', 'TransactionIdSetTreeStatus, TransactionIdGetStatus'),
        srcFile('src/backend/access/transam/slru.c', 'SimpleLruReadPage'),
      ],
      suzuki: suzuki(5, 'Concurrency Control (§5.4 Commit Log)'),
      rogov: rogov(R_MVCC, 'Pages and Tuples — transaction status and hint bits', 'the nearest chapter; Rogov has none on the SLRU caches themselves'),
    },
  },

  {
    id: 'stats.shmem',
    title: 'Cumulative Statistics',
    subtitle: 'the counters behind pg_stat_*',
    tldr: 'Per-object counters in shared memory since PG 15 — what autovacuum reads and what your dashboards graph.',
    sections: [
      {
        heading: 'What changed in PG 15',
        body:
          'Until PG 14 every backend sent statistics to a dedicated collector process over UDP, and the collector periodically wrote a file that readers had to load. Messages could be dropped under load and the view of the world could be seconds stale. PG 15 removed that process entirely and put the counters in shared memory, so updates are cheap, nothing is lost, and there is one fewer process in `ps`. If you learned that statistics are approximate and delayed, that was true and is no longer the main story.',
      },
      {
        heading: 'What is counted, and where to read it',
        body:
          "`pg_stat_user_tables` has sequential and index scans, tuples inserted, updated, deleted, live and dead tuple estimates, and the timestamps of the last vacuum and analyze. `pg_statio_user_tables` and `pg_stat_io` (PG 16) cover block reads and writes; `pg_stat_database` aggregates per database; `pg_stat_wal` covers WAL volume; and since PG 17 checkpoint counters live in `pg_stat_checkpointer` rather than `pg_stat_bgwriter`. (`pg_stat_replication`, despite the name, is a live view of each standby's positions, not a counter set.) The cumulative views count from the last `pg_stat_reset*` call, so what you want from them is almost always a rate, not a value.",
      },
      {
        heading: 'What autovacuum does with them',
        body:
          'Autovacuum workers read these counters to decide what to work on; the launcher only picks which database gets the next worker. A table qualifies for vacuum when its dead tuple estimate exceeds `autovacuum_vacuum_threshold` plus `autovacuum_vacuum_scale_factor` times its live tuple count — 50 plus 20% by default, which is far too lazy for a large hot table and is the most commonly overridden pair of settings in Postgres. Analyze has its own threshold, and since PG 13 inserts alone can trigger a vacuum through `autovacuum_vacuum_insert_threshold`, so that append-only tables still get their visibility map maintained.',
      },
      {
        heading: 'Two things people conflate',
        body:
          'These cumulative counters are *not* the planner statistics. `ANALYZE` writes histograms, most-common-value lists and correlations into `pg_statistic` for cost estimation; that is a different mechanism with a different lifecycle. It also matters that cumulative statistics are not crash safe: after a crash or an immediate shutdown they are discarded and start from zero, which is why autovacuum can go conspicuously quiet after an unclean restart. Within one transaction you see a stable snapshot of the counters by default — `stats_fetch_consistency` controls that if you are writing a monitoring query that must see live values.',
      },
    ],
    metrics: [
      { label: 'Commits', get: (s) => fmtNum(nz(s.stats?.commits)) },
      { label: 'Blocks hit', get: (s) => fmtNum(nz(s.stats?.blksHit)) },
      { label: 'Blocks read', get: (s) => fmtNum(nz(s.stats?.blksRead)) },
      { label: 'Tuples updated', get: (s) => fmtNum(nz(s.stats?.tupUpdated)) },
      { label: 'Autovacuum runs', get: (s) => fmtNum(nz(s.autovac?.totalRuns)) },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor'],
    see: ['autovac.worker', 'storage.table', 'planner.planner'],
    source: ['src/backend/utils/activity/pgstat.c'],
    refs: {
      docs: [manual('monitoring-stats.html', '27.2. The Cumulative Statistics System')],
      source: [
        srcFile('src/backend/utils/activity/pgstat.c', 'pgstat_report_stat'),
        srcFile('src/backend/utils/activity/pgstat_shmem.c'),
        srcFile('src/backend/utils/activity/pgstat_relation.c'),
      ],
    },
  },

  {
    id: 'wal.buffers',
    title: 'WAL Buffers',
    subtitle: 'the circular staging area for write-ahead log records',
    tldr: 'A small ring in shared memory where WAL records land before anyone writes them to pg_wal.',
    sections: [
      {
        heading: 'How a record gets in',
        body:
          'A backend builds a WAL record in its own memory first — the change, the block references, and any full-page images. Then it takes one of a small number of WAL insertion locks (eight of them, so several backends can copy in parallel), reserves its space with an atomic bump of the shared insert position, copies the bytes in, and releases the lock. Reserving the position is a handful of instructions; copying the bytes is not, and that is exactly why there are eight locks rather than one — several backends can be copying into different parts of the ring at the same time instead of queueing behind a single writer.',
      },
      {
        heading: 'Insert, write, flush — three different LSNs',
        body:
          'These are three distinct positions and confusing them causes real mistakes. The *insert* LSN is how far records have been placed into the buffer (`pg_current_wal_insert_lsn()`). The *write* LSN is how far has been handed to the operating system (`pg_current_wal_lsn()`). The *flush* LSN is how far has actually been fsynced and is therefore durable (`pg_current_wal_flush_lsn()`). A commit is durable once the flush LSN passes its commit record; with `synchronous_commit = off`, PostgreSQL may acknowledge the transaction before that point. Replication has its own versions of all three, plus a fourth: applied.',
      },
      {
        heading: 'When the ring fills',
        body:
          'The buffer is circular, so eventually the insert position comes back around to a page that has not been written out yet. Whichever backend gets there must write WAL itself before it can continue — a transaction doing an ordinary `UPDATE` suddenly paying for I/O. That is what `wal_buffers` exists to absorb, together with the walwriter draining it in the background every `wal_writer_delay`. The default `wal_buffers = -1` means one thirty-second of `shared_buffers` capped at one 16 MiB segment, which is plenty for most systems; write-heavy systems with bursty commits are the ones that benefit from pinning it at 16 MiB or a little more.',
      },
      {
        heading: 'What you would see in production',
        body:
          'Wait events `LWLock:WALWrite` and `LWLock:WALBufMapping` are the signature of a ring that is too small or storage that is too slow for the write rate — the two look similar from the application, which just sees write latency. `pg_stat_wal` gives the honest counters, including how many times a backend had to write buffers itself. Note that with `synchronous_commit = off` commits do not wait for the flush at all; the walwriter does it shortly afterwards, and the window of loss is bounded by that delay rather than by zero.',
      },
      {
        heading: 'What the city models',
        body:
          'The engine keeps aggregate insert, write and flush LSNs, a scaled WAL-buffer capacity, fill level, flush requests and a full-ring gate for backend/maintenance WAL. It does not store WAL records or ring pages, run insertion-lock contention, call write/fsync, expose real WAL wait events or calibrate the added model duration to storage latency.',
      },
    ],
    metrics: [
      { label: 'wal_buffers', get: (s) => fmtBytes(nz(s.wal?.bufferCapacity)) },
      {
        label: 'In use',
        get: (s) => `${fmtBytes(nz(s.wal?.bufferBytes))} (${fmtPct(ratio(nz(s.wal?.bufferBytes), nz(s.wal?.bufferCapacity)))})`,
      },
      { label: 'WAL rate', get: (s) => `${fmtBytes(nz(s.wal?.bytesPerSec))}/s` },
      { label: 'Insert LSN', get: (s) => fmtLsn(nz(s.wal?.insertLsn)) },
      {
        label: 'Not yet durable',
        get: (s) => fmtBytes(Math.max(0, nz(s.wal?.insertLsn) - nz(s.wal?.flushLsn))),
        hint: 'inserted minus flushed — what a crash would lose if commits did not wait',
      },
    ],
    knobs: ['tps', 'writeRatio', 'synchronousCommit', 'fullPageWrites'],
    see: ['shmem.deck', 'backend.slot', 'shared.buffers'],
    source: ['src/backend/access/transam/xlog.c', 'src/backend/access/transam/xloginsert.c'],
    refs: {
      docs: [
        manual('wal-configuration.html', '28.5. WAL Configuration'),
        manual('runtime-config-wal.html', '19.5. Write Ahead Log — wal_buffers, wal_writer_delay'),
      ],
      source: [
        srcFile('src/backend/access/transam/xlog.c', 'XLogInsertRecord, AdvanceXLInsertBuffer'),
        srcFile('src/backend/access/transam/xloginsert.c', 'XLogInsert'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.5)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log'),
    },
  },

  /* ======================================================================
   * The query lab
   * ====================================================================*/
  {
    id: 'planner.lab',
    title: 'The Query Lab',
    subtitle: 'from SQL text to rows on the wire',
    tldr: 'Five stages: parse, analyse, rewrite, plan, execute — all of it inside the one backend that owns the connection.',
    sections: [
      {
        heading: 'The pipeline',
        body:
          'A statement arrives as text. The *parser* turns it into a raw parse tree using grammar alone. *Analysis* resolves names against the catalogs, checks types, and produces a Query tree. The *rewriter* expands views, applies rules and adds row-level security predicates. The *planner* enumerates ways to execute that query and picks the cheapest. The *executor* runs the chosen plan and streams rows back through the protocol. Every one of those stages happens in the backend process for this connection, using its private memory.',
      },
      {
        heading: 'Two protocols, two costs',
        body:
          'The simple protocol sends a string and gets rows back, paying for parse, rewrite and plan every time. The extended protocol splits the work: `Parse` creates a prepared statement, `Bind` supplies parameters, `Execute` runs it — so repeated statements skip parsing and often skip planning. Almost every modern driver uses the extended protocol whether you asked for it or not, which is why a query with parameters can behave differently from the same query with literals pasted in.',
      },
      {
        heading: 'Plan caching, and its one sharp edge',
        body:
          'A prepared statement is planned as a custom plan for its first executions, using the actual parameter values. After a few of those, Postgres compares the average custom plan cost against a generic plan that ignores the parameters, and if the generic plan is not worse it switches to it and stops planning entirely. Usually that is a win. When your data is skewed — one parameter value matching a million rows and another matching three — the generic plan can be badly wrong for half your traffic. `plan_cache_mode` lets you force either behaviour. Note the cache is per session: with process-per-connection there is no shared plan cache to warm.',
      },
      {
        heading: 'Where the time actually goes',
        body:
          'For a short OLTP statement, planning can be a serious fraction of total time — hundreds of microseconds against a query that executes in one millisecond — which is the practical argument for prepared statements. For anything analytic, planning is noise and you should spend your attention on estimates and access paths. `EXPLAIN (ANALYZE)` prints Planning Time and Execution Time separately so you do not have to guess which case you are in.',
      },
      {
        heading: 'What the city models',
        body:
          'The lab uses six fixed statement templates and fixed teaching phases. It has no SQL grammar, catalog analysis, rewrite rules, prepared-plan cache or cost-based plan selection; the displayed alternative costs are fitted after the statement kind has already selected a plan template.',
      },
    ],
    metrics: [
      { label: 'Parsing', get: (s) => fmtNum(nIn(s, 'parse')) },
      { label: 'Planning', get: (s) => fmtNum(nIn(s, 'plan')) },
      { label: 'Executing', get: (s) => fmtNum(nIn(s, 'exec_cpu', 'exec_io', 'sort')) },
      { label: 'Returning rows', get: (s) => fmtNum(nIn(s, 'sending')) },
      { label: 'Throughput', get: (s) => `${fmtNum(nz(s.stats?.tps))} tps` },
    ],
    knobs: ['tps', 'seqScanRatio'],
    see: ['planner.parser', 'planner.rewriter', 'planner.planner', 'planner.executor'],
    source: ['src/backend/parser/analyze.c', 'src/backend/optimizer/plan/planner.c', 'src/backend/executor/execMain.c'],
    refs: {
      docs: [
        manual('query-path.html', '51.1. The Path of a Query'),
        manual('protocol-flow.html', '54.2. Message Flow'),
      ],
      source: [
        srcFile('src/backend/tcop/postgres.c', 'pg_parse_query, pg_analyze_and_rewrite_fixedparams, pg_plan_query'),
        srcFile('src/backend/utils/cache/plancache.c', 'choose_custom_plan'),
      ],
      suzuki: suzuki(3, 'Query Processing'),
      rogov: rogov(R_EXEC, 'Query Execution Stages'),
    },
  },

  {
    id: 'planner.parser',
    title: 'Parser & Analysis',
    subtitle: 'text to parse tree to query tree',
    tldr: 'Grammar first with no catalog access, then analysis resolves every name and type against the catalogs.',
    sections: [
      {
        heading: 'Two passes, deliberately separated',
        body:
          'The first pass is pure syntax: a lexer and a grammar produce a raw parse tree that mirrors the text, knowing nothing about whether the tables exist. The second pass, analysis, walks that tree and resolves it against the catalogs — turning names into object identifiers, working out the type of every expression, adding implicit casts, expanding `SELECT *` into an explicit target list, and checking that the statement makes semantic sense. Keeping them separate is what lets the server report a syntax error with an exact character position before touching a single catalog.',
      },
      {
        heading: 'What comes out',
        body:
          'The result is a Query tree: a range table listing every relation involved, a target list of output expressions, a join tree carrying the `FROM` structure and the `WHERE` qualifiers, and the sort, group and limit clauses. It is still a faithful description of *what* was asked for, with no decision at all about *how* — no index has been chosen, no join order fixed. The planner will consume this and produce something entirely different in shape.',
      },
      {
        heading: 'Where the locks start',
        body:
          'Analysis and name resolution are where the statement first opens its referenced relations and takes the required table locks, typically `ACCESS SHARE` for a `SELECT`. Raw parsing alone only produces a syntax tree; it does not resolve a table name or acquire that relation lock. This matters operationally: a session sitting in a transaction after analysis can retain the lock, and a pending `ACCESS EXCLUSIVE` request from DDL will queue behind it and can make later requests queue too.',
      },
      {
        heading: 'What you would see in production',
        body:
          'Errors here are the friendly ones: syntax errors with a caret pointing at the offending token, and "column does not exist" with a hint suggesting a similar name. They are also the cheapest failures — nothing has been planned or executed. Parsing cost is proportional to statement size, which is why a generated `IN` list with fifty thousand literals can spend more time being parsed than being executed.',
      },
    ],
    metrics: [
      { label: 'Parsing', get: (s) => fmtNum(nIn(s, 'parse')) },
      { label: 'Statements', get: (s) => `${fmtNum(nz(s.stats?.tps))} /s` },
      { label: 'Relations', get: (s) => `${fmtNum((s.tables ?? []).length)} tables` },
    ],
    knobs: ['tps'],
    see: ['planner.rewriter', 'planner.planner', 'planner.lab'],
    source: ['src/backend/parser/analyze.c'],
    refs: {
      docs: [
        manual('parser-stage.html', '51.3. The Parser Stage'),
        manual('query-path.html', '51.1. The Path of a Query'),
      ],
      source: [srcFile('src/backend/parser/analyze.c', 'parse_analyze_fixedparams, transformStmt')],
      suzuki: suzuki(3, 'Query Processing (§3.1)'),
      rogov: rogov(R_EXEC, 'Query Execution Stages — parsing'),
    },
  },

  {
    id: 'planner.rewriter',
    title: 'Rewriter',
    subtitle: 'views, rules and row-level security',
    tldr: 'Query tree in, query tree out — views are substituted, rules applied, security predicates added.',
    sections: [
      {
        heading: 'Views are rewrites, not objects',
        body:
          'A view is stored as a rule in `pg_rewrite`. When a query references one, the rewriter replaces that range table entry with the view definition as a subquery. Nothing is materialised and there is no runtime indirection — by the time the planner sees the query, the view has vanished into it, and the planner will usually flatten the subquery entirely. This is why a view over a table costs nothing by itself.',
      },
      {
        heading: 'When views do cost something',
        body:
          'Flattening is not always legal. A view containing an aggregate, `DISTINCT`, a window function, a `LIMIT`, or a volatile function forms an optimisation barrier: the planner cannot push your outer `WHERE` clause down through it, so the inner query computes far more rows than you asked to see. Stacked views over stacked views are the usual way this becomes a several-second query with an innocent-looking definition. If a query over a view is inexplicably slow, expand the view by hand and look at what could not move.',
      },
      {
        heading: 'Row-level security',
        body:
          'RLS policies are added here as extra qualifiers on the affected relations, so from the planner onwards they are just predicates. Order matters for safety: the security predicate must be evaluated before any user-supplied condition that could leak information, so a function in your `WHERE` clause that is not marked `LEAKPROOF` is forced to run *after* the policy check. That is a correctness requirement with a performance consequence — it can prevent an index from being used. The same rule governs `security_barrier` views.',
      },
      {
        heading: 'Rules, and why to avoid them',
        body:
          'The general rule system (`CREATE RULE ... DO INSTEAD`) can rewrite one statement into several, or into a completely different statement. It is powerful, surprising, and interacts badly with things people expect to work, such as `RETURNING` and statement counts. Outside of views, use triggers: they run in the executor with clear semantics. Rules survive mainly because views are built on them.',
      },
    ],
    metrics: [
      { label: 'Statements', get: (s) => `${fmtNum(nz(s.stats?.tps))} /s` },
      { label: 'Write share', get: (s) => fmtPct(nz(s.knobs?.writeRatio)), hint: 'writes go through the same rewriter' },
      { label: 'Relations', get: (s) => `${fmtNum((s.tables ?? []).length)} tables` },
    ],
    see: ['planner.parser', 'planner.planner', 'planner.lab'],
    source: ['src/backend/rewrite/rewriteHandler.c'],
    refs: {
      docs: [
        manual('rules-views.html', '39.2. Views and the Rule System'),
        manual('ddl-rowsecurity.html', '5.9. Row Security Policies'),
      ],
      source: [
        srcFile('src/backend/rewrite/rewriteHandler.c', 'fireRIRrules'),
        srcFile('src/backend/rewrite/rowsecurity.c', 'get_row_security_policies'),
      ],
      rogov: rogov(R_EXEC, 'Query Execution Stages — the transformation stage', 'Rogov gives the rewriter no section of its own'),
    },
  },

  {
    id: 'planner.planner',
    title: 'Planner',
    subtitle: 'cost-based optimisation — paths, estimates and the plan that wins',
    tldr: 'It enumerates ways to run the query, costs each one against statistics, and keeps the cheapest.',
    sections: [
      {
        heading: 'It does not pick an index — it enumerates paths',
        body:
          'For each relation the planner builds every access path it can: sequential scan, index scan, index-only scan, bitmap heap scan over one or more bitmap index scans, TID scan. Then it builds join paths over those — nested loop, hash join, merge join — for the join orders it is willing to consider, keeping at each step every path that is best at *something* rather than only the outright cheapest. Finally it turns the winning path tree into a Plan. In PostgreSQL 18.3, `join_collapse_limit` defaults to 8 and governs how far explicit JOIN/FROM structures are flattened; `geqo_threshold` defaults to 12 and separately controls when the genetic query optimizer is considered. They interact, but `join_collapse_limit` is not the threshold at which exhaustive search simply stops.',
      },
      {
        heading: 'The cost model',
        body:
          'Costs are relative estimates in arbitrary units; by convention `seq_page_cost` is 1.0 and the other constants are compared with it. `random_page_cost` defaults to 4.0, a value that combines the higher cost of non-sequential access with an assumption that many random reads are cached. The truthful value depends on the workload, storage, cache residency and the other cost constants, so there is no universal SSD or NVMe recipe. CPU work is represented by `cpu_tuple_cost` (0.01), `cpu_index_tuple_cost` (0.005) and `cpu_operator_cost` (0.0025). `effective_cache_size` allocates nothing — it is an estimate of cache available to a representative query across PostgreSQL and the operating system, not a prescribed fraction of system RAM. Calibrate these workload and cache assumptions together against a representative workload.',
      },
      {
        heading: 'Statistics and selectivity',
        body:
          '`ANALYZE` takes a random sample — 300 rows per unit of `default_statistics_target`, so 30000 rows at the default of 100 — and stores per column in `pg_statistic`: the fraction of nulls, an estimate of the number of distinct values, a list of most common values with their frequencies, a histogram of the rest, and the physical correlation between column order and row order. From those, the planner estimates what fraction of rows each qualifier will pass, multiplies its way up the tree, and gets a row count for every node. Everything else in the plan follows from those row counts, so an estimate that is wrong by 1000x produces a plan that is wrong by 1000x.',
      },
      {
        heading: 'Why estimates go wrong',
        body:
          'Four causes cover most cases. *Correlated columns*: the planner assumes independence, so `WHERE city = ? AND postcode = ?` multiplies two selectivities that are really the same one, and badly underestimates. *Out-of-range values*: on an append-only table, rows newer than the last `ANALYZE` fall past the end of the histogram. *Expressions*: ordinary per-column statistics do not describe `lower(email)`, but modern PostgreSQL can collect expression statistics with `CREATE STATISTICS ... ON (lower(email))` without an index; an expression index is a separate remedy when the query also needs indexed access. *n_distinct on large tables*: it is estimated from a sample and can be far too low, which wrecks join and grouping estimates.',
      },
      {
        heading: 'What to do about it',
        body:
          'First check the estimates, with `EXPLAIN (ANALYZE, BUFFERS)`, and find the *lowest* node where estimated and actual rows diverge — everything above it is a consequence, not a cause. Then fix the input: `ANALYZE` the table if it is stale, raise `default_statistics_target` or the per-column target for skewed columns, and use `CREATE STATISTICS` for correlated column groups or expressions. Add an expression index when indexed access is useful, not merely to obtain expression statistics. If estimates are sound but representative plans still price I/O incorrectly, calibrate `random_page_cost`, `seq_page_cost`, the CPU constants and `effective_cache_size` as a set from measured workload evidence. Use `enable_seqscan = off` only as a diagnostic; never leave it that way in production.',
      },
      {
        heading: 'What the city models',
        body:
          'A statement kind selects one fixed single-table plan template before the lab renders it. There are no joins, path enumeration, `ANALYZE` statistics, selectivity estimates or cost-driven alternatives; table statistics do not choose or change the model plan. Card costs, row estimates and node time are display-only teaching values.',
      },
    ],
    metrics: [
      { label: 'Planning', get: (s) => fmtNum(nIn(s, 'plan')) },
      { label: 'Seq scans', get: (s) => fmtNum(sumTables(s, (t) => t.seqScans)), hint: 'cumulative, all tables' },
      { label: 'Index scans', get: (s) => fmtNum(sumTables(s, (t) => t.idxScans)) },
      {
        label: 'Index share',
        get: (s) => {
          const idx = sumTables(s, (t) => t.idxScans)
          const seq = sumTables(s, (t) => t.seqScans)
          return fmtPct(ratio(idx, idx + seq))
        },
      },
      { label: 'Requested seq ratio', get: (s) => fmtPct(nz(s.knobs?.seqScanRatio)) },
    ],
    knobs: ['seqScanRatio', 'tps', 'writeRatio'],
    see: ['planner.executor', 'planner.plantree', 'stats.shmem', 'storage.index'],
    source: ['src/backend/optimizer/plan/planner.c', 'src/backend/optimizer/path/costsize.c'],
    refs: {
      docs: [
        manual('planner-optimizer.html', '51.5. Planner/Optimizer'),
        manual('runtime-config-query.html', '19.7. Query Planning'),
        manual('planner-stats.html', '14.2. Statistics Used by the Planner'),
        manual('sql-createstatistics.html', 'CREATE STATISTICS'),
      ],
      source: [
        srcFile('src/backend/optimizer/path/costsize.c', 'cost_seqscan, cost_index, index_pages_fetched'),
        srcFile('src/backend/utils/adt/selfuncs.c', 'eqsel, scalarineqsel, ineq_histogram_selectivity, get_actual_variable_range'),
        srcFile('src/backend/optimizer/path/allpaths.c', 'make_one_rel, set_subquery_pathlist, qual_is_pushdown_safe'),
      ],
      suzuki: suzuki(3, 'Query Processing (§3.2, §3.3, §3.6)'),
      rogov: rogov(R_EXEC, 'Query Execution Stages; Statistics'),
    },
  },

  {
    id: 'planner.executor',
    title: 'Executor',
    subtitle: 'a tree of nodes, pulling one tuple at a time',
    tldr: 'Each node asks its children for the next tuple — nothing is materialised unless a node has to.',
    sections: [
      {
        heading: 'Pull, do not push',
        body:
          'The executor turns the plan into a tree of node states and then asks the top node for a tuple. That node asks its children, which ask theirs, until a scan node reads a page and returns a row. The tuple flows back up through filters, joins and projections and out to the client, and then the whole thing happens again for the next row. Nothing runs to completion first; the query is a demand-driven pipeline.',
      },
      {
        heading: 'Blocking nodes are the exception',
        body:
          'Some nodes cannot answer until they have consumed their required input: `Sort` must see every row before it can return the first, and `Hash` must build its hash table before probing begins. A single global aggregate and HashAggregate are blocking in the useful sense; a sorted GroupAggregate can emit each completed group before consuming the entire input. These nodes have startup cost and are where `work_mem` is often spent. Streaming nodes such as sequential scans, nested loops and appends can return rows earlier, which is why `LIMIT 10` may be cheap over one plan and expensive over a plan that sorts fifty million rows first.',
      },
      {
        heading: 'What parallel query changes',
        body:
          'A `Gather` node asks the postmaster to start background workers, sets up a dynamic shared memory segment with a tuple queue per worker, and each worker runs its own copy of the subplan below. Scans below a Gather hand out page ranges so workers do not duplicate work; `Gather Merge` keeps sorted order at the cost of merging. The leader usually helps rather than waiting idle. Many plan nodes allocate private memory per worker, while Parallel Hash is deliberately different: workers cooperate on one shared hash table whose limit is based on the participating processes. Parallelism is disabled by parallel-unsafe functions and for plan regions that perform writes.',
      },
      {
        heading: 'Writes, and the part nobody expects',
        body:
          'Modifying statements have a `ModifyTable` node at the top that consumes rows from below and applies inserts, updates or deletes, firing triggers and evaluating `RETURNING`. Under `READ COMMITTED` there is one extra subtlety: if an `UPDATE` finds a row that another transaction changed since the snapshot was taken, it waits for that transaction, then re-evaluates its `WHERE` clause against the *new* version of the row and proceeds only if it still matches. That re-check is why an `UPDATE ... WHERE status = ?` under concurrency can affect fewer rows than the same statement in a serial run.',
      },
      {
        heading: 'What you would see in production',
        body:
          '`EXPLAIN (ANALYZE)` prints Workers Planned and Workers Launched; when launched is lower than planned you have exhausted `max_parallel_workers` or `max_worker_processes` cluster-wide, and queries are quietly running with less parallelism than the plan assumed. It is a common and invisible cause of "the same query is sometimes three times slower".',
      },
      {
        heading: 'What the city models',
        body:
          `The executor advances fixed teaching phases and activity through a preselected plan template. It prices explicit teaching working sets against per-node work_mem allowances for fixed Sort and HashAggregate nodes, but it does not allocate process memory or pull and materialize tuples node by node. It does not execute joins, launch parallel workers, create dynamic shared memory, fire triggers, recheck concurrent updates or measure CPU. Gather and parallel scan labels are illustrative plan shapes only. ${CLAIM_VALUES.workMem.coverageDisclosure}`,
      },
    ],
    metrics: [
      { label: 'Model CPU phase', get: (s) => fmtNum(nIn(s, 'exec_cpu')), hint: 'a teaching phase, not a pg_stat_activity CPU-running signal' },
      { label: 'Waiting on I/O', get: (s) => fmtNum(nIn(s, 'exec_io', 'eviction_flush')) },
      { label: 'Sorting or hashing', get: (s) => fmtNum(nIn(s, 'sort')) },
      { label: 'Streaming rows', get: (s) => fmtNum(nIn(s, 'sending')) },
      { label: 'Rows returned', get: (s) => fmtNum(nz(s.stats?.tupReturned)) },
    ],
    knobs: ['seqScanRatio', 'tps'],
    see: ['planner.plantree', 'planner.planner', 'backend.localmem', 'shared.buffers'],
    source: ['src/backend/executor/execMain.c'],
    refs: {
      docs: [
        manual('executor.html', '51.6. Executor'),
        manual('parallel-query.html', 'Chapter 15. Parallel Query'),
        manual('when-can-parallel-query-be-used.html', '15.2. When Can Parallel Query Be Used?'),
      ],
      source: [
        srcFile('src/backend/executor/execMain.c', 'standard_ExecutorRun, ExecutePlan'),
        srcFile('src/backend/executor/execProcnode.c', 'ExecInitNode, ExecProcNodeFirst'),
        srcFile('src/backend/executor/nodeGather.c', 'ExecGather, gather_readnext'),
      ],
      suzuki: suzuki(3, 'Query Processing (§3.4, §3.7)'),
      rogov: rogov(R_EXEC, 'Query Execution Stages; Nested Loop; Hashing; Merging and Sorting'),
    },
  },

  {
    id: 'planner.plantree',
    title: 'Reading a Plan',
    subtitle: 'how to get useful information out of EXPLAIN',
    tldr: 'Read it inside-out and bottom-up, and compare estimated rows against actual rows before anything else.',
    sections: [
      {
        heading: 'The shape',
        body:
          'A plan is a tree printed with indentation: a node is fed by the nodes indented under it. So the first line is the *last* thing that happens, and execution really starts at the deepest, most indented scan. Read it inside-out. Costs are shown as `cost=startup..total` and are inclusive estimates in arbitrary units. You cannot safely isolate a node’s own cost by subtracting its children: nodes can have multiple inputs, execute a child repeatedly, rescan it, or divide work across parallel participants. Use costs to compare candidate plans; use actual time, loops and buffers to understand an observed execution.',
      },
      {
        heading: 'The first thing to check, always',
        body:
          'Compare `rows=` (the estimate) with `actual rows=` on every node and find the deepest one where they diverge by more than roughly an order of magnitude. That node is the cause; every bad choice above it is a symptom. Watch the `loops=` counter while you do it: `actual rows` and `actual time` are per loop averages, so a node showing 3 rows and 20000 loops returned 60000 rows and consumed 20000 times its printed time. A nested loop whose outer side was estimated at one row and delivered a million is the single most common catastrophic plan.',
      },
      {
        heading: 'The tells worth knowing',
        body:
          '`Rows Removed by Filter` means the node read a lot to throw most of it away — often a missing or unusable index. `Heap Fetches` on an Index Only Scan means the visibility map did not let every tuple be answered from the index. `Sort Method: external merge  Disk: nnnnkB` means the sort spilled beyond `work_mem`; `lossy` bitmap blocks mean page-granularity rechecks. `Never Executed` means the node was pruned or the loop ended early. In `Buffers`, `shared hit=` means the page was already in `shared_buffers`; `shared read=` means a shared-buffer miss caused PostgreSQL to issue a read, which the OS page cache may still satisfy without device I/O. Always ask for `BUFFERS`, but do not over-read it.',
      },
      {
        heading: 'How to run it honestly',
        body:
          '`EXPLAIN` alone gives you only estimates; `EXPLAIN (ANALYZE)` actually runs the statement, so never run it on a `DELETE` outside a transaction you intend to roll back. Timing instrumentation itself costs something on systems with a slow clock — `EXPLAIN (ANALYZE, TIMING OFF)` tells you if that is distorting the result. Turn on `track_io_timing` to get real I/O times in the buffers output. And for the queries you cannot reproduce by hand, `auto_explain` with a duration threshold captures the plan that was actually used in production, which is frequently not the plan you get in psql.',
      },
      {
        heading: 'What the city shows',
        body:
          `The tree is a fixed model template. Its row figures and costs are display-only, and it has no estimated-versus-actual pair, loops, filters, buffer annotations, heap fetches, worker launch or EXPLAIN execution. Fixed Sort and HashAggregate nodes do report the model’s in-memory or spilled method from \`work_mem\`; that never changes the selected template. ${CLAIM_VALUES.workMem.coverageDisclosure} Node time is accumulated on the stretched model clock and is labeled model time, not PostgreSQL execution time.`,
      },
    ],
    metrics: [
      {
        label: 'Plan on show',
        get: (s) => {
          const p = firstPlan(s)
          return p ? p.label : '—'
        },
      },
      { label: 'Nodes', get: (s) => fmtNum(countPlanNodes(firstPlan(s))) },
      {
        label: 'Display rows',
        get: (s) => {
          const p = firstPlan(s)
          return p ? fmtNum(nz(p.rows)) : '—'
        },
      },
      {
        label: 'Display cost',
        get: (s) => {
          const p = firstPlan(s)
          return p ? fmtNum(nz(p.cost), 2) : '—'
        },
      },
      { label: 'Executing', get: (s) => fmtNum(nIn(s, 'exec_cpu', 'exec_io', 'sort')) },
    ],
    knobs: ['seqScanRatio'],
    see: ['planner.planner', 'planner.executor', 'planner.lab', 'shared.buffers'],
    source: ['src/backend/executor/execMain.c', 'src/backend/optimizer/path/costsize.c'],
    refs: {
      docs: [
        manual('using-explain.html', '14.1. Using EXPLAIN'),
        manual('executor.html', '51.6. Executor'),
      ],
      source: [
        srcFile('src/backend/commands/explain.c', 'ExplainNode'),
        srcFile('src/backend/optimizer/path/costsize.c', 'cost_seqscan, cost_gather_merge'),
      ],
      suzuki: suzuki(3, 'Query Processing (§3.3, §3.6)'),
      rogov: rogov(R_EXEC, 'Query Execution Stages'),
    },
  },
]
