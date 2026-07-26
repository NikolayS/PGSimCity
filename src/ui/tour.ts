import '../styles/tour.css'

import type { Knobs, TourChapter } from '../core/types'
import { clamp } from '../core/util'
import { el, icon, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — THE GUIDED TOUR
 *
 * Fourteen chapters that tell one story: a connection arrives, becomes a
 * process, becomes a plan, reads a page, writes a log record, commits, gets
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

const STEPS: TourStep[] = [
  {
    id: 'connect',
    title: 'A client connects',
    body:
      'Everything starts with a TCP connection. The postmaster has been listening since the server booted: it checks who you are, checks the database exists, and then does something no thread pool would ever do — it forks an entire new process to serve you, and steps out of the way. Watch the pulse leave the tower and land in the row of buildings ahead.',
    focus: 'client.pool',
    duration: 16,
    knobs: { tps: 140, writeRatio: 0.3, updateRatio: 0.6, seqScanRatio: 0.15, timeScale: 1, paused: false },
    spotlight: ['client.pool', 'postmaster', 'conn.gate'],
    look: [[8, 'postmaster']],
  },
  {
    id: 'backend',
    title: 'One process per connection',
    body:
      'That fork is a whole operating-system process, and it is yours alone until you disconnect. It gets private memory for sorting and hashing, plus a window onto the shared memory every other backend can see. This is why an idle connection is never free, and why every large deployment eventually puts a pooler in front of the database. Watch the colour of each block — it tells you what that process is waiting for, and most of the time it is waiting.',
    focus: 'backend.row',
    duration: 16,
    spotlight: ['backend.row', 'proc.array'],
  },
  {
    id: 'plan',
    title: 'The query becomes a plan',
    body:
      'Your SQL says what you want, never how to fetch it. The text is parsed into a tree, views and rules are expanded, and then the planner prices every strategy it can think of — this index, that join order, a full sweep of the table — using statistics about the data rather than the data itself. Watch the plan tree assemble above the lab: the shape it settles on is the difference between reading four pages and reading four thousand.',
    focus: 'planner.planner',
    duration: 16,
    spotlight: ['planner.lab', 'planner.planner', 'planner.plantree'],
    look: [[10, 'planner.plantree']],
  },
  {
    id: 'buffers',
    title: 'Reading a page: the cache',
    body:
      'Postgres never reads a single row off disk. It reads the whole 8 KiB page that contains it into shared_buffers — the lit plaza in the middle of the city — and every backend then reads that one copy. Blue tiles match what is on disk; the sweeping hand is the clock algorithm looking for a frame nobody wants any more. Watch the cache hit figure in the top bar. A tuned OLTP server sits above 99% because nearly every read lands on a tile that is already here; this city reads lower, because its workload also sweeps whole tables that were never going to fit. The seq-scan dial is what moves that number.',
    focus: 'shared.buffers',
    duration: 18,
    knobs: { seqScanRatio: 0.12 },
    spotlight: ['shared.buffers', 'buf.mapping'],
  },
  {
    id: 'page',
    title: 'What a page actually is',
    body:
      'Underneath the city is $PGDATA: ordinary files on an ordinary filesystem, cut into 8 KiB pages. A page holds a small header, a list of pointers at the front, and rows packed in from the back — which is how a row can move inside its page without a single index noticing. Watch one page ride the green road up into the plaza. That climb is precisely what a cache miss costs you.',
    focus: 'storage.table.accounts',
    duration: 16,
    spotlight: ['storage.datadir', 'storage.table.accounts', 'os.cache'],
  },
  {
    id: 'wal',
    title: 'Writing: the log comes first',
    body:
      'Now something changes a row. Postgres does not go and edit the file on disk — it edits the page in memory and writes a short description of the edit into the write-ahead log. Log first, then data: that single ordering is the entire reason a crash cannot lose work you were told was committed. Watch the amber stream leave the plaza heading east, long before anything travels down to storage.',
    focus: 'wal.buffers',
    duration: 18,
    knobs: { writeRatio: 0.55, updateRatio: 0.6 },
    spotlight: ['wal.buffers', 'walwriter', 'wal.vault'],
    look: [
      [9, 'walwriter'],
      [14, 'wal.vault'],
    ],
  },
  {
    id: 'commit',
    title: 'Commit, and what fsync costs',
    body:
      'A commit does not wait for your data pages to reach disk; those can sit in memory for minutes. It waits for the log record describing the change to be physically flushed, and that flush is an fsync — a real, mechanical, millisecond-scale wait that no amount of RAM removes. We have just set synchronous_commit to off, so nobody waits at all. Watch the queue at the log writer drain: that is the latency you bought, and the last fraction of a second of committed transactions you agreed to lose if the power fails.',
    focus: 'walwriter',
    duration: 20,
    knobs: { synchronousCommit: 'off', tps: 600, writeRatio: 0.7 },
    spotlight: ['walwriter', 'wal.vault', 'backend.row'],
  },
  {
    id: 'checkpoint',
    title: 'Checkpoints, and the spike',
    body:
      'The log cannot grow forever, so the checkpointer periodically walks the whole buffer pool and writes every modified page down to storage — after which the log before that point is no longer needed to recover. We have deliberately made the log ceiling tiny, so checkpoints now fire back to back. Watch two things: the pink flood down into the pit, and the amber surge right after each one, because the first change to any page after a checkpoint has to log the entire page. That loop is what your users feel as random latency spikes.',
    focus: 'checkpointer',
    duration: 22,
    scenario: 'checkpoint-storm',
    knobs: { synchronousCommit: 'on' },
    spotlight: ['checkpointer', 'shared.buffers', 'wal.vault', 'disk.array'],
    look: [[13, 'wal.vault']],
  },
  {
    id: 'mvcc',
    title: 'MVCC: updates leave corpses',
    body:
      'An UPDATE here does not overwrite anything. It writes a new version of the row and marks the old one dead, because an older transaction may still be entitled to see the old value — that is how readers never block writers and writers never block readers. The price is that every table accumulates versions nobody will ever read again. Autovacuum has just been switched off: watch the sessions table swell while nothing at all collects the debris.',
    focus: 'storage.table.sessions',
    duration: 18,
    scenario: 'bloat-and-vacuum',
    spotlight: ['storage.table.sessions', 'storage.table.accounts'],
  },
  {
    id: 'vacuum',
    title: 'Autovacuum cleans up',
    body:
      'Vacuum is the other half of that bargain. The launcher notices a table holds more dead rows than its threshold allows and sends a worker out: one pass over the table, one pass over every index it owns, then back to free the space. Watch a violet worker travel to the table and the bloat bar fall behind it. Notice what does not happen — the file does not shrink. The space inside it becomes reusable, which is all you actually needed.',
    focus: 'autovac.worker.0',
    duration: 18,
    knobs: { autovacuum: true, autovacuumScaleFactor: 0.08 },
    spotlight: ['autovac.launcher', 'autovac.worker.0', 'landfill'],
  },
  {
    id: 'horizon',
    title: 'When vacuum cannot: the horizon',
    body:
      'Now the expensive mistake. Somebody typed BEGIN, took a snapshot of the database, and went to lunch. Vacuum may not remove any row version that snapshot could still need, so the horizon — the oldest transaction anyone can still see — stops moving, and every table taking writes grows with no brake on it. The workers still run. They collect nothing. Halfway through this chapter we let that transaction go: watch the horizon jump forward and the entire backlog become collectable at once.',
    focus: 'xmin.horizon',
    duration: 22,
    knobs: { longRunningXact: true },
    at: [[12, { longRunningXact: false }]],
    spotlight: ['xmin.horizon', 'proc.array', 'autovac.worker.0'],
  },
  {
    id: 'stream',
    title: 'Streaming to a standby',
    body:
      'The same log that makes a commit durable is what keeps a second server alive. A walsender reads the log as it is written and pushes it down one TCP connection to the standby, where a single startup process replays it into an identical copy of every page. Nothing about your SQL crosses that wire — only the physical changes it produced. Watch a record leave the vault, cross the gap, and land.',
    focus: 'walsender',
    duration: 20,
    knobs: { replicaEnabled: true, walLevel: 'replica', replicaSlowApply: false, replicaNetworkLag: 30 },
    spotlight: ['walsender', 'net.wire', 'walreceiver', 'startup.proc'],
    look: [
      [8, 'net.wire'],
      [14, 'startup.proc'],
    ],
  },
  {
    id: 'lag',
    title: 'Lag, and the four LSNs',
    body:
      'A standby reports four positions, and confusing them is the most common mistake in Postgres monitoring: what the primary has sent, what the standby has written, what it has flushed to its own disk, and what it has actually replayed — `sent_lsn`, `write_lsn`, `flush_lsn` and `replay_lsn`. Only the last one is visible to a query running on the replica. Replay is a single process, and your primary produced that log with sixteen backends at once. Watch sent keep pace while replayed slides away from it — that gap is your replication lag.',
    focus: 'replica.standby',
    duration: 20,
    scenario: 'replication-lag',
    spotlight: ['replica.standby', 'startup.proc', 'replica.buffers'],
  },
  {
    id: 'city',
    title: 'The whole city again',
    body:
      'That is the entire machine. Fork a process, plan the query, pull pages into memory, log the change before making it, flush the log to keep the promise, write the pages out later, collect the dead versions, and ship the same log to a second copy. Every performance problem you will ever have in Postgres is one of those steps costing more than you expected. The console on the left drives all of it — break something, and watch which street goes quiet.',
    focus: 'world.ground',
    duration: 18,
    scenario: null,
    knobs: { tps: 240, writeRatio: 0.3, updateRatio: 0.55, seqScanRatio: 0.12, synchronousCommit: 'on', autovacuum: true },
    spotlight: ['world.ground'],
  },
]

/** The guided tour, in order. */
export const CHAPTERS: TourChapter[] = STEPS

const TOTAL_SECONDS = STEPS.reduce((n, c) => n + c.duration, 0)

/* ---------------------------------------------------------------------------
 * Small local helpers.
 * -------------------------------------------------------------------------*/

const SEEN_KEY = 'pgcity.seen'
const FIRST_RUN_DELAY_MS = 2800
const NARRATE_MS = 9000

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

/** "about 4 minutes" — derived from the chapters so the copy can never drift. */
function tourLength(): string {
  const mins = TOTAL_SECONDS / 60
  return mins < 1.5 ? `about ${Math.round(TOTAL_SECONDS / 10) * 10} seconds` : `about ${Math.round(mins)} minutes`
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export function createTour(ctx: UiContext): UiModule {
  const bus = ctx.bus
  const sim = ctx.sim
  const layer = document.getElementById('tour-layer') ?? el('div')
  const cleanup: (() => void)[] = []
  const timers: number[] = []

  // setKnob is generic over one key; the chapters are generic over all of them.
  // Bound, so it keeps working if SimApi ever becomes a class.
  const setKnob = sim.setKnob.bind(sim) as unknown as LooseSet

  /* ------------------------------ live state ----------------------------- */

  let running = false
  let held = false // tour-local pause: holds the chapter, nothing else
  let index = 0
  let elapsed = 0
  let atIdx = 0
  let lookIdx = 0
  let paintAcc = 0

  /** Everything the tour touched, and what the knobs were before it started. */
  let baseline: Knobs | null = null
  const touched = new Set<KnobKey>()
  let ranScenario = false

  /** True once the viewer grabs the camera; cleared when the next chapter starts. */
  let userControl = false

  /* =======================================================================
   * THE CAPTION CARD
   * =====================================================================*/

  const numEl = el('span', { class: 'tour-card__n', text: '01' })
  const ofEl = el('span', { class: 'tour-card__of', text: `/ ${STEPS.length}` })
  const eyebrow = el('span', { class: 'pg-eyebrow tour-card__eyebrow', text: 'Guided tour' })
  const titleEl = el('h2', { class: 'tour-card__title', text: STEPS[0].title })
  const bodyEl = el('p', { class: 'pg-body tour-card__body', text: STEPS[0].body })
  const clockEl = el('span', { class: 'tour-card__clock', text: '0s' })

  const deckBtn = (name: string, label: string, onClick: () => void): HTMLButtonElement =>
    el(
      'button',
      {
        class: 'pg-btn pg-btn--icon tour-btn',
        type: 'button',
        title: label,
        'aria-label': label,
        on: { click: onClick },
      },
      icon(name, 14),
    )

  const prevBtn = deckBtn('prev', 'Previous chapter', () => goTo(index - 1))
  const holdIcon = el('span', { class: 'tour-btn__icon' }, icon('pause', 14))
  const holdBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon tour-btn',
      type: 'button',
      title: 'Hold this chapter',
      'aria-label': 'Hold this chapter',
      on: { click: () => setHeld(!held) },
    },
    holdIcon,
  )
  const nextBtn = deckBtn('next', 'Next chapter', () => goTo(index + 1))
  const exitBtn = el(
    'button',
    {
      class: 'pg-btn tour-btn tour-btn--exit',
      type: 'button',
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
        el('div', { class: 'tour-card__btns' }, prevBtn, holdBtn, nextBtn, exitBtn),
      ),
    ),
    stepStrip,
    el('div', { class: 'tour-bar' }, barFill),
  )

  /* =======================================================================
   * THE NARRATION CARD — scenario beats, when the tour is not running
   * =====================================================================*/

  const narrateTitle = el('h3', { class: 'tour-narrate__title', text: '' })
  const narrateBody = el('p', { class: 'pg-body tour-narrate__body', text: '' })
  const narrateCard = el(
    'aside',
    { class: 'tour-narrate pg-panel', role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'pg-eyebrow tour-narrate__eyebrow', text: 'Scenario' }),
    narrateTitle,
    narrateBody,
  )

  let narrateTimer = 0

  function hideNarrate(instant = false): void {
    window.clearTimeout(narrateTimer)
    narrateTimer = 0
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

  function showNarrate(title: string, body: string, ms: number): void {
    window.clearTimeout(narrateTimer)
    setText(narrateTitle, title)
    setText(narrateBody, body)
    setClass(narrateCard, 'is-out', false)
    if (!narrateCard.classList.contains('is-live')) {
      narrateCard.classList.remove('is-enter')
      void narrateCard.offsetWidth
      narrateCard.classList.add('is-enter')
    }
    setClass(narrateCard, 'is-live', true)
    narrateTimer = window.setTimeout(() => hideNarrate(), Math.max(1200, ms))
  }

  /* =======================================================================
   * FIRST-RUN PROMPT
   * =====================================================================*/

  const firstRun = el(
    'aside',
    { class: 'tour-first pg-panel', role: 'note' },
    el(
      'div',
      { class: 'tour-first__text' },
      el('span', { class: 'pg-eyebrow', text: 'First time here?' }),
      el('p', {
        class: 'tour-first__line',
        text: `Take the guided tour — the whole city in ${STEPS.length} chapters, ${tourLength()}.`,
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
              bus.emit('tour:start', {})
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
    setClass(firstRun, 'is-live', false)
    document.body.classList.remove('pg-invite')
  }

  function showFirstRun(): void {
    if (running || hasSeen()) return
    markSeen()
    setClass(firstRun, 'is-live', true)
    // The card is centred in the same row as the minimap and is wider than the
    // space left beside it — tour.css uses this to stand the minimap down.
    document.body.classList.add('pg-invite')
  }

  layer.append(firstRun, narrateCard, card)

  if (!hasSeen()) timers.push(window.setTimeout(showFirstRun, FIRST_RUN_DELAY_MS))

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

  function enter(i: number): void {
    index = clamp(Math.round(i), 0, STEPS.length - 1)
    elapsed = 0
    atIdx = 0
    lookIdx = 0
    userControl = false

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

    // 3. camera
    if (step.focus) bus.emit('focus', { id: step.focus })

    paintChapter()
    paintClock()
    bus.emit('tour:chapter', { index, total: STEPS.length, title: step.title })
  }

  function goTo(i: number): void {
    if (!running) return
    if (i >= STEPS.length) {
      bus.emit('tour:stop', {})
      return
    }
    setHeld(false)
    // rewinding past the first chapter simply replays it
    enter(i < 0 ? 0 : i)
  }

  function setHeld(next: boolean): void {
    held = next
    holdIcon.replaceChildren(icon(held ? 'play' : 'pause', 14))
    holdBtn.title = held ? 'Resume the tour' : 'Hold this chapter'
    holdBtn.setAttribute('aria-label', holdBtn.title)
    setClass(holdBtn, 'is-active', held)
    setClass(card, 'is-held', held)
    paintClock()
  }

  function start(chapter: number): void {
    const target = clamp(Math.round(chapter), 0, STEPS.length - 1)
    if (running) {
      goTo(target)
      return
    }
    running = true
    baseline = { ...sim.state.knobs }
    touched.clear()
    ranScenario = false
    held = false
    setHeld(false)
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
    setHeld(false)
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
    setText(numEl, String(index + 1).padStart(2, '0'))
    setText(ofEl, `/ ${STEPS.length}`)
    setText(titleEl, step.title)
    setText(bodyEl, step.body)
    setText(eyebrow, step.scenario ? 'Guided tour · scenario running' : 'Guided tour')
    prevBtn.disabled = index === 0
    for (let i = 0; i < steps.length; i++) {
      setClass(steps[i], 'is-done', i < index)
      setClass(steps[i], 'is-now', i === index)
      if (i === index) steps[i].setAttribute('aria-current', 'step')
      else steps[i].removeAttribute('aria-current')
    }
  }

  function paintClock(): void {
    const step = STEPS[index]
    const left = Math.max(0, step.duration - elapsed)
    setText(clockEl, held ? 'hold' : `${Math.ceil(left)}s`)
    barFill.style.width = `${clamp(elapsed / step.duration, 0, 1) * 100}%`
  }

  /* =======================================================================
   * WIRING
   * =====================================================================*/

  cleanup.push(
    bus.on('tour:start', (p) => start(p && typeof p.chapter === 'number' ? p.chapter : 0)),
    bus.on('tour:stop', () => stop()),
    bus.on('narrate', (p) => {
      // While the tour is speaking, scenario beats stay quiet.
      if (running) return
      if (!p) {
        hideNarrate()
        return
      }
      showNarrate(p.title, p.body, p.ms ?? NARRATE_MS)
    }),
    bus.on('camera:mode', () => {
      if (running) userControl = true
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

  function update(dt: number): void {
    if (!running) return
    if (held) return

    elapsed += dt
    const step = STEPS[index]

    // mid-chapter knob beats
    const at = step.at
    while (at && atIdx < at.length && elapsed >= at[atIdx][0]) {
      applyKnobs(at[atIdx][1])
      atIdx += 1
    }

    // mid-chapter camera moves, unless the viewer has taken the camera
    const look = step.look
    while (look && lookIdx < look.length && elapsed >= look[lookIdx][0]) {
      if (!userControl) bus.emit('focus', { id: look[lookIdx][1] })
      lookIdx += 1
    }

    paintAcc += dt
    if (paintAcc >= 0.1) {
      paintAcc = 0
      paintClock()
    }

    if (elapsed >= step.duration) {
      if (index + 1 >= STEPS.length) bus.emit('tour:stop', {})
      else enter(index + 1)
    }
  }

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    for (const t of timers) window.clearTimeout(t)
    timers.length = 0
    window.clearTimeout(narrateTimer)
    if (running) {
      running = false
      restoreKnobs()
    }
    document.body.classList.remove('pg-tour')
    document.body.classList.remove('pg-invite')
    card.remove()
    narrateCard.remove()
    firstRun.remove()
  }

  paintChapter()
  paintClock()

  return { update, dispose }
}
