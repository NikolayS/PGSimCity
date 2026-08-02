/* ============================================================================
 * LIVE VIEW PROJECTIONS
 *
 * Each function here renders one PostgreSQL statistics view *from the running
 * model*. The column names are the real ones; the numbers are the model's.
 *
 * Two rules, both absolute:
 *  1. A column appears only if the model genuinely produces it. Nothing is
 *     padded with a plausible-looking figure to make a table look complete.
 *     The gaps are listed in catalog.ts and shown to the reader.
 *  2. Enum-valued columns (state, wait_event_type, wait_event, phase, locktype,
 *     mode, object, context, backend_type) only ever emit values that exist in
 *     PostgreSQL 18. They were checked against the manual one at a time.
 * ==========================================================================*/

import { PG_PAGE_BYTES, poolBytes, poolPages } from '../core/types'
import type { BackendSim, PhysicalStandbyState, SimState, TableSim, VacPhase } from '../core/types'
import { configuredSynchronousStandby } from '../core/replication'
import { CLAIM_VALUES } from '../core/claims'
import { N_TABLES } from '../world/layout'
import { fmtBytes, fmtLsn, fmtNum } from '../core/util'
import type { Collector } from './collector'
import { PID } from './collector'

const DIAGNOSTIC_GATES = CLAIM_VALUES.diagnoseBranchGates

export type Tone = '' | 'ok' | 'warn' | 'crit' | 'accent' | 'dim'
export type Mode = 'total' | 'rate'

export interface Col {
  key: string
  label: string
  /** right-align */
  num?: boolean
}

export interface Cell {
  v: string
  tone?: Tone
}

export interface Row {
  key: string
  cells: Record<string, Cell | string>
  tone?: Tone
  /** a small leading marker, e.g. '▸' for the row the step is about */
  mark?: boolean
}

export interface Projection {
  cols: Col[]
  rows: Row[]
  caption?: string
  empty?: string
}

export type ProjectionFn = (s: SimState, c: Collector, mode: Mode) => Projection

export type ProjectionSource =
  | 'activity.rows'
  | 'activity.xmin_rows'
  | 'database.counters'
  | 'tables.rows'
  | 'bgwriter.counters'
  | 'checkpointer.counters'
  | 'wal.counters'
  | 'wal.positions'
  | 'io.rows'
  | 'buffercache.rows'
  | 'replication.standbys'
  | 'vacuum.progress_rows'
  | 'locks.rows'
  | 'settings.rows'
  | 'slots.rows'

const NULLC: Cell = { v: 'null', tone: 'dim' }

const n = (v: number, digits = 0): Cell => ({ v: fmtNum(v, digits) })
/** A counter cell: raw total, or a per-second rate when the reader asks. */
const ctr = (totalV: number, rateV: number, mode: Mode): Cell =>
  mode === 'rate' ? { v: `${fmtNum(rateV, rateV < 10 ? 1 : 0)}/s`, tone: 'dim' } : { v: fmtNum(totalV) }

/**
 * A hand-computed ratio, rendered honestly.
 *
 * Zero over zero is undefined, not zero. This matters most at exactly the
 * moment the reader cares most: they have just applied a fix and run
 * pg_stat_reset(), so every counter is empty. Printing "0%" in healthy green
 * there is the page inventing a reading — and inventing a *reassuring* one,
 * which is worse. Until there is something to divide, say so.
 */
const ratio = (
  part: number,
  whole: number,
  tone: (r: number) => Tone,
  digits = 0,
): Cell =>
  whole > 0
    ? { v: `${((part / whole) * 100).toFixed(digits)}%`, tone: tone(part / whole) }
    : { v: '—', tone: 'dim' }

const age = (sec: number): string => {
  if (sec < 0) return '—'
  if (sec < 60) return `00:00:${sec.toFixed(0).padStart(2, '0')}`
  const m = Math.floor(sec / 60)
  const ss = Math.floor(sec % 60)
  if (m < 60) return `00:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  const h = Math.floor(m / 60)
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/* ---------------------------------------------------------------------------
 * pg_stat_activity
 * -------------------------------------------------------------------------*/

type ActivityWaitBucket = 'lock' | 'io' | 'commit' | 'idleTx' | 'cpu' | 'idle'

interface ActRow {
  pid: number
  backendType: string
  state: string
  wet: string
  we: string
  xactAge: number
  xid: string
  xmin: string
  query: string
  tone: Tone
  bucket?: ActivityWaitBucket
}

/**
 * The model's backend state machine mapped onto what pg_stat_activity would
 * actually report. Every (wait_event_type, wait_event) pair below is in the
 * manual: IO/DataFileRead, IO/WalSync, IPC/SyncRep, Lock/relation,
 * Timeout/VacuumDelay, Client/ClientRead, Client/ClientWrite, and the Activity
 * events the auxiliary processes park in.
 *
 * On the spelling of WalSync: PostgreSQL 17 began generating the wait event
 * names from a table (wait_event_names.txt) and normalised the capitalisation
 * while doing it, so this event is `WALSync` on 16 and older and `WalSync` from
 * 17 on. It is exactly the kind of name that gets copied out of an old blog
 * post into a monitoring query that then silently matches nothing.
 */
function actOf(
  b: BackendSim,
  s: SimState,
): { state: string; wet: string; we: string; tone: Tone; bucket: ActivityWaitBucket } {
  const syncStandby = configuredSynchronousStandby(s)
  const syncRep =
    syncStandby?.mode === 'sync'
    && s.knobs.synchronousStandbyNames !== 'none'
    && (s.knobs.synchronousCommit === 'remote_write'
      || s.knobs.synchronousCommit === 'on'
      || s.knobs.synchronousCommit === 'remote_apply')
  switch (b.state) {
    case 'idle':
      return { state: 'idle', wet: 'Client', we: 'ClientRead', tone: 'dim', bucket: 'idle' }
    case 'ending':
      return { state: 'idle', wet: 'Client', we: 'ClientRead', tone: 'dim', bucket: 'idle' }
    case 'idle_in_xact':
      return { state: 'idle in transaction', wet: 'Client', we: 'ClientRead', tone: 'warn', bucket: 'idleTx' }
    case 'exec_io':
      return { state: 'active', wet: 'IO', we: 'DataFileRead', tone: 'accent', bucket: 'io' }
    case 'eviction_flush':
      return { state: 'active', wet: 'IO', we: 'WalSync', tone: 'accent', bucket: 'io' }
    case 'commit_wait':
      return syncRep
        ? { state: 'active', wet: 'IPC', we: 'SyncRep', tone: 'accent', bucket: 'commit' }
        : { state: 'active', wet: 'IO', we: 'WalSync', tone: 'accent', bucket: 'commit' }
    case 'blocked':
      return { state: 'active', wet: 'Lock', we: 'relation', tone: 'crit', bucket: 'lock' }
    case 'sending':
      return { state: 'active', wet: 'Client', we: 'ClientWrite', tone: '', bucket: 'cpu' }
    default:
      // parse, plan, exec_cpu, sort, wal_insert, starting — on CPU, not waiting.
      return { state: 'active', wet: '', we: '', tone: '', bucket: 'cpu' }
  }
}

function activityRows(s: SimState, c: Collector, opts: { aux: boolean }): ActRow[] {
  const out: ActRow[] = []

  /* The held snapshot. The model tracks one global xmin horizon rather than a
   * per-session backend_xmin; when a snapshot is being held open, this row is
   * that snapshot rendered as the session holding it. Age and xmin are real. */
  if (s.knobs.longRunningXact) {
    out.push({
      pid: PID.oldSnapshot,
      backendType: 'client backend',
      state: 'idle in transaction',
      wet: 'Client',
      we: 'ClientRead',
      xactAge: s.oldestSnapshotAge,
      xid: String(s.xminHorizon),
      xmin: String(s.xminHorizon),
      query: 'BEGIN ISOLATION LEVEL REPEATABLE READ;',
      tone: 'crit',
      bucket: 'idleTx',
    })
  }

  for (const b of s.backends) {
    if (!b.active || b.state === 'free') continue
    const a = actOf(b, s)
    const inXact = c.xactStart[b.slot] >= 0
    out.push({
      pid: PID.backend(b.slot),
      backendType: 'client backend',
      state: a.state,
      wet: a.wet,
      we: a.we,
      xactAge: inXact ? s.t - c.xactStart[b.slot] : -1,
      xid: b.xid > 0 ? String(b.xid) : '',
      xmin: inXact ? String(s.xminHorizon) : '',
      query: b.sql || 'SELECT 1',
      tone: a.tone,
      bucket: a.bucket,
    })
  }

  if (!opts.aux) return out

  const ck = s.checkpoint
  out.push({
    pid: PID.checkpointer,
    backendType: 'checkpointer',
    state: '',
    wet: 'Activity',
    we: 'CheckpointerMain',
    xactAge: -1,
    xid: '',
    xmin: '',
    query: '',
    tone: ck.phase === 'idle' ? 'dim' : 'accent',
  })
  out.push({
    pid: PID.bgwriter,
    backendType: 'background writer',
    state: '',
    wet: 'Activity',
    we: s.bgwriter.activity > 0.05 ? 'BgwriterMain' : 'BgwriterHibernate',
    xactAge: -1,
    xid: '',
    xmin: '',
    query: '',
    tone: 'dim',
  })
  out.push({
    pid: PID.walwriter,
    backendType: 'walwriter',
    state: '',
    wet: 'Activity',
    we: 'WalWriterMain',
    xactAge: -1,
    xid: '',
    xmin: '',
    query: '',
    tone: 'dim',
  })
  out.push({
    pid: PID.avLauncher,
    backendType: 'autovacuum launcher',
    state: '',
    wet: 'Activity',
    we: 'AutovacuumMain',
    xactAge: -1,
    xid: '',
    xmin: '',
    query: '',
    tone: 'dim',
  })
  for (const w of s.autovac.workers) {
    if (!w.active) continue
    out.push({
      pid: PID.avWorker(w.slot),
      backendType: 'autovacuum worker',
      state: 'active',
      wet: w.vacuumDelay ? 'Timeout' : '',
      we: w.vacuumDelay ? 'VacuumDelay' : '',
      xactAge: -1,
      xid: '',
      xmin: String(s.xminHorizon),
      query: `autovacuum: VACUUM public.${s.tables[w.table].def.name}`,
      tone: w.vacuumDelay ? 'warn' : 'accent',
    })
  }
  for (let i = 0; i < s.replication.standbys.length; i++) {
    const standby = s.replication.standbys[i]
    if (!standby.enabled || !standby.connected) continue
    out.push({
      pid: PID.walsender + i,
      backendType: 'walsender',
      state: 'active',
      wet: 'Activity',
      we: 'WalSenderMain',
      xactAge: -1,
      xid: '',
      xmin: '',
      query: `START_REPLICATION SLOT "${s.replication.physicalSlots[i].name}" PHYSICAL ${fmtLsn(standby.sentLsn)} TIMELINE 1`,
      tone: 'dim',
    })
  }
  return out
}

export interface ActivityWaitCounts {
  total: number
  lock: number
  io: number
  commit: number
  walSync: number
  idleTx: number
  cpu: number
  idle: number
}

/** The exact client rows projected by activity_agg, reduced into path buckets. */
export function activityWaitCounts(s: SimState, c: Collector): ActivityWaitCounts {
  const counts: ActivityWaitCounts = {
    total: 0,
    lock: 0,
    io: 0,
    commit: 0,
    walSync: 0,
    idleTx: 0,
    cpu: 0,
    idle: 0,
  }
  for (const row of activityRows(s, c, { aux: false })) {
    counts.total++
    counts[row.bucket ?? 'cpu']++
    if (row.wet === 'IO' && row.we === 'WalSync') counts.walSync++
  }
  return counts
}

const activity: ProjectionFn = (s, c) => {
  /* Sorted by pid because the query printed above this table says ORDER BY pid.
   * The rows a page shows have to be the rows its own query would return, or
   * every other promise on the page is worth less. */
  const rows = activityRows(s, c, { aux: true })
    .sort((a, b) => a.pid - b.pid)
    .map<Row>((r) => ({
      key: String(r.pid),
      tone: r.tone,
      cells: {
        pid: String(r.pid),
        backend_type: { v: r.backendType, tone: r.backendType === 'client backend' ? '' : 'dim' },
        state: r.state ? { v: r.state, tone: r.tone } : NULLC,
        wait_event_type: r.wet ? { v: r.wet, tone: r.tone } : NULLC,
        wait_event: r.we ? { v: r.we, tone: r.tone } : NULLC,
        xact_age: r.xactAge >= 0 ? age(r.xactAge) : NULLC,
        query: r.query ? r.query : NULLC,
      },
    }))
  return {
    cols: [
      { key: 'pid', label: 'pid', num: true },
      { key: 'backend_type', label: 'backend_type' },
      { key: 'state', label: 'state' },
      { key: 'wait_event_type', label: 'wait_event_type' },
      { key: 'wait_event', label: 'wait_event' },
      { key: 'xact_age', label: 'xact_age' },
      { key: 'query', label: 'query' },
    ],
    rows,
    caption:
      'Background processes report state = null and query = null; only client backends and autovacuum workers carry a statement. Cost-throttled workers expose Timeout / VacuumDelay while sleeping. xact_age here stands in for now() − xact_start.',
  }
}

/** The GROUP BY that starts almost every real investigation. */
const activityAgg: ProjectionFn = (s, c) => {
  const rows = activityRows(s, c, { aux: false })
  const buckets = new Map<string, { state: string; wet: string; we: string; n: number; tone: Tone }>()
  for (const r of rows) {
    const k = `${r.state}|${r.wet}|${r.we}`
    const hit = buckets.get(k)
    if (hit) hit.n++
    else buckets.set(k, { state: r.state, wet: r.wet, we: r.we, n: 1, tone: r.tone })
  }
  const list = [...buckets.values()].sort((a, b) => b.n - a.n)
  const total = rows.length || 1
  return {
    cols: [
      { key: 'state', label: 'state' },
      { key: 'wait_event_type', label: 'wait_event_type' },
      { key: 'wait_event', label: 'wait_event' },
      { key: 'count', label: 'count', num: true },
      { key: 'share', label: 'share', num: true },
    ],
    rows: list.map<Row>((b) => ({
      key: `${b.state}|${b.wet}|${b.we}`,
      tone: b.tone,
      cells: {
        state: { v: b.state, tone: b.tone },
        wait_event_type: b.wet ? { v: b.wet, tone: b.tone } : NULLC,
        wait_event: b.we ? { v: b.we, tone: b.tone } : NULLC,
        count: String(b.n),
        share: `${((b.n / total) * 100).toFixed(0)}%`,
      },
    })),
    empty: 'No client backends are connected. Raise the transaction rate to give the server something to do.',
    caption:
      'Active with wait_event_type = null means the backend is not currently reporting an instrumented wait. It often suggests CPU or runnable work, but is not a CPU-running bit; the process may be pre-empted or doing uninstrumented work. State and wait columns are independent, and idle states are not queues.',
  }
}

/** pg_stat_activity as you read it when you are hunting the xmin horizon. */
const activityXmin: ProjectionFn = (s, c) => {
  const rows = activityRows(s, c, { aux: false })
    .filter((r) => r.xmin !== '')
    .sort((a, b) => b.xactAge - a.xactAge)
  return {
    cols: [
      { key: 'pid', label: 'pid', num: true },
      { key: 'state', label: 'state' },
      { key: 'backend_xid', label: 'backend_xid', num: true },
      { key: 'backend_xmin', label: 'backend_xmin', num: true },
      { key: 'xact_age', label: 'xact_age', num: true },
      { key: 'query', label: 'query' },
    ],
    rows: rows.map<Row>((r) => ({
      key: String(r.pid),
      tone: r.tone,
      mark: r.pid === PID.oldSnapshot,
      cells: {
        pid: String(r.pid),
        state: { v: r.state, tone: r.tone },
        backend_xid: r.xid ? r.xid : NULLC,
        backend_xmin: { v: r.xmin, tone: r.tone },
        xact_age: r.xactAge >= 0 ? { v: age(r.xactAge), tone: r.tone } : NULLC,
        query: r.query,
      },
    })),
    empty: 'No session is currently holding a snapshot.',
    caption: s.knobs.longRunningXact
      ? '▸ marks the abandoned session. Now look down the backend_xmin column: every session reports the same value. That is not a rendering shortcut — a snapshot\'s xmin is the oldest transaction still running when it was taken, so while that one session stays open, every snapshot taken after it is clamped to the same horizon. One idle session, and the entire cluster stops being able to clean anything up. (The model keeps a single global horizon rather than per-session state, so the marked row is that held snapshot drawn as the session holding it; its age and its xmin are real model values.)'
      : 'A read-only transaction takes no xid — backend_xid is null — but it still holds a snapshot, and the snapshot is what stops cleanup. Every session reports the same backend_xmin because nothing old is currently open.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_stat_database
 * -------------------------------------------------------------------------*/

const database: ProjectionFn = (s, c, mode) => {
  const t = c.total
  const r = c.rate
  return {
    cols: [
      { key: 'datname', label: 'datname' },
      { key: 'numbackends', label: 'numbackends', num: true },
      { key: 'xact_commit', label: 'xact_commit', num: true },
      { key: 'xact_rollback', label: 'xact_rollback', num: true },
      { key: 'blks_hit', label: 'blks_hit', num: true },
      { key: 'blks_read', label: 'blks_read', num: true },
      { key: 'hit_ratio', label: 'hit %', num: true },
      { key: 'tup_returned', label: 'tup_returned', num: true },
      { key: 'tup_inserted', label: 'tup_inserted', num: true },
      { key: 'tup_updated', label: 'tup_updated', num: true },
      { key: 'tup_deleted', label: 'tup_deleted', num: true },
    ],
    rows: [
      {
        key: 'pgsimcity',
        cells: {
          datname: 'pgsimcity',
          numbackends: String(s.stats.activeBackends),
          xact_commit: ctr(t.xactCommit, r.xactCommit, mode),
          xact_rollback: ctr(t.xactRollback, r.xactRollback, mode),
          blks_hit: ctr(t.blksHit, r.blksHit, mode),
          blks_read: ctr(t.blksRead, r.blksRead, mode),
          hit_ratio: ratio(t.blksHit, t.blksHit + t.blksRead, (x) => (x < 0.9 ? 'warn' : 'ok'), 1),
          tup_returned: ctr(t.tupReturned, r.tupReturned, mode),
          tup_inserted: ctr(t.tupInserted, r.tupInserted, mode),
          tup_updated: ctr(t.tupUpdated, r.tupUpdated, mode),
          tup_deleted: ctr(t.tupDeleted, r.tupDeleted, mode),
        },
      },
    ],
    caption:
      'hit % is not a column — it is blks_hit / (blks_hit + blks_read), computed by hand, and it is the reason blks_read alone tells you nothing. Everything here is cumulative since stats_reset, so a hand-computed ratio reads "—" until there is something to divide.',
  }
}

/** blks_hit / (blks_hit + blks_read), as rendered by database and read by Diagnose. */
export function collectorCacheHitPercent(c: Collector): number {
  const seen = c.total.blksHit + c.total.blksRead
  return seen > 0 ? (c.total.blksHit / seen) * 100 : 0
}

/* ---------------------------------------------------------------------------
 * pg_stat_all_tables
 * -------------------------------------------------------------------------*/

export function tableDeadRatio(table: TableSim): number {
  const tuples = table.liveTuples + table.deadTuples
  return tuples > 0 ? table.deadTuples / tuples : 0
}

const tables: ProjectionFn = (s) => ({
  cols: [
    { key: 'relname', label: 'relname' },
    { key: 'seq_scan', label: 'seq_scan', num: true },
    { key: 'idx_scan', label: 'idx_scan', num: true },
    { key: 'n_tup_ins', label: 'n_tup_ins', num: true },
    { key: 'n_tup_upd', label: 'n_tup_upd', num: true },
    { key: 'n_tup_hot_upd', label: 'n_tup_hot_upd', num: true },
    { key: 'n_tup_del', label: 'n_tup_del', num: true },
    { key: 'n_live_tup', label: 'n_live_tup', num: true },
    { key: 'n_dead_tup', label: 'n_dead_tup', num: true },
    { key: 'dead_pct', label: 'dead %', num: true },
    { key: 'last_autovacuum', label: 'last_autovacuum' },
  ],
  rows: [...s.tables]
    .sort((a, b) => b.deadTuples - a.deadTuples)
    .map<Row>((t) => {
      const dead = tableDeadRatio(t)
      return {
        key: t.def.id,
        tone: dead > 0.25 ? 'crit' : dead >= DIAGNOSTIC_GATES.deadTupleRatio.threshold ? 'warn' : '',
        cells: {
          relname: t.def.name,
          seq_scan: n(t.seqScans),
          idx_scan: n(t.idxScans),
          n_tup_ins: n(t.inserts),
          n_tup_upd: n(t.updates),
          n_tup_hot_upd: n(t.hotUpdates),
          n_tup_del: n(t.deletes),
          n_live_tup: n(t.liveTuples),
          n_dead_tup: { v: fmtNum(t.deadTuples), tone: dead > 0.25 ? 'crit' : dead >= DIAGNOSTIC_GATES.deadTupleRatio.threshold ? 'warn' : '' },
          dead_pct: { v: `${(dead * 100).toFixed(1)}%`, tone: dead > 0.25 ? 'crit' : dead >= DIAGNOSTIC_GATES.deadTupleRatio.threshold ? 'warn' : '' },
          last_autovacuum:
            t.lastVacuum > 0 ? `${age(s.t - t.lastVacuum)} ago` : NULLC,
        },
      }
    }),
  caption:
    'dead % is a model-derived pressure ratio, not a PostgreSQL column or a physical-bloat measurement. On a real server n_live_tup and n_dead_tup are estimates. HOT versus non-HOT updates describes whether index entries were added; neither outcome proves whether cleanup keeps up. Confirm physical growth with heap/index/TOAST size trends and, when justified, page inspection. These model counters are cumulative since boot.',
})

/* ---------------------------------------------------------------------------
 * pg_stat_bgwriter / pg_stat_checkpointer
 * -------------------------------------------------------------------------*/

const bgwriter: ProjectionFn = (s, c, mode) => ({
  cols: [
    { key: 'buffers_clean', label: 'buffers_clean', num: true },
    { key: 'buffers_alloc', label: 'buffers_alloc', num: true },
    { key: 'stats_reset', label: 'stats_reset' },
  ],
  rows: [
    {
      key: 'bgw',
      cells: {
        buffers_clean: NULLC,
        buffers_alloc: ctr(c.total.buffersAlloc, c.rate.buffersAlloc, mode),
        stats_reset: { v: c.resetStamp, tone: 'dim' },
      },
    },
  ],
  caption: s.knobs.bgwriterEnabled
    ? 'buffers_alloc is a full-stream page count. buffers_clean is blank because the city counts cleaning only inside its representative frame sample; presenting that sample counter as a PostgreSQL page count would mix scales in one row.'
    : 'bgwriter_lru_maxpages is effectively zero. buffers_clean remains blank because the city has a representative-sample counter, not the full-stream PostgreSQL page count.',
})

export function checkpointRequestedShare(c: Collector): number {
  const done = c.total.ckptTimed + c.total.ckptRequested
  return done > 0 ? c.total.ckptRequested / done : 0
}

const checkpointer: ProjectionFn = (s, c, mode) => {
  const t = c.total
  const done = t.ckptTimed + t.ckptRequested
  const requested = checkpointRequestedShare(c)
  const tone: Tone = done === 0 ? 'dim' : requested > 0.5 ? 'crit' : requested > DIAGNOSTIC_GATES.requestedCheckpointShare.threshold ? 'warn' : 'ok'
  return {
    cols: [
      { key: 'num_timed', label: 'num_timed', num: true },
      { key: 'num_requested', label: 'num_requested', num: true },
      { key: 'forced', label: 'requested %', num: true },
      { key: 'buffers_written', label: 'buffers_written', num: true },
      { key: 'write_time', label: 'write_time (ms)', num: true },
      { key: 'phase', label: 'phase (model)' },
    ],
    rows: [
      {
        key: 'ckpt',
        tone,
        cells: {
          num_timed: ctr(t.ckptTimed, c.rate.ckptTimed, mode),
          num_requested: { v: mode === 'rate' ? `${c.rate.ckptRequested.toFixed(2)}/s` : fmtNum(t.ckptRequested), tone },
          forced: ratio(t.ckptRequested, done, (x) => (x > 0.5 ? 'crit' : x > DIAGNOSTIC_GATES.requestedCheckpointShare.threshold ? 'warn' : 'ok')),
          buffers_written: NULLC,
          write_time: n(t.ckptWriteMs),
          phase: {
            v: s.checkpoint.phase === 'idle' ? `idle · next in ${s.checkpoint.nextInSec.toFixed(0)}s` : s.checkpoint.phase,
            tone: s.checkpoint.phase === 'idle' ? 'dim' : 'accent',
          },
        },
      },
    ],
    caption:
      done === 0
        ? `No checkpoint has completed since the counters were reset ${fmtNum(c.total.elapsed)} s ago, so requested % has nothing to divide and reads "—". The model phase on the right can still be moving.`
        : 'requested % is num_requested / (num_timed + num_requested), computed by hand. PostgreSQL num_requested combines multiple request sources; this ratio does not prove max_wal_size pressure. Correlate checkpoint messages, WAL volume, maintenance and backups. buffers_written is blank because model writes are sample-scale; the last column is model-only.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_stat_wal, and the WAL position functions
 * -------------------------------------------------------------------------*/

const wal: ProjectionFn = (s, c, mode) => {
  const t = c.total
  return {
    cols: [
      { key: 'wal_records', label: 'wal_records', num: true },
      { key: 'wal_fpi', label: 'wal_fpi', num: true },
      { key: 'wal_bytes', label: 'wal_bytes', num: true },
      { key: 'rate', label: 'bytes/sec now', num: true },
    ],
    rows: [
      {
        key: 'wal',
        cells: {
          wal_records: ctr(t.walRecords, c.rate.walRecords, mode),
          wal_fpi: { v: mode === 'rate' ? `${fmtNum(c.rate.walFpi, 1)}/s` : fmtNum(t.walFpi) },
          wal_bytes: { v: fmtBytes(mode === 'rate' ? c.rate.walBytes : t.walBytes) + (mode === 'rate' ? '/s' : '') },
          rate: { v: `${fmtBytes(s.wal.bytesPerSec)}/s` },
        },
      },
    ],
    caption:
      'bytes/sec now is model-only. wal_bytes is the model LSN advance; wal_records and wal_fpi are shaped model counts. PostgreSQL wal_fpi is a count, not bytes: page holes, wal_compression and build-time BLCKSZ mean it cannot be converted into an FPI share of wal_bytes.',
  }
}

const walLsn: ProjectionFn = (s) => {
  const behind = s.wal.insertLsn - s.wal.flushLsn
  return {
    cols: [
      { key: 'fn', label: 'function' },
      { key: 'lsn', label: 'pg_lsn' },
      { key: 'what', label: 'what it means' },
    ],
    rows: [
      {
        key: 'insert',
        cells: {
          fn: 'pg_current_wal_insert_lsn()',
          lsn: { v: fmtLsn(s.wal.insertLsn), tone: 'accent' },
          what: 'reserved in wal_buffers — may not exist on disk yet',
        },
      },
      {
        key: 'write',
        cells: {
          fn: 'pg_current_wal_lsn()',
          lsn: { v: fmtLsn(s.wal.writeLsn), tone: 'accent' },
          what: 'handed to the OS. This is the one every lag query uses.',
        },
      },
      {
        key: 'flush',
        cells: {
          fn: 'pg_current_wal_flush_lsn()',
          lsn: { v: fmtLsn(s.wal.flushLsn), tone: 'accent' },
          what: 'fsynced. A commit is durable at this point and not before.',
        },
      },
      {
        key: 'diff',
        tone: behind > 1024 * 1024 ? 'warn' : '',
        cells: {
          fn: 'pg_wal_lsn_diff(insert, flush)',
          lsn: { v: fmtBytes(behind), tone: behind > 1024 * 1024 ? 'warn' : 'dim' },
          what: 'WAL written but not yet durable — what a commit is waiting for',
        },
      },
      {
        key: 'file',
        cells: {
          fn: 'pg_walfile_name(pg_current_wal_lsn())',
          lsn: { v: s.wal.segments.find((sg) => sg.state === 'current')?.name ?? '—', tone: 'dim' },
          what: 'the segment file currently being written',
        },
      },
    ],
    caption:
      'Three positions, not one. Insert ≥ write ≥ flush always, and the gap between insert and flush is exactly what synchronous_commit decides whether to wait for.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_stat_io — who is doing the I/O
 * -------------------------------------------------------------------------*/

export function clientBackendWriteShare(c: Collector): number {
  const totalWrites = c.total.backendWrites + c.total.ckptBuffers + c.total.bgwClean
  return totalWrites > 0 ? c.total.backendWrites / totalWrites : 0
}

const io: ProjectionFn = (s, c, mode) => {
  const t = c.total
  const totalWrites = t.backendWrites + t.ckptBuffers + t.bgwClean
  const backendShare = clientBackendWriteShare(c)
  const tone: Tone = backendShare > 0.4 ? 'crit' : backendShare > DIAGNOSTIC_GATES.clientBackendWriteShare.threshold ? 'warn' : ''
  return {
    cols: [
      { key: 'backend_type', label: 'backend_type' },
      { key: 'object', label: 'object' },
      { key: 'context', label: 'context' },
      { key: 'reads', label: 'reads', num: true },
      { key: 'hits', label: 'hits', num: true },
      { key: 'writes', label: 'writes', num: true },
      { key: 'evictions', label: 'evictions', num: true },
    ],
    rows: [
      {
        key: 'client',
        tone,
        cells: {
          backend_type: { v: 'client backend', tone: tone || 'accent' },
          object: 'relation',
          context: 'normal',
          reads: mode === 'rate' ? { v: `${fmtNum(s.stats.ioReadPerSec)}/s`, tone: 'dim' } : n(t.blksRead),
          hits: ctr(t.blksHit, c.rate.blksHit, mode),
          writes: NULLC,
          evictions: NULLC,
        },
      },
      {
        key: 'ckpt',
        cells: {
          backend_type: 'checkpointer',
          object: 'relation',
          context: 'normal',
          reads: { v: '0', tone: 'dim' },
          hits: { v: '0', tone: 'dim' },
          writes: NULLC,
          evictions: { v: '0', tone: 'dim' },
        },
      },
      {
        key: 'bgw',
        cells: {
          backend_type: 'background writer',
          object: 'relation',
          context: 'normal',
          reads: { v: '0', tone: 'dim' },
          hits: { v: '0', tone: 'dim' },
          writes: NULLC,
          evictions: { v: '0', tone: 'dim' },
        },
      },
    ],
    caption:
      totalWrites > 0
        ? `Reads and hits are full-stream page counts. Writes and evictions are blank because the model records them only in its representative sample; that sample attributes ${(backendShare * 100).toFixed(0)}% of writes to client backends, but the ratio is not a pg_stat_io counter.`
        : 'Reads and hits are full-stream page counts. Writes and evictions are blank because the model records them only in its representative sample, which cannot truthfully populate PostgreSQL page-count columns.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_buffercache
 * -------------------------------------------------------------------------*/

export function coldBufferShare(s: SimState): number {
  const buffers = s.buffers
  let used = 0
  let cold = 0
  for (let i = 0; i < buffers.sampleFrames; i++) {
    if (!buffers.valid[i]) continue
    used++
    if (buffers.usage[i] === 0) cold++
  }
  return used > 0 ? cold / used : 0
}

const buffercache: ProjectionFn = (s) => {
  const b = s.buffers
  const counts = [0, 0, 0, 0, 0, 0]
  const dirty = [0, 0, 0, 0, 0, 0]
  const pinned = [0, 0, 0, 0, 0, 0]
  let used = 0
  let usageSum = 0
  for (let i = 0; i < b.sampleFrames; i++) {
    if (!b.valid[i]) continue
    used++
    const u = Math.min(5, b.usage[i])
    counts[u]++
    usageSum += u
    if (b.dirty[i]) dirty[u]++
    if (b.pinned[i]) pinned[u]++
  }
  const coldShare = coldBufferShare(s)
  const rows: Row[] = counts.map((cnt, u) => ({
    key: `u${u}`,
    tone: u === 0 && coldShare > DIAGNOSTIC_GATES.coldBufferShare.threshold ? 'warn' : '',
    cells: {
      usage_count: String(u),
      buffers: n(cnt),
      dirty: { v: fmtNum(dirty[u]), tone: dirty[u] > 0 ? 'crit' : 'dim' },
      pinned: { v: fmtNum(pinned[u]), tone: 'dim' },
      bar: { v: bar(cnt, b.sampleFrames), tone: 'accent' },
    },
  }))
  rows.push({
    key: 'unused',
    tone: 'dim',
    cells: {
      usage_count: { v: 'unused', tone: 'dim' },
      buffers: { v: fmtNum(b.sampleFrames - used), tone: 'dim' },
      dirty: { v: '0', tone: 'dim' },
      pinned: { v: '0', tone: 'dim' },
      bar: { v: bar(b.sampleFrames - used, b.sampleFrames), tone: 'dim' },
    },
  })
  return {
    cols: [
      { key: 'usage_count', label: 'usage_count' },
      { key: 'buffers', label: 'buffers', num: true },
      { key: 'dirty', label: 'dirty', num: true },
      { key: 'pinned', label: 'pinned', num: true },
      { key: 'bar', label: '' },
    ],
    rows,
    caption: `Representative pg_buffercache_usage_counts() sample over ${fmtNum(b.sampleFrames)} sampled frames (shared_buffers = ${fmtBytes(poolBytes(s.knobs))}; ${fmtNum(poolPages(s.knobs))} real 8 KiB buffers), average usage_count ${used > 0 ? (usageSum / used).toFixed(2) : '0.00'}. These rows describe only the plaza sample, not the complete shared_buffers array. A sample where almost everything sits at usage_count 0 is being churned faster than anything can earn its place.`,
  }
}

function bar(v: number, max: number, width = 22): string {
  const k = max > 0 ? Math.round((v / max) * width) : 0
  return '█'.repeat(Math.max(0, Math.min(width, k)))
}

/* ---------------------------------------------------------------------------
 * pg_stat_replication
 * -------------------------------------------------------------------------*/

export function replicationRows(state: SimState): PhysicalStandbyState[] {
  return state.replication.standbys.filter((standby) => standby.enabled && standby.connected)
}

const replication: ProjectionFn = (s) => {
  const standbys = replicationRows(s)
  if (standbys.length === 0) {
    return {
      cols: [{ key: 'x', label: 'pg_stat_replication' }],
      rows: [],
      empty:
        'No walsender is connected. An empty pg_stat_replication on a primary you believe has a standby is itself the alert — it means the standby is gone, not that lag is zero.',
    }
  }
  const primary = s.wal.writeLsn
  const gap = (l: number) => primary - l
  const cell = (l: number, warnAt: number) => {
    const g = gap(l)
    return { v: fmtLsn(l), tone: (g > warnAt * 4 ? 'crit' : g > warnAt ? 'warn' : 'ok') as Tone }
  }
  const rows: Row[] = []
  for (const standby of standbys) {
    rows.push({
      key: standby.nodeId,
      tone: standby.lagSec > 8 ? 'crit' : standby.lagSec > DIAGNOSTIC_GATES.healthyReplaySeconds.threshold ? 'warn' : '',
      cells: {
        application_name: standby.applicationName,
        state: { v: standby.walSender, tone: standby.walSender === 'streaming' ? 'ok' : 'warn' },
        sent_lsn: cell(standby.sentLsn, DIAGNOSTIC_GATES.senderStageGapBytes.threshold),
        write_lsn: cell(standby.writtenLsn, DIAGNOSTIC_GATES.currentPositionGapBytes.threshold),
        flush_lsn: cell(standby.flushedLsn, DIAGNOSTIC_GATES.currentPositionGapBytes.threshold),
        replay_lsn: cell(standby.appliedLsn, DIAGNOSTIC_GATES.currentPositionGapBytes.threshold),
        behind: {
          v: fmtBytes(standby.lagBytes),
          tone: standby.lagBytes > DIAGNOSTIC_GATES.currentPositionGapBytes.threshold * 4
            ? 'crit'
            : standby.lagBytes > DIAGNOSTIC_GATES.currentPositionGapBytes.threshold ? 'warn' : 'ok',
        },
        replay_lag: NULLC,
        sync_state: {
          v: standby.mode === 'sync' ? 'sync' : 'async',
          tone: standby.mode === 'sync' ? 'accent' : 'dim',
        },
      },
    })
  }
  return {
    cols: [
      { key: 'application_name', label: 'application_name' },
      { key: 'state', label: 'state' },
      { key: 'sent_lsn', label: 'sent_lsn' },
      { key: 'write_lsn', label: 'write_lsn' },
      { key: 'flush_lsn', label: 'flush_lsn' },
      { key: 'replay_lsn', label: 'replay_lsn' },
      { key: 'behind', label: 'primary − replay', num: true },
      { key: 'replay_lag', label: 'replay_lag', num: true },
      { key: 'sync_state', label: 'sync_state' },
    ],
    rows,
    caption:
      'Each row is a separate walsender. Read sent → write → flush → replay as stage boundaries; byte gaps localise backlog but do not prove a root cause. "primary − replay" is a model-derived current byte gap. replay_lag is blank because PostgreSQL defines it as recent commit-delay impact, not current byte lag converted to seconds, and the model does not reproduce its idle-to-NULL semantics.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_stat_progress_vacuum
 * -------------------------------------------------------------------------*/

const VAC_PHASE: Partial<Record<VacPhase, string>> = {
  travel: 'initializing',
  scan_heap: 'scanning heap',
  vacuum_index: 'vacuuming indexes',
  vacuum_heap: 'vacuuming heap',
  truncate: 'truncating heap',
  return: 'performing final cleanup',
}

const progressVacuum: ProjectionFn = (s) => {
  const rows: Row[] = []
  for (const w of s.autovac.workers) {
    if (!w.active) continue
    const phase = VAC_PHASE[w.phase]
    // 'analyze' is not a VACUUM phase — on a real server that worker has moved
    // to pg_stat_progress_analyze and has left this view entirely.
    if (!phase) continue
    const t = s.tables[w.table]
    const total = t.pages
    const scanned =
      w.phase === 'scan_heap' ? Math.round(total * w.progress) : w.phase === 'travel' ? 0 : total
    const vacuumed = w.phase === 'vacuum_heap' ? Math.round(total * w.progress) : w.phase === 'truncate' || w.phase === 'return' ? total : 0
    rows.push({
      key: String(w.slot),
      tone: w.stalledByHorizon ? 'crit' : 'accent',
      mark: w.stalledByHorizon,
      cells: {
        pid: String(PID.avWorker(w.slot)),
        relname: t.def.name,
        phase: { v: phase, tone: 'accent' },
        heap_blks_total: n(total),
        heap_blks_scanned: n(scanned),
        heap_blks_vacuumed: n(vacuumed),
        indexes_total: String(t.def.indexes.length),
        removed: {
          v: fmtNum(w.deadCollected),
          tone: w.stalledByHorizon ? 'crit' : w.deadCollected > 0 ? 'ok' : 'dim',
        },
      },
    })
  }
  return {
    cols: [
      { key: 'pid', label: 'pid', num: true },
      { key: 'relname', label: 'relid → relname' },
      { key: 'phase', label: 'phase' },
      { key: 'heap_blks_total', label: 'heap_blks_total', num: true },
      { key: 'heap_blks_scanned', label: 'heap_blks_scanned', num: true },
      { key: 'heap_blks_vacuumed', label: 'heap_blks_vacuumed', num: true },
      { key: 'indexes_total', label: 'indexes_total', num: true },
      { key: 'removed', label: 'removed (model)', num: true },
    ],
    rows,
    empty: s.knobs.autovacuum
      ? 'No vacuum is running this second — which is normal for this view. The launcher wakes on autovacuum_naptime (a few seconds in this model, sixty on a stock server); leave the page open and a worker will appear. Meanwhile pg_stat_all_tables supplies estimated dead-tuple pressure and maintenance timestamps, not a monotonic physical-bloat measurement.'
      : 'Routine autovacuum is off, so this city launches no new workers and n_dead_tup climbs. Real PostgreSQL still forces anti-wraparound vacuums even with autovacuum off; the city does not yet model per-relation XID age.',
    caption:
      'phase is the real enum: initializing, scanning heap, vacuuming indexes, vacuuming heap, cleaning up indexes, truncating heap, performing final cleanup. "removed" is not a column in this view — it is the model showing you what the pass actually reclaimed, which is the number pg_stat_progress_vacuum conspicuously does not give you.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_locks + pg_blocking_pids
 * -------------------------------------------------------------------------*/

const locks: ProjectionFn = (s) => {
  const rows: Row[] = []
  const holders = new Set(s.locks.map((l) => l.holder))
  for (const slot of holders) {
    const b = s.backends[slot]
    rows.push({
      key: `h${slot}`,
      tone: 'crit',
      mark: true,
      cells: {
        pid: String(PID.backend(slot)),
        locktype: 'relation',
        relation: s.tables[b.table]?.def.name ?? '—',
        mode: 'AccessExclusiveLock',
        granted: { v: 't', tone: 'ok' },
        wait_age: NULLC,
        blocked_by: { v: '{}', tone: 'dim' },
        state: { v: 'idle in transaction', tone: 'crit' },
      },
    })
  }
  for (const l of s.locks) {
    rows.push({
      key: `w${l.waiter}`,
      tone: 'warn',
      cells: {
        pid: String(PID.backend(l.waiter)),
        locktype: 'relation',
        relation: s.tables[l.table]?.def.name ?? '—',
        mode: l.mode === 'AccessExclusiveLock' ? 'RowExclusiveLock' : l.mode,
        granted: { v: 'f', tone: 'crit' },
        wait_age: { v: age(l.ageSec), tone: l.ageSec > 5 ? 'crit' : 'warn' },
        blocked_by: { v: `{${PID.backend(l.holder)}}`, tone: 'crit' },
        state: 'active',
      },
    })
  }
  return {
    cols: [
      { key: 'pid', label: 'pid', num: true },
      { key: 'state', label: 'state' },
      { key: 'locktype', label: 'locktype' },
      { key: 'relation', label: 'relation' },
      { key: 'mode', label: 'mode' },
      { key: 'granted', label: 'granted' },
      { key: 'wait_age', label: 'model wait age' },
      { key: 'blocked_by', label: 'blocked_by' },
    ],
    rows,
    empty:
      'Nothing is blocked. On a real server this query returning no rows is the answer you want, and it is much faster than reading pg_locks in full.',
    caption:
      '▸ is the holder. Notice its state: it is not running a query at all — it finished the statement and left the transaction open. Cancelling the waiters achieves nothing; the pid to deal with is the one every blocked_by array points at.',
  }
}

/* ---------------------------------------------------------------------------
 * pg_settings and pg_replication_slots
 * -------------------------------------------------------------------------*/

const settings: ProjectionFn = (s) => {
  const k = s.knobs
  const row = (name: string, setting: string, unit: string, context: string, tone: Tone = ''): Row => ({
    key: name,
    tone,
    cells: {
      name: { v: name, tone: tone || 'accent' },
      setting: { v: setting, tone },
      unit: unit ? { v: unit, tone: 'dim' } : NULLC,
      context: { v: context, tone: 'dim' },
    },
  })
  return {
    cols: [
      { key: 'name', label: 'name' },
      { key: 'setting', label: 'setting', num: true },
      { key: 'unit', label: 'unit' },
      { key: 'context', label: 'context' },
    ],
    rows: [
      row('shared_buffers', String(poolPages(k)), '8kB', 'postmaster'),
      row('wal_buffers', String(s.wal.bufferCapacity / PG_PAGE_BYTES), '8kB', 'postmaster'),
      row('max_connections', String(s.maxConnections), '', 'postmaster'),
      row('checkpoint_timeout', String(Math.round(k.checkpointTimeout)), 's', 'sighup'),
      row('checkpoint_completion_target', k.checkpointCompletionTarget.toFixed(2), '', 'sighup'),
      row('max_wal_size', String(Math.round(k.maxWalSize)), 'MB', 'sighup'),
      row('bgwriter_lru_maxpages', k.bgwriterEnabled ? String(k.bgwriterLruMaxpages) : '0', '', 'sighup', k.bgwriterEnabled ? '' : 'warn'),
      row('bgwriter_delay', '200', 'ms', 'sighup'),
      row('synchronous_commit', k.synchronousCommit, '', 'user'),
      row('wal_level', k.walLevel, '', 'postmaster'),
      row('full_page_writes', k.fullPageWrites ? 'on' : 'off', '', 'sighup', k.fullPageWrites ? '' : 'crit'),
      row('autovacuum', k.autovacuum ? 'on' : 'off', '', 'sighup', k.autovacuum ? '' : 'crit'),
      row('autovacuum_vacuum_scale_factor', k.autovacuumScaleFactor.toFixed(2), '', 'sighup'),
      row('autovacuum_max_workers', '3', '', 'postmaster'),
      row('track_io_timing', 'off', '', 'superuser', 'warn'),
    ],
    caption:
      'track_io_timing is off — which is the PostgreSQL default, and the reason blk_read_time, blk_write_time and every *_time column in pg_stat_io read zero on most servers you will ever touch. You can count I/Os without it. You cannot say whether they hurt.',
  }
}

const slots: ProjectionFn = (s) => {
  if (s.knobs.walLevel === 'minimal') {
    return {
      cols: [{ key: 'x', label: 'pg_replication_slots' }],
      rows: [],
      empty: 'No slots: wal_level = minimal cannot support physical or logical replication.',
    }
  }
  const rows: Row[] = []
  for (const slot of s.replication.physicalSlots) {
    const behind = slot.retainedBytes
    rows.push({
      key: slot.name,
      cells: {
        slot_name: slot.name,
        slot_type: 'physical',
        active: { v: slot.active ? 't' : 'f', tone: slot.active ? 'ok' : 'crit' },
        restart_lsn: { v: fmtLsn(slot.restartLsn), tone: slot.active ? 'accent' : 'warn' },
        confirmed_flush_lsn: NULLC,
        retained: {
          v: fmtBytes(behind),
          tone: behind > 256 * 1024 * 1024 ? 'crit' : behind > 16 * 1024 * 1024 ? 'warn' : 'dim',
        },
        wal_status: { v: 'reserved', tone: slot.active ? 'ok' : 'warn' },
      },
    })
  }
  if (s.replication.logicalEnabled) {
    const behind = s.wal.insertLsn - s.replication.logicalSlotLsn
    rows.push({
      key: 'sub',
      cells: {
        slot_name: 'pgsimcity_sub',
        slot_type: 'logical',
        active: { v: 't', tone: 'ok' },
        restart_lsn: { v: fmtLsn(s.replication.logicalSlotLsn), tone: 'warn' },
        confirmed_flush_lsn: { v: fmtLsn(s.replication.logicalSlotLsn), tone: 'accent' },
        retained: { v: fmtBytes(Math.max(0, behind)), tone: behind > 4e6 ? 'warn' : 'dim' },
        wal_status: { v: 'reserved', tone: 'ok' },
      },
    })
  }
  return {
    cols: [
      { key: 'slot_name', label: 'slot_name' },
      { key: 'slot_type', label: 'slot_type' },
      { key: 'active', label: 'active' },
      { key: 'restart_lsn', label: 'restart_lsn' },
      { key: 'confirmed_flush_lsn', label: 'confirmed_flush_lsn' },
      { key: 'retained', label: 'WAL retained', num: true },
      { key: 'wal_status', label: 'wal_status' },
    ],
    rows,
    caption:
      'WAL retained is derived as primary insert LSN minus restart_lsn for every slot. For logical slots the model collapses restart_lsn and confirmed_flush_lsn to one position; real PostgreSQL exposes both and restart_lsn can be earlier. The model does not configure max_slot_wal_keep_size or idle_replication_slot_timeout, so its slots remain reserved rather than being invalidated.',
  }
}

/* ---------------------------------------------------------------------------
 * registry
 * -------------------------------------------------------------------------*/

export const PROJECTIONS: Record<string, ProjectionFn> = {
  activity,
  activity_agg: activityAgg,
  activity_xmin: activityXmin,
  database,
  tables,
  bgwriter,
  checkpointer,
  wal,
  wal_lsn: walLsn,
  io,
  buffercache,
  replication,
  progress_vacuum: progressVacuum,
  locks,
  settings,
  slots,
}

export const PROJECTION_SOURCES: Record<string, ProjectionSource> = {
  activity: 'activity.rows',
  activity_agg: 'activity.rows',
  activity_xmin: 'activity.xmin_rows',
  database: 'database.counters',
  tables: 'tables.rows',
  bgwriter: 'bgwriter.counters',
  checkpointer: 'checkpointer.counters',
  wal: 'wal.counters',
  wal_lsn: 'wal.positions',
  io: 'io.rows',
  buffercache: 'buffercache.rows',
  replication: 'replication.standbys',
  progress_vacuum: 'vacuum.progress_rows',
  locks: 'locks.rows',
  settings: 'settings.rows',
  slots: 'slots.rows',
}

/** Guard: the model only knows about the five tables the city ships. */
export const TABLE_COUNT = N_TABLES
