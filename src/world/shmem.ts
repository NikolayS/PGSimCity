import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { BUF_GRID, N_BACKEND_SLOTS } from '../core/types'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, fmtBytes, fmtLsn, fmtNum, fmtPct, makeRng } from '../core/util'
import { ANCHOR, CITY, TABLES, bufferTilePos } from './layout'

/* ============================================================================
 * THE SHARED MEMORY PLAZA
 *
 * One mmap'd segment, mapped into every backend. Everything else in the city
 * exists to feed it or to drain it.
 *
 * The deck is cantilevered over the excavation on pylons that plunge to the
 * data files at y = -52: shared memory literally floats above storage, and
 * every page you see on the deck came up one of those columns.
 *
 * Contents (all coordinates from layout.ts, never re-derived):
 *   shared.buffers  1024 page frames, one InstancedMesh, true state per frame
 *   wal.buffers     the circular WAL insert ring
 *   proc.array      PGPROC slots + the xmin horizon blade
 *   lock.manager    16 lock partitions and their wait-for edges
 *   clog.slru       pg_xact commit bits in an SLRU cache
 *   stats.shmem     cumulative statistics, as a 3D sparkline
 *   buf.mapping     the (relation, block) → buffer hash table
 * ==========================================================================*/

/* ---------------------------------------------------------------- constants */

const G = CITY.buf.grid
const N = G * G
const PITCH = CITY.buf.pitch
const TILE = CITY.buf.tile
const BASE_Y = CITY.buf.baseY
const MAX_RISE = CITY.buf.maxRise
const HALF_GRID = ((G - 1) * PITCH) / 2
const GRID_SPAN = (G - 1) * PITCH + TILE

const DECK_W = CITY.deck.w
const DECK_D = CITY.deck.d
const DECK_TOP = CITY.deck.top
const DECK_BOT = CITY.deck.top - CITY.deck.thickness
/** Everything that stands on the deck sits on a 0.7 plinth. */
const MOUNT_Y = DECK_TOP + 0.7

const TAU = Math.PI * 2
/** How many tiles behind the clock hand still show its trail. */
const SWEEP_TRAIL = 26
/** Visible xid range on the ProcArray height axis. Beyond this the blade bottoms out. */
const XID_SPAN = 600
const PROC_H = 13.5
/** Transactions per visible SLRU slab. Real pg_xact packs 32768 xids into an 8kB page. */
const CLOG_XIDS_PER_SLAB = 1024
const CLOG_SLABS = 12
const CLOG_BITS = 64
const LOCK_PARTS = 16
const MAP_BUCKETS = 32
const STAT_BARS = 60
const MAX_LOCK_BEAMS = 8
const LOCK_BEAM_SEGS = 12
const MAX_MAP_BEAMS = 8

/* ------------------------------------------------------------ scratch state
 * Nothing in update() may allocate. Everything transient lives here. */

const _v = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3(1, 1, 1)
const _quat = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _col = new THREE.Color()
const _axisY = new THREE.Vector3(0, 1, 0)

const SIN = new Float32Array(256)
for (let i = 0; i < 256; i++) SIN[i] = Math.sin((i / 256) * TAU)

/** Linear-space rgb triples, precomputed once (Color converts sRGB → linear). */
function lin(hex: number, scale = 1, out = new Float32Array(3)): Float32Array {
  _col.setHex(hex)
  out[0] = _col.r * scale
  out[1] = _col.g * scale
  out[2] = _col.b * scale
  return out
}

const L_FREE = lin(COLOR.bufFree)
const L_CLEAN = lin(COLOR.bufClean)
const L_DIRTY = lin(COLOR.bufDirty)
const L_PINNED = lin(COLOR.bufPinned)
const L_WARN = lin(COLOR.warn)
const L_WAL = lin(COLOR.wal)
const L_WALDIM = lin(COLOR.walDim)
const L_CRIT = lin(COLOR.crit)
const L_OK = lin(COLOR.ok)
const L_SHMEM = lin(COLOR.shmem)
const L_BACKEND = lin(COLOR.backend)
const L_LOCK = lin(COLOR.lock)
const L_INDEX = lin(COLOR.index)
const L_VACUUM = lin(COLOR.vacuum)
const L_INK = lin(COLOR.ink)
/** Per-relation tint, so you can see which table owns which part of the cache. */
const L_TABLE = new Float32Array(TABLES.length * 3)
for (let i = 0; i < TABLES.length; i++) {
  _col.setHex(TABLES[i].color)
  L_TABLE[i * 3] = _col.r
  L_TABLE[i * 3 + 1] = _col.g
  L_TABLE[i * 3 + 2] = _col.b
}

/* --------------------------------------------------------------- utilities */

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
  m.instanceColor.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  m.castShadow = false
  m.receiveShadow = false
  return m
}

/**
 * Unit box whose origin is its bottom face, with a white vertex-colour
 * attribute. Instance colours only reach the fragment shader when the material
 * declares vertexColors, and that path multiplies by the geometry colour — so
 * the attribute has to exist and be white.
 */
function riserBox(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1)
  g.translate(0, 0.5, 0)
  return withWhite(g)
}

function withWhite(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.attributes.position.count
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  return g
}

/** Write a translate+scale matrix straight into an instance buffer (no compose). */
function setTRS(arr: Float32Array, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  const o = i * 16
  arr[o] = sx; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = sz; arr[o + 11] = 0
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1
}

/**
 * ProcArray height axis: transaction age. The newest xid stands at the top of
 * the ring, XID_SPAN transactions of history fit below it, and anything older
 * bottoms out on the deck — which is exactly what a pinned xmin looks like.
 */
function procY(xid: number, x: number): number {
  return 1.1 + PROC_H * clamp01(1 - (xid - x) / XID_SPAN)
}

/** bufferTilePos() allocates; update() cannot. Same maths, no array. */
function tileX(idx: number): number {
  return -HALF_GRID + (idx % G) * PITCH
}
function tileZ(idx: number): number {
  return -HALF_GRID + Math.floor(idx / G) * PITCH
}

function setColor3(arr: Float32Array, i: number, r: number, g: number, b: number): void {
  const o = i * 3
  arr[o] = r
  arr[o + 1] = g
  arr[o + 2] = b
}

/* ============================================================================
 * FACTORY
 * ==========================================================================*/

export const createShmem: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'shmem'

  /** Geometries / materials / textures this module owns and must dispose. */
  const owned: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }

  const rng = makeRng(0x5eed_c0de)

  /* ---------------------------------------------------------- shared mats */

  const mStruct = theme.mat('shmem.struct', { color: 0x1b2435, roughness: 0.74, metalness: 0.26 })
  const mStructLo = theme.mat('shmem.structLo', { color: 0x121a29, roughness: 0.82, metalness: 0.2 })
  const mStructHi = theme.mat('shmem.structHi', { color: 0x27334a, roughness: 0.55, metalness: 0.42 })
  const mPylon = theme.mat('shmem.pylon', { color: 0x0f1522, roughness: 0.88, metalness: 0.18 })
  const mRim = theme.neon(COLOR.shmem, 1.15)

  /** One material drives every instanced-colour mesh in the district. */
  const mData = keep(
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false }),
  )
  const mBeam = keep(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )

  const gRiser = keep(riserBox())

  /* =========================================================== 1. THE DECK */

  const deck = new THREE.Group()
  deck.name = 'shmem.deck'
  group.add(deck)

  // Body: inset so the cap above reads as a cantilevered edge with a shadow gap.
  const gDeckBody = keep(new THREE.BoxGeometry(DECK_W - 5, 1.5, DECK_D - 5))
  const deckBody = new THREE.Mesh(gDeckBody, mStructLo)
  deckBody.position.set(0, DECK_BOT + 0.75, 0)
  deck.add(deckBody)

  // Cap: the full-width top plate, chamfering out over the body.
  const gDeckCap = keep(new THREE.BoxGeometry(DECK_W, 0.9, DECK_D))
  const deckCap = new THREE.Mesh(gDeckCap, mStruct)
  deckCap.position.set(0, DECK_TOP - 0.45, 0)
  deck.add(deckCap)
  const deckEdge = theme.edges(gDeckCap, COLOR.gridBright, 0.34)
  deckEdge.position.copy(deckCap.position)
  deck.add(deckEdge)

  // The walking surface, carrying the printed floor plan.
  const deckTex = keep(makeDeckTexture(rng))
  const mDeckTop = keep(
    new THREE.MeshStandardMaterial({
      map: deckTex,
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0.12,
      emissive: 0x0b1224,
      emissiveMap: deckTex,
      emissiveIntensity: 0.9,
    }),
  )
  const gDeckPlan = keep(new THREE.PlaneGeometry(DECK_W - 0.6, DECK_D - 0.6))
  const deckPlan = new THREE.Mesh(gDeckPlan, mDeckTop)
  deckPlan.rotation.x = -Math.PI / 2
  deckPlan.position.set(0, DECK_TOP + 0.05, 0)
  deck.add(deckPlan)

  // Continuous indigo rim strip at the deck edge — the plaza's outline at night.
  {
    const rim = instanced(gRiser, mRim, 4)
    const a = rim.instanceMatrix.array as Float32Array
    const h = 0.22
    const y = DECK_TOP - 0.62
    setTRS(a, 0, 0, y, -DECK_D / 2 - 0.06, DECK_W + 0.5, h, 0.5)
    setTRS(a, 1, 0, y, DECK_D / 2 + 0.06, DECK_W + 0.5, h, 0.5)
    setTRS(a, 2, -DECK_W / 2 - 0.06, y, 0, 0.5, h, DECK_D + 0.5)
    setTRS(a, 3, DECK_W / 2 + 0.06, y, 0, 0.5, h, DECK_D + 0.5)
    rim.instanceColor = null // flat neon, no per-instance tint
    rim.frustumCulled = true
    deck.add(rim)
  }

  // Structural pylons diving into the excavation, with collars and X-bracing.
  const PYL_X = [-58, -20, 20, 58]
  const PYL_Z = [-44, 44]
  {
    const len = DECK_BOT - CITY.storage.y
    const gPyl = keep(new THREE.CylinderGeometry(2.5, 3.6, len, 8, 1, true))
    const pyl = new THREE.InstancedMesh(gPyl, mPylon, PYL_X.length * PYL_Z.length)
    const a = pyl.instanceMatrix.array as Float32Array
    let k = 0
    for (const z of PYL_Z) for (const x of PYL_X) setTRS(a, k++, x, CITY.storage.y + len / 2, z, 1, 1, 1)
    pyl.instanceMatrix.needsUpdate = true
    deck.add(pyl)
  }

  /** Fine structural detail — dropped when the camera is far away. */
  const fine = new THREE.Group()
  group.add(fine)
  {
    const gCollar = keep(new THREE.CylinderGeometry(4.6, 3.2, 1.8, 10))
    const collars = new THREE.InstancedMesh(gCollar, mStructHi, PYL_X.length * PYL_Z.length)
    const a = collars.instanceMatrix.array as Float32Array
    let k = 0
    for (const z of PYL_Z) for (const x of PYL_X) setTRS(a, k++, x, DECK_BOT - 0.7, z, 1, 1, 1)
    collars.instanceMatrix.needsUpdate = true
    fine.add(collars)

    // Truss: two tie beams per row plus diagonals between adjacent pylons.
    const braces: number[][] = [] // [x1,y1,z1, x2,y2,z2, thickness]
    for (const z of PYL_Z) {
      for (const y of [-16, -38]) braces.push([PYL_X[0], y, z, PYL_X[3], y, z, 0.8])
      for (let i = 0; i < 3; i++) {
        braces.push([PYL_X[i], -8, z, PYL_X[i + 1], -34, z, 0.6])
        braces.push([PYL_X[i], -34, z, PYL_X[i + 1], -8, z, 0.6])
      }
    }
    const gBrace = keep(new THREE.BoxGeometry(1, 1, 1))
    const brace = new THREE.InstancedMesh(gBrace, mPylon, braces.length)
    const ba = brace.instanceMatrix.array as Float32Array
    for (let i = 0; i < braces.length; i++) {
      const b = braces[i]
      const dx = b[3] - b[0]
      const dy = b[4] - b[1]
      const dz = b[5] - b[2]
      const len = Math.hypot(dx, dy, dz)
      _pos.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2)
      _v.set(dx / len, dy / len, dz / len)
      _quat.setFromUnitVectors(_axisY, _v)
      _scale.set(b[6], len, b[6])
      _mat.compose(_pos, _quat, _scale)
      _mat.toArray(ba, i * 16)
    }
    brace.instanceMatrix.needsUpdate = true
    fine.add(brace)

    // Perimeter railing: posts + top rail. Reads as a real service deck up close.
    const inset = 2.4
    const rx = DECK_W / 2 - inset
    const rz = DECK_D / 2 - inset
    const step = 7.2
    const nx = Math.floor((rx * 2) / step)
    const nz = Math.floor((rz * 2) / step)
    const posts: number[][] = []
    for (let i = 0; i <= nx; i++) {
      const x = -rx + (i * rx * 2) / nx
      posts.push([x, -rz], [x, rz])
    }
    for (let i = 1; i < nz; i++) {
      const z = -rz + (i * rz * 2) / nz
      posts.push([-rx, z], [rx, z])
    }
    const gPost = keep(new THREE.BoxGeometry(0.22, 1.5, 0.22))
    const post = new THREE.InstancedMesh(gPost, mStructHi, posts.length)
    const pa = post.instanceMatrix.array as Float32Array
    for (let i = 0; i < posts.length; i++) setTRS(pa, i, posts[i][0], DECK_TOP + 0.75, posts[i][1], 1, 1, 1)
    post.instanceMatrix.needsUpdate = true
    fine.add(post)

    const rail = new THREE.InstancedMesh(gRiser, theme.neon(COLOR.shmem, 0.55), 4)
    const ra = rail.instanceMatrix.array as Float32Array
    setTRS(ra, 0, 0, DECK_TOP + 1.44, -rz, rx * 2, 0.1, 0.1)
    setTRS(ra, 1, 0, DECK_TOP + 1.44, rz, rx * 2, 0.1, 0.1)
    setTRS(ra, 2, -rx, DECK_TOP + 1.44, 0, 0.1, 0.1, rz * 2)
    setTRS(ra, 3, rx, DECK_TOP + 1.44, 0, 0.1, 0.1, rz * 2)
    rail.instanceMatrix.needsUpdate = true
    fine.add(rail)
  }

  // Plinths under every sub-structure. Two draw calls for six buildings.
  {
    const gPad = keep(new THREE.BoxGeometry(1, 1, 1))
    const pads = new THREE.InstancedMesh(gPad, mStruct, 4)
    const a = pads.instanceMatrix.array as Float32Array
    const y = DECK_TOP + 0.35
    setTRS(a, 0, ANCHOR.lockManager[0], y, ANCHOR.lockManager[2], 27, 0.7, 27)
    setTRS(a, 1, ANCHOR.clogSlru[0], y, ANCHOR.clogSlru[2], 16, 0.7, 13)
    setTRS(a, 2, ANCHOR.statsShmem[0], y, ANCHOR.statsShmem[2], 28, 0.7, 6.5)
    setTRS(a, 3, ANCHOR.bufMapping[0], y, ANCHOR.bufMapping[2], 18, 0.7, 9)
    pads.instanceMatrix.needsUpdate = true
    pads.instanceColor = null
    deck.add(pads)

    const gDrum = keep(new THREE.CylinderGeometry(1, 1, 1, 24))
    const drums = new THREE.InstancedMesh(gDrum, mStruct, 2)
    const d = drums.instanceMatrix.array as Float32Array
    setTRS(d, 0, ANCHOR.procArray[0], y, ANCHOR.procArray[2], 13.5, 0.7, 13.5)
    setTRS(d, 1, ANCHOR.walBuffers[0], y, ANCHOR.walBuffers[2], 11.5, 0.7, 11.5)
    drums.instanceMatrix.needsUpdate = true
    drums.instanceColor = null
    deck.add(drums)
  }

  // Ambient indigo haze over the plaza. One fake light-pool decal, one real
  // (cheap, shadowless) point light so the matte structures have form.
  const hazeTex = keep(makeRadialTexture())
  const mHaze = keep(
    new THREE.MeshBasicMaterial({
      map: hazeTex,
      color: COLOR.shmem,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  const gHaze = keep(new THREE.PlaneGeometry(DECK_W + 60, DECK_D + 60))
  const haze = new THREE.Mesh(gHaze, mHaze)
  haze.rotation.x = -Math.PI / 2
  haze.position.set(0, DECK_TOP + 0.06, 0)
  haze.renderOrder = -1
  haze.raycast = () => {}
  group.add(haze)

  const plazaLight = new THREE.PointLight(COLOR.shmem, 4200, 460, 2)
  plazaLight.position.set(0, 58, 0)
  plazaLight.castShadow = false
  group.add(plazaLight)

  /* =================================================== 2. SHARED BUFFERS */

  const bufGroup = new THREE.Group()
  bufGroup.name = 'shared.buffers'
  group.add(bufGroup)

  // Recessed tray the frames sit in.
  {
    const gTray = keep(new THREE.BoxGeometry(GRID_SPAN + 5, 0.26, GRID_SPAN + 5))
    const tray = new THREE.Mesh(gTray, mStructLo)
    tray.position.set(0, BASE_Y - 0.13, 0)
    bufGroup.add(tray)
    const te = theme.edges(gTray, COLOR.shmem, 0.45)
    te.position.copy(tray.position)
    bufGroup.add(te)
  }

  const gTile = gRiser
  const tiles = instanced(gTile, mData, N)
  bufGroup.add(tiles)
  const tileMat = tiles.instanceMatrix.array as Float32Array
  const tileCol = tiles.instanceColor!.array as Float32Array
  for (let i = 0; i < N; i++) {
    const p = bufferTilePos(i)
    setTRS(tileMat, i, p[0], BASE_Y, p[2], TILE, 0.2, TILE)
  }
  tiles.instanceMatrix.needsUpdate = true

  const tileH = new Float32Array(N).fill(0.2)
  const tileCollapse = new Float32Array(N)
  const tilePrevKey = new Uint32Array(N)
  const tilePhase = new Uint8Array(N)
  for (let i = 0; i < N; i++) tilePhase[i] = (rng() * 256) | 0
  let tilesPrimed = false

  // Clock sweep: a translucent sheet across the row being examined plus the
  // bright hand itself. The trail behind it is painted into the tile colours.
  const gSheet = keep(new THREE.BoxGeometry(GRID_SPAN + 4, 8, PITCH * 0.9))
  const mSheet = keep(
    new THREE.MeshBasicMaterial({
      color: COLOR.warn,
      transparent: true,
      opacity: 0.075,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  const sweepSheet = new THREE.Mesh(gSheet, mSheet)
  sweepSheet.position.set(0, BASE_Y + 4, -HALF_GRID)
  sweepSheet.raycast = () => {}
  bufGroup.add(sweepSheet)

  const gBlade = keep(new THREE.BoxGeometry(0.5, 10.5, PITCH * 1.05))
  const sweepBlade = new THREE.Mesh(gBlade, theme.neon(COLOR.warn, 1.9))
  sweepBlade.position.set(-HALF_GRID, BASE_Y + 5.25, -HALF_GRID)
  sweepBlade.raycast = () => {}
  bufGroup.add(sweepBlade)

  // Floating readout above the grid.
  const readout = makeCanvasPanel(1024, 256, 42, 10.5)
  keep(readout)
  readout.mesh.position.set(0, 15.5, -55)
  bufGroup.add(readout.mesh)

  /* ====================================================== 3. WAL BUFFERS */

  const walGroup = new THREE.Group()
  walGroup.name = 'wal.buffers'
  walGroup.position.set(ANCHOR.walBuffers[0], 0, ANCHOR.walBuffers[2])
  group.add(walGroup)

  const WAL_SLOTS = 16
  const WAL_R = 8.5
  const gWalSeg = keep(withWhite(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)))
  const walSegs = instanced(gWalSeg, mData, WAL_SLOTS)
  walGroup.add(walSegs)
  const walMat = walSegs.instanceMatrix.array as Float32Array
  const walCol = walSegs.instanceColor!.array as Float32Array
  const walSegW = 2 * WAL_R * Math.sin(Math.PI / WAL_SLOTS) * 0.82
  const walSlotAng = new Float32Array(WAL_SLOTS)
  for (let i = 0; i < WAL_SLOTS; i++) {
    const ang = ((i + 0.5) / WAL_SLOTS) * TAU
    walSlotAng[i] = ang
    _pos.set(Math.sin(ang) * WAL_R, MOUNT_Y, Math.cos(ang) * WAL_R)
    _quat.setFromAxisAngle(_axisY, ang)
    _scale.set(walSegW, 0.4, 2.6)
    _mat.compose(_pos, _quat, _scale)
    _mat.toArray(walMat, i * 16)
  }
  walSegs.instanceMatrix.needsUpdate = true
  const walSlotH = new Float32Array(WAL_SLOTS).fill(0.4)

  const mWalRing = keep(new THREE.MeshBasicMaterial({ color: COLOR.walDim, toneMapped: false }))
  {
    const gRing = keep(new THREE.TorusGeometry(WAL_R + 1.5, 0.22, 6, 56))
    const ring = new THREE.Mesh(gRing, mWalRing)
    ring.rotation.x = Math.PI / 2
    ring.position.y = MOUNT_Y + 0.05
    walGroup.add(ring)

    const gSpindle = keep(new THREE.CylinderGeometry(0.5, 0.9, 7.5, 10))
    const spindle = new THREE.Mesh(gSpindle, mStructHi)
    spindle.position.y = MOUNT_Y + 3.75
    walGroup.add(spindle)
  }
  // Two arms: the insert head (bright) and the write position (dim). The angle
  // between them *is* the unflushed content of wal_buffers.
  const gArm = keep(new THREE.BoxGeometry(WAL_R, 0.22, 0.34).translate(WAL_R / 2, 0, 0))
  const walInsertArm = new THREE.Mesh(gArm, theme.neon(COLOR.wal, 1.7))
  walInsertArm.position.y = MOUNT_Y + 6.4
  walGroup.add(walInsertArm)
  const walWriteArm = new THREE.Mesh(gArm, theme.neon(COLOR.walDim, 1.4))
  walWriteArm.position.y = MOUNT_Y + 5.6
  walGroup.add(walWriteArm)


  /* ========================================================= 4. PROCARRAY */

  const procGroup = new THREE.Group()
  procGroup.name = 'proc.array'
  procGroup.position.set(ANCHOR.procArray[0], 0, ANCHOR.procArray[2])
  group.add(procGroup)

  const PROC_R = 9.5
  const gPillar = keep(withWhite(new THREE.CylinderGeometry(0.62, 0.72, 1, 6).translate(0, 0.5, 0)))
  const pillars = instanced(gPillar, mData, N_BACKEND_SLOTS)
  procGroup.add(pillars)
  const pillarMat = pillars.instanceMatrix.array as Float32Array
  const pillarCol = pillars.instanceColor!.array as Float32Array
  /** World-space pillar tops — the lock manager draws its wait-for edges to these. */
  const pillarPos = new Float32Array(N_BACKEND_SLOTS * 3)
  const pillarH = new Float32Array(N_BACKEND_SLOTS).fill(1)
  for (let i = 0; i < N_BACKEND_SLOTS; i++) {
    const ang = (i / N_BACKEND_SLOTS) * TAU
    const x = Math.sin(ang) * PROC_R
    const z = Math.cos(ang) * PROC_R
    setTRS(pillarMat, i, x, MOUNT_Y, z, 1, 1, 1)
    pillarPos[i * 3] = ANCHOR.procArray[0] + x
    pillarPos[i * 3 + 1] = MOUNT_Y + 1
    pillarPos[i * 3 + 2] = ANCHOR.procArray[2] + z
  }
  pillars.instanceMatrix.needsUpdate = true

  // The xmin horizon: one blade through the ring. Dead tuples newer than this
  // line are still visible to somebody, so vacuum is not allowed to remove them.
  const bladeGroup = new THREE.Group()
  bladeGroup.name = 'xmin.horizon'
  procGroup.add(bladeGroup)
  const gBladeDisc = keep(new THREE.CircleGeometry(PROC_R + 3.4, 44).rotateX(-Math.PI / 2))
  const mBlade = keep(
    new THREE.MeshBasicMaterial({
      color: COLOR.index,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  const bladeDisc = new THREE.Mesh(gBladeDisc, mBlade)
  bladeGroup.add(bladeDisc)
  const gBladeRing = keep(new THREE.TorusGeometry(PROC_R + 3.4, 0.18, 6, 48))
  const mBladeRing = keep(new THREE.MeshBasicMaterial({ color: COLOR.index, toneMapped: false }))
  const bladeRing = new THREE.Mesh(gBladeRing, mBladeRing)
  bladeRing.rotation.x = Math.PI / 2
  bladeGroup.add(bladeRing)
  // The gap column: how far the horizon has fallen behind the current xid.
  const gGap = keep(new THREE.CylinderGeometry(0.9, 0.9, 1, 10, 1, true).translate(0, 0.5, 0))
  const mGap = keep(
    new THREE.MeshBasicMaterial({
      color: COLOR.crit,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  const gapCol = new THREE.Mesh(gGap, mGap)
  gapCol.raycast = () => {}
  bladeGroup.add(gapCol)

  /* ===================================================== 5. LOCK MANAGER */

  const lockGroup = new THREE.Group()
  lockGroup.name = 'lock.manager'
  lockGroup.position.set(ANCHOR.lockManager[0], 0, ANCHOR.lockManager[2])
  group.add(lockGroup)

  const LOCK_PITCH = 6.6
  const chamberPos = new Float32Array(LOCK_PARTS * 3) // world space
  {
    const gCh = keep(new THREE.BoxGeometry(5.4, 3.2, 5.4))
    const chambers = new THREE.InstancedMesh(gCh, mStruct, LOCK_PARTS)
    const a = chambers.instanceMatrix.array as Float32Array
    for (let i = 0; i < LOCK_PARTS; i++) {
      const cx = (i % 4) - 1.5
      const cz = Math.floor(i / 4) - 1.5
      const x = cx * LOCK_PITCH
      const z = cz * LOCK_PITCH
      setTRS(a, i, x, MOUNT_Y + 1.6, z, 1, 1, 1)
      chamberPos[i * 3] = ANCHOR.lockManager[0] + x
      chamberPos[i * 3 + 1] = MOUNT_Y + 3.4
      chamberPos[i * 3 + 2] = ANCHOR.lockManager[2] + z
    }
    chambers.instanceMatrix.needsUpdate = true
    chambers.instanceColor = null
    lockGroup.add(chambers)
    // Blueprint outline around the whole 4×4 block, not around one chamber.
    const gOutline = keep(new THREE.BoxGeometry(LOCK_PITCH * 4 + 0.6, 3.6, LOCK_PITCH * 4 + 0.6))
    const e = theme.edges(gOutline, COLOR.gridBright, 0.3)
    e.position.set(0, MOUNT_Y + 1.7, 0)
    lockGroup.add(e)
  }
  const gCore = keep(withWhite(new THREE.BoxGeometry(3.4, 0.5, 3.4)))
  const lockCores = instanced(gCore, mData, LOCK_PARTS)
  lockGroup.add(lockCores)
  const lockCoreCol = lockCores.instanceColor!.array as Float32Array
  {
    const a = lockCores.instanceMatrix.array as Float32Array
    for (let i = 0; i < LOCK_PARTS; i++) {
      const x = ((i % 4) - 1.5) * LOCK_PITCH
      const z = (Math.floor(i / 4) - 1.5) * LOCK_PITCH
      setTRS(a, i, x, MOUNT_Y + 3.35, z, 1, 1, 1)
    }
    lockCores.instanceMatrix.needsUpdate = true
  }
  // Waiting queue: slabs stacked on top of the partition that holds them up.
  const LOCK_QUEUE_MAX = 4
  const gQueue = keep(withWhite(new THREE.BoxGeometry(2.6, 0.34, 2.6)))
  const lockQueue = instanced(gQueue, mData, LOCK_PARTS * LOCK_QUEUE_MAX)
  fine.add(lockQueue)
  const lockQueueMat = lockQueue.instanceMatrix.array as Float32Array
  const lockQueueCol = lockQueue.instanceColor!.array as Float32Array
  for (let i = 0; i < LOCK_PARTS; i++) {
    const x = ((i % 4) - 1.5) * LOCK_PITCH + ANCHOR.lockManager[0]
    const z = (Math.floor(i / 4) - 1.5) * LOCK_PITCH + ANCHOR.lockManager[2]
    for (let k = 0; k < LOCK_QUEUE_MAX; k++) {
      setTRS(lockQueueMat, i * LOCK_QUEUE_MAX + k, x, MOUNT_Y + 3.9 + k * 0.52, z, 1, 0, 1)
    }
  }
  lockQueue.instanceMatrix.needsUpdate = true

  // Wait-for edges: waiter's PGPROC → its lock partition → the holder's PGPROC.
  const lockBeams = makeBeamSet(MAX_LOCK_BEAMS, LOCK_BEAM_SEGS, mBeam)
  keep(lockBeams)
  group.add(lockBeams.line)

  const lockWaiters = new Uint8Array(LOCK_PARTS)
  const lockHeld = new Uint8Array(LOCK_PARTS)
  const lockHeat = new Float32Array(LOCK_PARTS)

  /* ========================================================= 6. CLOG SLRU */

  const clogGroup = new THREE.Group()
  clogGroup.name = 'clog.slru'
  clogGroup.position.set(ANCHOR.clogSlru[0], 0, ANCHOR.clogSlru[2])
  group.add(clogGroup)

  const CLOG_SLAB_W = 11
  const CLOG_SLAB_D = 7.4
  const CLOG_PITCH = 0.94
  const gSlab = keep(withWhite(new THREE.BoxGeometry(CLOG_SLAB_W, 0.46, CLOG_SLAB_D)))
  const clogSlabs = instanced(gSlab, mData, CLOG_SLABS)
  clogGroup.add(clogSlabs)
  const clogSlabMat = clogSlabs.instanceMatrix.array as Float32Array
  const clogSlabCol = clogSlabs.instanceColor!.array as Float32Array
  const clogSlabZ = new Float32Array(CLOG_SLABS)
  for (let i = 0; i < CLOG_SLABS; i++) {
    setTRS(clogSlabMat, i, 0, MOUNT_Y + 0.5 + i * CLOG_PITCH, 0, 1, 1, 1)
  }
  clogSlabs.instanceMatrix.needsUpdate = true

  // Commit bits on the face of the most-recently-used page. 2 bits per xact.
  const gBit = keep(withWhite(new THREE.BoxGeometry(0.52, 0.12, 0.52)))
  const clogBits = instanced(gBit, mData, CLOG_BITS)
  fine.add(clogBits)
  const clogBitMat = clogBits.instanceMatrix.array as Float32Array
  const clogBitCol = clogBits.instanceColor!.array as Float32Array
  for (let j = 0; j < CLOG_BITS; j++) setTRS(clogBitMat, j, 0, 0, 0, 1, 1, 1)

  {
    // Cabinet: two cheek walls and a back plate, so the stack reads as a cache.
    const gCheek = keep(new THREE.BoxGeometry(0.6, CLOG_SLABS * CLOG_PITCH + 1.6, CLOG_SLAB_D + 1.4))
    const cabinet = new THREE.InstancedMesh(gCheek, mStruct, 2)
    const a = cabinet.instanceMatrix.array as Float32Array
    const y = MOUNT_Y + (CLOG_SLABS * CLOG_PITCH) / 2 + 0.3
    setTRS(a, 0, -CLOG_SLAB_W / 2 - 0.5, y, 0, 1, 1, 1)
    setTRS(a, 1, CLOG_SLAB_W / 2 + 0.5, y, 0, 1, 1, 1)
    cabinet.instanceMatrix.needsUpdate = true
    cabinet.instanceColor = null
    clogGroup.add(cabinet)
    const e = theme.edges(gCheek, COLOR.gridBright, 0.28)
    e.position.set(-CLOG_SLAB_W / 2 - 0.5, y, 0)
    clogGroup.add(e)
  }

  /* ================================================ 7. CUMULATIVE STATS */

  const statsGroup = new THREE.Group()
  statsGroup.name = 'stats.shmem'
  statsGroup.position.set(ANCHOR.statsShmem[0], 0, ANCHOR.statsShmem[2])
  group.add(statsGroup)

  const STAT_PITCH = 0.42
  const statBars = instanced(gRiser, mData, STAT_BARS)
  statsGroup.add(statBars)
  const statMat = statBars.instanceMatrix.array as Float32Array
  const statCol = statBars.instanceColor!.array as Float32Array
  for (let i = 0; i < STAT_BARS; i++) {
    const x = (i - (STAT_BARS - 1) / 2) * STAT_PITCH
    setTRS(statMat, i, x, MOUNT_Y, 0, 0.3, 0.15, 1.7)
  }
  statBars.instanceMatrix.needsUpdate = true
  const statH = new Float32Array(STAT_BARS).fill(0.15)

  {
    const gMast = keep(new THREE.CylinderGeometry(0.26, 0.42, 1, 8).translate(0, 0.5, 0))
    const mast = new THREE.InstancedMesh(gMast, mStructHi, 2)
    const a = mast.instanceMatrix.array as Float32Array
    setTRS(a, 0, 12.6, MOUNT_Y, 0, 1, 15, 1)
    setTRS(a, 1, 12.6, MOUNT_Y + 15, 0, 0.25, 4.6, 0.25)
    mast.instanceMatrix.needsUpdate = true
    statsGroup.add(mast)
  }
  const gBeacon = keep(new THREE.SphereGeometry(0.42, 10, 8))
  const mBeacon = keep(new THREE.MeshBasicMaterial({ color: COLOR.ok, toneMapped: false }))
  const beacon = new THREE.Mesh(gBeacon, mBeacon)
  beacon.position.set(12.6, MOUNT_Y + 15.4, 0)
  statsGroup.add(beacon)

  /* ================================================= 8. BUFFER MAPPING */

  const mapGroup = new THREE.Group()
  mapGroup.name = 'buf.mapping'
  mapGroup.position.set(ANCHOR.bufMapping[0], 0, ANCHOR.bufMapping[2])
  group.add(mapGroup)

  {
    const gRack = keep(new THREE.BoxGeometry(16, 8.4, 4.2))
    const rack = new THREE.Mesh(gRack, mStruct)
    rack.position.set(0, MOUNT_Y + 4.2, 0)
    mapGroup.add(rack)
    const e = theme.edges(gRack, COLOR.gridBright, 0.3)
    e.position.copy(rack.position)
    mapGroup.add(e)
  }
  const gBucket = keep(withWhite(new THREE.BoxGeometry(1.5, 1.35, 0.5)))
  const buckets = instanced(gBucket, mData, MAP_BUCKETS)
  mapGroup.add(buckets)
  const bucketCol = buckets.instanceColor!.array as Float32Array
  /** World-space bucket faces (+Z side of the rack), where lookup beams start. */
  const bucketPos = new Float32Array(MAP_BUCKETS * 3)
  {
    const a = buckets.instanceMatrix.array as Float32Array
    for (let i = 0; i < MAP_BUCKETS; i++) {
      const cx = (i % 8) - 3.5
      const cy = 3 - Math.floor(i / 8)
      const x = cx * 1.82
      const y = MOUNT_Y + 1.6 + cy * 1.75
      setTRS(a, i, x, y, 2.35, 1, 1, 1)
      bucketPos[i * 3] = ANCHOR.bufMapping[0] + x
      bucketPos[i * 3 + 1] = y
      bucketPos[i * 3 + 2] = ANCHOR.bufMapping[2] + 2.6
    }
    buckets.instanceMatrix.needsUpdate = true
  }
  const bucketHeat = new Float32Array(MAP_BUCKETS)
  const mapBeams = makeBeamSet(MAX_MAP_BEAMS, 1, mBeam)
  keep(mapBeams)
  group.add(mapBeams.line)
  /** Live lookups: [bucket, tile, age] per slot. */
  const lookupBucket = new Int16Array(MAX_MAP_BEAMS).fill(-1)
  const lookupTile = new Int32Array(MAX_MAP_BEAMS)
  const lookupAge = new Float32Array(MAX_MAP_BEAMS)
  let lookupNext = 0
  const prevLastBuffer = new Int32Array(N_BACKEND_SLOTS).fill(-1)
  let flowTimer = 0
  let lookupRate = 0

  /* ============================================================= REGISTER */

  ctx.register({
    id: 'shmem.deck',
    name: 'Shared memory',
    role: 'one segment, mapped by every process',
    kind: 'memory',
    district: 'shmem',
    object: deck,
    tier: 0,
    color: COLOR.shmem,
    focus: { target: [0, DECK_TOP, 0], distance: 215, dir: [0.34, 0.6, 0.72] },
    labelAt: [0, DECK_TOP + 2, -DECK_D / 2 + 6],
    readout: (s) =>
      `${fmtBytes(s.buffers.size * 8192)} buffers · ${s.stats.activeBackends}/${s.maxConnections} attached`,
  })

  ctx.register({
    id: 'shared.buffers',
    name: 'shared_buffers',
    role: 'the page cache every backend reads through',
    kind: 'memory',
    district: 'shmem',
    object: bufGroup,
    tier: 0,
    color: COLOR.bufClean,
    focus: { target: [0, BASE_Y + 2, 0], distance: 104, dir: [0.12, 0.66, 0.74] },
    labelAt: [0, 12, 0],
    readout: (s) =>
      `hit ${fmtPct(s.buffers.hitRatio, 1)} · ${fmtNum(s.buffers.usedCount)}/${fmtNum(s.buffers.size)} used · ${fmtNum(
        s.buffers.dirtyCount,
      )} dirty`,
  })

  ctx.register({
    id: 'wal.buffers',
    name: 'wal_buffers',
    role: 'circular WAL insert ring',
    kind: 'memory',
    district: 'shmem',
    object: walGroup,
    tier: 1,
    color: COLOR.wal,
    focus: { target: [ANCHOR.walBuffers[0], MOUNT_Y + 3, ANCHOR.walBuffers[2]], distance: 34, dir: [0.72, 0.5, 0.48] },
    readout: (s) =>
      `${fmtPct(clamp01(s.wal.bufferBytes / Math.max(1, s.wal.bufferCapacity)))} full · insert ${fmtLsn(s.wal.insertLsn)}`,
  })

  ctx.register({
    id: 'proc.array',
    name: 'ProcArray',
    role: 'one PGPROC slot per backend',
    kind: 'memory',
    district: 'shmem',
    object: procGroup,
    tier: 1,
    color: COLOR.backend,
    focus: { target: [ANCHOR.procArray[0], MOUNT_Y + 5, ANCHOR.procArray[2]], distance: 40, dir: [-0.6, 0.52, -0.6] },
    readout: (s) => `${s.stats.activeBackends} active · xid ${fmtNum(s.xid)}`,
  })

  ctx.register({
    id: 'xmin.horizon',
    name: 'xmin horizon',
    role: 'oldest xid anyone can still see',
    kind: 'concept',
    district: 'shmem',
    object: bladeGroup,
    tier: 1,
    color: COLOR.index,
    focus: { target: [ANCHOR.procArray[0], MOUNT_Y + 7, ANCHOR.procArray[2]], distance: 32, dir: [-0.5, 0.35, -0.79] },
    readout: (s) => `xid ${fmtNum(s.xid)} · horizon ${fmtNum(s.xminHorizon)} (age ${fmtNum(s.xid - s.xminHorizon)})`,
  })

  ctx.register({
    id: 'lock.manager',
    name: 'Lock manager',
    role: '16 hash partitions of the lock table',
    kind: 'memory',
    district: 'shmem',
    object: lockGroup,
    tier: 1,
    color: COLOR.lock,
    focus: { target: [ANCHOR.lockManager[0], MOUNT_Y + 3, ANCHOR.lockManager[2]], distance: 42, dir: [0.62, 0.55, -0.56] },
    readout: (s) => (s.locks.length ? `${s.locks.length} waiting on a lock` : 'no waiters'),
  })

  ctx.register({
    id: 'clog.slru',
    name: 'pg_xact (CLOG)',
    role: 'SLRU cache of commit status bits',
    kind: 'memory',
    district: 'shmem',
    object: clogGroup,
    tier: 1,
    color: COLOR.ok,
    focus: { target: [ANCHOR.clogSlru[0], MOUNT_Y + 5, ANCHOR.clogSlru[2]], distance: 34, dir: [-0.66, 0.5, 0.56] },
    readout: (s) => `${fmtNum(s.stats.commits)} commits · ${fmtNum(s.stats.rollbacks)} rollbacks`,
  })

  ctx.register({
    id: 'stats.shmem',
    name: 'Cumulative statistics',
    role: 'pg_stat_* counters in shared memory',
    kind: 'memory',
    district: 'shmem',
    object: statsGroup,
    tier: 1,
    color: COLOR.inkDim,
    focus: { target: [ANCHOR.statsShmem[0], MOUNT_Y + 4, ANCHOR.statsShmem[2]], distance: 34, dir: [0.5, 0.5, 0.7] },
    readout: (s) => `${fmtNum(s.stats.tps)} tps · hit ${fmtPct(s.stats.cacheHitPct / 100, 1)}`,
  })

  ctx.register({
    id: 'buf.mapping',
    name: 'Buffer mapping table',
    role: 'hash: (relation, block) → buffer id',
    kind: 'memory',
    district: 'shmem',
    object: mapGroup,
    tier: 1,
    color: COLOR.shmem,
    focus: { target: [ANCHOR.bufMapping[0], MOUNT_Y + 4, ANCHOR.bufMapping[2]], distance: 30, dir: [-0.78, 0.44, 0.44] },
    readout: (s) => `${fmtNum(s.buffers.hits + s.buffers.misses)} lookups · ${fmtNum(s.buffers.evictions)} evictions`,
  })

  /* =============================================================== UPDATE */

  let panelTimer = 0
  let beaconPhase = 0

  function updateBuffers(dt: number, sim: SimState, t: number): void {
    const b = sim.buffers
    const valid = b.valid
    if (!valid) return
    const dirty = b.dirty
    const pinned = b.pinned
    const usage = b.usage
    const rel = b.rel
    const touch = b.lastTouch
    const blk = b.blk
    const n = Math.min(N, valid.length)
    const size = clamp(b.size | 0, 0, n)
    const hand = ((b.clockHand | 0) % Math.max(1, size) + Math.max(1, size)) % Math.max(1, size)

    const kH = 1 - Math.exp(-9 * dt)
    const collapseStep = dt * 2.6
    const timeOff = (t * 200) | 0

    for (let i = 0; i < n; i++) {
      let r: number, g: number, bl: number
      let target: number

      if (i >= size) {
        // Frames beyond shared_buffers were never allocated.
        r = 0.006
        g = 0.009
        bl = 0.018
        target = 0.15
      } else {
        const key = ((rel[i] << 24) ^ (blk[i] >>> 0)) >>> 0
        if (tilesPrimed && key !== tilePrevKey[i]) tileCollapse[i] = 1 // evicted: the frame changed identity
        tilePrevKey[i] = key

        const u = usage[i]
        if (!valid[i]) {
          r = L_FREE[0] * 0.75
          g = L_FREE[1] * 0.75
          bl = L_FREE[2] * 0.75
          target = 0.3
        } else {
          const isDirty = dirty[i] !== 0
          let inten: number
          if (isDirty) {
            // Dirty pages breathe: they are debt the checkpointer has to pay.
            const p = 0.86 + 0.24 * SIN[(tilePhase[i] + timeOff) & 255]
            inten = 1.24 * p
            r = L_DIRTY[0] * inten
            g = L_DIRTY[1] * inten
            bl = L_DIRTY[2] * inten
          } else {
            inten = 0.34 + (u / 5) * 0.3
            r = L_CLEAN[0] * inten
            g = L_CLEAN[1] * inten
            bl = L_CLEAN[2] * inten
          }
          // Whose page is this? A light tint toward the owning relation.
          const rl = rel[i]
          if (rl < TABLES.length) {
            const o = rl * 3
            const w = 0.3
            r += (L_TABLE[o] * inten - r) * w
            g += (L_TABLE[o + 1] * inten - g) * w
            bl += (L_TABLE[o + 2] * inten - bl) * w
          }
          if (pinned[i]) {
            r += L_PINNED[0] * 0.5
            g += L_PINNED[1] * 0.5
            bl += L_PINNED[2] * 0.5
          }
          target = 0.4 + (u / 5) * MAX_RISE + (pinned[i] ? 1.6 : 0)
        }

        // Fresh touches flash white and decay: this is the working set.
        const age = t - touch[i]
        if (age >= 0 && age < 0.9) {
          const f = 1 - age / 0.9
          const ff = f * f * 1.5
          r += 0.55 * ff
          g += 0.62 * ff
          bl += 0.78 * ff
        }

        // Clock-sweep trail. d is how many frames ago the hand passed here.
        let d = hand - i
        if (d < 0) d += size
        if (d < SWEEP_TRAIL) {
          const w = (1 - d / SWEEP_TRAIL) * 0.55
          r += L_WARN[0] * w
          g += L_WARN[1] * w
          bl += L_WARN[2] * w
        }
      }

      const c = tileCollapse[i]
      if (c > 0) {
        tileCollapse[i] = c - collapseStep > 0 ? c - collapseStep : 0
        target *= 1 - c * 0.92
        r += 0.5 * c
        g += 0.5 * c
        bl += 0.6 * c
      }

      const h = tileH[i] + (target - tileH[i]) * kH
      tileH[i] = h
      tileMat[i * 16 + 5] = h < 0.06 ? 0.06 : h
      setColor3(tileCol, i, r, g, bl)
    }
    tilesPrimed = true
    tiles.instanceMatrix.needsUpdate = true
    tiles.instanceColor!.needsUpdate = true

    // The hand itself.
    const row = Math.floor(hand / G)
    const col = hand % G
    sweepSheet.position.z = -HALF_GRID + row * PITCH
    sweepBlade.position.z = sweepSheet.position.z
    sweepBlade.position.x = -HALF_GRID + col * PITCH
  }

  function updateWal(dt: number, sim: SimState, t: number): void {
    const w = sim.wal
    const cap = Math.max(1, w.bufferCapacity)
    const fill = clamp01(w.bufferBytes / cap)
    // Where the write pointer sits on the ring; the insert head is `fill` ahead.
    const wrtA = ((w.writeLsn % cap) / cap) * TAU
    const insA = wrtA + fill * TAU
    const arc = fill * TAU
    const segArc = TAU / WAL_SLOTS
    // A full ring means backends stall waiting for a WAL write.
    const stall = fill > 0.94 ? (fill - 0.94) / 0.06 : 0
    const flash = stall > 0 ? 0.55 + 0.45 * SIN[((t * 900) | 0) & 255] : 0

    const kH = 1 - Math.exp(-12 * dt)
    for (let i = 0; i < WAL_SLOTS; i++) {
      let d = walSlotAng[i] - wrtA
      d = ((d % TAU) + TAU) % TAU
      // Fractional occupancy of this slot: partial slots grow in.
      const frac = clamp01((arc - (d - segArc * 0.5)) / segArc)
      const target = 0.4 + frac * 3.4
      const h = walSlotH[i] + (target - walSlotH[i]) * kH
      walSlotH[i] = h
      walMat[i * 16 + 5] = h

      const head = frac > 0.02 && frac < 1 ? 1 : 0
      let inten = 0.22 + frac * 1.05 + head * 0.5
      if (stall > 0) {
        const s = stall * flash
        setColor3(walCol, i, L_CRIT[0] * (0.6 + s * 1.4), L_CRIT[1] * (0.3 + s * 0.8), L_CRIT[2] * (0.3 + s * 0.8))
      } else if (frac <= 0.02) {
        setColor3(walCol, i, L_WALDIM[0] * 0.5, L_WALDIM[1] * 0.5, L_WALDIM[2] * 0.5)
      } else {
        setColor3(walCol, i, L_WAL[0] * inten, L_WAL[1] * inten, L_WAL[2] * inten)
      }
    }
    walSegs.instanceMatrix.needsUpdate = true
    walSegs.instanceColor!.needsUpdate = true

    walInsertArm.rotation.y = insA - Math.PI / 2
    walWriteArm.rotation.y = wrtA - Math.PI / 2
    // A full ring is a stall: the whole rim goes red.
    const sr = stall * flash
    mWalRing.color.setRGB(
      L_WALDIM[0] * 1.2 + L_CRIT[0] * sr * 2.6,
      L_WALDIM[1] * 1.2 + L_CRIT[1] * sr * 2.6,
      L_WALDIM[2] * 1.2 + L_CRIT[2] * sr * 2.6,
    )
  }

  function updateProc(dt: number, sim: SimState, t: number): void {
    const xid = sim.xid
    const kH = 1 - Math.exp(-7 * dt)
    let oldest = -1
    let oldestXid = Infinity
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = sim.backends[i]
      if (b && b.active && b.xid > 0 && b.xid < oldestXid) {
        oldestXid = b.xid
        oldest = i
      }
    }

    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const b = sim.backends[i]
      let target = 0.9
      let r = 0.02, g = 0.03, bl = 0.05
      if (b && b.active) {
        if (b.xid > 0) {
          target = procY(xid, b.xid)
          const old = i === oldest
          const src = old ? (sim.knobs.longRunningXact ? L_CRIT : L_VACUUM) : L_BACKEND
          const pulse = b.state === 'commit_wait' || b.state === 'wal_insert' ? 0.5 : 0
          const inten = (old ? 1.5 : 0.85) + pulse * 0.4
          r = src[0] * inten
          g = src[1] * inten
          bl = src[2] * inten
        } else {
          // Connected but not in a transaction: no xid, so nothing to hold back.
          target = 2.2
          r = L_BACKEND[0] * 0.28
          g = L_BACKEND[1] * 0.28
          bl = L_BACKEND[2] * 0.28
        }
        if (b.state === 'blocked') {
          const s = 0.6 + 0.4 * SIN[((t * 500) | 0) & 255]
          r += L_LOCK[0] * s
          g += L_LOCK[1] * s * 0.5
          bl += L_LOCK[2] * s * 0.5
        }
      }
      const h = pillarH[i] + (target - pillarH[i]) * kH
      pillarH[i] = h
      pillarMat[i * 16 + 5] = h
      pillarPos[i * 3 + 1] = MOUNT_Y + h
      setColor3(pillarCol, i, r, g, bl)
    }
    pillars.instanceMatrix.needsUpdate = true
    pillars.instanceColor!.needsUpdate = true

    // The blade. When a long-running transaction pins xmin it sinks to the deck
    // and goes red — everything above it is garbage vacuum is not allowed to take.
    const age = Math.max(0, xid - sim.xminHorizon)
    const pinnedHard = age > XID_SPAN * 0.55
    const by = MOUNT_Y + Math.max(0.5, procY(xid, sim.xminHorizon))
    bladeDisc.position.y += (by - bladeDisc.position.y) * (1 - Math.exp(-4 * dt))
    bladeRing.position.y = bladeDisc.position.y
    const danger = clamp01(age / (XID_SPAN * 0.8))
    const cr = (1 - danger) * L_INDEX[0] + danger * L_CRIT[0]
    const cg = (1 - danger) * L_INDEX[1] + danger * L_CRIT[1]
    const cb = (1 - danger) * L_INDEX[2] + danger * L_CRIT[2]
    const beat = pinnedHard ? 0.7 + 0.3 * SIN[((t * 220) | 0) & 255] : 1
    mBlade.color.setRGB(cr * beat, cg * beat, cb * beat)
    mBlade.opacity = 0.2 + danger * 0.3
    mBladeRing.color.setRGB(cr * 1.7 * beat, cg * 1.7 * beat, cb * 1.7 * beat)

    const topY = MOUNT_Y + procY(xid, xid)
    const gapH = Math.max(0.05, topY - bladeDisc.position.y)
    gapCol.position.y = bladeDisc.position.y
    gapCol.scale.set(1, gapH, 1)
    mGap.opacity = 0.06 + danger * 0.26
  }

  function updateLocks(dt: number, sim: SimState, t: number): void {
    lockWaiters.fill(0)
    lockHeld.fill(0)
    const edges = sim.locks
    const nEdges = edges ? edges.length : 0

    // Beams: waiter's PGPROC → the partition holding the lock → the holder's.
    let beam = 0
    for (let e = 0; e < nEdges; e++) {
      const L = edges[e]
      // Real Postgres hashes the LOCKTAG; we hash (relation, holder) the same way
      // it does — deterministically, into one of the 16 partitions.
      const part = ((L.table * 7 + L.holder * 3) & (LOCK_PARTS - 1)) >>> 0
      if (lockWaiters[part] < 255) lockWaiters[part]++
      lockHeld[part] = 1
      if (beam < MAX_LOCK_BEAMS && L.holder >= 0 && L.holder < N_BACKEND_SLOTS && L.waiter >= 0 && L.waiter < N_BACKEND_SLOTS) {
        const ax = pillarPos[L.waiter * 3]
        const ay = pillarPos[L.waiter * 3 + 1]
        const az = pillarPos[L.waiter * 3 + 2]
        const bx = pillarPos[L.holder * 3]
        const by = pillarPos[L.holder * 3 + 1]
        const bz = pillarPos[L.holder * 3 + 2]
        const cx = chamberPos[part * 3]
        const cy = chamberPos[part * 3 + 1] + 6
        const cz = chamberPos[part * 3 + 2]
        // A tension pulse runs waiter → holder so you can read the direction.
        const head = (t * 0.8 + e * 0.31) % 1
        writeBeam(lockBeams, beam, ax, ay, az, cx, cy, cz, bx, by, bz, L_LOCK, 1.1 + Math.min(1.4, L.ageSec * 0.25), head)
        beam++
      }
    }
    lockBeams.setActive(beam)

    const kH = 1 - Math.exp(-6 * dt)
    for (let i = 0; i < LOCK_PARTS; i++) {
      const want = lockHeld[i] ? 1 : 0
      lockHeat[i] += (want - lockHeat[i]) * kH
      const h = lockHeat[i]
      const q = lockWaiters[i]
      const beat = q > 0 ? 0.75 + 0.25 * SIN[((t * 340) | 0) & 255] : 1
      // Idle partitions are cool and nearly black; contention burns.
      const r = 0.012 + L_LOCK[0] * h * 1.5 * beat
      const g = 0.02 + L_LOCK[1] * h * 0.55 * beat
      const b = 0.035 + L_LOCK[2] * h * 0.55 * beat
      setColor3(lockCoreCol, i, r, g, b)

      for (let k = 0; k < LOCK_QUEUE_MAX; k++) {
        const idx = i * LOCK_QUEUE_MAX + k
        const on = k < q
        const sc = on ? 1 : 0 // collapse every axis: a flat box still rasterises
        lockQueueMat[idx * 16] = sc
        lockQueueMat[idx * 16 + 5] = sc
        lockQueueMat[idx * 16 + 10] = sc
        const inten = on ? 1.15 - k * 0.2 : 0
        setColor3(lockQueueCol, idx, L_LOCK[0] * inten, L_LOCK[1] * inten * 0.6, L_LOCK[2] * inten * 0.6)
      }
    }
    lockCores.instanceColor!.needsUpdate = true
    lockQueue.instanceMatrix.needsUpdate = true
    lockQueue.instanceColor!.needsUpdate = true
  }

  function updateClog(dt: number, sim: SimState, t: number): void {
    const xid = sim.xid
    const page = Math.floor(xid / CLOG_XIDS_PER_SLAB)
    const mru = ((page % CLOG_SLABS) + CLOG_SLABS) % CLOG_SLABS
    const kH = 1 - Math.exp(-8 * dt)

    for (let i = 0; i < CLOG_SLABS; i++) {
      // Age in "pages behind the current one": the SLRU keeps a few pages hot.
      let back = mru - i
      if (back < 0) back += CLOG_SLABS
      const isMru = i === mru
      const targetZ = isMru ? 2.6 : back < 3 ? 1.0 - back * 0.3 : 0
      clogSlabZ[i] += (targetZ - clogSlabZ[i]) * kH
      clogSlabMat[i * 16 + 14] = clogSlabZ[i]
      const inten = isMru ? 0.85 : back < 4 ? 0.3 - back * 0.06 : 0.06
      setColor3(clogSlabCol, i, L_SHMEM[0] * inten, L_SHMEM[1] * inten, L_SHMEM[2] * inten)
    }
    clogSlabs.instanceMatrix.needsUpdate = true
    clogSlabs.instanceColor!.needsUpdate = true

    // Bits on the front page. Each bit covers a slice of xids; it lights green
    // when those transactions have committed (or red if one rolled back).
    const base = page * CLOG_XIDS_PER_SLAB
    const per = CLOG_XIDS_PER_SLAB / CLOG_BITS
    const slabY = MOUNT_Y + 0.5 + mru * CLOG_PITCH + 0.28
    const slabZ = clogSlabZ[mru]
    const cols = 16
    const rows = 4
    for (let j = 0; j < CLOG_BITS; j++) {
      const cx = (j % cols) - (cols - 1) / 2
      const cz = Math.floor(j / cols) - (rows - 1) / 2
      const idx = j * 16
      clogBitMat[idx + 12] = ANCHOR.clogSlru[0] + cx * 0.66
      clogBitMat[idx + 13] = slabY
      clogBitMat[idx + 14] = ANCHOR.clogSlru[2] + slabZ + cz * 0.72

      const hi = base + (j + 1) * per
      if (xid >= hi) {
        // Deterministic ~4% aborts, so the wall isn't uniformly green.
        const aborted = ((j * 2654435761) ^ (page * 40503)) % 23 === 0
        const src = aborted ? L_CRIT : L_OK
        const fresh = clamp01(1 - (xid - hi) / (per * 6))
        const inten = 0.28 + fresh * 1.1
        setColor3(clogBitCol, j, src[0] * inten, src[1] * inten, src[2] * inten)
      } else if (xid > base + j * per) {
        const s = 0.5 + 0.5 * SIN[((t * 600) | 0) & 255]
        setColor3(clogBitCol, j, L_WARN[0] * s, L_WARN[1] * s, L_WARN[2] * s)
      } else {
        setColor3(clogBitCol, j, 0.01, 0.014, 0.024)
      }
    }
    clogBits.instanceMatrix.needsUpdate = true
    clogBits.instanceColor!.needsUpdate = true
  }

  function updateStats(dt: number, sim: SimState, t: number): void {
    const hist = sim.stats.history
    const tpsH = hist ? hist.tps : null
    const hitH = hist ? hist.hit : null
    const n = tpsH ? tpsH.length : 0

    let peak = 1
    for (let i = 0; i < STAT_BARS; i++) {
      const idx = n - STAT_BARS + i
      const v = idx >= 0 && tpsH ? tpsH[idx] : 0
      if (v > peak) peak = v
    }
    const kH = 1 - Math.exp(-10 * dt)
    for (let i = 0; i < STAT_BARS; i++) {
      const idx = n - STAT_BARS + i
      const v = idx >= 0 && tpsH ? tpsH[idx] : 0
      let hit = idx >= 0 && hitH ? hitH[idx] : 1
      if (hit > 1.5) hit /= 100 // tolerate percent or fraction
      hit = clamp01(hit)
      const target = 0.15 + (v / peak) * 7.6
      statH[i] += (target - statH[i]) * kH
      statMat[i * 16 + 5] = statH[i]
      const newest = i === STAT_BARS - 1 ? 0.55 : 0
      const inten = 0.5 + (v / peak) * 0.5 + newest
      const r = (L_CRIT[0] * (1 - hit) + L_OK[0] * hit) * inten
      const g = (L_CRIT[1] * (1 - hit) + L_OK[1] * hit) * inten
      const b = (L_CRIT[2] * (1 - hit) + L_OK[2] * hit) * inten
      setColor3(statCol, i, r, g, b)
    }
    statBars.instanceMatrix.needsUpdate = true
    statBars.instanceColor!.needsUpdate = true

    // Beacon blinks once per ~40 commits: the stats file is being updated.
    beaconPhase += dt * (0.4 + clamp01(sim.stats.tps / 400) * 3)
    const bl = beaconPhase % 1 < 0.12 ? 1.8 : 0.12
    mBeacon.color.setRGB(L_OK[0] * bl, L_OK[1] * bl, L_OK[2] * bl)
  }

  function updateBufMap(dt: number, sim: SimState, t: number): void {
    const b = sim.buffers
    lookupRate = Math.max(0, lookupRate - dt * 4)

    // A backend touching a new page must go through the mapping table first.
    for (let i = 0; i < N_BACKEND_SLOTS; i++) {
      const bk = sim.backends[i]
      if (!bk || !bk.active) continue
      const lb = bk.lastBuffer
      if (lb === prevLastBuffer[i] || lb < 0 || lb >= N) continue
      prevLastBuffer[i] = lb
      const bucket = ((b.rel[lb] * 7 + (b.blk[lb] >>> 0) * 13 + 5) & (MAP_BUCKETS - 1)) >>> 0
      lookupBucket[lookupNext] = bucket
      lookupTile[lookupNext] = lb
      lookupAge[lookupNext] = 0
      lookupNext = (lookupNext + 1) % MAX_MAP_BEAMS
      bucketHeat[bucket] = 1
      lookupRate = Math.min(6, lookupRate + 1)
    }

    let beam = 0
    for (let s = 0; s < MAX_MAP_BEAMS; s++) {
      if (lookupBucket[s] < 0) continue
      lookupAge[s] += dt
      const life = clamp01(lookupAge[s] / 0.45)
      if (life >= 1) {
        lookupBucket[s] = -1
        continue
      }
      const bu = lookupBucket[s]
      const tile = lookupTile[s]
      const ax = bucketPos[bu * 3]
      const ay = bucketPos[bu * 3 + 1]
      const az = bucketPos[bu * 3 + 2]
      const bx = tileX(tile)
      const by = BASE_Y + tileH[tile] + 0.4
      const bz = tileZ(tile)
      // A short dash travelling from the bucket to the frame it resolved to.
      const u0 = Math.max(0, life * 1.25 - 0.22)
      const u1 = Math.min(1, life * 1.25)
      const o = beam * 2 * 3
      lockPos(mapBeams, o, ax + (bx - ax) * u0, ay + (by - ay) * u0 + 2 * u0 * (1 - u0) * 3, az + (bz - az) * u0)
      lockPos(mapBeams, o + 3, ax + (bx - ax) * u1, ay + (by - ay) * u1 + 2 * u1 * (1 - u1) * 3, az + (bz - az) * u1)
      const inten = (1 - life) * 2.2
      mapBeams.colors[o] = L_INDEX[0] * inten
      mapBeams.colors[o + 1] = L_INDEX[1] * inten
      mapBeams.colors[o + 2] = L_INDEX[2] * inten
      mapBeams.colors[o + 3] = L_INK[0] * inten
      mapBeams.colors[o + 4] = L_INK[1] * inten
      mapBeams.colors[o + 5] = L_INK[2] * inten
      beam++
    }
    mapBeams.setActive(beam)

    const decay = dt * 3
    for (let i = 0; i < MAP_BUCKETS; i++) {
      const h = bucketHeat[i] > decay ? bucketHeat[i] - decay : 0
      bucketHeat[i] = h
      const inten = 0.05 + h * 1.5
      setColor3(bucketCol, i, L_SHMEM[0] * inten, L_SHMEM[1] * inten, L_SHMEM[2] * inten)
    }
    buckets.instanceColor!.needsUpdate = true

    // Occasional traffic on the mapping-table road.
    flowTimer -= dt
    if (flowTimer <= 0 && lookupRate > 0.5) {
      flowTimer = 0.55 + 0.8 / (1 + lookupRate)
      ctx.flow({ route: 'bufmap.in', count: 1, color: COLOR.shmem, size: 0.8, kind: 'stat' })
    }
  }

  function updatePanel(dt: number, sim: SimState): void {
    panelTimer -= dt
    if (panelTimer > 0) return
    panelTimer = 0.2
    const b = sim.buffers
    const g2 = readout.ctx
    const W = readout.canvas.width
    const H = readout.canvas.height
    g2.clearRect(0, 0, W, H)
    g2.fillStyle = 'rgba(6,10,20,0.72)'
    g2.fillRect(0, 0, W, H)
    g2.strokeStyle = 'rgba(123,108,255,0.55)'
    g2.lineWidth = 4
    g2.strokeRect(2, 2, W - 4, H - 4)
    g2.fillStyle = 'rgba(123,108,255,0.9)'
    g2.fillRect(2, 2, 10, H - 4)

    g2.textBaseline = 'middle'
    g2.textAlign = 'left'
    g2.font = '600 46px ui-monospace, SFMono-Regular, Menlo, monospace'
    g2.fillStyle = '#dbe7ff'
    g2.fillText(`shared_buffers  ${fmtNum(b.size)} × 8kB = ${fmtBytes(b.size * 8192)}`, 34, 52)

    g2.font = '500 40px ui-monospace, SFMono-Regular, Menlo, monospace'
    g2.fillStyle = '#8fa5c4'
    const hit = `hit ${fmtPct(b.hitRatio, 1)}`
    g2.fillText(hit, 34, 122)
    const w1 = g2.measureText(hit).width
    g2.fillStyle = '#3fa7ff'
    const used = `  used ${fmtNum(b.usedCount)}/${fmtNum(b.size)}`
    g2.fillText(used, 34 + w1, 122)
    const w2 = g2.measureText(used).width
    g2.fillStyle = '#ff4d6d'
    g2.fillText(`  dirty ${fmtNum(b.dirtyCount)}`, 34 + w1 + w2, 122)

    g2.fillStyle = '#8fa5c4'
    g2.font = '500 34px ui-monospace, SFMono-Regular, Menlo, monospace'
    g2.fillText(
      `clock hand ${b.clockHand}   evictions ${fmtNum(b.evictions)} (${fmtNum(b.dirtyEvictions)} dirty)   pinned ${fmtNum(
        b.pinnedCount,
      )}`,
      34,
      190,
    )
    readout.texture.needsUpdate = true
  }

  /* ------------------------------------------------------------- lifecycle */

  let detail: 0 | 1 | 2 = 2

  const mod: WorldModule = {
    id: 'shmem',
    group,
    update(dt: number, sim: SimState, t: number): void {
      const d = dt > 0.1 ? 0.1 : dt // a tab-switch must not snap every animation
      updateBuffers(d, sim, t)
      updateWal(d, sim, t)
      updateProc(d, sim, t)
      updateLocks(d, sim, t)
      updateClog(d, sim, t)
      updateStats(d, sim, t)
      updateBufMap(d, sim, t)
      updatePanel(d, sim)

      // The readout faces the viewer, yaw only — it is a sign, not a sprite.
      _v.copy(ctx.camera.position).sub(readout.mesh.position)
      readout.mesh.rotation.y = Math.atan2(_v.x, _v.z)

      // Haze follows the amount of work happening in the plaza.
      const load = clamp01(sim.stats.activeBackends / 8) * 0.5 + clamp01(sim.buffers.dirtyCount / 260) * 0.5
      mHaze.opacity = 0.16 + load * 0.26
      plazaLight.intensity = 3400 + load * 2600
    },
    setDetail(level: 0 | 1 | 2): void {
      detail = level
      fine.visible = level > 0
      clogBits.visible = level > 0
      lockQueue.visible = level > 0
      readout.mesh.visible = level > 0
      haze.visible = level < 2 // up close the floor haze just washes out the tiles
    },
    dispose(): void {
      // theme.edges() hands back geometry this module now owns.
      group.traverse((o) => {
        const ls = o as THREE.LineSegments
        if ((ls as unknown as { isLineSegments?: boolean }).isLineSegments) ls.geometry.dispose()
      })
      for (const o of owned) o.dispose()
      owned.length = 0
      group.clear()
    },
  }

  return mod
}

/* ============================================================================
 * Helpers that build resources at construction time only.
 * ==========================================================================*/

interface BeamSet {
  line: THREE.LineSegments
  positions: Float32Array
  colors: Float32Array
  segs: number
  setActive(n: number): void
  dispose(): void
}

/** One LineSegments for a whole family of beams; drawRange hides the idle ones. */
function makeBeamSet(maxBeams: number, segs: number, material: THREE.LineBasicMaterial): BeamSet {
  const verts = maxBeams * segs * 2
  const positions = new Float32Array(verts * 3)
  const colors = new Float32Array(verts * 3)
  const geo = new THREE.BufferGeometry()
  const pAttr = new THREE.BufferAttribute(positions, 3)
  const cAttr = new THREE.BufferAttribute(colors, 3)
  pAttr.setUsage(THREE.DynamicDrawUsage)
  cAttr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('position', pAttr)
  geo.setAttribute('color', cAttr)
  geo.setDrawRange(0, 0)
  const line = new THREE.LineSegments(geo, material)
  line.frustumCulled = false
  line.renderOrder = 3
  line.raycast = () => {}
  return {
    line,
    positions,
    colors,
    segs,
    setActive(n: number) {
      geo.setDrawRange(0, n * segs * 2)
      pAttr.needsUpdate = true
      cAttr.needsUpdate = true
    },
    dispose() {
      geo.dispose()
    },
  }
}

function lockPos(set: BeamSet, off: number, x: number, y: number, z: number): void {
  set.positions[off] = x
  set.positions[off + 1] = y
  set.positions[off + 2] = z
}

/** Quadratic bezier a → c → b, written into beam slot `i` with a moving highlight. */
function writeBeam(
  set: BeamSet,
  i: number,
  ax: number,
  ay: number,
  az: number,
  cx: number,
  cy: number,
  cz: number,
  bx: number,
  by: number,
  bz: number,
  color: Float32Array,
  inten: number,
  head: number,
): void {
  const segs = set.segs
  const base = i * segs * 2 * 3
  for (let s = 0; s < segs; s++) {
    for (let e = 0; e < 2; e++) {
      const u = (s + e) / segs
      const iu = 1 - u
      const w0 = iu * iu
      const w1 = 2 * iu * u
      const w2 = u * u
      const off = base + (s * 2 + e) * 3
      set.positions[off] = w0 * ax + w1 * cx + w2 * bx
      set.positions[off + 1] = w0 * ay + w1 * cy + w2 * by
      set.positions[off + 2] = w0 * az + w1 * cz + w2 * bz
      const d = Math.abs(u - head)
      const glow = d < 0.14 ? (1 - d / 0.14) * 1.8 : 0
      const k = inten * (0.55 + glow)
      set.colors[off] = color[0] * k
      set.colors[off + 1] = color[1] * k
      set.colors[off + 2] = color[2] * k
    }
  }
}

interface CanvasPanel {
  mesh: THREE.Mesh
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  dispose(): void
}

function makeCanvasPanel(w: number, h: number, worldW: number, worldH: number): CanvasPanel {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c2d = canvas.getContext('2d')!
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const geo = new THREE.PlaneGeometry(worldW, worldH)
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.renderOrder = 4
  return {
    mesh,
    canvas,
    ctx: c2d,
    texture,
    dispose() {
      geo.dispose()
      mat.dispose()
      texture.dispose()
    },
  }
}

/** Soft radial falloff used for the plaza's indigo light pool. */
function makeRadialTexture(): THREE.CanvasTexture {
  const s = 256
  const cv = document.createElement('canvas')
  cv.width = cv.height = s
  const g = cv.getContext('2d')!
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,0.85)')
  grd.addColorStop(0.45, 'rgba(255,255,255,0.28)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * The deck's printed floor plan: panel seams, hazard bands at the cantilevered
 * edges, the shared_buffers footprint with its column ruler, and the district
 * legends. One texture, one draw call, all of the typography in the plaza.
 */
function makeDeckTexture(rng: () => number): THREE.CanvasTexture {
  const W = 2048
  const H = Math.round((W * DECK_D) / DECK_W)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  const px = W / DECK_W
  const X = (wx: number) => (wx + DECK_W / 2) * px
  const Y = (wz: number) => (wz + DECK_D / 2) * px

  g.fillStyle = '#0a0f1a'
  g.fillRect(0, 0, W, H)

  // Very slight centre lift so the slab isn't dead flat.
  const vg = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W * 0.62)
  vg.addColorStop(0, 'rgba(70,96,150,0.10)')
  vg.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = vg
  g.fillRect(0, 0, W, H)

  // Cast-panel shading on a 13 m module.
  const mod = 13
  for (let wx = -DECK_W / 2; wx < DECK_W / 2; wx += mod) {
    for (let wz = -DECK_D / 2; wz < DECK_D / 2; wz += mod) {
      const a = 0.004 + rng() * 0.014
      g.fillStyle = `rgba(150,180,240,${a.toFixed(4)})`
      g.fillRect(X(wx), Y(wz), mod * px, mod * px)
    }
  }

  // Seams: minor every 13 m, major every 26 m.
  g.lineWidth = 1
  g.strokeStyle = 'rgba(56,80,124,0.28)'
  g.beginPath()
  for (let wx = -DECK_W / 2 + mod; wx < DECK_W / 2; wx += mod) {
    g.moveTo(X(wx), 0)
    g.lineTo(X(wx), H)
  }
  for (let wz = -DECK_D / 2 + mod; wz < DECK_D / 2; wz += mod) {
    g.moveTo(0, Y(wz))
    g.lineTo(W, Y(wz))
  }
  g.stroke()
  g.lineWidth = 2
  g.strokeStyle = 'rgba(74,106,164,0.38)'
  g.beginPath()
  for (let wx = -DECK_W / 2 + mod * 2; wx < DECK_W / 2; wx += mod * 2) {
    g.moveTo(X(wx), 0)
    g.lineTo(X(wx), H)
  }
  for (let wz = -DECK_D / 2 + mod * 2; wz < DECK_D / 2; wz += mod * 2) {
    g.moveTo(0, Y(wz))
    g.lineTo(W, Y(wz))
  }
  g.stroke()

  // Hazard band along the edges: this deck is cantilevered over a 55 m drop.
  const band = 2.6 * px
  g.save()
  g.beginPath()
  g.rect(0, 0, W, H)
  g.rect(band, band, W - band * 2, H - band * 2)
  g.clip('evenodd')
  g.fillStyle = 'rgba(24,34,54,0.9)'
  g.fillRect(0, 0, W, H)
  g.strokeStyle = 'rgba(123,108,255,0.30)'
  g.lineWidth = 6
  for (let i = -H; i < W + H; i += 26) {
    g.beginPath()
    g.moveTo(i, 0)
    g.lineTo(i + H, H)
    g.stroke()
  }
  g.restore()

  // shared_buffers footprint.
  const b0 = GRID_SPAN / 2 + 2.4
  g.save()
  g.setLineDash([16, 12])
  g.lineWidth = 3
  g.strokeStyle = 'rgba(63,167,255,0.5)'
  g.strokeRect(X(-b0), Y(-b0), b0 * 2 * px, b0 * 2 * px)
  g.restore()
  // Corner brackets.
  g.strokeStyle = 'rgba(63,167,255,0.8)'
  g.lineWidth = 5
  const br = 6 * px
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = X(sx * b0)
      const cy = Y(sz * b0)
      g.beginPath()
      g.moveTo(cx - sx * br, cy)
      g.lineTo(cx, cy)
      g.lineTo(cx, cy - sz * br)
      g.stroke()
    }
  }

  // Column / row ruler around the grid — 32 × 32 frames.
  g.fillStyle = 'rgba(120,150,200,0.75)'
  g.font = `500 ${Math.round(1.7 * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  for (let c = 0; c < BUF_GRID; c += 4) {
    const wx = -HALF_GRID + c * PITCH
    g.fillText(String(c), X(wx), Y(-b0 - 2.6))
    g.fillRect(X(wx) - 1, Y(-b0 - 1.2), 2, 0.8 * px)
  }
  g.textAlign = 'right'
  for (let r = 0; r < BUF_GRID; r += 4) {
    const wz = -HALF_GRID + r * PITCH
    g.fillText(String(r * BUF_GRID), X(-b0 - 1.8), Y(wz))
  }

  // Legends.
  const label = (text: string, wx: number, wz: number, size = 2.4, align: CanvasTextAlign = 'center', color = 'rgba(143,165,196,0.85)') => {
    g.textAlign = align
    g.fillStyle = color
    g.font = `600 ${Math.round(size * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    g.fillText(text, X(wx), Y(wz))
  }

  label('SHARED_BUFFERS · 1024 × 8kB PAGE FRAMES', 0, b0 + 3.4, 2.4, 'center', 'rgba(63,167,255,0.7)')
  label('CLOCK SWEEP →', -HALF_GRID + 10, -b0 - 5.2, 1.9, 'center', 'rgba(255,204,85,0.65)')
  label('wal_buffers', ANCHOR.walBuffers[0], ANCHOR.walBuffers[2] + 13.6, 2.3, 'center', 'rgba(255,176,58,0.8)')
  label('circular · insert → write → flush', ANCHOR.walBuffers[0], ANCHOR.walBuffers[2] + 16.4, 1.5)
  label('ProcArray', ANCHOR.procArray[0], ANCHOR.procArray[2] - 15.4, 2.3, 'center', 'rgba(90,209,255,0.8)')
  label('PGPROC[16] · snapshots · xmin', ANCHOR.procArray[0], ANCHOR.procArray[2] - 12.6, 1.5)
  label('LOCK MANAGER', ANCHOR.lockManager[0], ANCHOR.lockManager[2] - 16.4, 2.3, 'center', 'rgba(255,92,92,0.75)')
  label('16 hash partitions · wait-for graph', ANCHOR.lockManager[0], ANCHOR.lockManager[2] - 13.6, 1.5)
  label('pg_xact · SLRU', ANCHOR.clogSlru[0], ANCHOR.clogSlru[2] + 9.6, 2.3, 'center', 'rgba(87,227,137,0.75)')
  label('2 bits per transaction', ANCHOR.clogSlru[0], ANCHOR.clogSlru[2] + 12.2, 1.5)
  label('CUMULATIVE STATISTICS', ANCHOR.statsShmem[0], ANCHOR.statsShmem[2] + 7.4, 2.1)
  label('buffer mapping', ANCHOR.bufMapping[0], ANCHOR.bufMapping[2] + 7.6, 2.1, 'center', 'rgba(123,108,255,0.8)')
  label('(relation, block) → buffer id', ANCHOR.bufMapping[0], ANCHOR.bufMapping[2] + 10.2, 1.5)

  // District title along the south edge.
  g.textAlign = 'center'
  g.fillStyle = 'rgba(123,108,255,0.42)'
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '18px'
  g.font = `700 ${Math.round(3.4 * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  g.fillText('SHARED MEMORY SEGMENT', X(0), Y(DECK_D / 2 - 6.4))
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'

  // North mark, because the client sky is that way.
  g.strokeStyle = 'rgba(143,165,196,0.5)'
  g.lineWidth = 3
  g.beginPath()
  g.moveTo(X(-DECK_W / 2 + 9), Y(-DECK_D / 2 + 12))
  g.lineTo(X(-DECK_W / 2 + 9), Y(-DECK_D / 2 + 6))
  g.lineTo(X(-DECK_W / 2 + 7), Y(-DECK_D / 2 + 8.4))
  g.moveTo(X(-DECK_W / 2 + 9), Y(-DECK_D / 2 + 6))
  g.lineTo(X(-DECK_W / 2 + 11), Y(-DECK_D / 2 + 8.4))
  g.stroke()
  label('N', -DECK_W / 2 + 9, -DECK_D / 2 + 14.6, 1.8)

  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}
