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
 * Second, draw the selection. A wireframe box looks like a debug overlay and a
 * set of corner brackets looks like a sight, so the marker is neither: it is
 * the drawing an architect would hand you for this one building. A setting-out
 * circle on the ground, the footprint squared off inside it, the crown of the
 * massing repeated at roof level, two staffs tying the two together, and a
 * dimension line on each of the two exposed sides. Under all of it, a soft
 * band of light on the plot — the same lit-kerb language the district plinths
 * already speak, which is what makes the selection read from 400 m away.
 *
 * Nothing about the marker moves. The only animation anywhere is a slow rise
 * and fall in the ground light's brightness, at the rate a lamp warms.
 *
 * Hover is the identical drawing at a third of the intensity, so hovering
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
/** Ground-light breathing period, seconds. */
const LAMP_SEC = 3.2

/* --- module-scope scratch: nothing in here allocates per frame ------------- */
const _ndc = new THREE.Vector2()
const _box = new THREE.Box3()
const _sub = new THREE.Box3()
const _size = new THREE.Vector3()
const _center = new THREE.Vector3()
const _hits: THREE.Intersection[] = []

/* Line-writing cursor, hoisted so `applyBox` allocates nothing at all. */
let _pen: Float32Array | null = null
let _penK = 0
function seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
  const p = _pen!
  p[_penK++] = ax; p[_penK++] = ay; p[_penK++] = az
  p[_penK++] = bx; p[_penK++] = by; p[_penK++] = bz
}

/* ---------------------------------------------------------------------------
 * Measuring a component, safely.
 *
 * A registry root's world AABB is very often a lie. Districts park unused
 * instanced-mesh instances far below the world so they cannot be seen — the
 * postmaster's box runs y = -1000 to 47, the WAL vault's starts at y = -9000 —
 * and a marker sized from those is a kilometre tall. engine/collision.ts hit
 * exactly this problem for the walk controller and solved it by refusing to
 * accept an impossible box: it splits into the object's children and looks at
 * those instead. The same three verdicts are used here, and the boxes that
 * survive are unioned back into the one box the marker gets drawn from.
 * -------------------------------------------------------------------------*/

/** Taller than this and it is a parking artefact. The city plate + pit is 126. */
const MAX_H = 170
/** Wider than this in X or Z and it is not one object either. */
const MAX_SPAN = 3200
/** Boxes entirely outside this band are off the map. The pit floor is -60. */
const Y_FLOOR = -260
const Y_CEIL = 260
/** How deep to recurse into an impossible container. */
const MAX_DEPTH = 4

/** 0 drop, 1 accept, 2 split. */
function verdict(b: THREE.Box3): 0 | 1 | 2 {
  const sx = b.max.x - b.min.x
  const sy = b.max.y - b.min.y
  const sz = b.max.z - b.min.z
  if (!isFinite(sx) || !isFinite(sy) || !isFinite(sz)) return 0
  if (b.max.y <= Y_FLOOR || b.min.y >= Y_CEIL) return 0
  if (sy > MAX_H || sx > MAX_SPAN || sz > MAX_SPAN) return 2
  return 1
}

/** Union every believable box in `obj`'s subtree into `out`. */
function gather(obj: THREE.Object3D, depth: number, out: THREE.Box3): void {
  _sub.makeEmpty()
  _sub.setFromObject(obj)
  if (_sub.isEmpty()) return
  const v = verdict(_sub)
  if (v === 1) {
    out.union(_sub)
    return
  }
  if (v === 2 && depth < MAX_DEPTH) {
    const kids = obj.children
    for (let i = 0; i < kids.length; i++) gather(kids[i], depth + 1, out)
  }
}

/** Last resort: keep the top of the box and a sane footprint around it. */
function clampBox(b: THREE.Box3): void {
  if (b.max.y - b.min.y > MAX_H) b.min.y = b.max.y - MAX_H
  const cx = (b.min.x + b.max.x) / 2
  const cz = (b.min.z + b.max.z) / 2
  const half = MAX_SPAN / 2
  if (b.max.x - b.min.x > MAX_SPAN) {
    b.min.x = cx - half
    b.max.x = cx + half
  }
  if (b.max.z - b.min.z > MAX_SPAN) {
    b.min.z = cz - half
    b.max.z = cz + half
  }
}

/** Fill `out` with a box worth drawing a marker around. False if there is none. */
function measure(obj: THREE.Object3D, out: THREE.Box3): boolean {
  out.makeEmpty()
  gather(obj, 0, out)
  if (!out.isEmpty()) return true
  // Every part was rejected. Fall back to the raw box, clipped to something
  // drawable, rather than leaving the user with no marker at all.
  _sub.makeEmpty()
  _sub.setFromObject(obj)
  if (_sub.isEmpty() || !isFinite(_sub.min.x) || !isFinite(_sub.max.x) || !isFinite(_sub.min.y)) return false
  out.copy(_sub)
  clampBox(out)
  return true
}

/* ---------------------------------------------------------------------------
 * The marker.
 * -------------------------------------------------------------------------*/

/**
 * plan rect 8 + crown rect 8 + 2 staffs 4 + staff ticks 8
 * + 2 dimension lines (extension x2, run, slash x2) 20  =  48 vertices.
 */
const PLAN_VERTS = 48

interface Marker {
  root: THREE.Group
  plan: THREE.LineSegments
  pos: Float32Array
  attr: THREE.BufferAttribute
  ring: THREE.LineSegments
  glow: THREE.Mesh
  mat: THREE.LineBasicMaterial
  glowMat: THREE.MeshBasicMaterial
  /** brightness multiplier applied to the accent colour (bloom threshold) */
  gain: number
  /** resting opacity of the ground light */
  lamp: number
}

export interface PickerApi {
  /** selection/hover markers live here */
  group: THREE.Object3D
  /** Resolve the visible registered component under one viewport coordinate. */
  pick(clientX: number, clientY: number): PickHit | null
  update(dt: number): void
  dispose(): void
}

export interface PickHit {
  id: string
  part?: 'page'
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
  const glowGeo = makeGlowGeometry()

  const sel = makeMarker(ringGeo, glowGeo, 1, 2.1, 0.3)
  const hov = makeMarker(ringGeo, glowGeo, 0.35, 1, 0.12)
  group.add(sel.root, hov.root)

  const raycaster = new THREE.Raycaster()

  let selectedId: string | null = null
  let hoveredId: string | null = null
  let selDef: ComponentDef | undefined
  let hovDef: ComponentDef | undefined
  let walkMode = false

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

  function pickAt(clientX: number, clientY: number): PickHit | null {
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
      if (def) {
        return {
          id: def.id,
          ...(obj.userData.anatomyPart === 'page' ? { part: 'page' as const } : {}),
        }
      }
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

    const hit = pickAt(ev.clientX, ev.clientY)
    const id = hit?.id ?? null
    bus.emit(
      'select',
      hit
        ? { id, source: 'building', ...(hit.part ? { part: hit.part } : {}) }
        : { id: null },
    )

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
    if (!walkMode && hovDef && hoveredId !== selectedId) {
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

  const offCameraMode = bus.on('camera:mode', ({ mode }) => {
    const walking = mode === 'walk'
    if (walking === walkMode) return
    walkMode = walking
    refreshHover()
  })

  function accentOf(def: ComponentDef): number {
    return def.color ?? districtColor[def.district] ?? theme.color.ink
  }

  function applyAccent(m: Marker, hex: number): void {
    m.mat.color.setHex(hex).multiplyScalar(m.gain)
    // The ground light is a wash, not linework: it stays under the bloom
    // threshold however bright the accent is.
    m.glowMat.color.setHex(hex).multiplyScalar(0.85)
  }

  /**
   * Fit a marker to a component. Not cheap (it traverses the subtree, twice
   * over for a container that has to be split), which is exactly why it runs
   * on selection change and twice a second, not per frame.
   */
  function applyBox(m: Marker, def: ComponentDef): void {
    if (!measure(def.object, _box)) {
      m.root.visible = false
      return
    }
    _box.getSize(_size)
    _box.getCenter(_center)

    const maxDim = Math.max(_size.x, _size.y, _size.z)
    const pad = clamp(maxDim * 0.06, 0.6, 4)
    const tick = clamp(maxDim * 0.1, 0.5, 6)
    const hx = _size.x * 0.5 + pad
    const hz = _size.z * 0.5 + pad
    const x0 = _center.x - hx
    const x1 = _center.x + hx
    const z0 = _center.z - hz
    const z1 = _center.z + hz

    // Where the plan is drawn. Anything standing on the surface gets it on the
    // ground plane, where a plan belongs. Anything underground or up in the air
    // gets it just beneath its own base — a soffit plan — so the marker is
    // never a 60 m line hanging off the object.
    const base = _box.min.y
    const planY = base > -1 && base < 12 ? 0.08 : base - Math.max(1.5, pad)
    const topY = _box.max.y + pad
    const off = pad + tick * 0.8

    _pen = m.pos
    _penK = 0

    // footprint, on the plan
    seg(x0, planY, z0, x1, planY, z0)
    seg(x1, planY, z0, x1, planY, z1)
    seg(x1, planY, z1, x0, planY, z1)
    seg(x0, planY, z1, x0, planY, z0)
    // the crown of the massing, repeated at roof level
    seg(x0, topY, z0, x1, topY, z0)
    seg(x1, topY, z0, x1, topY, z1)
    seg(x1, topY, z1, x0, topY, z1)
    seg(x0, topY, z1, x0, topY, z0)
    // two staffs on opposite corners, tying plan to crown, with a tick at each end
    seg(x0, planY, z0, x0, topY, z0)
    seg(x0 - tick, planY, z0 - tick, x0, planY, z0)
    seg(x0 - tick, topY, z0 - tick, x0, topY, z0)
    seg(x1, planY, z1, x1, topY, z1)
    seg(x1, planY, z1, x1 + tick, planY, z1 + tick)
    seg(x1, topY, z1, x1 + tick, topY, z1 + tick)
    // dimension line across the south face
    const dz = z1 + off
    seg(x0, planY, z1, x0, planY, dz + tick * 0.4)
    seg(x1, planY, z1, x1, planY, dz + tick * 0.4)
    seg(x0, planY, dz, x1, planY, dz)
    seg(x0 - tick * 0.4, planY, dz - tick * 0.4, x0 + tick * 0.4, planY, dz + tick * 0.4)
    seg(x1 - tick * 0.4, planY, dz - tick * 0.4, x1 + tick * 0.4, planY, dz + tick * 0.4)
    // dimension line down the west face
    const dx = x0 - off
    seg(x0, planY, z0, dx - tick * 0.4, planY, z0)
    seg(x0, planY, z1, dx - tick * 0.4, planY, z1)
    seg(dx, planY, z0, dx, planY, z1)
    seg(dx - tick * 0.4, planY, z0 - tick * 0.4, dx + tick * 0.4, planY, z0 + tick * 0.4)
    seg(dx - tick * 0.4, planY, z1 - tick * 0.4, dx + tick * 0.4, planY, z1 + tick * 0.4)

    m.attr.needsUpdate = true

    const radius = Math.hypot(hx, hz) * 1.08 + tick
    m.ring.position.set(_center.x, planY, _center.z)
    m.ring.scale.set(radius, 1, radius)
    m.glow.position.set(_center.x, planY - 0.04, _center.z)
    m.glow.scale.set(radius, 1, radius)

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
        setHover(pickAt(pointerX, pointerY)?.id ?? null)
      }
    }

    if (selDef) {
      boxT += dt
      if (boxT >= BOX_SEC) {
        boxT = 0
        applyBox(sel, selDef)
      }
      // The only motion in the marker: the ground light warming and cooling.
      sel.glowMat.opacity = sel.lamp * (0.84 + 0.16 * Math.sin((t * Math.PI * 2) / LAMP_SEC))
    }

    if (!walkMode && hovDef && hoveredId !== selectedId) {
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
    offCameraMode()
    document.body.style.cursor = ''
    sel.plan.geometry.dispose()
    hov.plan.geometry.dispose()
    sel.mat.dispose()
    hov.mat.dispose()
    sel.glowMat.dispose()
    hov.glowMat.dispose()
    ringGeo.dispose()
    glowGeo.dispose()
    group.clear()
    _hits.length = 0
  }

  return { group, pick: pickAt, update, dispose }
}

/* -------------------------------- geometry -------------------------------- */

function makeMarker(
  ringGeo: THREE.BufferGeometry,
  glowGeo: THREE.BufferGeometry,
  opacity: number,
  gain: number,
  lamp: number,
): Marker {
  const mat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity,
    // A marker you cannot see through the building it marks is a bug, not a
    // feature: this is chrome, drawn last, over everything.
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  mat.name = `picker:${gain > 1 ? 'select' : 'hover'}`

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: lamp,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  glowMat.name = `${mat.name}:lamp`

  const pos = new Float32Array(PLAN_VERTS * 3)
  const attr = new THREE.BufferAttribute(pos, 3)
  attr.setUsage(THREE.DynamicDrawUsage)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', attr)

  const plan = new THREE.LineSegments(geo, mat)
  const ring = new THREE.LineSegments(ringGeo, mat)
  const glow = new THREE.Mesh(glowGeo, glowMat)

  const root = new THREE.Group()
  root.name = 'marker'
  root.visible = false
  root.add(glow, ring, plan)
  for (const o of root.children) {
    o.renderOrder = 999
    o.frustumCulled = false
    o.raycast = noRaycast
  }
  root.raycast = noRaycast

  return { root, plan, pos, attr, ring, glow, mat, glowMat, gain, lamp }
}

function noRaycast(): void {
  /* markers are decoration — never pickable */
}

/**
 * Unit-radius setting-out circle in the XZ plane: one continuous ring plus
 * outward radial ticks at the eighths, which is how a plot is marked out
 * before anything is built on it. Static — it never turns.
 */
function makeRingGeometry(): THREE.BufferGeometry {
  const STEPS = 64
  const TICKS = 16
  const verts = new Float32Array((STEPS + TICKS) * 2 * 3)
  let k = 0
  for (let i = 0; i < STEPS; i++) {
    const a0 = (i / STEPS) * Math.PI * 2
    const a1 = ((i + 1) / STEPS) * Math.PI * 2
    verts[k++] = Math.cos(a0); verts[k++] = 0; verts[k++] = Math.sin(a0)
    verts[k++] = Math.cos(a1); verts[k++] = 0; verts[k++] = Math.sin(a1)
  }
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    const r1 = i % 4 === 0 ? 1.13 : 1.06
    verts[k++] = c; verts[k++] = 0; verts[k++] = s
    verts[k++] = c * r1; verts[k++] = 0; verts[k++] = s * r1
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  return geo
}

/**
 * The light on the plot: a unit-radius annulus whose brightness is carried in
 * the vertex colours, so it fades out on both edges with no texture and no
 * shader. Additive, so on the dark plate it reads as a lit kerb rather than a
 * disc lying on the ground.
 */
function makeGlowGeometry(): THREE.BufferGeometry {
  const SEG = 48
  const RADII = [0.62, 0.94, 1.16]
  const LEVEL = [0, 1, 0]
  const count = RADII.length * (SEG + 1)
  const pos = new Float32Array(count * 3)
  const col = new Float32Array(count * 3)
  let k = 0
  for (let r = 0; r < RADII.length; r++) {
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2
      pos[k * 3] = Math.cos(a) * RADII[r]
      pos[k * 3 + 1] = 0
      pos[k * 3 + 2] = Math.sin(a) * RADII[r]
      col[k * 3] = LEVEL[r]
      col[k * 3 + 1] = LEVEL[r]
      col[k * 3 + 2] = LEVEL[r]
      k++
    }
  }
  const idx = new Uint16Array((RADII.length - 1) * SEG * 6)
  let m = 0
  for (let r = 0; r < RADII.length - 1; r++) {
    const a = r * (SEG + 1)
    const b = (r + 1) * (SEG + 1)
    for (let i = 0; i < SEG; i++) {
      idx[m++] = a + i; idx[m++] = b + i; idx[m++] = b + i + 1
      idx[m++] = a + i; idx[m++] = b + i + 1; idx[m++] = a + i + 1
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  return geo
}
