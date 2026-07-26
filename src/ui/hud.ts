import '../styles/hud.css'

import { COLOR, cssColor, onThemeMode, themeMode, toggleThemeMode } from '../core/theme'
import { clamp, fmtBytes, fmtDuration, fmtNum } from '../core/util'
import type { Bus, CameraMode, QualityLevel, SimApi, SimState } from '../core/types'
import { SCENARIOS } from '../sim/scenarios'
import { DISTRICT_BOUNDS } from '../world/layout'
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

/** 1..8 — keyboard destinations and the phone menu use this same order. */
const DISTRICT_DESTINATIONS = [
  { id: 'client.pool', label: 'Clients' },
  { id: 'backend.row', label: 'Backends' },
  { id: 'shared.buffers', label: 'Buffers' },
  { id: 'wal.vault', label: 'WAL' },
  { id: 'storage.datadir', label: 'Storage' },
  { id: 'checkpointer', label: 'Checkpoint' },
  { id: 'autovac.launcher', label: 'Vacuum' },
  { id: 'replica.standby', label: 'Standby' },
] as const

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
    label: 'Dirty pages',
    focus: 'shared.buffers',
    color: cssColor('bufDirty'),
    hint: 'Buffers modified in memory and not yet written to disk. Somebody has to pay for these eventually.',
  },
  {
    key: 'lag',
    label: 'Repl lag',
    focus: 'replica.standby',
    color: cssColor('replication'),
    hint: 'How far behind the standby has replayed. This is the number your read replica users actually feel.',
  },
]

interface MapDistrict {
  key: string
  label: string
  id: string
  color: number
}

/** Minimap footprints, painted back to front. */
const MAP_DISTRICTS: MapDistrict[] = [
  { key: 'storage', label: 'STORAGE', id: 'storage.datadir', color: COLOR.storage },
  { key: 'planner', label: 'PLANNER', id: 'planner.lab', color: COLOR.postmaster },
  { key: 'clients', label: 'CLIENTS', id: 'client.pool', color: COLOR.client },
  { key: 'backends', label: 'BACKENDS', id: 'backend.row', color: COLOR.backend },
  { key: 'shmem', label: 'SHARED MEM', id: 'shared.buffers', color: COLOR.shmem },
  { key: 'wal', label: 'WAL', id: 'wal.vault', color: COLOR.wal },
  { key: 'maintenance', label: 'MAINT', id: 'checkpointer', color: COLOR.vacuum },
  { key: 'replication', label: 'STANDBY', id: 'replica.standby', color: COLOR.replication },
]

const QUALITY_LEVELS: QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']

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

function health(s: SimState): Health {
  if (s.checkpoint.phase !== 'idle' && s.checkpoint.reason === 'wal') return 'crit'
  if (s.locks.length >= 3) return 'crit'
  if (s.stats.cacheHitPct < 50) return 'warn'
  if (s.replication.enabled && (s.replication.lagSec > 5 || lagClimbing(s.stats.history.lag))) return 'warn'
  if (s.buffers.size > 0 && s.buffers.dirtyCount / s.buffers.size > 0.7) return 'warn'
  return 'ok'
}

function healthReason(s: SimState, h: Health): string {
  if (s.checkpoint.phase !== 'idle' && s.checkpoint.reason === 'wal')
    return 'Checkpoint triggered by WAL volume — max_wal_size is being outrun'
  if (s.locks.length >= 3) return `${s.locks.length} backends waiting on a heavyweight lock`
  if (s.stats.cacheHitPct < 50) return `Cache hit ratio ${s.stats.cacheHitPct.toFixed(1)}% — most reads are going to storage`
  if (s.replication.enabled && s.replication.lagSec > 5) return `Standby is ${s.replication.lagSec.toFixed(1)}s behind`
  if (s.replication.enabled && lagClimbing(s.stats.history.lag)) return 'Replication lag is climbing'
  if (h === 'warn') return 'Most of the buffer pool is dirty'
  return 'Nothing dramatic is happening'
}

function vitalValue(key: VitalKey, s: SimState): { text: string; state: State } {
  switch (key) {
    case 'tps': {
      const offered = Math.max(1, s.knobs.tps)
      const ratio = s.stats.tps / offered
      return { text: fmtNum(s.stats.tps), state: ratio < 0.4 ? 'crit' : ratio < 0.72 ? 'warn' : '' }
    }
    case 'hit': {
      // Banded against what THIS city can actually reach. Its workload runs
      // sequential scans over relations far larger than a 768-frame pool, so it
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
      const r = s.buffers.size > 0 ? d / s.buffers.size : 0
      return { text: fmtNum(d), state: r > 0.75 ? 'crit' : r > 0.5 ? 'warn' : '' }
    }
    case 'lag': {
      if (!s.replication.enabled || !s.replication.connected) return { text: '—', state: '' }
      const v = s.replication.lagSec
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
    el('span', { class: 'hud-brand__mark' }, el('b', { text: 'PG' }), 'SIMCITY'),
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

  const tourBtn = toolBtn('tour', 'Guided tour', 'T', () => toggleTour())
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
  const viewBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-view-toggle',
      type: 'button',
      title: 'View, display, and destinations',
      'aria-label': 'Open view and destination controls',
      'aria-expanded': 'false',
      'aria-controls': 'hud-view-panel',
      on: { click: () => setViewOpen(!viewOpen) },
    },
    icon('eye', 15),
    el('span', { text: 'View' }),
  )
  const walkLabel = el('span', { class: 'hud-walk__label', text: 'Walk' })
  const walkBtn = el(
    'button',
    {
      class: 'pg-btn hud-tool hud-walk',
      type: 'button',
      title: 'Walk the city  (G)',
      'aria-label': 'Walk the city',
      'aria-pressed': 'false',
      on: {
        click: () => bus.emit('camera:mode', { mode: cameraMode === 'walk' ? 'orbit' : 'walk' }),
      },
    },
    icon('camera', 15),
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
    icon('bolt', 15),
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
    { class: 'hud-tools' },
    audioBtn,
    themeBtn,
    viewBtn,
    tourBtn,
    diagnoseLink,
    walkBtn,
    paletteBtn,
    helpBtn,
    perf,
  )

  const rightCluster = el('div', { class: 'hud-right' }, ckptBtn, el('span', { class: 'hud-sep' }), toolCluster)

  const topBar = el('div', { class: 'pg-panel hud-bar' }, brand, vitalsRow, rightCluster)
  topEl.append(topBar)

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
      data: { viewAction: 'home' },
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
  const districtViewButtons = DISTRICT_DESTINATIONS.map((destination, index) =>
    el(
      'button',
      {
        class: 'pg-btn hud-view__district',
        type: 'button',
        data: { viewDistrict: destination.id },
        title: `${destination.label}  (${index + 1})`,
        on: {
          click: () => {
            bus.emit('focus', { id: destination.id })
            setViewOpen(false)
          },
        },
      },
      el('span', { class: 'hud-view__key', text: String(index + 1) }),
      el('span', { text: destination.label }),
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
  const nowBox = el(
    'div',
    { class: 'hud-now' },
    el('div', { class: 'hud-now__row' }, nowName, nowTime),
    el('div', { class: 'hud-now__bar' }, nowFill),
  )

  /* Phone only: the scenario rail is thirteen chips long and there is no width
     for it under the transport, so it collapses behind one labelled control and
     the city keeps the pixels. Hidden on a desktop, where the rail always
     shows. */
  const scnBtn = el(
    'button',
    {
      class: 'pg-btn hud-scn__toggle',
      type: 'button',
      'aria-expanded': 'false',
      'aria-controls': 'hud-scenarios',
      title: 'Show or hide the scenario list',
      on: { click: () => setScenariosOpen(!scenariosOpen) },
    },
    el('span', { class: 'hud-scn__toggle-icon', text: '◈' }),
    el('span', { text: 'Scenarios' }),
  )

  const scnWrap = el(
    'div',
    { class: 'hud-transport__scn', id: 'hud-scenarios' },
    el('span', { class: 'pg-eyebrow hud-scn__label', text: 'Scenarios' }),
    nowBox,
    scenarioCue,
    chipRow,
  )

  /* Where the tool cluster lands on a phone. Empty, and zero-sized, otherwise. */
  const dockSlot = el('div', { class: 'hud-transport__dock' })

  const transport = el(
    'div',
    { class: 'pg-panel hud-transport' },
    el('div', { class: 'hud-transport__deck' }, playBtn, speedGroup, resetBtn, scnBtn),
    el('span', { class: 'hud-sep' }),
    scnWrap,
    dockSlot,
  )
  bottomEl.append(transport)

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
    setClass(viewBtn, 'is-active', next)
    setClass(transport, 'is-view-open', next)
    viewBtn.setAttribute('aria-expanded', String(next))
    if (next && scenariosOpen) setScenariosOpen(false)
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
  }
  const toasts: Toast[] = []

  function dropToast(t: Toast): void {
    const i = toasts.indexOf(t)
    if (i < 0) return
    toasts.splice(i, 1)
    window.clearTimeout(t.timer)
    t.node.classList.add('is-out')
    window.setTimeout(() => t.node.remove(), 240)
  }

  function pushToast(
    text: string,
    kind: 'info' | 'warn' | 'good' = 'info',
    ms = 3600,
    action?: { label: string; quality: QualityLevel },
  ): void {
    const node = el(
      'button',
      {
        class: `hud-toast hud-toast--${kind} pg-enter`,
        type: 'button',
        'aria-label': action ? `${text} ${action.label}` : 'Dismiss',
      },
      el('span', { class: 'hud-toast__dot pg-dot' }),
      el('span', { class: 'hud-toast__txt', text }),
      ...(action ? [el('span', { class: 'hud-toast__action', text: action.label })] : []),
    )
    const t: Toast = { node, timer: window.setTimeout(() => dropToast(t), Math.max(600, ms)) }
    node.addEventListener('click', () => {
      if (action) bus.emit('quality', { level: action.quality })
      dropToast(t)
    })
    toasts.push(t)
    toastEl.prepend(node)
    while (toasts.length > 4) dropToast(toasts[0])
  }

  cleanup.push(
    bus.on('toast', (p) => pushToast(p.text, p.kind ?? 'info', p.ms ?? 3600, p.action)),
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
    sim.setKnob('paused', !sim.state.knobs.paused)
  }

  function nudgeSpeed(dir: -1 | 1): void {
    const i = clamp(nearestSpeed(sim.state.knobs.timeScale) + dir, 0, SPEEDS.length - 1)
    sim.setKnob('timeScale', SPEEDS[i])
  }

  function resetSim(): void {
    sim.reset()
    bus.emit('toast', { text: 'Cluster restarted — knobs back to defaults', kind: 'info', ms: 2600 })
  }

  function toggleScenario(id: string): void {
    sim.runScenario(sim.state.scenario === id ? null : id)
  }

  function toggleTour(): void {
    if (tourRunning) bus.emit('tour:stop', {})
    else bus.emit('tour:start', {})
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
      text: next === 'day' ? 'Daylight — the city at noon' : 'Night — the city lit by its own data',
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
        toggleTour()
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
      default:
        break
    }

    if (k >= '1' && k <= '8') {
      e.preventDefault()
      bus.emit('focus', { id: DISTRICT_DESTINATIONS[Number(k) - 1].id })
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
      setClass(walkBtn, 'is-active', walking)
      walkBtn.setAttribute('aria-pressed', String(walking))
      walkBtn.setAttribute('aria-label', walking ? 'Exit walk mode' : 'Walk the city')
      walkBtn.title = walking ? 'Exit walk mode  (G)' : 'Walk the city  (G)'
      setText(walkLabel, walking ? 'Exit' : 'Walk')
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
      nowFill.style.width = '0%'
      setClass(nowBox, 'is-live', false)
      return
    }
    setClass(nowBox, 'is-live', true)
    setText(nowName, def.name)
    if (def.duration > 0) {
      setText(nowTime, `${fmtClock(s.scenarioT)} / ${fmtClock(def.duration)}`)
      nowFill.style.width = `${clamp(s.scenarioT / def.duration, 0, 1) * 100}%`
    } else {
      setText(nowTime, `${fmtClock(s.scenarioT)} · running`)
      nowFill.style.width = '100%'
    }
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
    topBar.remove()
    viewPanel.remove()
    transport.remove()
    compassRoot.remove()
    toastEl.replaceChildren()
    toastEl.classList.remove('hud-toasts')
  }

  return { update, dispose }
}
