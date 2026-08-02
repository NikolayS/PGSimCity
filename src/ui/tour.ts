import '../styles/tour.css'

import type { Knobs, QueryKind, TracePlayback, TraceStop, TourChapter } from '../core/types'
import { CLAIM_VALUES } from '../core/claims'
import { mdToHtml } from './content'
import { clamp } from '../core/util'
import { MODEL_TIME_STRETCH, sqlFor } from '../sim/model'
import { SCENARIO_NARRATION_SECONDS } from '../sim/scenarios'
import { MODE_IDS } from './mode-exits'
import { TABLES } from '../world/layout'
import { TRACE_COPY } from './trace-copy'
import { createTraceDwell } from './trace-dwell'
import { el, icon, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — THE GUIDED TOUR
 *
 * Fourteen chapters that tell one story: a connection arrives, becomes a
 * process, becomes a plan, reads a page, writes a WAL record, commits, gets
 * checkpointed, leaves a corpse behind, gets vacuumed — or does not — and ends
 * up on a second machine. Each chapter frames one component, may set knobs or
 * run a scenario to make its point, and hands the city back exactly as it
 * found it when the tour ends.
 *
 * The same lower-third card is reused for scenario narration when the tour is
 * NOT running, so the city only ever speaks in one voice.
 *
 * Keyboard: none of it is bound here. The HUD owns the single global key map;
 * its T key emits 'tour:start' / 'tour:stop', and its Escape handler offers the
 * key to every overlay first (through the shared { handled } payload) before
 * stopping the tour — which is exactly the precedence we want, so the palette
 * on top of the tour closes before the tour behind it does.
 *
 * Copy rules: two to four sentences, no jargon that has not been introduced,
 * and every chapter ends with something specific to watch.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * A chapter, plus the two things a cinematic needs that the frozen
 * TourChapter contract does not carry: mid-chapter knob beats (so chapter 11
 * can release the long-running transaction while you are still looking at it)
 * and mid-chapter camera moves (so chapter 12 can follow a WAL record from the
 * sender, across the wire, to the standby's startup process).
 *
 * CHAPTERS is exported as plain TourChapter[] — the extra fields are private
 * to the runner in this file.
 * -------------------------------------------------------------------------*/

interface TourStep extends TourChapter {
  /** knob changes applied partway through: [atSecond, knobs] */
  at?: [number, Partial<Knobs>][]
  /** extra camera moves partway through: [atSecond, componentId] */
  look?: [number, string][]
}

interface TraceChoice {
  kind: QueryKind
  table: number
  label: string
  hot?: boolean
}

const tableIndex = (id: string): number => TABLES.findIndex((table) => table.id === id)

const TRACE_CHOICES: readonly TraceChoice[] = [
  { kind: 'select_idx', table: tableIndex('accounts'), label: 'Point SELECT' },
  { kind: 'select_seq', table: tableIndex('sessions'), label: 'Sequential scan' },
  { kind: 'aggregate', table: tableIndex('orders'), label: 'Aggregate' },
  { kind: 'insert', table: tableIndex('orders'), label: 'INSERT' },
  { kind: 'update', table: tableIndex('sessions'), label: 'Non-HOT UPDATE', hot: false },
  { kind: 'delete', table: tableIndex('sessions'), label: 'DELETE' },
]

const TRACE_FOCUS: Record<TraceStop, string> = {
  connect: 'postmaster',
  parse_plan: 'planner.planner',
  fetch: 'shared.buffers',
  work: 'backend.row',
  wal: 'wal.buffers',
  commit: 'wal.vault',
  send: 'client.pool',
  done: 'backend.row',
  blocked: 'lock.manager',
}

const STEPS: TourStep[] = [
  {
    id: 'connect',
    title: 'A client connects',
    body:
      'Everything starts with a TCP connection. On PostgreSQL the postmaster accepts the socket, starts a child process, and leaves the client path while that child handles startup and authentication. The city starts one modeled backend and uses the pulse to stand in for that whole exchange; authentication itself is not simulated. Watch the pulse leave the tower and land in the row of buildings ahead.',
    focus: 'client.pool',
    duration: 16,
    knobs: { tps: 140, writeRatio: 0.3, updateRatio: 0.6, seqScanRatio: 0.15, timeScale: 1, paused: false },
    look: [[8, 'postmaster']],
  },
  {
    id: 'backend',
    title: 'One process per connection',
    body:
      'On PostgreSQL that fork is a whole operating-system process with private memory and a mapping of the shared segment. The city models one occupied slot and activity phase per connection; it does not allocate process memory, charge scheduler or ProcArray costs, or model work_mem. Watch the colour of each block — it tells you the modeled phase or wait.',
    focus: 'backend.row',
    duration: 16,
  },
  {
    id: 'plan',
    title: 'The query becomes a plan',
    body:
      'PostgreSQL normally parses SQL, expands rules and views, and costs competing paths. This city does not run those algorithms: one of six fixed single-table statement kinds selects a plan template, with no joins, statistics-driven estimates, or cost-driven choice. Watch that model plan template assemble above the lab and then drive the page-access animation.',
    focus: 'planner.planner',
    duration: 16,
    look: [[10, 'planner.plantree']],
  },
  {
    id: 'buffers',
    title: 'Reading a page: the cache',
    body:
      'Postgres reads the whole 8 KiB page containing a row into shared_buffers, represented by the sampled frames in the lit plaza, and every backend then reads that shared copy. Blue tiles match durable storage; the sweeping hand is the clock algorithm looking for a reusable frame. A shared-buffer miss makes PostgreSQL issue a read, but the operating-system page cache may satisfy it without physical device I/O. Large sequential scans above a quarter of shared_buffers use PostgreSQL 18’s bulk-read ring to limit cache pollution; with 18.3 defaults it starts at 256 KiB, grows to about 2.25 MiB for I/O concurrency, and remains capped. The city’s fixed sampled ring visualizes that isolation mechanism but not PostgreSQL 18’s dynamic size.',
    focus: 'shared.buffers',
    duration: 18,
    knobs: { seqScanRatio: 0.12 },
  },
  {
    id: 'page',
    title: 'What a page actually is',
    body:
      'Underneath the city is the data directory: ordinary files on an ordinary filesystem, cut into 8 KiB pages. A page holds a small header, a list of pointers at the front, and rows packed in from the back — which is how a row can move inside its page without a single index noticing. Watch one page ride the green road up into the plaza. That climb represents a shared-buffer miss; PostgreSQL’s counters cannot tell whether the kernel then served it from RAM or a storage device.',
    focus: 'storage.table.accounts',
    duration: 16,
  },
  {
    id: 'wal',
    title: 'Writing: WAL to disk before the page',
    body:
      'Now something changes a row. Postgres does not go and edit the file on disk — it edits the page in memory and writes a short description of the edit into the write-ahead log (WAL). WAL first, then data: the WAL record describing a change reaches durable storage before the changed page itself ever does, and that single ordering is the entire reason a crash cannot lose work you were told was committed. Watch the amber stream leave the plaza heading east, long before anything travels down to storage.',
    focus: 'wal.buffers',
    duration: 18,
    knobs: { writeRatio: 0.55, updateRatio: 0.6 },
    look: [
      [9, 'walwriter'],
      [14, 'wal.vault'],
    ],
  },
  {
    id: 'commit',
    title: 'Commit, and what fsync costs',
    body:
      'A durable commit does not wait for data pages; it waits for the WAL record describing the change to be flushed. We have set `synchronous_commit` to off, so PostgreSQL may acknowledge commits before that flush. In the city, watch modeled `commit_wait` occupancy and the deliberately stretched model duration fall; it is not a production latency measurement. The real trade is that the last fraction of a second of acknowledged transactions may be lost after a PostgreSQL server crash, operating-system crash or power failure.',
    focus: 'walwriter',
    duration: 20,
    knobs: { synchronousCommit: 'off', tps: 600, writeRatio: 0.7 },
  },
  {
    id: 'checkpoint',
    title: 'Checkpoints, WAL and I/O',
    body:
      `The WAL cannot grow forever, so the checkpointer periodically walks the buffer pool and writes the pages that were dirty when it began. We have deliberately made the WAL ceiling (\`max_wal_size\`) tiny, so modeled checkpoints now fire back to back. Watch the pink checkpoint writes and the amber full-page-image surge, then open Latency to compare p50 and p99 and read the p99 wait anatomy. Those values are deliberately stretched ${CLAIM_VALUES.modelLatency.unit}, not production milliseconds.`,
    focus: 'checkpointer',
    duration: 22,
    scenario: 'checkpoint-storm',
    knobs: { synchronousCommit: 'on' },
    look: [[13, 'wal.vault']],
  },
  {
    id: 'mvcc',
    title: 'MVCC: updates leave corpses',
    body:
      'An UPDATE does not overwrite the old version’s user-column values. It writes a new row version and changes the old tuple header to mark it superseded, because an older transaction may still be entitled to the old value. Ordinary snapshot reads and ordinary row-version changes do not block each other merely for visibility, although explicit locks and row-locking operations still can. Autovacuum has just been switched off: watch the sessions table accumulate obsolete versions while routine cleanup pauses.',
    focus: 'storage.table.sessions',
    duration: 18,
    scenario: 'bloat-and-vacuum',
  },
  {
    id: 'vacuum',
    title: 'Autovacuum cleans up',
    body:
      `Vacuum is the other half of that bargain. The launcher never inspects a table — it sends a worker into one database at a time. The worker reads the statistics, finds the tables holding more dead row versions than their threshold allows, and goes to work: one pass over the table, one pass over every index it owns, then back to free the space. Watch a violet worker travel to the table and the bloat bar fall behind it. ${CLAIM_VALUES.vacuumReclaim.rule} The city uses a tail-density heuristic and does not model the lock needed for real truncation.`,
    focus: 'autovac.worker.0',
    duration: 18,
    knobs: { autovacuum: true, autovacuumScaleFactor: 0.08 },
  },
  {
    id: 'horizon',
    title: 'When vacuum cannot: the horizon',
    body:
      'Now the expensive mistake. Somebody typed BEGIN, took a snapshot of the database, and went to lunch. Vacuum may not remove any row version that snapshot could still need, so the horizon — the oldest transaction anyone can still see — stops moving, and every table taking writes grows with no brake on it. The workers still run. They collect nothing. After a short look we let that transaction go: watch the horizon jump forward and the entire backlog become collectable at once.',
    focus: 'xmin.horizon',
    duration: 22,
    knobs: { longRunningXact: true },
    at: [[12, { longRunningXact: false }]],
  },
  {
    id: 'stream',
    title: 'Streaming to a standby',
    body:
      'The same write-ahead log that makes a commit durable feeds PostgreSQL standbys. The city tracks independent sent, written, flushed and replayed LSNs for two nodes and animates records along their routes; it does not keep a second copy of table rows or pages. Watch standby A’s modeled record leave the vault, cross the wire, and advance its replay frontier.',
    focus: 'walsender',
    duration: 20,
    knobs: { standbyAEnabled: true, walLevel: 'replica', standbyASlowApply: false, standbyANetworkLag: 30 },
    look: [
      [8, 'net.wire'],
      [14, 'startup.proc'],
    ],
  },
  {
    id: 'lag',
    title: 'Lag, and the four LSNs',
    body:
      '`pg_stat_replication` on the primary carries four positions, and confusing them is the most common mistake in Postgres monitoring: what the primary has sent, and — reported back by the standby — what it has written, what it has flushed to its own disk, and what it has actually replayed: `sent_lsn`, `write_lsn`, `flush_lsn` and `replay_lsn`. Only the last one is visible to a query running on the replica. Replay is a single process, and your primary produced that WAL with sixteen backends at once. Watch sent keep pace while replayed slides away from it — that gap is your replication lag.',
    focus: 'replica.standby',
    duration: 20,
    scenario: 'replication-lag',
  },
  {
    id: 'city',
    title: 'The whole city again',
    body:
      'That is the core query and maintenance loop. Occupy a backend slot, select a fixed plan template, pull sampled pages into memory, write WAL before dirty data pages, flush that WAL, write pages later, collect modeled dead-version counts, and advance two standby LSN pipelines. The wider city also models backup, archive, recovery, failover, and operator decisions. The console on the left drives the model — break something, and watch which measured counter or route changes.',
    focus: 'world.ground',
    duration: 18,
    scenario: null,
    knobs: { tps: 240, writeRatio: 0.3, updateRatio: 0.55, seqScanRatio: 0.12, synchronousCommit: 'on', autovacuum: true },
  },
]

/** The guided tour, in order. */
export const CHAPTERS: TourChapter[] = STEPS

/* ---------------------------------------------------------------------------
 * Small local helpers.
 * -------------------------------------------------------------------------*/

const SEEN_KEY = 'pgsimcity.seen'
/** The invitation is an offer, not a fixture: it shows itself out. */
const FIRST_RUN_LIFE_MS = 40000
type KnobKey = keyof Knobs
type LooseSet = (key: KnobKey, value: Knobs[KnobKey]) => void

function hasSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) != null
  } catch {
    // storage blocked: treat it as "already seen" so we never nag on every load
    return true
  }
}

function markSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    /* private mode — the prompt simply comes back next time */
  }
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export function createTour(ctx: UiContext): UiModule {
  const bus = ctx.bus
  const sim = ctx.sim
  const layer = document.getElementById('tour-layer') ?? el('div')
  const cleanup: (() => void)[] = []

  // setKnob is generic over one key; the chapters are generic over all of them.
  // Bound, so it keeps working if SimApi ever becomes a class.
  const setKnob = sim.setKnob.bind(sim) as unknown as LooseSet

  /* ------------------------------ live state ----------------------------- */

  let running = false
  let playing = false
  let index = 0
  let stageElapsed = 0
  let playElapsed = 0
  let atIdx = 0
  let lookIdx = 0
  let paintAcc = 0

  /** Everything the tour touched, and what the knobs were before it started. */
  let baseline: Knobs | null = null
  const touched = new Set<KnobKey>()
  let ranScenario = false
  const stageSnapshots: ({ knobs: Knobs; scenario: string | null } | undefined)[] =
    new Array(STEPS.length)

  /** True once the viewer grabs the camera; cleared when the next chapter starts. */
  let userControl = false

  /* =======================================================================
   * THE CAPTION CARD
   * =====================================================================*/

  const numEl = el('span', { class: 'tour-card__n', text: '1' })
  const ofEl = el('span', { class: 'tour-card__of', text: `of ${STEPS.length}` })
  const eyebrow = el('span', { class: 'pg-eyebrow tour-card__eyebrow', text: 'Guided tour' })
  const titleEl = el('h2', { class: 'tour-card__title', text: STEPS[0].title })
  const bodyEl = el('p', { class: 'pg-body tour-card__body', html: mdToHtml(STEPS[0].body) })
  const clockEl = el('span', { class: 'tour-card__clock', text: 'Your pace' })

  const deckBtn = (name: string, className: string, label: string, onClick: () => void): HTMLButtonElement =>
    el(
      'button',
      {
        class: `pg-btn pg-btn--icon tour-btn ${className}`,
        type: 'button',
        title: label,
        'aria-label': label,
        on: { click: onClick },
      },
      icon(name, 14),
    )

  const prevBtn = deckBtn('prev', 'tour-prev', 'Previous chapter', () => goTo(index - 1))
  const playIcon = el('span', { class: 'tour-btn__icon' }, icon('play', 14))
  const playLabel = el('span', { text: 'Play' })
  const playBtn = el(
    'button',
    {
      class: 'pg-btn tour-btn tour-btn--play',
      type: 'button',
      title: 'Play tour automatically',
      'aria-label': 'Play tour automatically',
      'aria-pressed': 'false',
      on: { click: () => setPlaying(!playing) },
    },
    playIcon,
    playLabel,
  )
  const nextLabel = el('span', { text: 'Next' })
  const nextBtn = el(
    'button',
    {
      class: 'pg-btn tour-btn tour-btn--next tour-next',
      type: 'button',
      title: 'Next chapter',
      'aria-label': 'Next chapter',
      on: { click: () => goTo(index + 1) },
    },
    nextLabel,
    icon('next', 14),
  )
  const exitBtn = el(
    'button',
    {
      class: 'pg-btn tour-btn tour-btn--exit',
      type: 'button',
      data: { modeExit: MODE_IDS.tour },
      title: 'End the tour and restore every setting  (Esc)',
      on: { click: () => bus.emit('tour:stop', {}) },
    },
    icon('close', 13),
    el('span', { text: 'Exit' }),
  )

  const steps = STEPS.map((s, i) =>
    el('button', {
      class: 'tour-step',
      type: 'button',
      title: `${i + 1}. ${s.title}`,
      'aria-label': `Chapter ${i + 1}: ${s.title}`,
      on: { click: () => goTo(i) },
    }),
  )
  const stepStrip = el('div', { class: 'tour-steps', role: 'group', 'aria-label': 'Chapters' }, ...steps)

  const barFill = el('i', { class: 'tour-bar__fill' })
  const card = el(
    'section',
    {
      class: 'tour-card pg-panel',
      role: 'region',
      'aria-label': 'Guided tour',
      'aria-live': 'polite',
    },
    el(
      'div',
      { class: 'tour-card__grid' },
      el('div', { class: 'tour-card__idx' }, numEl, ofEl),
      el('div', { class: 'tour-card__text' }, eyebrow, titleEl, bodyEl),
      el(
        'div',
        { class: 'tour-card__deck' },
        clockEl,
        el('div', { class: 'tour-card__btns' }, prevBtn, playBtn, nextBtn, exitBtn),
      ),
    ),
    stepStrip,
    el('div', { class: 'tour-bar' }, barFill),
  )

  /* =======================================================================
   * THE NARRATION CARD — scenario beats, when the tour is not running
   * =====================================================================*/

  const narrateEyebrow = el('span', { class: 'pg-eyebrow tour-narrate__eyebrow', text: 'Scenario' })
  const narrateTitle = el('h3', { class: 'tour-narrate__title', text: '' })
  const narrateBody = el('p', { class: 'pg-body tour-narrate__body', text: '' })
  const traceSql = el('code', { class: 'tour-narrate__sql' })
  const traceHint = el('p', { class: 'tour-narrate__hint' })
  const stretchText = el('span', { class: 'tour-narrate__stretch' })

  const traceModeButton = (mode: TracePlayback, label: string): HTMLButtonElement =>
    el('button', {
      class: `pg-btn tour-narrate__mode is-${mode}`,
      type: 'button',
      text: label,
      on: { click: () => setTracePlayback(mode) },
    })

  const stepTraceBtn = traceModeButton('step', 'Step')
  const slowTraceBtn = traceModeButton('slow', 'Slow')
  const liveTraceBtn = traceModeButton('live', 'Live')
  const traceAgainBtn = el('button', {
    class: 'pg-btn tour-narrate__again',
    type: 'button',
    text: 'Change one thing and run it again',
    on: { click: () => openTracePicker() },
  })
  const closeTraceBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon tour-narrate__close',
      type: 'button',
      title: 'End query trace',
      'aria-label': 'End query trace',
      on: { click: () => closeTrace() },
    },
    icon('close', 13),
  )
  const traceStrip = el(
    'div',
    { class: 'tour-narrate__strip' },
    el('div', { class: 'tour-narrate__modes', role: 'group', 'aria-label': 'Trace playback' },
      stepTraceBtn,
      slowTraceBtn,
      liveTraceBtn,
    ),
    stretchText,
    closeTraceBtn,
  )
  const narrateCard = el(
    'aside',
    { class: 'tour-narrate pg-panel', role: 'status', 'aria-live': 'polite' },
    narrateEyebrow,
    narrateTitle,
    narrateBody,
    traceSql,
    traceHint,
    traceStrip,
    traceAgainBtn,
  )

  let narrateTimer = 0
  let narrateUntil = 0
  let traceActive = false
  let traceAwaiting = false
  let traceMode: TracePlayback = 'slow'
  let paintedTraceStop: TraceStop | null = null
  let selectedTraceStop: TraceStop | null = null
  let traceBaseline: Knobs | null = null
  const traceTouched = new Set<KnobKey>()
  const traceDwell = createTraceDwell(sim.state.trace)

  const traceChoiceButtons = TRACE_CHOICES.map((choice) =>
    el(
      'button',
      {
        class: 'trace-picker__choice',
        type: 'button',
        on: { click: () => runTrace(choice) },
      },
      el(
        'span',
        { class: 'trace-picker__meta' },
        el('strong', { text: choice.label }),
        el('span', { text: TABLES[choice.table].name }),
      ),
      el('code', { text: sqlFor(choice.kind, choice.table) }),
    ),
  )
  const tracePicker = el(
    'div',
    {
      class: 'trace-picker',
      role: 'presentation',
      on: {
        pointerdown: (event: Event) => {
          if (event.target === tracePicker) dismissTracePicker()
        },
      },
    },
    el(
      'section',
      {
        class: 'trace-picker__dialog pg-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Choose a statement to trace',
      },
      el(
        'header',
        { class: 'trace-picker__head' },
        el(
          'div',
          {},
          el('span', { class: 'pg-eyebrow', text: 'Trace a query' }),
          el('h2', { text: 'Choose one honest model statement' }),
        ),
        el(
          'button',
          {
            class: 'pg-btn pg-btn--icon',
            type: 'button',
            title: 'Close statement picker',
            'aria-label': 'Close statement picker',
            on: { click: () => dismissTracePicker() },
          },
          icon('close', 14),
        ),
      ),
      el('p', {
        class: 'trace-picker__intro',
        text: 'These six statements are the complete v1 grammar. Free-text SQL would imply behavior the model does not have.',
      }),
      el('div', { class: 'trace-picker__grid' }, ...traceChoiceButtons),
    ),
  )
  tracePicker.hidden = true
  document.body.append(tracePicker)

  function traceSetKnob<Key extends KnobKey>(key: Key, value: Knobs[Key]): void {
    traceTouched.add(key)
    setKnob(key, value)
  }

  function restoreTraceKnobs(): void {
    if (traceBaseline) {
      for (const key of traceTouched) setKnob(key, traceBaseline[key])
    }
    traceTouched.clear()
    traceBaseline = null
  }

  function paintTracePlayback(): void {
    setClass(stepTraceBtn, 'is-active', traceMode === 'step')
    setClass(slowTraceBtn, 'is-active', traceMode === 'slow')
    setClass(liveTraceBtn, 'is-active', traceMode === 'live')
    const stretch = Math.round((1 / Math.max(0.001, sim.state.knobs.timeScale)) * MODEL_TIME_STRETCH)
    setText(
      stretchText,
      traceMode === 'step'
        ? `${stretch.toLocaleString()}× model stretch · paused between stops`
        : `${stretch.toLocaleString()}× model stretch`,
    )
  }

  function setTracePlayback(mode: TracePlayback): void {
    if (!traceActive) return
    traceMode = mode
    if (mode === 'slow') {
      traceSetKnob('timeScale', 0.05)
      traceSetKnob('paused', false)
    } else if (mode === 'live') {
      traceSetKnob('timeScale', 1)
      traceSetKnob('paused', false)
    }
    sim.setTraceMode(mode)
    paintTracePlayback()
  }

  function dismissTracePicker(): void {
    tracePicker.hidden = true
  }

  function openTracePicker(): void {
    if (running) bus.emit('tour:stop', {})
    hideFirstRun()
    tracePicker.hidden = false
    traceChoiceButtons[0]?.focus()
  }

  function runTrace(choice: TraceChoice): void {
    if (!traceBaseline) traceBaseline = { ...sim.state.knobs }
    if (traceActive) sim.endTrace()
    traceSetKnob('tps', 18)
    traceSetKnob('timeScale', 0.05)
    traceSetKnob('paused', false)
    traceMode = 'slow'
    sim.setTraceMode('slow')
    sim.request(choice.kind, choice.table, { hot: choice.hot })
    bus.emit('trace:run', {
      statement: choice.kind,
      table: TABLES[choice.table].id,
      playback: traceMode,
    })

    traceActive = true
    traceAwaiting = true
    paintedTraceStop = null
    selectedTraceStop = null
    narrateUntil = 0
    dismissTracePicker()
    hideNarrate(true)
    setClass(narrateCard, 'is-trace', true)
    setText(narrateEyebrow, 'Trace a query')
    setText(traceSql, sqlFor(choice.kind, choice.table))
    traceAgainBtn.hidden = true
    document.body.classList.add('pg-trace')
    bus.emit('focus', { id: 'world.ground' })
    paintTracePlayback()
  }

  function closeTrace(): void {
    dismissTracePicker()
    if (!traceActive) return
    traceActive = false
    traceAwaiting = false
    sim.endTrace()
    restoreTraceKnobs()
    setClass(narrateCard, 'is-trace', false)
    hideNarrate(true)
    document.body.classList.remove('pg-trace')
    bus.emit('select', { id: null, outlineOnly: true })
  }

  function showTraceCard(): void {
    setClass(narrateCard, 'is-out', false)
    setClass(narrateCard, 'is-live', true)
  }

  function paintTraceCard(stop: TraceStop): void {
    const copy = TRACE_COPY[stop]
    setText(narrateTitle, copy.title)
    setText(narrateBody, copy.line(sim.state.trace))
    setText(traceHint, copy.hint)
    traceAgainBtn.hidden = stop !== 'done'
    paintedTraceStop = stop
  }

  function updateTrace(dt: number, wallDt: number): void {
    if (!traceActive) return
    const trace = sim.state.trace
    if (trace.visited === 0) return
    if (traceAwaiting) {
      traceAwaiting = false
      traceDwell.reset(trace)
      showTraceCard()
    } else {
      traceDwell.update(trace, dt, wallDt)
    }
    if (paintedTraceStop !== traceDwell.stop) paintTraceCard(traceDwell.stop)
    if (selectedTraceStop !== trace.stop) {
      selectedTraceStop = trace.stop
      bus.emit('select', { id: TRACE_FOCUS[trace.stop], outlineOnly: true })
    }
  }

  function hideNarrate(instant = false): void {
    window.clearTimeout(narrateTimer)
    narrateTimer = 0
    narrateUntil = 0
    if (!narrateCard.classList.contains('is-live')) return
    if (instant) {
      setClass(narrateCard, 'is-live', false)
      setClass(narrateCard, 'is-out', false)
      return
    }
    setClass(narrateCard, 'is-out', true)
    narrateTimer = window.setTimeout(() => {
      setClass(narrateCard, 'is-live', false)
      setClass(narrateCard, 'is-out', false)
    }, 260)
  }

  function showNarrate(title: string, body: string, seconds: number): void {
    if (traceActive) return
    // Never two cards in the same corner. A scenario beat only happens because
    // somebody started a scenario, and starting one answers the invitation's
    // question — so the invitation stands down rather than stacking on top of
    // the narration that the viewer actually asked for.
    if (firstLive) hideFirstRun()
    window.clearTimeout(narrateTimer)
    setClass(narrateCard, 'is-trace', false)
    setText(narrateEyebrow, 'Scenario')
    setText(narrateTitle, title)
    setText(narrateBody, body)
    setClass(narrateCard, 'is-out', false)
    if (!narrateCard.classList.contains('is-live')) {
      narrateCard.classList.remove('is-enter')
      void narrateCard.offsetWidth
      narrateCard.classList.add('is-enter')
    }
    setClass(narrateCard, 'is-live', true)
    narrateUntil = sim.state.scenarioT + Math.max(1.2, seconds)
  }

  /* =======================================================================
   * FIRST-RUN PROMPT
   * =====================================================================*/

  let firstLive = false
  let firstTimer = 0

  const firstRun = el(
    'aside',
    { class: 'tour-first pg-panel', role: 'note' },
    el(
      'div',
      { class: 'tour-first__text' },
      el('span', { class: 'pg-eyebrow', text: 'First time here?' }),
      el('p', {
        class: 'tour-first__line',
        text: `Follow a query from connection to commit — ${STEPS.length} chapters, at your pace.`,
      }),
    ),
    el(
      'div',
      { class: 'tour-first__btns' },
      el(
        'button',
        {
          class: 'pg-btn tour-first__go',
          type: 'button',
          on: {
            click: () => {
              hideFirstRun()
              bus.emit('tour:start', { source: 'button' })
            },
          },
        },
        icon('tour', 13),
        el('span', { text: 'Start the tour' }),
      ),
      el(
        'button',
        {
          class: 'pg-btn pg-btn--ghost tour-first__no',
          type: 'button',
          text: 'Dismiss',
          on: { click: () => hideFirstRun() },
        },
      ),
    ),
  )

  function hideFirstRun(): void {
    window.clearTimeout(firstTimer)
    firstTimer = 0
    firstLive = false
    setClass(firstRun, 'is-live', false)
    document.body.classList.remove('pg-invite')
  }

  function showFirstRun(): void {
    if (running || hasSeen()) return
    markSeen()
    firstLive = true
    setClass(firstRun, 'is-live', true)
    // While this is up, nothing else speaks from the deck (see tour.css).
    document.body.classList.add('pg-invite')
    // An invitation nobody answers is just furniture. It leaves on its own.
    firstTimer = window.setTimeout(() => hideFirstRun(), FIRST_RUN_LIFE_MS)
  }

  layer.append(firstRun, narrateCard, card)

  showFirstRun()

  /* =======================================================================
   * KNOBS — apply on entry, restore on exit
   * =====================================================================*/

  function applyKnobs(partial: Partial<Knobs> | undefined): void {
    if (!partial) return
    for (const [key, value] of Object.entries(partial) as [KnobKey, Knobs[KnobKey]][]) {
      if (value === undefined) continue
      touched.add(key)
      setKnob(key, value)
    }
  }

  function restoreKnobs(): void {
    // The scenario goes first: sim.runScenario(null) puts back whatever it
    // saved, which may itself be a value this tour set. Our own baseline —
    // captured before the tour touched anything — always wins afterwards.
    if (ranScenario && sim.state.scenario) sim.runScenario(null)
    ranScenario = false
    if (baseline) {
      for (const key of touched) setKnob(key, baseline[key])
    }
    touched.clear()
    baseline = null
  }

  /* =======================================================================
   * CHAPTER TRANSPORT
   * =====================================================================*/

  function present(i: number): void {
    index = clamp(Math.round(i), 0, STEPS.length - 1)
    stageElapsed = 0
    playElapsed = 0
    atIdx = 0
    lookIdx = 0
    userControl = false

    const step = STEPS[index]
    if (step.focus) bus.emit('focus', { id: step.focus })

    paintChapter()
    paintTransport()
    bus.emit('tour:chapter', { index, total: STEPS.length, title: step.title })
  }

  function enter(i: number): void {
    index = clamp(Math.round(i), 0, STEPS.length - 1)
    const step = STEPS[index]

    // 1. scenario first — runScenario aims the camera at its own focus, and we
    //    want the chapter's framing to be the one that survives.
    if (step.scenario !== undefined) {
      if (step.scenario === null) {
        if (sim.state.scenario) sim.runScenario(null)
        ranScenario = false
      } else if (sim.state.scenario !== step.scenario) {
        sim.runScenario(step.scenario)
        ranScenario = true
      }
    }

    // 2. chapter knobs override anything the scenario just set
    applyKnobs(step.knobs)

    stageSnapshots[index] = {
      knobs: { ...sim.state.knobs },
      scenario: sim.state.scenario,
    }
    present(index)
  }

  function restoreStage(i: number, snapshot: { knobs: Knobs; scenario: string | null }): void {
    // A scenario owns a private knob baseline. Restarting it before restoring
    // the snapshot keeps that ownership coherent when a reader walks backward
    // across a scenario boundary.
    if (ranScenario && sim.state.scenario) sim.runScenario(null)
    ranScenario = false
    if (snapshot.scenario) {
      sim.runScenario(snapshot.scenario)
      ranScenario = true
    }
    applyKnobs(snapshot.knobs)
    present(i)
  }

  function goTo(i: number): void {
    if (!running) return
    if (i >= STEPS.length) {
      bus.emit('tour:stop', {})
      return
    }
    // Rewinding past the first chapter simply replays it.
    const target = clamp(Math.round(i), 0, STEPS.length - 1)
    const snapshot = stageSnapshots[target]
    if (snapshot) restoreStage(target, snapshot)
    else enter(target)
  }

  function setPlaying(next: boolean): void {
    playing = next
    playIcon.replaceChildren(icon(playing ? 'pause' : 'play', 14))
    setText(playLabel, playing ? 'Pause' : 'Play')
    playBtn.title = playing ? 'Pause automatic play' : 'Play tour automatically'
    playBtn.setAttribute('aria-label', playBtn.title)
    playBtn.setAttribute('aria-pressed', String(playing))
    setClass(playBtn, 'is-active', playing)
    setClass(card, 'is-playing', playing)
    paintTransport()
  }

  function start(chapter: number): void {
    if (traceActive) closeTrace()
    dismissTracePicker()
    const target = clamp(Math.round(chapter), 0, STEPS.length - 1)
    if (running) {
      goTo(target)
      return
    }
    running = true
    baseline = { ...sim.state.knobs }
    touched.clear()
    ranScenario = false
    stageSnapshots.fill(undefined)
    playing = false
    setPlaying(false)
    markSeen()
    hideFirstRun()
    hideNarrate(true)
    document.body.classList.add('pg-tour')
    setClass(card, 'is-live', true)
    card.classList.remove('is-enter')
    void card.offsetWidth
    card.classList.add('is-enter')
    enter(target)
  }

  function stop(): void {
    if (!running) return
    running = false
    setPlaying(false)
    setClass(card, 'is-live', false)
    document.body.classList.remove('pg-tour')
    restoreKnobs()
    bus.emit('toast', { text: 'Tour ended — every setting restored', kind: 'info', ms: 2400 })
  }

  /* =======================================================================
   * PAINT
   * =====================================================================*/

  function paintChapter(): void {
    const step = STEPS[index]
    setText(numEl, String(index + 1))
    setText(ofEl, `of ${STEPS.length}`)
    setText(titleEl, step.title)
    const bodyHtml = mdToHtml(step.body)
    if (bodyEl.innerHTML !== bodyHtml) bodyEl.innerHTML = bodyHtml
    setText(eyebrow, step.scenario ? 'Guided tour · scenario running' : 'Guided tour')
    prevBtn.disabled = index === 0
    const finishing = index === STEPS.length - 1
    setText(nextLabel, finishing ? 'Finish' : 'Next')
    nextBtn.title = finishing ? 'Finish tour' : 'Next chapter'
    nextBtn.setAttribute('aria-label', nextBtn.title)
    barFill.style.width = `${((index + 1) / STEPS.length) * 100}%`
    for (let i = 0; i < steps.length; i++) {
      setClass(steps[i], 'is-done', i < index)
      setClass(steps[i], 'is-now', i === index)
      if (i === index) steps[i].setAttribute('aria-current', 'step')
      else steps[i].removeAttribute('aria-current')
    }
  }

  function paintTransport(): void {
    const step = STEPS[index]
    const left = Math.max(0, step.duration - playElapsed)
    setText(clockEl, playing ? `${Math.ceil(left)}s` : 'Your pace')
  }

  /* =======================================================================
   * WIRING
   * =====================================================================*/

  const looseBus = bus
  cleanup.push(
    bus.on('tour:start', (p) => start(p && typeof p.chapter === 'number' ? p.chapter : 0)),
    bus.on('tour:stop', () => stop()),
    bus.on('trace:open', () => openTracePicker()),
    bus.on('narrate', (p) => {
      // While the tour is speaking, scenario beats stay quiet.
      if (running) return
      if (!p) {
        hideNarrate()
        return
      }
      showNarrate(p.title, p.body, p.seconds ?? SCENARIO_NARRATION_SECONDS)
    }),
    bus.on('camera:mode', () => {
      if (running) userControl = true
    }),
    looseBus.on('ui:escape', (payload) => {
      if (tracePicker.hidden) return
      dismissTracePicker()
      payload.handled = true
    }),
  )

  /* The viewer grabbing the camera is not a fight to win: note it, and stop
   * re-aiming until the next chapter takes over. */
  const grab = (): void => {
    if (running) userControl = true
  }
  const stage = document.getElementById('canvas-root') ?? document.body
  stage.addEventListener('pointerdown', grab, { capture: true, passive: true })
  stage.addEventListener('wheel', grab, { capture: true, passive: true })
  cleanup.push(() => {
    stage.removeEventListener('pointerdown', grab, { capture: true } as EventListenerOptions)
    stage.removeEventListener('wheel', grab, { capture: true } as EventListenerOptions)
  })

  const MOVE_KEYS = new Set([
    'w', 'a', 's', 'd', 'W', 'A', 'S', 'D', 'q', 'e', 'c', 'Q', 'E', 'C', ' ',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown',
  ])
  const onKey = (e: KeyboardEvent): void => {
    if (!running) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    if (MOVE_KEYS.has(e.key)) userControl = true
  }
  window.addEventListener('keydown', onKey)
  cleanup.push(() => window.removeEventListener('keydown', onKey))

  /* =======================================================================
   * TICK
   * =====================================================================*/

  function update(dt: number, wallDt = dt): void {
    updateTrace(dt, wallDt)
    if (narrateUntil > 0 && sim.state.scenarioT >= narrateUntil) hideNarrate()
    if (!running) return

    const step = STEPS[index]
    stageElapsed = Math.min(step.duration, stageElapsed + wallDt)

    // mid-chapter knob beats
    const at = step.at
    while (at && atIdx < at.length && stageElapsed >= at[atIdx][0]) {
      applyKnobs(at[atIdx][1])
      atIdx += 1
    }

    // mid-chapter camera moves, unless the viewer has taken the camera
    const look = step.look
    while (look && lookIdx < look.length && stageElapsed >= look[lookIdx][0]) {
      if (!userControl) bus.emit('focus', { id: look[lookIdx][1] })
      lookIdx += 1
    }

    if (!playing) return
    playElapsed += wallDt
    paintAcc += wallDt
    if (paintAcc >= 0.1) {
      paintAcc = 0
      paintTransport()
    }

    if (playElapsed >= step.duration) {
      if (index + 1 >= STEPS.length) bus.emit('tour:stop', {})
      else enter(index + 1)
    }
  }

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    window.clearTimeout(narrateTimer)
    window.clearTimeout(firstTimer)
    if (traceActive) {
      traceActive = false
      sim.endTrace()
      restoreTraceKnobs()
    }
    if (running) {
      running = false
      restoreKnobs()
    }
    document.body.classList.remove('pg-tour')
    document.body.classList.remove('pg-invite')
    document.body.classList.remove('pg-trace')
    card.remove()
    narrateCard.remove()
    firstRun.remove()
    tracePicker.remove()
  }

  paintChapter()
  paintTransport()

  return { update, dispose }
}
