import * as THREE from 'three'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

import '../styles/labels.css'
import { COLOR } from '../core/theme'
import type { Registry } from '../core/registry'
import type { Bus, ComponentDef, DistrictId, QualitySettings, SimState } from '../core/types'

/* ============================================================================
 * LABELS — the annotation layer.
 *
 * Every registered component owns one DOM chip, created once and then never
 * rebuilt: the whole layer is driven by toggling three classes and writing at
 * most `maxLabels` strings per second.
 *
 * The interesting part is the visibility budget. A city with ~80 named parts
 * would be an unreadable wall of text if we simply projected all of them, so
 * every eighth of a second we score the set —
 *
 *   tier 0 (districts)  always eligible
 *   tier 1 (landmarks)  eligible within 420 units
 *   tier 2 (details)    eligible within 140 units
 *   anything outside the view frustum is rejected outright
 *   the selected and hovered components always win
 *
 * — sort by (tier, distance) and light up the top N. Beyond FAR_DIST a chip
 * degrades to a bare name plate. The result reads like an architectural
 * drawing: the closer you get, the more the model annotates itself.
 * ==========================================================================*/

/** Max camera distance at which a tier is allowed to show at all. */
const TIER_RANGE = [Infinity, 420, 140]
/** Past this distance the chip drops its role line and readout. */
const FAR_DIST = 250
/** Re-score the whole set 8x/sec — invisible to the eye, cheap on the CPU. */
const RESORT_SEC = 1 / 8
/** Readouts tick at 6Hz; faster just makes numbers unreadable. */
const READOUT_SEC = 1 / 6
/** Frustum slack, world units — stops chips popping exactly on the screen edge. */
const FRUSTUM_MARGIN = 14
/** Must match the CSS transition on .lbl. */
const FADE_SEC = 0.2

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

/* --- module-scope scratch: update() must not allocate --------------------- */
const _proj = new THREE.Matrix4()
const _frustum = new THREE.Frustum()

/** 0 = off, 1 = armed (mounted, not yet transitioned), 2 = on, 3 = fading out. */
type LabelPhase = 0 | 1 | 2 | 3

interface Entry {
  def: ComponentDef
  obj: CSS2DObject
  el: HTMLDivElement
  read: HTMLElement | null
  pos: THREE.Vector3
  /** scored 8x/sec */
  wanted: boolean
  rank: number
  dist: number
  far: boolean
  phase: LabelPhase
  fadeT: number
  lastRead: string
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
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight)

  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  /** Reused between scoring passes; never re-allocated. */
  const cand: Entry[] = []

  let maxLabels = 26
  let selectedId: string | null = null
  let hoveredId: string | null = null
  /** Which chip the pointer is physically over, so we only emit on change. */
  let domHoverId: string | null = null
  let sortT = RESORT_SEC
  let readT = 0

  /* --------------------------------- DOM --------------------------------- */

  function makeEntry(def: ComponentDef): Entry {
    const el = document.createElement('div')
    el.className = 'lbl'
    el.dataset.id = def.id
    el.style.setProperty('--lbl-accent', hexCss(def.color ?? DISTRICT_COLOR[def.district] ?? COLOR.ink))

    const chip = document.createElement('div')
    chip.className = 'lbl__chip'

    const name = document.createElement('span')
    name.className = 'lbl__name'
    name.textContent = def.name
    chip.appendChild(name)

    if (def.role) {
      const role = document.createElement('span')
      role.className = 'lbl__role'
      role.textContent = def.role
      chip.appendChild(role)
    }

    let read: HTMLElement | null = null
    if (def.readout) {
      read = document.createElement('span')
      read.className = 'lbl__read'
      chip.appendChild(read)
    }

    const leader = document.createElement('span')
    leader.className = 'lbl__leader'
    const dot = document.createElement('span')
    dot.className = 'lbl__dot'

    el.appendChild(chip)
    el.appendChild(leader)
    el.appendChild(dot)

    const obj = new CSS2DObject(el)
    // (0,1) = the element's bottom-left corner sits on the anchor point, so the
    // chip floats up and to the right of what it names.
    obj.center.set(0, 1)
    const at = def.labelAt ?? def.focus.target
    obj.position.set(at[0], at[1], at[2])
    obj.visible = false
    group.add(obj)

    const e: Entry = {
      def,
      obj,
      el,
      read,
      pos: new THREE.Vector3(at[0], at[1], at[2]),
      wanted: false,
      rank: def.tier,
      dist: 0,
      far: false,
      phase: 0,
      fadeT: 0,
      lastRead: '',
    }
    if (def.id === selectedId) el.classList.add('is-selected')
    if (def.id === hoveredId) el.classList.add('is-hovered')
    return e
  }

  /** Pick up components registered since the last frame. */
  function sync(): void {
    const all = registry.all()
    for (let i = 0; i < all.length; i++) {
      const def = all[i]
      if (byId.has(def.id)) continue
      const e = makeEntry(def)
      byId.set(def.id, e)
      entries.push(e)
    }
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
    sortT = RESORT_SEC // the selection must show even if it was budgeted out
  })

  const offHover = bus.on('hover', ({ id }) => {
    if (id === hoveredId) return
    byId.get(hoveredId ?? '')?.el.classList.remove('is-hovered')
    hoveredId = id
    byId.get(id ?? '')?.el.classList.add('is-hovered')
    sortT = RESORT_SEC
  })

  /* -------------------------------- scoring ------------------------------- */

  function inFrustum(p: THREE.Vector3): boolean {
    const planes = _frustum.planes
    for (let i = 0; i < 6; i++) {
      if (planes[i].distanceToPoint(p) < -FRUSTUM_MARGIN) return false
    }
    return true
  }

  function rescore(camera: THREE.PerspectiveCamera): void {
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    _frustum.setFromProjectionMatrix(_proj)

    cand.length = 0
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      e.wanted = false
      const d = camera.position.distanceTo(e.pos)
      e.dist = d

      const far = d > FAR_DIST
      if (far !== e.far) {
        e.far = far
        e.el.classList.toggle('is-far', far)
      }

      if (!e.def.object.visible) continue
      const forced = e.def.id === selectedId || e.def.id === hoveredId
      if (!forced && d > TIER_RANGE[e.def.tier]) continue
      // rejects everything behind the camera as a side effect of the near plane
      if (!inFrustum(e.pos)) continue

      e.rank = forced ? -1 : e.def.tier
      cand.push(e)
    }

    cand.sort(byRank)
    const n = cand.length < maxLabels ? cand.length : maxLabels
    for (let i = 0; i < n; i++) cand[i].wanted = true
  }

  /* --------------------------------- frame -------------------------------- */

  function update(dt: number, camera: THREE.PerspectiveCamera, sim: SimState): void {
    if (entries.length !== registry.all().length) {
      sync()
      sortT = RESORT_SEC
    }

    sortT += dt
    if (sortT >= RESORT_SEC) {
      sortT = 0
      rescore(camera)
    }

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.wanted) {
        if (e.phase === 0) {
          // mount this frame, transition next frame — otherwise the element
          // goes from display:none straight to its final style and never fades.
          e.obj.visible = true
          e.phase = 1
        } else if (e.phase !== 2) {
          e.el.classList.add('is-on')
          e.phase = 2
        }
      } else if (e.phase === 1 || e.phase === 2) {
        e.el.classList.remove('is-on')
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
        if (e.phase === 0 || e.far || !e.read || !e.def.readout) continue
        const text = e.def.readout(sim)
        if (text !== e.lastRead) {
          e.lastRead = text
          e.read.textContent = text
        }
      }
    }
  }

  function render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    renderer.render(scene, camera)
  }

  function resize(w: number, h: number): void {
    renderer.setSize(w, h)
  }

  function setQuality(q: QualitySettings): void {
    maxLabels = Math.max(4, Math.floor(q.maxLabels))
    sortT = RESORT_SEC
  }

  function dispose(): void {
    dom.removeEventListener('click', onClick)
    dom.removeEventListener('dblclick', onDblClick)
    dom.removeEventListener('pointerover', onOver)
    dom.removeEventListener('pointerout', onOut)
    offSelect()
    offHover()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      group.remove(e.obj) // CSS2DObject's 'removed' handler unmounts the element
      e.el.remove()
    }
    entries.length = 0
    cand.length = 0
    byId.clear()
    dom.remove()
  }

  return { group, update, render, resize, setQuality, dispose }
}

/* --------------------------------- helpers -------------------------------- */

function byRank(a: Entry, b: Entry): number {
  return a.rank !== b.rank ? a.rank - b.rank : a.dist - b.dist
}

function hexCss(c: number): string {
  return '#' + (c >>> 0).toString(16).padStart(6, '0')
}
