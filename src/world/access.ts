import * as THREE from 'three'
import { COLOR } from '../core/theme'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { BUFFER_POOL_GATES, CITY, ROUTES, routeCurve } from './layout'
import type { BufferPoolGate } from './layout'
import { markTextPlane, markTextTexture } from './text-plane'

/* ============================================================================
 * THE ACCESS DISTRICT — how a person on foot gets anywhere.
 *
 * PGSimCity was laid out for a camera, and a camera can fly. A body cannot. A
 * survey of 4,600 world-space boxes found the city unwalkable for three
 * separate reasons, none of which is a step:
 *
 *   1. THE PLAZA IS AN ISLAND. The ground plate is cut away over CITY.pit, so
 *      the nearest solid ground is 40 m east/west and 42 m north/south of the
 *      deck edge, across a 52 m void. Not a step problem — a bridge problem.
 *   2. THE EXCAVATION HAS NO ROUTE IN OR OUT. 52 m of sheer wall, four times.
 *   3. THE DISTRICT PLINTHS ARE 0.60 m WITH A VERTICAL FACE, which is above the
 *      0.45 m step-up a walker gets, so every district is a walled compound.
 *
 * So this module builds, in one readable place, everything a pedestrian needs:
 *
 *   FOUR RAMPED CAUSEWAYS   1:14 to 1:16 clear-span trusses from solid ground
 *                           onto the plaza deck, one per side, each landing in
 *                           a gap opened in the deck railing (DECK_GATES, which
 *                           shmem.ts reads) and announced by a gate portal.
 *   THE DESCENT             a seven-flight switchback stair down the north-east
 *                           aisle of the excavation, ground level to the
 *                           data-directory floor at y = -52.
 *   THE RIM PARAPET         888 m of 0.9 m wall around the excavation, where
 *                           today there is a 52 m drop and a 0.07 m neon line.
 *   FIVE KERB RAMPS         one per district plinth.
 *   WAYFINDING              painted route lines on the ground in the colours
 *                           the legend already teaches, fingerposts at every
 *                           causeway head, named gates, and a sign on the
 *                           excavation floor telling you what is above you.
 *
 * WHY A SEPARATE MODULE. ground.ts owns the pit and shmem.ts owns the deck.
 * Access spans both and belongs to neither, and a pedestrian reading the source
 * should find every piece of their infrastructure in one file.
 *
 * ── THE COLLISION CONTRACT ──────────────────────────────────────────────────
 * engine/collision.ts answers two questions: what is under my feet (a ray cast
 * against registered *walkables*, plus the tops of static boxes) and what stops
 * me (static boxes only). So this module publishes two things:
 *
 *   walkables   meshes the ground ray may hit. Slopes have to be raycast — an
 *               axis-aligned box cannot be tilted — so every ramp, stair flight
 *               and landing lives here, merged into as few meshes as possible
 *               because that ray is cast sixty times a second.
 *   blockers    axis-aligned boxes for everything a walker must not pass
 *               through: handrails, the parapet, portal columns. Sloped rails
 *               are cut into short segments so their collider hugs the ramp
 *               instead of boxing the whole air column above it.
 *
 * Nothing here is registered as a component, on purpose: the collision world
 * derives its static boxes from the component registry, and a registered
 * causeway would become one 44 x 3 x 7 m box — a wall across its own ramp.
 *
 * Everything is built once. update() does no work and allocates nothing.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * The contract with shmem.ts: where the deck railing opens.
 * -------------------------------------------------------------------------*/

export type DeckGate = BufferPoolGate

/**
 * The deck railing is otherwise continuous: 84 posts on a 7.56 m (north/south)
 * and 7.45 m (east/west) pitch, plus four full-length top rails. Every gate
 * centre below sits between two posts, so exactly ONE post in the whole plaza
 * is deleted — the one at x = 0 on the north rail, where the backend approach
 * lands on the city's axis. The rest become the gate jambs.
 */
export const DECK_GATES: readonly DeckGate[] = BUFFER_POOL_GATES

/* ---------------------------------------------------------------------------
 * Human scale. Every number here is a dimension a walker can check against
 * their own body, because these are the objects that tell them how big the
 * rest of the city is.
 * -------------------------------------------------------------------------*/

/** Clear width of a causeway between its kerbs. Two people and a handcart. */
const WAY_W = 6.8
/** Structural depth of the causeway deck slab. */
const WAY_T = 0.36
/** Kerb: high enough to feel underfoot, low enough to step over. */
const KERB_H = 0.12
const KERB_W = 0.16
/** Handrail: 1.10 m to the top rail is the height a hand actually falls on. */
const RAIL_H = 1.1
const RAIL_POST = 0.11
/** Post pitch — close enough that the rail reads as a barrier, not a suggestion. */
const RAIL_PITCH = 2.55
/** Truss depth below the walking surface. Span/depth ≈ 19 over the 42 m spans. */
const TRUSS_D = 2.2

/** 0.1728 m riser on a 0.3721 m going: 2R + G = 0.72, a comfortable stair. */
const N_FLIGHTS = 7
const TREADS_PER_FLIGHT = 43
const STAIR_W = 3.6

/** Pit-rim parapet: chest height on a 1.8 m body. */
const PARAPET_H = 0.9
const PARAPET_T = 0.25

/**
 * The plaza deck stacks four surfaces within 8 cm: cap top 3.00 (which is what
 * the collision world calls the floor), printed plan 3.05, plaza haze sheet
 * 3.06, "SHARED MEMORY" floor decal 3.08. A causeway landing has to arrive
 * above all of them or it vanishes under the paint, so it lands at 3.10 and
 * gives the last 10 cm back on a threshold wedge you cannot feel.
 */
const DECK_TOP = CITY.deck.top
const LAND_Y = DECK_TOP + 0.1
/** Paving sits a hair above the ground plate so the two never z-fight. */
const PAVE_Y = 0.02
/** District plinths are 0.60 m; their paving sits 0.02 above that. */
const PLINTH_Y = 0.62

/* ---------------------------------------------------------------------------
 * The plan.
 * -------------------------------------------------------------------------*/

type Axis = 'x' | 'z'

interface CausewaySpec {
  id: string
  side: DeckGate['side']
  /** The axis the causeway runs along. */
  axis: Axis
  /** Centre line on the other horizontal axis. */
  centre: number
  /** Ground end: where the span springs from. */
  outer: number
  /** Deck end. */
  inner: number
  /** Walking height at the ground end. */
  yOuter: number
  /** How far the head platform reaches back onto solid ground. */
  headDepth: number
  /** 'plinth' heads sit 0.60 m up and get kerb ramps down to the rim ledge. */
  headOn: 'ground' | 'plinth'
  /** Where this causeway goes, for the fingerpost and the gate sign. */
  name: string
  color: number
}

/**
 * Four approaches. East and west are NOT mirror images: the west line dodges
 * the checkpointer's apron (x -159…-121, z -61…-19) and the proc_array pad on
 * the deck (z -57.5…-30.5); the east line dodges the wal_writer's base
 * (x 122…146, z -47…-21), the wal_buffers ring (x 54.5…77.5, z ±11.5) and the
 * stats pad (z 40.75…47.25). Every landing sits in a measured clear corridor
 * and every gate centre sits between two surviving railing posts.
 */
const CAUSEWAYS: readonly CausewaySpec[] = [
  {
    id: 'north', side: 'north', axis: 'z', centre: 0,
    outer: -106, inner: -CITY.deck.d / 2, yOuter: PAVE_Y,
    headDepth: 5, headOn: 'ground', name: 'BACKENDS', color: COLOR.backend,
  },
  {
    id: 'south', side: 'south', axis: 'z', centre: 3.78,
    outer: 106, inner: CITY.deck.d / 2, yOuter: PAVE_Y,
    headDepth: 5, headOn: 'ground', name: 'STANDBY', color: COLOR.replication,
  },
  {
    id: 'east', side: 'east', axis: 'x', centre: 26.075,
    outer: CITY.pit.x, inner: CITY.deck.w / 2, yOuter: PLINTH_Y,
    headDepth: 8, headOn: 'plinth', name: 'pg_wal', color: COLOR.wal,
  },
  {
    id: 'west', side: 'west', axis: 'x', centre: -11.175,
    outer: -CITY.pit.x, inner: -CITY.deck.w / 2, yOuter: PLINTH_Y,
    headDepth: 8, headOn: 'plinth', name: 'MAINTENANCE', color: COLOR.vacuum,
  },
]

/**
 * The descent. The north-east aisle of the excavation: east of the `sessions`
 * warehouse (x 42…62) and its conduit (x 61.5…63), west of `documents`
 * (x 94…114) and its conduit (x 93…94.5), north of the OS page cache (|z| < 80)
 * and south of the disk array (z < -94.5). A probe over the whole footprint
 * returns nothing at all between y = -50 and y = +8 — the aisle is empty from
 * the data-directory floor to the sky, which is exactly what a stair needs.
 */
const STAIR = {
  /** Landing towers; flights run between them along x. */
  westX: 70,
  eastX: 86,
  landing: 5,
  /** The two flight lanes. */
  laneA: -92,
  laneB: -88,
  zLo: -94,
  zHi: -86,
  /** Entry gangway from the rim. */
  gangX: 89,
  gangW: 5,
  topY: PAVE_Y,
  floorY: CITY.storage.y,
} as const

const FLIGHT_RISE = (STAIR.topY - STAIR.floorY) / N_FLIGHTS
const TREAD_RISE = FLIGHT_RISE / TREADS_PER_FLIGHT

interface PlinthRamp {
  id: string
  /** Position on the axis the ramp is *not* running along. */
  centre: number
  /** Ground end and plinth end. */
  from: number
  to: number
  name: string
  color: number
}

/**
 * One kerb ramp per district plinth, each on solid ground outside the
 * excavation and clear of that district's buildings. All five run north–south
 * because that is where each plinth's free edge is.
 */
const PLINTH_RAMPS: readonly PlinthRamp[] = [
  { id: 'backends', centre: 16, from: -106.5, to: -114, name: 'BACKENDS', color: COLOR.backend },
  { id: 'wal', centre: 150, from: -95.5, to: -88, name: 'pg_wal', color: COLOR.wal },
  { id: 'maintenance', centre: -170, from: -73.5, to: -66, name: 'MAINTENANCE', color: COLOR.vacuum },
  { id: 'replication', centre: 120, from: 146.5, to: 154, name: 'STANDBY', color: COLOR.replication },
  { id: 'clients', centre: 0, from: -236.5, to: -244, name: 'CLIENTS', color: COLOR.client },
]

/**
 * The five district plinths, exactly as ground.ts clips them to solid ground.
 * Used only to drop the painted routes onto the right surface.
 */
const PLINTH_RECTS: readonly [number, number, number, number][] = [
  [-116, 116, -356, -244],  // clients
  [-120, 120, -146, -114],  // backends
  [121, 264, -88, 116],     // wal
  [-252, -121, -66, 106],   // maintenance
  [44, 276, 154, 346],      // replication
]

/* ---------------------------------------------------------------------------
 * Build-time geometry helpers. None of this runs after boot.
 * -------------------------------------------------------------------------*/

const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _mat = new THREE.Matrix4()
const _nrm = new THREE.Matrix3()
const _axisY = new THREE.Vector3(0, 1, 0)
const _axisX = new THREE.Vector3(1, 0, 0)
const _axisZ = new THREE.Vector3(0, 0, 1)
const _dir = new THREE.Vector3()
const _col = new THREE.Color()

/**
 * A list of instance matrices that becomes one InstancedMesh. The access
 * district is described as parts, not meshes, so all of it costs six draw
 * calls.
 */
class Batch {
  private readonly m: number[] = []

  /** Axis-aligned box, by centre and size. */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    _pos.set(x, y, z)
    _quat.identity()
    _scale.set(sx, sy, sz)
    _mat.compose(_pos, _quat, _scale)
    for (let i = 0; i < 16; i++) this.m.push(_mat.elements[i])
  }

  /** A bar between two points, `t` x `t2` in section. */
  bar(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, t: number, t2 = t): void {
    _dir.set(x1 - x0, y1 - y0, z1 - z0)
    const len = _dir.length()
    if (len < 1e-6) return
    _dir.multiplyScalar(1 / len)
    _pos.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    _quat.setFromUnitVectors(_axisY, _dir)
    _scale.set(t, len, t2)
    _mat.compose(_pos, _quat, _scale)
    for (let i = 0; i < 16; i++) this.m.push(_mat.elements[i])
  }

  get count(): number {
    return this.m.length / 16
  }

  build(geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.InstancedMesh | null {
    const n = this.count
    if (n === 0) return null
    const mesh = new THREE.InstancedMesh(geo, mat, n)
    const a = mesh.instanceMatrix.array as Float32Array
    for (let i = 0; i < n * 16; i++) a[i] = this.m[i]
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor = null
    mesh.castShadow = false
    mesh.receiveShadow = false
    mesh.name = name
    mesh.raycast = () => {}
    return mesh
  }
}

/**
 * Walking surfaces, merged into one geometry. They have to be real triangles,
 * because collision.ts finds the ground by raycasting them; they have to be one
 * mesh, because that raycast runs every frame. Boxes are cloned from a template
 * BoxGeometry so the winding and the normals are three's, not mine.
 */
class SurfaceMesh {
  private static readonly TEMPLATE = new THREE.BoxGeometry(1, 1, 1)
  private readonly pos: number[] = []
  private readonly nrm: number[] = []
  private readonly idx: number[] = []

  private pushBox(): void {
    const t = SurfaceMesh.TEMPLATE
    const tp = t.attributes.position.array as Float32Array
    const tn = t.attributes.normal.array as Float32Array
    const ti = t.index!.array as ArrayLike<number>
    const base = this.pos.length / 3
    _nrm.getNormalMatrix(_mat)
    for (let i = 0; i < tp.length; i += 3) {
      _pos.set(tp[i], tp[i + 1], tp[i + 2]).applyMatrix4(_mat)
      this.pos.push(_pos.x, _pos.y, _pos.z)
      _dir.set(tn[i], tn[i + 1], tn[i + 2]).applyMatrix3(_nrm).normalize()
      this.nrm.push(_dir.x, _dir.y, _dir.z)
    }
    for (let i = 0; i < ti.length; i++) this.idx.push(base + ti[i])
  }

  /** A flat slab; `y` is the height of its TOP face. */
  flat(x0: number, x1: number, z0: number, z1: number, y: number, t: number): void {
    _pos.set((x0 + x1) / 2, y - t / 2, (z0 + z1) / 2)
    _quat.identity()
    _scale.set(Math.abs(x1 - x0), t, Math.abs(z1 - z0))
    _mat.compose(_pos, _quat, _scale)
    this.pushBox()
  }

  /**
   * A ramp whose TOP face runs from (a, yA) to (b, yB) along `axis`, `w` wide
   * about `centre`. The top face is what a ground ray hits, so it is placed
   * exactly and the slab hangs below it.
   */
  ramp(axis: Axis, a: number, b: number, yA: number, yB: number, centre: number, w: number, t: number): void {
    // Always run in the +axis direction. Rotating a box by more than 90° turns
    // its top face into its bottom face, which puts the walking surface a
    // thickness below where it belongs and drops the walker into the pit.
    if (b < a) {
      const su = a; a = b; b = su
      const sy = yA; yA = yB; yB = sy
    }
    const run = b - a
    const rise = yB - yA
    const len = Math.hypot(run, rise)
    if (len < 1e-6) return
    const ang = Math.atan2(rise, run)
    const midU = (a + b) / 2
    const midY = (yA + yB) / 2
    const dropU = (t / 2) * Math.sin(ang)
    const dropY = (t / 2) * Math.cos(ang)
    if (axis === 'x') {
      _pos.set(midU + dropU, midY - dropY, centre)
      _quat.setFromAxisAngle(_axisZ, ang)
      _scale.set(len, t, w)
    } else {
      _pos.set(centre, midY - dropY, midU + dropU)
      _quat.setFromAxisAngle(_axisX, -ang)
      _scale.set(w, t, len)
    }
    _mat.compose(_pos, _quat, _scale)
    this.pushBox()
  }

  get empty(): boolean {
    return this.idx.length === 0
  }

  build(mat: THREE.Material, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3))
    g.setIndex(this.idx)
    g.computeBoundingBox()
    g.computeBoundingSphere()
    const mesh = new THREE.Mesh(g, mat)
    mesh.name = name
    mesh.castShadow = false
    mesh.receiveShadow = false
    return mesh
  }
}

/* ---------------------------------------------------------------------------
 * Signage. Text is the one thing here that cannot be instanced, so it is
 * atlased instead: every sign in the district on one canvas, one draw call.
 * -------------------------------------------------------------------------*/

const SIGN_W = 512
const SIGN_ROW = 64
const SIGN_ROWS = 40
const SIGN_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

type Facing = '+x' | '-x' | '+z' | '-z'
const FACE_R: Record<Facing, [number, number, number]> = {
  '+x': [0, 0, -1], '-x': [0, 0, 1], '+z': [1, 0, 0], '-z': [-1, 0, 0],
}
const FACE_N: Record<Facing, [number, number, number]> = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
}

class SignAtlas {
  private readonly canvas = document.createElement('canvas')
  private readonly c2d: CanvasRenderingContext2D | null
  readonly texture: THREE.CanvasTexture
  private row = 0
  private quads = 0
  /** One row per distinct string: every sign is read from both sides, and half
   *  the district names appear three times. */
  private readonly rows = new Map<string, [number, number]>()
  private readonly p: number[] = []
  private readonly uv: number[] = []
  private readonly col: number[] = []
  private readonly idx: number[] = []
  private readonly planes: {
    text: string
    center: [number, number, number]
    normal: [number, number, number]
  }[] = []

  constructor() {
    this.canvas.width = SIGN_W
    this.canvas.height = SIGN_ROW * SIGN_ROWS
    this.c2d = this.canvas.getContext('2d')
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.anisotropy = 4
  }

  private draw(text: string): [number, number] {
    const hit = this.rows.get(text)
    if (hit) return hit
    const r = this.row
    if (r >= SIGN_ROWS) return [SIGN_ROWS - 1, 8]
    this.row++
    const c = this.c2d
    if (!c) {
      this.rows.set(text, [r, 8])
      return [r, 8]
    }
    const y0 = r * SIGN_ROW
    c.clearRect(0, y0, SIGN_W, SIGN_ROW)
    let size = 40
    c.font = `600 ${size}px ${SIGN_FONT}`
    let w = c.measureText(text).width
    if (w > SIGN_W - 16) {
      size = Math.max(10, Math.floor((size * (SIGN_W - 16)) / w))
      c.font = `600 ${size}px ${SIGN_FONT}`
      w = c.measureText(text).width
    }
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#ffffff'
    c.fillText(text, SIGN_W / 2, y0 + SIGN_ROW / 2)
    this.texture.needsUpdate = true
    const out: [number, number] = [r, Math.max(8, w)]
    this.rows.set(text, out)
    return out
  }

  /** How many of the atlas's rows are spoken for. */
  get used(): number {
    return this.row
  }

  /**
   * One line of text, `h` metres tall, centred on (x,y,z) and facing `facing`.
   * `lift` pushes the quad off the plate it is painted on — a sign board is a
   * real slab, and text buried inside it is text you cannot read.
   */
  plate(text: string, x: number, y: number, z: number, facing: Facing, h: number, color: number, bright = 1, lift = 0.012): void {
    const [row, w] = this.draw(text)
    const qw = (h * w) / SIGN_ROW
    const r = FACE_R[facing]
    const n = FACE_N[facing]
    const hw = qw / 2
    const hh = h / 2
    const u0 = 0.5 - w / (2 * SIGN_W)
    const u1 = 0.5 + w / (2 * SIGN_W)
    const v1 = 1 - row / SIGN_ROWS
    const v0 = 1 - (row + 1) / SIGN_ROWS
    _col.setHex(color).multiplyScalar(bright)
    const base = this.quads * 4
    const ox = x + n[0] * lift
    const oy = y + n[1] * lift
    const oz = z + n[2] * lift
    markTextTexture(this.texture, text)
    this.planes.push({ text, center: [ox, oy, oz], normal: [n[0], n[1], n[2]] })
    const corners: [number, number, number, number][] = [
      [-hw, -hh, u0, v0], [hw, -hh, u1, v0], [hw, hh, u1, v1], [-hw, hh, u0, v1],
    ]
    for (const [a, b, cu, cv] of corners) {
      this.p.push(ox + r[0] * a, oy + b, oz + r[2] * a)
      this.uv.push(cu, cv)
      this.col.push(_col.r, _col.g, _col.b)
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.quads++
  }

  /** The same line on both faces of a board — you have to read it coming and going. */
  plate2(text: string, x: number, y: number, z: number, a: Facing, b: Facing, h: number, color: number, bright = 1, lift = 0.012): void {
    this.plate(text, x, y, z, a, h, color, bright, lift)
    this.plate(text, x, y, z, b, h, color, bright, lift)
  }

  build(): THREE.Mesh | null {
    if (this.quads === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      toneMapped: false,
      // Front faces only: every plate is built with its normal pointing the way
      // it is meant to be read, and `plate2` adds the second face itself. Draw
      // both sides of one quad and the far side of a gate sign shows through
      // the near one, mirrored.
      side: THREE.FrontSide,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.name = 'access.signs'
    mesh.renderOrder = 5
    mesh.raycast = () => {}
    for (const plane of this.planes) {
      markTextPlane(mesh, plane.text, plane.center, plane.normal)
    }
    return mesh
  }
}

/* ---------------------------------------------------------------------------
 * Public shape.
 * -------------------------------------------------------------------------*/

/** What we need from collision.ts. Structural, so world/ never imports engine/. */
export interface CollisionSink {
  addWalkable(obj: THREE.Object3D, surface?: 'ground' | 'deck' | 'metal' | 'stair' | 'water'): void
  addBox(box: THREE.Box3, surface?: 'ground' | 'deck' | 'metal' | 'stair' | 'water'): void
}

export interface AccessModule extends WorldModule {
  /**
   * Surfaces the ground ray may hit: ramps, stair flights, landings. Hand each
   * one to `collision.addWalkable()`.
   */
  walkables: THREE.Object3D[]
  /** Solids a walker must not pass through. Hand each to `collision.addBox()`. */
  blockers: readonly THREE.Box3[]
  /** Both of the above in one call. */
  installCollision(sink: CollisionSink): void
}

export type AccessFactory = (ctx: WorldContext) => AccessModule

/* ==========================================================================*/

/**
 * Build the pedestrian infrastructure. Assignable to `WorldFactory`; the wider
 * return type is what lets main.ts hand the walkables to the collision world.
 */
export const createAccess: AccessFactory = (ctx: WorldContext): AccessModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'access'

  const owned: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }

  const blockers: THREE.Box3[] = []
  const surfaces = new SurfaceMesh()   // visible walking surfaces
  const stairPlane = new SurfaceMesh() // the stair's collision plane, not drawn
  const signs = new SignAtlas()

  /* --- materials: matte structure, neon meaning -------------------------- */

  const mDeck = theme.mat('access.deck', { color: 0x1b2434, roughness: 0.8, metalness: 0.22 })
  // Ramps terminate on host decks. They are a deliberate top coat there, so
  // give the shared walking surface a stable depth winner at each seam.
  mDeck.polygonOffset = true
  mDeck.polygonOffsetFactor = -1
  mDeck.polygonOffsetUnits = -1
  const mStruct = theme.mat('access.struct', { color: 0x121a29, roughness: 0.86, metalness: 0.2 })
  const mSteel = theme.mat('access.steel', { color: 0x27334a, roughness: 0.54, metalness: 0.44 })
  const mTread = theme.mat('access.tread', { color: 0x33415c, roughness: 0.6, metalness: 0.4 })
  const mRimPlaza = theme.neon(COLOR.shmem, 1.1)
  const mRimStore = theme.neon(COLOR.storage, 1.0)
  /**
   * The stair's walking plane. `material.visible = false` keeps it out of the
   * render list entirely while `object.visible` stays true, which is what the
   * ground ray needs: a walker glides down a 25° plane while seeing 301 real
   * treads pass under them.
   */
  const mHidden = keep(new THREE.MeshBasicMaterial())
  mHidden.visible = false

  const bStruct = new Batch()   // slabs, trusses, struts, parapet
  const bSteel = new Batch()    // rails, posts, portals, kerbs
  const bTread = new Batch()    // stair treads
  const bRimP = new Batch()     // indigo edge lines — the plaza's arms
  const bRimS = new Batch()     // green edge lines — the excavation

  /* --- small helpers ----------------------------------------------------- */

  const box3 = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    blockers.push(new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)))
  }

  /**
   * A run of handrail along an axis, following a slope. The collider is cut
   * into `seg`-metre pieces so a sloped rail hugs its ramp.
   */
  function railRun(axis: Axis, a: number, b: number, yA: number, yB: number, at: number, seg = 6): void {
    const len = Math.abs(b - a)
    if (len < 0.5) return
    const n = Math.max(1, Math.round(len / RAIL_PITCH))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const u = a + (b - a) * t
      const y = yA + (yB - yA) * t
      if (axis === 'x') bSteel.box(u, y + RAIL_H / 2, at, RAIL_POST, RAIL_H, RAIL_POST)
      else bSteel.box(at, y + RAIL_H / 2, u, RAIL_POST, RAIL_H, RAIL_POST)
    }
    for (const h of [RAIL_H, RAIL_H * 0.52]) {
      const t = h === RAIL_H ? 0.09 : 0.06
      if (axis === 'x') bSteel.bar(a, yA + h, at, b, yB + h, at, t)
      else bSteel.bar(at, yA + h, a, at, yB + h, b, t)
    }
    const k = Math.max(1, Math.round(len / seg))
    for (let i = 0; i < k; i++) {
      const u0 = a + ((b - a) * i) / k
      const u1 = a + ((b - a) * (i + 1)) / k
      const y0 = yA + ((yB - yA) * i) / k
      const y1 = yA + ((yB - yA) * (i + 1)) / k
      const lo = Math.min(y0, y1)
      const hi = Math.max(y0, y1) + RAIL_H
      if (axis === 'x') box3(Math.min(u0, u1), lo, at - 0.09, Math.max(u0, u1), hi, at + 0.09)
      else box3(at - 0.09, lo, Math.min(u0, u1), at + 0.09, hi, Math.max(u0, u1))
    }
  }

  /** A kerb, following a slope, with a neon line along its top edge. */
  function kerbRun(axis: Axis, a: number, b: number, yA: number, yB: number, at: number, neon: Batch): void {
    if (Math.abs(b - a) < 0.4) return
    if (axis === 'x') {
      bSteel.bar(a, yA + KERB_H / 2, at, b, yB + KERB_H / 2, at, KERB_W, KERB_H)
      neon.bar(a, yA + KERB_H, at, b, yB + KERB_H, at, KERB_W * 0.5, 0.05)
    } else {
      bSteel.bar(at, yA + KERB_H / 2, a, at, yB + KERB_H / 2, b, KERB_H, KERB_W)
      neon.bar(at, yA + KERB_H, a, at, yB + KERB_H, b, 0.05, KERB_W * 0.5)
    }
  }

  /**
   * A free-standing sign board on two posts, read from both sides. `span` is
   * the axis the board runs along; it faces the other one. Base at `y`, text at
   * 2.05 m — eye height for a 1.7 m walker at twenty paces.
   */
  function signBoard(
    text: string,
    x: number,
    y: number,
    z: number,
    span: Axis,
    w: number,
    color: number,
    readFrom?: Facing,
  ): void {
    const th = 0.44
    // 2.4 m of headroom under the board: it is a gantry over a footway, not a
    // beam to walk into.
    const top = y + 2.72
    const postH = top + th / 2 + 0.09 - y
    for (const s of [-1, 1]) {
      const px = span === 'x' ? x + s * (w / 2) : x
      const pz = span === 'z' ? z + s * (w / 2) : z
      bSteel.box(px, y + postH / 2, pz, 0.13, postH, 0.13)
      box3(px - 0.11, y, pz - 0.11, px + 0.11, y + postH, pz + 0.11)
    }
    if (span === 'x') {
      bSteel.box(x, top, z, w, th + 0.18, 0.12)
      bRimP.box(x, top - th / 2 - 0.13, z, w, 0.05, 0.14)
      if (readFrom) signs.plate(text, x, top, z, readFrom, th * 0.7, color, 1.3, 0.075)
      else signs.plate2(text, x, top, z, '+z', '-z', th * 0.7, color, 1.3, 0.075)
    } else {
      bSteel.box(x, top, z, 0.12, th + 0.18, w)
      bRimP.box(x, top - th / 2 - 0.13, z, 0.14, 0.05, w)
      if (readFrom) signs.plate(text, x, top, z, readFrom, th * 0.7, color, 1.3, 0.075)
      else signs.plate2(text, x, top, z, '+x', '-x', th * 0.7, color, 1.3, 0.075)
    }
  }

  /** A 2.4 m fingerpost. Each arm points the way it names. */
  function fingerpost(
    x: number,
    y: number,
    z: number,
    arms: [string, number, Facing][],
    readFrom?: Facing,
  ): void {
    const H = 2.4
    bSteel.box(x, y + H / 2, z, 0.14, H, 0.14)
    bSteel.box(x, y + 0.06, z, 0.5, 0.12, 0.5)
    box3(x - 0.12, y, z - 0.12, x + 0.12, y + H, z + 0.12)
    let h = H - 0.3
    for (const [text, color, facing] of arms) {
      const n = FACE_N[facing]
      bSteel.box(x + n[0] * 0.6, y + h, z + n[2] * 0.6, n[0] ? 1.2 : 0.09, 0.26, n[2] ? 1.2 : 0.09)
      const f: [Facing, Facing] = n[0] !== 0 ? ['+z', '-z'] : ['+x', '-x']
      if (readFrom) signs.plate(text, x + n[0] * 0.66, y + h, z + n[2] * 0.66, readFrom, 0.2, color, 1.3, 0.055)
      else signs.plate2(text, x + n[0] * 0.66, y + h, z + n[2] * 0.66, f[0], f[1], 0.2, color, 1.3, 0.055)
      h -= 0.44
    }
  }

  /* =====================================================================
   * 1. THE FOUR CAUSEWAYS
   *
   * A clear-span box truss, 6.8 m between kerbs, ~42 m of span for ~3 m of
   * rise. No pier reaches the excavation floor, for three measured reasons:
   * the `events` heap file (x ±9.5, z -89…-37) lies directly under the north
   * span, the OS page cache paves the middle of the pit at y = -24, and — the
   * one that actually matters — the plaza is meant to look like it floats on
   * its eight pylons. Each span is propped instead by a pair of raking struts
   * off a corbel cast into the pit wall: the same structural move as the deck,
   * one order of magnitude smaller.
   * ===================================================================*/

  function buildCauseway(c: CausewaySpec): void {
    const ax = c.axis
    const dir = Math.sign(c.inner - c.outer)
    const half = WAY_W / 2
    const railAt = half - 0.14
    const kerbAt = half - KERB_W / 2
    const yTop = LAND_Y
    const headY = c.headOn === 'plinth' ? PLINTH_Y : PAVE_Y
    const hOuter = c.outer - dir * c.headDepth
    const landEnd = c.inner + dir * 3.0
    const sillEnd = landEnd + dir * 1.4
    const lo = (u: number, v: number) => Math.min(u, v)
    const hi = (u: number, v: number) => Math.max(u, v)

    /* -- head platform on solid ground ---------------------------------- */
    if (ax === 'z') {
      surfaces.flat(c.centre - half - 1.6, c.centre + half + 1.6, lo(hOuter, c.outer), hi(hOuter, c.outer), headY, 0.72)
    } else {
      surfaces.flat(lo(hOuter, c.outer), hi(hOuter, c.outer), c.centre - half - 1.6, c.centre + half + 1.6, headY, 0.72)
    }
    // A head on a plinth stands 0.60 m over the rim ledge, so both of its
    // flanks become kerb ramps: that is how the rim walk reaches the causeway.
    if (c.headOn === 'plinth') {
      const ledgeMid = c.outer - dir * 1.5
      for (const s of [-1, 1]) {
        const w0 = c.centre + s * (half + 1.6)
        const w1 = c.centre + s * (half + 1.6 + 6)
        surfaces.ramp('z', lo(w0, w1), hi(w0, w1),
          s > 0 ? PLINTH_Y : PAVE_Y, s > 0 ? PAVE_Y : PLINTH_Y, ledgeMid, 3, 0.5)
      }
    }

    /* -- the span, the landing plate and the threshold wedge ------------- */
    surfaces.ramp(ax, c.outer, c.inner, c.yOuter, yTop, c.centre, WAY_W, WAY_T)
    if (ax === 'z') {
      surfaces.flat(c.centre - half, c.centre + half, lo(c.inner, landEnd), hi(c.inner, landEnd), yTop, 0.1)
    } else {
      surfaces.flat(lo(c.inner, landEnd), hi(c.inner, landEnd), c.centre - half, c.centre + half, yTop, 0.1)
    }
    surfaces.ramp(ax, landEnd, sillEnd, yTop, DECK_TOP, c.centre, WAY_W, 0.12)

    /* -- kerbs and handrails --------------------------------------------
     * The head platform gets a kerb but no rail: the rim walk arrives across
     * its flanks, and a rail there would fence the causeway off from the very
     * ramps that reach it. The span and the landing get both. */
    for (const s of [-1, 1]) {
      kerbRun(ax, hOuter, c.outer, headY, headY, c.centre + s * kerbAt, bRimP)
      kerbRun(ax, c.outer, c.inner, c.yOuter, yTop, c.centre + s * kerbAt, bRimP)
      kerbRun(ax, c.inner, landEnd, yTop, yTop, c.centre + s * kerbAt, bRimP)
      railRun(ax, c.outer, c.inner, c.yOuter, yTop, c.centre + s * railAt)
      railRun(ax, c.inner, landEnd, yTop, yTop, c.centre + s * railAt)
    }
    // A head that stands on the rim itself gets short returns either side of
    // the opening, so the platform edge is guarded where the parapet stops.
    if (c.headOn === 'plinth') {
      const edge = c.outer - dir * 0.25
      const other: Axis = ax === 'x' ? 'z' : 'x'
      for (const s of [-1, 1]) {
        railRun(other, c.centre + s * (half + 0.15), c.centre + s * (half + 1.6), headY, headY, edge, 3)
      }
    }

    /* -- the truss ------------------------------------------------------- */
    const chordAt = half - 0.5
    const n = Math.max(4, Math.round(Math.abs(c.inner - c.outer) / 5.5))
    const yAt = (u: number): number => c.yOuter + (yTop - c.yOuter) * ((u - c.outer) / (c.inner - c.outer))
    for (const s of [-1, 1]) {
      const at = c.centre + s * chordAt
      if (ax === 'z') {
        bStruct.bar(at, c.yOuter - WAY_T - 0.15, c.outer, at, yTop - WAY_T - 0.15, c.inner, 0.3)
        bStruct.bar(at, c.yOuter - WAY_T - TRUSS_D, c.outer, at, yTop - WAY_T - TRUSS_D, c.inner, 0.34)
      } else {
        bStruct.bar(c.outer, c.yOuter - WAY_T - 0.15, at, c.inner, yTop - WAY_T - 0.15, at, 0.3)
        bStruct.bar(c.outer, c.yOuter - WAY_T - TRUSS_D, at, c.inner, yTop - WAY_T - TRUSS_D, at, 0.34)
      }
      for (let i = 0; i <= n; i++) {
        const u = c.outer + ((c.inner - c.outer) * i) / n
        const y = yAt(u)
        if (ax === 'z') bStruct.box(at, y - WAY_T - TRUSS_D / 2, u, 0.24, TRUSS_D, 0.24)
        else bStruct.box(u, y - WAY_T - TRUSS_D / 2, at, 0.24, TRUSS_D, 0.24)
        if (i === n) continue
        const u2 = c.outer + ((c.inner - c.outer) * (i + 1)) / n
        const y2 = yAt(u2)
        const up = i % 2 === 0
        if (ax === 'z') {
          bStruct.bar(at, y - WAY_T - (up ? TRUSS_D : 0.15), u, at, y2 - WAY_T - (up ? 0.15 : TRUSS_D), u2, 0.2)
        } else {
          bStruct.bar(u, y - WAY_T - (up ? TRUSS_D : 0.15), at, u2, y2 - WAY_T - (up ? 0.15 : TRUSS_D), at, 0.2)
        }
      }
    }
    for (let i = 0; i <= n; i += 2) {
      const u = c.outer + ((c.inner - c.outer) * i) / n
      const y = yAt(u) - WAY_T - TRUSS_D
      if (ax === 'z') bStruct.box(c.centre, y, u, chordAt * 2, 0.22, 0.22)
      else bStruct.box(u, y, c.centre, 0.22, 0.22, chordAt * 2)
    }

    /* -- corbel on the pit wall and the raking struts -------------------- */
    const rimU = ax === 'z' ? -dir * CITY.pit.z : -dir * CITY.pit.x
    const propU = rimU + dir * 15
    const propY = yAt(propU) - WAY_T - TRUSS_D
    if (ax === 'z') {
      bStruct.box(c.centre, -10.6, rimU + dir * 0.9, WAY_W + 1.4, 1.8, 1.8)
      for (const s of [-1, 1]) bStruct.bar(c.centre + s * chordAt, -10.0, rimU, c.centre + s * chordAt, propY, propU, 0.5)
      bStruct.box(c.centre, propY + 0.1, propU, chordAt * 2, 0.3, 0.3)
    } else {
      bStruct.box(rimU + dir * 0.9, -10.6, c.centre, 1.8, 1.8, WAY_W + 1.4)
      for (const s of [-1, 1]) bStruct.bar(rimU, -10.0, c.centre + s * chordAt, propU, propY, c.centre + s * chordAt, 0.5)
      bStruct.box(propU, propY + 0.1, c.centre, 0.3, 0.3, chordAt * 2)
    }

    /* -- the gate portal on the deck edge -------------------------------- */
    const portalU = c.inner + dir * 1.2
    const colH = 2.9
    for (const s of [-1, 1]) {
      const at = c.centre + s * (half + 0.55)
      if (ax === 'z') {
        bSteel.box(at, yTop + colH / 2, portalU, 0.34, colH, 0.34)
        box3(at - 0.17, yTop, portalU - 0.17, at + 0.17, yTop + colH, portalU + 0.17)
      } else {
        bSteel.box(portalU, yTop + colH / 2, at, 0.34, colH, 0.34)
        box3(portalU - 0.17, yTop, at - 0.17, portalU + 0.17, yTop + colH, at + 0.17)
      }
    }
    if (ax === 'z') {
      bSteel.box(c.centre, yTop + colH + 0.16, portalU, WAY_W + 1.8, 0.32, 0.36)
      bRimP.box(c.centre, yTop + colH - 0.05, portalU + dir * 0.19, WAY_W + 1.4, 0.06, 0.04)
      signs.plate(`${c.name}  ▾`, c.centre, yTop + colH - 0.62, portalU + dir * 0.2,
        dir > 0 ? '+z' : '-z', 0.46, c.color, 1.3)
      signs.plate('SHARED MEMORY', c.centre, yTop + colH - 0.62, portalU - dir * 0.2,
        dir > 0 ? '-z' : '+z', 0.46, COLOR.shmem, 1.3)
    } else {
      bSteel.box(portalU, yTop + colH + 0.16, c.centre, 0.36, 0.32, WAY_W + 1.8)
      bRimP.box(portalU + dir * 0.19, yTop + colH - 0.05, c.centre, 0.04, 0.06, WAY_W + 1.4)
      signs.plate(`${c.name}  ▾`, portalU + dir * 0.2, yTop + colH - 0.62, c.centre,
        dir > 0 ? '+x' : '-x', 0.46, c.color, 1.3)
      signs.plate('SHARED MEMORY', portalU - dir * 0.2, yTop + colH - 0.62, c.centre,
        dir > 0 ? '-x' : '+x', 0.46, COLOR.shmem, 1.3)
    }

    /* -- the fingerpost at the head -------------------------------------- */
    const span = Math.round(Math.abs(c.inner - c.outer))
    const postU = hOuter - dir * 2.4
    const postW = c.centre + half + 3.0
    const toDeck: Facing = ax === 'z' ? (dir > 0 ? '+z' : '-z') : dir > 0 ? '+x' : '-x'
    const away: Facing = ax === 'z' ? (dir > 0 ? '-z' : '+z') : dir > 0 ? '-x' : '+x'
    if (ax === 'z') {
      fingerpost(postW, headY, postU, [[`SHARED MEMORY  ${span} m`, COLOR.shmem, toDeck], [c.name, c.color, away]])
      signBoard(`${c.id.toUpperCase()} CAUSEWAY`, c.centre, headY, postU, 'x', 5.2, c.color)
    } else {
      fingerpost(postU, headY, postW, [[`SHARED MEMORY  ${span} m`, COLOR.shmem, toDeck], [c.name, c.color, away]])
      signBoard(`${c.id.toUpperCase()} CAUSEWAY`, postU, headY, c.centre, 'z', 5.2, c.color)
    }
  }

  for (const c of CAUSEWAYS) buildCauseway(c)

  /* =====================================================================
   * 2. THE DESCENT — ground level to the data-directory floor, 52 m in seven
   * flights of 43 steps. A freight lift would be quicker, but the walk
   * controller has no moving platform, and a stair you can see all the way
   * down is the better arrival anyway: you come out on the floor of the
   * excavation and look up 52 m at eight pylons carrying shared memory.
   * ===================================================================*/

  {
    const { westX, eastX, landing, laneA, laneB, zLo, zHi, gangX, gangW, topY, floorY } = STAIR
    const levels: number[] = []
    for (let i = 0; i <= N_FLIGHTS; i++) levels.push(topY + ((floorY - topY) * i) / N_FLIGHTS)
    const rimZ = -CITY.pit.z

    /* -- entry gangway from the rim, propped off the pit wall ------------ */
    surfaces.flat(gangX - gangW / 2, gangX + gangW / 2, zLo, rimZ - 2, topY, 0.5)
    for (const s of [-1, 1]) {
      const at = gangX + s * (gangW / 2 - 0.12)
      railRun('z', rimZ - 2, zLo, topY, topY, at)
      bStruct.bar(gangX + s * (gangW / 2), topY - 0.5, zLo + 0.5, gangX + s * (gangW / 2), -7.5, rimZ + 0.4, 0.5)
    }
    bStruct.box(gangX, -7.8, rimZ + 0.9, gangW + 1.2, 1.6, 1.8)

    /* -- landings -------------------------------------------------------- */
    for (let i = 0; i <= N_FLIGHTS; i++) {
      const east = i % 2 === 0
      const x0 = east ? eastX : westX - landing
      const x1 = east ? eastX + landing : westX
      const y = levels[i]
      surfaces.flat(x0, x1, zLo, zHi, y, 0.5)
      const outerX = east ? x1 : x0
      // …and the bottom landing's outer face is where you walk out onto the
      // floor of the excavation, so that one stays open too.
      if (i !== N_FLIGHTS) railRun('z', zLo, zHi, y, y, outerX + (east ? -0.14 : 0.14))
      // The top landing's north face is where the gangway arrives; every other
      // landing is closed on both sides.
      if (i !== 0) railRun('x', x0, x1, y, y, zLo + 0.14)
      railRun('x', x0, x1, y, y, zHi - 0.14)
      // The top landing has no flight in lane B — that side is a 7.4 m drop.
      if (i === 0) railRun('z', laneB - STAIR_W / 2, laneB + STAIR_W / 2, y, y, x0 + 0.14)
      bStruct.box((x0 + x1) / 2, y - 0.66, zLo + 0.2, x1 - x0, 0.8, 0.4)
      bStruct.box((x0 + x1) / 2, y - 0.66, zHi - 0.2, x1 - x0, 0.8, 0.4)
      bStruct.box(outerX + (east ? -0.2 : 0.2), y - 0.66, (zLo + zHi) / 2, 0.4, 0.8, zHi - zLo)
      // Lit nosing on every landing: eight rungs of light you can count from
      // the floor of the excavation, which is how deep 52 m reads.
      bRimS.box((x0 + x1) / 2, y - 0.16, zLo + 0.06, x1 - x0, 0.09, 0.12)
      bRimS.box((x0 + x1) / 2, y - 0.16, zHi - 0.06, x1 - x0, 0.09, 0.12)
      // A column to the landing two levels down, so the tower reads as a tower.
      if (i + 2 <= N_FLIGHTS) {
        const cx = east ? x1 - 0.55 : x0 + 0.55
        for (const cz of [zLo + 0.55, zHi - 0.55]) {
          bStruct.box(cx, (levels[i] + levels[i + 2]) / 2, cz, 0.44, levels[i] - levels[i + 2], 0.44)
        }
      }
    }

    /* -- the flights ----------------------------------------------------- */
    for (let f = 0; f < N_FLIGHTS; f++) {
      const west = f % 2 === 0
      const lane = west ? laneA : laneB
      const a = west ? eastX : westX
      const b = west ? westX : eastX
      const yA = levels[f]
      const yB = levels[f + 1]
      // The walking plane runs landing top to landing top, half a riser above
      // every tread: the walker glides, the treads pass under them, and the two
      // ends meet the landings exactly.
      stairPlane.ramp('x', a, b, yA, yB, lane, STAIR_W, 0.6)
      const step = (b - a) / TREADS_PER_FLIGHT
      for (let i = 1; i <= TREADS_PER_FLIGHT; i++) {
        const x = a + step * (i - 0.5)
        const y = yA - TREAD_RISE * i
        bTread.box(x, y - 0.045, lane, Math.abs(step) * 0.92, 0.09, STAIR_W)
      }
      for (const s of [-1, 1]) {
        const at = lane + s * (STAIR_W / 2)
        bStruct.bar(a, yA - 0.62, at, b, yB - 0.62, at, 0.3, 0.62)
        // A lit line down the stringer. The excavation has no light of its own;
        // without this the stair is a black shape in a black hole, and the walk
        // down is the whole point of building it.
        bRimS.bar(a, yA - 0.14, at + s * 0.13, b, yB - 0.14, at + s * 0.13, 0.06, 0.1)
        railRun('x', a, b, yA, yB, at - s * 0.16, 5)
      }
    }

    /* -- arrival on the excavation floor --------------------------------- */
    const apronX0 = westX - landing - 12
    const apronX1 = westX - landing
    surfaces.flat(apronX0, apronX1, zLo, zHi, floorY, 0.2)
    bRimS.box((apronX0 + apronX1) / 2, floorY + 0.04, zLo + 0.1, 12, 0.08, 0.14)
    bRimS.box((apronX0 + apronX1) / 2, floorY + 0.04, zHi - 0.1, 12, 0.08, 0.14)
    signBoard('DATA DIRECTORY — FLOOR LEVEL, y = -52 m', apronX0 + 6, floorY, zLo + 0.6, 'x', 8, COLOR.storage, '+z')
    signBoard('SHARED MEMORY IS 52 m ABOVE YOU', apronX0 + 6, floorY, zHi - 0.6, 'x', 8, COLOR.shmem)
    fingerpost(apronX0 - 1.5, floorY, (zLo + zHi) / 2, [
      ['UNDER THE PLAZA  90 m', COLOR.shmem, '-x'],
      ['THE SURFACE  ▴ 52 m', COLOR.storage, '+x'],
    ], '-z')

    /* -- the lit path across the excavation floor -------------------------
     * From the foot of the stair to the underside of the plaza: 90 m of open
     * floor between the heap warehouses, with the eight pylons carrying shared
     * memory 52 m overhead. It is the best view in the city and it is pitch
     * dark, so the route is painted in storage green and every pylon foot gets
     * a lit pad. Walked and verified: this dog-leg clears the `events`
     * warehouse (x ±9.5, z -89…-37) and the checkpointer's floor pads. */
    const PATH: readonly [number, number][] = [
      [apronX0, -90], [40, -90], [30, -92], [30, -30], [22, -20], [12, -16], [4, -12],
    ]
    for (let i = 0; i < PATH.length - 1; i++) {
      const [ax, az] = PATH[i]
      const [bx, bz] = PATH[i + 1]
      bRimS.bar(ax, floorY + 0.05, az, bx, floorY + 0.05, bz, 1.1, 0.06)
    }
    for (const px of [-58, -20, 20, 58]) {
      for (const pz of [-44, 44]) {
        bRimS.box(px, floorY + 0.05, pz, 7.4, 0.06, 0.5)
        const armLength = (7.4 - 0.5) / 2
        const armOffset = 0.5 / 2 + armLength / 2
        for (const side of [-1, 1]) {
          bRimS.box(px, floorY + 0.05, pz + side * armOffset, 0.5, 0.06, armLength)
        }
      }
    }

    /* -- head signage on the rim ----------------------------------------- */
    signBoard('DATA DIRECTORY  ▾  52 m', gangX, topY, rimZ - 3.0, 'x', 5.6, COLOR.storage)
    fingerpost(gangX - gangW / 2 - 1.8, topY, rimZ - 2.6, [
      ['DATA DIRECTORY DESCENT', COLOR.storage, '+z'],
      ['BACKENDS', COLOR.backend, '-z'],
    ])
  }

  /* =====================================================================
   * 3. THE PIT-RIM PARAPET. 888 m of edge protection where today there is a
   * 52 m drop and a 0.07 m painted line, with openings only where a causeway
   * or the descent crosses.
   * ===================================================================*/

  {
    const px = CITY.pit.x - PARAPET_T / 2 - 0.1
    const pz = CITY.pit.z - PARAPET_T / 2 - 0.1
    interface Gap { lo: number; hi: number }
    const gapsFor = (side: DeckGate['side']): Gap[] => {
      const out: Gap[] = []
      for (const c of CAUSEWAYS) {
        if (c.side !== side) continue
        out.push({ lo: c.centre - WAY_W / 2 - 0.15, hi: c.centre + WAY_W / 2 + 0.15 })
      }
      if (side === 'north') {
        out.push({ lo: STAIR.gangX - STAIR.gangW / 2 - 0.3, hi: STAIR.gangX + STAIR.gangW / 2 + 0.3 })
      }
      return out.sort((a, b) => a.lo - b.lo)
    }
    const runs = (gaps: Gap[], lo: number, hi: number): [number, number][] => {
      const out: [number, number][] = []
      let cur = lo
      for (const g of gaps) {
        if (g.hi <= cur) continue
        if (g.lo > cur) out.push([cur, Math.min(g.lo, hi)])
        cur = Math.max(cur, g.hi)
      }
      if (cur < hi) out.push([cur, hi])
      return out
    }
    const wall = (x0: number, z0: number, x1: number, z1: number): void => {
      const sx = Math.max(PARAPET_T, x1 - x0)
      const sz = Math.max(PARAPET_T, z1 - z0)
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      bStruct.box(cx, PARAPET_H / 2, cz, sx, PARAPET_H, sz)
      bRimS.box(cx, PARAPET_H + 0.04, cz, sx, 0.08, sz)
      box3(cx - sx / 2, 0, cz - sz / 2, cx + sx / 2, PARAPET_H, cz + sz / 2)
    }
    const horizontalLimit = px - PARAPET_T / 2
    for (const [a, b] of runs(gapsFor('north'), -horizontalLimit, horizontalLimit)) wall(a, -pz - PARAPET_T / 2, b, -pz + PARAPET_T / 2)
    for (const [a, b] of runs(gapsFor('south'), -horizontalLimit, horizontalLimit)) wall(a, pz - PARAPET_T / 2, b, pz + PARAPET_T / 2)
    for (const [a, b] of runs(gapsFor('west'), -CITY.pit.z, CITY.pit.z)) wall(-px - PARAPET_T / 2, a, -px + PARAPET_T / 2, b)
    for (const [a, b] of runs(gapsFor('east'), -CITY.pit.z, CITY.pit.z)) wall(px - PARAPET_T / 2, a, px + PARAPET_T / 2, b)
  }

  /* =====================================================================
   * 3b. THE DECK RAILING, AS A COLLIDER.
   *
   * shmem.ts draws the railing but the whole `shmem` module id is on
   * collision.ts's exclude list, so today the plaza's edge protection is
   * decorative: a walker strolls straight through it and falls 55 m. Since
   * DECK_GATES lives here, the matching solid does too — the same spans, minus
   * the same openings. No geometry, only boxes.
   * ===================================================================*/

  {
    const inset = 2.4
    const rx = CITY.deck.w / 2 - inset
    const rz = CITY.deck.d / 2 - inset
    const t = 0.14
    const yTop = DECK_TOP + 1.5
    const railRuns = (side: DeckGate['side'], lo: number, hi: number): [number, number][] => {
      const spans: [number, number][] = []
      for (const g of DECK_GATES) if (g.side === side) spans.push([g.at - g.width / 2, g.at + g.width / 2])
      spans.sort((a, b) => a[0] - b[0])
      const out: [number, number][] = []
      let cur = lo
      for (const s of spans) {
        if (s[1] <= cur) continue
        if (s[0] > cur) out.push([cur, Math.min(s[0], hi)])
        cur = Math.max(cur, s[1])
      }
      if (cur < hi) out.push([cur, hi])
      return out
    }
    for (const [a, b] of railRuns('north', -rx, rx)) box3(a, DECK_TOP, -rz - t, b, yTop, -rz + t)
    for (const [a, b] of railRuns('south', -rx, rx)) box3(a, DECK_TOP, rz - t, b, yTop, rz + t)
    for (const [a, b] of railRuns('west', -rz, rz)) box3(-rx - t, DECK_TOP, a, -rx + t, yTop, b)
    for (const [a, b] of railRuns('east', -rz, rz)) box3(rx - t, DECK_TOP, a, rx + t, yTop, b)
  }

  /* =====================================================================
   * 3c. FOUR RAMPS INTO THE BUFFER BASIN.
   *
   * Each causeway-aligned coping gap continues down to the recessed cache
   * floor. walk.ts uses the same run and endpoints for its no-allocation swim
   * floor, so the visible ramp, collision surface and buoyancy boundary agree.
   * ===================================================================*/

  {
    const pool = CITY.buf.halfSpan
    const floorY = CITY.buf.baseY
    const w = WAY_W
    for (const c of CAUSEWAYS) {
      const dir = Math.sign(c.inner - c.outer)
      const a = -dir * pool
      const b = a + dir * CITY.buf.accessRun
      if (c.axis === 'z') {
        surfaces.ramp('z', a, b, DECK_TOP, floorY, c.centre, w, 0.3)
        for (const s of [-1, 1]) kerbRun('z', a, b, DECK_TOP, floorY, c.centre + s * (w / 2 - KERB_W / 2), bRimP)
      } else {
        surfaces.ramp('x', a, b, DECK_TOP, floorY, c.centre, w, 0.3)
        for (const s of [-1, 1]) kerbRun('x', a, b, DECK_TOP, floorY, c.centre + s * (w / 2 - KERB_W / 2), bRimP)
      }
    }
  }

  /* =====================================================================
   * 3d. THE FLOOR OF THE EXCAVATION.
   *
   * You can now walk down there, so there has to be something to walk on. The
   * The data-directory slab and the pit floor below it are both real geometry — but both
   * are drawn as PlaneGeometry, and collision.ts drops any box thinner than
   * 0.3 m as a decal. Without these two the descent ends in a 60 m fall and a
   * respawn. The numbers are storage.ts's and ground.ts's own.
   * ===================================================================*/

  box3(-112, CITY.storage.y - 1, -95, 112, CITY.storage.y, 100)
  box3(-CITY.pit.x, CITY.storage.y - 9, -CITY.pit.z, CITY.pit.x, CITY.storage.y - 8, CITY.pit.z)

  /* =====================================================================
   * 4. KERB RAMPS onto the five district plinths.
   * ===================================================================*/

  for (const r of PLINTH_RAMPS) {
    const w = 6
    surfaces.ramp('z', r.from, r.to, PAVE_Y, PLINTH_Y, r.centre, w, 0.5)
    for (const s of [-1, 1]) {
      kerbRun('z', r.from, r.to, PAVE_Y, PLINTH_Y, r.centre + s * (w / 2 - KERB_W / 2), bRimP)
    }
    const mid = (r.from + r.to) / 2
    signs.plate2(r.name, r.centre + w / 2 + 1.1, PLINTH_Y + 2.1, mid, '+x', '-x', 0.36, r.color, 1.2)
    bSteel.box(r.centre + w / 2 + 1.1, PLINTH_Y + 1.05, mid, 0.12, 2.1, 0.12)
  }

  /* =====================================================================
   * 5. PAINTED ROUTES. layout.ts already describes the whole network and
   * roads.ts already draws it — at y = 6…30, i.e. overhead, where a walker
   * cannot follow it. Projecting each visible route onto the ground in its
   * own colour turns the legend into roads a person can walk.
   * ===================================================================*/

  function surfaceHeightAt(x: number, z: number): number | null {
    if (Math.abs(x) < CITY.pit.x && Math.abs(z) < CITY.pit.z) return null
    for (const p of PLINTH_RECTS) {
      if (x >= p[0] && x <= p[1] && z >= p[2] && z <= p[3]) return PLINTH_Y + 0.02
    }
    return PAVE_Y + 0.02
  }

  function buildPaintedRoutes(): THREE.Mesh | null {
    const pos: number[] = []
    const col: number[] = []
    const idx: number[] = []
    const HALF = 0.6
    for (const id of Object.keys(ROUTES)) {
      const def = ROUTES[id]
      if (!def.visible) continue
      const curve = routeCurve(id)
      if (!curve) continue
      _col.setHex(def.color)
      const N = 96
      let prev: [number, number, number] | null = null
      for (let i = 0; i <= N; i++) {
        const p = curve.getPointAt(i / N, _pos)
        const y = surfaceHeightAt(p.x, p.z)
        if (y === null) {
          prev = null
          continue
        }
        const cur: [number, number, number] = [p.x, y, p.z]
        if (prev) {
          const dx = cur[0] - prev[0]
          const dz = cur[2] - prev[2]
          const len = Math.hypot(dx, dz)
          if (len > 1e-3) {
            const nx = (-dz / len) * HALF
            const nz = (dx / len) * HALF
            const base = pos.length / 3
            pos.push(
              prev[0] + nx, prev[1], prev[2] + nz,
              prev[0] - nx, prev[1], prev[2] - nz,
              cur[0] - nx, cur[1], cur[2] - nz,
              cur[0] + nx, cur[1], cur[2] + nz,
            )
            for (let k = 0; k < 4; k++) col.push(_col.r, _col.g, _col.b)
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
          }
        }
        prev = cur
      }
    }
    if (idx.length === 0) return null
    const g = keep(new THREE.BufferGeometry())
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.setIndex(idx)
    g.computeBoundingSphere()
    const m = keep(new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      // These routes are literal paint over ground, plinth, and forecourt
      // surfaces. Bias keeps them above every host surface in the far view.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    }))
    const mesh = new THREE.Mesh(g, m)
    mesh.name = 'access.routes'
    mesh.renderOrder = -2
    mesh.raycast = () => {}
    return mesh
  }

  const roads = buildPaintedRoutes()
  if (roads) group.add(roads)

  /* =====================================================================
   * Assemble.
   * ===================================================================*/

  const gBox = keep(new THREE.BoxGeometry(1, 1, 1))
  const batches: [Batch, THREE.Material, string][] = [
    [bStruct, mStruct, 'access.struct'],
    [bSteel, mSteel, 'access.steel'],
    [bTread, mTread, 'access.treads'],
    [bRimP, mRimPlaza, 'access.rim.plaza'],
    [bRimS, mRimStore, 'access.rim.storage'],
  ]
  for (const [b, m, name] of batches) {
    const mesh = b.build(gBox, m, name)
    if (mesh) group.add(mesh)
  }

  const surfaceMesh = surfaces.build(mDeck, 'access.surfaces')
  keep(surfaceMesh.geometry)
  group.add(surfaceMesh)

  const stairMesh = stairPlane.build(mHidden, 'access.stair.plane')
  keep(stairMesh.geometry)
  group.add(stairMesh)

  const signMesh = signs.build()
  if (signMesh) {
    keep(signMesh.geometry)
    keep(signMesh.material as THREE.Material)
    keep(signs.texture)
    group.add(signMesh)
  }

  const walkables: THREE.Object3D[] = [surfaceMesh, stairMesh]

  function installCollision(sink: CollisionSink): void {
    sink.addWalkable(surfaceMesh, 'metal')
    sink.addWalkable(stairMesh, 'stair')
    for (const b of blockers) sink.addBox(b)
  }

  return {
    id: 'access',
    group,
    walkables,
    blockers,
    installCollision,
    update(_dt: number, _sim: SimState, _t: number): void {
      /* Static infrastructure: nothing moves, nothing allocates. */
    },
    dispose(): void {
      for (const o of owned) o.dispose()
      owned.length = 0
    },
  }
}

/** `createAccess` is a `WorldFactory` too — this is the compile-time proof. */
export const accessFactory: WorldFactory = createAccess
