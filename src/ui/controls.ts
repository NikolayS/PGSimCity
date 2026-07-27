import type { Knobs, SimApi } from '../core/types'
import { DEFAULT_KNOBS } from '../core/types'
import { fmtBytes, fmtDuration, fmtNum } from '../core/util'
import { SCENARIOS } from '../sim/scenarios'
import { KNOB_GROUPS, KNOB_META, knobsInGroup } from './content'
import type { KnobMeta } from './content'
import {
  el,
  icon,
  linearToLog,
  logToLinear,
  setClass,
  setText,
  syncRangeFill,
} from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — the console (#hud-left).
 *
 * Every knob in KNOB_META, grouped by KNOB_GROUPS, rendered with the same
 * widget the inspector embeds inline. The console never caches simulation
 * state: it polls `sim.state.knobs` at 5 Hz and repairs any control whose value
 * drifted underneath it (scenarios, the tour and the keyboard all move knobs),
 * while never fighting a control the user has their hand on.
 * ==========================================================================*/

/** How long after the last interaction a control is left alone by the poll. */
const GRACE_MS = 700

type KnobValue = Knobs[keyof Knobs]

let uid = 0
const nextId = (prefix: string): string => `${prefix}-${(uid += 1)}`

/* ---------------------------------------------------------------------------
 * setKnob is generic over one key; the widgets are generic over all of them.
 * This is the single place that bridges the two.
 * -------------------------------------------------------------------------*/

type LooseSetter = (key: keyof Knobs, value: KnobValue) => void

export function applyKnob(sim: SimApi, key: keyof Knobs, value: KnobValue): void {
  ;(sim.setKnob as unknown as LooseSetter)(key, value)
}

export function readKnob(sim: SimApi, key: keyof Knobs): KnobValue {
  return sim.state.knobs[key]
}

/* ---------------------------------------------------------------------------
 * Persistence — panel geometry only. Wrapped because storage throws in some
 * privacy modes and a HUD must never take the app down with it.
 * -------------------------------------------------------------------------*/

export function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    return raw == null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

export function saveFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* storage unavailable — the preference simply does not survive a reload */
  }
}

/* ---------------------------------------------------------------------------
 * Phone sheets — shared between the console (left) and the inspector (right).
 *
 * On a phone both panels are bottom sheets standing in the same place, so only
 * one may be up at a time, and the HUD needs to know that one is: the transport
 * dock hides underneath it rather than leaving unreachable buttons behind the
 * glass. Both facts are read straight off the DOM, so whichever module moved
 * last, the answer is the same.
 * -------------------------------------------------------------------------*/

export const SHEET_EVENT = 'pgsimcity:sheet'

export type SheetSide = 'left' | 'right'

/** Tell the other sheet to stand down. Only ever called when one opens. */
export function announceSheet(side: SheetSide): void {
  window.dispatchEvent(new CustomEvent(SHEET_EVENT, { detail: { side } }))
}

export function sheetSideOf(e: Event): SheetSide | null {
  const detail = (e as CustomEvent<{ side?: SheetSide }>).detail
  return detail?.side ?? null
}

/** Recompute body.pg-sheet / body.pg-sheet-tall from whatever is actually open. */
export function syncSheetFlags(): void {
  const open = document.querySelector('.pgc-host.is-compact.is-open') != null
  const tall = document.querySelector('.pgc-host.is-compact.is-open .pgc-panel.is-tall') != null
  document.body.classList.toggle('pg-sheet', open)
  document.body.classList.toggle('pg-sheet-tall', open && tall)
}

/* ---------------------------------------------------------------------------
 * Collapsible section — shared by the console's groups and the inspector's
 * prose. Composes .pg-collapse from ui.css and stays keyboard operable.
 * -------------------------------------------------------------------------*/

export interface Collapse {
  root: HTMLElement
  head: HTMLButtonElement
  body: HTMLElement
  setOpen(open: boolean): void
  isOpen(): boolean
}

export function createCollapse(
  title: string,
  opts: { open?: boolean; onToggle?: (open: boolean) => void } = {},
): Collapse {
  const open = opts.open ?? false
  const bodyId = nextId('pgc-sec')
  const head = el(
    'button',
    { class: 'pg-collapse__head pgc-collapse__head', type: 'button' },
    el('span', { class: 'pgc-collapse__t', text: title }),
  )
  head.setAttribute('aria-expanded', String(open))
  head.setAttribute('aria-controls', bodyId)
  const body = el('div', { class: 'pg-collapse__body', id: bodyId })
  body.setAttribute('role', 'region')
  const root = el('div', { class: `pg-collapse${open ? ' is-open' : ''}` }, head, body)

  const setOpen = (next: boolean): void => {
    setClass(root, 'is-open', next)
    head.setAttribute('aria-expanded', String(next))
  }
  head.addEventListener('click', () => {
    const next = !root.classList.contains('is-open')
    setOpen(next)
    opts.onToggle?.(next)
  })

  return { root, head, body, setOpen, isOpen: () => root.classList.contains('is-open') }
}

/* ---------------------------------------------------------------------------
 * Value formatting — a knob reads as the GUC it stands for.
 * -------------------------------------------------------------------------*/

export interface KnobDisplay {
  /** the number (or word) itself */
  num: string
  /** its unit, rendered quietly next to it */
  unit?: string
  /** the same quantity said another way: pages as MiB, seconds as minutes */
  alt?: string
}

function decimalsOf(step: number | undefined): number {
  if (!step || !isFinite(step) || step <= 0) return 0
  const text = String(step)
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

export function knobDisplay(meta: KnobMeta, value: KnobValue): KnobDisplay {
  if (meta.kind === 'toggle') return { num: value ? 'on' : 'off' }
  if (meta.kind === 'select') return { num: String(value) }

  const n = typeof value === 'number' && isFinite(value) ? value : 0
  if (meta.fmt) return { num: meta.fmt(n as never) }
  switch (meta.key) {
    case 'checkpointTimeout':
      return { num: String(Math.round(n)), unit: 's', alt: n >= 60 ? fmtDuration(n) : undefined }
    case 'maxWalSize':
      return { num: fmtNum(n), unit: 'MiB', alt: n >= 1024 ? fmtBytes(n * 1024 * 1024, 1) : undefined }
    case 'tps':
      return { num: fmtNum(n), unit: 'tps' }
    case 'timeScale':
      return { num: n.toFixed(1), unit: '×' }
    default:
      break
  }
  if (meta.unit === '%') return { num: (n * 100).toFixed(0), unit: '%' }
  const digits = decimalsOf(meta.step)
  if (meta.unit) return { num: digits ? n.toFixed(digits) : fmtNum(n), unit: meta.unit }
  return { num: n.toFixed(Math.max(2, digits)) }
}

/* ---------------------------------------------------------------------------
 * The knob widget. One per (knob, host) — the console and the inspector each
 * build their own instance and both stay correct because both poll.
 * -------------------------------------------------------------------------*/

export interface KnobControl {
  root: HTMLElement
  /** pull the live value out of SimState; skipped while the user is on it */
  sync(force?: boolean): void
  dispose(): void
}

export function createKnobControl(ctx: UiContext, meta: KnobMeta): KnobControl {
  const inputId = nextId(`pgc-${String(meta.key)}`)
  const labelIsGuc = !!meta.guc && meta.guc === meta.label

  const num = el('span', { class: 'pgc-val__n' })
  const unit = el('span', { class: 'pgc-val__u' })
  const alt = el('span', { class: 'pgc-val__alt' })
  const value = el('span', { class: 'pgc-val' }, num, unit, alt)

  const label = el('label', {
    class: `pg-field__label pgc-knob__label${labelIsGuc ? ' is-mono' : ''}`,
    for: inputId,
    text: meta.label,
  })
  if (meta.danger) {
    const warn = icon('warn', 10)
    warn.setAttribute('class', 'pgc-knob__warn')
    label.append(warn)
  }

  const row = el('div', { class: 'pg-field__row pgc-knob__row' }, label, value)
  const root = el('div', { class: `pg-field pgc-knob${meta.danger ? ' is-danger' : ''}` }, row)
  root.dataset.kind = meta.kind
  if (meta.guc && !labelIsGuc) root.append(el('div', { class: 'pg-field__guc pgc-guc', text: meta.guc }))

  /* --- the control itself ------------------------------------------------ */

  const min = meta.min ?? 0
  const max = meta.max ?? 1
  const step = meta.step ?? 0.01

  let input: HTMLInputElement | HTMLSelectElement

  if (meta.kind === 'toggle') {
    const box = el('input', { type: 'checkbox', class: `pg-toggle${meta.danger ? ' is-danger' : ''}`, id: inputId })
    input = box
    row.append(box)
  } else if (meta.kind === 'select') {
    const sel = el('select', { class: 'pg-select pgc-knob__select', id: inputId })
    for (const opt of meta.options ?? []) sel.append(el('option', { value: opt.value, text: opt.label }))
    input = sel
    root.append(sel)
  } else if (meta.kind === 'logrange') {
    const range = el('input', {
      type: 'range',
      class: 'pg-range pgc-knob__range',
      id: inputId,
      min: '0',
      max: '1',
      step: '0.001',
    })
    input = range
    root.append(range)
  } else {
    const range = el('input', {
      type: 'range',
      class: 'pg-range pgc-knob__range',
      id: inputId,
      min: String(min),
      max: String(max),
      step: String(step),
    })
    input = range
    root.append(range)
  }

  if (meta.hint) {
    const hintId = `${inputId}-hint`
    root.append(el('p', { class: 'pg-field__hint pgc-knob__hint', id: hintId, text: meta.hint }))
    input.setAttribute('aria-describedby', hintId)
  }

  /* --- interaction state ------------------------------------------------- */

  let dragging = false
  let lastTouch = -1e9
  const touched = (): void => {
    lastTouch = performance.now()
  }
  const busy = (): boolean => dragging || performance.now() - lastTouch < GRACE_MS

  const endDrag = (): void => {
    dragging = false
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    touched()
  }
  const startDrag = (): void => {
    dragging = true
    touched()
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }
  input.addEventListener('pointerdown', startDrag)

  /* --- read / write ------------------------------------------------------ */

  const snap = (v: number): number => {
    const stepped = step > 0 ? Math.round(v / step) * step : v
    const clamped = stepped < min ? min : stepped > max ? max : stepped
    const digits = decimalsOf(step)
    return digits ? Number(clamped.toFixed(digits)) : Math.round(clamped)
  }

  function paint(v: KnobValue): void {
    const d = knobDisplay(meta, v)
    setText(num, d.num)
    setText(unit, d.unit ?? '')
    setText(alt, d.alt ?? '')
    setClass(root, 'is-armed', !!meta.danger && v !== DEFAULT_KNOBS[meta.key])
    if (meta.kind === 'toggle') setClass(value, 'is-on', v === true)
  }

  function writeControl(v: KnobValue): void {
    if (meta.kind === 'toggle') {
      ;(input as HTMLInputElement).checked = v === true
    } else if (meta.kind === 'select') {
      const next = String(v)
      if (input.value !== next) input.value = next
    } else {
      const n = typeof v === 'number' ? v : 0
      const t = meta.kind === 'logrange' ? logToLinear(n, Math.max(min, 1e-6), max) : n
      const next = String(t)
      if (input.value !== next) input.value = next
      syncRangeFill(input as HTMLInputElement)
    }
  }

  let shown: KnobValue | undefined

  function commit(requested: KnobValue): void {
    touched()
    applyKnob(ctx.sim, meta.key, requested)
    // The model is allowed to clamp or snap what it was handed; show the truth.
    const actual = readKnob(ctx.sim, meta.key)
    shown = actual
    paint(actual)
    if (actual !== requested) writeControl(actual)
  }

  input.addEventListener('input', () => {
    if (meta.kind === 'toggle') {
      commit((input as HTMLInputElement).checked)
      return
    }
    if (meta.kind === 'select') {
      commit(input.value as KnobValue)
      return
    }
    syncRangeFill(input as HTMLInputElement)
    const raw = Number(input.value)
    const v = meta.kind === 'logrange' ? snap(linearToLog(raw, Math.max(min, 1e-6), max)) : snap(raw)
    commit(v)
  })

  function sync(force = false): void {
    const v = readKnob(ctx.sim, meta.key)
    if (!force && busy()) return
    if (v === shown) return
    shown = v
    writeControl(v)
    paint(v)
  }

  sync(true)

  return {
    root,
    sync,
    dispose() {
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      root.remove()
    },
  }
}

/* ---------------------------------------------------------------------------
 * How far the city has drifted from a stock postgresql.conf.
 * -------------------------------------------------------------------------*/

function countChanged(knobs: Knobs, metas: readonly KnobMeta[]): number {
  let n = 0
  for (const m of metas) if (knobs[m.key] !== DEFAULT_KNOBS[m.key]) n += 1
  return n
}

const scenarioName = (id: string | null): string | null => {
  if (!id) return null
  const hit = SCENARIOS.find((s) => s.id === id)
  return hit ? hit.name : id
}

/* ===========================================================================
 * createControls — the rail.
 * =========================================================================*/

const OPEN_KEY = 'pgsimcity.console.open'
const GROUP_KEY = (id: string): string => `pgsimcity.console.group.${id}`
const OPEN_BY_DEFAULT: Record<string, boolean> = { workload: true, sim: true }

export function createControls(ctx: UiContext): UiModule {
  const mount = document.getElementById('hud-left')
  if (!mount) {
    console.warn('[PGSimCity] #hud-left is missing — the console has nowhere to live')
    return { update() {}, dispose() {} }
  }

  const host = el('div', { class: 'pgc-host pgc-host--left' })
  const looseBus = ctx.bus as unknown as {
    on(type: string, fn: (payload: unknown) => void): () => void
  }
  const controls: KnobControl[] = []
  const groupBadges: { metas: KnobMeta[]; node: HTMLElement }[] = []

  /* --- open / collapsed state ------------------------------------------- */

  const narrow = window.matchMedia('(max-width: 1100px)')
  let compact = narrow.matches
  let open = loadFlag(OPEN_KEY, false)
  let tall = false
  let planPreset = false

  const isOpen = (): boolean => open

  function applyOpen(): void {
    const panelOpen = isOpen()
    setClass(host, 'is-plan-hidden', planPreset)
    setClass(host, 'is-compact', compact)
    setClass(host, 'is-open', panelOpen)
    tab.setAttribute('aria-expanded', String(panelOpen))
    tab.title = panelOpen ? 'Hide the console' : 'Show the console'
    tab.setAttribute('aria-label', tab.title)
    panel.setAttribute('aria-hidden', String(!panelOpen))
    // Nothing inside a hidden panel should be reachable by keyboard.
    panel.inert = !panelOpen
    syncSheetFlags()
  }

  function setOpen(next: boolean): void {
    open = next
    saveFlag(OPEN_KEY, next)
    applyOpen()
    if (next) {
      // restart the entrance animation so re-opening feels like arriving
      panel.classList.remove('pg-enter')
      void panel.offsetWidth
      panel.classList.add('pg-enter')
      if (compact) announceSheet('left')
    }
    ctx.bus.emit('ui:layout', {})
  }

  function setTall(next: boolean): void {
    tall = next
    setClass(panel, 'is-tall', tall)
    sizeBtn.title = tall ? 'Shrink the console' : 'Expand the console'
    sizeBtn.setAttribute('aria-label', sizeBtn.title)
    sizeBtn.setAttribute('aria-expanded', String(tall))
    syncSheetFlags()
  }

  const tab = el('button', {
    class: 'pg-btn pg-btn--icon pgc-tab pgc-tab--left',
    type: 'button',
    on: { click: () => setOpen(!isOpen()) },
  })
  tab.append(icon('gear', 15), el('span', { class: 'pgc-tab__label', text: 'Console' }))

  /* --- header ------------------------------------------------------------ */

  const presetDot = el('span', { class: 'pg-dot pgc-preset__dot' })
  const presetName = el('div', { class: 'pgc-preset', text: 'Defaults' })

  /* Phone only: trade half the city for a tall sheet while you are reading, and
     trade it straight back. */
  const sizeBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon pgc-sheet-size',
      type: 'button',
      title: 'Expand the console',
      'aria-label': 'Expand the console',
      'aria-expanded': 'false',
      on: { click: () => setTall(!tall) },
    },
    icon('chevron', 13),
  )

  const head = el(
    'header',
    { class: 'pg-panel__head pgc-rail__head' },
    presetDot,
    el('div', { class: 'pgc-rail__id' }, el('div', { class: 'pg-eyebrow', text: 'Console' }), presetName),
    sizeBtn,
    el(
      'button',
      {
        class: 'pg-btn pg-btn--icon pgc-rail__collapse',
        type: 'button',
        title: 'Collapse the console',
        'aria-label': 'Collapse the console',
        on: { click: () => setOpen(false) },
      },
      icon('chevron', 14),
    ),
  )

  /* --- body: every knob, grouped ---------------------------------------- */

  const body = el('div', { class: 'pg-panel__body pg-scroll pgc-rail__body', tabindex: '0' })
  body.setAttribute('role', 'group')
  body.setAttribute('aria-label', 'Simulation parameters')

  for (const group of KNOB_GROUPS) {
    const metas = knobsInGroup(group.id)
    if (!metas.length) continue

    const open = loadFlag(GROUP_KEY(group.id), OPEN_BY_DEFAULT[group.id] ?? false)
    const section = createCollapse(group.label, {
      open,
      onToggle: (next) => saveFlag(GROUP_KEY(group.id), next),
    })
    section.root.classList.add('pgc-group')
    if (group.id === 'chaos') section.root.classList.add('is-chaos')

    const badge = el('span', { class: 'pgc-group__badge' })
    section.head.append(badge)
    groupBadges.push({ metas, node: badge })

    section.body.append(el('p', { class: 'pgc-group__hint', text: group.hint }))
    for (const meta of metas) {
      const control = createKnobControl(ctx, meta)
      controls.push(control)
      section.body.append(control.root)
    }
    body.append(section.root)
  }

  /* --- footer ------------------------------------------------------------ */

  const changedText = el('span', { class: 'pgc-changed', text: 'stock configuration' })
  const resetBtn = el(
    'button',
    {
      class: 'pg-btn pgc-reset',
      type: 'button',
      title: 'Put every parameter back to its default value',
      on: {
        click: () => {
          for (const meta of KNOB_META) applyKnob(ctx.sim, meta.key, DEFAULT_KNOBS[meta.key])
          for (const c of controls) c.sync(true)
          refresh()
          ctx.bus.emit('toast', { text: 'Every parameter is back to its default', kind: 'good' })
        },
      },
    },
    icon('reset', 13),
    el('span', { text: 'Restore defaults' }),
  )
  const foot = el('footer', { class: 'pg-panel__foot pgc-rail__foot' }, resetBtn, changedText)

  const panel = el('section', { class: 'pg-panel pgc-panel pgc-rail' }, head, body, foot)
  panel.setAttribute('aria-label', 'Console')
  host.append(tab, panel)
  mount.append(host)

  /* --- live header ------------------------------------------------------- */

  function refresh(): void {
    const knobs = ctx.sim.state.knobs
    const scenario = scenarioName(ctx.sim.state.scenario)
    const changed = countChanged(knobs, KNOB_META)

    setText(presetName, scenario ?? (changed ? 'Custom' : 'Defaults'))
    presetDot.dataset.state = scenario ? 'scenario' : changed ? 'custom' : 'default'
    setText(
      changedText,
      changed === 0 ? 'stock configuration' : `${changed} parameter${changed === 1 ? '' : 's'} changed`,
    )
    resetBtn.disabled = changed === 0

    for (const g of groupBadges) {
      const n = countChanged(knobs, g.metas)
      setText(g.node, n ? String(n) : '')
      setClass(g.node, 'is-on', n > 0)
    }
  }

  /* --- wiring ------------------------------------------------------------ */

  const onNarrow = (): void => {
    compact = narrow.matches
    applyOpen()
  }
  narrow.addEventListener('change', onNarrow)

  /* Two sheets, one place to stand. */
  const onSheet = (e: Event): void => {
    if (sheetSideOf(e) !== 'left' && compact && open) setOpen(false)
  }
  window.addEventListener(SHEET_EVENT, onSheet)

  const offScenario = ctx.bus.on('scenario', () => refresh())
  const offReset = ctx.bus.on('sim:reset', () => {
    for (const c of controls) c.sync(true)
    refresh()
  })
  const offCameraPreset = ctx.bus.on('camera:preset', ({ preset }) => {
    planPreset = preset === 'plan'
    applyOpen()
    ctx.bus.emit('ui:layout', {})
  })
  const offConsole = looseBus.on('ui:console', () => setOpen(true))

  applyOpen()
  refresh()

  let acc = 0
  return {
    update(dt: number) {
      acc += dt
      if (acc < 0.2) return
      acc = 0
      for (const c of controls) c.sync()
      refresh()
    },
    dispose() {
      narrow.removeEventListener('change', onNarrow)
      window.removeEventListener(SHEET_EVENT, onSheet)
      offScenario()
      offReset()
      offCameraPreset()
      offConsole()
      for (const c of controls) c.dispose()
      host.remove()
      syncSheetFlags()
    },
  }
}
