import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { REPLICA_BUF_GRID } from '../core/types'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtLsn, lerp, makeRng } from '../core/util'
import { ANCHOR, CITY, TABLES, routePoint, routeTangent } from './layout'

/* ============================================================================
 * REPLICATION — a second cluster, and the wire that keeps it alive.
 *
 * A standby is not a backup and not a mirror of your *queries*. It is a server
 * that never finishes crash recovery: a walsender on the primary pushes the
 * physical log down one TCP connection, a walreceiver writes it to the
 * standby's own pg_wal, and one startup process replays those records into
 * pages forever. Nothing about your SQL crosses the wire.
 *
 *   walsender ══ THE WIRE ══▶ WALRECEIVER ──▶ STARTUP ──▶ STANDBY (deck + disk)
 *                    ◀── ack / feedback ──          ▲
 *                                              replica.client (read-only)
 *
 * The whole district is built around four numbers that people constantly
 * conflate — sent / write / flush / replay — so they get a physical ruler with
 * four carriages on it. The gap between the last two *is* replication lag, and
 * it opens because replay is one process and the primary had sixteen.
 * ==========================================================================*/

/* --- module-scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _c2 = new THREE.Color()
const _axisY = new THREE.Vector3(0, 1, 0)
const _axisZ = new THREE.Vector3(0, 0, 1)
/** Ruler scratch: carriage positions and the four LSNs, hoisted out of update(). */
const _carZ = new Float64Array(5)
const _lsn = new Float64Array(4)

const TAU = Math.PI * 2
const MB = 1024 * 1024
/** ms of configured network lag → simulated seconds. Mirrors sim/model.ts. */
const NET_STRETCH = 6

/** cx, cy, cz, w, h, d — for cylinders w/d are diameters. */
type BoxSpec = [number, number, number, number, number, number]

/* --- anchors, never re-derived -------------------------------------------- */
const WS = ANCHOR.walSender // where the wire is fed
const WR = ANCHOR.walReceiver // [120, 0, 200]
const SP = ANCHOR.startupProc // [120, 0, 246]
const RB = ANCHOR.replicaBuffers // [120, 3, 300]
const RC = ANCHOR.replicaClient // [56, 34, 330]
const SUB = ANCHOR.subscriber // [252, 0, 208]

/** Half-width of the standby deck. */
const DECK_H = 22
/** Standby storage yard, south of the deck (see note in the storage section). */
const YARD_Z = 336
/** Where pages leave the deck for the standby's disk. Clear of the tile grid. */
const SHAFT_Z = ANCHOR.replicaBuffers[2] + 19
/** The wire's landfall mast, on the receiver's north side. */
const MAST_Z = 188
/** The LSN ruler stands west of the deck and faces the approaching city. */
const RULER_X = 64
const RULER_Z0 = 214 // north end — oldest LSN on the scale
const RULER_Z1 = 306 // south end — the primary's flush LSN
const RULER_Y = 13

/* ==========================================================================
 * Small builders — all of these run once, at construction time.
 * ========================================================================*/

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

/**
 * Park an instance: zero scale, and *inside* its own district. Sending it to
 * y = -9000 would work visually but would blow up the object's world AABB,
 * which is what the picker measures to draw its selection reticle.
 */
function hideInst(mesh: THREE.InstancedMesh, i: number, x = 0, y = 0, z = 0): void {
  setTRS(mesh, i, x, y, z, 0.0001, 0.0001, 0.0001)
}

/** Re-sample a route into a curve we can extrude. */
function subCurve(route: string, t0: number, t1: number, n: number): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = []
  for (let i = 0; i <= n; i++) pts.push(routePoint(route, t0 + (t1 - t0) * (i / n), new THREE.Vector3()))
  return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5)
}

/* ==========================================================================
 * TEXT — one monospace glyph atlas, one draw call for every string in the
 * district. Changing a string rewrites a few attribute floats; the texture is
 * uploaded exactly once. That is what makes live LSNs affordable.
 * ========================================================================*/

const GL_CW = 32
const GL_CH = 48
const GL_COLS = 16
const GL_ROWS = 6
const GL_ASPECT = GL_CW / GL_CH
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function glyphAtlas(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = GL_COLS * GL_CW
  cv.height = GL_ROWS * GL_CH
  const c = cv.getContext('2d')!
  c.font = `600 ${Math.round(GL_CH * 0.74)}px ${MONO}`
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillStyle = '#ffffff'
  for (let i = 0; i < 95; i++) {
    const col = i % GL_COLS
    const row = (i / GL_COLS) | 0
    c.fillText(String.fromCharCode(32 + i), col * GL_CW + GL_CW / 2, row * GL_CH + GL_CH * 0.55)
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = false
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 4
  return tex
}

/** The atlas is ASCII; formatted simulation strings are not. Fold them in. */
function asciiCode(cc: number): number {
  if (cc === 0x2026) return 0x2e // …
  if (cc === 0x2014 || cc === 0x2013 || cc === 0x2212) return 0x2d // — – −
  if (cc === 0x00b7 || cc === 0x2022) return 0x2e // · •
  if (cc === 0x2192 || cc === 0x25b6) return 0x3e // → ▶
  if (cc === 0x2713) return 0x2a // ✓
  if (cc === 0x2018 || cc === 0x2019) return 0x27 // ’
  if (cc === 0x201c || cc === 0x201d) return 0x22 // ”
  if (cc === 0x2260) return 0x21 // ≠
  return cc
}

type Facing = 'north' | 'south' | 'east' | 'west' | 'up'
const F_R: Record<Facing, [number, number, number]> = {
  west: [0, 0, 1], east: [0, 0, -1], north: [-1, 0, 0], south: [1, 0, 0], up: [1, 0, 0],
}
const F_U: Record<Facing, [number, number, number]> = {
  west: [0, 1, 0], east: [0, 1, 0], north: [0, 1, 0], south: [0, 1, 0], up: [0, 0, -1],
}

interface TextSlot {
  start: number
  cap: number
  size: number
  /** -1 left, 0 centre, 1 right */
  align: number
  x: number; y: number; z: number
  rx: number; ry: number; rz: number
  ux: number; uy: number; uz: number
  text: string
}

class TextBank {
  private readonly pos: Float32Array
  private readonly uv: Float32Array
  private readonly col: Float32Array
  private readonly posAttr: THREE.BufferAttribute
  private readonly uvAttr: THREE.BufferAttribute
  private readonly colAttr: THREE.BufferAttribute
  private readonly tex: THREE.CanvasTexture
  private readonly slots: TextSlot[] = []
  private next = 0
  readonly geometry: THREE.BufferGeometry
  readonly material: THREE.MeshBasicMaterial
  readonly mesh: THREE.Mesh

  constructor(maxChars: number) {
    this.pos = new Float32Array(maxChars * 12)
    this.uv = new Float32Array(maxChars * 8)
    this.col = new Float32Array(maxChars * 12)
    const idx = new Uint16Array(maxChars * 6)
    for (let i = 0; i < maxChars; i++) {
      const v = i * 4
      const o = i * 6
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3
    }
    this.posAttr = new THREE.BufferAttribute(this.pos, 3)
    this.uvAttr = new THREE.BufferAttribute(this.uv, 2)
    this.colAttr = new THREE.BufferAttribute(this.col, 3)
    this.posAttr.setUsage(THREE.DynamicDrawUsage)
    this.uvAttr.setUsage(THREE.DynamicDrawUsage)
    this.colAttr.setUsage(THREE.DynamicDrawUsage)

    const g = new THREE.BufferGeometry()
    g.setAttribute('position', this.posAttr)
    g.setAttribute('uv', this.uvAttr)
    g.setAttribute('color', this.colAttr)
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)
    this.geometry = g

    this.tex = glyphAtlas()
    this.material = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.raycast = () => {}
  }

  /** Reserve `cap` characters at a fixed spot. Returns the slot handle. */
  alloc(
    cap: number,
    x: number, y: number, z: number,
    facing: Facing,
    size: number,
    color: number,
    align: 'left' | 'center' | 'right' = 'center',
    bright = 1,
    text = '',
  ): number {
    const r = F_R[facing]
    const u = F_U[facing]
    const id = this.slots.length
    this.slots.push({
      start: this.next,
      cap,
      size,
      align: align === 'left' ? -1 : align === 'right' ? 1 : 0,
      x, y, z,
      rx: r[0], ry: r[1], rz: r[2],
      ux: u[0], uy: u[1], uz: u[2],
      text: '',
    })
    this.next += cap
    this.setColor(id, color, bright)
    this.set(id, text)
    return id
  }

  /** Rewrite a slot. No-op when the string has not changed. */
  set(id: number, text: string): void {
    const s = this.slots[id]
    if (s.text === text) return
    s.text = text
    const n = Math.min(text.length, s.cap)
    const w = s.size * GL_ASPECT
    const total = n * w
    const x0 = s.align === 0 ? -total / 2 : s.align < 0 ? 0 : -total
    const hh = s.size / 2
    for (let i = 0; i < s.cap; i++) {
      const q = (s.start + i) * 12
      if (i >= n) {
        // collapse onto the anchor, not the origin: a zeroed quad would drag
        // this mesh's bounding box across the whole city
        for (let k = 0; k < 4; k++) {
          this.pos[q + k * 3] = s.x
          this.pos[q + k * 3 + 1] = s.y
          this.pos[q + k * 3 + 2] = s.z
        }
        continue
      }
      let code = asciiCode(text.charCodeAt(i)) - 32
      if (code < 0 || code > 94) code = 0
      const col = code % GL_COLS
      const row = (code / GL_COLS) | 0
      const u0 = col / GL_COLS
      const u1 = (col + 1) / GL_COLS
      const v1 = 1 - row / GL_ROWS
      const v0 = 1 - (row + 1) / GL_ROWS
      const cx = x0 + i * w
      const a0 = cx, a1 = cx + w
      // BL, BR, TR, TL
      this.vert(q + 0, s, a0, -hh)
      this.vert(q + 3, s, a1, -hh)
      this.vert(q + 6, s, a1, hh)
      this.vert(q + 9, s, a0, hh)
      const o = (s.start + i) * 8
      this.uv[o] = u0; this.uv[o + 1] = v0
      this.uv[o + 2] = u1; this.uv[o + 3] = v0
      this.uv[o + 4] = u1; this.uv[o + 5] = v1
      this.uv[o + 6] = u0; this.uv[o + 7] = v1
    }
    this.posAttr.needsUpdate = true
    this.uvAttr.needsUpdate = true
  }

  private vert(o: number, s: TextSlot, a: number, b: number): void {
    this.pos[o] = s.x + s.rx * a + s.ux * b
    this.pos[o + 1] = s.y + s.ry * a + s.uy * b
    this.pos[o + 2] = s.z + s.rz * a + s.uz * b
  }

  /** Move a slot's anchor (used by the ruler carriages). */
  moveTo(id: number, x: number, y: number, z: number): void {
    const s = this.slots[id]
    if (s.x === x && s.y === y && s.z === z) return
    s.x = x; s.y = y; s.z = z
    const t = s.text
    s.text = '\0' // force a relayout
    this.set(id, t)
  }

  setColor(id: number, color: number, bright: number): void {
    const s = this.slots[id]
    _c.setHex(color).multiplyScalar(bright)
    const o = s.start * 12
    for (let i = 0; i < s.cap * 4; i++) {
      this.col[o + i * 3] = _c.r
      this.col[o + i * 3 + 1] = _c.g
      this.col[o + i * 3 + 2] = _c.b
    }
    this.colAttr.needsUpdate = true
  }

  /** Freeze the buffer: draw only what was allocated, and keep the zeroed
   *  tail of the position attribute out of the AABB. */
  finish(min: THREE.Vector3, max: THREE.Vector3): void {
    this.geometry.setDrawRange(0, this.next * 6)
    this.geometry.boundingBox = new THREE.Box3(min, max)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.tex.dispose()
  }
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export const createReplication: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx
  const low = quality.level === 'low'

  const group = new THREE.Group()
  group.name = 'district:replication'

  const owned: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }

  /* --- materials: structure matte, meaning neon -------------------------- */
  const matStruct = theme.mat('rep.struct', { color: 0x27334c, roughness: 0.72, metalness: 0.3, emissive: 0x060a14 })
  const matDeep = theme.mat('rep.deep', { color: 0x141c2e, roughness: 0.9, metalness: 0.12, emissive: 0x04070e })
  const matHeavy = theme.mat('rep.heavy', { color: 0x1f2a41, roughness: 0.52, metalness: 0.5, emissive: 0x070b16 })
  /** The standby is the same architecture, one shade colder and quieter. */
  const matCool = theme.mat('rep.cool', { color: 0x1c2740, roughness: 0.78, metalness: 0.26, emissive: 0x050810 })
  const neonWhite = theme.neon(0xffffff, 1)
  const lineInk = theme.line(COLOR.inkDim, 0.17)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 12)

  const edgeVerts: number[] = []
  const text = new TextBank(1600)

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

  /** Neon batch: white base, per-instance colour carries the meaning. */
  function neonBatch(parent: THREE.Object3D, geo: THREE.BufferGeometry, specs: readonly BoxSpec[]): THREE.InstancedMesh {
    const mesh = batch(parent, geo, neonWhite, specs)
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, _c)
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    mesh.raycast = () => {}
    return mesh
  }

  /* =====================================================================
   * 1. THE WIRE — one TCP connection, drawn at the scale it deserves.
   * ===================================================================*/

  const gWire = new THREE.Group()
  gWire.name = 'net.wire'
  group.add(gWire)

  const streamCurve = subCurve('net.stream', 0.0, 1.0, 40)
  const ackCurve = subCurve('net.ack', 0.0, 1.0, 32)
  const conduitGeo = own(new THREE.TubeGeometry(streamCurve, low ? 40 : 72, 0.46, 5, false))
  const ackGeo = own(new THREE.TubeGeometry(ackCurve, low ? 26 : 48, 0.24, 4, false))
  const conduit = new THREE.Mesh(conduitGeo, matHeavy) // pickable: it *is* net.wire
  const ackLine = new THREE.Mesh(ackGeo, matHeavy)
  ackLine.raycast = () => {}
  gWire.add(conduit, ackLine)
  const STREAM_LEN = streamCurve.getLength()
  const ACK_LEN = ackCurve.getLength()
  /** Mid-span. Idle packets are parked here so the wire's AABB stays honest. */
  const wireMid = routePoint('net.stream', 0.5, new THREE.Vector3())

  /* Sheath: short neon bars clamped along the cable. Segmenting the glow is
   * what lets the link show a *gap* when the standby is gone. */
  const N_SHEATH_S = low ? 26 : 44
  const N_SHEATH_A = low ? 16 : 26
  const N_SHEATH = N_SHEATH_S + N_SHEATH_A
  const sheath = new THREE.InstancedMesh(unitBox, neonWhite, N_SHEATH)
  {
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < N_SHEATH; i++) {
      const onStream = i < N_SHEATH_S
      const k = onStream ? (i + 0.5) / N_SHEATH_S : (i - N_SHEATH_S + 0.5) / N_SHEATH_A
      const route = onStream ? 'net.stream' : 'net.ack'
      routePoint(route, k, _p)
      routeTangent(route, k, _p2).normalize()
      _q.setFromUnitVectors(_axisZ, _p2)
      const len = (onStream ? STREAM_LEN / N_SHEATH_S : ACK_LEN / N_SHEATH_A) * 0.62
      setTRS(sheath, i, _p.x, _p.y, _p.z, onStream ? 0.62 : 0.34, onStream ? 0.62 : 0.34, len, _q)
      sheath.setColorAt(i, _c)
    }
    sheath.instanceMatrix.needsUpdate = true
    sheath.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    sheath.raycast = () => {}
  }
  gWire.add(sheath)

  /* Pylons. Sampled off the real curve, then checked against the excavation
   * and the WAL district's footprints before a foot is planted. */
  const PYLON_T = [0.15, 0.4, 0.62, 0.82]
  const pylonMass: BoxSpec[] = []
  const pylonFine: BoxSpec[] = []
  for (const pt of PYLON_T) {
    routePoint('net.stream', pt, _p)
    routePoint('net.ack', 1 - pt, _p2)
    const h = _p.y
    const cx = (_p.x + _p2.x) / 2
    const cz = (_p.z + _p2.z) / 2
    // Never plant a foot in the excavation or on another district's building.
    if (Math.abs(cx) < CITY.pit.x + 6 && Math.abs(cz) < CITY.pit.z + 6) continue
    pylonMass.push([cx, h / 2, cz, 2.2, h, 2.2])
    pylonMass.push([cx, 0.7, cz, 7.4, 1.4, 7.4]) // footing
    pylonMass.push([cx, h + 1.2, cz, Math.abs(_p.x - _p2.x) + 4, 0.9, 2.0]) // crossarm
    pylonFine.push([cx, h * 0.34, cz, 3.6, 0.5, 3.6]) // maintenance collars
    pylonFine.push([cx, h * 0.67, cz, 3.0, 0.5, 3.0])
    pylonFine.push([_p.x, _p.y + 0.9, _p.z, 0.7, 1.6, 0.7]) // insulators
    pylonFine.push([_p2.x, _p2.y + 0.9, _p2.z, 0.5, 1.6, 0.5])
  }
  const pylonStruct = batch(gWire, unitBox, matStruct, pylonMass, true)
  const pylonDetail = batch(gWire, unitBox, matDeep, pylonFine)

  /* Packets. One per chunk the walsender pushes; each takes exactly
   * network_lag to cross, which is the only honest way to draw latency. */
  const N_PKT = low ? 10 : 20
  const packets = new THREE.InstancedMesh(unitBox, neonWhite, N_PKT)
  packets.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  packets.frustumCulled = false
  packets.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_PKT; i++) {
    hideInst(packets, i, wireMid.x, wireMid.y, wireMid.z)
    packets.setColorAt(i, _c)
  }
  packets.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gWire.add(packets)
  const pktT = new Float32Array(N_PKT)
  const pktOn = new Uint8Array(N_PKT)
  const pktDur = new Float32Array(N_PKT)

  /* The break. A dead link is not a link that is merely dark — it arcs. */
  const BREAK_T = 0.55
  const breakAt = routePoint('net.stream', BREAK_T, new THREE.Vector3())
  const N_SPARK = low ? 5 : 9
  const sparks = new THREE.InstancedMesh(unitBox, neonWhite, N_SPARK)
  sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  sparks.frustumCulled = false
  sparks.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_SPARK; i++) {
    hideInst(sparks, i, breakAt.x, breakAt.y, breakAt.z)
    sparks.setColorAt(i, _c)
  }
  sparks.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gWire.add(sparks)
  const srng = makeRng(0x51de1a)
  const sparkDir = new Float32Array(N_SPARK * 3)
  const sparkPh = new Float32Array(N_SPARK)
  for (let i = 0; i < N_SPARK; i++) {
    sparkDir[i * 3] = srng() - 0.5
    sparkDir[i * 3 + 1] = srng() - 0.5
    sparkDir[i * 3 + 2] = srng() - 0.5
    sparkPh[i] = srng()
  }

  const TX_WIRE = text.alloc(28, breakAt.x, breakAt.y + 7, breakAt.z, 'west', 2.2, COLOR.crit, 'center', 0.1, 'LINK DOWN')
  text.alloc(30, 168, 52, 158, 'west', 1.9, COLOR.replication, 'center', 0.75, 'streaming replication')
  const TX_LAT = text.alloc(26, 168, 48.6, 158, 'west', 1.4, COLOR.inkDim, 'center', 0.8, '')

  /* =====================================================================
   * 2. WALRECEIVER — receives, writes, flushes. Two LSNs, two gauges.
   * ===================================================================*/

  const gRecv = new THREE.Group()
  gRecv.name = 'walreceiver'
  group.add(gRecv)

  const RX = WR[0]
  const RZ = WR[2] + 2

  const recvMass: BoxSpec[] = [
    [RX, 0.6, RZ, 30, 1.2, 22], // apron
    [RX, 5.4, RZ, 20, 9.6, 15], // receive hall
    [RX, 10.7, RZ, 21.4, 0.9, 16.4], // service band
    [RX, 13.0, RZ, 12, 3.8, 9], // equipment room
    [RX, 15.1, RZ, 13, 0.6, 10], // roof cap
    [RX + 2, 7, MAST_Z, 2.0, 14, 2.0], // mast legs, right under the landfall
    [RX + 6, 7, MAST_Z, 2.0, 14, 2.0],
    [RX + 4, 14.4, MAST_Z, 10, 0.9, 7], // mast platform
  ]
  const recvStruct = batch(gRecv, unitBox, matStruct, recvMass, true)

  const recvDetail: BoxSpec[] = [
    [RX, 11.2, RZ, 22, 0.3, 17], // walkway grating
    [RX, 12.1, RZ - 8.3, 21, 0.1, 0.1], // railings
    [RX, 12.1, RZ + 8.3, 21, 0.1, 0.1],
    [RX - 10.6, 12.1, RZ, 0.1, 0.1, 17],
    [RX + 10.6, 12.1, RZ, 0.1, 0.1, 17],
    [RX, 3.0, RZ, 20.3, 0.45, 15.3], // recessed bands
    [RX, 7.6, RZ, 20.3, 0.45, 15.3],
    [RX - 6, 13.0, RZ - 4.7, 2.4, 2.2, 0.4], // equipment vents
    [RX - 2, 13.0, RZ - 4.7, 2.4, 2.2, 0.4],
    [RX + 2, 13.0, RZ - 4.7, 2.4, 2.2, 0.4],
    [RX, 5.4, RZ + 7.8, 15.5, 7.5, 0.5], // gauge board, south face
  ]
  const recvDetailMesh = batch(gRecv, unitBox, matDeep, recvDetail)

  /* The dish, aimed at the walsender — computed, never guessed. */
  const dishAt = new THREE.Vector3(RX + 4, 17.6, MAST_Z)
  const dishAim = new THREE.Vector3(WS[0] - dishAt.x, 26 - dishAt.y, WS[2] - dishAt.z).normalize()
  const dishQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dishAim)
  const dishGeo = own(new THREE.SphereGeometry(5.4, 18, 8, 0, TAU, 0, Math.PI * 0.38))
  const dish = new THREE.Mesh(dishGeo, matStruct)
  dish.position.copy(dishAt)
  dish.quaternion.copy(dishQ)
  gRecv.add(dish)

  const dishInnerMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.BackSide }))
  const dishInner = new THREE.Mesh(dishGeo, dishInnerMat)
  dishInner.position.copy(dishAt)
  dishInner.quaternion.copy(dishQ)
  dishInner.scale.setScalar(0.94)
  dishInner.raycast = () => {}
  gRecv.add(dishInner)

  const feedHorn = new THREE.InstancedMesh(unitCyl, matHeavy, 1)
  _p2.copy(dishAt).addScaledVector(dishAim, 2.8)
  _q.setFromUnitVectors(_axisY, dishAim)
  setTRS(feedHorn, 0, _p2.x, _p2.y, _p2.z, 1.0, 5.4, 1.0, _q)
  feedHorn.instanceMatrix.needsUpdate = true
  gRecv.add(feedHorn)

  /* The standby's own pg_wal: a receiver writes real files to real disk. */
  const N_RSEG = 4
  const rsegCradles: BoxSpec[] = []
  for (let i = 0; i < N_RSEG; i++) rsegCradles.push([RX + 20, 1.4, RZ - 9 + i * 6, 8, 1.6, 5])
  const recvSegCradles = batch(gRecv, unitBox, matHeavy, rsegCradles)
  const recvSegs = new THREE.InstancedMesh(unitBox, neonWhite, N_RSEG)
  recvSegs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_RSEG; i++) {
    hideInst(recvSegs, i, RX + 20, 2.2, RZ - 9 + i * 6)
    recvSegs.setColorAt(i, _c)
  }
  recvSegs.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  recvSegs.raycast = () => {}
  gRecv.add(recvSegs)

  /* Neon: the two gauges. write_lsn is "the kernel has it"; flush_lsn is
   * "the platter has it". They are different numbers and a standby reports
   * both, which is the entire point of this building. */
  const RG_Y0 = 2.4
  const RG_H = 5.6
  const recvNeonSpecs: BoxSpec[] = [
    [RX - 4, RG_Y0, RZ + 8.06, 4.2, 0.12, 0.32], // 0: write gauge (scaled)
    [RX + 4, RG_Y0, RZ + 8.06, 4.2, 0.12, 0.32], // 1: flush gauge (scaled)
    [RX - 4, RG_Y0 - 0.35, RZ + 8.06, 5.0, 0.14, 0.42], // base ticks
    [RX + 4, RG_Y0 - 0.35, RZ + 8.06, 5.0, 0.14, 0.42],
    [RX, 9.4, RZ + 8.06, 15, 0.14, 0.3], // board head rail
    [RX - 10.15, 6.2, RZ, 0.12, 0.5, 12], // hall slits
    [RX + 10.15, 6.2, RZ, 0.12, 0.5, 12],
    [RX, 6.2, RZ - 7.65, 14, 0.5, 0.12],
    [RX + 4, 21.6, MAST_Z, 1.3, 1.3, 1.3], // 8: mast beacon
    [RX + 4, 14.9, MAST_Z, 9.8, 0.14, 0.14], // platform rail light
  ]
  const recvNeon = neonBatch(gRecv, unitBox, recvNeonSpecs)
  const IX_GW = 0
  const IX_GF = 1
  const IX_BEACON = 8

  text.alloc(14, RX, 11.9, RZ + 8.2, 'south', 1.5, COLOR.replication, 'center', 1.05, 'walreceiver')
  text.alloc(12, RX - 4, 1.4, RZ + 8.3, 'south', 0.85, COLOR.wal, 'center', 0.85, 'write_lsn')
  text.alloc(12, RX + 4, 1.4, RZ + 8.3, 'south', 0.85, COLOR.ok, 'center', 0.85, 'flush_lsn')
  const TX_WRITE = text.alloc(13, RX - 4, 10.2, RZ + 8.3, 'south', 0.9, COLOR.wal, 'center', 1.0, '')
  const TX_FLUSH = text.alloc(13, RX + 4, 10.2, RZ + 8.3, 'south', 0.9, COLOR.ok, 'center', 1.0, '')
  text.alloc(22, RX + 20, 4.6, RZ - 9, 'south', 0.75, COLOR.inkDim, 'center', 0.6, 'the standby has')
  text.alloc(22, RX + 20, 3.7, RZ - 9, 'south', 0.75, COLOR.inkDim, 'center', 0.6, 'a pg_wal of its own')

  /* =====================================================================
   * 3. STARTUP PROCESS — one conveyor, and everything that queues for it.
   * ===================================================================*/

  const gStartup = new THREE.Group()
  gStartup.name = 'startup.proc'
  group.add(gStartup)

  const SX = SP[0]
  const BELT_Z0 = 228 // intake, north
  const BELT_Z1 = 260 // apply head, south
  const BELT_Y = 7.2

  const startMass: BoxSpec[] = [
    [SX, 0.6, 244, 26, 1.2, 40], // apron
    [SX - 9, 3.6, BELT_Z0 + 3, 3.0, 7.2, 3.0], // gantry legs
    [SX + 9, 3.6, BELT_Z0 + 3, 3.0, 7.2, 3.0],
    [SX - 9, 3.6, BELT_Z1 - 5, 3.0, 7.2, 3.0],
    [SX + 9, 3.6, BELT_Z1 - 5, 3.0, 7.2, 3.0],
    [SX, BELT_Y - 0.9, (BELT_Z0 + BELT_Z1) / 2, 9.0, 1.0, BELT_Z1 - BELT_Z0 + 6], // belt table
    [SX, 12.4, BELT_Z1 - 1, 14, 9, 9], // apply house
    [SX, 17.2, BELT_Z1 - 1, 15, 0.8, 10], // roof cap
    [SX, 9.4, BELT_Z0 - 1, 13, 6, 7], // intake hopper
  ]
  const startStruct = batch(gStartup, unitBox, matStruct, startMass, true)

  const startDetail: BoxSpec[] = [
    [SX - 5.0, BELT_Y - 0.2, (BELT_Z0 + BELT_Z1) / 2, 0.5, 1.0, BELT_Z1 - BELT_Z0 + 6], // belt kerbs
    [SX + 5.0, BELT_Y - 0.2, (BELT_Z0 + BELT_Z1) / 2, 0.5, 1.0, BELT_Z1 - BELT_Z0 + 6],
    [SX, 12.4, BELT_Z1 + 3.4, 12, 7.4, 0.5], // readout panel, south face
    [SX, 16.0, BELT_Z1 - 1, 9, 1.0, 9],
    [SX - 6.6, 9.4, BELT_Z0 - 1, 0.5, 5.6, 6.6], // hopper flanks
    [SX + 6.6, 9.4, BELT_Z0 - 1, 0.5, 5.6, 6.6],
  ]
  const startDetailMesh = batch(gStartup, unitBox, matDeep, startDetail)

  /* The throughput gate: replay is single-threaded, so the belt necks down
   * to one lane before the apply house. Slow apply narrows it visibly. */
  const gateGroup = new THREE.Group()
  gStartup.add(gateGroup)
  const gateMesh = batch(gateGroup, unitBox, matHeavy, [
    [SX - 3.4, BELT_Y + 1.6, BELT_Z1 - 8, 1.2, 4.0, 1.4],
    [SX + 3.4, BELT_Y + 1.6, BELT_Z1 - 8, 1.2, 4.0, 1.4],
    [SX, BELT_Y + 3.8, BELT_Z1 - 8, 9.0, 0.8, 1.4],
  ])

  /* WAL records riding the belt southwards, and the queue that forms when
   * they arrive faster than one process can apply them. */
  const N_BELT = low ? 10 : 18
  const belt = new THREE.InstancedMesh(unitBox, neonWhite, N_BELT)
  belt.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  belt.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_BELT; i++) {
    hideInst(belt, i, SX, BELT_Y, (BELT_Z0 + BELT_Z1) / 2)
    belt.setColorAt(i, _c)
  }
  belt.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gStartup.add(belt)

  const N_QUEUE = 24
  const queue = new THREE.InstancedMesh(unitBox, neonWhite, N_QUEUE)
  queue.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  queue.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_QUEUE; i++) {
    // Three columns of eight, stacking upward in the hopper.
    const col = i % 3
    const row = (i / 3) | 0
    setBox(queue, i, [SX - 3.4 + col * 3.4, 6.6 + row * 1.5, BELT_Z0 - 1, 2.8, 1.15, 4.6])
    queue.setColorAt(i, _c)
  }
  queue.instanceMatrix.needsUpdate = true
  queue.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gStartup.add(queue)

  /* The apply head: a press that stamps one record onto one page. */
  const pressGroup = new THREE.Group()
  gStartup.add(pressGroup)
  const pressMesh = batch(pressGroup, unitBox, matHeavy, [
    [SX, 13.6, BELT_Z1 - 1, 6.2, 1.6, 6.2],
    [SX, 11.4, BELT_Z1 - 1, 1.0, 3.0, 1.0],
    [SX, 10.0, BELT_Z1 - 1, 5.0, 1.0, 5.0],
  ])
  const pageMesh = new THREE.InstancedMesh(unitBox, neonWhite, 1)
  pageMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  pageMesh.raycast = () => {}
  setBox(pageMesh, 0, [SX, BELT_Y + 0.6, BELT_Z1 - 1, 6.4, 0.5, 6.4])
  pageMesh.instanceMatrix.needsUpdate = true
  _c.setHex(COLOR.bufDirty)
  pageMesh.setColorAt(0, _c)
  pageMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gStartup.add(pageMesh)

  const startNeon = neonBatch(gStartup, unitBox, [
    [SX, BELT_Y - 1.45, (BELT_Z0 + BELT_Z1) / 2, 8.4, 0.1, BELT_Z1 - BELT_Z0 + 6], // belt lane light
    [SX, 12.4, BELT_Z1 + 3.7, 10.4, 0.14, 0.3], // panel rail
    [SX, 8.0, BELT_Z1 + 3.7, 10.4, 0.14, 0.3],
    [SX, 18.0, BELT_Z1 - 1, 1.4, 1.4, 1.4], // 3: activity lamp
    [SX - 6.9, 9.4, BELT_Z0 - 1, 0.12, 0.4, 6.0], // hopper rim
    [SX + 6.9, 9.4, BELT_Z0 - 1, 0.12, 0.4, 6.0],
  ])
  const IX_APPLY_LAMP = 3

  text.alloc(18, SX, 19.6, BELT_Z1 + 3.8, 'south', 1.5, COLOR.replication, 'center', 1.05, 'startup process')
  text.alloc(30, SX, 14.9, BELT_Z1 + 3.8, 'south', 0.85, COLOR.inkDim, 'center', 0.7, 'replays WAL, in LSN order,')
  text.alloc(30, SX, 13.9, BELT_Z1 + 3.8, 'south', 0.85, COLOR.inkDim, 'center', 0.7, 'in one process, forever')
  const TX_APPLY = text.alloc(22, SX, 10.6, BELT_Z1 + 3.8, 'south', 1.15, COLOR.replication, 'center', 1.0, '')
  const TX_QUEUE = text.alloc(26, SX, 15.0, BELT_Z0 - 4.6, 'west', 1.0, COLOR.warn, 'center', 0.8, '')

  /* =====================================================================
   * 4. THE STANDBY — the same city, half the size, half the noise.
   * ===================================================================*/

  const gStandby = new THREE.Group()
  gStandby.name = 'replica.standby'
  group.add(gStandby)

  const BX = RB[0]
  const BZ = RB[2]

  const deckMass: BoxSpec[] = [
    [BX, 0.55, BZ, DECK_H * 2 + 5, 1.1, DECK_H * 2 + 5], // stylobate
    [BX, 2.1, BZ, DECK_H * 2, 1.8, DECK_H * 2], // deck slab, top = 3
    [BX, 3.4, BZ - DECK_H + 0.4, DECK_H * 2, 0.8, 0.8], // parapets
    [BX, 3.4, BZ + DECK_H - 0.4, DECK_H * 2, 0.8, 0.8],
    [BX - DECK_H + 0.4, 3.4, BZ, 0.8, 0.8, DECK_H * 2],
    [BX + DECK_H - 0.4, 3.4, BZ, 0.8, 0.8, DECK_H * 2],
  ]
  const deckStruct = batch(gStandby, unitBox, matCool, deckMass, true)

  const deckDetail: BoxSpec[] = [
    [BX - 15, 1.0, BZ, 2.0, 2.0, DECK_H * 2 + 4], // under-deck ribs
    [BX, 1.0, BZ, 2.0, 2.0, DECK_H * 2 + 4],
    [BX + 15, 1.0, BZ, 2.0, 2.0, DECK_H * 2 + 4],
    [BX - 18, 4.4, BZ, 5.0, 2.0, 5.0], // read-only landing pad (replica.read lands here)
    [BX, 3.15, SHAFT_Z, 5.4, 0.3, 5.4], // the shaft head down to storage
  ]
  const deckDetailMesh = batch(gStandby, unitBox, matDeep, deckDetail)

  /* --- replica.buffers: a 12×12 echo of shared_buffers ------------------ */

  const gBuffers = new THREE.Group()
  gBuffers.name = 'replica.buffers'
  gStandby.add(gBuffers)

  const RG = REPLICA_BUF_GRID
  const N_RTILE = RG * RG
  const RP = CITY.replica.bufPitch
  const R_HALF = ((RG - 1) * RP) / 2
  const TILE = RP * 0.78
  const tiles = new THREE.InstancedMesh(unitBox, neonWhite, N_RTILE)
  tiles.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_RTILE; i++) {
    const col = i % RG
    const row = (i / RG) | 0
    setBox(tiles, i, [BX - R_HALF + col * RP, 3.4, BZ - R_HALF + row * RP, TILE, 0.4, TILE])
    tiles.setColorAt(i, _c)
  }
  tiles.instanceMatrix.needsUpdate = true
  tiles.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gBuffers.add(tiles)

  const tileHeat = new Float32Array(N_RTILE)
  const tileRel = new Uint8Array(N_RTILE)
  const tileRead = new Float32Array(N_RTILE)
  const trng = makeRng(0xb0ffe5)
  for (let i = 0; i < N_RTILE; i++) tileRel[i] = (trng() * TABLES.length) | 0

  text.alloc(22, BX, 2.0, BZ - DECK_H - 0.9, 'north', 1.3, COLOR.replication, 'center', 0.9, 'STANDBY')
  text.alloc(34, BX, 0.9, BZ - DECK_H - 0.9, 'north', 0.7, COLOR.inkDim, 'center', 0.65, 'hot standby — read-only')
  const TX_LAG = text.alloc(30, BX, 8.6, BZ + DECK_H + 1.2, 'south', 1.7, COLOR.replication, 'center', 1.1, '')
  const TX_LAGB = text.alloc(34, BX, 6.6, BZ + DECK_H + 1.2, 'south', 1.0, COLOR.inkDim, 'center', 0.8, '')

  /* --- replica.storage -------------------------------------------------- */
  /* The standby's $PGDATA. It is drawn as a walled yard at grade rather than
   * a second excavation: the ground plate is not ours to cut, and a buried
   * block would simply be invisible. The shaft head on the deck and the
   * descending conveyor carry the "this is below the buffers" reading. */

  const gStore = new THREE.Group()
  gStore.name = 'replica.storage'
  gStandby.add(gStore)

  const storeMass: BoxSpec[] = [
    [BX, 0.5, YARD_Z, 34, 1.0, 24], // yard apron
    [BX, 2.6, YARD_Z - 11.4, 34, 5.2, 1.2], // retaining walls
    [BX - 16.4, 2.6, YARD_Z, 1.2, 5.2, 24],
    [BX + 16.4, 2.6, YARD_Z, 1.2, 5.2, 24],
    [BX, 4.0, YARD_Z + 8, 16, 8.0, 8], // vault head-house
    [BX, 8.4, YARD_Z + 8, 17, 0.8, 9],
    [BX, 3.0, (SHAFT_Z + YARD_Z - 12) / 2, 6.0, 0.6, YARD_Z - 12 - SHAFT_Z], // conveyor off the deck
  ]
  const storeStruct = batch(gStore, unitBox, matCool, storeMass, true)

  const N_RACK = 6
  const rackMesh = new THREE.InstancedMesh(unitBox, neonWhite, N_RACK)
  rackMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  rackMesh.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_RACK; i++) {
    const col = i % 3
    const row = (i / 3) | 0
    setBox(rackMesh, i, [BX - 10 + col * 10, 2.6, YARD_Z - 6 + row * 8, 7.2, 3.0, 5.4])
    rackMesh.setColorAt(i, _c)
  }
  rackMesh.instanceMatrix.needsUpdate = true
  rackMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gStore.add(rackMesh)

  const storeNeon = neonBatch(gStore, unitBox, [
    [BX, 1.1, YARD_Z, 33, 0.1, 23], // yard floor ring
    [BX, 8.9, YARD_Z + 8, 16.4, 0.14, 8.4], // head-house rim
    [BX, 3.34, SHAFT_Z, 5.0, 0.2, 5.0], // 2: the shaft head on the deck
  ])
  const IX_SHAFT = 2

  text.alloc(16, BX, 11.2, YARD_Z + 12.2, 'south', 1.2, COLOR.storage, 'center', 0.95, 'replica $PGDATA')
  text.alloc(24, BX, 3.5, SHAFT_Z + 4.6, 'up', 1.1, COLOR.storage, 'center', 0.55, 'to disk')

  /* --- the four LSNs, on one ruler -------------------------------------- */

  const gRuler = new THREE.Group()
  gRuler.name = 'lsn.ruler'
  gStandby.add(gRuler)

  const RULER_L = RULER_Z1 - RULER_Z0
  const rulerMass: BoxSpec[] = [
    [RULER_X, RULER_Y / 2, RULER_Z0, 2.0, RULER_Y, 2.0], // posts
    [RULER_X, RULER_Y / 2, RULER_Z1, 2.0, RULER_Y, 2.0],
    [RULER_X, 0.6, RULER_Z0, 5, 1.2, 5],
    [RULER_X, 0.6, RULER_Z1, 5, 1.2, 5],
    [RULER_X, RULER_Y, (RULER_Z0 + RULER_Z1) / 2, 1.6, 1.4, RULER_L + 2], // the rail
    [RULER_X + 0.5, 4.9, (RULER_Z0 + RULER_Z1) / 2, 1.4, 9.0, 40], // legend board
  ]
  const rulerStruct = batch(gRuler, unitBox, matStruct, rulerMass, true)

  const N_TICK = 24
  const tickSpecs: BoxSpec[] = []
  for (let i = 0; i <= N_TICK; i++) {
    const z = RULER_Z0 + (i / N_TICK) * RULER_L
    const major = i % 6 === 0
    tickSpecs.push([RULER_X - 0.85, RULER_Y - (major ? 1.5 : 0.9), z, 0.14, major ? 2.0 : 1.0, 0.16])
  }
  const rulerTicks = neonBatch(gRuler, unitBox, tickSpecs)
  _c.setHex(COLOR.inkDim).multiplyScalar(0.5)
  for (let i = 0; i <= N_TICK; i++) rulerTicks.setColorAt(i, _c)
  rulerTicks.instanceColor!.needsUpdate = true

  /* Four carriages plus the primary's own mark and the lag bar. */
  const CAR_SENT = 0, CAR_WRITE = 1, CAR_FLUSH = 2, CAR_REPLAY = 3, CAR_PRIMARY = 4, CAR_LAG = 5
  const CAR_COLOR = [COLOR.replication, COLOR.wal, COLOR.ok, COLOR.client, COLOR.checkpoint, COLOR.crit]
  const CAR_NAME = ['sent', 'write', 'flush', 'replay', 'primary', '']
  const carriages = new THREE.InstancedMesh(unitBox, neonWhite, 6)
  carriages.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  carriages.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < 6; i++) {
    hideInst(carriages, i, RULER_X, RULER_Y, (RULER_Z0 + RULER_Z1) / 2)
    carriages.setColorAt(i, _c)
  }
  carriages.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gRuler.add(carriages)

  const RULER_MID = (RULER_Z0 + RULER_Z1) / 2
  const carLabel: number[] = []
  for (let i = 0; i < 4; i++) {
    carLabel.push(text.alloc(8, RULER_X - 1.6, RULER_Y + 2.4, RULER_Z0, 'west', 1.0, CAR_COLOR[i], 'center', 1.1, CAR_NAME[i]))
  }

  text.alloc(24, RULER_X - 0.4, 8.0, RULER_MID, 'west', 1.9, COLOR.ink, 'center', 0.9, 'pg_stat_replication')
  const TX_SCALE = text.alloc(34, RULER_X - 0.4, 6.3, RULER_MID, 'west', 1.0, COLOR.inkDim, 'center', 0.7)
  const TX_ROW: number[] = []
  for (let i = 0; i < 4; i++) {
    TX_ROW.push(text.alloc(38, RULER_X - 0.4, 5.0 - i * 1.4, RULER_MID, 'west', 1.1, CAR_COLOR[i], 'center', 1.0))
  }
  const TX_LAGBAR = text.alloc(44, RULER_X - 1.2, 10.6, RULER_MID, 'west', 1.15, COLOR.crit, 'center', 1.0)

  /* =====================================================================
   * 5. REPLICA CLIENT — read-only traffic, and the xmin it can pin.
   * ===================================================================*/

  const gClient = new THREE.Group()
  gClient.name = 'replica.client'
  group.add(gClient)

  const podGroup = new THREE.Group()
  podGroup.position.set(RC[0], RC[1], RC[2])
  gClient.add(podGroup)
  const podStruct = batch(podGroup, unitBox, matStruct, [
    [0, 0, 0, 11, 3.0, 11],
    [0, 2.0, 0, 7, 1.4, 7],
    [0, -2.2, 0, 3.0, 1.6, 3.0],
  ], true)
  const ringGeo = own(new THREE.TorusGeometry(8.2, 0.28, 5, 26))
  const ringMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }))
  const podRing = new THREE.Mesh(ringGeo, ringMat)
  podRing.rotation.x = Math.PI / 2
  podRing.raycast = () => {}
  podGroup.add(podRing)

  const clientNeon = neonBatch(gClient, unitBox, [
    [RC[0], RC[1] + 3.0, RC[2], 5.4, 0.2, 5.4], // 0: pod deck light
    [0, 0, 0, 1, 1, 1], // 1: the read beam, aimed at the standby below
    [RC[0], RC[1] + 4.6, RC[2], 1.2, 1.2, 1.2], // 2: feedback lamp
  ])
  const IX_READBEAM = 1
  const IX_FBLAMP = 2
  {
    // The beam lands where the replica.read route lands — on the deck's
    // west landing pad — instead of dropping into open ground beside it.
    _p.set(RC[0], RC[1] - 2.2, RC[2])
    routePoint('replica.read', 1, _p2)
    _p2.y = 4.6
    _sc.subVectors(_p2, _p)
    const len = _sc.length()
    _sc.normalize()
    _q.setFromUnitVectors(_axisY, _sc)
    setTRS(
      clientNeon, IX_READBEAM,
      (_p.x + _p2.x) / 2, (_p.y + _p2.y) / 2, (_p.z + _p2.z) / 2,
      0.5, len, 0.5, _q,
    )
    clientNeon.instanceMatrix.needsUpdate = true
  }

  text.alloc(20, RC[0], RC[1] + 7.4, RC[2], 'south', 1.5, COLOR.client, 'center', 1.0, 'read-only client')
  const TX_RCLIENT = text.alloc(34, RC[0], RC[1] + 5.6, RC[2], 'south', 0.95, COLOR.inkDim, 'center', 0.75, '')
  const TX_FEEDBACK = text.alloc(40, RC[0], RC[1] - 3.4, RC[2], 'south', 1.05, COLOR.vacuum, 'center', 0.1, '')

  /* =====================================================================
   * 6. LOGICAL SUBSCRIBER — rows, not blocks. Only at wal_level=logical.
   * ===================================================================*/

  const gSub = new THREE.Group()
  gSub.name = 'subscriber'
  group.add(gSub)

  const UX = SUB[0]
  const UZ = SUB[2]
  const subMass: BoxSpec[] = [
    [UX, 0.6, UZ, 26, 1.2, 22], // apron
    [UX, 4.4, UZ, 18, 6.4, 14], // apply hall
    [UX, 8.0, UZ, 19.4, 0.9, 15.4], // band
    [UX, 10.2, UZ, 9, 3.6, 8], // worker room
    [UX - 7, 8.4, UZ - 8, 1.2, 15, 1.2], // receiving mast
    [UX - 7, 16.2, UZ - 8, 4.4, 0.5, 4.4],
  ]
  const subStruct = batch(gSub, unitBox, matStruct, subMass, true)

  const subDetail: BoxSpec[] = [
    [UX, 2.2, UZ, 18.3, 0.4, 14.3],
    [UX, 6.2, UZ, 18.3, 0.4, 14.3],
    [UX, 4.4, UZ + 7.3, 14, 5.4, 0.5], // bin board, south face
  ]
  const subDetailMesh = batch(gSub, unitBox, matDeep, subDetail)

  /* One bin per relation: logical replication delivers row changes for the
   * tables in a PUBLICATION, not every block the primary wrote. */
  const N_BIN = TABLES.length
  const bins = new THREE.InstancedMesh(unitBox, neonWhite, N_BIN)
  bins.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  bins.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N_BIN; i++) {
    setBox(bins, i, [UX - 5.6 + i * 2.8, 3.0, UZ + 7.6, 2.0, 0.4, 0.4])
    bins.setColorAt(i, _c)
  }
  bins.instanceMatrix.needsUpdate = true
  bins.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gSub.add(bins)

  const subNeon = neonBatch(gSub, unitBox, [
    [UX, 5.4, UZ + 7.56, 13.4, 0.14, 0.3], // board rails
    [UX, 1.4, UZ + 7.56, 13.4, 0.14, 0.3],
    [UX - 9.15, 4.6, UZ, 0.12, 0.45, 11], // hall slits
    [UX + 9.15, 4.6, UZ, 0.12, 0.45, 11],
    [UX - 7, 17.2, UZ - 8, 1.1, 1.1, 1.1], // 4: mast lamp
  ])
  const IX_SUBLAMP = 4

  text.alloc(20, UX, 12.8, UZ + 7.7, 'south', 1.4, COLOR.toast, 'center', 1.0, 'subscriber')
  const TX_SUB = text.alloc(34, UX, 10.4, UZ + 7.7, 'south', 0.95, COLOR.inkDim, 'center', 0.8, '')
  const TX_SUBOFF = text.alloc(34, UX, 8.9, UZ + 7.7, 'south', 0.85, COLOR.crit, 'center', 0.15, 'needs wal_level = logical')

  /* --- one blueprint pass, one text pass for the district ---------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)
  // The wire's own signage sits over the WAL district, so the box spans both.
  text.finish(new THREE.Vector3(40, -2, 40), new THREE.Vector3(272, 60, 352))
  group.add(text.mesh)

  /* =====================================================================
   * Registration.
   * ===================================================================*/

  let applyRate = 0
  let recvRate = 0

  ctx.register({
    id: 'net.wire',
    name: 'the wire',
    role: 'one TCP connection carrying the log to the standby',
    kind: 'network',
    district: 'replication',
    object: gWire,
    tier: 0,
    focus: { target: [186, 34, 146], distance: 190, dir: [-0.62, 0.36, 0.7] },
    labelAt: [breakAt.x, breakAt.y + 12, breakAt.z],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const r = s.replication
      if (!r.connected) return 'link down — nothing is being streamed'
      return `${r.networkLagMs.toFixed(0)} ms one way · ${r.inFlight} packet${r.inFlight === 1 ? '' : 's'} in flight`
    },
  })

  ctx.register({
    id: 'walreceiver',
    name: 'walreceiver',
    role: 'writes and flushes arriving WAL to the standby’s own pg_wal',
    kind: 'process',
    district: 'replication',
    object: gRecv,
    tier: 0,
    focus: { target: [RX, 9, RZ], distance: 76, dir: [-0.5, 0.42, 0.76] },
    labelAt: [RX, 24, RZ],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const r = s.replication
      if (!r.connected) return 'disconnected'
      return `receiving ${fmtBytes(recvRate)}/s · write ${fmtLsn(r.writeLsn)} · flush ${fmtLsn(r.flushLsn)}`
    },
  })

  ctx.register({
    id: 'startup.proc',
    name: 'startup process',
    role: 'the single process that replays WAL, forever',
    kind: 'process',
    district: 'replication',
    object: gStartup,
    tier: 0,
    focus: { target: [SX, 9, 246], distance: 72, dir: [-0.58, 0.42, 0.7] },
    labelAt: [SX, 22, 246],
    color: COLOR.replication,
    readout: (s: SimState) =>
      `replay ${fmtLsn(s.replication.replayLsn)} · ${fmtBytes(applyRate)}/s · waiting ${fmtBytes(
        Math.max(0, s.replication.flushLsn - s.replication.replayLsn),
      )}`,
  })

  ctx.register({
    id: 'replica.standby',
    name: 'Standby',
    role: 'a second cluster, replaying',
    kind: 'storage',
    district: 'replication',
    object: gStandby,
    tier: 0,
    focus: { target: [98, 10, 288], distance: 150, dir: [-0.58, 0.42, 0.7] },
    labelAt: [BX, 20, BZ],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const r = s.replication
      if (!r.enabled) return 'offline'
      if (!r.connected) return 'disconnected — falling further behind'
      return `${fmtBytes(r.lagBytes)} behind · ${r.lagSec.toFixed(1)} s`
    },
  })

  ctx.register({
    id: 'replica.buffers',
    name: 'standby shared_buffers',
    role: 'a cache filled by the primary’s write set',
    kind: 'memory',
    district: 'replication',
    object: gBuffers,
    tier: 1,
    focus: { target: [BX, 5, BZ], distance: 66, dir: [-0.32, 0.66, 0.68] },
    labelAt: [BX, 14, BZ],
    color: COLOR.bufClean,
    readout: (s: SimState) => `${N_RTILE} frames · replay activity ${(s.replication.applyActivity * 100).toFixed(0)}%`,
  })

  ctx.register({
    id: 'replica.storage',
    name: 'standby $PGDATA',
    role: 'the standby’s own data files and pg_wal',
    kind: 'storage',
    district: 'replication',
    object: gStore,
    tier: 1,
    focus: { target: [BX, 5, YARD_Z], distance: 62, dir: [-0.4, 0.48, 0.78] },
    labelAt: [BX, 15, YARD_Z],
    color: COLOR.storage,
    readout: (s: SimState) => `applied to disk up to ${fmtLsn(s.replication.replayLsn)}`,
  })

  ctx.register({
    id: 'replica.client',
    name: 'read-only client',
    role: 'queries the standby — and can pin the primary’s xmin',
    kind: 'client',
    district: 'replication',
    object: gClient,
    tier: 1,
    focus: { target: [RC[0], RC[1], RC[2]], distance: 68, dir: [-0.5, 0.3, 0.81] },
    labelAt: [RC[0], RC[1] + 12, RC[2]],
    color: COLOR.client,
    readout: (s: SimState) => {
      const pin = s.knobs.longRunningXact && s.replication.connected
      return pin
        ? `hot_standby_feedback — pinning primary xmin ${s.xminHorizon}`
        : `reads see ${fmtLsn(s.replication.replayLsn)} — ${s.replication.lagSec.toFixed(1)} s old`
    },
  })

  ctx.register({
    id: 'subscriber',
    name: 'logical subscriber',
    role: 'applies decoded row changes, not blocks',
    kind: 'client',
    district: 'replication',
    object: gSub,
    tier: 1,
    focus: { target: [UX, 7, UZ], distance: 64, dir: [0.62, 0.44, 0.65] },
    labelAt: [UX, 20, UZ],
    color: COLOR.toast,
    readout: (s: SimState) =>
      s.replication.logicalEnabled
        ? `${s.replication.logicalChangesPerSec.toFixed(0)} row changes/s · slot ${fmtLsn(s.replication.logicalSlotLsn)}`
        : 'idle — requires wal_level = logical',
  })

  /* =====================================================================
   * Runtime. Nothing below here allocates per frame except the throttled
   * label strings, which are rebuilt eight times a second at most.
   * ===================================================================*/

  let prevT = -1
  let prevSent = -1
  let prevReplay = -1
  let prevWrite = -1
  let link = 0 // 0..1 connected
  let dishFlash = 0
  let applyFlash = 0
  let beltOffset = 0
  let queueLevel = 0
  let sendAcc = 0
  let feedback = 0
  let scaleSpan = 4 * MB
  let textT = 0
  let subBeat = 0
  let fbAcc = 0
  const carLabelZ = new Float64Array(4)

  const BELT_LEN = BELT_Z1 - BELT_Z0

  /** Map an LSN onto the ruler. South end = the primary's flush position. */
  function rulerZ(lsn: number, ref: number): number {
    const behind = clamp((ref - lsn) / scaleSpan, 0, 1)
    return RULER_Z1 - behind * RULER_L
  }

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated dt — freezes when paused
    prevT = t
    const rep = sim.replication
    const wal = sim.wal
    const connected = rep.enabled && rep.connected
    link = damp(link, connected ? 1 : 0, 4, dt)

    /* --- 1. the wire ---------------------------------------------------- */

    if (prevSent < 0) prevSent = rep.sentLsn
    const dSent = rep.sentLsn - prevSent
    prevSent = rep.sentLsn

    // One packet per send, rate-limited so a huge WAL rate does not flood the
    // cable with more boxes than a person can follow.
    sendAcc += dts
    const flightDur = Math.max(0.1, (rep.networkLagMs * NET_STRETCH) / 1000)
    if (dSent > 0 && connected && sendAcc > flightDur / 5) {
      sendAcc = 0
      for (let i = 0; i < N_PKT; i++) {
        if (!pktOn[i]) {
          pktOn[i] = 1
          pktT[i] = 0
          pktDur[i] = flightDur
          break
        }
      }
    }

    let pktDirty = false
    for (let i = 0; i < N_PKT; i++) {
      if (!pktOn[i]) continue
      pktT[i] += dts / pktDur[i]
      if (pktT[i] >= 1 || !connected) {
        if (pktT[i] >= 1) dishFlash = 1
        pktOn[i] = 0
        hideInst(packets, i, wireMid.x, wireMid.y, wireMid.z)
        _c.setRGB(0, 0, 0)
        packets.setColorAt(i, _c)
        pktDirty = true
        continue
      }
      routePoint('net.stream', pktT[i], _p)
      routeTangent('net.stream', pktT[i], _p2).normalize()
      _q.setFromUnitVectors(_axisZ, _p2)
      setTRS(packets, i, _p.x, _p.y, _p.z, 1.15, 1.15, 3.0, _q)
      _c.setHex(COLOR.wal).multiplyScalar(1.9)
      packets.setColorAt(i, _c)
      pktDirty = true
    }
    if (pktDirty) {
      packets.instanceMatrix.needsUpdate = true
      packets.instanceColor!.needsUpdate = true
    }

    // Sheath. Bright with throughput while up; dark with a hole at the break
    // while down — the cable is still there, the signal is not.
    const thru = clamp01(wal.bytesPerSec / (3 * MB))
    for (let i = 0; i < N_SHEATH; i++) {
      const onStream = i < N_SHEATH_S
      const k = onStream ? (i + 0.5) / N_SHEATH_S : (i - N_SHEATH_S + 0.5) / N_SHEATH_A
      const near = 1 - clamp01(Math.abs(k - BREAK_T) * 9)
      // The return path is normally quiet acknowledgements. With
      // hot_standby_feedback it also carries the standby's xmin, which is a
      // vacuum-coloured thing to be sending your primary — so it turns violet.
      const glow = link * (0.16 + thru * 0.5) * (onStream ? 1 : 0.55 + feedback * 1.5)
      _c.setHex(onStream ? COLOR.replication : COLOR.ok)
      if (!onStream && feedback > 0.01) _c.lerp(_c2.setHex(COLOR.vacuum), feedback)
      _c.multiplyScalar(glow)
      if (link < 0.98 && near > 0) {
        // arc light at the break, and a dead zone either side of it
        const arc = (1 - link) * near * (0.5 + 0.5 * Math.sin(t * 31 + i))
        _c2.setHex(COLOR.crit).multiplyScalar(arc * 2.4)
        _c.multiplyScalar(1 - near).add(_c2)
      }
      sheath.setColorAt(i, _c)
    }
    sheath.instanceColor!.needsUpdate = true

    // Sparks only exist while the link is broken.
    const broken = 1 - link
    if (broken > 0.02) {
      for (let i = 0; i < N_SPARK; i++) {
        sparkPh[i] += dt * (2.2 + i * 0.31)
        if (sparkPh[i] > 1) sparkPh[i] -= 1
        const k = sparkPh[i]
        const d = 1.2 + k * 7
        setTRS(
          sparks, i,
          breakAt.x + sparkDir[i * 3] * d,
          breakAt.y + sparkDir[i * 3 + 1] * d + k * 1.4,
          breakAt.z + sparkDir[i * 3 + 2] * d,
          0.5, 0.5, 0.5,
        )
        _c.setHex(COLOR.crit).multiplyScalar(broken * 3.2 * (1 - k) * (1 - k))
        sparks.setColorAt(i, _c)
      }
    } else {
      for (let i = 0; i < N_SPARK; i++) hideInst(sparks, i, breakAt.x, breakAt.y, breakAt.z)
      _c.setRGB(0, 0, 0)
      for (let i = 0; i < N_SPARK; i++) sparks.setColorAt(i, _c)
    }
    sparks.instanceMatrix.needsUpdate = true
    sparks.instanceColor!.needsUpdate = true

    /* --- 2. walreceiver ------------------------------------------------- */

    dishFlash = Math.max(0, dishFlash - dt * 3.4)
    _c.setHex(COLOR.replication).multiplyScalar(link * (0.08 + dishFlash * 2.2))
    dishInnerMat.color.copy(_c)

    if (prevWrite < 0) prevWrite = rep.writeLsn
    const dWrite = rep.writeLsn - prevWrite
    prevWrite = rep.writeLsn
    if (dts > 0) recvRate = damp(recvRate, dWrite / dts, 2.5, dt)

    // Gauge A: arrived but not yet fsynced on the standby. Gauge B: durable.
    const unflushed = clamp01((rep.writeLsn - rep.flushLsn) / (2 * MB))
    const behindPrimary = clamp01((wal.flushLsn - rep.flushLsn) / Math.max(1, scaleSpan))
    const gwH = Math.max(0.06, unflushed * RG_H)
    setTRS(recvNeon, IX_GW, RX - 4, RG_Y0 + gwH / 2, RZ + 8.06, 4.2, gwH, 0.32)
    const gfH = Math.max(0.06, (1 - behindPrimary) * RG_H * link)
    setTRS(recvNeon, IX_GF, RX + 4, RG_Y0 + gfH / 2, RZ + 8.06, 4.2, gfH, 0.32)
    recvNeon.instanceMatrix.needsUpdate = true

    _c.setHex(COLOR.wal).multiplyScalar(0.4 + unflushed * 2.0)
    recvNeon.setColorAt(IX_GW, _c)
    _c.setHex(COLOR.ok).multiplyScalar(0.35 + link * 1.5)
    recvNeon.setColorAt(IX_GF, _c)
    _c.setHex(COLOR.replication).multiplyScalar(link * (0.2 + thru * 0.7))
    for (let i = 2; i < IX_BEACON; i++) recvNeon.setColorAt(i, _c)
    _c.setHex(connected ? COLOR.ok : COLOR.crit).multiplyScalar(0.4 + 0.6 * Math.max(0, Math.sin(t * 2.4)))
    recvNeon.setColorAt(IX_BEACON, _c)
    _c.setHex(COLOR.replication).multiplyScalar(link * 0.5)
    recvNeon.setColorAt(IX_BEACON + 1, _c)
    recvNeon.instanceColor!.needsUpdate = true

    // The standby's own segments fill and roll over as WAL arrives.
    {
      const segSize = wal.segmentSize
      const cur = Math.floor(rep.writeLsn / segSize)
      for (let i = 0; i < N_RSEG; i++) {
        const seg = cur - (N_RSEG - 1 - i)
        const fill = seg === cur ? (rep.writeLsn % segSize) / segSize : 1
        const h = Math.max(0.2, fill * 4.4)
        setTRS(recvSegs, i, RX + 20, 2.2 + h / 2, RZ - 9 + i * 6, 6.4, h, 3.6)
        _c.setHex(seg === cur ? COLOR.wal : COLOR.walDim).multiplyScalar(link * (seg === cur ? 1.2 : 0.5))
        recvSegs.setColorAt(i, _c)
      }
      recvSegs.instanceMatrix.needsUpdate = true
      recvSegs.instanceColor!.needsUpdate = true
    }

    /* --- 3. startup process --------------------------------------------- */

    if (prevReplay < 0) prevReplay = rep.replayLsn
    const dReplay = rep.replayLsn - prevReplay
    prevReplay = rep.replayLsn
    if (dts > 0) applyRate = damp(applyRate, dReplay / dts, 2.5, dt)
    if (dReplay > 0) applyFlash = 1
    applyFlash = Math.max(0, applyFlash - dt * 4.2)

    // Belt speed is the apply rate; the belt is the only way records move.
    const beltSpeed = clamp(applyRate / (2 * MB), 0.05, 3) * 9
    beltOffset = (beltOffset + dt * beltSpeed * (rep.applyActivity > 0.05 ? 1 : 0.08)) % 4
    const beltStep = BELT_LEN / N_BELT
    for (let i = 0; i < N_BELT; i++) {
      const z = BELT_Z0 + ((i * beltStep + beltOffset) % BELT_LEN)
      const gate = z > BELT_Z1 - 9 ? 0.55 : 1 // records single-file through the gate
      setTRS(belt, i, SX, BELT_Y + 0.55, z, 3.4 * gate, 0.9, 2.6)
      _c.setHex(COLOR.wal).multiplyScalar(0.35 + rep.applyActivity * 1.5)
      belt.setColorAt(i, _c)
    }
    belt.instanceMatrix.needsUpdate = true
    belt.instanceColor!.needsUpdate = true

    // The queue. This is the whole lesson: when the primary produces WAL
    // faster than one process applies it, the backlog is physical.
    const waiting = Math.max(0, rep.flushLsn - rep.replayLsn)
    queueLevel = damp(queueLevel, clamp01(waiting / (12 * MB)), 3, dt)
    const qN = Math.round(queueLevel * N_QUEUE)
    for (let i = 0; i < N_QUEUE; i++) {
      const on = i < qN
      _c.setHex(i > N_QUEUE * 0.66 ? COLOR.crit : COLOR.wal).multiplyScalar(on ? 0.7 + queueLevel * 1.1 : 0)
      queue.setColorAt(i, _c)
    }
    queue.instanceColor!.needsUpdate = true

    // The gate narrows when replay cannot keep up: the cap made visible.
    const slow = sim.knobs.replicaSlowApply ? 1 : 0
    const gateW = lerp(1, 0.42, slow)
    gateGroup.scale.set(gateW, 1, 1)
    gateGroup.position.x = SX * (1 - gateW)

    pressGroup.position.y = -1.5 * applyFlash * applyFlash
    _c.setHex(COLOR.bufDirty).multiplyScalar(0.25 + applyFlash * 1.9)
    pageMesh.setColorAt(0, _c)
    pageMesh.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.replication).multiplyScalar(0.15 + rep.applyActivity * 0.9)
    for (let i = 0; i < IX_APPLY_LAMP; i++) startNeon.setColorAt(i, _c)
    _c.setHex(queueLevel > 0.5 ? COLOR.crit : COLOR.ok).multiplyScalar(0.5 + applyFlash * 1.8)
    startNeon.setColorAt(IX_APPLY_LAMP, _c)
    _c.setHex(COLOR.warn).multiplyScalar(0.1 + queueLevel * 1.4)
    startNeon.setColorAt(IX_APPLY_LAMP + 1, _c)
    startNeon.setColorAt(IX_APPLY_LAMP + 2, _c)
    startNeon.instanceColor!.needsUpdate = true

    /* --- 4. the standby ------------------------------------------------- */

    // Replay pulls in every page a record touches: the standby's cache is
    // shaped by the primary's *writes*, plus whatever local reads add.
    const applyPages = (dReplay / 8192) * 0.25
    if (applyPages > 0) {
      const n = Math.min(6, Math.max(1, Math.round(applyPages)))
      for (let k = 0; k < n; k++) {
        const idx = (trng() * N_RTILE) | 0
        tileHeat[idx] = 1
      }
    }
    if (connected && trng() < dt * 6) tileRead[(trng() * N_RTILE) | 0] = 1

    for (let i = 0; i < N_RTILE; i++) {
      const h = tileHeat[i]
      const r = tileRead[i]
      if (h > 0) tileHeat[i] = Math.max(0, h - dt * 0.55)
      if (r > 0) tileRead[i] = Math.max(0, r - dt * 1.3)
      const rise = 0.4 + h * 2.0 + r * 0.6
      const col = i % RG
      const row = (i / RG) | 0
      setTRS(
        tiles, i,
        BX - R_HALF + col * RP, 3.2 + rise / 2, BZ - R_HALF + row * RP,
        TILE, rise, TILE,
      )
      // dirty red as replay writes it, cooling to the relation's own colour
      _c.setHex(TABLES[tileRel[i]].color).multiplyScalar(0.1 + 0.16 * link)
      if (h > 0) {
        _c2.setHex(COLOR.bufDirty).multiplyScalar(h * 1.7)
        _c.add(_c2)
      }
      if (r > 0) {
        _c2.setHex(COLOR.client).multiplyScalar(r * 1.5)
        _c.add(_c2)
      }
      tiles.setColorAt(i, _c)
    }
    tiles.instanceMatrix.needsUpdate = true
    tiles.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.storage).multiplyScalar(0.12 + rep.applyActivity * 0.5)
    storeNeon.setColorAt(0, _c)
    storeNeon.setColorAt(1, _c)
    _c.setHex(COLOR.storage).multiplyScalar(0.2 + applyFlash * 1.6)
    storeNeon.setColorAt(IX_SHAFT, _c)
    storeNeon.instanceColor!.needsUpdate = true

    for (let i = 0; i < N_RACK; i++) {
      const ph = (t * 0.35 + i * 0.17) % 1
      _c.setHex(COLOR.storage).multiplyScalar(0.18 + rep.applyActivity * (0.35 + 0.4 * Math.sin(ph * TAU)))
      rackMesh.setColorAt(i, _c)
    }
    rackMesh.instanceColor!.needsUpdate = true

    /* --- the ruler ------------------------------------------------------ */

    const ref = Math.max(wal.flushLsn, rep.sentLsn)
    const worst = Math.max(ref - rep.replayLsn, 64 * 1024)
    scaleSpan = damp(scaleSpan, Math.max(1.5 * MB, worst * 1.25), 1.2, dt)

    const zSent = rulerZ(rep.sentLsn, ref)
    const zWrite = rulerZ(rep.writeLsn, ref)
    const zFlush = rulerZ(rep.flushLsn, ref)
    const zReplay = rulerZ(rep.replayLsn, ref)
    _carZ[0] = zSent; _carZ[1] = zWrite; _carZ[2] = zFlush; _carZ[3] = zReplay; _carZ[4] = RULER_Z1
    for (let i = 0; i < 5; i++) {
      setTRS(carriages, i, RULER_X, RULER_Y - 0.2, _carZ[i], 2.6, 2.6, 1.0)
      _c.setHex(CAR_COLOR[i]).multiplyScalar(i === CAR_REPLAY ? 2.0 : 1.4)
      carriages.setColorAt(i, _c)
      // Relaying out a name costs a buffer upload, so only when it really moved.
      if (i < 4 && Math.abs(_carZ[i] - carLabelZ[i]) > 0.08) {
        carLabelZ[i] = _carZ[i]
        text.moveTo(carLabel[i], RULER_X - 1.6, RULER_Y + 2.4, _carZ[i])
      }
    }
    // The lag bar spans exactly the gap that matters: flushed vs replayed.
    const lagLen = Math.max(0.2, zFlush - zReplay)
    setTRS(carriages, CAR_LAG, RULER_X, RULER_Y - 2.0, (zFlush + zReplay) / 2, 0.9, 0.9, lagLen)
    const lagBad = clamp01(rep.lagBytes / (8 * MB))
    _c.setHex(COLOR.warn).lerp(_c2.setHex(COLOR.crit), lagBad).multiplyScalar(0.4 + lagBad * 1.8)
    carriages.setColorAt(CAR_LAG, _c)
    carriages.instanceMatrix.needsUpdate = true
    carriages.instanceColor!.needsUpdate = true

    /* --- 5. replica client + hot_standby_feedback ------------------------ */

    podGroup.rotation.y += dt * 0.22
    podRing.rotation.z += dt * 0.5
    _c.setHex(COLOR.client).multiplyScalar(0.5 + 0.3 * Math.sin(t * 1.7))
    ringMat.color.copy(_c)

    // No GUC for hot_standby_feedback in this model: the honest stand-in is a
    // long-running snapshot, which is exactly what the feedback message pins.
    const pinning = sim.knobs.longRunningXact && connected
    feedback = damp(feedback, pinning ? 1 : 0, 3, dt)

    _c.setHex(COLOR.client).multiplyScalar(link * (0.35 + 0.25 * Math.sin(t * 3)))
    clientNeon.setColorAt(0, _c)
    _c.setHex(COLOR.client).multiplyScalar(link * 0.55)
    clientNeon.setColorAt(IX_READBEAM, _c)
    _c.setHex(COLOR.vacuum).multiplyScalar(0.1 + feedback * (1.6 + 0.6 * Math.sin(t * 4)))
    clientNeon.setColorAt(IX_FBLAMP, _c)
    clientNeon.instanceColor!.needsUpdate = true

    // The feedback rides the return path: the standby's xmin goes *up* the
    // wire and stops the primary's vacuum removing rows it still needs.
    if (feedback > 0.4) {
      fbAcc += dts
      if (fbAcc > 0.8) {
        fbAcc = 0
        ctx.flow({ route: 'net.ack', count: 1, kind: 'ack', color: COLOR.vacuum, size: 1.3 })
      }
    }

    /* --- 6. subscriber --------------------------------------------------- */

    subBeat = damp(subBeat, rep.logicalEnabled ? 1 : 0, 3.5, dt)
    const changes = rep.logicalEnabled ? clamp01(rep.logicalChangesPerSec / 220) : 0
    for (let i = 0; i < N_BIN; i++) {
      const ph = (t * 1.3 + i * 0.31) % 1
      const flick = 0.3 + 0.7 * Math.abs(Math.sin(ph * Math.PI))
      const h = 0.4 + subBeat * changes * flick * 4.2
      setTRS(bins, i, UX - 5.6 + i * 2.8, 2.0 + h / 2, UZ + 7.6, 2.0, h, 0.4)
      _c.setHex(TABLES[i].color).multiplyScalar(subBeat * (0.2 + changes * 1.6 * flick))
      bins.setColorAt(i, _c)
    }
    bins.instanceMatrix.needsUpdate = true
    bins.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.toast).multiplyScalar(0.05 + subBeat * (0.3 + changes * 0.8))
    for (let i = 0; i < IX_SUBLAMP; i++) subNeon.setColorAt(i, _c)
    _c.setHex(COLOR.toast).multiplyScalar(subBeat * (0.4 + 0.6 * Math.max(0, Math.sin(t * 3.1))))
    subNeon.setColorAt(IX_SUBLAMP, _c)
    subNeon.instanceColor!.needsUpdate = true

    /* --- 7. live text, eight times a second ------------------------------ */

    // Colours that ride a formatted string are updated with it: a setColor
    // touches the whole colour buffer, so it does not belong in a hot loop.
    textT += dt
    if (textT >= 0.125) {
      textT = 0
      text.setColor(TX_WIRE, COLOR.crit, 0.08 + broken * (1.3 + 0.5 * Math.sin(t * 6)))
      text.setColor(TX_FEEDBACK, COLOR.vacuum, 0.06 + feedback * 1.1)
      text.setColor(TX_SUBOFF, COLOR.crit, 0.1 + (1 - subBeat) * 0.8)
      text.set(TX_LAT, `${rep.networkLagMs.toFixed(0)} ms · ${rep.inFlight} in flight`)
      text.set(TX_WRITE, fmtLsn(rep.writeLsn))
      text.set(TX_FLUSH, fmtLsn(rep.flushLsn))
      text.set(TX_APPLY, `${fmtBytes(applyRate)}/s`)
      text.set(TX_QUEUE, waiting > 64 * 1024 ? `${fmtBytes(waiting)} queued` : '')
      text.setColor(TX_QUEUE, queueLevel > 0.5 ? COLOR.crit : COLOR.warn, 0.6 + queueLevel * 0.9)
      text.set(TX_LAG, connected ? `lag ${fmtBytes(rep.lagBytes)}` : 'DISCONNECTED')
      text.setColor(TX_LAG, connected ? (lagBad > 0.6 ? COLOR.crit : COLOR.replication) : COLOR.crit, 1.1)
      text.set(TX_LAGB, connected ? `${rep.lagSec.toFixed(1)} s behind · apply ${fmtBytes(applyRate)}/s` : 'the wire is down')
      text.set(TX_SCALE, `scale: 0 … ${fmtBytes(scaleSpan)} behind`)
      _lsn[0] = rep.sentLsn; _lsn[1] = rep.writeLsn; _lsn[2] = rep.flushLsn; _lsn[3] = rep.replayLsn
      for (let i = 0; i < 4; i++) {
        const behind = Math.max(0, ref - _lsn[i])
        text.set(TX_ROW[i], `${CAR_NAME[i].padEnd(7)}${fmtLsn(_lsn[i])}  -${fmtBytes(behind)}`)
      }
      text.set(TX_LAGBAR, `replication lag = flush − replay = ${fmtBytes(rep.lagBytes)}`)
      text.set(
        TX_RCLIENT,
        connected ? `sees ${fmtLsn(rep.replayLsn)}` : 'stale — no replay',
      )
      text.set(
        TX_FEEDBACK,
        pinning ? 'hot_standby_feedback = on · pinning primary xmin' : '',
      )
      text.set(
        TX_SUB,
        rep.logicalEnabled ? `${rep.logicalChangesPerSec.toFixed(0)} row changes/s` : 'no subscription active',
      )
    }
  }

  /* =====================================================================
   * Level of detail.
   * ===================================================================*/

  function setDetail(level: 0 | 1 | 2): void {
    const near = level >= 1
    const close = level >= 2

    pylonDetail.visible = near
    ackLine.visible = near
    recvDetailMesh.visible = near
    feedHorn.visible = near
    recvSegCradles.visible = near
    recvSegs.visible = near
    startDetailMesh.visible = near
    gateMesh.visible = near
    pressGroup.visible = near
    deckDetailMesh.visible = near
    rulerTicks.visible = near
    podStruct.visible = near
    podRing.visible = near
    subDetailMesh.visible = near
    rackMesh.visible = near
    edgeLines.visible = near
    pylonStruct.visible = true
    // Small print costs nothing to skip when the whole district is 400 m away.
    text.mesh.visible = near
    text.material.opacity = close ? 1 : 0.8
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    text.dispose()
    for (const m of [
      sheath, packets, sparks, pylonStruct, pylonDetail,
      recvStruct, recvDetailMesh, feedHorn, recvSegCradles, recvSegs, recvNeon,
      startStruct, startDetailMesh, gateMesh, belt, queue, pressMesh, pageMesh, startNeon,
      deckStruct, deckDetailMesh, tiles, storeStruct, rackMesh, storeNeon,
      rulerStruct, rulerTicks, carriages,
      podStruct, clientNeon,
      subStruct, subDetailMesh, bins, subNeon,
    ]) {
      m.dispose()
    }
    group.clear()
  }

  // main.ts starts its LOD bucket at 0 and only calls setDetail on a change.
  setDetail(0)

  return { id: 'replication', group, update, setDetail, dispose }
}
