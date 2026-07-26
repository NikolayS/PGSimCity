import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import { N_BACKEND_SLOTS, N_BUFFERS, N_VAC_WORKERS } from '../core/types'
import type { SimState, VacPhase, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtDuration, fmtNum, fmtPct, lerp, makeRng, smoothstep } from '../core/util'
import {
  ANCHOR, CITY, N_TABLES, TABLES,
  rid, routePoint, routeTangent, vacBayPos,
} from './layout'

/* ============================================================================
 * THE MAINTENANCE YARD — the processes nobody thinks about until 3am.
 *
 * Postgres does not clean up on the write path. A backend dirties a page in
 * shared memory and moves on; a backend updates a row and leaves the old
 * version lying where it fell. Everything that turns that laziness back into a
 * server which keeps running happens out here, west of the excavation:
 *
 *   CHECKPOINTER   walks the whole buffer pool, writes every dirty page, then
 *                  fsyncs — the moment your p99 remembers it exists.
 *   BGWRITER       trickles out the pages the clock hand is about to hand over,
 *                  so neither the checkpointer nor a user's backend has to.
 *   AUTOVACUUM     a launcher watching dead-tuple thresholds, and workers that
 *                  drive out to a table and reclaim what MVCC left behind.
 *   LANDFILL       what vacuum actually recovers: space reusable *inside* the
 *                  file, not disk handed back to the operating system.
 *   LOGGER         the one process that makes an incident diagnosable after.
 *   STATS RELAY    a relay, not a collector — since PG15 the cumulative stats
 *                  live in shared memory, over in the plaza.
 *
 * The lesson the whole yard is built around: a worker blocked by an old xmin
 * horizon drives the entire route, burns the entire I/O, and comes back with an
 * empty hopper. Turn on `longRunningXact` and watch AV-0 do exactly that.
 * ==========================================================================*/

/* --- module scratch: update() allocates nothing ---------------------------- */
const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _p3 = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _qc = new THREE.Quaternion()
const _qd = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _mw = new THREE.Matrix4()
const _c = new THREE.Color()
const _axisX = new THREE.Vector3(1, 0, 0)
const _axisY = new THREE.Vector3(0, 1, 0)
const _axisZ = new THREE.Vector3(0, 0, 1)

const TAU = Math.PI * 2
const MB = 1024 * 1024

/** cx, cy, cz, w, h, d — for cylinders w/d are diameters, h is length along Y. */
type BoxSpec = [number, number, number, number, number, number]

/* --- yard anchors: never re-derive a coordinate --------------------------- */
const CP = ANCHOR.checkpointer //   [-140, 0, -40]
const BW = ANCHOR.bgWriter //       [-140, 0,  34]
const AL = ANCHOR.autovacLauncher //[-196, 0,   0]
const DP = ANCHOR.vacDepot //       [-212, 0,   0]
const LF = ANCHOR.landfill //       [-234, 0,  76]
const LG = ANCHOR.logger //         [-140, 0, 100]
const SC = ANCHOR.statsCollector // [-196, 0,  76]

/** Top of the district plinth, laid by ground.ts. */
const YARD = 0.6
/** Apron slabs sit just above it; paint goes above those. */
const APRON_Y = YARD + 0.1
const PAINT_Y = YARD + 0.25
/** Wheels-on-the-ground height for anything that drives. */
const ROAD_Y = YARD + 0.14
/** Sodium-violet depot lighting — the only warm light in the city. */
const SODIUM = mixHex(COLOR.vacuum, 0xffc07a, 0.34)
/** autovacuum_naptime, as compressed by the simulation. */
const NAPTIME = 12

/* --------------------------------------------------------------------------
 * Small helpers. Everything here is allocation-free at runtime.
 * ------------------------------------------------------------------------*/

function pushBoxEdges(out: number[], s: BoxSpec): void {
  const [cx, cy, cz, w, h, d] = s
  const x0 = cx - w / 2, x1 = cx + w / 2
  const y0 = cy - h / 2, y1 = cy + h / 2
  const z0 = cz - d / 2, z1 = cz + d / 2
  const v: number[][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  for (let i = 0; i < e.length; i++) {
    const p = v[e[i]]
    out.push(p[0], p[1], p[2])
  }
}

function setBox(mesh: THREE.InstancedMesh, i: number, s: BoxSpec, q?: THREE.Quaternion): void {
  _p.set(s[0], s[1], s[2])
  _sc.set(s[3], s[4], s[5])
  _m.compose(_p, q ?? _qi, _sc)
  mesh.setMatrixAt(i, _m)
}

function setTRS(
  mesh: THREE.InstancedMesh,
  i: number,
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  q?: THREE.Quaternion,
): void {
  _p.set(x, y, z)
  _sc.set(sx, sy, sz)
  _m.compose(_p, q ?? _qi, _sc)
  mesh.setMatrixAt(i, _m)
}

/** Place an instance in a parent's local frame, given that parent's matrix. */
function setPart(
  mesh: THREE.InstancedMesh, i: number, world: THREE.Matrix4,
  x: number, y: number, z: number,
  sx: number, sy: number, sz: number,
  q?: THREE.Quaternion,
): void {
  _p2.set(x, y, z)
  _sc.set(sx, sy, sz)
  _m.compose(_p2, q ?? _qi, _sc)
  _m.premultiply(world)
  mesh.setMatrixAt(i, _m)
}

/** Collapse an instance in place — keeps the mesh's AABB honest. */
function zeroInst(mesh: THREE.InstancedMesh, i: number, x = 0, y = 0, z = 0): void {
  setTRS(mesh, i, x, y, z, 0.0001, 0.0001, 0.0001)
}

/** Advance an angle toward a target the short way *forwards* only. */
function advanceAngle(cur: number, target: number, maxStep: number): number {
  let d = target - cur
  while (d < 0) d += TAU
  while (d >= TAU) d -= TAU
  const next = cur + Math.min(d, maxStep)
  return next >= TAU ? next - TAU : next
}

/* ============================================================================
 * SIGNAGE — one canvas atlas, one merged geometry, one draw call for every
 * piece of text in the yard, including the three live worker status panels.
 * ==========================================================================*/

const SIGN_W = 384
const SIGN_ROW = 48
const SIGN_ROWS = 40
const SIGN_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

type Facing = 'west' | 'east' | 'north' | 'south' | 'up'

const FACE_R: Record<Facing, [number, number, number]> = {
  west: [0, 0, 1],
  east: [0, 0, -1],
  north: [-1, 0, 0],
  south: [1, 0, 0],
  up: [1, 0, 0],
}
const FACE_U: Record<Facing, [number, number, number]> = {
  west: [0, 1, 0],
  east: [0, 1, 0],
  north: [0, 1, 0],
  south: [0, 1, 0],
  up: [0, 0, -1],
}

/** A quad that billboards and whose text changes — the worker status panels. */
interface LivePlate {
  quad: number
  row: number
  /** half-extent in world units; follows the drawn text */
  hw: number
  hh: number
  text: string
}

class Signage {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  readonly texture: THREE.CanvasTexture
  private next = 0
  /** width in px of the most recent draw() */
  private lastW = 1

  private readonly pos: number[] = []
  private readonly uv: number[] = []
  private readonly col: number[] = []
  private readonly idx: number[] = []
  private quads = 0

  private geometry: THREE.BufferGeometry | null = null
  mesh: THREE.Mesh | null = null
  private posAttr: THREE.BufferAttribute | null = null
  private uvAttr: THREE.BufferAttribute | null = null
  private colorAttr: THREE.BufferAttribute | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = SIGN_W
    this.canvas.height = SIGN_ROW * SIGN_ROWS
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.texture.generateMipmaps = false
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.anisotropy = 4
  }

  /** Ink one atlas row; returns the drawn width in pixels. */
  private draw(row: number, text: string): number {
    const c = this.ctx
    const y0 = row * SIGN_ROW
    c.clearRect(0, y0, SIGN_W, SIGN_ROW)
    let size = 30
    c.font = `600 ${size}px ${SIGN_FONT}`
    let w = c.measureText(text).width
    if (w > SIGN_W - 10) {
      size = Math.max(9, Math.floor((size * (SIGN_W - 10)) / w))
      c.font = `600 ${size}px ${SIGN_FONT}`
      w = c.measureText(text).width
    }
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#ffffff'
    c.fillText(text, SIGN_W / 2, y0 + SIGN_ROW / 2)
    this.texture.needsUpdate = true
    this.lastW = Math.max(6, w)
    return this.lastW
  }

  private uv0(row: number, w: number, out: number[]): void {
    out[0] = 0.5 - w / (2 * SIGN_W)
    out[2] = 0.5 + w / (2 * SIGN_W)
    // flipY is on, so row 0 is the top of the image and v runs from the bottom
    out[3] = 1 - row / SIGN_ROWS
    out[1] = 1 - (row + 1) / SIGN_ROWS
  }

  private readonly uvTmp = [0, 0, 0, 0]

  /** A fixed plate welded to the model. Returns its quad index. */
  plate(
    text: string,
    x: number, y: number, z: number,
    facing: Facing,
    height: number,
    color: number,
    bright = 1,
  ): number {
    const row = this.next++
    const w = this.draw(row, text)
    const hw = (height * w) / SIGN_ROW / 2
    const hh = height / 2
    const r = FACE_R[facing]
    const u = FACE_U[facing]
    this.uv0(row, w, this.uvTmp)
    const [u0, v0, u1, v1] = this.uvTmp
    _c.setHex(color).multiplyScalar(bright)
    const base = this.quads * 4
    const cs: [number, number, number, number][] = [
      [-hw, -hh, u0, v0],
      [hw, -hh, u1, v0],
      [hw, hh, u1, v1],
      [-hw, hh, u0, v1],
    ]
    for (const [a, b, cu, cv] of cs) {
      this.pos.push(x + r[0] * a + u[0] * b, y + r[1] * a + u[1] * b, z + r[2] * a + u[2] * b)
      this.uv.push(cu, cv)
      this.col.push(_c.r, _c.g, _c.b)
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    return this.quads++
  }

  live(text: string, height: number, color: number, bright = 1): LivePlate {
    const quad = this.plate(text, 0, -9000, 0, 'up', height, color, bright)
    return { quad, row: this.next - 1, hw: (height * this.lastW) / SIGN_ROW / 2, hh: height / 2, text }
  }

  setLiveText(p: LivePlate, text: string): void {
    if (p.text === text) return
    p.text = text
    const w = this.draw(p.row, text)
    p.hw = (p.hh * 2 * w) / SIGN_ROW / 2
    const a = this.uvAttr
    if (!a) return
    this.uv0(p.row, w, this.uvTmp)
    const o = p.quad * 4
    a.setXY(o, this.uvTmp[0], this.uvTmp[1])
    a.setXY(o + 1, this.uvTmp[2], this.uvTmp[1])
    a.setXY(o + 2, this.uvTmp[2], this.uvTmp[3])
    a.setXY(o + 3, this.uvTmp[0], this.uvTmp[3])
    a.needsUpdate = true
  }

  /** Position a live plate in world space, facing the camera. */
  place(p: LivePlate, x: number, y: number, z: number, right: THREE.Vector3, up: THREE.Vector3): void {
    const a = this.posAttr
    if (!a) return
    const o = p.quad * 4
    const rx = right.x * p.hw, ry = right.y * p.hw, rz = right.z * p.hw
    const ux = up.x * p.hh, uy = up.y * p.hh, uz = up.z * p.hh
    a.setXYZ(o, x - rx - ux, y - ry - uy, z - rz - uz)
    a.setXYZ(o + 1, x + rx - ux, y + ry - uy, z + rz - uz)
    a.setXYZ(o + 2, x + rx + ux, y + ry + uy, z + rz + uz)
    a.setXYZ(o + 3, x - rx + ux, y - ry + uy, z - rz + uz)
    a.needsUpdate = true
  }

  setColor(quad: number, color: number, bright: number): void {
    const a = this.colorAttr
    if (!a) return
    _c.setHex(color).multiplyScalar(bright)
    const o = quad * 4
    for (let i = 0; i < 4; i++) a.setXYZ(o + i, _c.r, _c.g, _c.b)
    a.needsUpdate = true
  }

  build(): THREE.Mesh {
    const g = new THREE.BufferGeometry()
    const pa = new THREE.Float32BufferAttribute(this.pos, 3)
    pa.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', pa)
    const ua = new THREE.Float32BufferAttribute(this.uv, 2)
    ua.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('uv', ua)
    const ca = new THREE.Float32BufferAttribute(this.col, 3)
    ca.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('color', ca)
    g.setIndex(this.idx)
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      // Alpha is a glyph cutout, not object translucency. Alpha testing keeps
      // the plates crisp and out of the transparent depth-sort pass.
      alphaTest: 0.08,
      vertexColors: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.renderOrder = 5
    mesh.frustumCulled = false // live plates move; the atlas is one draw call
    mesh.raycast = () => {}
    this.geometry = g
    this.mesh = mesh
    this.posAttr = pa
    this.uvAttr = ua
    this.colorAttr = ca
    return mesh
  }

  dispose(): void {
    this.geometry?.dispose()
    ;(this.mesh?.material as THREE.Material | undefined)?.dispose()
    this.texture.dispose()
  }
}

/* --------------------------------------------------------------------------
 * A vacuum worker, as a vehicle.
 * ------------------------------------------------------------------------*/

interface Truck {
  slot: number
  group: THREE.Group
  body: THREE.InstancedMesh
  /** first instance index in the shared wheel / lamp meshes */
  wheel0: number
  neon0: number
  panelTop: LivePlate
  panelBot: LivePlate
  focus: [number, number, number]
  pos: THREE.Vector3
  prev: THREE.Vector3
  bay: THREE.Vector3
  /** where the worker was standing when this run was assigned to it */
  launchFrom: THREE.Vector3
  /** the haul road from the landfill tipping deck back to the bay */
  home: THREE.CatmullRomCurve3
  yaw: number
  bank: number
  pitch: number
  hopper: number
  scoop: number
  carry: number
  spin: number
  tilt: number
  homing: number
  wasActive: boolean
  prevPhase: VacPhase
  dumped: boolean
  expected: number
  panelT: number
}

/* ============================================================================
 * FACTORY
 * ==========================================================================*/

export const createMaintenance: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx
  const low = quality.level === 'low'

  const group = new THREE.Group()
  group.name = 'district:maintenance'

  const owned: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }
  const meshes: THREE.InstancedMesh[] = []

  /* --- materials: structure is matte, meaning is neon --------------------- */
  const matStruct = theme.mat('maint.struct', { color: 0x2b3550, roughness: 0.74, metalness: 0.26, emissive: 0x070b14 })
  const matDeep = theme.mat('maint.deep', { color: 0x18202f, roughness: 0.9, metalness: 0.12, emissive: 0x04070e })
  const matHeavy = theme.mat('maint.heavy', { color: 0x232d44, roughness: 0.5, metalness: 0.52, emissive: 0x080c16 })
  const matVehicle = theme.mat('maint.vehicle', { color: 0x39406b, roughness: 0.56, metalness: 0.36, emissive: 0x090c1a })
  const matTyre = theme.mat('maint.tyre', { color: 0x11141f, roughness: 0.98, metalness: 0.02 })
  const neonWhite = theme.neon(0xffffff, 1)
  const lineInk = theme.line(COLOR.inkDim, 0.17)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 14)
  const domeGeo = own(new THREE.SphereGeometry(0.5, 14, 8))

  const edgeVerts: number[] = []
  const signs = new Signage()
  const rng = makeRng(0x7ac1d5)

  /** InstancedMesh from a spec table, optionally feeding the blueprint pass. */
  function batch(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    specs: readonly BoxSpec[],
    edge = false,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, specs.length))
    for (let i = 0; i < specs.length; i++) setBox(mesh, i, specs[i])
    if (specs.length === 0) zeroInst(mesh, 0)
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = false
    parent.add(mesh)
    meshes.push(mesh)
    if (edge) for (const s of specs) pushBoxEdges(edgeVerts, s)
    return mesh
  }

  /** Neon batch: white base material, per-instance colour carries the meaning. */
  function neonBatch(parent: THREE.Object3D, specs: readonly BoxSpec[], geo = unitBox): THREE.InstancedMesh {
    const mesh = batch(parent, geo, neonWhite, specs)
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, _c)
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    return mesh
  }

  /* =======================================================================
   * 1. CHECKPOINTER — the pumping station.
   *
   *    A checkpoint is a promise: everything dirtied before this LSN is on
   *    disk, so crash recovery may start there. Keeping the promise costs one
   *    full pass over the buffer pool, and then an fsync of every file it
   *    touched. Idle, idle, idle — and then the whole building shakes.
   * =====================================================================*/

  const gCkpt = new THREE.Group()
  gCkpt.name = 'checkpointer'
  group.add(gCkpt)

  const CX = CP[0] // -140
  const CZ = CP[2] //  -40
  const HALL_X = CX - 1
  const HALL_E = HALL_X + 13 // east face, the city side. Pit rim is at x = -118.

  const ckptMass: BoxSpec[] = [
    [CX, APRON_Y, CZ, 38, 0.2, 42], // apron
    [HALL_X, 9.4, CZ, 26, 17, 30], // engine hall
    [HALL_X, 18.4, CZ, 27.6, 1.0, 31.6], // cornice
    [HALL_X - 1, 21.4, CZ - 1, 15, 5, 16], // machine room
    [HALL_X - 1, 24.2, CZ - 1, 16, 0.6, 17], // roof cap
    [CX - 17, 3.4, CZ, 9, 5.6, 28], // vessel house
    [CX + 14.5, 2.2, CZ, 7, 3.2, 22], // east gantry base
    [CX - 9, 21.0, CZ - 18, 6, 5, 6], // stack base
    [CX + 16, 11.5, CZ + 14, 2.2, 21, 2.2], // dial mast
  ]
  const ckptStruct = batch(gCkpt, unitBox, matStruct, ckptMass, true)

  const ckptRound: BoxSpec[] = [
    [CX - 17, 12.5, CZ - 11, 7, 15, 7], // pressure vessels: the head the
    [CX - 17, 12.5, CZ, 7, 15, 7], //      write phase builds up
    [CX - 17, 12.5, CZ + 11, 7, 15, 7],
    [CX - 9, 28.5, CZ - 18, 3.8, 15, 3.8], // sync stack
    [0, 0, 0, 1, 1, 1], // 4: fsync manifold, rotated below
    [0, 0, 0, 1, 1, 1], // 5: dial backplate
    [0, 0, 0, 1, 1, 1], // 6: outfall flange, aimed down ckpt.sweep
  ]
  const ckptHeavy = batch(gCkpt, unitCyl, matHeavy, ckptRound)
  {
    _q.setFromAxisAngle(_axisX, Math.PI / 2)
    setTRS(ckptHeavy, 4, CX + 14.5, 5.6, CZ, 3.6, 22, 3.6, _q)
    _q.setFromAxisAngle(_axisZ, Math.PI / 2)
    setTRS(ckptHeavy, 5, CX + 16.9, 24, CZ + 14, 15.6, 0.8, 15.6, _q)
    // Where the discharge main leaves for the plaza: ask the route.
    routePoint('ckpt.sweep', 0, _p2)
    routeTangent('ckpt.sweep', 0, _dir).normalize()
    _q.setFromUnitVectors(_axisY, _dir)
    setTRS(ckptHeavy, 6, _p2.x, _p2.y, _p2.z, 4.6, 2.2, 4.6, _q)
    ckptHeavy.instanceMatrix.needsUpdate = true
  }

  const ckptDomes = batch(gCkpt, domeGeo, matHeavy, [
    [CX - 17, 20, CZ - 11, 7, 5.6, 7],
    [CX - 17, 20, CZ, 7, 5.6, 7],
    [CX - 17, 20, CZ + 11, 7, 5.6, 7],
  ])

  const ckptDetail: BoxSpec[] = [
    // service walkway and rail around the cornice
    [HALL_X, 19.0, CZ - 15.4, 27.6, 0.24, 1.6],
    [HALL_X, 19.0, CZ + 15.4, 27.6, 0.24, 1.6],
    [HALL_X - 13.4, 19.0, CZ, 1.6, 0.24, 31.6],
    [HALL_X + 13.4, 19.0, CZ, 1.6, 0.24, 31.6],
    [HALL_X, 19.9, CZ - 16.0, 27.6, 0.1, 0.1],
    [HALL_X, 19.9, CZ + 16.0, 27.6, 0.1, 0.1],
    // recessed bands: one storey inside, three from outside
    [HALL_X, 5.4, CZ, 26.4, 0.55, 30.4],
    [HALL_X, 11.4, CZ, 26.4, 0.55, 30.4],
    // north-face vents
    [HALL_X - 7, 14.4, CZ - 15.1, 2.6, 3.4, 0.5],
    [HALL_X - 1, 14.4, CZ - 15.1, 2.6, 3.4, 0.5],
    [HALL_X + 5, 14.4, CZ - 15.1, 2.6, 3.4, 0.5],
    [HALL_X - 13.8, 9.0, CZ + 10, 2.6, 16, 4.4], // stair tower
    [HALL_E + 0.15, 11.6, CZ + 3, 0.6, 8.4, 15], // gauge board, east face
    // vessel pipework
    [CX - 12.6, 16.4, CZ - 11, 8, 0.7, 0.7],
    [CX - 12.6, 16.4, CZ, 8, 0.7, 0.7],
    [CX - 12.6, 16.4, CZ + 11, 8, 0.7, 0.7],
    [CX - 12.6, 16.4, CZ, 0.7, 0.7, 23],
    // discharge main, out of the east wall toward the plaza
    [HALL_E + 4, 12, CZ, 8, 1.5, 1.5],
    [CX + 18, 12, CZ, 6, 1.2, 1.2],
    [CX + 16, 22, CZ + 14, 5.2, 0.5, 0.5], // dial bracing
  ]
  const ckptDetailMesh = batch(gCkpt, unitBox, matDeep, ckptDetail)

  /* The flywheel turns at the rate pages are actually leaving. The same
   * buffersToWrite spread over a longer completion target is a slower wheel —
   * that is checkpoint_completion_target, made rotational. */
  const wheelGroup = new THREE.Group()
  wheelGroup.position.set(HALL_X, 10.5, CZ + 15.8)
  gCkpt.add(wheelGroup)
  const wheelGeo = own(new THREE.TorusGeometry(6.2, 0.72, 6, 26))
  const wheelRim = new THREE.Mesh(wheelGeo, matHeavy)
  wheelGroup.add(wheelRim)
  const wheelSpokes = new THREE.InstancedMesh(unitBox, matHeavy, 5)
  for (let i = 0; i < 4; i++) {
    _e.set(0, 0, (i * Math.PI) / 4)
    _q.setFromEuler(_e)
    setTRS(wheelSpokes, i, 0, 0, 0, 12.4, 0.45, 0.45, _q)
  }
  setTRS(wheelSpokes, 4, 0, 0, 0, 2.2, 2.2, 1.6)
  wheelSpokes.instanceMatrix.needsUpdate = true
  wheelGroup.add(wheelSpokes)
  meshes.push(wheelSpokes)

  /* --- checkpointer neon ------------------------------------------------- */

  const ckptNeon: BoxSpec[] = []
  const cn = (s: BoxSpec) => (ckptNeon.push(s), ckptNeon.length - 1)

  const IX_CK_SLIT = cn([HALL_E + 0.06, 8.4, CZ - 9, 0.12, 0.6, 9])
  cn([HALL_E + 0.06, 8.4, CZ + 9, 0.12, 0.6, 9])
  cn([HALL_X, 8.4, CZ - 15.15, 20, 0.6, 0.12])
  cn([HALL_X - 13.06, 8.4, CZ, 0.12, 0.6, 20])
  const CK_SLITS = 4

  const GAUGE_Z0 = CZ - 3.6
  const GAUGE_LEN = 12.6
  const IX_CK_BAR = cn([HALL_E + 0.5, 13.4, GAUGE_Z0, 0.5, 1.5, 0.4])
  const IX_CK_TRACK = cn([HALL_E + 0.42, 13.4, GAUGE_Z0 + GAUGE_LEN / 2, 0.32, 0.14, GAUGE_LEN])
  const IX_CK_TICK = ckptNeon.length
  for (let i = 0; i <= 10; i++) cn([HALL_E + 0.42, 12.5, GAUGE_Z0 + (GAUGE_LEN * i) / 10, 0.3, 0.5, 0.12])
  const CK_TICKS = 11

  const IX_CK_PRES = ckptNeon.length
  for (let i = 0; i < 3; i++) cn([CX - 20.6, 12.5, CZ - 11 + i * 11, 0.4, 12, 0.4])

  const IX_CK_FSYNC = ckptNeon.length
  for (let i = 0; i < 5; i++) cn([CX + 14.5, 5.6, CZ - 8 + i * 4, 4.2, 0.4, 4.2])

  const IX_CK_FPI = ckptNeon.length
  for (let i = 0; i < 6; i++) cn([HALL_E + 0.4, 6.4, CZ - 5 + i * 2.2, 0.35, 2.4, 1.2])

  const IX_CK_BEACON = cn([HALL_X - 1, 27.2, CZ - 1, 1.4, 1.4, 1.4])
  const IX_CK_BEACON2 = cn([CX - 9, 36.6, CZ - 18, 1.2, 1.2, 1.2])
  const IX_CK_VALVE = cn([0, 0, 0, 1, 1, 1])

  /* The countdown dial: two arcs racing each other.
   *   outer — checkpoint_timeout
   *   inner — WAL since the redo point, against max_wal_size
   * Whichever closes the circle first fires the checkpoint. If the inner one
   * keeps winning, max_wal_size is too small and none of your checkpoints are
   * the gentle, spread-out, time-triggered kind. */
  const DIAL_N = 40
  const DIAL_X = CX + 17.4
  const DIAL_Y = 24
  const DIAL_Z = CZ + 14
  const IX_CK_DIAL = ckptNeon.length
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < DIAL_N; i++) cn([DIAL_X, DIAL_Y, DIAL_Z, 1, 1, 1])
  }

  const ckptNeonMesh = neonBatch(gCkpt, ckptNeon)
  {
    routePoint('ckpt.sweep', 0, _p2)
    routeTangent('ckpt.sweep', 0, _dir).normalize()
    _q.setFromUnitVectors(_axisY, _dir)
    setTRS(ckptNeonMesh, IX_CK_VALVE, _p2.x, _p2.y, _p2.z, 3.4, 0.5, 3.4, _q)
    for (let ring = 0; ring < 2; ring++) {
      const r = ring === 0 ? 6.6 : 4.7
      for (let i = 0; i < DIAL_N; i++) {
        const a = (i / DIAL_N) * TAU
        _e.set(-a, 0, 0)
        _q.setFromEuler(_e)
        setTRS(
          ckptNeonMesh, IX_CK_DIAL + ring * DIAL_N + i,
          DIAL_X, DIAL_Y + r * Math.cos(a), DIAL_Z - r * Math.sin(a),
          0.34, ring === 0 ? 1.6 : 1.3, 0.42, _q,
        )
      }
    }
    ckptNeonMesh.instanceMatrix.needsUpdate = true
  }

  const SGN_CKPT = signs.plate('checkpointer', HALL_E + 0.5, 17.0, CZ + 3, 'east', 2.0, COLOR.checkpoint, 1.0)
  signs.plate('buffers written', HALL_E + 0.5, 14.9, GAUGE_Z0 + GAUGE_LEN / 2, 'east', 0.85, COLOR.inkDim, 0.7)
  signs.plate('full_page_writes', HALL_E + 0.5, 4.6, CZ + 0.5, 'east', 0.8, COLOR.wal, 0.55)
  signs.plate('fsync', CX + 14.5, 8.6, CZ + 11.6, 'south', 1.0, COLOR.crit, 0.5)
  signs.plate('checkpoint_timeout', DIAL_X + 0.4, DIAL_Y + 8.6, DIAL_Z, 'east', 0.95, COLOR.checkpoint, 0.6)
  const SGN_MAXWAL = signs.plate('max_wal_size', DIAL_X + 0.4, DIAL_Y - 8.6, DIAL_Z, 'east', 0.95, COLOR.wal, 0.45)
  const SGN_CKREASON = signs.plate('WAL-triggered, not timed', DIAL_X + 0.4, DIAL_Y + 10.2, DIAL_Z, 'east', 0.9, COLOR.crit, 0.08)

  /* =======================================================================
   * 2. BACKGROUND WRITER — the street sweeper.
   *
   *    It never stops and it never catches up. It cleans a little way ahead
   *    of the clock hand, so the frame a backend is about to claim is already
   *    clean. Park it and those writes still happen — inline, inside a user's
   *    query, which is the whole point of the machine.
   * =====================================================================*/

  const gBgw = new THREE.Group()
  gBgw.name = 'bgwriter'
  group.add(gBgw)

  const BX = BW[0] // -140
  const BZ = BW[2] //   34
  /** One lap of the circuit is one pass of the clock hand over the pool. */
  const LOOP_R = 11.5
  const LOOP_X = BX + 2
  const LOOP_Z = BZ

  const bgwMass: BoxSpec[] = [
    [BX, APRON_Y, BZ, 36, 0.2, 34], // pad
    [BX - 15, 4.6, BZ, 10, 8, 15], // shed
    [BX - 15, 9.0, BZ, 11.4, 1.0, 16.4], // shed roof
    [BX - 15, 10.6, BZ - 4, 3, 2.4, 3], // roof plant
    [BX + 15.5, 3.2, BZ, 5, 5.2, 9], // chute house, feeding bgw.sweep
    [BX - 4, 2.0, BZ - 15.5, 15, 3.6, 3], // totem base
  ]
  const bgwStruct = batch(gBgw, unitBox, matStruct, bgwMass, true)

  const bgwDetail: BoxSpec[] = [
    [BX - 15, 2.4, BZ + 7.6, 5.4, 4.6, 0.5], // door recess
    [BX - 15, 6.6, BZ, 10.4, 0.4, 15.4], // banding
    [BX - 9.6, 4.6, BZ, 0.6, 8, 15.4],
    [BX - 4, 11.5, BZ - 15.5, 0.9, 16, 0.9], // dirty-page mast
    [BX + 2, 11.5, BZ - 15.5, 0.9, 16, 0.9], // backend-write mast
    [BX + 15.5, 6.2, BZ, 6, 1.2, 10], // chute canopy
    [BX + 18, 8.4, BZ, 5, 1.0, 1.0], // outfall toward the plaza
  ]
  const bgwDetailMesh = batch(gBgw, unitBox, matDeep, bgwDetail)

  const bgwNeon: BoxSpec[] = []
  const bn = (s: BoxSpec) => (bgwNeon.push(s), bgwNeon.length - 1)

  const IX_BG_SHED = bn([BX - 9.75, 5.4, BZ, 0.12, 0.7, 11])
  bn([BX - 15, 5.4, BZ - 7.75, 7, 0.7, 0.12])
  const BG_SHED_N = 2

  /* The consequence, visible from here. Left column: how much of the pool is
   * dirty right now. Right column: how often a backend had to write out its
   * own victim page — exactly what this machine exists to prevent. */
  const TOTEM_N = 16
  const IX_BG_DIRTY = bgwNeon.length
  for (let i = 0; i < TOTEM_N; i++) bn([BX - 4, 4.6 + i * 0.95, BZ - 15.5, 2.6, 0.6, 0.5])
  const IX_BG_EVICT = bgwNeon.length
  for (let i = 0; i < TOTEM_N; i++) bn([BX + 2, 4.6 + i * 0.95, BZ - 15.5, 2.6, 0.6, 0.5])
  const IX_BG_CHUTE = bn([BX + 15.5, 6.9, BZ, 5.2, 0.3, 9.4])
  const IX_BG_OFF = bn([BX - 15, 9.9, BZ + 7.6, 4.6, 1.0, 0.3])
  const bgwNeonMesh = neonBatch(gBgw, bgwNeon)

  const gSweep = new THREE.Group()
  gBgw.add(gSweep)
  const sweepBody = batch(gSweep, unitBox, matHeavy, [
    [0, 1.5, 0, 4.4, 1.4, 2.4], // chassis
    [0.9, 2.9, 0, 2.0, 1.6, 2.2], // cab
    [-1.5, 2.6, 0, 1.8, 1.4, 2.0], // tank
    [2.4, 1.0, 0, 1.2, 1.2, 3.0], // brush drum
    [-2.4, 1.2, 0, 0.6, 1.0, 2.6], // squeegee
  ])
  const sweepNeon = neonBatch(gSweep, [
    [0.9, 3.1, 0, 2.1, 0.7, 2.25], // cab glazing
    [0.9, 3.9, 0, 0.7, 0.5, 0.7], // beacon
    [2.4, 1.0, 0, 1.3, 1.3, 3.05], // brush, lit while it is really cleaning
  ])

  const SGN_BGW = signs.plate('bgwriter', BX - 15, 11.6, BZ + 7.8, 'south', 1.6, COLOR.bgwriter, 1.0)
  signs.plate('pool dirty', BX - 4, 21.2, BZ - 15.8, 'north', 0.85, COLOR.bufDirty, 0.6)
  signs.plate('backend writes', BX + 2, 21.2, BZ - 15.8, 'north', 0.85, COLOR.warn, 0.5)
  const SGN_BGOFF = signs.plate('OFF', BX - 15, 11.0, BZ + 7.9, 'south', 1.0, COLOR.crit, 0.06)
  signs.plate('one lap = one clock sweep', LOOP_X, PAINT_Y + 0.02, LOOP_Z, 'up', 1.4, COLOR.bgwriter, 0.3)

  /* =======================================================================
   * 3. AUTOVACUUM LAUNCHER — the control tower.
   *
   *    Every naptime it wakes, compares each table's dead tuples against
   *    threshold + scale_factor * live, and forks a worker for the worst
   *    offender. The scanner makes exactly one revolution per naptime, so the
   *    sweep you can see IS the countdown.
   * =====================================================================*/

  const gLaunch = new THREE.Group()
  gLaunch.name = 'autovac.launcher'
  group.add(gLaunch)

  const AX = AL[0] // -196
  const AZ = AL[2] //    0

  // No apron here: the depot's slab already runs under the tower's footprint.
  const launchStruct = batch(gLaunch, unitBox, matStruct, [
    [AX, 2.6, AZ, 18, 4, 18],
    [AX, 4.9, AZ, 19.4, 0.7, 19.4],
  ], true)

  const launchCyl = batch(gLaunch, unitCyl, matHeavy, [
    [AX, 18, AZ, 7.4, 26, 7.4], // shaft
    [AX, 32.6, AZ, 13, 4.6, 13], // cab
    [AX, 35.4, AZ, 14.4, 1.0, 14.4], // cab roof
    [AX, 36.6, AZ, 2.0, 1.4, 2.0], // scanner bearing
  ])

  const launchDetailMesh = batch(gLaunch, unitBox, matDeep, [
    [AX, 30.0, AZ, 15, 0.5, 15], // gallery
    [AX, 31.0, AZ - 7.4, 15, 1.0, 0.12],
    [AX, 31.0, AZ + 7.4, 15, 1.0, 0.12],
    [AX - 7.4, 31.0, AZ, 0.12, 1.0, 15],
    [AX + 7.4, 31.0, AZ, 0.12, 1.0, 15],
    [AX + 4.4, 17, AZ, 1.2, 24, 1.2], // ladder
    [AX, 12, AZ, 8.4, 0.4, 8.4], // shaft collars
    [AX, 24, AZ, 8.4, 0.4, 8.4],
  ])

  const GAUGE_R = 11.6
  const launchNeon: BoxSpec[] = []
  const ln = (s: BoxSpec) => (launchNeon.push(s), launchNeon.length - 1)
  const gaugeAng: number[] = []
  const IX_AV_GAUGE = launchNeon.length
  for (let i = 0; i < N_TABLES; i++) {
    const a = -Math.PI * 0.62 + (i / (N_TABLES - 1)) * Math.PI * 1.24
    gaugeAng.push(a)
    ln([AX + GAUGE_R * Math.cos(a), 6.4, AZ + GAUGE_R * Math.sin(a), 1.6, 3, 1.6])
  }
  const IX_AV_CAB = launchNeon.length
  ln([AX, 32.6, AZ - 6.5, 9, 2.4, 0.14])
  ln([AX, 32.6, AZ + 6.5, 9, 2.4, 0.14])
  ln([AX - 6.5, 32.6, AZ, 0.14, 2.4, 9])
  ln([AX + 6.5, 32.6, AZ, 0.14, 2.4, 9])
  const AV_CAB_N = 4
  const IX_AV_BUSY = launchNeon.length
  for (let i = 0; i < N_VAC_WORKERS; i++) ln([AX - 8 + i * 8, 5.6, AZ + 9.4, 2.2, 0.9, 0.4])
  const IX_AV_NAP = ln([AX, 5.6, AZ - 9.4, 12, 0.7, 0.4])
  const IX_AV_TOP = ln([AX, 38.4, AZ, 1.3, 1.3, 1.3])
  // the rotating scanner: bar, leading head, trailing lamp — placed every frame
  const IX_AV_SCAN = launchNeon.length
  ln([AX, 37.4, AZ, 16, 0.35, 0.6])
  ln([AX, 37.4, AZ, 1.4, 0.7, 1.0])
  ln([AX, 37.4, AZ, 1.0, 0.5, 0.7])
  const launchNeonMesh = neonBatch(gLaunch, launchNeon)
  launchNeonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)

  signs.plate('autovacuum launcher', AX, 41.4, AZ, 'north', 1.6, COLOR.vacuum, 1.0)
  signs.plate('autovacuum_naptime', AX, 7.0, AZ - 9.6, 'north', 0.8, COLOR.inkDim, 0.55)
  signs.plate('workers', AX, 7.0, AZ + 9.6, 'south', 0.8, COLOR.inkDim, 0.55)
  const SGN_TABLE: number[] = []
  for (let i = 0; i < N_TABLES; i++) {
    const a = gaugeAng[i]
    SGN_TABLE.push(
      signs.plate(
        TABLES[i].name,
        AX + (GAUGE_R + 2.4) * Math.cos(a), PAINT_Y + 0.02, AZ + (GAUGE_R + 2.4) * Math.sin(a),
        'up', 1.5, TABLES[i].color, 0.55,
      ),
    )
  }

  /* =======================================================================
   * 4. THE DEPOT AND ITS THREE WORKERS.
   * =====================================================================*/

  const gDepot = new THREE.Group()
  gDepot.name = 'vac.depot'
  group.add(gDepot)

  // One slab, running north-south under the bays and on under the tower.
  const depotMass: BoxSpec[] = [[DP[0] + 2, APRON_Y, DP[2], 48, 0.2, 92]]
  const depotDetail: BoxSpec[] = []
  for (let i = 0; i < N_VAC_WORKERS; i++) {
    const b = vacBayPos(i)
    depotMass.push([b[0] - 4, 8.6, b[2], 16, 0.7, 15]) // bay canopy, clear of the masts
    depotDetail.push([b[0] - 11.4, 4.6, b[2] - 7, 1.0, 8.0, 1.0])
    depotDetail.push([b[0] - 11.4, 4.6, b[2] + 7, 1.0, 8.0, 1.0])
    depotDetail.push([b[0] + 3.4, 4.6, b[2] - 7, 1.0, 8.0, 1.0])
    depotDetail.push([b[0] + 3.4, 4.6, b[2] + 7, 1.0, 8.0, 1.0])
    depotDetail.push([b[0] - 12.4, 2.2, b[2], 1.6, 3.6, 1.2])
  }
  const depotStruct = batch(gDepot, unitBox, matStruct, depotMass, true)
  const depotDetailMesh = batch(gDepot, unitBox, matDeep, depotDetail)

  for (let i = 0; i < N_VAC_WORKERS; i++) {
    const b = vacBayPos(i)
    signs.plate(`AV-${i}`, b[0] - 4, PAINT_Y + 0.02, b[2] - 5.4, 'up', 2.4, COLOR.vacuum, 0.4)
  }
  signs.plate('vacuum depot', DP[0] - 4, 8.0, DP[2] - 46, 'north', 1.5, COLOR.vacuum, 0.75)

  /* --- the trucks -------------------------------------------------------- */

  const TRUCK_BODY = 11
  const TRUCK_NEON = 7
  /* Each worker keeps its own body — that is what the picker resolves against —
   * but the wheels and the lamps of all three share one mesh each. */
  const truckWheels = new THREE.InstancedMesh(unitCyl, matTyre, N_VAC_WORKERS * 4)
  truckWheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  truckWheels.frustumCulled = false
  truckWheels.raycast = () => {}
  group.add(truckWheels)
  meshes.push(truckWheels)

  const truckNeon = new THREE.InstancedMesh(unitBox, neonWhite, N_VAC_WORKERS * TRUCK_NEON)
  truckNeon.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  truckNeon.frustumCulled = false
  truckNeon.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let k = 0; k < N_VAC_WORKERS * TRUCK_NEON; k++) truckNeon.setColorAt(k, _c)
  truckNeon.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  group.add(truckNeon)
  meshes.push(truckNeon)

  const trucks: Truck[] = []
  for (let i = 0; i < N_VAC_WORKERS; i++) {
    const g = new THREE.Group()
    g.name = `autovac.worker.${i}`
    group.add(g)

    const body = new THREE.InstancedMesh(unitBox, matVehicle, TRUCK_BODY)
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    body.frustumCulled = false
    g.add(body)
    meshes.push(body)

    const b = vacBayPos(i)
    const bayX = b[0] - 4
    const bayZ = b[2]
    // The way home from the landfill tipping deck, down the ramp and past the pile.
    const home = new THREE.CatmullRomCurve3(
      [
        new THREE.Vector3(LF[0], 8.8, LF[2]),
        new THREE.Vector3(LF[0] - 13, 8.6, LF[2]),
        new THREE.Vector3(LF[0] - 18, 4.0, LF[2] - 6),
        new THREE.Vector3(LF[0] - 12, ROAD_Y, LF[2] - 24),
        new THREE.Vector3(bayX - 8, ROAD_Y, bayZ + 26),
        new THREE.Vector3(bayX, ROAD_Y, bayZ),
      ],
      false,
      'catmullrom',
      0.5,
    )
    home.getPointAt(0, _p) // warm the arc-length cache off the hot path

    trucks.push({
      slot: i,
      group: g,
      body,
      wheel0: i * 4,
      neon0: i * TRUCK_NEON,
      panelTop: signs.live('AV-0 idle', 1.6, COLOR.vacuum, 1.0),
      panelBot: signs.live('in bay', 1.15, COLOR.inkDim, 0.7),
      focus: [bayX, 3, bayZ],
      pos: new THREE.Vector3(bayX, ROAD_Y, bayZ),
      prev: new THREE.Vector3(bayX, ROAD_Y, bayZ),
      bay: new THREE.Vector3(bayX, ROAD_Y, bayZ),
      launchFrom: new THREE.Vector3(bayX, ROAD_Y, bayZ),
      home,
      yaw: 0, // parked nose-east, pointing at the depot exit
      bank: 0,
      pitch: 0,
      hopper: 0,
      scoop: 0,
      carry: 0,
      spin: 0,
      tilt: 0,
      homing: 0,
      wasActive: false,
      prevPhase: 'idle',
      dumped: false,
      expected: 1,
      panelT: 0,
    })
  }

  /* =======================================================================
   * 5. LANDFILL — what vacuum actually gives back.
   *
   *    Not disk. The file does not shrink; the space is recorded in the free
   *    space map and the next insert lands in it. The pile fades because that
   *    space gets used again — and it stays empty when the horizon is frozen.
   * =====================================================================*/

  const gLand = new THREE.Group()
  gLand.name = 'landfill'
  group.add(gLand)

  const PILE_X = LF[0] + 7
  const PILE_Z = LF[2]
  const DECK_X = LF[0] - 5

  const landStruct = batch(gLand, unitBox, matStruct, [
    [LF[0] - 2, APRON_Y, LF[2], 32, 0.2, 34], // apron
    [DECK_X, 7.6, LF[2], 16, 0.9, 13], // tipping deck
    [DECK_X - 7.4, 3.9, LF[2] - 5.6, 1.4, 7.4, 1.4],
    [DECK_X - 7.4, 3.9, LF[2] + 5.6, 1.4, 7.4, 1.4],
    [DECK_X + 7.4, 3.9, LF[2] - 5.6, 1.4, 7.4, 1.4],
    [DECK_X + 7.4, 3.9, LF[2] + 5.6, 1.4, 7.4, 1.4],
    [PILE_X + 11, 2.4, PILE_Z, 1.6, 4.5, 26], // retaining walls
    [PILE_X, 2.4, PILE_Z - 12.4, 24, 4.5, 1.6],
    [PILE_X, 2.4, PILE_Z + 12.4, 24, 4.5, 1.6],
  ], true)

  const landDetailMesh = batch(gLand, unitBox, matDeep, [
    [DECK_X, 8.9, LF[2] - 6.4, 16, 1.6, 0.14], // deck rails
    [DECK_X, 8.9, LF[2] + 6.4, 16, 1.6, 0.14],
    [DECK_X - 8.0, 8.9, LF[2], 0.14, 1.6, 13],
    [DECK_X - 10, 4.2, LF[2], 8, 0.5, 6], // approach ramp up to the deck
    [DECK_X - 10, 2.8, LF[2] - 2.8, 8, 3.4, 0.4],
    [DECK_X - 10, 2.8, LF[2] + 2.8, 8, 3.4, 0.4],
  ])

  /* Fixtures first, then the pile — one instanced mesh for the whole site. */
  const N_DEBRIS = low ? 120 : 300
  const landNeon: BoxSpec[] = [
    [DECK_X + 8.2, 8.4, LF[2], 0.3, 1.4, 12], // tipping edge
    [PILE_X + 11.85, 2.4, PILE_Z, 0.14, 0.6, 24], // wall trim
    [DECK_X - 6, 10.6, LF[2] - 6.6, 1.0, 1.0, 1.0], // gate lamp
  ]
  const IX_LF_DEBRIS = landNeon.length
  for (let i = 0; i < N_DEBRIS; i++) landNeon.push([PILE_X, 1, PILE_Z, 1, 1, 1])
  const landNeonMesh = neonBatch(gLand, landNeon)
  landNeonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  landNeonMesh.frustumCulled = false
  for (let i = 0; i < N_DEBRIS; i++) zeroInst(landNeonMesh, IX_LF_DEBRIS + i, PILE_X, 1, PILE_Z)
  landNeonMesh.instanceMatrix.needsUpdate = true

  const dbX = new Float32Array(N_DEBRIS)
  const dbZ = new Float32Array(N_DEBRIS)
  const dbYs = new Float32Array(N_DEBRIS) // spawn height
  const dbYr = new Float32Array(N_DEBRIS) // resting height
  const dbFall = new Float32Array(N_DEBRIS)
  const dbAge = new Float32Array(N_DEBRIS)
  const dbS = new Float32Array(N_DEBRIS)
  const dbRot = new Float32Array(N_DEBRIS)
  const dbLive = new Uint8Array(N_DEBRIS)
  let dbNext = 0
  let dbCount = 0

  signs.plate('landfill', DECK_X, 12.6, LF[2] - 6.8, 'north', 1.5, COLOR.vacuum, 0.9)
  signs.plate('space goes back to the table,', PILE_X, PAINT_Y + 0.02, PILE_Z + 15, 'up', 1.5, COLOR.inkDim, 0.42)
  signs.plate('never to the filesystem', PILE_X, PAINT_Y + 0.02, PILE_Z + 19, 'up', 1.5, COLOR.inkDim, 0.42)

  /* =======================================================================
   * 6. LOGGING COLLECTOR — the tape.
   *
   *    A line only exists here because a setting says so: a statement over
   *    log_min_duration_statement, a lock wait over deadlock_timeout, a
   *    checkpoint, an autovacuum. The long bright ones are the slow queries.
   * =====================================================================*/

  const gLog = new THREE.Group()
  gLog.name = 'logger'
  group.add(gLog)

  const GX = LG[0] // -140
  /** Pulled 3m north of the anchor so the hall stays on the district slab. */
  const GZ = LG[2] - 3 // 97
  const TAPE_Y = 13.4
  const TAPE_Z = GZ - 7.4
  const TAPE_X0 = GX + 10 // write head (east)
  const TAPE_X1 = GX - 10 // take-up reel (west)

  const logStruct = batch(gLog, unitBox, matStruct, [
    [GX, APRON_Y, GZ - 1, 34, 0.2, 20],
    [GX, 5.4, GZ, 28, 9.6, 18], // hall
    [GX, 10.6, GZ, 29.4, 0.9, 19.4], // cornice
    [GX - 10, 13.6, GZ + 2, 6, 5, 8], // spool house
  ], true)

  const logDetailMesh = batch(gLog, unitBox, matDeep, [
    [GX, 3.2, GZ - 9.15, 27, 0.5, 0.5],
    [GX, 7.2, GZ - 9.15, 27, 0.5, 0.5],
    [GX + 12, 5.4, GZ - 9.3, 2.6, 5.4, 0.4], // door
    [GX, TAPE_Y, TAPE_Z, 21, 0.16, 0.5], // the tape
    [GX, TAPE_Y - 1.6, TAPE_Z, 21, 0.14, 0.4], // return run
    [TAPE_X0 + 1.8, TAPE_Y + 1.7, TAPE_Z, 1.4, 2.6, 1.4], // write head
    [GX + 4, 11.6, GZ - 9.4, 0.6, 4, 0.6],
    [GX - 4, 11.6, GZ - 9.4, 0.6, 4, 0.6],
  ])

  const reelQuat = new THREE.Quaternion().setFromAxisAngle(_axisX, Math.PI / 2)
  const logReels = new THREE.InstancedMesh(unitCyl, matHeavy, 4)
  setTRS(logReels, 0, TAPE_X0, TAPE_Y, TAPE_Z, 5.4, 1.2, 5.4, reelQuat)
  setTRS(logReels, 1, TAPE_X1, TAPE_Y, TAPE_Z, 6.4, 1.2, 6.4, reelQuat)
  setTRS(logReels, 2, TAPE_X0, TAPE_Y, TAPE_Z, 1.4, 1.6, 1.4, reelQuat)
  setTRS(logReels, 3, TAPE_X1, TAPE_Y, TAPE_Z, 1.4, 1.6, 1.4, reelQuat)
  logReels.instanceMatrix.needsUpdate = true
  gLog.add(logReels)
  meshes.push(logReels)

  const logNeon: BoxSpec[] = []
  const gn = (s: BoxSpec) => (logNeon.push(s), logNeon.length - 1)
  const IX_LG_WIN = gn([GX - 6, 5.6, GZ - 9.2, 8, 0.5, 0.14])
  gn([GX + 6, 5.6, GZ - 9.2, 8, 0.5, 0.14])
  gn([GX, 5.6, GZ + 9.2, 20, 0.5, 0.14])
  const LG_WIN_N = 3
  const IX_LG_HEAD = gn([TAPE_X0 + 1.8, TAPE_Y + 0.6, TAPE_Z, 1.0, 0.4, 1.0])
  const IX_LG_REEL = gn([TAPE_X1, TAPE_Y, TAPE_Z - 0.8, 5.8, 0.1, 5.8])
  /** The entries themselves ride in the same mesh as the fittings. */
  const N_ENTRY = low ? 24 : 44
  const IX_LG_ENTRY = logNeon.length
  for (let i = 0; i < N_ENTRY; i++) gn([TAPE_X0, TAPE_Y, TAPE_Z, 1, 1, 1])

  const logNeonMesh = neonBatch(gLog, logNeon)
  logNeonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  logNeonMesh.frustumCulled = false
  setTRS(logNeonMesh, IX_LG_REEL, TAPE_X1, TAPE_Y, TAPE_Z - 0.8, 5.8, 0.1, 5.8, reelQuat)
  for (let i = 0; i < N_ENTRY; i++) zeroInst(logNeonMesh, IX_LG_ENTRY + i, TAPE_X0, TAPE_Y, TAPE_Z)
  logNeonMesh.instanceMatrix.needsUpdate = true
  const enT = new Float32Array(N_ENTRY)
  const enLen = new Float32Array(N_ENTRY)
  const enCol = new Int32Array(N_ENTRY)
  const enBright = new Float32Array(N_ENTRY)
  const enLive = new Uint8Array(N_ENTRY)

  signs.plate('logging collector', GX, 12.6, GZ - 9.4, 'north', 1.5, COLOR.ink, 0.85)
  signs.plate('log_min_duration_statement', GX + 1, 16.6, TAPE_Z - 0.7, 'north', 0.9, COLOR.warn, 0.5)

  /* =======================================================================
   * 7. STATS RELAY.
   *
   *    There is no stats collector process any more. Since PG15 the
   *    cumulative counters live in shared memory; this is only the feed.
   * =====================================================================*/

  const gStats = new THREE.Group()
  gStats.name = 'stats.collector'
  group.add(gStats)

  const SX = SC[0] // -196
  const SZ = SC[2] //   76

  const statsStruct = batch(gStats, unitBox, matStruct, [
    [SX, APRON_Y, SZ, 24, 0.2, 20],
    [SX, 3.6, SZ, 16, 6, 12],
    [SX, 7.0, SZ, 17, 0.8, 13],
    [SX + 5, 14, SZ, 0.9, 14, 0.9], // relay mast
  ], true)

  const dishAt = new THREE.Vector3(SX + 5, 20.6, SZ)
  const dishAim = new THREE.Vector3(
    ANCHOR.statsShmem[0] - dishAt.x,
    ANCHOR.statsShmem[1] + 8 - dishAt.y,
    ANCHOR.statsShmem[2] - dishAt.z,
  ).normalize()
  const dishGeo = own(new THREE.SphereGeometry(3.4, 16, 8, 0, TAU, 0, Math.PI * 0.35))
  const dish = new THREE.Mesh(dishGeo, matStruct)
  dish.position.copy(dishAt)
  dish.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dishAim)
  gStats.add(dish)

  const statsNeon: BoxSpec[] = []
  const sn = (s: BoxSpec) => (statsNeon.push(s), statsNeon.length - 1)
  const IX_ST_WIN = sn([SX, 3.8, SZ - 6.1, 12, 0.5, 0.14])
  sn([SX, 3.8, SZ + 6.1, 12, 0.5, 0.14])
  const ST_WIN_N = 2
  const IX_ST_CHASE = statsNeon.length
  const CHASE_N = 7
  for (let i = 0; i < CHASE_N; i++) {
    _p3.copy(dishAt).addScaledVector(dishAim, 4 + i * 3.6)
    sn([_p3.x, _p3.y, _p3.z, 0.7, 0.7, 0.7])
  }
  const statsNeonMesh = neonBatch(gStats, statsNeon)

  signs.plate('cumulative statistics', SX, 9.6, SZ - 6.3, 'north', 1.2, COLOR.inkDim, 0.8)
  signs.plate('shared memory since PG15', SX, 8.0, SZ - 6.3, 'north', 0.75, COLOR.inkDim, 0.45)
  signs.plate('this is only a relay', SX, 7.0, SZ - 6.3, 'north', 0.7, COLOR.ok, 0.4)

  /* =======================================================================
   * 8. THE YARD ITSELF — fence, lamps, and paint.
   * =====================================================================*/

  const gYard = new THREE.Group()
  gYard.name = 'maint.yard'
  group.add(gYard)

  const FX0 = -250, FX1 = -120, FZ0 = -64, FZ1 = 104
  const yardPosts: BoxSpec[] = []
  const POST_STEP = 13
  for (let x = FX0; x <= FX1 + 0.01; x += POST_STEP) {
    yardPosts.push([x, 2.0, FZ0, 0.24, 3.2, 0.24])
    yardPosts.push([x, 2.0, FZ1, 0.24, 3.2, 0.24])
  }
  for (let z = FZ0 + POST_STEP; z < FZ1 - 0.01; z += POST_STEP) {
    yardPosts.push([FX0, 2.0, z, 0.24, 3.2, 0.24])
    yardPosts.push([FX1, 2.0, z, 0.24, 3.2, 0.24])
  }
  // two rails per run: the chain link between them is implied, not drawn
  for (const y of [3.4, 1.6]) {
    const th = y > 3 ? 0.1 : 0.08
    yardPosts.push([(FX0 + FX1) / 2, y, FZ0, FX1 - FX0, th, th])
    yardPosts.push([(FX0 + FX1) / 2, y, FZ1, FX1 - FX0, th, th])
    yardPosts.push([FX0, y, (FZ0 + FZ1) / 2, th, th, FZ1 - FZ0])
    yardPosts.push([FX1, y, (FZ0 + FZ1) / 2, th, th, FZ1 - FZ0])
  }

  // Kept clear of the excavation rim (x = -118).
  const LAMPS: readonly (readonly [number, number])[] = [
    [-166, -58], [-130, -58], [-166, -16], [-130, -14],
    [-166, 20], [-130, 56], [-226, -42], [-226, 40],
    [-246, 62], [-178, 92], [-130, 88], [-196, -44],
  ]
  for (const [x, z] of LAMPS) {
    yardPosts.push([x, 6.0, z, 0.5, 11, 0.5])
    yardPosts.push([x + 0.9, 11.6, z, 2.4, 0.4, 0.9])
  }
  const yardDeep = batch(gYard, unitBox, matDeep, yardPosts)

  /* Every static lit thing at ground level in one mesh: painted markings, the
   * bgwriter's circuit, and the lamp heads. */
  const paint: BoxSpec[] = []
  const paintQ: (THREE.Quaternion | null)[] = []
  const paintC: number[] = []
  const PAINT_COL = mixHex(COLOR.warn, COLOR.vacuum, 0.4)
  const pushPaint = (s: BoxSpec, q?: THREE.Quaternion, col = PAINT_COL, bright = 0.22) => {
    paint.push(s)
    paintQ.push(q ? q.clone() : null)
    paintC.push(col, bright)
  }

  // the bgwriter's circuit: 40 dashes for 1024 buffers
  const LOOP_DASH = 40
  for (let i = 0; i < LOOP_DASH; i++) {
    const a = (i / LOOP_DASH) * TAU
    _e.set(0, -a, 0)
    _q.setFromEuler(_e)
    pushPaint(
      [LOOP_X + LOOP_R * Math.cos(a), PAINT_Y, LOOP_Z + LOOP_R * Math.sin(a), 1.7, 0.06, 0.45],
      _q, SODIUM, 0.18,
    )
  }
  for (const [x, z] of LAMPS) pushPaint([x + 1.7, 11.2, z, 1.4, 0.35, 0.8], undefined, SODIUM, 1.3)
  _e.set(0, Math.PI / 4, 0)
  const chevQ = new THREE.Quaternion().setFromEuler(_e)
  for (let i = 0; i < N_VAC_WORKERS; i++) {
    const b = vacBayPos(i)
    const bx = b[0] - 4
    pushPaint([bx, PAINT_Y, b[2] - 6.4, 17, 0.06, 0.4])
    pushPaint([bx, PAINT_Y, b[2] + 6.4, 17, 0.06, 0.4])
    pushPaint([bx - 8.4, PAINT_Y, b[2], 0.4, 0.06, 13])
    for (let k = 0; k < 4; k++) {
      pushPaint([bx + 7 + k * 1.7, PAINT_Y, b[2] - 3.2 + k * 0.2, 2.6, 0.06, 0.6], chevQ)
      pushPaint([bx + 7 + k * 1.7, PAINT_Y, b[2] + 3.2 - k * 0.2, 2.6, 0.06, 0.6], chevQ)
    }
  }
  // haul-road edge, following the real vacuum route out of the depot
  for (let i = 0; i < 24; i++) {
    routePoint(rid.vacGo(2), (i / 24) * 0.3, _p3)
    if (_p3.y < -2) break
    pushPaint([_p3.x, PAINT_Y, _p3.z - 4.4, 2.4, 0.06, 0.34])
    pushPaint([_p3.x, PAINT_Y, _p3.z + 4.4, 2.4, 0.06, 0.34])
  }
  // keep-clear hatching on the apron beside the tipping deck
  for (let i = 0; i < 6; i++) pushPaint([DECK_X - 6 + i * 2.6, PAINT_Y, LF[2] - 13, 0.5, 0.06, 6], chevQ)

  const paintMesh = neonBatch(gYard, paint)
  for (let i = 0; i < paint.length; i++) {
    setBox(paintMesh, i, paint[i], paintQ[i] ?? undefined)
    _c.setHex(paintC[i * 2]).multiplyScalar(paintC[i * 2 + 1])
    paintMesh.setColorAt(i, _c)
  }
  paintMesh.instanceMatrix.needsUpdate = true
  paintMesh.instanceColor!.needsUpdate = true
  paintMesh.raycast = () => {}

  /* --- one blueprint pass for the whole yard ----------------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)

  const signMesh = signs.build()
  group.add(signMesh)

  /* =======================================================================
   * Registration.
   * =====================================================================*/

  let logRate = 0
  let logSlow = 0

  const walFracOf = (s: SimState) =>
    clamp01((s.wal.insertLsn - s.checkpoint.redoLsn) / Math.max(1, s.knobs.maxWalSize * MB))

  ctx.register({
    id: 'checkpointer',
    name: 'checkpointer',
    role: 'writes every dirty page, then fsyncs — the latency spike you feel',
    kind: 'process',
    district: 'maintenance',
    object: gCkpt,
    tier: 0,
    focus: { target: [CX, 12, CZ], distance: 98, dir: [0.82, 0.44, 0.36] },
    labelAt: [HALL_X, 30, CZ],
    color: COLOR.checkpoint,
    readout: (s: SimState) => {
      const c = s.checkpoint
      if (c.phase !== 'idle') {
        return `${c.phase} ${fmtPct(c.progress)} · ${fmtNum(c.buffersWritten)}/${fmtNum(c.buffersToWrite)} buffers · ${c.reason}-triggered`
      }
      const wf = walFracOf(s)
      const tf = 1 - clamp01(c.nextInSec / Math.max(1, s.knobs.checkpointTimeout))
      const lead = wf > tf ? `max_wal_size ${fmtPct(wf)}` : `timeout ${fmtPct(tf)}`
      return `idle · next in ${Math.max(0, c.nextInSec).toFixed(0)}s (${lead}) · last took ${fmtDuration(c.lastDuration)}`
    },
  })

  ctx.register({
    id: 'bgwriter',
    name: 'background writer',
    role: 'trickles out the pages the clock hand is about to hand over',
    kind: 'process',
    district: 'maintenance',
    object: gBgw,
    tier: 0,
    focus: { target: [BX, 8, BZ], distance: 78, dir: [0.78, 0.46, 0.44] },
    labelAt: [BX - 15, 16, BZ],
    color: COLOR.bgwriter,
    readout: (s: SimState) => {
      const dirty = s.buffers.size > 0 ? s.buffers.dirtyCount / s.buffers.size : 0
      if (!s.bgwriter.enabled) {
        return `parked — bgwriter off · ${fmtNum(s.buffers.dirtyCount)} dirty (${fmtPct(dirty)}) · backends writing their own`
      }
      return `${s.bgwriter.cleanedPerSec.toFixed(0)} pages/s cleaned · pool ${fmtPct(dirty)} dirty`
    },
  })

  ctx.register({
    id: 'autovac.launcher',
    name: 'autovacuum launcher',
    role: 'wakes every naptime and forks a worker for the neediest table',
    kind: 'process',
    district: 'maintenance',
    object: gLaunch,
    tier: 0,
    focus: { target: [AX, 20, AZ], distance: 90, dir: [0.6, 0.44, 0.66] },
    labelAt: [AX, 44, AZ],
    color: COLOR.vacuum,
    readout: (s: SimState) => {
      if (!s.autovac.enabled) return 'autovacuum off — dead tuples accumulate for ever'
      let busy = 0
      for (let i = 0; i < s.autovac.workers.length; i++) if (s.autovac.workers[i].active) busy++
      let over = 0
      for (let i = 0; i < s.tables.length; i++) if (s.tables[i].deadTuples > s.tables[i].vacuumThreshold) over++
      return `next launch in ${Math.max(0, s.autovac.nextLaunchSec).toFixed(0)}s · ${busy}/${N_VAC_WORKERS} workers busy · ${over} tables over threshold`
    },
  })

  for (let i = 0; i < N_VAC_WORKERS; i++) {
    const tr = trucks[i]
    ctx.register({
      id: `autovac.worker.${i}`,
      name: `autovacuum worker ${i}`,
      role: 'scans a table and removes what MVCC left behind — if allowed to',
      kind: 'process',
      district: 'maintenance',
      object: tr.group,
      tier: 1,
      focus: { target: tr.focus, distance: 38, dir: [0.7, 0.5, 0.5] },
      color: COLOR.vacuum,
      readout: (s: SimState) => {
        const w = s.autovac.workers[i]
        if (!w.active) return 'idle in bay'
        const t = s.tables[w.table]
        if (w.stalledByHorizon) {
          return `${t.def.name} · ${w.phase} · BLOCKED by xmin horizon — 0 of ${fmtNum(t.deadTuples)} removable`
        }
        return `${t.def.name} · ${w.phase} · ${fmtNum(w.deadCollected)} dead tuples collected`
      },
    })
  }

  ctx.register({
    id: 'landfill',
    name: 'reclaimed space',
    role: 'removed tuples — reusable inside the file, never returned to disk',
    kind: 'storage',
    district: 'maintenance',
    object: gLand,
    tier: 1,
    focus: { target: [PILE_X - 4, 4, PILE_Z], distance: 60, dir: [0.55, 0.5, 0.66] },
    labelAt: [PILE_X, 12, PILE_Z],
    color: COLOR.vacuum,
    readout: (s: SimState) => {
      let dead = 0
      for (let i = 0; i < s.tables.length; i++) dead += s.tables[i].deadTuples
      return `${fmtNum(s.autovac.landfill)} tuples reclaimed · ${fmtNum(dead)} still dead in the heap`
    },
  })

  ctx.register({
    id: 'logger',
    name: 'logging collector',
    role: 'the only reason an incident is diagnosable afterwards',
    kind: 'process',
    district: 'maintenance',
    object: gLog,
    tier: 1,
    focus: { target: [GX, 8, GZ - 4], distance: 64, dir: [0.42, 0.42, -0.8] },
    labelAt: [GX, 18, GZ],
    color: COLOR.ink,
    readout: (s: SimState) =>
      `${logRate.toFixed(1)} entries/s · ${logSlow} slow · ${s.locks.length} lock waits · ${fmtNum(s.checkpoint.count)} checkpoints`,
  })

  ctx.register({
    id: 'stats.collector',
    name: 'statistics relay',
    role: 'no collector process since PG15 — the counters live in shared memory',
    kind: 'memory',
    district: 'maintenance',
    object: gStats,
    tier: 1,
    focus: { target: [SX, 6, SZ], distance: 50, dir: [0.6, 0.5, 0.6] },
    labelAt: [SX, 16, SZ],
    color: COLOR.inkDim,
    readout: (s: SimState) =>
      `${fmtNum(s.stats.tps)} tps · ${fmtPct(s.stats.cacheHitPct / 100, 1)} hit · relaying to stats.shmem`,
  })

  /* =======================================================================
   * Runtime state. Nothing below here allocates.
   * =====================================================================*/

  let prevT = -1
  let prevWritten = -1
  let prevEvict = -1
  let ckptPps = 0
  let evictRate = 0
  let wheelAngle = 0
  let scanAngle = 0
  let shake = 0
  let pressure = 0.1
  let syncFlash = 0
  let fpiFlash = 0
  let launchFlash = 0
  let sweepAngle = 0
  let sweepPark = 0
  let statsAcc = 0
  let statsBeat = 0
  let logAcc = 0
  let logWin = 0
  let logSlowAcc = 0
  let tapeSpin = 0
  let headFlash = 0
  const tableFlash = new Float32Array(N_TABLES)

  // Per-backend statement timers, so the logger spools real durations.
  const qT = new Float32Array(N_BACKEND_SLOTS)
  const qOn = new Uint8Array(N_BACKEND_SLOTS)
  const qBlocked = new Uint8Array(N_BACKEND_SLOTS)
  /** log_min_duration_statement, in simulated seconds. */
  const LOG_MIN_DURATION = 0.4
  const LOG_SLOW = 1.1

  function pushEntry(len: number, color: number, bright: number): void {
    for (let k = 0; k < N_ENTRY; k++) {
      if (!enLive[k]) {
        enLive[k] = 1
        enT[k] = 0
        enLen[k] = len
        enCol[k] = color
        enBright[k] = bright
        headFlash = 1
        logAcc += 1
        return
      }
    }
  }

  function spawnDebris(fromX: number, fromY: number, fromZ: number): void {
    let i = -1
    for (let k = 0; k < N_DEBRIS; k++) {
      const j = (dbNext + k) % N_DEBRIS
      if (!dbLive[j]) {
        i = j
        break
      }
    }
    if (i < 0) i = dbNext % N_DEBRIS // full: recycle the oldest, most faded piece
    else dbCount++
    dbNext = (i + 1) % N_DEBRIS
    dbLive[i] = 1
    // A cone: the closer to the middle, the higher it can rest.
    const a = rng() * TAU
    const r = Math.sqrt(rng()) * 8.4
    const h = Math.max(0, 1 - r / 8.4) * 5.0 * (0.4 + rng() * 0.6)
    dbX[i] = lerp(fromX, PILE_X + Math.cos(a) * r, 0.92)
    dbZ[i] = lerp(fromZ, PILE_Z + Math.sin(a) * r, 0.92)
    dbYs[i] = fromY
    dbYr[i] = YARD + 0.4 + h
    dbFall[i] = 0
    dbAge[i] = 0
    dbS[i] = 0.7 + rng() * 1.1
    dbRot[i] = rng() * TAU
  }

  /* --- worker routing ----------------------------------------------------- */

  /**
   * Keep a vehicle on the surface until it is well inside the excavation, then
   * let it follow the road down. The routes dive below y=0 while still over
   * solid ground; a truck may not. It descends the pit face instead.
   */
  function haulY(x: number, z: number, routeY: number): number {
    const d = Math.max(Math.abs(x) - CITY.pit.x, Math.abs(z) - CITY.pit.z)
    const k = 1 - smoothstep((d + 38) / 24) // surface until 14m inside the rim
    return lerp(ROAD_Y, routeY, k)
  }

  /** Sample the road a worker is on for its phase, into _p. */
  function truckRoute(tr: Truck, phase: VacPhase, table: number, progress: number, travel: number): void {
    const go = rid.vacGo(table)
    switch (phase) {
      case 'travel': {
        if (travel < 0.12) {
          // Pull out onto the haul road from wherever the worker was standing:
          // a free worker can be re-tasked before it has finished coming home.
          const k = smoothstep(travel / 0.12)
          routePoint(go, 0, _p2)
          _p.set(
            lerp(tr.launchFrom.x, _p2.x, k),
            lerp(tr.launchFrom.y, ROAD_Y, k),
            lerp(tr.launchFrom.z, _p2.z, k),
          )
          return
        }
        routePoint(go, (travel - 0.12) / 0.88, _p)
        break
      }
      case 'scan_heap':
        // Working the heap: crawl out over it and back, the pass that finds
        // the dead rows. Out-and-back so the worker starts and ends where the
        // travel road left it, with no jump at the phase change.
        routePoint(go, 1 - 0.1 * Math.sin(Math.PI * clamp01(progress)), _p)
        break
      case 'vacuum_index':
        // Out to the index structure and back, once per index — a round trip,
        // so the worker is always at the heap end when the phase changes.
        routePoint(rid.vacIdx(table), Math.sin(Math.PI * clamp01(progress)), _p)
        break
      case 'vacuum_heap':
        // the second pass, where the line pointers actually come back
        routePoint(go, 1 - 0.07 * Math.sin(Math.PI * clamp01(progress)), _p)
        break
      case 'return':
        routePoint(rid.vacBack(table), clamp01(progress), _p)
        break
      default:
        routePoint(go, 1, _p)
    }
    _p.y = haulY(_p.x, _p.z, _p.y)
  }

  /** Orientation for a stationary worker: face along the road it is parked on. */
  function truckTangent(phase: VacPhase, table: number, progress: number, travel: number): void {
    switch (phase) {
      case 'travel':
        routeTangent(rid.vacGo(table), clamp01((travel - 0.12) / 0.88), _dir)
        break
      case 'vacuum_index':
        routeTangent(rid.vacIdx(table), Math.sin(Math.PI * clamp01(progress)), _dir)
        if (progress > 0.5) _dir.negate() // heading home along the same road
        break
      case 'return':
        routeTangent(rid.vacBack(table), clamp01(progress), _dir)
        break
      default:
        routeTangent(rid.vacGo(table), 0.98, _dir)
    }
    _dir.y *= 0.4
    if (_dir.lengthSq() < 1e-8) _dir.set(1, 0, 0)
    else _dir.normalize()
  }

  const PHASE_LABEL: Record<VacPhase, string> = {
    idle: 'idle',
    travel: 'travel',
    scan_heap: 'scan_heap',
    vacuum_index: 'vacuum_index',
    vacuum_heap: 'vacuum_heap',
    truncate: 'truncate',
    analyze: 'analyze',
    return: 'return',
  }

  const offCkEnd = ctx.bus.on('checkpoint:end', () => {
    fpiFlash = 1
  })
  const offCkStart = ctx.bus.on('checkpoint:start', (p) => {
    pushEntry(1.8, p.reason === 'wal' ? COLOR.crit : COLOR.checkpoint, 1.9)
  })
  const offReset = ctx.bus.on('sim:reset', () => {
    for (let i = 0; i < N_DEBRIS; i++) {
      dbLive[i] = 0
      zeroInst(landNeonMesh, IX_LF_DEBRIS + i, PILE_X, 1, PILE_Z)
    }
    landNeonMesh.instanceMatrix.needsUpdate = true
    dbCount = 0
    dbNext = 0
    for (let i = 0; i < N_ENTRY; i++) {
      enLive[i] = 0
      zeroInst(logNeonMesh, IX_LG_ENTRY + i, TAPE_X0, TAPE_Y, TAPE_Z)
    }
    logNeonMesh.instanceMatrix.needsUpdate = true
    prevWritten = -1
    prevEvict = -1
  })

  /* =======================================================================
   * UPDATE
   * =====================================================================*/

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated dt — freezes when paused
    prevT = t

    const ck = sim.checkpoint
    const bgw = sim.bgwriter
    const av = sim.autovac
    const buf = sim.buffers

    /* --- 1. CHECKPOINTER ------------------------------------------------ */

    const writing = ck.phase === 'writing'
    const syncing = ck.phase === 'syncing'
    const running = ck.phase !== 'idle'

    if (prevWritten < 0 || ck.buffersWritten < prevWritten) prevWritten = ck.buffersWritten
    const dWritten = ck.buffersWritten - prevWritten
    prevWritten = ck.buffersWritten
    ckptPps = damp(ckptPps, dts > 1e-4 ? dWritten / dts : 0, 4, dt)

    // The wheel turns at the rate pages are actually leaving, so a high
    // checkpoint_completion_target — same work, more time — is a slower wheel.
    wheelAngle += dt * (running ? 0.4 + clamp01(ckptPps / 90) * 7.5 : 0.12)
    if (wheelAngle > TAU) wheelAngle -= TAU
    wheelGroup.rotation.z = wheelAngle

    // Pressure builds through the write phase and spikes on fsync.
    const pTarget = syncing ? 1 : writing ? 0.35 + ck.progress * 0.4 : running ? 0.3 : 0.1
    pressure = damp(pressure, pTarget, syncing ? 9 : 2.2, dt)
    syncFlash = syncing ? 1 : Math.max(0, syncFlash - dt * 1.6)

    // The sync phase is where a checkpoint hurts. Everything shudders.
    shake = damp(shake, syncing ? 1 : 0, syncing ? 12 : 4, dt)
    const jit = shake * 0.16
    gCkpt.position.set(Math.sin(t * 61.3) * jit, Math.sin(t * 47.7) * jit * 0.7, Math.cos(t * 53.1) * jit)

    // Cause and effect: every page's first change after this owes a full image.
    fpiFlash = Math.max(fpiFlash - dt * 0.8, sim.wal.fpwBurst)

    const timeFrac = 1 - clamp01(ck.nextInSec / Math.max(1, sim.knobs.checkpointTimeout))
    const walFrac = walFracOf(sim)
    const walWinning = walFrac > timeFrac + 0.02
    for (let ring = 0; ring < 2; ring++) {
      const frac = ring === 0 ? timeFrac : walFrac
      const base = ring === 0 ? COLOR.checkpoint : walWinning ? COLOR.crit : COLOR.wal
      const lead = ring === 0 ? !walWinning : walWinning
      const head = frac * DIAL_N
      for (let i = 0; i < DIAL_N; i++) {
        let b: number
        if (i < head - 1) b = lead ? 1.15 : 0.55
        else if (i < head) b = (lead ? 2.4 : 1.3) * (0.7 + 0.3 * Math.sin(t * 9))
        else b = 0.07
        _c.setHex(base).multiplyScalar(b)
        ckptNeonMesh.setColorAt(IX_CK_DIAL + ring * DIAL_N + i, _c)
      }
    }
    signs.setColor(SGN_MAXWAL, walWinning ? COLOR.crit : COLOR.wal, walWinning ? 1.3 : 0.4)
    signs.setColor(
      SGN_CKREASON,
      COLOR.crit,
      running && ck.reason === 'wal' ? 1.4 + 0.5 * Math.sin(t * 6) : walWinning ? 0.55 : 0.06,
    )
    signs.setColor(SGN_CKPT, COLOR.checkpoint, running ? 1.5 : 0.85)

    _c.setHex(COLOR.checkpoint).multiplyScalar(running ? 0.5 + ck.progress * 0.9 : 0.16)
    for (let i = 0; i < CK_SLITS; i++) ckptNeonMesh.setColorAt(IX_CK_SLIT + i, _c)

    const barLen = Math.max(0.12, ck.progress * GAUGE_LEN)
    setTRS(ckptNeonMesh, IX_CK_BAR, HALL_E + 0.5, 13.4, GAUGE_Z0 + barLen / 2, 0.5, 1.5, barLen)
    _c.setHex(COLOR.checkpoint).multiplyScalar(running ? 1.9 : 0.1)
    ckptNeonMesh.setColorAt(IX_CK_BAR, _c)
    _c.setHex(COLOR.checkpoint).multiplyScalar(0.14)
    ckptNeonMesh.setColorAt(IX_CK_TRACK, _c)
    for (let i = 0; i < CK_TICKS; i++) {
      _c.setHex(COLOR.inkDim).multiplyScalar(running && i / 10 <= ck.progress ? 0.9 : 0.12)
      ckptNeonMesh.setColorAt(IX_CK_TICK + i, _c)
    }

    for (let i = 0; i < 3; i++) {
      const wob = syncing ? 1 + 0.18 * Math.sin(t * 26 + i) : 1
      const h = Math.max(0.3, pressure * 12 * wob)
      setTRS(ckptNeonMesh, IX_CK_PRES + i, CX - 20.6, 6.5 + h / 2, CZ - 11 + i * 11, 0.4, h, 0.4)
      _c.setHex(pressure > 0.8 ? COLOR.crit : COLOR.checkpoint).multiplyScalar(0.4 + pressure * 1.9)
      ckptNeonMesh.setColorAt(IX_CK_PRES + i, _c)
    }
    ckptNeonMesh.instanceMatrix.needsUpdate = true

    for (let i = 0; i < 5; i++) {
      const chase = syncing ? 0.5 + 0.5 * Math.sin(t * 14 - i * 1.1) : 0
      _c.setHex(COLOR.crit).multiplyScalar(0.08 + syncFlash * (0.6 + chase * 2.4))
      ckptNeonMesh.setColorAt(IX_CK_FSYNC + i, _c)
    }
    for (let i = 0; i < 6; i++) {
      const lit = fpiFlash > i / 6 ? 1 : 0
      _c.setHex(COLOR.wal).multiplyScalar(0.05 + lit * (0.5 + fpiFlash * 1.9))
      ckptNeonMesh.setColorAt(IX_CK_FPI + i, _c)
    }
    _c.setHex(walWinning || ck.reason === 'wal' ? COLOR.crit : COLOR.checkpoint)
      .multiplyScalar(running ? 1.2 + 1.2 * Math.abs(Math.sin(t * 3.4)) : 0.35)
    ckptNeonMesh.setColorAt(IX_CK_BEACON, _c)
    _c.setHex(COLOR.crit).multiplyScalar(0.3 + 0.7 * Math.max(0, Math.sin(t * 2.1)))
    ckptNeonMesh.setColorAt(IX_CK_BEACON2, _c)
    _c.setHex(COLOR.checkpoint).multiplyScalar(writing ? 1.4 + 0.6 * Math.sin(t * 8) : 0.12)
    ckptNeonMesh.setColorAt(IX_CK_VALVE, _c)
    ckptNeonMesh.instanceColor!.needsUpdate = true

    /* --- 2. BGWRITER ----------------------------------------------------- */

    const bgOn = bgw.enabled
    sweepPark = damp(sweepPark, bgOn ? 0 : 1, 2.2, dt)

    // The sweeper's lap position IS the clock hand's position in the pool.
    const scanTarget = (bgw.scanPos / Math.max(1, N_BUFFERS)) * TAU
    if (bgOn) sweepAngle = advanceAngle(sweepAngle, scanTarget, dt * (0.4 + clamp01(bgw.activity) * 3.2))

    // parked outside the shed door, dark, while the pool goes on getting dirtier
    const sxp = lerp(LOOP_X + LOOP_R * Math.cos(sweepAngle), BX - 15, sweepPark)
    const szp = lerp(LOOP_Z + LOOP_R * Math.sin(sweepAngle), BZ + 12, sweepPark)
    gSweep.position.set(sxp, ROAD_Y, szp)
    gSweep.rotation.y = lerp(-sweepAngle - Math.PI / 2, Math.PI / 2, smoothstep(sweepPark))

    const bgAct = bgOn ? clamp01(bgw.activity) : 0
    _c.setHex(COLOR.bgwriter).multiplyScalar(bgOn ? 0.35 + bgAct * 0.9 : 0.04)
    for (let i = 0; i < BG_SHED_N; i++) bgwNeonMesh.setColorAt(IX_BG_SHED + i, _c)

    const dirtyFrac = buf.size > 0 ? clamp01(buf.dirtyCount / buf.size) : 0
    const dirtyLit = Math.round(dirtyFrac * TOTEM_N)
    for (let i = 0; i < TOTEM_N; i++) {
      const hot = i / TOTEM_N > 0.55
      _c.setHex(hot ? COLOR.crit : COLOR.bufDirty).multiplyScalar(i < dirtyLit ? (hot ? 1.9 : 1.1) : 0.06)
      bgwNeonMesh.setColorAt(IX_BG_DIRTY + i, _c)
    }

    if (prevEvict < 0 || buf.dirtyEvictions < prevEvict) prevEvict = buf.dirtyEvictions
    const dEvict = buf.dirtyEvictions - prevEvict
    prevEvict = buf.dirtyEvictions
    evictRate = damp(evictRate, dts > 1e-4 ? dEvict / dts : 0, 2.5, dt)
    const evictLit = Math.round(clamp01(evictRate / 40) * TOTEM_N)
    for (let i = 0; i < TOTEM_N; i++) {
      _c.setHex(i / TOTEM_N > 0.5 ? COLOR.crit : COLOR.warn).multiplyScalar(i < evictLit ? 1.5 : 0.06)
      bgwNeonMesh.setColorAt(IX_BG_EVICT + i, _c)
    }

    _c.setHex(COLOR.bgwriter).multiplyScalar(bgOn ? 0.25 + bgAct * 1.8 : 0.03)
    bgwNeonMesh.setColorAt(IX_BG_CHUTE, _c)
    _c.setHex(COLOR.crit).multiplyScalar(bgOn ? 0.04 : 1.2 + 0.6 * Math.sin(t * 3.2))
    bgwNeonMesh.setColorAt(IX_BG_OFF, _c)
    bgwNeonMesh.instanceColor!.needsUpdate = true
    signs.setColor(SGN_BGOFF, COLOR.crit, bgOn ? 0.05 : 1.2)
    signs.setColor(SGN_BGW, COLOR.bgwriter, bgOn ? 1.0 : 0.3)

    _c.setHex(COLOR.bgwriter).multiplyScalar(bgOn ? 0.4 + bgAct * 0.7 : 0.05)
    sweepNeon.setColorAt(0, _c)
    _c.setHex(bgOn ? COLOR.bgwriter : COLOR.inkDim).multiplyScalar(bgOn ? 1.0 + 0.9 * Math.abs(Math.sin(t * 5)) : 0.05)
    sweepNeon.setColorAt(1, _c)
    _c.setHex(COLOR.bufDirty).multiplyScalar(bgOn ? 0.3 + bgAct * 2.0 : 0.02)
    sweepNeon.setColorAt(2, _c)
    sweepNeon.instanceColor!.needsUpdate = true

    /* --- 3. AUTOVACUUM LAUNCHER ------------------------------------------ */

    const avOn = av.enabled
    // one revolution per naptime: the sweep you see is the countdown
    const napFrac = 1 - clamp01(av.nextLaunchSec / NAPTIME)
    if (avOn) scanAngle = advanceAngle(scanAngle, napFrac * TAU, dt * 3.2)
    _e.set(0, -scanAngle, 0)
    _q.setFromEuler(_e)
    _sc.set(1, 1, 1)
    _p.set(AX, 37.4, AZ)
    _mw.compose(_p, _q, _sc)
    setPart(launchNeonMesh, IX_AV_SCAN, _mw, 0, 0, 0, 16, 0.35, 0.6)
    setPart(launchNeonMesh, IX_AV_SCAN + 1, _mw, 7.4, 0, 0, 1.4, 0.7, 1.0)
    setPart(launchNeonMesh, IX_AV_SCAN + 2, _mw, -7.4, 0, 0, 1.0, 0.5, 0.7)
    launchFlash = Math.max(0, launchFlash - dt * 1.4)

    let busy = 0
    for (let i = 0; i < N_VAC_WORKERS; i++) if (av.workers[i].active) busy++

    for (let i = 0; i < N_TABLES; i++) {
      const tb = sim.tables[i]
      const ratio = tb.deadTuples / Math.max(1, tb.vacuumThreshold)
      const h = clamp(ratio, 0.05, 2.2) * 3.4
      setTRS(
        launchNeonMesh, IX_AV_GAUGE + i,
        AX + GAUGE_R * Math.cos(gaugeAng[i]), 5.2 + h / 2, AZ + GAUGE_R * Math.sin(gaugeAng[i]),
        1.6, h, 1.6,
      )
      // the beam passing a table that is over threshold sets it off
      let da = Math.abs(gaugeAng[i] - scanAngle) % TAU
      if (da > Math.PI) da = TAU - da
      if (avOn && ratio > 1 && da < 0.18) tableFlash[i] = 1
      tableFlash[i] = Math.max(0, tableFlash[i] - dt * 1.6)
      const over = ratio > 1
      _c.setHex(over ? COLOR.crit : TABLES[i].color).multiplyScalar(
        (over ? 1.0 : 0.28) + tableFlash[i] * 2.2 + (tb.vacuuming ? 0.6 : 0),
      )
      launchNeonMesh.setColorAt(IX_AV_GAUGE + i, _c)
      signs.setColor(SGN_TABLE[i], over ? COLOR.crit : TABLES[i].color, 0.4 + tableFlash[i] * 1.2 + (over ? 0.5 : 0))
    }

    _c.setHex(COLOR.vacuum).multiplyScalar(avOn ? 0.5 + 0.35 * Math.sin(t * 1.6) : 0.05)
    for (let i = 0; i < AV_CAB_N; i++) launchNeonMesh.setColorAt(IX_AV_CAB + i, _c)
    for (let i = 0; i < N_VAC_WORKERS; i++) {
      const w = av.workers[i]
      _c.setHex(w.stalledByHorizon ? COLOR.crit : COLOR.vacuum).multiplyScalar(w.active ? 1.7 : 0.08)
      launchNeonMesh.setColorAt(IX_AV_BUSY + i, _c)
    }
    const napLen = Math.max(0.2, (1 - napFrac) * 12)
    setTRS(launchNeonMesh, IX_AV_NAP, AX - 6 + napLen / 2, 5.6, AZ - 9.4, napLen, 0.7, 0.4)
    launchNeonMesh.instanceMatrix.needsUpdate = true
    _c.setHex(avOn ? COLOR.vacuum : COLOR.crit).multiplyScalar(avOn ? 0.7 + launchFlash * 2 : 0.5)
    launchNeonMesh.setColorAt(IX_AV_NAP, _c)
    _c.setHex(COLOR.crit).multiplyScalar(0.25 + 0.6 * Math.max(0, Math.sin(t * 2.4)))
    launchNeonMesh.setColorAt(IX_AV_TOP, _c)
    launchNeonMesh.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.vacuum).multiplyScalar(avOn ? 1.3 : 0.05)
    launchNeonMesh.setColorAt(IX_AV_SCAN, _c)
    _c.setHex(COLOR.vacuum).multiplyScalar(avOn ? 2.4 : 0.05)
    launchNeonMesh.setColorAt(IX_AV_SCAN + 1, _c)
    _c.setHex(COLOR.vacuum).multiplyScalar(avOn ? 0.8 : 0.05)
    launchNeonMesh.setColorAt(IX_AV_SCAN + 2, _c)
    launchNeonMesh.instanceColor!.needsUpdate = true

    /* --- 4. THE WORKERS -------------------------------------------------- */

    _right.setFromMatrixColumn(ctx.camera.matrixWorld, 0)
    _up.setFromMatrixColumn(ctx.camera.matrixWorld, 1)

    // An ancient snapshot means nothing found is removable, whatever the truck
    // digs up. The sim confirms it at the end of scan_heap; this predicts it.
    const horizonStale = sim.oldestSnapshotAge > 8

    for (let i = 0; i < N_VAC_WORKERS; i++) {
      const tr = trucks[i]
      const w = av.workers[i]
      const table = sim.tables[w.table]

      if (w.phase !== tr.prevPhase) {
        if (w.phase === 'scan_heap') tr.dumped = false
        if (w.phase === 'vacuum_heap') tr.expected = Math.max(1, table.deadTuples)
        tr.prevPhase = w.phase
      }
      if (w.active && !tr.wasActive) {
        launchFlash = 1
        tr.homing = 0
        tr.dumped = false
        tr.hopper = 0
        tr.launchFrom.copy(tr.pos)
      }
      if (!w.active && tr.wasActive) tr.homing = 1 // coast home from the landfill
      tr.wasActive = w.active

      const stalled = w.stalledByHorizon || (w.active && horizonStale && table.deadTuples > 400)

      tr.prev.copy(tr.pos)
      if (w.active) {
        truckRoute(tr, w.phase, w.table, w.progress, w.travel)
        tr.pos.lerp(_p, 1 - Math.exp(-18 * dt))
      } else if (tr.homing > 0) {
        tr.homing = Math.max(0, tr.homing - dt / 2.6)
        tr.home.getPointAt(clamp01(1 - tr.homing), _p)
        tr.pos.lerp(_p, 1 - Math.exp(-14 * dt))
      } else {
        tr.pos.lerp(tr.bay, 1 - Math.exp(-4 * dt))
      }

      /* Heading comes from the road, not from the frame-to-frame delta: a
       * worker settling onto its parking spot must not spin to face the drift.
       * The climb angle, though, is real motion — the road dives underground
       * where the truck does not. */
      _dir.subVectors(tr.pos, tr.prev)
      const moved = _dir.length()
      const speed = moved / Math.max(1e-4, dt)
      const climb = moved > 1e-5 ? _dir.y / moved : 0
      if (w.active) truckTangent(w.phase, w.table, w.progress, w.travel)
      else if (speed > 1.2) _dir.normalize()
      else _dir.set(1, 0, 0)

      // The chassis is modelled nose-along +X, and Ry maps +X to (cos y, 0, -sin y).
      let dy = Math.atan2(-_dir.z, _dir.x) - tr.yaw
      while (dy > Math.PI) dy -= TAU
      while (dy < -Math.PI) dy += TAU
      const yawRate = dy / Math.max(1e-3, dt)
      tr.yaw += dy * (1 - Math.exp(-7 * dt))
      // roll out of the corner, pitch down the ramp
      tr.bank = damp(tr.bank, clamp(yawRate * 0.05, -0.4, 0.4), 5, dt)
      const pitchTo = speed > 1.2 ? Math.asin(clamp(climb, -1, 1)) * 0.8 : 0
      tr.pitch = damp(tr.pitch, clamp(pitchTo, -0.9, 0.9), 6, dt)
      tr.spin += speed * dt * 1.1

      // The hopper fills as scanning finds dead rows and tops up as they are
      // actually removed — and stays empty when the horizon forbids it.
      let fillTarget = tr.hopper
      switch (w.phase) {
        case 'travel':
          fillTarget = 0
          break
        case 'scan_heap':
          fillTarget = stalled ? 0 : w.progress * 0.72
          break
        case 'vacuum_heap':
          fillTarget = stalled ? 0 : 0.72 + 0.28 * clamp01(w.deadCollected / tr.expected)
          break
        case 'return':
          fillTarget = w.progress > 0.9 ? 0 : tr.hopper
          break
        case 'idle':
          fillTarget = w.active ? tr.hopper : 0
          break
        default:
          fillTarget = stalled ? 0 : tr.hopper
      }
      tr.hopper = damp(tr.hopper, clamp01(fillTarget), w.phase === 'return' ? 6 : 2.4, dt)

      const tipping = w.active && w.phase === 'return' && w.progress > 0.86
      tr.tilt = damp(tr.tilt, tipping ? 0.6 : 0, 5, dt)
      if (tipping && !tr.dumped) {
        tr.dumped = true
        const n = Math.round(clamp01(tr.hopper) * (low ? 10 : 22))
        for (let k = 0; k < n; k++) spawnDebris(tr.pos.x, tr.pos.y + 3.6, tr.pos.z)
        if (n > 0) pushEntry(1.2, COLOR.vacuum, 1.2)
      }

      // The scoop cycles while the worker is at the heap. When the horizon is
      // frozen it comes up empty. Every time. That is the whole lesson.
      const scooping = w.active && (w.phase === 'scan_heap' || w.phase === 'vacuum_heap')
      if (scooping) {
        tr.scoop += dt * 0.85
        if (tr.scoop >= 1) tr.scoop -= 1
      } else {
        tr.scoop = damp(tr.scoop, 0, 5, dt)
      }
      const armA = scooping ? 0.92 * Math.sin(Math.PI * tr.scoop) : 0.1
      const carrying = scooping && !stalled && tr.scoop > 0.5 && tr.scoop < 0.94 ? 1 : 0
      tr.carry = damp(tr.carry, carrying, 12, dt)

      /* world matrix, then every part hung off it */
      _e.set(0, tr.yaw, 0)
      _q.setFromEuler(_e)
      _qa.setFromAxisAngle(_axisZ, tr.pitch) // nose up / down
      _q.multiply(_qa)
      _qa.setFromAxisAngle(_axisX, tr.bank) // lean
      _q.multiply(_qa)
      _sc.set(1, 1, 1)
      _mw.compose(tr.pos, _q, _sc)

      _qa.setFromAxisAngle(_axisZ, -tr.tilt) // hopper tip
      _e.set(0, 0, -armA)
      _qb.setFromEuler(_e) // scoop arm
      const ax = 3.4, ay = 2.4
      const adx = Math.cos(armA) * 2.6, ady = -Math.sin(armA) * 2.6
      const hopY = 3.3 + tr.tilt * 0.9
      const hopX = -1.1 + tr.tilt * 0.5

      setPart(tr.body, 0, _mw, 0, 1.55, 0, 7.2, 0.9, 3.4) // chassis
      setPart(tr.body, 1, _mw, hopX, hopY, 0, 4.6, 2.8, 3.2, _qa) // hopper
      setPart(tr.body, 2, _mw, hopX, hopY + 1.5, 0, 4.9, 0.3, 3.5, _qa) // lip
      setPart(tr.body, 3, _mw, 2.5, 3.2, 0, 2.4, 2.6, 2.9) // cab
      setPart(tr.body, 4, _mw, 2.5, 4.6, 0, 2.6, 0.35, 3.0) // cab roof
      setPart(tr.body, 5, _mw, 3.9, 1.5, 0, 0.5, 1.0, 3.2) // bumper
      setPart(tr.body, 6, _mw, ax + adx * 0.5, ay + ady * 0.5, 0, 2.6, 0.4, 0.4, _qb) // arm
      setPart(tr.body, 7, _mw, ax + adx, ay + ady - 0.3, 0, 1.5, 1.0, 2.6, _qb) // bucket
      setPart(tr.body, 8, _mw, -3.3, 2.2, 0, 0.8, 1.6, 3.4) // tailgate
      setPart(tr.body, 9, _mw, 1.2, 4.5, 1.2, 0.3, 1.9, 0.3) // exhaust
      setPart(tr.body, 10, _mw, 0.2, 6.2, 0, 0.22, 3.6, 0.22) // panel mast
      tr.body.instanceMatrix.needsUpdate = true
      // the truck moves, so the picker must re-measure it
      tr.body.boundingBox = null
      tr.body.boundingSphere = null

      if (truckWheels.visible) {
        _qc.setFromAxisAngle(_axisX, Math.PI / 2)
        _qd.setFromAxisAngle(_axisY, tr.spin)
        _qc.multiply(_qd)
        const w0 = tr.wheel0
        setPart(truckWheels, w0, _mw, 2.3, 0.9, 1.55, 1.8, 0.7, 1.8, _qc)
        setPart(truckWheels, w0 + 1, _mw, 2.3, 0.9, -1.55, 1.8, 0.7, 1.8, _qc)
        setPart(truckWheels, w0 + 2, _mw, -2.3, 0.9, 1.55, 1.8, 0.7, 1.8, _qc)
        setPart(truckWheels, w0 + 3, _mw, -2.3, 0.9, -1.55, 1.8, 0.7, 1.8, _qc)
        truckWheels.instanceMatrix.needsUpdate = true
      }

      const n0 = tr.neon0
      const fh = Math.max(0.05, tr.hopper * 2.3)
      setPart(truckNeon, n0, _mw, hopX, hopY - 1.25 + fh / 2, 0, 4.2, fh, 2.8, _qa)
      setPart(truckNeon, n0 + 1, _mw, 2.5, 3.6, 0, 2.5, 0.9, 2.95)
      setPart(truckNeon, n0 + 2, _mw, 2.5, 5.05, 0, 0.9, 0.55, 0.9)
      setPart(truckNeon, n0 + 3, _mw, 3.95, 2.2, 1.0, 0.3, 0.45, 0.7)
      setPart(truckNeon, n0 + 4, _mw, 3.95, 2.2, -1.0, 0.3, 0.45, 0.7)
      setPart(truckNeon, n0 + 5, _mw, ax + adx, ay + ady - 0.3, 0, 1.0, 0.55, 2.2, _qb)
      setPart(truckNeon, n0 + 6, _mw, -3.55, 3.3, 0, 0.14, 2.0, 3.0, _qa)
      truckNeon.instanceMatrix.needsUpdate = true

      const live = w.active || tr.homing > 0
      _c.setHex(COLOR.vacuum).multiplyScalar(tr.hopper * 2.2 + 0.05)
      truckNeon.setColorAt(n0, _c) // what is in the hopper
      _c.setHex(COLOR.vacuum).multiplyScalar(live ? 0.55 : 0.12)
      truckNeon.setColorAt(n0 + 1, _c)
      if (stalled) _c.setHex(COLOR.crit).multiplyScalar(1.4 + 1.6 * Math.abs(Math.sin(t * 7)))
      else if (live) _c.setHex(COLOR.warn).multiplyScalar(0.7 + 0.9 * Math.abs(Math.sin(t * 3.4)))
      else _c.setHex(COLOR.warn).multiplyScalar(0.06)
      truckNeon.setColorAt(n0 + 2, _c) // beacon
      _c.setHex(COLOR.ink).multiplyScalar(live ? 1.6 : 0.05)
      truckNeon.setColorAt(n0 + 3, _c)
      truckNeon.setColorAt(n0 + 4, _c)
      _c.setHex(COLOR.vacuum).multiplyScalar(tr.carry * 2.6 + 0.04)
      truckNeon.setColorAt(n0 + 5, _c) // what the scoop actually brought up
      _c.setHex(stalled ? COLOR.crit : COLOR.warn).multiplyScalar(live ? 0.5 : 0.08)
      truckNeon.setColorAt(n0 + 6, _c)
      truckNeon.instanceColor!.needsUpdate = true

      // focus follows the truck, so "focus autovac.worker.0" frames the vehicle
      tr.focus[0] = tr.pos.x
      tr.focus[1] = tr.pos.y + 3
      tr.focus[2] = tr.pos.z

      tr.panelT += dt
      if (tr.panelT > 0.2) {
        tr.panelT = 0
        if (!w.active) {
          signs.setLiveText(tr.panelTop, `AV-${i} idle`)
          signs.setLiveText(tr.panelBot, tr.homing > 0 ? 'returning to depot' : 'in bay')
        } else {
          signs.setLiveText(tr.panelTop, `${table.def.name} · ${PHASE_LABEL[w.phase]}`)
          signs.setLiveText(
            tr.panelBot,
            stalled
              ? 'BLOCKED BY XMIN HORIZON'
              : `${fmtNum(Math.round(w.deadCollected / 50) * 50)} dead tuples`,
          )
        }
      }
      const panelY = tr.pos.y + 8.6
      signs.place(tr.panelTop, tr.pos.x, panelY + 1.6, tr.pos.z, _right, _up)
      signs.place(tr.panelBot, tr.pos.x, panelY, tr.pos.z, _right, _up)
      signs.setColor(tr.panelTop.quad, live ? COLOR.vacuum : COLOR.inkDim, live ? 1.3 : 0.35)
      signs.setColor(
        tr.panelBot.quad,
        stalled ? COLOR.crit : COLOR.inkDim,
        stalled ? 1.6 + 0.6 * Math.sin(t * 7) : live ? 0.8 : 0.3,
      )
    }

    /* --- 5. LANDFILL ------------------------------------------------------ */

    for (let i = 0; i < N_DEBRIS; i++) {
      if (!dbLive[i]) continue
      if (dbFall[i] < 1) dbFall[i] = Math.min(1, dbFall[i] + dt * 1.5)
      dbAge[i] += dts
      const age = dbAge[i]
      // It fades because the space is handed back to the table and reused.
      const fade = age > 26 ? Math.max(0, 1 - (age - 26) / 40) : 1
      if (fade <= 0.002) {
        dbLive[i] = 0
        dbCount--
        zeroInst(landNeonMesh, IX_LF_DEBRIS + i, PILE_X, 1, PILE_Z)
        continue
      }
      const k = dbFall[i]
      const y = lerp(dbYs[i], dbYr[i], k * k)
      const settle = clamp01(age / 18) * 0.5
      _e.set(0, dbRot[i], 0)
      _q.setFromEuler(_e)
      const s = dbS[i] * (1 - settle * 0.25)
      setTRS(landNeonMesh, IX_LF_DEBRIS + i, dbX[i], y - settle * 0.4, dbZ[i], s, s * 0.7, s, _q)
      _c.setHex(mixHex(COLOR.vacuum, COLOR.storage, clamp01(age / 30)))
        .multiplyScalar((k < 1 ? 1.8 : 0.5) * fade)
      landNeonMesh.setColorAt(IX_LF_DEBRIS + i, _c)
    }
    landNeonMesh.instanceMatrix.needsUpdate = true

    let stalledAny = false
    for (let i = 0; i < N_VAC_WORKERS; i++) if (av.workers[i].stalledByHorizon) stalledAny = true
    _c.setHex(COLOR.vacuum).multiplyScalar(0.35)
    landNeonMesh.setColorAt(0, _c)
    _c.setHex(SODIUM).multiplyScalar(0.3)
    landNeonMesh.setColorAt(1, _c)
    _c.setHex(stalledAny ? COLOR.crit : dbCount > 0 ? COLOR.ok : COLOR.inkDim)
      .multiplyScalar(stalledAny ? 1.4 + 0.5 * Math.sin(t * 5) : 0.6)
    landNeonMesh.setColorAt(2, _c)
    landNeonMesh.instanceColor!.needsUpdate = true

    /* --- 6. LOGGER -------------------------------------------------------- */

    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = sim.backends[i]
      const st = b.state
      const running2 =
        b.active && st !== 'free' && st !== 'idle' && st !== 'starting' && st !== 'idle_in_xact' && st !== 'ending'
      if (running2) {
        if (!qOn[i]) {
          qOn[i] = 1
          qT[i] = 0
          qBlocked[i] = 0
        }
        qT[i] += dts
        if (st === 'blocked') qBlocked[i] = 1
      } else if (qOn[i]) {
        qOn[i] = 0
        const dur = qT[i]
        if (qBlocked[i]) {
          // log_lock_waits: the entry that names the blocker
          pushEntry(clamp(dur * 2.6, 2.2, 8), COLOR.lock, 2.1)
          logSlowAcc++
        } else if (dur > LOG_MIN_DURATION) {
          const slow = dur > LOG_SLOW
          pushEntry(clamp(dur * 2.2, 0.9, 7), slow ? COLOR.warn : COLOR.inkDim, slow ? 1.9 : 0.7)
          if (slow) logSlowAcc++
        }
      }
    }

    logWin += dts
    if (logWin >= 1) {
      logRate = damp(logRate, logAcc / logWin, 6, logWin)
      logSlow = logSlowAcc
      logAcc = 0
      logSlowAcc = 0
      logWin = 0
    }

    let tapeActive = 0
    for (let i = 0; i < N_ENTRY; i++) {
      if (!enLive[i]) continue
      enT[i] += dt * 0.34
      if (enT[i] >= 1) {
        enLive[i] = 0
        zeroInst(logNeonMesh, IX_LG_ENTRY + i, TAPE_X1, TAPE_Y, TAPE_Z)
        continue
      }
      tapeActive++
      setTRS(
        logNeonMesh, IX_LG_ENTRY + i,
        lerp(TAPE_X0, TAPE_X1, enT[i]), TAPE_Y + 0.28, TAPE_Z,
        enLen[i], 0.22, 0.42,
      )
      _c.setHex(enCol[i]).multiplyScalar(enBright[i] * clamp01(enT[i] * 12) * clamp01((1 - enT[i]) * 6))
      logNeonMesh.setColorAt(IX_LG_ENTRY + i, _c)
    }

    tapeSpin += dt * (0.5 + clamp01(logRate / 6) * 4.5)
    if (tapeSpin > TAU) tapeSpin -= TAU
    _e.set(Math.PI / 2, tapeSpin, 0)
    _q.setFromEuler(_e)
    setTRS(logNeonMesh, IX_LG_REEL, TAPE_X1, TAPE_Y, TAPE_Z - 0.8, 5.8, 0.1, 5.8, _q)
    logNeonMesh.instanceMatrix.needsUpdate = true

    headFlash = Math.max(0, headFlash - dt * 3)
    _c.setHex(COLOR.ink).multiplyScalar(0.12 + clamp01(logRate / 8) * 0.4)
    for (let i = 0; i < LG_WIN_N; i++) logNeonMesh.setColorAt(IX_LG_WIN + i, _c)
    _c.setHex(COLOR.warn).multiplyScalar(0.15 + headFlash * 2.4)
    logNeonMesh.setColorAt(IX_LG_HEAD, _c)
    _c.setHex(COLOR.inkDim).multiplyScalar(0.18 + clamp01(tapeActive / 8) * 0.5)
    logNeonMesh.setColorAt(IX_LG_REEL, _c)
    logNeonMesh.instanceColor!.needsUpdate = true

    /* --- 7. STATS RELAY --------------------------------------------------- */

    statsAcc += dts
    statsBeat += dt
    if (statsAcc > 1.1) {
      statsAcc = 0
      ctx.flow({ route: 'stats.in', count: 1, kind: 'stat', size: 0.8 })
    }
    const load = clamp01(sim.stats.tps / 400)
    _c.setHex(COLOR.inkDim).multiplyScalar(0.2 + load * 0.7)
    for (let i = 0; i < ST_WIN_N; i++) statsNeonMesh.setColorAt(IX_ST_WIN + i, _c)
    for (let i = 0; i < CHASE_N; i++) {
      const ph = (statsBeat * 1.4 - i * 0.12) % 1
      const lit = ph > 0 && ph < 0.22 ? 1 : 0
      _c.setHex(COLOR.shmem).multiplyScalar(0.1 + lit * (0.5 + load * 1.8))
      statsNeonMesh.setColorAt(IX_ST_CHASE + i, _c)
    }
    statsNeonMesh.instanceColor!.needsUpdate = true

  }

  /* =======================================================================
   * Level of detail.
   * =====================================================================*/

  function setDetail(level: 0 | 1 | 2): void {
    const near = level >= 1
    const close = level >= 2

    ckptDetailMesh.visible = near
    ckptDomes.visible = near
    wheelGroup.visible = near

    bgwDetailMesh.visible = near
    gSweep.visible = near

    launchDetailMesh.visible = near

    depotDetailMesh.visible = near
    truckWheels.visible = near

    landDetailMesh.visible = near
    logDetailMesh.visible = near
    logReels.visible = near
    dish.visible = near

    yardDeep.visible = near
    edgeLines.visible = near
    signMesh.visible = close
    // Paint and solid lamp heads stay on so the yard remains legible from the
    // air without transparent light pools or district haze.
  }

  function dispose(): void {
    offCkEnd()
    offCkStart()
    offReset()
    for (const o of owned) o.dispose()
    owned.length = 0
    signs.dispose()
    for (const m of meshes) m.dispose()
    meshes.length = 0
    group.clear()
  }

  // main.ts boots its LOD bucket at 0 and only calls setDetail on a change.
  setDetail(0)

  return { id: 'maintenance', group, update, setDetail, dispose }
}
