/* ============================================================================
 * PGSimCity — THE SIMULATION
 *
 * This file is the engine. Everything the city draws is a projection of the
 * state produced here, so the rules below are meant to be *true*, not pretty:
 * the clock sweep really sweeps, the backend really writes out its own victim
 * page when shared_buffers is too small, full-page writes really explode right
 * after a checkpoint, and an old snapshot really does stop vacuum dead.
 *
 * TWO HONEST DISTORTIONS, both deliberate:
 *
 *  1. TIME IS STRETCHED for anything sub-second. A real parse is ~50µs and a
 *     real fsync is ~1ms; at 60fps you would never see either. Every duration
 *     below is a monotone stretch (~100x) of the real one, so the *shape* is
 *     faithful — plan is longer than parse, exec_io dwarfs exec_cpu on a miss,
 *     commit_wait at remote_apply dwarfs commit_wait at 'on' — while the
 *     absolute numbers are theatre. Rates (tps, bytes/sec, LSNs) are NOT
 *     stretched; those are reported in real units.
 *
 *  2. THE CITY IS A SCALE MODEL. 1024 buffers (8 MiB shared_buffers), 16 backend
 *     slots, 14 visible WAL segments. To let 16 towers represent thousands of
 *     transactions per second, one trip through the backend state machine
 *     carries `batch` transactions, and all work (pages touched, WAL bytes,
 *     dead tuples) is multiplied by that batch, so the pool and the WAL see the
 *     real pressure.
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
 * ==========================================================================*/

import {
  DEFAULT_KNOBS,
  N_BACKEND_SLOTS,
  N_BUFFERS,
  N_VAC_WORKERS,
  N_WAL_SEG_SLOTS,
} from '../core/types'
import type {
  BackendSim,
  Bus,
  FlowKind,
  FlowRequest,
  Knobs,
  PlanNode,
  QueryKind,
  SimApi,
  SimState,
  TableSim,
  VacPhase,
  VacWorker,
  WalSegment,
} from '../core/types'
import { ANCHOR, N_TABLES, TABLES, rid } from '../world/layout'
import {
  clamp,
  clamp01,
  damp,
  expDelay,
  makeRng,
  pushHistory,
  walSegName,
  weightedPick,
} from '../core/util'
import { SCENARIOS } from './scenarios'

/* --------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------*/

const PAGE = 8192
const WAL_SEG = 16 * 1024 * 1024
/** wal_buffers: PostgreSQL auto-tunes this to shared_buffers/32 → 256 KiB here. */
const WAL_BUF_CAP = 256 * 1024
/** BAS_BULKREAD: a big seq scan gets a 256 KiB ring so it cannot evict the pool. */
const RING = 32
const STEP_MAX = 1 / 30
/** Most sub-steps one update() call may run, so a huge delta cannot stall the tab. */
const MAX_STEPS = 20
const IDLE_REAP = 22
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
/**
 * Ceiling on the pages one vacuum pass may hand back. Real truncation needs an
 * ACCESS EXCLUSIVE lock and gives it up the moment anyone else wants the table,
 * so it proceeds in small bites — and usually reclaims nothing at all.
 */
const TRUNCATE_MAX_PAGES = 8
const MAX_VISIT_PAGES = 2400
const PAGE_OPS_PER_SEC = 60000
const FLOW_BUDGET_PER_SEC = 420
const WAL_WRITER_DELAY = 0.2
const BGW_DELAY = 0.2
const NET_STRETCH = 6 // ms of configured network lag → sim seconds (see header)

/* --------------------------------------------------------------------------
 * Internal per-backend bookkeeping the UI never sees.
 * ------------------------------------------------------------------------*/

interface Extra {
  txCount: number
  rowsPerStmt: number
  pagesLeft: number
  pagesTotal: number
  execTotal: number
  execElapsed: number
  commitLsn: number
  writes: boolean
  needsSort: boolean
  hot: boolean
  seqScan: boolean
  scanBlk: number
  visitT: number
  idleT: number
  holdsLock: boolean
  ringPos: number
  planFlat: PlanNode[]
  planStart: number[]
  planEnd: number[]
  fpiBytes: number
}

function makeExtra(): Extra {
  return {
    txCount: 0,
    rowsPerStmt: 1,
    pagesLeft: 0,
    pagesTotal: 0,
    execTotal: 0.2,
    execElapsed: 0,
    commitLsn: 0,
    writes: false,
    needsSort: false,
    hot: false,
    seqScan: false,
    scanBlk: 0,
    visitT: 0,
    idleT: 0,
    holdsLock: false,
    ringPos: 0,
    planFlat: [],
    planStart: [],
    planEnd: [],
    fpiBytes: 0,
  }
}

/* --------------------------------------------------------------------------
 * createSim
 * ------------------------------------------------------------------------*/

export function createSim(bus: Bus): SimApi {
  const rng = makeRng(0xc0ffee)
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
      travel: 0,
      deadCollected: 0,
      stalledByHorizon: false,
    })
  }

  const tables: TableSim[] = TABLES.map((def) => ({
    def,
    pages: def.pages,
    liveTuples: def.pages * def.tuplesPerPage,
    deadTuples: 0,
    bloat: 0,
    vacuumThreshold: 50,
    lastVacuum: 0,
    seqScans: 0,
    idxScans: 0,
    inserts: 0,
    updates: 0,
    hotUpdates: 0,
    deletes: 0,
    heat: 0,
    vacuuming: false,
  }))

  const state: SimState = {
    t: 0,
    realT: 0,
    knobs: { ...DEFAULT_KNOBS },
    xid: 100000,
    xminHorizon: 100000,
    oldestSnapshotAge: 0,
    maxConnections: N_BACKEND_SLOTS,
    backends,
    buffers: {
      size: DEFAULT_KNOBS.sharedBuffers,
      valid: new Uint8Array(N_BUFFERS),
      dirty: new Uint8Array(N_BUFFERS),
      pinned: new Uint8Array(N_BUFFERS),
      usage: new Uint8Array(N_BUFFERS),
      rel: new Uint8Array(N_BUFFERS),
      lastTouch: new Float32Array(N_BUFFERS),
      blk: new Uint32Array(N_BUFFERS),
      clockHand: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      dirtyEvictions: 0,
      hitRatio: 0.98,
      dirtyCount: 0,
      pinnedCount: 0,
      usedCount: 0,
    },
    wal: {
      insertLsn: 0x1a000000,
      writeLsn: 0x1a000000,
      flushLsn: 0x1a000000,
      bufferBytes: 0,
      bufferCapacity: WAL_BUF_CAP,
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
      buffersWritten: 0,
      nextInSec: DEFAULT_KNOBS.checkpointTimeout,
      elapsed: 0,
      lastDuration: 0,
      reason: 'time',
      count: 0,
      redoLsn: 0x1a000000,
    },
    bgwriter: {
      enabled: true,
      scanPos: 0,
      cleanedTotal: 0,
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
      enabled: true,
      connected: true,
      mode: 'async',
      sentLsn: 0x1a000000,
      writeLsn: 0x1a000000,
      flushLsn: 0x1a000000,
      replayLsn: 0x1a000000,
      lagBytes: 0,
      lagSec: 0,
      networkLagMs: DEFAULT_KNOBS.replicaNetworkLag,
      applyActivity: 0,
      logicalEnabled: false,
      logicalSlotLsn: 0x1a000000,
      logicalChangesPerSec: 0,
      inFlight: 0,
    },
    locks: [],
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
      ioWritePerSec: 0,
      cacheHitPct: 98,
      activeBackends: 0,
      history: { tps: [], hit: [], wal: [], dirty: [], lag: [] },
    },
    scenario: null,
    scenarioT: 0,
    forkPulse: 0,
  }

  const K = state.knobs
  const buf = state.buffers
  const wal = state.wal
  const ckpt = state.checkpoint
  const bgw = state.bgwriter
  const av = state.autovac
  const rep = state.replication
  const stats = state.stats

  /* ---- derived tables ------------------------------------------------- */

  /** Average tuple width, derived from the declared tuples-per-page. */
  const avgTuple: number[] = TABLES.map((d) => Math.round((PAGE / d.tuplesPerPage) * 0.85))
  /** Hot working set per relation: ~4% of the heap takes ~97% of the traffic. */
  const hotPages: number[] = TABLES.map((d) => clamp(Math.round(d.pages * 0.04), 16, 180))
  /** Total index pages per table, used to place index blocks past the heap. */
  const idxPages: number[] = TABLES.map((d) => d.indexes.reduce((a, ix) => a + ix.pages, 0))
  /** Dead tuples that predate the xmin horizon and may therefore be removed. */
  const deadRemovable: number[] = TABLES.map(() => 0)

  const wRead: number[] = TABLES.map((d) => d.weight)
  const wIns: number[] = TABLES.map((d) => d.weight * (d.id === 'events' ? 2.4 : 1))
  // 'events' is append-only: it is never the target of an UPDATE or DELETE, which
  // is exactly why it never bloats.
  const wUpd: number[] = TABLES.map((d) =>
    d.id === 'events' ? 0 : d.weight * (d.id === 'sessions' ? 2.0 : 1),
  )
  // The planner picks a seq scan when the relation is small; a selective
  // predicate on a big table gets an index. So sequential scans land
  // overwhelmingly on the small relations, and only the analytics query
  // (`aggregate`) sweeps the big ones.
  /** Row count each relation settles at — inserts replace what deletes remove. */
  const naturalLive: number[] = TABLES.map((d) => d.pages * d.tuplesPerPage)
  /** 0 = tables at their natural size, 1 = draining hard. See tickTables(). */
  let liveDeficit = 0
  const wSeq: number[] = TABLES.map((d) => d.weight * Math.pow(600 / d.pages, 1.5))
  const wAgg: number[] = TABLES.map((d) => d.weight * Math.pow(d.pages / 600, 0.6))

  /* ---- buffer mapping table (the real shared hash table) --------------- */

  const bufMap = new Map<number, number>()
  const bufKey = (rel: number, blk: number) => rel * 0x400000 + blk
  const pinT = new Float32Array(N_BUFFERS)
  /**
   * Pages whose LSN is already past the checkpoint REDO point, i.e. that have
   * paid their full-page image for this checkpoint cycle. Keyed by page, not by
   * buffer: evicting a page and reading it back does NOT make it owe a second
   * image, because the rule is `page.LSN <= RedoRecPtr`, not residency.
   */
  const fpiDone = new Set<number>()
  const ringBuf = new Int32Array(N_BACKEND_SLOTS * RING).fill(-1)

  // A backend holds only a handful of pins at once (the pages its current node
  // is actually looking at). Pinned buffers are invisible to the clock sweep,
  // so this bound matters: unbounded pins would deadlock replacement.
  const PINS = 4
  const pinRing = new Int32Array(N_BACKEND_SLOTS * PINS).fill(-1)
  const pinPos = new Int32Array(N_BACKEND_SLOTS)

  function pinBuffer(slot: number, b: number): void {
    const base = slot * PINS
    const p = pinPos[slot]
    const old = pinRing[base + p]
    if (old >= 0 && old !== b) buf.pinned[old] = 0
    pinRing[base + p] = b
    pinPos[slot] = (p + 1) % PINS
    buf.pinned[b] = 1
    pinT[b] = state.t
  }

  function unpinAll(slot: number): void {
    const base = slot * PINS
    for (let i = 0; i < PINS; i++) {
      const b = pinRing[base + i]
      if (b >= 0) buf.pinned[b] = 0
      pinRing[base + i] = -1
    }
  }

  /* ---- wire (replication packets in flight) ---------------------------- */

  const WIRE = 96
  const wireLsn = new Float64Array(WIRE)
  const wireAt = new Float64Array(WIRE)
  let wireHead = 0
  let wireTail = 0
  let wireCount = 0

  /* ---- controller / accumulators -------------------------------------- */

  let pendingTx = 0
  let nextArrival = 0
  /** Transactions carried by one backend trip. See sizeBatch(). */
  let batchSize = 1
  let visitRate = 4 // EMA of completed backend trips per second
  /** Arrivals the queue could not hold — pg's "too many clients already". */
  let refusedTx = 0
  let visitsAcc = 0
  let commitsAcc = 0
  let walAcc = 0
  let fpiAcc = 0
  let ioReadAcc = 0
  let ioWriteAcc = 0
  let winHits = 0
  let winMisses = 0
  let rateT = 0
  let histT = 0
  let pageBudget = 0
  let flowTokens = 60
  let quiet = false
  let applying = false

  let forkCooldown = 0
  let walWriterT = 0
  let bgwT = 0
  let flushing = false
  let flushTarget = 0
  let flushT = 0
  let flushDur = 0
  let flushBytes = 0
  let archT = 0
  let archSlot = -1
  let cleanedAcc = 0
  let logicalAcc = 0
  let replicaReadT = 0
  let statT = 0
  let degradeWarnT = -100
  let refuseWarnT = -100
  let planSeq = 1

  /** xmin horizon control. When a long transaction is open the horizon freezes. */
  let horizonFrozen = false
  let horizonXid = state.xid
  let horizonT = 0

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
    // ceil, not round: a trip is indivisible, so rounding 1.4 down would leave
    // the fleet structurally unable to serve the offered rate. Over-sizing is
    // harmless — startVisit() only ever takes what is actually queued.
    batchSize = Math.max(1, Math.ceil(K.tps / NOMINAL_TRIPS))
  }

  /* ======================================================================
   * BUFFER POOL — shared_buffers, the clock sweep, and who pays for the I/O.
   * ====================================================================*/

  function invalidate(b: number): void {
    if (buf.valid[b]) bufMap.delete(bufKey(buf.rel[b], buf.blk[b]))
    buf.valid[b] = 0
    buf.dirty[b] = 0
    buf.pinned[b] = 0
    buf.usage[b] = 0
    buf.rel[b] = 255
    buf.blk[b] = 0
  }

  /** A dirty victim has to hit the disk before the frame can be reused. */
  function writeOut(b: number, byBackend: boolean): void {
    if (!buf.dirty[b]) return
    buf.dirty[b] = 0
    ioWriteAcc++
    if (byBackend) {
      buf.dirtyEvictions++
      const rel = buf.rel[b] < N_TABLES ? buf.rel[b] : 0
      if (++sIoWrite >= stride(stats.ioWritePerSec, 30)) {
        sIoWrite = 0
        flow(rid.ioWrite(rel), 1, 'page_write', 1.3)
      }
    }
  }

  /**
   * Clock sweep. Walk the pool decrementing usage_count until we find a frame
   * with usage 0 and no pin. This is BufferAlloc()/StrategyGetBuffer() and it is
   * the reason a too-small shared_buffers makes *backends* do write I/O.
   */
  function clockVictim(): number {
    const size = buf.size
    let guard = size * 6 + 8
    while (guard-- > 0) {
      const b = buf.clockHand
      buf.clockHand = buf.clockHand + 1 >= size ? 0 : buf.clockHand + 1
      if (buf.pinned[b]) continue
      if (buf.usage[b] > 0) {
        buf.usage[b]--
        continue
      }
      return b
    }
    return buf.clockHand % size
  }

  /** BAS_BULKREAD: reuse our own ring frame instead of evicting the whole pool. */
  function ringVictim(slot: number, x: Extra): number {
    const base = slot * RING
    const b = ringBuf[base + x.ringPos]
    x.ringPos = (x.ringPos + 1) % RING
    if (b >= 0 && b < buf.size && !buf.pinned[b]) return b
    const v = clockVictim()
    ringBuf[base + (x.ringPos + RING - 1) % RING] = v
    return v
  }

  /**
   * Request one page. Returns true on a shared-buffers hit.
   * `useRing` marks a large sequential read; `forWrite` dirties the page.
   */
  function touchPage(slot: number, rel: number, blk: number, forWrite: boolean, useRing: boolean): boolean {
    const key = bufKey(rel, blk)
    const found = bufMap.get(key)
    const b = backends[slot]
    const x = extras[slot]

    if (found !== undefined && found < buf.size && buf.valid[found]) {
      if (buf.usage[found] < 5) buf.usage[found]++
      pinBuffer(slot, found)
      buf.lastTouch[found] = state.t
      buf.hits++
      winHits++
      b.lastBuffer = found
      if (forWrite) markDirty(found, slot)
      return true
    }

    // miss → find a victim, pay for it, then read from storage
    const v = useRing ? ringVictim(slot, x) : clockVictim()
    if (buf.valid[v]) {
      writeOut(v, true) // the backend that wanted the frame does this write
      bufMap.delete(bufKey(buf.rel[v], buf.blk[v]))
      buf.evictions++
    }
    buf.valid[v] = 1
    buf.dirty[v] = 0
    buf.rel[v] = rel
    buf.blk[v] = blk
    buf.usage[v] = 1
    pinBuffer(slot, v)
    buf.lastTouch[v] = state.t
    bufMap.set(key, v)
    buf.misses++
    winMisses++
    ioReadAcc++
    b.lastBuffer = v
    if (++sIoRead >= stride(stats.ioReadPerSec, 40)) {
      sIoRead = 0
      flow(rid.ioRead(rel < N_TABLES ? rel : 0), 1, 'page_read', 1.2)
    }
    if (forWrite) markDirty(v, slot)
    return false
  }

  function markDirty(b: number, slot: number): void {
    buf.dirty[b] = 1
    if (!K.fullPageWrites) return
    // full_page_writes: the first modification of a page after a checkpoint
    // carries an entire 8 KiB image into the WAL, so that replay can always
    // start from a page it trusts. This is why WAL volume explodes immediately
    // after every checkpoint and then decays as the write working set pays off.
    const key = bufKey(buf.rel[b], buf.blk[b])
    if (fpiDone.has(key)) return
    if (fpiDone.size > 40000) fpiDone.clear()
    fpiDone.add(key)
    const bytes = PAGE * rr(0.6, 1.0) // the hole between pd_lower/pd_upper is skipped
    extras[slot].fpiBytes += bytes
    walInsert(bytes)
    fpiAcc += bytes
  }

  function resizePool(newSize: number): void {
    const size = clamp(Math.round(newSize), 32, N_BUFFERS)
    if (size < buf.size) for (let b = size; b < buf.size; b++) invalidate(b)
    buf.size = size
    if (buf.clockHand >= size) buf.clockHand = 0
    if (bgw.scanPos >= size) bgw.scanPos = 0
    for (let i = 0; i < ringBuf.length; i++) if (ringBuf[i] >= size) ringBuf[i] = -1
  }

  /** Pin decay + the counters the 3D grid reads. Cheap: 1024 slots. */
  function sweepPool(): void {
    let dirtyN = 0
    let pinN = 0
    let usedN = 0
    const now = state.t
    for (let b = 0; b < buf.size; b++) {
      if (buf.pinned[b] && now - pinT[b] > 0.12) buf.pinned[b] = 0
      if (buf.valid[b]) usedN++
      if (buf.dirty[b]) dirtyN++
      if (buf.pinned[b]) pinN++
    }
    buf.dirtyCount = dirtyN
    buf.pinnedCount = pinN
    buf.usedCount = usedN
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

  function requestFlush(target: number): void {
    if (target > flushTarget) flushTarget = target
    if (!flushing) {
      flushing = true
      flushBytes = Math.max(0, flushTarget - wal.flushLsn)
      // fsync latency: mostly fixed cost, a little size-dependent.
      flushDur = 0.085 + Math.min(0.22, flushBytes / (6 * 1024 * 1024))
      flushT = 0
      // write() happens now; fsync() completes flushDur later. Between the two,
      // these bytes are in the OS page cache — they survive a Postgres crash
      // and not a power cut, which is the whole point of the walwriter doc.
      // Handing them to the kernel is also what frees the wal_buffers ring:
      // a WAL buffer is reusable once written, not once flushed.
      wal.writeLsn = Math.max(wal.writeLsn, flushTarget)
      wal.bufferBytes = Math.min(wal.bufferCapacity, wal.insertLsn - wal.writeLsn)
      flow('wal.flush', 1, 'wal_flush', 1.3)
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
        wal.flushLsn = Math.max(wal.flushLsn, wal.writeLsn)
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
        if (flushTarget > wal.flushLsn) requestFlush(flushTarget)
      }
    }

    tickSegments(dt)
  }

  const archiverOn = () => K.walLevel !== 'minimal'

  function tickSegments(dt: number): void {
    const curSeg = Math.floor(wal.insertLsn / WAL_SEG)
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
      last.name = walSegName(last.id)
      last.bytes = 0
      last.fill = 0
      last.state = 'recycled'
      if (archSlot >= 0) archSlot--
    }

    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const s = segments[i]
      s.id = base + i
      s.name = walSegName(s.id)
      if (s.id < curSeg) {
        s.bytes = WAL_SEG
        s.fill = 1
        if (s.state === 'current' || s.state === 'recycled') s.state = 'full'
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

    // walsender has shipped everything below sentLsn
    if (rep.connected) {
      const sentSeg = Math.floor(rep.sentLsn / WAL_SEG)
      for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
        const s = segments[i]
        if (s.state === 'full' && s.id < sentSeg) s.state = 'streamed'
      }
    }

    // archiver: one segment at a time, .ready → archive_command → .done
    let queue = 0
    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const st = segments[i].state
      if (st === 'full' || st === 'streamed') queue++
    }
    wal.archiveQueue = queue

    if (archiverOn()) {
      if (archSlot >= 0 && archSlot < N_WAL_SEG_SLOTS && segments[archSlot].state === 'archiving') {
        archT += dt
        flow('wal.archive', 1, 'archive', 1.2)
        if (archT >= 2.4) {
          segments[archSlot].state = 'archived'
          wal.archived++
          archSlot = -1
          archT = 0
        }
      } else {
        archSlot = -1
        for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
          const s = segments[i]
          if (s.state === 'full' || s.state === 'streamed') {
            s.state = 'archiving'
            archSlot = i
            archT = 0
            break
          }
        }
      }
    }

    // pg_wal size: everything since the checkpoint REDO point, plus the
    // recycled files we keep pre-allocated, plus anything archiving is holding
    // — and, critically, everything a replication slot has not confirmed yet.
    // A standby that falls behind (or a slot nobody is reading) pins WAL on the
    // primary. That is how a replica takes down a primary's disk.
    const sinceRedo = Math.max(0, wal.insertLsn - ckpt.redoLsn)
    let slotHold = 0
    if (rep.enabled) {
      const restart = rep.logicalEnabled ? Math.min(rep.flushLsn, rep.logicalSlotLsn) : rep.flushLsn
      slotHold = Math.max(0, wal.insertLsn - restart)
    }
    wal.segmentCount = clamp(
      Math.round(Math.max(sinceRedo, slotHold) / WAL_SEG) + 3 + wal.archiveQueue,
      3,
      512,
    )
  }

  /* ======================================================================
   * CHECKPOINTS
   * ====================================================================*/

  function startCheckpoint(reason: 'time' | 'wal' | 'manual'): void {
    ckpt.phase = 'start'
    ckpt.reason = reason
    ckpt.elapsed = 0
    ckpt.progress = 0
    ckpt.buffersWritten = 0
    ckpt.nextInSec = K.checkpointTimeout
    // REDO point: recovery would replay from here.
    ckpt.redoLsn = wal.insertLsn
    let n = 0
    for (let b = 0; b < buf.size; b++) if (buf.dirty[b]) n++
    ckpt.buffersToWrite = n
    // Every page now owes a full-page image on its next modification.
    fpiDone.clear()
    wal.fpwBurst = 1
    ckptScan = buf.clockHand
    bus.emit('checkpoint:start', { reason })
    bus.emit('fx:pulse', {
      at: [ANCHOR.checkpointer[0], ANCHOR.checkpointer[1] + 12, ANCHOR.checkpointer[2]],
      radius: 40,
    })
    if (reason === 'wal') {
      toast('Checkpoint triggered by max_wal_size — not by the timer', 'warn', 5000)
    }
  }

  let ckptWriteDur = 30
  let ckptSyncDur = 1.5
  let ckptWriteAcc = 0
  /** The checkpointer has its own cursor: it sweeps the pool exactly once. */
  let ckptScan = 0

  function tickCheckpoint(dt: number): void {
    ckpt.elapsed += ckpt.phase === 'idle' ? 0 : dt

    if (ckpt.phase === 'idle') {
      ckpt.nextInSec -= dt
      const walSinceRedo = wal.insertLsn - ckpt.redoLsn
      if (walSinceRedo > K.maxWalSize * 1024 * 1024) startCheckpoint('wal')
      else if (ckpt.nextInSec <= 0) startCheckpoint('time')
      return
    }

    if (ckpt.phase === 'start') {
      if (ckpt.elapsed > 0.35) {
        ckpt.phase = 'writing'
        // checkpoint_completion_target spreads the writes. For a WAL-triggered
        // checkpoint the deadline is "when we would fill max_wal_size again".
        const walRate = Math.max(4096, wal.bytesPerSec)
        const walDeadline = (K.maxWalSize * 1024 * 1024) / walRate
        const span = ckpt.reason === 'wal' ? Math.min(K.checkpointTimeout, walDeadline) : K.checkpointTimeout
        ckptWriteDur = clamp(K.checkpointCompletionTarget * span, 2, 600)
        ckptWriteAcc = 0
      }
      return
    }

    if (ckpt.phase === 'writing') {
      const rate = ckpt.buffersToWrite / ckptWriteDur
      ckptWriteAcc += rate * dt
      let n = Math.floor(ckptWriteAcc)
      ckptWriteAcc -= n
      const target = stride(rate, 26)
      while (n-- > 0 && ckpt.buffersWritten < ckpt.buffersToWrite) {
        // One ordered pass over the pool, writing whatever is still dirty. The
        // bgwriter may have cleaned some of them already — that is the point.
        let found = -1
        for (let k = 0; k < buf.size; k++) {
          const b = (ckptScan + k) % buf.size
          if (buf.dirty[b]) {
            found = b
            ckptScan = (b + 1) % buf.size
            break
          }
        }
        ckpt.buffersWritten++
        if (found < 0) continue
        buf.dirty[found] = 0
        ioWriteAcc++
        if (++sCkpt >= target) {
          sCkpt = 0
          flow('ckpt.sweep', 1, 'page_write', 1.25)
          flow(rid.ioWrite(buf.rel[found] < N_TABLES ? buf.rel[found] : 0), 1, 'page_write', 1.1)
        }
      }
      ckpt.progress = ckpt.buffersToWrite > 0 ? clamp01(ckpt.buffersWritten / ckpt.buffersToWrite) : 1
      if (ckpt.progress >= 1 || ckpt.elapsed > ckptWriteDur + 1) {
        ckpt.phase = 'syncing'
        ckptSyncDur = clamp(0.5 + ckpt.buffersWritten / 420, 0.5, 4)
        ckpt.progress = 1
      }
      return
    }

    if (ckpt.phase === 'syncing') {
      // The fsync burst. Every file the checkpoint touched is flushed now, and
      // this is where a checkpoint actually hurts on a busy machine.
      flow('ckpt.fsync', 1, 'page_write', 1.3)
      if (ckpt.elapsed > ckptWriteDur + ckptSyncDur) ckpt.phase = 'finishing'
      return
    }

    // finishing: write the checkpoint record, recycle WAL below the REDO point
    if (ckpt.elapsed > ckptWriteDur + ckptSyncDur + 0.4) {
      walInsert(140)
      ckpt.lastDuration = ckpt.elapsed
      ckpt.count++
      ckpt.phase = 'idle'
      ckpt.progress = 0
      bus.emit('checkpoint:end', { duration: ckpt.lastDuration })
    }
  }

  /* ======================================================================
   * BGWRITER
   *
   * The bgwriter does NOT clean the whole pool — it cleans a little way ahead
   * of the clock hand, so pages a backend is about to reuse are already clean.
   * Hot dirty pages stay dirty until the checkpoint. Turn it off and the
   * backends start doing those writes themselves (buffers.dirtyEvictions).
   * ====================================================================*/

  function tickBgwriter(dt: number): void {
    bgw.enabled = K.bgwriterEnabled
    if (!bgw.enabled) {
      bgw.activity = damp(bgw.activity, 0, 4, dt)
      bgw.cleanedPerSec = damp(bgw.cleanedPerSec, 0, 2, dt)
      return
    }
    bgwT += dt
    if (bgwT < BGW_DELAY) return
    bgwT = 0

    const lookahead = clamp(Math.round(stats.ioReadPerSec * 0.5 + 32), 16, 420)
    let cleaned = 0
    let scanned = 0
    bgw.scanPos = buf.clockHand
    while (scanned < lookahead && cleaned < K.bgwriterLruMaxpages) {
      const b = (bgw.scanPos + scanned) % buf.size
      scanned++
      // only frames that are about to be handed out: usage 0, unpinned
      if (buf.dirty[b] && buf.usage[b] === 0 && !buf.pinned[b]) {
        buf.dirty[b] = 0
        ioWriteAcc++
        cleaned++
        if (++sBgw >= stride(cleaned / BGW_DELAY, 16)) {
          sBgw = 0
          flow('bgw.sweep', 1, 'page_write', 1.1)
        }
      }
    }
    bgw.cleanedTotal += cleaned
    cleanedAcc += cleaned
    bgw.activity = damp(bgw.activity, clamp01(cleaned / Math.max(1, K.bgwriterLruMaxpages)), 6, BGW_DELAY)
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
      t.vacuumThreshold = 50 + K.autovacuumScaleFactor * t.liveTuples
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

  function vacNext(w: VacWorker, phase: VacPhase, dur: number): void {
    w.phase = phase
    w.progress = 0
    vacPhaseT[w.slot] = 0
    vacPhaseDur[w.slot] = Math.max(0.05, dur)
  }

  function launchVacuum(): void {
    let slot = -1
    for (let i = 0; i < N_VAC_WORKERS; i++) if (!av.workers[i].active) { slot = i; break }
    if (slot < 0) return
    // pick the neediest table that is not already being vacuumed
    let best = -1
    let bestScore = 0
    for (let i = 0; i < N_TABLES; i++) {
      const t = tables[i]
      if (t.vacuuming) continue
      if (t.deadTuples <= t.vacuumThreshold) continue
      const score = t.deadTuples / Math.max(1, t.vacuumThreshold)
      if (score > bestScore) { bestScore = score; best = i }
    }
    if (best < 0) return
    const w = av.workers[slot]
    w.active = true
    w.table = best
    w.deadCollected = 0
    w.travel = 0
    w.stalledByHorizon = false
    vacTarget[slot] = Math.floor(deadRemovable[best])
    tables[best].vacuuming = true
    av.totalRuns++
    vacNext(w, 'travel', 2.0)
    flow('vac.launch', 2, 'stat', 1.2)
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
      const ti = w.table
      const t = tables[ti]
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
            vacNext(w, 'scan_heap', clamp((t.pages / 900) * skip, 1.2, 9))
          }
          break
        }
        case 'scan_heap': {
          t.heat = Math.min(1, t.heat + dt * 0.6)
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
              vacNext(w, 'vacuum_index', 1.0 + t.def.indexes[0].pages / 260)
            }
          }
          break
        }
        case 'vacuum_index': {
          if (++sVac >= 4) { sVac = 0; flow(rid.vacIdx(ti), 1, 'dead', 1.1) }
          if (done) {
            vacIdxLeft[i]--
            if (vacIdxLeft[i] > 0) {
              const ix = t.def.indexes[t.def.indexes.length - vacIdxLeft[i]]
              vacNext(w, 'vacuum_index', 1.0 + ix.pages / 260)
            } else {
              vacNext(w, 'vacuum_heap', clamp(t.pages / 1600, 0.8, 5))
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
          w.deadCollected += take
          av.landfill += take
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
            // then the truncation needs the exclusive lock it can only take a
            // few pages at a time.
            const cap = t.pages * t.def.tuplesPerPage
            const used = t.liveTuples + t.deadTuples
            const free = cap > 0 ? clamp01((cap - used) / cap) : 0
            const p = Math.pow(free, Math.min(t.def.tuplesPerPage, 32))
            const tailEmpty = p >= 0.999 ? t.pages : Math.floor(p / (1 - p))
            const shed = Math.min(tailEmpty, TRUNCATE_MAX_PAGES)
            if (shed > 0 && !horizonFrozen) {
              t.pages = Math.max(t.def.pages, t.pages - shed)
            }
            vacNext(w, 'analyze', 1.1)
          }
          break
        }
        case 'analyze': {
          if (done) vacNext(w, 'return', 1.8)
          break
        }
        case 'return': {
          w.travel = 1 - w.progress
          if (++sVac >= 3) { sVac = 0; flow(rid.vacBack(ti), 1, 'dead', 1.25) }
          if (done) {
            t.vacuuming = false
            t.lastVacuum = state.t
            w.active = false
            w.phase = 'idle'
            w.progress = 0
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
          bus.emit('fx:pulse', {
            at: [ANCHOR.lockManager[0], ANCHOR.lockManager[1] + 8, ANCHOR.lockManager[2]],
            radius: 26,
          })
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
        mode: 'AccessExclusiveLock',
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

  function tickReplication(dt: number): void {
    rep.enabled = K.replicaEnabled
    rep.networkLagMs = K.replicaNetworkLag
    rep.logicalEnabled = K.walLevel === 'logical'
    // synchronous_commit='on' is a *local* flush guarantee. Only remote_apply
    // makes the standby part of the commit path.
    rep.mode = K.synchronousCommit === 'remote_apply' ? 'sync' : 'async'

    if (!rep.enabled || K.walLevel === 'minimal') {
      if (rep.connected) {
        rep.connected = false
        wireCount = 0
        wireHead = 0
        wireTail = 0
        toast(
          K.walLevel === 'minimal'
            ? 'wal_level=minimal — a standby cannot be fed from this WAL'
            : 'Standby disconnected',
          'warn',
        )
      }
      rep.inFlight = 0
      rep.applyActivity = damp(rep.applyActivity, 0, 3, dt)
      rep.lagBytes = Math.max(0, wal.flushLsn - rep.replayLsn)
      rep.lagSec = rep.lagBytes / Math.max(4096, wal.bytesPerSec)
      return
    }
    if (!rep.connected) {
      rep.connected = true
      // A reconnecting standby resumes from where it stopped; if that WAL is
      // gone it would need a base backup. We fast-forward instead of lying.
      const behind = wal.flushLsn - rep.replayLsn
      if (behind > 4 * WAL_SEG) {
        rep.sentLsn = rep.writeLsn = rep.flushLsn = rep.replayLsn = wal.flushLsn
        toast('Standby resynchronised (required WAL had been recycled)', 'info')
      }
    }

    // walsender: push flushed WAL onto the wire in packets
    const delay = (K.replicaNetworkLag * NET_STRETCH) / 1000
    if (wal.flushLsn > rep.sentLsn && wireCount < WIRE) {
      const chunk = Math.min(wal.flushLsn - rep.sentLsn, Math.max(16 * 1024, wal.bytesPerSec * dt * 4))
      rep.sentLsn = Math.floor(rep.sentLsn + chunk)
      wireLsn[wireHead] = rep.sentLsn
      wireAt[wireHead] = state.t + delay
      wireHead = (wireHead + 1) % WIRE
      wireCount++
      flow('wal.stream', 1, 'stream', 1.2)
      flow('net.stream', 1, 'stream', 1.4)
    }

    // arrivals at the standby: walreceiver writes, then flushes
    while (wireCount > 0 && wireAt[wireTail] <= state.t) {
      rep.writeLsn = Math.max(rep.writeLsn, wireLsn[wireTail])
      wireTail = (wireTail + 1) % WIRE
      wireCount--
      flow('replica.apply', 1, 'stream', 1.1)
    }
    rep.inFlight = wireCount

    if (rep.flushLsn < rep.writeLsn) {
      const rate = Math.max(8 * 1024 * 1024, wal.bytesPerSec * 6)
      rep.flushLsn = Math.floor(Math.min(rep.writeLsn, rep.flushLsn + rate * dt))
      flow('net.ack', 1, 'ack', 1.0)
    }

    // Startup process: single-threaded replay of a WAL stream that sixteen
    // backends produced in parallel. Sequential replay is fast — until the
    // primary out-produces one CPU, and then the gap only ever grows.
    const applyRate = K.replicaSlowApply
      ? Math.max(24 * 1024, wal.bytesPerSec * 0.35)
      : Math.max(24 * 1024 * 1024, wal.bytesPerSec * 4)
    if (rep.replayLsn < rep.flushLsn) {
      rep.replayLsn = Math.floor(Math.min(rep.flushLsn, rep.replayLsn + applyRate * dt))
      rep.applyActivity = damp(rep.applyActivity, 1, 6, dt)
      flow('replica.buffer', 1, 'stream', 1.0)
      if (++sRepIo >= 6) { sRepIo = 0; flow('replica.io', 1, 'page_write', 1.0) }
    } else {
      rep.applyActivity = damp(rep.applyActivity, 0.08, 3, dt)
    }

    rep.lagBytes = Math.max(0, wal.flushLsn - rep.replayLsn)
    rep.lagSec = Math.min(999, rep.lagBytes / Math.max(4096, wal.bytesPerSec))

    // hot standby serving read-only queries
    replicaReadT += dt
    if (replicaReadT > 0.4) {
      replicaReadT = 0
      flow('replica.read', 1, 'query', 1.0)
    }

    // logical decoding reassembles committed transactions from the same WAL
    if (rep.logicalEnabled) {
      rep.logicalSlotLsn = Math.floor(
        Math.min(wal.flushLsn, rep.logicalSlotLsn + Math.max(2 * 1024 * 1024, wal.bytesPerSec * 1.4) * dt),
      )
      const changes = stats.tps * K.writeRatio * 1.4
      rep.logicalChangesPerSec = damp(rep.logicalChangesPerSec, changes, 2, dt)
      logicalAcc += dt
      if (logicalAcc > 0.12) {
        logicalAcc = 0
        flow('logical.decode', 1, 'stream', 1.1)
      }
    } else {
      rep.logicalSlotLsn = wal.flushLsn
      rep.logicalChangesPerSec = damp(rep.logicalChangesPerSec, 0, 3, dt)
    }
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
    const seqCost = t.pages * 1.0 + live * 0.01

    switch (kind) {
      case 'select_idx': {
        const shape = rng()
        if (shape < 0.45) {
          return pn('Index Scan', `using ${pkey} on ${name}  (Index Cond: id = $1)`, rows, 0.42 + rows * 0.25, [])
        }
        if (shape < 0.75) {
          const bi = pn('Bitmap Index Scan', `on ${alt}  (Index Cond: ${name.slice(0, 3)}_key = $1)`, rows * 1.4, 4.2 + rows * 0.02, [])
          return pn('Bitmap Heap Scan', `on ${name}  (Recheck Cond: …, Heap Blocks: exact=${Math.max(1, Math.round(rows / 3))})`, rows, 18 + rows * 0.3, [bi])
        }
        const inner = pn('Index Scan', `using ${tables[0].def.indexes[0].name} on ${tables[0].def.name}`, 1, 0.42, [])
        const outer = pn('Index Scan', `using ${alt} on ${name}`, rows, 0.42 + rows * 0.2, [])
        return pn('Nested Loop', `(Join Filter: none, rows=${Math.round(rows)})`, rows, 8 + rows * 0.6, [outer, inner])
      }
      case 'select_seq': {
        const s = pn('Seq Scan', `on ${name}  (Filter: payload ~~ $1, Rows Removed by Filter: ${Math.round(live * 0.94)})`, rows, seqCost, [])
        if (rng() < 0.45) {
          const so = pn('Sort', `(Sort Key: created_at DESC, Sort Method: top-N heapsort, Memory: ${Math.round(28 + rng() * 60)}kB)`, rows, seqCost * 1.1, [s])
          return pn('Limit', `(rows=${Math.round(rows)})`, rows, seqCost * 1.12, [so])
        }
        return s
      }
      case 'aggregate': {
        if (rng() < 0.5) {
          const ps = pn('Parallel Seq Scan', `on ${name}  (rows=${Math.round(live / 3)})`, live / 3, seqCost / 3, [])
          const pa = pn('Partial HashAggregate', `(Group Key: ${name.slice(0, 1)}.status)`, 12, seqCost / 3 + 80, [ps])
          const gm = pn('Gather Merge', '(Workers Planned: 2, Workers Launched: 2)', 36, seqCost / 3 + 140, [pa])
          return pn('Finalize GroupAggregate', '(Group Key: status)', 12, seqCost / 3 + 190, [gm])
        }
        const a = tables[0]
        const inner = pn('Seq Scan', `on ${a.def.name}`, a.liveTuples, a.pages * 1.0 + a.liveTuples * 0.01, [])
        const hash = pn('Hash', `(Buckets: 4096  Batches: 1  Memory Usage: ${Math.round(180 + rng() * 900)}kB)`, a.liveTuples, a.pages * 1.2, [inner])
        const outer = pn('Seq Scan', `on ${name}`, live, seqCost, [])
        const hj = pn('Hash Join', `(Hash Cond: ${name.slice(0, 1)}.account_id = a.id)`, live, seqCost * 1.6, [outer, hash])
        return pn('HashAggregate', '(Group Key: a.region)', 24, seqCost * 1.7, [hj])
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

  /* ======================================================================
   * BACKENDS
   * ====================================================================*/

  function sqlFor(kind: QueryKind, ti: number): string {
    const n = TABLES[ti].name
    switch (kind) {
      case 'select_idx':
        return `SELECT * FROM ${n} WHERE id = $1`
      case 'select_seq':
        return n === 'events'
          ? `SELECT * FROM events WHERE payload @> $1 ORDER BY created_at DESC LIMIT 50`
          : `SELECT * FROM ${n} WHERE updated_at > $1`
      case 'aggregate':
        return `SELECT status, count(*), sum(amount) FROM ${n} GROUP BY 1`
      case 'insert':
        return n === 'events'
          ? `INSERT INTO events (created_at, kind, payload) VALUES ($1, $2, $3)`
          : `INSERT INTO ${n} (…) VALUES ($1, $2, $3) RETURNING id`
      case 'update':
        return n === 'accounts'
          ? `UPDATE accounts SET balance = balance + $1 WHERE id = $2`
          : `UPDATE ${n} SET updated_at = now(), status = $1 WHERE id = ANY ($2)`
      case 'delete':
        return `DELETE FROM ${n} WHERE expires_at < now()`
    }
  }

  function pickBlk(ti: number, mode: 'hot' | 'append' | 'scan', x?: Extra): number {
    const t = tables[ti]
    if (mode === 'append') {
      // inserts go to the tail page unless the FSM has holes to fill
      if (t.bloat > 0.15 && rng() < 0.6) return Math.floor(t.pages * rng())
      return Math.max(0, t.pages - 1 - Math.floor(rng() * 2))
    }
    if (mode === 'scan' && x) {
      const b = x.scanBlk % Math.max(1, t.pages)
      x.scanBlk = b + 1
      return b
    }
    // 97.5% of accesses land in a small hot set, skewed within it
    if (rng() < 0.975) {
      const u = rng()
      return Math.floor(hotPages[ti] * u * u)
    }
    return Math.floor(t.pages * rng())
  }

  /** Index blocks live past the heap in the same relation for visual purposes. */
  function idxBlk(ti: number, level: 0 | 1 | 2): number {
    const base = tables[ti].def.pages
    if (level === 0) return base // root — always cached
    if (level === 1) return base + 1 + Math.floor(rng() * 4)
    const u = rng()
    return base + 8 + Math.floor(idxPages[ti] * u * u * u * u)
  }

  function startVisit(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const take = Math.max(1, Math.min(pendingTx, batchSize))
    pendingTx -= take
    x.txCount = take

    // pick the statement
    const isWrite = rng() < K.writeRatio
    let kind: QueryKind
    let ti: number
    if (isWrite) {
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
      if (rng() < 0.88) { kind = 'select_seq'; ti = weightedPick(wSeq, rng) }
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
    b.sql = sqlFor(kind, ti)
    b.rowsSent = 0
    b.buffersTouched = 0
    b.buffersHit = 0
    b.buffersRead = 0
    b.walBytes = 0
    b.waitOn = -1
    b.plan = null
    x.fpiBytes = 0
    x.visitT = 0
    x.idleT = 0
    x.writes = kind === 'insert' || kind === 'update' || kind === 'delete'
    x.seqScan = kind === 'select_seq' || kind === 'aggregate'
    x.needsSort = kind === 'aggregate' || (kind === 'select_seq' && rng() < 0.45)
    x.hot = kind === 'update' && rng() < TABLES[ti].hotFriendly && tables[ti].bloat < 0.55
    x.rowsPerStmt =
      kind === 'insert' ? 1 + Math.floor(rng() * 4)
      : kind === 'update' ? 2 + Math.floor(rng() * 10)
      : kind === 'delete' ? 1 + Math.floor(rng() * 18)
      : kind === 'select_idx' ? 1 + Math.floor(rng() * 6)
      : 20 + Math.floor(rng() * 400)

    b.state = 'parse'
    b.stateT = 0
    b.stateDur = rr(0.02, 0.045)
    b.progress = 0
    // A fresh statement gets a fresh access strategy: the previous scan's ring
    // frames go back to the general pool and age out normally.
    const rbase = slot * RING
    for (let i = 0; i < RING; i++) ringBuf[rbase + i] = -1
    x.ringPos = 0
    x.scanBlk = Math.floor(rng() * Math.max(1, tables[ti].pages))

    if (++sBufReq >= 2) {
      sBufReq = 0
      flow(rid.query(slot), 1, 'query', 1.2)
    }
    flow('procarray.in', 1, 'stat', 0.8)
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
      case 'select_seq':
        perStmt = Math.min(t.pages, 16 + Math.round(t.pages / 32))
        break
      case 'aggregate':
        perStmt = Math.min(t.pages, 200)
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
    // Scans are sampled once per trip; point work scales with the batch.
    const total = x.seqScan ? perStmt : Math.min(MAX_VISIT_PAGES, perStmt * x.txCount)
    x.pagesTotal = total
    x.pagesLeft = total
    x.execElapsed = 0

    const missFrac = clamp01(1 - buf.hitRatio)
    // Keep the floor — a trivial statement still costs something — but there is
    // no ceiling. Execution time has to stay proportional to the work, or a big
    // batch is free, the fleet has no capacity, and no amount of offered load
    // can ever saturate it. This is what makes achieved tps saturate instead of
    // tracking the knob, and what makes a cold pool cost real wall time.
    const dur = Math.max(0.1, 0.06 + total * (0.00035 + missFrac * 0.0045))
    x.execTotal = dur

    const ioShare = missFrac > 0.02 ? clamp(0.25 + missFrac * 0.6, 0.2, 0.85) : 0
    if (ioShare > 0) {
      b.state = 'exec_io'
      b.stateDur = dur * ioShare
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
    if (n > pageBudget) {
      // CPU backstop: account for the rest statistically at the current hit rate
      const skipped = n - Math.max(0, Math.floor(pageBudget))
      n = Math.max(0, Math.floor(pageBudget))
      const h = Math.round(skipped * buf.hitRatio)
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

    const ti = b.table
    const t = tables[ti]
    const nIdx = t.def.indexes.length
    const ring = x.seqScan && t.pages > buf.size / 4
    const write = x.writes

    for (let i = 0; i < n; i++) {
      let blk: number
      let forWrite = false
      if (x.seqScan) {
        blk = pickBlk(ti, 'scan', x)
      } else if (b.query === 'insert') {
        const k = i % (1 + nIdx)
        if (k === 0) { blk = pickBlk(ti, 'append'); forWrite = true }
        else { blk = idxBlk(ti, 2); forWrite = true }
      } else {
        const k = i % 5
        if (k === 0) blk = idxBlk(ti, 0)
        else if (k === 1) blk = idxBlk(ti, 1)
        else if (k === 2) blk = idxBlk(ti, 2)
        else { blk = pickBlk(ti, 'hot'); forWrite = write }
        // a non-HOT update also has to write every index entry
        if (write && !x.hot && k === 2) forWrite = true
      }
      const hit = touchPage(slot, ti, blk, forWrite, ring)
      b.buffersTouched++
      if (hit) b.buffersHit++
      else b.buffersRead++
    }
  }

  /** Commit accounting: tuples, WAL, dead rows, xids. */
  function finishStatement(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const ti = b.table
    const t = tables[ti]
    const rows = x.rowsPerStmt * x.txCount
    const tup = avgTuple[ti]
    const nIdx = t.def.indexes.length
    let bytes = 0

    switch (b.query) {
      case 'insert': {
        t.inserts += rows
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
          bytes += rows2 * (88 + tup)
        } else {
          addDead(ti, rows2)
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
        // DELETE writes a tiny WAL record — the index entries are cleaned up
        // later by vacuum, which is why deletes look cheap and then aren't.
        bytes += del * 64
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
      walInsert(bytes)
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
    x.commitLsn = wal.insertLsn
  }

  function endVisit(slot: number): void {
    const b = backends[slot]
    const x = extras[slot]
    const rb = Math.min(x.txCount, Math.round(x.txCount * 0.003 + (rng() < 0.02 ? 1 : 0)))
    stats.rollbacks += rb
    stats.commits += x.txCount - rb
    commitsAcc += x.txCount - rb
    visitsAcc++
    // The transaction is over: its xid is no longer live, so the backend stops
    // holding back the xmin horizon.
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
    if (!x.holdsLock && stats.activeBackends > 3 && rng() < clamp(x.txCount / 300, 0.004, 0.6)) {
      b.state = 'ending'
      b.stateDur = 0.18
    }
    if (++sBufReq >= 2) {
      sBufReq = 0
      flow(rid.result(slot), 1, 'result', 1.0)
      flow(rid.bufRet(slot), 1, 'result', 1.0)
    }
  }

  function forkBackend(): boolean {
    if (forkCooldown > 0) return false
    let slot = -1
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      if (!backends[i].active) { slot = i; break }
    }
    if (slot < 0 || slot >= state.maxConnections) return false
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
    state.forkPulse = Math.min(3, state.forkPulse + 1)
    forkCooldown = 0.14
    flow('conn.in', 1, 'fork', 1.4)
    flow(rid.fork(slot), 2, 'fork', 1.6)
    return true
  }

  function tickBackends(dt: number): void {
    let activeN = 0
    for (let slot = 0; slot < N_BACKEND_SLOTS; slot++) {
      const b = backends[slot]
      const x = extras[slot]
      if (!b.active) continue
      activeN++
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
          if (pendingTx > 0) startVisit(slot)
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
                pageBudget += x.pagesLeft
                drainPages(slot, x.execTotal)
              }
              if (x.needsSort) {
                b.state = 'sort'
                b.stateT = 0
                b.stateDur = rr(0.12, 0.34)
              } else if (x.writes) {
                b.state = 'wal_insert'
                b.stateT = 0
                b.stateDur = rr(0.03, 0.07)
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
              b.state = 'wal_insert'
              b.stateT = 0
              b.stateDur = rr(0.03, 0.07)
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
            finishStatement(slot)
            b.state = 'commit_wait'
            b.stateT = 0
            b.stateDur = commitWaitEstimate()
            if (K.synchronousCommit !== 'off') requestFlush(x.commitLsn)
          }
          break

        case 'commit_wait': {
          const sc = K.synchronousCommit
          let done = false
          if (sc === 'off') {
            // Commit returns immediately; the WAL is written by walwriter later.
            // Crash here and you lose the last few hundred ms of transactions.
            done = b.stateT >= 0.012
          } else if (sc === 'remote_apply' && rep.connected) {
            done = wal.flushLsn >= x.commitLsn && rep.replayLsn >= x.commitLsn
          } else {
            if (sc === 'remote_apply' && !rep.connected && state.t - degradeWarnT > 20) {
              degradeWarnT = state.t
              toast('synchronous_commit=remote_apply with no standby — degrading to local flush', 'warn', 6000)
            }
            done = wal.flushLsn >= x.commitLsn
          }
          if (b.stateT > 8) done = true // watchdog: never wedge the city
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
    }
    stats.activeBackends = activeN
  }

  function commitWaitEstimate(): number {
    switch (K.synchronousCommit) {
      case 'off':
        return 0.012
      case 'local':
      case 'on':
        return 0.14
      case 'remote_apply':
        return 0.14 + (K.replicaNetworkLag * NET_STRETCH * 2) / 1000 + 0.12
    }
  }

  /* ======================================================================
   * POSTMASTER
   * ====================================================================*/

  function tickPostmaster(dt: number): void {
    forkCooldown -= dt
    state.forkPulse = damp(state.forkPulse, 0, 3.2, dt)
    if (pendingTx <= 0) return
    let idle = 0
    let active = 0
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = backends[i]
      if (!b.active) continue
      active++
      if (b.state === 'idle') idle++
    }
    if (idle > 0) return
    if (active < state.maxConnections) {
      forkBackend()
      return
    }
    // At max_connections the queue IS the story: latency, not throughput. The
    // old cap was `maxConnections * batchSize * 2`, and batchSize was the
    // controller's output — so the backlog grew the ceiling with it, the queue
    // could never get deep, and the "too many clients" toast fired on a
    // quantity that could not grow. Ten seconds of offered load is a real
    // client-side queue; past that the clients are being refused.
    const cap = Math.max(state.maxConnections * batchSize * 2, K.tps * 10)
    if (pendingTx > cap) {
      refusedTx += pendingTx - cap
      pendingTx = cap
      if (state.t - refuseWarnT > 15) {
        refuseWarnT = state.t
        toast(
          `FATAL: sorry, too many clients already — ${Math.round(refusedTx).toLocaleString()} refused`,
          'warn',
          5000,
        )
      }
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
      wal.bytesPerSec = damp(wal.bytesPerSec, walAcc / iv, 3, iv)
      stats.walBytesPerSec = wal.bytesPerSec
      stats.ioReadPerSec = damp(stats.ioReadPerSec, ioReadAcc / iv, 3, iv)
      stats.ioWritePerSec = damp(stats.ioWritePerSec, ioWriteAcc / iv, 3, iv)
      bgw.cleanedPerSec = damp(bgw.cleanedPerSec, cleanedAcc / iv, 3, iv)
      visitRate = damp(visitRate, visitsAcc / iv, 1.6, iv)
      // fpwBurst decays as the working set pays off its full-page images
      const fpiRatio = walAcc > 0 ? clamp01(fpiAcc / walAcc) : 0
      wal.fpwBurst = damp(wal.fpwBurst, fpiRatio, 0.7, iv)

      const seen = winHits + winMisses
      // ~2s smoothing: a single 200-page analytics scan should nudge the gauge,
      // not slam it.
      if (seen > 8) buf.hitRatio = damp(buf.hitRatio, winHits / seen, 0.7, iv)
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
      visitsAcc = 0
      winHits = 0
      winMisses = 0
    }

    histT += dt
    if (histT >= 0.25) {
      histT = 0
      const h = stats.history
      pushHistory(h.tps, stats.tps)
      pushHistory(h.hit, stats.cacheHitPct)
      pushHistory(h.wal, wal.bytesPerSec)
      pushHistory(h.dirty, buf.dirtyCount)
      pushHistory(h.lag, rep.lagSec)
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
    beatIdx = 0
    bus.emit('scenario', { id: def.id })
    if (def.focus) bus.emit('focus', { id: def.focus })
    if (def.beats && def.beats.length && def.beats[0][0] <= 0) {
      bus.emit('narrate', { title: def.beats[0][1], body: def.beats[0][2], ms: 9000 })
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
    state.scenarioT += dt
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
        bus.emit('narrate', { title: b[1], body: b[2], ms: 9000 })
        beatIdx++
      }
    }
    if (def.duration > 0 && state.scenarioT >= def.duration) endScenario(false)
  }

  /* ======================================================================
   * KNOBS
   * ====================================================================*/

  function setKnob<Key extends keyof Knobs>(key: Key, value: Knobs[Key]): void {
    K[key] = value

    switch (key) {
      case 'sharedBuffers':
        resizePool(K.sharedBuffers)
        K.sharedBuffers = buf.size
        break
      case 'tps':
        K.tps = Math.max(0, K.tps)
        nextArrival = 0
        // The batch scale follows the offered rate, so it moves with the slider
        // rather than 250ms later.
        sizeBatch()
        break
      case 'bgwriterEnabled':
        bgw.enabled = K.bgwriterEnabled
        if (!K.bgwriterEnabled) toast('bgwriter off — backends will now write out their own victims', 'warn')
        break
      case 'autovacuum':
        av.enabled = K.autovacuum
        if (!K.autovacuum) toast('autovacuum off — dead tuples will accumulate', 'warn')
        break
      case 'checkpointTimeout':
        ckpt.nextInSec = Math.min(ckpt.nextInSec, K.checkpointTimeout)
        break
      case 'longRunningXact':
        if (K.longRunningXact) {
          horizonFrozen = true
          horizonXid = state.xid
          horizonT = state.t
          toast('BEGIN; SELECT … — an old snapshot is now pinning the xmin horizon', 'warn', 6000)
        } else {
          horizonFrozen = false
          horizonXid = state.xid
          // everything dead is suddenly removable again
          for (let i = 0; i < N_TABLES; i++) deadRemovable[i] = tables[i].deadTuples
          toast('COMMIT — horizon released, vacuum can clean up now', 'good', 5000)
        }
        break
      case 'lockContention':
        if (!K.lockContention) releaseLock()
        break
      case 'replicaEnabled':
      case 'walLevel':
        rep.logicalEnabled = K.walLevel === 'logical'
        break
      case 'fullPageWrites':
        fpiDone.clear()
        if (!K.fullPageWrites) {
          wal.fpwBurst = 0
          toast('full_page_writes=off — smaller WAL, and torn pages on crash', 'warn', 6000)
        }
        break
      case 'synchronousCommit':
        if (K.synchronousCommit === 'off') toast("synchronous_commit=off — commits no longer wait for fsync", 'warn', 5000)
        break
      case 'timeScale':
        K.timeScale = clamp(K.timeScale, 0.05, 20)
        break
      default:
        break
    }

    if (!applying) {
      applying = true
      bus.emit('knob', { key, value })
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

    tickScenario(dt)

    // client arrivals — Poisson at knobs.tps
    nextArrival -= dt
    let guard = 900
    while (nextArrival <= 0 && guard-- > 0) {
      pendingTx++
      const d = expDelay(K.tps, rng)
      if (!isFinite(d)) { nextArrival = 1e9; break }
      nextArrival += d
    }

    tickPostmaster(dt)
    tickLocks(dt)
    tickBackends(dt)
    tickBgwriter(dt)
    tickCheckpoint(dt)
    tickWal(dt)
    tickReplication(dt)
    tickAutovac(dt)
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

    tickStats(dt)
  }

  function update(dt: number): void {
    if (!isFinite(dt) || dt <= 0) return
    if (K.paused) return
    // What arrives here is the caller's already-clamped frame delta multiplied
    // by the speed knob. Re-clamping it to 0.1 is what used to make the knob a
    // silent no-op below ~50 fps: at 10 fps the frame delta is already 0.1, so
    // every multiplier collapsed to 1x. Sub-step instead — STEP_MAX bounds each
    // step, MAX_STEPS bounds the total work one frame can ask for.
    const cap = STEP_MAX * MAX_STEPS
    const d = dt > cap ? cap : dt
    state.realT += d / Math.max(0.05, K.timeScale)
    const steps = d > STEP_MAX ? Math.ceil(d / STEP_MAX) : 1
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
    state.maxConnections = N_BACKEND_SLOTS
    state.scenario = null
    state.scenarioT = 0
    state.forkPulse = 0
    state.locks.length = 0

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
    buf.size = K.sharedBuffers
    buf.valid.fill(0)
    buf.dirty.fill(0)
    buf.pinned.fill(0)
    buf.usage.fill(0)
    buf.rel.fill(255)
    buf.blk.fill(0)
    buf.lastTouch.fill(-99)
    pinT.fill(-99)
    fpiDone.clear()
    buf.clockHand = 0
    buf.hits = 0
    buf.misses = 0
    buf.evictions = 0
    buf.dirtyEvictions = 0
    buf.hitRatio = 0.9
    buf.dirtyCount = 0
    buf.pinnedCount = 0
    buf.usedCount = 0

    const lsn0 = 0x1a000000
    wal.insertLsn = wal.writeLsn = wal.flushLsn = lsn0
    wal.bufferBytes = 0
    wal.bufferCapacity = WAL_BUF_CAP
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
    archSlot = -1
    archT = 0
    flushing = false
    flushTarget = lsn0
    flushT = 0
    flushBytes = 0
    walWriterT = 0

    ckpt.phase = 'idle'
    ckpt.progress = 0
    ckpt.buffersToWrite = 0
    ckpt.buffersWritten = 0
    ckpt.nextInSec = K.checkpointTimeout * 0.62
    ckpt.elapsed = 0
    ckpt.lastDuration = 0
    ckpt.reason = 'time'
    ckpt.count = 0
    ckpt.redoLsn = lsn0

    bgw.enabled = K.bgwriterEnabled
    bgw.scanPos = 0
    bgw.cleanedTotal = 0
    bgw.cleanedPerSec = 0
    bgw.activity = 0

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
      w.travel = 0
      w.deadCollected = 0
      w.stalledByHorizon = false
      vacPhaseT[i] = 0
      vacPhaseDur[i] = 1
      vacIdxLeft[i] = 0
      vacTarget[i] = 0
    }

    for (let i = 0; i < N_TABLES; i++) {
      const t = tables[i]
      const d = TABLES[i]
      t.pages = d.pages
      t.liveTuples = d.pages * d.tuplesPerPage
      // The city is a database that has been up for a while, not one that was
      // loaded a second ago, so the tables already carry dead versions. sessions
      // starts just under its threshold: autovacuum has a bay to open in the
      // first half minute at any transaction rate, which is the only way the
      // yard introduces itself before a visitor has stopped looking at it.
      const seed = d.id === 'events' ? 0 : Math.round((50 + K.autovacuumScaleFactor * t.liveTuples) * (d.id === 'sessions' ? 0.94 : 0.45))
      t.deadTuples = seed
      deadRemovable[i] = seed
      t.bloat = 0
      t.vacuumThreshold = 50 + K.autovacuumScaleFactor * t.liveTuples
      t.lastVacuum = 0
      t.seqScans = 0
      t.idxScans = 0
      t.inserts = 0
      t.updates = 0
      t.hotUpdates = 0
      t.deletes = 0
      t.heat = 0
      t.vacuuming = false
    }

    rep.enabled = K.replicaEnabled
    rep.connected = K.replicaEnabled
    rep.mode = 'async'
    rep.sentLsn = rep.writeLsn = rep.flushLsn = rep.replayLsn = lsn0
    rep.lagBytes = 0
    rep.lagSec = 0
    rep.networkLagMs = K.replicaNetworkLag
    rep.applyActivity = 0
    rep.logicalEnabled = K.walLevel === 'logical'
    rep.logicalSlotLsn = lsn0
    rep.logicalChangesPerSec = 0
    rep.inFlight = 0
    wireHead = wireTail = wireCount = 0

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
    stats.ioWritePerSec = 0
    stats.cacheHitPct = 90
    stats.activeBackends = 0
    stats.history.tps.length = 0
    stats.history.hit.length = 0
    stats.history.wal.length = 0
    stats.history.dirty.length = 0
    stats.history.lag.length = 0

    pendingTx = 0
    nextArrival = 0
    refusedTx = 0
    sizeBatch()
    visitRate = 4
    visitsAcc = commitsAcc = walAcc = fpiAcc = ioReadAcc = ioWriteAcc = 0
    winHits = winMisses = 0
    rateT = histT = 0
    cleanedAcc = 0
    lockHolder = -1
    lockTimeout = LOCK_TIMEOUT_DEFAULT
    horizonFrozen = false
    horizonXid = state.xid
    horizonT = 0
    degradeWarnT = -100
    refuseWarnT = -100
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

  /* ---- bus plumbing: tolerate a UI that drives us through events -------- */

  bus.on('knob', (p) => {
    if (applying) return
    applying = true
    setKnob(p.key, p.value as Knobs[keyof Knobs])
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

  return { state, update, setKnob, runScenario, reset }
}
