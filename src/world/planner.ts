import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_BACKEND_SLOTS } from '../core/types'
import type { BackendSim, PlanNode, SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, easeOutCubic, fmtNum } from '../core/util'
import { ANCHOR, CITY, backendPid, backendX } from './layout'
import { OPACITY_TIER } from './storage'

/* ============================================================================
 * THE QUERY LAB — what happens between "SELECT" and the first row.
 *
 * A translucent volume 66 m above the backend row, hidden until you select a
 * backend. Then it unfolds that one process's statement:
 *
 *   SQL ─▶ parse ─▶ rewrite ─▶ PLAN (three candidates, one price each)
 *                                   └─ cheapest wins ─▶ execute ─▶ plan tree
 *
 * The costing bay is the point of the district. Postgres does not "decide to
 * use the index": it prices every strategy it can think of from *statistics* —
 * how many live rows, how many pages, how selective the predicate looks — and
 * runs the cheapest estimate. Bad statistics, bad price, bad plan. So each
 * candidate carries its number on its face, the winner lights, and the
 * pg_statistic plate that fed all three sits directly above them.
 *
 * The tree on the right is the winner, running. Children hang below their
 * parent because that is how EXPLAIN prints it; rows climb *up* the struts
 * because that is how execution actually goes — a node pulls tuples from its
 * children, one at a time, and hands them to its parent.
 * ==========================================================================*/

/* --- module-scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _p2 = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _qi = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _axisY = new THREE.Vector3(0, 1, 0)

/** cx, cy, cz, w, h, d */
type BoxSpec = [number, number, number, number, number, number]

/* --- the lab's own grid ---------------------------------------------------- */
const LX = ANCHOR.planner[0] // 0
const LY = ANCHOR.planner[1] // 66
const LZ = ANCHOR.planner[2] // -130
/** Every graphic sits on one south-facing plane; the shell gives it depth. */
const PLANE_Z = LZ + 2
const SHELL_W = 140
const SHELL_H = 46
const SHELL_D = 30
const FLOOR_Y = LY - 21
const ROOF_Y = LY + 25

/** Pipeline stations, west → east. */
const ST_X = [-58, -40, -22, -4]
const ST_Y = FLOOR_Y + 7
/** Candidate cards, above the plan station. */
const CARD_X = [-52, -30, -8]
const CARD_Y = FLOOR_Y + 26
const CARD_W = 19
const CARD_H = 15
/** Plan tree bay, east of the divider. */
const TREE_CX = 36
const TREE_Y0 = FLOOR_Y + 9
const TREE_W = 60
const TREE_H = 31
const NODE_W = 13
const NODE_H = 3.6
const NODE_PITCH = 15
const NODE_VSTEP = 8.4
const MAX_NODES = 32

/* ==========================================================================
 * Builders (construction time only).
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
 * Park an instance: zero scale, and inside the lab. Sending it to y = -9000
 * would work visually but would blow up the object's world AABB, which is what
 * the picker measures to draw its selection reticle.
 */
function hideInst(mesh: THREE.InstancedMesh, i: number, x = TREE_CX, y = TREE_Y0, z = PLANE_Z): void {
  setTRS(mesh, i, x, y, z, 0.0001, 0.0001, 0.0001)
}

/* ==========================================================================
 * TEXT — one monospace glyph atlas, one draw call for the whole lab. A plan
 * tree is mostly words and numbers, and relaying them out has to cost a few
 * hundred floats, not a texture upload.
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

/** The atlas is ASCII; simulation strings are not. Fold the typography in. */
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

interface TextSlot {
  start: number
  cap: number
  size: number
  align: number
  x: number; y: number; z: number
  text: string
}

/** Every string in the lab faces south — the side the city looks from. */
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
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(LX, LY, LZ), 400)
    this.geometry = g

    this.tex = glyphAtlas()
    this.material = new THREE.MeshBasicMaterial({
      map: this.tex,
      alphaTest: 0.08,
      vertexColors: true,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 7
    this.mesh.raycast = () => {}
  }

  alloc(
    cap: number,
    x: number, y: number,
    size: number,
    color: number,
    align: 'left' | 'center' | 'right' = 'center',
    bright = 1,
    text = '',
    z = PLANE_Z,
  ): number {
    const id = this.slots.length
    this.slots.push({
      start: this.next,
      cap,
      size,
      align: align === 'left' ? -1 : align === 'right' ? 1 : 0,
      x, y, z,
      text: '',
    })
    this.next += cap
    this.setColor(id, color, bright)
    this.set(id, text)
    return id
  }

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
      const a0 = s.x + x0 + i * w
      const a1 = a0 + w
      // south-facing quad: +X right, +Y up, wound BL BR TR TL
      this.pos[q] = a0; this.pos[q + 1] = s.y - hh; this.pos[q + 2] = s.z
      this.pos[q + 3] = a1; this.pos[q + 4] = s.y - hh; this.pos[q + 5] = s.z
      this.pos[q + 6] = a1; this.pos[q + 7] = s.y + hh; this.pos[q + 8] = s.z
      this.pos[q + 9] = a0; this.pos[q + 10] = s.y + hh; this.pos[q + 11] = s.z
      const o = (s.start + i) * 8
      this.uv[o] = u0; this.uv[o + 1] = v0
      this.uv[o + 2] = u1; this.uv[o + 3] = v0
      this.uv[o + 4] = u1; this.uv[o + 5] = v1
      this.uv[o + 6] = u0; this.uv[o + 7] = v1
    }
    this.posAttr.needsUpdate = true
    this.uvAttr.needsUpdate = true
  }

  /** Move (and optionally resize) a slot — the tree relays out on rebuild. */
  place(id: number, x: number, y: number, size = this.slots[id].size): void {
    const s = this.slots[id]
    if (s.x === x && s.y === y && s.size === size) return
    s.x = x; s.y = y; s.size = size
    const t = s.text
    s.text = '\0'
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

  /** Freeze the buffer: draw only what was allocated, and stop the zeroed
   *  tail of the position attribute from dragging the AABB to the origin. */
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

/* --- reading a plan -------------------------------------------------------- */

/** 0 seq scan, 1 index scan, 2 bitmap heap scan, -1 nothing to choose. */
function strategyOf(n: PlanNode): number {
  const l = n.label
  let best = -1
  if (l.indexOf('Bitmap') >= 0) best = 2
  else if (l.indexOf('Index') >= 0) best = 1
  else if (l.indexOf('Seq Scan') >= 0) best = 0
  for (let i = 0; i < n.children.length; i++) {
    const c = strategyOf(n.children[i])
    if (c > best) best = c
  }
  return best
}

/** The row estimate the access method has to produce. */
function leafRows(n: PlanNode): number {
  let x = n
  let r = n.rows
  while (x.children.length > 0) {
    x = x.children[0]
    r = x.rows
  }
  return r
}

/* ==========================================================================
 * FACTORY
 * ========================================================================*/

export const createPlanner: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, bus, quality } = ctx
  const low = quality.level === 'low'

  const group = new THREE.Group()
  group.name = 'district:planner'
  group.visible = false

  const owned: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }

  // The lab shell is a conceptual space, not a building: `volume` is its one
  // semantic translucency. Everything nested inside is solid so the diagram
  // never stacks translucent cards against a translucent back wall.
  const matShell = theme.mat('planner.shell', {
    color: 0x212c44,
    roughness: 0.72,
    metalness: 0.26,
    emissive: 0x060912,
    transparent: true,
    opacity: OPACITY_TIER.volume,
  })
  // The shell has no translucent front wall and writes depth, so its sparse
  // floor/roof/posts cannot sort behind farther transparent districts.
  matShell.depthWrite = true
  const matBack = theme.mat('planner.back', {
    color: 0x10182a,
    roughness: 0.92,
    metalness: 0.06,
    emissive: 0x03050c,
    opacity: OPACITY_TIER.solid,
    side: THREE.DoubleSide,
  })
  const matCard = theme.mat('planner.card', {
    color: 0x18213a,
    roughness: 0.86,
    metalness: 0.1,
    emissive: 0x04060f,
    opacity: OPACITY_TIER.solid,
  })
  const lineMat = theme.line(COLOR.inkDim, OPACITY_TIER.solid)
  const neonWhite = theme.neon(0xffffff, 1)
  const unitBox = theme.box(1, 1, 1)

  const edgeVerts: number[] = []
  const text = new TextBank(3000)

  function batch(parent: THREE.Object3D, mat: THREE.Material, specs: readonly BoxSpec[], edge = false): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(unitBox, mat, Math.max(1, specs.length))
    for (let i = 0; i < specs.length; i++) setBox(mesh, i, specs[i])
    if (specs.length === 0) hideInst(mesh, 0)
    mesh.instanceMatrix.needsUpdate = true
    parent.add(mesh)
    if (edge) for (const s of specs) pushBoxEdges(edgeVerts, s)
    return mesh
  }

  function neonBatch(parent: THREE.Object3D, specs: readonly BoxSpec[]): THREE.InstancedMesh {
    const mesh = batch(parent, neonWhite, specs)
    _c.setRGB(0, 0, 0)
    for (let i = 0; i < mesh.count; i++) mesh.setColorAt(i, _c)
    mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    mesh.raycast = () => {}
    return mesh
  }

  /* =====================================================================
   * 1. THE SHELL.
   * ===================================================================*/

  const shell: BoxSpec[] = [
    [LX, FLOOR_Y - 0.6, LZ, SHELL_W, 1.2, SHELL_D], // floor
    [LX, ROOF_Y + 0.6, LZ, SHELL_W, 1.2, SHELL_D], // roof
    [LX - SHELL_W / 2, LY, LZ - SHELL_D / 2, 1.2, SHELL_H, 1.2], // corner posts
    [LX + SHELL_W / 2, LY, LZ - SHELL_D / 2, 1.2, SHELL_H, 1.2],
    [LX - SHELL_W / 2, LY, LZ + SHELL_D / 2, 1.2, SHELL_H, 1.2],
    [LX + SHELL_W / 2, LY, LZ + SHELL_D / 2, 1.2, SHELL_H, 1.2],
  ]
  const shellMesh = batch(group, matShell, shell, true)
  pushBoxEdges(edgeVerts, [LX, LY, LZ, SHELL_W, SHELL_H, SHELL_D])
  const serviceGrating = batch(group, matCard, [
    [LX, FLOOR_Y + 1.0, LZ, SHELL_W - 6, 0.4, SHELL_D - 6],
  ], true)

  /*
   * The lab hangs above collision.build()'s ordinary pedestrian ceiling, so
   * publish only the surfaces a dropped-in walker can actually meet. The front
   * and sides stay open; the floor, rear wall, and four corner posts do not.
   */
  group.userData.walkColliders = [
    new THREE.Box3(
      new THREE.Vector3(LX - SHELL_W / 2, FLOOR_Y - 1.2, LZ - SHELL_D / 2),
      new THREE.Vector3(LX + SHELL_W / 2, FLOOR_Y, LZ + SHELL_D / 2),
    ),
    new THREE.Box3(
      new THREE.Vector3(LX - SHELL_W / 2 + 0.6, FLOOR_Y - 1, LZ - SHELL_D / 2 - 0.1),
      new THREE.Vector3(LX + SHELL_W / 2 - 0.6, ROOF_Y - 1, LZ - SHELL_D / 2 + 1.1),
    ),
    ...([-1, 1] as const).flatMap((sx) =>
      ([-1, 1] as const).map(
        (sz) =>
          new THREE.Box3(
            new THREE.Vector3(
              LX + sx * (SHELL_W / 2) - 0.6,
              LY - SHELL_H / 2,
              LZ + sz * (SHELL_D / 2) - 0.6,
            ),
            new THREE.Vector3(
              LX + sx * (SHELL_W / 2) + 0.6,
              LY + SHELL_H / 2,
              LZ + sz * (SHELL_D / 2) + 0.6,
            ),
          ),
      ),
    ),
  ]

  // A back wall, so the diagram has something to read against.
  const wallGeo = own(new THREE.PlaneGeometry(SHELL_W - 2, SHELL_H - 2))
  const backWall = new THREE.Mesh(wallGeo, matBack)
  backWall.position.set(LX, LY, LZ - SHELL_D / 2 + 0.5)
  backWall.raycast = () => {}
  group.add(backWall)

  const shellNeon = neonBatch(group, [
    [LX, FLOOR_Y + 0.1, LZ, SHELL_W - 2, 0.16, SHELL_D - 2], // floor rim
    [LX, ROOF_Y - 0.1, LZ, SHELL_W - 2, 0.16, SHELL_D - 2], // roof rim
    [LX, FLOOR_Y + 13.8, PLANE_Z - 3, SHELL_W - 12, 0.1, 0.1], // register lines
    [LX, FLOOR_Y + 42.0, PLANE_Z - 3, SHELL_W - 12, 0.1, 0.1],
    [LX + 3, LY, PLANE_Z - 3, 0.1, SHELL_H - 10, 0.1], // decide | run divider
  ])

  /** The beam down to the process all this is about. */
  const tether = neonBatch(group, [[0, 0, 0, 0.5, 1, 0.5]])

  text.alloc(26, LX, ROOF_Y - 3.6, 2.4, COLOR.index, 'center', 1.15, 'THE QUERY LAB')
  const TX_SQL = text.alloc(76, LX, ROOF_Y - 7.4, 1.85, COLOR.ink, 'center', 1.1)
  const TX_WHO = text.alloc(58, LX, ROOF_Y - 10.0, 1.15, COLOR.inkDim, 'center', 0.9)

  /* =====================================================================
   * 2. THE PIPELINE — parse, rewrite, plan, execute.
   * ===================================================================*/

  const STAGE_NAME = ['parse', 'rewrite', 'plan', 'execute']
  const STAGE_SUB = ['text -> parse tree', 'views & rules expand', 'price every path', 'run the winner']
  const STAGE_ID = ['planner.parser', 'planner.rewriter', 'planner.planner', 'planner.executor']

  const stageGroups: THREE.Group[] = []
  const stageStruct: THREE.InstancedMesh[] = []
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group()
    g.name = STAGE_ID[i]
    group.add(g)
    stageGroups.push(g)
    const x = ST_X[i]
    stageStruct.push(batch(g, matCard, [
      [x, ST_Y, PLANE_Z - 0.9, 15, 9, 1.0], // station card
      [x, ST_Y - 5.2, PLANE_Z - 0.9, 16.4, 1.2, 1.6], // plinth
      [x, ST_Y + 5.0, PLANE_Z - 0.9, 16.4, 0.8, 1.6], // cornice
    ], true))
    text.alloc(12, x, ST_Y + 2.6, 1.6, COLOR.index, 'center', 1.1, STAGE_NAME[i])
    text.alloc(24, x, ST_Y + 0.5, 0.84, COLOR.inkDim, 'center', 0.85, STAGE_SUB[i])
    text.alloc(3, x - 6.4, ST_Y + 3.5, 1.0, COLOR.inkDim, 'left', 0.7, `${i + 1}`)
  }

  const stageLamps = neonBatch(group, [
    [ST_X[0], ST_Y - 2.7, PLANE_Z - 0.3, 11, 0.7, 0.4],
    [ST_X[1], ST_Y - 2.7, PLANE_Z - 0.3, 11, 0.7, 0.4],
    [ST_X[2], ST_Y - 2.7, PLANE_Z - 0.3, 11, 0.7, 0.4],
    [ST_X[3], ST_Y - 2.7, PLANE_Z - 0.3, 11, 0.7, 0.4],
    [(ST_X[0] + ST_X[3]) / 2, ST_Y - 6.6, PLANE_Z - 0.9, ST_X[3] - ST_X[0] + 16, 0.12, 0.12], // 4: the rail
    [0, 0, 0, 1.2, 1.2, 1.2], // 5: the statement itself, moving along it
  ])
  const IX_RAIL = 4
  const IX_TOKEN = 5

  const TX_EXEC = text.alloc(30, ST_X[3], ST_Y - 4.2, 0.9, COLOR.ok, 'center', 1.0)

  /* =====================================================================
   * 3. THE COSTING BAY — three candidates, one price each.
   * ===================================================================*/

  const gPlan = stageGroups[2] // the plan station owns the bay above it

  const statsPlate = batch(gPlan, matCard, [
    [(CARD_X[0] + CARD_X[2]) / 2, CARD_Y + 13.6, PLANE_Z - 0.9, 62, 8, 1.0],
  ], true)
  text.alloc(30, (CARD_X[0] + CARD_X[2]) / 2, CARD_Y + 15.8, 1.3, COLOR.index, 'center', 1.1, 'pg_statistic -> estimates')
  const TX_STATS = text.alloc(58, (CARD_X[0] + CARD_X[2]) / 2, CARD_Y + 13.3, 1.05, COLOR.ink, 'center', 0.95)
  const TX_STATS2 = text.alloc(58, (CARD_X[0] + CARD_X[2]) / 2, CARD_Y + 11.3, 0.92, COLOR.inkDim, 'center', 0.8)

  const cardStruct = batch(gPlan, matCard, [
    [CARD_X[0], CARD_Y, PLANE_Z - 0.9, CARD_W, CARD_H, 1.0],
    [CARD_X[1], CARD_Y, PLANE_Z - 0.9, CARD_W, CARD_H, 1.0],
    [CARD_X[2], CARD_Y, PLANE_Z - 0.9, CARD_W, CARD_H, 1.0],
  ], true)

  /* Per card: head rail, cost bar, foot rail, and the feed from the stats
   * plate above — because that is where the number came from. */
  const cardNeonSpecs: BoxSpec[] = []
  for (let i = 0; i < 3; i++) {
    cardNeonSpecs.push([CARD_X[i], CARD_Y + CARD_H / 2 - 0.1, PLANE_Z - 0.3, CARD_W - 1, 0.16, 0.4])
    cardNeonSpecs.push([CARD_X[i] - CARD_W / 2 + 2.6, CARD_Y - 3.5, PLANE_Z - 0.3, 2.2, 0.3, 0.4]) // bar
    cardNeonSpecs.push([CARD_X[i], CARD_Y - CARD_H / 2 + 0.1, PLANE_Z - 0.3, CARD_W - 1, 0.16, 0.4])
    cardNeonSpecs.push([CARD_X[i], CARD_Y + CARD_H / 2 + 4.3, PLANE_Z - 1.0, 0.28, 8.4, 0.28]) // stats feed
  }
  const cardNeon = neonBatch(gPlan, cardNeonSpecs)

  const TX_CARD: number[][] = []
  for (let i = 0; i < 3; i++) {
    TX_CARD.push([
      text.alloc(22, CARD_X[i], CARD_Y + 4.8, 1.25, COLOR.ink, 'center', 1.0), // strategy
      text.alloc(22, CARD_X[i], CARD_Y + 2.3, 1.5, COLOR.warn, 'center', 1.1), // cost
      text.alloc(24, CARD_X[i], CARD_Y + 0.2, 0.95, COLOR.inkDim, 'center', 0.85), // rows
      text.alloc(30, CARD_X[i], CARD_Y - 1.6, 0.8, COLOR.inkDim, 'center', 0.7), // why
      text.alloc(18, CARD_X[i], CARD_Y - 5.7, 1.1, COLOR.ok, 'center', 1.1), // verdict
    ])
  }

  text.alloc(50, (CARD_X[0] + CARD_X[2]) / 2, CARD_Y - CARD_H / 2 - 2.8, 1.2, COLOR.index, 'center', 1.0,
    'the cheapest ESTIMATE wins - estimates come from stats')

  /* =====================================================================
   * 4. THE PLAN TREE.
   * ===================================================================*/

  const gTree = new THREE.Group()
  gTree.name = 'planner.plantree'
  group.add(gTree)

  const treeFrame = batch(gTree, matCard, [
    [TREE_CX, TREE_Y0 + TREE_H / 2 + 1, PLANE_Z - 2.6, TREE_W + 8, TREE_H + 14, 0.6],
  ], true)

  const nodeBody = new THREE.InstancedMesh(unitBox, matCard, MAX_NODES)
  nodeBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  for (let i = 0; i < MAX_NODES; i++) hideInst(nodeBody, i)
  nodeBody.instanceMatrix.needsUpdate = true
  gTree.add(nodeBody)

  const nodeGlow = new THREE.InstancedMesh(unitBox, neonWhite, MAX_NODES)
  nodeGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < MAX_NODES; i++) {
    hideInst(nodeGlow, i)
    nodeGlow.setColorAt(i, _c)
  }
  nodeGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  nodeGlow.raycast = () => {}
  gTree.add(nodeGlow)

  const struts = new THREE.InstancedMesh(unitBox, neonWhite, MAX_NODES)
  struts.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  for (let i = 0; i < MAX_NODES; i++) {
    hideInst(struts, i)
    struts.setColorAt(i, _c)
  }
  struts.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  struts.raycast = () => {}
  gTree.add(struts)

  const N_TUPLE = low ? MAX_NODES : MAX_NODES * 2
  const tuples = new THREE.InstancedMesh(unitBox, neonWhite, N_TUPLE)
  tuples.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  for (let i = 0; i < N_TUPLE; i++) {
    hideInst(tuples, i)
    tuples.setColorAt(i, _c)
  }
  tuples.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  tuples.raycast = () => {}
  gTree.add(tuples)

  const TX_NODE_A: number[] = []
  const TX_NODE_B: number[] = []
  for (let i = 0; i < MAX_NODES; i++) {
    TX_NODE_A.push(text.alloc(26, 0, -400, 1.15, COLOR.ink, 'center', 1.0))
    TX_NODE_B.push(text.alloc(26, 0, -400, 0.9, COLOR.inkDim, 'center', 0.9))
  }

  text.alloc(26, TREE_CX, TREE_Y0 + TREE_H + 8.0, 1.5, COLOR.index, 'center', 1.05, 'the winning plan')
  text.alloc(40, TREE_CX, TREE_Y0 + TREE_H + 6.0, 0.95, COLOR.inkDim, 'center', 0.8, 'rows are pulled upward, one at a time')
  const TX_TREESUM = text.alloc(48, TREE_CX, TREE_Y0 - 3.4, 1.05, COLOR.ink, 'center', 0.95)
  const TX_NODEDETAIL = text.alloc(66, TREE_CX, TREE_Y0 - 5.6, 0.95, COLOR.index, 'center', 0.9)

  /* --- one blueprint pass, one text pass -------------------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineMat)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)
  text.finish(
    new THREE.Vector3(LX - SHELL_W / 2, FLOOR_Y - 8, LZ - SHELL_D / 2),
    new THREE.Vector3(LX + SHELL_W / 2, ROOF_Y + 2, LZ + SHELL_D / 2),
  )
  group.add(text.mesh)

  /* =====================================================================
   * Registration.
   * ===================================================================*/

  let sel = -1
  let nodeCount = 0
  const nodes: (PlanNode | null)[] = new Array(MAX_NODES).fill(null)
  const selBackend = (s: SimState): BackendSim | null => (sel >= 0 ? s.backends[sel] : null)

  /** Registered objects, so the label engine drops their labels with the lab. */
  const registeredObjects: THREE.Object3D[] = [group, gTree, ...stageGroups]

  ctx.register({
    id: 'planner.lab',
    name: 'the query lab',
    role: 'how one statement becomes a plan',
    kind: 'concept',
    district: 'planner',
    object: group,
    tier: 1,
    focus: { target: [LX, LY, LZ], distance: 178, dir: [0.08, 0.26, 0.96] },
    labelAt: [LX, ROOF_Y + 5, LZ],
    color: COLOR.index,
    readout: (s: SimState) => {
      const b = selBackend(s)
      if (!b) return 'select a backend to open it'
      return `backend ${b.slot} · ${b.state.replace(/_/g, ' ')}`
    },
  })

  ctx.register({
    id: 'planner.parser',
    name: 'parser',
    role: 'SQL text becomes a parse tree',
    kind: 'concept',
    district: 'planner',
    object: stageGroups[0],
    tier: 2,
    focus: { target: [ST_X[0], ST_Y, LZ], distance: 54, dir: [0.05, 0.22, 0.97] },
    labelAt: [ST_X[0], ST_Y + 7.5, PLANE_Z],
    color: COLOR.index,
    readout: (s: SimState) =>
      selBackend(s)?.state === 'parse' ? 'parsing…' : 'syntax only — no catalogue lookups yet',
  })

  ctx.register({
    id: 'planner.rewriter',
    name: 'rewriter',
    role: 'views and rules expand the tree',
    kind: 'concept',
    district: 'planner',
    object: stageGroups[1],
    tier: 2,
    focus: { target: [ST_X[1], ST_Y, LZ], distance: 54, dir: [0.05, 0.22, 0.97] },
    labelAt: [ST_X[1], ST_Y + 7.5, PLANE_Z],
    color: COLOR.index,
    readout: () => 'a view is a rewrite rule, not a table',
  })

  ctx.register({
    id: 'planner.planner',
    name: 'planner',
    role: 'prices every path and takes the cheapest',
    kind: 'concept',
    district: 'planner',
    object: stageGroups[2],
    tier: 1,
    focus: { target: [(CARD_X[0] + CARD_X[2]) / 2, CARD_Y + 3, LZ], distance: 96, dir: [0.05, 0.2, 0.98] },
    labelAt: [(CARD_X[0] + CARD_X[2]) / 2, CARD_Y + CARD_H / 2 + 13, PLANE_Z],
    color: COLOR.index,
    readout: (s: SimState) => {
      const b = selBackend(s)
      if (!b || !b.plan) return 'no statement in flight'
      return `chose ${b.plan.label} · estimated cost ${b.plan.cost.toFixed(2)}`
    },
  })

  ctx.register({
    id: 'planner.executor',
    name: 'executor',
    role: 'runs the winning plan, pulling rows',
    kind: 'concept',
    district: 'planner',
    object: stageGroups[3],
    tier: 2,
    focus: { target: [ST_X[3], ST_Y, LZ], distance: 54, dir: [0.05, 0.22, 0.97] },
    labelAt: [ST_X[3], ST_Y + 7.5, PLANE_Z],
    color: COLOR.ok,
    readout: (s: SimState) => {
      const b = selBackend(s)
      if (!b) return 'idle'
      return `${fmtNum(b.rowsSent)} rows · ${b.buffersHit} hit / ${b.buffersRead} read`
    },
  })

  ctx.register({
    id: 'planner.plantree',
    name: 'plan tree',
    role: 'the plan as the executor walks it',
    kind: 'concept',
    district: 'planner',
    object: gTree,
    tier: 1,
    focus: { target: [TREE_CX, TREE_Y0 + TREE_H / 2, LZ], distance: 92, dir: [0.06, 0.18, 0.98] },
    labelAt: [TREE_CX, TREE_Y0 + TREE_H + 11, PLANE_Z],
    color: COLOR.index,
    readout: (s: SimState) => {
      const b = selBackend(s)
      if (!b || !b.plan) return 'no plan'
      return `${nodeCount} node${nodeCount === 1 ? '' : 's'} · ${fmtNum(b.plan.rows)} rows est · cost ${b.plan.cost.toFixed(2)}`
    },
  })

  /* =====================================================================
   * Selection. The lab exists only while a backend is being watched.
   * ===================================================================*/

  type Mode = 'none' | 'auto' | 'pinned'
  let mode: Mode = 'none'
  let autoT = 0

  function onTarget(id: string | null): void {
    if (!id) {
      mode = 'none'
      sel = -1
      return
    }
    if (id.indexOf('backend.') === 0) {
      const n = Number(id.slice(8))
      if (Number.isInteger(n) && n >= 0 && n < N_BACKEND_SLOTS) {
        mode = 'pinned'
        sel = n
      } else {
        // backend.row / backend.localmem: follow whoever is busiest
        mode = 'auto'
        autoT = 99
      }
      return
    }
    // Selecting the lab (or the tour focusing it) must not close it.
    if (id.indexOf('planner') === 0) {
      if (mode === 'none') {
        mode = 'auto'
        autoT = 99
      }
      return
    }
    mode = 'none'
    sel = -1
  }

  const offSelect = bus.on('select', (e) => onTarget(e.id))
  const offFocus = bus.on('focus', (e) => {
    if (e.id) onTarget(e.id)
  })

  /** Pick the most interesting live statement. */
  function pickAuto(s: SimState): number {
    let best = -1
    let bestScore = -1
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = s.backends[i]
      if (!b.active) continue
      let sc = b.plan ? 3 : 0
      const st = b.state
      if (st === 'exec_cpu' || st === 'exec_io' || st === 'sort') sc += 2
      else if (st === 'plan' || st === 'parse') sc += 1.5
      else if (st === 'idle') sc -= 1
      sc += b.progress * 0.2
      if (sc > bestScore) {
        bestScore = sc
        best = i
      }
    }
    return best
  }

  /* =====================================================================
   * Tidy-tree layout. Runs only when the plan object identity changes.
   * ===================================================================*/

  const nodeDepth = new Int32Array(MAX_NODES)
  const nodeParent = new Int32Array(MAX_NODES)
  const nodeLX = new Float32Array(MAX_NODES)
  const nodeWX = new Float32Array(MAX_NODES)
  const nodeWY = new Float32Array(MAX_NODES)
  let treeScale = 1
  let leafCursor = 0
  let maxDepth = 0

  function walkLayout(n: PlanNode, depth: number, parent: number): number {
    if (nodeCount >= MAX_NODES) return -1
    const i = nodeCount++
    nodes[i] = n
    nodeDepth[i] = depth
    nodeParent[i] = parent
    if (depth > maxDepth) maxDepth = depth
    let sum = 0
    let cnt = 0
    for (let k = 0; k < n.children.length; k++) {
      const c = walkLayout(n.children[k], depth + 1, i)
      if (c >= 0) {
        sum += nodeLX[c]
        cnt++
      }
    }
    // leaves take the next slot; a parent centres over the children it got
    nodeLX[i] = cnt > 0 ? sum / cnt : leafCursor++ * NODE_PITCH
    return i
  }

  function rebuildTree(plan: PlanNode | null): void {
    nodeCount = 0
    leafCursor = 0
    maxDepth = 0
    if (plan) walkLayout(plan, 0, -1)

    let minX = 0
    let maxX = 0
    for (let i = 0; i < nodeCount; i++) {
      if (i === 0 || nodeLX[i] < minX) minX = nodeLX[i]
      if (i === 0 || nodeLX[i] > maxX) maxX = nodeLX[i]
    }
    // Real plans never need shrinking; a pathological one must not spill out.
    const natW = maxX - minX + NODE_W
    const natH = maxDepth * NODE_VSTEP + NODE_H
    treeScale = clamp(Math.min(TREE_W / natW, TREE_H / Math.max(natH, 1)), 0.45, 1)
    const cx = (minX + maxX) / 2

    for (let i = 0; i < MAX_NODES; i++) {
      if (i >= nodeCount) {
        hideInst(nodeBody, i)
        hideInst(nodeGlow, i)
        hideInst(struts, i)
        text.set(TX_NODE_A[i], '')
        text.set(TX_NODE_B[i], '')
        continue
      }
      const n = nodes[i]!
      const w = NODE_W * treeScale
      const h = NODE_H * treeScale
      const wx = TREE_CX + (nodeLX[i] - cx) * treeScale
      const wy = TREE_Y0 + (maxDepth - nodeDepth[i]) * NODE_VSTEP * treeScale
      nodeWX[i] = wx
      nodeWY[i] = wy
      setBox(nodeBody, i, [wx, wy, PLANE_Z - 1.2, w, h, 0.8])
      setBox(nodeGlow, i, [wx, wy - h / 2 + 0.2, PLANE_Z - 0.6, w - 0.8, 0.3, 0.5])

      const p = nodeParent[i]
      if (p >= 0) {
        _p.set(wx, wy + h / 2, PLANE_Z - 1.2)
        _p2.set(nodeWX[p], nodeWY[p] - h / 2, PLANE_Z - 1.2)
        _dir.subVectors(_p2, _p)
        const len = Math.max(0.2, _dir.length())
        _dir.normalize()
        _q.setFromUnitVectors(_axisY, _dir)
        setTRS(struts, i, (_p.x + _p2.x) / 2, (_p.y + _p2.y) / 2, PLANE_Z - 1.2, 0.26, len, 0.26, _q)
      } else {
        hideInst(struts, i)
      }

      text.place(TX_NODE_A[i], wx, wy + 0.72 * treeScale, 1.15 * treeScale)
      text.place(TX_NODE_B[i], wx, wy - 0.86 * treeScale, 0.9 * treeScale)
      text.set(TX_NODE_A[i], n.label)
      text.set(TX_NODE_B[i], `rows=${fmtNum(n.rows)} cost=${n.cost.toFixed(2)}`)
    }
    nodeBody.instanceMatrix.needsUpdate = true
    nodeGlow.instanceMatrix.needsUpdate = true
    struts.instanceMatrix.needsUpdate = true
  }

  /* =====================================================================
   * The costing bay: three priced candidates for the same statement.
   * ===================================================================*/

  const CAND_NAME = ['Seq Scan', 'Index Scan', 'Bitmap Heap Scan']
  const CAND_WHY = [
    'read every page, filter',
    'walk the btree, fetch rows',
    'block bitmap, one pass',
  ]
  const candCost = new Float64Array(3)
  let candRows = 1
  let candWinner = -1
  let costT = 0

  function rebuildCandidates(s: SimState, b: BackendSim): void {
    const plan = b.plan
    const tbl = s.tables[b.table]
    const rows = plan ? Math.max(1, leafRows(plan)) : 1
    const win = plan ? strategyOf(plan) : -1
    candRows = rows
    candWinner = win

    // The same arithmetic the model costs with — pages, live rows, row count —
    // so the numbers on the cards and the numbers in the tree agree.
    candCost[0] = tbl.pages * 1.0 + tbl.liveTuples * 0.01
    candCost[1] = 0.42 + rows * 0.25
    candCost[2] = 22.2 + rows * 0.32
    if (plan && win >= 0) {
      // The winner is what actually ran, so it must also be the cheapest number
      // on the board — otherwise the picture would contradict the plan.
      candCost[win] = Math.min(candCost[win], plan.cost)
      for (let i = 0; i < 3; i++) {
        if (i !== win && candCost[i] <= candCost[win]) candCost[i] = candCost[win] * (1.6 + i * 0.9)
      }
    }
    costT = 0

    for (let i = 0; i < 3; i++) {
      const off = win < 0
      text.set(TX_CARD[i][0], off ? '' : CAND_NAME[i])
      text.set(TX_CARD[i][1], off ? '' : `cost ${candCost[i] < 10000 ? candCost[i].toFixed(2) : fmtNum(candCost[i])}`)
      text.set(TX_CARD[i][2], off ? '' : `rows ${fmtNum(candRows)}`)
      text.set(TX_CARD[i][3], off ? '' : CAND_WHY[i])
      text.set(TX_CARD[i][4], '')
    }
    text.set(TX_STATS, `${tbl.def.name}: ${fmtNum(tbl.liveTuples)} live rows in ${fmtNum(tbl.pages)} pages`)
    text.set(
      TX_STATS2,
      win < 0
        ? 'this statement writes rows - there is no access path to choose'
        : `${fmtNum(tbl.deadTuples)} dead rows - stale stats here would misprice every card`,
    )
  }

  function clearCandidates(): void {
    for (let i = 0; i < 3; i++) for (let k = 0; k < 5; k++) text.set(TX_CARD[i][k], '')
    text.set(TX_STATS, '')
    text.set(TX_STATS2, '')
    candWinner = -1
  }

  /* =====================================================================
   * Runtime.
   * ===================================================================*/

  let vis = 0
  let planRef: PlanNode | null = null
  let tokenX = ST_X[0]
  let detailNode = -1
  let textT = 0
  const tupleT = new Float32Array(N_TUPLE)
  for (let i = 0; i < N_TUPLE; i++) tupleT[i] = i / N_TUPLE

  function applyVis(v: number): void {
    const on = v > 0.004
    group.visible = on
    for (let i = 0; i < registeredObjects.length; i++) registeredObjects[i].visible = on
  }

  /** Which station is lit for this backend right now. */
  function stageActive(b: BackendSim | null, i: number): boolean {
    if (!b) return false
    const st = b.state
    switch (i) {
      case 0:
        return st === 'parse'
      // The rewriter has no state of its own in the model: it happens between
      // parse analysis and planning, so it lights on the tail of parse.
      case 1:
        return st === 'parse' && b.progress > 0.5
      case 2:
        return st === 'plan'
      default:
        return (
          st === 'exec_cpu' || st === 'exec_io' || st === 'sort' ||
          st === 'wal_insert' || st === 'commit_wait' || st === 'sending'
        )
    }
  }

  function update(dt: number, sim: SimState, t: number): void {
    /* --- who are we watching? ------------------------------------------- */
    if (mode === 'auto') {
      autoT += dt
      const cur = sel >= 0 ? sim.backends[sel] : null
      const stale = !cur || !cur.active || (!cur.plan && cur.state !== 'plan' && cur.state !== 'parse')
      if (autoT > 0.5 && stale) {
        autoT = 0
        const next = pickAuto(sim)
        if (next >= 0) sel = next
      }
    }

    const want = mode === 'none' ? 0 : 1
    vis = damp(vis, want, 6, dt)
    if (want === 0 && vis < 0.004) {
      if (group.visible) applyVis(0) // fully dissolved: costs nothing from here
      return
    }
    applyVis(vis)

    const b = sel >= 0 ? sim.backends[sel] : null

    /* --- plan identity: rebuild only when the object changes -------------- */
    const plan = b ? b.plan : null
    if (plan !== planRef) {
      planRef = plan
      rebuildTree(plan)
      if (plan && b) rebuildCandidates(sim, b)
      else clearCandidates()
      detailNode = -1
    }

    /* --- 1. the pipeline -------------------------------------------------- */
    let tokenTarget = ST_X[0]
    for (let i = 0; i < 4; i++) {
      const on = stageActive(b, i)
      if (on) tokenTarget = ST_X[i]
      _c.setHex(i === 3 ? COLOR.ok : COLOR.index).multiplyScalar(on ? 1.5 + 0.5 * Math.sin(t * 9) : 0.16)
      stageLamps.setColorAt(i, _c)
    }
    // A plan that already exists means planning is done, whatever the state.
    if (b && b.plan && b.state !== 'plan' && !stageActive(b, 3)) tokenTarget = ST_X[3]
    tokenX = damp(tokenX, tokenTarget, 7, dt)
    setTRS(stageLamps, IX_TOKEN, tokenX, ST_Y - 6.6, PLANE_Z - 0.7, 1.6, 1.6, 1.6)
    _c.setHex(COLOR.client).multiplyScalar(2.0)
    stageLamps.setColorAt(IX_TOKEN, _c)
    _c.setHex(COLOR.inkDim).multiplyScalar(0.35)
    stageLamps.setColorAt(IX_RAIL, _c)
    stageLamps.instanceMatrix.needsUpdate = true
    stageLamps.instanceColor!.needsUpdate = true

    /* --- 2. the costing bay ----------------------------------------------- */
    costT = Math.min(1, costT + dt / 0.75)
    const priced = plan !== null && candWinner >= 0
    const maxCost = Math.max(candCost[0], candCost[1], candCost[2], 1)
    const locked = costT > 0.72
    for (let i = 0; i < 3; i++) {
      const grow = easeOutCubic(clamp01(costT * 2.4 - i * 0.45))
      // log scale: a seq scan can be a thousand times a lookup, and both must fit
      const frac = priced ? clamp01(Math.log10(1 + candCost[i]) / Math.log10(1 + maxCost)) : 0
      const barH = Math.max(0.08, frac * (CARD_H - 8) * grow)
      const isWin = priced && i === candWinner
      setTRS(
        cardNeon, i * 4 + 1,
        CARD_X[i] - CARD_W / 2 + 2.6, CARD_Y - CARD_H / 2 + 2.2 + barH / 2, PLANE_Z - 0.3,
        2.2, barH, 0.4,
      )
      const pulse = isWin && locked ? 0.4 + 0.25 * Math.sin(t * 4) : 0
      _c.setHex(isWin ? COLOR.ok : COLOR.warn).multiplyScalar(isWin ? 1.5 + pulse : 0.6)
      cardNeon.setColorAt(i * 4 + 1, _c)
      _c.setHex(isWin ? COLOR.ok : COLOR.inkDim).multiplyScalar(isWin ? 1.0 + pulse : 0.22)
      cardNeon.setColorAt(i * 4, _c)
      cardNeon.setColorAt(i * 4 + 2, _c)
      // the statistics feed: the numbers arriving from the plate above
      const feed = priced ? clamp01(1.4 - Math.abs(costT * 2.2 - 0.5 - i * 0.35)) : 0
      _c.setHex(COLOR.index).multiplyScalar(0.1 + feed * 1.5)
      cardNeon.setColorAt(i * 4 + 3, _c)
    }
    cardNeon.instanceMatrix.needsUpdate = true
    cardNeon.instanceColor!.needsUpdate = true

    /* --- 3. the tree ------------------------------------------------------ */
    let hot = -1
    let hotA = 0.25
    for (let i = 0; i < nodeCount; i++) {
      const a = clamp01(nodes[i]!.activity)
      if (a > hotA) {
        hotA = a
        hot = i
      }
      _c.setHex(a > 0.2 ? COLOR.index : COLOR.inkDim).multiplyScalar(0.18 + a * 2.0)
      nodeGlow.setColorAt(i, _c)
      if (nodeParent[i] >= 0) {
        _c.setHex(COLOR.index).multiplyScalar(0.12 + a * 1.3)
        struts.setColorAt(i, _c)
      }
    }
    nodeGlow.instanceColor!.needsUpdate = true
    struts.instanceColor!.needsUpdate = true

    // Rows climbing the struts: one tuple per edge, speed follows activity.
    let ti = 0
    for (let i = 0; i < nodeCount && ti < N_TUPLE; i++) {
      const p = nodeParent[i]
      if (p < 0) continue
      const a = clamp01(nodes[i]!.activity)
      tupleT[ti] = (tupleT[ti] + dt * (0.25 + a * 1.9)) % 1
      const k = tupleT[ti]
      const h = NODE_H * treeScale * 0.5
      const x = nodeWX[i] + (nodeWX[p] - nodeWX[i]) * k
      const y = nodeWY[i] + h + (nodeWY[p] - h - nodeWY[i] - h) * k
      setTRS(tuples, ti, x, y, PLANE_Z - 0.95, 0.75, 0.75, 0.75)
      _c.setHex(COLOR.ok).multiplyScalar(0.15 + a * 2.2)
      tuples.setColorAt(ti, _c)
      ti++
    }
    for (let i = ti; i < N_TUPLE; i++) hideInst(tuples, i)
    tuples.instanceMatrix.needsUpdate = true
    tuples.instanceColor!.needsUpdate = true

    /* --- 4. shell + the tether down to the process ------------------------ */
    _c.setHex(COLOR.index).multiplyScalar(0.35)
    shellNeon.setColorAt(0, _c)
    shellNeon.setColorAt(1, _c)
    _c.setHex(COLOR.inkDim).multiplyScalar(0.22)
    shellNeon.setColorAt(2, _c)
    shellNeon.setColorAt(3, _c)
    shellNeon.setColorAt(4, _c)
    shellNeon.instanceColor!.needsUpdate = true

    if (b) {
      const bx = backendX(b.slot)
      _p.set(bx, CITY.backend.maxH, CITY.backend.z)
      _p2.set(clamp(bx, -SHELL_W / 2 + 6, SHELL_W / 2 - 6), FLOOR_Y - 1.4, LZ)
      _dir.subVectors(_p2, _p)
      const len = Math.max(0.5, _dir.length())
      _dir.normalize()
      _q.setFromUnitVectors(_axisY, _dir)
      setTRS(
        tether, 0,
        (_p.x + _p2.x) / 2, (_p.y + _p2.y) / 2, (_p.z + _p2.z) / 2,
        0.35, len, 0.35, _q,
      )
      _c.setHex(COLOR.backend).multiplyScalar(0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * 2.6)))
      tether.setColorAt(0, _c)
    } else {
      hideInst(tether, 0, LX, FLOOR_Y, LZ)
      _c.setRGB(0, 0, 0)
      tether.setColorAt(0, _c)
    }
    tether.instanceMatrix.needsUpdate = true
    tether.instanceColor!.needsUpdate = true

    /* --- 5. live text, eight times a second ------------------------------- */
    textT += dt
    if (textT >= 0.125) {
      textT = 0
      text.set(TX_SQL, b ? (b.sql || '(idle - no statement in flight)') : '')
      text.set(TX_WHO, b ? `backend ${b.slot} | pid ${backendPid(b.slot)} | ${b.state.replace(/_/g, ' ')}` : '')
      text.set(TX_EXEC, b ? `${fmtNum(b.rowsSent)} rows returned` : '')
      for (let i = 0; i < 3; i++) {
        const isWin = priced && i === candWinner
        text.set(
          TX_CARD[i][4],
          !priced || !locked ? '' : isWin ? 'CHOSEN' : `${(candCost[i] / Math.max(0.01, candCost[candWinner])).toFixed(1)}x dearer`,
        )
        text.setColor(TX_CARD[i][4], isWin ? COLOR.ok : COLOR.crit, isWin ? 1.2 : 0.55)
        text.setColor(TX_CARD[i][1], isWin ? COLOR.ok : COLOR.warn, isWin ? 1.25 : 0.75)
        text.setColor(TX_CARD[i][0], isWin ? COLOR.ink : COLOR.inkDim, isWin ? 1.1 : 0.65)
      }
      for (let i = 0; i < nodeCount; i++) {
        const a = clamp01(nodes[i]!.activity)
        text.setColor(TX_NODE_A[i], a > 0.2 ? COLOR.ink : COLOR.inkDim, 0.72 + a * 0.6)
      }
      if (hot !== detailNode) {
        detailNode = hot
        text.set(TX_NODEDETAIL, hot >= 0 ? nodes[hot]!.detail : '')
      }
      text.set(
        TX_TREESUM,
        plan
          ? `${nodeCount} nodes | total cost ${plan.cost.toFixed(2)} | ${fmtNum(plan.rows)} rows estimated`
          : b
            ? 'waiting for a statement'
            : '',
      )
    }
  }

  /* =====================================================================
   * Level of detail. The lab is 66 m up: from far away the small print is
   * illegible anyway, so it stops being drawn.
   * ===================================================================*/

  function setDetail(level: 0 | 1 | 2): void {
    const near = level >= 1
    edgeLines.visible = near
    tuples.visible = near
    statsPlate.visible = near
    backWall.visible = near
    text.mesh.visible = near
  }

  function dispose(): void {
    offSelect()
    offFocus()
    for (const o of owned) o.dispose()
    owned.length = 0
    text.dispose()
    for (const m of [
      shellMesh, serviceGrating, shellNeon, tether, stageLamps, statsPlate, cardStruct, cardNeon,
      treeFrame, nodeBody, nodeGlow, struts, tuples,
      ...stageStruct,
    ]) {
      m.dispose()
    }
    group.clear()
  }

  setDetail(0)
  applyVis(0)

  return { id: 'planner', group, update, setDetail, dispose }
}
