import '../styles/panel.css'

import type { ComponentDef, ComponentDoc, ComponentKind, Knobs, SimState } from '../core/types'
import { doc, knobMeta, mdToHtml } from './content'
import { createCollapse, createKnobControl, loadFlag, saveFlag } from './controls'
import type { KnobControl } from './controls'
import { clear, el, icon, metricTile, setClass, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGCITY — the inspector (#hud-right).
 *
 * One component at a time: what it is, what it is doing right now, and the
 * dials that change its behaviour. Live numbers sit above the prose because
 * they are the reason any of the prose is interesting.
 * ==========================================================================*/

/** Metric + readout refresh rate. Text at 6 Hz reads as continuous. */
const TICK = 1 / 6

const SUGGESTIONS = ['shared.buffers', 'checkpointer', 'autovac.worker.0', 'replica.standby']

const OPEN_KEY = 'pgcity.inspector.open'

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

/* ===========================================================================
 * createInspector
 * =========================================================================*/

export function createInspector(ctx: UiContext): UiModule {
  const mount = document.getElementById('hud-right')
  if (!mount) {
    console.warn('[pgcity] #hud-right is missing — the inspector has nowhere to live')
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
      title: 'Clear the selection',
      'aria-label': 'Clear the selection',
      on: {
        click: () => {
          ctx.bus.emit('select', { id: null })
          if (compact) setOpen(false)
        },
      },
    },
    icon('close', 13),
  )

  const head = el(
    'header',
    { class: 'pg-panel__head pgc-insp__head' },
    el('div', { class: 'pgc-insp__top' }, kindBadge, el('span', { class: 'pgc-spacer' }), flyBtn, closeBtn),
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
  tab.append(icon('layers', 15))

  host.append(tab, panel)
  mount.append(host)

  /* --- open / collapsed state -------------------------------------------- */

  const narrow = window.matchMedia('(max-width: 1100px)')
  let compact = narrow.matches
  let openWide = loadFlag(OPEN_KEY, true)
  let openNarrow = false

  const isOpen = (): boolean => (compact ? openNarrow : openWide)

  function applyOpen(): void {
    const open = isOpen()
    setClass(host, 'is-compact', compact)
    setClass(host, 'is-open', open)
    tab.setAttribute('aria-expanded', String(open))
    tab.title = open ? 'Hide the inspector' : 'Show the inspector'
    tab.setAttribute('aria-label', tab.title)
    panel.setAttribute('aria-hidden', String(!open))
    panel.inert = !open && compact
  }

  function setOpen(next: boolean): void {
    if (compact) openNarrow = next
    else {
      openWide = next
      saveFlag(OPEN_KEY, next)
    }
    applyOpen()
    ctx.bus.emit('ui:layout', {})
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

  /* --- empty state ------------------------------------------------------- */

  function renderEmpty(): HTMLElement {
    const wrap = el('div', { class: 'pgc-content pgc-empty pg-enter' })
    wrap.append(
      el('p', { class: 'pg-eyebrow', text: 'Nothing selected' }),
      el('p', { class: 'pgc-empty__lead', text: 'Click any building.' }),
      el('p', {
        class: 'pg-hint',
        text: 'Every structure in the city is one real mechanism inside PostgreSQL. Open one and it explains itself, with its own live counters and the parameters that govern it.',
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

    /* source */
    const source = info?.source ?? []
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

    return wrap
  }

  /* --- selection --------------------------------------------------------- */

  function select(id: string | null): void {
    if (id === currentId) {
      if (id && compact && !openNarrow) setOpen(true)
      return
    }
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
      closeBtn.disabled = true
      body.append(renderEmpty())
      body.scrollTop = 0
      return
    }

    const kind = def?.kind ?? inferKind(id)
    kindBadge.hidden = false
    kindBadge.dataset.kind = kind
    setText(kindBadge, kind)
    if (def?.color != null) kindBadge.style.setProperty('--kind', hex6(def.color))
    else kindBadge.style.removeProperty('--kind')

    setText(title, def?.name ?? info?.title ?? id)
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
    if (compact) setOpen(true)
  }

  /* --- wiring ------------------------------------------------------------ */

  const offSelect = ctx.bus.on('select', ({ id }) => select(id))

  const onNarrow = (): void => {
    compact = narrow.matches
    if (compact) openNarrow = false
    applyOpen()
  }
  narrow.addEventListener('change', onNarrow)

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
      narrow.removeEventListener('change', onNarrow)
      teardown()
      host.remove()
    },
  }
}
