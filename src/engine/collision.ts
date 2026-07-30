import * as THREE from 'three'
import { N_VAC_WORKERS } from '../core/types'
import type { ComponentDef, DistrictId } from '../core/types'
import type { Surface } from './audio'

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
 * WHAT IS DELIBERATELY NOT SOLID — see DEFAULT_EXCLUDE_IDS below. The three that
 * matter: `world.ground` (it is the floor, and the floor is a *walkable*, not a
 * blocker), `shared.buffers` (1024 tiles whose heights change every frame with
 * usage_count; a 32x32 field of live-height blocks with 0.6 m gaps would make
 * the plaza deck impassable for a 0.7 m-wide human), and `storage.tempfiles`
 * (its registered object is a 2 m-tall invisible pick proxy around a visible
 * 0.36 m step-height bay). You walk *through* the buffer tiles. Standing inside
 * a lit buffer is the entire point of the feature.
 *
 * OVERSIZED CONTAINERS. A registered root is often a whole district: the
 * backend row is one group 224 m wide and 26 m tall. Boxing that would wall off
 * the north side of the city. Even a smaller compound building cannot be boxed
 * as one mass: its loose AABB contains valid standing space between protruding
 * parts, and the solver must allow a walker spawned there to escape. Containers
 * are therefore split into children, and instanced box batches into individual
 * instances. Recursion stops at `maxDepth` (default 4).
 *
 * …AND OVERSIZED *LEAVES*. Nine districts merge their whole structure into one
 * childless mesh (`standby.b.struct`, `recovery.ground.struct`, the WAL vault,
 * the planner lab…). Recursing into a leaf finds nothing, so those buildings
 * used to end up with no collider at all and you walked straight through them.
 * A leaf that is too big is therefore VOXELISED instead: one pass over its
 * triangles bins them into a coarse XZ grid, each occupied cell is tightened to
 * the geometry actually inside it, and every cell is re-run through classify()
 * so a painted apron still fails minThickness rather than becoming a kerb.
 * Cell-tight, so a low wing does not inherit the tower's roof.
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
  /**
   * A box taller than this is split too. Default 70 m. Districts park unused
   * instanced-mesh instances far below the world — the postmaster's registry
   * box runs y = -1000‥47, the WAL vault's y = -9000‥17 — and boxing those
   * would drop an invisible one-kilometre column through the city. Nothing a
   * pedestrian can see is taller than 53 m, so 70 is comfortable headroom.
   */
  maxHeight?: number
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
  addBox(box: THREE.Box3, surface?: Surface): void
  /** Reduce one rendered object to static boxes and add them to this world. */
  addSolid(obj: THREE.Object3D, surface?: Surface): void
  /**
   * Add `userData.collisionSolids` Object3Ds and `userData.collisionBoxes`
   * Box3s published anywhere below a scene root.
   */
  addPublished(root: THREE.Object3D): void
  /** Register a surface root the ground ray may hit. Safe to call twice. */
  addWalkable(obj: THREE.Object3D, surface?: Surface): void
  removeWalkable(obj: THREE.Object3D): void
  /**
   * Height of the highest surface under `p` that lies in
   * `[p.y - maxDrop, p.y + tolerance]`, or null if there is nothing there.
   * Considers both the walkable meshes (one downward raycast) and the tops of
   * the static boxes, so you can stand on a backend tower without anyone having
   * registered its roof.
   */
  groundAt(p: THREE.Vector3, maxDrop: number): number | null
  /** Surface selected by the most recent successful groundAt() query. */
  readonly groundSurface: Surface
  /**
   * Upward normal of that same surface: (0,1,0) for a box top, the face normal
   * for a walkable ray hit. This is what tells a ramp from a wall. Owned by the
   * collision world and overwritten by every successful query — read it, do not
   * keep it.
   */
  readonly groundNormal: THREE.Vector3
  /**
   * Is there any structure a pedestrian could meet within `radius` of this XZ?
   *
   * Only what a person can actually walk up to counts: the buried storage layer
   * and anything hanging in the client sky are ignored. This is how a drop-in
   * tells "you are in the city" from "you are standing in the empty outfield" —
   * the ground ray cannot, because it finds the same plate at y = 0 either way.
   *
   * Not for per-frame use: it shares the candidate buffer with move().
   */
  solidNear(x: number, z: number, radius: number): boolean
  /**
   * Does a static collider sit wholly between two world-space points?
   *
   * Colliders containing `to` are ignored: component label anchors commonly
   * sit inside the object they name, and that object must not occlude itself.
   * Uses the existing spatial hash and candidate scratch; allocates nothing.
   */
  occluded(from: THREE.Vector3, to: THREE.Vector3): boolean
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
 *                    to be able to fall into; ground.ts publishes exact wall
 *                    boxes and the floor is a raycast walkable
 *   client.pool      the client sky, 40‥80 m up
 *   conn.gate        a 300 m sparse fence: boxing or voxelising its registered
 *                    root fills the real central opening; clients.ts publishes
 *                    exact post, wall, pylon, and header boxes instead
 *   shared.buffers   1024 live-height tiles, see the header
 *   storage.tempfiles
 *                    its registry object is an invisible selection proxy twice
 *                    as tall as a walker; the visible bay is only a 0.36 m step
 *   autovac.worker.N the vacuum trucks DRIVE. build() is a boot snapshot, so a
 *                    box for one of these is a ghost wall parked wherever the
 *                    truck happened to be at t = 0.
 */
export const DEFAULT_EXCLUDE_IDS: readonly string[] = (() => {
  const ids = [
    'world.ground',
    'world.pit',
    'client.pool',
    'conn.gate',
    'shared.buffers',
    'storage.tempfiles',
  ]
  for (let i = 0; i < N_VAC_WORKERS; i++) ids.push(`autovac.worker.${i}`)
  return ids
})()

/* --------------------------------------------------------------------------
 * Tuning that is not worth an option.
 * ------------------------------------------------------------------------*/

/** How far above the feet the ground ray starts. A head, basically. */
const RAY_UP = 2.0
/** A surface this far above the feet still counts as "under" them. */
const GROUND_TOL = 0.05
/** Below this the two floats are the same number. */
const EPS = 1e-4
/** Slack on the headroom test: the floor being stepped onto is not a ceiling. */
const STEP_EPS = 1e-3
/** solidNear(): a box whose top is below this is buried and does not count. */
const NEAR_FLOOR = -1
/** …and one whose underside is above this hangs in the sky and does not either. */
const NEAR_CEILING = 30
const SURFACES: readonly Surface[] = ['ground', 'deck', 'metal', 'stair', 'water']

const DEFAULTS = {
  maxSpan: 60,
  slabY: 5,
  maxHeight: 70,
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
const _leaf = new THREE.Box3()
const _origin = new THREE.Vector3()
const _step = new THREE.Vector3()
const DOWN = new THREE.Vector3(0, -1, 0)
const _ray = new THREE.Raycaster()
_ray.layers.enableAll()
const _hits: THREE.Intersection[] = []
const _normalMat = new THREE.Matrix3()
const _normal = new THREE.Vector3()
const _sub = new THREE.Box3()
const _va = new THREE.Vector3()
const _vb = new THREE.Vector3()
const _vc = new THREE.Vector3()
const _mat = new THREE.Matrix4()

function materialIsRendered(material: THREE.Material | readonly THREE.Material[]): boolean {
  const materials = Array.isArray(material) ? material : [material]
  for (let i = 0; i < materials.length; i++) {
    const item = materials[i]
    if (item.visible && (!item.transparent || item.opacity > 0.01)) return true
  }
  return false
}

/**
 * `Box3.setFromObject()` includes hidden branches and invisible pick proxies.
 * Collision follows pixels a walker can see, so measure rendered meshes only.
 */
function visibleBounds(obj: THREE.Object3D, target: THREE.Box3): THREE.Box3 {
  target.makeEmpty()
  expandVisibleBounds(obj, target)
  return target
}

function expandVisibleBounds(obj: THREE.Object3D, target: THREE.Box3): void {
  if (!obj.visible) return
  const mesh = obj as THREE.Mesh
  if (mesh.isMesh && mesh.geometry && materialIsRendered(mesh.material)) {
    const instanced = mesh as THREE.InstancedMesh
    if (instanced.isInstancedMesh) {
      if (!instanced.boundingBox) instanced.computeBoundingBox()
      if (instanced.boundingBox && !instanced.boundingBox.isEmpty()) {
        _sub.copy(instanced.boundingBox).applyMatrix4(instanced.matrixWorld)
        target.union(_sub)
      }
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      if (mesh.geometry.boundingBox && !mesh.geometry.boundingBox.isEmpty()) {
        _sub.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
        target.union(_sub)
      }
    }
  }
  const children = obj.children
  for (let i = 0; i < children.length; i++) expandVisibleBounds(children[i], target)
}

/** Set by sweepMove(); read immediately after. */
let _sweepHitX = false
let _sweepHitZ = false

/* ---- leaf voxeliser scratch (build time only, but still hoisted) ----------*/

/** Cells per horizontal axis when an oversized leaf mesh is subdivided. */
const SPLIT_MAX = 16
/** Target cell size, in metres. Matches the default spatial-hash cell. */
const SPLIT_TARGET = 16
/** Past this many indices a mesh is boxed whole rather than triangle-binned. */
const SPLIT_INDEX_CAP = 600_000
/** …and past this many instances an InstancedMesh is too. */
const SPLIT_INSTANCE_CAP = 4096
const CELLS = SPLIT_MAX * SPLIT_MAX
const _cMinX = new Float32Array(CELLS)
const _cMinY = new Float32Array(CELLS)
const _cMinZ = new Float32Array(CELLS)
const _cMaxX = new Float32Array(CELLS)
const _cMaxY = new Float32Array(CELLS)
const _cMaxZ = new Float32Array(CELLS)

/* ==========================================================================*/

export function createCollisionWorld(): CollisionWorld {
  /* ---- the box soup ------------------------------------------------------*/

  // 6 floats per box: minX minY minZ maxX maxY maxZ
  let data = new Float32Array(256 * 6)
  let boxSurface = new Uint8Array(256)
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
  const walkableSurfaces: Surface[] = []
  let debug: THREE.LineSegments | null = null
  let debugStale = true
  let groundSurface: Surface = 'ground'
  const groundNormal = new THREE.Vector3(0, 1, 0)
  /** Saved around the step-up probe so move() cannot corrupt a walker's read. */
  let savedSurface: Surface = 'ground'
  const savedNormal = new THREE.Vector3(0, 1, 0)

  let stepHeight = 0.45
  let activeBuildOptions: Required<CollisionBuildOptions> = {
    excludeIds: DEFAULT_EXCLUDE_IDS,
    excludeDistricts: [],
    maxSpan: DEFAULTS.maxSpan,
    slabY: DEFAULTS.slabY,
    maxHeight: DEFAULTS.maxHeight,
    hugeSpan: DEFAULTS.hugeSpan,
    minThickness: DEFAULTS.minThickness,
    ceiling: DEFAULTS.ceiling,
    floor: DEFAULTS.floor,
    maxDepth: DEFAULTS.maxDepth,
    pad: DEFAULTS.pad,
    cell: DEFAULTS.cell,
  }

  /* ---- building ----------------------------------------------------------*/

  function ensureCapacity(count: number): void {
    if (count * 6 <= data.length) return
    let cap = data.length / 6
    while (cap < count) cap *= 2
    const next = new Float32Array(cap * 6)
    next.set(data)
    data = next
    const nextSurface = new Uint8Array(cap)
    nextSurface.set(boxSurface)
    boxSurface = nextSurface
  }

  function surfaceCode(surface: Surface): number {
    switch (surface) {
      case 'ground':
        return 0
      case 'deck':
        return 1
      case 'metal':
        return 2
      case 'stair':
        return 3
      case 'water':
        return 4
    }
  }

  function pushBox(b: THREE.Box3, pad: number, surface: Surface): void {
    ensureCapacity(n + 1)
    const o = n * 6
    data[o] = b.min.x - pad
    data[o + 1] = b.min.y
    data[o + 2] = b.min.z - pad
    data[o + 3] = b.max.x + pad
    data[o + 4] = b.max.y
    data[o + 5] = b.max.z + pad
    boxSurface[n] = surfaceCode(surface)
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
    // Absurdly tall: a container, or a mesh with instances parked below the
    // world. Either way, look at its parts instead.
    if (sy > o.maxHeight) return 2
    if (sx <= o.maxSpan && sz <= o.maxSpan) return 1
    // Wide. A thin wide box is a deck or a roof and stays one collider; a wide
    // *tall* box is a district container and has to be broken up.
    if (sy <= o.slabY && sx <= o.hugeSpan && sz <= o.hugeSpan) return 1
    return 2
  }

  /* ---- oversized leaves --------------------------------------------------*/

  /* The grid splitLeaf() is currently binning into. Shared with sgVisit so the
   * traversal callback is built once, not once per mesh. */
  let sgX0 = 0
  let sgZ0 = 0
  let sgSizeX = 1
  let sgSizeZ = 1
  let sgNX = 1
  let sgNZ = 1
  let sgFloor = -Infinity
  let sgCeiling = Infinity

  /**
   * Bin one solid world-space AABB into the leaf grid: X and Z clipped to each
   * cell it covers, Y taken whole. Geometry outside the pedestrian band is
   * dropped here, which is what keeps instances parked at y = -9000 from
   * dragging a cell a kilometre down.
   */
  function splatSolid(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
  ): void {
    if (!(maxY > sgFloor) || minY >= sgCeiling) return
    const y0 = minY < sgFloor ? sgFloor : minY
    let ix0 = Math.floor((minX - sgX0) / sgSizeX)
    let ix1 = Math.floor((maxX - sgX0) / sgSizeX)
    let iz0 = Math.floor((minZ - sgZ0) / sgSizeZ)
    let iz1 = Math.floor((maxZ - sgZ0) / sgSizeZ)
    if (ix1 < 0 || iz1 < 0 || ix0 > sgNX - 1 || iz0 > sgNZ - 1) return
    if (ix0 < 0) ix0 = 0
    if (iz0 < 0) iz0 = 0
    if (ix1 > sgNX - 1) ix1 = sgNX - 1
    if (iz1 > sgNZ - 1) iz1 = sgNZ - 1
    for (let iz = iz0; iz <= iz1; iz++) {
      const lz0 = sgZ0 + iz * sgSizeZ
      const lz1 = lz0 + sgSizeZ
      const z0 = minZ > lz0 ? minZ : lz0
      const z1 = maxZ < lz1 ? maxZ : lz1
      for (let ix = ix0; ix <= ix1; ix++) {
        const lx0 = sgX0 + ix * sgSizeX
        const lx1 = lx0 + sgSizeX
        const x0 = minX > lx0 ? minX : lx0
        const x1 = maxX < lx1 ? maxX : lx1
        const c = iz * SPLIT_MAX + ix
        if (x0 < _cMinX[c]) _cMinX[c] = x0
        if (x1 > _cMaxX[c]) _cMaxX[c] = x1
        if (y0 < _cMinY[c]) _cMinY[c] = y0
        if (maxY > _cMaxY[c]) _cMaxY[c] = maxY
        if (z0 < _cMinZ[c]) _cMinZ[c] = z0
        if (z1 > _cMaxZ[c]) _cMaxZ[c] = z1
      }
    }
  }

  /** One mesh of the leaf being split, triangle by triangle. */
  const sgVisit = (child: THREE.Object3D): void => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !materialIsRendered(mesh.material)) return
    const geo = mesh.geometry
    if (!geo) return
    const inst = child as THREE.InstancedMesh
    if (inst.isInstancedMesh) {
      if (!geo.boundingBox) geo.computeBoundingBox()
      const bb = geo.boundingBox
      if (!bb || bb.isEmpty()) return
      const count = inst.count < SPLIT_INSTANCE_CAP ? inst.count : SPLIT_INSTANCE_CAP
      for (let i = 0; i < count; i++) {
        inst.getMatrixAt(i, _mat)
        _mat.premultiply(inst.matrixWorld)
        _sub.copy(bb).applyMatrix4(_mat)
        splatSolid(_sub.min.x, _sub.min.y, _sub.min.z, _sub.max.x, _sub.max.y, _sub.max.z)
      }
      return
    }
    const pos = geo.getAttribute('position')
    const index = geo.index
    const count = index ? index.count : pos ? pos.count : 0
    if (!pos || count < 3 || count > SPLIT_INDEX_CAP) {
      // No triangles to read, or too many to be worth reading: bin the mesh's
      // own box. Still cell-clipped, so it is never one district-wide wall.
      _sub.setFromObject(mesh)
      if (!_sub.isEmpty()) {
        splatSolid(_sub.min.x, _sub.min.y, _sub.min.z, _sub.max.x, _sub.max.y, _sub.max.z)
      }
      return
    }
    const m = mesh.matrixWorld
    for (let i = 0; i + 2 < count; i += 3) {
      const a = index ? index.getX(i) : i
      const b = index ? index.getX(i + 1) : i + 1
      const c = index ? index.getX(i + 2) : i + 2
      _va.fromBufferAttribute(pos, a).applyMatrix4(m)
      _vb.fromBufferAttribute(pos, b).applyMatrix4(m)
      _vc.fromBufferAttribute(pos, c).applyMatrix4(m)
      splatSolid(
        Math.min(_va.x, _vb.x, _vc.x),
        Math.min(_va.y, _vb.y, _vc.y),
        Math.min(_va.z, _vb.z, _vc.z),
        Math.max(_va.x, _vb.x, _vc.x),
        Math.max(_va.y, _vb.y, _vc.y),
        Math.max(_va.z, _vb.z, _vc.z),
      )
    }
  }

  /**
   * Subdivide an oversized object that recursion cannot help with — a merged
   * district mesh, or a container whose children all failed. Every cell is
   * re-classified, so an apron slab still fails minThickness.
   */
  function splitLeaf(obj: THREE.Object3D, o: Required<CollisionBuildOptions>, surface: Surface): void {
    visibleBounds(obj, _leaf)
    if (_leaf.isEmpty()) return
    const sx = _leaf.max.x - _leaf.min.x
    const sz = _leaf.max.z - _leaf.min.z
    if (!isFinite(sx) || !isFinite(sz) || sx <= EPS || sz <= EPS) return
    sgNX = Math.min(SPLIT_MAX, Math.max(1, Math.ceil(sx / SPLIT_TARGET)))
    sgNZ = Math.min(SPLIT_MAX, Math.max(1, Math.ceil(sz / SPLIT_TARGET)))
    sgX0 = _leaf.min.x
    sgZ0 = _leaf.min.z
    sgSizeX = sx / sgNX
    sgSizeZ = sz / sgNZ
    sgFloor = o.floor
    sgCeiling = o.ceiling
    for (let iz = 0; iz < sgNZ; iz++) {
      for (let ix = 0; ix < sgNX; ix++) {
        const c = iz * SPLIT_MAX + ix
        _cMinX[c] = Infinity
        _cMinY[c] = Infinity
        _cMinZ[c] = Infinity
        _cMaxX[c] = -Infinity
        _cMaxY[c] = -Infinity
        _cMaxZ[c] = -Infinity
      }
    }
    obj.traverseVisible(sgVisit)
    for (let iz = 0; iz < sgNZ; iz++) {
      for (let ix = 0; ix < sgNX; ix++) {
        const c = iz * SPLIT_MAX + ix
        if (_cMinX[c] > _cMaxX[c]) continue
        _box.min.set(_cMinX[c], _cMinY[c], _cMinZ[c])
        _box.max.set(_cMaxX[c], _cMaxY[c], _cMaxZ[c])
        if (classify(_box, o) === 1) pushBox(_box, o.pad, surface)
      }
    }
  }

  /**
   * An InstancedMesh is already an exact list of repeated solids. Keeping one
   * AABB for the whole batch fills every gap between instances; coarse leaf
   * cells still leave visible faces inside boxes the walker may start within.
   */
  function splitInstances(
    inst: THREE.InstancedMesh,
    o: Required<CollisionBuildOptions>,
    surface: Surface,
  ): boolean {
    if (inst.count <= 1 || inst.count > SPLIT_INSTANCE_CAP) return false
    const geo = inst.geometry
    if (!geo.boundingBox) geo.computeBoundingBox()
    const bb = geo.boundingBox
    if (!bb || bb.isEmpty()) return true
    for (let i = 0; i < inst.count; i++) {
      inst.getMatrixAt(i, _mat)
      _mat.premultiply(inst.matrixWorld)
      _sub.copy(bb).applyMatrix4(_mat)
      if (classify(_sub, o) === 1) pushBox(_sub, o.pad, surface)
    }
    return true
  }

  function addObject(
    obj: THREE.Object3D,
    depth: number,
    o: Required<CollisionBuildOptions>,
    surface: Surface,
  ): void {
    visibleBounds(obj, _box)
    if (_box.isEmpty()) return
    const verdict = classify(_box, o)
    if (verdict === 0) return

    const mesh = obj as THREE.Mesh
    const instanced = obj as THREE.InstancedMesh
    if (instanced.isInstancedMesh && splitInstances(instanced, o, surface)) return
    if (instanced.isInstancedMesh && instanced.count > 1) {
      const sx = _box.max.x - _box.min.x
      const sz = _box.max.z - _box.min.z
      // Preserve the bounded fallback for batches too large to expand exactly.
      if (sx > o.maxSpan || sz > o.maxSpan) {
        splitLeaf(obj, o, surface)
        return
      }
    }

    /*
     * A valid standing point can lie inside a compound root's loose AABB while
     * remaining outside every rendered child. The sweep deliberately permits
     * escape from containing boxes, so retaining that root box makes internal
     * walls unreachable. Children are the collision ownership boundary.
     */
    let visitedChildren = false
    if (!mesh.isMesh && depth < o.maxDepth && obj.children.length > 0) {
      visitedChildren = true
      const before = n
      const kids = obj.children
      for (let i = 0; i < kids.length; i++) addObject(kids[i], depth + 1, o, surface)
      if (n > before) return
      visibleBounds(obj, _box)
      if (_box.isEmpty()) return
    }

    if (verdict === 1) {
      pushBox(_box, o.pad, surface)
      return
    }
    if (!visitedChildren && depth < o.maxDepth && obj.children.length > 0) {
      const before = n
      const kids = obj.children
      for (let i = 0; i < kids.length; i++) addObject(kids[i], depth + 1, o, surface)
      if (n > before) return
    }
    // Nothing underneath to look at — a merged mesh, a container of decals, or
    // the depth limit. Dropping it here is what let the owner walk through nine
    // landmark districts.
    splitLeaf(obj, o, surface)
  }

  function build(source: ComponentSource, opts: CollisionBuildOptions = {}): void {
    const o: Required<CollisionBuildOptions> = {
      excludeIds: opts.excludeIds ?? DEFAULT_EXCLUDE_IDS,
      excludeDistricts: opts.excludeDistricts ?? [],
      maxSpan: opts.maxSpan ?? DEFAULTS.maxSpan,
      slabY: opts.slabY ?? DEFAULTS.slabY,
      maxHeight: opts.maxHeight ?? DEFAULTS.maxHeight,
      hugeSpan: opts.hugeSpan ?? DEFAULTS.hugeSpan,
      minThickness: opts.minThickness ?? DEFAULTS.minThickness,
      ceiling: opts.ceiling ?? DEFAULTS.ceiling,
      floor: opts.floor ?? DEFAULTS.floor,
      maxDepth: opts.maxDepth ?? DEFAULTS.maxDepth,
      pad: opts.pad ?? DEFAULTS.pad,
      cell: opts.cell ?? DEFAULTS.cell,
    }
    activeBuildOptions = o
    cell = o.cell > 1 ? o.cell : DEFAULTS.cell
    n = 0

    const skipId = new Set(o.excludeIds)
    const skipDistrict = new Set<DistrictId>(o.excludeDistricts)

    const all = source.all()
    // A component that lives inside one already boxed is the same mass twice:
    // the 16 backend towers arrive once as `backend.row`'s children and again
    // as `backend.N`. Duplicates cost candidate work in the busiest cells.
    const boxed = new Set<THREE.Object3D>()
    for (let i = 0; i < all.length; i++) {
      const def = all[i]
      if (skipId.has(def.id)) continue
      if (skipDistrict.has(def.district)) continue
      let ancestor: THREE.Object3D | null = def.object
      let duplicate = false
      while (ancestor) {
        if (boxed.has(ancestor)) {
          duplicate = true
          break
        }
        ancestor = ancestor.parent
      }
      if (duplicate) continue
      def.object.updateWorldMatrix(true, false)
      const before = n
      addObject(def.object, 0, o, def.id === 'shmem.deck' ? 'deck' : 'metal')
      // Only a component that actually produced colliders may shadow its
      // descendants; one that was dropped entirely must not silently take
      // theirs with it.
      if (n > before) boxed.add(def.object)
    }
    rebuildGrid()
  }

  function addBox(b: THREE.Box3, surface: Surface = 'metal'): void {
    if (b.isEmpty()) return
    pushBox(b, 0, surface)
    rebuildGrid()
  }

  function addSolid(obj: THREE.Object3D, surface: Surface = 'metal'): void {
    obj.updateWorldMatrix(true, false)
    addObject(obj, 0, activeBuildOptions, surface)
    rebuildGrid()
  }

  function addPublished(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const solids = obj.userData.collisionSolids as THREE.Object3D[] | undefined
      if (solids) {
        for (let i = 0; i < solids.length; i++) {
          solids[i].updateWorldMatrix(true, false)
          addObject(solids[i], 0, activeBuildOptions, 'metal')
        }
      }
      const boxes = obj.userData.collisionBoxes as THREE.Box3[] | undefined
      if (boxes) {
        for (let i = 0; i < boxes.length; i++) pushBox(boxes[i], 0, 'metal')
      }
    })
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
    let bestSurface: Surface = 'ground'
    // Normal of `best`, kept as three scalars so nothing has to be copied.
    let bnx = 0
    let bny = 1
    let bnz = 0

    // (a) tops of the static boxes directly under the point
    if (n > 0) {
      queryRect(p.x, p.z, p.x, p.z)
      for (let i = 0; i < candN; i++) {
        const o = cand[i] * 6
        if (p.x < data[o] || p.x > data[o + 3]) continue
        if (p.z < data[o + 2] || p.z > data[o + 5]) continue
        const top = data[o + 4]
        if (top >= lo && top <= hi && top > best) {
          best = top
          bestSurface = SURFACES[boxSurface[cand[i]]]
          // An AABB lid is flat by construction. Always walkable.
          bnx = 0
          bny = 1
          bnz = 0
        }
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
        if (y > best) {
          best = y
          const obj = _hits[i].object
          let hit = obj as THREE.Object3D | null
          while (hit) {
            const walkable = walkables.indexOf(hit)
            if (walkable >= 0) {
              bestSurface = walkableSurfaces[walkable]
              break
            }
            hit = hit.parent
          }
          // Face normal into world space. A slope is only a slope if someone
          // measures it; without this the walker climbs vertical faces.
          const face = _hits[i].face
          if (face) {
            _normalMat.getNormalMatrix(obj.matrixWorld)
            _normal.copy(face.normal).applyNormalMatrix(_normalMat).normalize()
            // A plane hit from above reports whichever winding it has; the
            // upward-facing version of the same plane is what we want.
            const s = _normal.y < 0 ? -1 : 1
            bnx = _normal.x * s
            bny = _normal.y * s
            bnz = _normal.z * s
          } else {
            bnx = 0
            bny = 1
            bnz = 0
          }
        }
        break
      }
      _hits.length = 0
    }

    if (best !== -Infinity) {
      groundSurface = bestSurface
      groundNormal.set(bnx, bny, bnz)
    }
    return best === -Infinity ? null : best
  }

  function solidNear(x: number, z: number, radius: number): boolean {
    if (n === 0 || radius <= 0) return false
    queryRect(x - radius, z - radius, x + radius, z + radius)
    const r2 = radius * radius
    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      if (data[o + 4] < NEAR_FLOOR) continue
      if (data[o + 1] > NEAR_CEILING) continue
      const dx = x < data[o] ? data[o] - x : x > data[o + 3] ? x - data[o + 3] : 0
      const dz = z < data[o + 2] ? data[o + 2] - z : z > data[o + 5] ? z - data[o + 5] : 0
      if (dx * dx + dz * dz <= r2) return true
    }
    return false
  }

  function occluded(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    if (dx * dx + dy * dy + dz * dz <= EPS * EPS || n === 0) return false

    queryRect(
      from.x < to.x ? from.x : to.x,
      from.z < to.z ? from.z : to.z,
      from.x > to.x ? from.x : to.x,
      from.z > to.z ? from.z : to.z,
    )

    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      let enter = 0
      let exit = 1

      if (Math.abs(dx) < EPS) {
        if (from.x < data[o] || from.x > data[o + 3]) continue
      } else {
        let a = (data[o] - from.x) / dx
        let b = (data[o + 3] - from.x) / dx
        if (a > b) {
          const swap = a
          a = b
          b = swap
        }
        if (a > enter) enter = a
        if (b < exit) exit = b
        if (enter > exit) continue
      }

      if (Math.abs(dy) < EPS) {
        if (from.y < data[o + 1] || from.y > data[o + 4]) continue
      } else {
        let a = (data[o + 1] - from.y) / dy
        let b = (data[o + 4] - from.y) / dy
        if (a > b) {
          const swap = a
          a = b
          b = swap
        }
        if (a > enter) enter = a
        if (b < exit) exit = b
        if (enter > exit) continue
      }

      if (Math.abs(dz) < EPS) {
        if (from.z < data[o + 2] || from.z > data[o + 5]) continue
      } else {
        let a = (data[o + 2] - from.z) / dz
        let b = (data[o + 5] - from.z) / dz
        if (a > b) {
          const swap = a
          a = b
          b = swap
        }
        if (a > enter) enter = a
        if (b < exit) exit = b
        if (enter > exit) continue
      }

      // Starting inside a box is not a useful line-of-sight blocker. Likewise,
      // a box containing the endpoint is the labelled component itself.
      if (enter > EPS && enter < 1 - EPS && exit < 1 - EPS) return true
    }
    return false
  }

  /** Earliest contact of one XZ segment against the candidate boxes. */
  function sweepTime(
    x: number,
    z: number,
    dx: number,
    dz: number,
    radius: number,
    wallY: number,
    headY: number,
  ): number {
    _sweepHitX = false
    _sweepHitZ = false
    let best = 2
    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      if (data[o + 4] <= wallY) continue
      if (data[o + 1] >= headY) continue

      const minX = data[o] - radius
      const maxX = data[o + 3] + radius
      const minZ = data[o + 2] - radius
      const maxZ = data[o + 5] + radius
      // Escape is always allowed when a spawn or a moving object left the
      // capsule inside a box. Only strict containment counts; contact does not.
      if (x > minX + EPS && x < maxX - EPS && z > minZ + EPS && z < maxZ - EPS) continue

      let nearX = -Infinity
      let farX = Infinity
      if (Math.abs(dx) < EPS) {
        if (x < minX || x > maxX) continue
      } else {
        nearX = (minX - x) / dx
        farX = (maxX - x) / dx
        if (nearX > farX) {
          const swap = nearX
          nearX = farX
          farX = swap
        }
      }

      let nearZ = -Infinity
      let farZ = Infinity
      if (Math.abs(dz) < EPS) {
        if (z < minZ || z > maxZ) continue
      } else {
        nearZ = (minZ - z) / dz
        farZ = (maxZ - z) / dz
        if (nearZ > farZ) {
          const swap = nearZ
          nearZ = farZ
          farZ = swap
        }
      }

      const enter = nearX > nearZ ? nearX : nearZ
      const exit = farX < farZ ? farX : farZ
      if (enter > exit || exit < 0 || enter < -EPS || enter > 1) continue
      const hitX = nearX >= nearZ - EPS
      const hitZ = nearZ >= nearX - EPS
      if (enter < best - EPS) {
        best = enter < 0 ? 0 : enter
        _sweepHitX = hitX
        _sweepHitZ = hitZ
      } else if (Math.abs(enter - best) <= EPS) {
        _sweepHitX ||= hitX
        _sweepHitZ ||= hitZ
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

    let x = from.x
    let z = from.z
    let dx = to.x - from.x
    let dz = to.z - from.z
    // Contact, then sweep the remaining tangent. Three passes resolve both
    // faces of a corner without distance-dependent tunnelling.
    for (let pass = 0; pass < 3 && (Math.abs(dx) > EPS || Math.abs(dz) > EPS); pass++) {
      const contact = sweepTime(x, z, dx, dz, radius, wallY, headY)
      if (contact > 1) {
        x += dx
        z += dz
        break
      }
      x += dx * contact
      z += dz * contact
      const remain = 1 - contact
      out.hitX ||= _sweepHitX
      out.hitZ ||= _sweepHitZ
      dx = _sweepHitX ? 0 : dx * remain
      dz = _sweepHitZ ? 0 : dz * remain
    }
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

    /* A kerb that lives on a walkable MESH rather than a box has no top face in
     * the set above, so ask the ground query for one — but only when something
     * actually stopped us, because that is a raycast and this runs five times a
     * frame. Open-field walking pays nothing. */
    if (out.blocked && walkables.length > 0) {
      savedSurface = groundSurface
      savedNormal.copy(groundNormal)
      _step.set(x, feet + stepHeight, z)
      const g = groundAt(_step, stepHeight)
      groundSurface = savedSurface
      groundNormal.copy(savedNormal)
      if (g !== null) {
        const rise = g - feet
        if (rise > EPS && rise <= stepHeight && rise > lift) lift = rise
      }
    }

    // …and never lift someone into a ceiling. The old code raised the feet
    // unconditionally, which is how you stand up inside a slab.
    if (lift > 0 && !headroom(x, z, feet + lift, radius, height)) lift = 0

    out.stepped = lift
    out.position.set(x, to.y + lift, z)
    return out
  }

  /** Is the capsule band [footY, footY + height] clear of boxes at this XZ? */
  function headroom(x: number, z: number, footY: number, radius: number, height: number): boolean {
    queryRect(x - radius, z - radius, x + radius, z + radius)
    const top = footY + height
    for (let i = 0; i < candN; i++) {
      const o = cand[i] * 6
      if (x + radius <= data[o] || x - radius >= data[o + 3]) continue
      if (z + radius <= data[o + 2] || z - radius >= data[o + 5]) continue
      // The box being stepped ONTO ends exactly at footY; it is the floor.
      if (data[o + 4] > footY + STEP_EPS && data[o + 1] < top - STEP_EPS) return false
    }
    return true
  }

  /* ---- walkables ---------------------------------------------------------*/

  function addWalkable(obj: THREE.Object3D, surface: Surface = 'ground'): void {
    const i = walkables.indexOf(obj)
    if (i >= 0) {
      walkableSurfaces[i] = surface
      return
    }
    walkables.push(obj)
    walkableSurfaces.push(surface)
  }
  function removeWalkable(obj: THREE.Object3D): void {
    const i = walkables.indexOf(obj)
    if (i >= 0) {
      walkables.splice(i, 1)
      walkableSurfaces.splice(i, 1)
    }
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
    groundSurface = 'ground'
    groundNormal.set(0, 1, 0)
    debugStale = true
  }

  function dispose(): void {
    clear()
    walkables.length = 0
    walkableSurfaces.length = 0
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
    addSolid,
    addPublished,
    addWalkable,
    removeWalkable,
    groundAt,
    get groundSurface(): Surface {
      return groundSurface
    },
    groundNormal,
    solidNear,
    occluded,
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
