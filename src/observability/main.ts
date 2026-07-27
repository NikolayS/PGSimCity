/* ============================================================================
 * PGSimCity — THE SYMPTOM CONSOLE
 *
 * A diagnosis tool for PostgreSQL statistics views, running against the same
 * simulation the city runs. You start from a complaint in plain language, the
 * tool puts the model into a state that produces it, and then walks you to the
 * view and the column that proves what is wrong — reading live rows out of the
 * running model at every step, and evaluating each branch of the decision tree
 * against the state that exists this second.
 *
 * Inspired by Alexey Lesovsky's PostgreSQL Observability map (pgstats.dev),
 * which is the reference for *what observes what*. This is the other half:
 * which one do you open, and why that one.
 * ==========================================================================*/

import './style.css'

import { BUILD_LABEL } from '../core/build'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { SCENARIOS } from '../sim/scenarios'
import { DEFAULT_KNOBS } from '../core/types'
import type { Knobs } from '../core/types'
import { el, setText } from '../ui/uikit'
import { fmtNum } from '../core/util'

import { BY_ID, CATALOG, CATALOG_SUBSYSTEMS, VERSIONS } from './catalog'
import type { CatalogEntry } from './catalog'
import { createCollector } from './collector'
import { NODES, SYMPTOMS } from './paths'
import type { Node as PathNode, Step, Symptom, Verdict } from './paths'
import { PROJECTIONS } from './views'
import type { Mode } from './views'
import { dataTable, knobRow, sqlBlock, vitalsStrip } from './ui'
import { createCityExit, installCityEscape } from './shell'

/* ---------------------------------------------------------------------------
 * Model
 * -------------------------------------------------------------------------*/

const bus = createBus()
const sim = createSim(bus)
const coll = createCollector(sim)

/**
 * Put the model into a named state.
 *
 * Applied knob by knob rather than through sim.runScenario(), for two reasons.
 * A scenario expires on a timer and restores the knobs it changed, which would
 * quietly cure the patient while the reader was on step three. And a scenario
 * only sets the knobs it cares about, so walking from "the xmin horizon" to
 * "checkpoint storm" would leave the abandoned snapshot still open — a second
 * illness the second diagnosis never mentions. Reset to stock first, then apply.
 */
function stage(scenarioId: string | null): void {
  if (!scenarioId) return
  const def = SCENARIOS.find((s) => s.id === scenarioId)
  if (!def) return
  for (const [k, v] of Object.entries(DEFAULT_KNOBS)) {
    if (k === 'timeScale' || k === 'paused') continue
    sim.setKnob(k as keyof Knobs, v as Knobs[keyof Knobs])
  }
  for (const [k, v] of Object.entries(def.knobs)) {
    if (v !== undefined) sim.setKnob(k as keyof Knobs, v as Knobs[keyof Knobs])
  }
}

/**
 * Run the model forward without drawing it.
 *
 * Half of these views are cumulative counters, and a counter with nothing in it
 * points every branch at the wrong answer — the old page's exact failure mode,
 * in a different costume. So after staging a symptom the model is advanced far
 * enough for the counters to *mean* something before the first card is drawn.
 */
function warm(modelSeconds: number): void {
  const dt = 1 / 30
  const steps = Math.round(modelSeconds / dt)
  for (let i = 0; i < steps; i++) {
    sim.update(dt)
    if (i % 3 === 0) coll.sample()
  }
  coll.sample()
}

/* ---------------------------------------------------------------------------
 * View state
 * -------------------------------------------------------------------------*/

type Screen =
  | { kind: 'home' }
  | { kind: 'console'; symptom: Symptom; nodeId: string; trail: string[] }
  | { kind: 'instrument'; id: string }

let screen: Screen = { kind: 'home' }
let counterMode: Mode = 'total'
let pgVersion: number = VERSIONS[0]

/** Everything the current pane wants refreshed on the data tick. */
let liveRefresh: (() => void)[] = []

/* ---------------------------------------------------------------------------
 * Shell
 * -------------------------------------------------------------------------*/

const root = document.querySelector<HTMLElement>('#app')
if (!root) throw new Error('#app missing')

const vitals = vitalsStrip(sim, coll)

const pauseBtn = el('button', { class: 'chip', type: 'button', text: '❚❚', title: 'Pause the model' })
pauseBtn.addEventListener('click', () => {
  sim.setKnob('paused', !sim.state.knobs.paused)
  pauseBtn.textContent = sim.state.knobs.paused ? '▶' : '❚❚'
  pauseBtn.classList.toggle('on', sim.state.knobs.paused)
})

const speedBtns = [1, 2, 4].map((x) => {
  const b = el('button', { class: `chip${x === 1 ? ' on' : ''}`, type: 'button', text: `${x}×` })
  b.addEventListener('click', () => {
    sim.setKnob('timeScale', x)
    speedBtns.forEach((o) => o.classList.toggle('on', o === b))
  })
  return b
})

const top = el(
  'header',
  { class: 'top' },
  el(
    'a',
    { class: 'brand', href: '../', title: 'Back to the city' },
    el('span', { text: 'PG' }),
    el('b', { text: 'SIMCITY' }),
    el('i', { text: '/' }),
    el('strong', { text: 'DIAGNOSE' }),
  ),
  createCityExit(),
  vitals.root,
  el('div', { class: 'clock' }, pauseBtn, ...speedBtns),
)

const railBody = el('div', { class: 'rail__body' })
const rail = el('aside', { class: 'rail' }, railBody)
const pane = el('section', { class: 'pane' })
root.replaceChildren(top, el('main', { class: 'body' }, rail, pane))

/* ---------------------------------------------------------------------------
 * Rail
 * -------------------------------------------------------------------------*/

function railHeading(text: string, ...extra: HTMLElement[]): HTMLElement {
  return el('div', { class: 'rail__head' }, el('h2', { text }), ...extra)
}

const versionRail = el('div', { class: 'versions' })
for (const v of VERSIONS) {
  const b = el('button', { class: `vchip${v === pgVersion ? ' on' : ''}`, type: 'button', text: String(v) })
  b.addEventListener('click', () => {
    pgVersion = v
    versionRail.querySelectorAll('.vchip').forEach((n) => n.classList.toggle('on', n === b))
    buildRail()
    render()
  })
  versionRail.append(b)
}

function buildRail(): void {
  const symptomList = el('div', { class: 'symptoms' })
  for (const s of SYMPTOMS) {
    const btn = el(
      'button',
      { class: `symptom sub-${s.accent}`, type: 'button' },
      el('span', { class: 'symptom__q', text: s.complaint }),
      el('span', { class: 'symptom__s', text: s.sub }),
    )
    btn.addEventListener('click', () => openSymptom(s))
    if (screen.kind === 'console' && screen.symptom.id === s.id) btn.classList.add('on')
    symptomList.append(btn)
  }

  const instrumentList = el('div', { class: 'instruments' })
  for (const group of CATALOG_SUBSYSTEMS) {
    const entries = CATALOG.filter((e) => e.subsystem === group.id)
    if (!entries.length) continue
    instrumentList.append(el('p', { class: 'instruments__group', text: group.label }))
    for (const e of entries) {
      const missing = e.since > pgVersion
      const btn = el(
        'button',
        { class: `instrument sub-${e.subsystem}${missing ? ' missing' : ''}`, type: 'button' },
        el('code', { text: e.id }),
        el(
          'span',
          { class: 'instrument__tag' },
          missing ? `not in PG ${pgVersion}` : e.coverage === 'absent' ? 'not modelled' : e.kind,
        ),
      )
      btn.addEventListener('click', () => {
        screen = { kind: 'instrument', id: e.id }
        buildRail()
        render()
      })
      if (screen.kind === 'instrument' && screen.id === e.id) btn.classList.add('on')
      instrumentList.append(btn)
    }
  }

  railBody.replaceChildren(
    railHeading('Where does it hurt?'),
    el('p', { class: 'rail__note', text: 'Pick a complaint. The model is put into a state that produces it, and you are walked to the column that proves it.' }),
    symptomList,
    railHeading('Instruments', versionRail),
    el('p', { class: 'rail__note', text: 'Every view this model can serve, live. Change the version to see what you would be blind to.' }),
    instrumentList,
  )
}

/* ---------------------------------------------------------------------------
 * Navigation
 * -------------------------------------------------------------------------*/

function openSymptom(s: Symptom): void {
  stage(s.scenario)
  coll.reset()
  warm(90)
  screen = { kind: 'console', symptom: s, nodeId: s.entry, trail: [] }
  buildRail()
  render()
  pane.scrollTo({ top: 0 })
}

function goto(nodeId: string): void {
  if (screen.kind !== 'console') return
  const next = NODES.get(nodeId)
  if (next && next.kind === 'step' && next.settle) settle(next.settle, 30)
  screen = { ...screen, nodeId, trail: [...screen.trail, screen.nodeId] }
  render()
  pane.scrollTo({ top: 0, behavior: 'smooth' })
}

/** Advance the model until `ready`, or until the budget of model seconds runs out. */
function settle(ready: (s: typeof sim.state) => boolean, maxSeconds: number): void {
  const dt = 1 / 30
  const steps = Math.round(maxSeconds / dt)
  for (let i = 0; i < steps && !ready(sim.state); i++) {
    sim.update(dt)
    if (i % 3 === 0) coll.sample()
  }
  coll.sample()
}

function back(): void {
  if (screen.kind !== 'console' || !screen.trail.length) return
  const trail = [...screen.trail]
  const nodeId = trail.pop()!
  screen = { ...screen, nodeId, trail }
  render()
}

/* ---------------------------------------------------------------------------
 * Shared pane pieces
 * -------------------------------------------------------------------------*/

function instrumentChip(id: string): HTMLElement {
  const e = BY_ID.get(id)
  if (!e) return el('span')
  const missing = e.since > pgVersion
  const chip = el(
    'button',
    { class: `ichip sub-${e.subsystem}`, type: 'button', title: 'Open this instrument' },
    el('code', { text: e.id }),
    el('span', { text: e.kind }),
    el('span', { class: missing ? 'bad' : '', text: missing ? `NOT IN PG ${pgVersion}` : `PG ${e.since}+` }),
    el('span', { class: `cov cov-${e.coverage}`, text: e.coverage }),
  )
  chip.addEventListener('click', () => {
    screen = { kind: 'instrument', id }
    buildRail()
    render()
  })
  return chip
}

/** Projections whose figures are counters since a reset, and only those. */
const COUNTER_VIEWS = new Set(['database', 'bgwriter', 'checkpointer', 'wal', 'io'])

function counterToggle(projection?: string): HTMLElement | null {
  if (projection && !COUNTER_VIEWS.has(projection)) return null
  const wrap = el('div', { class: 'toggle' })
  const mk = (m: Mode, label: string, title: string) => {
    const b = el('button', { class: `chip${counterMode === m ? ' on' : ''}`, type: 'button', text: label, title })
    b.addEventListener('click', () => {
      counterMode = m
      render()
    })
    return b
  }
  wrap.append(
    el('span', { class: 'toggle__k', text: 'counters' }),
    mk('total', 'cumulative', 'The raw counter, as the view returns it'),
    mk('rate', 'per second', 'The counter differenced over time — what you almost always actually want'),
  )
  const reset = el('button', {
    class: 'chip danger',
    type: 'button',
    text: 'SELECT pg_stat_reset();',
    title: 'Zero every cumulative counter, exactly as the real function does',
  })
  reset.addEventListener('click', () => {
    coll.reset()
    render()
  })
  wrap.append(reset)
  return wrap
}

function cityLink(id: string | undefined, label = 'See it in the city'): HTMLElement | null {
  if (!id) return null
  return el('a', { class: 'citylink', href: `../#/c/${id}`, title: `Open ${id} in PGSimCity` }, el('span', { text: label }), el('code', { text: id }))
}

function liveGrid(projection: string): HTMLElement {
  const fn = PROJECTIONS[projection]
  const t = dataTable()
  if (!fn) {
    setText(t.root, `No projection "${projection}"`)
    return t.root
  }
  const paint = () => t.update(fn(sim.state, coll, counterMode))
  paint()
  liveRefresh.push(paint)
  return t.root
}

/* ---------------------------------------------------------------------------
 * Home
 * -------------------------------------------------------------------------*/

function renderHome(): HTMLElement {
  const cards = SYMPTOMS.slice(0, 4).map((s) => {
    const b = el('button', { class: `homecard sub-${s.accent}`, type: 'button' }, el('strong', { text: s.complaint }), el('span', { text: s.sub }))
    b.addEventListener('click', () => openSymptom(s))
    return b
  })

  return el(
    'article',
    { class: 'card intro' },
    el('p', { class: 'eyebrow', text: 'POSTGRESQL OBSERVABILITY, FROM THE OTHER END' }),
    el('h1', { text: 'You do not have a question about pg_stat_activity. You have a database that is slow.' }),
    el('p', {
      class: 'lede',
      text:
        'There are about fifty statistics views in PostgreSQL and every one of them is an answer. This page keeps the questions attached. Pick a complaint, and the simulation behind this page — the same one that runs the city — is put into a state that actually produces it. Then you read real rows out of it, one view at a time, until you reach the column that proves what is wrong.',
    }),
    el('div', { class: 'homecards' }, ...cards),
    el(
      'section',
      { class: 'block' },
      el('h3', { text: 'The server behind this page, right now' }),
      el('div', { class: 'chiprow' }, instrumentChip('pg_stat_activity')),
      liveGrid('activity_agg'),
    ),
    el('div', { class: 'divider' }),
    el(
      'div',
      { class: 'creditgrid' },
      el(
        'div',
        {},
        el('h3', { text: 'The map this is built beside' }),
        el('p', {
          text:
            'Alexey Lesovsky\'s PostgreSQL Observability map is the reference for which view observes which subsystem, and it is better at that job than anything this page could draw. It answers "what exists". This page answers "which one do I open, and why that one".',
        }),
        el('a', { class: 'extlink', href: 'https://pgstats.dev/', target: '_blank', rel: 'noreferrer noopener', text: 'pgstats.dev — Alexey Lesovsky' }),
        el('p', { class: 'fine', text: 'Used as inspiration and credited with thanks. No assets or layout are copied, and nothing here implies endorsement.' }),
      ),
      el(
        'div',
        {},
        el('h3', { text: 'These numbers are not measurements' }),
        el('p', {
          text:
            'Every figure on this page comes from a simulation written in TypeScript, not from a PostgreSQL server. The mechanisms are modelled faithfully — the clock sweep really sweeps, a checkpoint really forces full-page writes, an old snapshot really stops vacuum dead — but a model is not a measurement, and no digit here should be quoted as one.',
        }),
        el('p', {
          text:
            'Catalog names are the other half of that promise. Every view, function, column and enum value on this page was checked against the PostgreSQL 18 manual as it was written, and where the model cannot honestly fill a column, the column is left out and said so.',
        }),
        el('a', { class: 'extlink', href: 'https://www.postgresql.org/docs/current/monitoring-stats.html', target: '_blank', rel: 'noreferrer noopener', text: 'The Cumulative Statistics System — PostgreSQL manual' }),
      ),
    ),
  )
}

/* ---------------------------------------------------------------------------
 * Console — steps
 * -------------------------------------------------------------------------*/

function renderStep(sc: Extract<Screen, { kind: 'console' }>, step: Step): HTMLElement {
  const branches = el('div', { class: 'branches' })
  const marks: { row: HTMLElement; test: () => boolean }[] = []

  for (const b of step.branches) {
    const flag = el('span', { class: 'branch__flag', text: 'TRUE NOW', hidden: step.branches.length === 1 })
    const row = el(
      'button',
      { class: 'branch', type: 'button' },
      el('span', { class: 'branch__l' }, inline(b.label)),
      flag,
      el('span', { class: 'branch__go', text: '→' }),
    )
    row.addEventListener('click', () => goto(b.next))
    branches.append(row)
    marks.push({ row, test: () => b.test(sim.state, coll) })
  }
  const undecided = el('p', {
    class: 'fine undecided',
    text: 'None of these is true of the model this second. That is a real answer too — leave it running, or take any branch to read on regardless.',
  })
  /* A step with a single branch is a "next" link, not a question. Flagging it
   * TRUE NOW would be technically accurate and completely meaningless. */
  const linear = step.branches.length === 1
  const paintMarks = () => {
    if (linear) {
      undecided.hidden = true
      return
    }
    let any = false
    for (const m of marks) {
      const t = m.test()
      any = any || t
      m.row.classList.toggle('true', t)
    }
    undecided.hidden = any
  }
  paintMarks()
  if (!linear) liveRefresh.push(paintMarks)

  const stepIndex = sc.trail.length + 1

  return el(
    'article',
    { class: 'card' },
    el(
      'div',
      { class: 'card__head' },
      el('p', { class: 'eyebrow', text: `STEP ${stepIndex} · ${sc.symptom.complaint}` }),
      el('h1', { text: step.title }),
      md(step.why, 'lede'),
    ),
    el('div', { class: 'chiprow' }, instrumentChip(step.instrument), counterToggle(step.projection)),
    sqlBlock(step.sql),
    liveGrid(step.projection),
    el(
      'section',
      { class: 'block' },
      el('h3', { text: 'What you are looking for' }),
      md(step.look),
    ),
    step.note ? el('aside', { class: 'note' }, el('span', { class: 'note__k', text: 'VERSIONS' }), md(step.note)) : null,
    el(
      'section',
      { class: 'block' },
      el('h3', { text: step.branches.length > 1 ? 'Which is it?' : 'Next' }),
      step.branches.length > 1
        ? el('p', { class: 'fine', text: 'The tool is reading the same rows you are. Every branch that is true of the running model right now is marked — sometimes more than one is, and that is a finding too.' })
        : null,
      branches,
      undecided,
    ),
    cityLink(step.city),
  )
}

/* ---------------------------------------------------------------------------
 * Console — verdicts
 * -------------------------------------------------------------------------*/

function renderVerdict(sc: Extract<Screen, { kind: 'console' }>, v: Verdict): HTMLElement {
  const evidence = el('div', { class: 'evidence' })
  const paintEvidence = () => {
    const items = v.evidence(sim.state, coll)
    evidence.replaceChildren(
      ...items.map((i) =>
        el('div', { class: `ev c-${i.tone || 'none'}` }, el('span', { class: 'ev__k', text: i.label }), el('span', { class: 'ev__v', text: i.value })),
      ),
    )
  }
  paintEvidence()
  liveRefresh.push(paintEvidence)

  const knobs = el('div', { class: 'knobs' })
  const syncs: (() => void)[] = []
  for (const k of v.knobs) {
    const row = knobRow(sim, k)
    knobs.append(row.root)
    syncs.push(row.sync)
  }
  liveRefresh.push(() => syncs.forEach((f) => f()))

  /* The scoreboard. A diagram can tell you what is wrong; only a page with a
   * running server behind it can tell you whether you fixed it, and that is the
   * one thing this whole feature exists to be able to do. So it is stated
   * plainly, live, in the view's own vocabulary — and it is allowed to say "not
   * enough evidence", because on counter-based views that is often the truth. */
  const verdictBand = (() => {
    if (!v.resolved) return null
    const flag = el('span', { class: 'rez__flag' })
    const read = el('span', { class: 'rez__read' })
    const band = el('div', { class: 'rez' }, flag, read)
    const paint = () => {
      const r = v.resolved!(sim.state, coll)
      const state = r.ok === null ? 'wait' : r.ok ? 'ok' : 'bad'
      band.className = `rez rez--${state}`
      setText(flag, r.ok === null ? 'NO EVIDENCE YET' : r.ok ? 'RESOLVED' : 'STILL PRESENT')
      setText(read, r.reading)
    }
    paint()
    liveRefresh.push(paint)
    return band
  })()

  const others = SYMPTOMS.filter((s) => s.id !== sc.symptom.id).slice(0, 3)
  const next = el('div', { class: 'nextrow' })
  for (const s of others) {
    const b = el('button', { class: `chip wide sub-${s.accent}`, type: 'button', text: s.complaint })
    b.addEventListener('click', () => openSymptom(s))
    next.append(b)
  }

  return el(
    'article',
    { class: 'card verdict' },
    el(
      'div',
      { class: 'card__head' },
      el('p', { class: 'eyebrow', text: `DIAGNOSIS · ${sc.symptom.complaint}` }),
      el('h1', { text: v.title }),
      md(v.because, 'lede'),
    ),
    el('section', { class: 'block' }, el('h3', { text: 'The evidence, right now' }), evidence),
    el('section', { class: 'block' }, el('h3', { text: 'Why that produces this symptom' }), md(v.mechanism)),
    el('section', { class: 'block' }, el('h3', { text: 'What you do about it' }), md(v.fix), knobs),
    v.confirm
      ? el(
          'section',
          { class: 'block' },
          el('h3', { text: 'Turn the dial, then confirm it' }),
          verdictBand,
          el('p', {
            class: 'fine',
            text:
              'One warning about the table below, and it is the most useful thing on this page: these are counters since the last reset, so a fix you just applied is buried under everything that happened before it. Switch to per second, or run pg_stat_reset(), and look again.',
          }),
          el('div', { class: 'chiprow' }, instrumentChip(v.confirm.instrument), counterToggle(v.confirm.projection)),
          sqlBlock(v.confirm.sql),
          liveGrid(v.confirm.projection),
        )
      : null,
    el(
      'section',
      { class: 'block links' },
      cityLink(v.city, 'Open the mechanism in the city'),
      ...v.reading.map((r) => el('a', { class: 'extlink', href: r.url, target: '_blank', rel: 'noreferrer noopener', text: r.label })),
    ),
    el('section', { class: 'block' }, el('h3', { text: 'Another complaint' }), next),
  )
}

/* ---------------------------------------------------------------------------
 * Instrument pane
 * -------------------------------------------------------------------------*/

function renderInstrument(e: CatalogEntry): HTMLElement {
  const missing = e.since > pgVersion
  const body: (HTMLElement | null)[] = []

  body.push(
    el(
      'div',
      { class: 'card__head' },
      el('p', { class: `eyebrow sub-${e.subsystem}`, text: `${e.kind.toUpperCase()} · ${CATALOG_SUBSYSTEMS.find((g) => g.id === e.subsystem)?.label ?? ''}` }),
      el('h1', { class: 'mono', text: e.id }),
      md(e.what, 'lede'),
    ),
  )

  if (missing) {
    body.push(
      el(
        'aside',
        { class: 'blindspot' },
        el('span', { class: 'note__k', text: `BLIND SPOT ON PG ${pgVersion}` }),
        el('p', { text: `${e.id} first appears in PostgreSQL ${e.since}. On the version you have selected it does not exist, and every question it would have answered has to be answered some other way — or not at all.` }),
        e.version ? md(e.version) : null,
      ),
    )
  } else if (e.coverage === 'absent') {
    body.push(
      el(
        'aside',
        { class: 'blindspot' },
        el('span', { class: 'note__k', text: 'THIS MODEL CANNOT SHOW YOU THIS' }),
        el('p', { text: e.coverageNote ?? '' }),
      ),
    )
  } else if (e.projection) {
    const tog = counterToggle(e.projection)
    if (tog) body.push(el('div', { class: 'chiprow' }, tog))
    body.push(liveGrid(e.projection))
  }

  const cols = el('div', { class: 'cols' })
  for (const c of e.columns) cols.append(el('code', { class: 'col', text: c }))
  /* Functions carry signatures, not columns, and calling them "columns" would be
   * the small kind of wrong that costs a reader their trust in the large kind. */
  const isFn = e.kind === 'function'
  body.push(
    el(
      'section',
      { class: 'block' },
      el('h3', { text: isFn ? `Signatures (${e.columns.length})` : `Columns (${e.columns.length})` }),
      el('p', {
        class: 'fine',
        text: isFn
          ? 'The real signatures, as the manual gives them. Checked one at a time.'
          : 'The complete list as of PostgreSQL 18, in the order the manual gives it. Nothing is abridged: if a column is missing from this list, that is a bug worth reporting. Names were checked against the manual one at a time.',
      }),
      cols,
    ),
  )

  if (e.coverageNote && e.coverage !== 'absent') {
    body.push(
      el(
        'section',
        { class: 'block' },
        el('h3', { text: 'What this model can and cannot fill in' }),
        el('p', { text: e.coverageNote }),
      ),
    )
  }
  if (e.version && !missing) {
    body.push(el('section', { class: 'block' }, el('h3', { text: 'What changed, and when' }), md(e.version)))
  }

  body.push(
    el(
      'section',
      { class: 'block links' },
      el('a', { class: 'extlink', href: e.docs, target: '_blank', rel: 'noreferrer noopener', text: 'PostgreSQL manual' }),
      cityLink(e.city, 'See the mechanism in the city'),
    ),
  )

  return el('article', { class: 'card' }, ...body.filter(Boolean).map((x) => x as HTMLElement))
}

/* ---------------------------------------------------------------------------
 * Tiny inline markup: `code` and **bold** only.
 * -------------------------------------------------------------------------*/

function inline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) frag.append(el('code', { text: tok.slice(1, -1) }))
    else frag.append(el('strong', { text: tok.slice(2, -2) }))
    last = m.index + tok.length
  }
  if (last < text.length) frag.append(text.slice(last))
  return frag
}

function md(text: string, cls = ''): HTMLElement {
  const p = el('p', cls ? { class: cls } : {})
  p.append(inline(text))
  return p
}

/* ---------------------------------------------------------------------------
 * Render
 * -------------------------------------------------------------------------*/

function stagedBanner(sc: Extract<Screen, { kind: 'console' }>): HTMLElement {
  const def = SCENARIOS.find((s) => s.id === sc.symptom.scenario)
  const clear = el('button', { class: 'chip', type: 'button', text: 'restore defaults' })
  clear.addEventListener('click', () => {
    sim.reset()
    coll.reset()
    render()
  })
  const backBtn = el('button', { class: 'chip', type: 'button', text: '← previous step' })
  backBtn.addEventListener('click', back)
  const home = el('button', { class: 'chip', type: 'button', text: 'start over' })
  home.addEventListener('click', () => {
    screen = { kind: 'home' }
    buildRail()
    render()
  })
  return el(
    'div',
    { class: 'staged' },
    el('span', { class: 'staged__k', text: 'STAGED' }),
    el('span', { class: 'staged__t', text: def ? `${def.name} — the model is running this configuration so you can read it live. Every knob on the page is still yours.` : 'free running' }),
    sc.trail.length ? backBtn : null,
    clear,
    home,
  )
}

function footer(): HTMLElement {
  /* This line reports the model clock and how much statistics history exists.
   * Rendered once and left alone it goes stale within seconds and then quietly
   * misreports both — which on the one line of the page whose job is to say
   * "these are not measurements" is the worst place to be wrong. */
  const stamp = el('p')
  const paintStamp = () =>
    setText(
      stamp,
      `Model time ${fmtNum(sim.state.t)} s · counters since ${coll.resetStamp} · ${fmtNum(coll.total.elapsed)} s of statistics. Numbers come from a simulation, not a server.`,
    )
  paintStamp()
  liveRefresh.push(paintStamp)

  return el(
    'footer',
    { class: 'foot' },
    stamp,
    el('p', {
      html: 'Inspired by <a href="https://pgstats.dev/" target="_blank" rel="noreferrer noopener">Alexey Lesovsky\'s PostgreSQL Observability map</a>. Names verified against the <a href="https://www.postgresql.org/docs/current/monitoring-stats.html" target="_blank" rel="noreferrer noopener">PostgreSQL 18 manual</a>. Apache-2.0.',
    }),
    el('p', {
      class: 'build-marker',
      text: `PGSimCity ${BUILD_LABEL}`,
      'aria-label': `PGSimCity build ${BUILD_LABEL}`,
    }),
  )
}

function render(): void {
  liveRefresh = []
  let content: HTMLElement
  let banner: HTMLElement | null = null

  if (screen.kind === 'home') {
    content = renderHome()
  } else if (screen.kind === 'instrument') {
    const e = BY_ID.get(screen.id)
    content = e ? renderInstrument(e) : renderHome()
  } else {
    const node: PathNode | undefined = NODES.get(screen.nodeId)
    banner = stagedBanner(screen)
    if (!node) content = renderHome()
    else if (node.kind === 'step') content = renderStep(screen, node)
    else content = renderVerdict(screen, node)
  }

  pane.replaceChildren(...[banner, content, footer()].filter(Boolean).map((x) => x as HTMLElement))
}

/* ---------------------------------------------------------------------------
 * Loop
 * -------------------------------------------------------------------------*/

let last = performance.now()
let vitalT = 0
let dataT = 0

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  sim.update(dt * sim.state.knobs.timeScale)
  coll.sample()

  vitalT += dt
  if (vitalT > 0.1) {
    vitalT = 0
    vitals.update()
  }
  dataT += dt
  if (dataT > 0.25) {
    dataT = 0
    for (const f of liveRefresh) f()
  }
  requestAnimationFrame(frame)
}

installCityEscape()

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault()
    pauseBtn.click()
  }
})

/* The model boots at DEFAULT_KNOBS — ten transactions a second, which is a
 * server doing essentially nothing. Nobody diagnoses an idle database, and a
 * page about statistics whose first impression is a row of zeros has already
 * lost the argument. Start it under an ordinary OLTP load instead. */
stage('steady-state')
coll.reset()
warm(60)

buildRail()
render()
requestAnimationFrame(frame)
