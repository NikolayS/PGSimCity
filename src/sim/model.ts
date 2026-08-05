/* ============================================================================
 * PGSimCity — THE SIMULATION
 *
 * This file is the engine. Everything the city draws is a projection of the
 * state produced here, so the rules below are meant to be *true*, not pretty:
 * the clock sweep really sweeps, the backend really writes out its own victim
 * page when shared_buffers is too small, full-page writes really explode right
 * after a checkpoint, and an old snapshot really does stop vacuum dead.
 *
 * THREE HONEST DISTORTIONS, all deliberate:
 *
 *  1. BACKEND LIFECYCLE TIME IS STRETCHED for anything sub-second. A real
 *     parse is ~50µs and a real fsync is ~1ms; at 60fps you would never see
 *     either. Those durations are a monotone stretch (~100x) of the real one,
 *     so the *shape* is faithful while the absolute numbers are theatre.
 *     Replication packet travel uses its own smaller 6x visual stretch, but
 *     configured network delay and replay_lag are converted back to real
 *     seconds at every readout. Rates (tps, bytes/sec, LSNs) are not stretched.
 *
 *  2. THE CITY IS A SCALE MODEL. The plaza samples at most 1,024 frames from
 *     the logical shared_buffers pool, alongside 16 backend slots and 14 visible
 *     WAL segments. To let 16 towers represent thousands of transactions per
 *     second, one trip through the backend state machine carries `batch`
 *     transactions, and all work (pages touched, WAL bytes, dead tuples) is
 *     multiplied by that batch, so the pool and the WAL see the real pressure.
 *     The latency instrument retains one weighted observation for that whole
 *     trip, so it does not model variance among transactions inside a batch.
 *     At the city's 30 Hz integration step those observations are quantized to
 *     33.33 model ms.
 *
 *     `batch` is a fixed FUNCTION OF THE OFFERED RATE — `tps / NOMINAL_TRIPS` —
 *     and nothing else. It is deliberately NOT a controller. Sizing it from the
 *     measured trip rate closed a feedback loop that cancelled every bottleneck
 *     in the model: slow trips produced proportionally bigger batches, so
 *     achieved tps tracked the tps knob at 0.90–1.00 with shared_buffers at 32,
 *     with 78% of backend-seconds parked in `blocked`, and at 50,000 offered
 *     tps. PostgreSQL has no such compensator. Achieved throughput here is
 *     `trips/s * batch` and is therefore an OUTPUT: it falls in exact
 *     proportion to any slowdown in the trip loop, and it saturates when the
 *     fleet is full.
 *
 *     One corollary, and it is load-bearing: the page STREAM a trip pushes
 *     through the pool is sampled at MAX_VISIT_PAGES, because the city cannot
 *     animate a hundred thousand buffer requests inside one trip — but the TIME
 *     that trip costs is charged on the unsampled amount (`work` in
 *     beginExec()). Charge the time on the sampled count and every transaction
 *     in the batch past the cap is free, which is the batch controller's bug
 *     rebuilt out of a different part. Anything that samples for the animation's
 *     sake must leave the cost alone.
 *
 *  3. THE OPENING WAL SEGMENT IS STAGED NEAR COMPLETION. The city opens 92%
 *     into a real 16 MiB segment, before its silent 14-second warm-up, so a
 *     reader can watch the remaining bytes close and enter archive_command.
 *     Only the starting LSN is staged: WAL rates, LSN deltas, segment size,
 *     max_wal_size arithmetic, and later segment fill remain unscaled.
 * ==========================================================================*/

import {
  DEFAULT_KNOBS,
  N_BACKEND_SLOTS,
  N_BUFFERS,
  N_VAC_WORKERS,
  N_WAL_SEG_SLOTS,
  SHARED_BUFFERS_FULL_SAMPLE_MIB,
} from '../core/types'
import { N_TABLES, TABLES } from '../core/catalog'
import { CLAIM_VALUES, ordinaryConnectionCapacity } from '../core/claims'
import { traceStopBit, walTriggerBytes } from '../core/model-helpers'
import { configuredSynchronousStandby } from '../core/replication'
import { rid } from '../core/route-ids'
import type {
  BackendSim,
  BackendState,
  BaseBackupWalRange,
  BufferPool,
  Bus,
  ClusterNodeId,
  ClusterNodeWalState,
  FlowKind,
  FlowRequest,
  Knobs,
  LatencyQuantile,
  LatencyWaits,
  PhysicalReplicationSlotState,
  PhysicalStandbyState,
  PlanNode,
  PoolMode,
  QueryKind,
  RestoreDrillLevel,
  SampleFrames,
  ScenarioChoiceId,
  ScenarioDecisionState,
  SimApi,
  SimState,
  TableSim,
  TracePlayback,
  TraceRequestOptions,
  TraceStop,
  VacPhase,
  VacWorker,
  WalSegment,
} from '../core/types'
import {
  clamp,
  clamp01,
  damp,
  expDelay,
  fmtBytes,
  fmtLsn,
  makeRng,
  pushHistory,
  walSegName,
  weightedPick,
} from '../core/util'
import { SCENARIOS, SCENARIO_NARRATION_SECONDS } from './scenarios'
import {
  collectRepresentativeVersions,
  createRepresentativeRow,
  holdRepresentativeSnapshot,
  recordRepresentativeUpdate,
  refreshRepresentativeRow,
  releaseRepresentativeSnapshot,
} from './mvcc'

export { traceStopBit, walTriggerBytes } from '../core/model-helpers'

const STATEMENT_TRANSACTION_ERROR =
  CLAIM_VALUES.pgBouncerPoolModes.statementTransactionError

function usesMultiplexedPoolQueue(mode: PoolMode): boolean {
  return mode === 'transaction' || mode === 'statement'
}

/* --------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------*/

const PHYSICAL_STANDBY_KNOBS = [
  {
    enabled: 'standbyAEnabled',
    networkLag: 'standbyANetworkLag',
    slowApply: 'standbyASlowApply',
  },
  {
    enabled: 'standbyBEnabled',
    networkLag: 'standbyBNetworkLag',
    slowApply: 'standbyBSlowApply',
  },
] as const

const PAGE = 8192
const WAL_SEG: typeof CLAIM_VALUES.walSegment.bytes = CLAIM_VALUES.walSegment.bytes
const INITIAL_WAL_SEGMENT_START = 0x1a000000
const INITIAL_WAL_LSN = INITIAL_WAL_SEGMENT_START + Math.floor(WAL_SEG * 0.92)
/** BAS_BULKREAD: a big seq scan gets a 256 KiB ring so it cannot evict the pool. */
export const MODEL_BULK_READ_RING_FRAMES: typeof CLAIM_VALUES.bulkReadRing.modelFrames =
  CLAIM_VALUES.bulkReadRing.modelFrames
const RING = MODEL_BULK_READ_RING_FRAMES
const STEP_MAX = 1 / 30
/** Keep UI disclosures tied to the first distortion documented in this file header. */
export const MODEL_TIME_STRETCH = 100
/** A pooled connection hand-off: long enough for Slow mode to render once. */
const TRACE_CONNECT_DUR = 0.03
/** A cache hit still passes through the trace's buffer-fetch stop. */
const TRACE_FETCH_DUR = 0.05
/** One physical row stands in for a table-wide stream; keep its changes legible. */
const MVCC_SAMPLE_SECONDS = 3
/** Most sub-steps one update() call may run, so a huge delta cannot stall the tab. */
const MAX_STEPS = 20
const IDLE_REAP = 22
const MIB = 1024 * 1024
/** Per-standby physical stream capacity in unstretched model bytes per second. */
export const MODEL_PHYSICAL_REPLICATION_LINK_BYTES_PER_SEC:
  typeof CLAIM_VALUES.physicalReplicationLink.bytesPerSec =
    CLAIM_VALUES.physicalReplicationLink.bytesPerSec
const WORK_MEM_HASH_MULTIPLIER = CLAIM_VALUES.workMem.hashMemMultiplier
const WORK_MEM_SPILL_PENALTY = CLAIM_VALUES.workMem.spillSlowdown - 1
const AUTOVACUUM_VACUUM_THRESHOLD = 50
const AUTOVACUUM_VACUUM_MAX_THRESHOLD = 100_000_000
const AUTOVACUUM_VACUUM_INSERT_THRESHOLD = 1_000
/** A visible full backup of the ~8 GiB city takes tens of simulated seconds. */
export const DR_BACKUP_BYTES_PER_SEC = 384 * MIB
/** Object-store download is faster than the backup's checksum/compress path. */
export const DR_RESTORE_BYTES_PER_SEC = 640 * MIB
/** Startup-process replay rate on the separate recovery host. */
export const DR_WAL_REPLAY_BYTES_PER_SEC = 24 * MIB
/** One download worker's scaled base-backup object throughput. */
const DR_BACKUP_FETCH_BYTES_PER_STREAM_SEC = 64 * MIB
/** Small WAL-object requests expose latency sooner than large backup objects. */
const DR_WAL_FETCH_BYTES_PER_STREAM_SEC = 4 * MIB
/** Scaled wal-push service time for one completed 16 MiB segment. */
export const DR_ARCHIVE_SEGMENT_SECONDS = 0.75
/** One daily schedule interval on the continuity quarter's compressed clock. */
export const DR_BACKUP_CADENCE_SECONDS = 60
/** Sequential local reads performed by the manifest verification phase. */
export const DR_DRILL_VERIFY_BYTES_PER_SEC = 768 * MIB
/** A modeled expected-row lookup reads an index root, leaf, and heap block. */
export const DR_DRILL_SMOKE_BLOCKS_PER_TABLE = 3
export const DR_DRILL_SMOKE_BYTES_PER_SEC = 512 * MIB
/** Teaching-scale pg_wal volume; production capacity is installation-specific. */
export const DR_PG_WAL_CAPACITY_BYTES = 512 * MIB
/** Fixed metadata/catalog allowance outside the declared heap and index pages. */
const DR_DATA_DIRECTORY_OVERHEAD_BYTES = 256 * MIB
/** Compression is illustrative: data entropy and tool settings decide reality. */
const DR_OBJECT_STORE_RATIO = 0.65
/** Fixed rings retain timestamps without allocating in the update path. */
const DR_HISTORY_SLOTS = 4096
/** Patroni timings are compressed for observation; they are not recommendations. */
const HA_LEASE_TTL_SECONDS = 4
const HA_LEASE_RENEW_SECONDS = 1
/** pg_rewind first checks prerequisites, then copies a scaled byte range. */
const REWIND_CHECK_SECONDS = 2
const REWIND_BYTES_PER_SEC = 8 * MIB
const COMMIT_HISTORY_SLOTS = 4096
/** PostgreSQL's wal_buffers=-1 rule: shared_buffers/32, 64 KiB to one segment. */
const walBufferCapacity = (sharedBuffersMiB: number): number =>
  clamp((sharedBuffersMiB * MIB) / 32, 64 * 1024, WAL_SEG)
const DECLARED_WORKING_SET_PAGES = TABLES.reduce(
  (total, table) => total + table.pages + table.indexes.reduce((sum, index) => sum + index.pages, 0),
  0,
)
const FULL_SAMPLE_PAGES = Math.min(
  DECLARED_WORKING_SET_PAGES,
  (SHARED_BUFFERS_FULL_SAMPLE_MIB * MIB) / PAGE,
)

/**
 * Convert the real MiB setting into the fixed-size representative plaza.
 * Scale capacity and page identities against the same working set; otherwise
 * the 1,024-frame sample acts like the whole pool and evicts pages that fit.
 */
function asSampleFrames(value: number): SampleFrames {
  return value as SampleFrames
}

function sampledBufferFrames(logicalMib: number): SampleFrames {
  const logicalPages = Math.floor((logicalMib * MIB) / PAGE)
  const scaled = Math.round((logicalPages / FULL_SAMPLE_PAGES) * N_BUFFERS)
  return asSampleFrames(clamp(scaled, 32, N_BUFFERS))
}

function createBufferPoolState(sharedBuffersMiB: number, hitRatio: number): BufferPool {
  return {
    sampleFrames: sampledBufferFrames(sharedBuffersMiB),
    valid: new Uint8Array(N_BUFFERS),
    dirty: new Uint8Array(N_BUFFERS),
    pinned: new Uint8Array(N_BUFFERS),
    usage: new Uint8Array(N_BUFFERS),
    rel: new Uint8Array(N_BUFFERS),
    lastTouch: new Float32Array(N_BUFFERS),
    blk: new Uint32Array(N_BUFFERS),
    pageLsn: new Float64Array(N_BUFFERS),
    clockHand: 0,
    hits: 0,
    misses: 0,
    evictions: asSampleFrames(0),
    dirtyEvictions: 0,
    hitRatio,
    dirtyCount: asSampleFrames(0),
    pinnedCount: asSampleFrames(0),
    usedCount: asSampleFrames(0),
  }
}

function createClusterWalState(lsn: number): ClusterNodeWalState {
  return {
    receivedLsn: lsn,
    writtenLsn: lsn,
    flushedLsn: lsn,
    appliedLsn: lsn,
    segmentSize: WAL_SEG,
    segmentCount: N_WAL_SEG_SLOTS,
    diskBytes: N_WAL_SEG_SLOTS * WAL_SEG,
  }
}

function clusterNodeIndex(id: ClusterNodeId): 0 | 1 | 2 {
  return id === 'primary' ? 0 : id === 'standbyA' ? 1 : 2
}

function isRunningState(state: BackendState): boolean {
  return state !== 'free'
    && state !== 'starting'
    && state !== 'idle'
    && state !== 'idle_in_xact'
    && state !== 'ending'
}

/** autovacuum_naptime. Real default is 60s; compressed so the yard stays alive. */
const AV_NAPTIME = 12
/**
 * lock_timeout, in seconds; 0 means **wait forever**, and that is PostgreSQL's
 * default (`runtime-config-client.html`). It is also the whole reason one
 * ACCESS EXCLUSIVE lock takes a database down: a blocked session keeps its
 * max_connections slot for as long as it waits, so waiters accumulate until the
 * pool is gone and queries that never touch the locked table start failing too.
 *
 * The city used to abort every waiter after 15 s unconditionally, which churned
 * the pool instead of filling it — each freed slot immediately re-rolled and had
 * only a ~26% chance of blocking again, so the slots never stayed exhausted and
 * the connection-pool cascade could not happen at all.
 *
 * FOLLOW-UP (needs src/core/types.ts + src/ui/content.ts, both outside this
 * workflow's file scope): promote this to a `lockTimeout` knob — KNOB_META
 * group `chaos`, unit s, default 0 — and read `K.lockTimeout` in
 * lockTimeoutSec() instead of the two constants here.
 */
const LOCK_TIMEOUT_DEFAULT = 0
/**
 * Guided scenarios that set lock_timeout for themselves, by scenario id. Stands
 * in for `knobs: { lockTimeout: 15 }` until the knob exists.
 *
 * It is applied at a BEAT, not at scenario start, because `lock-pileup` narrates
 * the cascade in order: the waiters queue (12 s), the queue poisons everything
 * behind it (26 s), the pool runs out and unrelated queries start failing
 * (42 s) — none of which can happen if every waiter aborts after 15 s — and
 * only then, at 58 s, "lock_timeout saves you". `atSec` must stay in step with
 * that beat in scenarios.ts.
 */
const SCENARIO_LOCK_TIMEOUT: Readonly<Record<string, { atSec: number; sec: number }>> = {
  'lock-pileup': { atSec: 58, sec: 15 },
}
/**
 * Trips per second the sixteen backend slots complete when nothing is wrong.
 * This is a SCALE CONSTANT, not a control target: `batchSize` is derived from
 * it so that one healthy fleet sustains roughly the offered rate, and any
 * slowdown in the trip loop shows up one-for-one in achieved tps.
 */
const NOMINAL_TRIPS = 35
/** Teaching-scale concurrency knee; it is not a claim about a production core count. */
export const MODEL_BACKEND_CONCURRENCY_TARGET: typeof CLAIM_VALUES.connectionPooler.concurrencyTarget =
  CLAIM_VALUES.connectionPooler.concurrencyTarget
/** Fixed teaching lifetime used to make session-pool binding observable. */
export const MODEL_SESSION_CONNECTION_LIFETIME = 15
/** Fixed storage for aggregate arrival cohorts; compaction preserves every transaction. */
const POOL_QUEUE_BUCKETS = 8192

/**
 * PostgreSQL work slows after the modeled concurrency knee regardless of who
 * admitted the connections. A pooler only keeps the input below this curve.
 */
export function backendConcurrencyMultiplier(serverConnections: number): number {
  const excess = Math.max(0, serverConnections - MODEL_BACKEND_CONCURRENCY_TARGET)
    / MODEL_BACKEND_CONCURRENCY_TARGET
  return 1 + 2.5 * excess * excess
}
/**
 * Ceiling on the pages one vacuum pass may hand back. Real truncation makes a
 * non-blocking ACCESS EXCLUSIVE attempt; if that fails, VACUUM skips truncation
 * and returns without waiting, leaving the space in the table this time.
 */
const TRUNCATE_MAX_PAGES = 8
const MAX_VISIT_PAGES = 2400
const PAGE_OPS_PER_SEC = 60000
/**
 * Where a relation's index blocks start in the buffer key space. Keep this
 * above every enlarged heap so heap growth cannot collide with index leaves.
 */
const IDX_BASE = 1 << 20
const FLOW_BUDGET_PER_SEC = 420
export const MODEL_LATENCY_WINDOW_TRIPS: typeof CLAIM_VALUES.modelLatency.windowTrips =
  CLAIM_VALUES.modelLatency.windowTrips
const WAL_WRITER_DELAY = 0.2
const BGW_DELAY = 0.2
/** BgBufferSync's fixed horizon for scanning the whole pool while idle. */
const BGW_SCAN_WHOLE_POOL_SECONDS = 120
/** Packet-flight animation only; replication timings are converted back out. */
const NET_PACKET_STRETCH = 6
/** The write acknowledgement precedes the standby's durable flush acknowledgement. */
const REPLICA_WRITE_ACK_DELAY_FRACTION = 0.65
/** Startup-process replay work after the standby has flushed a commit record. */
const REPLICA_APPLY_ACK_DELAY = 0.12

export function sqlFor(kind: QueryKind, ti: number): string {
  const n = TABLES[ti].name
  switch (kind) {
    case 'select_idx':
      return `SELECT * FROM ${n} WHERE id = $1`
    case 'select_seq':
      if (n === 'events') return `SELECT * FROM events WHERE payload @> $1 ORDER BY created_at DESC LIMIT 50`
      if (n === 'sessions') return `SELECT * FROM sessions WHERE expires_at > $1`
      if (n === 'orders') return `SELECT * FROM orders WHERE created_at > $1`
      if (n === 'documents') return `SELECT * FROM documents WHERE search @@ plainto_tsquery('english', $1)`
      return `SELECT * FROM accounts WHERE updated_at > $1`
    case 'aggregate':
      if (n === 'orders') return `SELECT status, count(*), sum(total) FROM orders GROUP BY 1`
      if (n === 'accounts') return `SELECT owner, count(*), sum(balance) FROM accounts GROUP BY 1`
      if (n === 'events') return `SELECT kind, count(*) FROM events GROUP BY 1`
      return `SELECT account_id, count(*) FROM ${n} GROUP BY 1`
    case 'insert':
      if (n === 'accounts') return `INSERT INTO accounts (id, owner, balance, updated_at) VALUES ($1, $2, $3, $4) RETURNING id`
      if (n === 'orders') return `INSERT INTO orders (id, account_id, status, total, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`
      if (n === 'events') return `INSERT INTO events (id, account_id, kind, payload, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`
      if (n === 'sessions') return `INSERT INTO sessions (id, account_id, expires_at, last_seen_at, metadata) VALUES ($1, $2, $3, $4, $5) RETURNING id`
      return `INSERT INTO documents (id, account_id, title, body) VALUES ($1, $2, $3, $4) RETURNING id`
    case 'update':
      if (n === 'accounts') return `UPDATE accounts SET balance = balance + $1 WHERE id = $2`
      if (n === 'orders') return `UPDATE orders SET status = $1 WHERE id = ANY ($2)`
      if (n === 'events') return `UPDATE events SET created_at = $1 WHERE id = ANY ($2)`
      if (n === 'sessions') return `UPDATE sessions SET last_seen_at = now(), expires_at = $1 WHERE id = ANY ($2)`
      return `UPDATE documents SET body = $1 WHERE id = ANY ($2)`
    case 'delete':
      if (n === 'sessions') return `DELETE FROM sessions WHERE expires_at < now()`
      if (n === 'accounts') return `DELETE FROM accounts WHERE updated_at < $1`
      return `DELETE FROM ${n} WHERE id < $1`
  }
}
/**
 * Pages per second the modelled storage device sustains before writes start
 * queueing behind each other. Calibrated so a healthy OLTP city sits at
 * ~1.1-1.4x pressure and a squeezed checkpoint (`checkpoint_completion_target`
 * near 0.1) pushes it to the ceiling — which is the whole reason that GUC
 * exists. See ioPressure().
 */
const DEVICE_PAGES_PER_SEC = 900
/** Cost-based delay leaves three quarters of the device to foreground work. */
const VACUUM_DEVICE_SHARE = 0.25
const VACUUM_PAGES_PER_WORKER_SEC =
  (DEVICE_PAGES_PER_SEC * VACUUM_DEVICE_SHARE) / N_VAC_WORKERS

/**
 * The WAL distance that triggers a checkpoint. `CalculateCheckPointSegments()`,
 * src/backend/access/transam/xlog.c:
 *
 *     CheckPointSegments = ConvertToXSegs(max_wal_size_mb, wal_segment_size)
 *                          / (1.0 + CheckPointCompletionTarget)
 *
 * A checkpoint has to *start* early enough that the WAL produced while it
 * spreads itself out — completion_target of one whole cycle — still fits under
 * max_wal_size. At the 0.9 default that is 53% of the knob, not 100%. Triggering
 * at the full max_wal_size is what made pg_wal peak at (1 + target) times the
 * number the user set.
 */
/* --------------------------------------------------------------------------
 * Internal per-backend bookkeeping the UI never sees.
 * ------------------------------------------------------------------------*/

interface Extra {
  txCount: number
  latencyCount: number
  rowsPerStmt: number
  pagesLeft: number
  pagesTotal: number
  execTotal: number
  execElapsed: number
  commitLsn: number
  writes: boolean
  needsSort: boolean
  postFilterCpu: boolean
  hot: boolean
  seqScan: boolean
  scanBlk: number
  visitT: number
  poolSlotWaitT: number
  bufferReadWaitT: number
  dirtyWriteWaitT: number
  dirtyWriteDuringReadT: number
  tempFileWaitT: number
  evictionWalWaitT: number
  commitWaitT: number
  lockWaitT: number
  idleT: number
  sessionAgeT: number
  nextSessionPoolWaitT: number
  holdsLock: boolean
  ringPos: number
  planFlat: PlanNode[]
  planStart: number[]
  planEnd: number[]
  fpiBytes: number
  walPending: number
  walPendingFpi: number
  walPrepared: boolean
  evictionBuffer: number
  evictionFlushLsn: number
  evictionVictimRel: number
  evictionVictimBlk: number
  evictionRel: number
  evictionBlk: number
  evictionForWrite: boolean
  evictionResumeState: 'exec_io' | 'exec_cpu'
  evictionResumeT: number
  evictionResumeDur: number
  workMemCountersRecorded: boolean
}

interface TraceRequest {
  kind: QueryKind
  table: number
  hot: boolean | undefined
  sql: string | undefined
  announced: boolean
  readyT: number
}

function makeExtra(): Extra {
  return {
    txCount: 0,
    latencyCount: 0,
    rowsPerStmt: 1,
    pagesLeft: 0,
    pagesTotal: 0,
    execTotal: 0.2,
    execElapsed: 0,
    commitLsn: 0,
    writes: false,
    needsSort: false,
    postFilterCpu: false,
    hot: false,
    seqScan: false,
    scanBlk: 0,
    visitT: 0,
    poolSlotWaitT: 0,
    bufferReadWaitT: 0,
    dirtyWriteWaitT: 0,
    dirtyWriteDuringReadT: 0,
    tempFileWaitT: 0,
    evictionWalWaitT: 0,
    commitWaitT: 0,
    lockWaitT: 0,
    idleT: 0,
    sessionAgeT: 0,
    nextSessionPoolWaitT: 0,
    holdsLock: false,
    ringPos: 0,
    planFlat: [],
    planStart: [],
    planEnd: [],
    fpiBytes: 0,
    walPending: 0,
    walPendingFpi: 0,
    walPrepared: false,
    evictionBuffer: -1,
    evictionFlushLsn: 0,
    evictionVictimRel: 0,
    evictionVictimBlk: 0,
    evictionRel: 0,
    evictionBlk: 0,
    evictionForWrite: false,
    evictionResumeState: 'exec_cpu',
    evictionResumeT: 0,
    evictionResumeDur: 0,
    workMemCountersRecorded: false,
  }
}

/* --------------------------------------------------------------------------
 * createSim
 * ------------------------------------------------------------------------*/

export interface SimOptions {
  /** Aggregate probes may trade frame resolution for fewer deterministic steps. */
  maxStep?: number
  /** Aggregate mechanism probes may isolate themselves from the daily DR job. */
  scheduledBackups?: boolean
  /** Test/measurement hook; production leaves this unset and allocates nothing. */
  latencyObserver?: (observation: Readonly<ModelLatencyObservation>) => void
  /** Test-only invariant hook called immediately before a representative page write. */
  pageWriteObserver?: (observation: Readonly<PageWriteObservation>) => void
}

export interface ModelLatencyObservation {
  totalMs: number
  waits: LatencyWaits
  /** Subset of dirtyWriteMs spent in XLogFlush for a dirty victim. */
  evictionWalFlushMs: number
  transactions: number
}

export interface PageWriteObservation {
  path: 'backend' | 'bgwriter' | 'checkpointer'
  pageLsn: number
  flushLsn: number
  pageLsnOwners: number
  tagMapped: boolean
  afterWalWait: boolean
}

export function createSim(bus: Bus, options: Readonly<SimOptions> = {}): SimApi {
  const maxStep = options.maxStep ?? STEP_MAX
  const scheduledBackups = options.scheduledBackups ?? true
  const latencyObserver = options.latencyObserver
  const pageWriteObserver = options.pageWriteObserver
  if (!isFinite(maxStep) || maxStep <= 0 || maxStep > STEP_MAX * MAX_STEPS) {
    throw new Error(`invalid simulation maxStep: ${maxStep}`)
  }
  const rng = makeRng(0xc0ffee)
  // Particle sampling must not perturb workload selection when I/O rates move.
  const presentationRng = makeRng(0x10cafe)
  const rr = (lo: number, hi: number) => lo + (hi - lo) * rng()

  /* ---- state skeleton (built once, then reset in place: world modules hold
   *      references to state.buffers, state.backends, … forever) ---------- */

  const backends: BackendSim[] = []
  for (let i = 0; i < N_BACKEND_SLOTS; i++) {
    backends.push({
      slot: i,
      active: false,
      state: 'free',
      stateT: 0,
      stateDur: 1,
      progress: 0,
      query: 'select_idx',
      table: 0,
      xid: 0,
      waitOn: -1,
      rowsSent: 0,
      buffersTouched: 0,
      buffersHit: 0,
      buffersRead: 0,
      walBytes: 0,
      walFpiBytes: 0,
      deadMade: 0,
      workMemNodes: 0,
      workMemSortNodes: 0,
      workMemHashNodes: 0,
      workMemAllowanceBytes: 0,
      workMemUsedBytes: 0,
      workMemSpillNodes: 0,
      tempFileBytes: 0,
      lastBuffer: 0,
      age: 0,
      plan: null,
      sql: '',
    })
  }
  const extras: Extra[] = []
  for (let i = 0; i < N_BACKEND_SLOTS; i++) extras.push(makeExtra())

  const segments: WalSegment[] = []
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    segments.push({ id: i, name: walSegName(i), bytes: 0, state: 'recycled', fill: 0 })
  }

  const vacWorkers: VacWorker[] = []
  for (let i = 0; i < N_VAC_WORKERS; i++) {
    vacWorkers.push({
      slot: i,
      active: false,
      table: 0,
      phase: 'idle',
      progress: 0,
      vacuumDelay: false,
      travel: 0,
      deadCollected: 0,
      stalledByHorizon: false,
    })
  }

  const tables: TableSim[] = TABLES.map((def) => ({
    def,
    autovacuumEnabled: true,
    pages: def.pages,
    indexPages: def.indexes.reduce((n, index) => n + index.pages, 0),
    liveTuples: def.pages * def.tuplesPerPage,
    reltuples: def.pages * def.tuplesPerPage,
    deadTuples: 0,
    bloat: 0,
    vacuumThreshold: Math.min(
      AUTOVACUUM_VACUUM_MAX_THRESHOLD,
      AUTOVACUUM_VACUUM_THRESHOLD
        + DEFAULT_KNOBS.autovacuumScaleFactor * def.pages * def.tuplesPerPage,
    ),
    lastVacuum: 0,
    seqScans: 0,
    idxScans: 0,
    inserts: 0,
    updates: 0,
    hotUpdates: 0,
    deletes: 0,
    heat: 0,
    vacuuming: false,
    mvcc: createRepresentativeRow(99999, def.pages > 1 ? 1 : 0),
  }))

  const initialLsn = INITIAL_WAL_LSN
  const primaryBuffers = createBufferPoolState(DEFAULT_KNOBS.sharedBuffers, 0.98)
  const standbyABuffers = createBufferPoolState(DEFAULT_KNOBS.sharedBuffers, 0.96)
  const standbyBBuffers = createBufferPoolState(DEFAULT_KNOBS.sharedBuffers, 0.96)
  const primaryNodeWal = createClusterWalState(initialLsn)
  const standbyANodeWal = createClusterWalState(initialLsn)
  const standbyBNodeWal = createClusterWalState(initialLsn)
  const primaryDataDirectory = { bytes: 0, appliedLsn: initialLsn }
  const standbyADataDirectory = { bytes: 0, appliedLsn: initialLsn }
  const standbyBDataDirectory = { bytes: 0, appliedLsn: initialLsn }
  const standbyA: PhysicalStandbyState = {
    nodeId: CLAIM_VALUES.standbyNames.internal[0],
    applicationName: CLAIM_VALUES.standbyNames.display[0],
    enabled: true,
    connected: true,
    mode: 'async',
    sentLsn: initialLsn,
    receivedLsn: initialLsn,
    writtenLsn: initialLsn,
    flushedLsn: initialLsn,
    appliedLsn: initialLsn,
    lagBytes: 0,
    lagSec: 0,
    networkLagMs: DEFAULT_KNOBS.standbyANetworkLag,
    replayPaused: false,
    applyActivity: 0,
    inFlight: 0,
    walSender: 'streaming',
    walReceiver: 'streaming',
    startupProcess: 'streaming',
    acknowledgedWriteLsn: initialLsn,
    acknowledgedFlushLsn: initialLsn,
    acknowledgedApplyLsn: initialLsn,
  }
  const standbyB: PhysicalStandbyState = {
    nodeId: CLAIM_VALUES.standbyNames.internal[1],
    applicationName: CLAIM_VALUES.standbyNames.display[1],
    enabled: true,
    connected: true,
    mode: 'async',
    sentLsn: initialLsn,
    receivedLsn: initialLsn,
    writtenLsn: initialLsn,
    flushedLsn: initialLsn,
    appliedLsn: initialLsn,
    lagBytes: 0,
    lagSec: 0,
    networkLagMs: DEFAULT_KNOBS.standbyBNetworkLag,
    replayPaused: false,
    applyActivity: 0,
    inFlight: 0,
    walSender: 'streaming',
    walReceiver: 'streaming',
    startupProcess: 'streaming',
    acknowledgedWriteLsn: initialLsn,
    acknowledgedFlushLsn: initialLsn,
    acknowledgedApplyLsn: initialLsn,
  }
  const standbyASlot: PhysicalReplicationSlotState = {
    name: 'standby_a_slot',
    standbyId: 'standbyA',
    exists: true,
    active: true,
    restartLsn: initialLsn,
    retainedBytes: 0,
  }
  const standbyBSlot: PhysicalReplicationSlotState = {
    name: 'standby_b_slot',
    standbyId: 'standbyB',
    exists: true,
    active: true,
    restartLsn: initialLsn,
    retainedBytes: 0,
  }

  const state: SimState = {
    t: 0,
    realT: 0,
    knobs: { ...DEFAULT_KNOBS },
    xid: 100000,
    xminHorizon: 100000,
    oldestSnapshotAge: 0,
    maxConnections:
      N_BACKEND_SLOTS
      + CLAIM_VALUES.connectionPooler.modelConnectionReservations.superuser
      + CLAIM_VALUES.connectionPooler.modelConnectionReservations.reserved,
    superuserReservedConnections:
      CLAIM_VALUES.connectionPooler.modelConnectionReservations.superuser,
    reservedConnections:
      CLAIM_VALUES.connectionPooler.modelConnectionReservations.reserved,
    pooler: {
      mode: DEFAULT_KNOBS.poolMode,
      clientConnections: DEFAULT_KNOBS.clientConnections,
      acceptedClients: DEFAULT_KNOBS.clientConnections,
      refusedClients: 0,
      boundClients: 0,
      sessionPendingTransactions: Array(N_BACKEND_SLOTS).fill(0),
      waitingClients: 0,
      disconnectedClients: 0,
      statementTransactionRejects: 0,
      serverConnections: 0,
      serverLimit: N_BACKEND_SLOTS,
      serverCapacity: N_BACKEND_SLOTS,
      serverConnectionErrors: 0,
      serverOfferedTps: DEFAULT_KNOBS.tps,
    },
    backends,
    buffers: primaryBuffers,
    wal: {
      insertLsn: initialLsn,
      writeLsn: initialLsn,
      flushLsn: initialLsn,
      bufferBytes: 0,
      bufferCapacity: walBufferCapacity(DEFAULT_KNOBS.sharedBuffers),
      segmentSize: WAL_SEG,
      segments,
      bytesPerSec: 0,
      fpwBurst: 0,
      archiveQueue: 0,
      archived: 0,
      segmentCount: N_WAL_SEG_SLOTS,
    },
    checkpoint: {
      phase: 'idle',
      progress: 0,
      buffersToWrite: 0,
      buffersWritten: asSampleFrames(0),
      nextInSec: DEFAULT_KNOBS.checkpointTimeout,
      elapsed: 0,
      lastDuration: 0,
      reason: 'time',
      numTimed: 0,
      numRequested: 0,
      numDone: 0,
      count: 0,
      redoLsn: initialLsn,
      completedRedoLsn: initialLsn,
    },
    bgwriter: {
      enabled: true,
      scanPos: 0,
      cleanedTotal: asSampleFrames(0),
      cleanedPerSec: 0,
      activity: 0,
    },
    autovac: {
      enabled: true,
      nextLaunchSec: AV_NAPTIME,
      workers: vacWorkers,
      totalRuns: 0,
      landfill: 0,
    },
    tables,
    replication: {
      logicalEnabled: false,
      logicalSlotLsn: initialLsn,
      logicalChangesPerSec: 0,
      standbys: [standbyA, standbyB],
      physicalSlots: [standbyASlot, standbyBSlot],
    },
    cluster: {
      nodes: [
        {
          id: 'primary',
          name: 'primary',
          role: 'primary',
          online: true,
          leaderOpinion: 'primary',
          buffers: primaryBuffers,
          wal: primaryNodeWal,
          dataDirectory: primaryDataDirectory,
        },
        {
          id: CLAIM_VALUES.standbyNames.internal[0],
          name: CLAIM_VALUES.standbyNames.display[0],
          role: 'standby',
          online: true,
          leaderOpinion: 'primary',
          buffers: standbyABuffers,
          wal: standbyANodeWal,
          dataDirectory: standbyADataDirectory,
        },
        {
          id: CLAIM_VALUES.standbyNames.internal[1],
          name: CLAIM_VALUES.standbyNames.display[1],
          role: 'standby',
          online: true,
          leaderOpinion: 'primary',
          buffers: standbyBBuffers,
          wal: standbyBNodeWal,
          dataDirectory: standbyBDataDirectory,
        },
      ],
    },
    highAvailability: {
      currentLeader: 'primary',
      acceptingWrites: true,
      patroni: {
        agents: [
          {
            nodeId: 'primary',
            reachableDcsMembers: [true, true, true],
            canReachConsensus: true,
            observedLeaderKey: 'primary',
            observedTerm: 1,
            leaseRemainingSec: HA_LEASE_TTL_SECONDS,
            lastDcsResult: 'compare_and_swap_committed',
            demotions: 0,
          },
          {
            nodeId: 'standbyA',
            reachableDcsMembers: [true, true, true],
            canReachConsensus: true,
            observedLeaderKey: 'primary',
            observedTerm: 1,
            leaseRemainingSec: HA_LEASE_TTL_SECONDS,
            lastDcsResult: 'observed',
            demotions: 0,
          },
          {
            nodeId: 'standbyB',
            reachableDcsMembers: [true, true, true],
            canReachConsensus: true,
            observedLeaderKey: 'primary',
            observedTerm: 1,
            leaseRemainingSec: HA_LEASE_TTL_SECONDS,
            lastDcsResult: 'observed',
            demotions: 0,
          },
        ],
        dcs: {
          algorithm: 'Raft',
          members: [
            {
              id: 'etcd1',
              failureDomain: 'primary',
              role: 'leader',
              reachableMembers: [true, true, true],
              inCommitMajority: true,
              term: 1,
              commitIndex: 1,
              appliedLeaderKey: 'primary',
              appliedRevision: 1,
            },
            {
              id: 'etcd2',
              failureDomain: 'standbyA',
              role: 'follower',
              reachableMembers: [true, true, true],
              inCommitMajority: true,
              term: 1,
              commitIndex: 1,
              appliedLeaderKey: 'primary',
              appliedRevision: 1,
            },
            {
              id: 'etcd3',
              failureDomain: 'standbyB',
              role: 'follower',
              reachableMembers: [true, true, true],
              inCommitMajority: true,
              term: 1,
              commitIndex: 1,
              appliedLeaderKey: 'primary',
              appliedRevision: 1,
            },
          ],
          majority: 2,
          leaderMember: 'etcd1',
          term: 1,
          commitIndex: 1,
          canCommit: true,
          leaderKey: {
            value: 'primary',
            leaseValid: true,
            ttlSec: HA_LEASE_TTL_SECONDS,
            leaseRemainingSec: HA_LEASE_TTL_SECONDS,
            revision: 1,
            compareAndSwapCount: 1,
            lastOperation: 'compare-and-swap',
          },
        },
        renewEverySec: HA_LEASE_RENEW_SECONDS,
        demotions: 0,
        splitBrain: false,
      },
      timeline: {
        current: 1,
        parent: 0,
        forkLsn: 0,
        forkedAt: 0,
        oldHistoryEndLsn: initialLsn,
        newHistoryEndLsn: initialLsn,
      },
      transition: {
        kind: 'none',
        status: 'idle',
        source: null,
        target: null,
        startedAt: 0,
        waitSec: 0,
        lossBytes: 0,
        lossTransactions: 0,
        failureReason: '',
      },
      rejoin: {
        required: false,
        node: null,
        reinitializeRequired: false,
        reinitializeNode: null,
        reinitializeBytes: 0,
        reinitializeCopiedBytes: 0,
        blockChangeTrackingAvailable: true,
        status: 'idle',
        progress: 0,
        startedAt: 0,
        elapsedSec: 0,
        estimatedDurationSec: 0,
        bytesRewound: 0,
        bytesCopied: 0,
        failureReason: '',
      },
    },
    disasterRecovery: {
      tool: 'WAL-G',
      dataDirectoryBytes: 0,
      archive: {
        timeline: 1,
        parentTimeline: 0,
        parentArchivedThroughLsn: 0,
        parentArchivedThroughTime: 0,
        historyFileName: '',
        historyFileArchived: false,
        queueSegments: 0,
        archivedThroughLsn: initialLsn,
        archivedThroughTime: 0,
        failedAttempts: 0,
        pgWalBytes: N_WAL_SEG_SLOTS * WAL_SEG,
        pgWalCapacityBytes: DR_PG_WAL_CAPACITY_BYTES,
        writesBlocked: false,
        rejectedWrites: 0,
      },
      backups: [],
      expiredBackups: 0,
      oldestRecoverableTime: 0,
      backupSchedule: {
        intervalSec: DR_BACKUP_CADENCE_SECONDS,
        nextStartAt: DR_BACKUP_CADENCE_SECONDS,
      },
      backup: {
        status: 'idle',
        trigger: 'manual',
        progress: 0,
        startedAt: 0,
        startTimeline: 1,
        stopTimeline: 0,
        startLsn: 0,
        stopLsn: 0,
        dataBytes: 0,
        objectStoreBytes: 0,
        copiedBytes: 0,
        estimatedDurationSec: 0,
        failureReason: '',
      },
      restore: {
        status: 'idle',
        progress: 0,
        targetTime: 0,
        targetRecordLsn: 0,
        targetLsn: 0,
        recoveryTargetTimeline: CLAIM_VALUES.timelineRecovery.defaultTarget,
        backupTimeline: 0,
        targetTimeline: 0,
        crossesTimelineFork: false,
        historyFileName: '',
        followedHistoryFile: false,
        parentReplayEndLsn: 0,
        backupId: -1,
        backupAgeSec: 0,
        backupBytesRequired: 0,
        backupBytesFetched: 0,
        walBytesRequired: 0,
        walBytesAvailable: 0,
        walBytesReplayed: 0,
        lastReachedTime: 0,
        lastReachedTimeline: 0,
        estimatedDurationSec: 0,
        elapsedSec: 0,
        failureReason: '',
        resultMessage: '',
        pendingWalFailureReason: '',
        pendingStartupFailureReason: '',
        promoted: false,
      },
      drill: {
        level: 'verified',
        status: 'idle',
        evidenceRank: CLAIM_VALUES.restoreDrill.levels.verified.rank,
        progress: 0,
        startedAt: 0,
        completedAt: 0,
        targetTime: 0,
        backupId: -1,
        backupAgeSec: 0,
        backupObjectBytesRequired: 0,
        walBytesRequired: 0,
        estimatedRestoreToTargetSec: 0,
        measuredRestoreToTargetSec: 0,
        estimatedDurationSec: 0,
        elapsedSec: 0,
        objectStoreBytesRead: 0,
        checksumBytesRequired: 0,
        checksumBytesRead: 0,
        smokeBytesRequired: 0,
        smokeBytesRead: 0,
        validationBytesRequired: 0,
        validationBytesRead: 0,
        manifestDigest: 0,
        restoredDigest: 0,
        smokeTableMask: 0,
        failureReason: '',
      },
    },
    locks: [],
    workMem: {
      activeNodes: 0,
      activeSortNodes: 0,
      activeHashNodes: 0,
      activeAllowanceBytes: 0,
      activeUsedBytes: 0,
      spillingNodes: 0,
      liveTempBytes: 0,
      tempFiles: 0,
      tempBytes: 0,
    },
    stats: {
      tps: 0,
      commits: 0,
      rollbacks: 0,
      blksHit: 0,
      blksRead: 0,
      tupReturned: 0,
      tupInserted: 0,
      tupUpdated: 0,
      tupDeleted: 0,
      walBytesPerSec: 0,
      ioReadPerSec: 0,
      ioWritePerSec: asSampleFrames(0),
      ioWriteLoad: 0,
      cacheHitPct: 98,
      activeBackends: 0,
      runningBackends: 0,
      poolerQueuedTransactions: 0,
      poolerQueryWaitTimeouts: 0,
      backendConcurrencyMultiplier: 1,
      latency: {
        observations: 0,
        transactions: 0,
        mean: {
          totalMs: 0,
          waits: { poolSlotMs: 0, bufferReadMs: 0, dirtyWriteMs: 0, tempFileMs: 0, commitMs: 0, lockMs: 0, runningMs: 0 },
        },
        p50: {
          totalMs: 0,
          waits: { poolSlotMs: 0, bufferReadMs: 0, dirtyWriteMs: 0, tempFileMs: 0, commitMs: 0, lockMs: 0, runningMs: 0 },
        },
        p99: {
          totalMs: 0,
          waits: { poolSlotMs: 0, bufferReadMs: 0, dirtyWriteMs: 0, tempFileMs: 0, commitMs: 0, lockMs: 0, runningMs: 0 },
        },
      },
      history: { tps: [], hit: [], latencyP50: [], latencyP99: [], wal: [], dirty: [], lag: [] },
    },
    scenario: null,
    scenarioT: 0,
    scenarioDecision: null,
    forkPulse: 0,
    trace: {
      slot: -1,
      query: 'select_idx',
      table: 0,
      sql: '',
      stop: 'done',
      stopT: 0,
      visited: 0,
      trips: 0,
      lastXid: 0,
      lastPlanLabel: '',
      lastPlanRows: 0,
      lastPlanCost: 0,
      rowsSent: 0,
      buffersHit: 0,
      buffersRead: 0,
      walBytes: 0,
      walFpiBytes: 0,
      deadMade: 0,
      lastTripSec: 0,
    },
  }

  const K = state.knobs
  const buf = state.buffers
  const wal = state.wal
  const ckpt = state.checkpoint
  const bgw = state.bgwriter
  const av = state.autovac
  const rep = state.replication
  const ha = state.highAvailability
  const dr = state.disasterRecovery
  const stats = state.stats
  type RuntimeStats = typeof stats & { pagesFor90Pct: number }
  const runtimeStats = stats as RuntimeStats
  runtimeStats.pagesFor90Pct = 0

  /* ---- derived tables ------------------------------------------------- */

  /** Average tuple width, derived from the declared tuples-per-page. */
  const avgTuple: number[] = TABLES.map((d) => Math.round((PAGE / d.tuplesPerPage) * 0.85))
  /**
   * The frequently-touched heap pages fit in the default pool; the rest of
   * each enlarged relation remains a cold tail that keeps replacement active.
   */
  const HOT_HEAP_PAGE_SHARE = 0.0001
  const HOT_INDEX_PAGE_SHARE = 0.0005
  const hotPages: number[] = TABLES.map((d) =>
    clamp(Math.round(d.pages * HOT_HEAP_PAGE_SHARE), 8, 32),
  )
  const warmPages: number[] = TABLES.map((d) =>
    clamp(Math.round(d.pages * 0.002), 256, 1024),
  )
  const HEAP_HOT_READ_SHARE = 0.85
  const HEAP_HOT_WRITE_SHARE = 0.60
  const HEAP_WARM_WRITE_SHARE = 0.35
  const HEAP_COLD_WRITE_SHARE = 0.05
  const INDEX_HOT_SHARE = 0.85
  /** Total index pages per table, used to place index blocks past the heap. */
  const baseIdxPages: number[] = TABLES.map((d) => d.indexes.reduce((a, ix) => a + ix.pages, 0))
  /** B-tree leaf traffic is skewed independently of the heap working set. */
  const hotIdxPages: number[] = baseIdxPages.map((pages) =>
    clamp(Math.round(pages * HOT_INDEX_PAGE_SHARE), 4, 24),
  )
  const warmIdxPages: number[] = baseIdxPages.map((pages) =>
    clamp(Math.round(pages * 0.002), 32, 256),
  )
  /** Effective index pages, including leaf pages occupied by dead entries. */
  const idxPages = baseIdxPages.slice()
  /** Index entries left behind by DELETE and non-HOT UPDATE until vacuum. */
  const deadIndexTuples: number[] = TABLES.map(() => 0)
  /** Sampled DML page writes since the table's current/last vacuum began. */
  const heapWritesSinceVacuum: number[] = TABLES.map(() => 0)
  const indexWritesSinceVacuum: number[] = TABLES.map(() => 0)
  type RuntimeTable = TableSim & {
    deadIndexTuples: number
    insSinceVacuum: number
    frozenPages: number
    vacuumInsThreshold: number
  }
  const runtimeTable = (ti: number): RuntimeTable => tables[ti] as RuntimeTable
  const INDEX_ENTRIES_PER_PAGE = 180
  const refreshIndexPages = (ti: number): void => {
    idxPages[ti] = baseIdxPages[ti] + Math.ceil(deadIndexTuples[ti] / INDEX_ENTRIES_PER_PAGE)
    runtimeTable(ti).indexPages = idxPages[ti]
    runtimeTable(ti).deadIndexTuples = deadIndexTuples[ti]
  }

  /* ---- sampled sequential scans ---------------------------------------- */

  /**
   * One sampled block stands for this many real blocks of the relation. The city
   * cannot animate 5,200 buffer requests inside one trip, so a sequential scan is
   * sampled — but a sample is only honest if it is a sample OF SOMETHING FIXED.
   */
  const SCAN_STRIDE = 32
  /** Blocks in the relation's sampling grid. Grows as the relation grows. */
  const scanGridN = (t: TableSim): number =>
    Math.max(1, Math.min(t.pages, Math.max(8, Math.ceil(t.pages / SCAN_STRIDE))))
  /**
   * Step `i` of an evenly-spaced sample of the whole relation. Repeated scans
   * use the same sample because they read the same relation; touchPage keeps a
   * recycling BAS_BULKREAD stream distinct from normal resident-page hits.
   */
  const scanBlkOf = (t: TableSim, i: number): number => {
    const n = scanGridN(t)
    return (i % n) * Math.max(1, Math.floor(t.pages / n))
  }
  /** Dead tuples that predate the xmin horizon and may therefore be removed. */
  const deadRemovable: number[] = TABLES.map(() => 0)
  /** pg_stat_all_tables.ins_since_vacuum, for insert-triggered vacuum. */
  const insSinceVacuum: number[] = TABLES.map(() => 0)
  /** relallfrozen, scaled as a count of heap pages. */
  const frozenPages: number[] = TABLES.map((d) => d.pages)
  const vacuumInsThreshold: number[] = TABLES.map(() => 1000)
  for (let i = 0; i < N_TABLES; i++) {
    const t = runtimeTable(i)
    t.indexPages = idxPages[i]
    t.deadIndexTuples = 0
    t.insSinceVacuum = 0
    t.frozenPages = frozenPages[i]
    t.vacuumInsThreshold = vacuumInsThreshold[i]
  }

  const wRead: number[] = TABLES.map((d) => d.weight)
  const wIns: number[] = TABLES.map((d) => d.weight * (d.id === 'events' ? 2.4 : 1))
  // 'events' is append-only: it is never the target of an UPDATE or DELETE, which
  // is exactly why it never bloats.
  const wUpd: number[] = TABLES.map((d) =>
    d.id === 'events' ? 0 : d.weight * (d.id === 'sessions' ? 2.0 : 1),
  )
  // The background OLTP mix sends nearly all ordinary seq scans to the small,
  // frequently rewritten relation. A periodic documents report retains a cold
  // tail; full analytics remain explicit or exceptional so they do not dominate
  // every page-weighted metric in the otherwise healthy default city.
  /** Row count each relation settles at — inserts replace what deletes remove. */
  const naturalLive: number[] = TABLES.map((d) => d.pages * d.tuplesPerPage)
  /** 0 = tables at their natural size, 1 = draining hard. See tickTables(). */
  let liveDeficit = 0
  const sessionsSeqTable = TABLES.findIndex((d) => d.id === 'sessions')
  const documentsSeqTable = TABLES.findIndex((d) => d.id === 'documents')
  const wAgg: number[] = TABLES.map((d) => d.weight * Math.pow(d.pages / 600, 0.6))
  const SMALL_SEQ_SCAN_SHARE = 0.9999

  /* ---- buffer mapping table (the real shared hash table) --------------- */

  const bufMap = new Map<number, number>()
  const accessCounts = new Map<number, number>()
  const bufKey = (rel: number, blk: number) => rel * 0x400000 + blk
  /**
   * Preserve relation locality while sampling logical pages into the plaza.
   * Hashing every block across all N_BUFFERS identities made a 274 MiB table
   * occupy the entire 8 GiB sample, so it could not remain resident in a
   * 2 GiB pool. Heap and index ranges stay separate as each 1,024-page bucket
   * represents the same amount of the declared working set.
   */
  const representativeBufKey = (rel: number, blk: number): number => {
    if (rel < N_TABLES) {
      const index = blk >= IDX_BASE
      const page = index ? blk - IDX_BASE : blk
      const bucket = Math.floor((page * N_BUFFERS) / FULL_SAMPLE_PAGES)
      return rel * N_BUFFERS * 2 + (index ? N_BUFFERS : 0) + bucket
    }
    let key = bufKey(rel, blk) | 0
    key = Math.imul(key ^ (key >>> 16), 0x7feb352d)
    key = Math.imul(key ^ (key >>> 15), 0x846ca68b)
    return ((key ^ (key >>> 16)) >>> 0) % N_BUFFERS
  }

  function deleteBufferMapping(b: number, rel = buf.rel[b], blk = buf.blk[b]): void {
    const key = representativeBufKey(rel, blk)
    if (bufMap.get(key) === b) bufMap.delete(key)
  }
  const pinT = new Float32Array(N_BUFFERS)
  /**
   * Pages whose LSN is already past the checkpoint REDO point, i.e. that have
   * paid their full-page image for this checkpoint cycle. Keyed by page, not by
   * buffer: evicting a page and reading it back does NOT make it owe a second
   * image, because the rule is `page.LSN <= RedoRecPtr`, not residency.
   */
  const fpiGenerationByPage = new Map<number, number>()
  let fpiGeneration = 0
  /**
   * BM_CHECKPOINT_NEEDED. BufferSync() tags every buffer that is dirty at the
   * redo point and writes exactly that set; a page dirtied afterwards is
   * explicitly not this checkpoint's responsibility, and — the part that
   * matters — a page that was dirty at the redo point IS, unconditionally.
   * Without the tag the write loop lapped the pool picking up whatever happened
   * to be dirty at the time, so pages from the snapshot could survive the
   * checkpoint unwritten while post-redo pages were written in their place.
   * That breaks the contract that makes redoLsn a valid recovery start.
   */
  const ckptNeeded = new Uint8Array(N_BUFFERS)
  const ringBuf = new Int32Array(N_BACKEND_SLOTS * RING).fill(-1)

  // A backend holds only a handful of pins at once (the pages its current node
  // is actually looking at). Pinned buffers are invisible to the clock sweep,
  // so this bound matters: unbounded pins would deadlock replacement.
  const PINS = 4
  const pinRing = new Int32Array(N_BACKEND_SLOTS * PINS).fill(-1)
  const pinPos = new Int32Array(N_BACKEND_SLOTS)
  /** slot + 1 for a backend victim; 254/255 for checkpointer/bgwriter WAL waits. */
  const evictionOwner = new Uint8Array(N_BUFFERS)
  /** Backend bitmask for sampled page changes awaiting their aggregate WAL insert. */
  const pageLsnOwners = new Uint16Array(N_BUFFERS)
  /**
   * Concurrent pins one backend may hold, scaled to the pool. StrategyGetBuffer()
   * raises `ERROR: no unpinned buffers available` when every frame is pinned, and
   * this is what keeps that unreachable by construction: 16 slots × 4 pins = 64
   * possible pins against a pool whose slider minimum is 32 frames was enough to
   * pin the whole pool, which is how a pinned frame came to be stolen at all.
   */
  const pinsFor = (): number => Math.max(1, Math.min(PINS, Math.floor(buf.sampleFrames / (2 * N_BACKEND_SLOTS))))

  function pinBuffer(slot: number, b: number): void {
    const base = slot * PINS
    const n = pinsFor()
    const p = pinPos[slot] % n
    const old = pinRing[base + p]
    if (old >= 0 && old !== b && evictionOwner[old] === 0) buf.pinned[old] = 0
    pinRing[base + p] = b
    pinPos[slot] = (p + 1) % n
    buf.pinned[b] = 1
    pinT[b] = state.t
  }

  function unpinAll(slot: number): void {
    const base = slot * PINS
    for (let i = 0; i < PINS; i++) {
      const b = pinRing[base + i]
      if (b >= 0 && evictionOwner[b] === 0) buf.pinned[b] = 0
      pinRing[base + i] = -1
    }
  }

  /* ---- wire (replication packets in flight) ---------------------------- */

  const WIRE = 96
  const ACKW = 32
  interface RuntimePhysicalReplication {
    wireLsn: Float64Array
    wireAt: Float64Array
    wireHead: number
    wireTail: number
    wireCount: number
    applyAckLsn: Float64Array
    applyAckAt: Float64Array
    applyAckHead: number
    applyAckTail: number
    applyAckCount: number
    applyAckSentLsn: number
    writeAckLsn: Float64Array
    writeAckAt: Float64Array
    writeAckHead: number
    writeAckTail: number
    writeAckCount: number
    writeAckSentLsn: number
    flushAckLsn: Float64Array
    flushAckAt: Float64Array
    flushAckHead: number
    flushAckTail: number
    flushAckCount: number
    flushAckSentLsn: number
    previousLagBytes: number
    previousLagSec: number
    bufferPageCursor: number
    readT: number
    rejoining: boolean
  }
  const createPhysicalRuntime = (): RuntimePhysicalReplication => ({
    wireLsn: new Float64Array(WIRE),
    wireAt: new Float64Array(WIRE),
    wireHead: 0,
    wireTail: 0,
    wireCount: 0,
    applyAckLsn: new Float64Array(ACKW),
    applyAckAt: new Float64Array(ACKW),
    applyAckHead: 0,
    applyAckTail: 0,
    applyAckCount: 0,
    applyAckSentLsn: wal.flushLsn,
    writeAckLsn: new Float64Array(ACKW),
    writeAckAt: new Float64Array(ACKW),
    writeAckHead: 0,
    writeAckTail: 0,
    writeAckCount: 0,
    writeAckSentLsn: wal.flushLsn,
    flushAckLsn: new Float64Array(ACKW),
    flushAckAt: new Float64Array(ACKW),
    flushAckHead: 0,
    flushAckTail: 0,
    flushAckCount: 0,
    flushAckSentLsn: wal.flushLsn,
    previousLagBytes: 0,
    previousLagSec: 0,
    bufferPageCursor: 0,
    readT: 0,
    rejoining: false,
  })
  const physicalRuntime: [RuntimePhysicalReplication, RuntimePhysicalReplication] = [
    createPhysicalRuntime(),
    createPhysicalRuntime(),
  ]

  /**
   * LagTrackerWrite/LagTrackerRead: primary flush positions paired with the
   * time at which they became durable. replay_lag is a measured interval, not
   * a byte gap divided by today's write rate.
   */
  const LAG_SAMPLES = 512
  const lagSampleLsn = new Float64Array(LAG_SAMPLES)
  const lagSampleAt = new Float64Array(LAG_SAMPLES)
  let lagSampleHead = 0
  let lagSampleCount = 1
  lagSampleLsn[0] = wal.flushLsn
  lagSampleAt[0] = state.t

  function recordFlushSample(lsn: number): void {
    if (lagSampleCount > 0) {
      const last = (lagSampleHead + lagSampleCount - 1) % LAG_SAMPLES
      if (lsn <= lagSampleLsn[last]) return
    }
    if (lagSampleCount < LAG_SAMPLES) {
      const at = (lagSampleHead + lagSampleCount) % LAG_SAMPLES
      lagSampleLsn[at] = lsn
      lagSampleAt[at] = state.t
      lagSampleCount++
    } else {
      lagSampleLsn[lagSampleHead] = lsn
      lagSampleAt[lagSampleHead] = state.t
      lagSampleHead = (lagSampleHead + 1) % LAG_SAMPLES
    }
  }

  function flushTimeOf(lsn: number): number {
    if (lagSampleCount <= 0) return state.t
    const first = lagSampleHead
    if (lsn <= lagSampleLsn[first]) return lagSampleAt[first]
    let prev = first
    for (let i = 1; i < lagSampleCount; i++) {
      const cur = (lagSampleHead + i) % LAG_SAMPLES
      if (lsn <= lagSampleLsn[cur]) {
        const span = lagSampleLsn[cur] - lagSampleLsn[prev]
        const f = span > 0 ? clamp01((lsn - lagSampleLsn[prev]) / span) : 1
        return lagSampleAt[prev] + (lagSampleAt[cur] - lagSampleAt[prev]) * f
      }
      prev = cur
    }
    return lagSampleAt[prev]
  }

  function updateReplayLag(
    standby: PhysicalStandbyState,
    runtime: RuntimePhysicalReplication,
  ): void {
    const measured = standby.appliedLsn >= wal.flushLsn
      ? 0
      : Math.min(999, Math.max(0, state.t - flushTimeOf(standby.appliedLsn)))
    // Interpolation and tick ordering can add a fraction of a second while the
    // byte gap is already closing. Do not let that sampling jitter recreate the
    // old, glaring inverse response.
    const reported = measured / NET_PACKET_STRETCH
    standby.lagSec = standby.lagBytes < runtime.previousLagBytes
      ? Math.min(runtime.previousLagSec, reported)
      : reported
    runtime.previousLagBytes = standby.lagBytes
    runtime.previousLagSec = standby.lagSec
  }

  /* ---- accumulators ---------------------------------------------------- */

  let pendingTx = 0
  let nextArrival = 0
  const poolArrivalAt = new Float64Array(POOL_QUEUE_BUCKETS)
  const poolArrivalCount = new Float64Array(POOL_QUEUE_BUCKETS)
  const compactArrivalAt = new Float64Array(POOL_QUEUE_BUCKETS)
  const compactArrivalCount = new Float64Array(POOL_QUEUE_BUCKETS)
  let poolArrivalHead = 0
  let poolArrivalBuckets = 0
  let queuedRandomTx = 0
  const sessionPendingTx = new Float64Array(N_BACKEND_SLOTS)
  let queuedSessionTx = 0
  let sessionArrivalCursor = 0
  let sessionWaitCohortAt = 0
  let backgroundSeqScans = 0
  let nextWideSeqScan = 1
  /** Transactions carried by one backend trip. See sizeBatch(). */
  let batchSize = 1
  const traceQueue: TraceRequest[] = []
  let traceRunning = false
  let tracePlayback: TracePlayback = 'slow'
  let traceStepArmed = false
  let scenarioQueryKind: QueryKind | null = null
  let scenarioQueryTable = -1
  let commitsAcc = 0
  /*
   * A rolling distribution of completed trips. One trip can stand for several
   * transactions, so nearest-rank quantiles use latencyWeight rather than
   * treating an animation sample as one real transaction. Transactions inside
   * that batch share the trip observation; their within-batch tail is not
   * modeled. All storage and sorted-slot orders are fixed up front: completion
   * and refresh allocate nothing in the production frame loop.
   */
  const latencyTotal = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyPoolSlot = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyBufferRead = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyDirtyWrite = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyTempFile = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyCommit = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyLock = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyRunning = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyWeight = new Float64Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderTotal = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderPoolSlot = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderBufferRead = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderDirtyWrite = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderTempFile = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderCommit = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderLock = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  const latencyOrderRunning = new Uint16Array(MODEL_LATENCY_WINDOW_TRIPS)
  let latencyHead = 0
  let latencyCount = 0
  let latencyPoolSlotSeen = false
  /**
   * Bounded commit-position ledger used only to count acknowledged write
   * transactions beyond a failover candidate's durable LSN. Typed arrays keep
   * both the hot path and the failure drill allocation-free.
   */
  const commitLsn = new Float64Array(COMMIT_HISTORY_SLOTS)
  const commitCount = new Float64Array(COMMIT_HISTORY_SLOTS)
  let commitHead = 0
  let commitSlots = 0
  /* Recovery time targets inspect transaction-end records, independently of
   * when the client later receives its commit acknowledgement. */
  const recoveryCommitLsn = new Float64Array(COMMIT_HISTORY_SLOTS)
  const recoveryCommitAt = new Float64Array(COMMIT_HISTORY_SLOTS)
  const recoveryCommitTimeline = new Uint32Array(COMMIT_HISTORY_SLOTS)
  let recoveryCommitHead = 0
  let recoveryCommitSlots = 0
  let walAcc = 0
  let fpiAcc = 0
  let maintenanceWalPending = 0
  let maintenanceFpiPending = 0
  let maintenanceWalQueued = 0
  let maintenanceWalDrained = 0
  let ioReadAcc = 0
  let ioWriteAcc = 0
  /**
   * Writeback queueing, recomputed from the smoothed write rate in tickStats().
   * 1 = an idle device. Storage is shared and finite: the checkpointer, the
   * bgwriter and every backend that evicts a dirty page are all queueing on the
   * same spindle a backend's own read has to wait behind.
   */
  let ioLoad = 1
  /**
   * Representative storage pressure charged to model phase duration. The
   * `syncing` term makes checkpoint sync stall model work at tick resolution
   * rather than at the 250 ms stats cadence, which would smear it. The rolling
   * latency distribution measures this stretched model time; it is not
   * production-time calibration.
   *
   * checkpoint_completion_target exists *solely* because an unspread checkpoint
   * is a recognisable I/O latency event. Before this coupling, ckpt.phase was
   * referenced nowhere outside tickCheckpoint(): dragging the target from 0.9 to
   * 0.1 squeezed the same writes into a ninth of the time and moved write-phase
   * mean I/O by 7%, with idle-phase peaks *higher* than write-phase peaks.
   */
  const ioPressure = () => ioLoad + (ckpt.phase === 'syncing' ? 1.5 : 0)
  let winHits = 0
  let winMisses = 0
  /**
   * The two halves of `pg_stat_database`'s hit ratio, as a sliding delta.
   * `blks_hit / (blks_hit + blks_read)` is an EVENT-weighted ratio over
   * cumulative counters: every page request carries the same weight no matter
   * which second it arrived in. Averaging per-window *ratios* with equal weight
   * — which is what the old `damp(hitRatio, winHits/seen, …)` did — is a
   * different and badly biased statistic here, because misses arrive in bursts
   * (one analytics scan is 200 misses inside a single 0.25 s window) while the
   * quiet windows in between are nearly all hits. Measured at the shipped
   * defaults: 81.7% displayed against a true 65.2%, jittering across 60 points.
   *
   * These are the same two counters decayed by a common factor, so the ratio is
   * the real event-weighted one over a ~50 s horizon and cannot drift when the
   * city goes idle. A shorter window lets a warmed finite sample round to a
   * misleading 100.0% seconds after its last miss.
   */
  let emaHits = 0
  let emaSeen = 0
  let rateT = 0
  let histT = 0
  let coverageT = 0
  let pageBudget = 0
  let flowTokens = 60
  let quiet = false
  let applying = false

  let forkCooldown = 0
  let walWriterT = 0
  let bgwT = 0
  let bgwriterFlushBuffer = -1
  let bgwriterFlushLsn = 0
  let flushing = false
  let flushTarget = 0
  let flushCovered = 0
  let flushT = 0
  let flushDur = 0
  let flushBytes = 0
  let archT = 0
  let archiveNextSeg = 0
  let archiveInFlight = -1
  let archiveRetryT = 0
  let lastObservedCurrentSeg = 0
  let backupSeq = 1
  let earliestBackupCompletedAt = 0
  let backupTrigger: 'manual' | 'schedule' = 'manual'
  const closedSegmentId = new Int32Array(DR_HISTORY_SLOTS)
  const closedSegmentAt = new Float64Array(DR_HISTORY_SLOTS)
  let restoreTimelineLocked = false
  let restoreReplayTimeline = 0
  let cleanedAcc = 0
  let bgwriterAllocations = 0
  let bgwriterAllocationEstimate = 0
  let bgwriterScanRemainder = 0
  let clockSweepPasses = 0
  let bgwriterScanPasses = 0
  let bgwriterCursorValid = true
  let logicalAcc = 0
  let statT = 0
  let degradeWarnT = -100
  let refuseWarnT = -100
  let archiveWriteWarnT = -100
  let noBufWarnT = -100
  let workMemWarnT = -100
  let planSeq = 1
  let patroniRenewT = 0

  /** xmin horizon control. When a long transaction is open the horizon freezes. */
  let horizonFrozen = false
  let horizonXid = state.xid
  let horizonT = 0

  const standbyFeedbackActive = (): boolean => {
    if (K.walLevel === 'minimal') return false
    const [standbyA, standbyB] = rep.standbys
    return (K.standbyALongQuery && standbyA.enabled && standbyA.connected)
      || (K.standbyBLongQuery && standbyB.enabled && standbyB.connected)
  }

  const horizonPinRequested = (): boolean =>
    K.longRunningXact || standbyFeedbackActive()

  function engageHorizonPin(): void {
    const inProgress: number[] = []
    for (let i = 0; i < backends.length; i++) {
      if (backends[i].xid > 0) inProgress.push(backends[i].xid)
    }
    horizonFrozen = true
    horizonXid = state.xid + 1
    for (let i = 0; i < inProgress.length; i++) {
      horizonXid = Math.min(horizonXid, inProgress[i])
    }
    horizonT = state.t
    for (let i = 0; i < N_TABLES; i++) {
      holdRepresentativeSnapshot(
        tables[i].mvcc,
        state.xid + 1,
        state.t,
        inProgress,
      )
    }
    toast(
      standbyFeedbackActive()
        ? 'hot_standby_feedback — a standby snapshot is now pinning the xmin horizon'
        : 'BEGIN; SELECT … — an old snapshot is now pinning the xmin horizon',
      'warn',
      6000,
    )
  }

  function releaseHorizonPin(): void {
    horizonFrozen = false
    horizonXid = state.xid + 1
    // Releasing xmin makes existing dead rows removable; vacuum still has to
    // visit them, so bloat and relation size do not recover instantly.
    for (let i = 0; i < N_TABLES; i++) {
      deadRemovable[i] = tables[i].deadTuples
      releaseRepresentativeSnapshot(tables[i].mvcc)
    }
    toast('xmin pin released — vacuum can clean up now', 'good', 5000)
  }

  function syncHorizonPin(): void {
    const requested = horizonPinRequested()
    if (requested && !horizonFrozen) engageHorizonPin()
    else if (!requested && horizonFrozen) releaseHorizonPin()
  }

  let lockHolder = -1
  let lockTable = 3 // sessions — small, hot, and the one everybody wants
  const lockWaitT: number[] = new Array(N_BACKEND_SLOTS).fill(0)
  /** Effective lock_timeout in seconds; 0 = wait forever. See the constants. */
  let lockTimeout = LOCK_TIMEOUT_DEFAULT
  const lockTimeoutSec = (): number => (lockTimeout > 0 ? lockTimeout : Infinity)

  /* ---- flow emission budget ------------------------------------------- */

  let sIoRead = 0
  let sIoWrite = 0
  let sWalIns = 0
  let sCkpt = 0
  let sBgw = 0
  let sVac = 0
  let sIdx = 0
  let sBufReq = 0
  let sClog = 0
  let sRepIo = 0

  function resetTraceRecord(): void {
    const trace = state.trace
    trace.slot = -1
    trace.query = 'select_idx'
    trace.table = 0
    trace.sql = ''
    trace.stop = 'done'
    trace.stopT = 0
    trace.visited = 0
    trace.trips = 0
    trace.lastXid = 0
    trace.lastPlanLabel = ''
    trace.lastPlanRows = 0
    trace.lastPlanCost = 0
    trace.rowsSent = 0
    trace.buffersHit = 0
    trace.buffersRead = 0
    trace.walBytes = 0
    trace.walFpiBytes = 0
    trace.deadMade = 0
    trace.lastTripSec = 0
  }

  function request(kind: QueryKind, table: number, opts: TraceRequestOptions = {}): void {
    if (!Number.isInteger(table) || table < 0 || table >= N_TABLES || traceQueue.length >= 8) return
    traceQueue.push({
      kind,
      table,
      hot: opts.hot,
      sql: opts.sql?.trim(),
      announced: false,
      readyT: 0,
    })
    pendingTx++
  }

  function announceTraceRequest(): void {
    if (traceRunning || traceQueue.length === 0) return
    const request = traceQueue[0]
    if (request.announced) return
    resetTraceRecord()
    const trace = state.trace
    trace.query = request.kind
    trace.table = request.table
    trace.sql = request.sql || sqlFor(request.kind, request.table)
    trace.stop = 'connect'
    trace.stopT = 0
    trace.visited = traceStopBit('connect')
    request.announced = true
    request.readyT = state.t + TRACE_CONNECT_DUR
    traceRunning = true
  }

  function setTraceMode(mode: TracePlayback): void {
    if (mode === 'step') {
      if (tracePlayback === 'step') {
        traceStepArmed = true
        K.paused = false
      } else {
        tracePlayback = 'step'
        traceStepArmed = false
        K.paused = true
      }
      return
    }
    tracePlayback = mode
    traceStepArmed = false
    K.paused = false
  }

  function endTrace(): void {
    if (traceQueue.length > 0) pendingTx = Math.max(0, pendingTx - traceQueue.length)
    traceQueue.length = 0
    traceRunning = false
    traceStepArmed = false
    tracePlayback = 'slow'
    K.paused = false
    resetTraceRecord()
  }

  function traceStopFor(stateName: BackendSim['state']): TraceStop | null {
    switch (stateName) {
      case 'starting': return 'connect'
      case 'parse':
      case 'plan': return 'parse_plan'
      case 'exec_io': return 'fetch'
      case 'eviction_flush': return 'fetch'
      case 'exec_cpu':
      case 'sort': return 'work'
      case 'wal_insert': return 'wal'
      case 'commit_wait': return 'commit'
      case 'sending': return 'send'
      case 'blocked': return 'blocked'
      case 'idle': return 'done'
      default: return null
    }
  }

  function enterTraceStop(stop: TraceStop, elapsed: number): void {
    const trace = state.trace
    if (trace.stop === stop) return
    trace.stop = stop
    trace.stopT = elapsed
    trace.visited |= traceStopBit(stop)
    if (tracePlayback === 'step' && traceStepArmed) {
      traceStepArmed = false
      K.paused = true
    }
  }

  function syncTraceBackend(slot: number): void {
    if (!traceRunning || state.trace.slot !== slot) return
    const b = backends[slot]
    const x = extras[slot]
    const trace = state.trace
    b.walFpiBytes = x.fpiBytes
    trace.rowsSent = b.rowsSent
    trace.buffersHit = b.buffersHit
    trace.buffersRead = b.buffersRead
    trace.walBytes = b.walBytes
    trace.walFpiBytes = b.walFpiBytes
    trace.deadMade = b.deadMade
    trace.lastTripSec = x.visitT
    if (b.xid > 0) trace.lastXid = b.xid
    if (b.plan) {
      trace.lastPlanLabel = b.plan.label
      trace.lastPlanRows = b.plan.rows
      trace.lastPlanCost = b.plan.cost
    }
    const stop = traceStopFor(b.state)
    if (stop) enterTraceStop(stop, x.visitT)
  }

  function flow(
    route: string,
    count: number,
    kind: FlowKind,
    size?: number,
    spread?: number,
    stagger?: number,
  ): void {
    if (quiet) return
    if (flowTokens < count) return
    flowTokens -= count
    const req: FlowRequest = { route, count, kind }
    if (size !== undefined) req.size = size
    if (spread !== undefined) req.spread = spread
    if (stagger !== undefined) req.stagger = stagger
    bus.emit('flow', req)
  }

  function toast(text: string, kind: 'info' | 'warn' | 'good' = 'info', ms = 4200): void {
    if (quiet) return
    bus.emit('toast', { text, kind, ms })
  }

  /** 1-in-n sampler used to keep particle emission under the budget. */
  function stride(ratePerSec: number, targetPerSec: number): number {
    if (ratePerSec <= targetPerSec) return 1
    return Math.max(1, Math.ceil(ratePerSec / targetPerSec))
  }

  function clearArrivalQueue(): void {
    poolArrivalHead = 0
    poolArrivalBuckets = 0
    queuedRandomTx = 0
    sessionPendingTx.fill(0)
    queuedSessionTx = 0
    sessionArrivalCursor = 0
  }

  /** Preserve all queued work while coarsening only old arrival-time precision. */
  function compactArrivalQueue(): void {
    const compacted = Math.ceil(poolArrivalBuckets / 2)
    for (let pair = 0; pair < compacted; pair++) {
      const first = (poolArrivalHead + pair * 2) % POOL_QUEUE_BUCKETS
      const secondOffset = pair * 2 + 1
      const firstCount = poolArrivalCount[first]
      if (secondOffset >= poolArrivalBuckets) {
        compactArrivalAt[pair] = poolArrivalAt[first]
        compactArrivalCount[pair] = firstCount
        continue
      }
      const second = (poolArrivalHead + secondOffset) % POOL_QUEUE_BUCKETS
      const secondCount = poolArrivalCount[second]
      const count = firstCount + secondCount
      compactArrivalAt[pair] = (
        poolArrivalAt[first] * firstCount + poolArrivalAt[second] * secondCount
      ) / Math.max(1, count)
      compactArrivalCount[pair] = count
    }
    for (let i = 0; i < compacted; i++) {
      poolArrivalAt[i] = compactArrivalAt[i]
      poolArrivalCount[i] = compactArrivalCount[i]
    }
    poolArrivalHead = 0
    poolArrivalBuckets = compacted
  }

  function enqueueArrivals(count: number, at: number): void {
    if (count <= 0) return
    if (poolArrivalBuckets >= POOL_QUEUE_BUCKETS) compactArrivalQueue()
    const tail = (poolArrivalHead + poolArrivalBuckets) % POOL_QUEUE_BUCKETS
    poolArrivalAt[tail] = at
    poolArrivalCount[tail] = count
    poolArrivalBuckets++
    queuedRandomTx += count
  }

  function markQueuedArrivalsAt(at: number): void {
    for (let i = 0; i < poolArrivalBuckets; i++) {
      poolArrivalAt[(poolArrivalHead + i) % POOL_QUEUE_BUCKETS] = at
    }
  }

  function moveArrivalQueueToSessions(): void {
    const count = queuedRandomTx
    poolArrivalHead = 0
    poolArrivalBuckets = 0
    queuedRandomTx = 0
    sessionPendingTx.fill(0)
    queuedSessionTx = count
    sessionArrivalCursor = 0
    const slots = sessionBindingLimit()
    const each = Math.floor(count / slots)
    let remainder = count - each * slots
    for (let slot = 0; slot < slots; slot++) {
      sessionPendingTx[slot] = each + (remainder-- > 0 ? 1 : 0)
    }
  }

  function moveSessionQueueToArrivals(): void {
    const count = queuedSessionTx
    sessionPendingTx.fill(0)
    queuedSessionTx = 0
    sessionArrivalCursor = 0
    enqueueArrivals(count, state.t)
  }

  function enqueueSessionArrivals(count: number): void {
    const slots = sessionBindingLimit()
    for (let i = 0; i < count; i++) {
      const slot = sessionArrivalCursor++ % slots
      sessionPendingTx[slot]++
    }
    queuedSessionTx += count
  }

  /** Returns the mean FIFO age of the batch; within-batch variance stays absent. */
  function dequeueArrivals(count: number): number {
    let remaining = Math.min(count, queuedRandomTx)
    const taken = remaining
    let weightedAge = 0
    while (remaining > 0 && poolArrivalBuckets > 0) {
      const available = poolArrivalCount[poolArrivalHead]
      const consume = Math.min(remaining, available)
      weightedAge += consume * Math.max(0, state.t - poolArrivalAt[poolArrivalHead])
      remaining -= consume
      queuedRandomTx -= consume
      if (consume >= available) {
        poolArrivalCount[poolArrivalHead] = 0
        poolArrivalHead = (poolArrivalHead + 1) % POOL_QUEUE_BUCKETS
        poolArrivalBuckets--
      } else {
        poolArrivalCount[poolArrivalHead] = available - consume
      }
    }
    return taken > 0 ? weightedAge / taken : 0
  }

  function expireMultiplexedPoolWaiters(): void {
    if (!usesMultiplexedPoolQueue(K.poolMode) || K.queryWaitTimeout <= 0) return
    const deadline = state.t - K.queryWaitTimeout
    let expired = 0
    while (
      poolArrivalBuckets > 0
      && poolArrivalAt[poolArrivalHead] <= deadline
    ) {
      expired += poolArrivalCount[poolArrivalHead]
      poolArrivalCount[poolArrivalHead] = 0
      poolArrivalHead = (poolArrivalHead + 1) % POOL_QUEUE_BUCKETS
      poolArrivalBuckets--
    }
    if (expired <= 0) return
    queuedRandomTx -= expired
    pendingTx -= expired
    stats.poolerQueryWaitTimeouts += expired
    state.pooler.disconnectedClients += expired
    if (state.t - refuseWarnT > 15) {
      refuseWarnT = state.t
      toast(
        `PgBouncer query_wait_timeout disconnected ${Math.round(expired).toLocaleString()} waiting clients`,
        'warn',
        5000,
      )
    }
  }

  function expireSessionPoolWaiters(): void {
    if (K.poolMode !== 'session' || K.queryWaitTimeout <= 0) return
    const cycles = Math.floor((state.t - sessionWaitCohortAt) / K.queryWaitTimeout)
    if (cycles <= 0) return
    const accepted = acceptedClientConnections()
    const bound = Math.min(accepted, sessionBindingLimit())
    const expired = Math.max(0, accepted - bound) * cycles
    sessionWaitCohortAt += cycles * K.queryWaitTimeout
    if (expired <= 0) return
    stats.poolerQueryWaitTimeouts += expired
    state.pooler.disconnectedClients += expired
  }

  function acceptedClientConnections(): number {
    const admissionLimit = K.poolMode === 'disabled'
      ? ordinaryConnectionCapacity(
          state.maxConnections,
          state.superuserReservedConnections,
          state.reservedConnections,
        )
      : K.maxClientConn
    return Math.min(K.clientConnections, admissionLimit)
  }

  function configuredServerConnectionLimit(): number {
    return K.poolMode === 'disabled'
      ? acceptedClientConnections()
      : K.defaultPoolSize
  }

  function serverConnectionCapacity(): number {
    return Math.max(1, Math.min(
      ordinaryConnectionCapacity(
        state.maxConnections,
        state.superuserReservedConnections,
        state.reservedConnections,
      ),
      configuredServerConnectionLimit(),
    ))
  }

  function sessionBindingLimit(): number {
    return Math.max(1, Math.min(acceptedClientConnections(), serverConnectionCapacity()))
  }

  function activeServerConnectionLimit(): number {
    return K.poolMode === 'session'
      ? sessionBindingLimit()
      : serverConnectionCapacity()
  }

  /** Session mode admits transactions only from clients holding a server binding. */
  function serverOfferedTps(): number {
    /* The tps knob is aggregate work offered by the admitted cohort. Refused
     * sockets are reported connection failures; they do not silently delete a
     * proportional share of that independently configured workload. */
    if (K.poolMode !== 'session') return K.tps
    const accepted = acceptedClientConnections()
    if (accepted <= 0) return 0
    const bound = Math.min(accepted, sessionBindingLimit())
    return K.tps * bound / accepted
  }

  function syncPoolerState(): void {
    const pooler = state.pooler
    pooler.mode = K.poolMode
    pooler.clientConnections = K.clientConnections
    pooler.acceptedClients = acceptedClientConnections()
    pooler.refusedClients = Math.max(0, K.clientConnections - pooler.acceptedClients)
    pooler.serverConnections = stats.activeBackends
    pooler.serverLimit = configuredServerConnectionLimit()
    pooler.serverCapacity = serverConnectionCapacity()
    pooler.serverConnectionErrors = K.poolMode === 'disabled'
      ? 0
      : Math.max(0, Math.min(pooler.acceptedClients, pooler.serverLimit) - pooler.serverCapacity)
    pooler.boundClients = K.poolMode === 'session'
      ? Math.min(pooler.acceptedClients, pooler.serverConnections, pooler.serverCapacity)
      : 0
    for (let slot = 0; slot < N_BACKEND_SLOTS; slot++) {
      pooler.sessionPendingTransactions[slot] = K.poolMode === 'session'
        ? sessionPendingTx[slot]
        : 0
    }
    pooler.waitingClients = K.poolMode === 'session'
      ? Math.max(0, pooler.acceptedClients - pooler.boundClients)
      : usesMultiplexedPoolQueue(K.poolMode)
        ? Math.min(
            pooler.acceptedClients,
            Math.ceil(queuedRandomTx / Math.max(1, batchSize)),
          )
        : 0
    pooler.serverOfferedTps = serverOfferedTps()
    stats.poolerQueuedTransactions = K.poolMode === 'disabled'
      ? 0
      : (K.poolMode === 'session' ? queuedSessionTx + pooler.waitingClients : queuedRandomTx)
    stats.backendConcurrencyMultiplier = state.scenario === 'connection-storm'
      ? backendConcurrencyMultiplier(stats.activeBackends)
      : 1
  }

  function rotateSessionBinding(slot: number): void {
    if (
      K.poolMode !== 'session'
      || state.pooler.waitingClients <= 0
      || extras[slot].sessionAgeT < MODEL_SESSION_CONNECTION_LIFETIME
      || sessionPendingTx[slot] > 0
    ) return
    const x = extras[slot]
    x.sessionAgeT %= MODEL_SESSION_CONNECTION_LIFETIME
    const waited = Math.max(0, state.t - sessionWaitCohortAt)
    x.nextSessionPoolWaitT = K.queryWaitTimeout > 0
      ? Math.min(waited, K.queryWaitTimeout)
      : waited
    /* The newly bound client already had one query waiting for assignment. */
    sessionPendingTx[slot]++
    queuedSessionTx++
    pendingTx++
  }

  /**
   * How many transactions one backend trip stands for. Purely a function of the
   * OFFERED rate: a healthy fleet turns over NOMINAL_TRIPS trips per second, so
   * `tps / NOMINAL_TRIPS` per trip is the scale factor that makes a healthy
   * city serve roughly what the clients ask for.
   *
   * It must never depend on the *measured* trip rate. That was a feedback loop
   * that cancelled every bottleneck in the model — see the file header.
   */
  function sizeBatch(): void {
    batchSize = Math.max(1, Math.round(serverOfferedTps() / NOMINAL_TRIPS))
  }

  function clearLatencyQuantile(quantile: LatencyQuantile): void {
    quantile.totalMs = 0
    quantile.waits.poolSlotMs = 0
    quantile.waits.bufferReadMs = 0
    quantile.waits.dirtyWriteMs = 0
    quantile.waits.tempFileMs = 0
    quantile.waits.commitMs = 0
    quantile.waits.lockMs = 0
    quantile.waits.runningMs = 0
  }

  function readLatencyComponentQuantile(
    values: Float64Array,
    order: Uint16Array,
    fraction: number,
    totalWeight: number,
  ): number {
    const rank = Math.max(1, Math.ceil(totalWeight * fraction))
    let cumulative = 0
    let selected = order[Math.max(0, latencyCount - 1)]
    for (let i = 0; i < latencyCount; i++) {
      const at = order[i]
      cumulative += latencyWeight[at]
      if (cumulative >= rank) {
        selected = at
        break
      }
    }
    return values[selected] * 1000
  }

  function readLatencyQuantile(fraction: number, totalWeight: number, out: LatencyQuantile): void {
    out.totalMs = readLatencyComponentQuantile(latencyTotal, latencyOrderTotal, fraction, totalWeight)
    out.waits.poolSlotMs = latencyPoolSlotSeen
      ? readLatencyComponentQuantile(latencyPoolSlot, latencyOrderPoolSlot, fraction, totalWeight)
      : 0
    out.waits.bufferReadMs = readLatencyComponentQuantile(
      latencyBufferRead, latencyOrderBufferRead, fraction, totalWeight,
    )
    out.waits.dirtyWriteMs = readLatencyComponentQuantile(
      latencyDirtyWrite, latencyOrderDirtyWrite, fraction, totalWeight,
    )
    out.waits.tempFileMs = readLatencyComponentQuantile(
      latencyTempFile, latencyOrderTempFile, fraction, totalWeight,
    )
    out.waits.commitMs = readLatencyComponentQuantile(
      latencyCommit, latencyOrderCommit, fraction, totalWeight,
    )
    out.waits.lockMs = readLatencyComponentQuantile(latencyLock, latencyOrderLock, fraction, totalWeight)
    out.waits.runningMs = readLatencyComponentQuantile(
      latencyRunning, latencyOrderRunning, fraction, totalWeight,
    )
  }

  function readLatencyMean(totalWeight: number, out: LatencyQuantile): void {
    let total = 0
    let poolSlot = 0
    let bufferRead = 0
    let dirtyWrite = 0
    let tempFile = 0
    let commit = 0
    let lock = 0
    let running = 0
    for (let i = 0; i < latencyCount; i++) {
      const at = latencyOrderTotal[i]
      const weight = latencyWeight[at]
      total += latencyTotal[at] * weight
      if (latencyPoolSlotSeen) poolSlot += latencyPoolSlot[at] * weight
      bufferRead += latencyBufferRead[at] * weight
      dirtyWrite += latencyDirtyWrite[at] * weight
      tempFile += latencyTempFile[at] * weight
      commit += latencyCommit[at] * weight
      lock += latencyLock[at] * weight
      running += latencyRunning[at] * weight
    }
    const scale = 1000 / totalWeight
    out.totalMs = total * scale
    out.waits.poolSlotMs = poolSlot * scale
    out.waits.bufferReadMs = bufferRead * scale
    out.waits.dirtyWriteMs = dirtyWrite * scale
    out.waits.tempFileMs = tempFile * scale
    out.waits.commitMs = commit * scale
    out.waits.lockMs = lock * scale
    out.waits.runningMs = running * scale
  }

  function refreshLatencyQuantiles(): void {
    const latency = stats.latency
    latency.observations = latencyCount
    if (latencyCount === 0) {
      latency.transactions = 0
      clearLatencyQuantile(latency.mean)
      clearLatencyQuantile(latency.p50)
      clearLatencyQuantile(latency.p99)
      return
    }

    let totalWeight = 0
    for (let i = 0; i < latencyCount; i++) totalWeight += latencyWeight[latencyOrderTotal[i]]

    latency.transactions = totalWeight
    readLatencyMean(totalWeight, latency.mean)
    readLatencyQuantile(0.5, totalWeight, latency.p50)
    readLatencyQuantile(0.99, totalWeight, latency.p99)
  }

  function removeLatencySlot(order: Uint16Array, at: number): void {
    let removeAt = 0
    while (removeAt < latencyCount && order[removeAt] !== at) removeAt++
    if (removeAt === latencyCount) throw new Error('latency ring lost its sorted slot')
    for (let i = removeAt; i < latencyCount - 1; i++) order[i] = order[i + 1]
  }

  function insertLatencySlot(
    order: Uint16Array,
    values: Float64Array,
    at: number,
    orderedCount: number,
  ): void {
    let lo = 0
    let hi = orderedCount
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (values[order[mid]] <= values[at]) lo = mid + 1
      else hi = mid
    }
    for (let i = orderedCount; i > lo; i--) order[i] = order[i - 1]
    order[lo] = at
  }

  function recordLatency(x: Extra): void {
    const at = latencyHead
    let orderedCount = latencyCount
    if (latencyCount === MODEL_LATENCY_WINDOW_TRIPS) {
      removeLatencySlot(latencyOrderTotal, at)
      if (latencyPoolSlotSeen) removeLatencySlot(latencyOrderPoolSlot, at)
      removeLatencySlot(latencyOrderBufferRead, at)
      removeLatencySlot(latencyOrderDirtyWrite, at)
      removeLatencySlot(latencyOrderTempFile, at)
      removeLatencySlot(latencyOrderCommit, at)
      removeLatencySlot(latencyOrderLock, at)
      removeLatencySlot(latencyOrderRunning, at)
      orderedCount--
    }
    const total = Math.max(0, x.visitT)
    let poolSlot = Math.max(0, x.poolSlotWaitT)
    let bufferRead = Math.max(0, x.bufferReadWaitT - x.dirtyWriteDuringReadT)
    let dirtyWrite = Math.max(0, x.dirtyWriteWaitT)
    let tempFile = Math.max(0, x.tempFileWaitT)
    let commit = Math.max(0, x.commitWaitT)
    let lock = Math.max(0, x.lockWaitT)
    const waits = poolSlot + bufferRead + dirtyWrite + tempFile + commit + lock
    if (waits > total && waits > 0) {
      const scale = total / waits
      poolSlot *= scale
      bufferRead *= scale
      dirtyWrite *= scale
      tempFile *= scale
      commit *= scale
      lock *= scale
    }

    latencyTotal[at] = total
    latencyPoolSlot[at] = poolSlot
    latencyBufferRead[at] = bufferRead
    latencyDirtyWrite[at] = dirtyWrite
    latencyTempFile[at] = tempFile
    latencyCommit[at] = commit
    latencyLock[at] = lock
    latencyRunning[at] = Math.max(
      0,
      total - poolSlot - bufferRead - dirtyWrite - tempFile - commit - lock,
    )
    latencyWeight[at] = Math.max(1, x.latencyCount)

    /* Binary insertion makes every quantile refresh O(window), not O(window²). */
    if (!latencyPoolSlotSeen && poolSlot > 0) {
      latencyPoolSlotSeen = true
      // Every older value is zero, so total-latency order is a valid fixed,
      // allocation-free seed before the first positive pool-slot insertion.
      for (let i = 0; i < orderedCount; i++) latencyOrderPoolSlot[i] = latencyOrderTotal[i]
    }
    insertLatencySlot(latencyOrderTotal, latencyTotal, at, orderedCount)
    if (latencyPoolSlotSeen) {
      insertLatencySlot(latencyOrderPoolSlot, latencyPoolSlot, at, orderedCount)
    }
    insertLatencySlot(latencyOrderBufferRead, latencyBufferRead, at, orderedCount)
    insertLatencySlot(latencyOrderDirtyWrite, latencyDirtyWrite, at, orderedCount)
    insertLatencySlot(latencyOrderTempFile, latencyTempFile, at, orderedCount)
    insertLatencySlot(latencyOrderCommit, latencyCommit, at, orderedCount)
    insertLatencySlot(latencyOrderLock, latencyLock, at, orderedCount)
    insertLatencySlot(latencyOrderRunning, latencyRunning, at, orderedCount)

    if (latencyObserver) {
      latencyObserver({
        totalMs: total * 1000,
        waits: {
          poolSlotMs: poolSlot * 1000,
          bufferReadMs: bufferRead * 1000,
          dirtyWriteMs: dirtyWrite * 1000,
          tempFileMs: tempFile * 1000,
          commitMs: commit * 1000,
          lockMs: lock * 1000,
          runningMs: latencyRunning[at] * 1000,
        },
        evictionWalFlushMs: x.evictionWalWaitT * 1000,
        transactions: latencyWeight[at],
      })
    }

    latencyHead = (latencyHead + 1) % MODEL_LATENCY_WINDOW_TRIPS
    if (latencyCount < MODEL_LATENCY_WINDOW_TRIPS) latencyCount++
  }

  /* ======================================================================
   * BUFFER POOL — shared_buffers, the clock sweep, and who pays for the I/O.
   * ====================================================================*/

  function invalidate(b: number): void {
    if (buf.valid[b]) deleteBufferMapping(b)
    buf.valid[b] = 0
    buf.dirty[b] = 0
    ckptNeeded[b] = 0
    buf.pinned[b] = 0
    buf.usage[b] = 0
    buf.rel[b] = 255
    buf.blk[b] = 0
    buf.pageLsn[b] = 0
    evictionOwner[b] = 0
    pageLsnOwners[b] = 0
  }

  /** A dirty victim has to hit the disk before the frame can be reused. */
  function writeOut(
    b: number,
    path: PageWriteObservation['path'],
    afterWalWait = false,
    expectedRel = buf.rel[b],
    expectedBlk = buf.blk[b],
  ): boolean {
    if (!buf.dirty[b]) return false
    if (pageWriteObserver) {
      const mappedBuffer = bufMap.get(representativeBufKey(expectedRel, expectedBlk))
      pageWriteObserver({
        path,
        pageLsn: buf.pageLsn[b],
        flushLsn: wal.flushLsn,
        pageLsnOwners: pageLsnOwners[b],
        tagMapped: mappedBuffer === b,
        afterWalWait,
      })
    }
    buf.dirty[b] = 0
    ioWriteAcc++
    if (path === 'backend') {
      buf.dirtyEvictions++
      const rel = buf.rel[b] < N_TABLES ? buf.rel[b] : 0
      if (++sIoWrite >= stride(stats.ioWritePerSec, 30)) {
        sIoWrite = 0
        flow(rid.ioWrite(rel), 1, 'page_write', 1.3)
      }
    }
    return true
  }

  /**
   * Clock sweep. Walk the pool decrementing usage_count until we find a frame
   * with usage 0 and no pin. This is BufferAlloc()/StrategyGetBuffer() and it is
   * the reason a too-small shared_buffers makes *backends* do write I/O.
   *
   * Returns -1 when every frame is pinned. StrategyGetBuffer() raises
   * `ERROR: no unpinned buffers available` there — it refuses, it never steals.
   * The old fallback (`return buf.clockHand % size`) handed back a PINNED frame,
   * which touchPage then evicted out from under the backend holding it: measured
   * 66 such thefts at shared_buffers=32 / tps=1600 over two minutes, every one of
   * them a page another backend was reading.
   *
   * `trycounter` mirrors the real one exactly: it is reset every time a
   * usage_count is decremented — that is progress — and only counts down on a
   * frame that is pinned.
   */
  function clockVictim(): number {
    const size = buf.sampleFrames
    let trycounter = size
    for (;;) {
      const b = buf.clockHand
      if (buf.clockHand + 1 >= size) {
        buf.clockHand = 0
        clockSweepPasses++
      } else {
        buf.clockHand++
      }
      if (!buf.pinned[b] && pageLsnOwners[b] === 0) {
        if (buf.usage[b] > 0) {
          buf.usage[b]--
          trycounter = size
          continue
        }
        bgwriterAllocations++
        return b
      }
      if (--trycounter === 0) return -1
    }
  }

  /**
   * BAS_BULKREAD: reuse our own ring frame instead of evicting the whole pool.
   * GetBufferFromRing() takes the frame back only when it is unpinned AND its
   * usage_count is still <= 1 — if somebody else has been using the page since we
   * put it there, it has escaped the ring and we must not recycle it.
   */
  function ringVictim(slot: number, x: Extra): number {
    const base = slot * RING
    const b = ringBuf[base + x.ringPos]
    x.ringPos = (x.ringPos + 1) % RING
    if (
      b >= 0
      && b < buf.sampleFrames
      && !buf.pinned[b]
      && pageLsnOwners[b] === 0
      && buf.usage[b] <= 1
    ) return b
    const v = clockVictim()
    if (v >= 0) ringBuf[base + ((x.ringPos + RING - 1) % RING)] = v
    return v
  }

  function chargeBackendPageWrite(slot: number, duringRead: boolean): void {
    const b = backends[slot]
    const x = extras[slot]
    const writeSec = ioPressure() / DEVICE_PAGES_PER_SEC
    x.execTotal += writeSec
    b.stateDur += writeSec
    x.dirtyWriteWaitT += writeSec
    if (duringRead) x.dirtyWriteDuringReadT += writeSec
  }

  function installBufferMiss(
    slot: number,
    v: number,
    rel: number,
    blk: number,
    forWrite: boolean,
    reserved = false,
  ): void {
    const b = backends[slot]
    buf.valid[v] = 1
    buf.dirty[v] = 0
    buf.rel[v] = rel
    buf.blk[v] = blk
    buf.pageLsn[v] = wal.flushLsn
    pageLsnOwners[v] = 0
    buf.usage[v] = 1
    if (reserved) {
      buf.pinned[v] = 1
      pinT[v] = state.t
    } else {
      pinBuffer(slot, v)
    }
    buf.lastTouch[v] = state.t
    bufMap.set(representativeBufKey(rel, blk), v)
    buf.misses++
    winMisses++
    ioReadAcc++
    b.lastBuffer = v
    if (++sIoRead >= stride(stats.ioReadPerSec, 40)) {
      sIoRead = 0
      const table = rel < N_TABLES ? rel : 0
      // A shared_buffers miss is not necessarily a device read. Decide the
      // kernel-cache outcome at the source so motion and drive LEDs consume
      // one fact rather than independently guessing.
      const ioPressure = clamp01(stats.ioReadPerSec / 900)
      const osCacheHit = presentationRng() < 0.74 - ioPressure * 0.29
      flow(osCacheHit ? rid.ioReadCache(table) : rid.ioRead(table), 1, 'page_read', 1.2)
    }
    if (forWrite) markDirty(v, slot)
  }

  function pageWalDurable(b: number): boolean {
    return pageLsnOwners[b] === 0 && buf.pageLsn[b] <= wal.flushLsn
  }

  function requestPageWalFlush(b: number): void {
    if (pageLsnOwners[b] === 0 && buf.pageLsn[b] > wal.flushLsn) {
      requestFlush(buf.pageLsn[b])
    }
  }

  function beginEvictionFlushWait(
    slot: number,
    victim: number,
    rel: number,
    blk: number,
    forWrite: boolean,
  ): void {
    const b = backends[slot]
    const x = extras[slot]
    x.evictionBuffer = victim
    x.evictionFlushLsn = buf.pageLsn[victim]
    x.evictionVictimRel = buf.rel[victim]
    x.evictionVictimBlk = buf.blk[victim]
    x.evictionRel = rel
    x.evictionBlk = blk
    x.evictionForWrite = forWrite
    x.evictionResumeState = b.state === 'exec_io' ? 'exec_io' : 'exec_cpu'
    x.evictionResumeT = b.stateT
    x.evictionResumeDur = b.stateDur
    pinBuffer(slot, victim)
    evictionOwner[victim] = slot + 1
    b.state = 'eviction_flush'
    b.stateT = 0
    b.stateDur = Math.max(0.09, flushDur) * 1.5
    requestPageWalFlush(victim)
  }

  function finishEvictionFlushWait(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const victim = x.evictionBuffer
    if (victim < 0) return
    const duringRead = x.evictionResumeState === 'exec_io'
    b.state = x.evictionResumeState
    b.stateT = x.evictionResumeT
    b.stateDur = x.evictionResumeDur
    if (writeOut(
      victim,
      'backend',
      true,
      x.evictionVictimRel,
      x.evictionVictimBlk,
    )) {
      chargeBackendPageWrite(slot, duringRead)
    }
    deleteBufferMapping(victim, x.evictionVictimRel, x.evictionVictimBlk)
    buf.evictions++
    const replacementKey = representativeBufKey(x.evictionRel, x.evictionBlk)
    const installed = bufMap.get(replacementKey)
    if (installed !== undefined && installed !== victim && buf.valid[installed]) {
      invalidate(victim)
      pinBuffer(slot, installed)
      if (buf.usage[installed] < 5) buf.usage[installed]++
      buf.lastTouch[installed] = state.t
      b.lastBuffer = installed
      if (x.evictionForWrite) markDirty(installed, slot)
      buf.hits++
      winHits++
      b.buffersTouched++
      b.buffersHit++
    } else {
      installBufferMiss(slot, victim, x.evictionRel, x.evictionBlk, x.evictionForWrite, true)
      b.buffersTouched++
      b.buffersRead++
    }
    x.evictionBuffer = -1
    x.evictionFlushLsn = 0
    evictionOwner[victim] = 0
  }

  function cancelEvictionFlushWait(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const victim = x.evictionBuffer
    if (victim < 0) return
    b.state = x.evictionResumeState
    b.stateT = x.evictionResumeT
    b.stateDur = x.evictionResumeDur
    buf.pinned[victim] = 0
    if (evictionOwner[victim] === slot + 1) evictionOwner[victim] = 0
    x.evictionBuffer = -1
    x.evictionFlushLsn = 0
    // The requested page is accounted as an uncached read; the dirty victim stays mapped.
    buf.misses++
    winMisses++
    ioReadAcc++
    b.buffersTouched++
    b.buffersRead++
  }

  /**
   * Request one page. Returns true on a hit, false on a completed miss, and
   * null when WAL durability has suspended this backend's dirty-victim miss.
   */
  function touchPage(
    slot: number,
    rel: number,
    blk: number,
    forWrite: boolean,
    useRing: boolean,
  ): boolean | null {
    const exactKey = bufKey(rel, blk)
    const representativeKey = representativeBufKey(rel, blk)
    accessCounts.set(exactKey, (accessCounts.get(exactKey) ?? 0) + 1)
    const found = bufMap.get(representativeKey)
    const b = backends[slot]
    const x = extras[slot]

    if (found !== undefined && found < buf.sampleFrames && buf.valid[found]) {
      // PinBuffer(): a strategy access caps usage_count at 1 (`if (usage == 0)
      // usage = 1`), an ordinary one increments up to BM_MAX_USAGE_COUNT. That cap
      // is the whole point of a ring — a sequential scan must not be able to
      // promote the pages it sweeps past above the OLTP working set.
      if (useRing) { if (buf.usage[found] === 0) buf.usage[found] = 1 }
      else if (buf.usage[found] < 5) buf.usage[found]++
      pinBuffer(slot, found)
      buf.lastTouch[found] = state.t
      // A frame represents a stable bucket of logical pages; expose the page
      // most recently sampled into that bucket to inspectors and FPI tracking.
      buf.rel[found] = rel
      buf.blk[found] = blk
      b.lastBuffer = found
      if (forWrite) markDirty(found, slot)
      // One sampled ring block represents roughly SCAN_STRIDE blocks spread
      // across the relation. Its representative frame can recur while the
      // 32-frame BAS_BULKREAD stream itself is recycling cold pages, so score
      // the sample the same way as drainPages()'s statistical tail.
      const representativeHit = !useRing
      if (representativeHit) {
        buf.hits++
        winHits++
      } else {
        buf.misses++
        winMisses++
        ioReadAcc++
      }
      return representativeHit
    }

    // miss → find a victim, pay for it, then read from storage
    const v = useRing ? ringVictim(slot, x) : clockVictim()
    if (v < 0) {
      // Every frame is pinned: `ERROR: no unpinned buffers available`. The read
      // still happened — it just cannot be cached — so it counts as blks_read.
      buf.misses++
      winMisses++
      ioReadAcc++
      if (state.t - noBufWarnT > 20) {
        noBufWarnT = state.t
        toast('ERROR: no unpinned buffers available', 'warn', 4000)
      }
      return false
    }
    if (buf.pinned[v]) {
      throw new Error(`buffer invariant: attempted to evict pinned frame ${v}`)
    }
    if (buf.valid[v]) {
      if (buf.dirty[v] && !pageWalDurable(v)) {
        /* FlushBuffer() enforces the write-ahead rule with XLogFlush(page LSN).
         * requestFlush joins the existing in-flight flush, so one fsync can
         * release committers and dirty-victim evictors together. */
        beginEvictionFlushWait(slot, v, rel, blk, forWrite)
        return null
      }
      if (writeOut(v, 'backend')) {
        // An already-durable page pays only the device write itself.
        chargeBackendPageWrite(slot, b.state === 'exec_io')
      }
      deleteBufferMapping(v)
      buf.evictions++
    }
    installBufferMiss(slot, v, rel, blk, forWrite)
    return false
  }

  function markDirty(b: number, slot: number): void {
    buf.dirty[b] = 1
    /* The page LSN advances only when this trip's aggregate record has reached
     * its end LSN. Until then the owner bit makes the content non-writable. */
    pageLsnOwners[b] |= 1 << slot
    const rel = buf.rel[b]
    if (rel < N_TABLES) {
      if (buf.blk[b] < IDX_BASE) heapWritesSinceVacuum[rel]++
      else indexWritesSinceVacuum[rel]++
    }
    if (!K.fullPageWrites) return
    // full_page_writes: the first modification of a page after a checkpoint
    // carries an entire 8 KiB image into the WAL, so that replay can always
    // start from a page it trusts. This is why WAL volume explodes immediately
    // after every checkpoint and then decays as the write working set pays off.
    const key = bufKey(buf.rel[b], buf.blk[b])
    if (fpiGenerationByPage.get(key) === fpiGeneration) return
    fpiGenerationByPage.set(key, fpiGeneration)
    const bytes = PAGE * rr(0.6, 1.0) // the hole between pd_lower/pd_upper is skipped
    extras[slot].fpiBytes += bytes
    backends[slot].walFpiBytes = extras[slot].fpiBytes
  }

  /**
   * WAL for a page modified by a maintenance process. Vacuum uses its own
   * Buffer Access Strategy, so there is deliberately no backend slot and no
   * call to touchPage()/markDirty(). It still shares the checkpoint generation:
   * a heap page pays at most one FPI between redo points no matter whether a
   * backend or vacuum touched it first.
   */
  function walInsertPage(
    rel: number,
    blk: number,
    recBytes: number,
    passGeneration = fpiGeneration,
  ): void {
    queueMaintenanceWal(recBytes)
    if (K.fullPageWrites) {
      const key = bufKey(rel, blk)
      const seenGeneration = fpiGenerationByPage.get(key) ?? -1
      if (seenGeneration < passGeneration) {
        fpiGenerationByPage.set(key, passGeneration)
        // Maintenance must not consume the workload RNG: toggling autovacuum
        // should not silently re-roll the client query mix in an A/B sweep.
        const bytes = PAGE * 0.8
        queueMaintenanceWal(bytes)
        maintenanceFpiPending += bytes
      }
    }
  }

  function queueMaintenanceWal(bytes: number): void {
    maintenanceWalPending += bytes
    maintenanceWalQueued += bytes
  }

  function resizePool(logicalMib: number): void {
    const size = sampledBufferFrames(logicalMib)
    wal.bufferCapacity = walBufferCapacity(logicalMib)
    wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
    // shared_buffers only changes at restart, and the shutdown checkpoint that
    // precedes one writes every dirty buffer out. Dropping the frames without
    // writing them was a silent loss of modified pages — and the one remaining
    // way a page dirty at a checkpoint's redo point could escape being written.
    if (size < buf.sampleFrames) {
      for (let b = size; b < buf.sampleFrames; b++) {
        writeOut(b, 'checkpointer')
        invalidate(b)
      }
    }
    buf.sampleFrames = size
    if (buf.clockHand >= size) buf.clockHand = 0
    if (bgw.scanPos >= size) bgw.scanPos = 0
    bgwriterScanRemainder = 0
    clockSweepPasses = 0
    bgwriterScanPasses = 0
    bgwriterCursorValid = true
    for (let i = 0; i < ringBuf.length; i++) if (ringBuf[i] >= size) ringBuf[i] = -1
    // pinsFor() shrinks with the pool; pins parked in ring positions the new
    // bound no longer reaches would otherwise be held for ever.
    const n = pinsFor()
    for (let s = 0; s < N_BACKEND_SLOTS; s++) {
      for (let i = 0; i < PINS; i++) {
        const b = pinRing[s * PINS + i]
        if (b >= 0 && (i >= n || b >= size)) {
          if (b < buf.sampleFrames) buf.pinned[b] = 0
          pinRing[s * PINS + i] = -1
        }
      }
      if (pinPos[s] >= n) pinPos[s] = 0
    }
    for (let ni = 1; ni < state.cluster.nodes.length; ni++) {
      const standbyPool = state.cluster.nodes[ni].buffers
      if (size < standbyPool.sampleFrames) {
        for (let b = size; b < standbyPool.sampleFrames; b++) {
          standbyPool.valid[b] = 0
          standbyPool.dirty[b] = 0
          standbyPool.usage[b] = 0
        }
      }
      standbyPool.sampleFrames = size
      if (standbyPool.clockHand >= size) standbyPool.clockHand = 0
    }
  }

  /** Pin decay + the counters the 3D grid reads. Cheap: 1024 slots. */
  function sweepPool(): void {
    let dirtyN = 0
    let pinN = 0
    let usedN = 0
    const now = state.t
    for (let b = 0; b < buf.sampleFrames; b++) {
      if (buf.pinned[b] && evictionOwner[b] === 0 && now - pinT[b] > 0.12) buf.pinned[b] = 0
      if (buf.valid[b]) usedN++
      if (buf.dirty[b]) dirtyN++
      if (buf.pinned[b]) pinN++
    }
    buf.dirtyCount = asSampleFrames(dirtyN)
    buf.pinnedCount = asSampleFrames(pinN)
    buf.usedCount = asSampleFrames(usedN)
  }

  /* ======================================================================
   * WAL
   * ====================================================================*/

  function walInsert(rawBytes: number): void {
    const bytes = Math.round(rawBytes) // an LSN is a byte offset, never a fraction
    wal.insertLsn += bytes
    walAcc += bytes
    // wal_buffers holds everything inserted but not yet written, and it is a
    // fixed ring: once it is full the inserting backend has to write buffers
    // out itself before it can carve out space. That stall is what shows up as
    // WALWriteLock contention on an undersized wal_buffers.
    wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
    if (wal.bufferBytes >= wal.bufferCapacity) requestFlush(wal.insertLsn)
  }

  /**
   * Capture the finished insert position before issuing write+fsync. WAL
   * inserted after this point is not covered by this flush and has to ride the
   * next one; this is why a commit under load waits for one to two fsyncs.
   */
  function startFlush(): void {
    flushing = true
    flushTarget = Math.min(flushTarget, wal.insertLsn)
    flushCovered = wal.insertLsn
    flushBytes = Math.max(0, flushCovered - wal.flushLsn)
    flushDur = (0.085 + Math.min(0.22, flushBytes / (6 * 1024 * 1024))) * ioPressure()
    flushT = 0
    // write() happens now; fsync() completes later. WAL buffers are reusable
    // once written to the kernel, not once the fsync has hardened them.
    wal.writeLsn = Math.max(wal.writeLsn, flushCovered)
    wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
    flow('wal.flush', 1, 'wal_flush', 1.3)
  }

  function requestFlush(target: number): void {
    const insertedTarget = Math.min(target, wal.insertLsn)
    if (insertedTarget > flushTarget) flushTarget = insertedTarget
    if (!flushing) {
      startFlush()
      return
    }
    /* Fsync is visually stretched, but insertion rates are not. Release the
     * requested write now; bytes above flushCovered ride the next fsync. */
    wal.writeLsn = Math.max(wal.writeLsn, insertedTarget)
    wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
  }

  function drainMaintenanceWal(dt: number): void {
    let budget = Math.max(4096, 24 * 1024 * 1024 * dt)
    while (maintenanceWalPending > 0 && budget > 0) {
      const gap = Math.max(0, wal.insertLsn - wal.writeLsn)
      const available = Math.max(0, wal.bufferCapacity - gap)
      // Maintenance inserts first, but may consume only half a refill; a large
      // vacuum must not keep every client backend parked on WALWriteLock. It may
      // use more than one refill per tick when the writer keeps releasing pages.
      const chunk = Math.min(
        maintenanceWalPending,
        Math.min(available, wal.bufferCapacity * 0.5),
        budget,
      )
      if (chunk <= 0) break
      walInsert(chunk)
      maintenanceWalPending -= chunk
      maintenanceWalDrained += chunk
      budget -= chunk
      const fpiChunk = Math.min(maintenanceFpiPending, chunk)
      maintenanceFpiPending -= fpiChunk
      fpiAcc += fpiChunk
      if (maintenanceWalPending > 0) requestFlush(wal.insertLsn)
    }
  }

  function tickWal(dt: number): void {
    walWriterT += dt
    if (walWriterT >= WAL_WRITER_DELAY) {
      walWriterT = 0
      // walwriter wakes on its timer, and eagerly when wal_buffers pass half full
      if (wal.bufferBytes > 0) requestFlush(wal.insertLsn)
    } else if (wal.bufferBytes > wal.bufferCapacity * 0.5) {
      requestFlush(wal.insertLsn)
    }

    if (flushing) {
      flushT += dt
      if (flushT >= flushDur) {
        // The fsync hardens exactly what had been written when it started, so
        // flush catches up with write and the gap closes. One flush satisfies
        // every backend waiting below that line — that is group commit.
        // Records inserted while it was in flight are not covered: they stay in
        // wal_buffers and ride the next flush, which is why a commit arriving
        // mid-fsync waits for the one after it.
        wal.flushLsn = Math.max(wal.flushLsn, flushCovered)
        recordFlushSample(wal.flushLsn)
        wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
        flushing = false
        flow('wal.write', 1, 'wal', 1.4)
        flow('wal.fsync', 1, 'wal_flush', 1.1)
        // Anyone who asked for a flush while that one was in flight is still
        // waiting, and in Postgres they do not wait for the WAL writer's next
        // tick: the first of them takes WALWriteLock the moment it is free and
        // starts the next write+fsync immediately. Under sustained load that is
        // why fsyncs run back to back, and why the write pointer stays ahead of
        // the flush pointer instead of the two meeting between flushes.
        if (flushTarget > wal.flushLsn) startFlush()
      }
    }

    tickSegments(dt)
  }

  const archiverOn = () => K.walLevel !== 'minimal'

  function tickSegments(dt: number): void {
    const curSeg = Math.floor(wal.insertLsn / WAL_SEG)
    if (curSeg > lastObservedCurrentSeg) {
      for (let id = lastObservedCurrentSeg; id < curSeg; id++) {
        const slot = ((id % DR_HISTORY_SLOTS) + DR_HISTORY_SLOTS) % DR_HISTORY_SLOTS
        closedSegmentId[slot] = id
        closedSegmentAt[slot] = state.t
      }
      lastObservedCurrentSeg = curSeg
    }

    let base = Math.floor(segments[0].id)
    // scroll the visible window so the current segment sits ~2/3 along
    while (curSeg - base > N_WAL_SEG_SLOTS - 5) {
      for (let i = 0; i < N_WAL_SEG_SLOTS - 1; i++) {
        const a = segments[i]
        const b = segments[i + 1]
        a.id = b.id
        a.name = b.name
        a.bytes = b.bytes
        a.state = b.state
        a.fill = b.fill
      }
      base++
      const last = segments[N_WAL_SEG_SLOTS - 1]
      // "recycled": the old file is renamed to a future name, not deleted.
      last.id = base + N_WAL_SEG_SLOTS - 1
      last.name = walSegName(last.id, ha.timeline.current)
      last.bytes = 0
      last.fill = 0
      last.state = 'recycled'
    }

    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const s = segments[i]
      s.id = base + i
      const segmentTimeline = ha.timeline.forkLsn > 0
        && s.id < Math.floor(ha.timeline.forkLsn / WAL_SEG)
        ? ha.timeline.parent
        : ha.timeline.current
      s.name = walSegName(s.id, segmentTimeline)
      if (s.id < curSeg) {
        s.bytes = WAL_SEG
        s.fill = 1
        if (segmentTimeline === dr.archive.parentTimeline) {
          s.state = (s.id + 1) * WAL_SEG <= dr.archive.parentArchivedThroughLsn
            ? 'archived'
            : 'streamed'
        } else if (s.id < archiveNextSeg) s.state = 'archived'
        else if (s.id === archiveInFlight) s.state = 'archiving'
        else s.state = 'full'
      } else if (s.id === curSeg) {
        s.bytes = wal.insertLsn - curSeg * WAL_SEG
        s.fill = clamp01(s.bytes / WAL_SEG)
        s.state = 'current'
      } else {
        if (s.state !== 'recycled') {
          s.bytes = 0
          s.fill = 0
          s.state = 'recycled'
        }
      }
    }

    // A visible segment is streamed once both physical walsenders passed it.
    if (rep.standbys[0].connected || rep.standbys[1].connected) {
      let sent = Number.POSITIVE_INFINITY
      for (let i = 0; i < 2; i++) {
        const standby = rep.standbys[i]
        if (standby.connected) sent = Math.min(sent, standby.sentLsn)
      }
      const sentSeg = Math.floor(sent / WAL_SEG)
      for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
        const s = segments[i]
        if (s.state === 'full' && s.id < sentSeg) s.state = 'streamed'
      }
    }

    // The queue is model-owned and unbounded by the 14-slot display window.
    // PostgreSQL retries the oldest .ready file until wal-g wal-push returns 0.
    const completedThrough = curSeg - 1
    const queue = Math.max(0, completedThrough - archiveNextSeg + 1)
    wal.archiveQueue = queue
    dr.archive.queueSegments = queue

    const historyFilePending = ha.timeline.forkLsn > 0
      && !dr.archive.historyFileArchived
    if (archiverOn() && historyFilePending) {
      if (!K.walGArchiveCredentialsValid) {
        archiveRetryT += dt
        if (archiveRetryT >= DR_ARCHIVE_SEGMENT_SECONDS) {
          archiveRetryT -= DR_ARCHIVE_SEGMENT_SECONDS
          dr.archive.failedAttempts++
          archT = 0
        }
      } else {
        archiveRetryT = 0
        archT += dt
        flow('wal.archive', 1, 'archive', 1.2)
        if (archT >= DR_ARCHIVE_SEGMENT_SECONDS) {
          dr.archive.historyFileArchived = true
          archT = 0
        }
      }
    } else if (archiverOn() && queue > 0) {
      if (!K.walGArchiveCredentialsValid) {
        archiveRetryT += dt
        if (archiveRetryT >= DR_ARCHIVE_SEGMENT_SECONDS) {
          archiveRetryT -= DR_ARCHIVE_SEGMENT_SECONDS
          dr.archive.failedAttempts++
          archT = 0
        }
      } else {
        archiveRetryT = 0
        if (archiveInFlight < 0) {
          archiveInFlight = archiveNextSeg
          archT = 0
        }
        archT += dt
        flow('wal.archive', 1, 'archive', 1.2)
        if (archT >= DR_ARCHIVE_SEGMENT_SECONDS) {
          const archivedId = archiveInFlight
          archiveNextSeg = archivedId + 1
          archiveInFlight = -1
          archT = 0
          wal.archived++
          dr.archive.archivedThroughLsn = archiveNextSeg * WAL_SEG
          const slot = ((archivedId % DR_HISTORY_SLOTS) + DR_HISTORY_SLOTS) % DR_HISTORY_SLOTS
          dr.archive.archivedThroughTime =
            closedSegmentId[slot] === archivedId ? closedSegmentAt[slot] : state.t
        }
      }
    } else if (queue === 0) {
      archiveInFlight = -1
      archT = 0
      archiveRetryT = 0
    }

    // pg_wal size: everything since the REDO point of the last COMPLETED
    // checkpoint, plus the recycled files we keep pre-allocated, plus anything
    // archiving is holding — and, critically, everything a replication slot has
    // not confirmed yet. A standby that falls behind (or a slot nobody is
    // reading) pins WAL on the primary. That is how a replica takes down a
    // primary's disk.
    //
    // `completedRedoLsn`, not `ckpt.redoLsn`: segments are recycled by
    // RemoveOldXlogFiles() after the checkpoint record is written and pg_control
    // updated, never at the start. This is why pg_wal holds its maximum right
    // through the write phase and steps down exactly once, at the end.
    const sinceRedo = Math.max(0, wal.insertLsn - ckpt.completedRedoLsn)
    let slotHold = 0
    for (let i = 0; i < 2; i++) {
      const standby = rep.standbys[i]
      const slot = rep.physicalSlots[i]
      if (K.walLevel === 'minimal' || !slot.exists) {
        slot.active = false
        slot.restartLsn = wal.insertLsn
        slot.retainedBytes = 0
        continue
      }
      slot.active = standby.enabled && standby.connected
      if (slot.active) slot.restartLsn = Math.max(slot.restartLsn, standby.flushedLsn)
      slot.retainedBytes = Math.max(0, wal.insertLsn - slot.restartLsn)
      slotHold = Math.max(slotHold, slot.retainedBytes)
    }
    if (rep.logicalEnabled) {
      slotHold = Math.max(slotHold, wal.insertLsn - rep.logicalSlotLsn)
    }
    const archiveHold = Math.max(0, wal.insertLsn - archiveNextSeg * WAL_SEG)
    wal.segmentCount = clamp(
      Math.ceil(Math.max(sinceRedo, slotHold, archiveHold) / WAL_SEG) + 3,
      N_WAL_SEG_SLOTS,
      512,
    )
    dr.archive.pgWalBytes = wal.segmentCount * WAL_SEG
    if (!dr.archive.writesBlocked && dr.archive.pgWalBytes >= dr.archive.pgWalCapacityBytes) {
      dr.archive.writesBlocked = true
      toast(
        'pg_wal reached the scaled safety limit — writes rejected; real PostgreSQL would PANIC when the filesystem filled',
        'warn',
        8000,
      )
    } else if (
      dr.archive.writesBlocked
      && dr.archive.pgWalBytes <= dr.archive.pgWalCapacityBytes * 0.75
    ) {
      dr.archive.writesBlocked = false
      toast('Primary pg_wal fell below the scaled safety limit — writes admitted again', 'good', 5000)
    }
  }

  /* ======================================================================
   * DISASTER RECOVERY
   * ====================================================================*/

  function dataDirectoryBytes(): number {
    let pages = 0
    for (let i = 0; i < tables.length; i++) pages += tables[i].pages + tables[i].indexPages
    return pages * PAGE + DR_DATA_DIRECTORY_OVERHEAD_BYTES
  }

  function applyBackupRetention(): void {
    const keep = Math.max(1, Math.round(K.backupRetention))
    while (dr.backups.length > keep) {
      dr.backups.shift()
      dr.expiredBackups++
    }
    dr.oldestRecoverableTime = dr.backups.length > 0 ? dr.backups[0].completedAt : 0
  }

  function backupFetchBytesPerSec(): number {
    return Math.min(
      DR_RESTORE_BYTES_PER_SEC,
      K.walGDownloadConcurrency * DR_BACKUP_FETCH_BYTES_PER_STREAM_SEC,
    )
  }

  function walRecoveryBytesPerSec(): number {
    return Math.min(
      DR_WAL_REPLAY_BYTES_PER_SEC,
      K.walGDownloadConcurrency * DR_WAL_FETCH_BYTES_PER_STREAM_SEC,
    )
  }

  function mixBackupDigest(hash: number, value: number): number {
    return Math.imul(hash ^ (Math.trunc(value) >>> 0), 0x01000193) >>> 0
  }

  function backupManifestDigest(): number {
    const op = dr.backup
    let digest = mixBackupDigest(0x811c9dc5, op.startTimeline)
    digest = mixBackupDigest(digest, op.startLsn)
    digest = mixBackupDigest(digest, op.stopLsn)
    if (op.stopTimeline !== op.startTimeline) {
      digest = mixBackupDigest(digest, ha.timeline.forkLsn)
      digest = mixBackupDigest(digest, op.stopTimeline)
    }
    digest = mixBackupDigest(digest, op.dataBytes)
    for (let i = 0; i < tables.length; i++) {
      digest = mixBackupDigest(digest, tables[i].pages)
      digest = mixBackupDigest(digest, tables[i].indexPages)
      digest = mixBackupDigest(digest, tables[i].liveTuples)
    }
    return digest
  }

  function backupSmokeTableMask(): number {
    let mask = 0
    for (let i = 0; i < tables.length; i++) {
      if (tables[i].liveTuples > 0) mask |= 1 << i
    }
    if (K.restoreDrillFault === 'empty_other_table' && N_TABLES > 1) mask &= ~(1 << 1)
    return mask
  }

  function backupObjectDigest(manifestDigest: number): number {
    return K.restoreDrillFault === 'corrupt_object'
      ? mixBackupDigest(manifestDigest, 0x434f5252)
      : manifestDigest
  }

  function completedBackupWalRanges(): BaseBackupWalRange[] {
    const op = dr.backup
    if (op.stopTimeline === op.startTimeline) {
      return [{
        timeline: op.startTimeline,
        startLsn: op.startLsn,
        endLsn: op.stopLsn,
      }]
    }
    /* The city has one fork, so the only supported multi-range manifest is
     * the parent range followed by the child range created during backup. */
    return [
      {
        timeline: op.startTimeline,
        startLsn: op.startLsn,
        endLsn: ha.timeline.forkLsn,
      },
      {
        timeline: op.stopTimeline,
        startLsn: ha.timeline.forkLsn,
        endLsn: op.stopLsn,
      },
    ]
  }

  function completeBaseBackup(): void {
    const op = dr.backup
    const duration = Math.max(0, state.t - op.startedAt)
    const manifestDigest = backupManifestDigest()
    const objectDigest = backupObjectDigest(manifestDigest)
    const smokeTableMask = backupSmokeTableMask()
    if (earliestBackupCompletedAt === 0) earliestBackupCompletedAt = state.t
    dr.backups.push({
      id: backupSeq,
      label: `base_${walSegName(Math.floor(op.startLsn / WAL_SEG), op.startTimeline)}`,
      startedAt: op.startedAt,
      completedAt: state.t,
      startTimeline: op.startTimeline,
      startLsn: op.startLsn,
      stopLsn: op.stopLsn,
      walRanges: completedBackupWalRanges(),
      dataBytes: op.dataBytes,
      objectStoreBytes: op.objectStoreBytes,
      durationSec: duration,
      source: 'standby_a',
      trigger: op.trigger,
      tool: 'WAL-G',
      manifestDigest,
      objectDigest,
      smokeTableMask,
    })
    K.restoreDrillFault = 'none'
    backupSeq++
    applyBackupRetention()
    op.status = 'idle'
    op.progress = 1
    op.copiedBytes = op.dataBytes
    op.failureReason = ''
    toast('WAL-G backup-push stored; scheduled delete retain FULL expired older backups and their PITR WAL', 'good', 6000)
  }

  function failBaseBackup(reason: string): void {
    const op = dr.backup
    op.status = 'failed'
    op.failureReason = reason
    toast(reason, 'warn', 6500)
  }

  function backupArchiveBoundary(stopLsn: number): number {
    return Math.ceil(stopLsn / WAL_SEG) * WAL_SEG
  }

  function parentArchivedThroughForSpanningBackup(): number {
    const parentEnd = dr.archive.parentArchivedThroughLsn
    if (
      parentEnd >= ha.timeline.forkLsn
      || parentEnd < forkSegmentStartLsn()
      || !forkSegmentCopyArchived()
    ) return parentEnd
    return ha.timeline.forkLsn
  }

  function backupWalRangesArchived(): boolean {
    const op = dr.backup
    const stopBoundary = backupArchiveBoundary(op.stopLsn)
    if (op.stopTimeline === op.startTimeline) {
      return archiveHasLsn(op.startTimeline, stopBoundary)
    }
    return op.startTimeline === ha.timeline.parent
      && op.stopTimeline === ha.timeline.current
      && op.startLsn <= ha.timeline.forkLsn
      && op.stopLsn >= ha.timeline.forkLsn
      && parentArchivedThroughForSpanningBackup() >= ha.timeline.forkLsn
      && archiveHasLsn(op.stopTimeline, stopBoundary)
  }

  function startBaseBackup(): boolean {
    const op = dr.backup
    const standbyA = rep.standbys[0]
    if (op.status === 'copying' || op.status === 'waiting_wal') return false
    op.trigger = backupTrigger
    if (!standbyA.connected || !standbyA.enabled || K.walLevel === 'minimal') {
      failBaseBackup(
        K.walLevel === 'minimal'
          ? 'Full backup refused: wal_level=minimal cannot support the required archive recovery chain'
          : 'Full backup refused: this modeled WAL-G backup-push is configured on standby_a, which is unavailable',
      )
      return false
    }

    dr.dataDirectoryBytes = dataDirectoryBytes()
    op.status = 'copying'
    op.progress = 0
    op.startedAt = state.t
    op.startTimeline = state.highAvailability.timeline.current
    op.stopTimeline = 0
    op.startLsn = standbyA.appliedLsn
    op.stopLsn = 0
    op.dataBytes = dr.dataDirectoryBytes
    op.objectStoreBytes = Math.round(op.dataBytes * DR_OBJECT_STORE_RATIO)
    op.copiedBytes = 0
    op.estimatedDurationSec = op.dataBytes / DR_BACKUP_BYTES_PER_SEC
    op.failureReason = ''
    if (op.trigger === 'manual') {
      dr.backupSchedule.nextStartAt = state.t + dr.backupSchedule.intervalSec
    }
    toast(
      `WAL-G ${op.trigger === 'schedule' ? 'daily scheduled ' : ''}backup-push started on standby_a — compressed objects stream straight to object storage`,
      'info',
      6000,
    )
    return true
  }

  function tickBackupSchedule(): void {
    const schedule = dr.backupSchedule
    if (state.t < schedule.nextStartAt) return
    do schedule.nextStartAt += schedule.intervalSec
    while (schedule.nextStartAt <= state.t)
    const op = dr.backup
    if (op.status === 'copying' || op.status === 'waiting_wal') return
    backupTrigger = 'schedule'
    startBaseBackup()
    backupTrigger = 'manual'
  }

  function resetRestore(targetTime: number): void {
    const restore = dr.restore
    restore.status = 'idle'
    restore.progress = 0
    restore.targetTime = targetTime
    restore.targetRecordLsn = 0
    restore.targetLsn = 0
    restore.recoveryTargetTimeline = K.recoveryTargetTimeline
    restore.backupTimeline = 0
    restore.targetTimeline = 0
    restore.crossesTimelineFork = false
    restore.historyFileName = ''
    restore.followedHistoryFile = false
    restore.parentReplayEndLsn = 0
    restore.backupId = -1
    restore.backupAgeSec = 0
    restore.backupBytesRequired = 0
    restore.backupBytesFetched = 0
    restore.walBytesRequired = 0
    restore.walBytesAvailable = 0
    restore.walBytesReplayed = 0
    restore.lastReachedTime = 0
    restore.lastReachedTimeline = 0
    restore.estimatedDurationSec = 0
    restore.elapsedSec = 0
    restore.failureReason = ''
    restore.resultMessage = ''
    restore.pendingWalFailureReason = ''
    restore.pendingStartupFailureReason = ''
    restoreTimelineLocked = false
    restoreReplayTimeline = 0
  }

  function resetDrill(level: RestoreDrillLevel, targetTime: number): void {
    const drill = dr.drill
    drill.level = level
    drill.status = 'idle'
    drill.evidenceRank = CLAIM_VALUES.restoreDrill.levels[level].rank
    drill.progress = 0
    drill.startedAt = state.t
    drill.completedAt = 0
    drill.targetTime = targetTime
    drill.backupId = -1
    drill.backupAgeSec = 0
    drill.backupObjectBytesRequired = 0
    drill.walBytesRequired = 0
    drill.estimatedRestoreToTargetSec = 0
    drill.measuredRestoreToTargetSec = 0
    drill.estimatedDurationSec = 0
    drill.elapsedSec = 0
    drill.objectStoreBytesRead = 0
    drill.checksumBytesRequired = 0
    drill.checksumBytesRead = 0
    drill.smokeBytesRequired = 0
    drill.smokeBytesRead = 0
    drill.validationBytesRequired = 0
    drill.validationBytesRead = 0
    drill.manifestDigest = 0
    drill.restoredDigest = 0
    drill.smokeTableMask = 0
    drill.failureReason = ''
  }

  function backupById(id: number): (typeof dr.backups)[number] | undefined {
    for (let i = 0; i < dr.backups.length; i++) {
      if (dr.backups[i].id === id) return dr.backups[i]
    }
    return undefined
  }

  function smokeBytesForLevel(level: RestoreDrillLevel): number {
    const tableCount = level === 'table' ? 1 : N_TABLES
    return tableCount * DR_DRILL_SMOKE_BLOCKS_PER_TABLE * PAGE
  }

  function archiveGapReason(timeline: number): string {
    if (timeline === dr.archive.parentTimeline) {
      const forkSegmentStart = Math.floor(ha.timeline.forkLsn / WAL_SEG) * WAL_SEG
      if (
        dr.archive.parentArchivedThroughLsn >= forkSegmentStart
        && dr.archive.parentArchivedThroughLsn < ha.timeline.forkLsn
      ) {
        return `Archive gap: recovery_target_timeline=current searches only timeline ${timeline}, whose partial fork segment was not archived under that timeline. Timeline ${dr.archive.timeline}'s copied fork segment belongs to a newer history and is not eligible for current`
      }
      if (dr.archive.parentArchivedThroughLsn >= ha.timeline.forkLsn) {
        return `Archive gap: recovery_target_timeline=current searches only timeline ${timeline}, whose archived divergent tail ends before the selected transaction record. Timeline ${dr.archive.timeline}'s newer history is not eligible for current`
      }
      if (!K.walGArchiveCredentialsValid) {
        return `Archive fault and parent gap: wal-g wal-push credentials are invalid, and timeline ${timeline} is missing complete segments before the fork segment in object storage. The promoted standby used archive_mode=on while it was in recovery and will not archive those segments it received by streaming; repairing timeline ${dr.archive.timeline}'s archiver can archive its copied fork segment but cannot recreate this earlier parent gap`
      }
      if (!archiverOn()) {
        return `Archive fault: wal_level=minimal left complete timeline-${timeline} segments missing before the fork segment in object storage. The promoted standby's timeline-${dr.archive.timeline} fork-segment copy cannot recreate that earlier parent chain`
      }
      return `Archive gap: timeline ${timeline} is missing complete segments before the fork segment in object storage. The promoted standby used archive_mode=on while it was in recovery, so it will not archive those segments it received by streaming; archive_timeout and timeline ${dr.archive.timeline}'s copied fork segment cannot repair this earlier lost parent chain`
    }
    if (!K.walGArchiveCredentialsValid) {
      return `Archive fault: wal-g wal-push credentials are invalid, so completed WAL on timeline ${timeline} cannot reach the selected target; repair the credentials and wait for the .ready queue to drain`
    }
    if (!archiverOn()) {
      return `Archive fault: wal_level=minimal disables this modeled archive-recovery chain, so wal-g wal-push cannot reach the selected target on timeline ${timeline}; repair the configuration before relying on PITR`
    }
    if (dr.archive.queueSegments > 0) {
      return `The selected target is beyond the healthy timeline ${timeline} archive frontier while wal-g wal-push processes completed segments; no archive fault is modeled. Let the .ready queue drain and compare archive throughput with WAL generation; archive_timeout controls segment switching, not push throughput`
    }
    return `The selected target is inside timeline ${timeline}'s healthy unarchived tail: the .ready queue is empty, credentials are valid, and wal-g wal-push has no current work. PostgreSQL archives a 16 MiB WAL segment only after it closes; this is the archive-only RPO floor. archive_timeout can shorten the tail at the cost of padded segments`
  }

  function failRestore(reason: string): false {
    dr.restore.status = 'failed'
    dr.restore.failureReason = reason
    dr.restore.resultMessage = ''
    toast(reason, 'warn', 7000)
    return false
  }

  function restoreTargetTimeline(backupTimeline: number): number {
    if (dr.restore.recoveryTargetTimeline === 'current') return backupTimeline
    if (
      ha.timeline.forkLsn > 0
      && backupTimeline === ha.timeline.parent
      && dr.archive.historyFileArchived
    ) return ha.timeline.current
    return backupTimeline
  }

  function archivedThroughForTimeline(timeline: number): number {
    if (timeline === dr.archive.timeline) return dr.archive.archivedThroughLsn
    if (timeline === dr.archive.parentTimeline) return dr.archive.parentArchivedThroughLsn
    return 0
  }

  function archiveHasLsn(timeline: number, lsn: number): boolean {
    return archivedThroughForTimeline(timeline) >= lsn
  }

  function forkSegmentStartLsn(): number {
    return Math.floor(ha.timeline.forkLsn / WAL_SEG) * WAL_SEG
  }

  function forkSegmentCopyArchived(): boolean {
    return ha.timeline.forkLsn > 0
      && dr.archive.timeline === ha.timeline.current
      && dr.archive.archivedThroughLsn >= forkSegmentStartLsn() + WAL_SEG
  }

  function restoreFollowsForkHistory(): boolean {
    const restore = dr.restore
    return restore.targetTimeline === ha.timeline.current
      && restore.backupTimeline === ha.timeline.parent
      && dr.archive.historyFileArchived
  }

  function parentArchivedThroughForRestore(): number {
    const parentEnd = dr.archive.parentArchivedThroughLsn
    /* The copied file closes only the parent tail in the fork segment; it
     * cannot bridge an earlier complete segment missing from object storage. */
    if (
      parentEnd >= ha.timeline.forkLsn
      || !restoreFollowsForkHistory()
      || parentEnd < forkSegmentStartLsn()
      || !forkSegmentCopyArchived()
    ) return parentEnd
    return ha.timeline.forkLsn
  }

  function archivedThroughForRestoreTimeline(timeline: number): number {
    return timeline === dr.restore.backupTimeline && restoreFollowsForkHistory()
      ? parentArchivedThroughForRestore()
      : archivedThroughForTimeline(timeline)
  }

  function firstCrossingCommitLsn(
    targetTime: number,
    timeline: number,
    afterLsn: number,
    throughLsn: number,
  ): number {
    let first = Number.POSITIVE_INFINITY
    for (let i = 0; i < recoveryCommitSlots; i++) {
      const slot = (
        recoveryCommitHead - 1 - i + COMMIT_HISTORY_SLOTS
      ) % COMMIT_HISTORY_SLOTS
      const lsn = recoveryCommitLsn[slot]
      if (
        recoveryCommitTimeline[slot] === timeline
        && lsn > afterLsn
        && lsn <= throughLsn
        && recoveryCommitAt[slot] >= targetTime
      ) first = Math.min(first, lsn)
    }
    return Number.isFinite(first) ? first : 0
  }

  function refreshLastReachedCommit(replayEndLsn: number): void {
    const restore = dr.restore
    const parentFrontier = parentArchivedThroughForRestore()
    const parentComplete = !restore.crossesTimelineFork
      || parentFrontier >= ha.timeline.forkLsn
    restore.lastReachedTime = 0
    restore.lastReachedTimeline = 0
    for (let i = 0; i < recoveryCommitSlots; i++) {
      const slot = (
        recoveryCommitHead - 1 - i + COMMIT_HISTORY_SLOTS
      ) % COMMIT_HISTORY_SLOTS
      const timeline = recoveryCommitTimeline[slot]
      const lsn = recoveryCommitLsn[slot]
      let reached = false
      if (restore.crossesTimelineFork) {
        reached = timeline === restore.backupTimeline
          && lsn <= Math.min(ha.timeline.forkLsn, parentFrontier, replayEndLsn)
        if (!reached && parentComplete && timeline === restoreReplayTimeline) {
          reached = lsn >= ha.timeline.forkLsn
            && lsn <= Math.min(
              replayEndLsn,
              archivedThroughForRestoreTimeline(restoreReplayTimeline),
            )
        }
      } else if (timeline === restoreReplayTimeline) {
        reached = lsn <= Math.min(
          replayEndLsn,
          archivedThroughForRestoreTimeline(restoreReplayTimeline),
        )
      }
      if (reached && recoveryCommitAt[slot] > restore.lastReachedTime) {
        restore.lastReachedTime = recoveryCommitAt[slot]
        restore.lastReachedTimeline = timeline
      }
    }
  }

  function availableWalRangeBytes(
    timeline: number,
    startLsn: number,
    endLsn: number,
  ): number {
    return Math.max(
      0,
      Math.min(endLsn, archivedThroughForRestoreTimeline(timeline)) - startLsn,
    )
  }

  function liveRestoreWalBytesAvailable(
    selected: (typeof dr.backups)[number],
    replayEndLsn: number,
  ): number {
    const restore = dr.restore
    let available = 0
    for (let i = 0; i < selected.walRanges.length; i++) {
      const range = selected.walRanges[i]
      const rangeEnd = Math.min(range.endLsn, replayEndLsn)
      if (rangeEnd <= range.startLsn) continue
      const required = rangeEnd - range.startLsn
      const rangeAvailable = availableWalRangeBytes(
        range.timeline,
        range.startLsn,
        rangeEnd,
      )
      available += rangeAvailable
      if (rangeAvailable < required || replayEndLsn <= range.endLsn) {
        return Math.min(restore.walBytesRequired, available)
      }
    }

    const finalRange = selected.walRanges[selected.walRanges.length - 1]
    if (!finalRange || replayEndLsn <= finalRange.endLsn) {
      return Math.min(restore.walBytesRequired, available)
    }
    if (finalRange.timeline === restoreReplayTimeline) {
      available += availableWalRangeBytes(
        finalRange.timeline,
        finalRange.endLsn,
        replayEndLsn,
      )
      return Math.min(restore.walBytesRequired, available)
    }

    const parentEnd = Math.min(replayEndLsn, ha.timeline.forkLsn)
    const parentRequired = Math.max(0, parentEnd - finalRange.endLsn)
    const parentAvailable = availableWalRangeBytes(
      finalRange.timeline,
      finalRange.endLsn,
      parentEnd,
    )
    available += parentAvailable
    if (parentAvailable < parentRequired || replayEndLsn <= ha.timeline.forkLsn) {
      return Math.min(restore.walBytesRequired, available)
    }
    available += availableWalRangeBytes(
      restoreReplayTimeline,
      ha.timeline.forkLsn,
      replayEndLsn,
    )
    return Math.min(restore.walBytesRequired, available)
  }

  function refreshRestorePlan(
    selected: (typeof dr.backups)[number],
    discoverTimeline: boolean,
  ): void {
    const restore = dr.restore
    if (discoverTimeline || !restoreTimelineLocked) {
      restore.targetTimeline = restoreTargetTimeline(selected.startTimeline)
    }

    let targetRecordTimeline = restore.targetTimeline
    let targetRecordLsn = 0
    if (
      restore.targetTimeline === ha.timeline.current
      && selected.startTimeline === ha.timeline.parent
    ) {
      targetRecordLsn = firstCrossingCommitLsn(
        restore.targetTime,
        selected.startTimeline,
        selected.startLsn,
        ha.timeline.forkLsn,
      )
      if (targetRecordLsn > 0) {
        targetRecordTimeline = selected.startTimeline
      } else {
        targetRecordLsn = firstCrossingCommitLsn(
          restore.targetTime,
          restore.targetTimeline,
          ha.timeline.forkLsn - 1,
          Number.POSITIVE_INFINITY,
        )
      }
    } else {
      targetRecordLsn = firstCrossingCommitLsn(
        restore.targetTime,
        restore.targetTimeline,
        selected.startLsn,
        Number.POSITIVE_INFINITY,
      )
    }

    restore.targetRecordLsn = targetRecordLsn
    restore.targetLsn = targetRecordLsn
    restoreReplayTimeline = targetRecordLsn > 0
      ? targetRecordTimeline
      : restore.targetTimeline
    const replayEndLsn = targetRecordLsn > 0
      ? targetRecordLsn
      : Math.max(
          selected.startLsn,
          archivedThroughForTimeline(restoreReplayTimeline),
        )
    restore.crossesTimelineFork = selected.startTimeline !== restoreReplayTimeline
      && replayEndLsn >= ha.timeline.forkLsn
    restore.historyFileName = restore.crossesTimelineFork
      ? dr.archive.historyFileName
      : ''
    restore.followedHistoryFile = restore.crossesTimelineFork
    restore.parentReplayEndLsn = restore.crossesTimelineFork
      ? ha.timeline.forkLsn
      : restoreReplayTimeline === dr.archive.parentTimeline
        ? replayEndLsn
        : 0
    restore.walBytesRequired = Math.max(0, replayEndLsn - selected.startLsn)
    restore.walBytesAvailable = liveRestoreWalBytesAvailable(selected, replayEndLsn)
    refreshLastReachedCommit(replayEndLsn)
    restore.estimatedDurationSec =
      restore.backupBytesRequired / backupFetchBytesPerSec()
      + restore.walBytesRequired / walRecoveryBytesPerSec()
    restore.pendingWalFailureReason = ''
  }

  function restoreStartupFailureReason(
    selected: (typeof dr.backups)[number],
  ): string {
    const finalRange = selected.walRanges[selected.walRanges.length - 1]
    if (!finalRange) return ''
    const requestedTimeline = dr.restore.targetTimeline
    const containsMinimumRecoveryPoint = requestedTimeline === finalRange.timeline
      || (
        requestedTimeline === ha.timeline.current
        && finalRange.timeline === ha.timeline.parent
        && finalRange.endLsn <= ha.timeline.forkLsn
      )
    if (!containsMinimumRecoveryPoint) {
      return `Recovery startup failed: requested timeline ${requestedTimeline} does not contain backup ${selected.label}'s minimum recovery point ${fmtLsn(finalRange.endLsn)} on timeline ${finalRange.timeline}; that point is past the fork ${fmtLsn(ha.timeline.forkLsn)}`
    }
    return ''
  }

  function targetNotReachedReason(): string {
    const restore = dr.restore
    return restore.lastReachedTime > 0
      ? `Recovery target not reached: recovery ended before configured recovery target was reached. The last transaction-end record actually reached was at ${restore.lastReachedTime.toFixed(1)}s on timeline ${restore.lastReachedTimeline}, before the selected recovery_target_time ${restore.targetTime.toFixed(1)}s`
      : `Recovery target not reached: recovery ended before configured recovery target was reached. No transaction-end timestamp is present in the bounded modeled evidence before the selected recovery_target_time ${restore.targetTime.toFixed(1)}s`
  }

  function liveArchiveGapReason(): string {
    const restore = dr.restore
    const gapTimeline = restoreFollowsForkHistory()
      ? dr.archive.parentArchivedThroughLsn < forkSegmentStartLsn()
        ? restore.backupTimeline
        : restore.targetTimeline
      : restoreReplayTimeline
    return archiveGapReason(gapTimeline)
  }

  function completeRestore(): void {
    const restore = dr.restore
    restore.status = 'complete'
    restore.progress = 1
    restore.resultMessage = restore.crossesTimelineFork
      ? `PITR complete: recovery_target_timeline=${restore.recoveryTargetTimeline} followed ${restore.historyFileName} from timeline ${restore.backupTimeline} at ${fmtLsn(restore.parentReplayEndLsn)} to timeline ${restore.targetTimeline} and encountered the transaction-end record at ${fmtLsn(restore.targetRecordLsn)} that crossed recovery_target_time`
      : `PITR complete on timeline ${restoreReplayTimeline}: recovery_target_timeline=${restore.recoveryTargetTimeline} encountered the transaction-end record at ${fmtLsn(restore.targetRecordLsn)} that crossed recovery_target_time without crossing a fork`
    toast(restore.resultMessage, 'good', 7500)
  }

  function startPointInTimeRestore(targetAgeSec = K.recoveryTargetAge): boolean {
    if (
      dr.drill.status === 'restoring'
      || dr.drill.status === 'verifying'
      || dr.drill.status === 'querying'
    ) return false
    const targetTime = state.t - Math.max(0, targetAgeSec)
    resetRestore(targetTime)
    if (dr.backups.length === 0) {
      return failRestore('PITR impossible: no retained full backup exists; take and verify a base backup first')
    }
    if (targetTime < dr.oldestRecoverableTime) {
      return failRestore(
        earliestBackupCompletedAt > 0 && targetTime >= earliestBackupCompletedAt
          ? 'PITR impossible: retention expired the full backup that could have covered this target; increase the future wal-g delete retain FULL count before the window expires'
          : 'PITR impossible: no retained full backup was taken early enough to cover the selected target; changing retention cannot recover history that was never backed up',
      )
    }

    let selected: (typeof dr.backups)[number] | undefined
    for (let i = dr.backups.length - 1; i >= 0; i--) {
      const candidate = dr.backups[i]
      if (candidate.completedAt <= targetTime) {
        selected = candidate
        break
      }
    }
    if (!selected) {
      return failRestore('PITR impossible: no retained full backup completed before the selected recovery_target_time')
    }

    const restore = dr.restore
    restore.backupTimeline = selected.startTimeline
    restore.backupId = selected.id
    restore.backupAgeSec = Math.max(0, targetTime - selected.completedAt)
    restore.backupBytesRequired = selected.dataBytes
    refreshRestorePlan(selected, true)

    restore.status = 'fetching'
    toast(
      `PITR started from ${selected.label}: fetch the full backup, then replay archived WAL to recovery_target_time`,
      'info',
      6500,
    )
    return true
  }

  function startRestoreDrill(
    level: RestoreDrillLevel,
    targetAgeSec = K.recoveryTargetAge,
  ): boolean {
    const drill = dr.drill
    if (
      drill.status === 'restoring'
      || drill.status === 'verifying'
      || drill.status === 'querying'
      || dr.restore.status === 'fetching'
      || dr.restore.status === 'replaying'
    ) return false

    const targetTime = state.t - Math.max(0, targetAgeSec)
    resetDrill(level, targetTime)
    const started = startPointInTimeRestore(targetAgeSec)
    const restore = dr.restore
    drill.targetTime = restore.targetTime
    drill.backupId = restore.backupId
    drill.walBytesRequired = restore.walBytesRequired
    if (!started) {
      drill.status = 'failed'
      drill.failureReason = restore.failureReason
      return false
    }

    drill.estimatedRestoreToTargetSec = restore.estimatedDurationSec
    const selected = backupById(restore.backupId)
    if (selected) {
      drill.backupAgeSec = restore.backupAgeSec
      drill.backupObjectBytesRequired = selected.objectStoreBytes
      drill.manifestDigest = selected.manifestDigest
      drill.restoredDigest = selected.objectDigest
      drill.smokeTableMask = selected.smokeTableMask
    }
    drill.status = 'restoring'
    drill.checksumBytesRequired = level === 'verified' ? restore.backupBytesRequired : 0
    drill.smokeBytesRequired = smokeBytesForLevel(level)
    drill.validationBytesRequired = drill.checksumBytesRequired + drill.smokeBytesRequired
    drill.estimatedDurationSec =
      drill.estimatedRestoreToTargetSec
      + drill.checksumBytesRequired / DR_DRILL_VERIFY_BYTES_PER_SEC
      + drill.smokeBytesRequired / DR_DRILL_SMOKE_BYTES_PER_SEC
    toast(
      `${CLAIM_VALUES.restoreDrill.levels[level].label} drill started on the recovery ground — restore-to-target time is running`,
      'info',
      6500,
    )
    return true
  }

  function failRestoreDrill(reason: string): void {
    const drill = dr.drill
    drill.status = 'failed'
    drill.completedAt = state.t
    drill.failureReason = reason
    if (drill.measuredRestoreToTargetSec === 0) drill.estimatedRestoreToTargetSec = 0
    dr.restore.status = 'idle'
    toast(`Restore drill failed — ${reason}`, 'warn', 7500)
  }

  function completeRestoreDrill(): void {
    const drill = dr.drill
    drill.status = 'passed'
    drill.completedAt = state.t
    drill.progress = 1
    drill.failureReason = ''
    dr.restore.status = 'idle'
    toast(
      `Restore drill passed in ${drill.elapsedSec.toFixed(1)} model s — read the supported claim and its limits`,
      'good',
      7500,
    )
  }

  function tickRestoreDrill(dt: number): void {
    const drill = dr.drill
    if (
      drill.status !== 'restoring'
      && drill.status !== 'verifying'
      && drill.status !== 'querying'
    ) return

    drill.elapsedSec = Math.max(0, state.t - drill.startedAt)
    drill.progress = drill.estimatedDurationSec > 0
      ? Math.min(1, drill.elapsedSec / drill.estimatedDurationSec)
      : 0
    if (drill.status === 'restoring') {
      const restore = dr.restore
      drill.walBytesRequired = restore.walBytesRequired
      drill.estimatedRestoreToTargetSec = restore.estimatedDurationSec
      drill.estimatedDurationSec =
        drill.estimatedRestoreToTargetSec
        + drill.checksumBytesRequired / DR_DRILL_VERIFY_BYTES_PER_SEC
        + drill.smokeBytesRequired / DR_DRILL_SMOKE_BYTES_PER_SEC
      const backupReadFraction = restore.backupBytesRequired > 0
        ? Math.min(1, restore.backupBytesFetched / restore.backupBytesRequired)
        : 0
      drill.objectStoreBytesRead =
        drill.backupObjectBytesRequired * backupReadFraction + restore.walBytesReplayed
      if (restore.status === 'failed') {
        failRestoreDrill(restore.failureReason)
      } else if (restore.status === 'complete') {
        drill.objectStoreBytesRead = drill.backupObjectBytesRequired + restore.walBytesRequired
        drill.measuredRestoreToTargetSec = restore.elapsedSec
        drill.status = drill.checksumBytesRequired > 0 ? 'verifying' : 'querying'
      }
    } else if (drill.status === 'verifying') {
      drill.checksumBytesRead = Math.min(
        drill.checksumBytesRequired,
        drill.checksumBytesRead + DR_DRILL_VERIFY_BYTES_PER_SEC * dt,
      )
      if (drill.checksumBytesRead >= drill.checksumBytesRequired) {
        if (drill.restoredDigest !== drill.manifestDigest) {
          failRestoreDrill('the restored object digest does not match the backup manifest')
        } else {
          drill.status = 'querying'
        }
      }
    } else {
      drill.smokeBytesRead = Math.min(
        drill.smokeBytesRequired,
        drill.smokeBytesRead + DR_DRILL_SMOKE_BYTES_PER_SEC * dt,
      )
      if (drill.smokeBytesRead >= drill.smokeBytesRequired) {
        const expectedMask = drill.level === 'table' ? 1 : (1 << N_TABLES) - 1
        if ((drill.smokeTableMask & expectedMask) !== expectedMask) {
          let missing = 0
          while (missing < N_TABLES && (drill.smokeTableMask & (1 << missing)) !== 0) missing++
          failRestoreDrill(
            `the restored ${tables[missing]?.def.name ?? 'selected'} table is empty; its smoke query found no row witness`,
          )
        } else {
          completeRestoreDrill()
        }
      }
    }

    drill.validationBytesRead = drill.checksumBytesRead + drill.smokeBytesRead
  }

  function tickDisasterRecovery(dt: number): void {
    dr.dataDirectoryBytes = dataDirectoryBytes()
    if (scheduledBackups) tickBackupSchedule()

    const backup = dr.backup
    if (backup.status === 'copying') {
      const sourceNode = state.cluster.nodes[1]
      if (!sourceNode.online) {
        failBaseBackup('Full backup failed: standby_a went offline while WAL-G was reading its data directory')
      } else {
        backup.copiedBytes = Math.min(
          backup.dataBytes,
          backup.copiedBytes + DR_BACKUP_BYTES_PER_SEC * dt,
        )
        backup.progress = backup.dataBytes > 0 ? backup.copiedBytes / backup.dataBytes : 1
        if (backup.copiedBytes >= backup.dataBytes) {
          if (ha.currentLeader === 'standbyA') {
            failBaseBackup('Full backup failed: standby_a was promoted during the online backup, so pg_backup_stop cannot finish it')
          } else {
            // Backup stop on standby_a cannot switch the current primary's WAL.
            backup.stopLsn = rep.standbys[0].appliedLsn
            backup.stopTimeline = ha.timeline.current
            if (backupWalRangesArchived()) {
              completeBaseBackup()
            } else backup.status = 'waiting_wal'
          }
        }
      }
    } else if (backup.status === 'waiting_wal') {
      backup.progress = 1
      if (
        backup.stopTimeline === backup.startTimeline
        && dr.archive.timeline !== backup.startTimeline
      ) {
        failBaseBackup(
          `Full backup failed: archive recovery moved from timeline ${backup.startTimeline} to timeline ${dr.archive.timeline} before the backup stop WAL reached timeline ${backup.startTimeline}'s archive`,
        )
      } else if (backupWalRangesArchived()) {
        completeBaseBackup()
      }
    }

    const restore = dr.restore
    if (restore.status === 'fetching' || restore.status === 'replaying') {
      const selected = backupById(restore.backupId)
      if (!selected) {
        failRestore(
          restore.status === 'fetching'
            ? 'The selected full backup expired from retention before the restore reached its target'
            : 'Archived WAL needed to finish replay expired from retention before the restore reached its target',
        )
      } else {
        restore.elapsedSec += dt
        if (restore.status === 'fetching') {
          restore.backupBytesFetched = Math.min(
            restore.backupBytesRequired,
            restore.backupBytesFetched + backupFetchBytesPerSec() * dt,
          )
          if (restore.backupBytesFetched >= restore.backupBytesRequired) {
            refreshRestorePlan(selected, true)
            restoreTimelineLocked = true
            restore.pendingStartupFailureReason = restoreStartupFailureReason(selected)
            if (restore.pendingStartupFailureReason) {
              failRestore(restore.pendingStartupFailureReason)
            } else if (restore.walBytesRequired > 0) restore.status = 'replaying'
            else if (restore.targetRecordLsn > 0) completeRestore()
            else failRestore(targetNotReachedReason())
          }
        }
        if (restore.status === 'replaying') {
          refreshRestorePlan(selected, false)
          const replayLimit = Math.min(
            restore.walBytesRequired,
            restore.walBytesAvailable,
          )
          restore.walBytesReplayed = Math.min(
            replayLimit,
            restore.walBytesReplayed + walRecoveryBytesPerSec() * dt,
          )
          if (restore.walBytesReplayed >= replayLimit) {
            if (restore.targetRecordLsn <= 0) {
              restore.pendingWalFailureReason = targetNotReachedReason()
              failRestore(restore.pendingWalFailureReason)
            } else if (restore.walBytesAvailable < restore.walBytesRequired) {
              restore.pendingWalFailureReason = liveArchiveGapReason()
              failRestore(restore.pendingWalFailureReason)
            } else completeRestore()
          }
        }
        restore.progress = restore.resultMessage.length > 0
          ? 1
          : restore.estimatedDurationSec > 0
            ? Math.min(1, restore.elapsedSec / restore.estimatedDurationSec)
            : 1
      }
    }
    tickRestoreDrill(dt)
  }

  /* ======================================================================
   * CHECKPOINTS
   * ====================================================================*/

  function startCheckpoint(reason: 'time' | 'wal' | 'manual'): void {
    ckpt.phase = 'start'
    ckpt.reason = reason
    ckpt.elapsed = 0
    ckpt.progress = 0
    ckpt.buffersWritten = asSampleFrames(0)
    ckpt.nextInSec = K.checkpointTimeout
    ckptRecordTicket = 0
    if (reason !== 'time') ckpt.numRequested++
    // RedoRecPtr: where replay would restart if we crashed once this checkpoint
    // has completed. `completedRedoLsn` — what pg_control still says, and what
    // WAL retention is measured from — does not move until then.
    ckpt.redoLsn = wal.insertLsn
    // BufferSync(): tag the dirty set as it stands at the redo point. This IS
    // the checkpoint's obligation; nothing dirtied after this line belongs to it.
    let n = 0
    for (let b = 0; b < buf.sampleFrames; b++) {
      if (buf.dirty[b]) {
        ckptNeeded[b] = 1
        n++
      } else ckptNeeded[b] = 0
    }
    for (let b = buf.sampleFrames; b < N_BUFFERS; b++) ckptNeeded[b] = 0
    ckpt.buffersToWrite = n
    // Every page now owes a full-page image on its next modification.
    fpiGeneration++
    wal.fpwBurst = K.fullPageWrites ? 1 : 0
    // One forward-only lap over the pool, so the pass visits every tagged buffer
    // exactly once and then stops.
    ckptScan = 0
    bus.emit('checkpoint:start', { reason })
    if (reason === 'wal') {
      toast('Checkpoint triggered by max_wal_size — not by the timer', 'warn', 5000)
    }
  }

  let ckptWriteEnd = 0
  let ckptSyncDur = 1.5
  let ckptSyncEnd = 0
  let ckptRecordTicket = 0
  let lastCheckpointEndLsn = wal.insertLsn
  /** The checkpointer has its own cursor: it sweeps the pool exactly once. */
  let ckptScan = 0
  let checkpointFlushBuffer = -1
  let checkpointFlushLsn = 0

  function releaseCheckpointFlushBuffer(): void {
    if (checkpointFlushBuffer >= 0) {
      buf.pinned[checkpointFlushBuffer] = 0
      if (evictionOwner[checkpointFlushBuffer] === 254) {
        evictionOwner[checkpointFlushBuffer] = 0
      }
    }
    checkpointFlushBuffer = -1
    checkpointFlushLsn = 0
  }

  function tickCheckpoint(dt: number): void {
    ckpt.elapsed += ckpt.phase === 'idle' ? 0 : dt
    // checkpointer.c schedules START-to-start: CheckpointerMain() computes
    // elapsed_secs = now - last_checkpoint_time, and last_checkpoint_time is
    // stamped when the checkpoint BEGINS. Running the countdown only while idle
    // made the period checkpoint_timeout + duration — 68 s at
    // completion_target = 0.1 and 122 s at 1.0 against a fixed 60 s timeout,
    // i.e. completion_target changed checkpoint FREQUENCY. It spreads the
    // writes; it must never move the schedule.
    ckpt.nextInSec -= dt

    if (ckpt.phase === 'idle') {
      const walSinceRedo = wal.insertLsn - ckpt.redoLsn
      if (walSinceRedo > walTriggerBytes(K)) startCheckpoint('wal')
      else if (ckpt.nextInSec <= 0) {
        ckpt.numTimed++
        ckpt.nextInSec = K.checkpointTimeout
        // A timeout is recorded even when there has been no WAL activity
        // since the last checkpoint; in that case PostgreSQL skips the run.
        if (wal.insertLsn > lastCheckpointEndLsn) startCheckpoint('time')
      }
      return
    }

    if (ckpt.phase === 'start') {
      if (ckpt.elapsed > 0.35) {
        ckpt.phase = 'writing'
      }
      return
    }

    if (ckpt.phase === 'writing') {
      if (checkpointFlushBuffer >= 0) {
        const pending = checkpointFlushBuffer
        if (!buf.valid[pending] || !buf.dirty[pending]) {
          releaseCheckpointFlushBuffer()
          ckpt.buffersWritten++
        } else if (pageLsnOwners[pending] !== 0) {
          return
        } else {
          checkpointFlushLsn = buf.pageLsn[pending]
          if (wal.flushLsn < checkpointFlushLsn) {
            requestFlush(checkpointFlushLsn)
            return
          }
          writeOut(pending, 'checkpointer')
          if (++sCkpt >= stride(1 / Math.max(dt, 1 / 120), 26)) {
            sCkpt = 0
            flow('ckpt.sweep', 1, 'page_write', 1.25)
            flow(
              rid.ioWrite(buf.rel[pending] < N_TABLES ? buf.rel[pending] : 0),
              1,
              'page_write',
              1.1,
            )
          }
          releaseCheckpointFlushBuffer()
          ckpt.buffersWritten++
        }
      }
      // IsCheckpointOnSchedule(): both the WAL and time criteria are sampled
      // continuously. A workload change during the write phase therefore moves
      // the pace immediately instead of being frozen into one rate captured at
      // checkpoint start.
      // buffersWritten tracks only the write pass, while the completion target
      // applies to the whole checkpoint. Reserve the modelled sync/control-file
      // tail so target=1.0 still completes on the start-to-start deadline rather
      // than slipping the next checkpoint by that tail on every cycle.
      const completionReserve =
        clamp(0.5 + ckpt.buffersToWrite / 420, 0.5, 4) + 0.45
      const elapsedXlogs =
        (wal.insertLsn - ckpt.redoLsn + wal.bytesPerSec * completionReserve)
        / Math.max(1, walTriggerBytes(K))
      const elapsedTime =
        (ckpt.elapsed + completionReserve) / Math.max(1, K.checkpointTimeout)
      const sched = Math.max(elapsedXlogs, elapsedTime)
      const target = Math.max(0.01, K.checkpointCompletionTarget)
      const desired = Math.min(
        ckpt.buffersToWrite,
        Math.ceil(clamp01(sched / target) * ckpt.buffersToWrite),
      )
      let n = Math.max(0, desired - ckpt.buffersWritten)
      const flowStride = stride(n / Math.max(dt, 1 / 120), 26)
      while (n-- > 0 && ckpt.buffersWritten < ckpt.buffersToWrite) {
        // ONE forward-only pass over the tagged set — the buffers that were
        // dirty at the redo point, and only those. The old code searched
        // circularly for "whatever is dirty now", which lapped repeatedly: it
        // wrote pages first dirtied AFTER the redo point while pages from the
        // snapshot survived the checkpoint unwritten, which is precisely the
        // durability contract redoLsn depends on.
        let found = -1
        while (ckptScan < buf.sampleFrames) {
          const b = ckptScan++
          if (ckptNeeded[b]) {
            found = b
            break
          }
        }
        if (found < 0) {
          // Lap complete: every tagged buffer has been visited. (Only reachable
          // if the pool shrank underneath us.)
          ckpt.buffersWritten = asSampleFrames(ckpt.buffersToWrite)
          break
        }
        // BufferSync()'s num_processed. A tagged buffer someone else already
        // cleaned still counts as processed and does not count as written —
        // that split is what makes buffers_checkpoint smaller than the dirty
        // count when the bgwriter is doing its job.
        if (!buf.dirty[found]) {
          ckptNeeded[found] = 0
          ckpt.buffersWritten++
          continue
        }
        if (!pageWalDurable(found)) {
          if (evictionOwner[found] !== 0) {
            ckptScan--
            break
          }
          ckptNeeded[found] = 0
          checkpointFlushBuffer = found
          checkpointFlushLsn = buf.pageLsn[found]
          buf.pinned[found] = 1
          pinT[found] = state.t
          evictionOwner[found] = 254
          requestPageWalFlush(found)
          break
        }
        ckptNeeded[found] = 0
        ckpt.buffersWritten++
        writeOut(found, 'checkpointer')
        if (++sCkpt >= flowStride) {
          sCkpt = 0
          flow('ckpt.sweep', 1, 'page_write', 1.25)
          flow(rid.ioWrite(buf.rel[found] < N_TABLES ? buf.rel[found] : 0), 1, 'page_write', 1.1)
        }
      }
      ckpt.progress = ckpt.buffersToWrite > 0 ? clamp01(ckpt.buffersWritten / ckpt.buffersToWrite) : 1
      if (ckpt.progress >= 1) {
        ckpt.phase = 'syncing'
        ckptSyncDur = clamp(0.5 + ckpt.buffersWritten / 420, 0.5, 4)
        ckptWriteEnd = ckpt.elapsed
        ckptSyncEnd = ckptWriteEnd + ckptSyncDur
        ckpt.progress = 1
      }
      return
    }

    if (ckpt.phase === 'syncing') {
      // The fsync burst. Every file the checkpoint touched is flushed now, and
      // this is where a checkpoint actually hurts on a busy machine.
      flow('ckpt.fsync', 1, 'page_write', 1.3)
      if (ckpt.elapsed > ckptSyncEnd) ckpt.phase = 'finishing'
      return
    }

    // finishing: write the checkpoint record, update pg_control, and only THEN
    // recycle the WAL below the redo point
    if (ckpt.elapsed > ckptSyncEnd + 0.4) {
      if (ckptRecordTicket === 0) {
        // Append the checkpoint record to the ordered maintenance stream.
        // Vacuum records generated later queue behind it instead of starving
        // checkpoint completion.
        queueMaintenanceWal(140)
        ckptRecordTicket = maintenanceWalQueued
      }
      // Page-record estimates are fractional before walInsert rounds them to
      // byte LSNs, so allow sub-byte accumulator residue at the ticket.
      if (maintenanceWalDrained + 1 < ckptRecordTicket) return
      // ControlFile->checkPointCopy = checkPoint, then RemoveOldXlogFiles().
      // ckpt.redoLsn, NOT wal.insertLsn: recovery restarts at the redo point
      // this checkpoint stamped when it began, so what pg_wal must keep is
      // everything since then — including every byte the checkpoint itself
      // produced while it ran. Assigning insertLsn here would zero retention at
      // completion instead of at start: right phase, wrong magnitude.
      ckpt.completedRedoLsn = ckpt.redoLsn
      ckpt.lastDuration = ckpt.elapsed
      ckpt.numDone++
      ckpt.count++
      lastCheckpointEndLsn = wal.insertLsn
      ckpt.phase = 'idle'
      ckpt.progress = 0
      bus.emit('checkpoint:end', { duration: ckpt.lastDuration })
    }
  }

  /* ======================================================================
   * BGWRITER
   *
   * The bgwriter cleans ahead of the clock hand so pages a backend is about to
   * reuse are already clean. Its persistent cursor also makes enough progress
   * to lap an otherwise idle pool every two minutes. Hot dirty pages stay dirty
   * until their usage count falls or the checkpoint writes them.
   * ====================================================================*/

  function tickBgwriter(dt: number): void {
    bgw.enabled = K.bgwriterEnabled
    let resumedCleaned = 0
    if (!bgw.enabled) {
      if (bgwriterFlushBuffer >= 0) {
        buf.pinned[bgwriterFlushBuffer] = 0
        evictionOwner[bgwriterFlushBuffer] = 0
        bgwriterFlushBuffer = -1
        bgwriterFlushLsn = 0
      }
      bgw.activity = damp(bgw.activity, 0, 4, dt)
      bgw.cleanedPerSec = damp(bgw.cleanedPerSec, 0, 2, dt)
      bgwriterAllocations = 0
      bgwriterAllocationEstimate = 0
      bgwriterScanRemainder = 0
      bgwriterCursorValid = false
      return
    }
    if (bgwriterFlushBuffer >= 0) {
      const pending = bgwriterFlushBuffer
      if (!buf.valid[pending] || !buf.dirty[pending]) {
        buf.pinned[pending] = 0
        evictionOwner[pending] = 0
        bgwriterFlushBuffer = -1
        bgwriterFlushLsn = 0
      } else if (pageLsnOwners[pending] !== 0) {
        bgw.activity = damp(bgw.activity, 1, 6, dt)
        return
      } else if (!pageWalDurable(pending)) {
        bgwriterFlushLsn = buf.pageLsn[pending]
        requestFlush(bgwriterFlushLsn)
        bgw.activity = damp(bgw.activity, 1, 6, dt)
        return
      } else {
        writeOut(pending, 'bgwriter')
        buf.pinned[pending] = 0
        evictionOwner[pending] = 0
        bgwriterFlushBuffer = -1
        bgwriterFlushLsn = 0
        resumedCleaned = 1
        // XLogFlush returned; resume the same BgBufferSync round immediately.
        bgwT = BGW_DELAY
      }
    }
    bgwT += dt
    if (bgwT < BGW_DELAY) return
    bgwT = 0

    let cleaned = resumedCleaned
    if (resumedCleaned > 0 && ++sBgw >= stride(1 / BGW_DELAY, 16)) {
      sBgw = 0
      flow('bgw.sweep', 1, 'page_write', 1.1)
    }

    // BgBufferSync sizes its scan from recent buffer allocations, not physical
    // reads. Keep the estimate in representative frames and apply PostgreSQL's
    // default bgwriter_lru_multiplier of 2.0.
    const recentAllocations = bgwriterAllocations
    bgwriterAllocations = 0
    bgwriterAllocationEstimate = Math.max(
      recentAllocations,
      damp(bgwriterAllocationEstimate, recentAllocations, 1.5, BGW_DELAY),
    )
    const cursorBehindClock =
      bgwriterScanPasses < clockSweepPasses
      || (
        bgwriterScanPasses === clockSweepPasses
        && bgw.scanPos < buf.clockHand
      )
    // BgBufferSync skips next_to_clean to the strategy point only when its
    // persistent cursor has fallen behind; an idle cursor is never re-anchored.
    if (!bgwriterCursorValid || cursorBehindClock) {
      bgw.scanPos = buf.clockHand
      bgwriterScanPasses = clockSweepPasses
      bgwriterCursorValid = true
    }
    // BgBufferSync retains next_to_clean across rounds. Its minimum scan rate
    // covers NBuffers in 120 seconds even when allocation activity is zero.
    // Carry the fractional representative frame so the fixed sample preserves
    // that horizon at every shared_buffers setting.
    const idleScanBudget =
      bgwriterScanRemainder
      + (buf.sampleFrames * BGW_DELAY) / BGW_SCAN_WHOLE_POOL_SECONDS
    const minimumScan = Math.floor(idleScanBudget)
    bgwriterScanRemainder = idleScanBudget - minimumScan
    const requestedLookahead = clamp(
      Math.max(Math.round(bgwriterAllocationEstimate * 2), minimumScan),
      0,
      buf.sampleFrames,
    )
    // next_to_clean may get at most one pass ahead of the strategy point.
    // BgBufferSync calls this remaining distance bufs_to_lap.
    const buffersToLap = Math.max(
      0,
      (clockSweepPasses + 1) * buf.sampleFrames
        + buf.clockHand
        - (bgwriterScanPasses * buf.sampleFrames + bgw.scanPos),
    )
    const lookahead = Math.min(requestedLookahead, buffersToLap)
    // cleanedTotal counts representative frames. Project the real-page GUC
    // onto that sample so 100 and 400 do not both exceed a 64-frame plaza.
    const cleanLimit = K.bgwriterLruMaxpages <= 0
      ? 0
      : Math.max(1, Math.ceil((K.bgwriterLruMaxpages * buf.sampleFrames) / N_BUFFERS))
    let scanned = 0
    while (scanned < lookahead && cleaned < cleanLimit) {
      const b = bgw.scanPos
      if (bgw.scanPos + 1 >= buf.sampleFrames) {
        bgw.scanPos = 0
        bgwriterScanPasses++
      } else {
        bgw.scanPos++
      }
      scanned++
      // only frames that are about to be handed out: usage 0, unpinned
      if (buf.dirty[b] && buf.usage[b] === 0 && !buf.pinned[b]) {
        if (!pageWalDurable(b)) {
          bgwriterFlushBuffer = b
          bgwriterFlushLsn = buf.pageLsn[b]
          buf.pinned[b] = 1
          pinT[b] = state.t
          evictionOwner[b] = 255
          requestPageWalFlush(b)
          break
        }
        writeOut(b, 'bgwriter')
        cleaned++
        if (++sBgw >= stride(cleaned / BGW_DELAY, 16)) {
          sBgw = 0
          flow('bgw.sweep', 1, 'page_write', 1.1)
        }
      }
    }
    bgw.cleanedTotal = asSampleFrames(bgw.cleanedTotal + cleaned)
    cleanedAcc += cleaned
    bgw.activity = damp(bgw.activity, clamp01(cleaned / Math.max(1, cleanLimit)), 6, BGW_DELAY)
  }

  /* ======================================================================
   * TABLES, MVCC AND DEAD TUPLES
   * ====================================================================*/

  function addDead(ti: number, n: number): void {
    const t = tables[ti]
    t.deadTuples += n
    // Tuples deleted after the horizon froze are NOT removable: vacuum can see
    // them, but it may not touch them, because that ancient snapshot might
    // still need to read them.
    if (!horizonFrozen) deadRemovable[ti] += n
  }

  function extendIfNeeded(ti: number): void {
    const t = tables[ti]
    const cap = t.pages * t.def.tuplesPerPage
    const used = t.liveTuples + t.deadTuples
    if (used > cap) {
      // Relation extension — this *is* bloat when the dead tuples are the cause.
      t.pages += Math.ceil((used - cap) / t.def.tuplesPerPage) + 1
    }
  }

  function tickTables(dt: number): void {
    let defW = 0
    let wSum = 0
    for (let i = 0; i < N_TABLES; i++) {
      const t = tables[i]
      t.heat = damp(t.heat, 0, 1.1, dt)
      t.vacuumThreshold = Math.min(
        AUTOVACUUM_VACUUM_MAX_THRESHOLD,
        AUTOVACUUM_VACUUM_THRESHOLD + K.autovacuumScaleFactor * t.reltuples,
      )
      // autovacuum.c relation_needs_vacanalyze: insert-triggered vacuum scales
      // only with the unfrozen share. That makes append-only relations get a
      // cheap VM/freeze pass even though they never manufacture dead tuples.
      const unfrozen = t.pages > 0 ? clamp01((t.pages - frozenPages[i]) / t.pages) : 1
      vacuumInsThreshold[i] = AUTOVACUUM_VACUUM_INSERT_THRESHOLD
        + K.autovacuumScaleFactor * t.reltuples * unfrozen
      const rt = runtimeTable(i)
      rt.insSinceVacuum = insSinceVacuum[i]
      rt.frozenPages = frozenPages[i]
      rt.vacuumInsThreshold = vacuumInsThreshold[i]
      const total = t.liveTuples + t.deadTuples
      t.bloat = total > 0 ? t.deadTuples / total : 0
      if (deadRemovable[i] > t.deadTuples) deadRemovable[i] = t.deadTuples
      // Steady-state workload: rows deleted from a table are replaced by new
      // ones, so live counts hover around the relation's natural size instead
      // of draining away. Without this, `bloat` would measure a vanishing
      // table rather than accumulating dead versions.
      const deficit = clamp01((naturalLive[i] - t.liveTuples) / naturalLive[i])
      wIns[i] = TABLES[i].weight * (TABLES[i].id === 'events' ? 2.4 : 1) * (1 + 3 * deficit)
      // Weighted by how often this table is the target of an update or delete,
      // so the feedback tracks the relations that are actually draining.
      defW += deficit * wUpd[i]
      wSum += wUpd[i]
    }
    // The deficit above only decides *which* table receives an insert. This
    // decides *how many* statements are inserts at all: an update-heavy
    // workload deletes far more rows than it inserts, and without this the
    // bloat scenarios empty their tables inside ninety seconds, so the bloat
    // bar ends up measuring an empty relation instead of dead versions in a
    // live one. Full response by a 15% shortfall; no effect at all once the
    // tables are at their natural size, so a healthy workload is untouched.
    liveDeficit = wSum > 0 ? clamp01(defW / wSum / 0.15) : 0
  }

  /* ======================================================================
   * AUTOVACUUM
   * ====================================================================*/

  const vacPhaseT: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacPhaseDur: number[] = new Array(N_VAC_WORKERS).fill(1)
  const vacIdxLeft: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacTarget: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacIndexTarget: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacHeapModified: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacHeapHotModified: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacHeapWarmModified: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacIndexPageTouches: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacScanModified: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacFpiGeneration: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacPageAcc: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacPageCursor: number[] = new Array(N_VAC_WORKERS).fill(0)
  const vacActiveShare: number[] = new Array(N_VAC_WORKERS).fill(1)
  const vacWorkCredit: number[] = new Array(N_VAC_WORKERS).fill(0)

  function vacNext(w: VacWorker, phase: VacPhase, dur: number): void {
    w.phase = phase
    w.progress = 0
    w.vacuumDelay = false
    vacPhaseT[w.slot] = 0
    vacPhaseDur[w.slot] = Math.max(0.05, dur)
    vacPageAcc[w.slot] = 0
    vacPageCursor[w.slot] = 0
    vacActiveShare[w.slot] = 1
    vacWorkCredit[w.slot] = 0
  }

  function vacNextPaced(
    w: VacWorker,
    phase: VacPhase,
    readPages: number,
    writePages: number,
    unthrottledDuration: number,
  ): void {
    vacNext(w, phase, unthrottledDuration)
    const workDuration = vacPhaseDur[w.slot]
    const pacedDuration = Math.max(
      workDuration,
      (readPages + writePages) / VACUUM_PAGES_PER_WORKER_SEC,
    )
    vacActiveShare[w.slot] = workDuration / pacedDuration
  }

  /**
   * Estimate distinct pages drawn from a bounded set. Vacuum uses this for
   * index traffic; heap traffic is split into hot, warm and cold bands below.
   */
  function affectedVacuumPages(
    pages: number,
    changes: number,
    hotSet: number,
    hotShare: number,
  ): number {
    if (pages <= 0 || changes <= 0) return 0
    const hotN = Math.min(pages, Math.max(1, hotSet))
    const coldN = Math.max(0, pages - hotN)
    const hotTouched = hotN * (1 - Math.exp(-(changes * hotShare) / hotN))
    const coldTouched = coldN > 0
      ? coldN * (1 - Math.exp(-(changes * (1 - hotShare)) / coldN))
      : 0
    return Math.min(pages, Math.round(hotTouched + coldTouched))
  }

  function distinctPagesTouched(pages: number, draws: number): number {
    if (pages <= 0 || draws <= 0) return 0
    return Math.min(pages, Math.round(pages * (1 - Math.exp(-draws / pages))))
  }

  function launchVacuum(): void {
    const candidates: { table: number; score: number }[] = []
    for (let i = 0; i < N_TABLES; i++) {
      const t = tables[i]
      if (t.vacuuming || !t.autovacuumEnabled) continue
      const sVac = t.deadTuples / Math.max(1, t.vacuumThreshold)
      const sIns = insSinceVacuum[i] / Math.max(1, vacuumInsThreshold[i])
      const score = Math.max(sVac, sIns)
      if (score > 1) candidates.push({ table: i, score })
    }
    candidates.sort((a, b) => b.score - a.score)

    // do_autovacuum walks the eligible list and fills every free worker slot.
    // Choosing one global winner per naptime let a small hot table win again
    // before a large table ever got a turn.
    let next = 0
    for (let slot = 0; slot < N_VAC_WORKERS && next < candidates.length; slot++) {
      const w = av.workers[slot]
      if (w.active) continue
      const best = candidates[next++].table
      w.active = true
      w.table = best
      w.deadCollected = 0
      w.vacuumDelay = false
      w.travel = 0
      w.stalledByHorizon = false
      vacTarget[slot] = Math.floor(deadRemovable[best])
      const dead = Math.max(1, tables[best].deadTuples)
      vacIndexTarget[slot] = Math.floor(deadIndexTuples[best] * (vacTarget[slot] / dead))
      const pages = Math.max(1, tables[best].pages)
      // Logical tuple counters are relation-wide while buffer traffic is a
      // representative sample. Base vacuum WAL page counts on the sampled DML
      // page writes that created the garbage, with a dense-page floor for the
      // pre-existing tuples present when the city loads.
      const heapPageDraws = Math.max(
        Math.ceil(vacTarget[slot] / tables[best].def.tuplesPerPage),
        heapWritesSinceVacuum[best],
      )
      const heapHotN = Math.min(pages, hotPages[best])
      const heapWarmN = Math.min(
        Math.max(0, pages - heapHotN),
        warmPages[best],
      )
      const heapColdN = Math.max(0, pages - heapHotN - heapWarmN)
      vacHeapHotModified[slot] = distinctPagesTouched(
        heapHotN,
        heapPageDraws * HEAP_HOT_WRITE_SHARE,
      )
      vacHeapWarmModified[slot] = distinctPagesTouched(
        heapWarmN,
        heapPageDraws * HEAP_WARM_WRITE_SHARE,
      )
      const heapColdModified = distinctPagesTouched(
        heapColdN,
        heapPageDraws * HEAP_COLD_WRITE_SHARE,
      )
      vacHeapModified[slot] =
        vacHeapHotModified[slot]
        + vacHeapWarmModified[slot]
        + heapColdModified
      vacIndexPageTouches[slot] = Math.max(
        Math.ceil(vacIndexTarget[slot] / INDEX_ENTRIES_PER_PAGE),
        indexWritesSinceVacuum[best],
      )
      heapWritesSinceVacuum[best] = 0
      indexWritesSinceVacuum[best] = 0
      // Heap scanning may prune some pages immediately. The remaining pages
      // are revisited after the index pass; they are disjoint WAL actions, not
      // a second modification record for every page in the relation.
      vacScanModified[slot] = Math.round(vacHeapModified[slot] * 0.15)
      // A checkpoint that starts mid-pass does not make the same vacuum visit
      // pay a second full-page image when it reaches vacuum_heap.
      vacFpiGeneration[slot] = fpiGeneration
      tables[best].vacuuming = true
      av.totalRuns++
      vacNext(w, 'travel', 2.0)
      flow('vac.launch', 2, 'stat', 1.2)
    }
  }

  function indexPagesFor(ti: number, indexNo: number): number {
    const d = TABLES[ti]
    const share = d.indexes[indexNo].pages / Math.max(1, baseIdxPages[ti])
    return Math.max(1, Math.round(idxPages[ti] * share))
  }

  function indexBlockOffset(ti: number, indexNo: number): number {
    let offset = IDX_BASE + 8
    for (let i = 0; i < indexNo; i++) offset += indexPagesFor(ti, i)
    return offset
  }

  /** Pace a discrete per-page maintenance action over the current phase. */
  function vacuumPageWork(
    worker: number,
    total: number,
    dt: number,
    done: boolean,
    visit: (page: number) => void,
  ): void {
    if (total <= 0) return
    vacPageAcc[worker] += (total * dt) / vacPhaseDur[worker]
    let n = Math.floor(vacPageAcc[worker])
    vacPageAcc[worker] -= n
    if (done) n = total - vacPageCursor[worker]
    while (n-- > 0 && vacPageCursor[worker] < total) visit(vacPageCursor[worker]++)
  }

  /** Account every physical page while active work slices are running. */
  function chargeVacuumIo(readPagesPerSec: number, writePagesPerSec: number, dt: number): void {
    ioReadAcc += readPagesPerSec * dt
    ioWriteAcc += writePagesPerSec * dt
  }

  function vacuumHeapBlock(worker: number, tableIndex: number, ordinal: number): number {
    const table = tables[tableIndex]
    const hotModified = vacHeapHotModified[worker]
    if (ordinal < hotModified) {
      return Math.min(table.pages - 1, Math.floor((ordinal * hotPages[tableIndex]) / Math.max(1, hotModified)))
    }
    const warmModified = vacHeapWarmModified[worker]
    if (ordinal < hotModified + warmModified) {
      const warmOrdinal = ordinal - hotModified
      return Math.min(
        table.pages - 1,
        hotPages[tableIndex]
          + Math.floor((warmOrdinal * warmPages[tableIndex]) / Math.max(1, warmModified)),
      )
    }
    const coldModified = vacHeapModified[worker] - hotModified - warmModified
    const coldOrdinal = ordinal - hotModified - warmModified
    return Math.min(
      table.pages - 1,
      hotPages[tableIndex]
        + warmPages[tableIndex]
        + Math.floor(
          (
            coldOrdinal
            * Math.max(0, table.pages - hotPages[tableIndex] - warmPages[tableIndex])
          ) / Math.max(1, coldModified),
        ),
    )
  }

  function vacuumIndexModifiedPages(worker: number, tableIndex: number, indexNo: number): number {
    const pages = indexPagesFor(tableIndex, indexNo)
    const hotSet = Math.max(
      1,
      Math.round(hotIdxPages[tableIndex] * (pages / Math.max(1, idxPages[tableIndex]))),
    )
    return affectedVacuumPages(
      pages,
      vacIndexPageTouches[worker] / Math.max(1, tables[tableIndex].def.indexes.length),
      hotSet,
      INDEX_HOT_SHARE,
    )
  }

  function vacNextIndex(w: VacWorker, worker: number, tableIndex: number, indexNo: number): void {
    const pages = indexPagesFor(tableIndex, indexNo)
    const modified = vacuumIndexModifiedPages(worker, tableIndex, indexNo)
    vacNextPaced(w, 'vacuum_index', pages, modified, 1 + pages / 260)
  }

  function tickAutovac(dt: number): void {
    av.enabled = K.autovacuum
    if (av.enabled) {
      av.nextLaunchSec -= dt
      if (av.nextLaunchSec <= 0) {
        av.nextLaunchSec = AV_NAPTIME
        launchVacuum()
      }
    }

    for (let i = 0; i < N_VAC_WORKERS; i++) {
      const w = av.workers[i]
      if (!w.active) continue
      // A maintenance worker that cannot reserve WAL space waits on
      // WALWriteLock just like a backend. Do not let the phase clock keep
      // running while its page records pile up in an unbounded side queue.
      if (maintenanceWalPending >= wal.bufferCapacity) {
        w.vacuumDelay = false
        continue
      }
      const ti = w.table
      const t = tables[ti]
      /* PostgreSQL calls vacuum_delay_point() after spending its cost budget.
       * Credit admits whole work slices at the scaled pace, leaving explicit
       * zero-progress VacuumDelay slices between them. Individual page costs
       * and the real 2 ms delay are not modeled. */
      const activeShare = vacActiveShare[i]
      if (activeShare < 1) {
        vacWorkCredit[i] += dt * activeShare
        if (vacWorkCredit[i] + Number.EPSILON < dt) {
          w.vacuumDelay = true
          continue
        }
        vacWorkCredit[i] -= dt
      }
      w.vacuumDelay = false
      vacPhaseT[i] += dt
      w.progress = clamp01(vacPhaseT[i] / vacPhaseDur[i])
      const done = vacPhaseT[i] >= vacPhaseDur[i]

      switch (w.phase) {
        case 'travel': {
          w.travel = w.progress
          if (++sVac >= 3) { sVac = 0; flow(rid.vacGo(ti), 1, 'dead', 1.3) }
          if (done) {
            // scan cost is proportional to the heap — the visibility map lets
            // vacuum skip all-visible pages, so append-only tables are cheap.
            const skip = t.def.id === 'events' ? 0.15 : 1
            const readPages = Math.max(1, Math.round(t.pages * skip))
            vacNextPaced(
              w,
              'scan_heap',
              readPages,
              vacScanModified[i],
              Math.max((t.pages / 900) * skip, 1.2),
            )
          }
          break
        }
        case 'scan_heap': {
          t.heat = Math.min(1, t.heat + dt * 0.6)
          const skip = t.def.id === 'events' ? 0.15 : 1
          const readPages = Math.max(1, Math.round(t.pages * skip))
          const modified = vacScanModified[i]
          const allModified = vacHeapModified[i]
          const deadPerPage = allModified > 0 ? vacTarget[i] / allModified : 0
          chargeVacuumIo(
            readPages / vacPhaseDur[i],
            modified / vacPhaseDur[i],
            dt,
          )
          vacuumPageWork(i, modified, dt, done, (page) => {
            const blk = vacuumHeapBlock(i, ti, page)
            walInsertPage(ti, blk, 40 + 2 * deadPerPage, vacFpiGeneration[i])
          })
          if (++sVac >= 5) { sVac = 0; flow(rid.idxLookup(ti), 1, 'dead', 0.9) }
          if (done) {
            const removable = Math.floor(deadRemovable[ti])
            // THE LESSON: an old snapshot pins the horizon, so nothing this
            // vacuum found is actually removable. It burns the I/O anyway.
            w.stalledByHorizon = horizonFrozen && t.deadTuples > removable * 4 + 200
            vacTarget[i] = removable
            if (removable < 1) {
              vacNext(w, 'analyze', 1.0)
            } else {
              vacIdxLeft[i] = t.def.indexes.length
              vacNextIndex(w, i, ti, 0)
            }
          }
          break
        }
        case 'vacuum_index': {
          const indexNo = t.def.indexes.length - vacIdxLeft[i]
          const pages = indexPagesFor(ti, indexNo)
          const killed = vacIndexTarget[i] / Math.max(1, t.def.indexes.length)
          const modified = vacuumIndexModifiedPages(i, ti, indexNo)
          const killedPerPage = modified > 0 ? killed / modified : 0
          const base = indexBlockOffset(ti, indexNo)
          chargeVacuumIo(
            pages / vacPhaseDur[i],
            modified / vacPhaseDur[i],
            dt,
          )
          vacuumPageWork(i, modified, dt, done, (page) => {
            walInsertPage(ti, base + page, 30 + 2 * killedPerPage, vacFpiGeneration[i])
          })
          if (++sVac >= 4) { sVac = 0; flow(rid.vacIdx(ti), 1, 'dead', 1.1) }
          if (done) {
            vacIdxLeft[i]--
            if (vacIdxLeft[i] > 0) {
              const nextIndex = t.def.indexes.length - vacIdxLeft[i]
              vacNextIndex(w, i, ti, nextIndex)
            } else {
              deadIndexTuples[ti] = Math.max(0, deadIndexTuples[ti] - vacIndexTarget[i])
              refreshIndexPages(ti)
              const modified = Math.max(0, vacHeapModified[i] - vacScanModified[i])
              vacNextPaced(
                w,
                'vacuum_heap',
                modified,
                modified,
                Math.max(t.pages / 1600, 0.8),
              )
            }
          }
          break
        }
        case 'vacuum_heap': {
          // reclaim happens here: line pointers are freed for reuse
          const collect = (vacTarget[i] * dt) / vacPhaseDur[i]
          const take = Math.min(collect, deadRemovable[ti], t.deadTuples)
          t.deadTuples -= take
          deadRemovable[ti] -= take
          if (take > 0) {
            collectRepresentativeVersions(t.mvcc, state.xminHorizon)
          }
          w.deadCollected += take
          av.landfill += take
          const allModified = vacHeapModified[i]
          const scanModified = vacScanModified[i]
          const modified = Math.max(0, allModified - scanModified)
          const deadPerPage = allModified > 0 ? vacTarget[i] / allModified : 0
          chargeVacuumIo(
            modified / vacPhaseDur[i],
            modified / vacPhaseDur[i],
            dt,
          )
          vacuumPageWork(i, modified, dt, done, (page) => {
            const ordinal = scanModified + page
            const blk = vacuumHeapBlock(i, ti, ordinal)
            walInsertPage(ti, blk, 40 + 2 * deadPerPage, vacFpiGeneration[i])
          })
          if (++sVac >= 4) { sVac = 0; flow(rid.ioWrite(ti), 1, 'page_write', 1.0) }
          if (done) vacNext(w, 'truncate', 0.7)
          break
        }
        case 'truncate': {
          if (done) {
            // ONLY trailing *empty* pages come back to the filesystem, and that
            // is the whole lesson: vacuum makes space reusable inside the file,
            // it does not give it back.
            //
            // Vacuum leaves its free space scattered across the relation, so a
            // page at the tail is only reclaimable if every slot on it happens
            // to be free. With a free fraction f that is f^tuplesPerPage, and
            // the expected run of such pages at the end of the file is
            // p/(1-p). For a bloated but populated table that is zero, which is
            // why the slab keeps its height while the bloat bar climbs. Only a
            // table that lost nearly all of its rows ever shrinks — and even
            // then real truncation makes a non-blocking ACCESS EXCLUSIVE
            // attempt and skips the shrink if another lock prevents it.
            const cap = t.pages * t.def.tuplesPerPage
            const used = t.liveTuples + t.deadTuples
            const free = cap > 0 ? clamp01((cap - used) / cap) : 0
            const spare = Math.floor((cap - used) / Math.max(1, t.def.tuplesPerPage))
            // Scattered free space almost never forms a long empty suffix.
            // Nine independent occupancy groups is the scaled analogue of a
            // real page's many tuple slots; the 1/16 gate is
            // REL_TRUNCATE_FRACTION.
            const tailEmpty = Math.floor(t.pages * Math.pow(free, 9))
            const shed = Math.min(tailEmpty, TRUNCATE_MAX_PAGES)
            if (spare > Math.max(40, t.pages / 16) && shed > 0 && !horizonFrozen) {
              t.pages = Math.max(t.def.pages, t.pages - shed)
              maintenanceWalPending += 30 // XLOG_SMGR_TRUNCATE
            }
            vacNext(w, 'analyze', 1.1)
          }
          break
        }
        case 'analyze': {
          if (done) {
            // The folded-in ANALYZE refreshes pg_class.reltuples. Between
            // maintenance passes it stays stale while liveTuples keeps moving.
            t.reltuples = Math.max(0, t.liveTuples)
            vacNext(w, 'return', 1.8)
          }
          break
        }
        case 'return': {
          w.travel = 1 - w.progress
          if (++sVac >= 3) { sVac = 0; flow(rid.vacBack(ti), 1, 'dead', 1.25) }
          if (done) {
            t.vacuuming = false
            t.lastVacuum = state.t
            insSinceVacuum[ti] = 0
            frozenPages[ti] = t.pages
            w.active = false
            w.phase = 'idle'
            w.progress = 0
            w.vacuumDelay = false
            w.travel = 0
            if (w.stalledByHorizon) {
              toast(
                `autovacuum: ${t.def.name} — ${Math.round(t.deadTuples).toLocaleString()} dead rows, 0 removable (old snapshot)`,
                'warn',
                6000,
              )
              // The run is over: the flag described this pass, not the bay.
              w.stalledByHorizon = false
            }
          }
          break
        }
        case 'idle':
          w.active = false
          break
      }
    }
  }

  /* ======================================================================
   * LOCKS
   * ====================================================================*/

  function releaseLock(): void {
    if (lockHolder >= 0) {
      extras[lockHolder].holdsLock = false
      const h = backends[lockHolder]
      if (h.state === 'idle_in_xact') {
        h.state = 'idle'
        h.stateT = 0
        h.stateDur = 0.4
      }
    }
    lockHolder = -1
    if (state.locks.length) state.locks.length = 0
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = backends[i]
      if (b.state === 'blocked') {
        b.waitOn = -1
        beginExec(i)
      }
      lockWaitT[i] = 0
    }
  }

  function tickLocks(dt: number): void {
    if (!K.lockContention) {
      if (lockHolder >= 0) releaseLock()
      return
    }
    if (lockHolder < 0) {
      // Somebody runs ALTER TABLE and then sits there in an open transaction.
      for (let i = 0; i < N_BACKEND_SLOTS; i++) {
        const b = backends[i]
        if (b.active && (b.state === 'idle' || b.state === 'sending')) {
          lockHolder = i
          extras[i].holdsLock = true
          b.state = 'idle_in_xact'
          b.stateT = 0
          b.stateDur = 9999
          b.table = lockTable
          b.sql = `LOCK TABLE ${TABLES[lockTable].name} IN ACCESS EXCLUSIVE MODE`
          b.plan = null
          toast(`ACCESS EXCLUSIVE lock held on ${TABLES[lockTable].name}`, 'warn', 5000)
          break
        }
      }
    }
    for (let e = 0; e < state.locks.length; e++) state.locks[e].ageSec += dt
  }

  function conflicts(slot: number, ti: number): boolean {
    if (lockHolder < 0 || slot === lockHolder) return false
    return ti === lockTable
  }

  function blockOn(slot: number, ti: number): void {
    const b = backends[slot]
    const to = lockTimeoutSec()
    b.state = 'blocked'
    b.stateT = 0
    // With lock_timeout disabled there is no deadline to draw a progress ring
    // against; the wait is open-ended, exactly as it is on a real primary.
    b.stateDur = Number.isFinite(to) ? to : 9999
    b.waitOn = lockHolder
    lockWaitT[slot] = 0
    if (state.locks.length < 12) {
      state.locks.push({
        holder: lockHolder,
        waiter: slot,
        table: ti,
        mode: 'RowExclusiveLock',
        ageSec: 0,
      })
    }
  }

  function unblock(slot: number): void {
    for (let i = state.locks.length - 1; i >= 0; i--) {
      if (state.locks[i].waiter === slot) state.locks.splice(i, 1)
    }
    backends[slot].waitOn = -1
  }

  /* ======================================================================
   * REPLICATION
   * ====================================================================*/

  const streamRoutes = ['net.stream', 'net.streamB'] as const
  const ackRoutes = ['net.ack', 'net.ackB'] as const
  const receiveRoutes = ['replica.apply', 'replicaB.apply'] as const
  const bufferRoutes = ['replica.buffer', 'replicaB.buffer'] as const
  const ioRoutes = ['replica.io', 'replicaB.io'] as const

  function synchronousStandby(): PhysicalStandbyState {
    return configuredSynchronousStandby(state) ?? rep.standbys[0]
  }

  function resetPhysicalRuntime(runtime: RuntimePhysicalReplication, lsn: number): void {
    runtime.wireHead = runtime.wireTail = runtime.wireCount = 0
    runtime.applyAckHead = runtime.applyAckTail = runtime.applyAckCount = 0
    runtime.writeAckHead = runtime.writeAckTail = runtime.writeAckCount = 0
    runtime.flushAckHead = runtime.flushAckTail = runtime.flushAckCount = 0
    runtime.applyAckSentLsn = lsn
    runtime.writeAckSentLsn = lsn
    runtime.flushAckSentLsn = lsn
    runtime.previousLagBytes = 0
    runtime.previousLagSec = 0
    runtime.bufferPageCursor = 0
    runtime.readT = 0
    runtime.rejoining = false
  }

  function tickStandbyBuffers(index: 0 | 1, fromLsn: number, toLsn: number, dt: number): void {
    const pool = state.cluster.nodes[index + 1].buffers
    const runtime = physicalRuntime[index]
    const pageDelta = Math.max(0, Math.floor((toLsn - fromLsn) / PAGE))
    const touches = Math.min(12, pageDelta)
    for (let i = 0; i < touches; i++) {
      const b = (runtime.bufferPageCursor * 131 + index * 67) % pool.sampleFrames
      runtime.bufferPageCursor++
      if (!pool.valid[b]) {
        pool.valid[b] = 1
        pool.usedCount = asSampleFrames(pool.usedCount + 1)
        pool.misses++
      } else {
        pool.hits++
      }
      if (!pool.dirty[b]) pool.dirtyCount = asSampleFrames(pool.dirtyCount + 1)
      pool.dirty[b] = 1
      pool.usage[b] = Math.min(5, pool.usage[b] + 1)
      pool.rel[b] = (runtime.bufferPageCursor + index) % N_TABLES
      pool.blk[b] = Math.floor(toLsn / PAGE)
      pool.lastTouch[b] = state.t
    }
    const seen = pool.hits + pool.misses
    if (seen > 0) pool.hitRatio = pool.hits / seen
    /* Recovery restartpoints make replayed pages durable independently on
     * each standby. This compact cleaner represents that writeback, not the
     * primary's checkpointer or buffer pool. */
    let cleanBudget = Math.min(3, Math.ceil(dt * 30))
    while (cleanBudget-- > 0 && pool.dirtyCount > 0) {
      const b = pool.clockHand
      pool.clockHand = pool.clockHand + 1 >= pool.sampleFrames ? 0 : pool.clockHand + 1
      if (!pool.dirty[b]) continue
      pool.dirty[b] = 0
      pool.dirtyCount = asSampleFrames(pool.dirtyCount - 1)
    }
  }

  function tickPhysicalStandby(index: 0 | 1, dt: number): void {
    const standby = rep.standbys[index]
    const runtime = physicalRuntime[index]
    const knobKeys = PHYSICAL_STANDBY_KNOBS[index]
    const enabled = K[knobKeys.enabled]
    const slowApply = K[knobKeys.slowApply]
    const networkLagMs = K[knobKeys.networkLag]
    /* Patroni moves the synchronous role to the remaining follower after a
     * promotion; synchronous_commit still controls each transaction's wait. */
    const sync = configuredSynchronousStandby(state) === standby

    standby.enabled = enabled
    standby.networkLagMs = networkLagMs
    standby.mode = sync ? 'sync' : 'async'

    if (ha.currentLeader === standby.nodeId) {
      standby.connected = false
      standby.inFlight = 0
      standby.lagBytes = 0
      standby.lagSec = 0
      standby.applyActivity = damp(standby.applyActivity, 0, 3, dt)
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
      standby.startupProcess = 'stopped'
      return
    }

    const standbyNode = state.cluster.nodes[index + 1]
    if (standbyNode.role === 'diverged') {
      standby.connected = false
      standby.inFlight = 0
      standby.applyActivity = damp(standby.applyActivity, 0, 3, dt)
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
      standby.startupProcess = 'stopped'
      return
    }

    const leader = ha.currentLeader
      ? state.cluster.nodes[clusterNodeIndex(ha.currentLeader)]
      : undefined
    if (!leader?.online) {
      standby.connected = false
      resetPhysicalRuntime(runtime, standby.appliedLsn)
      standby.inFlight = 0
      standby.applyActivity = damp(standby.applyActivity, 0, 3, dt)
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
      standby.startupProcess = 'stopped'
      return
    }

    if (!enabled || K.walLevel === 'minimal') {
      if (standby.connected) {
        standby.connected = false
        resetPhysicalRuntime(runtime, standby.appliedLsn)
        toast(
          K.walLevel === 'minimal'
            ? 'wal_level=minimal — physical standbys cannot be fed from this WAL'
            : `${standby.applicationName} disconnected — its physical slot still retains WAL`,
          'warn',
        )
      }
      standby.inFlight = 0
      standby.applyActivity = damp(standby.applyActivity, 0, 3, dt)
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
      standby.startupProcess = 'stopped'
      if (K.walLevel === 'minimal') {
        standby.sentLsn = standby.receivedLsn = standby.writtenLsn = wal.flushLsn
        standby.flushedLsn = standby.appliedLsn = wal.flushLsn
        standby.lagBytes = 0
        standby.lagSec = 0
        runtime.previousLagBytes = 0
        runtime.previousLagSec = 0
      }
      return
    }

    if (!standby.connected) {
      standby.connected = true
      resetPhysicalRuntime(runtime, standby.appliedLsn)
      runtime.rejoining = true
    }
    const delay = (networkLagMs * NET_PACKET_STRETCH) / 1000
    if (runtime.rejoining && wal.flushLsn - standby.sentLsn < 64 * 1024) {
      runtime.rejoining = false
    }
    const catchingUp = runtime.rejoining || wal.flushLsn - standby.sentLsn > 256 * 1024
    standby.walSender = catchingUp ? 'catchup' : 'streaming'
    standby.walReceiver = catchingUp ? 'catchup' : 'streaming'
    standby.startupProcess = catchingUp ? 'catchup' : 'streaming'

    // One primary-side walsender and one packet queue per standby.
    if (wal.flushLsn > standby.sentLsn && runtime.wireCount < WIRE) {
      const chunk = Math.min(
        wal.flushLsn - standby.sentLsn,
        MODEL_PHYSICAL_REPLICATION_LINK_BYTES_PER_SEC * dt,
      )
      standby.sentLsn = Math.floor(standby.sentLsn + chunk)
      runtime.wireLsn[runtime.wireHead] = standby.sentLsn
      runtime.wireAt[runtime.wireHead] = state.t + delay
      runtime.wireHead = (runtime.wireHead + 1) % WIRE
      runtime.wireCount++
      flow('wal.stream', 1, 'stream', 1.2)
      flow(streamRoutes[index], 1, 'stream', 1.4)
    }

    while (
      runtime.wireCount > 0
      && runtime.wireAt[runtime.wireTail] <= state.t
    ) {
      standby.receivedLsn = Math.max(
        standby.receivedLsn,
        runtime.wireLsn[runtime.wireTail],
      )
      runtime.wireTail = (runtime.wireTail + 1) % WIRE
      runtime.wireCount--
      flow(receiveRoutes[index], 1, 'stream', 1.1)
    }
    standby.inFlight = runtime.wireCount

    /* The walreceiver accepts bytes, writes its own pg_wal, then fsyncs it.
     * Small rolling gaps keep the three positions legible under sustained
     * traffic; an idle stream still converges exactly. */
    const receiveBusy = standby.receivedLsn < standby.sentLsn || wal.bytesPerSec > 64 * 1024
    const displayGap = 0
    const writeLimit = receiveBusy
      ? Math.max(standby.writtenLsn, standby.receivedLsn - displayGap)
      : standby.receivedLsn
    if (standby.writtenLsn < writeLimit) {
      const rate = Math.max(8 * MIB, wal.bytesPerSec * 5)
      standby.writtenLsn = Math.floor(
        Math.min(writeLimit, standby.writtenLsn + rate * dt),
      )
    }
    if (
      standby.writtenLsn > runtime.writeAckSentLsn
      && runtime.writeAckCount < ACKW
    ) {
      runtime.writeAckSentLsn = standby.writtenLsn
      runtime.writeAckLsn[runtime.writeAckHead] = standby.writtenLsn
      runtime.writeAckAt[runtime.writeAckHead] =
        state.t + delay * REPLICA_WRITE_ACK_DELAY_FRACTION
      runtime.writeAckHead = (runtime.writeAckHead + 1) % ACKW
      runtime.writeAckCount++
    }
    while (
      runtime.writeAckCount > 0
      && runtime.writeAckAt[runtime.writeAckTail] <= state.t
    ) {
      standby.acknowledgedWriteLsn = Math.max(
        standby.acknowledgedWriteLsn,
        runtime.writeAckLsn[runtime.writeAckTail],
      )
      runtime.writeAckTail = (runtime.writeAckTail + 1) % ACKW
      runtime.writeAckCount--
    }
    const flushLimit = receiveBusy
      ? Math.max(standby.flushedLsn, standby.writtenLsn - displayGap)
      : standby.writtenLsn
    if (standby.flushedLsn < flushLimit) {
      const rate = Math.max(8 * MIB, wal.bytesPerSec * 4)
      standby.flushedLsn = Math.floor(
        Math.min(flushLimit, standby.flushedLsn + rate * dt),
      )
    }

    if (
      standby.flushedLsn > runtime.flushAckSentLsn
      && runtime.flushAckCount < ACKW
    ) {
      runtime.flushAckSentLsn = standby.flushedLsn
      runtime.flushAckLsn[runtime.flushAckHead] = standby.flushedLsn
      runtime.flushAckAt[runtime.flushAckHead] = state.t + delay
      runtime.flushAckHead = (runtime.flushAckHead + 1) % ACKW
      runtime.flushAckCount++
    }
    while (
      runtime.flushAckCount > 0
      && runtime.flushAckAt[runtime.flushAckTail] <= state.t
    ) {
      standby.acknowledgedFlushLsn = Math.max(
        standby.acknowledgedFlushLsn,
        runtime.flushAckLsn[runtime.flushAckTail],
      )
      runtime.flushAckTail = (runtime.flushAckTail + 1) % ACKW
      runtime.flushAckCount--
    }

    const applyRate = slowApply
      ? Math.max(24 * 1024, wal.bytesPerSec * 0.35)
      : Math.max(24 * MIB, wal.bytesPerSec * 4)
    const beforeApply = standby.appliedLsn
    if (standby.appliedLsn < standby.flushedLsn && !standby.replayPaused) {
      standby.appliedLsn = Math.floor(
        Math.min(standby.flushedLsn, standby.appliedLsn + applyRate * dt),
      )
      standby.applyActivity = damp(standby.applyActivity, 1, 6, dt)
      tickStandbyBuffers(index, beforeApply, standby.appliedLsn, dt)
      flow(bufferRoutes[index], 1, 'stream', 1.0)
      if (++sRepIo >= 6) {
        sRepIo = 0
        flow(ioRoutes[index], 1, 'page_write', 1.0)
      }
    } else {
      standby.applyActivity = damp(standby.applyActivity, 0.08, 3, dt)
    }

    if (
      standby.appliedLsn > runtime.applyAckSentLsn
      && runtime.applyAckCount < ACKW
    ) {
      runtime.applyAckSentLsn = standby.appliedLsn
      runtime.applyAckLsn[runtime.applyAckHead] = standby.appliedLsn
      runtime.applyAckAt[runtime.applyAckHead] =
        state.t + delay + REPLICA_APPLY_ACK_DELAY
      runtime.applyAckHead = (runtime.applyAckHead + 1) % ACKW
      runtime.applyAckCount++
      flow(ackRoutes[index], 1, 'ack', 1.0)
    }
    while (
      runtime.applyAckCount > 0
      && runtime.applyAckAt[runtime.applyAckTail] <= state.t
    ) {
      standby.acknowledgedApplyLsn = Math.max(
        standby.acknowledgedApplyLsn,
        runtime.applyAckLsn[runtime.applyAckTail],
      )
      runtime.applyAckTail = (runtime.applyAckTail + 1) % ACKW
      runtime.applyAckCount--
    }

    standby.lagBytes = Math.max(0, wal.flushLsn - standby.appliedLsn)
    updateReplayLag(standby, runtime)
    runtime.readT += dt
    if (index === 0 && runtime.readT > 0.4) {
      runtime.readT = 0
      flow('replica.read', 1, 'query', 1.0)
    }
  }

  function syncClusterProjection(): void {
    const leaderId = ha.currentLeader
    if (leaderId) {
      const node = state.cluster.nodes[clusterNodeIndex(leaderId)]
      node.wal.receivedLsn = wal.insertLsn
      node.wal.writtenLsn = wal.writeLsn
      node.wal.flushedLsn = wal.flushLsn
      node.wal.appliedLsn = wal.insertLsn
      node.wal.segmentCount = wal.segmentCount
      node.wal.diskBytes = wal.segmentCount * WAL_SEG
      node.dataDirectory.bytes = dr.dataDirectoryBytes
      node.dataDirectory.appliedLsn = wal.insertLsn
    }

    const oldPrimary = state.cluster.nodes[0]
    if (
      leaderId
      && leaderId !== 'primary'
      && oldPrimary.role === 'standby'
      && oldPrimary.online
    ) {
      oldPrimary.wal.receivedLsn = wal.insertLsn
      oldPrimary.wal.writtenLsn = wal.writeLsn
      oldPrimary.wal.flushedLsn = wal.flushLsn
      oldPrimary.wal.appliedLsn = wal.insertLsn
      oldPrimary.wal.segmentCount = wal.segmentCount
      oldPrimary.wal.diskBytes = wal.segmentCount * WAL_SEG
      oldPrimary.dataDirectory.bytes = dr.dataDirectoryBytes
      oldPrimary.dataDirectory.appliedLsn = wal.insertLsn
    }

    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      const standby = rep.standbys[i]
      const node = state.cluster.nodes[i + 1]
      if (node.id === leaderId) continue
      if (node.role === 'diverged') {
        node.online = false
        continue
      }
      node.online = standby.enabled
      node.wal.receivedLsn = standby.receivedLsn
      node.wal.writtenLsn = standby.writtenLsn
      node.wal.flushedLsn = standby.flushedLsn
      node.wal.appliedLsn = standby.appliedLsn
      node.wal.segmentCount = Math.max(
        N_WAL_SEG_SLOTS,
        Math.ceil(Math.max(0, standby.receivedLsn - standby.appliedLsn) / WAL_SEG) + 3,
      )
      node.wal.diskBytes = node.wal.segmentCount * WAL_SEG
      node.dataDirectory.bytes = dr.dataDirectoryBytes
      node.dataDirectory.appliedLsn = standby.appliedLsn
    }
    ha.timeline.newHistoryEndLsn = wal.insertLsn
  }

  function tickReplication(dt: number): void {
    tickPhysicalStandby(0, dt)
    tickPhysicalStandby(1, dt)

    rep.logicalEnabled = K.walLevel === 'logical'
    if (rep.logicalEnabled) {
      rep.logicalSlotLsn = Math.floor(
        Math.min(
          wal.flushLsn,
          rep.logicalSlotLsn + Math.max(2 * MIB, wal.bytesPerSec * 1.4) * dt,
        ),
      )
      const changes = stats.tps * K.writeRatio * 1.4
      rep.logicalChangesPerSec = damp(rep.logicalChangesPerSec, changes, 2, dt)
      logicalAcc += dt
      if (logicalAcc > 0.12) {
        logicalAcc = 0
        flow('logical.decode', 1, 'stream', 1.1)
      }
    } else {
      rep.logicalSlotLsn = wal.insertLsn
      rep.logicalChangesPerSec = damp(rep.logicalChangesPerSec, 0, 3, dt)
    }
    syncHorizonPin()
    syncClusterProjection()
  }

  /* ======================================================================
   * PATRONI, PROMOTION, TIMELINES, AND REJOIN
   * ====================================================================*/

  function clearInFlightPageWalState(): void {
    releaseCheckpointFlushBuffer()
    if (bgwriterFlushBuffer >= 0) buf.pinned[bgwriterFlushBuffer] = 0
    bgwriterFlushBuffer = -1
    bgwriterFlushLsn = 0
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const x = extras[i]
      if (x.evictionBuffer >= 0) buf.pinned[x.evictionBuffer] = 0
      x.evictionBuffer = -1
      x.evictionFlushLsn = 0
    }
    evictionOwner.fill(0)
    pageLsnOwners.fill(0)
    buf.pageLsn.fill(0)
    ckptNeeded.fill(0)
    ckptScan = 0
    checkpointFlushBuffer = -1
    checkpointFlushLsn = 0
    ckpt.phase = 'idle'
    ckpt.progress = 0
    ckpt.buffersToWrite = 0
    ckpt.buffersWritten = asSampleFrames(0)
  }

  function resetActiveWalAt(lsn: number): void {
    const parentArchiveTimeline = dr.archive.timeline
    const parentArchivedThroughLsn = dr.archive.archivedThroughLsn
    const parentArchivedThroughTime = dr.archive.archivedThroughTime
    wal.insertLsn = lsn
    wal.writeLsn = lsn
    wal.flushLsn = lsn
    wal.bufferBytes = 0
    flushing = false
    flushTarget = lsn
    flushCovered = lsn
    flushT = 0
    flushBytes = 0
    walWriterT = 0
    maintenanceWalPending = 0
    maintenanceFpiPending = 0
    clearInFlightPageWalState()

    const seg0 = Math.floor(lsn / WAL_SEG)
    const base = seg0 - 3
    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const segment = segments[i]
      segment.id = base + i
      segment.name = walSegName(
        segment.id,
        segment.id < seg0 ? ha.timeline.parent : ha.timeline.current,
      )
      segment.bytes = segment.id < seg0
        ? WAL_SEG
        : segment.id === seg0
          ? lsn - seg0 * WAL_SEG
          : 0
      segment.fill = segment.id < seg0
        ? 1
        : segment.id === seg0
          ? segment.bytes / WAL_SEG
          : 0
      segment.state = segment.id < seg0
        ? (segment.id + 1) * WAL_SEG <= parentArchivedThroughLsn
          ? 'archived'
          : 'streamed'
        : segment.id === seg0
          ? 'current'
          : 'recycled'
    }
    archiveNextSeg = seg0
    archiveInFlight = -1
    archT = 0
    archiveRetryT = 0
    lastObservedCurrentSeg = seg0
    closedSegmentId.fill(-1)
    closedSegmentAt.fill(0)

    ckpt.redoLsn = lsn
    ckpt.completedRedoLsn = lsn
    rep.logicalSlotLsn = lsn
    dr.archive.parentTimeline = parentArchiveTimeline
    dr.archive.parentArchivedThroughLsn = parentArchivedThroughLsn
    dr.archive.parentArchivedThroughTime = parentArchivedThroughTime
    dr.archive.timeline = ha.timeline.current
    dr.archive.archivedThroughLsn = lsn
    dr.archive.archivedThroughTime = parentArchivedThroughTime
    dr.archive.historyFileName = CLAIM_VALUES.timelineRecovery.historyFile
    dr.archive.historyFileArchived = false

    lagSampleHead = 0
    lagSampleCount = 1
    lagSampleLsn[0] = lsn
    lagSampleAt[0] = state.t
  }

  function stopCrashedPrimaryWork(): void {
    pendingTx = 0
    clearArrivalQueue()
    nextArrival = 0
    clearInFlightPageWalState()
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = backends[i]
      const x = extras[i]
      b.active = false
      b.state = 'free'
      b.xid = 0
      b.plan = null
      x.txCount = 0
      x.walPending = 0
      x.walPendingFpi = 0
      x.walPrepared = false
      x.evictionBuffer = -1
      x.evictionFlushLsn = 0
      x.planFlat.length = 0
      unpinAll(i)
    }
    wal.insertLsn = wal.writeLsn = wal.flushLsn
    wal.bufferBytes = 0
    flushing = false
    flushTarget = wal.flushLsn
    flushCovered = wal.flushLsn
  }

  function resetTransition(
    kind: 'switchover' | 'failover',
    source: ClusterNodeId,
    target: 'standbyA' | 'standbyB',
  ): void {
    const transition = ha.transition
    transition.kind = kind
    transition.status = 'waiting'
    transition.source = source
    transition.target = target
    transition.startedAt = state.t
    transition.waitSec = 0
    transition.lossBytes = 0
    transition.lossTransactions = 0
    transition.failureReason = ''
  }

  function standbyForNode(id: 'standbyA' | 'standbyB'): PhysicalStandbyState {
    return rep.standbys[id === 'standbyA' ? 0 : 1]
  }

  function eligiblePromotionTarget(id: 'standbyA' | 'standbyB'): boolean {
    const standby = standbyForNode(id)
    return K.walLevel !== 'minimal'
      && standby.enabled
      && standby.connected
      && state.cluster.nodes[clusterNodeIndex(id)].online
  }

  function stopPrimaryAndStreams(): void {
    ha.acceptingWrites = false
    const sourceNode = state.cluster.nodes[0]
    sourceNode.wal.receivedLsn = wal.insertLsn
    sourceNode.wal.writtenLsn = wal.writeLsn
    sourceNode.wal.flushedLsn = wal.flushLsn
    sourceNode.wal.appliedLsn = wal.insertLsn
    sourceNode.online = false
    ha.timeline.oldHistoryEndLsn = wal.flushLsn
    stopCrashedPrimaryWork()

    /* The primary and its network are gone. Bytes already durable on each
     * candidate survive; queued packets and primary-only bytes do not. */
    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      const standby = rep.standbys[i]
      resetPhysicalRuntime(physicalRuntime[i], standby.flushedLsn)
      standby.sentLsn = standby.receivedLsn = standby.writtenLsn = standby.flushedLsn
      standby.inFlight = 0
      standby.connected = false
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
    }
    patroniRenewT = 0
  }

  function stageFailoverCandidateDecision(): void {
    if (ha.currentLeader !== 'primary' || ha.transition.status === 'waiting') return
    const transition = ha.transition
    transition.kind = 'failover'
    transition.status = 'waiting'
    transition.source = 'primary'
    transition.target = null
    transition.startedAt = state.t
    transition.waitSec = 0
    transition.lossBytes = 0
    transition.lossTransactions = 0
    transition.failureReason = ''
    stopPrimaryAndStreams()
  }

  function patroniAgent(nodeId: ClusterNodeId) {
    return ha.patroni.agents[clusterNodeIndex(nodeId)]
  }

  function canCommitFor(nodeId: ClusterNodeId): boolean {
    return ha.patroni.dcs.canCommit && patroniAgent(nodeId).canReachConsensus
  }

  function startSwitchover(target: 'standbyA' | 'standbyB' = 'standbyA'): boolean {
    if (
      ha.transition.status === 'waiting'
      || ha.currentLeader !== 'primary'
      || !canCommitFor('primary')
      || !canCommitFor(target)
      || !eligiblePromotionTarget(target)
    ) {
      toast(
        !canCommitFor('primary') || !canCommitFor(target)
          ? 'Switchover refused: both Patroni agents need Raft consensus to compare-and-swap the leader key'
          : 'Switchover refused: reset the drill and choose a connected physical standby',
        'warn',
        6500,
      )
      return false
    }
    resetTransition('switchover', 'primary', target)
    ha.acceptingWrites = false
    pendingTx = 0
    clearArrivalQueue()
    toast(
      `Planned switchover: writes stopped; waiting for ${standbyForNode(target).applicationName} to flush every byte`,
      'info',
      6500,
    )
    bus.emit('narrate', {
      title: 'Planned switchover',
      body: `Write admission is closed. Patroni will not compare-and-swap the leader key until ${standbyForNode(target).applicationName} has flushed every byte. The wait is the cost; loss must remain zero.`,
      seconds: 8,
    })
    bus.emit('focus', { id: 'ha.dcs' })
    bus.emit('select', { id: 'ha.dcs' })
    return true
  }

  function startFailover(target: 'standbyA' | 'standbyB' = 'standbyA'): boolean {
    const transition = ha.transition
    const stagedChoice =
      transition.kind === 'failover'
      && transition.status === 'waiting'
      && transition.source === 'primary'
      && transition.target === null
      && !state.cluster.nodes[0].online
    if (stagedChoice) {
      const standby = standbyForNode(target)
      const eligible =
        K.walLevel !== 'minimal'
        && standby.enabled
        && state.cluster.nodes[clusterNodeIndex(target)].online
      if (!canCommitFor(target) || !eligible) {
        toast(
          !canCommitFor(target)
            ? 'Failover refused: the candidate cannot commit a leader-key compare-and-swap through Raft'
            : 'Failover refused: choose an online physical standby',
          'warn',
          6500,
        )
        return false
      }
      transition.target = target
      toast(
        `Candidate selected: ${standby.applicationName} is durable through ${fmtLsn(standby.flushedLsn)}`,
        'info',
        6500,
      )
      bus.emit('narrate', {
        title: 'Promotion candidate selected',
        body: `${standby.applicationName} can preserve only the WAL durable at its flush LSN. Patroni promotes after the old leader lease is gone; the gap to the former primary becomes the lost tail of timeline ${ha.timeline.current}.`,
        seconds: 9,
      })
      if (
        !ha.currentLeader
        || ha.patroni.dcs.leaderKey.leaseRemainingSec <= 0
      ) completePromotion(true)
      return true
    }

    if (
      transition.status === 'waiting'
      || ha.currentLeader !== 'primary'
      || !canCommitFor(target)
      || !eligiblePromotionTarget(target)
    ) {
      toast(
        !canCommitFor(target)
          ? 'Failover refused: the candidate cannot commit a leader-key compare-and-swap through Raft'
          : 'Failover refused: reset the drill and choose a connected physical standby',
        'warn',
        6500,
      )
      return false
    }

    resetTransition('failover', 'primary', target)
    stopPrimaryAndStreams()
    toast(
      `Primary gone: Patroni is waiting ${ha.patroni.dcs.leaderKey.leaseRemainingSec.toFixed(1)} s for its leader-key lease to expire`,
      'warn',
      6500,
    )
    bus.emit('narrate', {
      title: 'Unplanned failover',
      body: `The primary disappeared. ${standbyForNode(target).applicationName} is durable through ${fmtLsn(standbyForNode(target).flushedLsn)}, while the primary had flushed further. Patroni must wait for the old leader lease to expire before it can promote.`,
      seconds: 9,
    })
    bus.emit('focus', { id: 'ha.dcs' })
    bus.emit('select', { id: 'ha.dcs' })
    return true
  }

  function prepareFollowerAfterPromotion(
    id: 'standbyA' | 'standbyB',
    forkLsn: number,
  ): boolean {
    if (ha.currentLeader === id) return false
    const index = id === 'standbyA' ? 0 : 1
    const standby = rep.standbys[index]
    const node = state.cluster.nodes[index + 1]
    /* PostgreSQL refuses a timeline switch when recovery has already replayed
     * beyond the new timeline's fork. Patroni must rewind or reinitialise this
     * data directory; silently moving its LSNs backwards invents recovery. */
    if (standby.appliedLsn > forkLsn) {
      node.role = 'diverged'
      node.online = false
      standby.connected = false
      standby.inFlight = 0
      standby.walSender = 'stopped'
      standby.walReceiver = 'stopped'
      standby.startupProcess = 'stopped'
      resetPhysicalRuntime(physicalRuntime[index], standby.appliedLsn)
      return true
    }
    standby.sentLsn = Math.min(standby.sentLsn, forkLsn)
    standby.receivedLsn = Math.min(standby.receivedLsn, forkLsn)
    standby.writtenLsn = Math.min(standby.writtenLsn, forkLsn)
    standby.flushedLsn = Math.min(standby.flushedLsn, forkLsn)
    standby.appliedLsn = Math.min(standby.appliedLsn, forkLsn)
    standby.acknowledgedWriteLsn = standby.writtenLsn
    standby.acknowledgedFlushLsn = standby.flushedLsn
    standby.acknowledgedApplyLsn = standby.appliedLsn
    resetPhysicalRuntime(physicalRuntime[index], standby.appliedLsn)
    standby.connected = standby.enabled
    return false
  }

  function completePromotion(unplanned: boolean, sourceRemainsOnline = false): void {
    const transition = ha.transition
    const sourceId = transition.source
    const targetId = transition.target
    if (!sourceId || !targetId || targetId === 'primary') return
    if (!commitLeaderKeyCompareAndSwap(unplanned ? null : sourceId, targetId)) {
      transition.status = 'failed'
      transition.failureReason = 'Raft could not commit the leader-key compare-and-swap'
      return
    }
    const target = standbyForNode(targetId)
    const forkLsn = unplanned ? target.flushedLsn : wal.flushLsn
    const oldEnd = unplanned ? ha.timeline.oldHistoryEndLsn : forkLsn

    transition.lossBytes = Math.max(0, oldEnd - forkLsn)
    transition.lossTransactions = unplanned
      ? committedWritesBetween(forkLsn, oldEnd)
      : 0
    transition.waitSec = Math.max(0, state.t - transition.startedAt)
    transition.status = 'complete'

    ha.timeline.parent = ha.timeline.current
    ha.timeline.current++
    ha.timeline.forkLsn = forkLsn
    ha.timeline.forkedAt = state.t
    ha.timeline.oldHistoryEndLsn = oldEnd
    ha.timeline.newHistoryEndLsn = forkLsn

    const source = state.cluster.nodes[clusterNodeIndex(sourceId)]
    const promoted = state.cluster.nodes[clusterNodeIndex(targetId)]
    source.role = unplanned ? 'diverged' : 'standby'
    source.online = sourceRemainsOnline || !unplanned
    source.leaderOpinion = unplanned ? sourceId : targetId
    promoted.role = 'primary'
    promoted.online = true
    promoted.leaderOpinion = targetId
    for (let i = 0; i < state.cluster.nodes.length; i++) {
      const node = state.cluster.nodes[i]
      if (node.id !== sourceId) node.leaderOpinion = targetId
      if (node.id !== sourceId && node.id !== targetId) node.role = 'standby'
    }

    ha.currentLeader = targetId
    patroniRenewT = 0
    resetActiveWalAt(forkLsn)

    target.sentLsn = target.receivedLsn = target.writtenLsn = forkLsn
    target.flushedLsn = target.appliedLsn = forkLsn
    target.acknowledgedWriteLsn = target.acknowledgedFlushLsn =
      target.acknowledgedApplyLsn = forkLsn
    resetPhysicalRuntime(
      physicalRuntime[targetId === 'standbyA' ? 0 : 1],
      forkLsn,
    )
    const standbyANeedsReinitialize = prepareFollowerAfterPromotion('standbyA', forkLsn)
    const standbyBNeedsReinitialize = prepareFollowerAfterPromotion('standbyB', forkLsn)
    const reinitializeNode = standbyANeedsReinitialize
      ? 'standbyA'
      : standbyBNeedsReinitialize
        ? 'standbyB'
        : null

    const rejoin = ha.rejoin
    rejoin.required = unplanned || reinitializeNode !== null
    rejoin.node = unplanned ? sourceId : null
    rejoin.reinitializeRequired = reinitializeNode !== null
    rejoin.reinitializeNode = reinitializeNode
    rejoin.reinitializeBytes = reinitializeNode ? dr.dataDirectoryBytes : 0
    rejoin.reinitializeCopiedBytes = 0
    rejoin.blockChangeTrackingAvailable = K.walLogHints
    rejoin.status = 'idle'
    rejoin.progress = 0
    rejoin.startedAt = 0
    rejoin.elapsedSec = 0
    rejoin.estimatedDurationSec = 0
    rejoin.bytesRewound = Math.max(0, oldEnd - forkLsn)
    rejoin.bytesCopied = 0
    rejoin.failureReason = ''
    ha.acceptingWrites = true

    const scenarioDecision = state.scenarioDecision
    if (
      scenarioDecision?.kind === 'failover-candidate'
      && scenarioDecision.choice
    ) {
      scenarioDecision.lossBytes = transition.lossBytes
      scenarioDecision.lossTransactions = transition.lossTransactions
      scenarioDecision.rejoinBytes = rejoin.bytesRewound + rejoin.reinitializeBytes
      scenarioDecision.phase = 'outcome'
    }

    toast(
      unplanned
        ? `Failover complete: ${transition.lossBytes} bytes and ${transition.lossTransactions} committed write transactions lost; timeline ${ha.timeline.current} forked`
        : `Switchover complete after ${transition.waitSec.toFixed(1)} s: zero bytes and zero transactions lost`,
      unplanned ? 'warn' : 'good',
      8500,
    )
    bus.emit('narrate', {
      title: unplanned ? 'Two histories now exist' : 'Orderly handover complete',
      body: unplanned
        ? reinitializeNode
          ? `Timeline ${ha.timeline.current} forked from timeline ${ha.timeline.parent} at ${fmtLsn(forkLsn)}. The former primary needs pg_rewind, and ${state.cluster.nodes[clusterNodeIndex(reinitializeNode)].name} replayed beyond the fork, so PostgreSQL refuses the new timeline until Patroni rewinds or reinitialises that follower. No healthy standby remains.`
          : `Timeline ${ha.timeline.current} forked from timeline ${ha.timeline.parent} at ${fmtLsn(forkLsn)}. The old history continues for ${transition.lossBytes} bytes that the new primary never received: ${transition.lossTransactions} committed write transactions are lost. The former primary cannot follow this new history until pg_rewind discards its divergent tail.`
        : `Patroni waited ${transition.waitSec.toFixed(1)} seconds for the standby, then compare-and-swapped the leader key and moved the service address. Zero bytes and zero transactions were lost.`,
      seconds: 12,
    })
    bus.emit('focus', { id: 'timeline.yard' })
    bus.emit('select', { id: 'timeline.yard' })
  }

  function setLinks(
    links: [boolean, boolean, boolean],
    first: boolean,
    second: boolean,
    third: boolean,
  ): void {
    links[0] = first
    links[1] = second
    links[2] = third
  }

  function selectRaftLeader(next: 'etcd1' | 'etcd2' | 'etcd3' | null): void {
    const dcs = ha.patroni.dcs
    if (dcs.leaderMember !== next) dcs.term++
    dcs.leaderMember = next
    for (let i = 0; i < dcs.members.length; i++) {
      const member = dcs.members[i]
      member.role = next === null ? 'candidate' : member.id === next ? 'leader' : 'follower'
      if (member.inCommitMajority) member.term = dcs.term
    }
  }

  function configureHaPartition(): void {
    const agents = ha.patroni.agents
    const members = ha.patroni.dcs.members
    const mode = K.haPartition

    if (mode === 'healthy') {
      for (let i = 0; i < 3; i++) {
        setLinks(agents[i].reachableDcsMembers, true, true, true)
        agents[i].canReachConsensus = true
        setLinks(members[i].reachableMembers, true, true, true)
        members[i].inCommitMajority = true
      }
      ha.patroni.dcs.canCommit = true
      selectRaftLeader(ha.patroni.dcs.leaderMember ?? 'etcd1')
      return
    }

    if (mode === 'isolate_node') {
      setLinks(agents[0].reachableDcsMembers, false, false, false)
      agents[0].canReachConsensus = false
      for (let i = 1; i < 3; i++) {
        setLinks(agents[i].reachableDcsMembers, false, true, true)
        agents[i].canReachConsensus = true
      }
      setLinks(members[0].reachableMembers, true, false, false)
      setLinks(members[1].reachableMembers, false, true, true)
      setLinks(members[2].reachableMembers, false, true, true)
      members[0].inCommitMajority = false
      members[1].inCommitMajority = true
      members[2].inCommitMajority = true
      ha.patroni.dcs.canCommit = true
      selectRaftLeader('etcd2')
      return
    }

    if (mode === 'isolate_dcs_majority') {
      setLinks(agents[0].reachableDcsMembers, true, false, false)
      agents[0].canReachConsensus = false
      for (let i = 1; i < 3; i++) {
        setLinks(agents[i].reachableDcsMembers, false, true, true)
        agents[i].canReachConsensus = true
      }
      setLinks(members[0].reachableMembers, true, false, false)
      setLinks(members[1].reachableMembers, false, true, true)
      setLinks(members[2].reachableMembers, false, true, true)
      members[0].inCommitMajority = false
      members[1].inCommitMajority = true
      members[2].inCommitMajority = true
      ha.patroni.dcs.canCommit = true
      selectRaftLeader('etcd2')
      return
    }

    setLinks(agents[0].reachableDcsMembers, true, false, false)
    setLinks(agents[1].reachableDcsMembers, false, true, false)
    setLinks(agents[2].reachableDcsMembers, false, false, true)
    for (let i = 0; i < 3; i++) agents[i].canReachConsensus = false
    setLinks(members[0].reachableMembers, true, false, false)
    setLinks(members[1].reachableMembers, false, true, false)
    setLinks(members[2].reachableMembers, false, false, true)
    for (let i = 0; i < 3; i++) members[i].inCommitMajority = false
    ha.patroni.dcs.canCommit = false
    selectRaftLeader(null)
  }

  function applyCommittedDcsEntry(): void {
    const dcs = ha.patroni.dcs
    for (let i = 0; i < dcs.members.length; i++) {
      const member = dcs.members[i]
      if (!member.inCommitMajority) continue
      member.term = dcs.term
      member.commitIndex = dcs.commitIndex
      member.appliedLeaderKey = dcs.leaderKey.value
      member.appliedRevision = dcs.leaderKey.revision
    }
  }

  function flowRaftCommit(): void {
    const dcs = ha.patroni.dcs
    const leader = dcs.leaderMember
    if (leader === 'etcd1') {
      if (dcs.members[0].reachableMembers[1]) flow('ha.raft12', 1, 'stat', 0.72)
      if (dcs.members[0].reachableMembers[2]) flow('ha.raft13', 1, 'stat', 0.72)
    } else if (leader === 'etcd2') {
      if (dcs.members[1].reachableMembers[0]) flow('ha.raft12', 1, 'stat', 0.72)
      if (dcs.members[1].reachableMembers[2]) flow('ha.raft23', 1, 'stat', 0.72)
    } else if (leader === 'etcd3') {
      if (dcs.members[2].reachableMembers[0]) flow('ha.raft13', 1, 'stat', 0.72)
      if (dcs.members[2].reachableMembers[1]) flow('ha.raft23', 1, 'stat', 0.72)
    }
  }

  function observeCommittedLeaderKey(result: 'observed' | 'renewed'): void {
    const dcs = ha.patroni.dcs
    const visibleValue = dcs.leaderKey.leaseValid ? dcs.leaderKey.value : null
    for (let i = 0; i < ha.patroni.agents.length; i++) {
      const agent = ha.patroni.agents[i]
      if (!agent.canReachConsensus) continue
      agent.observedLeaderKey = visibleValue
      agent.observedTerm = dcs.term
      agent.leaseRemainingSec = dcs.leaderKey.leaseRemainingSec
      agent.lastDcsResult = result === 'renewed' && agent.nodeId === visibleValue
        ? 'renewed'
        : 'observed'
    }
  }

  function recordFailedDcsViews(): void {
    for (let i = 0; i < ha.patroni.agents.length; i++) {
      const agent = ha.patroni.agents[i]
      if (agent.canReachConsensus) continue
      const links = agent.reachableDcsMembers
      agent.lastDcsResult = links[0] || links[1] || links[2]
        ? 'no_consensus'
        : 'unreachable'
      if (agent.leaseRemainingSec <= 0) agent.observedLeaderKey = null
    }
  }

  function commitLeaderKeyCompareAndSwap(
    expected: ClusterNodeId | null,
    target: ClusterNodeId,
  ): boolean {
    const dcs = ha.patroni.dcs
    const key = dcs.leaderKey
    const current = key.leaseValid ? key.value : null
    if (!canCommitFor(target) || current !== expected) return false
    dcs.commitIndex++
    key.value = target
    key.leaseValid = true
    key.leaseRemainingSec = key.ttlSec
    key.revision++
    key.compareAndSwapCount++
    key.lastOperation = 'compare-and-swap'
    applyCommittedDcsEntry()
    flowRaftCommit()
    observeCommittedLeaderKey('observed')
    const targetAgent = patroniAgent(target)
    targetAgent.lastDcsResult = 'compare_and_swap_committed'
    return true
  }

  function commitLeaderKeyRenewal(leaderId: ClusterNodeId): void {
    const dcs = ha.patroni.dcs
    const key = dcs.leaderKey
    if (
      !canCommitFor(leaderId)
      || !key.leaseValid
      || key.value !== leaderId
    ) return
    dcs.commitIndex++
    key.leaseRemainingSec = key.ttlSec
    key.lastOperation = 'renew'
    applyCommittedDcsEntry()
    flowRaftCommit()
    observeCommittedLeaderKey('renewed')
    const route = leaderId === 'primary'
      ? 'ha.lease1'
      : leaderId === 'standbyA'
        ? 'ha.lease2'
        : 'ha.lease3'
    flow(route, 1, 'stat', 0.9)
  }

  function commitLeaderLeaseExpiry(): void {
    const dcs = ha.patroni.dcs
    const key = dcs.leaderKey
    key.leaseValid = false
    key.leaseRemainingSec = 0
    key.lastOperation = 'lease-expired'
    if (!dcs.canCommit || key.value === null) return
    dcs.commitIndex++
    key.value = null
    key.revision++
    applyCommittedDcsEntry()
    flowRaftCommit()
    observeCommittedLeaderKey('observed')
  }

  function demoteExpiredLeader(): ClusterNodeId | null {
    const leaderId = ha.currentLeader
    if (!leaderId) return null
    const leader = state.cluster.nodes[clusterNodeIndex(leaderId)]
    const agent = patroniAgent(leaderId)
    leader.role = 'standby'
    leader.leaderOpinion = null
    agent.observedLeaderKey = null
    agent.leaseRemainingSec = 0
    agent.demotions++
    ha.currentLeader = null
    ha.patroni.demotions++
    ha.acceptingWrites = false
    pendingTx = 0
    clearArrivalQueue()
    toast(
      'Patroni lease TTL expired: the node demoted itself; only a committed leader-key compare-and-swap can promote a rival',
      'warn',
      7500,
    )
    return leaderId
  }

  function promoteAfterPartition(sourceId: ClusterNodeId): void {
    if (sourceId !== 'primary' || !canCommitFor('standbyA')) return
    const target = standbyForNode('standbyA')
    if (!target.enabled || !state.cluster.nodes[1].online) return
    resetTransition('failover', sourceId, 'standbyA')
    ha.transition.startedAt = state.t - ha.patroni.dcs.leaderKey.ttlSec
    stopPrimaryAndStreams()
    completePromotion(true, K.haPartition === 'isolate_dcs_majority')
  }

  function resumePrimaryAfterConsensusPause(): void {
    if (
      K.haPartition !== 'healthy'
      || ha.currentLeader !== null
      || ha.transition.status === 'waiting'
      || ha.rejoin.required
      || !state.cluster.nodes[0].online
      || !commitLeaderKeyCompareAndSwap(null, 'primary')
    ) return
    const primary = state.cluster.nodes[0]
    primary.role = 'primary'
    primary.leaderOpinion = 'primary'
    for (let i = 1; i < state.cluster.nodes.length; i++) {
      state.cluster.nodes[i].role = 'standby'
      state.cluster.nodes[i].leaderOpinion = 'primary'
    }
    ha.currentLeader = 'primary'
    ha.acceptingWrites = true
  }

  function tickPatroni(dt: number): void {
    const dcs = ha.patroni.dcs
    const key = dcs.leaderKey
    if (key.leaseValid) {
      key.leaseRemainingSec = Math.max(0, key.leaseRemainingSec - dt)
    }
    for (let i = 0; i < ha.patroni.agents.length; i++) {
      const agent = ha.patroni.agents[i]
      if (agent.observedLeaderKey !== null) {
        agent.leaseRemainingSec = Math.max(0, agent.leaseRemainingSec - dt)
      }
    }

    patroniRenewT += dt
    if (patroniRenewT >= ha.patroni.renewEverySec) {
      patroniRenewT -= ha.patroni.renewEverySec
      const leaderId = ha.currentLeader
      const leaderOnline = leaderId !== null
        && state.cluster.nodes[clusterNodeIndex(leaderId)].online
      if (leaderId && leaderOnline) commitLeaderKeyRenewal(leaderId)
      else observeCommittedLeaderKey('observed')
      recordFailedDcsViews()
    }

    if (key.leaseValid && key.leaseRemainingSec <= 0) {
      commitLeaderLeaseExpiry()
    } else if (!key.leaseValid && key.value !== null && dcs.canCommit) {
      commitLeaderLeaseExpiry()
    }

    const leaderId = ha.currentLeader
    if (leaderId) {
      const agent = patroniAgent(leaderId)
      if (agent.leaseRemainingSec <= 0 || !key.leaseValid) {
        const expired = demoteExpiredLeader()
        if (
          ha.transition.kind === 'failover'
          && ha.transition.status === 'waiting'
          && ha.transition.target
          && ha.transition.target !== 'primary'
        ) {
          completePromotion(true)
        } else if (
          expired
          && (K.haPartition === 'isolate_node' || K.haPartition === 'isolate_dcs_majority')
        ) {
          promoteAfterPartition(expired)
        }
      }
    } else {
      resumePrimaryAfterConsensusPause()
    }
  }

  function startPgRewind(): boolean {
    const rejoin = ha.rejoin
    if (
      !rejoin.required
      || rejoin.node !== 'primary'
      || rejoin.status === 'checking'
      || rejoin.status === 'rewinding'
      || rejoin.status === 'complete'
    ) {
      toast(
        rejoin.status === 'complete' && rejoin.reinitializeRequired
          ? 'pg_rewind repaired the former primary; the ahead follower still requires reinitialisation'
          : rejoin.required
            ? 'pg_rewind is already running'
          : 'pg_rewind has no divergent former primary to repair',
        'warn',
        5500,
      )
      return false
    }
    rejoin.status = 'checking'
    rejoin.progress = 0
    rejoin.startedAt = state.t
    rejoin.elapsedSec = 0
    rejoin.bytesRewound = Math.max(
      0,
      ha.timeline.oldHistoryEndLsn - ha.timeline.forkLsn,
    )
    rejoin.bytesCopied = 0
    rejoin.estimatedDurationSec =
      REWIND_CHECK_SECONDS
      + Math.max(4, rejoin.bytesRewound / REWIND_BYTES_PER_SEC)
    rejoin.failureReason = ''
    toast(
      'pg_rewind started: locating the divergence point and checking required WAL',
      'info',
      5500,
    )
    bus.emit('narrate', {
      title: 'The old primary cannot simply rejoin',
      body: 'Its WAL describes a history the new primary never had. pg_rewind first finds the common point and verifies the old data directory, block-change tracking, and required WAL; only then can it discard changed blocks and follow the new timeline.',
      seconds: 10,
    })
    bus.emit('focus', { id: 'ha.rejoin' })
    bus.emit('select', { id: 'ha.rejoin' })
    return true
  }

  function failPgRewind(reason: string): void {
    const rejoin = ha.rejoin
    rejoin.status = 'failed'
    rejoin.failureReason = reason
    rejoin.progress = Math.min(0.25, rejoin.elapsedSec / rejoin.estimatedDurationSec)
    toast(reason, 'warn', 8000)
    bus.emit('narrate', {
      title: 'pg_rewind failed',
      body: `${reason}. This node still cannot rejoin; rebuild it from a fresh base backup or restore the missing prerequisite.`,
      seconds: 10,
    })
  }

  function tickPgRewind(dt: number): void {
    const rejoin = ha.rejoin
    if (rejoin.status !== 'checking' && rejoin.status !== 'rewinding') return
    rejoin.elapsedSec += dt
    if (rejoin.status === 'checking') {
      rejoin.progress = Math.min(
        0.25,
        (rejoin.elapsedSec / REWIND_CHECK_SECONDS) * 0.25,
      )
      if (rejoin.elapsedSec < REWIND_CHECK_SECONDS) return
      if (!K.oldPrimaryDataIntact) {
        failPgRewind('pg_rewind failed: the former primary data directory is missing or unreadable')
        return
      }
      if (!rejoin.blockChangeTrackingAvailable) {
        failPgRewind('pg_rewind failed: data checksums are off and wal_log_hints was not enabled before divergence')
        return
      }
      if (!K.rewindWalRetained) {
        failPgRewind('pg_rewind failed: required WAL before the divergence point has already been recycled')
        return
      }
      rejoin.status = 'rewinding'
    }

    const copyDuration = rejoin.estimatedDurationSec - REWIND_CHECK_SECONDS
    const copyElapsed = Math.max(0, rejoin.elapsedSec - REWIND_CHECK_SECONDS)
    const copyProgress = Math.min(1, copyElapsed / copyDuration)
    rejoin.bytesCopied = Math.round(rejoin.bytesRewound * copyProgress)
    rejoin.progress = 0.25 + copyProgress * 0.75
    if (copyProgress < 1) return

    const node = state.cluster.nodes[0]
    node.role = 'standby'
    node.online = true
    node.leaderOpinion = ha.currentLeader
    node.wal.receivedLsn = wal.insertLsn
    node.wal.writtenLsn = wal.writeLsn
    node.wal.flushedLsn = wal.flushLsn
    node.wal.appliedLsn = wal.insertLsn
    node.dataDirectory.appliedLsn = wal.insertLsn
    rejoin.status = 'complete'
    rejoin.progress = 1
    rejoin.bytesCopied = rejoin.bytesRewound
    rejoin.required = rejoin.reinitializeRequired
    rejoin.failureReason = ''
    toast(
      `pg_rewind completed in ${rejoin.elapsedSec.toFixed(1)} s; the former primary can now follow timeline ${ha.timeline.current}`,
      'good',
      7500,
    )
    bus.emit('narrate', {
      title: 'Former primary repaired',
      body: `pg_rewind took ${rejoin.elapsedSec.toFixed(1)} seconds. It returned the old data directory to the common history, discarded the divergent tail, and the node now follows timeline ${ha.timeline.current} as a standby.`,
      seconds: 9,
    })
  }

  function finishFollowerReinitialize(): void {
    const rejoin = ha.rejoin
    const id = rejoin.reinitializeNode
    if (id !== 'standbyA' && id !== 'standbyB') return
    const index = id === 'standbyA' ? 0 : 1
    const standby = rep.standbys[index]
    const node = state.cluster.nodes[index + 1]
    const lsn = wal.flushLsn

    standby.sentLsn = standby.receivedLsn = standby.writtenLsn = lsn
    standby.flushedLsn = standby.appliedLsn = lsn
    standby.acknowledgedWriteLsn = standby.acknowledgedFlushLsn =
      standby.acknowledgedApplyLsn = lsn
    standby.connected = standby.enabled
    standby.inFlight = 0
    standby.walSender = standby.enabled ? 'streaming' : 'stopped'
    standby.walReceiver = standby.enabled ? 'streaming' : 'stopped'
    standby.startupProcess = standby.enabled ? 'streaming' : 'stopped'
    resetPhysicalRuntime(physicalRuntime[index], lsn)

    node.role = 'standby'
    node.online = standby.enabled
    node.leaderOpinion = ha.currentLeader
    node.wal.receivedLsn = lsn
    node.wal.writtenLsn = lsn
    node.wal.flushedLsn = lsn
    node.wal.appliedLsn = lsn
    node.dataDirectory.appliedLsn = lsn

    rejoin.reinitializeCopiedBytes = rejoin.reinitializeBytes
    rejoin.reinitializeRequired = false
    rejoin.required = rejoin.status !== 'complete'
    toast(
      `${node.name} reinitialised from ${fmtBytes(rejoin.reinitializeBytes)} of base-backup data and can follow timeline ${ha.timeline.current}`,
      'good',
      7500,
    )
  }

  function tickHighAvailability(dt: number): void {
    tickPatroni(dt)
    const transition = ha.transition
    if (transition.status === 'waiting') {
      transition.waitSec = Math.max(0, state.t - transition.startedAt)
      if (
        transition.kind === 'switchover'
        && transition.target
        && transition.target !== 'primary'
      ) {
        const target = standbyForNode(transition.target)
        if (
          transition.waitSec >= 0.5
          && wal.insertLsn === wal.flushLsn
          && target.flushedLsn >= wal.flushLsn
          && target.inFlight === 0
        ) {
          completePromotion(false)
        }
      }
    }
    tickPgRewind(dt)
  }

  /* ======================================================================
   * PLAN TREES
   * ====================================================================*/

  function pn(label: string, detail: string, rows: number, cost: number, children: PlanNode[]): PlanNode {
    return { id: planSeq++, label, detail, rows: Math.max(1, Math.round(rows)), cost: Math.round(cost * 100) / 100, actualMs: 0, children, activity: 0 }
  }

  function buildPlan(kind: QueryKind, ti: number, seq: boolean, rows: number): PlanNode {
    const t = tables[ti]
    const name = t.def.name
    const live = t.liveTuples
    const ix = t.def.indexes
    const pkey = ix[0].name
    const alt = ix.length > 1 ? ix[1].name : ix[0].name
    const diskRunCost = t.pages * 1.0
    const cpuRunCost = live * 0.01
    const seqCost = diskRunCost + cpuRunCost

    switch (kind) {
      case 'select_idx': {
        // Retiring random plan shapes must not re-roll the seeded workload that
        // follows this plan; preserve the former shape draw as a sequence guard.
        rng()
        return pn('Index Scan', `using ${pkey} on ${name}  (Index Cond: id = $1)`, 1, 0.67, [])
      }
      case 'select_seq': {
        // Preserve both draws the former random Sort branch consumed while SQL,
        // rather than chance, now decides whether the Sort exists.
        const retiredShapeRoll = rng()
        const sortMemoryRoll = retiredShapeRoll < 0.45 ? rng() : retiredShapeRoll
        const filter = name === 'events'
          ? 'payload @> $1'
          : name === 'sessions'
            ? 'expires_at > $1'
            : name === 'orders'
              ? 'created_at > $1'
              : name === 'documents'
                ? "search @@ plainto_tsquery('english', $1)"
                : 'updated_at > $1'
        const s = pn('Seq Scan', `on ${name}  (Filter: ${filter}; row figures are display-only)`, rows, seqCost, [])
        if (name === 'events') {
          const so = pn('Sort', `(Sort Key: created_at DESC; fixed teaching node; display seed ${Math.round(28 + sortMemoryRoll * 60)})`, rows, seqCost * 1.1, [s])
          return pn('Limit', `(display rows=${Math.round(rows)})`, rows, seqCost * 1.12, [so])
        }
        return s
      }
      case 'aggregate': {
        // cost_seqscan() divides only CPU cost across parallel participants;
        // the operating system's read-ahead already amortizes the disk run.
        const parallelSeqCost = diskRunCost + cpuRunCost / 3
        const ps = pn('Parallel Seq Scan', `on ${name}  (illustrative shape; no parallel workers modeled)`, live / 3, parallelSeqCost, [])
        const pa = pn('Partial HashAggregate', '(Group Key: status; fixed teaching node)', 12, parallelSeqCost + 80, [ps])
        if (rng() < 0.5) {
          const gather = pn('Gather', '(illustrative shape; no workers launched)', 36, parallelSeqCost + 140, [pa])
          return pn('Finalize HashAggregate', '(Group Key: status; fixed teaching node)', 12, parallelSeqCost + 190, [gather])
        }
        // create_gather_merge_path() rejects a subpath without matching pathkeys.
        const sortMemory = Math.round(180 + rng() * 900)
        const sort = pn('Sort', `(Sort Key: status; fixed teaching node; display seed ${sortMemory})`, 12, parallelSeqCost + 120, [pa])
        const gatherMerge = pn('Gather Merge', '(illustrative shape; no workers launched)', 36, parallelSeqCost + 180, [sort])
        return pn('Finalize GroupAggregate', '(Group Key: status)', 12, parallelSeqCost + 230, [gatherMerge])
      }
      case 'insert': {
        const src = pn('Values Scan', 'on "*VALUES*"', rows, 0.01 * rows, [])
        return pn('Insert', `on ${name}  (${ix.length} index${ix.length > 1 ? 'es' : ''} to maintain)`, rows, 0.02 * rows + 0.5, [src])
      }
      case 'update': {
        const child = seq
          ? pn('Seq Scan', `on ${name}  (Filter: expires_at < now())`, rows, seqCost, [])
          : pn('Index Scan', `using ${pkey} on ${name}  (Index Cond: id = ANY ($1))`, rows, 0.42 + rows * 0.3, [])
        return pn('Update', `on ${name}`, rows, (seq ? seqCost : rows * 0.4) + 1.2, [child])
      }
      case 'delete': {
        const bi = pn('Bitmap Index Scan', `on ${alt}  (Index Cond: expires_at < now())`, rows * 1.3, 4 + rows * 0.02, [])
        const bh = pn('Bitmap Heap Scan', `on ${name}`, rows, 14 + rows * 0.3, [bi])
        return pn('Delete', `on ${name}`, rows, 16 + rows * 0.35, [bh])
      }
    }
  }

  /** Post-order flatten: children get their activity window before parents. */
  function flatten(node: PlanNode, out: PlanNode[]): void {
    for (let i = 0; i < node.children.length; i++) flatten(node.children[i], out)
    out.push(node)
  }

  function planWindows(x: Extra): void {
    const n = x.planFlat.length
    x.planStart.length = 0
    x.planEnd.length = 0
    for (let i = 0; i < n; i++) {
      const s = n === 1 ? 0 : (i / n) * 0.72
      x.planStart.push(s)
      x.planEnd.push(Math.min(1, s + 0.45))
    }
  }

  function tickPlan(x: Extra, p: number, dt: number): void {
    const n = x.planFlat.length
    for (let i = 0; i < n; i++) {
      const node = x.planFlat[i]
      const s = x.planStart[i]
      const e = x.planEnd[i]
      const u = (p - s) / Math.max(1e-4, e - s)
      const a = u < 0 ? 0 : u > 1 ? 0.12 : Math.sin(Math.PI * u) * 0.88 + 0.12
      node.activity = a
      if (a > 0.14) node.actualMs += dt * 1000 * a
    }
  }

  function workMemWorkingSet(node: PlanNode, query: QueryKind): number {
    if (node.label === 'Partial HashAggregate') {
      return CLAIM_VALUES.workMem.spillExample.partialHashWorkingSetMiB * MIB
    }
    if (node.label === 'Finalize HashAggregate') {
      return CLAIM_VALUES.workMem.spillExample.finalizeHashWorkingSetMiB * MIB
    }
    if (node.label === 'Sort') {
      return query === 'aggregate'
        ? CLAIM_VALUES.workMem.spillExample.aggregateSortWorkingSetMiB * MIB
        : CLAIM_VALUES.workMem.spillExample.partialHashWorkingSetMiB * MIB
    }
    return 0
  }

  /** Price only fixed Sort/HashAggregate nodes; work_mem never selects a plan. */
  function configureWorkMem(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    b.workMemNodes = 0
    b.workMemSortNodes = 0
    b.workMemHashNodes = 0
    b.workMemAllowanceBytes = 0
    b.workMemUsedBytes = 0
    b.workMemSpillNodes = 0
    b.tempFileBytes = 0
    x.workMemCountersRecorded = false

    const sortAllowance = K.workMem * MIB
    const hashAllowance = sortAllowance * WORK_MEM_HASH_MULTIPLIER
    for (let i = 0; i < x.planFlat.length; i++) {
      const node = x.planFlat[i]
      const workingSet = workMemWorkingSet(node, b.query)
      if (workingSet <= 0) continue
      const hash = node.label.includes('HashAggregate')
      const allowance = hash ? hashAllowance : sortAllowance
      const spilled = workingSet > allowance
      const retained = Math.min(workingSet, allowance)
      b.workMemNodes++
      if (hash) b.workMemHashNodes++
      else b.workMemSortNodes++
      b.workMemAllowanceBytes += allowance
      b.workMemUsedBytes += retained
      if (spilled) {
        b.workMemSpillNodes++
        b.tempFileBytes += workingSet
      }

      const workingKiB = Math.round(workingSet / 1024)
      const retainedKiB = Math.round(retained / 1024)
      if (hash) {
        const batches = Math.max(2, Math.ceil(workingSet / allowance))
        node.detail += spilled
          ? `; Batches: ${batches}  Memory Usage: ${retainedKiB}kB  Disk Usage: ${workingKiB}kB`
          : `; Batches: 1  Memory Usage: ${workingKiB}kB`
      } else {
        node.detail += spilled
          ? `; Sort Method: external merge  Disk: ${workingKiB}kB`
          : `; Sort Method: quicksort  Memory: ${workingKiB}kB`
      }
    }
  }

  function beginWorkMem(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    b.state = 'sort'
    b.stateT = 0
    const inMemoryDuration = rr(0.12, 0.34)
    // The fixed teaching example makes the spill trip approximately 10× its
    // in-memory twin. visitT is the work already paid; the final 75 ms is the
    // representative send phase both twins still have ahead of them.
    const fittedTripEstimate = x.visitT + inMemoryDuration + 0.075
    b.stateDur = inMemoryDuration
      + (b.workMemSpillNodes > 0 ? fittedTripEstimate * WORK_MEM_SPILL_PENALTY : 0)
    if (b.workMemSpillNodes === 0 || x.workMemCountersRecorded) return

    x.workMemCountersRecorded = true
    state.workMem.tempFiles += b.workMemSpillNodes * x.txCount
    state.workMem.tempBytes += b.tempFileBytes * x.txCount
    if (state.t - workMemWarnT > 15) {
      workMemWarnT = state.t
      toast(
        `${b.workMemSpillNodes} work_mem node${b.workMemSpillNodes === 1 ? '' : 's'} spilled ${fmtBytes(b.tempFileBytes)} per statement to base/pgsql_tmp`,
        'warn',
        5000,
      )
    }
  }

  /* ======================================================================
   * BACKENDS
   * ====================================================================*/

  function pickBlk(ti: number, mode: 'hot' | 'append' | 'scan', x?: Extra, forWrite = false): number {
    const t = tables[ti]
    if (mode === 'append') {
      // inserts go to the tail page unless the FSM has holes to fill
      if (t.bloat > 0.15 && rng() < 0.6) return Math.floor(t.pages * rng())
      return Math.max(0, t.pages - 1 - Math.floor(rng() * 2))
    }
    if (mode === 'scan' && x) return scanBlkOf(t, x.scanBlk++)
    // Reads mix a compact hot set with a relation-wide cold tail. Writes add a
    // repeating middle band: checkpoints can amortise its first-touch images,
    // while the uniform cold tail remains the irreducible floor.
    const band = rng()
    const u = rng()
    if (!forWrite) {
      if (band < HEAP_HOT_READ_SHARE) return Math.floor(hotPages[ti] * u * u)
      return Math.floor(t.pages * u)
    }
    if (band < HEAP_HOT_WRITE_SHARE) return Math.floor(hotPages[ti] * u * u)
    if (band < HEAP_HOT_WRITE_SHARE + HEAP_WARM_WRITE_SHARE) {
      return Math.min(
        t.pages - 1,
        hotPages[ti] + Math.floor(warmPages[ti] * u * u),
      )
    }
    return Math.floor(t.pages * u)
  }

  /**
   * Index blocks live past the heap, in a key space no heap page can reach.
   * A btree on a hot relation is small and stays resident: the leaf level is
   * reached through a descent that touches root and inner pages every time, so
   * the *distinct* leaves a workload visits are a small fraction of the index —
   * which is why `idx_blks_hit` is very nearly all of `idx_blks_read + hit` on a
   * healthy server, and why an index scan almost never reaches storage.
   */
  function idxBlk(ti: number, level: 0 | 1 | 2, forWrite = false): number {
    const base = IDX_BASE
    if (level === 0) return base // root — always cached
    if (level === 1) return base + 1 + Math.floor(rng() * 4)
    const roll = rng()
    if (forWrite) {
      const u = rng()
      if (roll < HEAP_HOT_WRITE_SHARE) {
        return base + 8 + Math.floor(hotIdxPages[ti] * u * u)
      }
      if (roll < HEAP_HOT_WRITE_SHARE + HEAP_WARM_WRITE_SHARE) {
        return base
          + 8
          + hotIdxPages[ti]
          + Math.floor(warmIdxPages[ti] * u * u)
      }
      return base + 8 + Math.floor(idxPages[ti] * u)
    }
    const hot = roll < INDEX_HOT_SHARE
    const skewed = hot
      ? roll / INDEX_HOT_SHARE
      : (roll - INDEX_HOT_SHARE) / (1 - INDEX_HOT_SHARE)
    const pages = hot ? hotIdxPages[ti] : idxPages[ti]
    return base + 8 + Math.floor(pages * skewed * skewed)
  }

  function startVisit(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const requested = traceQueue.length > 0
      && traceQueue[0].announced
      && traceQueue[0].readyT < state.t
      ? traceQueue.shift()
      : undefined
    const randomPending = K.poolMode === 'session'
      ? sessionPendingTx[slot]
      : Math.max(0, pendingTx - traceQueue.length)
    const take = requested ? 1 : Math.max(1, Math.min(randomPending, batchSize))
    const multiplexedPoolWait = requested || K.poolMode === 'session'
      ? 0
      : dequeueArrivals(take)
    const poolSlotWait = usesMultiplexedPoolQueue(K.poolMode)
      ? multiplexedPoolWait
      : K.poolMode === 'session'
        ? x.nextSessionPoolWaitT
        : 0
    pendingTx -= take
    if (!requested && K.poolMode === 'session') {
      sessionPendingTx[slot] -= take
      queuedSessionTx -= take
    }
    x.nextSessionPoolWaitT = 0
    x.txCount = take
    x.latencyCount = take

    // pick the statement
    let kind: QueryKind
    let ti: number
    if (requested) {
      kind = requested.kind
      ti = requested.table
      state.trace.slot = slot
    } else if (scenarioQueryKind && scenarioQueryTable >= 0) {
      kind = scenarioQueryKind
      ti = scenarioQueryTable
    } else if (rng() < K.writeRatio) {
      // Steady state: rows that leave have to be replaced. The workload tilts
      // towards inserts exactly as far as the tables are short of their natural
      // size, and not at all when they are not. See tickTables().
      if (rng() < K.updateRatio * (1 - 0.95 * liveDeficit)) {
        kind = rng() < 0.22 ? 'delete' : 'update'
        ti = weightedPick(wUpd, rng)
      } else {
        kind = 'insert'
        ti = weightedPick(wIns, rng)
      }
    } else if (rng() < K.seqScanRatio) {
      // Analytics against an OLTP database are rare and expensive; ordinary
      // seq scans are common and small.
      if (rng() < SMALL_SEQ_SCAN_SHARE) {
        kind = 'select_seq'
        backgroundSeqScans++
        const cadenceRoll = rng()
        if (backgroundSeqScans >= nextWideSeqScan) {
          ti = documentsSeqTable
          nextWideSeqScan = backgroundSeqScans + 450 + Math.floor(cadenceRoll * 101)
        } else {
          ti = sessionsSeqTable
        }
      }
      else { kind = 'aggregate'; ti = weightedPick(wAgg, rng) }
    } else {
      kind = 'select_idx'
      ti = weightedPick(wRead, rng)
    }

    b.query = kind
    b.table = ti
    // backend_xid is assigned lazily, at the first write — a read-only
    // transaction never consumes a transaction id. See beginExec().
    b.xid = 0
    b.sql = requested?.sql || sqlFor(kind, ti)
    b.rowsSent = 0
    b.buffersTouched = 0
    b.buffersHit = 0
    b.buffersRead = 0
    b.walBytes = 0
    b.walFpiBytes = 0
    b.deadMade = 0
    b.workMemNodes = 0
    b.workMemSortNodes = 0
    b.workMemHashNodes = 0
    b.workMemAllowanceBytes = 0
    b.workMemUsedBytes = 0
    b.workMemSpillNodes = 0
    b.tempFileBytes = 0
    b.waitOn = -1
    b.plan = null
    x.fpiBytes = 0
    x.walPending = 0
    x.walPendingFpi = 0
    x.walPrepared = false
    x.evictionBuffer = -1
    x.evictionFlushLsn = 0
    x.visitT = poolSlotWait
    x.poolSlotWaitT = poolSlotWait
    x.bufferReadWaitT = 0
    x.dirtyWriteWaitT = 0
    x.dirtyWriteDuringReadT = 0
    x.tempFileWaitT = 0
    x.evictionWalWaitT = 0
    x.commitWaitT = 0
    x.lockWaitT = 0
    x.workMemCountersRecorded = false
    x.idleT = 0
    x.writes = kind === 'insert' || kind === 'update' || kind === 'delete'
    x.seqScan = kind === 'select_seq' || kind === 'aggregate'
    // SQL now decides whether the trace sorts. Preserve the former seeded
    // branch as predicate CPU so correcting the plan does not make that work or
    // its later workload sequence disappear.
    const retiredSortRoll = kind === 'select_seq' ? rng() : 1
    x.needsSort = kind === 'aggregate' || (kind === 'select_seq' && TABLES[ti].id === 'events')
    x.postFilterCpu =
      kind === 'select_seq'
      && TABLES[ti].id !== 'events'
      && retiredSortRoll < 0.45
    x.hot = kind === 'update'
      && (requested?.hot ?? (rng() < TABLES[ti].hotFriendly && tables[ti].bloat < 0.55))
    // A primary-key lookup still samples a bound id from the workload even
    // though the unique index fixes its result cardinality at one row.
    let uniqueLookupRows = 0
    if (kind === 'select_idx') {
      rng()
      uniqueLookupRows = 1
    }
    x.rowsPerStmt =
      kind === 'insert' ? 1 + Math.floor(rng() * 4)
      : kind === 'update' ? 2 + Math.floor(rng() * 10)
      : kind === 'delete' ? 1 + Math.floor(rng() * 18)
      : kind === 'select_idx' ? uniqueLookupRows
      : 20 + Math.floor(rng() * 400)

    if (x.writes && dr.archive.writesBlocked) {
      dr.archive.rejectedWrites += x.txCount
      stats.rollbacks += x.txCount
      x.txCount = 0
      x.writes = false
      b.state = 'sending'
      b.stateT = 0
      b.stateDur = 0.05
      b.progress = 0
      if (state.t - archiveWriteWarnT > 5) {
        archiveWriteWarnT = state.t
        toast('Write rejected: the scaled pg_wal safety limit is full behind the stalled archive', 'warn', 5000)
      }
      return
    }

    b.state = 'parse'
    b.stateT = 0
    b.stateDur = rr(0.02, 0.045)
    b.progress = 0
    // A fresh statement gets a fresh access strategy: the previous scan's ring
    // frames go back to the general pool and age out normally.
    const rbase = slot * RING
    for (let i = 0; i < RING; i++) ringBuf[rbase + i] = -1
    x.ringPos = 0
    x.scanBlk = 0

    if (++sBufReq >= 2) {
      sBufReq = 0
      flow(rid.query(slot), 1, 'query', 1.2)
    }
    flow('procarray.in', 1, 'stat', 0.8)
    syncTraceBackend(slot)
  }

  /** Work out how many pages this trip has to move and how long that takes. */
  function beginExec(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const ti = b.table
    const t = tables[ti]
    const nIdx = t.def.indexes.length

    // A transaction is assigned an xid the moment it first writes, and not
    // before. Read-only transactions hold a snapshot but consume no xid, which
    // is why `backend_xid` in pg_stat_activity is null for them.
    if (x.writes) {
      state.xid += x.txCount
      b.xid = state.xid
    }

    // Pages per statement. An index scan is a btree descent (root, inner, leaf)
    // plus the heap tuple; maintaining an index on write costs another descent
    // each. A sequential scan is sampled — the city cannot afford 5200 real
    // page requests per scan — but the cost still grows with the relation, which
    // is the part that matters.
    let perStmt: number
    switch (b.query) {
      case 'select_idx':
        perStmt = 3 + Math.min(8, x.rowsPerStmt)
        break
      // Both sequential kinds read the WHOLE relation — that is what makes them
      // sequential — so both push the same sampled walk through the pool, and
      // both cost what the relation costs. `aggregate` used to sample at
      // min(pages, 200), i.e. 48% of `sessions` against select_seq's 7% of the
      // same table: two statements reading identical blocks, one of them handing
      // the buffer pool seven times the traffic. What actually separates them is
      // which relations the query generator sends them to (ordinary scans
      // favour the small relation; wAgg favours large ones) and the sort/hash
      // `aggregate` runs on top.
      case 'select_seq':
      case 'aggregate':
        perStmt = scanGridN(t)
        break
      case 'insert':
        perStmt = 1 + 3 * nIdx + (t.def.toast ? 2 : 0)
        break
      case 'update':
        perStmt = 4 + (x.hot ? 0 : 3 * nIdx) + (t.def.toast ? 1 : 0)
        break
      case 'delete':
        perStmt = 4
        break
    }
    // The pages this trip really has to move. EVERY statement in the batch is
    // charged, sequential scans included: the file header's contract is that
    // "all work (pages touched, WAL bytes, dead tuples) is multiplied by that
    // batch, so the pool and the WAL see the real pressure", and exempting scans
    // broke it. The seq-scan share of buffer traffic then fell as 1/batch, so the
    // lifetime hit ratio became a function of the *tps* knob — measured 62.0% at
    // 10 tps rising to 88.7% at 3000 — and `seq_scan` in pg_stat_user_tables was
    // counted per statement while only one statement's worth of pages was pushed
    // through the pool.
    const work = perStmt * x.txCount
    // How much of that stream is actually pushed through the buffer pool. The
    // city cannot animate a hundred thousand page requests inside one trip, so
    // the *stream* is sampled — but only the stream. The cost is charged below
    // on the full `work`. The cap has to scale with the batch too, or it puts the
    // 1/batch dilution straight back: past MAX_VISIT_PAGES every further
    // transaction would contribute no pages at all.
    const cap = Math.max(MAX_VISIT_PAGES, 24 * x.txCount)
    // The CPU backstop accounts the unanimated tail of a scan statistically as
    // ring misses, so scan traffic keeps its full event weight at every batch.
    const total = x.seqScan ? work : Math.min(cap, work)
    x.pagesTotal = total
    x.pagesLeft = total
    x.execElapsed = 0

    const missFrac = clamp01(1 - buf.hitRatio)
    // Keep the floor — a trivial statement still costs something — but there is
    // no ceiling of any kind. Execution time has to stay proportional to the
    // work, or a big batch is free, the fleet has no capacity, and no amount of
    // offered load can ever saturate it. Clamping `dur` (the old
    // `clamp(…, 0.1, 1.5)`) and charging it on the SAMPLED page count are the
    // same defect wearing two hats: above MAX_VISIT_PAGES the second one made
    // every further transaction in the batch free, so achieved tps went on
    // climbing past the fleet's asymptote (measured 1.5k tps at 5,000 offered
    // but 9.2k at 50,000). Charge on `work`. `base` is the cost on an
    // unloaded device; ioPressure() adds what the queue in front of it costs.
    const base = Math.max(
      0.1,
      0.06 + work * (0.00035 + missFrac * missFrac * 0.007),
    )

    const ioShare = missFrac > 0.02 ? clamp(0.25 + missFrac * 0.6, 0.2, 0.85) : 0
    // Only the I/O half is stretched by device pressure, and that asymmetry is
    // the lesson: a query served out of shared_buffers barely notices a
    // checkpoint, and a query that has to reach storage queues behind every
    // page the checkpointer is pushing at it. Stretching the CPU half too would
    // make shared_buffers look useless during a checkpoint, which is backwards.
    const ioDur = base * ioShare * ioPressure()
    // Once most requests miss, random reads queue behind one another and the
    // cost per miss rises as well as the number of misses. Normalise around the
    // healthy ~40% miss point so the scale constant remains stable, while a
    // 32-frame thrash run pays the nonlinear latency a real device would.
    const cacheThrash = Math.max(0.65, (1 + 2 * missFrac) / 1.8)
    /* Rejected and pool-waiting clients do no PostgreSQL work. Only the
     * server processes actually connected here contribute pressure. */
    const concurrencyMultiplier = state.scenario === 'connection-storm'
      ? backendConcurrencyMultiplier(stats.activeBackends)
      : 1
    const dur = (ioDur + base * (1 - ioShare))
      * cacheThrash
      * concurrencyMultiplier
    x.execTotal = dur
    configureWorkMem(slot)

    const traced = traceRunning && state.trace.slot === slot
    if (ioShare > 0 || traced) {
      b.state = 'exec_io'
      b.stateDur = ioShare > 0 ? ioDur : Math.min(TRACE_FETCH_DUR, dur)
    } else {
      b.state = 'exec_cpu'
      b.stateDur = dur
    }
    b.stateT = 0
    b.progress = 0
    t.heat = Math.min(1, t.heat + 0.25)
    if (b.query === 'select_idx' || b.query === 'update' || b.query === 'delete') {
      t.idxScans += x.txCount
      if (++sIdx >= stride(stats.tps * 0.4, 20)) {
        sIdx = 0
        flow(rid.idxLookup(ti), 1, 'page_read', 0.9)
      }
    } else if (x.seqScan) {
      // Same unit as idxScans above: one backend trip carries x.txCount
      // statements, and both counters are per statement.
      t.seqScans += x.txCount
    }
    if (++sBufReq >= 2) {
      sBufReq = 0
      flow(rid.bufReq(slot), 1, 'query', 1.0)
      flow('bufmap.in', 1, 'stat', 0.8)
    }
  }

  /** Stream the page requests out over the exec states so the grid breathes. */
  function drainPages(slot: number, dt: number): void {
    const b = backends[slot]
    const x = extras[slot]
    if (x.pagesLeft <= 0) return
    const share = x.execTotal > 0 ? dt / x.execTotal : 1
    let n = Math.min(x.pagesLeft, Math.ceil(x.pagesTotal * share))
    if (n <= 0) return

    const ti = b.table
    const t = tables[ti]
    const nIdx = t.def.indexes.length
    const logicalBufferPages = Math.floor((K.sharedBuffers * MIB) / PAGE)
    const ring = x.seqScan && t.pages > logicalBufferPages / 4
    const write = x.writes
    const gridN = x.seqScan ? scanGridN(t) : 0

    if (n > pageBudget) {
      // CPU backstop: the city has a hard ceiling on buffer requests per second
      // (PAGE_OPS_PER_SEC), so the tail of a very large batch is accounted
      // statistically instead of being walked page by page.
      //
      // It must NOT be accounted at buf.hitRatio: that is the gauge this stream
      // feeds, so the backstop would confirm whatever the gauge already said and
      // the ratio would stop responding to the workload at exactly the loads
      // where the backstop fires. Use THIS statement's own measured rate on the
      // pages it did push through — a real observation of this access pattern —
      // and, before it has any, the structural rate for the access kind: a ring
      // scan of a relation larger than its 32-frame ring misses.
      const skipped = n - Math.max(0, Math.floor(pageBudget))
      n = Math.max(0, Math.floor(pageBudget))
      const seen = b.buffersTouched
      // A BAS_BULKREAD stream is the explicit cold-path case: pages skipped by
      // the CPU backstop are misses just like the pages we walked. Letting eight
      // early ring hits flip the whole statistical tail to "hit" made large
      // batches self-confirming and put the tps knob back into the hit ratio.
      const rate = ring ? 0 : seen >= 8 ? b.buffersHit / seen : clamp01(buf.hitRatio)
      const h = Math.round(skipped * rate)
      buf.hits += h
      buf.misses += skipped - h
      winHits += h
      winMisses += skipped - h
      ioReadAcc += skipped - h
      x.pagesLeft -= skipped
      b.buffersTouched += skipped
      b.buffersHit += h
      b.buffersRead += skipped - h
    }
    pageBudget -= n
    x.pagesLeft -= n

    for (let i = 0; i < n; i++) {
      let blk: number
      let forWrite = false
      if (x.seqScan) {
        // Each statement in the batch is its own scan, and initscan() calls
        // GetAccessStrategy() per scan: the ring belongs to the scan, not to the
        // backend. One grid wrap == one statement boundary, so hand the next
        // statement a fresh ring rather than letting it inherit the frames the
        // previous one was recycling.
        if (x.scanBlk > 0 && x.scanBlk % gridN === 0) {
          const rb = slot * RING
          for (let j = 0; j < RING; j++) ringBuf[rb + j] = -1
          x.ringPos = 0
        }
        blk = pickBlk(ti, 'scan', x)
      } else if (b.query === 'insert') {
        const k = i % (1 + nIdx)
        if (k === 0) { blk = pickBlk(ti, 'append'); forWrite = true }
        else { blk = idxBlk(ti, 2, true); forWrite = true }
      } else {
        const k = i % 5
        if (k === 0) blk = idxBlk(ti, 0)
        else if (k === 1) blk = idxBlk(ti, 1)
        else if (k === 2) blk = idxBlk(ti, 2, write && !x.hot)
        else { blk = pickBlk(ti, 'hot', undefined, write); forWrite = write }
        // A non-HOT update writes every modeled index entry; BRIN summaries are absent.
        if (write && !x.hot && k === 2) forWrite = true
      }
      const hit = touchPage(slot, ti, blk, forWrite, ring)
      if (hit === null) {
        const unprocessed = n - i - 1
        x.pagesLeft += unprocessed
        pageBudget += unprocessed
        break
      }
      b.buffersTouched++
      if (hit) b.buffersHit++
      else b.buffersRead++
    }
  }

  /** Commit accounting: tuples, WAL, dead rows, xids. */
  function finishStatement(slot: number, deferWal = false): number {
    const b = backends[slot]
    const x = extras[slot]
    const ti = b.table
    const t = tables[ti]
    const rows = x.rowsPerStmt * x.txCount
    const tup = avgTuple[ti]
    const nIdx = t.def.indexes.length
    const logical = K.walLevel === 'logical'
    // A same-page heap update can omit the unchanged tuple prefix/suffix.
    // Logical decoding needs a standalone new tuple, so it pays the full body.
    // minimal and replica are identical for ordinary steady-state DML.
    const CHANGED = 0.35
    const updBody = logical ? tup : Math.max(24, Math.round(tup * CHANGED))
    let bytes = 0

    switch (b.query) {
      case 'insert': {
        t.inserts += rows
        insSinceVacuum[ti] += rows
        t.liveTuples += rows
        stats.tupInserted += rows
        extendIfNeeded(ti)
        bytes += rows * (58 + tup + nIdx * 70)
        if (t.def.toast) bytes += rows * 620
        break
      }
      case 'update': {
        const rows2 = Math.min(rows, t.liveTuples)
        t.updates += rows2
        stats.tupUpdated += rows2
        if (x.hot) {
          t.hotUpdates += rows2
          // HOT: no new index entries, and heap_page_prune_opt reclaims most of
          // the dead versions on the next visit to the page — but only if the
          // xmin horizon allows it.
          const pruned = horizonFrozen ? 0 : Math.floor(rows2 * 0.85)
          addDead(ti, rows2 - pruned)
          b.deadMade += rows2 - pruned
          bytes += rows2 * (88 + updBody)
        } else {
          addDead(ti, rows2)
          b.deadMade += rows2
          deadIndexTuples[ti] += rows2 * nIdx
          refreshIndexPages(ti)
          bytes += rows2 * (108 + tup + nIdx * 78)
        }
        extendIfNeeded(ti)
        break
      }
      case 'delete': {
        const del = Math.min(rows, t.liveTuples)
        t.deletes += del
        stats.tupDeleted += del
        t.liveTuples -= del
        addDead(ti, del)
        b.deadMade += del
        deadIndexTuples[ti] += del * nIdx
        refreshIndexPages(ti)
        // DELETE writes a tiny WAL record — the index entries are cleaned up
        // later by vacuum, which is why deletes look cheap and then aren't.
        bytes += del * (64 + (logical ? 28 : 0))
        break
      }
      default: {
        b.rowsSent = rows
        stats.tupReturned += rows
        break
      }
    }

    if (x.writes) {
      bytes += x.txCount * 46 // commit record
      if (!deferWal) walInsert(bytes)
      b.walBytes = bytes + x.fpiBytes
      if (++sWalIns >= stride(stats.tps * K.writeRatio, 28)) {
        sWalIns = 0
        flow(rid.walIns(slot), 1, 'wal', wal.fpwBurst > 0.5 ? 1.7 : 1.15)
      }
    }
    if (++sClog >= stride(stats.tps, 14)) {
      sClog = 0
      flow('clog.in', 1, 'stat', 0.8)
    }
    if (!deferWal) {
      x.commitLsn = wal.insertLsn
      if (x.writes) rememberRecoveryCommitRecord(x.commitLsn)
    }
    return bytes
  }

  function beginWalInsert(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    // Apply the tuple/index effects once, then copy the resulting record bytes
    // through the fixed wal_buffers ring over subsequent ticks.
    x.walPending = finishStatement(slot, true) + x.fpiBytes
    x.walPendingFpi = x.fpiBytes
    x.walPrepared = true
    b.state = 'wal_insert'
    b.stateT = 0
    b.stateDur = rr(0.03, 0.07)
  }

  function stampBackendPageLsns(slot: number, lsn: number): void {
    const ownerBit = 1 << slot
    for (let b = 0; b < buf.sampleFrames; b++) {
      if ((pageLsnOwners[b] & ownerBit) === 0) continue
      buf.pageLsn[b] = Math.max(buf.pageLsn[b], lsn)
      pageLsnOwners[b] &= ~ownerBit
    }
  }

  function rememberCommittedWrites(lsn: number, count: number): void {
    if (lsn <= 0 || count <= 0) return
    commitLsn[commitHead] = lsn
    commitCount[commitHead] = count
    commitHead = (commitHead + 1) % COMMIT_HISTORY_SLOTS
    if (commitSlots < COMMIT_HISTORY_SLOTS) commitSlots++
  }

  function rememberRecoveryCommitRecord(lsn: number): void {
    if (lsn <= 0) return
    recoveryCommitLsn[recoveryCommitHead] = lsn
    recoveryCommitAt[recoveryCommitHead] = state.t
    recoveryCommitTimeline[recoveryCommitHead] = ha.timeline.current
    recoveryCommitHead = (recoveryCommitHead + 1) % COMMIT_HISTORY_SLOTS
    if (recoveryCommitSlots < COMMIT_HISTORY_SLOTS) recoveryCommitSlots++
  }

  function committedWritesBetween(afterLsn: number, throughLsn: number): number {
    let total = 0
    for (let i = 0; i < commitSlots; i++) {
      const slot = (commitHead - 1 - i + COMMIT_HISTORY_SLOTS) % COMMIT_HISTORY_SLOTS
      const lsn = commitLsn[slot]
      if (lsn <= afterLsn) break
      if (lsn <= throughLsn) total += commitCount[slot]
    }
    return total
  }

  function endVisit(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    recordLatency(x)
    const traced = traceRunning && state.trace.slot === slot
    if (traced) {
      syncTraceBackend(slot)
      state.trace.trips = x.txCount
      state.trace.lastTripSec = x.visitT
      enterTraceStop('done', x.visitT)
      traceRunning = false
    }
    const rb = Math.min(x.txCount, Math.round(x.txCount * 0.003 + (rng() < 0.02 ? 1 : 0)))
    stats.rollbacks += rb
    stats.commits += x.txCount - rb
    commitsAcc += x.txCount - rb
    if (x.writes) rememberCommittedWrites(x.commitLsn, x.txCount - rb)
    const table = tables[b.table]
    if (
      b.query === 'update'
      && b.xid > 0
      && x.txCount > rb
      && (traced || state.t >= table.mvcc.nextSampleAt)
      && recordRepresentativeUpdate(table.mvcc, b.xid - rb, state.t, x.hot)
    ) {
      table.mvcc.nextSampleAt = state.t + MVCC_SAMPLE_SECONDS
      refreshRepresentativeRow(table.mvcc, state.xminHorizon)
    }
    /* Each represented transaction contains one query. The scale model releases
     * every boundary in the batch here; statement mode rejects open blocks. */
    // The xid is no longer live, so the backend stops holding back xmin.
    b.xid = 0
    b.state = 'idle'
    b.stateT = 0
    b.stateDur = 0.2
    b.progress = 0
    b.plan = null
    x.planFlat.length = 0
    unpinAll(slot)
    // Client churn. An unpooled application holds a connection for a few
    // hundred transactions and then closes it, so the postmaster is forking
    // continuously — and the higher the transaction rate, the more processes
    // per second it has to create. This is the cost a pooler removes.
    const serverOverCapacity = K.poolMode !== 'disabled'
      && slot >= activeServerConnectionLimit()
    /* Direct clients keep the city's existing connection churn in every
     * workload. Pooling removes it by reusing its server connections. */
    const directChurn = K.poolMode === 'disabled'
      && stats.activeBackends > 3
      && rng() < clamp(x.txCount / 300, 0.004, 0.6)
    rotateSessionBinding(slot)
    if (!x.holdsLock && (serverOverCapacity || directChurn)) {
      b.state = 'ending'
      b.stateDur = 0.18
    }
    if (++sBufReq >= 2) {
      sBufReq = 0
      flow(rid.result(slot), 1, 'result', 1.0)
      flow(rid.bufRet(slot), 1, 'result', 1.0)
    }
    x.txCount = 0
  }

  function forkBackend(): boolean {
    if (forkCooldown > 0) return false
    let slot = -1
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      if (!backends[i].active) { slot = i; break }
    }
    if (slot < 0 || slot >= activeServerConnectionLimit()) return false
    const b = backends[slot]
    b.active = true
    b.state = 'starting'
    b.stateT = 0
    b.stateDur = rr(0.1, 0.2)
    b.age = 0
    b.progress = 0
    b.sql = ''
    b.plan = null
    extras[slot] = extras[slot] || makeExtra()
    extras[slot].idleT = 0
    extras[slot].sessionAgeT = 0
    extras[slot].nextSessionPoolWaitT = 0
    state.forkPulse = Math.min(3, state.forkPulse + 1)
    forkCooldown = 0.14
    flow('conn.in', 1, 'fork', 1.4)
    flow(rid.fork(slot), 2, 'fork', 1.6)
    return true
  }

  function tickBackends(dt: number): void {
    announceTraceRequest()
    let activeN = 0
    let runningN = 0
    let workMemNodes = 0
    let workMemSortNodes = 0
    let workMemHashNodes = 0
    let workMemAllowanceBytes = 0
    let workMemUsedBytes = 0
    let workMemSpillNodes = 0
    let liveTempBytes = 0
    for (let slot = 0; slot < N_BACKEND_SLOTS; slot++) {
      const b = backends[slot]
      const x = extras[slot]
      if (!b.active) continue
      activeN++
      if (K.poolMode === 'session') x.sessionAgeT += dt
      if (b.state === 'idle') rotateSessionBinding(slot)
      if (b.state === 'exec_io') x.bufferReadWaitT += dt
      else if (b.state === 'eviction_flush') {
        x.dirtyWriteWaitT += dt
        x.evictionWalWaitT += dt
      }
      else if (b.state === 'commit_wait' && K.synchronousCommit !== 'off') x.commitWaitT += dt
      else if (b.state === 'blocked') x.lockWaitT += dt
      else if (b.state === 'sort' && b.tempFileBytes > 0) {
        x.tempFileWaitT += dt
        /* One external pass writes and rereads the modeled temp bytes. These
         * pages affect shared device pressure, but never shared-buffer hit or
         * miss counters. */
        const ioPages = (b.tempFileBytes * x.txCount) / PAGE
        const share = b.stateDur > 0 ? dt / b.stateDur : 1
        ioWriteAcc += ioPages * share
        ioReadAcc += ioPages * share
      }
      b.age += dt
      b.stateT += dt
      x.visitT += dt
      b.progress = b.stateDur > 0 ? clamp01(b.stateT / b.stateDur) : 1

      switch (b.state) {
        case 'starting':
          if (b.stateT >= b.stateDur) {
            b.state = 'idle'
            b.stateT = 0
            b.stateDur = 0.2
            x.idleT = 0
          }
          break

        case 'idle': {
          x.idleT += dt
          const traceReady = traceQueue.length > 0
            && traceQueue[0].announced
            && traceQueue[0].readyT < state.t
          const randomPending = K.poolMode === 'session'
            ? sessionPendingTx[slot]
            : pendingTx - traceQueue.length
          if (traceReady || randomPending > 0) startVisit(slot)
          else if (x.idleT > IDLE_REAP && activeN > 2) {
            b.state = 'ending'
            b.stateT = 0
            b.stateDur = 0.2
          }
          break
        }

        case 'idle_in_xact':
          // holding a lock (or a snapshot) open — goes nowhere on purpose
          break

        case 'parse':
          if (b.stateT >= b.stateDur) {
            b.state = 'plan'
            b.stateT = 0
            b.stateDur = rr(0.035, 0.09)
          }
          break

        case 'plan':
          if (b.stateT >= b.stateDur) {
            b.plan = buildPlan(b.query, b.table, x.seqScan, x.rowsPerStmt)
            x.planFlat.length = 0
            flatten(b.plan, x.planFlat)
            planWindows(x)
            if (conflicts(slot, b.table)) blockOn(slot, b.table)
            else beginExec(slot)
          }
          break

        case 'blocked': {
          lockWaitT[slot] += dt
          if (lockHolder < 0) {
            unblock(slot)
            beginExec(slot)
          } else if (lockWaitT[slot] > lockTimeoutSec()) {
            // ERROR: canceling statement due to lock timeout
            unblock(slot)
            stats.rollbacks += x.txCount
            // These transactions are dead. Zero the batch so endVisit cannot
            // count the same work a second time as commits — an aborted
            // transaction is not throughput.
            x.txCount = 0
            b.xid = 0
            b.state = 'sending'
            b.stateT = 0
            b.stateDur = 0.05
            b.rowsSent = 0
          } else if (++sBufReq >= 3) {
            sBufReq = 0
            flow(rid.lockWait(slot), 1, 'query', 1.0)
          }
          break
        }

        case 'exec_io':
        case 'exec_cpu': {
          x.execElapsed += dt
          drainPages(slot, dt)
          tickPlan(x, clamp01(x.execElapsed / x.execTotal), dt)
          if (b.stateT >= b.stateDur) {
            if (b.state === 'exec_io') {
              b.state = 'exec_cpu'
              b.stateT = 0
              b.stateDur = Math.max(0.05, x.execTotal - x.execElapsed)
            } else {
              // flush any page work the timing model left behind
              if (x.pagesLeft > 0) {
                drainPages(slot, x.execTotal)
              }
              if (x.evictionBuffer >= 0) break
              if (x.needsSort) {
                beginWorkMem(slot)
              } else if (x.postFilterCpu) {
                x.postFilterCpu = false
                b.state = 'exec_cpu'
                b.stateT = 0
                b.stateDur = rr(0.12, 0.34)
              } else if (x.writes) {
                beginWalInsert(slot)
              } else {
                finishStatement(slot)
                b.state = 'sending'
                b.stateT = 0
                b.stateDur = rr(0.03, 0.12)
              }
            }
          }
          break
        }

        case 'sort':
          if (b.stateT >= b.stateDur) {
            if (x.writes) {
              beginWalInsert(slot)
            } else {
              finishStatement(slot)
              b.state = 'sending'
              b.stateT = 0
              b.stateDur = rr(0.03, 0.12)
            }
          }
          break

        case 'wal_insert':
          if (b.stateT >= b.stateDur) {
            if (!x.walPrepared) {
              x.walPending = finishStatement(slot, true) + x.fpiBytes
              x.walPendingFpi = x.fpiBytes
              x.walPrepared = true
            }
            const gap = Math.max(0, wal.insertLsn - wal.writeLsn)
            const available = Math.max(0, wal.bufferCapacity - gap)
            if (available <= 0) {
              requestFlush(wal.insertLsn)
              break
            }
            const chunk = Math.min(
              x.walPending,
              available,
              Math.max(4096, 24 * 1024 * 1024 * dt),
            )
            if (chunk > 0) {
              walInsert(chunk)
              x.walPending -= chunk
              const fpiChunk = Math.min(x.walPendingFpi, chunk)
              x.walPendingFpi -= fpiChunk
              fpiAcc += fpiChunk
            }
            if (x.walPending > 0) {
              // At a full ring the backend remains on WALWriteLock until a
              // writer makes reusable space. Work beyond the capacity is never
              // silently accepted or hidden by the display clamp.
              requestFlush(wal.insertLsn)
              break
            }
            x.commitLsn = wal.insertLsn
            rememberRecoveryCommitRecord(x.commitLsn)
            stampBackendPageLsns(slot, x.commitLsn)
            x.walPrepared = false
            b.stateT = 0
            if (K.synchronousCommit === 'off') {
              // Acknowledgement bypasses the durability wait. WAL remains in
              // the shared ring for walwriter, unless ring pressure already
              // forced this backend to request a write while inserting it.
              b.state = 'sending'
              b.stateDur = rr(0.03, 0.12) + Math.min(0.25, x.rowsPerStmt / 2400)
            } else {
              b.state = 'commit_wait'
              b.stateDur = commitWaitEstimate()
              requestFlush(x.commitLsn)
            }
          }
          break

        case 'eviction_flush':
          if (x.evictionBuffer < 0 || !buf.valid[x.evictionBuffer]) {
            cancelEvictionFlushWait(slot)
          } else if (!buf.dirty[x.evictionBuffer]) {
            finishEvictionFlushWait(slot)
          } else if (pageLsnOwners[x.evictionBuffer] === 0) {
            x.evictionFlushLsn = buf.pageLsn[x.evictionBuffer]
            if (wal.flushLsn >= x.evictionFlushLsn) finishEvictionFlushWait(slot)
            else requestFlush(x.evictionFlushLsn)
          }
          if (b.state === 'eviction_flush' && b.stateT > 8) {
            cancelEvictionFlushWait(slot)
          }
          break

        case 'commit_wait': {
          const sc = K.synchronousCommit
          let done = false
          if (sc === 'off') {
            done = true
          } else if (
            (sc === 'remote_write' || sc === 'on' || sc === 'remote_apply')
            && K.synchronousStandbyNames !== 'none'
          ) {
            const syncStandby = synchronousStandby()
            const acknowledged = sc === 'remote_write'
              ? syncStandby.acknowledgedWriteLsn
              : sc === 'on'
                ? syncStandby.acknowledgedFlushLsn
                : syncStandby.acknowledgedApplyLsn
            done = wal.flushLsn >= x.commitLsn && acknowledged >= x.commitLsn
            if (!syncStandby.connected && state.t - degradeWarnT > 20) {
              degradeWarnT = state.t
              toast('commits are waiting for a synchronous standby that is not there', 'warn', 6000)
            }
          } else {
            // With synchronous_standby_names empty, remote modes collapse to
            // the local durability guarantee.
            done = wal.flushLsn >= x.commitLsn
            if (b.stateT > 8) done = true // watchdog for local states only
          }
          if (done) {
            b.state = 'sending'
            b.stateT = 0
            b.stateDur = rr(0.03, 0.12) + Math.min(0.25, x.rowsPerStmt / 2400)
          }
          break
        }

        case 'sending':
          if (b.stateT >= b.stateDur) endVisit(slot)
          break

        case 'ending':
          if (b.stateT >= b.stateDur) {
            b.active = false
            b.state = 'free'
            b.plan = null
            b.sql = ''
            x.planFlat.length = 0
            unpinAll(slot)
            const base = slot * RING
            for (let i = 0; i < RING; i++) ringBuf[base + i] = -1
          }
          break

        case 'free':
          break
      }
      if (!b.active) activeN--
      if (b.active && isRunningState(b.state)) runningN++
      if (b.state === 'sort') {
        workMemNodes += b.workMemNodes
        workMemSortNodes += b.workMemSortNodes
        workMemHashNodes += b.workMemHashNodes
        workMemAllowanceBytes += b.workMemAllowanceBytes
        workMemUsedBytes += b.workMemUsedBytes
        workMemSpillNodes += b.workMemSpillNodes
        liveTempBytes += b.tempFileBytes
      }
      syncTraceBackend(slot)
    }
    stats.activeBackends = activeN
    stats.runningBackends = runningN
    syncPoolerState()
    state.workMem.activeNodes = workMemNodes
    state.workMem.activeSortNodes = workMemSortNodes
    state.workMem.activeHashNodes = workMemHashNodes
    state.workMem.activeAllowanceBytes = workMemAllowanceBytes
    state.workMem.activeUsedBytes = workMemUsedBytes
    state.workMem.spillingNodes = workMemSpillNodes
    state.workMem.liveTempBytes = liveTempBytes
  }

  function commitWaitEstimate(): number {
    const fsync = Math.max(0.09, flushDur) * 1.5
    const syncStandby = synchronousStandby()
    const remoteWait = K.synchronousStandbyNames !== 'none'
      ? syncStandby.connected
        ? (syncStandby.networkLagMs * 2) / 1000
        : 9999
      : 0
    switch (K.synchronousCommit) {
      case 'off':
        return 0
      case 'local':
        return fsync
      case 'remote_write':
        return fsync + remoteWait * REPLICA_WRITE_ACK_DELAY_FRACTION
      case 'on':
        return fsync + remoteWait
      case 'remote_apply':
        return fsync + remoteWait + (
          K.synchronousStandbyNames !== 'none' ? REPLICA_APPLY_ACK_DELAY : 0
        )
    }
  }

  /* ======================================================================
   * POSTMASTER
   * ====================================================================*/

  function tickPostmaster(dt: number): void {
    forkCooldown -= dt
    state.forkPulse = damp(state.forkPulse, 0, 3.2, dt)
    expireMultiplexedPoolWaiters()
    expireSessionPoolWaiters()
    stats.poolerQueuedTransactions = K.poolMode === 'disabled'
      ? 0
      : (K.poolMode === 'session'
          ? queuedSessionTx + state.pooler.waitingClients
          : queuedRandomTx)
    if (pendingTx <= 0) return
    let idle = 0
    let active = 0
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = backends[i]
      if (!b.active) continue
      active++
      if (b.state === 'idle') idle++
    }
    if (idle > 0 && K.poolMode !== 'session') return
    if (active < activeServerConnectionLimit()) {
      forkBackend()
    }
  }

  /* ======================================================================
   * STATS
   * ====================================================================*/

  function tickStats(dt: number): void {
    rateT += dt
    if (rateT >= 0.25) {
      const iv = rateT
      rateT = 0
      stats.tps = damp(stats.tps, commitsAcc / iv, 3, iv)
      refreshLatencyQuantiles()
      wal.bytesPerSec = damp(wal.bytesPerSec, walAcc / iv, 3, iv)
      stats.walBytesPerSec = wal.bytesPerSec
      stats.ioReadPerSec = damp(stats.ioReadPerSec, ioReadAcc / iv, 3, iv)
      stats.ioWritePerSec = asSampleFrames(damp(stats.ioWritePerSec, ioWriteAcc / iv, 3, iv))
      stats.ioWriteLoad = clamp01(stats.ioWritePerSec / DEVICE_PAGES_PER_SEC)
      // Writeback pressure. Quadratic, because a device does not degrade
      // linearly: it is fine until it is not. Reads are deliberately NOT in the
      // numerator — a read miss is already priced into exec duration through
      // missFrac, and counting it twice would let the buffer-pool lesson bleed
      // into the checkpoint one.
      ioLoad = 1 + 2.5 * stats.ioWriteLoad ** 2
      bgw.cleanedPerSec = damp(bgw.cleanedPerSec, cleanedAcc / iv, 3, iv)
      // fpwBurst decays as the working set pays off its full-page images
      const fpiRatio = walAcc > 0 ? clamp01(fpiAcc / walAcc) : 0
      wal.fpwBurst = damp(wal.fpwBurst, fpiRatio, 0.7, iv)

      // blks_hit / (blks_hit + blks_read) over a sliding window: decay the two
      // COUNTS by a common factor and divide, rather than averaging per-window
      // ratios. ~50 s horizon: responsive to a changed workload without
      // reporting a warmed finite sample as a perfect 100.0% cache.
      const k = Math.exp(-0.02 * iv)
      emaHits = emaHits * k + winHits
      emaSeen = emaSeen * k + winHits + winMisses
      if (emaSeen > 8) buf.hitRatio = emaHits / emaSeen
      stats.cacheHitPct = buf.hitRatio * 100
      stats.blksHit = buf.hits
      stats.blksRead = buf.misses

      // The scale factor, re-derived in case the tps knob moved. NOT a
      // controller: nothing measured feeds back into it. stats.tps above is a
      // pure observation of what the fleet actually committed.
      sizeBatch()

      commitsAcc = 0
      walAcc = 0
      fpiAcc = 0
      ioReadAcc = 0
      ioWriteAcc = 0
      cleanedAcc = 0
      winHits = 0
      winMisses = 0
    }

    coverageT += dt
    if (coverageT >= 5) {
      coverageT = 0
      const counts = [...accessCounts.values()].sort((a, b) => b - a)
      let total = 0
      for (const n of counts) total += n
      const target = total * 0.9
      let seen = 0
      let pages = 0
      while (pages < counts.length && seen < target) seen += counts[pages++]
      runtimeStats.pagesFor90Pct = pages
    }

    histT += dt
    if (histT >= 0.25) {
      histT = 0
      const h = stats.history
      pushHistory(h.tps, stats.tps)
      pushHistory(h.hit, stats.cacheHitPct)
      pushHistory(h.latencyP50, stats.latency.p50.totalMs)
      pushHistory(h.latencyP99, stats.latency.p99.totalMs)
      pushHistory(h.wal, wal.bytesPerSec)
      pushHistory(h.dirty, buf.dirtyCount)
      pushHistory(h.lag, Math.max(rep.standbys[0].lagSec, rep.standbys[1].lagSec))
    }

    statT += dt
    if (statT > 0.35) {
      statT = 0
      flow('stats.in', 1, 'stat', 0.8)
    }
  }

  /* ======================================================================
   * SCENARIOS
   * ====================================================================*/

  const savedKnobs: Partial<Knobs> = {}
  let savedKeys: (keyof Knobs)[] = []
  let beatIdx = 0

  function totalDeadTuples(): number {
    let total = 0
    for (let i = 0; i < tables.length; i++) total += tables[i].deadTuples
    return total
  }

  function totalTablePages(): number {
    let total = 0
    for (let i = 0; i < tables.length; i++) total += tables[i].pages
    return total
  }

  function createScenarioDecision(id: string): ScenarioDecisionState | null {
    if (id === 'slot-pressure') {
      return {
        kind: 'slot-pressure',
        phase: 'staging',
        choice: null,
        correct: null,
        slotRetainedAtDecision: 0,
        capacityAtDecision: dr.archive.pgWalCapacityBytes,
        addedCapacityBytes: 0,
        rejectedWritesAtDecision: 0,
        rejectedWrites: 0,
      }
    }
    if (id === 'vacuum-blockade') {
      return {
        kind: 'vacuum-blockade',
        phase: 'staging',
        choice: null,
        correct: null,
        deadTuplesAtDecision: 0,
        pagesAtDecision: 0,
        vacuumRunsAtDecision: 0,
        landfillAtDecision: 0,
        deadTuplesAdded: 0,
        pagesAdded: 0,
        blockedVacuumWorkers: 0,
        deadTuplesReclaimed: 0,
        transactionTerminated: false,
      }
    }
    if (id === 'failover-candidate') {
      return {
        kind: 'failover-candidate',
        phase: 'staging',
        choice: null,
        correct: null,
        standbyALagBytes: 0,
        standbyBLagBytes: 0,
        lossBytes: 0,
        lossTransactions: 0,
        rejoinBytes: 0,
      }
    }
    return null
  }

  function tickScenarioDecision(dt: number): void {
    const decision = state.scenarioDecision
    if (!decision || !state.scenario) return
    let revealAt: number | undefined
    for (let i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === state.scenario) {
        revealAt = SCENARIOS[i].decision?.revealAt
        break
      }
    }
    if (decision.phase === 'staging' && revealAt !== undefined && state.scenarioT >= revealAt) {
      if (decision.kind === 'slot-pressure') {
        /* The link has just been repaired. The remaining question is whether
         * the retained WAL has enough disk headroom to survive catch-up. */
        setKnob('standbyBEnabled', true)
        decision.slotRetainedAtDecision = rep.physicalSlots[1].retainedBytes
        decision.capacityAtDecision = dr.archive.pgWalCapacityBytes
        decision.rejectedWritesAtDecision = dr.archive.rejectedWrites
      } else if (decision.kind === 'vacuum-blockade') {
        decision.deadTuplesAtDecision = totalDeadTuples()
        decision.pagesAtDecision = totalTablePages()
        decision.vacuumRunsAtDecision = av.totalRuns
        decision.landfillAtDecision = av.landfill
      } else {
        decision.standbyALagBytes = Math.max(0, wal.flushLsn - rep.standbys[0].flushedLsn)
        decision.standbyBLagBytes = Math.max(0, wal.flushLsn - rep.standbys[1].flushedLsn)
        stageFailoverCandidateDecision()
      }
      decision.phase = 'ready'
    }

    if (decision.kind === 'slot-pressure') {
      decision.rejectedWrites = Math.max(
        0,
        dr.archive.rejectedWrites - decision.rejectedWritesAtDecision,
      )
      if (
        decision.choice === 'add-wal-capacity'
        && rep.standbys[1].connected
        && rep.physicalSlots[1].retainedBytes
          <= Math.max(16 * MIB, decision.slotRetainedAtDecision * 0.1)
      ) {
        decision.phase = 'recovered'
      }
      return
    }

    if (decision.kind === 'vacuum-blockade') {
      if (decision.phase !== 'staging') {
        decision.deadTuplesAdded = Math.max(
          decision.deadTuplesAdded,
          totalDeadTuples() - decision.deadTuplesAtDecision,
        )
        decision.pagesAdded = Math.max(
          decision.pagesAdded,
          totalTablePages() - decision.pagesAtDecision,
        )
        decision.deadTuplesReclaimed = Math.max(
          0,
          av.landfill - decision.landfillAtDecision,
        )
        if (K.longRunningXact) {
          let active = 0
          for (let i = 0; i < av.workers.length; i++) {
            if (av.workers[i].active) active++
          }
          decision.blockedVacuumWorkers = Math.max(decision.blockedVacuumWorkers, active)
        }
        if (
          decision.transactionTerminated
          && decision.deadTuplesReclaimed > 0
          && !K.longRunningXact
        ) {
          decision.phase = 'recovered'
        }
      }
      return
    }

    if (
      decision.choice
      && ha.transition.status === 'complete'
      && ha.rejoin.status === 'idle'
      && decision.phase !== 'outcome'
      && decision.phase !== 'recovered'
    ) {
      decision.lossBytes = ha.transition.lossBytes
      decision.lossTransactions = ha.transition.lossTransactions
      decision.rejoinBytes = ha.rejoin.bytesRewound + ha.rejoin.reinitializeBytes
      decision.phase = 'outcome'
    }
    if (
      decision.phase === 'recovering'
      && ha.rejoin.reinitializeRequired
    ) {
      ha.rejoin.reinitializeCopiedBytes = Math.min(
        ha.rejoin.reinitializeBytes,
        ha.rejoin.reinitializeCopiedBytes + DR_BACKUP_BYTES_PER_SEC * dt,
      )
      if (ha.rejoin.reinitializeCopiedBytes >= ha.rejoin.reinitializeBytes) {
        finishFollowerReinitialize()
      }
    }
    if (
      decision.phase === 'recovering'
      && ha.rejoin.status === 'complete'
      && !ha.rejoin.required
    ) {
      decision.phase = 'recovered'
    }
  }

  function saveKnob<Key extends keyof Knobs>(k: Key): void {
    savedKnobs[k] = K[k]
  }

  function endScenario(silent: boolean): void {
    if (!state.scenario) return
    for (const k of savedKeys) {
      const v = savedKnobs[k]
      if (v !== undefined) setKnob(k, v as Knobs[typeof k])
    }
    savedKeys = []
    lockTimeout = LOCK_TIMEOUT_DEFAULT
    state.scenario = null
    state.scenarioT = 0
    state.scenarioDecision = null
    scenarioQueryKind = null
    scenarioQueryTable = -1
    beatIdx = 0
    bus.emit('scenario', { id: null })
    bus.emit('narrate', null)
    if (!silent) toast('Scenario finished — knobs restored', 'good')
  }

  function runScenario(id: string | null): void {
    if (!id) {
      endScenario(false)
      return
    }
    const def = SCENARIOS.find((s) => s.id === id)
    if (!def) {
      console.warn(`[sim] unknown scenario "${id}"`)
      return
    }
    if (state.scenario) endScenario(true)
    savedKeys = Object.keys(def.knobs) as (keyof Knobs)[]
    for (const k of savedKeys) saveKnob(k)
    for (const k of savedKeys) {
      const v = def.knobs[k]
      if (v !== undefined) setKnob(k, v as Knobs[typeof k])
    }
    // Scenario lock_timeout, if any, arrives later at its beat (see the table).
    lockTimeout = LOCK_TIMEOUT_DEFAULT
    state.scenario = def.id
    state.scenarioT = 0
    state.scenarioDecision = createScenarioDecision(def.id)
    scenarioQueryKind = def.query?.kind ?? null
    scenarioQueryTable = def.query
      ? TABLES.findIndex((table) => table.id === def.query!.table)
      : -1
    beatIdx = 0
    bus.emit('scenario', { id: def.id })
    if (def.focus) bus.emit('focus', { id: def.focus })
    if (def.beats && def.beats.length && def.beats[0][0] <= 0) {
      bus.emit('narrate', {
        title: def.beats[0][1],
        body: def.beats[0][2],
        seconds: SCENARIO_NARRATION_SECONDS,
      })
      beatIdx = 1
    }
  }

  function tickScenario(dt: number): void {
    if (!state.scenario) return
    const def = SCENARIOS.find((s) => s.id === state.scenario)
    if (!def) {
      state.scenario = null
      return
    }
    const previousScenarioT = state.scenarioT
    state.scenarioT += dt
    tickScenarioDecision(dt)
    // This guided beat describes the launcher waking and a worker being sent,
    // so a passive viewer must see that change too. Crossing the beat makes it
    // one-shot: a viewer remains free to turn the knob back off afterwards.
    if (def.id === 'bloat-and-vacuum' && previousScenarioT < 70 && state.scenarioT >= 70) {
      setKnob('autovacuum', true)
    }
    if (def.id === 'no-bgwriter' && previousScenarioT < 64 && state.scenarioT >= 64) {
      setKnob('bgwriterEnabled', true)
    }
    if (def.id === 'work-mem-spill' && previousScenarioT < 52 && state.scenarioT >= 52) {
      setKnob('workMem', CLAIM_VALUES.workMem.spillExample.highMiB)
    }
    if (def.id === 'connection-storm' && previousScenarioT < 44 && state.scenarioT >= 44) {
      setKnob('clientConnections', 1_000)
      setKnob('poolMode', 'transaction')
    }
    // Stands in for a `lockTimeout` knob this scenario would set at a beat.
    const lt = SCENARIO_LOCK_TIMEOUT[def.id]
    if (lt && lockTimeout !== lt.sec && state.scenarioT >= lt.atSec) {
      lockTimeout = lt.sec
      // Waiters already parked were given an open-ended ring; re-arm them
      // against the deadline they would have had, counted from now.
      for (let i = 0; i < N_BACKEND_SLOTS; i++) {
        if (backends[i].state === 'blocked') {
          backends[i].stateT = 0
          backends[i].stateDur = lt.sec
          lockWaitT[i] = 0
        }
      }
    }
    const beats = def.beats
    if (beats) {
      while (beatIdx < beats.length && state.scenarioT >= beats[beatIdx][0]) {
        const b = beats[beatIdx]
        bus.emit('narrate', {
          title: b[1],
          body: b[2],
          seconds: SCENARIO_NARRATION_SECONDS,
        })
        beatIdx++
      }
    }
    if (def.duration > 0 && state.scenarioT >= def.duration) endScenario(false)
  }

  function chooseScenario(choice: ScenarioChoiceId): boolean {
    const decision = state.scenarioDecision
    if (!decision || decision.phase !== 'ready' || decision.choice) return false

    if (decision.kind === 'slot-pressure') {
      if (choice === 'add-wal-capacity') {
        decision.choice = choice
        decision.correct = true
        decision.addedCapacityBytes = 512 * MIB
        dr.archive.pgWalCapacityBytes += decision.addedCapacityBytes
        decision.phase = 'outcome'
        toast(
          '512 MiB of scaled pg_wal capacity added; standby_b keeps its slot and continues catch-up',
          'good',
          7000,
        )
        return true
      }
      if (choice === 'drop-replication-slot') {
        decision.choice = choice
        decision.correct = false
        const slot = rep.physicalSlots[1]
        slot.exists = false
        slot.active = false
        slot.restartLsn = wal.insertLsn
        slot.retainedBytes = 0
        decision.phase = 'outcome'
        toast(
          'standby_b restarted without primary_slot_name; it is streaming, but its WAL retention guarantee is gone',
          'warn',
          8000,
        )
        return true
      }
      return false
    }

    if (decision.kind === 'vacuum-blockade') {
      if (choice === 'terminate-transaction') {
        decision.choice = choice
        decision.correct = true
        decision.transactionTerminated = true
        setKnob('longRunningXact', false)
        decision.phase = 'outcome'
        toast(
          'One idle transaction terminated; its snapshot released and vacuum can remove dead row versions',
          'good',
          7000,
        )
        return true
      }
      if (choice === 'wait-for-transaction') {
        decision.choice = choice
        decision.correct = false
        decision.phase = 'outcome'
        toast(
          'The idle transaction remains; every new dead row version stays behind the pinned xmin horizon',
          'warn',
          7500,
        )
        return true
      }
      return false
    }

    if (choice !== 'promote-standby-a' && choice !== 'promote-standby-b') return false
    const target = choice === 'promote-standby-a' ? 'standbyA' : 'standbyB'
    if (!startFailover(target)) return false
    decision.choice = choice
    decision.correct = choice === 'promote-standby-a'
    decision.phase = 'recovering'
    return true
  }

  function recoverScenario(): boolean {
    const decision = state.scenarioDecision
    if (!decision) return false
    if (
      decision.kind === 'vacuum-blockade'
      && decision.choice === 'wait-for-transaction'
      && K.longRunningXact
      && decision.phase === 'outcome'
    ) {
      decision.transactionTerminated = true
      decision.phase = 'recovering'
      setKnob('longRunningXact', false)
      return true
    }
    if (
      decision.kind === 'failover-candidate'
      && decision.phase === 'outcome'
      && ha.rejoin.required
      && startPgRewind()
    ) {
      decision.phase = 'recovering'
      return true
    }
    return false
  }

  /* ======================================================================
   * KNOBS
   * ====================================================================*/

  function rejectStatementTransactionBlock(): void {
    state.pooler.statementTransactionRejects++
    state.pooler.disconnectedClients++
    toast(
      `PgBouncer ${STATEMENT_TRANSACTION_ERROR.severity} ${STATEMENT_TRANSACTION_ERROR.sqlstate} — ${STATEMENT_TRANSACTION_ERROR.message}; client disconnected`,
      'warn',
      7000,
    )
  }

  function setKnob<Key extends keyof Knobs>(key: Key, value: Knobs[Key], source?: 'user'): void {
    const previousCheckpointTimeout = K.checkpointTimeout
    const previousPoolMode = K.poolMode
    K[key] = value

    switch (key) {
      case 'sharedBuffers':
        resizePool(K.sharedBuffers)
        break
      case 'workMem':
        K.workMem = clamp(Math.round(K.workMem), 1, 256)
        break
      case 'tps':
        K.tps = Math.max(0, K.tps)
        if (K.tps === 0 && K.poolMode === 'disabled') {
          /* A zero direct-workload stage cancels application work that has not
           * entered PostgreSQL. Retaining an unbounded hidden client queue here
           * kept generating transaction-end records long after tests stopped
           * the workload and fabricated later PITR targets. */
          pendingTx = Math.min(pendingTx, traceQueue.length)
          clearArrivalQueue()
        }
        nextArrival = 0
        // The batch scale follows the offered rate, so it moves with the slider
        // rather than 250ms later.
        sizeBatch()
        break
      case 'clientConnections':
        K.clientConnections = clamp(Math.round(K.clientConnections), 1, 2_000)
        nextArrival = 0
        if (K.poolMode === 'session') {
          moveSessionQueueToArrivals()
          moveArrivalQueueToSessions()
        }
        sizeBatch()
        if (K.poolMode === 'session') sessionWaitCohortAt = state.t
        syncPoolerState()
        break
      case 'poolMode':
        sessionWaitCohortAt = state.t
        if (previousPoolMode !== 'session' && K.poolMode === 'session') {
          moveArrivalQueueToSessions()
        } else if (previousPoolMode === 'session' && K.poolMode !== 'session') {
          moveSessionQueueToArrivals()
        }
        if (
          previousPoolMode === 'disabled'
          && usesMultiplexedPoolQueue(K.poolMode)
        ) {
          // Work already waiting at the application enters PgBouncer now; its
          // pool wait cannot predate the pooler's introduction.
          markQueuedArrivalsAt(state.t)
        }
        if (K.poolMode === 'statement') {
          if (K.longRunningXact) {
            K.longRunningXact = false
            rejectStatementTransactionBlock()
          }
          if (K.lockContention) {
            K.lockContention = false
            releaseLock()
            rejectStatementTransactionBlock()
          }
          syncHorizonPin()
        }
        for (let i = 0; i < N_BACKEND_SLOTS; i++) {
          extras[i].sessionAgeT = 0
          extras[i].nextSessionPoolWaitT = 0
        }
        sizeBatch()
        syncPoolerState()
        break
      case 'defaultPoolSize':
        K.defaultPoolSize = clamp(Math.round(K.defaultPoolSize), 1, 100)
        if (K.poolMode === 'session') {
          moveSessionQueueToArrivals()
          moveArrivalQueueToSessions()
        }
        sizeBatch()
        syncPoolerState()
        break
      case 'maxClientConn':
        K.maxClientConn = clamp(Math.round(K.maxClientConn), 1, 2_000)
        nextArrival = 0
        if (K.poolMode === 'session') {
          moveSessionQueueToArrivals()
          moveArrivalQueueToSessions()
        }
        sizeBatch()
        syncPoolerState()
        break
      case 'queryWaitTimeout':
        K.queryWaitTimeout = clamp(Math.round(K.queryWaitTimeout), 0, 600)
        sessionWaitCohortAt = state.t
        syncPoolerState()
        break
      case 'bgwriterEnabled':
        bgw.enabled = K.bgwriterEnabled
        if (!K.bgwriterEnabled) toast('bgwriter off — backends will now write out their own victims', 'warn')
        break
      case 'autovacuum':
        av.enabled = K.autovacuum
        if (!K.autovacuum) {
          toast('autovacuum off — routine cleanup stops; anti-wraparound is not modeled', 'warn')
        }
        break
      case 'checkpointTimeout':
        // A reload changes the interval from the last checkpoint start, so keep
        // elapsed time rather than preserving the old remaining countdown.
        ckpt.nextInSec += K.checkpointTimeout - previousCheckpointTimeout
        break
      case 'longRunningXact':
      case 'standbyALongQuery':
      case 'standbyBLongQuery':
        if (
          key === 'longRunningXact'
          && K.poolMode === 'statement'
          && K.longRunningXact
        ) {
          K.longRunningXact = false
          rejectStatementTransactionBlock()
        }
        if (key !== 'longRunningXact' && K[key] && !standbyFeedbackActive()) {
          toast('hot_standby_feedback needs a connected standby — there is none', 'warn', 5000)
        }
        syncHorizonPin()
        break
      case 'lockContention':
        if (K.poolMode === 'statement' && K.lockContention) {
          K.lockContention = false
          releaseLock()
          rejectStatementTransactionBlock()
        } else if (!K.lockContention) releaseLock()
        break
      case 'standbyAEnabled':
      case 'standbyBEnabled':
      case 'walLevel':
        rep.logicalEnabled = K.walLevel === 'logical'
        syncHorizonPin()
        break
      case 'fullPageWrites':
        fpiGeneration++
        if (!K.fullPageWrites) {
          wal.fpwBurst = 0
          toast('full_page_writes=off — smaller WAL, and torn pages on crash', 'warn', 6000)
        }
        break
      case 'synchronousCommit':
        if (K.synchronousCommit === 'off') toast("synchronous_commit=off — commits no longer wait for fsync", 'warn', 5000)
        else if (
          (K.synchronousCommit === 'remote_write'
            || K.synchronousCommit === 'on'
            || K.synchronousCommit === 'remote_apply')
          && K.synchronousStandbyNames !== 'none'
          && !synchronousStandby().connected
        ) {
          toast('commits will wait until the named synchronous standby returns or synchronous_standby_names is cleared and reloaded', 'warn', 7000)
        }
        break
      case 'synchronousStandbyNames':
        toast(
          K.synchronousStandbyNames !== 'none'
            ? `synchronous_standby_names loaded with ${synchronousStandby().applicationName} — remote commit durability now reduces availability`
            : 'synchronous_standby_names cleared and reloaded — SyncRep waiters released with local durability only',
          K.synchronousStandbyNames !== 'none' ? 'warn' : 'good',
          7000,
        )
        break
      case 'walGArchiveCredentialsValid':
        toast(
          K.walGArchiveCredentialsValid
            ? 'WAL-G object-storage credentials refreshed — wal-push resumes with the oldest .ready segment'
            : 'WAL-G object-storage credentials expired — wal-push returns nonzero and PostgreSQL keeps retrying',
          K.walGArchiveCredentialsValid ? 'good' : 'warn',
          6000,
        )
        break
      case 'walGDownloadConcurrency':
        K.walGDownloadConcurrency = clamp(Math.round(K.walGDownloadConcurrency), 1, 16)
        break
      case 'backupRetention':
        K.backupRetention = clamp(Math.round(K.backupRetention), 1, 5)
        applyBackupRetention()
        break
      case 'recoveryTargetAge':
        K.recoveryTargetAge = clamp(Math.round(K.recoveryTargetAge), 0, 300)
        break
      case 'recoveryTargetTimeline':
        toast(
          K.recoveryTargetTimeline === 'latest'
            ? 'recovery_target_timeline=latest — recovery uses the latest timeline found in the archive'
            : 'recovery_target_timeline=current — recovery stays on the timeline current when the base backup was taken',
          K.recoveryTargetTimeline === 'latest' ? 'good' : 'warn',
          6500,
        )
        break
      case 'restoreDrillFault':
        toast(
          K.restoreDrillFault === 'none'
            ? 'The next full backup will retain healthy modeled evidence'
            : K.restoreDrillFault === 'empty_other_table'
              ? 'Teaching fault armed: orders will restore without its expected row witness in the next full backup'
              : 'Teaching fault armed: the next full backup will retain an object whose digest disagrees with its manifest',
          K.restoreDrillFault === 'none' ? 'good' : 'warn',
          6000,
        )
        break
      case 'haPartition':
        configureHaPartition()
        toast(
          K.haPartition === 'healthy'
            ? 'Network healed: Patroni can use Raft consensus for a linearizable leader-key operation again'
            : K.haPartition === 'isolate_node'
              ? `Primary node isolated: its ${ha.patroni.agents[0].leaseRemainingSec.toFixed(1)} s lease deadline is draining`
              : K.haPartition === 'isolate_dcs_majority'
                ? 'Primary reaches only an etcd minority; that side cannot commit a leader-key operation'
                : 'Every etcd member is isolated: no side has the majority needed to commit',
          K.haPartition === 'healthy' ? 'good' : 'warn',
          6500,
        )
        break
      case 'walLogHints':
        toast(
          K.walLogHints
            ? 'wal_log_hints enabled for future changed-block tracking'
            : 'wal_log_hints off and checksums off — a later pg_rewind will fail',
          K.walLogHints ? 'good' : 'warn',
          6000,
        )
        break
      case 'oldPrimaryDataIntact':
      case 'rewindWalRetained':
        if (!K[key]) {
          toast(
            key === 'oldPrimaryDataIntact'
              ? 'Former primary data directory unavailable — pg_rewind has no source to inspect'
              : 'Divergence WAL recycled — pg_rewind cannot find the common history',
            'warn',
            6000,
          )
        }
        break
      case 'timeScale':
        K.timeScale = clamp(K.timeScale, 0.05, 20)
        break
      default:
        break
    }

    if (!applying) {
      applying = true
      bus.emit('knob', { key, value, source })
      applying = false
    }
  }

  /* ======================================================================
   * STEP
   * ====================================================================*/

  function step(dt: number): void {
    state.t += dt
    flowTokens = Math.min(90, flowTokens + FLOW_BUDGET_PER_SEC * dt)
    pageBudget = PAGE_OPS_PER_SEC * dt
    // Maintenance generated these records on the previous tick. Give that
    // ordered stream first use of wal_buffers so client backends cannot starve
    // vacuum WAL indefinitely under sustained load.
    const leaderAtTickStart = ha.currentLeader === null
      ? null
      : state.cluster.nodes[clusterNodeIndex(ha.currentLeader)]
    if (leaderAtTickStart?.online) drainMaintenanceWal(dt)

    tickScenario(dt)

    // Patroni closes write admission while handing over or after lease loss.
    if (ha.acceptingWrites) {
      nextArrival -= dt
      let guard = 900
      let arrivals = 0
      while (nextArrival <= 0 && guard-- > 0) {
        const d = expDelay(serverOfferedTps(), rng)
        if (!isFinite(d)) { nextArrival = 1e9; break }
        pendingTx++
        arrivals++
        nextArrival += d
      }
      if (K.poolMode === 'session') enqueueSessionArrivals(arrivals)
      else enqueueArrivals(arrivals, state.t)
    }

    tickPostmaster(dt)
    tickLocks(dt)
    tickBackends(dt)
    const activeLeader = ha.currentLeader === null
      ? null
      : state.cluster.nodes[clusterNodeIndex(ha.currentLeader)]
    if (activeLeader?.online) tickBgwriter(dt)
    if (
      activeLeader?.online
      && (
        ha.transition.kind !== 'switchover'
        || ha.transition.status !== 'waiting'
      )
    ) {
      tickCheckpoint(dt)
    }
    if (activeLeader?.online) tickWal(dt)
    tickDisasterRecovery(dt)
    tickReplication(dt)
    tickHighAvailability(dt)
    if (
      activeLeader?.online
      && (
        ha.transition.kind !== 'switchover'
        || ha.transition.status !== 'waiting'
      )
    ) {
      tickAutovac(dt)
    }
    tickTables(dt)
    sweepPool()

    // xmin horizon
    if (horizonFrozen) {
      state.xminHorizon = horizonXid
      state.oldestSnapshotAge = state.t - horizonT
    } else {
      state.xminHorizon = Math.max(horizonXid, state.xid - Math.max(1, stats.activeBackends * 2))
      horizonXid = state.xminHorizon
      state.oldestSnapshotAge = Math.min(2, 0.4 + stats.activeBackends * 0.02)
    }
    for (let i = 0; i < N_TABLES; i++) {
      refreshRepresentativeRow(tables[i].mvcc, state.xminHorizon)
    }

    tickStats(dt)
  }

  function update(dt: number): void {
    if (!isFinite(dt) || dt <= 0) return
    if (K.paused) return
    // The frame timebase normally sends fixed wall-clock steps multiplied by
    // the speed knob. Re-clamping to 0.1 would make higher speeds a silent
    // no-op, so subdivide instead; MAX_STEPS still bounds direct API callers.
    const cap = STEP_MAX * MAX_STEPS
    const d = dt > cap ? cap : dt
    state.realT += d / Math.max(0.05, K.timeScale)
    const steps = d > maxStep ? Math.ceil(d / maxStep) : 1
    const sd = d / steps
    for (let i = 0; i < steps; i++) step(sd)
  }

  /* ======================================================================
   * RESET / WARM-UP
   * ====================================================================*/

  function hardReset(): void {
    Object.assign(K, DEFAULT_KNOBS)
    liveDeficit = 0
    state.t = 0
    state.realT = 0
    state.xid = 100000
    state.xminHorizon = 100000
    state.oldestSnapshotAge = 0
    state.maxConnections =
      N_BACKEND_SLOTS
      + CLAIM_VALUES.connectionPooler.modelConnectionReservations.superuser
      + CLAIM_VALUES.connectionPooler.modelConnectionReservations.reserved
    state.superuserReservedConnections =
      CLAIM_VALUES.connectionPooler.modelConnectionReservations.superuser
    state.reservedConnections =
      CLAIM_VALUES.connectionPooler.modelConnectionReservations.reserved
    state.pooler.mode = DEFAULT_KNOBS.poolMode
    state.pooler.clientConnections = DEFAULT_KNOBS.clientConnections
    state.pooler.acceptedClients = DEFAULT_KNOBS.clientConnections
    state.pooler.refusedClients = 0
    state.pooler.boundClients = 0
    state.pooler.sessionPendingTransactions.fill(0)
    state.pooler.waitingClients = 0
    state.pooler.disconnectedClients = 0
    state.pooler.statementTransactionRejects = 0
    state.pooler.serverConnections = 0
    state.pooler.serverLimit = N_BACKEND_SLOTS
    state.pooler.serverCapacity = N_BACKEND_SLOTS
    state.pooler.serverConnectionErrors = 0
    state.pooler.serverOfferedTps = DEFAULT_KNOBS.tps
    state.scenario = null
    state.scenarioT = 0
    state.scenarioDecision = null
    state.forkPulse = 0
    state.locks.length = 0
    ha.currentLeader = 'primary'
    ha.acceptingWrites = true
    ha.patroni.renewEverySec = HA_LEASE_RENEW_SECONDS
    ha.patroni.demotions = 0
    ha.patroni.splitBrain = false
    const dcs = ha.patroni.dcs
    dcs.leaderMember = 'etcd1'
    dcs.term = 1
    dcs.commitIndex = 1
    dcs.canCommit = true
    dcs.leaderKey.value = 'primary'
    dcs.leaderKey.leaseValid = true
    dcs.leaderKey.ttlSec = HA_LEASE_TTL_SECONDS
    dcs.leaderKey.leaseRemainingSec = HA_LEASE_TTL_SECONDS
    dcs.leaderKey.revision = 1
    dcs.leaderKey.compareAndSwapCount = 1
    dcs.leaderKey.lastOperation = 'compare-and-swap'
    for (let i = 0; i < 3; i++) {
      const agent = ha.patroni.agents[i]
      setLinks(agent.reachableDcsMembers, true, true, true)
      agent.canReachConsensus = true
      agent.observedLeaderKey = 'primary'
      agent.observedTerm = 1
      agent.leaseRemainingSec = HA_LEASE_TTL_SECONDS
      agent.lastDcsResult = i === 0 ? 'compare_and_swap_committed' : 'observed'
      agent.demotions = 0
      const member = dcs.members[i]
      setLinks(member.reachableMembers, true, true, true)
      member.inCommitMajority = true
      member.role = i === 0 ? 'leader' : 'follower'
      member.term = 1
      member.commitIndex = 1
      member.appliedLeaderKey = 'primary'
      member.appliedRevision = 1
    }
    ha.timeline.current = 1
    ha.timeline.parent = 0
    ha.timeline.forkLsn = 0
    ha.timeline.forkedAt = 0
    ha.timeline.oldHistoryEndLsn = INITIAL_WAL_LSN
    ha.timeline.newHistoryEndLsn = INITIAL_WAL_LSN
    ha.transition.kind = 'none'
    ha.transition.status = 'idle'
    ha.transition.source = null
    ha.transition.target = null
    ha.transition.startedAt = 0
    ha.transition.waitSec = 0
    ha.transition.lossBytes = 0
    ha.transition.lossTransactions = 0
    ha.transition.failureReason = ''
    ha.rejoin.required = false
    ha.rejoin.node = null
    ha.rejoin.reinitializeRequired = false
    ha.rejoin.reinitializeNode = null
    ha.rejoin.reinitializeBytes = 0
    ha.rejoin.reinitializeCopiedBytes = 0
    ha.rejoin.blockChangeTrackingAvailable = true
    ha.rejoin.status = 'idle'
    ha.rejoin.progress = 0
    ha.rejoin.startedAt = 0
    ha.rejoin.elapsedSec = 0
    ha.rejoin.estimatedDurationSec = 0
    ha.rejoin.bytesRewound = 0
    ha.rejoin.bytesCopied = 0
    ha.rejoin.failureReason = ''

    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = backends[i]
      b.active = false
      b.state = 'free'
      b.stateT = 0
      b.stateDur = 1
      b.progress = 0
      b.query = 'select_idx'
      b.table = 0
      b.xid = 0
      b.waitOn = -1
      b.rowsSent = 0
      b.buffersTouched = 0
      b.buffersHit = 0
      b.buffersRead = 0
      b.walBytes = 0
      b.walFpiBytes = 0
      b.deadMade = 0
      b.workMemNodes = 0
      b.workMemSortNodes = 0
      b.workMemHashNodes = 0
      b.workMemAllowanceBytes = 0
      b.workMemUsedBytes = 0
      b.workMemSpillNodes = 0
      b.tempFileBytes = 0
      b.lastBuffer = 0
      b.age = 0
      b.plan = null
      b.sql = ''
      extras[i] = makeExtra()
      lockWaitT[i] = 0
    }
    ringBuf.fill(-1)
    pinRing.fill(-1)
    pinPos.fill(0)

    bufMap.clear()
    accessCounts.clear()
    buf.sampleFrames = sampledBufferFrames(K.sharedBuffers)
    buf.valid.fill(0)
    buf.dirty.fill(0)
    buf.pinned.fill(0)
    buf.usage.fill(0)
    buf.rel.fill(255)
    buf.blk.fill(0)
    buf.pageLsn.fill(0)
    buf.lastTouch.fill(-99)
    pinT.fill(-99)
    evictionOwner.fill(0)
    pageLsnOwners.fill(0)
    fpiGenerationByPage.clear()
    fpiGeneration = 0
    buf.clockHand = 0
    buf.hits = 0
    buf.misses = 0
    buf.evictions = asSampleFrames(0)
    buf.dirtyEvictions = 0
    buf.hitRatio = 0.9
    emaHits = emaSeen = 0
    buf.dirtyCount = asSampleFrames(0)
    buf.pinnedCount = asSampleFrames(0)
    buf.usedCount = asSampleFrames(0)
    for (let ni = 1; ni < state.cluster.nodes.length; ni++) {
      const standbyPool = state.cluster.nodes[ni].buffers
      standbyPool.sampleFrames = sampledBufferFrames(K.sharedBuffers)
      standbyPool.valid.fill(0)
      standbyPool.dirty.fill(0)
      standbyPool.pinned.fill(0)
      standbyPool.usage.fill(0)
      standbyPool.rel.fill(255)
      standbyPool.blk.fill(0)
      standbyPool.pageLsn.fill(0)
      standbyPool.lastTouch.fill(-99)
      standbyPool.clockHand = 0
      standbyPool.hits = 0
      standbyPool.misses = 0
      standbyPool.evictions = asSampleFrames(0)
      standbyPool.dirtyEvictions = 0
      standbyPool.hitRatio = 0.96
      standbyPool.dirtyCount = asSampleFrames(0)
      standbyPool.pinnedCount = asSampleFrames(0)
      standbyPool.usedCount = asSampleFrames(0)
    }

    const lsn0 = INITIAL_WAL_LSN
    wal.insertLsn = wal.writeLsn = wal.flushLsn = lsn0
    wal.bufferBytes = 0
    wal.bufferCapacity = walBufferCapacity(K.sharedBuffers)
    wal.bytesPerSec = 0
    wal.fpwBurst = 0
    wal.archiveQueue = 0
    wal.archived = 0
    wal.segmentCount = N_WAL_SEG_SLOTS
    const seg0 = Math.floor(lsn0 / WAL_SEG)
    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const s = segments[i]
      s.id = seg0 - 3 + i
      s.name = walSegName(s.id)
      s.bytes = s.id < seg0 ? WAL_SEG : 0
      s.fill = s.id < seg0 ? 1 : 0
      s.state = s.id < seg0 ? 'archived' : s.id === seg0 ? 'current' : 'recycled'
    }
    archiveNextSeg = seg0
    archiveInFlight = -1
    archT = 0
    archiveRetryT = 0
    lastObservedCurrentSeg = seg0
    closedSegmentId.fill(-1)
    closedSegmentAt.fill(0)
    flushing = false
    flushTarget = lsn0
    flushCovered = lsn0
    flushT = 0
    flushBytes = 0
    walWriterT = 0

    ckpt.phase = 'idle'
    ckpt.progress = 0
    ckpt.buffersToWrite = 0
    ckpt.buffersWritten = asSampleFrames(0)
    ckpt.nextInSec = K.checkpointTimeout * 0.62
    ckpt.elapsed = 0
    ckpt.lastDuration = 0
    ckpt.reason = 'time'
    ckpt.numTimed = 0
    ckpt.numRequested = 0
    ckpt.numDone = 0
    ckpt.count = 0
    ckpt.redoLsn = lsn0
    ckpt.completedRedoLsn = lsn0
    // Both pointers, or the first tick reports a 26-billion-byte pg_wal.
    lastCheckpointEndLsn = lsn0
    ckptNeeded.fill(0)
    ckptScan = 0
    checkpointFlushBuffer = -1
    checkpointFlushLsn = 0
    ckptWriteEnd = 0
    ckptSyncEnd = 0
    ckptRecordTicket = 0
    ioLoad = 1

    bgw.enabled = K.bgwriterEnabled
    bgw.scanPos = 0
    bgw.cleanedTotal = asSampleFrames(0)
    bgw.cleanedPerSec = 0
    bgw.activity = 0
    bgwriterScanRemainder = 0
    clockSweepPasses = 0
    bgwriterScanPasses = 0
    bgwriterCursorValid = true

    av.enabled = K.autovacuum
    av.nextLaunchSec = AV_NAPTIME * 0.4
    av.totalRuns = 0
    av.landfill = 0
    for (let i = 0; i < N_VAC_WORKERS; i++) {
      const w = av.workers[i]
      w.active = false
      w.table = 0
      w.phase = 'idle'
      w.progress = 0
      w.vacuumDelay = false
      w.travel = 0
      w.deadCollected = 0
      w.stalledByHorizon = false
      vacPhaseT[i] = 0
      vacPhaseDur[i] = 1
      vacIdxLeft[i] = 0
      vacTarget[i] = 0
      vacIndexTarget[i] = 0
      vacHeapModified[i] = 0
      vacHeapHotModified[i] = 0
      vacHeapWarmModified[i] = 0
      vacIndexPageTouches[i] = 0
      vacScanModified[i] = 0
      vacFpiGeneration[i] = 0
      vacPageAcc[i] = 0
      vacPageCursor[i] = 0
      vacActiveShare[i] = 1
      vacWorkCredit[i] = 0
    }

    for (let i = 0; i < N_TABLES; i++) {
      const t = tables[i]
      const d = TABLES[i]
      t.autovacuumEnabled = true
      t.pages = d.pages
      t.liveTuples = d.pages * d.tuplesPerPage
      t.reltuples = t.liveTuples
      // The city is a database that has been up for a while, not one that was
      // loaded a second ago, so the tables already carry dead versions. sessions
      // starts just under its threshold: autovacuum has a bay to open in the
      // first half minute at any transaction rate, which is the only way the
      // yard introduces itself before a visitor has stopped looking at it.
      const threshold = Math.min(
        AUTOVACUUM_VACUUM_MAX_THRESHOLD,
        AUTOVACUUM_VACUUM_THRESHOLD + K.autovacuumScaleFactor * t.reltuples,
      )
      const seed = d.id === 'events'
        ? 0
        : Math.round(threshold * (d.id === 'sessions' ? 0.995 : 0.45))
      t.deadTuples = seed
      deadRemovable[i] = seed
      insSinceVacuum[i] = 0
      frozenPages[i] = t.pages
      vacuumInsThreshold[i] = 1000
      deadIndexTuples[i] = 0
      heapWritesSinceVacuum[i] = 0
      indexWritesSinceVacuum[i] = 0
      idxPages[i] = baseIdxPages[i]
      const rt = runtimeTable(i)
      rt.indexPages = idxPages[i]
      rt.deadIndexTuples = 0
      rt.insSinceVacuum = 0
      rt.frozenPages = t.pages
      rt.vacuumInsThreshold = 1000
      t.bloat = 0
      t.vacuumThreshold = threshold
      t.lastVacuum = 0
      t.seqScans = 0
      t.idxScans = 0
      t.inserts = 0
      t.updates = 0
      t.hotUpdates = 0
      t.deletes = 0
      t.heat = 0
      t.vacuuming = false
      t.mvcc = createRepresentativeRow(state.xid - 1, i + 1)
    }

    dr.dataDirectoryBytes = dataDirectoryBytes()
    dr.archive.timeline = 1
    dr.archive.parentTimeline = 0
    dr.archive.parentArchivedThroughLsn = 0
    dr.archive.parentArchivedThroughTime = 0
    dr.archive.historyFileName = ''
    dr.archive.historyFileArchived = false
    dr.archive.queueSegments = 0
    dr.archive.archivedThroughLsn = seg0 * WAL_SEG
    dr.archive.archivedThroughTime = 0
    dr.archive.failedAttempts = 0
    dr.archive.pgWalBytes = N_WAL_SEG_SLOTS * WAL_SEG
    dr.archive.pgWalCapacityBytes = DR_PG_WAL_CAPACITY_BYTES
    dr.archive.writesBlocked = false
    dr.archive.rejectedWrites = 0
    dr.backups.length = 0
    dr.expiredBackups = 0
    dr.oldestRecoverableTime = 0
    dr.backupSchedule.intervalSec = DR_BACKUP_CADENCE_SECONDS
    dr.backupSchedule.nextStartAt = DR_BACKUP_CADENCE_SECONDS
    backupSeq = 1
    earliestBackupCompletedAt = 0
    backupTrigger = 'manual'
    dr.backup.status = 'idle'
    dr.backup.trigger = 'manual'
    dr.backup.progress = 0
    dr.backup.startedAt = 0
    dr.backup.startTimeline = 1
    dr.backup.stopTimeline = 0
    dr.backup.startLsn = 0
    dr.backup.stopLsn = 0
    dr.backup.dataBytes = 0
    dr.backup.objectStoreBytes = 0
    dr.backup.copiedBytes = 0
    dr.backup.estimatedDurationSec = 0
    dr.backup.failureReason = ''
    resetRestore(0)
    resetDrill('verified', 0)

    for (let i = 0 as 0 | 1; i < 2; i = (i + 1) as 0 | 1) {
      const standby = rep.standbys[i]
      const knobKeys = PHYSICAL_STANDBY_KNOBS[i]
      const enabled = K[knobKeys.enabled]
      standby.enabled = enabled
      standby.connected = enabled
      standby.mode = 'async'
      standby.sentLsn = standby.receivedLsn = standby.writtenLsn = lsn0
      standby.flushedLsn = standby.appliedLsn = lsn0
      standby.lagBytes = 0
      standby.lagSec = 0
      standby.networkLagMs = K[knobKeys.networkLag]
      standby.replayPaused = false
      standby.applyActivity = 0
      standby.inFlight = 0
      standby.walSender = enabled ? 'streaming' : 'stopped'
      standby.walReceiver = enabled ? 'streaming' : 'stopped'
      standby.startupProcess = enabled ? 'streaming' : 'stopped'
      standby.acknowledgedWriteLsn = lsn0
      standby.acknowledgedFlushLsn = lsn0
      standby.acknowledgedApplyLsn = lsn0
      const slot = rep.physicalSlots[i]
      slot.exists = true
      slot.active = enabled
      slot.restartLsn = lsn0
      slot.retainedBytes = 0
      resetPhysicalRuntime(physicalRuntime[i], lsn0)
    }
    rep.logicalEnabled = K.walLevel === 'logical'
    rep.logicalSlotLsn = lsn0
    rep.logicalChangesPerSec = 0
    lagSampleHead = 0
    lagSampleCount = 1
    lagSampleLsn[0] = lsn0
    lagSampleAt[0] = state.t
    for (let i = 0; i < state.cluster.nodes.length; i++) {
      const node = state.cluster.nodes[i]
      node.online = i === 0 || rep.standbys[i - 1].enabled
      node.leaderOpinion = 'primary'
      node.role = i === 0 ? 'primary' : 'standby'
      node.wal.receivedLsn = lsn0
      node.wal.writtenLsn = lsn0
      node.wal.flushedLsn = lsn0
      node.wal.appliedLsn = lsn0
      node.wal.segmentCount = N_WAL_SEG_SLOTS
      node.wal.diskBytes = N_WAL_SEG_SLOTS * WAL_SEG
      node.dataDirectory.bytes = dr.dataDirectoryBytes
      node.dataDirectory.appliedLsn = lsn0
    }

    stats.tps = 0
    stats.commits = 0
    stats.rollbacks = 0
    stats.blksHit = 0
    stats.blksRead = 0
    stats.tupReturned = 0
    stats.tupInserted = 0
    stats.tupUpdated = 0
    stats.tupDeleted = 0
    stats.walBytesPerSec = 0
    stats.ioReadPerSec = 0
    stats.ioWritePerSec = asSampleFrames(0)
    stats.ioWriteLoad = 0
    stats.cacheHitPct = 90
    stats.activeBackends = 0
    stats.runningBackends = 0
    stats.poolerQueuedTransactions = 0
    stats.poolerQueryWaitTimeouts = 0
    stats.backendConcurrencyMultiplier = 1
    state.workMem.activeNodes = 0
    state.workMem.activeSortNodes = 0
    state.workMem.activeHashNodes = 0
    state.workMem.activeAllowanceBytes = 0
    state.workMem.activeUsedBytes = 0
    state.workMem.spillingNodes = 0
    state.workMem.liveTempBytes = 0
    state.workMem.tempFiles = 0
    state.workMem.tempBytes = 0
    stats.latency.observations = 0
    stats.latency.transactions = 0
    clearLatencyQuantile(stats.latency.mean)
    clearLatencyQuantile(stats.latency.p50)
    clearLatencyQuantile(stats.latency.p99)
    runtimeStats.pagesFor90Pct = 0
    stats.history.tps.length = 0
    stats.history.hit.length = 0
    stats.history.latencyP50.length = 0
    stats.history.latencyP99.length = 0
    stats.history.wal.length = 0
    stats.history.dirty.length = 0
    stats.history.lag.length = 0

    pendingTx = 0
    clearArrivalQueue()
    nextArrival = 0
    sessionWaitCohortAt = 0
    backgroundSeqScans = 0
    nextWideSeqScan = 1
    latencyTotal.fill(0)
    latencyPoolSlot.fill(0)
    latencyBufferRead.fill(0)
    latencyDirtyWrite.fill(0)
    latencyTempFile.fill(0)
    latencyCommit.fill(0)
    latencyLock.fill(0)
    latencyRunning.fill(0)
    latencyWeight.fill(0)
    latencyHead = 0
    latencyCount = 0
    latencyPoolSlotSeen = false
    commitLsn.fill(0)
    commitCount.fill(0)
    commitHead = 0
    commitSlots = 0
    recoveryCommitLsn.fill(0)
    recoveryCommitAt.fill(0)
    recoveryCommitTimeline.fill(0)
    recoveryCommitHead = 0
    recoveryCommitSlots = 0
    traceQueue.length = 0
    traceRunning = false
    tracePlayback = 'slow'
    traceStepArmed = false
    scenarioQueryKind = null
    scenarioQueryTable = -1
    resetTraceRecord()
    sizeBatch()
    syncPoolerState()
    commitsAcc = walAcc = fpiAcc = ioReadAcc = ioWriteAcc = 0
    maintenanceWalPending = maintenanceFpiPending = 0
    maintenanceWalQueued = maintenanceWalDrained = 0
    winHits = winMisses = 0
    emaHits = emaSeen = 0
    rateT = histT = coverageT = 0
    cleanedAcc = 0
    bgwriterAllocations = 0
    bgwriterAllocationEstimate = 0
    bgwriterFlushBuffer = -1
    bgwriterFlushLsn = 0
    lockHolder = -1
    lockTimeout = LOCK_TIMEOUT_DEFAULT
    horizonFrozen = false
    horizonXid = state.xid
    horizonT = 0
    degradeWarnT = -100
    refuseWarnT = -100
    archiveWriteWarnT = -100
    noBufWarnT = -100
    workMemWarnT = -100
    patroniRenewT = 0
    savedKeys = []
    beatIdx = 0
  }

  function reset(): void {
    hardReset()
    // Warm up silently so the city is never empty on load: pool populated,
    // WAL flowing, checkpoint countdown already part-way through.
    quiet = true
    for (let i = 0; i < 420; i++) step(1 / 30)
    quiet = false
    bus.emit('sim:reset', {})
  }

  function setLeaderOpinion(nodeId: ClusterNodeId, leader: ClusterNodeId | null): void {
    for (let i = 0; i < state.cluster.nodes.length; i++) {
      const node = state.cluster.nodes[i]
      if (node.id !== nodeId) continue
      node.leaderOpinion = leader
      return
    }
  }

  /* ---- bus plumbing: tolerate a UI that drives us through events -------- */

  bus.on('knob', (p) => {
    if (applying) return
    applying = true
    setKnob(p.key, p.value as Knobs[keyof Knobs], p.source)
    applying = false
  })
  bus.on('scenario', (p) => {
    if (applying) return
    if (p.id === state.scenario) return
    applying = true
    runScenario(p.id)
    applying = false
  })

  reset()

  return {
    state,
    update,
    setKnob,
    runScenario,
    chooseScenario,
    recoverScenario,
    request,
    setTraceMode,
    endTrace,
    startBaseBackup,
    startPointInTimeRestore,
    startRestoreDrill,
    setLeaderOpinion,
    startSwitchover,
    startFailover,
    startPgRewind,
    reset,
  }
}
