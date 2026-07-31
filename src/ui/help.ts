import '../styles/hud.css'

import { BUILD_LABEL } from '../core/build'
import { DESTINATIONS } from '../core/destinations'
import { COLOR, onThemeMode } from '../core/theme'
import type { Bus, ColorKey } from '../core/types'
import { MODE_IDS } from './mode-exits'
import { NO_EA_CONTENT, TRADEMARK_NOTICE } from './legal'
import { el, icon } from './uikit'
import { emitLoose } from './hud'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — HELP OVERLAY
 *
 * One modal: the city control map, the colour legend, and short reading notes on
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

export interface KeyRow {
  id: string
  keys: string[]
  /** joiner shown between keys: ' ' for a sequence, 'or', '+' … */
  join?: string
  what: string
}

export const CAMERA_KEYS: KeyRow[] = [
  { id: 'pan', keys: ['LMB drag', 'MMB drag'], join: 'or', what: 'Pan — grab the ground and move it' },
  {
    id: 'orbit',
    keys: ['Shift+LMB drag', 'Ctrl/Cmd+LMB drag'],
    join: 'or',
    what: 'Orbit around the city',
  },
  {
    id: 'context-menu',
    keys: ['RMB', 'Touch long-press'],
    join: 'or',
    what: 'Open the context menu without moving the camera',
  },
  { id: 'wheel', keys: ['Wheel'], what: 'Zoom in orbit · change movement speed in fly mode' },
  { id: 'touch-pan', keys: ['1 finger'], what: 'Pan the map' },
  { id: 'touch-orbit', keys: ['2 fingers'], what: 'Pinch to zoom · twist to turn · drag up or down to tilt' },
  { id: 'touch-move', keys: ['Left thumb'], what: 'Walk — a small stick push walks; a full push runs' },
  { id: 'touch-look', keys: ['Right thumb'], what: 'Look — drag while the left thumb keeps moving' },
  { id: 'touch-vertical', keys: ['Jump', 'Crouch'], what: 'Jump / toggle crouch · while swimming, hold to rise / dive' },
  { id: 'click', keys: ['Click'], what: 'Select a building · in fly or walk mode, capture the mouse' },
  { id: 'move', keys: ['W', 'A', 'S', 'D'], what: 'Move in orbit, fly, or walk · arrow keys work too' },
  { id: 'rise', keys: ['Space'], what: 'Rise in fly mode · jump or swim upward in walk mode' },
  { id: 'operate', keys: ['E'], what: 'Rise in fly mode · operate a nearby lever, door, or console in walk mode' },
  { id: 'descend', keys: ['C', 'Q'], join: 'or', what: 'Descend in fly mode · C crouches or dives in walk mode' },
  { id: 'boost', keys: ['Shift'], what: 'Boost in orbit or fly mode · run in walk mode' },
  { id: 'precision', keys: ['Alt'], what: 'Precision — slow movement in orbit or fly mode' },
  { id: 'altitude', keys: ['PgUp', 'PgDn'], what: 'Change altitude in orbit or fly mode' },
  { id: 'pointer-lock-exit', keys: ['Esc'], what: 'Leave pointer lock' },
]

export const APP_KEYS: KeyRow[] = [
  { id: 'pause', keys: ['K', 'P'], join: 'or', what: 'Pause / resume the simulation' },
  { id: 'playback-rate', keys: [',', '.'], what: 'Slower / faster (0.1× – 5×)' },
  { id: 'tour', keys: ['T'], what: 'Guided tour' },
  { id: 'reset', keys: ['R'], what: 'Reset — restart with default settings' },
  { id: 'fly', keys: ['F'], what: 'Toggle fly / orbit camera · desktop; touch uses Walk mode' },
  { id: 'walk', keys: ['G'], what: 'Get down — walk the city on foot, 1.7 m tall' },
  { id: 'walk-button', keys: ['Walk button'], what: 'Touch equivalent of G; Exit walk returns to the map' },
  { id: 'home', keys: ['H'], what: 'Establishing shot of the whole city · View menu' },
  { id: 'default-home', keys: ['Home'], what: 'Default establishing shot' },
  { id: 'overview', keys: ['O'], what: 'Overview — straight down on the plate · View menu' },
  { id: 'trace', keys: ['Enter'], what: 'Open Run a Query' },
  { id: 'palette', keys: ['/', 'Ctrl/Cmd+K'], join: 'or', what: 'Command palette' },
  { id: 'help', keys: ['?'], what: 'This panel' },
  { id: 'labels', keys: ['L'], what: 'Toggle floating labels · View menu' },
  { id: 'theme', keys: ['N'], what: 'Daylight / night · theme control beside Sound' },
  { id: 'sound', keys: ['M'], what: 'Sound on / off — audio starts off and remembers your choice' },
  { id: 'escape', keys: ['Esc'], what: 'Close the topmost overlay' },
  { id: 'districts', keys: ['1', '…', '8'], what: 'Jump to a district · View menu on phones' },
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
    p: 'The lit grid in the centre is a representative sample of <code>shared_buffers</code> — one tile per sampled frame, blue when its 8 KiB page matches disk, red when it has been modified in memory and not yet written. The rotating hand is the clock sweep looking for a frame to reuse.',
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
    p: 'South of the city, two TCP connections carry WAL to two standby clusters. Each standby replays its own stream in order; when one cannot keep up, that gap is its replication lag.',
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
          el('dt', { data: { helpAction: r.id } }, keyChips(r)),
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
      data: { modeExit: MODE_IDS.help },
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
  const legalSection = el(
    'section',
    { class: 'help-legal', 'data-help-section': 'legal' },
    el('h3', { class: 'pg-eyebrow help-h', text: 'Independence & trademarks' }),
    el('p', { class: 'help-legal__notice', text: TRADEMARK_NOTICE }),
    el('p', { class: 'help-legal__content', text: NO_EA_CONTENT }),
  )
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
        '<strong>How much to trust this.</strong> PGSimCity is still 0.x: early and moving. It is a model, not an emulator: ' +
        'no PostgreSQL source code runs in the 3D city, and the numbers are scaled so a human can watch them. Three specialist review rounds ' +
        'with independent attempts to refute each finding, a separate geometry audit, and the deterministic test suite provide evidence, not a guarantee. ' +
        'Mistakes have been found and fixed throughout. ' +
        "Touch controls have been verified only in Chrome's mobile emulation. " +
        '<a href="https://github.com/NikolayS/PGSimCity#how-much-to-trust-this" target="_blank" rel="noopener">See exactly what was checked.</a>' +
        '<br><br>Found one? Corrections from people who know the engine are exactly what this needs — please ' +
        '<a href="https://github.com/NikolayS/PGSimCity/issues/new" target="_blank" rel="noopener">open an issue</a> or send a ' +
        '<a href="https://github.com/NikolayS/PGSimCity/pulls" target="_blank" rel="noopener">pull request</a>.',
    }),
    el('p', {
      class: 'help-disclaimer',
      html:
        '<strong>Analytics & privacy.</strong> PGSimCity uses Plausible to count aggregate visits, referring sites, ' +
        'bounce rate and visit duration, plus named interface actions and outbound clicks tagged with the panel that sent them. ' +
        'Its event payload contains no names, email addresses, free-form input, browser fingerprint or personal data supplied ' +
        'by the application. Plausible briefly derives a daily visitor count from request IP and user agent without storing ' +
        'either raw value or a persistent identifier. There are no analytics cookies, ad networks or session recordings. ' +
        'Blocking <code>plausible.io</code> disables measurement without breaking any part of the city.',
    }),
    legalSection,
    el('p', {
      class: 'build-marker help-build',
      text: `PGSimCity ${BUILD_LABEL}`,
      'aria-label': `PGSimCity build ${BUILD_LABEL}`,
    }),
  )

  const jumpButton = (
    label: string,
    target: 'controls' | 'legend' | 'reading' | 'legal',
    section: HTMLElement,
  ) =>
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
    jumpButton('Legal', 'legal', legalSection),
  )

  const dialog = el(
    'div',
    {
      class: 'help-dialog pg-panel',
      data: { analyticsPanel: 'help' },
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
        el('p', { class: 'pg-sub', text: 'The city controls, and what every colour in the city means' }),
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
      bus.emit('panel:open', { panel: 'help' })
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
      const req = p as { open?: boolean; section?: 'controls' | 'legend' | 'reading' | 'legal' } | undefined
      setOpen(req && typeof req.open === 'boolean' ? req.open : !open)
      if (req?.section) {
        const section = {
          controls: controlsSection,
          legend: legendHeading,
          reading: readingHeading,
          legal: legalSection,
        }[req.section]
        requestAnimationFrame(() => section.scrollIntoView({ block: 'start' }))
      }
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
