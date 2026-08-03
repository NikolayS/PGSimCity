/* ============================================================================
 * DIAGNOSTIC PATHS
 *
 * A catalogue of statistics views answers "what exists". Nobody arrives with
 * that question. They arrive with "the database is slow", and the fifty views
 * exist because each one answers some *other* question that eventually gets you
 * there. This file is that second thing: a decision tree that starts from a
 * complaint in the user's own words and ends at a column.
 *
 * Every branch carries a predicate over live model state, so the tool does not
 * merely list the possibilities — it evaluates them against the database that
 * is running behind the page and marks the one that is true this second.
 *
 * Copy rules, inherited from src/sim/scenarios.ts: say what is happening, say
 * why, say what an operator would do. No hedging. The reader is a strong
 * engineer who has simply never had to run a database at 3 a.m.
 * ==========================================================================*/

import { poolBytes, SHARED_BUFFERS_FULL_SAMPLE_MIB, SHARED_BUFFERS_MIN_MIB } from '../core/types'
import type { Knobs, SimState } from '../core/types'
import { configuredSynchronousStandby, worstConnectedStandbyLag } from '../core/replication'
import { CLAIM_VALUES } from '../core/claims'
import { fmtBytes } from '../core/util'
import type { Collector } from './collector'
import type { Subsystem } from './catalog'
import {
  activityWaitCounts,
  checkpointRequestedShare,
  clientBackendWriteShare,
  coldBufferShare,
  collectorCacheHitPercent,
  replicationRows,
  tableDeadRatio,
} from './views'
import type { ProjectionSource } from './views'

const MIB = 1024 * 1024
const DIAGNOSTIC_GATES = CLAIM_VALUES.diagnoseBranchGates
export type DiagnosticGateId = keyof typeof DIAGNOSTIC_GATES

/* ---------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------*/

export interface Branch {
  /** the condition, in plain language */
  label: string
  /** exact live-row family read by both this predicate and its adjacent view */
  source: ProjectionSource
  /** true right now? */
  test: (s: SimState, c: Collector) => boolean
  /** registered non-zero model-range gates, when this predicate has any */
  gates?: DiagnosticGateId[]
  /** step id or verdict id */
  next: string
}

export interface Step {
  id: string
  kind: 'step'
  /** the question this step asks */
  title: string
  /** why you run this now, rather than something else */
  why: string
  sql: string
  /** key into views.ts PROJECTIONS */
  projection: string
  /** catalog id of the instrument being read */
  instrument: string
  /** what to look for in the rows above */
  look: string
  branches: Branch[]
  /** version or accuracy footnote */
  note?: string
  /** city component this step interrogates */
  city?: string
  /**
   * Optional: advance the model until this is true before drawing the step.
   *
   * Some views are empty most of the time on a real server too —
   * pg_stat_progress_vacuum only has rows while a vacuum is actually running.
   * That is a fact worth teaching, but a step whose entire point is "watch this
   * worker achieve nothing" should not open on an empty table. The runner
   * advances the clock a bounded amount to catch one.
   */
  settle?: (s: SimState) => boolean
}

export interface KnobSpec {
  key: keyof Knobs
  /** the real GUC name */
  guc: string
  kind: 'range' | 'toggle' | 'choice'
  min?: number
  max?: number
  step?: number
  unit?: string
  choices?: string[]
  /** shown under the control */
  help: string
  /** display transform for ranges, e.g. buffers → MiB */
  fmt?: (v: number) => string
}

/**
 * Whether the diagnosis is still true of the model this second.
 *
 * `ok` is deliberately three-valued. Half of these views are counters since a
 * reset, so immediately after the reader turns a dial and runs pg_stat_reset()
 * there is genuinely nothing to divide — and answering "fixed" from an empty
 * counter would be the page committing the exact error it spends a paragraph
 * warning about. `null` means "no evidence yet", and it says so.
 */
export interface Resolution {
  ok: boolean | null
  /** the reading that decides it, in the view's own vocabulary */
  reading: string
}

export interface Verdict {
  id: string
  kind: 'verdict'
  title: string
  /** the diagnosis */
  because: string
  /** why the mechanism produces this symptom */
  mechanism: string
  /** live numbers that back the call */
  evidence: (s: SimState, c: Collector) => { label: string; value: string; tone?: 'ok' | 'warn' | 'crit' }[]
  /** what an operator does about it */
  fix: string
  knobs: KnobSpec[]
  /** what to re-read to confirm the fix worked */
  confirm?: { projection: string; instrument: string; sql: string }
  /**
   * Re-run the finding against live state, so the reader who turns the dial gets
   * an answer instead of a table they have to re-interpret unaided. This is the
   * whole point of building the page on a running model rather than a diagram:
   * a diagram cannot tell you whether you fixed it.
   */
  resolved?: (s: SimState, c: Collector) => Resolution
  city?: string
  reading: { label: string; url: string }[]
  /** load-bearing scope qualification retained at narrow widths */
  disclosure?: string
}

export interface Symptom {
  id: string
  /** the complaint, in the words someone actually uses */
  complaint: string
  /** the shape of it */
  sub: string
  /** scenario id to stage in the model, or null */
  scenario: string | null
  /** diagnostic-only knob refinement applied after the shared scenario */
  stageKnobs?: Partial<Knobs>
  /** model seconds needed for this staged lesson's long-window readings */
  warmSeconds?: number
  entry: string
  accent: Subsystem
}

export type Node = Step | Verdict

function gated(
  gates: DiagnosticGateId | DiagnosticGateId[],
  test: Branch['test'],
): Pick<Branch, 'gates' | 'source' | 'test'> {
  const registered = Array.isArray(gates) ? gates : [gates]
  const source = DIAGNOSTIC_GATES[registered[0]].source
  for (const gate of registered) {
    if (DIAGNOSTIC_GATES[gate].source !== source) {
      throw new Error(`diagnostic gate ${gate} reads ${DIAGNOSTIC_GATES[gate].source}, not ${source}`)
    }
  }
  return { gates: registered, source, test }
}

/* ---------------------------------------------------------------------------
 * Live helpers used by branch predicates
 * -------------------------------------------------------------------------*/

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

/** The model's scaled relations make xmin trouble visible around 2–3% dead. */
export const DIAGNOSTIC_BLOAT_RATIO = DIAGNOSTIC_GATES.deadTupleRatio.threshold

function worstReplayStandby(s: SimState) {
  return replicationRows(s).sort(
    (a, b) => b.flushedLsn - b.appliedLsn - (a.flushedLsn - a.appliedLsn),
  )[0]
}

function worstSenderStandby(s: SimState) {
  return replicationRows(s).sort(
    (a, b) => s.wal.writeLsn - b.sentLsn - (s.wal.writeLsn - a.sentLsn),
  )[0]
}

/** How long the counters must have been running before an absence means anything. */
const QUIET_SECONDS = 25

/**
 * Has the checkpoint storm actually stopped?
 *
 * Graded on whether num_requested is still *moving*, not on the requested share —
 * and the difference is the whole reason this function exists rather than a
 * one-line ratio test. Immediately after a fix the counters are nearly empty, so
 * a single checkpoint that was already in flight when the setting changed makes
 * the share read 100% and the page would report failure for a fix that worked.
 * That is the small-denominator trap, and it is the same mistake as alerting on
 * a cumulative counter — which this page spends a paragraph warning against, so
 * it had better not make it.
 *
 * "num_requested stops moving" is also what the model-specific fix text tells the
 * reader to watch, so the tool and the advice agree.
 */
function ckptResolved(c: Collector): Resolution {
  const requested = Math.round(c.total.ckptRequested)
  const secs = Math.round(c.total.elapsed)
  if (requested > 0)
    return {
      ok: false,
      reading: `num_requested has moved ${requested} time${requested === 1 ? '' : 's'} in the ${secs} s since reset — this model records WAL pressure as the cause, but the PostgreSQL counter alone would not`,
    }
  if (secs < QUIET_SECONDS)
    return {
      ok: null,
      reading: `num_requested has not moved, but there is only ${secs} s of counter history — too little to call it either way`,
    }
  const timed = Math.round(c.total.ckptTimed)
  const done = Math.round(c.total.ckptDone)
  return {
    ok: true,
    reading:
      timed > 0
        ? `num_requested has not moved in ${secs} s; the timer expired ${timed} time${timed === 1 ? '' : 's'} and num_done records ${done} completion${done === 1 ? '' : 's'} — timer expiries can be skipped`
        : `num_requested has not moved in ${secs} s; num_done records ${done} completion${done === 1 ? '' : 's'}, including any run already in flight when the counters were reset`,
  }
}

/**
 * The same ratio over the last couple of seconds rather than since the reset.
 *
 * This exists because of the lesson itself: a cumulative counter cannot show
 * you a fix. Raise bgwriter_lru_maxpages and the *total* share barely moves,
 * because it is dominated by everything that happened before you touched it.
 * The rate moves immediately. That gap is the single most common misreading of
 * pg_stat_*, so the verdict shows both numbers side by side.
 */
export function recentBackendWriteShare(c: Collector): number {
  const t = c.rate.backendWrites + c.rate.ckptBuffers + c.rate.bgwClean
  return t > 0.01 ? c.rate.backendWrites / t : 0
}

/* ---------------------------------------------------------------------------
 * Knob specs — the dials a verdict lets you turn, under their real GUC names
 * -------------------------------------------------------------------------*/

const KB = {
  sharedBuffers: {
    key: 'sharedBuffers',
    guc: 'shared_buffers',
    kind: 'range',
    min: SHARED_BUFFERS_MIN_MIB,
    max: SHARED_BUFFERS_FULL_SAMPLE_MIB,
    step: SHARED_BUFFERS_MIN_MIB,
    help: 'How much of the working set the server can hold. The curve is flat, then a cliff, then flat again.',
    fmt: (v: number) => fmtBytes(v * MIB),
  },
  maxWalSize: {
    key: 'maxWalSize',
    guc: 'max_wal_size',
    kind: 'range',
    min: 32,
    max: 1024,
    step: 16,
    unit: 'MB',
    help: 'The WAL budget used by PostgreSQL’s moving checkpoint threshold. Change it only after WAL pressure is established as the request cause.',
  },
  checkpointTimeout: {
    key: 'checkpointTimeout',
    guc: 'checkpoint_timeout',
    kind: 'range',
    min: 30,
    max: 600,
    step: 10,
    unit: 's',
    help: 'Doubling this roughly halves full-page-write volume, and costs you a longer crash recovery.',
  },
  bgwriterEnabled: {
    key: 'bgwriterEnabled',
    guc: 'bgwriter_lru_maxpages > 0',
    kind: 'toggle',
    help: 'Off means bgwriter_lru_maxpages = 0. The writes do not disappear; backends do them instead.',
  },
  bgwriterLruMaxpages: {
    key: 'bgwriterLruMaxpages',
    guc: 'bgwriter_lru_maxpages',
    kind: 'range',
    min: 0,
    max: 600,
    step: 20,
    help: 'Pages the background writer may clean per round. Raising it is nearly free.',
  },
  autovacuum: {
    key: 'autovacuum',
    guc: 'autovacuum',
    kind: 'toggle',
    help: 'There is exactly one correct value in production and it is on.',
  },
  autovacuumScaleFactor: {
    key: 'autovacuumScaleFactor',
    guc: 'autovacuum_vacuum_scale_factor',
    kind: 'range',
    min: 0.01,
    max: 0.3,
    step: 0.01,
    help: 'Dead rows needed to trigger a vacuum, as a fraction of the table. The 0.2 default is far too lazy for a large hot table.',
    fmt: (v: number) => v.toFixed(2),
  },
  longRunningXact: {
    key: 'longRunningXact',
    guc: 'an abandoned BEGIN',
    kind: 'toggle',
    help: 'Not a setting — a session someone left open. idle_in_transaction_session_timeout is the setting that kills it.',
  },
  lockContention: {
    key: 'lockContention',
    guc: 'an uncommitted LOCK TABLE',
    kind: 'toggle',
    help: 'Not a setting either. lock_timeout is what stops the queue forming behind it.',
  },
  synchronousCommit: {
    key: 'synchronousCommit',
    guc: 'synchronous_commit',
    kind: 'choice',
    choices: ['off', 'local', 'remote_write', 'on', 'remote_apply'],
    help: 'A per-session setting. Money commits with remote_apply; telemetry commits with off.',
  },
  synchronousStandbyNames: {
    key: 'synchronousStandbyNames',
    guc: 'synchronous_standby_names',
    kind: 'choice',
    choices: ['none', 'standbyA', 'standbyB'],
    help: 'Selects the named synchronous follower. none releases SyncRep waiters and gives up remote durability.',
  },
  standbyASlowApply: {
    key: 'standbyASlowApply',
    guc: 'a standby that cannot keep up',
    kind: 'toggle',
    help: 'Replay is single-threaded. This models a standby whose one redo process cannot keep up.',
  },
  standbyBSlowApply: {
    key: 'standbyBSlowApply',
    guc: 'standby_b replay cannot keep up',
    kind: 'toggle',
    help: 'Replay is independent per standby. This controls the lagging standby_b row.',
  },
  standbyANetworkLag: {
    key: 'standbyANetworkLag',
    guc: 'network one-way delay',
    kind: 'range',
    min: 0,
    max: 200,
    step: 5,
    unit: 'ms',
    help: 'Delays every position equally. It is not what people usually mean by replication lag.',
  },
  standbyBNetworkLag: {
    key: 'standbyBNetworkLag',
    guc: 'standby_b network one-way delay',
    kind: 'range',
    min: 0,
    max: 200,
    step: 5,
    unit: 'ms',
    help: 'Controls standby_b independently; compare its row with standby_a before blaming a shared link.',
  },
  tps: {
    key: 'tps',
    guc: 'offered client load',
    kind: 'range',
    min: 10,
    max: 4000,
    step: 10,
    unit: 'tps',
    help: 'What the application is asking for. A pooler is how you keep this above max_connections without forking a process per client.',
  },
  clientConnections: {
    key: 'clientConnections',
    guc: 'application client connections',
    kind: 'range',
    min: 1,
    max: 2000,
    step: 1,
    unit: 'clients',
    help: 'Application-side connections beside the aggregate tps control; refused sockets are reported separately and do not silently rescale that workload.',
  },
  poolMode: {
    key: 'poolMode',
    guc: 'PgBouncer pool_mode',
    kind: 'choice',
    choices: ['disabled', 'session', 'transaction'],
    help: 'Transaction mode reuses a server after each transaction and gives up arbitrary session state. disabled is the city comparison, not a PgBouncer value.',
  },
  defaultPoolSize: {
    key: 'defaultPoolSize',
    guc: 'PgBouncer default_pool_size',
    kind: 'range',
    min: 1,
    max: 100,
    step: 1,
    unit: 'server connections',
    help: 'PgBouncer server target for this one modeled user/database pool. PostgreSQL rejects attempts beyond the city\'s sixteen-slot capacity.',
  },
  maxClientConn: {
    key: 'maxClientConn',
    guc: 'PgBouncer max_client_conn',
    kind: 'range',
    min: 1,
    max: 2000,
    step: 1,
    unit: 'clients',
    help: 'PgBouncer client admission, not PostgreSQL server capacity. PgBouncer defaults to 100.',
  },
  queryWaitTimeout: {
    key: 'queryWaitTimeout',
    guc: 'PgBouncer query_wait_timeout',
    kind: 'range',
    min: 0,
    max: 600,
    step: 5,
    unit: 's',
    help: 'Disconnect a client whose query waits this long for a server; PgBouncer defaults to 120 seconds and zero waits indefinitely.',
  },
  fullPageWrites: {
    key: 'fullPageWrites',
    guc: 'full_page_writes',
    kind: 'toggle',
    help: 'Safe to turn off only on storage that guarantees atomic 8 kB writes. On a cloud volume, you do not have that guarantee.',
  },
} as const satisfies Record<string, KnobSpec>

const DOC = (slug: string, label: string) => ({
  label,
  url: `${CLAIM_VALUES.postgresqlVersion.manualBase}${slug}`,
})

/* ---------------------------------------------------------------------------
 * The symptoms
 * -------------------------------------------------------------------------*/

export const SYMPTOMS: Symptom[] = [
  {
    id: 'slow',
    complaint: 'Everything is slow right now.',
    sub: 'No single query — the whole server feels heavy.',
    scenario: 'connection-storm',
    entry: 'slow.1',
    accent: 'backends',
  },
  {
    id: 'stall',
    complaint: 'Writes stall every few minutes.',
    sub: `A PostgreSQL latency complaint; correlate checkpoint and I/O counters with rolling p50/p99 in ${CLAIM_VALUES.modelLatency.unit}.`,
    scenario: 'checkpoint-storm',
    entry: 'stall.1',
    accent: 'checkpoint',
  },
  {
    id: 'bloat',
    complaint: 'A table keeps growing and VACUUM is not helping.',
    sub: 'Autovacuum is running. The table grows anyway.',
    scenario: 'xmin-horizon',
    entry: 'bloat.1',
    accent: 'vacuum',
  },
  {
    id: 'reads',
    complaint: 'Reads got slow and the disk is busy.',
    sub: 'Same queries, same data, far more I/O than last month.',
    scenario: 'cache-thrash',
    entry: 'io.1',
    accent: 'buffers',
  },
  {
    id: 'blocked',
    complaint: 'Queries on one table wait forever.',
    sub: 'Everything else is fine. That one table is frozen.',
    scenario: 'lock-pileup',
    entry: 'lock.1',
    accent: 'locks',
  },
  {
    id: 'replica',
    complaint: 'The read replica is serving stale data.',
    sub: 'Users see writes they made a minute ago disappear.',
    scenario: 'replication-lag',
    entry: 'replica.1',
    accent: 'replication',
  },
  {
    id: 'commit',
    complaint: 'Commits got slow. Nothing else did.',
    sub: 'The queries are fast. COMMIT is what takes the time.',
    scenario: 'wal-flood',
    entry: 'commit.1',
    accent: 'wal',
  },
  {
    id: 'normal',
    complaint: 'Nothing is wrong. Show me what normal looks like.',
    sub: 'Learn the healthy readings so an unhealthy one registers.',
    scenario: 'steady-state',
    stageKnobs: { seqScanRatio: 0, sharedBuffers: SHARED_BUFFERS_FULL_SAMPLE_MIB },
    warmSeconds: 300,
    entry: 'normal.1',
    accent: 'storage',
  },
]

/* ---------------------------------------------------------------------------
 * The tree
 * -------------------------------------------------------------------------*/

const STEPS: Step[] = [
  /* ==================== everything is slow ============================== */
  {
    id: 'slow.1',
    kind: 'step',
    title: 'Are they waiting, or are they working?',
    why: 'Before you tune anything, find out whether the server is busy or blocked. Those have opposite fixes, and every minute spent on the wrong one is a minute the incident runs.',
    instrument: 'pg_stat_activity',
    projection: 'activity_agg',
    city: 'backend.row',
    sql: `SELECT state, wait_event_type, wait_event, count(*)
  FROM pg_stat_activity
 WHERE backend_type = 'client backend'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;`,
    look:
      'A backend that is `active` with `wait_event_type` null is not currently reporting an instrumented wait. That often suggests CPU or runnable work, but it is not a CPU-running bit: the process may be pre-empted or doing work with no exposed wait event. State and wait columns are independent, and idle states are not queues. Use the largest instrumented wait bucket to focus investigation, not to claim complete time attribution.',
    note:
      'wait_event_type and wait_event arrived in 9.6. On 9.5 and older, pg_stat_activity had a single boolean `waiting` column that told you a backend was stuck on a heavyweight lock and nothing else — which is why so much old advice assumes every wait is a lock.',
    branches: [
      {
        label: 'Every connection slot is busy; new work is queueing outside PostgreSQL.',
        next: 'v.saturation',
        ...gated('connectionSpareSlots', (s, c) =>
          activityWaitCounts(s, c).total >= s.maxConnections - DIAGNOSTIC_GATES.connectionSpareSlots.threshold),
      },
      { label: 'Most of them are waiting on `Lock`.', next: 'lock.1', ...gated('lockWaitShare', (s, c) => share(activityWaitCounts(s, c).lock, activityWaitCounts(s, c).total) > DIAGNOSTIC_GATES.lockWaitShare.threshold) },
      { label: 'Most of them are waiting on `IO`.', next: 'io.1', ...gated('ioWaitShare', (s, c) => share(activityWaitCounts(s, c).io, activityWaitCounts(s, c).total) > DIAGNOSTIC_GATES.ioWaitShare.threshold) },
      { label: 'They are waiting to commit — `IO / WalSync` or `IPC / SyncRep`.', next: 'commit.1', ...gated('commitWaitShare', (s, c) => share(activityWaitCounts(s, c).commit, activityWaitCounts(s, c).total) > DIAGNOSTIC_GATES.commitWaitShare.threshold) },
      { label: 'Sessions are sitting in `idle in transaction`.', source: 'activity.rows', next: 'bloat.2', test: (s, c) => activityWaitCounts(s, c).idleTx > 0 },
      { label: 'Hardly anything is running at all.', next: 'v.idle', ...gated('activeWorkFloor', (s, c) => activityWaitCounts(s, c).total - activityWaitCounts(s, c).idle < DIAGNOSTIC_GATES.activeWorkFloor.threshold) },
    ],
  },

  /* ==================== writes stall =================================== */
  {
    id: 'stall.1',
    kind: 'step',
    title: 'Is the checkpointer timer expiring, or are requests arriving?',
    why: 'Periodic stalls may correlate with checkpoints. These counters separate timer expiries from requests, while num_done counts actual completions; a second source is needed to identify why a request occurred.',
    instrument: 'pg_stat_checkpointer',
    projection: 'checkpointer',
    city: 'checkpointer',
    sql: `SELECT num_timed, num_requested, num_done, buffers_written,
       write_time, sync_time
  FROM pg_stat_checkpointer;`,
    look:
      '`num_timed` counts `checkpoint_timeout` expiries, including expiries where PostgreSQL skips the checkpoint because nothing changed. `num_done` counts completed checkpoints. `num_requested` counts requests from multiple causes, including WAL pressure, explicit CHECKPOINT, base-backup activity and shutdown. A high requested rate tells you to correlate checkpoint messages, WAL volume, maintenance and backups; it does not prove max_wal_size is too small.',
    note:
      'pg_stat_checkpointer is new in PostgreSQL 17; num_done arrived in 18. On 16 and older the timer and request counters live in pg_stat_bgwriter as `checkpoints_timed` and `checkpoints_req`. Those older versions do not expose the separate completion count.',
    branches: [
      { label: '`num_requested` is a serious share; investigate the request sources.', next: 'stall.2', ...gated('requestedCheckpointShare', (_s, c) => c.total.ckptDone > 0 && checkpointRequestedShare(c) > DIAGNOSTIC_GATES.requestedCheckpointShare.threshold) },
      { label: 'Requests are a small share of timer expiries plus requests.', next: 'v.ckpt_ok', ...gated('requestedCheckpointShare', (_s, c) => c.total.ckptDone > 0 && checkpointRequestedShare(c) <= DIAGNOSTIC_GATES.requestedCheckpointShare.threshold) },
    ],
  },
  {
    id: 'stall.2',
    kind: 'step',
    title: 'How do WAL bytes and FPI counts move around the requests?',
    why: 'This model records WAL pressure as its request source. On a real server, compare time-aligned rates and checkpoint messages without turning an FPI count into bytes.',
    instrument: 'pg_stat_wal',
    projection: 'wal',
    city: 'wal.vault',
    sql: `SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full
  FROM pg_stat_wal;`,
    look:
      '`wal_fpi` is a count and `wal_bytes` is a byte total; the count cannot be converted into an FPI byte share. Compare their rates before and after checkpoints. If byte attribution matters, inspect WAL records with a WAL-analysis tool instead of multiplying the count by a page size.',
    note:
      'A full-page image can omit the unused page hole, and wal_compression can compress it, so even BLCKSZ is not its recorded size. BLCKSZ is build-time configurable. PostgreSQL 18 reports WAL I/O in pg_stat_io with object = \'wal\'.',
    branches: [
      { label: 'In this model, wal_fpi and wal_bytes rise together after requested checkpoints.', source: 'wal.counters', next: 'v.ckpt_storm', test: (_s, c) => c.total.walBytes > 0 && c.total.walFpi > 0 },
      { label: 'WAL bytes rise without a modeled FPI burst.', source: 'wal.counters', next: 'v.wal_volume', test: (_s, c) => c.total.walBytes > 0 && c.total.walFpi <= 0 },
    ],
  },

  /* ==================== bloat ========================================== */
  {
    id: 'bloat.1',
    kind: 'step',
    title: 'Which table shows dead-tuple pressure or physical growth?',
    why: 'Start with two different signals: estimated dead-row pressure from pg_stat_all_tables, and measured heap/index/TOAST size trends. Neither substitutes for the other.',
    instrument: 'pg_stat_all_tables',
    projection: 'tables',
    city: 'storage.datadir',
    sql: `SELECT relname, n_live_tup, n_dead_tup,
       n_tup_upd, n_tup_hot_upd,
       last_autovacuum, autovacuum_count,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       pg_total_relation_size(relid) AS total_bytes
  FROM pg_stat_all_tables
 ORDER BY n_dead_tup DESC;`,
    look:
      '`n_live_tup` and `n_dead_tup` are estimated counts: use their change as vacuum-pressure evidence, not as a physical-bloat measurement or a monotonic truth counter. HOT versus non-HOT updates describes index-maintenance work, not whether cleanup keeps up. Sample heap, index and total bytes over time; a low dead estimate does not exclude old reusable space, index bloat or TOAST growth. When a costly page scan is justified, pgstattuple can confirm tuple and free-space occupancy.',
    branches: [
      {
        label: 'Estimated dead-tuple pressure exceeds this model’s alert threshold, and `last_autovacuum` has a value.',
        next: 'bloat.2',
        ...gated('deadTupleRatio', (s) => s.tables.some((t) => tableDeadRatio(t) >= DIAGNOSTIC_BLOAT_RATIO && t.lastVacuum > 0)),
      },
      {
        label: 'Dead tuples exceed the alert threshold, but `last_autovacuum` is null.',
        next: 'bloat.autovacuum',
        ...gated('deadTupleRatio', (s) => s.tables.some((t) => tableDeadRatio(t) >= DIAGNOSTIC_BLOAT_RATIO && t.lastVacuum === 0)),
      },
      { label: 'The current dead-tuple estimate is low; check physical size trends.', next: 'v.no_bloat', ...gated('deadTupleRatio', (s) => s.tables.every((t) => tableDeadRatio(t) < DIAGNOSTIC_BLOAT_RATIO)) },
    ],
  },
  {
    id: 'bloat.autovacuum',
    kind: 'step',
    title: 'Is routine autovacuum enabled?',
    why: '`last_autovacuum` being null says that no pass has completed since statistics were reset; it does not say why. Read the setting before blaming the launcher.',
    instrument: 'pg_settings',
    projection: 'settings',
    city: 'autovac.launcher',
    sql: `SELECT name, setting, unit, source
  FROM pg_settings
 WHERE name = 'autovacuum';`,
    look:
      '`last_autovacuum` and `autovacuum_count` are history. The `autovacuum` setting tells you whether routine workers may launch now. A null timestamp with the setting on can simply mean that no pass has completed yet — continue to the xmin horizon instead of diagnosing a disabled launcher.',
    branches: [
      { label: '`autovacuum` is on; find what is preventing cleanup.', source: 'settings.rows', next: 'bloat.2', test: (s) => s.knobs.autovacuum },
      { label: '`autovacuum` is off.', source: 'settings.rows', next: 'v.av_off', test: (s) => !s.knobs.autovacuum },
    ],
  },
  {
    id: 'bloat.2',
    kind: 'step',
    title: 'Is something holding the xmin horizon back?',
    why: 'Vacuum may only remove a row version that is invisible to **every** snapshot still open anywhere in the cluster. One session can therefore stop cleanup for the whole database while doing no work at all.',
    instrument: 'pg_stat_activity',
    projection: 'activity_xmin',
    city: 'proc.array',
    sql: `SELECT pid, state, backend_xid, backend_xmin,
       now() - xact_start AS xact_age, query
  FROM pg_stat_activity
 WHERE backend_xmin IS NOT NULL OR backend_xid IS NOT NULL
 ORDER BY GREATEST(age(backend_xmin), age(backend_xid)) DESC NULLS LAST;

SELECT gid, prepared, owner, database, transaction,
       age(transaction) AS xid_age
  FROM pg_prepared_xacts
 ORDER BY age(transaction) DESC;

SELECT slot_name, slot_type, active, xmin, catalog_xmin,
       age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
  FROM pg_replication_slots
 WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL;

SELECT pid, application_name, state, backend_xmin,
       age(backend_xmin) AS feedback_xmin_age
  FROM pg_stat_replication
 WHERE backend_xmin IS NOT NULL;`,
    look:
      'Compare every candidate: active backend_xmin values, old assigned backend_xid values, prepared transactions, replication-slot xmin/catalog_xmin values, and standby feedback reported by walsenders. The oldest relevant value can constrain cleanup; no single pg_stat_activity list is the global horizon.',
    note:
      'An idle transaction is not automatically a snapshot pin. Under READ COMMITTED each command gets a new snapshot, so inspect backend_xmin and transaction IDs rather than generalizing the modeled REPEATABLE READ case.',
    branches: [
      { label: 'There is a session in `idle in transaction` with an ancient xact_age.', source: 'activity.xmin_rows', next: 'bloat.3', test: (s) => s.knobs.longRunningXact },
      { label: 'Nothing here is old.', source: 'activity.xmin_rows', next: 'v.av_tuning', test: (s) => !s.knobs.longRunningXact },
    ],
  },
  {
    id: 'bloat.3',
    kind: 'step',
    settle: (s) => s.autovac.workers.some((w) => w.active && w.phase !== 'analyze'),
    title: 'Now watch what a vacuum pass actually achieves.',
    why: 'This is the part that fools monitoring. Autovacuum keeps running, keeps reading the whole heap, keeps burning the I/O — and reclaims nothing, because nothing it finds is removable yet.',
    instrument: 'pg_stat_progress_vacuum',
    projection: 'progress_vacuum',
    city: 'autovac.launcher',
    sql: `SELECT p.pid, c.relname, p.phase,
       p.heap_blks_total, p.heap_blks_scanned,
       p.heap_blks_vacuumed, p.index_vacuum_count
  FROM pg_stat_progress_vacuum p
  JOIN pg_class c ON c.oid = p.relid;`,
    look:
      'The worker walks the full phase sequence — scanning heap, vacuuming indexes, vacuuming heap — and heap_blks_scanned climbs all the way to heap_blks_total. The work is real. The result is not. Your dashboard reports "autovacuum: healthy" the entire time.',
    note:
      'PostgreSQL 17 replaced max_dead_tuples and num_dead_tuples in this view with max_dead_tuple_bytes, dead_tuple_bytes and num_dead_item_ids, and added indexes_total and indexes_processed. delay_time arrived in 18.',
    branches: [
      { label: 'The progress row still shows 0 removed.', source: 'vacuum.progress_rows', next: 'v.xmin', test: (s) => s.autovac.workers.some((w) => w.active && w.phase !== 'analyze' && w.deadCollected === 0) },
      { label: 'It is removing rows, just not fast enough.', source: 'vacuum.progress_rows', next: 'v.av_tuning', test: (s) => s.autovac.workers.some((w) => w.active && !w.stalledByHorizon && w.deadCollected > 0) },
    ],
  },

  /* ==================== reads / buffers ================================ */
  {
    id: 'io.1',
    kind: 'step',
    title: 'Which backend type and context account for the I/O?',
    why: 'pg_stat_io is cluster-wide and groups work by backend type, object and context. It narrows the mechanism; it does not name a PID, relation or query.',
    instrument: 'pg_stat_io',
    projection: 'io',
    city: 'shared.buffers',
    sql: `SELECT backend_type, object, context,
       reads, read_bytes, hits,
       writes, write_bytes, writebacks, evictions
  FROM pg_stat_io
 WHERE object = 'relation'
   AND context = 'normal';`,
    look:
      'Client-backend writes prove that client backends wrote relation buffers; they do not identify one causal chain or one remedy. Compare rates and bytes by backend type and context, then correlate workload, checkpointer/background-writer activity and individual backends before changing memory.',
    note:
      'PostgreSQL 18 adds pg_stat_get_backend_io(pid) for one backend; join it laterally to pg_stat_activity when PID/query attribution is needed. It still does not identify a relation. Before 18, pg_stat_io can only supply backend-type aggregates.',
    branches: [
      { label: 'The city’s separate representative sample has a high client-backend write share.', next: 'v.backend_writes', ...gated('clientBackendWriteShare', (_s, c) => clientBackendWriteShare(c) > DIAGNOSTIC_GATES.clientBackendWriteShare.threshold) },
      { label: 'Reads dominate and the hit ratio is poor.', next: 'io.2', ...gated('cacheHitPercent', (_s, c) => collectorCacheHitPercent(c) < DIAGNOSTIC_GATES.cacheHitPercent.threshold) },
      {
        label: 'Reads are mostly hits and writes are spread sensibly.',
        next: 'v.io_ok',
        ...gated(['cacheHitPercent', 'clientBackendWriteShare'], (_s, c) =>
          collectorCacheHitPercent(c) >= DIAGNOSTIC_GATES.cacheHitPercent.threshold
          && clientBackendWriteShare(c) <= DIAGNOSTIC_GATES.clientBackendWriteShare.threshold),
      },
    ],
  },
  {
    id: 'io.2',
    kind: 'step',
    title: 'Is the buffer sample showing churn or reuse?',
    why: 'A usage-count histogram characterizes current residency and churn. It cannot by itself distinguish a pool that is too small from a one-pass or bulk-read workload with little reusable data.',
    instrument: 'pg_buffercache',
    projection: 'buffercache',
    city: 'shared.buffers',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_buffercache;

SELECT * FROM pg_buffercache_usage_counts();`,
    look:
      'Postgres has no LRU list. The clock sweep decrements usage counts and reuses a frame at zero. Many zero-use buffers demonstrate churn, but cannot distinguish capacity pressure from a scan or bulk-read workload that would have low reuse at any pool size. Correlate query shapes, relation sizes and repeated access.',
    note:
      'pg_buffercache_usage_counts() and pg_buffercache_summary() arrived in 16 and are cheaper than scanning the full view. The pg_buffercache view and functions do not acquire buffer-manager locks, so their values can be slightly inconsistent under concurrent activity.',
    branches: [
      { label: 'Almost everything sits at usage_count 0.', next: 'v.small_pool', ...gated('coldBufferShare', (s) => coldBufferShare(s) > DIAGNOSTIC_GATES.coldBufferShare.threshold) },
      { label: 'The pool is holding a real working set.', next: 'v.io_ok', ...gated('coldBufferShare', (s) => coldBufferShare(s) <= DIAGNOSTIC_GATES.coldBufferShare.threshold) },
    ],
  },

  /* ==================== locks ========================================== */
  {
    id: 'lock.1',
    kind: 'step',
    title: 'Who is blocked, and who is blocking them?',
    why: 'A lock queue looks like a performance problem and is not one. There is no tuning to do — there is one session to find.',
    instrument: 'pg_blocking_pids',
    projection: 'locks',
    city: 'lock.manager',
    sql: `WITH waiters AS (
  SELECT a.pid AS waiter_pid, a.state AS waiter_state,
         a.query AS waiter_query, l.locktype,
         l.relation::regclass AS waited_relation,
         l.mode AS waited_mode, l.waitstart,
         unnest(pg_blocking_pids(a.pid)) AS blocker_pid
    FROM pg_locks l
    JOIN pg_stat_activity a USING (pid)
   WHERE NOT l.granted
)
SELECT w.*, b.state AS blocker_state,
       b.xact_start AS blocker_xact_start,
       b.query AS blocker_query
  FROM waiters w
  LEFT JOIN pg_stat_activity b ON b.pid = w.blocker_pid
 ORDER BY w.waitstart;`,
    look:
      'Each row shows a waiter and the lock it requested, then the blocker PID and activity independently. It does not claim which of the blocker’s locks conflicts with that request. A recurring blocker PID is a lead; inspect its transaction state and full lock set before acting.',
    note:
      'pg_blocking_pids() encodes wait-queue and conflict rules that are difficult to reproduce with a pg_locks self-join. A zero blocker PID can represent a prepared transaction, whose pg_locks.pid is null; inspect pg_prepared_xacts in that case.',
    branches: [
      { label: 'One pid is blocking everyone else.', source: 'locks.rows', next: 'v.lock_holder', test: (s) => s.locks.length > 0 },
      { label: 'Nothing is blocked.', source: 'locks.rows', next: 'v.no_locks', test: (s) => s.locks.length === 0 },
    ],
  },

  /* ==================== replication ==================================== */
  {
    id: 'replica.1',
    kind: 'step',
    title: 'Which of the four positions is actually behind?',
    why: '"Replication lag" is four different numbers, and they fail for four different reasons. Reading them as one number is why this gets misdiagnosed as a network problem.',
    instrument: 'pg_stat_replication',
    projection: 'replication',
    city: 'walsender',
    sql: `SELECT application_name, state,
       sent_lsn, write_lsn, flush_lsn, replay_lsn,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_bytes,
       write_lag, flush_lag, replay_lag
  FROM pg_stat_replication;`,
    look:
      'In PostgreSQL this is a pipeline: the walsender **sends**, the standby **writes**, **flushes**, then **replays**. The city represents only those ordered LSN frontiers and acknowledgement queues; it has no receiver files, fsync call or page replay. Walk left to right and stop at the first modeled position not tracking the primary.',
    note:
      'write_lag, flush_lag and replay_lag arrived in 10. An empty pg_stat_replication on a primary you believe has a standby is not "zero lag" — it means the walsender is gone.',
    branches: [
      {
        label: 'Received and flushed are fine; only replay is sliding.',
        next: 'v.replay',
        ...gated('replayStageGapBytes', (s) => replicationRows(s).some(
          (standby) => standby.flushedLsn - standby.appliedLsn > DIAGNOSTIC_GATES.replayStageGapBytes.threshold,
        )),
      },
      {
        label: 'Even sent_lsn is far behind the primary.',
        next: 'v.network',
        ...gated('senderStageGapBytes', (s) => replicationRows(s).some(
          (standby) => s.wal.writeLsn - standby.sentLsn > DIAGNOSTIC_GATES.senderStageGapBytes.threshold,
        )),
      },
      {
        label: 'Every connected standby has all four positions within a few kilobytes of the primary.',
        next: 'v.rep_ok',
        ...gated(['currentPositionGapBytes', 'replayStageGapBytes'], (s) => {
          const standbys = replicationRows(s)
          return standbys.length > 0 && standbys.every((standby) =>
            s.wal.writeLsn - standby.sentLsn <= DIAGNOSTIC_GATES.currentPositionGapBytes.threshold
            && s.wal.writeLsn - standby.writtenLsn <= DIAGNOSTIC_GATES.currentPositionGapBytes.threshold
            && s.wal.writeLsn - standby.flushedLsn <= DIAGNOSTIC_GATES.currentPositionGapBytes.threshold
            && s.wal.writeLsn - standby.appliedLsn <= DIAGNOSTIC_GATES.currentPositionGapBytes.threshold
            && standby.flushedLsn - standby.appliedLsn <= DIAGNOSTIC_GATES.replayStageGapBytes.threshold)
        }),
      },
    ],
  },

  /* ==================== commit ========================================= */
  {
    id: 'commit.1',
    kind: 'step',
    title: 'What exactly is a committing backend waiting for?',
    why: 'A commit does not wait for your data pages — those can sit dirty in shared_buffers for minutes. It waits for one WAL flush. Which flush, and whose disk, is the whole question.',
    instrument: 'pg_stat_activity',
    projection: 'activity_agg',
    city: 'walwriter',
    sql: `SELECT state, wait_event_type, wait_event, count(*)
  FROM pg_stat_activity
 WHERE backend_type = 'client backend'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;`,
    look:
      '`IO / WalSync` is the local fsync — the backend is waiting for your own disk to confirm the WAL record is durable. `IPC / SyncRep` is a different animal entirely: the backend is waiting for a **standby** to confirm. One is a storage problem; the other is a configuration decision someone made on purpose. Resist the urge to filter this query down to the two commit waits: the size of the commit bucket only means something next to the buckets it is competing with.',
    note:
      'The name of the local flush wait changed. PostgreSQL 17 started generating the wait event list from a table and normalised the capitalisation on the way through, so this event is `WALSync` on 16 and older and `WalSync` from 17 on. A monitoring query that greps for the old spelling on a new server matches nothing at all, and reports a healthy zero while doing it.',
    branches: [
      { label: 'They are waiting on `IPC / SyncRep`.', source: 'activity.rows', next: 'v.sync_remote', test: (s, c) => s.knobs.synchronousStandbyNames !== 'none' && (s.knobs.synchronousCommit === 'remote_write' || s.knobs.synchronousCommit === 'on' || s.knobs.synchronousCommit === 'remote_apply') && activityWaitCounts(s, c).commit > 0 },
      { label: 'They are waiting on `IO / WalSync`.', next: 'v.sync_local', ...gated('walSyncWaitFloor', (s, c) => activityWaitCounts(s, c).walSync >= DIAGNOSTIC_GATES.walSyncWaitFloor.threshold) },
      { label: 'Nobody is waiting on `WalSync` or `SyncRep`.', next: 'v.commit_ok', ...gated('walSyncWaitFloor', (s, c) => activityWaitCounts(s, c).commit === 0 && activityWaitCounts(s, c).walSync < DIAGNOSTIC_GATES.walSyncWaitFloor.threshold) },
    ],
  },

  /* ==================== the baseline =================================== */
  {
    id: 'normal.1',
    kind: 'step',
    title: 'Start with the shape of the workload.',
    why: 'You cannot recognise an abnormal reading without a normal one. Four views, four minutes, and the numbers on your own server stop being noise.',
    instrument: 'pg_stat_database',
    projection: 'database',
    city: 'stats.collector',
    sql: `SELECT numbackends, xact_commit, xact_rollback,
       blks_hit, blks_read,
       tup_returned, tup_inserted, tup_updated, tup_deleted
  FROM pg_stat_database
 WHERE datname = current_database();`,
    look:
      'These are totals since `stats_reset`, not rates. The raw number is almost never what you want — take two samples a minute apart and subtract. Switch the toggle above the table to per-second and watch every figure change meaning. A healthy OLTP hit ratio is 99%-ish; anything with a serious seq-scan component will read lower and that is not automatically wrong.',
    note:
      'Since PostgreSQL 15 these counters live in shared memory rather than being shipped to a collector process over UDP, which is why they no longer get lost under load and why a restart no longer resets them.',
    branches: [{ label: 'Next: who is connected, and what are they doing?', source: 'database.counters', next: 'normal.2', test: () => true }],
  },
  {
    id: 'normal.2',
    kind: 'step',
    title: 'Learn what a healthy pg_stat_activity looks like.',
    why: 'This is the view you will open first in every incident for the rest of your career. Know its resting state.',
    instrument: 'pg_stat_activity',
    projection: 'activity',
    city: 'backend.row',
    sql: `SELECT pid, backend_type, state,
       wait_event_type, wait_event,
       now() - xact_start AS xact_age, query
  FROM pg_stat_activity
 ORDER BY pid;`,
    look:
      'Note the background processes: the checkpointer parked on `Activity / CheckpointerMain`, the background writer on `BgwriterHibernate` when it has nothing to clean. Those are not stuck — an Activity wait is a process asleep on its own main loop, and it is the single most common false alarm in Postgres monitoring.',
    branches: [{ label: 'Next: is the write path keeping up?', source: 'activity.rows', next: 'normal.3', test: () => true }],
  },
  {
    id: 'normal.3',
    kind: 'step',
    title: 'Check the write path before it checks you.',
    why: 'The checkpointer and the background writer are the two processes nobody looks at until latency goes strange. Two numbers tell you whether they are coping.',
    instrument: 'pg_stat_checkpointer',
    projection: 'checkpointer',
    city: 'checkpointer',
    sql: `SELECT num_timed, num_requested, num_done, buffers_written, write_time
  FROM pg_stat_checkpointer;

SELECT buffers_clean, buffers_alloc FROM pg_stat_bgwriter;`,
    look:
      'A low num_requested rate means few checkpoints were requested during this window; it does not reveal why any request occurred. num_timed is timer expiries, while num_done is completed checkpoints. Correlate requests with WAL volume, checkpoint messages, backups and explicit maintenance. buffers_clean should be non-zero but modest — the background writer is meant to clean a short way ahead of the clock hand, not to empty the pool.',
    note:
      'PostgreSQL 17 split pg_stat_checkpointer out of pg_stat_bgwriter. If you are on 16 or older, read checkpoints_timed and checkpoints_req from pg_stat_bgwriter instead.',
    branches: [{ label: 'Next: is the standby keeping up?', source: 'checkpointer.counters', next: 'normal.4', test: () => true }],
  },
  {
    id: 'normal.4',
    kind: 'step',
    title: 'And finally: is the copy of your data current?',
    why: 'On PostgreSQL, replication lag can be silent while a replica keeps answering with older data. The city does not execute those reads; it can only compare its replay frontier with the primary LSN.',
    instrument: 'pg_stat_replication',
    projection: 'replication',
    city: 'walsender',
    sql: `SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_bytes,
       replay_lag
  FROM pg_stat_replication;`,
    look:
      'Alert on `pg_current_wal_lsn() - replay_lsn` in bytes for current backlog. Graph replay_lag too, but read it as PostgreSQL defines it: an estimate of recent commit-delay impact at replay, not current staleness, byte lag converted to time or a catch-up forecast. It may retain a recent value and then become NULL on an idle system.',
    branches: [{ label: 'That is the baseline. Now go break something.', source: 'replication.standbys', next: 'v.baseline', test: () => true }],
  },
]

/* ---------------------------------------------------------------------------
 * The verdicts
 * -------------------------------------------------------------------------*/

const VERDICTS: Verdict[] = [
  {
    id: 'v.ckpt_storm',
    kind: 'verdict',
    title: 'The model records WAL pressure and a post-checkpoint FPI burst.',
    because:
      'PGSimCity records max_wal_size pressure as the request cause here. PostgreSQL’s num_requested, wal_fpi and wal_bytes counters alone neither establish that cause nor attribute a byte share to FPIs.',
    mechanism:
      `After a checkpoint establishes a redo point, the first modification of a page can log a full-page image. The image may omit the page hole and wal_compression may compress it, so wal_fpi cannot be converted into bytes. Time-aligned count and byte rates can establish correlation; WAL-record analysis is required for byte attribution. The city exposes rolling p50/p99 in ${CLAIM_VALUES.modelLatency.unit}; ${CLAIM_VALUES.modelLatency.batchDisclosure}, and ${CLAIM_VALUES.modelLatency.resolutionDisclosure}. Those model-time quantiles are not a production query trace.`,
    evidence: (_s, c) => [
      { label: 'num_timed', value: String(Math.round(c.total.ckptTimed)) },
      { label: 'num_requested', value: String(Math.round(c.total.ckptRequested)), tone: 'crit' },
      { label: 'num_done', value: String(Math.round(c.total.ckptDone)) },
      { label: 'requested share', value: `${(checkpointRequestedShare(c) * 100).toFixed(0)}%`, tone: 'crit' },
      { label: 'wal_fpi rate', value: `${c.rate.walFpi.toFixed(1)}/s`, tone: 'warn' },
      { label: 'wal_bytes rate', value: `${fmtBytes(c.rate.walBytes)}/s`, tone: 'warn' },
    ],
    fix:
      'Because this model exposes WAL pressure as the cause, raise max_wal_size against its measured peak WAL rate and headroom, then verify the pressure stops. On a real server, first exclude explicit CHECKPOINT, backup and shutdown requests; changing max_wal_size cannot fix those. checkpoint_timeout also trades full-page-image frequency against crash-recovery work.',
    knobs: [KB.maxWalSize, KB.checkpointTimeout],
    confirm: {
      projection: 'checkpointer',
      instrument: 'pg_stat_checkpointer',
      sql: `SELECT num_timed, num_requested, num_done FROM pg_stat_checkpointer;`,
    },
    resolved: (_s, c) => ckptResolved(c),
    city: 'checkpointer',
    reading: [
      DOC('wal-configuration.html', 'WAL Configuration'),
      DOC('runtime-config-wal.html', 'Write Ahead Log settings'),
    ],
  },
  {
    id: 'v.wal_volume',
    kind: 'verdict',
    title: 'In this model, WAL generation outruns the configured checkpoint budget.',
    because:
      'The model’s recorded checkpoint reason is WAL volume, and full-page images are not the bulk of the bytes. A real num_requested counter would require independent cause evidence before supporting that conclusion.',
    mechanism:
      'max_wal_size is a budget, not a limit. Cross it and Postgres starts a checkpoint immediately so it can recycle segments below the new redo point. On a write-heavy server sized for a quieter one, that budget is crossed continuously and the timer never gets a say.',
    evidence: (s, c) => [
      { label: 'wal_bytes/sec', value: `${fmtBytes(c.rate.walBytes)}/s` },
      { label: 'max_wal_size', value: `${s.knobs.maxWalSize} MB` },
      { label: 'requested share', value: `${(checkpointRequestedShare(c) * 100).toFixed(0)}%`, tone: 'warn' },
    ],
    fix:
      'For this modeled cause, size max_wal_size from measured peak WAL rate, available disk and recovery objectives, then confirm the WAL-triggered requests stop. In production, confirm the request reason from checkpoint messages and surrounding activity rather than treating num_requested as a cause code.',
    knobs: [KB.maxWalSize],
    confirm: {
      projection: 'checkpointer',
      instrument: 'pg_stat_checkpointer',
      sql: `SELECT num_timed, num_requested, num_done FROM pg_stat_checkpointer;`,
    },
    resolved: (_s, c) => ckptResolved(c),
    city: 'wal.vault',
    reading: [DOC('wal-configuration.html', 'WAL Configuration')],
  },
  {
    id: 'v.ckpt_ok',
    kind: 'verdict',
    title: 'Few checkpoints were requested in this window.',
    because:
      'Few request events were observed relative to timer expiries. A timer expiry can be skipped, so num_done—not num_timed—says how many checkpoints completed. This is not proof that max_wal_size is ideal or that checkpoint I/O cannot contribute to a stall.',
    mechanism:
      'When a timer expiry starts a checkpoint, checkpoint_completion_target paces it across the configured interval; an idle expiry can be skipped. A checkpoint that this model starts under WAL pressure may have only the model’s estimated time to refill its WAL budget; other kinds of requested checkpoint do not imply that deadline.',
    evidence: (_s, c) => [
      { label: 'num_timed', value: String(Math.round(c.total.ckptTimed)), tone: 'ok' },
      { label: 'num_requested', value: String(Math.round(c.total.ckptRequested)), tone: 'ok' },
      { label: 'num_done', value: String(Math.round(c.total.ckptDone)), tone: 'ok' },
      { label: 'buffers_written', value: String(Math.round(c.total.ckptBuffers)) },
    ],
    fix:
      'On PostgreSQL, if writes still stall periodically, next inspect checkpoint sync_time and autovacuum activity against an external latency trace. The city has no checkpoint sync_time; its rolling modeled latency can correlate I/O and counter pressure but cannot replace that production trace.',
    knobs: [KB.checkpointTimeout],
    city: 'checkpointer',
    reading: [DOC('wal-configuration.html', 'WAL Configuration')],
  },
  {
    id: 'v.xmin',
    kind: 'verdict',
    title: 'One abandoned transaction is holding the xmin horizon, and vacuum cannot remove anything.',
    because:
      'In this modeled REPEATABLE READ incident, a session is idle in a transaction with an old active snapshot. Production diagnosis must also compare old backend XIDs, prepared transactions, slots and standby feedback before naming the cluster-wide constraint.',
    mechanism:
      'This is the cruel part: autovacuum keeps running. It dispatches workers, they travel to the table, they scan the whole heap, they burn the I/O — and they collect nothing. Page pruning respects the same horizon, so even the HOT path stops helping and tables that never bloat start bloating. Your monitoring says vacuum is healthy. Your table says otherwise.',
    evidence: (s) => [
      { label: 'oldest snapshot age', value: `${s.oldestSnapshotAge.toFixed(0)} s`, tone: 'crit' },
      { label: 'xmin horizon', value: String(s.xminHorizon), tone: 'crit' },
      { label: 'dead tuples', value: Math.round(s.tables.reduce((a, t) => a + t.deadTuples, 0)).toLocaleString(), tone: 'crit' },
      { label: 'worst table', value: `${[...s.tables].sort((a, b) => b.bloat - a.bloat)[0].def.name} · ${([...s.tables].sort((a, b) => b.bloat - a.bloat)[0].bloat * 100).toFixed(0)}% dead`, tone: 'crit' },
    ],
    fix:
      'Release the transaction and watch the horizon jump forward — every dead row becomes removable at once and the next pass actually collects. Then prevent it: set idle_in_transaction_session_timeout and statement_timeout. Neither is a nice-to-have. Without them one forgotten psql window can take down a production database over a weekend.',
    knobs: [KB.longRunningXact, KB.autovacuumScaleFactor],
    confirm: {
      projection: 'tables',
      instrument: 'pg_stat_all_tables',
      sql: `SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_all_tables ORDER BY n_dead_tup DESC;`,
    },
    /* Two conditions, and the order matters. Releasing the snapshot is the fix;
     * the dead rows then take a few vacuum passes to actually come back. Saying
     * "fixed" the instant the horizon moves would teach the wrong lesson, since
     * the whole point is that the damage outlives the cause. */
    resolved: (s) => {
      if (s.knobs.longRunningXact)
        return { ok: false, reading: `a snapshot is still open, ${s.oldestSnapshotAge.toFixed(0)} s old — the horizon has not moved` }
      const worst = [...s.tables].sort((a, b) => b.bloat - a.bloat)[0]
      return {
        ok: tableDeadRatio(worst) < DIAGNOSTIC_BLOAT_RATIO,
        reading: `horizon released · worst table ${worst.def.name} is ${(tableDeadRatio(worst) * 100).toFixed(0)}% dead and ${tableDeadRatio(worst) < DIAGNOSTIC_BLOAT_RATIO ? 'has been collected' : 'is still being worked off'}`,
      }
    },
    city: 'proc.array',
    reading: [
      DOC('routine-vacuuming.html', 'Routine Vacuuming'),
      DOC('mvcc.html', 'Concurrency Control'),
    ],
  },
  {
    id: 'v.av_off',
    kind: 'verdict',
    title: 'Routine autovacuum is off. Anti-wraparound cleanup is the only override.',
    because: 'Dead row versions are accumulating faster than cleanup removes them. Vacuum performs comprehensive cleanup, while HOT page pruning can also remove eligible dead versions during ordinary page access.',
    mechanism:
      'Under MVCC an UPDATE writes a new row version and marks the old one dead; the old version stays on the page until somebody reclaims it. With routine vacuum disabled the table and indexes bloat, every sequential scan reads more pages for the same live rows, and the buffer pool fills with garbage. PostgreSQL still forces anti-wraparound vacuum near autovacuum_freeze_max_age; PGSimCity does not yet model that XID-age safety valve. Bloat costs you cache, not just disk.',
    evidence: (s) => [
      { label: 'autovacuum', value: 'off', tone: 'crit' },
      { label: 'dead tuples', value: Math.round(s.tables.reduce((a, t) => a + t.deadTuples, 0)).toLocaleString(), tone: 'crit' },
    ],
    fix:
      'Turn it on. There is no production configuration in which off is correct — and if someone turned it off to "reduce I/O", they traded a steady trickle for an eventual emergency VACUUM FULL that takes an ACCESS EXCLUSIVE lock on the table.',
    knobs: [KB.autovacuum, KB.autovacuumScaleFactor],
    confirm: {
      projection: 'tables',
      instrument: 'pg_stat_all_tables',
      sql: `SELECT relname, n_dead_tup, last_autovacuum FROM pg_stat_all_tables ORDER BY n_dead_tup DESC;`,
    },
    resolved: (s) => {
      if (!s.knobs.autovacuum) return { ok: false, reading: 'routine autovacuum is still off — this model has no anti-wraparound override' }
      const worst = [...s.tables].sort((a, b) => b.bloat - a.bloat)[0]
      return {
        ok: tableDeadRatio(worst) < DIAGNOSTIC_BLOAT_RATIO,
        reading: `autovacuum on · worst table ${worst.def.name} is ${(tableDeadRatio(worst) * 100).toFixed(0)}% dead`,
      }
    },
    city: 'autovac.launcher',
    reading: [
      DOC('routine-vacuuming.html', 'Routine Vacuuming'),
      DOC('storage-hot.html', 'Heap-Only Tuples'),
    ],
  },
  {
    id: 'v.av_tuning',
    kind: 'verdict',
    title: 'Vacuum is working — it is just losing the race.',
    because:
      'Nothing is pinning the horizon and dead rows are being removed, but they are being created faster than the current thresholds trigger a pass.',
    mechanism:
      'A table is eligible for autovacuum once its dead-tuple estimate exceeds min(autovacuum_vacuum_max_threshold, autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × pg_class.reltuples). reltuples is the planner estimate refreshed by VACUUM or ANALYZE, not pg_stat_all_tables.n_live_tup. PostgreSQL 18 defaults the maximum threshold to 100 million, so that cap—not an ever-growing scale term—governs very large tables; PostgreSQL 17 and older have no cap.',
    evidence: (s) => [
      { label: 'scale factor', value: s.knobs.autovacuumScaleFactor.toFixed(2) },
      { label: 'worst table', value: `${[...s.tables].sort((a, b) => b.bloat - a.bloat)[0].def.name} · ${([...s.tables].sort((a, b) => b.bloat - a.bloat)[0].bloat * 100).toFixed(0)}% dead`, tone: 'warn' },
      { label: 'workers busy', value: `${s.autovac.workers.filter((w) => w.active).length} of 3` },
    ],
    fix:
      'Lower autovacuum_vacuum_scale_factor per table on your big hot relations — 0.01 or 0.02 is normal — and raise autovacuum_max_workers and the cost limits so a pass finishes before the next one is due. Vacuum that runs often is cheap. Vacuum that runs rarely is an outage.',
    knobs: [KB.autovacuumScaleFactor, KB.autovacuum],
    confirm: {
      projection: 'tables',
      instrument: 'pg_stat_all_tables',
      sql: `SELECT s.relname, c.reltuples, s.n_live_tup, s.n_dead_tup
  FROM pg_stat_all_tables AS s
  JOIN pg_class AS c ON c.oid = s.relid
 ORDER BY s.n_dead_tup DESC;`,
    },
    resolved: (s) => {
      const worst = [...s.tables].sort((a, b) => b.bloat - a.bloat)[0]
      return {
        ok: tableDeadRatio(worst) < DIAGNOSTIC_BLOAT_RATIO,
        reading: `scale factor ${s.knobs.autovacuumScaleFactor.toFixed(2)} · worst table ${worst.def.name} is ${(tableDeadRatio(worst) * 100).toFixed(0)}% dead`,
      }
    },
    city: 'autovac.launcher',
    reading: [DOC('runtime-config-autovacuum.html', 'Automatic Vacuuming settings')],
  },
  {
    id: 'v.no_bloat',
    kind: 'verdict',
    title: 'Current estimates show low dead-tuple pressure; physical bloat is unmeasured.',
    because: 'The modeled dead-tuple fraction is low. On PostgreSQL, n_live_tup and n_dead_tup are estimates and do not measure reusable heap space, index bloat or TOAST growth.',
    mechanism:
      'A relation can have a low current dead-tuple estimate and still contain reusable space from earlier churn; its indexes or TOAST relation can also be the growth. Conversely, dead tuples can occupy reusable space without requiring a physical shrink. The city can distinguish modeled live-row, heap-page and aggregate index growth, but it has no TOAST relation or chunk state.',
    evidence: (s) => s.tables.slice(0, 3).map((t) => ({ label: t.def.name, value: `${(t.bloat * 100).toFixed(1)}% dead`, tone: 'ok' as const })),
    fix:
      'Graph pg_relation_size(), pg_indexes_size() and pg_total_relation_size() alongside row counts. If the physical question justifies a page scan, use pgstattuple or an equivalent inspection tool; do not declare “no bloat” from n_dead_tup alone.',
    knobs: [KB.autovacuumScaleFactor],
    city: 'storage.datadir',
    reading: [DOC('routine-vacuuming.html', 'Routine Vacuuming')],
  },
  {
    id: 'v.backend_writes',
    kind: 'verdict',
    title: 'The model sample attributes many writes to client backends; the cause is unresolved.',
    because:
      'The city’s representative sample—not the blank pg_stat_io write cells above—attributes a large write share to client backends. On PostgreSQL, that proves who performed writes, not which query, relation or unique causal chain produced them.',
    mechanism:
      'A client backend may write buffers during allocation pressure, relation extension and other write paths. The city makes a dirty-victim evictor wait for the shared WAL flush when the page LSN is not durable, charges the following page write to that backend, exposes sampled backend-write counts, and reports the dirty-wait distribution’s own p99. Establish the workload and context from rates, checkpointer/background-writer behavior, per-backend I/O and query evidence before assigning a remedy.',
    evidence: (s, c) => {
      const now = recentBackendWriteShare(c)
      return [
        { label: 'sample client-backend writes', value: Math.round(c.total.backendWrites).toLocaleString(), tone: 'crit' as const },
        { label: 'sample share since reset', value: `${(clientBackendWriteShare(c) * 100).toFixed(0)}%`, tone: 'crit' as const },
        {
          label: 'sample share in the last 2 s',
          value: `${(now * 100).toFixed(0)}%`,
          tone: (now > 0.4 ? 'crit' : now > DIAGNOSTIC_GATES.clientBackendWriteShare.threshold ? 'warn' : 'ok') as 'ok' | 'warn' | 'crit',
        },
        { label: 'sample bgwriter cleans/s', value: c.rate.bgwClean.toFixed(1), tone: (s.knobs.bgwriterEnabled ? 'warn' : 'crit') as 'warn' | 'crit' },
      ]
    },
    fix:
      'First compare write rates and bytes across contexts, inspect checkpointer/background-writer capacity, and on PostgreSQL 18 join pg_stat_get_backend_io(pid) to pg_stat_activity. Test shared_buffers or background-writer changes only after workload reuse and allocation pressure support them, then compare before/after rates rather than cumulative totals.',
    knobs: [KB.sharedBuffers, KB.bgwriterLruMaxpages, KB.bgwriterEnabled],
    confirm: {
      projection: 'io',
      instrument: 'pg_stat_io',
      sql: `SELECT backend_type, object, context,
       reads, hits, writes, evictions
  FROM pg_stat_io
 WHERE object = 'relation'
   AND context = 'normal';`,
    },
    /* Judged on the *rate*, not the total, and that is the lesson rather than an
     * implementation detail: the cumulative share is dominated by everything
     * that happened before the reader touched the dial, so a page that graded
     * the fix on it would report failure for minutes after a successful fix. */
    resolved: (_s, c) => {
      const moving = c.rate.backendWrites + c.rate.ckptBuffers + c.rate.bgwClean
      if (moving < 0.05) return { ok: null, reading: 'nothing is being written this second — no rate to judge yet' }
      const now = recentBackendWriteShare(c)
      return {
        ok: now <= DIAGNOSTIC_GATES.clientBackendWriteShare.threshold,
        reading: `${(now * 100).toFixed(0)}% of writes in the last two seconds are still charged to client backends (cumulative share is ${(clientBackendWriteShare(c) * 100).toFixed(0)}%, and lags badly)`,
      }
    },
    city: 'bgwriter',
    reading: [
      DOC('runtime-config-resource.html', 'Resource Consumption settings'),
      DOC('monitoring-stats.html', 'The Cumulative Statistics System'),
    ],
  },
  {
    id: 'v.small_pool',
    kind: 'verdict',
    title: 'The buffer sample shows churn; pool size is not yet proven.',
    because:
      'Almost every sampled resident buffer sits at usage_count 0. That establishes low reuse in the sample, but a one-pass or bulk-read workload can produce the same histogram even when a larger pool would not help.',
    mechanism:
      'Postgres has no LRU list. The sweep walks the pool decrementing usage counts and takes the first frame at zero. That is cheap and needs no global lock, and it works beautifully — right up until there is nothing in the pool worth keeping, at which point the sweep degenerates into an expensive way of evicting pages you are about to need again.',
    evidence: (s) => [
      { label: 'shared_buffers', value: fmtBytes(poolBytes(s.knobs)), tone: 'warn' },
      { label: 'cache hit ratio', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: s.stats.cacheHitPct < 90 ? 'crit' : 'warn' },
      { label: 'sampled frames at usage_count 0', value: `${(coldBufferShare(s) * 100).toFixed(0)}%`, tone: 'crit' },
      { label: 'reads/sec', value: s.stats.ioReadPerSec.toFixed(0) },
    ],
    fix:
      'Identify one-pass and bulk-read queries, compare relation and reusable working-set sizes, and measure repeated-access hit/read rates. Only then test a shared_buffers change with before/after rates; a larger pool cannot create reuse that the workload does not have.',
    knobs: [KB.sharedBuffers],
    confirm: {
      projection: 'buffercache',
      instrument: 'pg_buffercache',
      sql: `SELECT * FROM pg_buffercache_usage_counts();`,
    },
    resolved: (s) => ({
      ok: coldBufferShare(s) <= DIAGNOSTIC_GATES.coldBufferShare.threshold
        && s.stats.cacheHitPct >= DIAGNOSTIC_GATES.cacheHitPercent.threshold,
      reading: `shared_buffers ${fmtBytes(poolBytes(s.knobs))} · ${(coldBufferShare(s) * 100).toFixed(0)}% of sampled frames still at usage_count 0 · hit ratio ${s.stats.cacheHitPct.toFixed(1)}%`,
    }),
    city: 'shared.buffers',
    reading: [DOC('runtime-config-resource.html', 'Resource Consumption settings')],
  },
  {
    id: 'v.io_ok',
    kind: 'verdict',
    title: 'This sample shows reuse; it does not close the I/O investigation.',
    because: 'Reads are mostly hits and the usage-count sample contains reused buffers. The sample does not prove optimal sizing, necessary reads, physical device I/O or correct write attribution.',
    mechanism:
      'A high hit ratio does not mean zero I/O or prove that the remaining reads are necessary. PostgreSQL 18 gives sequential scans of relations larger than a quarter of shared_buffers a bulk-read ring that starts at 256 KiB, grows with io_combine_limit × effective_io_concurrency and is capped. The ring limits cache pollution; it does not guarantee zero displacement or prove physical device reads. The current city model uses a historical fixed 32-frame approximation, so its sampled cache cannot validate PostgreSQL 18’s ring size.',
    evidence: (s) => [
      { label: 'cache hit ratio', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: 'ok' },
      { label: 'sampled frames at usage_count 0', value: `${(coldBufferShare(s) * 100).toFixed(0)}%`, tone: 'ok' },
      { label: 'reads/sec', value: s.stats.ioReadPerSec.toFixed(0) },
    ],
    fix:
      'Look at what is reading rather than at how much. pg_stat_all_tables.seq_scan against a large relation, and pg_stat_all_indexes.idx_scan sitting at zero on an index you are paying to maintain, are both more actionable than a hit-ratio target.',
    knobs: [KB.sharedBuffers],
    city: 'shared.buffers',
    reading: [DOC('monitoring-stats.html', 'The Cumulative Statistics System')],
  },
  {
    id: 'v.lock_holder',
    kind: 'verdict',
    title: 'One session holds an ACCESS EXCLUSIVE lock and never committed.',
    because:
      'Every blocked backend points at the same pid, and that pid is not running a query — it is in `idle in transaction`. The statement that took the lock finished in a millisecond. The lock outlives it, because a lock is held until the transaction ends.',
    mechanism:
      'The city models one scripted ACCESS EXCLUSIVE holder and attaches every affected statement directly to it. It does not model lock modes, queue fairness or one waiter blocking later compatible requests. The evidence below establishes direct waiters and occupied slots only; PostgreSQL’s more complex queue-order cascade is not demonstrated here.',
    evidence: (s) => [
      { label: 'waiters', value: String(s.locks.length), tone: 'crit' },
      { label: 'oldest wait', value: `${Math.max(0, ...s.locks.map((l) => l.ageSec)).toFixed(0)} ${CLAIM_VALUES.modelDuration.shortUnit}`, tone: 'crit' },
      { label: 'mode', value: 'AccessExclusiveLock', tone: 'crit' },
      { label: 'connections in use', value: `${s.stats.activeBackends} of ${s.maxConnections}` },
    ],
    fix:
      'End the holder’s transaction, not the waiters’ queries. Ask the client to commit or roll back; if the session is abandoned, verify the PID, owner and abort consequences before pg_terminate_backend(). pg_cancel_backend() only cancels a current query and cannot clear an idle-in-transaction session. Use SET lock_timeout for DDL so lock acquisition fails promptly.',
    knobs: [KB.lockContention],
    confirm: {
      projection: 'locks',
      instrument: 'pg_locks',
      sql: `SELECT a.pid, a.state, l.locktype,
       l.relation::regclass AS relation, l.mode, l.granted,
       now() - l.waitstart AS wait_age,
       pg_blocking_pids(a.pid) AS blocked_by
  FROM pg_locks l
  JOIN pg_stat_activity a USING (pid)
 WHERE NOT l.granted
    OR l.pid IN (SELECT unnest(pg_blocking_pids(w.pid))
                   FROM pg_stat_activity w);`,
    },
    resolved: (s) => ({
      ok: s.locks.length === 0,
      reading:
        s.locks.length === 0
          ? 'the model has no direct waiters — its scripted holder path has cleared'
          : `${s.locks.length} modeled session${s.locks.length === 1 ? '' : 's'} still waiting directly on the holder, oldest ${Math.max(0, ...s.locks.map((l) => l.ageSec)).toFixed(0)} ${CLAIM_VALUES.modelDuration.shortUnit}`,
    }),
    city: 'lock.manager',
    reading: [
      DOC('explicit-locking.html', 'Explicit Locking'),
      DOC('functions-admin.html#FUNCTIONS-ADMIN-SIGNAL', 'Server Signaling Functions'),
    ],
  },
  {
    id: 'v.no_locks',
    kind: 'verdict',
    title: 'Nothing is blocked. This is not a lock problem.',
    because: 'pg_blocking_pids() returns an empty array for every session — no backend is waiting on a heavyweight lock.',
    mechanism:
      'Lock waits are one of the few Postgres problems with a clean, unambiguous signal: wait_event_type = \'Lock\'. If nobody is showing it, no amount of lock tuning will help, and the queue you think you are seeing is a queue somewhere else.',
    evidence: (s) => [
      { label: 'lock waiters', value: '0', tone: 'ok' },
      { label: 'active backends', value: String(s.stats.runningBackends) },
    ],
    fix: 'Go back to pg_stat_activity and read the wait buckets again — whatever they are queuing on, it is not the lock manager.',
    knobs: [KB.lockContention],
    city: 'lock.manager',
    reading: [DOC('explicit-locking.html', 'Explicit Locking')],
  },
  {
    id: 'v.replay',
    kind: 'verdict',
    title: 'A standby is receiving fine. It cannot replay fast enough.',
    because:
      'sent_lsn, write_lsn and flush_lsn are all tracking the primary — the network is fine and the standby\'s disk is fine. Only replay_lsn is sliding backwards.',
    mechanism:
      'Core PostgreSQL 18 uses one startup process for ordered WAL replay; recovery prefetch improves I/O but is not general parallel redo. Lag grows while sustained generation exceeds replay capacity, and the standby can catch up while the primary keeps writing whenever replay capacity exceeds the incoming rate. The city models that as one bounded applied-LSN rate per standby. A PostgreSQL read there would reflect replay_lsn, but the city has no replica query or row result.',
    evidence: (s) => {
      const standby = worstReplayStandby(s)
      if (!standby) return [{ label: 'pg_stat_replication', value: 'no connected rows', tone: 'crit' }]
      return [
        { label: 'standby', value: standby.applicationName, tone: 'crit' },
        { label: 'flush − replay', value: fmtBytes(standby.flushedLsn - standby.appliedLsn), tone: 'crit' },
        { label: 'model replay delay', value: `${standby.lagSec.toFixed(1)} s`, tone: 'crit' },
        { label: 'primary WAL rate', value: `${fmtBytes(s.wal.bytesPerSec)}/s` },
      ]
    },
    fix:
      'Reduce the WAL the primary produces, or accept the lag and route reads that need currency to the primary. Track pg_current_wal_lsn() minus replay_lsn in bytes and alert on it. And set max_slot_wal_keep_size, because a slot for a standby that falls far enough behind will otherwise consume the primary\'s whole volume.',
    knobs: [KB.standbyASlowApply, KB.standbyBSlowApply, KB.standbyANetworkLag, KB.standbyBNetworkLag],
    confirm: {
      projection: 'replication',
      instrument: 'pg_stat_replication',
      sql: `SELECT replay_lag, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) FROM pg_stat_replication;`,
    },
    resolved: (s) => {
      const standbys = replicationRows(s)
      if (standbys.length === 0)
        return { ok: false, reading: 'pg_stat_replication is empty — no walsender is connected, which is worse than lag' }
      const standby = worstReplayStandby(s)!
      return {
        ok: standbys.every((row) =>
          row.lagSec <= DIAGNOSTIC_GATES.healthyReplaySeconds.threshold
          && row.lagBytes <= DIAGNOSTIC_GATES.currentPositionGapBytes.threshold),
        reading: `${standby.applicationName} has the worst replay delay at ${standby.lagSec.toFixed(2)} s · current byte backlog ${fmtBytes(standby.lagBytes)}`,
      }
    },
    city: 'replica.standby',
    reading: [
      DOC('warm-standby.html', 'Log-Shipping Standby Servers'),
      DOC('runtime-config-replication.html', 'Replication settings'),
    ],
  },
  {
    id: 'v.network',
    kind: 'verdict',
    title: 'Backlog is accumulating at or before WAL transmission.',
    because: 'sent_lsn is behind the primary’s current WAL position. That localises the bottleneck to the sender side or link, but does not identify the network as the root cause by itself.',
    mechanism:
      'Inspect walsender scheduling and CPU pressure, WAL availability and read throughput, sender-side limits, and link throughput or congestion. High latency alone need not create a persistent byte backlog when throughput is sufficient. A primary-to-sent gap rules attention toward or before transmission; it does not prove which component caused it.',
    evidence: (s) => {
      const standby = worstSenderStandby(s)
      if (!standby) return [{ label: 'pg_stat_replication', value: 'no connected rows', tone: 'crit' }]
      return [
        { label: 'standby', value: standby.applicationName, tone: 'crit' },
        { label: 'primary − sent', value: fmtBytes(s.wal.writeLsn - standby.sentLsn), tone: 'crit' },
        { label: 'one-way delay', value: `${standby.networkLagMs} ms`, tone: 'warn' },
        { label: 'records in flight', value: String(standby.inFlight) },
      ]
    },
    fix: 'Inspect the walsender and link together. Fix sender scheduling or WAL-read constraints when they are responsible; fix link throughput or congestion when the transport is responsible. Use byte-rate evidence rather than latency alone.',
    knobs: [KB.standbyANetworkLag, KB.standbyBNetworkLag],
    confirm: {
      projection: 'replication',
      instrument: 'pg_stat_replication',
      sql: `SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       write_lag, flush_lag, replay_lag
  FROM pg_stat_replication;`,
    },
    resolved: (s) => {
      const standbys = replicationRows(s)
      if (standbys.length === 0)
        return { ok: false, reading: 'pg_stat_replication is empty — no walsender is connected at all' }
      const standby = worstSenderStandby(s)!
      const behind = s.wal.writeLsn - standby.sentLsn
      return {
        ok: standbys.every((row) =>
          s.wal.writeLsn - row.sentLsn <= DIAGNOSTIC_GATES.resolvedSenderGapBytes.threshold),
        reading: `${standby.applicationName} has the worst primary − sent_lsn gap at ${fmtBytes(Math.max(0, behind))}, with ${standby.networkLagMs} ms one way`,
      }
    },
    city: 'net.wire',
    reading: [DOC('warm-standby.html', 'Log-Shipping Standby Servers')],
  },
  {
    id: 'v.rep_ok',
    kind: 'verdict',
    title: 'Every connected standby is current.',
    because: 'Every pg_stat_replication row has all four modeled positions within a few kilobytes of the primary, and each modeled replay delay is small.',
    mechanism:
      'This is what healthy looks like, and it is worth knowing precisely, because the failure mode is silent. Nothing errors when a replica falls behind: it keeps answering queries, with older data.',
    evidence: (s) => {
      const standby = worstConnectedStandbyLag(s)
      if (!standby) return [{ label: 'pg_stat_replication', value: 'no connected rows', tone: 'crit' }]
      return [
        { label: 'worst standby', value: standby.applicationName, tone: 'ok' },
        { label: 'primary − replay', value: fmtBytes(standby.lagBytes), tone: 'ok' },
        { label: 'model replay delay', value: `${standby.lagSec.toFixed(2)} s`, tone: 'ok' },
        { label: 'connected rows', value: String(replicationRows(s).length) },
      ]
    },
    fix:
      'Set up the alert while it is healthy. Check pg_replication_slots for ownership, restart_lsn, wal_status and safe_wal_size; inactive permanent slots retain WAL by default, while configured timeout or max_slot_wal_keep_size can invalidate them.',
    knobs: [KB.standbyASlowApply, KB.standbyBSlowApply],
    city: 'walsender',
    reading: [DOC('warm-standby.html', 'Log-Shipping Standby Servers')],
  },
  {
    id: 'v.saturation',
    kind: 'verdict',
    title: 'Every connection slot is occupied, and new work is queueing.',
    because:
      'All available server connection slots are in use and throughput is far below the offered load. The wait rows still matter, but they do not make another server slot available. Direct work queues outside PostgreSQL and is absent from the rolling latency. With PgBouncer transaction pooling, the city instead includes an estimated pool-slot queue in the end-to-end decomposition.',
    mechanism:
      `The city models sixteen backend slots, a fixed fork cadence, queued demand and an uncalibrated pressure curve driven only by active PostgreSQL backends, with a teaching-scale knee at ${CLAIM_VALUES.connectionPooler.concurrencyTarget}. Pooling does not change an assigned statement's plan or executor cost; it reuses connections and can keep PostgreSQL below that pressure curve. ${CLAIM_VALUES.connectionPooler.coverageDisclosure}`,
    evidence: (s) => [
      { label: 'application clients', value: `${s.pooler.acceptedClients} admitted · ${s.pooler.refusedClients} refused`, tone: s.pooler.refusedClients > 0 ? 'crit' : 'warn' },
      { label: 'PostgreSQL backends', value: `${s.stats.activeBackends} of ${s.maxConnections}`, tone: 'crit' },
      { label: 'pool mode / waiting', value: `${s.pooler.mode} · ${s.pooler.waitingClients} clients` },
      { label: 'pool wait timeouts', value: String(Math.round(s.stats.poolerQueryWaitTimeouts)), tone: s.stats.poolerQueryWaitTimeouts > 0 ? 'crit' : undefined },
      { label: 'achieved tps', value: s.stats.tps.toFixed(0) },
      { label: 'offered tps', value: String(Math.round(s.knobs.tps)), tone: 'warn' },
    ],
    fix:
      `Put a measured concurrency limit in front of PostgreSQL. In PgBouncer, pool_mode chooses when a server connection returns to the pool, default_pool_size targets server connections per user/database pair, max_client_conn caps client sockets for the process, and query_wait_timeout disconnects an expired waiter. Transaction pooling multiplexes most aggressively but costs session state: ${CLAIM_VALUES.connectionPooler.transactionTradeoff} Compare PgBouncer SHOW POOLS cl_active, cl_waiting, sv_active and sv_idle with pg_stat_activity's PostgreSQL backend rows. pgcat and Odyssey are alternatives, not modeled implementations.`,
    knobs: [KB.clientConnections, KB.poolMode, KB.defaultPoolSize, KB.maxClientConn, KB.queryWaitTimeout, KB.tps],
    confirm: {
      projection: 'activity_agg',
      instrument: 'pg_stat_activity',
      sql: `SELECT state, wait_event_type, wait_event, count(*)
  FROM pg_stat_activity
 WHERE backend_type = 'client backend'
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;`,
    },
    resolved: (s) => ({
      ok: s.stats.activeBackends < s.maxConnections - DIAGNOSTIC_GATES.connectionSpareSlots.threshold,
      reading: `${s.pooler.acceptedClients} clients admitted by ${s.pooler.mode}; pg_stat_activity sees ${s.stats.activeBackends} of ${s.maxConnections} PostgreSQL backends, achieving ${s.stats.tps.toFixed(0)} tps against ${Math.round(s.knobs.tps)} offered`,
    }),
    city: 'client.pooler',
    reading: [
      DOC('runtime-config-connection.html', 'PostgreSQL connection settings'),
      { label: 'PgBouncer configuration', url: 'https://www.pgbouncer.org/config' },
      { label: 'PgBouncer feature map by pool mode', url: 'https://www.pgbouncer.org/features.html' },
    ],
    disclosure: 'connection-pooler-diagnosis-scope',
  },
  {
    id: 'v.idle',
    kind: 'verdict',
    title: 'The server is not doing anything.',
    because: 'Almost every backend is idle. Whatever is slow, the database is not currently the thing that is slow.',
    mechanism:
      'This is a genuinely common outcome, and it is worth stating plainly because it is the one nobody wants to report. An idle database under a "the site is slow" incident usually means the bottleneck is in the application, the pooler, or the network between them.',
    evidence: (s) => [
      { label: 'active backends', value: String(s.stats.runningBackends), tone: 'ok' },
      { label: 'tps', value: s.stats.tps.toFixed(0) },
      { label: 'cache hit', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: 'ok' },
    ],
    fix:
      'Raise the offered load here to give the model something to do, or take the finding upstream: if the database is idle and the users are waiting, the queue is in front of it.',
    knobs: [KB.tps],
    city: 'backend.row',
    reading: [DOC('monitoring-stats.html', 'The Cumulative Statistics System')],
  },
  {
    id: 'v.sync_local',
    kind: 'verdict',
    title: 'Commits are waiting on your own disk — this is the durability contract.',
    because:
      'Backends are stacked on `IO / WalSync`. Each one is waiting until flush_lsn passes its own commit LSN, which is exactly what synchronous_commit = on promises.',
    mechanism:
      `Watch modeled \`commit_wait\` backends release together when one flush advances past their commit LSNs. Dirty-victim evictors whose page LSN is covered join that same in-flight flush. That is the city’s group-commit mechanism. It increases the rolling p50/p99 and appears in the commit component’s own p99 distribution. ${CLAIM_VALUES.modelLatency.batchDisclosure}, and ${CLAIM_VALUES.modelLatency.resolutionDisclosure}; these are ${CLAIM_VALUES.modelLatency.unit}, not a production latency distribution.`,
    evidence: (s, c) => [
      { label: 'synchronous_commit', value: s.knobs.synchronousCommit },
      { label: 'waiting to commit', value: String(activityWaitCounts(s, c).commit), tone: 'warn' },
      { label: 'insert − flush', value: fmtBytes(s.wal.insertLsn - s.wal.flushLsn) },
    ],
    fix:
      'Decide per transaction, not per cluster. synchronous_commit is a session setting: money moves may need remote_apply, while disposable telemetry may accept off. Turning it off preserves crash consistency but can lose the last few hundred milliseconds of **acknowledged** transactions after a PostgreSQL server, operating-system or power failure.',
    knobs: [KB.synchronousCommit, KB.fullPageWrites],
    confirm: {
      projection: 'wal_lsn',
      instrument: 'pg_current_wal_lsn',
      sql: `SELECT pg_current_wal_insert_lsn(), pg_current_wal_lsn(), pg_current_wal_flush_lsn();`,
    },
    /* Note what "resolved" means here, because it is not "faster". Turning
     * synchronous_commit off empties the queue by giving up a durability
     * guarantee, so the reading names the setting that bought the result rather
     * than congratulating the reader on an empty column. */
    resolved: (s, c) => {
      const commitWaits = activityWaitCounts(s, c).commit
      return {
        ok: commitWaits === 0,
        reading: `synchronous_commit = ${s.knobs.synchronousCommit} · ${commitWaits} backend${commitWaits === 1 ? '' : 's'} waiting on the flush, insert − flush ${fmtBytes(Math.max(0, s.wal.insertLsn - s.wal.flushLsn))}`,
      }
    },
    city: 'walwriter',
    reading: [DOC('runtime-config-wal.html', 'Write Ahead Log settings')],
  },
  {
    id: 'v.sync_remote',
    kind: 'verdict',
    title: 'Every commit is waiting for a standby to answer.',
    because:
      'The wait is `IPC / SyncRep`, not `IO / WalSync`. It includes a network round trip and the acknowledgement selected by synchronous_commit: standby write for remote_write, durable standby flush for on, or replay for remote_apply.',
    mechanism:
      'This is the one everybody gets wrong in the other direction: synchronous_commit = on guarantees a **local** flush only. If the primary\'s disk survives but the machine does not, the standby may never have seen that commit. Synchronous replication requires synchronous_standby_names, and once you have it, every commit costs a full round trip.',
    evidence: (s, c) => {
      const standby = configuredSynchronousStandby(s)
      return [
        { label: 'synchronous_commit', value: s.knobs.synchronousCommit, tone: 'warn' },
        { label: 'waiting to commit', value: String(activityWaitCounts(s, c).commit), tone: 'warn' },
        { label: 'synchronous standby', value: standby?.applicationName ?? 'none' },
        { label: 'one-way delay', value: standby ? `${standby.networkLagMs} ms` : '—' },
        { label: 'model replay delay', value: standby ? `${standby.lagSec.toFixed(2)} s` : '—' },
      ]
    },
    fix:
      'Confirm the guarantee you meant to buy. remote_write is cheaper but does not survive standby operating-system or power failure; on waits for its durable flush; remote_apply also waits for visibility. Measure commit latency and the selected standby stage directly. If remote durability is not required, local avoids the round trip.',
    knobs: [KB.synchronousCommit, KB.synchronousStandbyNames, KB.standbyANetworkLag, KB.standbyBNetworkLag],
    confirm: {
      projection: 'wal_lsn',
      instrument: 'pg_current_wal_lsn',
      sql: `SELECT pg_current_wal_insert_lsn(), pg_current_wal_lsn(), pg_current_wal_flush_lsn();`,
    },
    resolved: (s, c) => {
      const standby = configuredSynchronousStandby(s)
      const commitWaits = activityWaitCounts(s, c).commit
      return {
        ok: commitWaits === 0,
        reading: `synchronous_commit = ${s.knobs.synchronousCommit} with ${standby?.applicationName ?? 'no synchronous standby'}${standby ? ` at ${standby.networkLagMs} ms one way` : ''} · ${commitWaits} backend${commitWaits === 1 ? '' : 's'} still waiting for the standby`,
      }
    },
    city: 'walsender',
    reading: [DOC('runtime-config-replication.html', 'Replication settings')],
  },
  {
    id: 'v.commit_ok',
    kind: 'verdict',
    title: 'Nothing is waiting to commit.',
    because: 'No backend is on WalSync or SyncRep. That can mean the required durability path is keeping up, or that synchronous_commit is configured not to wait; read the setting with the wait events.',
    mechanism:
      'With synchronous_commit requiring local durability, a commit waits for its WAL record to reach durable storage while data pages may remain dirty in shared_buffers. With synchronous_commit = off, PostgreSQL may acknowledge earlier. Read the wait queue together with the configured guarantee.',
    evidence: (s) => [
      { label: 'synchronous_commit', value: s.knobs.synchronousCommit, tone: 'ok' },
      { label: 'insert − flush', value: fmtBytes(s.wal.insertLsn - s.wal.flushLsn), tone: 'ok' },
      { label: 'WAL rate', value: `${fmtBytes(s.wal.bytesPerSec)}/s` },
    ],
    fix:
      'Try switching synchronous_commit to remote_apply and watch the modeled commit_wait queue and stretched trip duration change. This demonstrates the dependency, not production commit latency.',
    knobs: [KB.synchronousCommit],
    city: 'walwriter',
    reading: [DOC('runtime-config-wal.html', 'Write Ahead Log settings')],
  },
  {
    id: 'v.baseline',
    kind: 'verdict',
    title: 'That is the baseline. Now go and break something.',
    because:
      'You have read the four views that between them describe a working PostgreSQL server: the workload, the sessions, the write path, and the copy of your data.',
    mechanism:
      'These views mix cumulative counters, current states, gauges and interval estimates. Counters become rates through two samples and a subtraction; current pg_stat_activity state and replication positions are read as snapshots; lag intervals have their own documented semantics. Classify a value before comparing it over time.',
    evidence: (s, c) => {
      const standby = worstConnectedStandbyLag(s)
      return [
        { label: 'tps', value: s.stats.tps.toFixed(0), tone: 'ok' },
        { label: 'cache hit', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: 'ok' },
        { label: 'requested checkpoints', value: `${(checkpointRequestedShare(c) * 100).toFixed(0)}%`, tone: 'ok' },
        { label: 'worst connected standby', value: standby?.applicationName ?? 'none' },
        { label: 'model replay delay', value: standby ? `${standby.lagSec.toFixed(2)} s` : '—', tone: 'ok' },
      ]
    },
    fix:
      'Pick any other complaint on the left. Each one puts this same server into a state that produces that symptom, and walks you to the column that proves it. The numbers you just learned are the ones that will look wrong.',
    knobs: [KB.tps, KB.sharedBuffers],
    city: 'shared.buffers',
    reading: [DOC('monitoring-stats.html', 'The Cumulative Statistics System')],
  },
]

export const NODES = new Map<string, Node>()
for (const s of STEPS) NODES.set(s.id, s)
for (const v of VERDICTS) NODES.set(v.id, v)

export const ALL_STEPS = STEPS
export const ALL_VERDICTS = VERDICTS
