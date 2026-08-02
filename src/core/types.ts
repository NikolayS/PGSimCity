/* ============================================================================
 * PGSimCity — shared contracts.
 *
 * Everything in this file is API surface consumed by more than one module.
 * The simulation (src/sim) never imports three.js; the world (src/world) never
 * mutates simulation state. They meet here.
 * ==========================================================================*/

import type * as THREE from 'three'
import { CLAIM_VALUES } from './claims'

/* ---------------------------------------------------------------------------
 * City constants — geometry and simulation must agree on these counts.
 * -------------------------------------------------------------------------*/

/** Shared-buffer visual sample is BUF_GRID x BUF_GRID frame tiles. */
export const BUF_GRID = CLAIM_VALUES.bufferSample.gridWidth
export const N_BUFFERS = CLAIM_VALUES.bufferSample.capacityFrames
export type SampleFrames = number & { readonly __sampleFrames: unique symbol }
/** PostgreSQL's standard block size. */
export const PG_PAGE_BYTES = 8 * 1024
/** Real shared_buffers range exposed by the control rail, in binary MiB. */
export const SHARED_BUFFERS_MIN_MIB = 128
export const SHARED_BUFFERS_MAX_MIB = 64 * 1024
/**
 * The declared demo relations total 8 GiB, so this logical pool activates all
 * N_BUFFERS representative frames. Larger settings stay capped because the
 * sampled working set fits and the miss curve is already flat.
 */
export const SHARED_BUFFERS_FULL_SAMPLE_MIB = 8 * 1024
/** How many backend slots exist in the Backend District. */
export const N_BACKEND_SLOTS = 16
/** Visible WAL segment slots in the vault (a moving window of pg_wal). */
export const N_WAL_SEG_SLOTS = 14
/** Autovacuum worker slots (mirrors autovacuum_max_workers). */
export const N_VAC_WORKERS = 3
/** Replica's (smaller) buffer grid. */
export const REPLICA_BUF_GRID = BUF_GRID

/* ---------------------------------------------------------------------------
 * Tables & indexes — the "data" the whole city moves around.
 * -------------------------------------------------------------------------*/

export interface IndexDef {
  id: string
  name: string
  /** btree | gin — purely cosmetic in the model, but shapes the 3D structure. */
  kind: 'btree' | 'gin'
  /** Relative visual size. */
  pages: number
}

export interface TableDef {
  id: string
  name: string
  /** Human blurb shown in the inspector. */
  blurb: string
  /** Base heap size in pages (visual + sim scale). */
  pages: number
  /** Rough tuples per page. */
  tuplesPerPage: number
  /** How hot this table is in the workload (relative weight, sums are normalised). */
  weight: number
  /** Fraction of updates that can be HOT (no index churn). */
  hotFriendly: number
  /** Accent colour (hex int) used by storage + flows. */
  color: number
  indexes: IndexDef[]
  /** Does it have a TOAST sidecar? */
  toast?: boolean
}

/* ---------------------------------------------------------------------------
 * Knobs — user-facing GUCs and workload dials.
 * -------------------------------------------------------------------------*/

export type SyncCommit = 'off' | 'local' | 'remote_write' | 'on' | 'remote_apply'
export type WalLevel = 'minimal' | 'replica' | 'logical'
export type SynchronousStandbyNames = 'none' | 'standbyA' | 'standbyB'
export type HaPartition =
  | 'healthy'
  | 'isolate_node'
  | 'isolate_dcs_majority'
  | 'split_dcs'
export type RestoreDrillFault = 'none' | 'empty_other_table' | 'corrupt_object'
export type RecoveryTargetTimeline = 'latest' | 'current'

export interface Knobs {
  /** Target transactions/sec offered by clients. */
  tps: number
  /** 0..1 — share of statements that write. */
  writeRatio: number
  /** 0..1 — within writes, share that are UPDATE/DELETE (vs INSERT). */
  updateRatio: number
  /** 0..1 — share of reads that are seq scans (vs index scans). */
  seqScanRatio: number
  /** Logical shared_buffers pool size in MiB. The plaza is only a sample. */
  sharedBuffers: number
  /** MiB per eligible executor node; hash nodes receive the fixed multiplier. */
  workMem: number
  /** seconds */
  checkpointTimeout: number
  /** 0..1 */
  checkpointCompletionTarget: number
  /** MiB — WAL volume that forces a checkpoint. */
  maxWalSize: number
  bgwriterEnabled: boolean
  /** pages per bgwriter round */
  bgwriterLruMaxpages: number
  synchronousCommit: SyncCommit
  /** Which follower synchronous_standby_names selects, or an empty setting. */
  synchronousStandbyNames: SynchronousStandbyNames
  walLevel: WalLevel
  fullPageWrites: boolean
  autovacuum: boolean
  /** 0..1 — autovacuum_vacuum_scale_factor */
  autovacuumScaleFactor: number
  /** Hold an ancient snapshot open: pins xmin, blocks cleanup. */
  longRunningXact: boolean
  /** Take a heavyweight lock that blocks writers on one table. */
  lockContention: boolean
  /** Whether standby_a is streaming from the primary. */
  standbyAEnabled: boolean
  /** ms of one-way network delay to standby_a. */
  standbyANetworkLag: number
  /** standby_a applies WAL slower than it arrives. */
  standbyASlowApply: boolean
  /** Whether standby_b is streaming from the primary. */
  standbyBEnabled: boolean
  /** ms of one-way network delay to standby_b. */
  standbyBNetworkLag: number
  /** standby_b applies WAL slower than it arrives. */
  standbyBSlowApply: boolean
  /** A long-running standby_a read reports xmin through hot_standby_feedback. */
  standbyALongQuery: boolean
  /** A long-running standby_b read reports xmin through hot_standby_feedback. */
  standbyBLongQuery: boolean
  /** WAL-G's object-storage credentials are valid for wal-push. */
  walGArchiveCredentialsValid: boolean
  /** Concurrent WAL-G backup-fetch and wal-fetch download workers. */
  walGDownloadConcurrency: number
  /** Full backups kept by the modeled `wal-g delete retain FULL n` policy. */
  backupRetention: number
  /** Seconds before now selected by the recovery_target_time control. */
  recoveryTargetAge: number
  /** Timeline history PostgreSQL may follow while recovering to the target. */
  recoveryTargetTimeline: RecoveryTargetTimeline
  /** Explicit evidence fault injected into the next modeled retained backup. */
  restoreDrillFault: RestoreDrillFault
  /** Which network topology separates Patroni agents and etcd members. */
  haPartition: HaPartition
  /** pg_rewind block-change prerequisite; this model's data checksums are off. */
  walLogHints: boolean
  /** Whether the failed primary's data directory still exists and is readable. */
  oldPrimaryDataIntact: boolean
  /** Whether WAL back to the divergence point has not been recycled. */
  rewindWalRetained: boolean
  /** Simulation speed multiplier. */
  timeScale: number
  paused: boolean
}

export function poolPages(knobs: Pick<Knobs, 'sharedBuffers'>): number {
  return knobs.sharedBuffers * 128
}

export function poolBytes(knobs: Pick<Knobs, 'sharedBuffers'>): number {
  return knobs.sharedBuffers * 1024 * 1024
}

export const DEFAULT_KNOBS: Knobs = {
  tps: 10,
  writeRatio: 0.2,
  updateRatio: 0.6,
  seqScanRatio: 0.15,
  sharedBuffers: 2 * 1024,
  workMem: CLAIM_VALUES.workMem.defaultMiB,
  checkpointTimeout: CLAIM_VALUES.checkpointPolicy.defaultTimeoutSeconds,
  checkpointCompletionTarget: 0.9,
  maxWalSize: CLAIM_VALUES.checkpointPolicy.defaultMaxWalSizeMiB,
  bgwriterEnabled: true,
  bgwriterLruMaxpages: 100,
  synchronousCommit: 'on',
  synchronousStandbyNames: 'standbyA',
  walLevel: 'replica',
  fullPageWrites: true,
  autovacuum: true,
  // PostgreSQL's own default is 0.2. This city ships the per-table tuning its
  // own docs recommend for a busy relation, because at 0.2 the demo tables need
  // ~5,900 dead rows to cross the threshold — which at this transaction rate is
  // most of an hour, and the autovacuum yard, its three bays, its landfill and
  // tour chapter 10 would all sit dead for the whole of a visit.
  autovacuumScaleFactor: 0.02,
  longRunningXact: false,
  lockContention: false,
  standbyAEnabled: true,
  standbyANetworkLag: 30,
  standbyASlowApply: false,
  standbyBEnabled: true,
  standbyBNetworkLag: 55,
  standbyBSlowApply: false,
  standbyALongQuery: false,
  standbyBLongQuery: false,
  walGArchiveCredentialsValid: true,
  walGDownloadConcurrency: 10,
  backupRetention: 3,
  recoveryTargetAge: 20,
  recoveryTargetTimeline: CLAIM_VALUES.timelineRecovery.defaultTarget,
  restoreDrillFault: 'none',
  haPartition: 'healthy',
  walLogHints: true,
  oldPrimaryDataIntact: true,
  rewindWalRetained: true,
  timeScale: 1,
  paused: false,
}

/* ---------------------------------------------------------------------------
 * Simulation state.
 * -------------------------------------------------------------------------*/

export type BackendState =
  | 'free'        // slot unused
  | 'starting'    // postmaster forked it
  | 'idle'        // connected, waiting for a query
  | 'idle_in_xact'
  | 'parse'
  | 'plan'
  | 'exec_cpu'    // running, CPU bound
  | 'exec_io'     // waiting for a buffer read
  | 'sort'        // work_mem / temp file
  | 'wal_insert'
  | 'eviction_flush' // FlushBuffer waiting for the victim page's WAL
  | 'commit_wait' // waiting on fsync / sync replication
  | 'blocked'     // waiting on a heavyweight lock
  | 'sending'     // streaming rows back
  | 'ending'

export type QueryKind =
  | 'select_idx'
  | 'select_seq'
  | 'aggregate'
  | 'insert'
  | 'update'
  | 'delete'

export type TraceStop =
  | 'connect'
  | 'parse_plan'
  | 'fetch'
  | 'work'
  | 'wal'
  | 'commit'
  | 'send'
  | 'done'
  | 'blocked'

export interface TraceRecord {
  /** backend slot carrying the requested statement; -1 while connecting */
  slot: number
  query: QueryKind
  /** index into SimState.tables */
  table: number
  sql: string
  stop: TraceStop
  /** simulated seconds from the start of this trip to the current stop */
  stopT: number
  /** one bit per TraceStop, set by the model when that stop is entered */
  visited: number
  /** transactions represented by the completed backend trip */
  trips: number
  lastXid: number
  lastPlanLabel: string
  lastPlanRows: number
  lastPlanCost: number
  rowsSent: number
  buffersHit: number
  buffersRead: number
  walBytes: number
  walFpiBytes: number
  deadMade: number
  lastTripSec: number
}

export interface TraceRequestOptions {
  /** Override the model's HOT choice for a teaching example. */
  hot?: boolean
  /** Reader-entered SQL retained as the receipt; execution still follows QueryKind. */
  sql?: string
}

export type TracePlayback = 'step' | 'slow' | 'live'

export interface PlanNode {
  id: number
  label: string
  detail: string
  /** rows estimate (cosmetic) */
  rows: number
  cost: number
  actualMs: number
  children: PlanNode[]
  /** 0..1 — lit up while this node is "running". */
  activity: number
}

export interface BackendSim {
  slot: number
  active: boolean
  state: BackendState
  /** seconds spent in current state */
  stateT: number
  /** expected duration of current state */
  stateDur: number
  /** 0..1 */
  progress: number
  query: QueryKind
  /** index into SimState.tables */
  table: number
  xid: number
  /** slot of the backend we're waiting on, or -1 */
  waitOn: number
  rowsSent: number
  buffersTouched: number
  buffersHit: number
  buffersRead: number
  walBytes: number
  /** full-page-image portion of walBytes */
  walFpiBytes: number
  /** dead row versions created by this trip */
  deadMade: number
  /** Eligible fixed-template nodes; work_mem is an allowance for each one. */
  workMemNodes: number
  workMemSortNodes: number
  workMemHashNodes: number
  /** Sum of node allowances, not a claim that every node peaks simultaneously. */
  workMemAllowanceBytes: number
  /** Sum of modeled working bytes retained by the eligible nodes. */
  workMemUsedBytes: number
  workMemSpillNodes: number
  /** Per represented statement; cumulative counters account for batched trips. */
  tempFileBytes: number
  /** last shared-buffer index this backend touched (for flow targeting) */
  lastBuffer: number
  /** total lifetime in seconds (connections are recycled) */
  age: number
  plan: PlanNode | null
  /** cosmetic: label like "SELECT … FROM orders" */
  sql: string
}

export interface BufferPool {
  /** Active frames in the representative sample. Later entries are dark. */
  sampleFrames: SampleFrames
  valid: Uint8Array
  dirty: Uint8Array
  pinned: Uint8Array
  /** clock-sweep usage_count 0..5 */
  usage: Uint8Array
  /** which table (index into tables) the page belongs to; 255 = none */
  rel: Uint8Array
  /** sim time of last touch, for the "heat" shader */
  lastTouch: Float32Array
  /** page number inside the relation (cosmetic) */
  blk: Uint32Array
  /** Latest WAL position required before each sampled page may be written. */
  pageLsn: Float64Array
  clockHand: number
  /**
   * hits and misses count the full logical request stream. evictions,
   * dirtyEvictions, dirtyCount, pinnedCount and usedCount are sample-only.
   */
  hits: number
  misses: number
  evictions: SampleFrames
  dirtyEvictions: number
  /** smoothed 0..1 */
  hitRatio: number
  dirtyCount: SampleFrames
  pinnedCount: SampleFrames
  usedCount: SampleFrames
}

export type WalSegState = 'current' | 'full' | 'archiving' | 'archived' | 'recycled' | 'streamed'

export interface WalSegment {
  id: number
  /** e.g. 000000010000000000000023 */
  name: string
  bytes: number
  state: WalSegState
  /** 0..1 fill */
  fill: number
}

export interface WalState {
  /** monotonically increasing byte positions */
  insertLsn: number
  writeLsn: number
  flushLsn: number
  /** bytes sitting in wal_buffers */
  bufferBytes: number
  bufferCapacity: number
  segmentSize: number
  segments: WalSegment[]
  bytesPerSec: number
  /** 0..1 — elevated right after a checkpoint (full-page images) */
  fpwBurst: number
  archiveQueue: number
  archived: number
  /** how many segments exist right now (pg_wal size) */
  segmentCount: number
}

export type CheckpointPhase = 'idle' | 'start' | 'writing' | 'syncing' | 'finishing'

export interface CheckpointState {
  phase: CheckpointPhase
  /** 0..1 through the write phase */
  progress: number
  buffersToWrite: number
  buffersWritten: SampleFrames
  nextInSec: number
  elapsed: number
  lastDuration: number
  reason: 'time' | 'wal' | 'manual'
  count: number
  /** LSN at REDO point of the running/last checkpoint */
  redoLsn: number
  /** REDO point recorded by the last completed checkpoint in pg_control. */
  completedRedoLsn: number
}

export interface BgwriterState {
  enabled: boolean
  /** clock position 0..N_BUFFERS */
  scanPos: number
  cleanedTotal: SampleFrames
  cleanedPerSec: number
  /** 0..1 how busy it looks */
  activity: number
}

export type VacPhase = 'idle' | 'travel' | 'scan_heap' | 'vacuum_index' | 'vacuum_heap' | 'truncate' | 'analyze' | 'return'

export interface VacWorker {
  slot: number
  active: boolean
  table: number
  phase: VacPhase
  progress: number
  /** true only while cost-based throttling is sleeping */
  vacuumDelay: boolean
  /** 0..1 along its travel route */
  travel: number
  deadCollected: number
  /** blocked by an old xmin horizon — dead tuples can't be removed */
  stalledByHorizon: boolean
}

export interface AutovacState {
  enabled: boolean
  nextLaunchSec: number
  workers: VacWorker[]
  totalRuns: number
  /** cosmetic pile of removed tuples at the landfill */
  landfill: number
}

export interface MvccSnapshot {
  /** XIDs below xmin completed before this snapshot. */
  xmin: number
  /** XIDs at or above xmax had not started when this snapshot was taken. */
  xmax: number
  /** XIDs between xmin and xmax that were still in progress. */
  inProgress: number[]
  takenAt: number
  /** Only the deliberately held older snapshot can pin the global horizon. */
  active: boolean
  /** Model-computed revision visible through this snapshot. */
  visibleRevision: number
}

export interface MvccTupleVersion {
  revision: number
  /** Transaction that inserted this physical row version. */
  xmin: number
  /** Transaction that replaced it; zero means this is the current version. */
  xmax: number
  createdAt: number
  /** This version was created by a HOT update. */
  hot: boolean
  /** This version was replaced through a same-page HOT link. */
  nextHot: boolean
  /** Representative TID, not bytes decoded from a real block. */
  block: number
  offset: number
  /** Heap TID stored by the index entry for this version's HOT chain. */
  indexBlock: number
  indexOffset: number
  /** Model-owned t_ctid target; self for the current version. */
  ctidBlock: number
  ctidOffset: number
  /** Revision at t_ctid, or zero while t_ctid points to self. */
  nextRevision: number
  /** Model-computed vacuum eligibility at the current xmin horizon. */
  collectable: boolean
}

/**
 * A sampled single-row history. Aggregate tuple counts remain relation-wide;
 * this bounded story exists to expose the MVCC rule those counts result from.
 */
export interface MvccRowStory {
  versions: MvccTupleVersion[]
  earlierSnapshot: MvccSnapshot
  laterSnapshot: MvccSnapshot
  nextSampleAt: number
  collectedVersions: number
  /** Bounded-history count whose individual headers are no longer retained. */
  omittedVersions: number
  /** Greatest xmax among omitted versions; all are removable after this XID. */
  omittedThroughXmax: number
}

export interface TableSim {
  def: TableDef
  pages: number
  /** Live total across this table's index relation files, including bloat. */
  indexPages: number
  liveTuples: number
  deadTuples: number
  /** deadTuples / (live+dead) */
  bloat: number
  /** autovacuum_vacuum_threshold + scale_factor * live */
  vacuumThreshold: number
  lastVacuum: number
  seqScans: number
  idxScans: number
  inserts: number
  updates: number
  hotUpdates: number
  deletes: number
  /** 0..1 activity heat, decays */
  heat: number
  /** currently being vacuumed */
  vacuuming: boolean
  /** Model-owned representative row used by page anatomy. */
  mvcc: MvccRowStory
}

export interface ReplicationState {
  logicalEnabled: boolean
  logicalSlotLsn: number
  logicalChangesPerSec: number
  /** The two independent physical streams fed by separate walsenders. */
  standbys: [PhysicalStandbyState, PhysicalStandbyState]
  /** Physical slots survive connection loss and retain primary WAL. */
  physicalSlots: [PhysicalReplicationSlotState, PhysicalReplicationSlotState]
}

export type ClusterNodeId = 'primary' | 'standbyA' | 'standbyB'

export interface ClusterNodeWalState {
  /** Furthest byte accepted by this node. On the primary this is insert_lsn. */
  receivedLsn: number
  /** Furthest byte written into this node's pg_wal files. */
  writtenLsn: number
  /** Furthest byte made durable in this node's pg_wal files. */
  flushedLsn: number
  /** Furthest byte whose records have changed data pages on this node. */
  appliedLsn: number
  segmentSize: number
  segmentCount: number
  diskBytes: number
}

export interface ClusterDataDirectoryState {
  bytes: number
  /** Primary pages are current; standby pages are current only through this LSN. */
  appliedLsn: number
}

export interface ClusterNodeState {
  id: ClusterNodeId
  name: 'primary' | 'standby_a' | 'standby_b'
  /** `diverged` is a former primary that cannot follow the new timeline yet. */
  role: 'primary' | 'standby' | 'diverged'
  online: boolean
  /**
   * This node's observation, not a cluster-wide truth. Patroni acts through
   * the linearizable DCS leader key; a stale opinion never authorizes writes.
   */
  leaderOpinion: ClusterNodeId | null
  buffers: BufferPool
  wal: ClusterNodeWalState
  dataDirectory: ClusterDataDirectoryState
}

export interface ClusterState {
  nodes: [ClusterNodeState, ClusterNodeState, ClusterNodeState]
}

export type HaTransitionKind = 'none' | 'switchover' | 'failover'
export type HaTransitionStatus = 'idle' | 'waiting' | 'complete' | 'failed'
export type PgRewindStatus = 'idle' | 'checking' | 'rewinding' | 'complete' | 'failed'

export type EtcdMemberId = 'etcd1' | 'etcd2' | 'etcd3'
export type EtcdMemberRole = 'leader' | 'follower' | 'candidate'
export type PatroniDcsResult =
  | 'observed'
  | 'renewed'
  | 'compare_and_swap_committed'
  | 'unreachable'
  | 'no_consensus'

export interface PatroniAgentState {
  nodeId: ClusterNodeId
  /** This agent's network paths to etcd-1, etcd-2, and etcd-3. */
  reachableDcsMembers: [boolean, boolean, boolean]
  /** A linearizable operation can reach the current Raft commit majority. */
  canReachConsensus: boolean
  /** Last linearizable view; stale minority reads never update this field. */
  observedLeaderKey: ClusterNodeId | null
  observedTerm: number
  /** Local safety deadline for the last observed lease. */
  leaseRemainingSec: number
  lastDcsResult: PatroniDcsResult
  demotions: number
}

export interface EtcdMemberState {
  id: EtcdMemberId
  failureDomain: ClusterNodeId
  role: EtcdMemberRole
  /** Network paths to etcd-1, etcd-2, and etcd-3, including itself. */
  reachableMembers: [boolean, boolean, boolean]
  inCommitMajority: boolean
  term: number
  commitIndex: number
  appliedLeaderKey: ClusterNodeId | null
  appliedRevision: number
}

export interface LeaderKeyState {
  /** Value in the latest committed Raft log entry. */
  value: ClusterNodeId | null
  /** False when its attached lease TTL has elapsed. */
  leaseValid: boolean
  ttlSec: number
  leaseRemainingSec: number
  revision: number
  compareAndSwapCount: number
  lastOperation: 'compare-and-swap' | 'renew' | 'lease-expired'
}

export interface DcsConsensusState {
  algorithm: 'Raft'
  members: [EtcdMemberState, EtcdMemberState, EtcdMemberState]
  majority: 2
  leaderMember: EtcdMemberId | null
  term: number
  commitIndex: number
  /** Whether a connected component currently has the majority needed to commit. */
  canCommit: boolean
  leaderKey: LeaderKeyState
}

export interface PatroniState {
  /** One independently observing Patroni process beside each PostgreSQL node. */
  agents: [PatroniAgentState, PatroniAgentState, PatroniAgentState]
  /** etcd members committing one linearizable leader key through Raft. */
  dcs: DcsConsensusState
  renewEverySec: number
  demotions: number
  /**
   * Always false: a CAS can commit only on the Raft majority side, and an
   * isolated holder demotes when its last observed lease reaches its TTL.
   */
  splitBrain: boolean
}

export interface TimelineForkState {
  current: number
  parent: number
  forkLsn: number
  /** Simulated time at which the one modeled promotion created the fork. */
  forkedAt: number
  /** Last durable byte on the former primary's now-divergent history. */
  oldHistoryEndLsn: number
  /** Last byte generated on the promoted node's history. */
  newHistoryEndLsn: number
}

export interface HaTransitionState {
  kind: HaTransitionKind
  status: HaTransitionStatus
  source: ClusterNodeId | null
  target: ClusterNodeId | null
  startedAt: number
  waitSec: number
  lossBytes: number
  /** Committed write transactions whose commit records did not reach target. */
  lossTransactions: number
  failureReason: string
}

export interface PgRewindState {
  required: boolean
  node: ClusterNodeId | null
  /** A follower ahead of the fork cannot enter the new timeline directly. */
  reinitializeRequired: boolean
  reinitializeNode: ClusterNodeId | null
  reinitializeBytes: number
  reinitializeCopiedBytes: number
  /** Captured at divergence; enabling wal_log_hints afterwards is too late. */
  blockChangeTrackingAvailable: boolean
  status: PgRewindStatus
  progress: number
  startedAt: number
  elapsedSec: number
  estimatedDurationSec: number
  bytesRewound: number
  bytesCopied: number
  failureReason: string
}

export interface HighAvailabilityState {
  currentLeader: ClusterNodeId | null
  acceptingWrites: boolean
  patroni: PatroniState
  timeline: TimelineForkState
  transition: HaTransitionState
  rejoin: PgRewindState
}

export type ReplicationProcessState = 'stopped' | 'catchup' | 'streaming'

export interface PhysicalStandbyState {
  nodeId: 'standbyA' | 'standbyB'
  applicationName: 'standby_a' | 'standby_b'
  enabled: boolean
  connected: boolean
  mode: 'async' | 'sync'
  /** Primary-side walsender progress. */
  sentLsn: number
  /** Bytes delivered to walreceiver, before its local write catches up. */
  receivedLsn: number
  /** Bytes written to the standby's own pg_wal. */
  writtenLsn: number
  /** Bytes fsynced in the standby's own pg_wal. */
  flushedLsn: number
  /** Bytes replayed by the standby startup process. */
  appliedLsn: number
  lagBytes: number
  lagSec: number
  networkLagMs: number
  applyActivity: number
  inFlight: number
  walSender: ReplicationProcessState
  walReceiver: ReplicationProcessState
  startupProcess: ReplicationProcessState
  /** Primary has received this standby's write/durable/apply acknowledgements. */
  acknowledgedWriteLsn: number
  acknowledgedFlushLsn: number
  acknowledgedApplyLsn: number
}

export interface PhysicalReplicationSlotState {
  name: 'standby_a_slot' | 'standby_b_slot'
  standbyId: 'standbyA' | 'standbyB'
  /** False after DROP_REPLICATION_SLOT; the standby then needs a new base backup. */
  exists: boolean
  active: boolean
  restartLsn: number
  retainedBytes: number
}

export type BaseBackupStatus = 'idle' | 'copying' | 'waiting_wal' | 'failed'

export interface BaseBackupWalRange {
  /** Timeline from the backup manifest's WAL-Ranges entry. */
  timeline: number
  /** First LSN that must be readable on this timeline. */
  startLsn: number
  /** Earliest LSN where replay may stop on this timeline. */
  endLsn: number
}

export interface BaseBackup {
  id: number
  /** WAL-G base-backup name derived from the backup start WAL segment. */
  label: string
  startedAt: number
  completedAt: number
  /** Timeline current at backup start; walRanges owns the full requirement. */
  startTimeline: number
  startLsn: number
  stopLsn: number
  /** Chronological WAL requirements from the modeled backup manifest. */
  walRanges: BaseBackupWalRange[]
  /** Logical bytes read from the data directory. */
  dataBytes: number
  /** Scaled compressed bytes stored in object storage. */
  objectStoreBytes: number
  durationSec: number
  source: 'standby_a'
  trigger: 'manual' | 'schedule'
  tool: 'WAL-G'
  /** Deterministic model digest for the backup manifest captured at backup time. */
  manifestDigest: number
  /** Digest of the retained object contents; verification compares this to the manifest. */
  objectDigest: number
  /** One bit per declared relation that contained a row witness in this backup. */
  smokeTableMask: number
}

export interface BaseBackupOperation {
  status: BaseBackupStatus
  trigger: 'manual' | 'schedule'
  progress: number
  startedAt: number
  startTimeline: number
  stopTimeline: number
  startLsn: number
  stopLsn: number
  dataBytes: number
  objectStoreBytes: number
  copiedBytes: number
  estimatedDurationSec: number
  failureReason: string
}

export interface BaseBackupSchedule {
  /** One real day represented on the continuity quarter's teaching clock. */
  intervalSec: number
  /** Absolute simulated time of the next automatic backup-push attempt. */
  nextStartAt: number
}

export type PointInTimeRestoreStatus =
  | 'idle'
  | 'fetching'
  | 'replaying'
  | 'complete'
  | 'failed'

export interface PointInTimeRestore {
  status: PointInTimeRestoreStatus
  progress: number
  targetTime: number
  /** Transaction-end record proving that recovery can cross targetTime; zero if absent. */
  targetRecordLsn: number
  targetLsn: number
  recoveryTargetTimeline: RecoveryTargetTimeline
  /** Timeline current at backup start, used by recovery_target_timeline=current. */
  backupTimeline: number
  targetTimeline: number
  crossesTimelineFork: boolean
  historyFileName: string
  followedHistoryFile: boolean
  /** Parent replay end; latest caps at the fork, while current may use its archived tail. */
  parentReplayEndLsn: number
  backupId: number
  backupAgeSec: number
  backupBytesRequired: number
  backupBytesFetched: number
  walBytesRequired: number
  /** WAL bytes currently available on the contiguous selected archive history. */
  walBytesAvailable: number
  walBytesReplayed: number
  /** Latest transaction-end timestamp reached in the available selected history. */
  lastReachedTime: number
  /** Timeline of the transaction-end record that supplied lastReachedTime. */
  lastReachedTimeline: number
  estimatedDurationSec: number
  elapsedSec: number
  failureReason: string
  /** Exact successful outcome retained after a PITR or drill finishes. */
  resultMessage: string
  /** Missing-WAL result from the latest archive evaluation. */
  pendingWalFailureReason: string
  /** Backup/control-file incompatibility discovered when recovery starts. */
  pendingStartupFailureReason: string
  /** This PITR operation stops at the target; promotion is a separate HA action. */
  promoted: false
}

export type RestoreDrillLevel = 'table' | 'cluster' | 'verified'

export type RestoreDrillStatus =
  | 'idle'
  | 'restoring'
  | 'verifying'
  | 'querying'
  | 'passed'
  | 'failed'

export interface RestoreDrill {
  level: RestoreDrillLevel
  status: RestoreDrillStatus
  evidenceRank: number
  progress: number
  startedAt: number
  completedAt: number
  targetTime: number
  backupId: number
  /** Age of the selected backup at recovery_target_time. */
  backupAgeSec: number
  /** Compressed backup objects read from storage, before local extraction. */
  backupObjectBytesRequired: number
  walBytesRequired: number
  estimatedRestoreToTargetSec: number
  measuredRestoreToTargetSec: number
  estimatedDurationSec: number
  elapsedSec: number
  objectStoreBytesRead: number
  checksumBytesRequired: number
  checksumBytesRead: number
  smokeBytesRequired: number
  smokeBytesRead: number
  validationBytesRequired: number
  validationBytesRead: number
  manifestDigest: number
  restoredDigest: number
  smokeTableMask: number
  failureReason: string
}

export interface ArchiveRecoveryState {
  /** Timeline whose live frontier the unqualified fields below describe. */
  timeline: number
  /** The one modeled parent timeline, or zero before promotion. */
  parentTimeline: number
  /** Retained parent WAL may extend beyond the fork for current-timeline recovery. */
  parentArchivedThroughLsn: number
  parentArchivedThroughTime: number
  historyFileName: string
  historyFileArchived: boolean
  queueSegments: number
  archivedThroughLsn: number
  archivedThroughTime: number
  failedAttempts: number
  pgWalBytes: number
  pgWalCapacityBytes: number
  /**
   * Teaching-scale guard. Real PostgreSQL PANICs when the filesystem fills;
   * the city keeps reads and the archiver alive so the incident can be watched.
   */
  writesBlocked: boolean
  rejectedWrites: number
}

export interface DisasterRecoveryState {
  /** The concrete behavior used where WAL-G and pgBackRest differ. */
  tool: 'WAL-G'
  dataDirectoryBytes: number
  archive: ArchiveRecoveryState
  backups: BaseBackup[]
  expiredBackups: number
  oldestRecoverableTime: number
  backupSchedule: BaseBackupSchedule
  backup: BaseBackupOperation
  restore: PointInTimeRestore
  drill: RestoreDrill
}

export interface LockEdge {
  holder: number
  waiter: number
  table: number
  mode: string
  ageSec: number
}

/** Additive anatomy of one completed model-latency observation. */
export interface LatencyWaits {
  bufferReadMs: number
  dirtyWriteMs: number
  tempFileMs: number
  commitMs: number
  lockMs: number
  runningMs: number
}

export interface WorkMemState {
  activeNodes: number
  activeSortNodes: number
  activeHashNodes: number
  activeAllowanceBytes: number
  activeUsedBytes: number
  spillingNodes: number
  /** Current representative bytes visible under active backend slots. */
  liveTempBytes: number
  /** Cumulative pg_stat_database-shaped counters since model reset. */
  tempFiles: number
  tempBytes: number
}

export interface LatencyQuantile {
  /** Deliberately stretched backend lifecycle time, never production time. */
  totalMs: number
  /** Independent weighted quantile for each component distribution. */
  waits: LatencyWaits
}

export interface LatencyStats {
  /** Completed backend trips currently retained in the fixed rolling window. */
  observations: number
  /** Transactions represented by those trips; quantiles are weighted by this. */
  transactions: number
  /** Weighted mean; unlike component quantiles, its anatomy is additive. */
  mean: LatencyQuantile
  p50: LatencyQuantile
  p99: LatencyQuantile
}

export interface SimStats {
  tps: number
  commits: number
  rollbacks: number
  blksHit: number
  blksRead: number
  tupReturned: number
  tupInserted: number
  tupUpdated: number
  tupDeleted: number
  walBytesPerSec: number
  /** Full logical page stream; unlike ioWritePerSec, this is not sampled. */
  ioReadPerSec: number
  /** Representative-sample write rate; do not present it as full-pool I/O. */
  ioWritePerSec: SampleFrames
  /** Normalized representative-sample write pressure for presentation. */
  ioWriteLoad: number
  cacheHitPct: number
  /** Occupied connection slots, including idle sessions. */
  activeBackends: number
  /** Backends whose pg_stat_activity state is active. */
  runningBackends: number
  /** Rolling weighted transaction quantiles in deliberately stretched model ms. */
  latency: LatencyStats
  /** rolling window for sparklines: newest last */
  history: {
    tps: number[]
    hit: number[]
    latencyP50: number[]
    latencyP99: number[]
    wal: number[]
    dirty: number[]
    lag: number[]
  }
}

export type ScenarioDecisionPhase =
  | 'staging'
  | 'ready'
  | 'outcome'
  | 'recovering'
  | 'recovered'

export type ScenarioChoiceId =
  | 'add-wal-capacity'
  | 'drop-replication-slot'
  | 'terminate-transaction'
  | 'wait-for-transaction'
  | 'promote-standby-a'
  | 'promote-standby-b'

interface ScenarioDecisionBase {
  phase: ScenarioDecisionPhase
  choice: ScenarioChoiceId | null
  /** Testable judgement for this staged situation; never rendered as a score. */
  correct: boolean | null
}

export interface SlotPressureDecisionState extends ScenarioDecisionBase {
  kind: 'slot-pressure'
  slotRetainedAtDecision: number
  capacityAtDecision: number
  addedCapacityBytes: number
  rebuildRequired: boolean
  rebuildBytes: number
  rebuildCopiedBytes: number
  rejectedWritesAtDecision: number
  rejectedWrites: number
}

export interface VacuumBlockadeDecisionState extends ScenarioDecisionBase {
  kind: 'vacuum-blockade'
  deadTuplesAtDecision: number
  pagesAtDecision: number
  vacuumRunsAtDecision: number
  landfillAtDecision: number
  deadTuplesAdded: number
  pagesAdded: number
  blockedVacuumWorkers: number
  deadTuplesReclaimed: number
  transactionTerminated: boolean
}

export interface FailoverCandidateDecisionState extends ScenarioDecisionBase {
  kind: 'failover-candidate'
  standbyALagBytes: number
  standbyBLagBytes: number
  lossBytes: number
  lossTransactions: number
  rejoinBytes: number
}

export type ScenarioDecisionState =
  | SlotPressureDecisionState
  | VacuumBlockadeDecisionState
  | FailoverCandidateDecisionState

export interface SimState {
  /** simulated seconds since boot */
  t: number
  /** wall seconds since boot */
  realT: number
  knobs: Knobs
  xid: number
  /** Global visibility cutoff; a replacing xmax must precede it to be removable. */
  xminHorizon: number
  oldestSnapshotAge: number
  maxConnections: number
  backends: BackendSim[]
  buffers: BufferPool
  wal: WalState
  checkpoint: CheckpointState
  bgwriter: BgwriterState
  autovac: AutovacState
  tables: TableSim[]
  replication: ReplicationState
  cluster: ClusterState
  highAvailability: HighAvailabilityState
  disasterRecovery: DisasterRecoveryState
  locks: LockEdge[]
  workMem: WorkMemState
  stats: SimStats
  /** id of the running scenario, if any */
  scenario: string | null
  scenarioT: number
  /** Model-owned state for one of the three operator judgement scenarios. */
  scenarioDecision: ScenarioDecisionState | null
  /** postmaster fork animation pulses */
  forkPulse: number
  /** model-owned record of the requested statement trip */
  trace: TraceRecord
}

export interface SimApi {
  state: SimState
  /** advance by dt simulated seconds (already scaled by timeScale) */
  update(dt: number): void
  setKnob<K extends keyof Knobs>(key: K, value: Knobs[K], source?: 'user'): void
  runScenario(id: string | null): void
  /** Apply one of the visible operator choices in an interactive scenario. */
  chooseScenario(choice: ScenarioChoiceId): boolean
  /** Repair the survivable consequence of the selected choice. */
  recoverScenario(): boolean
  request(kind: QueryKind, table: number, opts?: TraceRequestOptions): void
  setTraceMode(mode: TracePlayback): void
  endTrace(): void
  /** Start a WAL-G full backup-push from standby_a to object storage. */
  startBaseBackup(): boolean
  /** Restore to `targetAgeSec` before now, or the recoveryTargetAge control. */
  startPointInTimeRestore(targetAgeSec?: number): boolean
  /** Exercise the retained backup and archive, then run the selected proof level. */
  startRestoreDrill(level: RestoreDrillLevel, targetAgeSec?: number): boolean
  /** Record one node's observation; the DCS leader key remains authoritative. */
  setLeaderOpinion(node: ClusterNodeId, leader: ClusterNodeId | null): void
  /** Stop writes, wait for the selected standby, then hand over with no loss. */
  startSwitchover(target?: 'standbyA' | 'standbyB'): boolean
  /** Model loss of the current primary and promote a selected durable position. */
  startFailover(target?: 'standbyA' | 'standbyB'): boolean
  /** Rewind the former primary to the recorded divergence point. */
  startPgRewind(): boolean
  reset(): void
}

/* ---------------------------------------------------------------------------
 * Event bus.
 * -------------------------------------------------------------------------*/

export type FlowKind =
  | 'query'      // client → backend
  | 'result'     // backend → client
  | 'page_read'  // storage → shared buffers
  | 'page_write' // shared buffers → storage
  | 'wal'        // wal record
  | 'wal_flush'
  | 'archive'
  | 'stream'     // replication
  | 'ack'
  | 'dead'       // dead tuples to the landfill
  | 'fork'       // postmaster spawning
  | 'stat'

/** A request to send N particles down a named route. */
export interface FlowRequest {
  route: string
  count?: number
  /** hex colour; defaults to the route's colour */
  color?: number
  /** world units/sec; defaults to the route's speed */
  speed?: number
  size?: number
  kind?: FlowKind
  /** lateral jitter in world units */
  spread?: number
  /** stagger emission over this many seconds */
  stagger?: number
}

export interface BusEvents {
  flow: FlowRequest
  /** camera should frame a component */
  focus: { id: string | null; instant?: boolean }
  /** inspector panel target changed; `part` names a directly-picked substructure */
  select: { id: string | null; part?: 'page'; outlineOnly?: boolean; source?: 'building' }
  hover: { id: string | null }
  knob: { key: keyof Knobs; value: unknown; source?: 'user' }
  scenario: { id: string | null }
  toast: {
    text: string
    kind?: 'info' | 'warn' | 'good'
    ms?: number
    action?: { label: string; quality: QualityLevel }
  }
  narrate: { title: string; body: string; seconds?: number } | null
  'tour:start': { chapter?: number; source?: 'button' | 'keyboard' }
  'tour:stop': Record<string, never>
  'tour:chapter': { index: number; total: number; title: string }
  'trace:open': { source?: 'button' | 'keyboard' }
  'trace:run': { statement: QueryKind; table: string; playback: TracePlayback }
  'panel:open': { panel: 'console' | 'inspector' | 'help'; item?: string }
  /** open one of the physical anatomy instruments, optionally for a component */
  'anatomy:open': { view: 'page' | 'directory'; id?: string }
  'camera:mode': { mode: CameraMode }
  /** named framing preset currently controlling the composition */
  'camera:preset': { preset: 'plan' | null }
  /** first meaningful map gesture in the current pointer interaction */
  'camera:gesture': { kind: 'pan' | 'rotate'; pointer: 'mouse' | 'touch' }
  'quality': { level: QualityLevel }
  'sim:reset': Record<string, never>
  'checkpoint:start': { reason: string }
  'checkpoint:end': { duration: number }
  'audio:toggle': Record<string, never>
  'ui:camera-preset': { preset: 'plan' }
  'ui:console': { open?: boolean; key?: string }
  'ui:escape': { handled: boolean }
  'ui:help': { open?: boolean; section?: 'controls' | 'legend' | 'reading' | 'legal' }
  'ui:labels-toggle': Record<string, never>
  'ui:palette': { open?: boolean }
  'ui:theme-toggle': Record<string, never>
}

export type BusHandler<K extends keyof BusEvents> = (payload: BusEvents[K]) => void

export interface Bus {
  on<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  once<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void
  off<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): void
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void
}

/* ---------------------------------------------------------------------------
 * World modules & the component registry.
 * -------------------------------------------------------------------------*/

export type DistrictId =
  | 'clients'
  | 'backends'
  | 'shmem'
  | 'wal'
  | 'storage'
  | 'maintenance'
  | 'replication'
  | 'planner'
  | 'world'

export type ComponentKind =
  | 'process'   // an OS process
  | 'memory'    // shared/local memory structure
  | 'storage'   // on-disk
  | 'network'
  | 'client'
  | 'concept'   // an idea, not a thing (MVCC, xmin horizon…)

export interface FocusSpec {
  /** world-space point the camera should look at */
  target: [number, number, number]
  /** preferred distance from target */
  distance: number
  /** preferred direction FROM target TO camera (does not need to be normalised) */
  dir?: [number, number, number]
}

export interface ComponentDef {
  id: string
  name: string
  /** one-line subtitle, e.g. "background process" */
  role: string
  kind: ComponentKind
  district: DistrictId
  /** Pickable root. Raycasting uses its descendants. */
  object: THREE.Object3D
  focus: FocusSpec
  /** world position for the floating label; defaults to focus.target */
  labelAt?: [number, number, number]
  /**
   * 0 = district-scale, always visible
   * 1 = major landmark, visible from medium range
   * 2 = detail, only visible up close
   */
  tier: 0 | 1 | 2
  /** live one-line metric for the label + panel header, evaluated each frame */
  readout?: (s: SimState) => string
  /** override outline colour */
  color?: number
}

export interface QualitySettings {
  level: QualityLevel
  pixelRatio: number
  bloom: boolean
  shadows: boolean
  /** max simultaneous flow particles */
  maxParticles: number
  /** max CSS2D labels visible at once */
  maxLabels: number
  antialias: boolean
}

export type QualityLevel = 'low' | 'reduced' | 'medium' | 'high' | 'ultra'

export interface WorldContext {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  bus: Bus
  sim: SimState
  quality: QualitySettings
  /** register a pickable/labelled component */
  register(def: ComponentDef): void
  /** shorthand for bus.emit('flow', …) */
  flow(req: FlowRequest): void
  /** shared material/geometry cache — see core/theme.ts */
  theme: ThemeApi
}

export interface WorldModule {
  id: string
  group: THREE.Object3D
  /**
   * @param dt   frame delta in real seconds
   * @param sim  live simulation state
   * @param t    simulated time in seconds
   */
  update(dt: number, sim: SimState, t: number): void
  /** distance-based detail switch, called when the bucket changes */
  setDetail?(level: 0 | 1 | 2): void
  dispose?(): void
}

export type WorldFactory = (ctx: WorldContext) => WorldModule

/* ---------------------------------------------------------------------------
 * Theme API (implemented in core/theme.ts).
 * -------------------------------------------------------------------------*/

export interface ThemeApi {
  color: Record<ColorKey, number>
  /** cached MeshStandardMaterial */
  mat(key: string, opts?: MatOpts): THREE.MeshStandardMaterial
  /** cached emissive/neon material (unlit, bloom-friendly) */
  neon(color: number, intensity?: number, opts?: NeonOpts): THREE.MeshBasicMaterial
  /** cached line material for blueprint edges */
  line(color: number, opacity?: number): THREE.LineBasicMaterial
  /** wireframe edge overlay for a mesh geometry */
  edges(geo: THREE.BufferGeometry, color: number, opacity?: number): THREE.LineSegments
  /** canvas-backed text texture (for decals on floors/walls) */
  textTexture(text: string, opts?: TextTexOpts): THREE.Texture
  /** shared box/cyl geometry cache */
  box(w: number, h: number, d: number): THREE.BufferGeometry
  cyl(rt: number, rb: number, h: number, seg?: number): THREE.CylinderGeometry
  dispose(): void
}

export interface MatOpts {
  color?: number
  roughness?: number
  metalness?: number
  emissive?: number
  emissiveIntensity?: number
  transparent?: boolean
  opacity?: number
  flatShading?: boolean
  side?: THREE.Side
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
  /**
   * Whether the shared masonry term is compiled into this material. Default
   * true — structure is masonry. Turn it off for glazing, for rubber, for
   * polished metal: coursed joints on a window claim the wrong material.
   */
  surface?: boolean
}

export interface NeonOpts {
  transparent?: boolean
  opacity?: number
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
}

export interface TextTexOpts {
  size?: number
  color?: string
  bg?: string
  font?: string
  padding?: number
  align?: CanvasTextAlign
  letterSpacing?: string
}

export type ColorKey =
  | 'bg'
  | 'fog'
  | 'grid'
  | 'gridBright'
  | 'ground'
  | 'client'
  | 'backend'
  | 'shmem'
  | 'bufClean'
  | 'bufDirty'
  | 'bufPinned'
  | 'bufFree'
  | 'wal'
  | 'walDim'
  | 'storage'
  | 'vacuum'
  | 'checkpoint'
  | 'bgwriter'
  | 'replication'
  | 'lock'
  | 'ok'
  | 'warn'
  | 'crit'
  | 'ink'
  | 'inkDim'
  | 'postmaster'
  | 'archive'
  | 'toast'
  | 'index'

/* ---------------------------------------------------------------------------
 * Camera.
 * -------------------------------------------------------------------------*/

export type CameraMode = 'orbit' | 'fly' | 'focus' | 'tour' | 'walk'

export interface CameraApi {
  camera: THREE.PerspectiveCamera
  mode: CameraMode
  setMode(m: CameraMode): void
  /** smoothly frame a focus spec; returns when the move starts */
  focusOn(spec: FocusSpec, opts?: { instant?: boolean; duration?: number }): void
  /** fly along a path for the guided tour */
  flyPath(points: [number, number, number][], lookAt: [number, number, number][], duration: number): Promise<void>
  /** cancel any scripted movement, hand control back to the user */
  release(): void
  update(dt: number): void
  /** distance from the city centre, used for LOD */
  readonly altitude: number
  /** true while a scripted move is running */
  readonly scripted: boolean
  resize(w: number, h: number): void
  dispose(): void
}

/* ---------------------------------------------------------------------------
 * Routes — the road network. Defined in world/layout.ts, drawn by engine/flows.ts.
 * -------------------------------------------------------------------------*/

export interface RouteDef {
  id: string
  /** control points, world space */
  points: [number, number, number][]
  /** default particle colour */
  color: number
  /** default world units/sec */
  speed: number
  /** default particle size */
  size?: number
  /** draw a faint static "road" line for this route */
  visible?: boolean
  /** road line opacity */
  roadOpacity?: number
  /** curve tension for CatmullRom */
  tension?: number
  /** treat control points as a polyline instead of a smooth curve */
  linear?: boolean
}

/* ---------------------------------------------------------------------------
 * Inspector content (src/ui/content.ts).
 * -------------------------------------------------------------------------*/

export interface ContentSection {
  heading: string
  /** supports a tiny subset of markdown: **bold**, `code`, [link](url) */
  body: string
}

/**
 * One external pointer for the inspector's "Go deeper" block.
 *
 * `url` is OPTIONAL on purpose: some references are books with no canonical
 * public page, and a guessed link is a fabricated citation. If there is no URL,
 * there is no link — panel.ts renders those as plain text.
 */
export interface DocRef {
  /** human label, e.g. "24.1. Routine Vacuuming" */
  label: string
  /** absolute https URL. Omit when no stable public page exists. */
  url?: string
  /** for source refs: the function(s) worth looking for in that file */
  symbol?: string
  /**
   * false when the link works but the section/chapter number has not been
   * re-checked against the current release. Rendered with a "†" marker, never
   * hidden — an unverified citation the reader can see is honest; a silently
   * confident wrong one is not.
   */
  verified?: boolean
}

/**
 * Egor Rogov, "PostgreSQL 14 Internals" (Postgres Professional).
 *
 * A paper/PDF book. There is DELIBERATELY no `url` field on this type and
 * panel.ts MUST NOT render one — see the comment in renderRefs().
 */
export interface BookRef {
  /** e.g. "PostgreSQL 14 Internals — Egor Rogov, Postgres Professional" */
  edition: string
  /** e.g. "Part II. Buffer Cache and WAL" */
  part: string
  /** e.g. "ch. 9 Buffer Cache (Cache Hits; Cache Misses)" */
  chapter: string
  /** honest hedge, shown verbatim on hover, e.g. "chapter number not re-checked" */
  confidence?: string
}

/** The reading list behind one component. Every field is optional. */
export interface DocReferences {
  /** postgresql.org/docs/18 — the reviewed manual */
  docs?: DocRef[]
  /** github.com/postgres/postgres — the source */
  source?: DocRef[]
  /** Hironobu Suzuki, "The Internals of PostgreSQL" — interdb.jp, free online */
  suzuki?: DocRef & { chapter: string }
  /** Egor Rogov, "PostgreSQL 14 Internals" — citation only, never a link */
  rogov?: BookRef
}

export interface ComponentDoc {
  id: string
  title: string
  subtitle: string
  /** one-sentence "what it is" for the hover tooltip */
  tldr: string
  /** the meaty explanation */
  sections: ContentSection[]
  /** live metrics to show, resolved against SimState */
  metrics?: { label: string; get: (s: SimState) => string; hint?: string }[]
  /** related GUCs the user can twiddle right there */
  knobs?: (keyof Knobs)[]
  /** explicit operations; unlike knobs these start work rather than set policy. */
  actions?: (
    | 'start-full-backup'
    | 'start-pitr'
    | 'start-restore-drill'
    | 'start-switchover'
    | 'trigger-failover'
    | 'start-pg-rewind'
  )[]
  /** ids of related components, rendered as jump links */
  see?: string[]
  /** source pointers for the curious, e.g. src/backend/postmaster/checkpointer.c */
  source?: string[]
  /**
   * Richer, linkable reading list. Optional and additive: `source` above stays
   * the plain-path list every doc already populates, and `refs.source` carries
   * the same files with URLs and symbols. Once all 52 docs have `refs`, a later
   * pass can drop `source` — but not in the same change, because 52 entries and
   * the panel renderer both depend on it today.
   */
  refs?: DocReferences
}

export interface TourChapter {
  id: string
  title: string
  /** narration shown while the camera flies */
  body: string
  /** component to frame (preferred) */
  focus?: string
  /** or an explicit camera move */
  camera?: FocusSpec
  /** wall-clock seconds this chapter lasts */
  duration: number
  /** knob changes applied on entry */
  knobs?: Partial<Knobs>
  /** scenario to trigger on entry */
  scenario?: string | null
}

export interface ScenarioDef {
  id: string
  name: string
  blurb: string
  icon: string
  /** knob overrides applied while running */
  knobs: Partial<Knobs>
  /** what to look at when it starts */
  focus?: string
  /** scenario seconds at 1×; 0 = runs until cancelled */
  duration: number
  /** Optional fixed statement stream; this selects a template, never a plan. */
  query?: { kind: QueryKind; table: string }
  /** narration beats: [atSecond, title, body] */
  beats?: [number, string, string][]
  /** A non-modal operator decision shown only after its instrument threshold. */
  decision?: {
    revealAt: number
    choices: {
      id: ScenarioChoiceId
      label: string
      hint: string
    }[]
  }
}
