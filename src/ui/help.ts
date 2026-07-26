import '../styles/hud.css'

import { DESTINATIONS } from '../core/destinations'
import { COLOR, onThemeMode } from '../core/theme'
import type { Bus, ColorKey } from '../core/types'
import { el, icon } from './uikit'
import { emitLoose } from './hud'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — HELP OVERLAY
 *
 * One modal: the complete input map, the colour legend, and four sentences on
 * how to read the city. It is opened by the HUD (the `?` key or the toolbar
 * button) over the loose bus channel 'ui:help', and closes on Escape — which
 * arrives as 'ui:escape' with a mutable { handled } payload so the HUD knows
 * the key was consumed here and does not also dismiss the inspector.
 *
 * The legend reads straight out of core/theme.ts COLOR, so a palette change in
 * the 3D city can never disagree with the explanation of it.
 * ==========================================================================*/

interface LooseBus {
  on(type: string, fn: (p: unknown) => void): () => void
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface KeyRow {
  keys: string[]
  /** joiner shown between keys: ' ' for a sequence, 'or', '+' … */
  join?: string
  what: string
}

const CAMERA_KEYS: KeyRow[] = [
  { keys: ['LMB drag'], what: 'Pan — grab the ground and move it' },
  { keys: ['RMB drag'], what: 'Orbit around the city' },
  { keys: ['MMB drag', 'Ctrl+LMB'], join: 'or', what: 'Pan and orbit, for model-viewer habits' },
  { keys: ['Wheel'], what: 'Zoom' },
  { keys: ['1 finger'], what: 'Pan the map' },
  { keys: ['2 fingers'], what: 'Pinch to zoom · twist to turn · drag up or down to tilt' },
  { keys: ['Left thumb'], what: 'Walk — a small stick push walks; a full push runs' },
  { keys: ['Right thumb'], what: 'Look — drag while the left thumb keeps moving' },
  { keys: ['Jump', 'Crouch'], what: 'Jump / toggle crouch · while swimming, hold to rise / dive' },
  { keys: ['Click'], what: 'Select a building — in fly mode, capture the mouse' },
  { keys: ['W', 'A', 'S', 'D'], what: 'Fly — arrow keys work too' },
  { keys: ['Space', 'E'], join: 'or', what: 'Rise' },
  { keys: ['C', 'Q'], join: 'or', what: 'Descend' },
  { keys: ['Shift'], what: 'Boost' },
  { keys: ['Alt'], what: 'Precision — slow, fine movement' },
  { keys: ['PgUp', 'PgDn'], what: 'Change altitude' },
  { keys: ['Esc'], what: 'Leave pointer lock' },
]

const APP_KEYS: KeyRow[] = [
  { keys: ['K', 'P'], join: 'or', what: 'Pause / resume the simulation' },
  { keys: [',', '.'], what: 'Slower / faster (0.1× – 5×)' },
  { keys: ['T'], what: 'Guided tour' },
  { keys: ['R'], what: 'Reset — restart with default settings' },
  { keys: ['F'], what: 'Toggle fly / orbit camera · desktop; touch uses Walk mode' },
  { keys: ['G'], what: 'Get down — walk the city on foot, 1.7 m tall' },
  { keys: ['Walk button'], what: 'Touch equivalent of G; Exit walk returns to the map' },
  { keys: ['H'], what: 'Establishing shot of the whole city · View menu' },
  { keys: ['O'], what: 'Overview — straight down on the plate · View menu' },
  { keys: ['/', 'Ctrl K'], join: 'or', what: 'Command palette' },
  { keys: ['?'], what: 'This panel' },
  { keys: ['L'], what: 'Toggle floating labels · View menu' },
  { keys: ['N'], what: 'Daylight / night · theme control beside Sound' },
  { keys: ['M'], what: 'Sound on / off — audio starts off and remembers your choice' },
  { keys: ['Esc'], what: 'Close the topmost overlay' },
  { keys: ['1', '…', '8'], what: 'Jump to a district · View menu on phones' },
]

interface LegendRow {
  key: ColorKey
  name: string
  what: string
}

/** Every colour in the city that carries meaning, and the meaning. */
const LEGEND: LegendRow[] = [
  { key: 'client', name: 'Client', what: 'Application connections and the rows travelling back to them' },
  { key: 'postmaster', name: 'Postmaster', what: 'The supervisor process, and every fork it performs' },
  { key: 'backend', name: 'Backend', what: 'One OS process per connection — your query runs in here' },
  { key: 'shmem', name: 'Shared memory', what: 'Structures every backend can see: ProcArray, locks, CLOG' },
  { key: 'bufClean', name: 'Clean page', what: 'A buffer that matches what is on disk — free to evict' },
  { key: 'bufDirty', name: 'Dirty page', what: 'Modified in memory only. Somebody must write it out' },
  { key: 'bufPinned', name: 'Pinned page', what: 'In use right now — the clock sweep may not take it' },
  { key: 'wal', name: 'WAL', what: 'Write-ahead log records: the durability contract' },
  { key: 'archive', name: 'Archive', what: 'Completed WAL segments shipped to archive storage' },
  { key: 'storage', name: 'Storage', what: 'Heap files, the data directory, and physical disk I/O' },
  { key: 'index', name: 'Index', what: 'B-tree and GIN structures, and index-only lookups' },
  { key: 'toast', name: 'TOAST', what: 'Oversized values pushed out of the main heap' },
  { key: 'vacuum', name: 'Vacuum', what: 'Autovacuum workers and the dead tuples they collect' },
  { key: 'checkpoint', name: 'Checkpoint', what: 'The checkpointer flushing dirty pages to disk' },
  { key: 'bgwriter', name: 'bgwriter', what: 'Background cleaning ahead of the clock sweep' },
  { key: 'replication', name: 'Replication', what: 'WAL on the wire, and the standby replaying it' },
  { key: 'lock', name: 'Lock', what: 'A heavyweight lock, and the queue of backends waiting on it' },
]

const READING: { h: string; p: string }[] = [
  {
    h: 'The plaza',
    p: 'The lit grid in the centre is <code>shared_buffers</code> — one tile per 8 KiB page, blue when it matches disk, red when it has been modified in memory and not yet written. The rotating hand is the clock sweep looking for a frame to reuse.',
  },
  {
    h: 'The pit',
    p: 'The ground is cut away beneath the plaza. That excavation is the data directory: heap files, indexes, TOAST and the disks. Every trip down there is a page that was not in cache.',
  },
  {
    h: 'The WAL district',
    p: 'Everything east of the plaza is the write-ahead log. Changes go there <strong>before</strong> they reach the data files, and a commit waits for that amber stream to be flushed — never for the pages themselves.',
  },
  {
    h: 'The ground',
    p: 'The city stands on a poured plate with a kerb and an edge light, and beyond that kerb there is nothing. The plate is cut to the outline of Slonik, the PostgreSQL elephant: the trunk runs north over the client terminal, the ear lies south-west over the standby and recovery sites, and the brow reaches east over the WAL district. Press <code>O</code> to look straight down at it.',
  },
  {
    h: 'The standby',
    p: 'South of the city, one TCP connection carries WAL to a second cluster where a single process replays it in order. When it cannot keep up, that gap is your replication lag.',
  },
]

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export function createHelp(ctx: UiContext): UiModule {
  const bus: Bus = ctx.bus
  const root = document.getElementById('help-overlay') ?? el('div')
  const cleanup: (() => void)[] = []

  let open = false
  let lastFocus: HTMLElement | null = null

  /* ------------------------------- markup -------------------------------- */

  const keyChips = (row: KeyRow): HTMLElement => {
    const wrap = el('span', { class: 'help-keys' })
    row.keys.forEach((k, i) => {
      if (i > 0 && row.join) wrap.append(el('span', { class: 'help-keys__join', text: row.join }))
      wrap.append(el('kbd', { class: 'pg-kbd', text: k }))
    })
    return wrap
  }

  const keyTable = (title: string, rows: KeyRow[]): HTMLElement =>
    el(
      'section',
      { class: 'help-col' },
      el('h3', { class: 'pg-eyebrow help-h', text: title }),
      el(
        'dl',
        { class: 'help-keymap' },
        ...rows.flatMap((r) => [
          el('dt', {}, keyChips(r)),
          el('dd', { class: 'help-what', text: r.what }),
        ]),
      ),
    )

  /* The legend is the contract between the colours in the city and their
     meanings, so it has to follow the day/night switch — a swatch that still
     shows the night hex after the city has moved to daylight is a lie about the
     thing it exists to explain. */
  interface LegendUi {
    row: LegendRow
    swatch: HTMLElement
    hex: HTMLElement
  }
  const legendUi: LegendUi[] = []

  const paintLegend = (): void => {
    for (const item of legendUi) {
      const hex = '#' + COLOR[item.row.key].toString(16).padStart(6, '0')
      item.swatch.style.setProperty('--sw', hex)
      item.hex.textContent = hex
    }
  }

  const legendItem = (row: LegendRow): HTMLElement => {
    const swatch = el('span', { class: 'help-swatch' })
    const hex = el('code', { class: 'help-legend__hex' })
    legendUi.push({ row, swatch, hex })
    return el(
      'div',
      { class: 'help-legend__row' },
      swatch,
      el(
        'div',
        { class: 'help-legend__text' },
        el('span', { class: 'help-legend__name' }, row.name, hex),
        el('span', { class: 'help-legend__what', text: row.what }),
      ),
    )
  }

  const closeBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon help-close',
      type: 'button',
      'aria-label': 'Close',
      title: 'Close  (Esc)',
      on: { click: () => setOpen(false) },
    },
    icon('close', 14),
  )

  const controlsSection = el(
    'div',
    { class: 'help-cols', 'data-help-section': 'controls' },
    keyTable('Camera', CAMERA_KEYS),
    keyTable('Application', APP_KEYS),
  )
  const legendHeading = el('h3', {
    class: 'pg-eyebrow help-h',
    text: 'Colour legend',
    'data-help-section': 'legend',
  })
  const readingHeading = el('h3', {
    class: 'pg-eyebrow help-h',
    text: 'How to read the city',
    'data-help-section': 'reading',
  })
  const helpBody = el(
    'div',
    { class: 'pg-panel__body help-body pg-scroll' },
    controlsSection,
    el(
      'p',
      { class: 'pg-hint help-districts' },
      el('span', { class: 'pg-tag', text: '1 – 8' }),
      ' ',
      DESTINATIONS.map((destination) => destination.name).join(' · '),
    ),
    el('hr', { class: 'pg-divider' }),
    legendHeading,
    el('div', { class: 'help-legend' }, ...LEGEND.map(legendItem)),
    el('hr', { class: 'pg-divider' }),
    readingHeading,
    el(
      'div',
      { class: 'help-reading pg-body' },
      ...READING.map((r) =>
        el(
          'p',
          { class: 'help-reading__p' },
          el('strong', { text: r.h }),
          ' — ',
          el('span', { html: r.p }),
        ),
      ),
    ),
    el('p', {
      class: 'help-disclaimer',
      html:
        '<strong>Early, unreviewed prototype.</strong> PGSimCity is a teaching model, not a real server: the mechanisms are modelled, ' +
        'the numbers are simulated, and no PostgreSQL source code runs here. It was built quickly and ' +
        '<strong>almost certainly contains inaccuracies and mistakes</strong>, in both the simulation and the explanations.' +
        '<br><br>Found one? Corrections from people who know the engine are exactly what this needs — please ' +
        '<a href="https://github.com/NikolayS/PGSimCity/issues/new" target="_blank" rel="noopener">open an issue</a> or send a ' +
        '<a href="https://github.com/NikolayS/PGSimCity/pulls" target="_blank" rel="noopener">pull request</a>.',
    }),
  )

  const jumpButton = (label: string, target: 'controls' | 'legend' | 'reading', section: HTMLElement) =>
    el(
      'button',
      {
        class: 'pg-btn help-nav__button',
        type: 'button',
        'data-help-target': target,
        on: { click: () => section.scrollIntoView({ block: 'start' }) },
      },
      label,
    )
  const helpNav = el(
    'nav',
    { class: 'help-nav', 'aria-label': 'Help sections' },
    jumpButton('Controls', 'controls', controlsSection),
    jumpButton('Colours', 'legend', legendHeading),
    jumpButton('Reading', 'reading', readingHeading),
  )

  const dialog = el(
    'div',
    {
      class: 'help-dialog pg-panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'help-title',
      tabindex: '-1',
    },
    el(
      'header',
      { class: 'pg-panel__head help-head' },
      el(
        'div',
        { class: 'help-head__title' },
        el('h2', { class: 'pg-title', id: 'help-title', text: 'Controls & legend' }),
        el('p', { class: 'pg-sub', text: 'Everything you can press, and what every colour in the city means' }),
        helpNav,
      ),
      closeBtn,
    ),
    helpBody,
  )

  root.classList.add('help-overlay')
  root.hidden = true
  root.replaceChildren(dialog)
  paintLegend()
  cleanup.push(onThemeMode(paintLegend))

  /* ------------------------------ behaviour ------------------------------ */

  function focusables(): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (n) => n.offsetParent !== null || n === dialog,
    )
  }

  function setOpen(next: boolean): void {
    if (next === open) return
    open = next
    root.hidden = !next
    if (next) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.scrollTop = 0
      // focus after the frame that unhides it, or the browser ignores it
      requestAnimationFrame(() => closeBtn.focus())
    } else {
      const back = lastFocus
      lastFocus = null
      if (back && document.contains(back)) back.focus()
    }
  }

  // Backdrop click closes; clicks inside the dialog do not reach here.
  root.addEventListener('click', (e) => {
    if (e.target === root) setOpen(false)
  })

  // Focus trap. Escape is handled through the bus so the HUD keeps ownership
  // of the global key map and knows the key was consumed.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const list = focusables()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialog)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  })

  const loose = bus as unknown as LooseBus
  cleanup.push(
    loose.on('ui:help', (p) => {
      const req = p as { open?: boolean } | undefined
      setOpen(req && typeof req.open === 'boolean' ? req.open : !open)
    }),
    loose.on('ui:escape', (p) => {
      if (!open) return
      setOpen(false)
      const payload = p as { handled?: boolean } | undefined
      if (payload) payload.handled = true
    }),
    // A tour or a scenario taking over the screen should not be read through
    // a modal sitting on top of it.
    bus.on('tour:start', () => setOpen(false)),
  )

  /* Nothing in here is live, so the frame tick has no work to do. */
  function update(_dt: number): void {
    void _dt
  }

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    setOpen(false)
    root.replaceChildren()
    root.classList.remove('help-overlay')
    root.hidden = true
  }

  return { update, dispose }
}

/** Open or close the help overlay from anywhere that has the bus. */
export function toggleHelpOverlay(bus: Bus, next?: boolean): void {
  emitLoose(bus, 'ui:help', next === undefined ? {} : { open: next })
}
