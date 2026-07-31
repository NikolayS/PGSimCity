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
import { fmtBytes } from '../core/util'
import type { Collector } from './collector'
import type { Subsystem } from './catalog'

const MIB = 1024 * 1024

/* ---------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------*/

export interface Branch {
  /** the condition, in plain language */
  label: string
  /** true right now? */
  test: (s: SimState, c: Collector) => boolean
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
}

export interface Symptom {
  id: string
  /** the complaint, in the words someone actually uses */
  complaint: string
  /** the shape of it */
  sub: string
  /** scenario id to stage in the model, or null */
  scenario: string | null
  entry: string
  accent: Subsystem
}

export type Node = Step | Verdict

/* ---------------------------------------------------------------------------
 * Live helpers used by branch predicates
 * -------------------------------------------------------------------------*/

interface Waits {
  total: number
  lock: number
  io: number
  commit: number
  idleTx: number
  cpu: number
  idle: number
}

export function waits(s: SimState): Waits {
  const w: Waits = { total: 0, lock: 0, io: 0, commit: 0, idleTx: 0, cpu: 0, idle: 0 }
  if (s.knobs.longRunningXact) {
    w.total++
    w.idleTx++
  }
  for (const b of s.backends) {
    if (!b.active || b.state === 'free') continue
    w.total++
    switch (b.state) {
      case 'blocked':
        w.lock++
        break
      case 'exec_io':
        w.io++
        break
      case 'commit_wait':
        w.commit++
        break
      case 'idle_in_xact':
        w.idleTx++
        break
      case 'idle':
      case 'ending':
        w.idle++
        break
      default:
        w.cpu++
    }
  }
  return w
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

export function forcedShare(c: Collector): number {
  const t = c.total.ckptTimed + c.total.ckptRequested
  return t > 0 ? c.total.ckptRequested / t : 0
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
  return {
    ok: true,
    reading:
      timed > 0
        ? `num_requested has not moved in ${secs} s and ${timed} checkpoint${timed === 1 ? '' : 's'} fired on the timer — the schedule is yours again`
        : `num_requested has not moved in ${secs} s — no requested checkpoint has completed in this observation window`,
  }
}

export function fpiShare(c: Collector): number {
  return c.total.walBytes > 0 ? (c.total.walFpi * 8192) / c.total.walBytes : 0
}

export function backendWriteShare(c: Collector): number {
  const t = c.total.backendWrites + c.total.ckptBuffers + c.total.bgwClean
  return t > 0 ? c.total.backendWrites / t : 0
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

export function coldShare(s: SimState): number {
  const b = s.buffers
  let used = 0
  let cold = 0
  for (let i = 0; i < b.sampleFrames; i++) {
    if (!b.valid[i]) continue
    used++
    if (b.usage[i] === 0) cold++
  }
  return used > 0 ? cold / used : 0
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
    choices: ['off', 'local', 'on', 'remote_apply'],
    help: 'A per-session setting. Money commits with remote_apply; telemetry commits with off.',
  },
  replicaSlowApply: {
    key: 'replicaSlowApply',
    guc: 'a standby that cannot keep up',
    kind: 'toggle',
    help: 'Replay is single-threaded. This models a standby whose one redo process cannot keep up.',
  },
  replicaNetworkLag: {
    key: 'replicaNetworkLag',
    guc: 'network one-way delay',
    kind: 'range',
    min: 0,
    max: 200,
    step: 5,
    unit: 'ms',
    help: 'Delays every position equally. It is not what people usually mean by replication lag.',
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
  fullPageWrites: {
    key: 'fullPageWrites',
    guc: 'full_page_writes',
    kind: 'toggle',
    help: 'Safe to turn off only on storage that guarantees atomic 8 kB writes. On a cloud volume, you do not have that guarantee.',
  },
} as const satisfies Record<string, KnobSpec>

const DOC = (slug: string, label: string) => ({ label, url: `https://www.postgresql.org/docs/current/${slug}` })

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
    sub: 'Latency is fine, then a spike, then fine again.',
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
      { label: 'Most of them are waiting on `Lock`.', next: 'lock.1', test: (s) => share(waits(s).lock, waits(s).total) > 0.25 },
      { label: 'Most of them are waiting on `IO`.', next: 'io.1', test: (s) => share(waits(s).io, waits(s).total) > 0.3 },
      { label: 'They are waiting to commit — `IO / WalSync` or `IPC / SyncRep`.', next: 'commit.1', test: (s) => share(waits(s).commit, waits(s).total) > 0.25 },
      { label: 'Sessions are sitting in `idle in transaction`.', next: 'bloat.2', test: (s) => waits(s).idleTx > 0 },
      {
        label: 'Everything is `active`, nothing is waiting, and every connection slot is busy.',
        next: 'v.saturation',
        test: (s) => s.stats.activeBackends >= s.maxConnections - 1 && share(waits(s).cpu, waits(s).total) > 0.4,
      },
      { label: 'Hardly anything is running at all.', next: 'v.idle', test: (s) => waits(s).total - waits(s).idle < 3 },
    ],
  },

  /* ==================== writes stall =================================== */
  {
    id: 'stall.1',
    kind: 'step',
    title: 'Is the checkpointer running on the timer, or on requests?',
    why: 'Periodic stalls may correlate with checkpoints. These counters separate timer checkpoints from requested ones, but a second source is needed to identify why a request occurred.',
    instrument: 'pg_stat_checkpointer',
    projection: 'checkpointer',
    city: 'checkpointer',
    sql: `SELECT num_timed, num_requested, buffers_written,
       write_time, sync_time
  FROM pg_stat_checkpointer;`,
    look:
      '`num_timed` counts checkpoints initiated by `checkpoint_timeout`. `num_requested` counts requested checkpoints from multiple causes, including WAL pressure, explicit CHECKPOINT, base-backup activity and shutdown. A high requested rate tells you to correlate checkpoint messages, WAL volume, maintenance and backups; it does not prove max_wal_size is too small.',
    note:
      'pg_stat_checkpointer is new in PostgreSQL 17. On 16 and older these two counters live in pg_stat_bgwriter and are called `checkpoints_timed` and `checkpoints_req` — same numbers, older home. Most tuning guides still name the old columns.',
    branches: [
      { label: '`num_requested` is a serious share; investigate the request sources.', next: 'stall.2', test: (_s, c) => c.total.ckptDone > 0 && forcedShare(c) > 0.2 },
      { label: 'Almost every checkpoint is timed.', next: 'v.ckpt_ok', test: (_s, c) => c.total.ckptDone > 0 && forcedShare(c) <= 0.2 },
    ],
  },
  {
    id: 'stall.2',
    kind: 'step',
    title: 'Does WAL volume explain the requests in this incident?',
    why: 'This model records WAL pressure as its request source. On a real server, use WAL volume and checkpoint messages to establish that cause before asking whether full-page images amplify it.',
    instrument: 'pg_stat_wal',
    projection: 'wal',
    city: 'wal.vault',
    sql: `SELECT wal_records, wal_fpi, wal_bytes, wal_buffers_full
  FROM pg_stat_wal;`,
    look:
      '`wal_fpi` counts full-page images. The first time a page is modified after a checkpoint stamps its redo point, its entire 8 kB image goes into the WAL — so if FPI is a large share of wal_bytes, the checkpoints are generating the WAL that is triggering the next checkpoint.',
    note:
      'pg_stat_wal arrived in 14. PostgreSQL 18 removed wal_write, wal_sync, wal_write_time and wal_sync_time from it; WAL I/O now shows up in pg_stat_io with object = \'wal\'.',
    branches: [
      { label: 'Full-page images are a large share of the bytes.', next: 'v.ckpt_storm', test: (_s, c) => c.total.walBytes > 0 && fpiShare(c) > 0.25 },
      { label: 'WAL volume is high, but FPI is not what is driving it.', next: 'v.wal_volume', test: (_s, c) => c.total.walBytes > 0 && fpiShare(c) <= 0.25 },
    ],
  },

  /* ==================== bloat ========================================== */
  {
    id: 'bloat.1',
    kind: 'step',
    title: 'Which table, and how dead is it?',
    why: 'Start with the fact rather than the theory: find the table whose dead row versions are growing, and check whether autovacuum has been there at all.',
    instrument: 'pg_stat_all_tables',
    projection: 'tables',
    city: 'storage.datadir',
    sql: `SELECT relname, n_live_tup, n_dead_tup,
       n_tup_upd, n_tup_hot_upd,
       last_autovacuum, autovacuum_count
  FROM pg_stat_all_tables
 ORDER BY n_dead_tup DESC;`,
    look:
      'Compare `n_tup_hot_upd` with `n_tup_upd`. A HOT update keeps the new row version on the same page and touches no index, and Postgres can prune those during ordinary page access without vacuum at all. A table where the two numbers diverge is a table that depends on vacuum — and will bloat the moment vacuum cannot keep up. The healthy table at the bottom of the list is worth as much as the sick one at the top: `events` is insert-only, so it has no dead rows to collect and vacuum has nothing to do on it. Bloat is a property of your write pattern before it is a property of your vacuum settings.',
    branches: [
      { label: 'Dead tuples are climbing although autovacuum ran recently.', next: 'bloat.2', test: (s) => s.tables.some((t) => t.bloat > 0.12 && s.t - t.lastVacuum < 90) },
      { label: 'autovacuum has never run on it.', next: 'v.av_off', test: (s) => !s.knobs.autovacuum },
      { label: 'Dead tuples are under control.', next: 'v.no_bloat', test: (s) => s.tables.every((t) => t.bloat < 0.12) },
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
 WHERE backend_xmin IS NOT NULL
 ORDER BY age(backend_xmin) DESC;`,
    look:
      'The oldest `backend_xmin` in this list **is** the horizon. Note that `backend_xid` can be null while `backend_xmin` is not: a read-only transaction never consumes a transaction id, but it still holds a snapshot — and the snapshot is what blocks cleanup. Sorting by xact_age finds the session; sorting by age(backend_xmin) finds the damage.',
    note:
      'Two other things pin the horizon and are not in this list: a replication slot with an old `xmin` (check pg_replication_slots) and a long query on a hot standby with hot_standby_feedback on. Same mechanism, same damage, different view.',
    branches: [
      { label: 'There is a session in `idle in transaction` with an ancient xact_age.', next: 'bloat.3', test: (s) => s.knobs.longRunningXact || s.oldestSnapshotAge > 25 },
      { label: 'Nothing here is old.', next: 'v.av_tuning', test: (s) => !s.knobs.longRunningXact && s.oldestSnapshotAge <= 25 },
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
      { label: 'It scans the whole heap and removes nothing.', next: 'v.xmin', test: (s) => s.knobs.longRunningXact },
      { label: 'It is removing rows, just not fast enough.', next: 'v.av_tuning', test: (s) => !s.knobs.longRunningXact },
    ],
  },

  /* ==================== reads / buffers ================================ */
  {
    id: 'io.1',
    kind: 'step',
    title: 'Who is actually doing the I/O?',
    why: 'Every I/O problem has a culprit process, and until PostgreSQL 16 you essentially could not name it. This is the view that changed that, and it is the first place to look now.',
    instrument: 'pg_stat_io',
    projection: 'io',
    city: 'shared.buffers',
    sql: `SELECT backend_type, object, context,
       reads, hits, writes, evictions
  FROM pg_stat_io
 WHERE object = 'relation'
   AND context = 'normal';`,
    look:
      'Reads on the `client backend` row are normal — that is queries fetching pages. **Writes** on that row are not. A user query only writes a page when the frame it wanted was dirty and it had to clean it first, which means somebody\'s SELECT is paying for somebody else\'s UPDATE. Compare that number with the checkpointer\'s and the background writer\'s.',
    note:
      'pg_stat_io is new in 16. Before that the nearest signal is `buffers_backend` in pg_stat_bgwriter, which tells you backends wrote pages but not which object, context or operation. PostgreSQL 18 replaced op_bytes with per-operation read_bytes, write_bytes and extend_bytes.',
    branches: [
      { label: '`client backend` writes are a large share of all writes.', next: 'v.backend_writes', test: (_s, c) => backendWriteShare(c) > 0.25 },
      { label: 'Reads dominate and the hit ratio is poor.', next: 'io.2', test: (s) => s.stats.cacheHitPct < 92 },
      { label: 'Reads are mostly hits and writes are spread sensibly.', next: 'v.io_ok', test: (s, c) => s.stats.cacheHitPct >= 92 && backendWriteShare(c) <= 0.25 },
    ],
  },
  {
    id: 'io.2',
    kind: 'step',
    title: 'Is the pool large enough to hold anything?',
    why: 'A low hit ratio has two very different causes — a pool too small for the working set, or a workload that sweeps data nothing can cache. The clock-sweep usage counts tell them apart.',
    instrument: 'pg_buffercache',
    projection: 'buffercache',
    city: 'shared.buffers',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_buffercache;

SELECT * FROM pg_buffercache_usage_counts();`,
    look:
      'Postgres has no LRU list. The clock sweep walks the pool decrementing `usagecount`, and the first frame it finds at zero is the victim. If nearly every buffer sits at 0, nothing survives long enough to be counted as useful twice — the pool is being churned, not used.',
    note:
      'pg_buffercache_usage_counts() and pg_buffercache_summary() arrived in 16 and are far cheaper than scanning the pg_buffercache view, which takes a lock on every buffer header. Do not put the view itself in a polling loop.',
    branches: [
      { label: 'Almost everything sits at usage_count 0.', next: 'v.small_pool', test: (s) => coldShare(s) > 0.55 },
      { label: 'The pool is holding a real working set.', next: 'v.io_ok', test: (s) => coldShare(s) <= 0.55 },
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
    sql: `SELECT a.pid, a.state, l.locktype,
       l.relation::regclass AS relation, l.mode, l.granted,
       now() - l.waitstart AS wait_age,
       pg_blocking_pids(a.pid) AS blocked_by
  FROM pg_locks l
  JOIN pg_stat_activity a USING (pid)
 WHERE NOT l.granted
    OR l.pid IN (SELECT unnest(pg_blocking_pids(w.pid))
                   FROM pg_stat_activity w);`,
    look:
      'One pid appears in every `blocked_by` array and is itself blocked by nobody. That is your holder — and look at its state. It is not running a query; it finished the statement and left the transaction open. Cancelling the waiters achieves nothing at all.',
    note:
      'pg_blocking_pids() arrived in 9.6 and replaced a decade of hand-written self-joins on pg_locks. It briefly takes the lock manager\'s shared state, so it is a diagnostic tool, not a dashboard metric. `waitstart` arrived in 14.',
    branches: [
      { label: 'One pid is blocking everyone else.', next: 'v.lock_holder', test: (s) => s.locks.length > 0 },
      { label: 'Nothing is blocked.', next: 'v.no_locks', test: (s) => s.locks.length === 0 },
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
      'It is a pipeline: the walsender **sends**, the standby **writes** it, **flushes** it to its own disk, and only then does the startup process **replay** it. Walk left to right and stop at the first position that is not tracking the primary. That column is the component that is behind.',
    note:
      'write_lag, flush_lag and replay_lag arrived in 10. An empty pg_stat_replication on a primary you believe has a standby is not "zero lag" — it means the walsender is gone.',
    branches: [
      { label: 'Received and flushed are fine; only replay is sliding.', next: 'v.replay', test: (s) => s.replication.flushLsn - s.replication.replayLsn > 256 * 1024 },
      { label: 'Even sent_lsn is far behind the primary.', next: 'v.network', test: (s) => s.wal.writeLsn - s.replication.sentLsn > 512 * 1024 },
      { label: 'All four are within a few kilobytes of the primary.', next: 'v.rep_ok', test: (s) => s.replication.lagBytes < 512 * 1024 },
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
      { label: 'They are waiting on `IPC / SyncRep`.', next: 'v.sync_remote', test: (s) => s.knobs.synchronousStandbyNames && (s.knobs.synchronousCommit === 'on' || s.knobs.synchronousCommit === 'remote_apply') && waits(s).commit > 0 },
      { label: 'They are waiting on `IO / WalSync`.', next: 'v.sync_local', test: (s) => (!s.knobs.synchronousStandbyNames || s.knobs.synchronousCommit === 'local' || s.knobs.synchronousCommit === 'off') && waits(s).commit > 0 },
      { label: 'Nobody is waiting to commit.', next: 'v.commit_ok', test: (s) => waits(s).commit === 0 },
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
    branches: [{ label: 'Next: who is connected, and what are they doing?', next: 'normal.2', test: () => true }],
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
    branches: [{ label: 'Next: is the write path keeping up?', next: 'normal.3', test: () => true }],
  },
  {
    id: 'normal.3',
    kind: 'step',
    title: 'Check the write path before it checks you.',
    why: 'The checkpointer and the background writer are the two processes nobody looks at until latency goes strange. Two numbers tell you whether they are coping.',
    instrument: 'pg_stat_checkpointer',
    projection: 'checkpointer',
    city: 'checkpointer',
    sql: `SELECT num_timed, num_requested, buffers_written, write_time
  FROM pg_stat_checkpointer;

SELECT buffers_clean, buffers_alloc FROM pg_stat_bgwriter;`,
    look:
      'A low num_requested rate means few checkpoints were requested during this window; it does not reveal why any request occurred. Correlate requests with WAL volume, checkpoint messages, backups and explicit maintenance. buffers_clean should be non-zero but modest — the background writer is meant to clean a short way ahead of the clock hand, not to empty the pool.',
    note:
      'PostgreSQL 17 split pg_stat_checkpointer out of pg_stat_bgwriter. If you are on 16 or older, read checkpoints_timed and checkpoints_req from pg_stat_bgwriter instead.',
    branches: [{ label: 'Next: is the standby keeping up?', next: 'normal.4', test: () => true }],
  },
  {
    id: 'normal.4',
    kind: 'step',
    title: 'And finally: is the copy of your data current?',
    why: 'Replication lag is silent. Nothing errors, nothing logs, and the replica keeps answering queries with older data.',
    instrument: 'pg_stat_replication',
    projection: 'replication',
    city: 'walsender',
    sql: `SELECT application_name, state, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_bytes,
       replay_lag
  FROM pg_stat_replication;`,
    look:
      'Alert on `pg_current_wal_lsn() - replay_lsn` in bytes for current backlog. Graph replay_lag too, but read it as PostgreSQL defines it: an estimate of recent commit-delay impact at replay, not current staleness, byte lag converted to time or a catch-up forecast. It may retain a recent value and then become NULL on an idle system.',
    branches: [{ label: 'That is the baseline. Now go break something.', next: 'v.baseline', test: () => true }],
  },
]

/* ---------------------------------------------------------------------------
 * The verdicts
 * -------------------------------------------------------------------------*/

const VERDICTS: Verdict[] = [
  {
    id: 'v.ckpt_storm',
    kind: 'verdict',
    title: 'This modeled incident is WAL-triggered, and full-page writes feed it.',
    because:
      'PGSimCity records max_wal_size pressure as the request cause here. In PostgreSQL, num_requested alone would not establish that cause; checkpoint messages and correlated WAL volume do. Each checkpoint stamps a new redo point, after which a page may owe a full 8 KiB image on its first change.',
    mechanism:
      'Checkpoint → full-page writes → more WAL → max_wal_size crossed sooner → the next checkpoint starts early. It is a feedback loop, and it is self-sustaining once it starts. What your users see is not an error: it is a periodic latency spike that your application team will confidently attribute to the network, because the database never logs anything.',
    evidence: (_s, c) => [
      { label: 'num_timed', value: String(Math.round(c.total.ckptTimed)) },
      { label: 'num_requested', value: String(Math.round(c.total.ckptRequested)), tone: 'crit' },
      { label: 'requested share', value: `${(forcedShare(c) * 100).toFixed(0)}%`, tone: 'crit' },
      { label: 'full-page images', value: `${(fpiShare(c) * 100).toFixed(0)}% of wal_bytes`, tone: 'warn' },
    ],
    fix:
      'Because this model exposes WAL pressure as the cause, raise max_wal_size against its measured peak WAL rate and headroom, then verify the pressure stops. On a real server, first exclude explicit CHECKPOINT, backup and shutdown requests; changing max_wal_size cannot fix those. checkpoint_timeout also trades full-page-image frequency against crash-recovery work.',
    knobs: [KB.maxWalSize, KB.checkpointTimeout],
    confirm: {
      projection: 'checkpointer',
      instrument: 'pg_stat_checkpointer',
      sql: `SELECT num_timed, num_requested FROM pg_stat_checkpointer;`,
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
      { label: 'requested share', value: `${(forcedShare(c) * 100).toFixed(0)}%`, tone: 'warn' },
    ],
    fix:
      'For this modeled cause, size max_wal_size from measured peak WAL rate, available disk and recovery objectives, then confirm the WAL-triggered requests stop. In production, confirm the request reason from checkpoint messages and surrounding activity rather than treating num_requested as a cause code.',
    knobs: [KB.maxWalSize],
    confirm: {
      projection: 'checkpointer',
      instrument: 'pg_stat_checkpointer',
      sql: `SELECT num_timed, num_requested FROM pg_stat_checkpointer;`,
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
      'The observed checkpoints are mostly timer-driven. That is evidence against a high rate of requested checkpoints, not proof that max_wal_size is ideal or that checkpoint I/O cannot contribute to a stall.',
    mechanism:
      'A timed checkpoint normally has checkpoint_completion_target of the configured interval for pacing. A checkpoint that this model starts under WAL pressure may have only the model’s estimated time to refill its WAL budget; other kinds of requested checkpoint do not imply that deadline.',
    evidence: (_s, c) => [
      { label: 'num_timed', value: String(Math.round(c.total.ckptTimed)), tone: 'ok' },
      { label: 'num_requested', value: String(Math.round(c.total.ckptRequested)), tone: 'ok' },
      { label: 'buffers_written', value: String(Math.round(c.total.ckptBuffers)) },
    ],
    fix:
      'If writes still stall periodically, the next suspects are the fsync burst at the end of each checkpoint (watch sync_time), and autovacuum arriving on a large table. Try the "reads got slow" path — a stall that correlates with I/O rather than with the clock is a different animal.',
    knobs: [KB.checkpointTimeout],
    city: 'checkpointer',
    reading: [DOC('wal-configuration.html', 'WAL Configuration')],
  },
  {
    id: 'v.xmin',
    kind: 'verdict',
    title: 'One abandoned transaction is holding the xmin horizon, and vacuum cannot remove anything.',
    because:
      'A session is sitting in `idle in transaction` with an old snapshot. Vacuum may only remove a row version that is invisible to every open snapshot, so every dead row created since that BEGIN has to stay — across the entire database, not just this table.',
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
        ok: worst.bloat < 0.12,
        reading: `horizon released · worst table ${worst.def.name} is ${(worst.bloat * 100).toFixed(0)}% dead and ${worst.bloat < 0.12 ? 'has been collected' : 'is still being worked off'}`,
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
        ok: worst.bloat < 0.12,
        reading: `autovacuum on · worst table ${worst.def.name} is ${(worst.bloat * 100).toFixed(0)}% dead`,
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
      'A table is eligible for autovacuum once its dead tuples exceed autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup. The default scale factor of 0.2 means a hundred-million-row table waits for twenty million dead rows before anything happens — a threshold calibrated for 2005 hardware and table sizes.',
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
      sql: `SELECT relname, n_dead_tup, n_live_tup FROM pg_stat_all_tables ORDER BY n_dead_tup DESC;`,
    },
    resolved: (s) => {
      const worst = [...s.tables].sort((a, b) => b.bloat - a.bloat)[0]
      return {
        ok: worst.bloat < 0.12,
        reading: `scale factor ${s.knobs.autovacuumScaleFactor.toFixed(2)} · worst table ${worst.def.name} is ${(worst.bloat * 100).toFixed(0)}% dead`,
      }
    },
    city: 'autovac.launcher',
    reading: [DOC('runtime-config-autovacuum.html', 'Automatic Vacuuming settings')],
  },
  {
    id: 'v.no_bloat',
    kind: 'verdict',
    title: 'These tables are not bloated. The growth is something else.',
    because: 'Dead tuples are a small fraction of live tuples on every relation, and autovacuum is keeping up.',
    mechanism:
      'A table can grow for reasons that are not bloat: it can simply be accumulating rows, its indexes can be growing faster than the heap, or its TOAST sidecar can be doing the growing while the main relation stays flat.',
    evidence: (s) => s.tables.slice(0, 3).map((t) => ({ label: t.def.name, value: `${(t.bloat * 100).toFixed(1)}% dead`, tone: 'ok' as const })),
    fix:
      'Compare pg_relation_size() with pg_total_relation_size() to see whether the indexes or the TOAST table are the growth, and check n_ins_since_vacuum — an append-only table needs vacuum for freezing even though it never has dead rows.',
    knobs: [KB.autovacuumScaleFactor],
    city: 'storage.datadir',
    reading: [DOC('routine-vacuuming.html', 'Routine Vacuuming')],
  },
  {
    id: 'v.backend_writes',
    kind: 'verdict',
    title: 'Your user queries are doing their own write I/O.',
    because:
      'A large share of all page writes are charged to `client backend`. That happens in exactly one situation: a backend needed a free frame, the clock sweep handed it a dirty one, and the backend had to write that page out before it could start its own read.',
    mechanism:
      'This is the symptom nobody recognises, because throughput barely moves — the same pages get written either way. What changes is **who waits**. A synchronous write in the middle of a user query is a latency spike, and it lands on random unlucky transactions rather than on a background process, which is why it shows up in your p99 and nowhere else.',
    evidence: (s, c) => {
      const now = recentBackendWriteShare(c)
      return [
        { label: 'sample client-backend writes', value: Math.round(c.total.backendWrites).toLocaleString(), tone: 'crit' as const },
        { label: 'sample share since reset', value: `${(backendWriteShare(c) * 100).toFixed(0)}%`, tone: 'crit' as const },
        {
          label: 'sample share in the last 2 s',
          value: `${(now * 100).toFixed(0)}%`,
          tone: (now > 0.4 ? 'crit' : now > 0.2 ? 'warn' : 'ok') as 'ok' | 'warn' | 'crit',
        },
        { label: 'sample bgwriter cleans/s', value: c.rate.bgwClean.toFixed(1), tone: (s.knobs.bgwriterEnabled ? 'warn' : 'crit') as 'warn' | 'crit' },
      ]
    },
    fix:
      'Fix the pool first. The background writer only cleans a short window ahead of the clock hand, so it cannot rescue a pool that is being churned end to end — raise shared_buffers and the backend writes fall away on their own. Then raise bgwriter_lru_maxpages and lower bgwriter_delay, which is nearly free and moves the remaining writes onto a background process. Watch the two share figures above as you turn the dial: the cumulative one barely twitches and the two-second one moves at once, which is the whole reason nobody should ever alert on a raw pg_stat_* counter.',
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
        ok: now <= 0.2,
        reading: `${(now * 100).toFixed(0)}% of writes in the last two seconds are still charged to client backends (cumulative share is ${(backendWriteShare(c) * 100).toFixed(0)}%, and lags badly)`,
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
    title: 'shared_buffers is too small for this working set.',
    because:
      'Almost every resident buffer sits at usage_count 0 — nothing survives long enough to be used twice. The clock sweep never stops, and every miss asks the operating system for a page; PostgreSQL statistics cannot distinguish an OS-cache hit from physical device I/O.',
    mechanism:
      'Postgres has no LRU list. The sweep walks the pool decrementing usage counts and takes the first frame at zero. That is cheap and needs no global lock, and it works beautifully — right up until there is nothing in the pool worth keeping, at which point the sweep degenerates into an expensive way of evicting pages you are about to need again.',
    evidence: (s) => [
      { label: 'shared_buffers', value: fmtBytes(poolBytes(s.knobs)), tone: 'warn' },
      { label: 'cache hit ratio', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: s.stats.cacheHitPct < 90 ? 'crit' : 'warn' },
      { label: 'sampled frames at usage_count 0', value: `${(coldShare(s) * 100).toFixed(0)}%`, tone: 'crit' },
      { label: 'reads/sec', value: s.stats.ioReadPerSec.toFixed(0) },
    ],
    fix:
      'Raise shared_buffers and watch the hit ratio, the usage-count distribution and the read rate all move together. 25% of RAM is the usual starting point. The interesting part is that the curve is not linear — it is flat, then a cliff, then flat again, and the cliff is where your working set stops fitting.',
    knobs: [KB.sharedBuffers],
    confirm: {
      projection: 'buffercache',
      instrument: 'pg_buffercache',
      sql: `SELECT * FROM pg_buffercache_usage_counts();`,
    },
    resolved: (s) => ({
      ok: coldShare(s) <= 0.55 && s.stats.cacheHitPct >= 92,
      reading: `shared_buffers ${fmtBytes(poolBytes(s.knobs))} · ${(coldShare(s) * 100).toFixed(0)}% of sampled frames still at usage_count 0 · hit ratio ${s.stats.cacheHitPct.toFixed(1)}%`,
    }),
    city: 'shared.buffers',
    reading: [DOC('runtime-config-resource.html', 'Resource Consumption settings')],
  },
  {
    id: 'v.io_ok',
    kind: 'verdict',
    title: 'The buffer pool is healthy. Your I/O is going somewhere else.',
    because: 'Reads are mostly hits, the usage-count distribution shows a real working set, and writes are spread across the background processes the way they should be.',
    mechanism:
      'A high hit ratio does not mean zero I/O or prove that the remaining reads are necessary. PostgreSQL 18 gives sequential scans of relations larger than a quarter of shared_buffers a bulk-read ring that starts at 256 KiB, grows with io_combine_limit × effective_io_concurrency and is capped. The ring limits cache pollution; it does not guarantee zero displacement or prove physical device reads. The current city model uses a historical fixed 32-frame approximation, so its sampled cache cannot validate PostgreSQL 18’s ring size.',
    evidence: (s) => [
      { label: 'cache hit ratio', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: 'ok' },
      { label: 'sampled frames at usage_count 0', value: `${(coldShare(s) * 100).toFixed(0)}%`, tone: 'ok' },
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
      'Locks queue in order, and this is the detail that surprises people: a blocked ACCESS EXCLUSIVE request also blocks every **later** request, including harmless SELECTs that would never have conflicted with each other. One waiter poisons the whole queue behind it. Meanwhile every blocked session is still holding a connection, so once they exhaust the pool, traffic that never touches this table starts failing too. One lock becomes a total outage.',
    evidence: (s) => [
      { label: 'waiters', value: String(s.locks.length), tone: 'crit' },
      { label: 'oldest wait', value: `${Math.max(0, ...s.locks.map((l) => l.ageSec)).toFixed(0)} s`, tone: 'crit' },
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
          ? 'pg_locks has no ungranted rows — the queue has drained and every waiter got its lock'
          : `${s.locks.length} session${s.locks.length === 1 ? '' : 's'} still queued behind the holder, oldest ${Math.max(0, ...s.locks.map((l) => l.ageSec)).toFixed(0)} s`,
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
    title: 'The standby is receiving fine. It cannot replay fast enough.',
    because:
      'sent_lsn, write_lsn and flush_lsn are all tracking the primary — the network is fine and the standby\'s disk is fine. Only replay_lsn is sliding backwards.',
    mechanism:
      'Core PostgreSQL 18 uses one startup process for ordered WAL replay; recovery prefetch improves I/O but is not general parallel redo. Lag grows while sustained generation exceeds replay capacity. The standby can catch up while the primary keeps writing whenever replay capacity exceeds the incoming rate. A read there reflects replay_lsn, and the connection itself does not advertise staleness.',
    evidence: (s) => [
      { label: 'flush − replay', value: fmtBytes(s.replication.flushLsn - s.replication.replayLsn), tone: 'crit' },
      { label: 'model replay delay', value: `${s.replication.lagSec.toFixed(1)} s`, tone: 'crit' },
      { label: 'primary WAL rate', value: `${fmtBytes(s.wal.bytesPerSec)}/s` },
    ],
    fix:
      'Reduce the WAL the primary produces, or accept the lag and route reads that need currency to the primary. Track pg_current_wal_lsn() minus replay_lsn in bytes and alert on it. And set max_slot_wal_keep_size, because a slot for a standby that falls far enough behind will otherwise consume the primary\'s whole volume.',
    knobs: [KB.replicaSlowApply, KB.replicaNetworkLag],
    confirm: {
      projection: 'replication',
      instrument: 'pg_stat_replication',
      sql: `SELECT replay_lag, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) FROM pg_stat_replication;`,
    },
    resolved: (s) => {
      if (!s.replication.enabled || !s.replication.connected)
        return { ok: false, reading: 'pg_stat_replication is empty — the walsender is gone, which is worse than lag, not better' }
      return {
        ok: s.replication.lagSec <= 2,
        reading: `model replay delay ${s.replication.lagSec.toFixed(2)} s · current byte backlog ${fmtBytes(s.replication.lagBytes)}`,
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
    evidence: (s) => [
      { label: 'primary − sent', value: fmtBytes(s.wal.writeLsn - s.replication.sentLsn), tone: 'crit' },
      { label: 'one-way delay', value: `${s.replication.networkLagMs} ms`, tone: 'warn' },
      { label: 'records in flight', value: String(s.replication.inFlight) },
    ],
    fix: 'Inspect the walsender and link together. Fix sender scheduling or WAL-read constraints when they are responsible; fix link throughput or congestion when the transport is responsible. Use byte-rate evidence rather than latency alone.',
    knobs: [KB.replicaNetworkLag],
    confirm: {
      projection: 'replication',
      instrument: 'pg_stat_replication',
      sql: `SELECT application_name, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       write_lag, flush_lag, replay_lag
  FROM pg_stat_replication;`,
    },
    resolved: (s) => {
      if (!s.replication.enabled || !s.replication.connected)
        return { ok: false, reading: 'pg_stat_replication is empty — no walsender is connected at all' }
      const behind = s.wal.writeLsn - s.replication.sentLsn
      return {
        ok: behind < 256 * 1024,
        reading: `primary − sent_lsn is ${fmtBytes(Math.max(0, behind))} at ${s.replication.networkLagMs} ms one way`,
      }
    },
    city: 'net.wire',
    reading: [DOC('warm-standby.html', 'Log-Shipping Standby Servers')],
  },
  {
    id: 'v.rep_ok',
    kind: 'verdict',
    title: 'The standby is current.',
    because: 'All four modeled positions are within a few kilobytes of the primary and the current modeled replay delay is small.',
    mechanism:
      'This is what healthy looks like, and it is worth knowing precisely, because the failure mode is silent. Nothing errors when a replica falls behind: it keeps answering queries, with older data.',
    evidence: (s) => [
      { label: 'primary − replay', value: fmtBytes(s.replication.lagBytes), tone: 'ok' },
      { label: 'model replay delay', value: `${s.replication.lagSec.toFixed(2)} s`, tone: 'ok' },
      { label: 'sync_state', value: s.replication.mode === 'sync' ? 'sync' : 'async' },
    ],
    fix:
      'Set up the alert while it is healthy. Check pg_replication_slots for ownership, restart_lsn, wal_status and safe_wal_size; inactive permanent slots retain WAL by default, while configured timeout or max_slot_wal_keep_size can invalidate them.',
    knobs: [KB.replicaSlowApply],
    city: 'walsender',
    reading: [DOC('warm-standby.html', 'Log-Shipping Standby Servers')],
  },
  {
    id: 'v.saturation',
    kind: 'verdict',
    title: 'You are out of connections, not out of capacity.',
    because:
      'Every slot is busy and running, nothing is waiting on a lock or on I/O, and throughput has flattened while latency keeps climbing. New work is queuing outside the database.',
    mechanism:
      'Postgres is not threaded: the postmaster forks an entire OS process per connection, each with its own memory and its own entry in the shared ProcArray. Taking a snapshot means scanning that array, so every additional connection makes every transaction in the system slightly slower — including the ones that were already fast. The cost is superlinear and it is invisible in any single query\'s timing.',
    evidence: (s) => [
      { label: 'backends', value: `${s.stats.activeBackends} of ${s.maxConnections}`, tone: 'crit' },
      { label: 'achieved tps', value: s.stats.tps.toFixed(0) },
      { label: 'offered tps', value: String(Math.round(s.knobs.tps)), tone: 'warn' },
    ],
    fix:
      'Put a pooler in front of it — PgBouncer in transaction mode, a few hundred client connections mapped onto a few dozen server connections. As a rule of thumb max_connections should be a small multiple of your core count, not a number chosen to stop your application throwing errors.',
    knobs: [KB.tps],
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
      ok: s.stats.activeBackends < s.maxConnections - 1,
      reading: `${s.stats.activeBackends} of ${s.maxConnections} connection slots in use, achieving ${s.stats.tps.toFixed(0)} tps against ${Math.round(s.knobs.tps)} offered`,
    }),
    city: 'postmaster',
    reading: [DOC('runtime-config-connection.html', 'Connection settings')],
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
      'Watch them release together: one fsync satisfies every backend queued behind it. That is group commit, and it is why throughput does not collapse under a high commit rate even though every commit waits. What you are paying is latency per transaction, not bandwidth.',
    evidence: (s) => [
      { label: 'synchronous_commit', value: s.knobs.synchronousCommit },
      { label: 'waiting to commit', value: String(waits(s).commit), tone: 'warn' },
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
    resolved: (s) => ({
      ok: waits(s).commit === 0,
      reading: `synchronous_commit = ${s.knobs.synchronousCommit} · ${waits(s).commit} backend${waits(s).commit === 1 ? '' : 's'} waiting on the flush, insert − flush ${fmtBytes(Math.max(0, s.wal.insertLsn - s.wal.flushLsn))}`,
    }),
    city: 'walwriter',
    reading: [DOC('runtime-config-wal.html', 'Write Ahead Log settings')],
  },
  {
    id: 'v.sync_remote',
    kind: 'verdict',
    title: 'Every commit is waiting for a standby to answer.',
    because:
      'The wait is `IPC / SyncRep`, not `IO / WalSync`. These backends are not waiting for a disk — they are waiting for a network round trip, the standby\'s fsync, and at remote_apply the standby\'s replay as well.',
    mechanism:
      'This is the one everybody gets wrong in the other direction: synchronous_commit = on guarantees a **local** flush only. If the primary\'s disk survives but the machine does not, the standby may never have seen that commit. Synchronous replication requires synchronous_standby_names, and once you have it, every commit costs a full round trip.',
    evidence: (s) => [
      { label: 'synchronous_commit', value: s.knobs.synchronousCommit, tone: 'warn' },
      { label: 'waiting to commit', value: String(waits(s).commit), tone: 'warn' },
      { label: 'one-way delay', value: `${s.replication.networkLagMs} ms` },
      { label: 'model replay delay', value: `${s.replication.lagSec.toFixed(2)} s` },
    ],
    fix:
      'Confirm you meant to buy this. At remote_apply, measure commit latency and the standby’s apply path directly. PostgreSQL replay_lag estimates recent commit-delay impact; it is not a current staleness or catch-up timer. If remote durability is not required, `local` gives local durability without the round trip.',
    knobs: [KB.synchronousCommit, KB.replicaNetworkLag],
    confirm: {
      projection: 'wal_lsn',
      instrument: 'pg_current_wal_lsn',
      sql: `SELECT pg_current_wal_insert_lsn(), pg_current_wal_lsn(), pg_current_wal_flush_lsn();`,
    },
    resolved: (s) => ({
      ok: waits(s).commit === 0,
      reading: `synchronous_commit = ${s.knobs.synchronousCommit} at ${s.replication.networkLagMs} ms one way · ${waits(s).commit} backend${waits(s).commit === 1 ? '' : 's'} still waiting for the standby`,
    }),
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
      'Try switching synchronous_commit to remote_apply and watch the commit_wait queue appear — it is the cheapest way to feel what durability costs.',
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
    evidence: (s, c) => [
      { label: 'tps', value: s.stats.tps.toFixed(0), tone: 'ok' },
      { label: 'cache hit', value: `${s.stats.cacheHitPct.toFixed(1)}%`, tone: 'ok' },
      { label: 'requested checkpoints', value: `${(forcedShare(c) * 100).toFixed(0)}%`, tone: 'ok' },
      { label: 'model replay delay', value: `${s.replication.lagSec.toFixed(2)} s`, tone: 'ok' },
    ],
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
