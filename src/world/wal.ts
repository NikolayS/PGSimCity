import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import { N_WAL_SEG_SLOTS } from '../core/types'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtLsn, lerp, makeRng, smoothstep } from '../core/util'
import { ANCHOR, TABLES, routePoint, routeTangent, walSegZ } from './layout'

/* ============================================================================
 * THE WAL DISTRICT — why there is a log at all.
 *
 * Postgres never writes a data page and hopes. It writes the *intent* first, in
 * a strictly sequential file, and makes that file durable. Only later — lazily,
 * at a checkpoint — do the pages themselves go to disk. Everything east of the
 * plaza exists to make that ordering physical:
 *
 *   wal_buffers ──trunk main──▶ WALWRITER ──▶ VAULT (pg_wal) ──▶ ARCHIVER
 *                                  │                 │
 *                            fsync valve       WALSENDER ──▶ standby
 *                                              LOGICAL DECODER ──▶ subscriber
 *
 * The one distinction the district is built around: *written* (handed to the
 * kernel) is not *flushed* (fsynced). The walwriter shows both as separate
 * gauges, because that gap is the entire reason synchronous_commit exists.
 * ==========================================================================*/

/* --- module-scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _c2 = new THREE.Color()
const _axisY = new THREE.Vector3(0, 1, 0)

const TAU = Math.PI * 2
const MB = 1024 * 1024

/** cx, cy, cz, w, h, d — for cylinders w/d are diameters. */
type BoxSpec = [number, number, number, number, number, number]

/* --- anchors, pulled out so no coordinate is re-derived -------------------- */
const WW = ANCHOR.walWriter // pumping station
const WV = ANCHOR.walVault // the ingot hall
const AR = ANCHOR.archiver // gantry crane
const AS = ANCHOR.archiveStore // cold store
const WS = ANCHOR.walSender // transmission tower
const LD = ANCHOR.logicalDecoder // the prism

/** Half-length of the vault hall in z: 14 slots, 9 m apart, plus a bay. */
const VAULT_Z = walSegZ(N_WAL_SEG_SLOTS - 1) + 7.5 // 66

/* --------------------------------------------------------------------------
 * Small builders. All of these run once, at construction time.
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

function setBox(mesh: THREE.InstancedMesh, i: number, s: BoxSpec): void {
  _p.set(s[0], s[1], s[2])
  _sc.set(s[3], s[4], s[5])
  _m.compose(_p, _qi, _sc)
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

/** Park an instance out of sight without touching its draw cost. */
function hideInst(mesh: THREE.InstancedMesh, i: number): void {
  setTRS(mesh, i, 0, -9000, 0, 0.0001, 0.0001, 0.0001)
}

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

/* ============================================================================
 * SIGNAGE — one canvas atlas, one merged geometry, one draw call for every
 * piece of text in the district (including the 14 live segment file names).
 * ==========================================================================*/

const SIGN_W = 512
const SIGN_ROW = 64
const SIGN_ROWS = 32
const SIGN_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

class Signage {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  readonly texture: THREE.CanvasTexture
  private next = 0

  private readonly pos: number[] = []
  private readonly uv: number[] = []
  private readonly col: number[] = []
  private readonly idx: number[] = []
  private quads = 0

  geometry: THREE.BufferGeometry | null = null
  mesh: THREE.Mesh | null = null
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

  /** Draw `text` into row `row`; returns the drawn width in pixels. */
  private draw(row: number, text: string): number {
    const c = this.ctx
    const y0 = row * SIGN_ROW
    c.clearRect(0, y0, SIGN_W, SIGN_ROW)
    let size = 36
    c.font = `600 ${size}px ${SIGN_FONT}`
    let w = c.measureText(text).width
    if (w > SIGN_W - 12) {
      size = Math.max(11, Math.floor((size * (SIGN_W - 12)) / w))
      c.font = `600 ${size}px ${SIGN_FONT}`
      w = c.measureText(text).width
    }
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillStyle = '#ffffff'
    c.fillText(text, SIGN_W / 2, y0 + SIGN_ROW / 2)
    this.texture.needsUpdate = true
    return Math.max(8, w)
  }

  /**
   * Reserve a row, draw the text, and emit a quad sized to the *drawn* extent so
   * the glyph aspect is always right whatever the string length.
   * @returns [quadIndex, rowIndex]
   */
  plate(
    text: string,
    x: number, y: number, z: number,
    facing: Facing,
    height: number,
    color: number,
    bright = 1,
  ): [number, number] {
    const row = this.next++
    const w = this.draw(row, text)
    const qw = (height * w) / SIGN_ROW
    const r = FACE_R[facing]
    const u = FACE_U[facing]
    const hw = qw / 2
    const hh = height / 2
    // The texture row is full-width; the quad only covers the inked span.
    const u0 = 0.5 - w / (2 * SIGN_W)
    const u1 = 0.5 + w / (2 * SIGN_W)
    // flipY is on by default, so row 0 lives at the *top* of the image → v is
    // measured from the bottom.
    const v1 = 1 - row / SIGN_ROWS
    const v0 = 1 - (row + 1) / SIGN_ROWS
    const corners: [number, number, number, number][] = [
      [-hw, -hh, u0, v0],
      [hw, -hh, u1, v0],
      [hw, hh, u1, v1],
      [-hw, hh, u0, v1],
    ]
    _c.setHex(color).multiplyScalar(bright)
    const base = this.quads * 4
    for (const [a, b, cu, cv] of corners) {
      this.pos.push(x + r[0] * a + u[0] * b, y + r[1] * a + u[1] * b, z + r[2] * a + u[2] * b)
      this.uv.push(cu, cv)
      this.col.push(_c.r, _c.g, _c.b)
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    return [this.quads++, row]
  }

  build(): THREE.Mesh {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    const ca = new THREE.Float32BufferAttribute(this.col, 3)
    ca.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('color', ca)
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      toneMapped: false,
      side: THREE.FrontSide,
    })
    const mesh = new THREE.Mesh(g, mat)
    mesh.renderOrder = 5
    mesh.raycast = () => {}
    this.geometry = g
    this.mesh = mesh
    this.colorAttr = ca
    return mesh
  }

  /** Repaint one row in place — used for the live segment file names. */
  redraw(row: number, text: string): void {
    this.draw(row, text)
  }

  setColor(quad: number, color: number, bright: number): void {
    const a = this.colorAttr
    if (!a) return
    _c.setHex(color).multiplyScalar(bright)
    const o = quad * 4
    for (let i = 0; i < 4; i++) a.setXYZ(o + i, _c.r, _c.g, _c.b)
    a.needsUpdate = true
  }

  dispose(): void {
    this.geometry?.dispose()
    ;(this.mesh?.material as THREE.Material | undefined)?.dispose()
    this.texture.dispose()
  }
}

/* --------------------------------------------------------------------------
 * A soft radial sprite, used for the district haze and the fsync steam.
 * ------------------------------------------------------------------------*/

function softTexture(): THREE.CanvasTexture {
  const s = 128
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const c = cv.getContext('2d')!
  const g = c.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.42)')
  g.addColorStop(0.72, 'rgba(255,255,255,0.09)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  c.fillStyle = g
  c.fillRect(0, 0, s, s)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

/** Re-sample a route into a curve we can extrude — used for the trunk mains. */
function subCurve(route: string, t0: number, t1: number, n: number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) pts.push(routePoint(route, t0 + (t1 - t0) * (i / n), new THREE.Vector3()))
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5)
}

/* ============================================================================
 * FACTORY
 * ==========================================================================*/

export const createWal: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx
  const low = quality.level === 'low'

  const group = new THREE.Group()
  group.name = 'district:wal'

  const owned: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }

  /* --- shared materials: structure is matte, meaning is neon -------------- */
  const matStruct = theme.mat('wal.struct', { color: 0x2a3752, roughness: 0.72, metalness: 0.3, emissive: 0x070c16 })
  const matDeep = theme.mat('wal.deep', { color: 0x161f33, roughness: 0.88, metalness: 0.14, emissive: 0x050912 })
  const matHeavy = theme.mat('wal.heavy', { color: 0x202b42, roughness: 0.55, metalness: 0.48, emissive: 0x080d18 })
  const matGlass = theme.mat('wal.glass', {
    color: 0x9fd8ff,
    roughness: 0.06,
    metalness: 0.1,
    transparent: true,
    opacity: 0.22,
  })
  const neonWhite = theme.neon(0xffffff, 1)
  const lineInk = theme.line(COLOR.inkDim, 0.19)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 12)

  const edgeVerts: number[] = []
  const signs = new Signage()

  /** InstancedMesh from a spec table, optionally contributing blueprint edges. */
  function batch(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    specs: readonly BoxSpec[],
    edge = false,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, specs.length))
    for (let i = 0; i < specs.length; i++) setBox(mesh, i, specs[i])
    if (specs.length === 0) hideInst(mesh, 0)
    mesh.instanceMatrix.needsUpdate = true
    mesh.castShadow = false
    parent.add(mesh)
    if (edge) for (const s of specs) pushBoxEdges(edgeVerts, s)
    return mesh
  }

  /** Neon batch: white base material, per-instance colour carries the meaning. */
  function neonBatch(parent: THREE.Object3D, geo: THREE.BufferGeometry, specs: readonly BoxSpec[]): THREE.InstancedMesh {
    const mesh = batch(parent, geo, neonWhite, specs)
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, _c)
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    return mesh
  }

  /* =======================================================================
   * 1. WALWRITER — the pumping station.
   * =====================================================================*/

  const gWalWriter = new THREE.Group()
  gWalWriter.name = 'walwriter'
  group.add(gWalWriter)

  const WX = WW[0] // 128
  const WZ = WW[2] // -34

  // Massing. Kept east of x=122: the excavation edge is at x=118 and nothing
  // may overhang it.
  const wwMass: BoxSpec[] = [
    [WX + 6, 0.55, WZ, 24, 1.1, 26], // apron
    [WX + 6, 2.6, WZ, 20, 3.0, 21], // base
    [WX + 4, 8.6, WZ, 16, 11.2, 17], // pump hall
    [WX + 4, 14.8, WZ, 17.4, 0.9, 18.4], // service band
    [WX + 4, 17.6, WZ, 11.5, 4.8, 12.5], // machine room
    [WX + 4, 20.3, WZ, 12.5, 0.7, 13.5], // roof cap
  ]
  const wwStruct = batch(gWalWriter, unitBox, matStruct, wwMass, true)

  /* Where do the trunk mains actually meet the building? Ask the routes rather
   * than guessing: the flush main comes in from wal_buffers and the write main
   * leaves for the vault at whatever angle layout.ts decided. */
  const HALL_CX = WX + 4
  const HALL_HX = 8
  const HALL_HZ = 8.5
  const insideHall = (p: THREE.Vector3) => Math.abs(p.x - HALL_CX) <= HALL_HX && Math.abs(p.z - WZ) <= HALL_HZ

  const intakeAt = new THREE.Vector3()
  const intakeDir = new THREE.Vector3(-1, 0, 0)
  const outletAt = new THREE.Vector3()
  const outletDir = new THREE.Vector3(1, 0, 0)
  {
    // last point of wal.flush still outside the hall = the intake penetration
    let tIn = 0.9
    for (let k = 40; k >= 0; k--) {
      const t = k / 40
      routePoint('wal.flush', t, _p)
      if (!insideHall(_p)) {
        tIn = t
        break
      }
    }
    routePoint('wal.flush', tIn, intakeAt)
    routeTangent('wal.flush', tIn, intakeDir).normalize()
    // first point of wal.write already outside the hall = the outlet
    let tOut = 0.1
    for (let k = 0; k <= 40; k++) {
      const t = k / 40
      routePoint('wal.write', t, _p)
      if (!insideHall(_p)) {
        tOut = t
        break
      }
    }
    routePoint('wal.write', tOut, outletAt)
    routeTangent('wal.write', tOut, outletDir).normalize()
  }
  const outletYaw = Math.atan2(outletDir.x, outletDir.z)

  // The cylinder that actually does the work, plus its rod guides.
  const wwRound: BoxSpec[] = [
    [HALL_CX, 24.0, WZ, 6.2, 7.4, 6.2], // piston housing
    [HALL_CX, 28.1, WZ, 7.2, 0.9, 7.2], // gland cap
    [WX + 0.4, 30.2, WZ, 0.64, 13, 0.64], // guide column, west
    [WX + 7.6, 30.2, WZ, 0.64, 13, 0.64], // guide column, east
    [0, 0, 0, 1, 1, 1], // 4: intake flange, placed below
    [0, 0, 0, 1, 1, 1], // 5: outlet flange, placed below
  ]
  const wwRoundMesh = batch(gWalWriter, unitCyl, matHeavy, wwRound)
  _q.setFromUnitVectors(_axisY, intakeDir)
  setTRS(wwRoundMesh, 4, intakeAt.x, intakeAt.y, intakeAt.z, 5.8, 2.0, 5.8, _q)
  _q.setFromUnitVectors(_axisY, outletDir)
  setTRS(wwRoundMesh, 5, outletAt.x, outletAt.y, outletAt.z, 5.2, 1.8, 5.2, _q)
  wwRoundMesh.instanceMatrix.needsUpdate = true

  const wwDetail: BoxSpec[] = [
    [HALL_CX, 14.35, WZ, 19, 0.3, 20], // walkway grating
    [HALL_CX, 20.05, WZ, 13.6, 0.28, 14.6],
    // walkway railings
    [HALL_CX, 15.3, WZ - 9.9, 19, 0.12, 0.12],
    [HALL_CX, 15.3, WZ + 9.9, 19, 0.12, 0.12],
    [WX - 5.4, 15.3, WZ, 0.12, 0.12, 20],
    [WX + 13.4, 15.3, WZ, 0.12, 0.12, 20],
    // recessed bands on the hall
    [HALL_CX, 6.0, WZ, 16.3, 0.5, 17.3],
    [HALL_CX, 11.6, WZ, 16.3, 0.5, 17.3],
    // gauge board on the south face + its two recesses
    [HALL_CX, 9.4, WZ + 8.7, 11.4, 9.4, 0.5],
    [WX + 1, 9.4, WZ + 8.95, 3.4, 8.4, 0.35],
    [WX + 7, 9.4, WZ + 8.95, 3.4, 8.4, 0.35],
    // machine-room vents, north face
    [WX + 0.4, 17.6, WZ - 6.3, 2.2, 2.6, 0.4],
    [WX + 4.0, 17.6, WZ - 6.3, 2.2, 2.6, 0.4],
    [WX + 7.6, 17.6, WZ - 6.3, 2.2, 2.6, 0.4],
    // crosshead yoke
    [HALL_CX, 37.4, WZ, 9.6, 0.9, 2.6],
  ]
  const wwDetailMesh = batch(gWalWriter, unitBox, matDeep, wwDetail)

  /* The piston. One stroke per fsync — the visible unit of durability. */
  const pistonGroup = new THREE.Group()
  gWalWriter.add(pistonGroup)
  const pistonMesh = batch(pistonGroup, unitBox, matHeavy, [
    [WX + 4, 31.8, WZ, 0.95, 7.6, 0.95], // rod
    [WX + 4, 35.9, WZ, 4.4, 1.1, 4.4], // crosshead
    [WX + 0.4, 35.9, WZ, 1.0, 0.7, 1.0], // slipper, west guide
    [WX + 7.6, 35.9, WZ, 1.0, 0.7, 1.0], // slipper, east guide
  ])

  /* Flywheel on the north wall: it spins at the WAL throughput. */
  const wheelGroup = new THREE.Group()
  wheelGroup.position.set(WX + 4, 9.5, WZ - 9.0)
  gWalWriter.add(wheelGroup)
  const wheelGeo = own(new THREE.TorusGeometry(2.8, 0.42, 6, 22))
  const wheelRim = new THREE.Mesh(wheelGeo, matHeavy)
  wheelGroup.add(wheelRim)
  const wheelSpokes = new THREE.InstancedMesh(unitBox, matHeavy, 5)
  for (let i = 0; i < 4; i++) {
    _e.set(0, 0, (i * Math.PI) / 4)
    _q.setFromEuler(_e)
    setTRS(wheelSpokes, i, 0, 0, 0, 5.6, 0.3, 0.3, _q)
  }
  setTRS(wheelSpokes, 4, 0, 0, 0, 1.1, 1.1, 0.9)
  wheelSpokes.instanceMatrix.needsUpdate = true
  wheelGroup.add(wheelSpokes)

  /* Neon: window slits, the two LSN gauges, the fsync bypass. */
  const WW_GAUGE_H = 6.6
  const GAUGE_Y0 = 5.6
  const wwNeonSpecs: BoxSpec[] = [
    [WX - 3.95, 8.2, WZ, 0.12, 0.5, 12], // hall slits
    [HALL_CX, 8.2, WZ - 8.55, 12, 0.5, 0.12],
    [WX + 11.95, 8.2, WZ, 0.12, 0.5, 12],
    [HALL_CX, 17.8, WZ - 6.3, 8.6, 0.16, 0.12], // machine-room glazing
    [HALL_CX, 17.8, WZ + 6.3, 8.6, 0.16, 0.12],
    [HALL_CX, 13.6, WZ + 9.0, 10.4, 0.14, 0.14], // gauge board head rail
    [WX + 1, GAUGE_Y0, WZ + 9.12, 2.6, 0.1, 0.3], // 6: WRITE gauge bar (scaled)
    [WX + 7, GAUGE_Y0, WZ + 9.12, 2.6, 0.1, 0.3], // 7: FLUSH gauge bar (scaled)
    [WX + 1, GAUGE_Y0 - 0.2, WZ + 9.12, 3.0, 0.12, 0.42], // 8: base tick, west
    [WX + 7, GAUGE_Y0 - 0.2, WZ + 9.12, 3.0, 0.12, 0.42], // 9: base tick, east
    [0, 0, 0, 1, 1, 1], // 10..12: synchronous_commit bypass duct, placed below
    [0, 0, 0, 1, 1, 1],
    [0, 0, 0, 1, 1, 1],
    [0, 0, 0, 1, 1, 1], // 13: intake gasket, placed below
    [0, 0, 0, 1, 1, 1], // 14: outlet gasket, placed below
    [WX + 0.75, 24.0, WZ, 0.35, 6.4, 0.35], // 15..16: piston housing indicator strips
    [WX + 7.25, 24.0, WZ, 0.35, 6.4, 0.35],
    [WX + 10.6, 12.2, WZ + 9.2, 0.9, 0.9, 0.9], // 17: durability lamp
  ]
  const wwNeon = neonBatch(gWalWriter, unitBox, wwNeonSpecs)
  const IX_GW = 6
  const IX_GF = 7
  const IX_BYP = 10
  const IX_INTAKE = 13
  const IX_OUTLET = 14
  const IX_PIST = 15
  const IX_LAMP = 17

  // The synchronous_commit bypass: a duct that hops over the fsync valve. It is
  // dark unless the user turns durability off, and then it is the only lit path.
  {
    _q.setFromAxisAngle(_axisY, outletYaw)
    _p2.copy(outletAt).addScaledVector(outletDir, 2.6)
    setTRS(wwNeon, IX_BYP, _p2.x, _p2.y + 3.4, _p2.z, 0.7, 6.8, 0.7)
    _p2.copy(outletAt).addScaledVector(outletDir, 5.8)
    setTRS(wwNeon, IX_BYP + 1, _p2.x, _p2.y + 6.8, _p2.z, 0.7, 0.7, 6.8, _q)
    _p2.copy(outletAt).addScaledVector(outletDir, 9.0)
    setTRS(wwNeon, IX_BYP + 2, _p2.x, _p2.y + 3.4, _p2.z, 0.7, 6.8, 0.7)
    // lit gaskets where the mains penetrate the wall
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), intakeDir)
    _p2.copy(intakeAt).addScaledVector(intakeDir, -0.9)
    setTRS(wwNeon, IX_INTAKE, _p2.x, _p2.y, _p2.z, 5.6, 5.6, 0.22, _q)
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), outletDir)
    _p2.copy(outletAt).addScaledVector(outletDir, 0.9)
    setTRS(wwNeon, IX_OUTLET, _p2.x, _p2.y, _p2.z, 5.0, 5.0, 0.22, _q)
    wwNeon.instanceMatrix.needsUpdate = true
  }

  /* Steam: fsync is where the heat is. Cheap additive billboards. */
  const soft = own(softTexture())
  const N_STEAM = low ? 6 : 12
  const steamMat = own(
    new THREE.MeshBasicMaterial({
      map: soft,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const quadGeo = own(new THREE.PlaneGeometry(1, 1))
  const steam = new THREE.InstancedMesh(quadGeo, steamMat, N_STEAM)
  steam.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  steam.frustumCulled = false
  steam.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_STEAM; i++) {
    hideInst(steam, i) // parked until the first update places them
    steam.setColorAt(i, _c)
  }
  steam.instanceMatrix.needsUpdate = true
  steam.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gWalWriter.add(steam)
  const srng = makeRng(0x5eafc0)
  const stT = new Float32Array(N_STEAM)
  const stX = new Float32Array(N_STEAM)
  const stZ = new Float32Array(N_STEAM)
  const stS = new Float32Array(N_STEAM)
  for (let i = 0; i < N_STEAM; i++) {
    stT[i] = srng()
    stX[i] = (srng() - 0.5) * 5
    stZ[i] = (srng() - 0.5) * 5
    stS[i] = 3.4 + srng() * 3.4
  }

  signs.plate('walwriter', HALL_CX, 14.9, WZ + 9.2, 'south', 1.4, COLOR.wal, 1.1)
  signs.plate('write_lsn → OS', WX + 1, 4.8, WZ + 9.3, 'south', 0.72, COLOR.wal, 0.85)
  signs.plate('flush_lsn → disk', WX + 7, 4.8, WZ + 9.3, 'south', 0.72, COLOR.ok, 0.85)
  signs.plate('written ≠ durable', WX + 6, 1.2, WZ + 11.6, 'up', 1.5, COLOR.ink, 0.5)
  _p2.copy(outletAt).addScaledVector(outletDir, 5.8)
  const [SGN_BYPASS] = signs.plate(
    'synchronous_commit = off · bypass',
    _p2.x, _p2.y + 8.6, _p2.z,
    'north', 0.95, COLOR.ok, 0.2,
  )

  /* =======================================================================
   * 2. THE VAULT — pg_wal as an ingot store.
   * =====================================================================*/

  const gVault = new THREE.Group()
  gVault.name = 'wal.vault'
  group.add(gVault)

  const VX = WV[0] // 168

  const vaultMass: BoxSpec[] = [
    [VX, 0.5, 0, 27, 1.0, VAULT_Z * 2 + 2], // floor slab
    [VX - 10.5, 1.3, 0, 6, 1.6, VAULT_Z * 2 + 2], // stylobate, west
    [VX + 10.5, 1.3, 0, 6, 1.6, VAULT_Z * 2 + 2], // stylobate, east
    [VX - 10.5, 15.6, 0, 3.4, 1.8, VAULT_Z * 2 + 2], // architrave, west
    [VX + 10.5, 15.6, 0, 3.4, 1.8, VAULT_Z * 2 + 2], // architrave, east
    // north gable: a portal with the vault door in it
    [VX - 8.5, 7.5, -VAULT_Z - 1, 10, 15, 2],
    [VX + 8.5, 7.5, -VAULT_Z - 1, 10, 15, 2],
    [VX, 13.5, -VAULT_Z - 1, 27, 3, 2],
    // south gable: where recycled segments wait to be renamed
    [VX - 8.5, 7.5, VAULT_Z + 1, 10, 15, 2],
    [VX + 8.5, 7.5, VAULT_Z + 1, 10, 15, 2],
    [VX, 13.5, VAULT_Z + 1, 27, 3, 2],
  ]
  const vaultStruct = batch(gVault, unitBox, matStruct, vaultMass, true)

  // Colonnade. One pier is deliberately missing where the WAL trunk main enters
  // the hall — that gap is the inlet arch.
  const piers: BoxSpec[] = []
  for (let k = 0; k < 8; k++) {
    const z = -63 + k * 18
    for (const side of [-10.5, 10.5]) {
      if (side < 0 && z === -9) continue // inlet arch
      piers.push([VX + side, 8.4, z, 2.4, 12.6, 2.4])
    }
  }
  // the inlet arch itself
  piers.push([VX - 10.5, 8.4, -19, 2.4, 12.6, 2.4])
  piers.push([VX - 10.5, 8.4, 1, 2.4, 12.6, 2.4])
  const vaultPiers = batch(gVault, unitBox, matStruct, piers)

  const roofBeams: BoxSpec[] = []
  for (let k = 0; k < 15; k++) roofBeams.push([VX, 16.9, -63 + k * 9, 24, 0.8, 1.2])
  roofBeams.push([VX, 12.6, 0, 1.6, 0.9, VAULT_Z * 2 - 4]) // charging rail
  const vaultRoof = batch(gVault, unitBox, matDeep, roofBeams)

  // The round vault door — pg_wal is a strongroom, not a scratch directory.
  const doorGeo = own(new THREE.TorusGeometry(3.9, 0.55, 8, 28))
  const vaultDoor = new THREE.Mesh(doorGeo, matHeavy)
  vaultDoor.position.set(VX, 6.6, -VAULT_Z - 2.3)
  gVault.add(vaultDoor)
  const doorPlate = new THREE.InstancedMesh(unitCyl, matHeavy, 1)
  _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  setTRS(doorPlate, 0, VX, 6.6, -VAULT_Z - 2.3, 7.4, 0.7, 7.4, _q)
  doorPlate.instanceMatrix.needsUpdate = true
  gVault.add(doorPlate)
  const doorSpokes: BoxSpec[] = [
    [VX, 6.6, -VAULT_Z - 2.75, 7.4, 0.4, 0.3],
    [VX, 6.6, -VAULT_Z - 2.75, 0.4, 7.4, 0.3],
    [VX, 6.6, -VAULT_Z - 2.9, 1.5, 1.5, 0.5],
  ]
  const vaultDoorDetail = batch(gVault, unitBox, matDeep, doorSpokes)

  /* --- the 14 segment slots ---------------------------------------------- */

  const cradles: BoxSpec[] = []
  const cradleSides: BoxSpec[] = []
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    const z = walSegZ(i)
    cradles.push([VX, 1.4, z, 9.4, 1.8, 7.8])
    cradleSides.push([VX - 4.4, 3.0, z, 0.6, 2.6, 7.4])
    cradleSides.push([VX + 4.4, 3.0, z, 0.6, 2.6, 7.4])
  }
  const segCradles = batch(gVault, unitBox, matHeavy, cradles)
  const segCradleSides = batch(gVault, unitBox, matDeep, cradleSides)

  /** Ingot body: a neon block that fills from the bottom as the segment fills. */
  const SEG_Y0 = 2.3
  const SEG_H = 6.4
  const segFillMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_WAL_SEG_SLOTS)
  segFillMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    hideInst(segFillMesh, i)
    segFillMesh.setColorAt(i, _c)
  }
  segFillMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gVault.add(segFillMesh)

  // Caps (a full segment is closed), and the "streamed" marker on the east side.
  const segCaps = new THREE.InstancedMesh(unitBox, matHeavy, N_WAL_SEG_SLOTS)
  segCaps.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) hideInst(segCaps, i)
  gVault.add(segCaps)

  const segMarks = new THREE.InstancedMesh(unitBox, neonWhite, N_WAL_SEG_SLOTS)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    setBox(segMarks, i, [VX + 3.95, 5.6, walSegZ(i), 0.3, 1.4, 5.6])
    segMarks.setColorAt(i, _c)
  }
  segMarks.instanceMatrix.needsUpdate = true
  segMarks.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gVault.add(segMarks)

  // Envelope outlines: a recycled segment is a ghost of a file that still exists.
  const outPos: number[] = []
  const outCol: number[] = []
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    const before = outPos.length
    pushBoxEdges(outPos, [VX, SEG_Y0 + SEG_H / 2, walSegZ(i), 7.4, SEG_H + 0.2, 7.6])
    for (let v = before; v < outPos.length; v += 3) outCol.push(0, 0, 0)
  }
  const outGeo = own(new THREE.BufferGeometry())
  outGeo.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  const outColAttr = new THREE.Float32BufferAttribute(outCol, 3)
  outColAttr.setUsage(THREE.DynamicDrawUsage)
  outGeo.setAttribute('color', outColAttr)
  const outMat = own(
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
  )
  const segOutlines = new THREE.LineSegments(outGeo, outMat)
  segOutlines.raycast = () => {}
  segOutlines.renderOrder = 3
  gVault.add(segOutlines)
  /** 24 edges × 2 verts per box. */
  const OUT_VERTS = 48

  // File names on the west face of every ingot — live, from segment.name.
  const segNameQuad = new Int32Array(N_WAL_SEG_SLOTS)
  const segNameRow = new Int32Array(N_WAL_SEG_SLOTS)
  const segNameCache: string[] = []
  for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
    const s = ctx.sim.wal.segments[i]
    const name = s ? s.name : '000000000000000000000000'
    segNameCache.push(name)
    const [q, r] = signs.plate(name, VX - 3.85, 5.6, walSegZ(i), 'west', 0.9, COLOR.wal, 0.8)
    segNameQuad[i] = q
    segNameRow[i] = r
  }

  /* Charging head: WAL pours into whichever segment is current. Local space —
   * the whole group slides along z to sit over the current segment. */
  const chargeGroup = new THREE.Group()
  chargeGroup.position.set(VX, 0, 0)
  gVault.add(chargeGroup)
  const chargeBody = batch(chargeGroup, unitBox, matHeavy, [
    [0, 11.4, 0, 3.0, 1.8, 3.4],
    [0, 10.2, 0, 1.2, 0.9, 1.2],
  ])
  const chargeBeamMat = own(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(COLOR.wal).multiplyScalar(2.2),
      toneMapped: false,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    }),
  )
  const chargeBeam = new THREE.Mesh(unitBox, chargeBeamMat)
  chargeBeam.scale.set(0.55, 1, 0.55)
  chargeBeam.raycast = () => {}
  chargeGroup.add(chargeBeam)

  signs.plate('pg_wal · 16 MB segments', VX, 17.2, -VAULT_Z - 2.2, 'north', 1.4, COLOR.wal, 1.0)
  signs.plate('16 MB', VX, 2.0, -VAULT_Z - 2.95, 'north', 0.8, COLOR.archive, 0.7)
  const [SGN_RECYC] = signs.plate('recycled — renamed for reuse, not deleted', VX, 17.2, VAULT_Z + 2.2, 'south', 1.2, COLOR.inkDim, 0.7)

  /* =======================================================================
   * 3. ARCHIVER + ARCHIVE STORE.
   * =====================================================================*/

  const gArchiver = new THREE.Group()
  gArchiver.name = 'archiver'
  group.add(gArchiver)

  const archMass: BoxSpec[] = [
    [AR[0], 0.6, AR[2], 26, 1.2, 16], // plinth
    [AR[0] - 7, 7.5, AR[2], 2.6, 15, 3.2], // gantry legs
    [AR[0] + 7, 7.5, AR[2], 2.6, 15, 3.2],
    [AR[0], 16.2, AR[2], 22, 2.4, 3.8], // girder
    [AR[0], 18.4, AR[2], 8, 1.2, 5], // hoist house
    [AR[0], 4.0, AR[2] - 8.5, 12, 8, 6], // archive_command shed
  ]
  const archStruct = batch(gArchiver, unitBox, matStruct, archMass, true)

  const archDetail: BoxSpec[] = [
    [AR[0] + 4.6, 11.6, AR[2] + 4.4, 4.6, 3.4, 4.6], // control cab
    [AR[0], 0.5, AR[2] - 5, 30, 1.0, 1.6], // rails
    [AR[0], 0.5, AR[2] + 5, 30, 1.0, 1.6],
    [AR[0] - 11, 11.0, AR[2] - 6, 1.2, 22, 1.2], // queue mast
    [AR[0] - 11, 22.2, AR[2] - 6, 3.0, 0.4, 3.0],
    [AR[0], 4.0, AR[2] - 11.6, 12.4, 0.5, 0.5], // shed banding
    [AR[0], 6.6, AR[2] - 11.6, 12.4, 0.5, 0.5],
  ]
  const archDetailMesh = batch(gArchiver, unitBox, matDeep, archDetail)

  // Queue depth, stacked on the mast: a stuck archive_command is a real outage.
  // Last two instances are the hoist lamp and the backlog strobe.
  const N_QBAR = 12
  const IX_HOIST = N_QBAR
  const IX_STROBE = N_QBAR + 1
  const archQueue = new THREE.InstancedMesh(unitBox, neonWhite, N_QBAR + 2)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_QBAR; i++) {
    setBox(archQueue, i, [AR[0] - 11, 2.4 + i * 1.6, AR[2] - 6, 2.6, 1.0, 2.6])
    archQueue.setColorAt(i, _c)
  }
  setBox(archQueue, IX_HOIST, [AR[0], 19.7, AR[2], 1.6, 0.9, 1.6])
  setBox(archQueue, IX_STROBE, [AR[0] - 11, 22.8, AR[2] - 6, 1.4, 1.4, 1.4])
  archQueue.setColorAt(IX_HOIST, _c)
  archQueue.setColorAt(IX_STROBE, _c)
  archQueue.instanceMatrix.needsUpdate = true
  archQueue.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gArchiver.add(archQueue)

  /* The runway the crane rides, extruded along the real 'wal.archive' route. */
  const runwayCurve = subCurve('wal.archive', 0.015, 0.985, 26)
  const runwayGeo = own(new THREE.TubeGeometry(runwayCurve, 44, 0.34, 5, false))
  const runway = new THREE.Mesh(runwayGeo, matHeavy)
  runway.raycast = () => {}
  gArchiver.add(runway)

  const runMasts: BoxSpec[] = []
  for (const t of [0.28, 0.52, 0.76, 0.94]) {
    routePoint('wal.archive', t, _p)
    runMasts.push([_p.x, _p.y / 2, _p.z, 0.9, _p.y, 0.9])
    runMasts.push([_p.x, _p.y + 0.5, _p.z, 2.6, 0.4, 2.0])
  }
  const runwayMasts = batch(gArchiver, unitBox, matStruct, runMasts)

  /* The travelling crane. Its spreader is slung to the west of the trolley so
   * the hook comes down exactly over the ingot row at x = walVault.x, while the
   * shuttle itself stays in the east aisle clear of the charging rail. */
  const CRANE_ARM = -4.4
  const craneGroup = new THREE.Group()
  gArchiver.add(craneGroup)
  const IX_CABLE = 3
  const craneBody = batch(craneGroup, unitBox, matHeavy, [
    [0, 0, 0, 4.0, 2.0, 3.2], // trolley
    [0, 1.3, 0, 1.4, 0.8, 1.4], // pickup shoe on the runway
    [0, -1.2, 0, 2.2, 0.5, 2.2], // hoist gear
    [CRANE_ARM, -3.2, 0, 0.16, 3, 0.16], // 3: cable, rescaled every frame
    [CRANE_ARM / 2, -1.4, 0, 5.0, 0.35, 0.55], // spreader arm
  ])
  const craneLoad = new THREE.Mesh(unitBox, neonWhite)
  craneLoad.scale.set(6.8, 5.8, 7.0)
  craneLoad.position.x = CRANE_ARM
  craneLoad.visible = false
  craneGroup.add(craneLoad)
  const craneLoadMat = own(new THREE.MeshBasicMaterial({ color: COLOR.wal, toneMapped: false }))
  craneLoad.material = craneLoadMat

  signs.plate('archiver', AR[0], 21.2, AR[2], 'north', 1.3, COLOR.archive, 1.0)
  signs.plate('archive_command', AR[0], 8.8, AR[2] - 11.8, 'north', 0.9, COLOR.ink, 0.55)
  const [SGN_QUEUE] = signs.plate('archive queue', AR[0] - 11, 24.4, AR[2] - 6, 'north', 0.9, COLOR.archive, 0.5)

  /* --- archive store: cold, dim, and it only ever grows ------------------- */

  const gStore = new THREE.Group()
  gStore.name = 'archive.store'
  group.add(gStore)

  const storeMass: BoxSpec[] = [
    [AS[0], 0.6, AS[2], 30, 1.2, 24],
    [AS[0] + 14, 5.4, AS[2], 2, 10, 24], // back wall (east)
    [AS[0], 5.4, AS[2] - 11, 30, 10, 2], // north wall
    [AS[0], 5.4, AS[2] + 11, 30, 10, 2], // south wall
    [AS[0], 10.9, AS[2], 30, 1.0, 24], // roof
  ]
  const storeStruct = batch(gStore, unitBox, matStruct, storeMass, true)

  const storeShelves: BoxSpec[] = []
  for (let r = 0; r < 3; r++) storeShelves.push([AS[0] + 1, 1.2 + r * 2.6, AS[2], 24, 0.3, 21])
  for (let c = 0; c < 4; c++) storeShelves.push([AS[0] - 10 + c * 7, 5.0, AS[2], 0.4, 8.0, 21])
  const storeShelfMesh = batch(gStore, unitBox, matDeep, storeShelves)

  const N_STORE = 45
  const storeSlots = new THREE.InstancedMesh(unitBox, neonWhite, N_STORE)
  const storeSlotY = new Float32Array(N_STORE)
  {
    let i = 0
    for (let ry = 0; ry < 3; ry++) {
      for (let cz = 0; cz < 5; cz++) {
        for (let cx = 0; cx < 3; cx++) {
          const x = AS[0] - 7 + cx * 7
          const y = 2.4 + ry * 2.6
          const z = AS[2] - 8 + cz * 4
          setBox(storeSlots, i, [x, y, z, 6.0, 1.9, 3.4])
          storeSlotY[i] = y
          i++
        }
      }
    }
  }
  storeSlots.instanceMatrix.needsUpdate = true
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_STORE; i++) storeSlots.setColorAt(i, _c)
  storeSlots.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gStore.add(storeSlots)

  signs.plate('archive store · cold', AS[0], 12.6, AS[2] - 11.2, 'north', 1.1, COLOR.archive, 0.85)

  /* =======================================================================
   * 4. WALSENDER — the transmission tower and the slot spool.
   * =====================================================================*/

  const gSender = new THREE.Group()
  gSender.name = 'walsender'
  group.add(gSender)

  const sendMass: BoxSpec[] = [
    [WS[0], 0.7, WS[2], 18, 1.4, 18],
    [WS[0], 2.4, WS[2], 14, 2.2, 14],
    [WS[0], 15.9, WS[2], 11, 0.5, 11], // platforms
    [WS[0], 27.3, WS[2], 8, 0.45, 8],
    [WS[0], 35.9, WS[2], 5.5, 0.4, 5.5],
  ]
  const sendStruct = batch(gSender, unitBox, matStruct, sendMass, true)

  const sendTower: BoxSpec[] = [
    [WS[0], 9.5, WS[2], 10.4, 12.6, 10.4],
    [WS[0], 21.5, WS[2], 7.0, 11.4, 7.0],
    [WS[0], 31.5, WS[2], 4.4, 8.6, 4.4],
    [WS[0], 40.5, WS[2], 0.9, 9.4, 0.9],
  ]
  const sendTowerMesh = batch(gSender, unitCyl, matStruct, sendTower)

  const sendDetail: BoxSpec[] = [
    [WS[0], 16.5, WS[2] - 5.4, 11, 1.1, 0.12], // platform railings
    [WS[0], 16.5, WS[2] + 5.4, 11, 1.1, 0.12],
    [WS[0] - 5.4, 16.5, WS[2], 0.12, 1.1, 11],
    [WS[0] + 5.4, 16.5, WS[2], 0.12, 1.1, 11],
    [WS[0], 27.9, WS[2] - 3.9, 8, 1.0, 0.12],
    [WS[0], 27.9, WS[2] + 3.9, 8, 1.0, 0.12],
    [WS[0] + 4.5, 30.0, WS[2] + 3.2, 1.0, 1.0, 5.4], // dish support arm
    [WS[0], 3.0, WS[2] + 9.4, 6, 3.2, 1.2], // cabinet
  ]
  const sendDetailMesh = batch(gSender, unitBox, matDeep, sendDetail)

  /* The dish. Aimed at the walreceiver — computed from the anchor, not guessed. */
  const dishAt = new THREE.Vector3(WS[0] + 5.6, 30.4, WS[2] + 6.4)
  const dishAim = new THREE.Vector3(
    ANCHOR.walReceiver[0] - dishAt.x,
    14 - dishAt.y,
    ANCHOR.walReceiver[2] - dishAt.z,
  ).normalize()
  const dishQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dishAim)
  const dishGeo = own(new THREE.SphereGeometry(5.0, 18, 8, 0, TAU, 0, Math.PI * 0.36))
  const dish = new THREE.Mesh(dishGeo, matStruct)
  dish.position.copy(dishAt)
  dish.quaternion.copy(dishQuat)
  gSender.add(dish)

  const dishInner = new THREE.Mesh(dishGeo, neonWhite)
  dishInner.position.copy(dishAt)
  dishInner.quaternion.copy(dishQuat)
  dishInner.scale.setScalar(0.94)
  dishInner.raycast = () => {}
  const dishInnerMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.BackSide }))
  dishInner.material = dishInnerMat
  gSender.add(dishInner)

  const feedHorn = new THREE.InstancedMesh(unitCyl, matHeavy, 1)
  _p2.copy(dishAt).addScaledVector(dishAim, 2.6)
  _q.setFromUnitVectors(_axisY, dishAim)
  setTRS(feedHorn, 0, _p2.x, _p2.y, _p2.z, 1.0, 5.2, 1.0, _q)
  feedHorn.instanceMatrix.needsUpdate = true
  gSender.add(feedHorn)

  // Transmission pulses: rings leaving the dish along the aim vector.
  const N_PULSE = 4
  const pulseGeo = own(new THREE.TorusGeometry(1, 0.09, 5, 22))
  const pulses = new THREE.InstancedMesh(pulseGeo, neonWhite, N_PULSE)
  pulses.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  pulses.frustumCulled = false
  pulses.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_PULSE; i++) {
    hideInst(pulses, i)
    pulses.setColorAt(i, _c)
  }
  pulses.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gSender.add(pulses)
  const pulseT = new Float32Array(N_PULSE)
  const pulseOn = new Uint8Array(N_PULSE)
  const pulseQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dishAim)

  /* The replication slot, as a spool of WAL we have promised to keep. */
  const SPX = WS[0] + 15
  const SPZ = WS[2] + 13
  const SPY = 6.2
  const spoolMass: BoxSpec[] = [
    [SPX, 0.6, SPZ, 13, 1.2, 9],
    [SPX - 3.4, SPY / 2, SPZ, 1.4, SPY, 1.4], // bearing posts
    [SPX + 3.4, SPY / 2, SPZ, 1.4, SPY, 1.4],
  ]
  const spoolStruct = batch(gSender, unitBox, matStruct, spoolMass, true)

  const spoolAxis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
  const spoolFlanges = new THREE.InstancedMesh(unitCyl, matHeavy, 3)
  setTRS(spoolFlanges, 0, SPX - 2.3, SPY, SPZ, 11.4, 0.5, 11.4, spoolAxis)
  setTRS(spoolFlanges, 1, SPX + 2.3, SPY, SPZ, 11.4, 0.5, 11.4, spoolAxis)
  setTRS(spoolFlanges, 2, SPX, SPY, SPZ, 1.6, 9.4, 1.6, spoolAxis)
  spoolFlanges.instanceMatrix.needsUpdate = true
  gSender.add(spoolFlanges)

  const spoolWind = new THREE.InstancedMesh(unitCyl, neonWhite, 1)
  spoolWind.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  setTRS(spoolWind, 0, SPX, SPY, SPZ, 2.4, 4.2, 2.4, spoolAxis)
  spoolWind.instanceMatrix.needsUpdate = true
  _c.setHex(COLOR.wal)
  spoolWind.setColorAt(0, _c)
  spoolWind.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gSender.add(spoolWind)

  const sendNeonSpecs: BoxSpec[] = [
    [WS[0], 8.0, WS[2] - 5.3, 6.0, 0.35, 0.12], // tower bands
    [WS[0], 8.0, WS[2] + 5.3, 6.0, 0.35, 0.12],
    [WS[0], 20.0, WS[2] - 3.6, 4.0, 0.3, 0.12],
    [WS[0], 20.0, WS[2] + 3.6, 4.0, 0.3, 0.12],
    [WS[0], 3.0, WS[2] + 10.05, 4.4, 1.2, 0.12], // cabinet readout
    [WS[0], 45.6, WS[2], 1.5, 1.5, 1.5], // 5: mast beacon
    [SPX, 13.6, SPZ, 1.2, 1.2, 1.2], // 6: slot overflow warning
  ]
  const sendNeon = neonBatch(gSender, unitBox, sendNeonSpecs)
  const IX_BEACON = 5
  const IX_SLOTWARN = 6

  signs.plate('walsender', WS[0], 4.9, WS[2] + 10.1, 'south', 1.1, COLOR.replication, 1.0)
  const [SGN_SLOT] = signs.plate('replication slot', SPX, 15.0, SPZ, 'west', 1.1, COLOR.replication, 0.7)

  /* =======================================================================
   * 5. LOGICAL DECODER — physical WAL in, per-row changes out.
   * =====================================================================*/

  const gLogical = new THREE.Group()
  gLogical.name = 'logical.decoder'
  group.add(gLogical)

  const logMass: BoxSpec[] = [
    [LD[0], 0.7, LD[2], 24, 1.4, 20],
    [LD[0] - 10, 5.9, LD[2] - 8, 1.4, 9, 1.4], // posts
    [LD[0] + 10, 5.9, LD[2] - 8, 1.4, 9, 1.4],
    [LD[0] - 10, 5.9, LD[2] + 8, 1.4, 9, 1.4],
    [LD[0] + 10, 5.9, LD[2] + 8, 1.4, 9, 1.4],
    [LD[0], 10.9, LD[2], 26, 1.0, 22], // roof
    [LD[0], 12.4, LD[2], 10, 2.0, 10], // lantern
  ]
  const logStruct = batch(gLogical, unitBox, matStruct, logMass, true)

  const logDetail: BoxSpec[] = [
    [LD[0], 1.6, LD[2], 14, 0.4, 14], // plinth under the prism
    [LD[0], 10.3, LD[2], 24.4, 0.4, 20.4],
    [LD[0] - 10, 10.4, LD[2], 1.8, 0.4, 17],
    [LD[0] + 10, 10.4, LD[2], 1.8, 0.4, 17],
  ]
  const logDetailMesh = batch(gLogical, unitBox, matDeep, logDetail)

  // Prism: a real triangular section, oriented so a face meets the incoming WAL.
  const inDir = new THREE.Vector3(LD[0] - 176, 0, LD[2] - 22).normalize()
  const inHeading = Math.atan2(inDir.x, inDir.z)
  const outHeading = Math.atan2(ANCHOR.subscriber[0] - LD[0], ANCHOR.subscriber[2] - LD[2])

  const prismGeo = own(new THREE.CylinderGeometry(4.2, 4.2, 7.6, 3))
  const prism = new THREE.Mesh(prismGeo, matGlass)
  prism.position.set(LD[0], 5.8, LD[2])
  prism.rotation.y = inHeading
  gLogical.add(prism)

  const prismCoreGeo = own(new THREE.CylinderGeometry(2.7, 2.7, 6.9, 3))
  const prismCore = new THREE.Mesh(prismCoreGeo, neonWhite)
  const prismCoreMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }))
  prismCore.material = prismCoreMat
  prismCore.position.copy(prism.position)
  prismCore.rotation.y = inHeading
  prismCore.raycast = () => {}
  gLogical.add(prismCore)

  const N_OUT = TABLES.length
  const beamOut = new THREE.InstancedMesh(unitBox, neonWhite, N_OUT)
  beamOut.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  const outAngle = new Float32Array(N_OUT)
  for (let i = 0; i < N_OUT; i++) {
    const spread = ((i - (N_OUT - 1) / 2) / Math.max(1, N_OUT - 1)) * 0.62
    outAngle[i] = outHeading + spread
  }
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_OUT; i++) {
    _q.setFromAxisAngle(_axisY, outAngle[i])
    _p.set(LD[0], 5.8, LD[2])
    _p.x += Math.sin(outAngle[i]) * (4.2 + 7.5)
    _p.z += Math.cos(outAngle[i]) * (4.2 + 7.5)
    setTRS(beamOut, i, _p.x, _p.y, _p.z, 0.5, 0.5, 15, _q)
    beamOut.setColorAt(i, _c)
  }
  beamOut.instanceMatrix.needsUpdate = true
  beamOut.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gLogical.add(beamOut)

  const logNeon = neonBatch(gLogical, unitBox, [
    [LD[0], 12.4, LD[2] - 5.05, 8.4, 1.0, 0.12],
    [LD[0], 12.4, LD[2] + 5.05, 8.4, 1.0, 0.12],
    [LD[0] - 5.05, 12.4, LD[2], 0.12, 1.0, 8.4],
    [LD[0] + 5.05, 12.4, LD[2], 0.12, 1.0, 8.4],
    [LD[0], 2.0, LD[2], 13, 0.12, 13], // floor ring
    [LD[0], 5.8, LD[2], 0.9, 0.9, 18], // 5: the opaque amber feed (rotated below)
  ])
  const IX_FEED = 5
  {
    // The incoming beam is physical WAL: one colour, no structure to it yet.
    const len = 18
    _p.set(LD[0], 5.8, LD[2]).addScaledVector(inDir, -(4.2 + len / 2))
    _q.setFromAxisAngle(_axisY, inHeading)
    setTRS(logNeon, IX_FEED, _p.x, _p.y, _p.z, 0.9, 0.9, len, _q)
    logNeon.instanceMatrix.needsUpdate = true
  }

  signs.plate('logical decoder', LD[0], 14.4, LD[2] - 5.2, 'north', 1.1, COLOR.toast, 1.0)
  const [SGN_LOGON] = signs.plate('wal_level = logical', LD[0], 3.2, LD[2] - 10.2, 'north', 0.9, COLOR.ok, 0.15)
  const [SGN_LOGOFF] = signs.plate('requires wal_level = logical', LD[0], 3.2, LD[2] + 10.2, 'south', 0.9, COLOR.crit, 0.15)

  /* =======================================================================
   * 6. AMBIENT — trunk mains, district haze.
   * =====================================================================*/

  const gAmbient = new THREE.Group()
  gAmbient.name = 'wal.ambient'
  group.add(gAmbient)

  // wal_buffers → walwriter, and walwriter → vault. The pipe is structure; it
  // clear-spans the excavation because there is nothing at y≈0 to stand on.
  const flushCurve = subCurve('wal.flush', 0.22, 1.0, 22)
  const writeCurve = subCurve('wal.write', 0.0, 1.0, 22)
  const tubeFlushGeo = own(new THREE.TubeGeometry(flushCurve, 40, 0.62, 6, false))
  const tubeWriteGeo = own(new THREE.TubeGeometry(writeCurve, 40, 0.7, 6, false))
  const tubeFlush = new THREE.Mesh(tubeFlushGeo, matHeavy)
  const tubeWrite = new THREE.Mesh(tubeWriteGeo, matHeavy)
  tubeFlush.raycast = () => {}
  tubeWrite.raycast = () => {}
  gAmbient.add(tubeFlush, tubeWrite)

  // Collars: amber rings where the main is bolted together.
  const N_COLLAR = 16
  const collarGeo = own(new THREE.TorusGeometry(0.9, 0.14, 5, 14))
  const collars = new THREE.InstancedMesh(collarGeo, neonWhite, N_COLLAR)
  _c.setHex(COLOR.wal).multiplyScalar(0.5)
  for (let i = 0; i < N_COLLAR; i++) {
    const half = i < N_COLLAR / 2
    const k = half ? i / (N_COLLAR / 2) : (i - N_COLLAR / 2) / (N_COLLAR / 2)
    const route = half ? 'wal.flush' : 'wal.write'
    const t = half ? 0.24 + k * 0.66 : 0.18 + k * 0.7
    routePoint(route, t, _p)
    routeTangent(route, t, _p2)
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _p2)
    setTRS(collars, i, _p.x, _p.y, _p.z, 1, 1, 1, _q)
    collars.setColorAt(i, _c)
  }
  collars.instanceMatrix.needsUpdate = true
  collars.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  collars.raycast = () => {}
  gAmbient.add(collars)

  // Warm ground haze over the district. Clears the excavation (x > 121).
  const hazeMat = own(
    new THREE.MeshBasicMaterial({
      map: soft,
      color: COLOR.wal,
      transparent: true,
      opacity: 0.09,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const haze = new THREE.Mesh(quadGeo, hazeMat)
  haze.rotation.x = -Math.PI / 2
  haze.position.set(190, 0.9, 4)
  haze.scale.set(136, 192, 1)
  haze.renderOrder = 2
  haze.raycast = () => {}
  gAmbient.add(haze)

  /* --- one blueprint line pass for the whole district --------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)

  /* --- signage mesh (one draw call for every label in the district) -------- */
  const signMesh = signs.build()
  group.add(signMesh)

  /* =======================================================================
   * Registration.
   * =====================================================================*/

  let flushHz = 0
  let craneCarrying = false

  ctx.register({
    id: 'walwriter',
    name: 'walwriter',
    role: 'writes WAL out of shared memory, and fsyncs it',
    kind: 'process',
    district: 'wal',
    object: gWalWriter,
    tier: 0,
    focus: { target: [WX + 4, 14, WZ], distance: 82, dir: [-0.9, 0.42, -0.32] },
    labelAt: [WX + 4, 41, WZ],
    color: COLOR.wal,
    readout: (s: SimState) =>
      `${flushHz.toFixed(1)} flush/s · ${fmtBytes(s.wal.bytesPerSec)}/s · ${fmtBytes(s.wal.insertLsn - s.wal.flushLsn)} not durable`,
  })

  ctx.register({
    id: 'wal.vault',
    name: 'pg_wal',
    role: 'the write-ahead log on disk — 16 MB segments',
    kind: 'storage',
    district: 'wal',
    object: gVault,
    tier: 0,
    focus: { target: [VX, 8, 0], distance: 132, dir: [-0.82, 0.5, -0.28] },
    labelAt: [VX, 22, 0],
    color: COLOR.wal,
    readout: (s: SimState) => {
      const segs = s.wal.segments
      let cur = ''
      for (let i = 0; i < segs.length; i++) if (segs[i].state === 'current') cur = segs[i].name
      return `${cur || '—'} · pg_wal ${fmtBytes(s.wal.segmentCount * s.wal.segmentSize)}`
    },
  })

  ctx.register({
    id: 'archiver',
    name: 'archiver',
    role: 'runs archive_command on every completed segment',
    kind: 'process',
    district: 'wal',
    object: gArchiver,
    tier: 1,
    focus: { target: [AR[0], 10, AR[2]], distance: 74, dir: [-0.55, 0.48, -0.68] },
    labelAt: [AR[0], 24, AR[2]],
    color: COLOR.archive,
    readout: (s: SimState) =>
      s.knobs.walLevel === 'minimal'
        ? 'archiving off (wal_level = minimal)'
        : `queue ${s.wal.archiveQueue} · ${s.wal.archived} archived${craneCarrying ? ' · lifting' : ''}`,
  })

  ctx.register({
    id: 'archive.store',
    name: 'archive store',
    role: 'where archived WAL goes to be forgotten about',
    kind: 'storage',
    district: 'wal',
    object: gStore,
    tier: 1,
    focus: { target: [AS[0], 6, AS[2]], distance: 68, dir: [-0.7, 0.45, -0.55] },
    labelAt: [AS[0], 16, AS[2]],
    color: COLOR.archive,
    readout: (s: SimState) => `${s.wal.archived} segments · ${fmtBytes(s.wal.archived * s.wal.segmentSize)}`,
  })

  ctx.register({
    id: 'walsender',
    name: 'walsender',
    role: 'streams WAL to the standby, and holds a slot open for it',
    kind: 'process',
    district: 'wal',
    object: gSender,
    tier: 0,
    focus: { target: [WS[0], 20, WS[2]], distance: 92, dir: [-0.72, 0.4, 0.52] },
    labelAt: [WS[0], 50, WS[2]],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const r = s.replication
      if (!r.connected) return `disconnected · slot holding ${fmtBytes(r.lagBytes)}`
      return `sent ${fmtLsn(r.sentLsn)} · lag ${fmtBytes(r.lagBytes)}`
    },
  })

  ctx.register({
    id: 'logical.decoder',
    name: 'logical decoder',
    role: 'turns physical WAL into per-row changes',
    kind: 'process',
    district: 'wal',
    object: gLogical,
    tier: 1,
    focus: { target: [LD[0], 7, LD[2]], distance: 66, dir: [-0.6, 0.45, 0.56] },
    labelAt: [LD[0], 18, LD[2]],
    color: COLOR.toast,
    readout: (s: SimState) =>
      s.replication.logicalEnabled
        ? `${s.replication.logicalChangesPerSec.toFixed(0)} changes/s · slot ${fmtLsn(s.replication.logicalSlotLsn)}`
        : 'dark — requires wal_level = logical',
  })

  /* =======================================================================
   * Runtime state. Nothing below here allocates.
   * =====================================================================*/

  let prevT = -1
  let prevFlush = -1
  let prevSent = -1
  let strokeT = 1 // 0..1 through a piston stroke; >=1 means at rest
  let strokeBytes = 0
  let flushAcc = 0
  let flushWin = 0
  let inFlight = 0 // written-but-not-yet-durable, decays over a stroke
  let wheelAngle = 0
  let chargeZ = 0
  let chargeLevel = 0
  let bypassLevel = 0
  let queueLevel = 0
  let streamPulse = 0
  let logicalAcc = 0
  let streamAcc = 0
  let logicalBeat = 0

  // Crane: driven by the *simulated* clock so it stays locked to the sim.
  let craneSlot = -1
  let cranePhase = 0 // 0 park, 1 reach, 2 lift, 3 haul, 4 drop, 5 return
  let craneT = 0 // 0..1 along wal.archive
  let craneClock = 0
  let craneHook = 0 // 0 = up, 1 = down
  const cranePos = new THREE.Vector3()
  const craneFrom = new THREE.Vector3()
  const craneTarget = new THREE.Vector3()
  /** The trolley rides this far above the runway line. */
  const CRANE_LIFT = 3.4
  /** Deck height inside the vault hall: under the architrave, clear of the rail. */
  const CRANE_HALL_Y = 11.4
  /** Parking bay, sampled once — Curve.getPoint is not free enough for a hot loop. */
  const cranePark = routePoint('wal.archive', 0.02, new THREE.Vector3())
  cranePark.y += CRANE_LIFT
  cranePos.copy(cranePark)
  craneFrom.copy(cranePos)

  const ARCH_WINDOW = 2.4 // the sim's per-segment archive time

  function segColor(state: string): number {
    switch (state) {
      case 'current':
        return COLOR.wal
      case 'full':
        return COLOR.wal
      case 'streamed':
        return COLOR.wal
      case 'archiving':
        return mixHex(COLOR.wal, COLOR.archive, 0.5)
      case 'archived':
        return COLOR.archive
      default:
        return COLOR.walDim
    }
  }

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated dt: freezes when paused
    prevT = t
    const wal = sim.wal
    const rep = sim.replication

    /* --- 1. WALWRITER -------------------------------------------------- */

    if (prevFlush < 0) prevFlush = wal.flushLsn
    const dFlush = wal.flushLsn - prevFlush
    prevFlush = wal.flushLsn
    if (dFlush > 0) {
      // One fsync completed: one piston stroke, one puff of steam.
      strokeT = 0
      strokeBytes = dFlush
      inFlight = 1
      flushAcc += 1
    }
    // Rate is per *simulated* second, so the readout still means something when
    // the user winds the clock up or pauses it.
    flushWin += dts
    if (flushWin >= 0.5) {
      flushHz = damp(flushHz, flushAcc / flushWin, 8, flushWin)
      flushAcc = 0
      flushWin = 0
    }
    if (strokeT < 1) strokeT = Math.min(1, strokeT + dt / 0.34)
    // Fast down-stroke, slower return: a pump, not a metronome.
    const stroke = strokeT >= 1 ? 0 : strokeT < 0.34 ? smoothstep(strokeT / 0.34) : 1 - smoothstep((strokeT - 0.34) / 0.66)
    pistonGroup.position.y = -2.6 * stroke
    inFlight = Math.max(0, inFlight - dt * 3.6)

    // Gauge A: WAL sitting in wal_buffers, inserted but not handed to the OS.
    const unwritten = clamp01(wal.bufferBytes / Math.max(1, wal.bufferCapacity))
    // Gauge B: bytes written but not yet fsynced. Zero at rest — which is the
    // point: after the stroke completes they are durable, and only then.
    const undurable = inFlight * clamp01(strokeBytes / Math.max(1, wal.bufferCapacity) + 0.35)

    const gwH = Math.max(0.06, unwritten * WW_GAUGE_H)
    setTRS(wwNeon, IX_GW, WX + 1, GAUGE_Y0 + gwH / 2, WZ + 9.12, 2.6, gwH, 0.3)
    const gfH = Math.max(0.06, undurable * WW_GAUGE_H)
    setTRS(wwNeon, IX_GF, WX + 7, GAUGE_Y0 + gfH / 2, WZ + 9.12, 2.6, gfH, 0.3)
    wwNeon.instanceMatrix.needsUpdate = true

    const syncOff = sim.knobs.synchronousCommit === 'off'
    bypassLevel = damp(bypassLevel, syncOff ? 1 : 0, 5, dt)

    // Window slits brighten with WAL throughput: a busy station is a lit one.
    _c.setHex(COLOR.wal).multiplyScalar(0.22 + clamp01(wal.bytesPerSec / (3 * MB)) * 0.5)
    for (let i = 0; i < 6; i++) wwNeon.setColorAt(i, _c)
    _c.setHex(COLOR.wal).multiplyScalar(0.5 + unwritten * 2.2)
    wwNeon.setColorAt(IX_GW, _c)
    // The flush gauge flashes green as the write becomes durable.
    _c.setHex(COLOR.wal).multiplyScalar(0.35 + undurable * 1.6)
    _c2.setHex(COLOR.ok).multiplyScalar(2.4 * Math.max(0, 1 - strokeT * 2.2))
    _c.add(_c2)
    wwNeon.setColorAt(IX_GF, _c)
    _c.setHex(COLOR.wal).multiplyScalar(0.55)
    wwNeon.setColorAt(8, _c)
    _c.setHex(COLOR.ok).multiplyScalar(0.55)
    wwNeon.setColorAt(9, _c)
    _c.setHex(COLOR.ok).multiplyScalar(0.08 + bypassLevel * (1.5 + 0.4 * Math.sin(t * 5)))
    for (let i = 0; i < 3; i++) wwNeon.setColorAt(IX_BYP + i, _c)
    _c.setHex(COLOR.wal).multiplyScalar(0.3 + unwritten * 1.9)
    wwNeon.setColorAt(IX_INTAKE, _c)
    _c.setHex(COLOR.wal).multiplyScalar(0.25 + stroke * 2.6)
    wwNeon.setColorAt(IX_OUTLET, _c)
    _c.setHex(COLOR.wal).multiplyScalar(0.2 + stroke * 2.2)
    wwNeon.setColorAt(IX_PIST, _c)
    wwNeon.setColorAt(IX_PIST + 1, _c)

    // Durability lamp: green when the log is caught up with the inserts.
    const behind = wal.insertLsn - wal.flushLsn
    if (syncOff) _c.setHex(COLOR.warn).multiplyScalar(0.9 + 0.5 * Math.sin(t * 3))
    else if (behind < 4096) _c.setHex(COLOR.ok).multiplyScalar(2.0)
    else _c.setHex(COLOR.wal).multiplyScalar(1.2 + 1.2 * Math.min(1, behind / wal.bufferCapacity))
    wwNeon.setColorAt(IX_LAMP, _c)
    wwNeon.instanceColor!.needsUpdate = true

    signs.setColor(SGN_BYPASS, COLOR.ok, 0.12 + bypassLevel * 0.95)

    // Flywheel: WAL throughput, made rotational.
    wheelAngle += dt * (0.35 + clamp01(wal.bytesPerSec / (2 * MB)) * 7)
    if (wheelAngle > TAU) wheelAngle -= TAU
    wheelGroup.rotation.z = wheelAngle

    // Steam. Rises faster the harder the station is working.
    if (steam.visible) {
      const heat = clamp01(flushHz / 8) * 0.7 + stroke * 0.4
      for (let i = 0; i < N_STEAM; i++) {
        stT[i] += dt * (0.14 + heat * 0.5)
        if (stT[i] >= 1) stT[i] -= 1
        const k = stT[i]
        const y = 28 + k * 17
        const s = stS[i] * (0.5 + k * 1.6)
        _p.set(WX + 4 + stX[i] * (0.4 + k), y, WZ + stZ[i] * (0.4 + k))
        _sc.set(s, s, s)
        _m.compose(_p, ctx.camera.quaternion, _sc)
        steam.setMatrixAt(i, _m)
        const a = (1 - k) * k * 4 * (0.05 + heat * 0.16)
        _c.setHex(mixHex(COLOR.wal, COLOR.ink, 0.5)).multiplyScalar(a)
        steam.setColorAt(i, _c)
      }
      steam.instanceMatrix.needsUpdate = true
      steam.instanceColor!.needsUpdate = true
    }

    /* --- 2. THE VAULT --------------------------------------------------- */

    const segs = wal.segments
    const sentSeg = Math.floor(rep.sentLsn / Math.max(1, wal.segmentSize))
    let curIdx = -1
    const outArr = outColAttr.array as Float32Array
    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) {
      const s = segs[i]
      if (!s) continue
      const st = s.state
      if (st === 'current') curIdx = i

      // file name — only redraw the atlas row when the window actually scrolls
      if (segNameCache[i] !== s.name) {
        segNameCache[i] = s.name
        signs.redraw(segNameRow[i], s.name)
      }

      const base = segColor(st)
      let bright: number
      let fill = s.fill
      switch (st) {
        case 'current':
          bright = 1.9
          break
        case 'full':
          bright = 1.35
          fill = 1
          break
        case 'streamed':
          bright = 1.25
          fill = 1
          break
        case 'archiving':
          bright = 1.5 + 0.7 * Math.sin(t * 9)
          fill = 1
          break
        case 'archived':
          bright = 0.42
          fill = 1
          break
        default: // recycled: the file is still there, it just has no content yet
          bright = 0
          fill = 0
      }
      // The segment currently in the crane's hook is out of its cradle.
      if (craneCarrying && craneSlot === i) fill = 0

      const h = SEG_H * fill
      if (h > 0.02) setTRS(segFillMesh, i, VX, SEG_Y0 + h / 2, walSegZ(i), 7.0, h, 7.2)
      else hideInst(segFillMesh, i)
      _c.setHex(base).multiplyScalar(bright)
      segFillMesh.setColorAt(i, _c)

      // cap: a completed segment is closed
      const capped = fill >= 0.999 && st !== 'current'
      if (capped) setBox(segCaps, i, [VX, SEG_Y0 + SEG_H + 0.3, walSegZ(i), 8.0, 0.5, 8.2])
      else hideInst(segCaps, i)

      // "already streamed to the standby" marker on the flank
      const streamed = rep.connected && s.id < sentSeg && st !== 'recycled'
      _c.setHex(COLOR.replication).multiplyScalar(streamed ? 1.6 : 0)
      segMarks.setColorAt(i, _c)

      // envelope outline: bright ghost for recycled, faint elsewhere
      if (st === 'recycled') _c.setHex(COLOR.inkDim).multiplyScalar(0.34)
      else _c.setHex(base).multiplyScalar(0.22 + bright * 0.12)
      const o = i * OUT_VERTS * 3
      for (let v = 0; v < OUT_VERTS; v++) {
        outArr[o + v * 3] = _c.r
        outArr[o + v * 3 + 1] = _c.g
        outArr[o + v * 3 + 2] = _c.b
      }

      signs.setColor(segNameQuad[i], st === 'recycled' ? COLOR.inkDim : base, st === 'recycled' ? 0.35 : 0.55 + bright * 0.25)
    }
    segFillMesh.instanceMatrix.needsUpdate = true
    segFillMesh.instanceColor!.needsUpdate = true
    segCaps.instanceMatrix.needsUpdate = true
    segMarks.instanceColor!.needsUpdate = true
    outColAttr.needsUpdate = true

    // Charging head slides to whichever segment is current and pours into it.
    if (curIdx >= 0) chargeZ = damp(chargeZ, walSegZ(curIdx), 4, dt)
    chargeGroup.position.z = chargeZ
    chargeLevel = damp(chargeLevel, clamp01(wal.bytesPerSec / (2.5 * MB)), 4, dt)
    const segTop = curIdx >= 0 ? SEG_Y0 + SEG_H * (segs[curIdx]?.fill ?? 0) : SEG_Y0
    const beamLen = Math.max(0.2, 10.0 - segTop)
    chargeBeam.position.set(0, segTop + beamLen / 2, 0)
    chargeBeam.scale.set(0.55, beamLen, 0.55)
    chargeBeamMat.opacity = 0.1 + chargeLevel * 0.5
    signs.setColor(SGN_RECYC, COLOR.inkDim, 0.45 + 0.12 * Math.sin(t * 0.9))

    /* --- 3. ARCHIVER + CRANE -------------------------------------------- */

    // Which slot is the sim archiving right now?
    let archIdx = -1
    for (let i = 0; i < N_WAL_SEG_SLOTS; i++) if (segs[i] && segs[i].state === 'archiving') archIdx = i

    if (archIdx >= 0 && archIdx !== craneSlot) {
      // A new segment went to archive_command: start a fresh lift from wherever
      // the crane happens to be. No teleporting, however far behind it is.
      craneSlot = archIdx
      cranePhase = 1
      craneClock = 0
      craneFrom.copy(cranePos)
      craneCarrying = false
      ctx.flow({ route: 'wal.archive', count: 2, kind: 'archive', color: COLOR.archive, stagger: 0.08 })
    } else if (archIdx < 0 && craneSlot >= 0 && cranePhase >= 1 && cranePhase < 4) {
      // The sim finished before the crane did — put it down and go home.
      cranePhase = 4
      craneClock = 0
    }

    craneClock += dts
    switch (cranePhase) {
      case 1: {
        // travel down the hall to the slot being archived
        const k = clamp01(craneClock / (ARCH_WINDOW * 0.2))
        craneTarget.set(VX - CRANE_ARM, CRANE_HALL_Y, walSegZ(craneSlot))
        cranePos.lerpVectors(craneFrom, craneTarget, smoothstep(k))
        craneT = 0
        craneHook = 1 // hook already down, ready to take the load
        if (k >= 1) {
          cranePhase = 2
          craneClock = 0
        }
        break
      }
      case 2: {
        // close on the ingot, then hoist it clear of the cradle
        const k = clamp01(craneClock / (ARCH_WINDOW * 0.16))
        craneHook = 1 - smoothstep(k)
        craneCarrying = k > 0.25
        if (k >= 1) {
          cranePhase = 3
          craneClock = 0
          craneFrom.copy(cranePos)
        }
        break
      }
      case 3: {
        // out along the runway to the cold store
        const k = clamp01(craneClock / (ARCH_WINDOW * 0.52))
        craneT = k
        routePoint('wal.archive', craneT, _p)
        _p.y += CRANE_LIFT
        // ease off the in-hall pickup point onto the runway
        cranePos.copy(_p)
        if (k < 0.18) cranePos.lerpVectors(craneFrom, _p, smoothstep(k / 0.18))
        craneHook = 0
        craneCarrying = true
        if (k >= 1) {
          cranePhase = 4
          craneClock = 0
        }
        break
      }
      case 4: {
        // lower it into the stack
        const k = clamp01(craneClock / (ARCH_WINDOW * 0.14))
        routePoint('wal.archive', 1, cranePos)
        cranePos.y += CRANE_LIFT
        craneHook = smoothstep(k)
        if (craneCarrying && k > 0.7) {
          craneCarrying = false
          ctx.flow({ route: 'wal.archive', count: 3, kind: 'archive', color: COLOR.archive, stagger: 0.05 })
        }
        if (k >= 1) {
          cranePhase = 5
          craneClock = 0
          craneT = 1
        }
        break
      }
      case 5: {
        const k = clamp01(craneClock / 0.9)
        craneT = 1 - k
        routePoint('wal.archive', craneT, cranePos)
        cranePos.y += CRANE_LIFT
        craneHook = 1 - k
        if (k >= 1) {
          cranePhase = 0
          craneSlot = -1
        }
        break
      }
      default:
        cranePos.copy(cranePark)
        craneT = 0
        craneHook = 0
        craneCarrying = false
    }

    craneGroup.position.copy(cranePos)
    if (cranePhase === 3) {
      routeTangent('wal.archive', craneT, _p2)
      craneGroup.rotation.y = Math.atan2(_p2.x, _p2.z)
    } else {
      craneGroup.rotation.y = damp(craneGroup.rotation.y, 0, 4, dt)
    }
    // In the hall the hook has 1 m of travel — that is all the headroom there is
    // between the cradles and the charging rail. Over the store it can drop far.
    const hookRange = cranePhase === 4 ? 5.0 : 1.0
    const drop = 0.6 + craneHook * hookRange
    setTRS(craneBody, IX_CABLE, CRANE_ARM, -1.4 - drop / 2, 0, 0.16, drop, 0.16)
    craneBody.instanceMatrix.needsUpdate = true
    craneLoad.visible = craneCarrying
    if (craneCarrying) {
      craneLoad.position.y = -1.4 - drop - 2.9
      craneLoadMat.color.setHex(COLOR.wal).multiplyScalar(1.5)
    }

    // Archive queue mast. A stuck archive_command fills pg_wal — show the stack.
    const qDepth = sim.knobs.walLevel === 'minimal' ? 0 : wal.archiveQueue
    queueLevel = damp(queueLevel, qDepth, 4, dt)
    const qCrit = clamp01((qDepth - 5) / 7)
    for (let i = 0; i < N_QBAR; i++) {
      const on = clamp01(queueLevel - i)
      _c.setHex(COLOR.archive).lerp(_c2.setHex(COLOR.crit), qCrit)
      _c.multiplyScalar(0.04 + on * 1.7)
      archQueue.setColorAt(i, _c)
    }
    _c.setHex(craneCarrying ? COLOR.archive : COLOR.inkDim).multiplyScalar(craneCarrying ? 1.8 : 0.25)
    archQueue.setColorAt(IX_HOIST, _c)
    _c.setHex(COLOR.crit).multiplyScalar(qCrit * (1.2 + 1.2 * Math.sin(t * 6)))
    archQueue.setColorAt(IX_STROBE, _c)
    archQueue.instanceColor!.needsUpdate = true
    signs.setColor(SGN_QUEUE, qCrit > 0.3 ? COLOR.crit : COLOR.archive, 0.35 + qCrit * 0.9)

    // Cold store fill.
    const stored = clamp(wal.archived, 0, N_STORE)
    for (let i = 0; i < N_STORE; i++) {
      const on = i < stored
      const fresh = i === stored - 1
      _c.setHex(COLOR.archive).multiplyScalar(on ? (fresh ? 1.4 : 0.34) : 0.015)
      storeSlots.setColorAt(i, _c)
    }
    storeSlots.instanceColor!.needsUpdate = true

    /* --- 4. WALSENDER ---------------------------------------------------- */

    if (prevSent < 0) prevSent = rep.sentLsn
    const dSent = rep.sentLsn - prevSent
    prevSent = rep.sentLsn
    if (dSent > 0 && rep.connected) {
      streamPulse = 1
      streamAcc += dts
      if (streamAcc > 0.3) {
        streamAcc = 0
        ctx.flow({ route: 'wal.stream', count: 1, kind: 'stream', color: COLOR.replication })
        for (let i = 0; i < N_PULSE; i++) {
          if (!pulseOn[i]) {
            pulseOn[i] = 1
            pulseT[i] = 0
            break
          }
        }
      }
    }
    streamPulse = Math.max(0, streamPulse - dt * 2.2)

    let pulseDirty = false
    for (let i = 0; i < N_PULSE; i++) {
      if (!pulseOn[i]) continue
      pulseT[i] += dt / 1.1
      if (pulseT[i] >= 1) {
        pulseOn[i] = 0
        hideInst(pulses, i)
        _c.setRGB(0, 0, 0)
        pulses.setColorAt(i, _c)
        pulseDirty = true
        continue
      }
      const k = pulseT[i]
      _p.copy(dishAt).addScaledVector(dishAim, 3 + k * 34)
      const r = 2.2 + k * 7
      setTRS(pulses, i, _p.x, _p.y, _p.z, r, r, r, pulseQuat)
      _c.setHex(COLOR.replication).multiplyScalar(2.2 * (1 - k) * (1 - k))
      pulses.setColorAt(i, _c)
      pulseDirty = true
    }
    if (pulseDirty) {
      pulses.instanceMatrix.needsUpdate = true
      pulses.instanceColor!.needsUpdate = true
    }

    const connected = rep.connected && rep.enabled
    _c.setHex(COLOR.replication).multiplyScalar(connected ? 0.1 + streamPulse * 1.9 : 0.02)
    dishInnerMat.color.copy(_c)

    // The slot spool: WAL we promised to keep because the standby has not
    // replayed it yet. This is exactly how a forgotten slot fills your disk.
    const lagFrac = clamp01(Math.sqrt(rep.lagBytes / (192 * MB)))
    const spoolR = lerp(2.4, 10.6, lagFrac)
    setTRS(spoolWind, 0, SPX, SPY, SPZ, spoolR, 4.2, spoolR, spoolAxis)
    spoolWind.instanceMatrix.needsUpdate = true
    const spoolCrit = clamp01((lagFrac - 0.72) / 0.28)
    _c.setHex(COLOR.wal).lerp(_c2.setHex(COLOR.crit), spoolCrit).multiplyScalar(0.55 + lagFrac * 1.5)
    spoolWind.setColorAt(0, _c)
    spoolWind.instanceColor!.needsUpdate = true
    signs.setColor(SGN_SLOT, spoolCrit > 0.3 ? COLOR.crit : COLOR.replication, 0.4 + lagFrac * 0.8)

    const sendLevel = connected ? 0.25 + streamPulse * 1.1 : 0.05
    _c.setHex(COLOR.replication).multiplyScalar(sendLevel)
    for (let i = 0; i < IX_BEACON; i++) sendNeon.setColorAt(i, _c)
    // aviation beacon on the mast — ambient, keeps blinking whatever the sim does
    _c.setHex(COLOR.crit).multiplyScalar(0.35 + 0.65 * Math.max(0, Math.sin(t * 2.2)))
    sendNeon.setColorAt(IX_BEACON, _c)
    _c.setHex(COLOR.crit).multiplyScalar(spoolCrit * (1.4 + 1.0 * Math.sin(t * 7)))
    sendNeon.setColorAt(IX_SLOTWARN, _c)
    sendNeon.instanceColor!.needsUpdate = true

    /* --- 5. LOGICAL DECODER ---------------------------------------------- */

    const logicalOn = sim.knobs.walLevel === 'logical'
    logicalBeat = damp(logicalBeat, logicalOn ? 1 : 0, 4, dt)
    const changes = logicalOn ? clamp01(rep.logicalChangesPerSec / 220) : 0

    _c.setHex(COLOR.toast).multiplyScalar(logicalBeat * (0.25 + changes * 0.9))
    prismCoreMat.color.copy(_c)

    if (logicalBeat > 0.01) {
      for (let i = 0; i < N_OUT; i++) {
        const ph = (t * 1.6 + i * 0.37) % 1
        const flick = 0.35 + 0.65 * Math.abs(Math.sin((ph + i * 0.2) * Math.PI * 2))
        _c.setHex(TABLES[i].color).multiplyScalar(logicalBeat * (0.15 + changes * 1.7 * flick))
        beamOut.setColorAt(i, _c)
      }
    } else {
      _c.setRGB(0, 0, 0)
      for (let i = 0; i < N_OUT; i++) beamOut.setColorAt(i, _c)
    }
    beamOut.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.toast).multiplyScalar(0.05 + logicalBeat * (0.35 + changes * 0.8))
    for (let i = 0; i < IX_FEED; i++) logNeon.setColorAt(i, _c)
    // amber in, colour out: the feed only carries WAL when decoding is on
    _c.setHex(COLOR.wal).multiplyScalar(logicalBeat * (0.5 + changes * 1.6))
    logNeon.setColorAt(IX_FEED, _c)
    logNeon.instanceColor!.needsUpdate = true

    signs.setColor(SGN_LOGON, COLOR.ok, 0.12 + logicalBeat * 0.95)
    signs.setColor(SGN_LOGOFF, COLOR.crit, 0.12 + (1 - logicalBeat) * 0.7)

    if (logicalOn) {
      logicalAcc += dts
      if (logicalAcc > 0.33) {
        logicalAcc = 0
        const ti = (t * 3.1) % TABLES.length | 0
        ctx.flow({ route: 'logical.decode', count: 1, kind: 'stream', color: TABLES[ti].color, size: 1.0 })
      }
    }

    /* --- 6. Ambient ------------------------------------------------------ */

    const pipeLevel = 0.25 + clamp01(wal.bytesPerSec / (3 * MB)) * 1.5
    _c.setHex(COLOR.wal).multiplyScalar(pipeLevel * (0.7 + 0.3 * Math.sin(t * 2.2)))
    for (let i = 0; i < N_COLLAR; i++) collars.setColorAt(i, _c)
    collars.instanceColor!.needsUpdate = true
    hazeMat.opacity = 0.05 + clamp01(wal.bytesPerSec / (4 * MB)) * 0.08
  }

  /* =======================================================================
   * Level of detail.
   * =====================================================================*/

  function setDetail(level: 0 | 1 | 2): void {
    const near = level >= 1
    const close = level >= 2

    wwDetailMesh.visible = near
    wheelGroup.visible = near
    steam.visible = near

    vaultRoof.visible = near
    segCradleSides.visible = near
    segOutlines.visible = near
    vaultDoorDetail.visible = close
    vaultDoor.visible = near
    doorPlate.visible = near
    chargeGroup.visible = near

    archDetailMesh.visible = near
    runwayMasts.visible = near
    storeShelfMesh.visible = near

    sendDetailMesh.visible = near
    feedHorn.visible = near
    spoolFlanges.visible = near

    logDetailMesh.visible = near
    prism.visible = near

    collars.visible = near
    edgeLines.visible = near
    signMesh.visible = close
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    signs.dispose()
    for (const m of [
      wwStruct, wwRoundMesh, wwDetailMesh, pistonMesh, wheelSpokes, wwNeon, steam,
      vaultStruct, vaultPiers, vaultRoof, doorPlate, vaultDoorDetail, segCradles, segCradleSides,
      segFillMesh, segCaps, segMarks, chargeBody,
      archStruct, archDetailMesh, archQueue, runwayMasts, craneBody,
      storeStruct, storeShelfMesh, storeSlots,
      sendStruct, sendTowerMesh, sendDetailMesh, feedHorn, pulses, spoolStruct, spoolFlanges, spoolWind, sendNeon,
      logStruct, logDetailMesh, beamOut, logNeon,
      collars,
    ]) {
      m.dispose()
    }
    group.clear()
  }

  // main.ts starts its LOD bucket at 0 and only calls setDetail on a change, so
  // the district has to boot in the far configuration to match.
  setDetail(0)

  return { id: 'wal', group, update, setDetail, dispose }
}
