import * as THREE from 'three'
import type { ComponentDef, DistrictId } from '../core/types'

/* ============================================================================
 * THE COLLISION WORLD
 *
 * A pedestrian needs three answers, sixty times a second:
 *
 *   1. what is under my feet?          groundAt()
 *   2. can I move from here to there?  move()
 *   3. …without stopping dead on a kerb.
 *
 * The city is heavily instanced — 1024 shared-buffer tiles, 14 WAL segments,
 * five warehouses of pages — so colliding against meshes is out of the
 * question. Instead the whole static city is reduced ONCE, at build time, to a
 * few hundred axis-aligned boxes taken straight from the component registry,
 * and those boxes are bucketed into a uniform grid. A walker only ever tests
 * the handful of boxes in the cells it is standing in.
 *
 * WHY REGISTRY BOXES. Every district already publishes a pickable root per
 * component. `Box3.setFromObject` on that root is exactly the volume the user
 * sees, costs nothing at runtime, and means a district that grows a new
 * building gets collision for free. No district has to know this file exists.
 *
 * WHAT IS DELIBERATELY NOT SOLID — see DEFAULT_EXCLUDE_IDS below. The two that
 * matter: `world.ground` (it is the floor, and the floor is a *walkable*, not a
 * blocker) and `shared.buffers` (1024 tiles whose heights change every frame
 * with usage_count; a 32x32 field of live-height blocks with 0.6 m gaps would
 * make the plaza deck impassable for a 0.7 m-wide human). You walk *through*
 * the buffer tiles. Standing inside a lit buffer is the entire point of the
 * feature.
 *
 * OVERSIZED CONTAINERS. A registered root is often a whole district: the
 * backend row is one group 224 m wide and 26 m tall. Boxing that would wall off
 * the north side of the city. So a box that is too big is not dropped — it is
 * SPLIT: we recurse into the object's children and box those instead. Sixteen
 * backend towers, one box each. Recursion stops at `maxDepth` (default 4) or as
 * soon as a level yields boxes of sane size.
 *
 * Nothing in groundAt() or move() allocates. The single exception is three's
 * own per-intersection record inside Raycaster.intersectObjects — the results
 * array itself is reused, and the ray, the vectors and the candidate buffers
 * are all hoisted to module scope.
 * ==========================================================================*/

/* --------------------------------------------------------------------------
 * Public shape.
 * ------------------------------------------------------------------------*/

/** Anything that can enumerate components. `Registry` satisfies this. */
export interface ComponentSource {
  all(): readonly ComponentDef[]
}

export interface MoveResult {
  /** Resolved feet position. `y` is `to.y` plus any step-up. */
  position: THREE.Vector3
  /** The X move was clamped by a wall. */
  hitX: boolean
  /** The Z move was clamped by a wall. */
  hitZ: boolean
  /** hitX || hitZ */
  blocked: boolean
  /** Metres the feet were lifted by the step-up allowance (0 on flat ground). */
  stepped: number
}

export function createMoveResult(): MoveResult {
  return { position: new THREE.Vector3(), hitX: false, hitZ: false, blocked: false, stepped: 0 }
}

export interface CollisionBuildOptions {
  /**
   * Component ids that must never block a walker.
   * Defaults to DEFAULT_EXCLUDE_IDS; pass your own array to replace it
   * wholesale, or spread it to extend: `[...DEFAULT_EXCLUDE_IDS, 'my.thing']`.
   */
  excludeIds?: readonly string[]
  /** Whole districts to skip. Default: none. */
  excludeDistricts?: readonly DistrictId[]
  /**
   * A box wider than this in X *or* Z is a district container, not a building:
   * split it into its children. Default 60 m — wide enough for the postmaster
   * and the WAL vault, narrow enough to catch the backend row (224 m).
   */
  maxSpan?: number
  /**
   * …unless it is thinner than this, in which case it is a floor slab and is
   * kept as one box. Default 5 m — the shared-memory deck is 156 x 124 x ~3.5
   * and must stay a single collider or there is nothing to stand on.
   */
  slabY?: number
  /** Never accept a slab bigger than this even if it is thin. Default 340 m. */
  hugeSpan?: number
  /** Boxes thinner than this vertically are decals / lines. Default 0.3 m. */
  minThickness?: number
  /**
   * Drop boxes whose underside is at or above this. Default 38 m: the client
   * sky (y 40‥80) and the query lab (y 66) hang up there and no pedestrian can
   * ever touch them.
   */
  ceiling?: number
  /** Drop boxes whose top is at or below this. Default -80 m (the pit floor is -60). */
  floor?: number
  /** How deep to recurse into an oversized container. Default 4. */
  maxDepth?: number
  /** Grow every accepted box by this much horizontally. Default 0. */
  pad?: number
  /** Spatial-hash cell size in metres. Default 16. */
  cell?: number
}

export interface CollisionWorld {
  /** Rebuild the static collider set from a component registry. */
  build(source: ComponentSource, opts?: CollisionBuildOptions): void
  /** Add one static box by hand (guard rails, invisible walls). */
  addBox(box: THREE.Box3): void
  /** Register a surface root the ground ray may hit. Safe to call twice. */
  addWalkable(obj: THREE.Object3D): void
  removeWalkable(obj: THREE.Object3D): void
  /**
   * Height of the highest surface under `p` that lies in
   * `[p.y - maxDrop, p.y + tolerance]`, or null if there is nothing there.
   * Considers both the walkable meshes (one downward raycast) and the tops of
   * the static boxes, so you can stand on a backend tower without anyone having
   * registered its roof.
   */
  groundAt(p: THREE.Vector3, maxDrop: number): number | null
  /**
   * Slide a vertical capsule horizontally. `from` and `to` are FEET positions;
   * only the horizontal component of `to` is used — `to.y` is passed through to
   * `out.position.y` (plus any step-up), and `from.y` is the height the capsule
   * is tested at. Resolve vertical motion yourself, after this call.
   */
  move(from: THREE.Vector3, to: THREE.Vector3, radius: number, height: number, out: MoveResult): MoveResult
  /** Wireframe of every collider. Rebuilt on demand; owned by this world. */
  debugMesh(): THREE.LineSegments
  /** Step-up allowance used by move(). */
  stepHeight: number
  readonly boxCount: number
  clear(): void
  dispose(): void
}

/**
 * Components that must not block a pedestrian.
 *
 *   world.ground     the floor itself — register it as a *walkable* instead
 *   world.pit        the excavation: a 236 x 208 m rim, glow band and wall set
 *                    whose flat pieces would pave over the hole you are meant
 *                    to be able to fall into
 *   client.pool      the client sky, 40‥80 m up
 *   conn.gate        the connection gate, hanging at y = 14 over open air
 *   shared.buffers   1024 live-height tiles, see the header
 *   shmem            (module id, harmless if it ever becomes a component)
 */
export const DEFAULT_EXCLUDE_IDS: readonly string[] = [
  'world.ground',
  'world.pit',
  'client.pool',
  'conn.gate',
  'shared.buffers',
  'shmem',
]

/* --------------------------------------------------------------------------
 * Tuning that is not worth an option.
 * ------------------------------------------------------------------------*/

/** How far above the feet the ground ray starts. A head, basically. */
const RAY_UP = 2.0
/** A surface this far above the feet still counts as "under" them. */
const GROUND_TOL = 0.05
/** Below this the two floats are the same number. */
const EPS = 1e-4

const DEFAULTS = {
  maxSpan: 60,
  slabY: 5,
  hugeSpan: 340,
  minThickness: 0.3,
  ceiling: 38,
  floor: -80,
  maxDepth: 4,
  pad: 0,
  cell: 16,
} as const

/* --------------------------------------------------------------------------
 * Module-scope scratch. Nothing below this line allocates per frame.
 * ------------------------------------------------------------------------*/

const _box = new THREE.Box3()
const _origin = new THREE.Vector3()
const DOWN = new THREE.Vector3(0, -1, 0)
const _ray = new THREE.Raycaster()
_ray.layers.enableAll()
const _hits: THREE.Intersection[] = []

/** Set by solveAxis(); read immediately after. */
let _axisHit = false

/* ==========================================================================*/

export function createCollisionWorld(): CollisionWorld {
  /* ---- the box soup ------------------------------------------------------*/

  // 6 floats per box: minX minY minZ maxX maxY maxZ
  let data = new Float32Array(256 * 6)
  let n = 0

  // uniform grid, CSR-encoded
  let cell: number = DEFAULTS.cell
  let gx0 = 0
  let gz0 = 0
  let gw = 0
  let gh = 0
  let cellStart = new Int32Array(1)
  let cellItems = new Int32Array(1)

  // candidate scratch, sized with the box set
  let cand = new Int32Array(256)
  let candN = 0
  let stamp = new Int32Array(256)
  let gen = 0

  const walkables: THREE.Object3D[] = []
  let debug: THREE.LineSegments | null = null
  let debugStale = true

  let stepHeight = 0.45

  /* ---- building ----------------------------------------------------------*/

  function ensureCapacity(count: number): void {
    if (count * 6 <= data.length) return
    let cap = data.length / 6
    while (cap < count) cap *= 2
    const next = new Float32Array(cap * 6)
    next.set(data)
    data = next
  }

  function pushBox(b: THREE.Box3, pad: number): void {
    ensureCapacity(n + 1)
    const o = n * 6
    data[o] = b.min.x - pad
    data[o + 1] = b.min.y
    data[o + 2] = b.min.z - pad
    data[o + 3] = b.max.x + pad
    data[o + 4] = b.max.y
    data[o + 5] = b.max.z + pad
    n++
    debugStale = true
  }

  type Verdict = 0 | 1 | 2 // 0 drop, 1 accept, 2 split

  function classify(b: THREE.Box3, o: Required<CollisionBuildOptions>): Verdict {
    const sx = b.max.x - b.min.x
    const sy = b.max.y - b.min.y
    const sz = b.max.z - b.min.z
    if (!isFinite(sx) || !isFinite(sy) || !isFinite(sz)) return 0
    // Degenerate: a line, a decal, a ground plate. Nothing to bump into.
    if (sx <= EPS || sz <= EPS || sy < o.minThickness) return 0
    if (b.min.y >= o.ceiling) return 0
    if (b.max.y <= o.floor) return 0
    if (sx <= o.maxSpan && sz <= o.maxSpan) return 1
    // Wide. A thin wide box is a deck or a roof and stays one collider; a wide
    // *tall* box is a district container and has to be broken up.
    if (sy <= o.slabY && sx <= o.hugeSpan && sz <= o.hugeSpan) return 1
    return 2
  }

  function addObject(obj: THREE.Object3D, depth: number, o: Required<CollisionBuildOptions>): void {
    _box.setFromObject(obj)
    if (_box.isEmpty()) return
    const verdict = classify(_box, o)
    if (verdict === 1) {
      pushBox(_box, o.pad)
      return
    }
    if (verdict === 2 && depth < o.maxDepth) {
      const kids = obj.children
      for (let i = 0; i < kids.length; i++) addObject(kids[i], depth + 1, o)
    }
  }

  function build(source: ComponentSource, opts: CollisionBuildOptions = {}): void {
    const o: Required<CollisionBuildOptions> = {
      excludeIds: opts.excludeIds ?? DEFAULT_EXCLUDE_IDS,
      excludeDistricts: opts.excludeDistricts ?? [],
      maxSpan: opts.maxSpan ?? DEFAULTS.maxSpan,
      slabY: opts.slabY ?? DEFAULTS.slabY,
      hugeSpan: opts.hugeSpan ?? DEFAULTS.hugeSpan,
      minThickness: opts.minThickness ?? DEFAULTS.minThickness,
      ceiling: opts.ceiling ?? DEFAULTS.ceiling,
      floor: opts.floor ?? DEFAULTS.floor,
      maxDepth: opts.maxDepth ?? DEFAULTS.maxDepth,
      pad: opts.pad ?? DEFAULTS.pad,
      cell: opts.cell ?? DEFAULTS.cell,
    }
    cell = o.cell > 1 ? o.cell : DEFAULTS.cell
    n = 0

    const skipId = new Set(o.excludeIds)
    const skipDistrict = new Set<DistrictId>(o.excludeDistricts)

    const all = source.all()
    for (let i = 0; i < all.length; i++) {
      const def = all[i]
      if (skipId.has(def.id)) continue
      if (skipDistrict.has(def.district)) continue
      def.object.updateWorldMatrix(true, false)
      addObject(def.object, 0, o)
    }
    rebuildGrid()
  }

  function addBox(b: THREE.Box3): void {
    if (b.isEmpty()) return
    pushBox(b, 0)
    rebuildGrid()
  }

  /* ---- the spatial hash --------------------------------------------------*/

  function rebuildGrid(): void {
    if (cand.length < n) {
      cand = new Int32Array(Math.max(n, cand.length * 2))
      stamp = new Int32Array(cand.length)
      gen = 0
    }
    if (n === 0) {
      gw = 0
      gh = 0
      return
    }
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const o = i * 6
      if (data[o] < minX) minX = data[o]
      if (data[o + 3] > maxX) maxX = data[o + 3]
      if (data[o + 2] < minZ) minZ = data[o + 2]
      if (data[o + 5] > maxZ) maxZ = data[o + 5]
    }
    gx0 = Math.floor(minX / cell)
    gz0 = Math.floor(minZ / cell)
    gw = Math.floor(maxX / cell) - gx0 + 1
    gh = Math.floor(maxZ / cell) - gz0 + 1
    // A pathological box would blow the grid up; fall back to one bucket.
    if (gw * gh > 1 << 20) {
      gw = 1
      gh = 1
      gx0 = Math.floor(minX / cell)
      gz0 = Math.floor(minZ / cell)
      cell = Math.max(maxX - minX, maxZ - minZ) + 1
    }

    const cells = gw * gh
    if (cellStart.length < cells + 1) cellStart = new Int32Array(cells + 1)
    else cellStart.fill(0, 0, cells + 1)

    // pass 1 — count
    let total = 0
    for (let i = 0; i < n; i++) {
      const o = i * 6
      const ix0 = Math.max(0, Math.floor(data[o] / cell) - gx0)
      const ix1 = Math.min(gw - 1, Math.floor(data[o + 3] / cell) - gx0)
      const iz0 = Math.max(0, Math.floor(data[o + 2] / cell) - gz0)
      const iz1 = Math.min(gh - 1, Math.floor(data[o + 5] / cell) - gz0)
      for (let iz = iz0; iz <= iz1; iz++) {
        const row = iz * gw
        for (let ix = ix0; ix <= ix1; ix++) {
          cellStart[row + ix + 1]++
          total++
        }
      }
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c]

    if (cellItems.length < total) cellItems = new Int32Array(Math.max(total, 16))

    // pass 2 — fill, using a private cursor copy of the starts
    const cursor = new Int32Array(cells)
    for (let i = 0; i < n; i++) {
      const o = i * 6
      const ix0 = Math.max(0, Math.floor(data[o] / cell) - gx0)
      const ix1 = Math.min(gw - 1, Math.floor(data[o + 3] / cell) - gx0)
      const iz0 = Math.max(0, Math.floor(data[o + 2] / cell) - gz0)
      const iz1 = Math.min(gh - 1, Math.floor(data[o + 5] / cell) - gz0)
      for (let iz = iz0; iz <= iz1; iz++) {
        const row = iz * gw
        for (let ix = ix0; ix <= ix1; ix++) {
          const c = row + ix
          cellItems[cellStart[c] + cursor[c]] = i
          cursor[c]++
        }
      }
    }
    debugStale = true
  }

  /**
   * Collect every box overlapping an XZ rectangle into `cand`. Boxes that span
   * several cells are de-duplicated with a generation stamp, so no Set and no
   * allocation.
   */
  function queryRect(minX: number, minZ: number, maxX: number, maxZ: number): void {
    candN = 0
    if (gw === 0) return
    let ix0 = Math.floor(minX / cell) - gx0
    let ix1 = Math.floor(maxX / cell) - gx0
    let iz0 = Math.floor(minZ / cell) - gz0
    let iz1 = Math.floor(maxZ / cell) - gz0
    if (ix1 < 0 || iz1 < 0 || ix0 > gw - 1 || iz0 > gh - 1) return
    if (ix0 < 0) ix0 = 0
    if (iz0 < 0) iz0 = 0
    if (ix1 > gw - 1) ix1 = gw - 1
    if (iz1 > gh - 1) iz1 = gh - 1

    gen++
    for (let iz = iz0; iz <= iz1; iz++) {
      const row = iz * gw
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = row + ix
        const s = cellStart[c]
        const e = cellStart[c + 1]
        for (let k = s; k < e; k++) {
          const idx = cellItems[k]
          if (stamp[idx] === gen) continue
          stamp[idx] = gen
          cand[candN++] = idx
        }
      }
    }
  }

  /* ---- queries -----------------------------------------------------------*/

  function groundAt(p: THREE.Vector3, maxDrop: number): number | null {
    const lo = p.y - maxDrop
    const hi = p.y + GROUND_TOL
    let best = -Infinity

    // (a) tops of the static boxes directly under the point
    if (n > 0) {
      queryRect(p.x, p.z, p.x, p.z)
      for (let i = 0; i < candN; i++) {
        const o = cand[i] * 6
        if (p.x < data[o] || p.x > data[o + 3]) continue
        if (p.z < data[o + 2] || p.z > data[o + 5]) continue
        const top = data[o + 4]
        if (top >= lo && top <= hi && top > best) best = top
      }
    }

    // (b) one downward ray against the walkable surfaces only
    if (walkables.length > 0) {
      const from = hi + RAY_UP
      _origin.set(p.x, from, p.z)
      _ray.set(_origin, DOWN)
      _ray.near = 0
      _ray.far = from - lo
      _hits.length = 0
      _ray.intersectObjects(walkables, true, _hits)
      // three sorts by distance, so the first qualifying hit is the highest one.
      for (let i = 0; i < _hits.length; i++) {
        const y = _hits[i].point.y
        if (y > hi) continue
        if (y < lo) break
        if (y > best) best = y
        break
      }
      _hits.length = 0
    }

    return best === -Infinity ? null : best
  }

  /**
   * One axis of the slide. `isX` picks the axis; `other` is the walker's
   * position on the perpendicular axis. Boxes the walker is already inside are
   * ignored on purpose — pushing back out of them is how a controller gets
   * stuck in a corner forever.
   */
  function solveAxis(
    isX: boolean,
    cur: number,
    target: number,
    other: number,
    radius: number,
    wallY: number,
    headY: number,
  ): number {
    _axisHit = false
    const d = target - cur
    if (d === 0) return cur
    let best = target
    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      // vertical band: below the step allowance it is a floor, above the head
      // it is a ceiling; neither stops a horizontal move.
      if (data[o + 4] <= wallY) continue
      if (data[o + 1] >= headY) continue
      const oMin = isX ? data[o + 2] : data[o]
      const oMax = isX ? data[o + 5] : data[o + 3]
      if (other + radius <= oMin || other - radius >= oMax) continue
      if (d > 0) {
        const limit = (isX ? data[o] : data[o + 2]) - radius
        if (limit >= best) continue
        if (limit < cur) continue
        best = limit
        _axisHit = true
      } else {
        const limit = (isX ? data[o + 3] : data[o + 5]) + radius
        if (limit <= best) continue
        if (limit > cur) continue
        best = limit
        _axisHit = true
      }
    }
    return best
  }

  function move(
    from: THREE.Vector3,
    to: THREE.Vector3,
    radius: number,
    height: number,
    out: MoveResult,
  ): MoveResult {
    out.position.set(to.x, to.y, to.z)
    out.hitX = false
    out.hitZ = false
    out.blocked = false
    out.stepped = 0
    if (n === 0) return out

    const feet = from.y
    const wallY = feet + stepHeight
    const headY = feet + height

    const loX = (from.x < to.x ? from.x : to.x) - radius
    const hiX = (from.x > to.x ? from.x : to.x) + radius
    const loZ = (from.z < to.z ? from.z : to.z) - radius
    const hiZ = (from.z > to.z ? from.z : to.z) + radius
    queryRect(loX, loZ, hiX, hiZ)
    if (candN === 0) return out

    // X first, then Z against the already-resolved X: that is what makes a
    // walker slide along a wall instead of stopping dead in front of it.
    const x = solveAxis(true, from.x, to.x, from.z, radius, wallY, headY)
    out.hitX = _axisHit
    const z = solveAxis(false, from.z, to.z, x, radius, wallY, headY)
    out.hitZ = _axisHit
    out.blocked = out.hitX || out.hitZ

    // Step-up: whatever we are actually standing over now, up to stepHeight.
    let lift = 0
    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      if (x + radius <= data[o] || x - radius >= data[o + 3]) continue
      if (z + radius <= data[o + 2] || z - radius >= data[o + 5]) continue
      const rise = data[o + 4] - feet
      if (rise > EPS && rise <= stepHeight && rise > lift) lift = rise
    }
    out.stepped = lift
    out.position.set(x, to.y + lift, z)
    return out
  }

  /* ---- walkables ---------------------------------------------------------*/

  function addWalkable(obj: THREE.Object3D): void {
    if (walkables.indexOf(obj) < 0) walkables.push(obj)
  }
  function removeWalkable(obj: THREE.Object3D): void {
    const i = walkables.indexOf(obj)
    if (i >= 0) walkables.splice(i, 1)
  }

  /* ---- debug -------------------------------------------------------------*/

  function debugMesh(): THREE.LineSegments {
    if (!debug) {
      debug = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x39ff88, transparent: true, opacity: 0.5, depthTest: false }),
      )
      debug.name = 'collision.debug'
      debug.frustumCulled = false
      debug.renderOrder = 999
      debug.raycast = () => {}
    }
    if (!debugStale) return debug
    debugStale = false
    // 12 edges x 2 vertices x 3 floats
    const pos = new Float32Array(n * 72)
    let w = 0
    const put = (x: number, y: number, z: number) => {
      pos[w++] = x
      pos[w++] = y
      pos[w++] = z
    }
    for (let i = 0; i < n; i++) {
      const o = i * 6
      const x0 = data[o]
      const y0 = data[o + 1]
      const z0 = data[o + 2]
      const x1 = data[o + 3]
      const y1 = data[o + 4]
      const z1 = data[o + 5]
      // bottom ring
      put(x0, y0, z0); put(x1, y0, z0)
      put(x1, y0, z0); put(x1, y0, z1)
      put(x1, y0, z1); put(x0, y0, z1)
      put(x0, y0, z1); put(x0, y0, z0)
      // top ring
      put(x0, y1, z0); put(x1, y1, z0)
      put(x1, y1, z0); put(x1, y1, z1)
      put(x1, y1, z1); put(x0, y1, z1)
      put(x0, y1, z1); put(x0, y1, z0)
      // uprights
      put(x0, y0, z0); put(x0, y1, z0)
      put(x1, y0, z0); put(x1, y1, z0)
      put(x1, y0, z1); put(x1, y1, z1)
      put(x0, y0, z1); put(x0, y1, z1)
    }
    debug.geometry.dispose()
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    debug.geometry = geo
    return debug
  }

  /* ---- lifecycle ---------------------------------------------------------*/

  function clear(): void {
    n = 0
    gw = 0
    gh = 0
    debugStale = true
  }

  function dispose(): void {
    clear()
    walkables.length = 0
    _hits.length = 0
    if (debug) {
      debug.geometry.dispose()
      ;(debug.material as THREE.Material).dispose()
      debug.removeFromParent()
      debug = null
    }
  }

  return {
    build,
    addBox,
    addWalkable,
    removeWalkable,
    groundAt,
    move,
    debugMesh,
    get stepHeight(): number {
      return stepHeight
    },
    set stepHeight(v: number) {
      stepHeight = v > 0 ? v : 0
    },
    get boxCount(): number {
      return n
    },
    clear,
    dispose,
  }
}
