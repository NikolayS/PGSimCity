import '../styles/hud.css'

import { DESTINATIONS, destinationForDistrict } from '../core/destinations'
import { COLOR, cssColor, onThemeMode, themeMode, toggleThemeMode } from '../core/theme'
import { clamp, fmtBytes, fmtDuration, fmtNum } from '../core/util'
import type {
  Bus,
  CameraMode,
  QualityLevel,
  ScenarioChoiceId,
  SimApi,
  SimState,
  TraceStop,
} from '../core/types'
import { SCENARIOS } from '../sim/scenarios'
import { DISTRICT_BOUNDS } from '../world/layout'
import { MODE_IDS, modeTokens } from './mode-exits'
import { el, icon, setClass, setText, sparkline } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PGSimCity — THE HUD
 *
 * Four surfaces, one module, because they share one clock and one keyboard:
 *
 *   #hud-top      the instrument bar: identity + health, five vital signs with
 *                 sparklines, the checkpoint countdown, and the tool buttons.
 *   #hud-bottom   transport: play/pause, speed, reset, and the scenario rack.
 *   #toast-stack  transient messages emitted by the simulation.
 *   #compass      a 2D minimap of the districts with the camera's view cone.
 *
 * This module also owns the single global keydown handler for application keys.
 * Camera keys belong to the camera rig and are deliberately not bound here.
 *
 * Everything reads live state from ctx.sim.state each tick — nothing is cached
 * across frames — and every DOM write goes through setText/setClass so an
 * unchanged value costs nothing.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * Camera hook.
 *
 * The HUD has no reference to the camera. main.ts pushes the camera's ground
 * position and heading here once per frame; if a future UiContext grows a
 * getCamera() we prefer that instead (see `readCamera` below).
 * -------------------------------------------------------------------------*/

let camX = 0
let camZ = 0
let camYaw = 0

/** Called by main.ts every frame: world-space x/z and heading in radians. */
export function setCompassCamera(x: number, z: number, yaw: number): void {
  camX = x
  camZ = z
  camYaw = yaw
}

/* ---------------------------------------------------------------------------
 * Loose bus channels.
 *
 * BusEvents is frozen and has no entry for "open the command palette" or
 * "toggle labels", so those travel as extra string channels on the same bus
 * (the bus itself is an untyped string map at runtime). They are also mirrored
 * as window CustomEvents so a module that would rather listen to the DOM can.
 * -------------------------------------------------------------------------*/

interface LooseBus {
  emit(type: string, payload: unknown): void
  on(type: string, fn: (p: unknown) => void): () => void
}

export function emitLoose(bus: Bus, type: string, payload: unknown): void {
  ;(bus as unknown as LooseBus).emit(type, payload)
  window.dispatchEvent(new CustomEvent(`pgsimcity:${type.replace(/^ui:/, '')}`, { detail: payload }))
}

/* --------------------------------- config -------------------------------- */

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 3, 5]
const TRACE_RAIL: readonly TraceStop[] = [
  'connect',
  'parse_plan',
  'fetch',
  'work',
  'wal',
  'commit',
  'send',
  'done',
]

type VitalKey = 'tps' | 'hit' | 'wal' | 'dirty' | 'lag'

interface VitalDef {
  key: VitalKey
  label: string
  focus: string
  color: string
  hint: string
}

const VITALS: VitalDef[] = [
  {
    key: 'tps',
    label: 'TPS',
    focus: 'backend.row',
    color: cssColor('backend'),
    hint: 'Transactions committed per second. Falls below the offered rate when the server is saturated.',
  },
  {
    key: 'hit',
    label: 'Cache hit',
    focus: 'shared.buffers',
    color: cssColor('bufClean'),
    hint: 'Share of page requests served from shared_buffers. A well-tuned OLTP server sits above 99%; here the sequential-scan dial is what moves it, because a scan streams pages this pool cannot keep.',
  },
  {
    key: 'wal',
    label: 'WAL',
    focus: 'wal.vault',
    color: cssColor('wal'),
    hint: 'Write-ahead log bytes produced per second. Compare it against max_wal_size to predict the next checkpoint.',
  },
  {
    key: 'dirty',
    label: 'Dirty sample',
    focus: 'shared.buffers',
    color: cssColor('bufDirty'),
    hint: 'Sampled frames modified in memory and not yet written to disk. Somebody has to pay for these eventually.',
  },
  {
    key: 'lag',
    label: 'Repl lag',
    focus: 'replica.standby',
    color: cssColor('replication'),
    hint: 'The larger replay lag of standby_a and standby_b. Each node has its own received, flushed, and applied position.',
  },
]

interface MapDistrict {
  key: string
  label: string
  id: string
  color: number
}

function mapDistrict(key: Exclude<Parameters<typeof destinationForDistrict>[0], 'world'>, color: number): MapDistrict {
  const destination = destinationForDistrict(key)
  if (!destination) throw new Error(`missing destination for district ${key}`)
  return {
    key,
    label: destination.shortName.toUpperCase(),
    id: destination.id,
    color,
  }
}

/** Minimap footprints, painted back to front. */
const MAP_DISTRICTS: MapDistrict[] = [
  mapDistrict('storage', COLOR.storage),
  mapDistrict('planner', COLOR.postmaster),
  mapDistrict('clients', COLOR.client),
  mapDistrict('backends', COLOR.backend),
  mapDistrict('shmem', COLOR.shmem),
  mapDistrict('wal', COLOR.wal),
  mapDistrict('maintenance', COLOR.vacuum),
  mapDistrict('replication', COLOR.replication),
]

const QUALITY_LEVELS: QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']
const ROTATE_HINT_STORAGE_KEY = 'pgsimcity.rotate-hint.dismissed'

/* ------------------------------ tiny helpers ----------------------------- */

type Health = 'ok' | 'warn' | 'crit'
type State = '' | 'ok' | 'warn' | 'crit'

const SVG_NS = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

function rgba(hex: number, a: number): string {
  return `rgba(${(hex >> 16) & 255}, ${(hex >> 8) & 255}, ${hex & 255}, ${a})`
}

function fmtSpeed(v: number): string {
  return `${v < 1 ? String(Number(v.toFixed(2))) : v.toFixed(v % 1 === 0 ? 0 : 1)}×`
}

function fmtClock(sec: number): string {
  const whole = Math.floor(sec + 1e-6)
  const m = Math.floor(whole / 60)
  const s = whole % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function nearestSpeed(v: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < SPEEDS.length; i++) {
    const d = Math.abs(Math.log(SPEEDS[i]) - Math.log(Math.max(0.01, v)))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Is a modal (help, command palette…) in front of the city right now?
 *
 * `[aria-modal]` alone is not enough: the dialog element itself is never marked
 * hidden, only the overlay wrapping it, so visibility has to be resolved for
 * real. checkVisibility() does that in one call; the fallback walks up looking
 * for a [hidden] ancestor.
 */
function isVisible(node: HTMLElement): boolean {
  const check = (node as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility
  if (typeof check === 'function') return check.call(node)
  return !node.hidden && !node.closest('[hidden]')
}

function modalOpen(): boolean {
  const help = document.getElementById('help-overlay')
  if (help && !help.hidden) return true
  for (const n of Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]'))) {
    if (isVisible(n)) return true
  }
  return false
}

/** True when replication lag has been climbing over the last couple of seconds. */
function lagClimbing(lag: readonly number[]): boolean {
  const n = lag.length
  if (n < 10) return false
  return lag[n - 1] - lag[n - 9] > 0.4 && lag[n - 1] > 1
}

function worstStandby(s: SimState): SimState['replication']['standbys'][number] | undefined {
  const a = s.replication.standbys[0]
  const b = s.replication.standbys[1]
  if (!a.connected) return b.connected ? b : undefined
  if (!b.connected) return a
  return b.lagSec > a.lagSec ? b : a
}

function health(s: SimState): Health {
  if (s.disasterRecovery.archive.writesBlocked) return 'crit'
  const pgWalFill =
    s.disasterRecovery.archive.pgWalBytes
    / Math.max(1, s.disasterRecovery.archive.pgWalCapacityBytes)
  if (pgWalFill >= 0.95) return 'crit'
  if (s.checkpoint.phase !== 'idle' && s.checkpoint.reason === 'wal') return 'crit'
  if (s.locks.length >= 3) return 'crit'
  if (pgWalFill >= 0.8) return 'warn'
  if (s.stats.cacheHitPct < 50) return 'warn'
  const standby = worstStandby(s)
  if (standby && (standby.lagSec > 5 || lagClimbing(s.stats.history.lag))) return 'warn'
  if (s.buffers.sampleFrames > 0 && s.buffers.dirtyCount / s.buffers.sampleFrames > 0.7) return 'warn'
  return 'ok'
}

function healthReason(s: SimState, h: Health): string {
  if (s.disasterRecovery.archive.writesBlocked)
    return 'Primary WAL volume reached its scaled safety limit — writes are rejected'
  const pgWalFill =
    s.disasterRecovery.archive.pgWalBytes
    / Math.max(1, s.disasterRecovery.archive.pgWalCapacityBytes)
  if (pgWalFill >= 0.8)
    return `Primary pg_wal is ${(pgWalFill * 100).toFixed(0)}% of its scaled safety capacity`
  if (s.checkpoint.phase !== 'idle' && s.checkpoint.reason === 'wal')
    return 'Checkpoint triggered by WAL volume — max_wal_size is being outrun'
  if (s.locks.length >= 3) return `${s.locks.length} backends waiting on a heavyweight lock`
  if (s.stats.cacheHitPct < 50) return `Cache hit ratio ${s.stats.cacheHitPct.toFixed(1)}% — most reads are going to storage`
  const standby = worstStandby(s)
  if (standby && standby.lagSec > 5) return `${standby.applicationName} is ${standby.lagSec.toFixed(1)}s behind`
  if (standby && lagClimbing(s.stats.history.lag)) return 'Replication lag is climbing'
  if (h === 'warn') return 'Most sampled buffer frames are dirty'
  return 'Nothing dramatic is happening'
}

export function vitalValue(key: VitalKey, s: SimState): { text: string; state: State } {
  switch (key) {
    case 'tps': {
      const offered = Math.max(1, s.knobs.tps)
      const ratio = s.stats.tps / offered
      return { text: fmtNum(s.stats.tps), state: ratio < 0.4 ? 'crit' : ratio < 0.72 ? 'warn' : '' }
    }
    case 'hit': {
      // Banded against what THIS city can actually reach. Its workload runs
      // sequential scans over relations far larger than a 768-frame sample, so it
      // lives in the 60-90% range and only approaches 99% once the seq-scan
      // dial is turned down. Bands tuned to a real server's 99% would leave
      // this vital stuck on a warning for every visitor, which teaches nothing.
      const v = s.stats.cacheHitPct
      return { text: `${v.toFixed(1)}%`, state: v < 50 ? 'crit' : v < 70 ? 'warn' : v >= 90 ? 'ok' : '' }
    }
    case 'wal': {
      const bps = s.wal.bytesPerSec
      const fillSec = bps > 1 ? (s.knobs.maxWalSize * 1024 * 1024) / bps : Infinity
      // A rate carries its time component in the value, not only in the label.
      return { text: `${fmtBytes(bps)}/s`, state: fillSec < 12 ? 'crit' : fillSec < 40 ? 'warn' : '' }
    }
    case 'dirty': {
      const d = s.buffers.dirtyCount
      const r = s.buffers.sampleFrames > 0 ? d / s.buffers.sampleFrames : 0
      return { text: fmtNum(d), state: r > 0.75 ? 'crit' : r > 0.5 ? 'warn' : '' }
    }
    case 'lag': {
      const standby = worstStandby(s)
      if (!standby) return { text: '—', state: '' }
      const v = standby.lagSec
      return { text: `${v.toFixed(1)}s`, state: v > 20 ? 'crit' : v > 5 ? 'warn' : '' }
    }
  }
}

function vitalHistory(key: VitalKey, s: SimState): number[] {
  const h = s.stats.history
  const src = key === 'tps' ? h.tps : key === 'hit' ? h.hit : key === 'wal' ? h.wal : key === 'dirty' ? h.dirty : h.lag
  return src.length > 64 ? src.slice(-64) : src
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export function createHud(ctx: UiContext): UiModule {
  const bus = ctx.bus
  const looseBus = bus as unknown as LooseBus
  const sim = ctx.sim
  const cleanup: (() => void)[] = []

  const mount = (id: string): HTMLElement => document.getElementById(id) ?? el('div')
  const topEl = mount('hud-top')
  const bottomEl = mount('hud-bottom')
  const toastEl = mount('toast-stack')
  const compassEl = mount('compass')

  /* -------------------------------------------------------------------------
   * DEFENSIVE GUARD — re-entrant reset.
   *
   * sim.reset() ends by emitting 'sim:reset', and main.ts answers that event by
   * calling sim.reset() again: an unbounded loop that hangs the tab (verified).
   * Wrapping the shared SimApi makes a re-entrant reset a no-op, so the first
   * call always completes exactly once. Restored on dispose(); harmless once
   * the root cause in main.ts is fixed.
   * ---------------------------------------------------------------------- */
  const api = sim as SimApi
  const originalReset = api.reset
  let resetting = false
  api.reset = function guardedReset(this: SimApi): void {
    if (resetting) return
    resetting = true
    try {
      originalReset.call(this)
    } finally {
      resetting = false
    }
  }
  cleanup.push(() => {
    api.reset = originalReset
  })

  /* ------------------------------ live state ----------------------------- */

  let cameraMode: CameraMode = 'orbit'
  let cameraPreset: 'plan' | null = null
  let tourRunning = false
  let labelsOn = true
  let viewOpen = false

  /* =======================================================================
   * TOP BAR
   * =====================================================================*/

  const statusDot = el('span', { class: 'hud-status', 'aria-hidden': 'true' })
  const clockEl = el('span', { class: 'hud-clock', text: '0:00' })
  const brand = el(
    'div',
    { class: 'hud-brand', title: 'PGSimCity — a working model of the PostgreSQL engine' },
    statusDot,
    el('span', { class: 'hud-brand__mark' }, el('b', { text: 'PG' }), 'PGSimCity'.slice(2)),
    el('span', { class: 'hud-brand__rule' }),
    clockEl,
  )

  interface VitalUi {
    def: VitalDef
    root: HTMLButtonElement
    value: HTMLElement
    canvas: HTMLCanvasElement
    state: State
  }

  const vitals: VitalUi[] = VITALS.map((def) => {
    const value = el('div', { class: 'pg-metric__v hud-vital__v', text: '—' })
    const canvas = el('canvas', { class: 'pg-spark hud-vital__spark', width: 88, height: 24 })
    const root = el(
      'button',
      {
        class: 'hud-vital',
        // so the stylesheet can drop the least essential tiles on a phone
        'data-vital': def.key,
        type: 'button',
        title: `${def.hint}\nClick to fly to it.`,
        'aria-label': `${def.label} — show in the city`,
        on: { click: () => bus.emit('focus', { id: def.focus }) },
      },
      el('div', { class: 'pg-metric__k hud-vital__k', text: def.label }),
      value,
      canvas,
    )
    return { def, root, value, canvas, state: '' }
  })

  const vitalsRow = el('div', { class: 'hud-vitals' }, ...vitals.map((v) => v.root))

  /* --- checkpoint ring --- */

  const RING_R = 15
  const RING_C = 2 * Math.PI * RING_R
  const ringBar = svg('circle', {
    class: 'hud-ckpt__bar',
    cx: 18,
    cy: 18,
    r: RING_R,
    'stroke-dasharray': RING_C.toFixed(2),
    'stroke-dashoffset': RING_C.toFixed(2),
    transform: 'rotate(-90 18 18)',
  })
  const ringSvg = svg('svg', { viewBox: '0 0 36 36', width: 34, height: 34, 'aria-hidden': 'true' })
  ringSvg.append(svg('circle', { class: 'hud-ckpt__track', cx: 18, cy: 18, r: RING_R }), ringBar)
  const ringNum = el('span', { class: 'hud-ckpt__n', text: '0' })
  const ckptState = el('span', { class: 'hud-ckpt__state', text: 'idle' })
  const ckptBtn = el(
    'button',
    {
      class: 'hud-ckpt',
      type: 'button',
      title: 'Time until the next checkpoint, against checkpoint_timeout. Click to fly to the checkpointer.',
      'aria-label': 'Checkpoint countdown — show the checkpointer',
      on: { click: () => bus.emit('focus', { id: 'checkpointer' }) },
    },
    el('span', { class: 'hud-ckpt__ring' }, ringSvg, ringNum),
    el(
      'span',
      { class: 'hud-ckpt__meta' },
      el('span', { class: 'pg-eyebrow', text: 'Checkpoint' }),
      ckptState,
    ),
  )

  /* --- tool buttons --- */

  const toolBtn = (
    name: string,
    label: string,
    key: string,
    onClick: () => void,
  ): HTMLButtonElement =>
    el(
      'button',
      {
        class: 'pg-btn pg-btn--icon hud-tool',
        type: 'button',
        title: `${label}  (${key})`,
        'aria-label': label,
        on: { click: onClick },
      },
      icon(name, 15),
    )

  const tourBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-tour',
      type: 'button',
      title: 'Guided tour  (T)',
      'aria-label': 'Guided tour',
      on: { click: () => toggleTour('button') },
    },
    icon('tour', 15),
    el('span', { text: 'Tour' }),
  )
  const traceBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-trace-open',
      type: 'button',
      title: 'Trace one fixed query through PostgreSQL  (Enter)',
      'aria-label': 'Run a query',
      on: { click: () => bus.emit('trace:open', { source: 'button' }) },
    },
    el('span', { 'aria-hidden': 'true', text: '▷' }),
    el('span', { text: 'Run a query' }),
  )
  const paletteBtn = toolBtn('search', 'Command palette', '/', () => openPalette())
  const helpBtn = toolBtn('help', 'Keyboard & legend', '?', () => toggleHelp())
  const audioLabel = el('span', { class: 'hud-audio__label', text: 'Sound off' })
  const audioBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-audio',
      type: 'button',
      title: 'Turn sound on  (M)',
      'aria-label': 'Turn sound on',
      'aria-pressed': 'false',
      on: { click: () => toggleAudio() },
    },
    icon('sound', 15),
    audioLabel,
  )
  const themeIcon = el('span', { class: 'hud-theme__icon' })
  const themeLabel = el('span', { class: 'hud-theme__label', text: 'Night' })
  const themeBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-theme',
      type: 'button',
      on: { click: () => toggleTheme() },
    },
    themeIcon,
    themeLabel,
  )
  const sourceLink = el(
    'a',
    {
      class: 'pg-btn hud-tool hud-source',
      href: 'https://github.com/NikolayS/PGSimCity',
      target: '_blank',
      rel: 'noopener',
      title: 'PGSimCity source code on GitHub',
      'aria-label': 'Source on GitHub',
    },
    'Source',
  )
  const legalBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-legal',
      type: 'button',
      title: 'Electronic Arts trademark and independence notice',
      'aria-label': 'Legal notice',
      on: { click: () => emitLoose(bus, 'ui:help', { open: true, section: 'legal' }) },
    },
    'Legal',
  )
  const viewLabel = el('span', { text: 'View' })
  const viewBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-view-toggle',
      type: 'button',
      data: { modeExit: modeTokens(MODE_IDS.fly, MODE_IDS.plan) },
      title: 'View, display, and destinations',
      'aria-label': 'Open view and destination controls',
      'aria-expanded': 'false',
      'aria-controls': 'hud-view-panel',
      on: {
        click: () => {
          if (cameraMode === 'fly') {
            bus.emit('camera:mode', { mode: 'orbit' })
            return
          }
          if (cameraPreset === 'plan') {
            bus.emit('focus', { id: 'world.ground' })
            return
          }
          setViewOpen(!viewOpen)
        },
      },
    },
    icon('eye', 15),
    viewLabel,
  )
  const walkLabel = el('span', { class: 'hud-walk__label', text: 'Walk' })
  const walkBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-walk',
      type: 'button',
      data: { modeExit: modeTokens(MODE_IDS.walk, MODE_IDS.swim) },
      title: 'Walk the city  (G)',
      'aria-label': 'Walk the city',
      'aria-pressed': 'false',
      on: {
        click: () => bus.emit('camera:mode', { mode: cameraMode === 'walk' ? 'orbit' : 'walk' }),
      },
    },
    icon('walk', 15),
    walkLabel,
  )

  /* ---- ENTRY POINT: the Diagnose console (observability/) -----------------
   * The only edit this feature makes outside observability/** and
   * src/observability/**. A plain link, deliberately: the console is a separate
   * page with its own simulation, so there is nothing to wire up here. */
  const diagnoseLink = el(
    'a',
    {
      class: 'pg-btn pg-btn--icon hud-tool',
      href: 'observability/',
      title: 'Diagnose — start from a symptom, end at the pg_stat_* column that proves it',
      'aria-label': 'Diagnose',
    },
    icon('diagnose', 15),
  )

  const fpsEl = el('span', { class: 'hud-perf__fps', text: '—' })
  const partEl = el('span', { class: 'hud-perf__p', text: '0 particles' })
  const qualitySel = el('select', {
    class: 'pg-select hud-perf__sel',
    title: 'Rendering quality — lower it if the frame rate suffers',
    'aria-label': 'Rendering quality',
    on: {
      change: (e: Event) => {
        const level = (e.target as HTMLSelectElement).value as QualityLevel
        bus.emit('quality', { level })
      },
    },
  })
  for (const lv of QUALITY_LEVELS) qualitySel.append(el('option', { value: lv, text: lv.toUpperCase() }))
  qualitySel.value = ctx.getQuality().level

  const perf = el(
    'div',
    { class: 'hud-perf' },
    el('div', { class: 'hud-perf__nums' }, fpsEl, partEl),
    qualitySel,
  )

  /* The tools travel. On a desktop they belong beside the checkpoint ring in
     the instrument bar; on a phone there is no room for both, and the split
     that survives is instruments on top, controls at the bottom — so this whole
     cluster moves into the transport dock and comes back on rotation. */
  const toolCluster = el(
    'div',
    { class: 'hud-tools', data: { analyticsPanel: 'hud' } },
    audioBtn,
    themeBtn,
    sourceLink,
    topEl.children[0],
    legalBtn,
    viewBtn,
    tourBtn,
    traceBtn,
    diagnoseLink,
    walkBtn,
    paletteBtn,
    helpBtn,
    perf,
  )

  const rightCluster = el('div', { class: 'hud-right' }, ckptBtn, el('span', { class: 'hud-sep' }), toolCluster)

  const topBar = el('div', { class: 'pg-panel hud-bar' }, brand, vitalsRow, rightCluster)
  topEl.append(topBar)

  const STACKED_TOP_MIN_WIDTH = 701
  const STACKED_TOP_MAX_WIDTH = 1440

  function applyTopLayout(): void {
    const width = window.innerWidth
    setClass(
      topBar,
      'is-stacked',
      width >= STACKED_TOP_MIN_WIDTH && width <= STACKED_TOP_MAX_WIDTH,
    )
  }

  window.addEventListener('resize', applyTopLayout)
  cleanup.push(() => window.removeEventListener('resize', applyTopLayout))
  applyTopLayout()

  /* The phone hides the minimap, so camera presets, labels, and all eight
     district jumps need a compact touch surface of their own. It is also useful
     on desktop: a shortcut is a convenience, never the only entrance. */
  const labelsViewLabel = el('span', { text: 'Labels on' })
  const labelsViewBtn = el(
    'button',
    {
      class: 'pg-btn hud-view__action',
      type: 'button',
      data: { viewAction: 'labels' },
      'aria-pressed': 'true',
      title: 'Show or hide floating labels  (L)',
      on: { click: () => toggleLabels() },
    },
    icon('layers', 15),
    labelsViewLabel,
  )
  const homeViewBtn = el(
    'button',
    {
      class: 'pg-btn hud-view__action',
      type: 'button',
      data: { viewAction: 'home', modeExit: MODE_IDS.plan },
      title: 'Establishing shot  (H)',
      on: {
        click: () => {
          bus.emit('focus', { id: 'world.ground' })
          setViewOpen(false)
        },
      },
    },
    icon('home', 15),
    el('span', { text: 'Home' }),
  )
  const overviewViewBtn = el(
    'button',
    {
      class: 'pg-btn hud-view__action',
      type: 'button',
      data: { viewAction: 'overview' },
      title: 'Straight-down overview  (O)',
      on: {
        click: () => {
          emitLoose(bus, 'ui:camera-preset', { preset: 'plan' })
          setViewOpen(false)
        },
      },
    },
    icon('eye', 15),
    el('span', { text: 'Overview' }),
  )
  const flyViewBtn = el(
    'button',
    {
      class: 'pg-btn hud-view__action hud-view__desktop-only',
      type: 'button',
      data: { viewAction: 'fly' },
      title: 'Toggle fly / orbit camera  (F)',
      on: {
        click: () => {
          bus.emit('camera:mode', { mode: cameraMode === 'fly' ? 'orbit' : 'fly' })
          setViewOpen(false)
        },
      },
    },
    icon('camera', 15),
    el('span', { text: 'Fly' }),
  )
  const districtViewButtons = DESTINATIONS.map((destination, index) =>
    el(
      'button',
      {
        class: 'pg-btn hud-view__district',
        type: 'button',
        data: { viewDistrict: destination.id },
        title: `${destination.name}  (${index + 1})`,
        on: {
          click: () => {
            bus.emit('focus', { id: destination.id })
            setViewOpen(false)
          },
        },
      },
      el('span', { class: 'hud-view__key', text: String(index + 1) }),
      el('span', { text: destination.name }),
    ),
  )
  const closeViewBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon hud-view__close',
      type: 'button',
      title: 'Close view controls',
      'aria-label': 'Close view controls',
      on: { click: () => setViewOpen(false) },
    },
    icon('close', 14),
  )
  const viewPanel = el(
    'section',
    {
      class: 'pg-panel hud-view-panel interactive',
      id: 'hud-view-panel',
      role: 'dialog',
      'aria-labelledby': 'hud-view-title',
      hidden: true,
    },
    el(
      'div',
      { class: 'hud-view__head' },
      el('span', { class: 'pg-eyebrow', id: 'hud-view-title', text: 'View & destinations' }),
      closeViewBtn,
    ),
    el('div', { class: 'hud-view__actions' }, labelsViewBtn, homeViewBtn, overviewViewBtn, flyViewBtn),
    el(
      'div',
      { class: 'hud-view__district-head' },
      el('span', { class: 'pg-eyebrow', text: 'Fly to a district' }),
      el('span', { class: 'hud-view__swipe', text: 'Swipe →' }),
    ),
    el('div', { class: 'hud-view__districts' }, ...districtViewButtons),
  )
  topEl.append(viewPanel)
  cleanup.push(onThemeMode((mode) => paintTheme(mode)))

  /* =======================================================================
   * TRANSPORT BAR
   * =====================================================================*/

  const playIcon = el('span', { class: 'hud-play__icon' }, icon('pause', 14))
  const playBtn = el(
    'button',
    {
      class: 'pg-btn hud-play',
      type: 'button',
      title: 'Pause / resume  (K)',
      'aria-label': 'Pause or resume the simulation',
      on: { click: () => togglePause() },
    },
    playIcon,
  )

  const speedEl = el('span', { class: 'hud-speed__v', text: '1×' })
  const slowerBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon',
      type: 'button',
      title: 'Slower  (,)',
      'aria-label': 'Slower',
      on: { click: () => nudgeSpeed(-1) },
    },
    icon('prev', 13),
  )
  const fasterBtn = el(
    'button',
    {
      class: 'pg-btn pg-btn--icon',
      type: 'button',
      title: 'Faster  (.)',
      'aria-label': 'Faster',
      on: { click: () => nudgeSpeed(1) },
    },
    icon('next', 13),
  )
  const speedGroup = el('div', { class: 'hud-speed' }, slowerBtn, speedEl, fasterBtn)

  const resetBtn = el(
    'button',
    {
      class: 'pg-btn hud-reset',
      type: 'button',
      title: 'Restart the cluster with default settings  (R)',
      on: { click: () => resetSim() },
    },
    icon('reset', 13),
    el('span', { class: 'hud-reset__t', text: 'Reset' }),
  )

  interface ChipUi {
    id: string
    root: HTMLButtonElement
  }

  const chips: ChipUi[] = SCENARIOS.map((s) => {
    const root = el(
      'button',
      {
        class: 'pg-chip hud-chip',
        type: 'button',
        title: s.blurb,
        'aria-pressed': 'false',
        on: { click: () => toggleScenario(s.id) },
      },
      el('span', { class: 'hud-chip__icon', text: s.icon }),
      el('span', { class: 'hud-chip__name', text: s.name }),
    )
    return { id: s.id, root }
  })

  const chipRow = el('div', { class: 'hud-chips pg-scroll' }, ...chips.map((c) => c.root))
  const scenarioCue = el('span', {
    class: 'hud-scn__cue',
    text: `${SCENARIOS.length} · scroll →`,
    'aria-hidden': 'true',
  })

  const nowName = el('span', { class: 'hud-now__name', text: 'No scenario' })
  const nowTime = el('span', { class: 'hud-now__time', text: 'free running' })
  const nowFill = el('i', { class: 'hud-now__fill' })
  const nowStop = el('span', { class: 'hud-now__stop', text: '' })
  const nowBox = el(
    'button',
    {
      class: 'hud-now',
      type: 'button',
      disabled: true,
      data: { modeExit: MODE_IDS.scenario },
      on: { click: () => stopScenario() },
    },
    el('div', { class: 'hud-now__row' }, nowName, nowTime),
    el('div', { class: 'hud-now__bar' }, nowFill),
    nowStop,
  )

  /* Phone only: the scenario rail is intentionally longer than the viewport
     for it under the transport, so it collapses behind one labelled control and
     the city keeps the pixels. Hidden on a desktop, where the rail always
     shows. */
  const scnBtn = el(
    'button',
    {
      class: 'pg-btn hud-scn__toggle',
      type: 'button',
      data: { modeExit: MODE_IDS.scenario },
      'aria-expanded': 'false',
      'aria-controls': 'hud-scenarios',
      title: 'Show or hide the scenario list',
      on: {
        click: () => {
          if (sim.state.scenario) stopScenario()
          else setScenariosOpen(!scenariosOpen)
        },
      },
    },
    el('span', { class: 'hud-scn__toggle-icon', text: '◈' }),
    el('span', { class: 'hud-scn__toggle-label', text: 'Scenarios' }),
  )

  const scnWrap = el(
    'div',
    { class: 'hud-transport__scn', id: 'hud-scenarios' },
    el('span', { class: 'pg-eyebrow hud-scn__label', text: 'Scenarios' }),
    nowBox,
    scenarioCue,
    chipRow,
  )

  const traceChips = TRACE_RAIL.map((stop) =>
    el('span', {
      class: 'hud-trace__stop',
      text: stop === 'parse_plan' ? 'parse + plan' : stop,
      data: { traceStop: stop },
    }),
  )
  const traceRail = el(
    'div',
    { class: 'hud-trace', role: 'list', 'aria-label': 'Query trace stops' },
    ...traceChips,
  )

  /* Where the trace rail lives, and where the tool cluster joins it on a phone. */
  const dockSlot = el('div', { class: 'hud-transport__dock' }, traceRail)

  const transport = el(
    'div',
    { class: 'pg-panel hud-transport' },
    el('div', { class: 'hud-transport__deck' }, playBtn, speedGroup, resetBtn, scnBtn),
    el('span', { class: 'hud-sep' }),
    scnWrap,
    dockSlot,
  )

  const decisionTitle = el('strong', { class: 'hud-decision__title' })
  const decisionState = el('span', { class: 'hud-decision__state' })
  const decisionFacts = [0, 1, 2].map(() => {
    const label = el('span', { class: 'hud-decision__fact-label' })
    const value = el('strong', { class: 'hud-decision__fact-value' })
    return { root: el('span', { class: 'hud-decision__fact' }, label, value), label, value }
  })
  const decisionChoiceUi = [0, 1].map(() => {
    const label = el('strong', { class: 'hud-decision__choice-label' })
    const hint = el('span', { class: 'hud-decision__choice-hint' })
    const root = el(
      'button',
      {
        class: 'pg-btn hud-decision__choice',
        type: 'button',
        on: {
          click: (event) => {
            const target = event.currentTarget as HTMLButtonElement
            const choice = target.dataset.scenarioChoice as ScenarioChoiceId | undefined
            if (choice) sim.chooseScenario(choice)
            paintScenario()
          },
        },
      },
      label,
      hint,
    )
    return { root, label, hint }
  })
  const decisionChoices = el(
    'div',
    { class: 'hud-decision__choices' },
    ...decisionChoiceUi.map((choice) => choice.root),
  )
  const decisionResult = el('p', {
    class: 'hud-decision__result',
    'aria-live': 'polite',
  })
  const decisionRecover = el('button', {
    class: 'pg-btn hud-decision__recover',
    type: 'button',
    text: 'Recover',
    on: {
      click: () => {
        sim.recoverScenario()
        paintScenario()
      },
    },
  })
  const decisionRetry = el('button', {
    class: 'pg-btn hud-decision__retry',
    type: 'button',
    text: 'Run this situation again',
    on: {
      click: () => {
        const id = sim.state.scenario
        if (!id) return
        sim.reset()
        sim.runScenario(id)
        paintScenario()
      },
    },
  })
  const decisionActions = el(
    'div',
    { class: 'hud-decision__actions' },
    decisionRecover,
    decisionRetry,
  )
  const decisionRoot = el(
    'section',
    {
      class: 'pg-panel hud-decision',
      hidden: true,
      'aria-label': 'Operator decision',
    },
    el(
      'div',
      { class: 'hud-decision__head' },
      el('span', { class: 'pg-eyebrow', text: 'Operator instruments' }),
      decisionTitle,
      decisionState,
    ),
    el('div', { class: 'hud-decision__facts' }, ...decisionFacts.map((fact) => fact.root)),
    decisionChoices,
    decisionResult,
    decisionActions,
  )
  bottomEl.append(decisionRoot, transport)

  let scenariosOpen = false

  function setScenariosOpen(next: boolean): void {
    scenariosOpen = next
    setClass(transport, 'is-scn-open', next)
    setClass(scnBtn, 'is-active', next)
    scnBtn.setAttribute('aria-expanded', String(next))
  }

  function setViewOpen(next: boolean): void {
    viewOpen = next
    viewPanel.hidden = !next
    setClass(transport, 'is-view-open', next)
    viewBtn.setAttribute('aria-expanded', String(next))
    if (next && scenariosOpen) setScenariosOpen(false)
    paintViewButton()
  }

  /* ---- phone layout: instruments on top, every control in the dock -------- */

  const phone = window.matchMedia('(max-width: 700px)')

  function applyPhoneLayout(): void {
    const target = phone.matches ? dockSlot : rightCluster
    if (toolCluster.parentElement !== target) target.append(toolCluster)
    // Leaving the rail expanded across a rotation would re-cover the city.
    if (!phone.matches && scenariosOpen) setScenariosOpen(false)
  }

  const onPhoneChange = (): void => applyPhoneLayout()
  phone.addEventListener('change', onPhoneChange)
  cleanup.push(() => phone.removeEventListener('change', onPhoneChange))
  applyPhoneLayout()

  /* =======================================================================
   * TOASTS
   * =====================================================================*/

  toastEl.setAttribute('aria-live', 'polite')
  toastEl.classList.add('hud-toasts')

  interface Toast {
    node: HTMLElement
    timer: number
    onDrop?: () => void
  }
  const toasts: Toast[] = []

  function dropToast(t: Toast): void {
    const i = toasts.indexOf(t)
    if (i < 0) return
    toasts.splice(i, 1)
    window.clearTimeout(t.timer)
    t.onDrop?.()
    t.node.classList.add('is-out')
    window.setTimeout(() => t.node.remove(), 240)
  }

  function pushToast(
    text: string,
    kind: 'info' | 'warn' | 'good' = 'info',
    ms = 3600,
    action?: { label: string; quality: QualityLevel },
    opts?: { className?: string; onDrop?: () => void },
  ): Toast {
    const node = el(
      'button',
      {
        class: `hud-toast hud-toast--${kind} pg-enter${opts?.className ? ` ${opts.className}` : ''}`,
        type: 'button',
        'aria-label': action ? `${text} ${action.label}` : 'Dismiss',
      },
      el('span', { class: 'hud-toast__dot pg-dot' }),
      el('span', { class: 'hud-toast__txt', text }),
      ...(action ? [el('span', { class: 'hud-toast__action', text: action.label })] : []),
    )
    const t: Toast = {
      node,
      timer: window.setTimeout(() => dropToast(t), Math.max(600, ms)),
      onDrop: opts?.onDrop,
    }
    node.addEventListener('click', () => {
      if (action) bus.emit('quality', { level: action.quality })
      dropToast(t)
    })
    toasts.push(t)
    toastEl.prepend(node)
    while (toasts.length > 4) dropToast(toasts[0])
    return t
  }

  cleanup.push(
    bus.on('toast', (p) => pushToast(p.text, p.kind ?? 'info', p.ms ?? 3600, p.action)),
  )

  function rotateHintDismissed(): boolean {
    try {
      return window.localStorage.getItem(ROTATE_HINT_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  }

  function rememberRotateHint(): void {
    try {
      window.localStorage.setItem(ROTATE_HINT_STORAGE_KEY, '1')
    } catch {
      /* Storage can be unavailable; the in-page guard still prevents repetition. */
    }
  }

  let rotateHint: Toast | null = null
  let rotateHintHandled = rotateHintDismissed()
  cleanup.push(
    bus.on('camera:gesture', ({ kind, pointer }) => {
      if (kind === 'rotate') {
        rotateHintHandled = true
        rememberRotateHint()
        if (rotateHint) dropToast(rotateHint)
        return
      }
      if (rotateHintHandled || rotateHint) return
      const text =
        pointer === 'touch'
          ? 'Use two fingers: twist to rotate, drag together to tilt'
          : 'Hold Shift and drag to rotate or tilt'
      rotateHint = pushToast(text, 'info', 6500, undefined, {
        className: 'hud-rotate-hint',
        onDrop: () => {
          rotateHint = null
          rotateHintHandled = true
          rememberRotateHint()
        },
      })
    }),
  )

  /* =======================================================================
   * COMPASS
   * =====================================================================*/

  const compassCanvas = el('canvas', {
    class: 'hud-compass__canvas interactive',
    title: 'City map — click a district to fly there',
    'aria-label': 'City minimap',
  })
  const compassRoot = el('div', { class: 'pg-panel hud-compass' }, compassCanvas)
  compassEl.append(compassRoot)

  const MAP_PAD = 30
  const box = (() => {
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const d of MAP_DISTRICTS) {
      const b = DISTRICT_BOUNDS[d.key]
      if (!b) continue
      minX = Math.min(minX, b.x[0])
      maxX = Math.max(maxX, b.x[1])
      minZ = Math.min(minZ, b.z[0])
      maxZ = Math.max(maxZ, b.z[1])
    }
    if (!isFinite(minX)) {
      minX = -300
      maxX = 300
      minZ = -300
      maxZ = 300
    }
    return { minX: minX - MAP_PAD, maxX: maxX + MAP_PAD, minZ: minZ - MAP_PAD, maxZ: maxZ + MAP_PAD }
  })()

  /** Cached screen-space rects, rebuilt on every paint, used for hit-testing. */
  const hitRects: { d: MapDistrict; x: number; y: number; w: number; h: number }[] = []

  function readCamera(): { x: number; z: number; yaw: number } {
    const hook = (ctx as UiContext & { getCamera?: () => { x: number; z: number; yaw: number } }).getCamera
    if (typeof hook === 'function') {
      const c = hook()
      if (c) return c
    }
    return { x: camX, z: camZ, yaw: camYaw }
  }

  function paintCompass(): void {
    const cv = compassCanvas
    const w = cv.clientWidth || 196
    const h = cv.clientHeight || 168
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
    }
    const g = cv.getContext('2d')
    if (!g) return
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)

    const worldW = box.maxX - box.minX
    const worldH = box.maxZ - box.minZ
    const inset = 10
    const scale = Math.min((w - inset * 2) / worldW, (h - inset * 2) / worldH)
    const ox = (w - worldW * scale) / 2
    const oy = (h - worldH * scale) / 2
    const sx = (x: number) => ox + (x - box.minX) * scale
    const sy = (z: number) => oy + (z - box.minZ) * scale

    // faint city frame
    g.strokeStyle = rgba(COLOR.grid, 0.55)
    g.lineWidth = 1
    g.strokeRect(ox + 0.5, oy + 0.5, worldW * scale - 1, worldH * scale - 1)

    hitRects.length = 0
    g.font = '600 7px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (const d of MAP_DISTRICTS) {
      const b = DISTRICT_BOUNDS[d.key]
      if (!b) continue
      const x = sx(b.x[0])
      const y = sy(b.z[0])
      const rw = (b.x[1] - b.x[0]) * scale
      const rh = (b.z[1] - b.z[0]) * scale
      hitRects.push({ d, x, y, w: rw, h: rh })
      g.fillStyle = rgba(d.color, 0.13)
      g.fillRect(x, y, rw, rh)
      g.strokeStyle = rgba(d.color, 0.55)
      g.lineWidth = 1
      g.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1)
      if (rw > 34 && rh > 11) {
        g.fillStyle = rgba(d.color, 0.92)
        g.fillText(d.label, x + rw / 2, y + rh / 2)
      }
    }

    // camera marker + view cone
    const cam = readCamera()
    const cx = clamp(sx(cam.x), 2, w - 2)
    const cy = clamp(sy(cam.z), 2, h - 2)
    const fwdX = Math.sin(cam.yaw)
    const fwdY = Math.cos(cam.yaw)
    const half = 0.42
    const len = 30
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(
      cx + Math.sin(cam.yaw - half) * len,
      cy + Math.cos(cam.yaw - half) * len,
    )
    g.lineTo(
      cx + Math.sin(cam.yaw + half) * len,
      cy + Math.cos(cam.yaw + half) * len,
    )
    g.closePath()
    g.fillStyle = rgba(COLOR.ink, 0.16)
    g.fill()
    g.strokeStyle = rgba(COLOR.ink, 0.42)
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(cx, cy)
    g.lineTo(cx + fwdX * len, cy + fwdY * len)
    g.stroke()
    g.fillStyle = cssColor('ink')
    g.beginPath()
    g.arc(cx, cy, 2.6, 0, Math.PI * 2)
    g.fill()

    // chrome: north marker + camera mode
    g.font = '600 8px ui-monospace, SFMono-Regular, Menlo, monospace'
    g.textAlign = 'left'
    g.fillStyle = rgba(COLOR.inkDim, 0.75)
    g.fillText('N ▲', 6, 9)
    g.textAlign = 'right'
    g.fillStyle = rgba(cameraMode === 'fly' ? COLOR.backend : COLOR.inkDim, 0.85)
    g.fillText(cameraMode.toUpperCase(), w - 6, h - 7)
  }

  compassCanvas.addEventListener('click', (e) => {
    const r = compassCanvas.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    for (let i = hitRects.length - 1; i >= 0; i--) {
      const h = hitRects[i]
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
        bus.emit('focus', { id: h.d.id })
        return
      }
    }
    bus.emit('focus', { id: 'world.ground' })
  })

  /* =======================================================================
   * ACTIONS
   * =====================================================================*/

  function togglePause(): void {
    sim.setKnob('paused', !sim.state.knobs.paused, 'user')
  }

  function nudgeSpeed(dir: -1 | 1): void {
    const i = clamp(nearestSpeed(sim.state.knobs.timeScale) + dir, 0, SPEEDS.length - 1)
    sim.setKnob('timeScale', SPEEDS[i], 'user')
  }

  function resetSim(): void {
    sim.reset()
    bus.emit('toast', { text: 'Cluster restarted — knobs back to defaults', kind: 'info', ms: 2600 })
  }

  function toggleScenario(id: string): void {
    sim.runScenario(sim.state.scenario === id ? null : id)
    setScenariosOpen(false)
  }

  function stopScenario(): void {
    if (!sim.state.scenario) return
    sim.runScenario(null)
    setScenariosOpen(false)
  }

  function toggleTour(source: 'button' | 'keyboard'): void {
    if (tourRunning) bus.emit('tour:stop', {})
    else bus.emit('tour:start', { source })
  }

  function toggleHelp(): void {
    emitLoose(bus, 'ui:help', {})
  }

  function openPalette(): void {
    emitLoose(bus, 'ui:palette', { open: true })
  }

  /**
   * N — daylight or night, for the whole city and the whole console at once.
   *
   * core/theme.ts does the work (palette, every cached material, the toon ramp)
   * and remembers the choice; the renderer answers the same notification with
   * the light rig and the tone mapping curve. The loose 'theme:mode' channel is
   * here so any module that needs to re-derive something can listen without
   * BusEvents having to grow an entry.
   */
  function toggleTheme(): void {
    const next = toggleThemeMode()
    emitLoose(bus, 'theme:mode', { mode: next })
    bus.emit('toast', {
      text: next === 'day' ? 'Daylight — golden hour' : 'Night — the city lit by its own data',
      kind: 'info',
      ms: 1800,
    })
  }

  function toggleLabels(): void {
    labelsOn = !labelsOn
    document.body.classList.toggle('pg-labels-off', !labelsOn)
    setText(labelsViewLabel, labelsOn ? 'Labels on' : 'Labels off')
    labelsViewBtn.setAttribute('aria-pressed', String(labelsOn))
    setClass(labelsViewBtn, 'is-active', labelsOn)
    emitLoose(bus, 'ui:labels', { on: labelsOn })
    bus.emit('toast', { text: labelsOn ? 'Labels on' : 'Labels hidden', kind: 'info', ms: 1400 })
  }

  function toggleAudio(): void {
    emitLoose(bus, 'audio:toggle', {})
  }

  function escape(): void {
    if (viewOpen) {
      setViewOpen(false)
      return
    }
    const payload = { handled: false }
    emitLoose(bus, 'ui:escape', payload)
    if (payload.handled) return
    if (tourRunning) {
      bus.emit('tour:stop', {})
      return
    }
    bus.emit('select', { id: null })
  }

  /* =======================================================================
   * KEYBOARD — the single global handler for application keys
   * =====================================================================*/

  function onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null
    if (t) {
      const tag = t.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable) return
    }
    if (e.altKey) return

    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openPalette()
      }
      return
    }

    // While a modal owns the screen, only Escape gets through.
    if (modalOpen() && e.key !== 'Escape') return

    const k = e.key
    switch (k) {
      case 'k':
      case 'K':
      case 'p':
      case 'P':
        if (e.repeat) return
        e.preventDefault()
        togglePause()
        return
      case ',':
      case '<':
        e.preventDefault()
        nudgeSpeed(-1)
        return
      case '.':
      case '>':
        e.preventDefault()
        nudgeSpeed(1)
        return
      case 't':
      case 'T':
        if (e.repeat) return
        e.preventDefault()
        toggleTour('keyboard')
        return
      case 'r':
      case 'R':
        if (e.repeat) return
        e.preventDefault()
        resetSim()
        return
      case 'f':
      case 'F':
        if (e.repeat) return
        e.preventDefault()
        bus.emit('camera:mode', { mode: cameraMode === 'fly' ? 'orbit' : 'fly' })
        return
      case 'g':
      case 'G':
        if (e.repeat) return
        e.preventDefault()
        bus.emit('camera:mode', { mode: cameraMode === 'walk' ? 'orbit' : 'walk' })
        return
      case 'h':
      case 'H':
        if (e.repeat) return
        e.preventDefault()
        bus.emit('focus', { id: 'world.ground' })
        return
      case 'l':
      case 'L':
        if (e.repeat) return
        e.preventDefault()
        toggleLabels()
        return
      case 'n':
      case 'N':
        if (e.repeat) return
        e.preventDefault()
        toggleTheme()
        return
      case 'm':
      case 'M':
        if (e.repeat) return
        e.preventDefault()
        toggleAudio()
        return
      case '/':
        e.preventDefault()
        openPalette()
        return
      case '?':
        e.preventDefault()
        toggleHelp()
        return
      case 'Escape':
        escape()
        return
      case 'Enter':
        if (e.repeat) return
        e.preventDefault()
        bus.emit('trace:open', { source: 'keyboard' })
        return
      default:
        break
    }

    if (k >= '1' && k <= '8') {
      e.preventDefault()
      bus.emit('focus', { id: DESTINATIONS[Number(k) - 1].id })
    }
  }

  window.addEventListener('keydown', onKeyDown)
  cleanup.push(() => window.removeEventListener('keydown', onKeyDown))

  /* =======================================================================
   * BUS SUBSCRIPTIONS
   * =====================================================================*/

  cleanup.push(
    bus.on('camera:mode', ({ mode }) => {
      cameraMode = mode
      const walking = mode === 'walk'
      document.body.classList.toggle('pg-walk', walking)
      setClass(walkBtn, 'is-active', walking)
      walkBtn.setAttribute('aria-pressed', String(walking))
      walkBtn.setAttribute('aria-label', walking ? 'Exit walk mode' : 'Walk the city')
      walkBtn.title = walking ? 'Exit walk mode  (G)' : 'Walk the city  (G)'
      setText(walkLabel, walking ? 'Exit' : 'Walk')
      paintViewButton()
    }),
    bus.on('camera:preset', ({ preset }) => {
      cameraPreset = preset
      paintViewButton()
    }),
    bus.on('tour:start', () => {
      tourRunning = true
      setClass(tourBtn, 'is-active', true)
    }),
    bus.on('tour:stop', () => {
      tourRunning = false
      setClass(tourBtn, 'is-active', false)
    }),
    bus.on('quality', ({ level }) => {
      if (qualitySel.value !== level) qualitySel.value = level
    }),
    bus.on('scenario', () => paintScenario()),
    // The ring goes pink the instant a checkpoint starts — the simulation
    // already toasts the "triggered by max_wal_size" case, so we stay quiet.
    bus.on('checkpoint:start', () => paintCheckpoint(sim.state)),
    bus.on('checkpoint:end', () => paintCheckpoint(sim.state)),
    looseBus.on('ui:theme-toggle', () => toggleTheme()),
    looseBus.on('ui:labels-toggle', () => toggleLabels()),
  )

  /* =======================================================================
   * PAINT
   * =====================================================================*/

  let lastHealth: Health | null = null

  function paintTop(s: SimState): void {
    const h = health(s)
    if (h !== lastHealth) {
      lastHealth = h
      statusDot.className = `hud-status is-${h}`
    }
    const reason = healthReason(s, h)
    if (statusDot.title !== reason) statusDot.title = reason
    setText(clockEl, fmtDuration(s.t))

    for (const v of vitals) {
      const { text, state } = vitalValue(v.def.key, s)
      setText(v.value, text)
      if (state !== v.state) {
        v.state = state
        v.value.className = 'pg-metric__v hud-vital__v' + (state ? ` is-${state}` : '')
      }
    }
  }

  function paintSparks(s: SimState): void {
    for (const v of vitals) {
      const data = vitalHistory(v.def.key, s)
      if (v.def.key === 'hit') {
        sparkline(v.canvas, data, { color: v.def.color, fill: true, min: 0, max: 100, baseline: 99 })
      } else {
        sparkline(v.canvas, data, { color: v.def.color, fill: true, min: 0 })
      }
    }
  }

  let lastRingClass = ''

  function paintCheckpoint(s: SimState): void {
    const c = s.checkpoint
    const active = c.phase !== 'idle'
    let p: number
    let cls: string
    if (active) {
      p = clamp(c.progress, 0, 1)
      cls = 'hud-ckpt is-running'
      setText(ringNum, `${Math.round(p * 100)}`)
      const phase = c.phase === 'syncing' || c.phase === 'finishing' ? 'SYNCING' : 'WRITING'
      setText(ckptState, `${phase} · ${c.reason}`)
    } else {
      const timeout = Math.max(1, s.knobs.checkpointTimeout)
      p = clamp(1 - c.nextInSec / timeout, 0, 1)
      cls = p > 0.9 ? 'hud-ckpt is-due' : p > 0.7 ? 'hud-ckpt is-near' : 'hud-ckpt'
      setText(ringNum, String(Math.max(0, Math.ceil(c.nextInSec))))
      setText(ckptState, `in ${fmtDuration(c.nextInSec)}`)
    }
    if (cls !== lastRingClass) {
      lastRingClass = cls
      ckptBtn.className = cls
    }
    ringBar.setAttribute('stroke-dashoffset', (RING_C * (1 - p)).toFixed(2))
  }

  function paintTransport(s: SimState): void {
    const paused = s.knobs.paused
    if (playIcon.dataset.state !== (paused ? 'paused' : 'running')) {
      playIcon.dataset.state = paused ? 'paused' : 'running'
      playIcon.replaceChildren(icon(paused ? 'play' : 'pause', 14))
    }
    setClass(playBtn, 'is-active', paused)
    setText(speedEl, fmtSpeed(s.knobs.timeScale))
  }

  function paintTraceRail(s: SimState): void {
    const trace = s.trace
    const live = trace.sql.length > 0
    setClass(traceRail, 'is-live', live)
    setClass(traceBtn, 'is-active', live)
    if (!live) return
    const writes = trace.query === 'insert' || trace.query === 'update' || trace.query === 'delete'
    for (let i = 0; i < TRACE_RAIL.length; i++) {
      const stop = TRACE_RAIL[i]
      const chip = traceChips[i]
      const applicable = writes || (stop !== 'wal' && stop !== 'commit')
      const visited = (trace.visited & (1 << i)) !== 0
      setClass(chip, 'is-skipped', !applicable)
      setClass(chip, 'is-visited', visited)
      setClass(chip, 'is-now', trace.stop === stop)
    }
  }

  function paintAudio(): void {
    const state = ctx.getAudioState?.() ?? { enabled: false, preferred: false, volume: 0.35 }
    const enabled = state.enabled && state.volume > 0
    const ready = !enabled && state.preferred
    const text = enabled ? 'Sound on' : ready ? 'Sound ready' : 'Sound off'
    setText(audioLabel, text)
    setClass(audioBtn, 'is-active', enabled)
    setClass(audioBtn, 'is-ready', ready)
    audioBtn.setAttribute('aria-pressed', String(enabled))
    audioBtn.setAttribute('aria-label', enabled ? 'Turn sound off' : 'Turn sound on')
    audioBtn.title = enabled
      ? `Sound on · ${Math.round(state.volume * 100)}%  (M)`
      : ready
        ? 'Sound ready — interact to resume  (M)'
        : 'Turn sound on  (M)'
  }

  function paintTheme(mode = themeMode()): void {
    if (themeIcon.dataset.mode !== mode) {
      themeIcon.dataset.mode = mode
      themeIcon.replaceChildren(icon(mode === 'day' ? 'sun' : 'moon', 15))
    }
    const day = mode === 'day'
    setText(themeLabel, day ? 'Day' : 'Night')
    setClass(themeBtn, 'is-active', day)
    themeBtn.setAttribute('aria-pressed', String(day))
    themeBtn.setAttribute('aria-label', day ? 'Day theme; switch to night' : 'Night theme; switch to daylight')
    themeBtn.title = day ? 'Daylight theme — switch to night  (N)' : 'Night theme — switch to daylight  (N)'
  }

  let lastScenario: string | null | undefined

  function paintViewButton(): void {
    const label =
      cameraMode === 'fly' ? 'Exit fly' : cameraPreset === 'plan' ? 'Exit overview' : 'View'
    const exiting = label !== 'View'
    setText(viewLabel, label)
    setClass(viewBtn, 'is-active', viewOpen || exiting)
    viewBtn.setAttribute(
      'aria-label',
      cameraMode === 'fly'
        ? 'Exit fly mode'
        : cameraPreset === 'plan'
          ? 'Exit overhead view'
          : 'Open view and destination controls',
    )
    viewBtn.title =
      cameraMode === 'fly'
        ? 'Exit fly mode'
        : cameraPreset === 'plan'
          ? 'Return to the city view'
        : 'View, display, and destinations'
  }

  function setDecisionFact(index: number, label: string, value: string): void {
    const fact = decisionFacts[index]
    setText(fact.label, label)
    setText(fact.value, value)
  }

  function paintDecision(): void {
    const s = sim.state
    const decision = s.scenarioDecision
    const def = s.scenario ? SCENARIOS.find((scenario) => scenario.id === s.scenario) : undefined
    if (!decision || !def?.decision || decision.phase === 'staging') {
      decisionRoot.hidden = true
      return
    }

    decisionRoot.hidden = false
    decisionRoot.dataset.kind = decision.kind
    decisionRoot.dataset.phase = decision.phase
    setText(
      decisionState,
      decision.phase === 'ready'
        ? decision.kind === 'slot-pressure'
          ? 'Scaled WAL rate · choose an operation'
          : 'Choose an operation'
        : decision.phase === 'recovering'
          ? 'Operation running'
          : decision.phase === 'recovered'
            ? 'Recovery complete'
            : 'Consequence visible',
    )

    const showChoices = decision.phase === 'ready' && decision.choice === null
    decisionChoices.hidden = !showChoices
    if (showChoices) {
      for (let i = 0; i < decisionChoiceUi.length; i++) {
        const choice = def.decision.choices[i]
        const ui = decisionChoiceUi[i]
        ui.root.dataset.scenarioChoice = choice.id
        ui.root.disabled = false
        setText(ui.label, choice.label)
        setText(ui.hint, choice.hint)
      }
    }

    decisionResult.hidden = decision.choice === null
    decisionActions.hidden = decision.choice === null
    decisionRetry.hidden =
      decision.phase !== 'outcome' && decision.phase !== 'recovered'
    decisionRecover.hidden = true
    decisionRecover.disabled = false

    if (decision.kind === 'slot-pressure') {
      const slot = s.replication.physicalSlots[1]
      const standby = s.replication.standbys[1]
      setText(decisionTitle, 'WAL retention and standby continuity')
      setDecisionFact(
        0,
        'pg_wal',
        `${fmtBytes(s.disasterRecovery.archive.pgWalBytes)} / ${fmtBytes(s.disasterRecovery.archive.pgWalCapacityBytes)}`,
      )
      setDecisionFact(
        1,
        'standby_b_slot',
        slot.exists
          ? `${slot.active ? 'active' : 'inactive'} · ${fmtBytes(slot.retainedBytes)} retained`
          : 'dropped · no WAL retained',
      )
      setDecisionFact(
        2,
        'standby_b durable gap',
        fmtBytes(Math.max(0, s.wal.flushLsn - standby.flushedLsn)),
      )
      if (decision.choice === 'add-wal-capacity') {
        setText(
          decisionResult,
          decision.phase === 'recovered'
            ? `You added ${fmtBytes(decision.addedCapacityBytes)}. standby_b caught up without a rebuild; ${fmtNum(decision.rejectedWrites)} writes were rejected after the decision.`
            : `You added ${fmtBytes(decision.addedCapacityBytes)}. The slot remains valid while standby_b catches up; the capacity is the cost.`,
        )
      } else if (decision.choice === 'drop-replication-slot') {
        setText(
          decisionResult,
          decision.phase === 'recovered'
            ? `You dropped the slot, then copied a ${fmtBytes(decision.rebuildBytes)} base backup. standby_b can stream again.`
            : `You dropped standby_b_slot. Retained WAL is recyclable now, but standby_b cannot resume: recovery requires a ${fmtBytes(decision.rebuildBytes)} base backup.`,
        )
        decisionRecover.hidden = decision.phase !== 'outcome' && decision.phase !== 'recovering'
        decisionRecover.disabled = decision.phase === 'recovering'
        setText(
          decisionRecover,
          decision.phase === 'recovering'
            ? `Rebuilding ${Math.min(100, (decision.rebuildCopiedBytes / Math.max(1, decision.rebuildBytes)) * 100).toFixed(0)}%`
            : 'Rebuild standby_b',
        )
      }
      return
    }

    if (decision.kind === 'vacuum-blockade') {
      let dead = 0
      let pages = 0
      for (let i = 0; i < s.tables.length; i++) {
        dead += s.tables[i].deadTuples
        pages += s.tables[i].pages
      }
      let workers = 0
      for (let i = 0; i < s.autovac.workers.length; i++) {
        if (s.autovac.workers[i].active) workers++
      }
      setText(decisionTitle, 'xmin horizon and cleanup')
      setDecisionFact(0, 'oldest snapshot', fmtDuration(s.oldestSnapshotAge))
      setDecisionFact(1, 'dead row versions', fmtNum(dead))
      setDecisionFact(2, 'autovacuum', `${workers} workers · ${fmtNum(pages)} pages`)
      if (decision.choice === 'terminate-transaction') {
        setText(
          decisionResult,
          decision.phase === 'recovered'
            ? `You terminated one idle transaction. The model aborts no uncommitted row changes; vacuum has reclaimed ${fmtNum(decision.deadTuplesReclaimed)} dead row versions.`
            : 'You terminated one idle transaction. Its snapshot released immediately; the next vacuum pass can reclaim the accumulated dead row versions.',
        )
      } else if (decision.choice === 'wait-for-transaction') {
        setText(
          decisionResult,
          `You kept the idle transaction. Since the decision: +${fmtNum(decision.deadTuplesAdded)} dead row versions, +${fmtNum(decision.pagesAdded)} relation pages, and ${decision.blockedVacuumWorkers} autovacuum workers kept scanning behind the pinned horizon.`,
        )
        decisionRecover.hidden = decision.phase !== 'outcome' && decision.phase !== 'recovering'
        decisionRecover.disabled = decision.phase === 'recovering'
        setText(
          decisionRecover,
          decision.phase === 'recovering' ? 'Vacuum reclaiming dead rows' : 'Terminate it now',
        )
      }
      return
    }

    setText(decisionTitle, 'Failover candidates by durable LSN')
    setDecisionFact(0, 'standby_a durable gap', fmtBytes(decision.standbyALagBytes))
    setDecisionFact(1, 'standby_b durable gap', fmtBytes(decision.standbyBLagBytes))
    setDecisionFact(
      2,
      'write admission',
      s.highAvailability.acceptingWrites ? 'open' : 'closed during failover',
    )
    if (decision.choice) {
      const chosen = decision.choice === 'promote-standby-a' ? 'standby_a' : 'standby_b'
      setText(
        decisionResult,
        s.highAvailability.transition.status !== 'complete'
          ? `You selected ${chosen}. The primary is gone; Patroni is waiting for the old leader lease before promotion.`
          : `You promoted ${chosen}: ${fmtBytes(decision.lossBytes)} and ${fmtNum(decision.lossTransactions)} committed write transactions are absent from the new timeline. Rejoining the former primary requires pg_rewind to copy ${fmtBytes(decision.rejoinBytes)} of changed blocks.`,
      )
      if (s.highAvailability.transition.status === 'complete' && s.highAvailability.rejoin.required) {
        decisionRecover.hidden = false
        decisionRecover.disabled = decision.phase === 'recovering'
        setText(
          decisionRecover,
          decision.phase === 'recovering'
            ? `pg_rewind ${(s.highAvailability.rejoin.progress * 100).toFixed(0)}%`
            : 'Rejoin former primary with pg_rewind',
        )
      }
    }
  }

  function paintScenario(): void {
    const s = sim.state
    if (s.scenario !== lastScenario) {
      lastScenario = s.scenario
      for (const c of chips) {
        const on = c.id === s.scenario
        setClass(c.root, 'is-active', on)
        c.root.setAttribute('aria-pressed', on ? 'true' : 'false')
      }
    }
    const def = s.scenario ? SCENARIOS.find((x) => x.id === s.scenario) : undefined
    if (!def) {
      setText(nowName, 'No scenario')
      setText(nowTime, 'free running')
      setText(nowStop, '')
      nowFill.style.width = '0%'
      setClass(nowBox, 'is-live', false)
      nowBox.disabled = true
      setText(scnBtn.querySelector<HTMLElement>('.hud-scn__toggle-label')!, 'Scenarios')
      scnBtn.title = 'Show or hide the scenario list'
      paintDecision()
      return
    }
    setClass(nowBox, 'is-live', true)
    nowBox.disabled = false
    setText(nowName, def.name)
    setText(nowStop, 'Stop')
    setText(scnBtn.querySelector<HTMLElement>('.hud-scn__toggle-label')!, 'Stop scenario')
    scnBtn.title = 'Stop the running scenario and restore the previous settings'
    if (def.duration > 0) {
      setText(nowTime, `${fmtClock(s.scenarioT)} / ${fmtClock(def.duration)}`)
      nowFill.style.width = `${clamp(s.scenarioT / def.duration, 0, 1) * 100}%`
    } else {
      setText(nowTime, `${fmtClock(s.scenarioT)} · running`)
      nowFill.style.width = '100%'
    }
    paintDecision()
  }

  function paintPerf(): void {
    const fps = Math.round(ctx.getFps())
    setText(fpsEl, `${fps} FPS`)
    fpsEl.className = 'hud-perf__fps' + (fps < 30 ? ' is-crit' : fps < 50 ? ' is-warn' : '')
    setText(partEl, `${fmtNum(ctx.getFlowStats().active)} particles`)
    const lv = ctx.getQuality().level
    if (qualitySel.value !== lv && document.activeElement !== qualitySel) qualitySel.value = lv
  }

  /* =======================================================================
   * TICK
   * =====================================================================*/

  let tFast = 0
  let tSlow = 0
  let tMap = 0

  function update(dt: number, wallDt = dt): void {
    const s = sim.state
    // Trace visits can be shorter than a rendered frame; the model's bitfield
    // is the source, and the rail paints that record on every frame.
    paintTraceRail(s)
    tFast += wallDt
    if (tFast >= 0.125) {
      tFast = 0
      paintTop(s)
      paintSparks(s)
      paintCheckpoint(s)
      paintTransport(s)
      paintAudio()
      paintScenario()
    }
    tMap += dt
    if (tMap >= 0.1) {
      tMap = 0
      paintCompass()
    }
    tSlow += wallDt
    if (tSlow >= 0.5) {
      tSlow = 0
      paintPerf()
    }
  }

  // first paint, so the bar is never empty for a frame
  paintTop(sim.state)
  paintSparks(sim.state)
  paintCheckpoint(sim.state)
  paintTransport(sim.state)
  paintTraceRail(sim.state)
  paintAudio()
  paintTheme()
  paintScenario()
  paintPerf()
  paintCompass()

  function dispose(): void {
    for (const off of cleanup) off()
    cleanup.length = 0
    for (const t of toasts) window.clearTimeout(t.timer)
    toasts.length = 0
    document.body.classList.remove('pg-labels-off')
    document.body.classList.remove('pg-walk')
    topBar.remove()
    viewPanel.remove()
    decisionRoot.remove()
    transport.remove()
    compassRoot.remove()
    toastEl.replaceChildren()
    toastEl.classList.remove('hud-toasts')
  }

  return { update, dispose }
}
