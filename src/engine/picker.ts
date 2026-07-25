import * as THREE from 'three'

import type { Registry } from '../core/registry'
import type { Bus, ComponentDef, DistrictId, ThemeApi } from '../core/types'
import { clamp } from '../core/util'

/* ============================================================================
 * PICKER — pointing at the city.
 *
 * Two jobs. First, turn pointer events on the canvas into `hover` / `select` /
 * `focus` on the bus: raycast at 25Hz against the registry roots, never while
 * the camera is being dragged, never when the pointer is on the HUD.
 *
 * Second, draw the selection. A wireframe box would look like a debug overlay,
 * so instead each marker is a survey reticle: four corner brackets standing
 * just outside the object's world AABB, a dashed ring on the ground directly
 * beneath it, and a hairline dropping from the box down to that ring — the
 * same notation an architectural model uses to say "this one, here, on this
 * plot". The brackets breathe on a 1.2s cycle and the ring turns slowly; the
 * hover marker is the identical geometry at 35% with no motion, so hovering
 * previews the selection instead of introducing a second visual language.
 * ==========================================================================*/

/** Pointer travel that still counts as a click, in CSS px. */
const CLICK_PX = 5
/** Press-to-release time that still counts as a click, in ms. */
const CLICK_MS = 350
/** Gap between two clicks that makes them a double-click, in ms. */
const DBL_MS = 320
/** Raycast at most this often. */
const PICK_SEC = 1 / 25
/** Objects animate under the cursor — re-measure the selected AABB this often. */
const BOX_SEC = 0.5
/** Bracket breathing period, seconds. */
const BREATH_SEC = 1.2
/** Ground ring turn rate, rad/sec. */
const RING_SPIN = 0.35

/* --- module-scope scratch: nothing in here allocates per frame ------------- */
const _ndc = new THREE.Vector2()
const _box = new THREE.Box3()
const _size = new THREE.Vector3()
const _center = new THREE.Vector3()
const _hits: THREE.Intersection[] = []

interface Marker {
  root: THREE.Group
  brackets: THREE.LineSegments
  pos: Float32Array
  attr: THREE.BufferAttribute
  ring: THREE.LineSegments
  drop: THREE.LineSegments
  mat: THREE.LineBasicMaterial
  /** brightness multiplier applied to the accent colour (bloom threshold) */
  gain: number
}

export interface PickerApi {
  /** selection/hover markers live here */
  group: THREE.Object3D
  update(dt: number): void
  dispose(): void
}

export function createPicker(opts: {
  dom: HTMLElement
  camera: THREE.PerspectiveCamera
  registry: Registry
  bus: Bus
  theme: ThemeApi
}): PickerApi {
  const { dom, camera, registry, bus, theme } = opts

  const group = new THREE.Group()
  group.name = 'picker'

  /** Fallback accent per district; ComponentDef.color wins. */
  const districtColor: Record<DistrictId, number> = {
    clients: theme.color.client,
    backends: theme.color.backend,
    shmem: theme.color.shmem,
    wal: theme.color.wal,
    storage: theme.color.storage,
    maintenance: theme.color.vacuum,
    replication: theme.color.replication,
    planner: theme.color.index,
    world: theme.color.ink,
  }

  const ringGeo = makeRingGeometry()
  const dropGeo = makeDropGeometry()

  const sel = makeMarker(ringGeo, dropGeo, 1, 2.1)
  const hov = makeMarker(ringGeo, dropGeo, 0.35, 1)
  group.add(sel.root, hov.root)

  const raycaster = new THREE.Raycaster()

  let selectedId: string | null = null
  let hoveredId: string | null = null
  let selDef: ComponentDef | undefined
  let hovDef: ComponentDef | undefined

  /* --- pointer bookkeeping ------------------------------------------------ */
  let pointerX = 0
  let pointerY = 0
  let pickDirty = false
  let pickT = 0
  let inside = false

  let downId = -1
  let downX = 0
  let downY = 0
  let downT = 0
  let downPrimary = false
  let dragging = false

  let lastClickT = -1e9
  let lastClickId: string | null = null

  /* --- canvas rect cache (avoids a DOMRect per pick) ---------------------- */
  let rectX = 0
  let rectY = 0
  let rectW = 1
  let rectH = 1
  let rectDirty = true

  function readRect(): void {
    const r = dom.getBoundingClientRect()
    rectX = r.left
    rectY = r.top
    rectW = r.width || 1
    rectH = r.height || 1
    rectDirty = false
  }

  /* --- raycast candidates ------------------------------------------------- */
  let roots: THREE.Object3D[] = []
  let rootCount = -1
  function candidates(): THREE.Object3D[] {
    const n = registry.all().length
    if (n !== rootCount) {
      rootCount = n
      roots = registry.roots()
    }
    return roots
  }

  /** Raycaster ignores `visible`, so LOD'd-out districts must be filtered here. */
  function shown(o: THREE.Object3D | null): boolean {
    let node = o
    let guard = 0
    while (node && guard++ < 64) {
      if (!node.visible) return false
      node = node.parent
    }
    return true
  }

  function pickAt(clientX: number, clientY: number): string | null {
    if (rectDirty) readRect()
    _ndc.set(((clientX - rectX) / rectW) * 2 - 1, -((clientY - rectY) / rectH) * 2 + 1)
    if (_ndc.x < -1 || _ndc.x > 1 || _ndc.y < -1 || _ndc.y > 1) return null
    raycaster.setFromCamera(_ndc, camera)
    _hits.length = 0
    raycaster.intersectObjects(candidates(), true, _hits)
    for (let i = 0; i < _hits.length; i++) {
      const obj = _hits[i].object
      if (!shown(obj)) continue
      const def = registry.resolve(obj)
      if (def) return def.id
    }
    return null
  }

  /* ------------------------------- events -------------------------------- */

  function onPointerDown(ev: PointerEvent): void {
    if (ev.target !== dom) return
    downId = ev.pointerId
    downX = ev.clientX
    downY = ev.clientY
    downT = ev.timeStamp
    downPrimary = ev.button === 0
    dragging = false
  }

  function onPointerMove(ev: PointerEvent): void {
    if (downId === ev.pointerId && !dragging) {
      if (Math.abs(ev.clientX - downX) > CLICK_PX || Math.abs(ev.clientY - downY) > CLICK_PX) {
        dragging = true
        // a drag is a camera move, not a hover — drop the highlight immediately
        setHover(null)
      }
    }
    if (ev.target !== dom) return
    inside = true
    pointerX = ev.clientX
    pointerY = ev.clientY
    pickDirty = true
  }

  function onPointerUp(ev: PointerEvent): void {
    if (ev.pointerId !== downId) return
    const moved = Math.abs(ev.clientX - downX) > CLICK_PX || Math.abs(ev.clientY - downY) > CLICK_PX
    const quick = ev.timeStamp - downT <= CLICK_MS
    const wasPrimary = downPrimary
    downId = -1
    downPrimary = false
    if (dragging || moved || !quick || !wasPrimary) {
      dragging = false
      return
    }

    const id = pickAt(ev.clientX, ev.clientY)
    bus.emit('select', { id })

    const now = ev.timeStamp
    if (id !== null && id === lastClickId && now - lastClickT < DBL_MS) {
      bus.emit('focus', { id })
      lastClickT = -1e9
      lastClickId = null
    } else {
      lastClickT = now
      lastClickId = id
    }
  }

  function onPointerCancel(ev: PointerEvent): void {
    if (ev.pointerId === downId) {
      downId = -1
      dragging = false
    }
  }

  function onPointerLeave(): void {
    inside = false
    pickDirty = false
    setHover(null)
  }

  function setHover(id: string | null): void {
    if (id === hoveredId) return
    bus.emit('hover', { id })
  }

  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerup', onPointerUp)
  dom.addEventListener('pointercancel', onPointerCancel)
  dom.addEventListener('pointerleave', onPointerLeave)
  const onWinResize = () => {
    rectDirty = true
  }
  window.addEventListener('resize', onWinResize)

  /* --- the markers follow the bus, not our own emits, so a selection made by
     the search box or a label chip is drawn the same way ------------------- */

  /** The hover marker never doubles up on the selection marker. */
  function refreshHover(): void {
    hovBoxT = 0
    if (hovDef && hoveredId !== selectedId) {
      applyAccent(hov, accentOf(hovDef))
      applyBox(hov, hovDef)
    } else {
      hov.root.visible = false
    }
  }

  const offSelect = bus.on('select', ({ id }) => {
    if (id === selectedId) return
    selectedId = id
    selDef = id ? registry.get(id) : undefined
    boxT = 0
    if (selDef) {
      applyAccent(sel, accentOf(selDef))
      applyBox(sel, selDef)
    } else {
      sel.root.visible = false
    }
    refreshHover()
  })

  const offHover = bus.on('hover', ({ id }) => {
    if (id === hoveredId) return
    hoveredId = id
    hovDef = id ? registry.get(id) : undefined
    document.body.style.cursor = id ? 'pointer' : ''
    refreshHover()
  })

  function accentOf(def: ComponentDef): number {
    return def.color ?? districtColor[def.district] ?? theme.color.ink
  }

  function applyAccent(m: Marker, hex: number): void {
    m.mat.color.setHex(hex).multiplyScalar(m.gain)
  }

  /**
   * Fit a marker to a component's world AABB. Not cheap (it traverses the whole
   * subtree), which is exactly why it runs on selection change and twice a
   * second, not per frame.
   */
  function applyBox(m: Marker, def: ComponentDef): void {
    _box.makeEmpty()
    _box.setFromObject(def.object)
    if (_box.isEmpty() || !isFinite(_box.min.x) || !isFinite(_box.max.x)) {
      m.root.visible = false
      return
    }
    _box.getSize(_size)
    _box.getCenter(_center)

    const maxDim = Math.max(_size.x, _size.y, _size.z)
    const pad = clamp(maxDim * 0.05, 0.5, 3)
    const hx = _size.x * 0.5 + pad
    const hy = _size.y * 0.5 + pad
    const hz = _size.z * 0.5 + pad

    // bracket arm length: a fixed fraction of the object, never longer than the
    // edge it sits on (flat objects would otherwise sprout arms out the top)
    const a = clamp(maxDim * 0.16, 0.9, 6)
    const ax = Math.min(a, hx * 0.7)
    const ay = Math.min(a, hy * 0.7)
    const az = Math.min(a, hz * 0.7)

    const p = m.pos
    let k = 0
    for (let c = 0; c < 4; c++) {
      const sx = c === 0 || c === 3 ? -1 : 1
      const sz = c < 2 ? -1 : 1
      const x = sx * hx
      const z = sz * hz
      for (let e = 0; e < 2; e++) {
        const y = e === 0 ? -hy : hy
        const yi = e === 0 ? ay : -ay
        // three arms per corner: along X, along Z, and up/down the vertical edge
        p[k++] = x; p[k++] = y; p[k++] = z
        p[k++] = x - sx * ax; p[k++] = y; p[k++] = z
        p[k++] = x; p[k++] = y; p[k++] = z
        p[k++] = x; p[k++] = y; p[k++] = z - sz * az
        p[k++] = x; p[k++] = y; p[k++] = z
        p[k++] = x; p[k++] = y + yi; p[k++] = z
      }
    }
    m.attr.needsUpdate = true
    m.brackets.position.copy(_center)

    // The ground plane is y=0 — except over the excavation, where the thing you
    // selected lives underground; there the ring sits just below its own base.
    const ringY = _box.min.y > -1 ? 0 : _box.min.y - 1.5
    const radius = Math.max(hx, hz) * 1.1 + 1.5
    m.ring.position.set(_center.x, ringY, _center.z)
    m.ring.scale.setScalar(radius)

    m.drop.position.set(_center.x, _box.min.y, _center.z)
    m.drop.scale.set(1, Math.max(_box.min.y - ringY, 0.001), 1)

    m.root.visible = true
  }

  /* -------------------------------- frame -------------------------------- */

  let t = 0
  let boxT = 0
  let hovBoxT = 0

  function update(dt: number): void {
    t += dt

    // throttled hover picking — only after the pointer actually moved
    pickT += dt
    if (pickT >= PICK_SEC) {
      pickT = 0
      if (inside && pickDirty && !dragging && downId === -1) {
        pickDirty = false
        setHover(pickAt(pointerX, pointerY))
      }
    }

    if (selDef) {
      boxT += dt
      if (boxT >= BOX_SEC) {
        boxT = 0
        applyBox(sel, selDef)
      }
      sel.brackets.scale.setScalar(1 + 0.028 * Math.sin((t * Math.PI * 2) / BREATH_SEC))
      sel.ring.rotation.y = t * RING_SPIN
    }

    if (hovDef && hoveredId !== selectedId) {
      hovBoxT += dt
      if (hovBoxT >= BOX_SEC) {
        hovBoxT = 0
        applyBox(hov, hovDef)
      }
    }
  }

  function dispose(): void {
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('pointermove', onPointerMove)
    dom.removeEventListener('pointerup', onPointerUp)
    dom.removeEventListener('pointercancel', onPointerCancel)
    dom.removeEventListener('pointerleave', onPointerLeave)
    window.removeEventListener('resize', onWinResize)
    offSelect()
    offHover()
    document.body.style.cursor = ''
    sel.brackets.geometry.dispose()
    hov.brackets.geometry.dispose()
    sel.mat.dispose()
    hov.mat.dispose()
    ringGeo.dispose()
    dropGeo.dispose()
    group.clear()
    _hits.length = 0
  }

  return { group, update, dispose }
}

/* -------------------------------- geometry -------------------------------- */

/** 4 corners x 2 (bottom, top) x 3 arms x 2 endpoints = 48 vertices. */
const BRACKET_VERTS = 48

function makeMarker(
  ringGeo: THREE.BufferGeometry,
  dropGeo: THREE.BufferGeometry,
  opacity: number,
  gain: number,
): Marker {
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    // A reticle you cannot see through the building it marks is a bug, not a
    // feature: this is chrome, drawn last, over everything.
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  mat.name = `picker:${gain > 1 ? 'select' : 'hover'}`

  const pos = new Float32Array(BRACKET_VERTS * 3)
  const attr = new THREE.BufferAttribute(pos, 3)
  attr.setUsage(THREE.DynamicDrawUsage)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', attr)

  const brackets = new THREE.LineSegments(geo, mat)
  const ring = new THREE.LineSegments(ringGeo, mat)
  const drop = new THREE.LineSegments(dropGeo, mat)

  const root = new THREE.Group()
  root.name = 'marker'
  root.visible = false
  root.add(brackets, ring, drop)
  for (const o of root.children) {
    o.renderOrder = 999
    o.frustumCulled = false
    o.raycast = noRaycast
  }
  root.raycast = noRaycast

  return { root, brackets, pos, attr, ring, drop, mat, gain }
}

function noRaycast(): void {
  /* markers are decoration — never pickable */
}

/**
 * Unit-radius dashed ring in the XZ plane. Every sixth dash is long, which
 * gives the ring a readable rotation instead of a shimmering dotted circle.
 */
function makeRingGeometry(): THREE.BufferGeometry {
  const DASHES = 24
  const STEPS = 3
  const span = (Math.PI * 2) / DASHES
  const verts = new Float32Array(DASHES * STEPS * 2 * 3)
  let k = 0
  for (let d = 0; d < DASHES; d++) {
    const run = span * (d % 6 === 0 ? 0.92 : 0.5)
    const a0 = d * span
    for (let s = 0; s < STEPS; s++) {
      const t0 = a0 + (run * s) / STEPS
      const t1 = a0 + (run * (s + 1)) / STEPS
      verts[k++] = Math.cos(t0)
      verts[k++] = 0
      verts[k++] = Math.sin(t0)
      verts[k++] = Math.cos(t1)
      verts[k++] = 0
      verts[k++] = Math.sin(t1)
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  return geo
}

/** Unit hairline pointing straight down; scaled to reach the ground ring. */
function makeDropGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, -1, 0]), 3))
  return geo
}
