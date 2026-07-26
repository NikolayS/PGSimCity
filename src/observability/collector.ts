/* ============================================================================
 * THE CUMULATIVE STATISTICS SYSTEM (model edition)
 *
 * PostgreSQL's pg_stat_* views are almost all *counters since a reset*, and
 * misreading a counter as a rate is the single most common mistake people make
 * with them. So this module does what the real stats system does: it watches
 * the running model, accumulates monotonic totals, and remembers when they were
 * last reset. The UI can then show either the raw total or a derived per-second
 * rate — which is the lesson, not a feature.
 *
 * Nothing here invents a quantity. Every counter is either a value the model
 * already maintains, or a sum of model events observed as they happen. Two
 * counters are explicitly *derived* and labelled as such in the catalog:
 * wal_records and wal_fpi.
 * ==========================================================================*/

import type { SimApi, SimState } from '../core/types'
import { N_BACKEND_SLOTS } from '../core/types'

export interface Counters {
  /** wall-clock seconds of model time since the last reset */
  elapsed: number
  xactCommit: number
  xactRollback: number
  blksRead: number
  blksHit: number
  tupReturned: number
  tupInserted: number
  tupUpdated: number
  tupDeleted: number
  /** pg_stat_checkpointer */
  ckptTimed: number
  ckptRequested: number
  ckptDone: number
  ckptWriteMs: number
  ckptBuffers: number
  /** pg_stat_bgwriter */
  bgwClean: number
  buffersAlloc: number
  /** pg_stat_io, client backend */
  backendWrites: number
  evictions: number
  /** pg_stat_wal */
  walBytes: number
  walRecords: number
  walFpi: number
}

const ZERO: Counters = {
  elapsed: 0,
  xactCommit: 0,
  xactRollback: 0,
  blksRead: 0,
  blksHit: 0,
  tupReturned: 0,
  tupInserted: 0,
  tupUpdated: 0,
  tupDeleted: 0,
  ckptTimed: 0,
  ckptRequested: 0,
  ckptDone: 0,
  ckptWriteMs: 0,
  ckptBuffers: 0,
  bgwClean: 0,
  buffersAlloc: 0,
  backendWrites: 0,
  evictions: 0,
  walBytes: 0,
  walRecords: 0,
  walFpi: 0,
}

export interface Collector {
  /** totals since the last pg_stat_reset() */
  readonly total: Counters
  /** per-second rates over a ~2 s trailing window */
  readonly rate: Counters
  /** when the counters were last reset, as model seconds */
  readonly resetAt: number
  /** wall-clock label for stats_reset */
  readonly resetStamp: string
  /** per-slot transaction start, in model seconds; -1 when not in a transaction */
  readonly xactStart: Float64Array
  /** per-slot connection start, model seconds */
  readonly backendStart: Float64Array
  sample(): void
  reset(): void
}

/** Stable, plausible pids so a reader can follow one session across two views. */
export const PID = {
  postmaster: 24480,
  checkpointer: 24483,
  bgwriter: 24484,
  walwriter: 24485,
  avLauncher: 24486,
  avWorker: (i: number) => 24490 + i,
  walsender: 24497,
  /** the abandoned session that is holding the old snapshot */
  oldSnapshot: 24461,
  backend: (slot: number) => 24500 + slot * 3,
}

export function createCollector(sim: SimApi): Collector {
  const s = sim.state
  const total: Counters = { ...ZERO }
  const rate: Counters = { ...ZERO }

  /* Baselines: the model's own counters keep running across a stats reset, so
   * every total is (current − baseline), exactly like a real reset. */
  let base = snapshotRaw(s)
  let resetAt = s.t
  let resetStamp = stamp()

  /* Event-driven accumulators — these are counted as they happen because the
   * model does not keep them itself. */
  let ckptTimed = 0
  let ckptRequested = 0
  let ckptWriteMs = 0
  let ckptBuffers = 0
  let lastCkptCount = s.checkpoint.count
  let walRecords = 0
  let walFpi = 0
  let lastInsertLsn = s.wal.insertLsn
  let lastTup = s.stats.tupInserted + s.stats.tupUpdated + s.stats.tupDeleted
  let lastCommits = s.stats.commits

  const xactStart = new Float64Array(N_BACKEND_SLOTS).fill(-1)
  const backendStart = new Float64Array(N_BACKEND_SLOTS).fill(-1)

  /* rate window */
  let prev: Counters = { ...ZERO }
  let prevT = s.t
  const WINDOW = 2

  function snapshotRaw(st: SimState) {
    return {
      commits: st.stats.commits,
      rollbacks: st.stats.rollbacks,
      hits: st.buffers.hits,
      misses: st.buffers.misses,
      tupReturned: st.stats.tupReturned,
      tupInserted: st.stats.tupInserted,
      tupUpdated: st.stats.tupUpdated,
      tupDeleted: st.stats.tupDeleted,
      bgwClean: st.bgwriter.cleanedTotal,
      dirtyEvictions: st.buffers.dirtyEvictions,
      evictions: st.buffers.evictions,
      insertLsn: st.wal.insertLsn,
      ckptTimed: 0,
      ckptRequested: 0,
      ckptWriteMs: 0,
      ckptBuffers: 0,
      walRecords: 0,
      walFpi: 0,
    }
  }

  function stamp(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  function sample(): void {
    /* ---- checkpoints: count increments when one finishes, and `reason`
     * still describes the run that just ended. ------------------------- */
    if (s.checkpoint.count !== lastCkptCount) {
      const n = Math.max(0, s.checkpoint.count - lastCkptCount)
      lastCkptCount = s.checkpoint.count
      if (s.checkpoint.reason === 'wal' || s.checkpoint.reason === 'manual') ckptRequested += n
      else ckptTimed += n
      ckptWriteMs += s.checkpoint.lastDuration * 1000
      ckptBuffers += s.checkpoint.buffersWritten
    }

    /* ---- WAL records and full-page images.
     * wal_bytes is exact (it is the LSN advance). The other two are derived:
     * one record per tuple operation plus one per commit, and the full-page
     * share taken from the post-checkpoint burst the model simulates. ---- */
    const dLsn = s.wal.insertLsn - lastInsertLsn
    if (dLsn > 0) {
      lastInsertLsn = s.wal.insertLsn
      walFpi += (dLsn * s.wal.fpwBurst) / 8192
    }
    const tup = s.stats.tupInserted + s.stats.tupUpdated + s.stats.tupDeleted
    const commits = s.stats.commits
    walRecords += Math.max(0, tup - lastTup) + Math.max(0, commits - lastCommits)
    lastTup = tup
    lastCommits = commits

    /* ---- per-session transaction clocks. A backend is inside a transaction
     * from the moment it leaves idle until it goes back to idle. ---------- */
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = s.backends[i]
      if (!b.active || b.state === 'free') {
        xactStart[i] = -1
        backendStart[i] = -1
        continue
      }
      if (backendStart[i] < 0) backendStart[i] = s.t - b.age
      const inXact = b.state !== 'idle' && b.state !== 'starting' && b.state !== 'ending'
      if (inXact) {
        if (xactStart[i] < 0) xactStart[i] = s.t
      } else {
        xactStart[i] = -1
      }
    }

    /* ---- roll up the totals ------------------------------------------- */
    total.elapsed = s.t - resetAt
    total.xactCommit = s.stats.commits - base.commits
    total.xactRollback = s.stats.rollbacks - base.rollbacks
    total.blksHit = s.buffers.hits - base.hits
    total.blksRead = s.buffers.misses - base.misses
    total.tupReturned = s.stats.tupReturned - base.tupReturned
    total.tupInserted = s.stats.tupInserted - base.tupInserted
    total.tupUpdated = s.stats.tupUpdated - base.tupUpdated
    total.tupDeleted = s.stats.tupDeleted - base.tupDeleted
    total.ckptTimed = ckptTimed
    total.ckptRequested = ckptRequested
    total.ckptDone = ckptTimed + ckptRequested
    total.ckptWriteMs = ckptWriteMs
    total.ckptBuffers = ckptBuffers
    total.bgwClean = s.bgwriter.cleanedTotal - base.bgwClean
    // buffers_alloc counts buffer allocations, which in this model is exactly
    // the number of pages that had to be found a frame — the misses.
    total.buffersAlloc = s.buffers.misses - base.misses
    total.backendWrites = s.buffers.dirtyEvictions - base.dirtyEvictions
    total.evictions = s.buffers.evictions - base.evictions
    total.walBytes = s.wal.insertLsn - base.insertLsn
    total.walRecords = walRecords
    total.walFpi = walFpi

    /* ---- rates ---------------------------------------------------------- */
    const dt = s.t - prevT
    if (dt >= WINDOW) {
      for (const k of Object.keys(rate) as (keyof Counters)[]) {
        rate[k] = (total[k] - prev[k]) / dt
      }
      prev = { ...total }
      prevT = s.t
    }
  }

  function reset(): void {
    base = snapshotRaw(s)
    resetAt = s.t
    resetStamp = stamp()
    ckptTimed = ckptRequested = ckptWriteMs = ckptBuffers = 0
    walRecords = 0
    walFpi = 0
    lastInsertLsn = s.wal.insertLsn
    lastCkptCount = s.checkpoint.count
    lastTup = s.stats.tupInserted + s.stats.tupUpdated + s.stats.tupDeleted
    lastCommits = s.stats.commits
    Object.assign(total, ZERO)
    Object.assign(rate, ZERO)
    prev = { ...ZERO }
    prevT = s.t
  }

  sample()

  return {
    total,
    rate,
    get resetAt() {
      return resetAt
    },
    get resetStamp() {
      return resetStamp
    },
    xactStart,
    backendStart,
    sample,
    reset,
  }
}
