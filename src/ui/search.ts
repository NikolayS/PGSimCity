import '../styles/tour.css'

import type { ComponentDef, ScenarioDef, TourChapter } from '../core/types'
import { SCENARIOS } from '../sim/scenarios'
import { KNOB_META } from './content'
import type { KnobMeta } from './content'
import { emitLoose } from './hud'
import { CHAPTERS } from './tour'
import { el, icon, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — THE COMMAND PALETTE
 *
 * One field over a dimmed city that searches the four things a viewer can
 * actually mean:
 *
 *   components  every registered building, via registry.search()
 *   settings    every GUC in KNOB_META — activating one opens the console,
 *               scrolls to the dial and flashes it
 *   scenarios   the guided experiments in sim/scenarios.ts
 *   chapters    the guided tour, jumped to directly
 *   anatomy     the physical page and directory instruments
 *
 * Opened with / or Ctrl+K (also from the HUD's toolbar over the loose
 * 'ui:palette' channel), closed with Escape, a backdrop click, or activating
 * anything. Escape is claimed through the shared { handled } payload so the HUD
 * does not also dismiss the inspector or the tour behind us.
 * ==========================================================================*/

interface LooseBus {
  on(type: string, fn: (p: unknown) => void): () => void
}

type ItemKind = 'component' | 'setting' | 'scenario' | 'chapter' | 'anatomy'

interface Item {
  kind: ItemKind
  /** stable id, used for the row's DOM id */
  key: string
  /** small uppercase badge shown on the left of the row */
  badge: string
  title: string
  sub: string
  run(): void
}

const GROUPS: { kind: ItemKind; label: string }[] = [
  { kind: 'component', label: 'Components' },
  { kind: 'setting', label: 'Settings' },
  { kind: 'scenario', label: 'Scenarios' },
  { kind: 'chapter', label: 'Tour chapters' },
  { kind: 'anatomy', label: 'Anatomy' },
]

const LIMITS: Record<ItemKind, number> = { component: 8, setting: 6, scenario: 5, chapter: 5, anatomy: 2 }

const ANATOMY = [
  {
    view: 'page',
    title: '8 KiB page anatomy',
    sub: 'Open a byte-scaled heap page: header, line pointers, free space and tuples',
  },
  {
    view: 'directory',
    title: 'Data directory anatomy',
    sub: 'Open the physical cluster tree: base/, relation forks, segments, WAL and config',
  },
] as const

/**
 * Curated starting points for an empty query — the eight places worth going
 * first. Components that no world module registered are skipped, so the list
 * is always honest about what exists.
 */
const CURATED: { kind: ItemKind; id: string }[] = [
  { kind: 'chapter', id: 'connect' },
  { kind: 'component', id: 'shared.buffers' },
  { kind: 'component', id: 'wal.vault' },
  { kind: 'component', id: 'checkpointer' },
  { kind: 'scenario', id: 'checkpoint-storm' },
  { kind: 'setting', id: 'synchronousCommit' },
  { kind: 'scenario', id: 'xmin-horizon' },
  { kind: 'component', id: 'replica.standby' },
  { kind: 'component', id: 'autovac.worker.0' },
  { kind: 'scenario', id: 'cache-thrash' },
  { kind: 'setting', id: 'sharedBuffers' },
]

const CURATED_MAX = 8

/* ---------------------------------------------------------------------------
 * Scoring. Cheap, predictable, and no regular expressions built from user
 * input: exact beats prefix beats word-start beats substring, and shorter
 * haystacks win ties.
 * -------------------------------------------------------------------------*/

function score(hay: string, needle: string): number {
  if (!hay) return -1
  const h = hay.toLowerCase()
  const at = h.indexOf(needle)
  if (at < 0) return -1
  if (h === needle) return 1000
  if (at === 0) return 620 - Math.min(200, h.length)
  const prev = h.charCodeAt(at - 1)
  const boundary = prev === 32 || prev === 46 || prev === 95 || prev === 45 || prev === 47
  return (boundary ? 400 : 240) - Math.min(150, h.length) - Math.min(60, at)
}

/** Best weighted score across a set of fields. */
function best(needle: string, fields: [string, number][]): number {
  let top = -1
  for (const [text, weight] of fields) {
    const s = score(text, needle)
    if (s > 0) top = Math.max(top, s * weight)
  }
  return top
}

/** Highlight every occurrence of the query without ever touching innerHTML. */
function markMatch(text: string, needle: string): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (!needle) {
    frag.append(text)
    return frag
  }
  const hay = text.toLowerCase()
  let i = 0
  let at = hay.indexOf(needle)
  if (at < 0) {
    frag.append(text)
    return frag
  }
  while (at >= 0) {
    if (at > i) frag.append(text.slice(i, at))
    frag.append(el('mark', { class: 'pal-mark', text: text.slice(at, at + needle.length) }))
    i = at + needle.length
    at = hay.indexOf(needle, i)
  }
  if (i < text.length) frag.append(text.slice(i))
  return frag
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export function createSearch(ctx: UiContext): UiModule {
  const bus = ctx.bus
  const sim = ctx.sim
  const registry = ctx.registry
  const cleanup: (() => void)[] = []
  const timers: number[] = []

  let open = false
  let query = ''
  let sel = 0
  let flat: { item: Item; node: HTMLElement }[] = []
  let lastFocus: HTMLElement | null = null

  /* =======================================================================
   * ACTIONS
   * =====================================================================*/

  function showComponent(id: string): void {
    bus.emit('select', { id })
    bus.emit('focus', { id })
  }

  function runScenario(def: ScenarioDef): void {
    sim.runScenario(def.id)
    bus.emit('toast', { text: `Scenario: ${def.name}`, kind: 'info', ms: 2600 })
  }

  function startChapter(i: number): void {
    bus.emit('tour:start', { chapter: i })
  }

  function openAnatomy(view: 'page' | 'directory'): void {
    bus.emit('anatomy:open', { view })
  }

  /**
   * Settings live in the console, not here. Ask for the rail, then walk the
   * DOM the way a user would: open the drawer, open the group, scroll the dial
   * into view and flash it. Every step is optional — if the console is not
   * mounted, the toast still tells the viewer where to look.
   */
  function revealKnob(meta: KnobMeta): void {
    emitLoose(bus, 'ui:console', { open: true, key: meta.key })
    bus.emit('ui:layout', {})
    bus.emit('toast', {
      text: `${meta.label} — highlighted in the console`,
      kind: 'info',
      ms: 3200,
    })

    timers.push(
      window.setTimeout(() => {
        const host = document.querySelector<HTMLElement>('.pgc-host')
        if (host && !host.classList.contains('is-open')) {
          host.querySelector<HTMLButtonElement>('.pgc-tab')?.click()
        }
        const input = document.querySelector<HTMLElement>(`[id^="pgc-${String(meta.key)}-"]`)
        if (!input) return
        const group = input.closest<HTMLElement>('.pg-collapse')
        if (group && !group.classList.contains('is-open')) {
          group.querySelector<HTMLButtonElement>('.pg-collapse__head')?.click()
        }
        const field = input.closest<HTMLElement>('.pg-field') ?? input
        timers.push(
          window.setTimeout(() => {
            field.scrollIntoView({ block: 'center', behavior: 'smooth' })
            field.classList.remove('pal-flash')
            void field.offsetWidth
            field.classList.add('pal-flash')
            timers.push(window.setTimeout(() => field.classList.remove('pal-flash'), 2200))
          }, 120),
        )
      }, 30),
    )
  }

  /* =======================================================================
   * ITEM BUILDERS
   * =====================================================================*/

  function componentItem(def: ComponentDef): Item {
    return {
      kind: 'component',
      key: def.id,
      badge: def.kind,
      title: def.name,
      sub: `${def.role} · ${def.id}`,
      run: () => showComponent(def.id),
    }
  }

  function settingItem(meta: KnobMeta): Item {
    return {
      kind: 'setting',
      key: String(meta.key),
      badge: meta.group,
      title: meta.guc ?? meta.label,
      sub: meta.hint,
      run: () => revealKnob(meta),
    }
  }

  function scenarioItem(def: ScenarioDef): Item {
    return {
      kind: 'scenario',
      key: def.id,
      badge: 'run',
      title: def.name,
      sub: def.blurb,
      run: () => runScenario(def),
    }
  }

  function chapterItem(ch: TourChapter, i: number): Item {
    return {
      kind: 'chapter',
      key: ch.id,
      badge: `ch ${i + 1}`,
      title: ch.title,
      sub: ch.body,
      run: () => startChapter(i),
    }
  }

  function anatomyItem(def: (typeof ANATOMY)[number]): Item {
    return {
      kind: 'anatomy',
      key: def.view,
      badge: 'open',
      title: def.title,
      sub: def.sub,
      run: () => openAnatomy(def.view),
    }
  }

  /* =======================================================================
   * COLLECTION
   * =====================================================================*/

  function curated(): Item[] {
    const out: Item[] = []
    for (const pick of CURATED) {
      if (out.length >= CURATED_MAX) break
      if (pick.kind === 'component') {
        const def = registry.get(pick.id)
        if (def) out.push(componentItem(def))
      } else if (pick.kind === 'setting') {
        const meta = KNOB_META.find((m) => String(m.key) === pick.id)
        if (meta) out.push(settingItem(meta))
      } else if (pick.kind === 'scenario') {
        const def = SCENARIOS.find((s) => s.id === pick.id)
        if (def) out.push(scenarioItem(def))
      } else {
        const i = CHAPTERS.findIndex((c) => c.id === pick.id)
        if (i >= 0) out.push(chapterItem(CHAPTERS[i], i))
      }
    }
    return out
  }

  function collect(raw: string): Item[] {
    const q = raw.trim().toLowerCase()
    if (!q) return curated()

    const out: Item[] = []

    for (const def of registry.search(q, LIMITS.component)) out.push(componentItem(def))

    const rank = <T,>(list: readonly T[], fields: (x: T) => [string, number][], limit: number): T[] =>
      list
        .map((x) => ({ x, s: best(q, fields(x)) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((r) => r.x)

    for (const meta of rank(
      KNOB_META,
      (m) => [
        [m.guc ?? '', 1.05],
        [m.label, 1],
        [String(m.key), 0.95],
        [m.hint, 0.42],
      ],
      LIMITS.setting,
    )) {
      out.push(settingItem(meta))
    }

    for (const def of rank(
      SCENARIOS,
      (s) => [
        [s.name, 1],
        [s.id, 0.9],
        [s.blurb, 0.5],
      ],
      LIMITS.scenario,
    )) {
      out.push(scenarioItem(def))
    }

    const chapterHits = rank(
      CHAPTERS.map((c, i) => ({ c, i })),
      ({ c }) => [
        [c.title, 1],
        [c.id, 0.85],
        [c.body, 0.4],
      ],
      LIMITS.chapter,
    )
    for (const { c, i } of chapterHits) out.push(chapterItem(c, i))

    for (const def of rank(
      ANATOMY,
      (item) => [
        [item.title, 1],
        [item.view, 0.95],
        [item.sub, 0.55],
      ],
      LIMITS.anatomy,
    )) {
      out.push(anatomyItem(def))
    }

    return out
  }

  /* =======================================================================
   * DOM
   * =====================================================================*/

  const input = el('input', {
    class: 'pal-input pg-mono',
    type: 'text',
    id: 'pal-input',
    placeholder: 'Search the city — buildings, settings, scenarios, anatomy',
    autocomplete: 'off',
    autocapitalize: 'off',
    role: 'combobox',
    'aria-label': 'Search PGSimCity',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'pal-list',
  })
  input.setAttribute('spellcheck', 'false')

  const list = el('div', { class: 'pal-list pg-scroll', id: 'pal-list', role: 'listbox' })
  list.setAttribute('aria-label', 'Results')

  const countEl = el('span', { class: 'pal-foot__count', text: '' })

  const hint = (keys: string[], what: string): HTMLElement =>
    el(
      'span',
      { class: 'pal-hint' },
      ...keys.map((k) => el('kbd', { class: 'pg-kbd', text: k })),
      el('span', { class: 'pal-hint__t', text: what }),
    )

  const dialog = el(
    'div',
    {
      class: 'pal-dialog pg-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Command palette',
    },
    el(
      'div',
      { class: 'pal-head' },
      el('span', { class: 'pal-head__icon' }, icon('search', 15)),
      input,
      el('kbd', { class: 'pg-kbd pal-head__esc', text: 'esc' }),
    ),
    list,
    el(
      'div',
      { class: 'pal-foot' },
      hint(['↑', '↓'], 'navigate'),
      hint(['⏎'], 'open'),
      hint(['esc'], 'close'),
      countEl,
    ),
  )

  const overlay = el('div', { class: 'pal-overlay', hidden: true }, dialog)
  document.body.append(overlay)

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) setOpen(false)
  })

  /* =======================================================================
   * RENDER
   * =====================================================================*/

  function rowNode(item: Item, i: number, q: string): HTMLElement {
    const title = el('span', { class: 'pal-row__title' })
    title.append(markMatch(item.title, q))
    const sub = el('span', { class: 'pal-row__sub' })
    sub.append(markMatch(item.sub, q))

    const node = el(
      'div',
      {
        class: 'pal-row',
        id: `pal-row-${i}`,
        role: 'option',
        'aria-selected': 'false',
        data: { kind: item.kind },
      },
      el('span', { class: 'pal-row__badge', text: item.badge }),
      el('span', { class: 'pal-row__main' }, title, sub),
      el('span', { class: 'pal-row__go', text: '↵' }),
    )
    node.addEventListener('mousemove', () => setSel(i))
    node.addEventListener('click', () => {
      setSel(i)
      activate()
    })
    return node
  }

  function render(): void {
    const q = query.trim().toLowerCase()
    const items = collect(query)
    flat = []
    list.replaceChildren()

    if (items.length === 0) {
      list.append(
        el(
          'div',
          { class: 'pal-empty' },
          el('p', { class: 'pal-empty__t', text: `Nothing matches “${query.trim()}”` }),
          el('p', {
            class: 'pal-empty__s',
            text: 'Try a building (buffers), a parameter (max_wal_size), a scenario (bloat), or anatomy (page).',
          }),
        ),
      )
      setText(countEl, 'no results')
      sel = 0
      paintSel()
      return
    }

    for (const group of GROUPS) {
      const inGroup = items.filter((it) => it.kind === group.kind)
      if (inGroup.length === 0) continue
      list.append(el('div', { class: 'pal-group pg-eyebrow', text: group.label }))
      for (const item of inGroup) {
        const node = rowNode(item, flat.length, q)
        flat.push({ item, node })
        list.append(node)
      }
    }

    setText(countEl, `${flat.length} result${flat.length === 1 ? '' : 's'}`)
    sel = 0
    paintSel()
  }

  function paintSel(): void {
    for (let i = 0; i < flat.length; i++) {
      const on = i === sel
      setClass(flat[i].node, 'is-sel', on)
      flat[i].node.setAttribute('aria-selected', on ? 'true' : 'false')
    }
    const active = flat[sel]
    if (active) {
      input.setAttribute('aria-activedescendant', active.node.id)
      active.node.scrollIntoView({ block: 'nearest' })
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }

  function setSel(i: number): void {
    if (flat.length === 0) return
    const next = ((i % flat.length) + flat.length) % flat.length
    if (next === sel) return
    sel = next
    paintSel()
  }

  function activate(): void {
    const hit = flat[sel]
    if (!hit) return
    setOpen(false)
    hit.item.run()
  }

  /* =======================================================================
   * OPEN / CLOSE
   * =====================================================================*/

  function setOpen(next: boolean): void {
    if (next === open) return
    open = next
    overlay.hidden = !next
    input.setAttribute('aria-expanded', next ? 'true' : 'false')
    document.body.classList.toggle('pg-palette-open', next)
    if (next) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      query = ''
      input.value = ''
      render()
      // focus after the frame that unhides it, or the browser ignores it
      requestAnimationFrame(() => input.focus())
    } else {
      list.replaceChildren()
      flat = []
      const back = lastFocus
      lastFocus = null
      if (back && document.contains(back) && back !== document.body) back.focus()
      else document.querySelector<HTMLCanvasElement>('#canvas-root canvas')?.focus()
    }
  }

  input.addEventListener('input', () => {
    query = input.value
    render()
  })

  /* =======================================================================
   * KEYBOARD
   *
   * One capture-phase listener: it opens the palette before anything else can
   * claim / or Ctrl+K, and while the palette is open it consumes the keys it
   * uses so neither the HUD nor the camera rig ever sees them.
   * =====================================================================*/

  function isTypingTarget(t: EventTarget | null): boolean {
    const node = t as HTMLElement | null
    if (!node || typeof node.tagName !== 'string') return false
    const tag = node.tagName
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || node.isContentEditable === true
  }

  function onKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey

    if (!open) {
      if (isTypingTarget(e.target)) return
      if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
      } else if (e.key === '/' && !mod && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
      }
      return
    }

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        setSel(sel + 1)
        return
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        setSel(sel - 1)
        return
      case 'Home':
        if (flat.length) {
          e.preventDefault()
          e.stopPropagation()
          setSel(0)
        }
        return
      case 'End':
        if (flat.length) {
          e.preventDefault()
          e.stopPropagation()
          setSel(flat.length - 1)
        }
        return
      case 'Tab':
        e.preventDefault()
        e.stopPropagation()
        setSel(sel + (e.shiftKey ? -1 : 1))
        return
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        activate()
        return
      default:
        // Everything else is typing. It must reach the input untouched, and
        // the HUD and the camera rig both ignore keys aimed at a field.
        break
    }
  }

  window.addEventListener('keydown', onKeyDown, true)
  cleanup.push(() => window.removeEventListener('keydown', onKeyDown, true))

  /* =======================================================================
   * BUS
   * =====================================================================*/

  const loose = bus as unknown as LooseBus
  cleanup.push(
    loose.on('ui:palette', (p) => {
      const req = p as { open?: boolean } | undefined
      setOpen(req && typeof req.open === 'boolean' ? req.open : !open)
    }),
    loose.on('ui:escape', (p) => {
      if (!open) return
      setOpen(false)
      const payload = p as { handled?: boolean } | undefined
      if (payload) payload.handled = true
    }),
    // The city taking over the screen closes the palette in front of it.
    bus.on('tour:start', () => setOpen(false)),
  )

  /* Nothing in the palette is live, so the frame tick has no work to do. */
  function update(_dt: number): void {
    void _dt
  }

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    for (const t of timers) window.clearTimeout(t)
    timers.length = 0
    document.body.classList.remove('pg-palette-open')
    overlay.remove()
  }

  return { update, dispose }
}
