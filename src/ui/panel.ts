import '../styles/panel.css'

import { destinationForId } from '../core/destinations'
import type { ComponentDef, ComponentDoc, ComponentKind, DocRef, DocReferences, Knobs, SimState } from '../core/types'
import { doc, knobMeta, mdToHtml } from './content'
import {
  SHEET_EVENT,
  announceSheet,
  createCollapse,
  createKnobControl,
  loadFlag,
  saveFlag,
  sheetSideOf,
  syncSheetFlags,
} from './controls'
import type { KnobControl } from './controls'
import { clear, el, icon, metricTile, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — the inspector (#hud-right).
 *
 * One component at a time: what it is, what it is doing right now, and the
 * dials that change its behaviour. Live numbers sit above the prose because
 * they are the reason any of the prose is interesting.
 * ==========================================================================*/

/** Metric + readout refresh rate. Text at 6 Hz reads as continuous. */
const TICK = 1 / 6

const SUGGESTIONS = ['shared.buffers', 'checkpointer', 'autovac.worker.0', 'replica.standby']

const OPEN_KEY = 'pgsimcity.inspector.open'

/* ---------------------------------------------------------------------------
 * Kind badge. The registry is authoritative; this is the fallback for docs
 * that describe an idea rather than a registered object.
 * -------------------------------------------------------------------------*/

const KIND_HINTS: [RegExp, ComponentKind][] = [
  [/^client\.|^conn\./, 'client'],
  [/localmem|^shmem|^shared\.|^buf\.|^proc\.array|^clog|^wal\.buffers|^os\.cache/, 'memory'],
  [
    /^postmaster|^backend\.|^autovac\.|^checkpointer|^bgwriter|^walwriter|^archiver|^startup|^walsender|^walreceiver|^logical\.decoder|^stats\./,
    'process',
  ],
  [/^storage|^disk|^archive|^landfill|^wal\.vault|^replica\.storage/, 'storage'],
  [/^net\.|^replica|^subscriber|^stream/, 'network'],
]

function inferKind(id: string): ComponentKind {
  for (const [re, kind] of KIND_HINTS) if (re.test(id)) return kind
  return 'concept'
}

const hex6 = (c: number): string => `#${(c >>> 0).toString(16).padStart(6, '0').slice(-6)}`

/* ---------------------------------------------------------------------------
 * Prose. mdToHtml handles the inline marks; paragraphs are real elements so
 * they can have real spacing.
 * -------------------------------------------------------------------------*/

function proseBody(text: string): HTMLElement {
  const wrap = el('div', { class: 'pg-body pgc-prose' })
  for (const para of text.split(/\n{2,}/)) {
    const t = para.trim()
    if (t) wrap.append(el('p', { class: 'pgc-p', html: mdToHtml(t) }))
  }
  return wrap
}

type AnatomyView = 'page' | 'directory'

function discussesPageLayout(id: string, heading: string, body: string, sectionIndex: number): boolean {
  if ((id.startsWith('storage.table.') || id.startsWith('storage.index.')) && sectionIndex === 0) return true
  const copy = `${heading} ${body}`
  return /\b(?:page layout|8\s*KiB\s+pages?)\b/i.test(copy)
}

/* ---------------------------------------------------------------------------
 * References — the reading list behind each component.
 *
 * Everything here is checkable: a manual page, a file in the PostgreSQL tree, a
 * chapter of a book. That is the whole point, so the renderer never dresses up
 * a reference as something it is not. No URL means no link.
 * -------------------------------------------------------------------------*/

/** One reference line. A link only when there is a real URL to link to. */
function refLine(r: DocRef): HTMLElement {
  const li = el('li', { class: 'pgc-src__i pgc-ref' })
  li.append(
    r.url
      ? el('a', { class: 'pgc-ref__a', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: r.label })
      : el('span', { class: 'pgc-ref__t', text: r.label }),
  )
  if (r.symbol) li.append(document.createTextNode(' '), el('span', { class: 'pgc-ref__sym pg-mono', text: r.symbol }))
  if (r.verified === false) {
    const dagger = el('span', { class: 'pgc-ref__unver', text: ' †' })
    dagger.title = 'the link is good; the section or chapter number has not been re-checked'
    li.append(dagger)
  }
  return li
}

/**
 * One labelled group. Everything else is borrowed from the "In the source"
 * block's classes so the two read as the same object; the one inline rule is
 * the gap between groups, which belongs in `.pgc-ref__g` in panel.css the next
 * time that file is open.
 */
function refGroup(heading: string, items: HTMLElement[]): HTMLElement | null {
  if (!items.length) return null
  return el(
    'div',
    { class: 'pgc-ref__g', style: { marginTop: '10px' } },
    el('span', { class: 'pg-eyebrow', text: heading }),
    el('ul', { class: 'pgc-src pgc-ref__list' }, ...items),
  )
}

function renderRefs(refs: DocReferences): HTMLElement | null {
  const groups: (HTMLElement | null)[] = [
    refGroup('Documentation', (refs.docs ?? []).map(refLine)),
    refGroup('Source', (refs.source ?? []).map(refLine)),
    refGroup(
      'The Internals of PostgreSQL',
      refs.suzuki ? [refLine({ ...refs.suzuki, label: `ch. ${refs.suzuki.chapter} — ${refs.suzuki.label}` })] : [],
    ),
  ]

  // Rogov: "PostgreSQL 14 Internals" is a book. The reference apparatus supplies
  // NO url for it, by explicit instruction, because there is no canonical public
  // page for a chapter — inventing one would be a fabricated citation. Render it
  // as plain text, never as an <a>. Do not "helpfully" add a link here later.
  if (refs.rogov) {
    const r = refs.rogov
    const line = el(
      'li',
      { class: 'pgc-src__i pgc-ref' },
      el('span', { class: 'pgc-ref__t', text: r.edition }),
      el('br'),
      el('span', { class: 'pgc-ref__t', text: `${r.part} · ${r.chapter}` }),
    )
    if (r.confidence) line.title = `confidence: ${r.confidence}`
    groups.push(refGroup('In print', [line]))
  }

  const kept = groups.filter((g): g is HTMLElement => g != null)
  if (!kept.length) return null

  const block = el('div', { class: 'pgc-block pgc-block--refs' }, el('span', { class: 'pg-eyebrow', text: 'Go deeper' }))
  const body = el('div', { class: 'pg-body' }, ...kept)
  block.append(body)
  return block
}

/* ===========================================================================
 * createInspector
 * =========================================================================*/

export function createInspector(ctx: UiContext): UiModule {
  const mount = document.getElementById('hud-right')
  if (!mount) {
    console.warn('[PGSimCity] #hud-right is missing — the inspector has nowhere to live')
    return { update() {}, dispose() {} }
  }

  const host = el('div', { class: 'pgc-host pgc-host--right' })

  /* --- header ------------------------------------------------------------ */

  const kindBadge = el('span', { class: 'pgc-kind' })
  const title = el('h2', { class: 'pg-title pgc-insp__title', text: 'Nothing selected' })
  const subtitle = el('p', { class: 'pg-sub pgc-insp__sub', text: 'Click a building to open it up' })
  const readout = el('p', { class: 'pgc-readout' })

  const flyBtn = el(
    'button',
    {
      class: 'pg-btn pgc-fly',
      type: 'button',
      title: 'Fly the camera to this component',
      on: { click: () => currentId && ctx.bus.emit('focus', { id: currentId }) },
    },
    icon('camera', 13),
    el('span', { text: 'Fly to' }),
  )

  const closeBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon pgc-insp__close',
      type: 'button',
      title: 'Close the inspector',
      'aria-label': 'Close the inspector',
      on: {
        click: () => {
          ctx.bus.emit('select', { id: null })
          setOpen(false)
        },
      },
    },
    icon('close', 13),
  )

  /* Phone only: the sheet keeps the bottom 42% by default so the city keeps the
     rest. This buys the other 40% when you are reading rather than exploring. */
  const sizeBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon pgc-sheet-size',
      type: 'button',
      title: 'Expand the inspector',
      'aria-label': 'Expand the inspector',
      'aria-expanded': 'false',
      on: { click: () => setTall(!tall) },
    },
    icon('chevron', 13),
  )

  const head = el(
    'header',
    { class: 'pg-panel__head pgc-insp__head' },
    el(
      'div',
      { class: 'pgc-insp__top' },
      kindBadge,
      el('span', { class: 'pgc-spacer' }),
      sizeBtn,
      flyBtn,
      closeBtn,
    ),
    title,
    subtitle,
    readout,
  )

  /* --- body -------------------------------------------------------------- */

  const body = el('div', { class: 'pg-panel__body pg-scroll pgc-insp__body', tabindex: '0' })
  body.setAttribute('role', 'region')
  body.setAttribute('aria-label', 'Component notes')

  const panel = el('section', { class: 'pg-panel pgc-panel pgc-insp' }, head, body)
  panel.setAttribute('aria-label', 'Inspector')

  const tab = el('button', {
    class: 'pg-btn pg-btn--icon pgc-tab pgc-tab--right',
    type: 'button',
    on: { click: () => setOpen(!isOpen()) },
  })
  tab.append(icon('layers', 15), el('span', { class: 'pgc-tab__label', text: 'Inspector' }))

  host.append(tab, panel)
  mount.append(host)

  /* --- open / collapsed state -------------------------------------------- */

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
    tab.title = panelOpen ? 'Hide the inspector' : 'Show the inspector'
    tab.setAttribute('aria-label', tab.title)
    panel.setAttribute('aria-hidden', String(!panelOpen))
    panel.inert = !panelOpen
    syncSheetFlags()
  }

  function setOpen(next: boolean): void {
    open = next
    saveFlag(OPEN_KEY, next)
    applyOpen()
    if (next && compact) announceSheet('right')
    ctx.bus.emit('ui:layout', {})
  }

  function setTall(next: boolean): void {
    tall = next
    setClass(panel, 'is-tall', tall)
    sizeBtn.title = tall ? 'Shrink the inspector' : 'Expand the inspector'
    sizeBtn.setAttribute('aria-label', sizeBtn.title)
    sizeBtn.setAttribute('aria-expanded', String(tall))
    syncSheetFlags()
  }

  /* --- live pieces, rebuilt on every selection --------------------------- */

  type Tile = { set(v: string, state?: '' | 'ok' | 'warn' | 'crit'): void; get: (s: SimState) => string }
  let tiles: Tile[] = []
  let knobs: KnobControl[] = []
  let liveDot: HTMLElement | null = null
  /** undefined until the first render, so the empty state is drawn on boot */
  let currentId: string | null | undefined
  let currentDef: ComponentDef | undefined
  /** seconds since the last metric refresh; primed so the first frame paints */
  let acc = TICK
  /** which prose sections the user left open, per component, for this session */
  const sectionState = new Map<string, boolean[]>()

  function teardown(): void {
    for (const k of knobs) k.dispose()
    knobs = []
    tiles = []
    liveDot = null
    clear(body)
  }

  function anatomyEntry(view: AnatomyView, id: string): HTMLElement {
    const page = view === 'page'
    return el(
      'aside',
      {
        class: 'pgc-anatomy-entry',
        data: { anatomyEntry: view },
        ariaLabel: page ? 'Open the 8 KiB page anatomy' : 'Open the data directory anatomy',
      },
      el(
        'div',
        { class: 'pgc-anatomy-entry__copy' },
        el('strong', {
          class: 'pgc-anatomy-entry__title',
          text: page ? 'What is inside that 8 KiB page?' : 'What is actually inside the data directory?',
        }),
        el('span', {
          class: 'pgc-anatomy-entry__hint',
          text: page
            ? 'Open the byte-scaled header, line pointers, free space and tuple layout.'
            : 'Open base/, relation forks, segment suffixes, WAL and configuration files.',
        }),
      ),
      el(
        'button',
        {
          class: 'pg-btn pgc-anatomy-entry__button',
          type: 'button',
          on: { click: () => ctx.bus.emit('anatomy:open', { view, id }) },
        },
        el('span', { text: page ? 'Open page' : 'Open directory' }),
        el('span', { class: 'pgc-anatomy-entry__arrow', ariaHidden: 'true', text: '→' }),
      ),
    )
  }

  /* --- empty state ------------------------------------------------------- */

  function renderEmpty(): HTMLElement {
    const wrap = el('div', { class: 'pgc-content pgc-empty pg-enter' })
    wrap.append(
      el('p', {
        class: 'pg-hint',
        text: 'Every structure in the city is one real mechanism inside Postgres. Open one and it explains itself, with its own live counters and the parameters that govern it.',
      }),
    )

    const list = el('div', { class: 'pgc-empty__list' })
    for (const id of SUGGESTIONS) {
      const d = ctx.registry.get(id)
      const info = doc(id)
      const name = d?.name ?? info?.title ?? id
      const why = d?.role ?? info?.subtitle ?? ''
      list.append(
        el(
          'button',
          {
            class: 'pg-btn pgc-empty__btn',
            type: 'button',
            on: {
              click: () => {
                ctx.bus.emit('focus', { id })
                ctx.bus.emit('select', { id })
              },
            },
          },
          el('span', { class: 'pgc-empty__n', text: name }),
          why ? el('span', { class: 'pgc-empty__w', text: why }) : null,
        ),
      )
    }
    wrap.append(el('p', { class: 'pg-eyebrow pgc-empty__k', text: 'Start here' }), list)

    const keys = el('p', { class: 'pgc-empty__keys' })
    keys.append(
      el('span', { class: 'pg-kbd', text: '1' }),
      document.createTextNode('–'),
      el('span', { class: 'pg-kbd', text: '8' }),
      document.createTextNode(' jump between districts · '),
      el('span', { class: 'pg-kbd', text: 'T' }),
      document.createTextNode(' takes the guided tour'),
    )
    wrap.append(keys)

    /* Whose shoulders this stands on. Named here rather than in every panel,
       and worded so nobody reads it as an endorsement — none of these people
       has seen this city. Each component also links the exact page or chapter
       it draws on, under "Go deeper". */
    wrap.append(
      el('p', { class: 'pg-eyebrow pgc-empty__k', text: 'Where this comes from' }),
      el('p', {
        class: 'pg-hint',
        text: 'The explanations lean on the PostgreSQL documentation, Bruce Momjian’s talks and slides, Hironobu Suzuki’s “The Internals of PostgreSQL”, and Egor Rogov’s “PostgreSQL 14 Internals”. With thanks — and to be clear, none of them is involved in this project or has reviewed it. Every mistake you find here is this project’s own.',
      }),
    )
    return wrap
  }

  /* --- populated state --------------------------------------------------- */

  function renderDoc(id: string, info: ComponentDoc | undefined): HTMLElement {
    const wrap = el('div', { class: 'pgc-content pg-enter' })

    /* metrics first — the numbers are the reason this feels alive */
    const metrics = info?.metrics ?? []
    if (metrics.length) {
      const dot = el('span', { class: 'pgc-live-dot' })
      liveDot = dot
      const grid = el('div', { class: 'pg-metrics pgc-metrics' })
      for (const m of metrics) {
        const tile = metricTile(m.label)
        if (m.hint) tile.root.title = m.hint
        grid.append(tile.root)
        tiles.push({ set: tile.set, get: m.get })
      }
      wrap.append(
        el('div', { class: 'pgc-block pgc-block--metrics' }, el('div', { class: 'pgc-eyebrow-row' }, el('span', { class: 'pg-eyebrow', text: 'Live' }), dot), grid),
      )
    }

    /* prose */
    if (info?.sections?.length) {
      const remembered = sectionState.get(id)
      const flags: boolean[] = []
      const prose = el('div', { class: 'pgc-block pgc-block--prose' })
      info.sections.forEach((section, i) => {
        const open = remembered?.[i] ?? i === 0
        flags.push(open)
        const collapse = createCollapse(section.heading, {
          open,
          // `flags` is the array held by sectionState, so this remembers itself
          onToggle: (next) => {
            flags[i] = next
          },
        })
        collapse.root.classList.add('pgc-section')
        collapse.body.append(proseBody(section.body))
        if (id === 'storage.datadir' && section.heading === 'The layout') {
          collapse.body.append(anatomyEntry('directory', id))
        }
        if (discussesPageLayout(id, section.heading, section.body, i)) {
          collapse.body.append(anatomyEntry('page', id))
        }
        prose.append(collapse.root)
      })
      sectionState.set(id, flags)
      wrap.append(prose)
    } else {
      wrap.append(
        el(
          'div',
          { class: 'pgc-block pgc-block--prose' },
          el('p', { class: 'pg-eyebrow', text: 'No notes' }),
          el('p', {
            class: 'pg-hint',
            text: 'No notes for this one yet. It is a real part of the city — it just has not been written up.',
          }),
        ),
      )
    }

    /* inline knobs */
    const keys = (info?.knobs ?? []).filter((k, i, a) => a.indexOf(k) === i) as (keyof Knobs)[]
    if (keys.length) {
      const block = el(
        'div',
        { class: 'pgc-block pgc-block--knobs' },
        el('div', { class: 'pgc-eyebrow-row' }, el('span', { class: 'pg-eyebrow', text: 'Change it' })),
      )
      let added = 0
      for (const key of keys) {
        const meta = knobMeta(key)
        if (!meta) continue
        const control = createKnobControl(ctx, meta)
        knobs.push(control)
        block.append(control.root)
        added += 1
      }
      if (added) wrap.append(block)
    }

    /* related */
    const see = info?.see ?? []
    if (see.length) {
      const row = el('div', { class: 'pgc-see' })
      for (const other of see) {
        const d = ctx.registry.get(other)
        const info2 = doc(other)
        const label = d?.name ?? info2?.title ?? other
        row.append(
          el('button', {
            class: 'pg-btn pgc-see__btn',
            type: 'button',
            text: label,
            title: `${other} — click to inspect, double-click to fly there`,
            on: {
              click: () => ctx.bus.emit('select', { id: other }),
              dblclick: () => ctx.bus.emit('focus', { id: other }),
            },
          }),
        )
      }
      wrap.append(
        el('div', { class: 'pgc-block pgc-block--see' }, el('span', { class: 'pg-eyebrow', text: 'Related' }), row),
      )
    }

    /* source — the plain-path list, for docs that have no linked reading list
       yet. Where `refs.source` exists it says the same thing with URLs and
       function names, so showing both would just print every path twice. */
    const source = info?.refs?.source?.length ? [] : (info?.source ?? [])
    if (source.length) {
      const list = el('ul', { class: 'pgc-src' })
      for (const path of source) list.append(el('li', { class: 'pgc-src__i pg-mono', text: path }))
      wrap.append(
        el(
          'div',
          { class: 'pgc-block pgc-block--src' },
          el('span', { class: 'pg-eyebrow', text: 'In the source' }),
          list,
        ),
      )
    }

    /* references — the reading list, only if this doc has one */
    if (info?.refs) {
      const block = renderRefs(info.refs)
      if (block) wrap.append(block)
    }

    return wrap
  }

  /* --- selection --------------------------------------------------------- */

  function select(id: string | null): void {
    if (id === currentId) {
      if (id && !open) setOpen(true)
      return
    }
    const clearedSelection = id == null && currentId != null
    currentId = id
    teardown()

    const def = id ? ctx.registry.get(id) : undefined
    const info = id ? doc(id) : undefined
    currentDef = def

    if (!id) {
      kindBadge.hidden = true
      setText(title, 'Nothing selected')
      setText(subtitle, 'Click a building to open it up')
      subtitle.hidden = false
      setText(readout, '')
      readout.hidden = true
      flyBtn.disabled = true
      closeBtn.disabled = false
      body.append(renderEmpty())
      body.scrollTop = 0
      if (clearedSelection) setOpen(false)
      return
    }

    const kind = def?.kind ?? inferKind(id)
    kindBadge.hidden = false
    kindBadge.dataset.kind = kind
    setText(kindBadge, kind)
    if (def?.color != null) kindBadge.style.setProperty('--kind', hex6(def.color))
    else kindBadge.style.removeProperty('--kind')

    setText(title, destinationForId(id)?.name ?? def?.name ?? info?.title ?? id)
    const sub = def?.role ?? info?.subtitle ?? ''
    setText(subtitle, sub)
    subtitle.hidden = !sub
    readout.hidden = !def?.readout
    flyBtn.disabled = !def
    flyBtn.title = def ? 'Fly the camera to this component' : 'This one has no place in the city to fly to'
    closeBtn.disabled = false

    body.append(renderDoc(id, info))
    body.scrollTop = 0
    acc = TICK // paint the new metrics on the very next frame, not 160ms later
    setOpen(true)
  }

  /* --- wiring ------------------------------------------------------------ */

  const offSelect = ctx.bus.on('select', ({ id, outlineOnly }) => {
    if (!outlineOnly) select(id)
  })
  const offCameraPreset = ctx.bus.on('camera:preset', ({ preset }) => {
    planPreset = preset === 'plan'
    applyOpen()
    ctx.bus.emit('ui:layout', {})
  })

  const onNarrow = (): void => {
    compact = narrow.matches
    applyOpen()
  }
  narrow.addEventListener('change', onNarrow)

  /* Two sheets, one place to stand. */
  const onSheet = (e: Event): void => {
    if (sheetSideOf(e) !== 'right' && compact && open) setOpen(false)
  }
  window.addEventListener(SHEET_EVENT, onSheet)

  applyOpen()
  select(null)

  return {
    update(dt: number) {
      acc += dt
      if (acc < TICK) return
      acc = 0
      const s = ctx.sim.state
      for (const t of tiles) {
        let text = '—'
        try {
          text = t.get(s)
        } catch {
          text = '—'
        }
        t.set(text)
      }
      if (liveDot) setClass(liveDot, 'is-paused', s.knobs.paused)
      if (currentDef?.readout && !readout.hidden) {
        try {
          setText(readout, currentDef.readout(s))
        } catch {
          setText(readout, '')
        }
      }
      for (const k of knobs) k.sync()
    },
    dispose() {
      offSelect()
      offCameraPreset()
      narrow.removeEventListener('change', onNarrow)
      window.removeEventListener(SHEET_EVENT, onSheet)
      teardown()
      host.remove()
      syncSheetFlags()
    },
  }
}
