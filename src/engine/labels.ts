import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

import '../styles/labels.css'
import { destinationForDistrict } from '../core/destinations'
import { COLOR } from '../core/theme'
import type { Registry } from '../core/registry'
import type {
  Bus,
  CameraMode,
  ComponentDef,
  DistrictId,
  QualitySettings,
  SimState,
} from '../core/types'
import type { CollisionWorld } from './collision'
import {
  EXPANDED_LABEL_CAP,
  LabelDetail,
  detailExpansionPriority,
  requestedLabelDetail,
} from './label-detail'
import {
  WALK_LABEL_CAP,
  WALK_LABEL_SCALE,
  labelAreaPlacementBudget,
  labelScale,
  mapLabelPriority,
  walkLabelPriority,
} from './label-layout'

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
/** Below this much of its level's fade, a label is not worth the space. */
const MIN_VIS = 0.12
/** …and above 1/VIS_GAIN of it, it is drawn at full strength. A cross-fade you
 *  cannot read is just clutter, so the ramp is steep and the 200ms CSS fade on
 *  enter and exit does most of the smoothing. */
const VIS_GAIN = 2.2

/* --- priority bands, lowest wins ------------------------------------------ */
const B_SELECTED = 0
const B_HOVERED = 1
const B_FOCUS = 2
const B_MAP = 3
const B_TIER = [5, 7, 8]
/** A district chip on screen only to carry its "+N". */
const B_COLLAPSE = 6
/** Bands sit this far apart; distance (< ~2000) is the within-band tiebreak. */
const BAND_STEP = 100000
/** A shown label beats a hidden one of the same band — but never crosses a band. */
const STICKY = 40000
/** Walking changes identity as the visitor turns, so map-grade stickiness is too strong. */
const WALK_STICKY = 1200

/* --- timing --------------------------------------------------------------- */
/** Full placement pass ~9x/sec. Faster is invisible to the eye and costs a layout. */
const PASS_SEC = 1 / 9
/** Readouts tick at 6Hz; faster just makes numbers unreadable. */
const READOUT_SEC = 1 / 6
/** Must match the opacity transition on .lbl. */
const FADE_SEC = 0.22
/**
 * A label cannot be collided away inside this long of appearing, nor come back
 * inside HIDE_COOLDOWN of being dropped. Both are measured against the wall
 * clock, not the frame delta: main.ts clamps dt to 0.1s so a stalled frame
 * cannot teleport the city, and accumulating that would stretch a 0.7s pin into
 * seven real seconds on a slow machine — long enough for pinned labels to sit
 * visibly on top of each other.
 */
const MIN_DWELL = 0.7
const HIDE_COOLDOWN = 0.3
/** How long a tour/scenario focus keeps its priority boost. */
const FOCUS_TTL = 30
/** Static-box visibility checks per frame. Three clears all object labels in
 * roughly a third of a second even at this scene's 1–3 fps floor. */
export const LABEL_OCCLUSION_BUDGET = 3

/* --- placement geometry, pixels ------------------------------------------- */
const GAP_X = 16
const GAP_Y = 16
/** A hidden label needs this much clear space around it to be placed… */
const PAD_NEW = 8
/** …a shown one tolerates this much real overlap before it is dropped. */
const PAD_KEEP = -3
/** What a label that MUST be placed will squeeze into as a last resort. */
const PAD_CRAMP = -14
/** Keep chips this far off the viewport edge. */
const EDGE = 6
/**
 * Candidate offsets, tried in this order: home, other side, lifted, centred,
 * below, lifted further. 0 = centred over the anchor, which is the only thing
 * that will seat a wide chip whose anchor sits mid-screen — there is room for
 * it neither fully left nor fully right, and dropping it is much worse than
 * hanging it overhead on a vertical leader.
 */
const VAR_SIDE = [1, -1, 1, -1, 0, 1, -1, 0, 1, -1]
const VAR_UP = [1, 1, 1, 1, 1, -1, -1, 1, 1, 1]
const VAR_LIFT = [0, 0, 30, 30, 0, 0, 0, 34, 62, 62]
const N_VAR = 10

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
  clients: destinationForDistrict('clients')?.name ?? '',
  backends: destinationForDistrict('backends')?.name ?? '',
  shmem: destinationForDistrict('shmem')?.name ?? '',
  wal: destinationForDistrict('wal')?.name ?? '',
  storage: destinationForDistrict('storage')?.name ?? '',
  maintenance: destinationForDistrict('maintenance')?.name ?? '',
  replication: destinationForDistrict('replication')?.name ?? '',
  planner: destinationForDistrict('planner')?.name ?? '',
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

  /* measured chip box at each content tier */
  nameW: number
  nameH: number
  readoutW: number
  readoutH: number
  roleW: number
  roleH: number
  needMeasure: boolean
  measuredRead: number

  /* per pass */
  dist: number
  onScreen: boolean
  sx: number
  sy: number
  band: number
  prio: number
  detailPrio: number
  requestedDetail: LabelDetail
  nextDetail: LabelDetail
  alpha: number
  scale: number
  place: boolean
  /** Cached camera-to-anchor visibility, refreshed round-robin. */
  occluded: boolean

  /* sticky state — wall-clock seconds, see MIN_DWELL */
  shown: boolean
  sinceT: number
  variant: number
  dx: number
  dy: number

  /* collapse bookkeeping, district chips and proxies only */
  hidden: number
  zeroPasses: number
  collapseOn: boolean

  /* DOM write cache */
  detail: LabelDetail
  phase: LabelPhase
  fadeT: number
  lastRead: string
  lastOpacity: number
  lastScale: number
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

export function createLabels(
  container: HTMLElement,
  registry: Registry,
  bus: Bus,
  collision: Pick<CollisionWorld, 'occluded'>,
): LabelsApi {
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
  const expandedCand: Entry[] = []
  const pendingMeasure: Entry[] = []
  let componentCount = 0

  let maxLabels = 26
  let selectedId: string | null = null
  let hoveredId: string | null = null
  let focusId: string | null = null
  /** Wall-clock second the focus boost expires at. */
  let focusUntil = 0
  /** Wall clock, seconds, sampled once per frame. */
  let now = performance.now() / 1000
  /** Which chip the pointer is physically over, so we only emit on change. */
  let domHoverId: string | null = null
  let passT = PASS_SEC
  let readT = 0
  let occlusionCursor = 0
  let cameraMode: CameraMode = 'orbit'

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
      nameW: 90,
      nameH: 20,
      readoutW: 120,
      readoutH: 34,
      roleW: 120,
      roleH: 48,
      needMeasure: false,
      measuredRead: READ_FILLER.length,
      dist: 0,
      onScreen: false,
      sx: 0,
      sy: 0,
      band: B_TIER[2],
      prio: 0,
      detailPrio: 0,
      requestedDetail: LabelDetail.Name,
      nextDetail: LabelDetail.Name,
      alpha: 0,
      scale: 1,
      place: false,
      occluded: false,
      shown: false,
      sinceT: -1e6,
      variant: 0,
      dx: GAP_X,
      dy: -GAP_Y - 34,
      hidden: 0,
      zeroPasses: 99,
      collapseOn: false,
      detail: LabelDetail.Role,
      phase: 0,
      fadeT: 0,
      lastRead: '',
      lastOpacity: -1,
      lastScale: NaN,
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
   * Size every new chip at all three content tiers before it can be placed.
   * The batch shares each layout, and static text is never measured again.
   */
  function measureBatch(): void {
    const n = pendingMeasure.length
    if (!n) return
    for (let i = 0; i < n; i++) measureHost.appendChild(pendingMeasure[i].el)
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.roleW = e.chip.offsetWidth
      e.roleH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) pendingMeasure[i].el.classList.add('is-readout-only')
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.readoutW = e.chip.offsetWidth
      e.readoutH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.el.classList.remove('is-readout-only')
      e.el.classList.add('is-name-only')
    }
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.nameW = e.chip.offsetWidth
      e.nameH = e.chip.offsetHeight
    }
    for (let i = 0; i < n; i++) {
      const e = pendingMeasure[i]
      e.detail = LabelDetail.Name
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
      chip.el.dataset.destination = id
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
    focusUntil = id ? performance.now() / 1000 + FOCUS_TTL : 0
    passT = PASS_SEC
  })

  const offCameraMode = bus.on('camera:mode', ({ mode }) => {
    if (cameraMode === mode) return
    cameraMode = mode
    passT = PASS_SEC
  })

  /* ------------------------- HUD-aware placement box ---------------------- */

  const hudTop = document.getElementById('hud-top')
  const hudBottom = document.getElementById('hud-bottom')
  const hudLeft = document.getElementById('hud-left')
  const hudRight = document.getElementById('hud-right')
  const hudCompass = document.getElementById('compass')
  const hudToasts = document.getElementById('toast-stack')
  /** Constructed after labels.ts; resolved once when the tour module mounts. */
  let hudFirstRun: HTMLElement | null = null
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
    const side = VAR_SIDE[v]
    vx = side > 0 ? e.sx + GAP_X : side < 0 ? e.sx - GAP_X - w : e.sx - w * 0.5
    vy = VAR_UP[v] > 0 ? e.sy - GAP_Y - h - VAR_LIFT[v] : e.sy + GAP_Y + VAR_LIFT[v]
  }

  function fits(e: Entry, v: number, w: number, h: number, pad: number): boolean {
    variantAt(e, v, w, h)
    if (vx - pad < boxL || vx + w + pad > boxR || vy - pad < boxT || vy + h + pad > boxB) return false
    return !hits(vx - pad, vy - pad, w + pad * 2, h + pad * 2)
  }

  /**
   * Destination chips must remain readable even when their anchor is under a
   * side panel or the minimap. Search the usable screen on a coarse grid and
   * take the nearest clear slot. This is a last resort for at most eight map
   * labels, not the object-label hot path.
   */
  function placeDestinationFallback(e: Entry, w: number, h: number): void {
    let bestX = Math.max(boxL, Math.min(boxR - w, vx))
    let bestY = Math.max(boxT, Math.min(boxB - h, vy))
    let bestD = Infinity
    const step = 12
    const maxX = Math.max(boxL, boxR - w)
    const maxY = Math.max(boxT, boxB - h)

    for (let y = boxT; y <= maxY; y += step) {
      for (let x = boxL; x <= maxX; x += step) {
        if (hits(x - 3, y - 3, w + 6, h + 6)) continue
        const dx = x + w * 0.5 - e.sx
        const dy = y + h * 0.5 - e.sy
        const d = dx * dx + dy * dy
        if (d >= bestD) continue
        bestD = d
        bestX = x
        bestY = y
      }
    }
    vx = bestX
    vy = bestY
  }

  function reserveHudRect(node: HTMLElement | null): void {
    if (!node) return
    const r = node.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    addRect(r.left - 6, r.top - 6, r.width + 12, r.height + 12)
  }

  function isDestination(e: Entry): boolean {
    return e.rank === 3 || e.proxy
  }

  function pass(camera: THREE.PerspectiveCamera): void {
    const walking = cameraMode === 'walk'
    /* ---- READ PHASE — nothing below here may touch the DOM ------------- */
    readBox()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (!e.needMeasure || e.phase === 0) continue
      const w = e.chip.offsetWidth
      if (w > 0) {
        const h = e.chip.offsetHeight
        if (e.detail === LabelDetail.Name) {
          e.nameW = w
          e.nameH = h
        } else if (e.detail === LabelDetail.Readout) {
          e.readoutW = w
          e.readoutH = h
        } else {
          e.roleW = w
          e.roleH = h
        }
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
      e.nextDetail = LabelDetail.Name
      e.dist = camera.position.distanceTo(e.pos)
      if (walking && (e.rank < 0 || e.rank > 2 || e.proxy)) continue
      e.scale = walking
        ? WALK_LABEL_SCALE
        : labelScale(
            e.dist,
            e.rank < 0 || isDestination(e) ? 'map' : 'component',
            viewW,
          )

      if (e.rank === 3) {
        // A destination still exists when its presentation is dormant. The
        // Query lab deliberately dissolves between statements, for example,
        // but its map identity and navigation target must not disappear too.
        if (e.members.length < DISTRICT_MIN) continue
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
      // Destination labels may pull an on-screen anchor out from under HUD
      // chrome. Object labels do not: there is no value in a leader pointing
      // behind an inspector to a building the visitor cannot see.
      if (isDestination(e)) {
        if (sx < EDGE || sx > viewW - EDGE || sy < EDGE || sy > viewH - EDGE) continue
      } else if (sx < boxL - 90 || sx > boxR + 90 || sy < boxT - 90 || sy > boxB + 90) {
        continue
      }
      e.sx = sx
      e.sy = sy
      e.onScreen = true

      // A scale of zero means the distance response crossed the 11 px legibility
      // threshold. Keep onScreen true so a readable district chip can collapse
      // this retired component into its "+N" count.
      if (e.scale === 0) continue

      // City and district chips are map annotations. Promoted component chips
      // speak for their whole district too, so they follow the same rule:
      // buildings occlude object labels, never the map hierarchy.
      if (e.occluded && e.rank >= 0 && e.rank <= 2 && !e.proxy) continue

      const forced = e.id === selectedId || e.id === hoveredId
      const focused = !forced && now < focusUntil && e.id === focusId
      const centreX = sx - hw
      const centreY = sy - hh
      if (walking) {
        const walkPrio = walkLabelPriority(
          e.rank,
          e.proxy,
          e.dist,
          centreX * centreX + centreY * centreY,
        )
        if (walkPrio === null) continue
        e.band = forced ? (e.id === selectedId ? B_SELECTED : B_HOVERED) : focused ? B_FOCUS : B_TIER[0]
        e.alpha = 1
        e.prio =
          walkPrio
          - (e.shown ? WALK_STICKY : 0)
          - (forced ? BAND_STEP * 2 : focused ? BAND_STEP : 0)
        cand.push(e)
        continue
      }
      let band: number
      let vis: number

      if (e.rank === 3) {
        const a = fadeIn(e.dist, DISTRICT_IN, DISTRICT_BAND)
        if (a > MIN_VIS) {
          band = B_MAP + mapLabelPriority('district', viewW)
          vis = e.collapseOn ? 1 : a
        } else if (e.collapseOn) {
          band = B_COLLAPSE
          vis = 1
        } else continue
      } else if (e.rank < 0) {
        vis = fadeIn(e.dist, CITY_IN, CITY_BAND)
        band = B_MAP + mapLabelPriority('city', viewW)
        if (vis <= MIN_VIS && !forced && !focused) continue
      } else {
        const tier = fadeOut(e.dist, TIER_OUT[e.rank], TIER_BAND[e.rank])
        if (e.proxy) {
          // A promoted member has to survive out to district range, where it is
          // the only thing naming this part of the city.
          const a = fadeIn(e.dist, DISTRICT_IN, DISTRICT_BAND)
          vis = a > tier ? a : tier
          band = B_MAP + mapLabelPriority('district', viewW)
        } else {
          vis = tier
          band = B_TIER[e.rank]
        }
        if (vis <= MIN_VIS && !forced && !focused) continue
      }

      if (forced) {
        band = e.id === selectedId ? B_SELECTED : B_HOVERED
        vis = 1
      } else if (focused) {
        band = B_FOCUS
        vis = 1
      }

      e.band = band
      e.alpha = vis * VIS_GAIN > 1 ? 1 : vis * VIS_GAIN
      e.prio = band * BAND_STEP + (e.dist < 60000 ? e.dist : 60000) - (e.shown ? STICKY : 0)
      cand.push(e)
    }

    cand.sort(byPrio)

    /* Expanded content has its own budget. Selection and hover are attention;
       without either, screen-centre proximity decides which near labels earn a
       readout. The placement budget still decides whether the chip is shown. */
    expandedCand.length = 0
    if (!walking) {
      for (let i = 0; i < cand.length; i++) {
        const e = cand[i]
        if (e.rank < 0 || e.rank > 2) continue
        const selected = e.id === selectedId
        const hovered = e.id === hoveredId
        const detail = requestedLabelDetail(e.dist, e.read !== null, selected, hovered)
        if (detail === LabelDetail.Name) continue
        const dx = e.sx - hw
        const dy = e.sy - hh
        e.requestedDetail = detail
        e.detailPrio = detailExpansionPriority(selected, hovered, dx * dx + dy * dy)
        expandedCand.push(e)
      }
    }
    expandedCand.sort(byDetailPrio)
    const expandedN =
      expandedCand.length < EXPANDED_LABEL_CAP ? expandedCand.length : EXPANDED_LABEL_CAP
    for (let i = 0; i < expandedN; i++) {
      const e = expandedCand[i]
      e.nextDetail = e.requestedDetail
    }

    /* ---- place ---------------------------------------------------------- */
    ensureGrid()
    gridReset()
    reserveHudRect(hudCompass)
    reserveHudRect(hudToasts)
    if (!hudFirstRun) hudFirstRun = document.querySelector('.tour-first')
    reserveHudRect(hudFirstRun)
    let budget = walking ? Math.min(maxLabels, WALK_LABEL_CAP) : maxLabels
    let areaLeft = viewW * viewH * labelAreaPlacementBudget(viewW)

    for (let i = 0; i < cand.length; i++) {
      const e = cand[i]
      let w = detailWidth(e, e.nextDetail) * e.scale
      let h = detailHeight(e, e.nextDetail) * e.scale
      let area = w * h
      // Attention requests the complete role, but the frame guarantee wins. A
      // name can still identify the selected object when its prose will not fit.
      if (area > areaLeft && e.nextDetail !== LabelDetail.Name) {
        e.nextDetail = LabelDetail.Name
        w = e.nameW * e.scale
        h = e.nameH * e.scale
        area = w * h
      }
      const withinArea = area <= areaLeft
      // Selected and hovered are placed first and are never collided away;
      // anything inside its dwell is held down so nothing can blink.
      const age = now - e.sinceT
      // Destination identities retain placement priority, but the area cap may
      // remove them: keeping all eight is precisely what overwhelms a phone.
      const pinned = isDestination(e) || e.band <= B_HOVERED || (e.shown && age < MIN_DWELL)
      const cooling = !e.shown && age < HIDE_COOLDOWN && e.band > B_FOCUS
      const pad = e.shown ? PAD_KEEP : PAD_NEW
      let v = -1
      let forcedDestination = false

      if (withinArea && (budget > 0 || pinned) && (!cooling || pinned)) {
        // Preserve the last successful slot whenever it remains valid.
        // Trying "home" first defeated the placer’s own hysteresis: two labels
        // could repeatedly reclaim one another's pixels at a fixed camera.
        if (e.shown && fits(e, e.variant, w, h, pad)) v = e.variant
        else if (fits(e, 0, w, h, pad)) v = 0
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
      // A pinned label that fits the area budget has to go down somewhere — it
      // is the selection, or too young to drop without strobing. Take the
      // least-bad slot, then fall back to wherever it was.
      if (v < 0 && pinned && withinArea) {
        for (let k = 0; k < N_VAR; k++) {
          if (fits(e, k, w, h, PAD_CRAMP)) {
            v = k
            break
          }
        }
        if (v < 0) {
          v = e.variant
          forcedDestination = isDestination(e)
        }
      }

      if (v < 0) continue
      variantAt(e, v, w, h)
      if (forcedDestination) placeDestinationFallback(e, w, h)
      e.variant = v
      e.dx = vx - e.sx
      e.dy = vy - e.sy
      e.place = true
      budget--
      areaLeft -= area
      addRect(vx, vy, w, h)
    }

    /* ---- collapse counts ------------------------------------------------ */
    if (!walking) {
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
    }

    /* ---- WRITE PHASE ---------------------------------------------------- */
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      if (e.nextDetail !== e.detail) {
        e.detail = e.nextDetail
        e.el.classList.toggle('is-name-only', e.detail === LabelDetail.Name)
        e.el.classList.toggle('is-readout-only', e.detail === LabelDetail.Readout)
        // This tier may have been sized before its live text or "+N" changed.
        e.needMeasure = true
      }

      if (
        e.place &&
        (e.dx !== e.lastDx || e.dy !== e.lastDy || e.scale !== e.lastScale)
      ) {
        e.lastDx = e.dx
        e.lastDy = e.dy
        e.lastScale = e.scale
        const w = detailWidth(e, e.detail) * e.scale
        const h = detailHeight(e, e.detail) * e.scale
        // The leader runs from the anchor to whichever chip corner is nearest it.
        const cx = e.dx > 0 ? e.dx : e.dx + w < 0 ? e.dx + w : 0
        const cy = e.dy > 0 ? e.dy : e.dy + h < 0 ? e.dy + h : 0
        const st = e.el.style
        st.setProperty('--lbl-scale', e.scale.toFixed(3))
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
    now = performance.now() / 1000
    if (componentCount !== registry.all().length) {
      sync()
      passT = PASS_SEC
    }
    passT += dt
    if (passT >= PASS_SEC) {
      passT = 0
      pass(camera)
    }

    let checked = 0
    let scanned = 0
    while (checked < LABEL_OCCLUSION_BUDGET && scanned < entries.length) {
      if (occlusionCursor >= entries.length) occlusionCursor = 0
      const e = entries[occlusionCursor++]
      scanned++
      if (!e.onScreen || e.rank < 0 || e.rank > 2 || e.proxy) continue
      e.occluded = isLabelAnchorOccluded(collision, camera.position, e.pos)
      checked++
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]

      if (e.place !== e.shown) {
        e.shown = e.place
        e.sinceT = now
      }

      const target = e.shown && !e.occluded ? e.alpha : 0
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
        if (!e.read || e.detail === LabelDetail.Name || !e.def?.readout) continue
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
    const widthChanged = w !== viewW
    viewW = w
    viewH = h
    renderer.setSize(w, h)
    if (widthChanged) {
      // The phone tier wraps names against vw, invalidating every cached box.
      for (let i = 0; i < entries.length; i++) entries[i].needMeasure = true
    }
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
    offCameraMode()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      group.remove(e.obj) // CSS2DObject's 'removed' handler unmounts the element
      e.el.remove()
    }
    entries.length = 0
    cand.length = 0
    expandedCand.length = 0
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

function byDetailPrio(a: Entry, b: Entry): number {
  return a.detailPrio - b.detailPrio
}

function detailWidth(e: Entry, detail: LabelDetail): number {
  if (detail === LabelDetail.Name) return e.nameW
  return detail === LabelDetail.Readout ? e.readoutW : e.roleW
}

function detailHeight(e: Entry, detail: LabelDetail): number {
  if (detail === LabelDetail.Name) return e.nameH
  return detail === LabelDetail.Readout ? e.readoutH : e.roleH
}

export function isLabelAnchorOccluded(
  collision: Pick<CollisionWorld, 'occluded'>,
  camera: THREE.Vector3,
  anchor: THREE.Vector3,
): boolean {
  return collision.occluded(camera, anchor)
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
