import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

import '../styles/labels.css'
import { COLOR } from '../core/theme'
import type { Registry } from '../core/registry'
import type { Bus, ComponentDef, DistrictId, QualitySettings, SimState } from '../core/types'

/* ============================================================================
 * LABELS — map-grade annotation.
 *
 * A city with eighty named parts cannot simply project every name: capping the
 * *count* does nothing about two chips landing on the same pixels. So this
 * layer does what a map renderer does, in four parts:
 *
 *  1. ZOOM HIERARCHY. Every anchor is scored against its own distance to the
 *     camera, so the far side of the city stays coarse while the part you flew
 *     to annotates itself in detail:
 *
 *        city      the model's own name, only from far out
 *        district  one chip per district, at the centroid of its members
 *        tier 0    landmarks
 *        tier 1    structures
 *        tier 2    details
 *
 *     Neighbouring levels overlap in a fade band, so one hands over to the next
 *     instead of blinking. A district whose name a member already carries
 *     (Backends, Shared memory, Storage) promotes that member rather than
 *     drawing a second chip saying the same word beside it.
 *
 *  2. SCREEN-SPACE COLLISION. Each pass projects the candidates to pixels,
 *     sorts them by priority and places them greedily against a uniform grid of
 *     the rects already down. A chip that does not fit at its home offset is
 *     tried at seven alternates (other side, lifted, below) before it is given
 *     up on, and its leader is redrawn to whichever corner ends up nearest the
 *     anchor.
 *
 *  3. HYSTERESIS. Recomputing placement from scratch makes boundary labels
 *     strobe as the camera drifts, which reads far worse than overlap. So a
 *     shown label (a) outranks an equal-tier hidden one, (b) tolerates a few
 *     pixels of real overlap before it is dropped, and (c) cannot be dropped at
 *     all inside its minimum dwell. A hidden one needs clear space and a short
 *     cooldown before it may come back.
 *
 *  4. COLLAPSE, NEVER SILENCE. Anything on screen that is not labelled — level
 *     gated or collided out — is counted into its district's "+N" pill, so an
 *     area can never read as empty. That is the bug this file exists to fix:
 *     wal_buffers and CLOG sit on the shared-memory plaza and were simply never
 *     labelled from a normal viewing distance, with nothing on screen to say
 *     they were there at all.
 *
 * Cost: the full pass runs at ~9Hz, never per frame. Chip boxes are measured
 * once at construction, in both forms, and re-measured only when their content
 * really changes width; every read in a pass happens before every write, so a
 * pass costs at most one layout. Between passes the browser interpolates chip
 * offsets on the compositor through a transform transition. The hot path
 * allocates nothing.
 * ==========================================================================*/

/* --- zoom hierarchy: world units from the camera to the anchor ------------- */
/** The model's own name fades in above this. */
const CITY_IN = 420
const CITY_BAND = 110
/** District chips fade in above this (and stay for as long as they carry a "+N"). */
const DISTRICT_IN = 360
const DISTRICT_BAND = 90
/** Per tier: gone beyond TIER_OUT, full below TIER_OUT - TIER_BAND. */
const TIER_OUT = [400, 320, 150]
const TIER_BAND = [80, 70, 35]
/** Past this the chip drops its role line and readout. */
const FAR_DIST = 250

/* --- priority bands, lowest wins ------------------------------------------ */
const B_SELECTED = 0
const B_HOVERED = 1
const B_FOCUS = 2
const B_CITY = 3
const B_DISTRICT = 4
const B_TIER = [5, 7, 8]
/** A district chip on screen only to carry its "+N". */
const B_COLLAPSE = 6
/** Bands sit this far apart; distance (< ~2000) is the within-band tiebreak. */
const BAND_STEP = 100000
/** A shown label beats a hidden one of the same band — but never crosses a band. */
const STICKY = 40000

/* --- timing --------------------------------------------------------------- */
/** Full placement pass ~9x/sec. Faster is invisible to the eye and costs a layout. */
const PASS_SEC = 1 / 9
/** Readouts tick at 6Hz; faster just makes numbers unreadable. */
const READOUT_SEC = 1 / 6
/** Must match the opacity transition on .lbl. */
const FADE_SEC = 0.22
/** A label cannot be collided away inside this long of appearing. */
const MIN_DWELL = 0.7
/** …nor come back inside this long of being dropped. */
const HIDE_COOLDOWN = 0.3
/** How long a tour/scenario focus keeps its priority boost. */
const FOCUS_TTL = 30

/* --- placement geometry, pixels ------------------------------------------- */
const GAP_X = 16
const GAP_Y = 16
/** A hidden label needs this much clear space around it to be placed… */
const PAD_NEW = 8
/** …a shown one tolerates this much real overlap before it is dropped. */
const PAD_KEEP = -3
/** Keep chips this far off the viewport edge. */
const EDGE = 6
/** Candidate offsets: home first, then other side / lifted / below. */
const VAR_SIDE = [1, -1, 1, -1, 1, -1, 1, -1]
const VAR_UP = [1, 1, 1, 1, -1, -1, 1, 1]
const VAR_LIFT = [0, 0, 30, 30, 0, 0, 62, 62]
const N_VAR = 8

/* --- collision grid ------------------------------------------------------- */
const CELL = 96
const CELL_CAP = 20
const MAX_RECTS = 96

/** Fallback accent per district, overridden by ComponentDef.color. */
const DISTRICT_COLOR: Record<DistrictId, number> = {
  clients: COLOR.client,
  backends: COLOR.backend,
  shmem: COLOR.shmem,
  wal: COLOR.wal,
  storage: COLOR.storage,
  maintenance: COLOR.vacuum,
  replication: COLOR.replication,
  planner: COLOR.index,
  world: COLOR.ink,
}

/** Name on a district chip. Empty = this district never gets one. */
const DISTRICT_NAME: Record<DistrictId, string> = {
  clients: 'Clients',
  backends: 'Backends',
  shmem: 'Shared memory',
  wal: 'WAL',
  storage: 'Storage',
  maintenance: 'Maintenance',
  replication: 'Standby',
  planner: 'Query lab',
  world: '', // the model's own name is a component already, at the city level
}

/** A district earns a chip once it has this many members. */
const DISTRICT_MIN = 2
/** A plausible readout, so the very first measurement reserves room for one. */
const READ_FILLER = '0000000 · 00000 · 000'

/* --- module-scope scratch: the hot path must not allocate ------------------ */
const _proj = new THREE.Matrix4()
const _v4 = new THREE.Vector4()

/** 0 = off, 1 = armed (mounted, not yet transitioned), 2 = on, 3 = fading out. */
type LabelPhase = 0 | 1 | 2 | 3

/** -1 = the model's own name, 0..2 = ComponentDef.tier, 3 = a district chip. */
type LabelRank = -1 | 0 | 1 | 2 | 3

interface Entry {
  id: string
  def: ComponentDef | null
  district: DistrictId
  rank: LabelRank
  /** This component *is* its district's label — it carries the "+N" itself. */
  proxy: boolean
  el: HTMLDivElement
  chip: HTMLElement
  read: HTMLElement | null
  more: HTMLElement
  obj: CSS2DObject
  pos: THREE.Vector3
  /** district chips and proxies only */
  members: Entry[]

  /* measured chip box, in both forms */
  nearW: number
  nearH: number
  farW: number
  farH: number
  needMeasure: boolean
  measuredRead: number

  /* per pass */
  dist: number
  onScreen: boolean
  sx: number
  sy: number
  band: number
  prio: number
  alpha: number
  place: boolean

  /* sticky state */
  shown: boolean
  shownT: number
  hiddenT: number
  variant: number
  dx: number
  dy: number

  /* collapse bookkeeping, district chips and proxies only */
  hidden: number
  zeroPasses: number
  collapseOn: boolean

  /* DOM write cache */
  far: boolean
  phase: LabelPhase
  fadeT: number
  lastRead: string
  lastOpacity: number
  lastDx: number
  lastDy: number
  lastMore: number
  nudged: boolean
}

export interface LabelsApi {
  /** Add this to the scene — the CSS2D objects hang off it. */
  group: THREE.Object3D
  update(dt: number, camera: THREE.PerspectiveCamera, sim: SimState): void
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void
  resize(w: number, h: number): void
  setQuality(q: QualitySettings): void
  dispose(): void
}

export function createLabels(container: HTMLElement, registry: Registry, bus: Bus): LabelsApi {
  const group = new THREE.Group()
  group.name = 'labels'

  const renderer = new CSS2DRenderer()
  // We own stacking order (see .lbl.is-selected); skip the per-frame sort and
  // the z-index write it does on every element.
  renderer.sortObjects = false
  const dom = renderer.domElement
  dom.className = 'lbl-layer'
  dom.style.position = 'absolute'
  dom.style.top = '0'
  dom.style.left = '0'
  dom.style.pointerEvents = 'none'
  container.appendChild(dom)

  let viewW = container.clientWidth || window.innerWidth
  let viewH = container.clientHeight || window.innerHeight
  renderer.setSize(viewW, viewH)

  /** Off-screen host that sizes chips before they are ever mounted. */
  const measureHost = document.createElement('div')
  measureHost.className = 'lbl-measure'
  dom.appendChild(measureHost)

  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  /** The chip that speaks for a district — synthetic, or a promoted member. */
  const districts = new Map<DistrictId, Entry>()
  /** Reused between passes; never re-allocated. */
  const cand: Entry[] = []
  const pendingMeasure: Entry[] = []
  let componentCount = 0

  let maxLabels = 26
  let selectedId: string | null = null
  let hoveredId: string | null = null
  let focusId: string | null = null
  let focusT = 0
  /** Which chip the pointer is physically over, so we only emit on change. */
  let domHoverId: string | null = null
  let passT = PASS_SEC
  let readT = 0

  /* --------------------------------- DOM --------------------------------- */

  function makeEl(name: string, role: string, accent: number, withRead: boolean): Entry {
    const el = document.createElement('div')
    el.className = 'lbl'
    el.style.setProperty('--lbl-accent', hexCss(accent))

    const leader = document.createElement('span')
    leader.className = 'lbl__leader'
    const dot = document.createElement('span')
    dot.className = 'lbl__dot'

    const chip = document.createElement('div')
    chip.className = 'lbl__chip'

    const nameEl = document.createElement('span')
    nameEl.className = 'lbl__name'
    nameEl.textContent = name
    chip.appendChild(nameEl)

    if (role) {
      const roleEl = document.createElement('span')
      roleEl.className = 'lbl__role'
      roleEl.textContent = role
      chip.appendChild(roleEl)
    }

    let read: HTMLElement | null = null
    if (withRead) {
      read = document.createElement('span')
      read.className = 'lbl__read'
      // Reserve a plausible readout width for the first measurement; the real
      // string replaces it on the first pass this label is a candidate.
      read.textContent = READ_FILLER
      chip.appendChild(read)
    }

    // Every chip carries the collapse pill. It is display:none until it counts
    // for something, so it costs nothing and saves rebuilding the DOM later.
    const more = document.createElement('span')
    more.className = 'lbl__more'
    chip.appendChild(more)

    el.appendChild(leader)
    el.appendChild(dot)
    el.appendChild(chip)

    const obj = new CSS2DObject(el)
    // (0,0) against a zero-height .lbl puts the anchor exactly on the element's
    // origin, so every chip offset below is measured from the world point.
    obj.center.set(0, 0)
    obj.visible = false

    return {
      id: '',
      def: null,
      district: 'world',
      rank: 0,
      proxy: false,
      el,
      chip,
      read,
      more,
      obj,
      pos: new THREE.Vector3(),
      members: [],
      nearW: 120,
      nearH: 34,
      farW: 90,
      farH: 20,
      needMeasure: false,
      measuredRead: READ_FILLER.length,
      dist: 0,
      onScreen: false,
      sx: 0,
      sy: 0,
      band: B_TIER[2],
      prio: 0,
      alpha: 0,
      place: false,
      shown: false,
      shownT: 0,
      hiddenT: HIDE_COOLDOWN,
      variant: 0,
      dx: GAP_X,
      dy: -GAP_Y - 34,
      hidden: 0,
      zeroPasses: 99,
      collapseOn: false,
      far: false,
      phase: 0,
      fadeT: 0,
      lastRead: '',
      lastOpacity: -1,
      lastDx: NaN,
      lastDy: NaN,
      lastMore: -1,
      nudged: false,
    }
  }

  function makeComponent(def: ComponentDef): Entry {
    const isCity = def.district === 'world' && def.tier === 0
    const e = makeEl(def.name, def.role, def.color ?? DISTRICT_COLOR[def.district] ?? COLOR.ink, !!def.readout)
    e.id = def.id
    e.def = def
    e.district = def.district
    e.rank = isCity ? -1 : def.tier
    e.el.dataset.id = def.id
    if (isCity) e.el.classList.add('lbl--city')
    const at = def.labelAt ?? def.focus.target
    e.pos.set(at[0], at[1], at[2])
    e.obj.position.copy(e.pos)
    if (def.id === selectedId) e.el.classList.add('is-selected')
    if (def.id === hoveredId) e.el.classList.add('is-hovered')
    return e
  }

  function makeDistrict(id: DistrictId): Entry {
    const e = makeEl(DISTRICT_NAME[id], '', DISTRICT_COLOR[id] ?? COLOR.ink, false)
    e.id = `district:${id}`
    e.district = id
    e.rank = 3
    e.el.classList.add('lbl--district')
    return e
  }

  /**
   * Size every new chip in both forms, off-screen, before it can be placed.
   * Two layouts per batch — and none at all afterwards for anything whose text
   * never changes width.
   */
  function measureBatch(): void {
    const n = pendingMeasure.length
    if (!n) return
    for (let i = 0; i < n; i++) measureHost.appendChild(pendingMeasure[i].el)
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.nearW = e.chip.offsetWidth
      e.nearH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) pendingMeasure[i].el.classList.add('is-far')
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.farW = e.chip.offsetWidth
      e.farH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.el.classList.remove('is-far')
      if (e.read) e.read.textContent = ''
      measureHost.removeChild(e.el)
      group.add(e.obj)
    }
    pendingMeasure.length = 0
  }

  /** Pick up components registered since the last frame, then re-derive districts. */
  function sync(): void {
    const all = registry.all()
    let added = 0
    for (let i = 0; i < all.length; i++) {
      const def = all[i]
      if (byId.has(def.id)) continue
      const e = makeComponent(def)
      byId.set(def.id, e)
      entries.push(e)
      pendingMeasure.push(e)
      added++
    }
    componentCount = all.length
    if (!added) return
    rebuildDistricts()
    measureBatch()
  }

  /**
   * Decide what speaks for each district. If a member is already named after it
   * — backend.row is "Backends", shmem.deck is "Shared memory" — that member is
   * promoted instead of being shadowed by a second chip saying the same word.
   * Failing that, a synthetic chip goes at the centroid of the members.
   */
  function rebuildDistricts(): void {
    for (const d of districts.values()) {
      d.members.length = 0
      d.proxy = false
    }

    const members = new Map<DistrictId, Entry[]>()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.rank < 0 || e.rank > 2) continue
      if (!DISTRICT_NAME[e.district]) continue
      let list = members.get(e.district)
      if (!list) {
        list = []
        members.set(e.district, list)
      }
      list.push(e)
    }

    for (const [id, list] of members) {
      if (list.length < DISTRICT_MIN) continue
      const want = DISTRICT_NAME[id].toLowerCase()
      let twin: Entry | null = null
      for (let i = 0; i < list.length; i++) {
        const def = list[i].def
        if (def && def.name.toLowerCase() === want && (!twin || list[i].rank < twin.rank)) twin = list[i]
      }

      let chip = districts.get(id)
      if (twin) {
        // A promoted member takes over; a synthetic chip made for this district
        // on an earlier pass is retired where it can never be a candidate again.
        if (chip && chip !== twin) retire(chip)
        chip = twin
        twin.proxy = true
      } else if (!chip || chip.rank !== 3) {
        chip = makeDistrict(id)
        entries.push(chip)
        pendingMeasure.push(chip)
      }
      districts.set(id, chip)
      chip.members = list
      if (chip.rank !== 3) continue

      let x = 0
      let y = 0
      let z = 0
      let anchor = list[0]
      for (let i = 0; i < list.length; i++) {
        x += list[i].pos.x
        y += list[i].pos.y
        z += list[i].pos.z
        if (list[i].rank < anchor.rank) anchor = list[i]
      }
      chip.pos.set(x / list.length, y / list.length + 10, z / list.length)
      chip.obj.position.copy(chip.pos)
      // Clicking a district does the obvious thing: inspect its biggest part.
      if (anchor.id) chip.el.dataset.id = anchor.id
    }
  }

  function retire(e: Entry): void {
    e.members.length = 0
    e.place = false
    e.shown = false
    e.obj.visible = false
    e.phase = 0
    e.pos.set(0, -1e6, 0)
    e.obj.position.copy(e.pos)
  }

  /* ------------------------------ interaction ---------------------------- */

  function idFrom(target: EventTarget | null): string | null {
    const node = target as HTMLElement | null
    if (!node || typeof node.closest !== 'function') return null
    const host = node.closest('.lbl') as HTMLElement | null
    return host?.dataset.id ?? null
  }

  function onClick(ev: MouseEvent): void {
    const id = idFrom(ev.target)
    if (!id) return
    ev.stopPropagation()
    bus.emit('select', { id })
  }

  function onDblClick(ev: MouseEvent): void {
    const id = idFrom(ev.target)
    if (!id) return
    ev.stopPropagation()
    bus.emit('focus', { id })
  }

  function onOver(ev: PointerEvent): void {
    const id = idFrom(ev.target)
    if (!id || id === domHoverId) return
    domHoverId = id
    bus.emit('hover', { id })
  }

  function onOut(ev: PointerEvent): void {
    if (!domHoverId) return
    // moving between the chip and its dot must not read as "left the label"
    if (idFrom(ev.relatedTarget) === domHoverId) return
    domHoverId = null
    bus.emit('hover', { id: null })
  }

  // Delegated: four listeners for the whole layer instead of five per chip.
  dom.addEventListener('click', onClick)
  dom.addEventListener('dblclick', onDblClick)
  dom.addEventListener('pointerover', onOver)
  dom.addEventListener('pointerout', onOut)

  const offSelect = bus.on('select', ({ id }) => {
    if (id === selectedId) return
    byId.get(selectedId ?? '')?.el.classList.remove('is-selected')
    selectedId = id
    byId.get(id ?? '')?.el.classList.add('is-selected')
    passT = PASS_SEC // the selection must show even if it was budgeted out
  })

  const offHover = bus.on('hover', ({ id }) => {
    if (id === hoveredId) return
    byId.get(hoveredId ?? '')?.el.classList.remove('is-hovered')
    hoveredId = id
    byId.get(id ?? '')?.el.classList.add('is-hovered')
    passT = PASS_SEC
  })

  // The tour and the scenarios aim the camera through 'focus'; whatever they
  // are pointing at outranks everything but the user's own selection.
  const offFocus = bus.on('focus', ({ id }) => {
    focusId = id
    focusT = id ? FOCUS_TTL : 0
    passT = PASS_SEC
  })

  /* ------------------------- HUD-aware placement box ---------------------- */

  const hudTop = document.getElementById('hud-top')
  const hudBottom = document.getElementById('hud-bottom')
  const hudLeft = document.getElementById('hud-left')
  const hudRight = document.getElementById('hud-right')
  let boxL = 0
  let boxT = 0
  let boxR = 0
  let boxB = 0

  /** A label under the console or the inspector is invisible — don't spend one there. */
  function readBox(): void {
    boxL = EDGE
    boxT = EDGE
    boxR = viewW - EDGE
    boxB = viewH - EDGE
    if (hudTop) {
      const r = hudTop.getBoundingClientRect()
      if (r.height > 0) boxT = Math.max(boxT, r.bottom + 6)
    }
    if (hudBottom) {
      const r = hudBottom.getBoundingClientRect()
      if (r.height > 0) boxB = Math.min(boxB, r.top - 6)
    }
    if (hudLeft) {
      const r = hudLeft.getBoundingClientRect()
      if (r.width > 0) boxL = Math.max(boxL, r.right + 6)
    }
    if (hudRight) {
      const r = hudRight.getBoundingClientRect()
      if (r.width > 0) boxR = Math.min(boxR, r.left - 6)
    }
    // A layout we did not anticipate must never squeeze the labels out entirely.
    if (boxR - boxL < 260 || boxB - boxT < 180) {
      boxL = EDGE
      boxT = EDGE
      boxR = viewW - EDGE
      boxB = viewH - EDGE
    }
  }

  /* ----------------------------- collision grid --------------------------- */

  const rX = new Float32Array(MAX_RECTS)
  const rY = new Float32Array(MAX_RECTS)
  const rW = new Float32Array(MAX_RECTS)
  const rH = new Float32Array(MAX_RECTS)
  let rectN = 0
  let gCols = 0
  let gRows = 0
  let gCells = new Int32Array(0)
  let gCounts = new Int32Array(0)
  let gDegraded = false

  function ensureGrid(): void {
    const c = Math.max(1, Math.ceil(viewW / CELL))
    const r = Math.max(1, Math.ceil(viewH / CELL))
    if (c === gCols && r === gRows) return
    gCols = c
    gRows = r
    gCells = new Int32Array(c * r * CELL_CAP)
    gCounts = new Int32Array(c * r)
  }

  function gridReset(): void {
    gCounts.fill(0)
    rectN = 0
    gDegraded = false
  }

  function cellIdx(v: number, max: number): number {
    const i = Math.floor(v / CELL)
    return i < 0 ? 0 : i > max ? max : i
  }

  function addRect(x: number, y: number, w: number, h: number): void {
    if (rectN >= MAX_RECTS) {
      gDegraded = true
      return
    }
    const i = rectN++
    rX[i] = x
    rY[i] = y
    rW[i] = w
    rH[i] = h
    const c0 = cellIdx(x, gCols - 1)
    const c1 = cellIdx(x + w, gCols - 1)
    const r0 = cellIdx(y, gRows - 1)
    const r1 = cellIdx(y + h, gRows - 1)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * gCols + c
        const n = gCounts[k]
        if (n >= CELL_CAP) {
          // One overfull cell drops this pass to a linear scan. With under a
          // hundred rects that is still microseconds, and it cannot miss a hit.
          gDegraded = true
          continue
        }
        gCells[k * CELL_CAP + n] = i
        gCounts[k] = n + 1
      }
    }
  }

  function hitsRect(i: number, x: number, y: number, w: number, h: number): boolean {
    return x < rX[i] + rW[i] && x + w > rX[i] && y < rY[i] + rH[i] && y + h > rY[i]
  }

  function hits(x: number, y: number, w: number, h: number): boolean {
    if (gDegraded) {
      for (let i = 0; i < rectN; i++) if (hitsRect(i, x, y, w, h)) return true
      return false
    }
    const c0 = cellIdx(x, gCols - 1)
    const c1 = cellIdx(x + w, gCols - 1)
    const r0 = cellIdx(y, gRows - 1)
    const r1 = cellIdx(y + h, gRows - 1)
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * gCols + c
        const n = gCounts[k]
        const base = k * CELL_CAP
        for (let j = 0; j < n; j++) if (hitsRect(gCells[base + j], x, y, w, h)) return true
      }
    }
    return false
  }

  /* -------------------------------- the pass ------------------------------ */

  let vx = 0
  let vy = 0

  /** Chip top-left for variant v, in screen pixels. Writes vx / vy. */
  function variantAt(e: Entry, v: number, w: number, h: number): void {
    vx = VAR_SIDE[v] > 0 ? e.sx + GAP_X : e.sx - GAP_X - w
    vy = VAR_UP[v] > 0 ? e.sy - GAP_Y - h - VAR_LIFT[v] : e.sy + GAP_Y + VAR_LIFT[v]
  }

  function fits(e: Entry, v: number, w: number, h: number, pad: number): boolean {
    variantAt(e, v, w, h)
    if (vx - pad < boxL || vx + w + pad > boxR || vy - pad < boxT || vy + h + pad > boxB) return false
    return !hits(vx - pad, vy - pad, w + pad * 2, h + pad * 2)
  }

  function anyVisible(d: Entry): boolean {
    const m = d.members
    for (let i = 0; i < m.length; i++) {
      const def = m[i].def
      if (def && def.object.visible) return true
    }
    return false
  }

  function pass(camera: THREE.PerspectiveCamera): void {
    /* ---- READ PHASE — nothing below here may touch the DOM ------------- */
    readBox()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!e.needMeasure || e.far || e.phase === 0) continue
      const w = e.chip.offsetWidth
      if (w > 0) {
        e.nearW = w
        e.nearH = e.chip.offsetHeight
        e.needMeasure = false
      }
    }

    /* ---- score ---------------------------------------------------------- */
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    const hw = viewW * 0.5
    const hh = viewH * 0.5
    cand.length = 0

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      e.place = false
      e.onScreen = false
      e.dist = camera.position.distanceTo(e.pos)

      if (e.rank === 3) {
        if (e.members.length < DISTRICT_MIN || !anyVisible(e)) continue
      } else if (e.def && !e.def.object.visible) {
        continue
      }

      _v4.set(e.pos.x, e.pos.y, e.pos.z, 1).applyMatrix4(_proj)
      const cw = _v4.w
      if (cw <= 1e-6) continue // behind the camera
      const nz = _v4.z / cw
      if (nz < -1 || nz > 1) continue // CSS2DRenderer would hide it anyway
      const sx = (_v4.x / cw) * hw + hw
      const sy = -(_v4.y / cw) * hh + hh
      if (sx < boxL - 90 || sx > boxR + 90 || sy < boxT - 90 || sy > boxB + 90) continue
      e.sx = sx
      e.sy = sy
      e.onScreen = true

      const forced = e.id === selectedId || e.id === hoveredId
      const focused = !forced && focusT > 0 && e.id === focusId
      let band: number
      let alpha: number

      if (e.rank === 3) {
        const a = fadeIn(e.dist, DISTRICT_IN, DISTRICT_BAND)
        if (a > 0.02) {
          band = B_DISTRICT
          alpha = e.collapseOn ? 1 : a
        } else if (e.collapseOn) {
          band = B_COLLAPSE
          alpha = 1
        } else continue
      } else if (e.rank < 0) {
        alpha = fadeIn(e.dist, CITY_IN, CITY_BAND)
        band = B_CITY
        if (alpha <= 0.02 && !forced && !focused) continue
      } else {
        const tier = fadeOut(e.dist, TIER_OUT[e.rank], TIER_BAND[e.rank])
        if (e.proxy) {
          // A promoted member has to survive out to district range, where it is
          // the only thing naming this part of the city.
          const a = fadeIn(e.dist, DISTRICT_IN, DISTRICT_BAND)
          alpha = a > tier ? a : tier
          band = B_DISTRICT
        } else {
          alpha = tier
          band = B_TIER[e.rank]
        }
        if (alpha <= 0.02 && !forced && !focused) continue
      }

      if (forced) {
        band = e.id === selectedId ? B_SELECTED : B_HOVERED
        alpha = 1
      } else if (focused) {
        band = B_FOCUS
        alpha = 1
      }

      e.band = band
      e.alpha = alpha
      e.prio = band * BAND_STEP + (e.dist < 60000 ? e.dist : 60000) - (e.shown ? STICKY : 0)
      cand.push(e)
    }

    cand.sort(byPrio)

    /* ---- place ---------------------------------------------------------- */
    ensureGrid()
    gridReset()
    let budget = maxLabels

    for (let i = 0; i < cand.length; i++) {
      const e = cand[i]
      const w = e.far ? e.farW : e.nearW
      const h = e.far ? e.farH : e.nearH
      // Selected and hovered are placed first and are never collided away;
      // anything inside its dwell is held down so nothing can blink.
      const pinned = e.band <= B_HOVERED || (e.shown && e.shownT < MIN_DWELL)
      const cooling = !e.shown && e.hiddenT < HIDE_COOLDOWN && e.band > B_FOCUS
      const pad = e.shown ? PAD_KEEP : PAD_NEW
      let v = -1

      if ((budget > 0 || pinned) && (!cooling || pinned)) {
        if (fits(e, 0, w, h, pad)) v = 0
        else if (e.variant > 0 && fits(e, e.variant, w, h, pad)) v = e.variant
        else {
          for (let k = 1; k < N_VAR; k++) {
            if (k === e.variant) continue
            if (fits(e, k, w, h, pad)) {
              v = k
              break
            }
          }
        }
      }
      // A pinned label goes down wherever it was, even overlapping: an awkward
      // pair for a few frames beats a label that strobes.
      if (v < 0 && pinned) v = e.variant

      if (v < 0) continue
      variantAt(e, v, w, h)
      e.variant = v
      e.dx = vx - e.sx
      e.dy = vy - e.sy
      e.place = true
      budget--
      addRect(vx, vy, w, h)
    }

    /* ---- collapse counts ------------------------------------------------ */
    for (const d of districts.values()) d.hidden = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.rank < 0 || e.rank > 2 || !e.onScreen || e.place) continue
      const d = districts.get(e.district)
      if (d && d !== e && d.members.length >= DISTRICT_MIN) d.hidden++
    }
    for (const d of districts.values()) {
      if (d.hidden > 0) d.zeroPasses = 0
      else d.zeroPasses++
      // Four passes of grace, so a count flickering across zero cannot take the
      // whole district chip down with it.
      d.collapseOn = d.hidden > 0 || d.zeroPasses < 4
    }

    /* ---- WRITE PHASE ---------------------------------------------------- */
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      const far = e.rank >= 0 && e.rank <= 2 && e.dist > FAR_DIST
      if (far !== e.far) {
        e.far = far
        e.el.classList.toggle('is-far', far)
        if (!far) e.needMeasure = true
      }

      if (e.place && (e.dx !== e.lastDx || e.dy !== e.lastDy)) {
        e.lastDx = e.dx
        e.lastDy = e.dy
        const w = e.far ? e.farW : e.nearW
        const h = e.far ? e.farH : e.nearH
        // The leader runs from the anchor to whichever chip corner is nearest it.
        const cx = e.dx > 0 ? e.dx : e.dx + w < 0 ? e.dx + w : 0
        const cy = e.dy > 0 ? e.dy : e.dy + h < 0 ? e.dy + h : 0
        const st = e.el.style
        st.setProperty('--lbl-dx', `${e.dx.toFixed(1)}px`)
        st.setProperty('--lbl-dy', `${e.dy.toFixed(1)}px`)
        st.setProperty('--lbl-lead', `${Math.sqrt(cx * cx + cy * cy).toFixed(1)}px`)
        st.setProperty('--lbl-lead-a', `${((Math.atan2(cy, cx) * 180) / Math.PI).toFixed(1)}deg`)
        const nudged = e.variant !== 0
        if (nudged !== e.nudged) {
          e.nudged = nudged
          e.el.classList.toggle('is-nudged', nudged)
        }
      }

      const n = e.hidden > 99 ? 99 : e.hidden
      if (n !== e.lastMore) {
        const wasOn = e.lastMore > 0
        const isOn = n > 0
        e.lastMore = n
        e.more.textContent = isOn ? `+${n}` : ''
        if (isOn !== wasOn) e.el.classList.toggle('has-more', isOn)
        // The pill changes the chip's width, so the cached box is now a lie.
        e.needMeasure = true
      }
    }
  }

  /* --------------------------------- frame -------------------------------- */

  function update(dt: number, camera: THREE.PerspectiveCamera, sim: SimState): void {
    if (componentCount !== registry.all().length) {
      sync()
      passT = PASS_SEC
    }
    if (focusT > 0) focusT -= dt

    passT += dt
    if (passT >= PASS_SEC) {
      passT = 0
      pass(camera)
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      if (e.place !== e.shown) {
        e.shown = e.place
        e.shownT = 0
        e.hiddenT = 0
      } else if (e.shown) e.shownT += dt
      else e.hiddenT += dt

      const target = e.shown ? e.alpha : 0
      if (target > 0.01) {
        if (e.phase === 0) {
          // mount this frame, transition next frame — otherwise the element
          // goes from display:none straight to its final style and never fades.
          e.obj.visible = true
          e.phase = 1
          setOpacity(e, 0)
        } else {
          if (e.phase !== 2) {
            e.el.classList.add('is-on')
            e.phase = 2
          }
          setOpacity(e, target)
        }
      } else if (e.phase === 1 || e.phase === 2) {
        e.el.classList.remove('is-on')
        setOpacity(e, 0)
        e.phase = 3
        e.fadeT = FADE_SEC
      } else if (e.phase === 3) {
        e.fadeT -= dt
        if (e.fadeT <= 0) {
          e.obj.visible = false
          e.phase = 0
        }
      }
    }

    readT += dt
    if (readT >= READOUT_SEC) {
      readT = 0
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if (!e.read || e.far || !e.def?.readout) continue
        if (e.phase === 0 && !e.place) continue
        const text = e.def.readout(sim)
        if (text !== e.lastRead) {
          // The readout is tabular, so the same length is the same pixels —
          // only a real width change is worth a re-measure.
          if (text.length !== e.measuredRead) {
            e.measuredRead = text.length
            e.needMeasure = true
          }
          e.lastRead = text
          e.read.textContent = text
        }
      }
    }
  }

  function setOpacity(e: Entry, v: number): void {
    if (Math.abs(v - e.lastOpacity) < 0.012) return
    e.lastOpacity = v
    e.el.style.opacity = v.toFixed(3)
  }

  function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    renderer.render(scene, camera)
  }

  function resize(w: number, h: number): void {
    viewW = w
    viewH = h
    renderer.setSize(w, h)
    passT = PASS_SEC
  }

  function setQuality(q: QualitySettings): void {
    maxLabels = Math.max(4, Math.floor(q.maxLabels))
    passT = PASS_SEC
  }

  function dispose(): void {
    dom.removeEventListener('click', onClick)
    dom.removeEventListener('dblclick', onDblClick)
    dom.removeEventListener('pointerover', onOver)
    dom.removeEventListener('pointerout', onOut)
    offSelect()
    offHover()
    offFocus()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      group.remove(e.obj) // CSS2DObject's 'removed' handler unmounts the element
      e.el.remove()
    }
    entries.length = 0
    cand.length = 0
    pendingMeasure.length = 0
    byId.clear()
    districts.clear()
    measureHost.remove()
    dom.remove()
  }

  return { group, update, render, resize, setQuality, dispose }
}

/* --------------------------------- helpers -------------------------------- */

function byPrio(a: Entry, b: Entry): number {
  return a.prio - b.prio
}

/** 0 below `edge - band`, 1 above `edge`, smooth in between. */
function fadeIn(d: number, edge: number, band: number): number {
  const t = (d - (edge - band)) / band
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)
}

/** 1 below `edge - band`, 0 above `edge`, smooth in between. */
function fadeOut(d: number, edge: number, band: number): number {
  return 1 - fadeIn(d, edge, band)
}

function hexCss(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0')
}
