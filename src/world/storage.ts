import * as THREE from 'three'
import { COLOR, DAY_PALETTE, atmosphere, mixHex } from '../core/theme'
import { N_VAC_WORKERS } from '../core/types'
import type { FlowRequest, SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, fmtBytes, fmtNum, fmtPct, makeRng } from '../core/util'
import { ANCHOR, CITY, N_TABLES, TABLES, indexPos, rid, routeCurve, tableX } from './layout'

export function diskArrayReadout(s: SimState): string {
  return `${fmtNum(s.stats.ioReadPerSec)} read pages/s · ${fmtNum(s.stats.ioWritePerSec)} sampled write frames/s · fsync ${
    s.checkpoint.phase === 'syncing' ? 'ACTIVE' : 'idle'
  }`
}

/**
 * Opacity is semantic, never atmosphere. Physical matter is solid; `volume`
 * is only for non-physical regions, `glass` only for real enclosures whose
 * contents must remain visible, and `hint` for at most one unstacked cue in a
 * district. New translucent materials must choose one of these tiers.
 */
export const OPACITY_TIER = {
  solid: 1.0,
  volume: 0.35,
  glass: 0.6,
  hint: 0.12,
} as const

/* ============================================================================
 * THE STORAGE UNDERWORLD
 *
 * Everything below y = 0, seen through the excavation. This is the layer the
 * rest of the city exists to avoid touching.
 *
 *   data directory   the pit floor: a printed blueprint of the cluster files
 *   heap files       five warehouses; the roof is the file, one tile per run of
 *                    8 KiB pages, coloured by what is actually in those pages
 *   indexes          real B-trees — root, internals, leaves, and the doubly
 *                    linked leaf chain that makes range scans cheap
 *   TOAST            the sidecar where oversized values get sliced and filed
 *   _fsm / _vm       the two forks nobody draws: free space, and all-visible
 *   OS page cache    a porous slab between memory and the platters
 *   disk array       the floor of the story; fsync is where the promise lands
 *
 * Vertical traffic runs in physical conduits built along the rid.ioRead /
 * rid.ioWrite routes, so a page fault is visibly an elevator ride from the
 * platters, through the kernel's cache, up to the shared-memory plaza.
 * ==========================================================================*/

/* ---------------------------------------------------------------- geometry */

const FLOOR_Y = CITY.storage.y // -52, the data-directory floor
const ROOF_Y = CITY.storage.warehouseTop // -30, where the page tiles live
const PIT_FLOOR_Y = FLOOR_Y - 8 // ground.ts digs 8 m deeper than the floor

/** One roof tile is an 8 MiB run of heap pages. */
const PAGES_PER_TILE = 1024
/** Index trees sample page counts at the same scale as the enlarged relations. */
const INDEX_PAGES_PER_VISUAL_PAGE = 84
const COLS = 12
const PITCH = 1.4
const TILE_W = 1.15
const ROWS_MIN = 3
const ROWS_MAX = 44
/** Block 0 sits here; the file grows south, because files grow at the end. */
const FILE_Z0 = -89
const SLOT_Z0 = -94
const SLOT_Z1 = -18
const HALF_W = 9.5
/** Where the _fsm bars and _vm bits run, along the roof edges. */
const PANEL_X = 8.3
/** Top of the service gantry that carries the I/O conduit onto the roof. */
const GANTRY_Y = ROOF_Y + 4.6

const FLOOR_X0 = -112
const FLOOR_X1 = 112
const FLOOR_Z0 = -95
const FLOOR_Z1 = 100

/** Disk rack: north strip of the pit, in the gap between floor and pit wall. */
const RACK_Z = -99
const RACK_TOP = -46
const RACK_W = 132
const RACK_D = 8

/** OS page cache slab. */
const OC_Y = CITY.osCache.y // -24
const OC_COLS = 22
const OC_ROWS = 16
const OC_PITCH = 10
const OC_TILE = 8.4
const OC_N = OC_COLS * OC_ROWS

/** B-tree: one root, four internal, twelve leaves. */
const NODES_PER_TREE = 17
const LEAVES = 12
const STRUTS_PER_TREE = 4 + LEAVES + (LEAVES - 1)
const LEAF_PITCH = 1.6
const ROOT_Y = -33
const INNER_Y = -38.5
const LEAF_Y = -44

const GIN_ENTRIES = 48
const GIN_LISTS = 12

const MAX_PROBES = 14
const TOAST_SLOTS = 3
const TOAST_CHUNKS = 4
const N_DRIVES = 96
const DRIVE_COLS = 24
const DRIVE_ROWS = 4

/* ------------------------------------------------------------------ colours */

const C_DEAD = 0x8f2f3d // dull red: dead tuples, not the bright dirty-page red
const C_GAP = 0x0b111d // free space in a page
const C_GREY = 0x39465e // bloated index leaf

/* ------------------------------------------------------------ scratch state
 * update() must not allocate. Everything transient lives here. */

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _scale = new THREE.Vector3(1, 1, 1)
const _quat = new THREE.Quaternion()
const _mat4 = new THREE.Matrix4()
const _col = new THREE.Color()
const _axisY = new THREE.Vector3(0, 1, 0)

/** Deterministic noise for update(): xorshift on a module-scope word. */
let _rndState = 0x9e3779b9
function rnd(): number {
  let x = _rndState
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  _rndState = x >>> 0
  return _rndState / 4294967296
}

function lin(hex: number, scale = 1, out = new Float32Array(3)): Float32Array {
  _col.setHex(hex)
  out[0] = _col.r * scale
  out[1] = _col.g * scale
  out[2] = _col.b * scale
  return out
}

const L_DEAD = lin(C_DEAD)
const L_GAP = lin(C_GAP)
const L_OK = lin(COLOR.ok)
const L_INDEX = lin(COLOR.index)
const L_GREY = lin(C_GREY)
const L_VACUUM = lin(COLOR.vacuum)
const L_STORAGE = lin(COLOR.storage)
const L_WARN = lin(COLOR.warn)
const L_CRIT = lin(COLOR.crit)
const L_DIRTY = lin(COLOR.bufDirty)
const L_TOAST = lin(COLOR.toast)
const L_INK = lin(COLOR.inkDim)
const L_TABLE = new Float32Array(N_TABLES * 3)
for (let i = 0; i < N_TABLES; i++) {
  _col.setHex(TABLES[i].color)
  L_TABLE[i * 3] = _col.r
  L_TABLE[i * 3 + 1] = _col.g
  L_TABLE[i * 3 + 2] = _col.b
}

/* --------------------------------------------------------------- utilities */

function setTRS(a: Float32Array, i: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  const o = i * 16
  a[o] = sx; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0
  a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = sz; a[o + 11] = 0
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1
}

function setColor3(a: Float32Array, i: number, r: number, g: number, b: number): void {
  const o = i * 3
  a[o] = r
  a[o + 1] = g
  a[o + 2] = b
}

/** Instance colours only reach the shader through a (white) vertex colour attribute. */
function withWhite(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.attributes.position.count
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  return g
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, count)
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3).fill(1), 3)
  m.instanceColor.setUsage(THREE.DynamicDrawUsage)
  m.frustumCulled = false
  return m
}

/** 12 edges of an axis-aligned box, written as 24 vertices into `pos`. */
const EDGE_PAIRS = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]
function writeBoxEdges(
  pos: Float32Array, slot: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
): void {
  let o = slot * 24 * 3
  for (let e = 0; e < 24; e++) {
    const c = EDGE_PAIRS[e]
    pos[o++] = cx + (c & 1 ? hx : -hx)
    pos[o++] = cy + (c & 2 ? hy : -hy)
    pos[o++] = cz + (c & 4 ? hz : -hz)
  }
}

/** The directories nobody visits until recovery day. name, x, z, height. */
const ANNEX: readonly (readonly [string, number, number, number])[] = [
  ['global', -96, 52, 7],
  ['pg_xact', -80, 52, 5],
  ['pg_multixact', -96, 68, 5],
  ['pg_subtrans', -80, 68, 4],
  ['pg_tblspc', -96, 84, 4],
  ['pg_stat', -80, 84, 3.4],
]

function hexA(c: number, a: number): string {
  return `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`
}

/* ============================================================================
 * FACTORY
 * ==========================================================================*/

export const createStorage: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx
  const group = new THREE.Group()
  group.name = 'storage'
  const collisionBoxes: THREE.Box3[] = []

  const owned: { dispose(): void }[] = []
  const keep = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x)
    return x
  }
  const rng = makeRng(0x5107a9e)

  /* ------------------------------------------------------------ materials */

  const mStruct = theme.mat('storage.struct', { color: 0x1a2333, roughness: 0.8, metalness: 0.2 })
  const mStructLo = theme.mat('storage.structLo', { color: 0x101827, roughness: 0.92, metalness: 0.12 })
  const mStructHi = theme.mat('storage.structHi', { color: 0x27334c, roughness: 0.54, metalness: 0.42 })

  /** One material for every instanced-colour mesh down here. */
  const mData = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false }))
  mData.name = 'storage.liveData'
  // Kernel memory is a conceptual region, not physical matter: the one
  // deliberately translucent material in this district.
  const mVolume = keep(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: OPACITY_TIER.volume,
      // The slab is one non-overlapping tile layer. Writing depth keeps later,
      // farther translucent districts from stacking through it.
      depthWrite: true,
    }),
  )
  mVolume.name = 'storage.osCache'
  const mIndexLine = keep(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      toneMapped: false,
      depthWrite: true,
    }),
  )
  /** Invisible collider: no draw call, still raycastable. */
  const mPick = keep(new THREE.MeshBasicMaterial({ visible: false }))

  const gUnit = keep(new THREE.BoxGeometry(1, 1, 1))
  const gRiser = keep(withWhite(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)))
  const gFlat = keep(withWhite(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)))
  const gCyl = keep(new THREE.CylinderGeometry(1, 1, 1, 10))

  /* Static matte boxes are collected here and baked into two instanced meshes. */
  const boxLo: number[] = []
  const boxHi: number[] = []
  const passableBoxLo = new Set<number>()
  const passableBoxHi = new Set<number>()
  const addBox = (a: number[], x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    a.push(x, y, z, sx, sy, sz)
  }

  /* =================================================== 1. DATA DIRECTORY */

  const dirGroup = new THREE.Group()
  dirGroup.name = 'storage.datadir'
  group.add(dirGroup)

  const floorW = FLOOR_X1 - FLOOR_X0
  const floorD = FLOOR_Z1 - FLOOR_Z0
  const floorCx = (FLOOR_X0 + FLOOR_X1) / 2
  const floorCz = (FLOOR_Z0 + FLOOR_Z1) / 2

  const floorTex = keep(buildFloorTexture(rng, quality.level === 'low' ? 1024 : 1792))
  const mFloor = keep(
    new THREE.MeshStandardMaterial({
      map: floorTex,
      color: 0xffffff,
      roughness: 0.94,
      metalness: 0.06,
      emissive: 0x0a1220,
      emissiveMap: floorTex,
      emissiveIntensity: 0.85,
    }),
  )
  const gFloor = keep(new THREE.PlaneGeometry(floorW, floorD).rotateX(-Math.PI / 2))
  const floor = new THREE.Mesh(gFloor, mFloor)
  floor.position.set(floorCx, FLOOR_Y + 0.02, floorCz)
  dirGroup.add(floor)

  // The printed plan is authored for night and must remain readable, so the
  // daylight storage zone is a translucent coat over it rather than a
  // replacement texture. From the rim the green floor identifies the data
  // directory as a district; up close the paths and relation names still show
  // through.
  const mFloorZone = keep(
    new THREE.MeshStandardMaterial({
      color: COLOR.storage,
      roughness: 0.98,
      metalness: 0,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  )
  mFloorZone.name = 'storage.dayZone'
  mFloorZone.userData.pgDayColor = mixHex(DAY_PALETTE.storage, DAY_PALETTE.ground, 0.18)
  const floorZone = new THREE.Mesh(gFloor, mFloorZone)
  floorZone.name = 'storage.dayZone'
  floorZone.position.set(floorCx, FLOOR_Y + 0.045, floorCz)
  floorZone.renderOrder = 1
  floorZone.raycast = () => {}
  floorZone.userData.pgDayOnly = true
  floorZone.userData.pgNoShadow = true
  floorZone.visible = false
  dirGroup.add(floorZone)
  // Slab under the printed plan, so the floor has thickness from the side.
  addBox(boxLo, floorCx, FLOOR_Y - 0.5, floorCz, floorW, 1.0, floorD)

  // The administrative annex.
  for (const [, ax, az, ah] of ANNEX) {
    addBox(boxLo, ax, FLOOR_Y + ah / 2, az, 11, ah, 9)
    addBox(boxHi, ax, FLOOR_Y + ah + 0.25, az, 12, 0.5, 10)
  }

  // All sixteen private spill runs terminate in one shared on-volume bay.
  // The animated slabs themselves belong to the backend module; this plinth
  // establishes their real containment under base/pgsql_tmp.
  const tempBayGroup = new THREE.Group()
  tempBayGroup.name = 'storage.tempfiles'
  group.add(tempBayGroup)
  passableBoxLo.add(boxLo.length)
  addBox(boxLo, 0, FLOOR_Y + 0.18, -89, CITY.backend.span + 8, 0.36, 7.5)
  passableBoxHi.add(boxHi.length)
  addBox(boxHi, 0, FLOOR_Y + 0.5, -92.5, CITY.backend.span + 8, 0.28, 0.3)
  passableBoxHi.add(boxHi.length)
  addBox(boxHi, 0, FLOOR_Y + 0.5, -85.5, CITY.backend.span + 8, 0.28, 0.3)
  const tempBayProxy = new THREE.Mesh(gUnit, mPick)
  tempBayProxy.position.set(0, FLOOR_Y + 0.8, -89)
  tempBayProxy.scale.set(CITY.backend.span + 8, 2.0, 8)
  tempBayGroup.add(tempBayProxy)

  /* Floor markings: the storage-green rim of the data directory plus the TOAST link. */
  {
    const pts: number[] = []
    const y = FLOOR_Y + 0.09
    const seg = (x0: number, z0: number, x1: number, z1: number) => pts.push(x0, y, z0, x1, y, z1)
    // perimeter
    seg(FLOOR_X0, FLOOR_Z0, FLOOR_X1, FLOOR_Z0)
    seg(FLOOR_X1, FLOOR_Z0, FLOOR_X1, FLOOR_Z1)
    seg(FLOOR_X1, FLOOR_Z1, FLOOR_X0, FLOOR_Z1)
    seg(FLOOR_X0, FLOOR_Z1, FLOOR_X0, FLOOR_Z0)
    // documents → pg_toast: out-of-line values leave the heap and live over there
    const dx = tableX(4)
    const tx = ANCHOR.toastYard[0]
    const tz = ANCHOR.toastYard[2]
    let px = dx
    let pz = SLOT_Z1 + 2
    const bend: [number, number][] = [[dx, 58], [tx + 22, 58], [tx + 22, tz], [tx + 13, tz]]
    for (const [bx, bz] of bend) {
      // dashed: 3 on, 2.4 off
      const len = Math.hypot(bx - px, bz - pz)
      const n = Math.max(1, Math.floor(len / 5.4))
      for (let i = 0; i < n; i++) {
        const a0 = i / n
        const a1 = a0 + 0.56 / n
        seg(px + (bx - px) * a0, pz + (bz - pz) * a0, px + (bx - px) * a1, pz + (bz - pz) * a1)
      }
      px = bx
      pz = bz
    }
    const g = keep(new THREE.BufferGeometry())
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
    const marks = new THREE.LineSegments(g, theme.line(COLOR.storage, 0.42))
    marks.raycast = () => {}
    dirGroup.add(marks)
  }

  // One cold pool of light so the underworld has form without a shadow map.
  const pitLight = new THREE.PointLight(COLOR.storage, 2600, 300, 2)
  pitLight.position.set(0, ROOF_Y + 14, -30)
  group.add(pitLight)
  const rackLight = new THREE.PointLight(0x7fb0ff, 900, 160, 2)
  rackLight.position.set(0, RACK_TOP + 8, RACK_Z + 14)
  group.add(rackLight)
  // Seen from the surface the excavation used to be an unlit black square: the
  // two lights above sit low and tight, so nothing carried up to the rim. These
  // two are wide, weak and high in the cut — enough that the pit reads as a lit
  // space below the city in the establishing shot, without flattening the
  // close-up once the camera is actually down there.
  const pitFill = new THREE.PointLight(COLOR.storage, 5200, 520, 2)
  pitFill.position.set(0, ROOF_Y + 34, 40)
  group.add(pitFill)
  const pitFillW = new THREE.PointLight(0x5f86c8, 3600, 470, 2)
  pitFillW.position.set(-60, ROOF_Y + 30, -60)
  group.add(pitFillW)

  /* ====================================================== 2. HEAP FILES */

  const heapGroup = new THREE.Group()
  heapGroup.name = 'storage.heaps'
  group.add(heapGroup)

  /** Per-table tile allocation inside the one shared roof mesh. */
  const rowsBase = new Int32Array(N_TABLES)
  const rowCap = new Int32Array(N_TABLES)
  const tileBase = new Int32Array(N_TABLES)
  const rowBase = new Int32Array(N_TABLES)
  let tileCap = 0
  let rowTotal = 0
  for (let i = 0; i < N_TABLES; i++) {
    const base = clamp(Math.ceil(TABLES[i].pages / (COLS * PAGES_PER_TILE)), ROWS_MIN, ROWS_MAX)
    rowsBase[i] = base
    rowCap[i] = Math.min(ROWS_MAX, Math.max(base * 2 + 4, 10))
    tileBase[i] = tileCap
    rowBase[i] = rowTotal
    tileCap += rowCap[i] * COLS
    rowTotal += rowCap[i]
  }

  const tiles = instanced(gRiser, mData, tileCap)
  tiles.raycast = () => {} // picked through per-table proxies instead
  heapGroup.add(tiles)
  const tileMat = tiles.instanceMatrix.array as Float32Array
  const tileCol = tiles.instanceColor!.array as Float32Array

  const vmCaps = instanced(gFlat, mData, tileCap)
  vmCaps.raycast = () => {}
  heapGroup.add(vmCaps)
  const capMat = vmCaps.instanceMatrix.array as Float32Array
  const capCol = vmCaps.instanceColor!.array as Float32Array

  /** Fixed per-tile character: page fill and dead-tuple concentration vary. */
  const tileNoise = new Float32Array(tileCap)
  /** Tiles a shared-memory pylon lands on: no roof there, it is a column base. */
  const tileBlocked = new Uint8Array(tileCap)
  const tileFlash = new Float32Array(tileCap)
  const tileVm = new Float32Array(tileCap)
  const tileH = new Float32Array(tileCap)

  const PYL_X = [-58, -20, 20, 58]
  const PYL_Z = [-44, 44]
  for (let ti = 0; ti < N_TABLES; ti++) {
    const tx = tableX(ti)
    for (let r = 0; r < rowCap[ti]; r++) {
      for (let c = 0; c < COLS; c++) {
        const gi = tileBase[ti] + r * COLS + c
        tileNoise[gi] = rng()
        const x = tx + (c - (COLS - 1) / 2) * PITCH
        const z = FILE_Z0 + (r + 0.5) * PITCH
        for (const px of PYL_X) {
          for (const pz of PYL_Z) {
            if (Math.abs(x - px) < 5.0 && Math.abs(z - pz) < 5.0) tileBlocked[gi] = 1
          }
        }
        setTRS(tileMat, gi, x, ROOF_Y, z, TILE_W, 0.001, TILE_W)
        setTRS(capMat, gi, x, ROOF_Y, z, 0.001, 1, 0.001)
      }
    }
  }
  tiles.instanceMatrix.needsUpdate = true
  vmCaps.instanceMatrix.needsUpdate = true

  /* _fsm bars and _vm bits: one instance per page-run row, on the roof edges. */
  const fsmGroup = new THREE.Group()
  fsmGroup.name = 'storage.fsm'
  group.add(fsmGroup)
  const fsmBars = instanced(gRiser, mData, rowTotal)
  fsmGroup.add(fsmBars)
  const fsmMat = fsmBars.instanceMatrix.array as Float32Array
  const fsmCol = fsmBars.instanceColor!.array as Float32Array

  const vmGroup = new THREE.Group()
  vmGroup.name = 'storage.vm'
  group.add(vmGroup)
  const vmBits = instanced(gFlat, mData, rowTotal)
  vmGroup.add(vmBits)
  const vmMat = vmBits.instanceMatrix.array as Float32Array
  const vmCol = vmBits.instanceColor!.array as Float32Array
  const fsmGroups: THREE.Group[] = []
  const vmGroups: THREE.Group[] = []

  const rowFree = new Float32Array(rowTotal)
  const rowVm = new Float32Array(rowTotal)
  const fsmFlash = new Float32Array(rowTotal)
  const vmFlash = new Float32Array(rowTotal)

  for (let ti = 0; ti < N_TABLES; ti++) {
    const tx = tableX(ti)
    const fsmOne = new THREE.Group()
    fsmOne.name = `storage.fsm.${TABLES[ti].id}`
    const fsmProxy = new THREE.Mesh(gUnit, mPick)
    fsmProxy.position.set(tx - PANEL_X, ROOF_Y + 1.8, FILE_Z0 + (rowCap[ti] * PITCH) / 2)
    fsmProxy.scale.set(2.2, 4.0, rowCap[ti] * PITCH)
    fsmOne.add(fsmProxy)
    fsmGroup.add(fsmOne)
    fsmGroups.push(fsmOne)

    const vmOne = new THREE.Group()
    vmOne.name = `storage.vm.${TABLES[ti].id}`
    const vmProxy = new THREE.Mesh(gUnit, mPick)
    vmProxy.position.set(tx + PANEL_X, ROOF_Y + 0.4, FILE_Z0 + (rowCap[ti] * PITCH) / 2)
    vmProxy.scale.set(2.2, 1.2, rowCap[ti] * PITCH)
    vmOne.add(vmProxy)
    vmGroup.add(vmOne)
    vmGroups.push(vmOne)

    for (let r = 0; r < rowCap[ti]; r++) {
      const ri = rowBase[ti] + r
      const z = FILE_Z0 + (r + 0.5) * PITCH
      setTRS(fsmMat, ri, tx - PANEL_X, ROOF_Y + 0.05, z, 0.001, 0.001, 0.001)
      setTRS(vmMat, ri, tx + PANEL_X, ROOF_Y + 0.12, z, 0.001, 1, 0.001)
    }
  }
  fsmBars.instanceMatrix.needsUpdate = true
  vmBits.instanceMatrix.needsUpdate = true

  /* Warehouse shells. Each one is a real mesh so it can be picked and so its
   * length can follow the file; the blueprint outlines share one line mesh. */
  const bodyMeshes: THREE.Mesh[] = []
  const roofProxies: THREE.Mesh[] = []
  const tableGroups: THREE.Group[] = []
  const bodyH = ROOF_Y - FLOOR_Y

  const edgePos = new Float32Array(N_TABLES * 24 * 3)
  const gEdges = keep(new THREE.BufferGeometry())
  const edgeAttr = new THREE.BufferAttribute(edgePos, 3)
  edgeAttr.setUsage(THREE.DynamicDrawUsage)
  gEdges.setAttribute('position', edgeAttr)
  const heapEdges = new THREE.LineSegments(gEdges, theme.line(COLOR.gridBright, 0.34))
  heapEdges.frustumCulled = false
  heapEdges.raycast = () => {}
  heapGroup.add(heapEdges)

  for (let ti = 0; ti < N_TABLES; ti++) {
    const tx = tableX(ti)
    const g = new THREE.Group()
    g.name = `storage.table.${TABLES[ti].id}`
    heapGroup.add(g)
    tableGroups.push(g)

    const len0 = rowsBase[ti] * PITCH
    const body = new THREE.Mesh(gUnit, mStruct)
    body.position.set(tx, FLOOR_Y + bodyH / 2, FILE_Z0 + len0 / 2)
    body.scale.set(HALF_W * 2, bodyH, len0)
    g.add(body)
    bodyMeshes.push(body)
    writeBoxEdges(edgePos, ti, tx, FLOOR_Y + bodyH / 2, FILE_Z0 + len0 / 2, HALF_W, bodyH / 2, len0 / 2)

    // Roof collider: the tiles live in a shared mesh, so give the picker a box.
    const proxy = new THREE.Mesh(gUnit, mPick)
    proxy.position.set(tx, ROOF_Y + 1.2, FILE_Z0 + len0 / 2)
    proxy.scale.set(HALF_W * 2 + 1, 3.4, len0)
    proxy.userData.anatomyPart = 'page'
    g.add(proxy)
    roofProxies.push(proxy)

    /* --- fixed architecture on the relation's slot ---------------------- */

    // Service walkways down both flanks, with handrail posts.
    for (const s of [-1, 1]) {
      addBox(boxHi, tx + s * (HALF_W + 0.75), ROOF_Y - 1.4, (SLOT_Z0 + SLOT_Z1) / 2, 1.5, 0.3, SLOT_Z1 - SLOT_Z0)
      for (let z = SLOT_Z0 + 3; z < SLOT_Z1; z += 6.4) {
        addBox(boxHi, tx + s * (HALF_W + 1.35), ROOF_Y - 0.6, z, 0.22, 1.6, 0.22)
      }
    }
    // Recessed bands + vents on the long faces: the building has a section.
    for (let z = SLOT_Z0 + 5; z < SLOT_Z1 - 4; z += 9.5) {
      for (const s of [-1, 1]) {
        addBox(boxLo, tx + s * (HALF_W + 0.18), FLOOR_Y + bodyH * 0.42, z, 0.5, bodyH * 0.5, 2.2)
        addBox(boxHi, tx + s * (HALF_W + 0.3), FLOOR_Y + 4.2, z, 0.35, 2.4, 4.4)
      }
    }
    // Ground-level plinth so the shell does not just meet the floor plane.
    addBox(boxLo, tx, FLOOR_Y + 0.55, (SLOT_Z0 + SLOT_Z1) / 2, HALF_W * 2 + 3, 1.1, SLOT_Z1 - SLOT_Z0)

    /* --- the gantry: where the I/O conduit lands ------------------------ */
    const gz0 = SLOT_Z0
    const gz1 = -52 // stops clear of the plaza column at z = -44
    const legH = GANTRY_Y - 0.45 - ROOF_Y
    for (const s of [-1, 1]) {
      addBox(boxHi, tx + s * (HALF_W + 1.2), GANTRY_Y, (gz0 + gz1) / 2, 1.0, 0.9, gz1 - gz0)
      for (let z = gz0 + 4; z < gz1; z += 10.5) {
        addBox(boxHi, tx + s * (HALF_W + 1.2), ROOF_Y + legH / 2, z, 0.6, legH, 0.6)
      }
    }
    // Transverse bridge and the head house the conduit actually plugs into.
    addBox(boxHi, tx, GANTRY_Y, -60, (HALF_W + 1.7) * 2, 0.8, 2.6)
    addBox(boxHi, tx, GANTRY_Y - 1.7, -60, 5.2, 2.6, 4.6)
  }

  // Column bases where the shared-memory plaza lands on the storage floor.
  for (const px of PYL_X) {
    for (const pz of PYL_Z) {
      addBox(boxLo, px, FLOOR_Y + 0.6, pz, 10, 1.2, 10)
      addBox(boxHi, px, FLOOR_Y + 1.5, pz, 8.4, 0.7, 8.4)
    }
  }

  /* Vacuum front: the blade that sweeps a heap while a worker is scanning it. */
  const vacBlades = instanced(gRiser, mData, N_TABLES)
  heapGroup.add(vacBlades)
  const vacMat = vacBlades.instanceMatrix.array as Float32Array
  const vacCol = vacBlades.instanceColor!.array as Float32Array
  for (let i = 0; i < N_TABLES; i++) setTRS(vacMat, i, tableX(i), ROOF_Y, FILE_Z0, 0.001, 0.001, 0.001)

  /* ======================================================== 3. INDEXES */

  interface IdxSlot {
    table: number
    id: string
    name: string
    gin: boolean
    pages: number
    x: number
    z: number
    group: THREE.Group
  }
  const idx: IdxSlot[] = []
  const idxOfTable: number[][] = []
  let btrees = 0

  for (let ti = 0; ti < N_TABLES; ti++) {
    const defs = TABLES[ti].indexes
    const list: number[] = []
    for (let k = 0; k < defs.length; k++) {
      const d = defs[k]
      const ix = tableX(ti)
      const iz = indexPos(ti)[2] + (k === 0 ? 4 : -18) // second index sits in front
      const g = new THREE.Group()
      g.name = `storage.index.${d.id}`
      group.add(g)
      list.push(idx.length)
      idx.push({ table: ti, id: d.id, name: d.name, gin: d.kind === 'gin', pages: d.pages, x: ix, z: iz, group: g })
      if (d.kind !== 'gin') btrees++
    }
    idxOfTable.push(list)
  }

  const idxNodes = instanced(gRiser, mData, btrees * NODES_PER_TREE)
  idxNodes.raycast = () => {}
  group.add(idxNodes)
  const nodeMat = idxNodes.instanceMatrix.array as Float32Array
  const nodeCol = idxNodes.instanceColor!.array as Float32Array
  const nodeHeat = new Float32Array(btrees * NODES_PER_TREE)
  /** World position of every node, for the struts and the pick proxies. */
  const nodePos = new Float32Array(btrees * NODES_PER_TREE * 3)

  const strutN = btrees * STRUTS_PER_TREE
  const strutPos = new Float32Array(strutN * 6)
  const strutCol = new Float32Array(strutN * 6)
  const gStrut = keep(new THREE.BufferGeometry())
  {
    const pa = new THREE.BufferAttribute(strutPos, 3)
    const ca = new THREE.BufferAttribute(strutCol, 3)
    ca.setUsage(THREE.DynamicDrawUsage)
    gStrut.setAttribute('position', pa)
    gStrut.setAttribute('color', ca)
  }
  const struts = new THREE.LineSegments(gStrut, mIndexLine)
  struts.frustumCulled = false
  struts.raycast = () => {}
  group.add(struts)
  const strutHeat = new Float32Array(strutN)
  const strutColAttr = gStrut.getAttribute('color') as THREE.BufferAttribute

  const idxMasts = instanced(gCyl, mStructHi, idx.length)
  idxMasts.name = 'storage.index.masts'
  idxMasts.instanceColor = null
  group.add(idxMasts)

  // Every heap and every non-hash index has its own _fsm fork. These short
  // strips sit on the index plinths so page reuse is not depicted as heap-only.
  const IDX_FSM_BITS = 6
  const idxFsm = instanced(gRiser, mData, idx.length * IDX_FSM_BITS)
  group.add(idxFsm)
  const idxFsmMat = idxFsm.instanceMatrix.array as Float32Array
  const idxFsmCol = idxFsm.instanceColor!.array as Float32Array
  for (let s = 0; s < idx.length; s++) {
    const it = idx[s]
    for (let i = 0; i < IDX_FSM_BITS; i++) {
      setTRS(idxFsmMat, s * IDX_FSM_BITS + i, it.x + (i - 2.5) * 2.8, FLOOR_Y + 1.4, it.z + 4.2, 1.6, 0.2, 0.75)
    }
  }
  idxFsm.instanceMatrix.needsUpdate = true

  const ginEntries = instanced(gRiser, mData, GIN_ENTRIES + GIN_LISTS)
  ginEntries.raycast = () => {}
  group.add(ginEntries)
  const ginMat = ginEntries.instanceMatrix.array as Float32Array
  const ginCol = ginEntries.instanceColor!.array as Float32Array
  const ginHeat = new Float32Array(GIN_ENTRIES + GIN_LISTS)
  const GIN_TREE_N = 4
  const ginTreeNodes = instanced(gRiser, mData, GIN_TREE_N)
  group.add(ginTreeNodes)
  const ginTreeMat = ginTreeNodes.instanceMatrix.array as Float32Array
  const ginTreeCol = ginTreeNodes.instanceColor!.array as Float32Array
  const ginTreeHeat = new Float32Array(GIN_TREE_N)
  for (let i = 0; i < GIN_TREE_N; i++) setTRS(ginTreeMat, i, 0, FLOOR_Y, 0, 0.001, 0.001, 0.001)

  /** slot -> tree number (btree only), or -1 for the GIN. */
  const treeOf = new Int32Array(idx.length).fill(-1)
  const baseLeafCount = new Uint8Array(idx.length)
  const liveLeafCount = new Uint8Array(idx.length)
  const tableBaseIndexPages = new Float32Array(N_TABLES)
  for (let ti = 0; ti < N_TABLES; ti++) {
    const defs = TABLES[ti].indexes
    for (let i = 0; i < defs.length; i++) tableBaseIndexPages[ti] += defs[i].pages
  }
  {
    let tree = 0
    const mastArr = idxMasts.instanceMatrix.array as Float32Array
    for (let s = 0; s < idx.length; s++) {
      const it = idx[s]
      addBox(boxLo, it.x, FLOOR_Y + 0.5, it.z, 22, 1.0, 10)
      addBox(boxHi, it.x, FLOOR_Y + 1.15, it.z, 19, 0.4, 8)
      setTRS(mastArr, s, it.x, FLOOR_Y + (ROOT_Y - FLOOR_Y) / 2 + 1, it.z, 0.7, ROOT_Y - FLOOR_Y - 2, 0.7)
      // The index mast starts 2 m above the storage floor: clear at a walk,
      // but inside a 1.8 m capsule during a normal jump.
      collisionBoxes.push(
        new THREE.Box3(
          new THREE.Vector3(it.x - 0.7, FLOOR_Y + 2, it.z - 0.7),
          new THREE.Vector3(it.x + 0.7, ROOT_Y, it.z + 0.7),
        ),
      )

      const proxy = new THREE.Mesh(gUnit, mPick)
      proxy.position.set(it.x, (FLOOR_Y + ROOT_Y) / 2 + 2, it.z)
      proxy.scale.set(22, ROOT_Y - FLOOR_Y + 4, 10)
      it.group.add(proxy)

      if (it.gin) {
        // GIN gets a short entry B-tree below, fanning into posting structures.
        addBox(boxHi, it.x, LEAF_Y + 1.2, it.z, 20, 1.0, 7)
        continue
      }
      const baseLeaves = clamp(
        Math.round(5 + Math.sqrt(it.pages / INDEX_PAGES_PER_VISUAL_PAGE) / 3),
        6,
        10,
      )
      baseLeafCount[s] = baseLeaves
      liveLeafCount[s] = baseLeaves
      treeOf[s] = tree
      const nb = tree * NODES_PER_TREE
      const put = (n: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
        setTRS(nodeMat, nb + n, x, y, z, sx, sy, sz)
        nodePos[(nb + n) * 3] = x
        nodePos[(nb + n) * 3 + 1] = y + sy
        nodePos[(nb + n) * 3 + 2] = z
      }
      put(0, it.x, ROOT_Y, it.z, 3.4, 1.0, 2.6)
      for (let i = 0; i < 4; i++) put(1 + i, it.x + (i - 1.5) * 4.6, INNER_Y, it.z, 2.6, 0.9, 2.1)
      for (let i = 0; i < LEAVES; i++) {
        put(5 + i, it.x + (i - (LEAVES - 1) / 2) * LEAF_PITCH, LEAF_Y, it.z, 1.3, 0.8, 1.8)
      }

      const sb = tree * STRUTS_PER_TREE
      const link = (n: number, a: number, b: number, dz: number) => {
        const o = (sb + n) * 6
        strutPos[o] = nodePos[(nb + a) * 3]
        strutPos[o + 1] = nodePos[(nb + a) * 3 + 1] - (a === 0 ? 1.0 : 0.9)
        strutPos[o + 2] = nodePos[(nb + a) * 3 + 2] + dz
        strutPos[o + 3] = nodePos[(nb + b) * 3]
        strutPos[o + 4] = nodePos[(nb + b) * 3 + 1]
        strutPos[o + 5] = nodePos[(nb + b) * 3 + 2] + dz
      }
      for (let i = 0; i < 4; i++) link(i, 0, 1 + i, 0)
      for (let i = 0; i < LEAVES; i++) link(4 + i, 1 + Math.floor(i / 3), 5 + i, 0)
      // The leaf level is a doubly linked list — that is why range scans are cheap.
      for (let i = 0; i < LEAVES - 1; i++) {
        const o = (sb + 4 + LEAVES + i) * 6
        const a = nb + 5 + i
        const b = nb + 6 + i
        strutPos[o] = nodePos[a * 3]
        strutPos[o + 1] = LEAF_Y + 0.35
        strutPos[o + 2] = nodePos[a * 3 + 2] + 1.15
        strutPos[o + 3] = nodePos[b * 3]
        strutPos[o + 4] = LEAF_Y + 0.35
        strutPos[o + 5] = nodePos[b * 3 + 2] + 1.15
      }
      tree++
    }
    idxNodes.instanceMatrix.needsUpdate = true
    idxMasts.instanceMatrix.needsUpdate = true
  }

  /* GIN layout: a short entry B-tree over a fan of posting lists. */
  const ginSlot = idx.findIndex((i) => i.gin)
  if (ginSlot >= 0) {
    const it = idx[ginSlot]
    setTRS(ginTreeMat, 0, it.x, ROOT_Y, it.z, 3.4, 1.0, 2.6)
    for (let i = 0; i < 3; i++) {
      setTRS(ginTreeMat, 1 + i, it.x + (i - 1) * 6.2, INNER_Y, it.z, 2.8, 0.9, 2.1)
    }
    ginTreeNodes.instanceMatrix.needsUpdate = true

    const linePos = new Float32Array(6 * 6)
    let lo = 0
    for (let i = 0; i < 3; i++) {
      const ix = it.x + (i - 1) * 6.2
      linePos[lo++] = it.x; linePos[lo++] = ROOT_Y + 1; linePos[lo++] = it.z
      linePos[lo++] = ix; linePos[lo++] = INNER_Y + 0.9; linePos[lo++] = it.z
      linePos[lo++] = ix; linePos[lo++] = INNER_Y; linePos[lo++] = it.z
      linePos[lo++] = it.x + (i - 1) * 6.2; linePos[lo++] = LEAF_Y + 2.0; linePos[lo++] = it.z
    }
    const ginTreeLinesGeo = keep(new THREE.BufferGeometry())
    ginTreeLinesGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3))
    const ginTreeLines = new THREE.LineSegments(ginTreeLinesGeo, theme.line(COLOR.index, 0.42))
    ginTreeLines.raycast = () => {}
    group.add(ginTreeLines)

    for (let i = 0; i < GIN_ENTRIES; i++) {
      const c = i % 16
      const r = Math.floor(i / 16)
      setTRS(ginMat, i, it.x + (c - 7.5) * 1.18, LEAF_Y + 1.7, it.z + (r - 1) * 1.9, 0.86, 0.3, 1.35)
    }
    for (let i = 0; i < GIN_LISTS; i++) {
      setTRS(ginMat, GIN_ENTRIES + i, it.x + (i - 5.5) * 1.55, LEAF_Y - 3.4, it.z + 3.6, 0.42, 2.6, 0.42)
    }
    ginEntries.instanceMatrix.needsUpdate = true
  }

  /* Index probe pool: root → internal → leaf, then down to the heap page. */
  const pTable = new Int32Array(MAX_PROBES).fill(-1)
  const pSlot = new Int32Array(MAX_PROBES)
  const pLeaf = new Int32Array(MAX_PROBES)
  const pTile = new Int32Array(MAX_PROBES)
  const pAge = new Float32Array(MAX_PROBES)
  const pKind = new Uint8Array(MAX_PROBES) // 0 = scan, 1 = index insert (non-HOT)
  const pFired = new Uint8Array(MAX_PROBES)
  let pNext = 0

  /* ========================================================== 4. TOAST */

  const toastGroup = new THREE.Group()
  toastGroup.name = 'storage.toast'
  group.add(toastGroup)
  /** Which relation owns the sidecar. Only tables with def.toast have one. */
  const toastTable = TABLES.findIndex((d) => d.toast === true)

  const SILOS = 4
  addBox(boxLo, ANCHOR.toastYard[0], FLOOR_Y + 0.6, ANCHOR.toastYard[2], 30, 1.2, 22)
  const gSilo = keep(withWhite(new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).translate(0, 0.5, 0)))
  const siloShell = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(3.3, 3.6, 13, 14)), mStruct, SILOS)
  siloShell.instanceColor = null
  {
    const a = siloShell.instanceMatrix.array as Float32Array
    for (let i = 0; i < SILOS; i++) setTRS(a, i, (i - 1.5) * 8, FLOOR_Y + 7.7, 4, 1, 1, 1)
    siloShell.instanceMatrix.needsUpdate = true
  }
  siloShell.position.set(ANCHOR.toastYard[0], 0, ANCHOR.toastYard[2])
  toastGroup.add(siloShell)

  const siloFill = instanced(gSilo, mData, SILOS)
  siloFill.position.set(ANCHOR.toastYard[0], 0, ANCHOR.toastYard[2])
  toastGroup.add(siloFill)
  const siloMat = siloFill.instanceMatrix.array as Float32Array
  const siloCol = siloFill.instanceColor!.array as Float32Array

  // Intake gantry: values arrive here, get compressed as one datum, then the
  // shortened datum is sliced and filed.
  addBox(boxHi, ANCHOR.toastYard[0], FLOOR_Y + 9.2, ANCHOR.toastYard[2] - 7, 26, 0.7, 1.4)
  for (const s of [-1, 1]) addBox(boxHi, ANCHOR.toastYard[0] + s * 12, FLOOR_Y + 4.6, ANCHOR.toastYard[2] - 7, 0.7, 8.6, 0.7)

  const toastBits = instanced(gRiser, mData, TOAST_SLOTS * (1 + TOAST_CHUNKS))
  toastBits.position.set(ANCHOR.toastYard[0], 0, ANCHOR.toastYard[2])
  toastGroup.add(toastBits)
  const tbMat = toastBits.instanceMatrix.array as Float32Array
  const tbCol = toastBits.instanceColor!.array as Float32Array
  const tAge = new Float32Array(TOAST_SLOTS).fill(-1)

  {
    const proxy = new THREE.Mesh(gUnit, mPick)
    proxy.position.set(ANCHOR.toastYard[0], FLOOR_Y + 8, ANCHOR.toastYard[2])
    proxy.scale.set(32, 18, 24)
    toastGroup.add(proxy)
  }

  /* ================================================== 5. OS PAGE CACHE */

  const osGroup = new THREE.Group()
  osGroup.name = 'os.cache'
  group.add(osGroup)

  const osTiles = instanced(gFlat, mVolume, OC_N)
  osGroup.add(osTiles)
  const osMat = osTiles.instanceMatrix.array as Float32Array
  const osCol = osTiles.instanceColor!.array as Float32Array
  const osHole = new Uint8Array(OC_N)
  const osResident = new Float32Array(OC_N)
  const osDirty = new Float32Array(OC_N)
  const osFlash = new Float32Array(OC_N)
  const osKind = new Uint8Array(OC_N)

  const ocX = (c: number) => (c - (OC_COLS - 1) / 2) * OC_PITCH
  const ocZ = (r: number) => (r - (OC_ROWS - 1) / 2) * OC_PITCH
  for (let r = 0; r < OC_ROWS; r++) {
    for (let c = 0; c < OC_COLS; c++) {
      const i = r * OC_COLS + c
      const x = ocX(c)
      const z = ocZ(r)
      // The kernel's cache is not under Postgres's control: it is full of holes.
      let hole = rng() < 0.17 ? 1 : 0
      for (const px of PYL_X) for (const pz of PYL_Z) if (Math.abs(x - px) < 7 && Math.abs(z - pz) < 7) hole = 1
      osHole[i] = hole
      osResident[i] = hole ? 0 : rng() * 0.35
      setTRS(osMat, i, x, OC_Y, z, hole ? 0.001 : OC_TILE, 1, hole ? 0.001 : OC_TILE)
    }
  }
  osTiles.instanceMatrix.needsUpdate = true

  // A frame, so the slab reads as a layer and not as floating confetti.
  {
    const w = OC_COLS * OC_PITCH
    const d = OC_ROWS * OC_PITCH
    addBox(boxLo, 0, OC_Y - 0.35, -d / 2, w + 2, 0.7, 1.2)
    addBox(boxLo, 0, OC_Y - 0.35, d / 2, w + 2, 0.7, 1.2)
    addBox(boxLo, -w / 2, OC_Y - 0.35, 0, 1.2, 0.7, d)
    addBox(boxLo, w / 2, OC_Y - 0.35, 0, 1.2, 0.7, d)
    const gFrame = keep(new THREE.BoxGeometry(w + 2, 0.7, d + 2))
    const fe = theme.edges(gFrame, COLOR.gridBright, 0.28)
    fe.position.set(0, OC_Y - 0.35, 0)
    osGroup.add(fe)
  }

  // A dedicated durability plane separates volatile kernel memory from the
  // filesystem. The excavation rim at y=0 is only PostgreSQL's address-space
  // boundary; it no longer has to pretend the kernel page cache is durable.
  const durabilityGroup = new THREE.Group()
  durabilityGroup.name = 'storage.durability'
  group.add(durabilityGroup)
  {
    const w = CITY.osCache.w + 8
    const d = CITY.osCache.d + 8
    const gPlane = keep(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2))
    const mPlane = keep(
      new THREE.MeshBasicMaterial({
        color: COLOR.storage,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    const plane = new THREE.Mesh(gPlane, mPlane)
    plane.position.y = CITY.durability.y
    plane.renderOrder = 2
    plane.raycast = () => {}
    durabilityGroup.add(plane)

    const frameGeo = keep(new THREE.BoxGeometry(w, 0.5, d))
    const frame = theme.edges(frameGeo, COLOR.storage, 0.9)
    frame.position.y = CITY.durability.y
    frame.raycast = () => {}
    durabilityGroup.add(frame)

    const tex = theme.textTexture('MEMORY ENDS  /  DISK BEGINS', {
      size: 68,
      color: '#57e389',
      letterSpacing: '3px',
    })
    const img = tex.image as { width: number; height: number }
    const mLabel = keep(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }))
    const gLabel = keep(new THREE.PlaneGeometry(1, 1))
    for (const side of [-1, 1]) {
      const label = new THREE.Mesh(gLabel, mLabel)
      label.scale.set(42, 42 / Math.max(1, img.width / img.height), 1)
      label.position.set(0, CITY.durability.y + 1.8, side * (d / 2 + 0.2))
      label.rotation.y = side < 0 ? Math.PI : 0
      label.raycast = () => {}
      durabilityGroup.add(label)
    }
  }

  /* ==================================================== 6. DISK ARRAY */

  const diskGroup = new THREE.Group()
  diskGroup.name = 'disk.array'
  group.add(diskGroup)

  const rackH = RACK_TOP - PIT_FLOOR_Y
  const CABS = 6
  for (let i = 0; i < CABS; i++) {
    const x = (i - (CABS - 1) / 2) * (RACK_W / CABS)
    const bodyW = RACK_W / CABS - 1.4
    const trimW = RACK_W / CABS - 1.0
    addBox(boxLo, x, PIT_FLOOR_Y + rackH / 2, RACK_Z, bodyW, rackH, RACK_D)
    addBox(boxHi, x, PIT_FLOOR_Y + rackH + 0.4, RACK_Z, trimW, 0.8, RACK_D + 0.8)
    addBox(boxHi, x, PIT_FLOOR_Y + 0.5, RACK_Z, trimW, 1.0, RACK_D + 0.8)
  }
  {
    const gRack = keep(new THREE.BoxGeometry(RACK_W, rackH, RACK_D))
    const re = theme.edges(gRack, COLOR.gridBright, 0.3)
    re.position.set(0, PIT_FLOOR_Y + rackH / 2, RACK_Z)
    diskGroup.add(re)
    // The cabinets live in the shared structure mesh, so the rack needs its
    // own collider or only the drive LEDs would be clickable.
    const proxy = new THREE.Mesh(gUnit, mPick)
    proxy.position.copy(re.position)
    proxy.scale.set(RACK_W, rackH, RACK_D + 1)
    diskGroup.add(proxy)
  }

  const drives = instanced(gRiser, mData, N_DRIVES)
  diskGroup.add(drives)
  const driveMat = drives.instanceMatrix.array as Float32Array
  const driveCol = drives.instanceColor!.array as Float32Array
  const ledHeat = new Float32Array(N_DRIVES)
  const ledKind = new Uint8Array(N_DRIVES)
  const driveZ = RACK_Z - RACK_D / 2 - 0.35
  for (let i = 0; i < N_DRIVES; i++) {
    const c = i % DRIVE_COLS
    const r = Math.floor(i / DRIVE_COLS)
    const x = (c - (DRIVE_COLS - 1) / 2) * (RACK_W / DRIVE_COLS)
    const y = PIT_FLOOR_Y + 2.4 + r * ((rackH - 4) / DRIVE_ROWS)
    setTRS(driveMat, i, x, y, driveZ, RACK_W / DRIVE_COLS - 1.1, 0.55, 0.4)
  }
  drives.instanceMatrix.needsUpdate = true

  const gFsync = keep(new THREE.BoxGeometry(RACK_W * 0.5, 0.6, 0.6))
  const mFsync = keep(new THREE.MeshBasicMaterial({ color: 0x2a1a24, toneMapped: false }))
  const fsyncBar = new THREE.Mesh(gFsync, mFsync)
  fsyncBar.position.set(0, RACK_TOP + 1.5, driveZ)
  diskGroup.add(fsyncBar)

  /* ================================================= 7. I/O CONDUITS */

  {
    const tubeGeos: THREE.TubeGeometry[] = []
    const collar: number[] = [] // x,y,z, qx,qy,qz,qw
    // Stop just under the shared-memory deck: the riser has to visibly reach
    // the plaza it feeds, without punching through its underside.
    const yTop = -2.6
    for (let ti = 0; ti < N_TABLES; ti++) {
      for (const routeId of [rid.ioRead(ti), rid.ioWrite(ti)]) {
        const curve = routeCurve(routeId)
        if (!curve) continue
        const pts = curve.getPoints(56)
        const sub: THREE.Vector3[] = []
        for (const p of pts) if (p.y <= yTop) sub.push(p)
        if (sub.length < 3) continue
        const c2 = new THREE.CatmullRomCurve3(sub, false, 'catmullrom', 0.4)
        const tube = new THREE.TubeGeometry(c2, 22, 1.15, 6, false)
        tubeGeos.push(tube)
        for (let k = 0; k <= 5; k++) {
          const u = k / 5
          c2.getPointAt(u, _v)
          c2.getTangentAt(u, _v2).normalize()
          _quat.setFromUnitVectors(_axisY, _v2)
          collar.push(_v.x, _v.y, _v.z, _quat.x, _quat.y, _quat.z, _quat.w)
        }
      }
    }

    let vTotal = 0
    let iTotal = 0
    for (const g of tubeGeos) {
      vTotal += g.attributes.position.count
      iTotal += g.index ? g.index.count : 0
    }
    const pos = new Float32Array(vTotal * 3)
    const nor = new Float32Array(vTotal * 3)
    const ind = new Uint32Array(iTotal)
    let vo = 0
    let io = 0
    for (const g of tubeGeos) {
      const p = g.attributes.position.array as Float32Array
      const n = g.attributes.normal.array as Float32Array
      pos.set(p, vo * 3)
      nor.set(n, vo * 3)
      const gi = g.index!.array as ArrayLike<number>
      for (let k = 0; k < gi.length; k++) ind[io + k] = gi[k] + vo
      vo += g.attributes.position.count
      io += gi.length
      g.dispose()
    }
    const gConduit = keep(new THREE.BufferGeometry())
    gConduit.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    gConduit.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    gConduit.setIndex(new THREE.BufferAttribute(ind, 1))
    const conduit = new THREE.Mesh(gConduit, mStructLo)
    conduit.frustumCulled = false
    conduit.raycast = () => {}
    group.add(conduit)

    const nCollar = collar.length / 7
    const gCollar = keep(new THREE.CylinderGeometry(1.6, 1.6, 0.8, 8, 1, true))
    const collars = new THREE.InstancedMesh(gCollar, mStructHi, nCollar)
    collars.name = 'storage.io.collars'
    collars.instanceColor = null
    collars.frustumCulled = false
    const ca = collars.instanceMatrix.array as Float32Array
    for (let i = 0; i < nCollar; i++) {
      const o = i * 7
      _pos.set(collar[o], collar[o + 1], collar[o + 2])
      _quat.set(collar[o + 3], collar[o + 4], collar[o + 5], collar[o + 6])
      _scale.set(1, 1, 1)
      _mat4.compose(_pos, _quat, _scale)
      _mat4.toArray(ca, i * 16)
    }
    collars.instanceMatrix.needsUpdate = true
    group.add(collars)
  }

  /* ============================================== bake the static boxes */

  /** Fine detail: dropped when the camera pulls back. */
  const fine = new THREE.Group()
  group.add(fine)

  const structLo = new THREE.InstancedMesh(gUnit, mStructLo, Math.max(1, boxLo.length / 6))
  const structHi = new THREE.InstancedMesh(gUnit, mStructHi, Math.max(1, boxHi.length / 6))
  for (const [arr, mesh, parent] of [[boxLo, structLo, group], [boxHi, structHi, fine]] as const) {
    const a = mesh.instanceMatrix.array as Float32Array
    for (let i = 0; i < arr.length / 6; i++) {
      setTRS(a, i, arr[i * 6], arr[i * 6 + 1], arr[i * 6 + 2], arr[i * 6 + 3], arr[i * 6 + 4], arr[i * 6 + 5])
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor = null
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    parent.add(mesh)
  }
  for (const [boxes, passable] of [
    [boxLo, passableBoxLo],
    [boxHi, passableBoxHi],
  ] as const) {
    for (let i = 0; i < boxes.length; i += 6) {
      if (passable.has(i)) continue
      const x = boxes[i]
      const y = boxes[i + 1]
      const z = boxes[i + 2]
      const sx = boxes[i + 3]
      const sy = boxes[i + 4]
      const sz = boxes[i + 5]
      collisionBoxes.push(
        new THREE.Box3(
          new THREE.Vector3(x - sx / 2, y - sy / 2, z - sz / 2),
          new THREE.Vector3(x + sx / 2, y + sy / 2, z + sz / 2),
        ),
      )
    }
  }
  group.userData.collisionBoxes = collisionBoxes

  /* ============================================================ 8. STATE */

  const readEvents = new Float32Array(N_TABLES)
  const diskReadEvents = new Float32Array(N_TABLES)
  const cacheReadEvents = new Float32Array(N_TABLES)
  const writeEvents = new Float32Array(N_TABLES)
  const routeKind = new Map<string, number>()
  for (let ti = 0; ti < N_TABLES; ti++) {
    routeKind.set(rid.ioRead(ti), ti * 3)
    routeKind.set(rid.ioReadCache(ti), ti * 3 + 1)
    routeKind.set(rid.ioWrite(ti), ti * 3 + 2)
  }
  const offFlow = ctx.bus.on('flow', (req: FlowRequest) => {
    const k = routeKind.get(req.route)
    if (k === undefined) return
    const ti = (k / 3) | 0
    const kind = k % 3
    if (kind === 2) {
      writeEvents[ti] += 1
    } else {
      readEvents[ti] += 1
      if (kind === 0) diskReadEvents[ti] += 1
      else cacheReadEvents[ti] += 1
    }
  })

  const prevIdxScans = new Float32Array(N_TABLES)
  const prevUpdates = new Float32Array(N_TABLES)
  const prevHot = new Float32Array(N_TABLES)
  const prevInserts = new Float32Array(N_TABLES)
  const prevPages = new Float32Array(N_TABLES)
  const scanBudget = new Float32Array(N_TABLES)
  const idxWriteBudget = new Float32Array(N_TABLES)
  const hotBudget = new Float32Array(N_TABLES)
  const insBudget = new Float32Array(N_TABLES)
  const updBudget = new Float32Array(N_TABLES)
  const vacHeat = new Float32Array(N_TABLES)
  /** Insert-triggered vacuum (PG13+): timer, and the sweep it is running. */
  const insVacT = new Float32Array(N_TABLES)
  const insVacFront = new Float32Array(N_TABLES).fill(-1)
  const rowsPrev = new Int32Array(N_TABLES).fill(-1)
  const tilesUsed = new Int32Array(N_TABLES)
  const vmCover = new Float32Array(N_TABLES)
  const idxBloat = new Float32Array(N_TABLES)
  const fsmPick = new Int32Array(N_TABLES)

  let osHitRatio = 0.5
  let osResidentPct = 0
  let ledBudget = 0
  let fsyncGlow = 0
  let toastChunks = 0
  let toastBytes = 0
  let siloLevel = 0
  let toastSpawn = 0

  /* ========================================================= REGISTRATION */

  const totalPages = (s: SimState) => {
    let n = 0
    for (let i = 0; i < s.tables.length; i++) n += s.tables[i].pages
    return n
  }
  const liveIndexPages = (s: SimState, it: IdxSlot) =>
    s.tables[it.table].indexPages * (it.pages / Math.max(1, tableBaseIndexPages[it.table]))

  ctx.register({
    id: 'storage.datadir',
    name: 'Data directory',
    role: 'aggregate heap-page projection · no filesystem or relation forks',
    kind: 'storage',
    district: 'storage',
    object: dirGroup,
    tier: 0,
    color: COLOR.storage,
    focus: { target: [0, FLOOR_Y + 6, -20], distance: 250, dir: [0.26, 0.62, 0.74] },
    labelAt: [0, FLOOR_Y + 4, 62],
    readout: (s) => `${fmtNum(totalPages(s))} aggregate pages · ${fmtBytes(totalPages(s) * 8192)} in ${s.tables.length} modeled tables`,
  })

  ctx.register({
    id: 'storage.tempfiles',
    name: 'base/pgsql_tmp',
    role: 'modeled Sort and HashAggregate spill files · joins absent',
    kind: 'storage',
    district: 'storage',
    object: tempBayGroup,
    tier: 1,
    color: COLOR.vacuum,
    focus: { target: [0, FLOOR_Y + 2, -89], distance: 150, dir: [0.1, 0.55, -0.83] },
    labelAt: [0, FLOOR_Y + 5, -89],
    readout: (s) => `${s.workMem.spillingNodes} nodes spilling now · ${fmtBytes(s.workMem.liveTempBytes)} live · ${fmtNum(s.workMem.tempFiles)} temp_files / ${fmtBytes(s.workMem.tempBytes)} temp_bytes cumulative`,
  })

  for (let ti = 0; ti < N_TABLES; ti++) {
    const def = TABLES[ti]
    const tx = tableX(ti)
    ctx.register({
      id: `storage.table.${def.id}`,
      name: def.name,
      role: 'aggregate page and row-version counts · no page layout',
      kind: 'storage',
      district: 'storage',
      object: tableGroups[ti],
      tier: 1,
      color: def.color,
      focus: { target: [tx, ROOF_Y - 2, FILE_Z0 + 16], distance: 62, dir: [0.34, 0.56, 0.76] },
      labelAt: [tx, ROOF_Y + 6, FILE_Z0 - 2],
      readout: (s) => {
        const t = s.tables[ti]
        return `${fmtNum(t.pages)} pages · ${fmtBytes(t.pages * 8192)} · ${fmtNum(t.liveTuples)} live / ${fmtNum(
          t.deadTuples,
        )} dead · ${fmtPct(t.bloat, 1)} bloat`
      },
    })
  }

  for (let s = 0; s < idx.length; s++) {
    const it = idx[s]
    ctx.register({
      id: `storage.index.${it.id}`,
      name: it.name,
      role: it.gin ? 'illustrative GIN shape · kind is cosmetic in the model' : 'illustrative B-tree shape · aggregate index state only',
      kind: 'storage',
      district: 'storage',
      object: it.group,
      tier: 2,
      color: COLOR.index,
      focus: {
        target: [it.x, it.gin ? INNER_Y + 1 : LEAF_Y + 3, it.z],
        distance: it.gin ? 46 : 58,
        // Stay inside the excavation for GIN so the shared-memory deck cannot
        // occlude its entry tree and posting structures.
        dir: it.gin ? [0.68, 0.35, 0.65] : [-0.52, 0.72, -0.46],
      },
      labelAt: [it.x, ROOT_Y + 3, it.z],
      readout: (sim) => {
        const t = sim.tables[it.table]
        return `${fmtNum(liveIndexPages(sim, it))} display pages · ${fmtNum(t.idxScans)} table-level index scans · ${fmtPct(
          clamp01(t.bloat * 1.2),
          0,
        )} derived pointer illustration`
      },
    })
  }

  ctx.register({
    id: 'storage.toast',
    name: 'pg_toast',
    role: 'illustrative TOAST route · no modeled chunk storage',
    kind: 'storage',
    district: 'storage',
    object: toastGroup,
    tier: 1,
    color: COLOR.toast,
    focus: { target: [ANCHOR.toastYard[0], FLOOR_Y + 8, ANCHOR.toastYard[2]], distance: 56, dir: [-0.1, 0.5, 0.86] },
    labelAt: [ANCHOR.toastYard[0], FLOOR_Y + 18, ANCHOR.toastYard[2]],
    readout: () => 'illustrative chunks · model records no TOAST chunk count or bytes',
  })

  for (let ti = 0; ti < N_TABLES; ti++) {
    const def = TABLES[ti]
    const tx = tableX(ti)
    ctx.register({
      id: `storage.fsm.${def.id}`,
      name: `${def.name} free space map`,
      role: 'derived _fsm illustration · no modeled map lookup',
      kind: 'storage',
      district: 'storage',
      object: fsmGroups[ti],
      tier: 2,
      color: COLOR.warn,
      focus: { target: [tx - PANEL_X, ROOF_Y + 2, FILE_Z0 + 4], distance: 30, dir: [-0.6, 0.5, 0.62] },
      labelAt: [tx - PANEL_X - 1.5, ROOF_Y + 5, FILE_Z0 + 4],
      readout: (s) => {
        const table = s.tables[ti]
        const cap = table.pages * table.def.tuplesPerPage
        const free = clamp01(1 - (table.liveTuples + table.deadTuples) / Math.max(1, cap))
        return `${fmtPct(free, 1)} derived capacity estimate · no modeled FSM entries`
      },
    })
    ctx.register({
      id: `storage.vm.${def.id}`,
      name: `${def.name} visibility map`,
      role: 'derived _vm illustration · no modeled visibility bits',
      kind: 'storage',
      district: 'storage',
      object: vmGroups[ti],
      tier: 2,
      color: COLOR.ok,
      focus: { target: [tx + PANEL_X, ROOF_Y + 2, FILE_Z0 + 10], distance: 34, dir: [0.62, 0.5, 0.6] },
      labelAt: [tx + PANEL_X + 1.5, ROOF_Y + 5, FILE_Z0 + 10],
      readout: () =>
        `${fmtPct(vmCover[ti], 0)} derived illustration · no modeled visibility bits or index-only plan`,
    })
  }

  ctx.register({
    id: 'os.cache',
    name: 'OS page cache',
    role: 'illustrative cache route · no modeled kernel cache state',
    kind: 'memory',
    district: 'storage',
    object: osGroup,
    tier: 1,
    color: COLOR.bufClean,
    focus: { target: [0, OC_Y, -10], distance: 190, dir: [0.3, 0.42, 0.86] },
    labelAt: [0, OC_Y + 4, -74],
    readout: () =>
      `${fmtPct(osHitRatio, 0)} illustrative route hits · no modeled cache residency or timing effect`,
  })

  ctx.register({
    id: 'storage.durability',
    name: 'Durability boundary',
    role: 'volatile kernel memory ends; durable storage begins',
    kind: 'concept',
    district: 'storage',
    object: durabilityGroup,
    tier: 1,
    color: COLOR.storage,
    focus: { target: [0, CITY.durability.y, 0], distance: 190, dir: [0.3, 0.42, 0.86] },
    labelAt: [0, CITY.durability.y + 2, 82],
    readout: () => `y ${CITY.durability.y.toFixed(1)} · below the OS page cache · above the data directory`,
  })

  ctx.register({
    id: 'disk.array',
    name: 'Storage',
    role: 'illustrative device layer · no calibrated latency or queue',
    kind: 'storage',
    district: 'storage',
    object: diskGroup,
    tier: 1,
    color: COLOR.storage,
    // 96 units is inside the rack volume — frame the platters, do not enter them.
    focus: { target: [0, RACK_TOP - 4, RACK_Z + 10], distance: 205, dir: [0.2, 0.6, 0.78] },
    labelAt: [0, RACK_TOP + 5, RACK_Z],
    readout: diskArrayReadout,
  })

  /* ================================================================ HEAP */

  function updateHeap(dt: number, sim: SimState, t: number): void {
    for (let ti = 0; ti < N_TABLES; ti++) {
      const tb = sim.tables[ti]
      const def = tb.def

      /* --- how long is the file right now ------------------------------ */
      const wantTiles = Math.max(1, Math.ceil(tb.pages / PAGES_PER_TILE))
      const rows = clamp(Math.ceil(wantTiles / COLS), ROWS_MIN, rowCap[ti])
      const used = Math.min(wantTiles, rows * COLS)
      tilesUsed[ti] = used

      const base = tileBase[ti]
      const rb = rowBase[ti]
      const tx = tableX(ti)

      // Rows that vanished (a successful truncate) have to be cleared once.
      if (rows < rowsPrev[ti]) {
        for (let k = rows * COLS; k < rowsPrev[ti] * COLS; k++) {
          tileMat[(base + k) * 16 + 5] = 0.001
          capMat[(base + k) * 16] = 0.001
          capMat[(base + k) * 16 + 10] = 0.001
          tileVm[base + k] = 0
        }
        for (let r = rows; r < rowsPrev[ti]; r++) {
          fsmMat[(rb + r) * 16 + 5] = 0.001
          vmMat[(rb + r) * 16] = 0.001
          vmMat[(rb + r) * 16 + 10] = 0.001
        }
      }
      rowsPrev[ti] = rows

      /* --- write activity: it clears visibility-map bits ---------------- */
      const dIns = Math.max(0, tb.inserts - prevInserts[ti])
      const dUpd = Math.max(0, tb.updates - prevUpdates[ti])
      const dHot = Math.max(0, tb.hotUpdates - prevHot[ti])
      const dScan = Math.max(0, tb.idxScans - prevIdxScans[ti])
      const dPages = tb.pages - prevPages[ti]
      prevInserts[ti] = tb.inserts
      prevUpdates[ti] = tb.updates
      prevHot[ti] = tb.hotUpdates
      prevIdxScans[ti] = tb.idxScans
      prevPages[ti] = tb.pages

      insBudget[ti] = Math.min(insBudget[ti] + dIns * 0.02, 6)
      updBudget[ti] = Math.min(updBudget[ti] + dUpd * 0.03, 8)
      scanBudget[ti] = Math.min(scanBudget[ti] + dScan * 0.05, 4)
      // Only the updates that could NOT be HOT cost index maintenance.
      idxWriteBudget[ti] = Math.min(idxWriteBudget[ti] + Math.max(0, dUpd - dHot) * 0.05, 5)
      hotBudget[ti] = Math.min(hotBudget[ti] + dHot * 0.04, 6)

      // An insert asks the free space map first, and only extends the file when
      // no page has room. That is the whole difference between reuse and bloat.
      let guard = 0
      while (insBudget[ti] >= 1 && guard++ < 4) {
        insBudget[ti] -= 1
        const target = dPages > 0 ? used - 1 : fsmPick[ti]
        const gi = base + clamp(target, 0, used - 1)
        tileFlash[gi] = 1
        tileVm[gi] = 0
        const rr = rb + Math.floor(clamp(target, 0, used - 1) / COLS)
        fsmFlash[rr] = 1
      }
      guard = 0
      while (updBudget[ti] >= 1 && guard++ < 6) {
        updBudget[ti] -= 1
        const k = Math.floor(rnd() * used)
        tileFlash[base + k] = 0.9
        tileVm[base + k] = 0 // a modified page is no longer all-visible
      }
      // The model represents ordinary indexes; HOT adds no entry to them.
      guard = 0
      while (hotBudget[ti] >= 1 && guard++ < 4) {
        hotBudget[ti] -= 1
        const k = Math.floor(rnd() * used)
        tileFlash[base + k] = Math.max(tileFlash[base + k], 0.7)
      }
      // Page faults and writebacks light the page they actually touched.
      const io = readEvents[ti] + writeEvents[ti]
      readEvents[ti] = 0
      writeEvents[ti] = 0
      for (let k = 0; k < Math.min(4, io); k++) {
        tileFlash[base + Math.floor(rnd() * used)] = 0.85
      }

      /* --- autovacuum front -------------------------------------------- */
      let front = -1
      for (let w = 0; w < N_VAC_WORKERS; w++) {
        const vw = sim.autovac.workers[w]
        if (!vw || !vw.active || vw.table !== ti) continue
        if (vw.phase === 'scan_heap' || vw.phase === 'vacuum_heap' || vw.phase === 'truncate') front = vw.progress
      }

      // An append-only table never crosses the dead-tuple threshold, so the
      // dead-tuple vacuum never visits it. Since PostgreSQL 13 autovacuum also
      // runs on insert volume alone, precisely so it can mark pages all-visible
      // and keep index-only scans cheap. That is the sweep modelled here.
      if (front < 0 && sim.autovac.enabled && tb.bloat < 0.03) {
        if (insVacFront[ti] >= 0) {
          insVacFront[ti] += dt * 0.42
          if (insVacFront[ti] > 1) insVacFront[ti] = -1
        } else {
          insVacT[ti] += dt * clamp01(dIns * 0.05 + 0.08)
          if (insVacT[ti] > 6) {
            insVacT[ti] = 0
            insVacFront[ti] = 0
          }
        }
        front = insVacFront[ti]
      } else {
        insVacFront[ti] = -1
      }
      vacHeat[ti] = front >= 0 ? Math.min(1, vacHeat[ti] + dt * 4) : Math.max(0, vacHeat[ti] - dt * 1.6)
      const frontTile = front >= 0 ? Math.floor(front * used) : -1

      /* --- paint the roof ---------------------------------------------- */
      const cap = Math.max(1, tb.pages * def.tuplesPerPage)
      const fillAvg = clamp01((tb.liveTuples + tb.deadTuples) / cap)
      const bloat = tb.bloat
      const tr = L_TABLE[ti * 3]
      const tg = L_TABLE[ti * 3 + 1]
      const tbl = L_TABLE[ti * 3 + 2]
      const kH = 1 - Math.exp(-9 * dt)
      const flashDecay = dt * 2.1
      // Both of these are fractions of the file, not fixed tile counts: a
      // 400-page table has a proportionally small tail, not a mostly-fresh one.
      const tailFrom = used - Math.max(2, Math.min(COLS * 2, used * 0.18))
      const frontierFrom = used - Math.max(1, Math.min(COLS, used * 0.08))
      let vmSet = 0
      let bestFree = -1
      let bestRow = 0

      for (let r = 0; r < rows; r++) {
        let rowFreeAcc = 0
        let rowVmAcc = 0
        let rowN = 0
        for (let c = 0; c < COLS; c++) {
          const k = r * COLS + c
          const gi = base + k
          if (tileBlocked[gi] || k >= used) {
            tileMat[gi * 16 + 5] = 0.001
            capMat[gi * 16] = 0.001
            capMat[gi * 16 + 10] = 0.001
            continue
          }
          const n = tileNoise[gi]

          // Dead tuples are never spread evenly: updates concentrate on hot
          // pages, so at 15% bloat a third of the file is still untouched and
          // a handful of pages are nothing but corpses. n² keeps the mean at
          // the table's real dead ratio while making the spread that skewed.
          let dead = bloat * n * n * 2.85
          if (k > tailFrom) dead *= 0.22 // pages appended since are still clean
          if (dead > 1) dead = 1
          let fill = fillAvg * (0.72 + 0.56 * n)
          if (k >= frontierFrom) fill *= 0.5 // the insertion frontier is half empty
          if (fill > 1) fill = 1

          const live = fill * (1 - dead)
          const dd = fill * dead

          // Visibility map: vacuum sets the bit, any write clears it.
          let vm = tileVm[gi]
          if (dead > 0.05) vm = 0 // any dead tuple on the page clears the bit
          else if (frontTile >= 0 && k <= frontTile) vm = vm + (1 - vm) * Math.min(1, dt * 5)
          else if (vm > 0) vm = Math.min(1, vm + dt * 0.35)
          tileVm[gi] = vm
          if (vm > 0.5) vmSet++

          let fl = tileFlash[gi]
          if (fl > 0) {
            fl -= flashDecay
            if (fl < 0) fl = 0
            tileFlash[gi] = fl
          }

          // Height is page fullness: empty pages read as dark gaps in the roof.
          const target = 0.14 + fill * 1.25 + fl * 0.5
          const h = tileH[gi] + (target - tileH[gi]) * kH
          tileH[gi] = h
          tileMat[gi * 16 + 5] = h < 0.03 ? 0.03 : h

          const inten = 0.55 + 0.55 * n
          let cr = L_GAP[0] + tr * live * inten + L_DEAD[0] * dd * 1.35
          let cg = L_GAP[1] + tg * live * inten + L_DEAD[1] * dd * 1.35
          let cb = L_GAP[2] + tbl * live * inten + L_DEAD[2] * dd * 1.35
          if (fl > 0) {
            cr += fl * 0.75
            cg += fl * 0.8
            cb += fl * 0.9
          }
          if (frontTile >= 0 && k <= frontTile && frontTile - k < COLS * 2) {
            const w = 1 - (frontTile - k) / (COLS * 2)
            cr += L_VACUUM[0] * w * 0.9
            cg += L_VACUUM[1] * w * 0.9
            cb += L_VACUUM[2] * w * 0.9
          }
          setColor3(tileCol, gi, cr, cg, cb)

          // All-visible cap: the bit that makes index-only scans possible.
          const cs = vm > 0.04 ? TILE_W * 0.86 * vm : 0.001
          capMat[gi * 16] = cs
          capMat[gi * 16 + 10] = cs
          capMat[gi * 16 + 13] = ROOF_Y + h + 0.06
          const ci = 0.55 + 0.5 * vm
          setColor3(capCol, gi, L_OK[0] * ci, L_OK[1] * ci, L_OK[2] * ci)

          rowFreeAcc += 1 - fill
          rowVmAcc += vm
          rowN++
        }

        const ri = rb + r
        const free = rowN ? rowFreeAcc / rowN : 0
        const vmv = rowN ? rowVmAcc / rowN : 0
        rowFree[ri] = rowFree[ri] + (free - rowFree[ri]) * kH
        rowVm[ri] = rowVm[ri] + (vmv - rowVm[ri]) * kH
        if (rowFree[ri] > bestFree) {
          bestFree = rowFree[ri]
          bestRow = r
        }

        // _fsm: one bar per page run, height = free space the map is offering.
        let ff = fsmFlash[ri]
        if (ff > 0) {
          ff -= flashDecay
          if (ff < 0) ff = 0
          fsmFlash[ri] = ff
        }
        const bh = 0.12 + rowFree[ri] * 3.4 + ff * 0.8
        fsmMat[ri * 16] = 1.0
        fsmMat[ri * 16 + 5] = bh
        fsmMat[ri * 16 + 10] = PITCH * 0.8
        const fi = 0.35 + rowFree[ri] * 0.9 + ff * 1.6
        setColor3(fsmCol, ri, L_WARN[0] * fi, L_WARN[1] * fi * 0.9, L_WARN[2] * fi * 0.5)

        // _vm: the strip of bits, green where the whole page is all-visible.
        let vf = vmFlash[ri]
        if (vf > 0) {
          vf -= flashDecay
          if (vf < 0) vf = 0
          vmFlash[ri] = vf
        }
        vmMat[ri * 16] = 1.1
        vmMat[ri * 16 + 10] = PITCH * 0.8
        const vi = 0.16 + rowVm[ri] * 1.05 + vf * 2.2
        setColor3(
          vmCol,
          ri,
          mixLin(L_INK[0], L_OK[0], rowVm[ri]) * vi,
          mixLin(L_INK[1], L_OK[1], rowVm[ri]) * vi,
          mixLin(L_INK[2], L_OK[2], rowVm[ri]) * vi,
        )
      }

      fsmPick[ti] = bestRow * COLS + ((rnd() * COLS) | 0)
      vmCover[ti] = used ? vmSet / used : 0
      idxBloat[ti] = idxBloat[ti] + (clamp01(bloat * 1.6) - idxBloat[ti]) * (1 - Math.exp(-1.5 * dt))

      /* --- the shell follows the file ---------------------------------- */
      const len = rows * PITCH
      const cz = FILE_Z0 + len / 2
      const body = bodyMeshes[ti]
      body.position.z = cz
      body.scale.z = len
      const proxy = roofProxies[ti]
      proxy.position.z = cz
      proxy.scale.z = len
      writeBoxEdges(edgePos, ti, tableX(ti), FLOOR_Y + bodyH / 2, cz, HALF_W, bodyH / 2, len / 2)

      // The vacuum blade: a violet line crossing the pages it has processed.
      if (front >= 0) {
        const fz = FILE_Z0 + front * len
        setTRS(vacMat, ti, tx, ROOF_Y, fz, HALF_W * 2, 2.2, 0.35)
        const g2 = 0.9 + 0.5 * Math.sin(t * 9)
        setColor3(vacCol, ti, L_VACUUM[0] * g2, L_VACUUM[1] * g2, L_VACUUM[2] * g2)
      } else if (vacHeat[ti] > 0.01) {
        setTRS(vacMat, ti, tx, ROOF_Y, FILE_Z0 + len, HALF_W * 2, 2.2 * vacHeat[ti], 0.35)
        setColor3(vacCol, ti, L_VACUUM[0] * vacHeat[ti], L_VACUUM[1] * vacHeat[ti], L_VACUUM[2] * vacHeat[ti])
      } else {
        vacMat[ti * 16 + 5] = 0.001
      }
    }

    tiles.instanceMatrix.needsUpdate = true
    tiles.instanceColor!.needsUpdate = true
    vmCaps.instanceMatrix.needsUpdate = true
    vmCaps.instanceColor!.needsUpdate = true
    fsmBars.instanceMatrix.needsUpdate = true
    fsmBars.instanceColor!.needsUpdate = true
    vmBits.instanceMatrix.needsUpdate = true
    vmBits.instanceColor!.needsUpdate = true
    vacBlades.instanceMatrix.needsUpdate = true
    vacBlades.instanceColor!.needsUpdate = true
    edgeAttr.needsUpdate = true
  }

  /* ============================================================= INDEXES */

  function spawnProbe(ti: number, kind: number): void {
    const list = idxOfTable[ti]
    if (!list.length) return
    const slot = list[(rnd() * list.length) | 0]
    const i = pNext
    pNext = (pNext + 1) % MAX_PROBES
    pTable[i] = ti
    pSlot[i] = slot
    pLeaf[i] = (rnd() * Math.max(1, liveLeafCount[slot] || LEAVES)) | 0
    pTile[i] = tileBase[ti] + ((rnd() * Math.max(1, tilesUsed[ti])) | 0)
    pAge[i] = 0
    pKind[i] = kind
    pFired[i] = 0
  }

  function updateIndexes(dt: number, sim: SimState, t: number): void {
    const decay = Math.exp(-3.4 * dt)
    for (let i = 0; i < nodeHeat.length; i++) nodeHeat[i] *= decay
    for (let i = 0; i < strutHeat.length; i++) strutHeat[i] *= decay
    for (let i = 0; i < ginHeat.length; i++) ginHeat[i] *= decay
    for (let i = 0; i < ginTreeHeat.length; i++) ginTreeHeat[i] *= decay

    // The number of visible leaves and the readout derive from the same live
    // index-page value. Bloat therefore grows indexes beside growing heaps.
    for (let s = 0; s < idx.length; s++) {
      const tree = treeOf[s]
      if (tree < 0) continue
      const it = idx[s]
      const pages = liveIndexPages(sim, it)
      const leaves = clamp(Math.ceil(baseLeafCount[s] * pages / Math.max(1, it.pages)), 1, LEAVES)
      liveLeafCount[s] = leaves
      const nb = tree * NODES_PER_TREE
      for (let leaf = 0; leaf < LEAVES; leaf++) {
        const n = nb + 5 + leaf
        if (leaf < leaves) {
          setTRS(nodeMat, n, nodePos[n * 3], LEAF_Y, nodePos[n * 3 + 2], 1.3, 0.8, 1.8)
        } else {
          setTRS(nodeMat, n, nodePos[n * 3], LEAF_Y, nodePos[n * 3 + 2], 0.001, 0.001, 0.001)
        }
      }
    }

    /* --- spawn ---------------------------------------------------------- */
    for (let ti = 0; ti < N_TABLES; ti++) {
      let guard = 0
      while (scanBudget[ti] >= 1 && guard++ < 2) {
        scanBudget[ti] -= 1
        spawnProbe(ti, 0)
      }
      guard = 0
      // Non-HOT updates maintain every modeled index. BRIN summary maintenance is absent.
      while (idxWriteBudget[ti] >= 1 && guard++ < 2) {
        idxWriteBudget[ti] -= 1
        spawnProbe(ti, 1)
      }
      // A vacuum that is cleaning indexes lights every leaf it walks.
      for (let w = 0; w < N_VAC_WORKERS; w++) {
        const vw = sim.autovac.workers[w]
        if (vw && vw.active && vw.table === ti && vw.phase === 'vacuum_index' && rnd() < dt * 12) spawnProbe(ti, 2)
      }
    }

    /* --- advance -------------------------------------------------------- */
    for (let i = 0; i < MAX_PROBES; i++) {
      if (pTable[i] < 0) continue
      const age = (pAge[i] += dt)
      if (age > 0.95) {
        pTable[i] = -1
        continue
      }
      const slot = pSlot[i]
      const tree = treeOf[slot]
      const kind = pKind[i]

      if (tree < 0) {
        // GIN probe: descend the entry B-tree, then fan into one key range and
        // its posting trees. It is not a flat mat.
        const branch = pLeaf[i] % 3
        if (age < 0.5) ginTreeHeat[0] = 1
        if (age > 0.08) ginTreeHeat[1 + branch] = 1
        if (age > 0.18) {
          const first = branch * 16
          const u = clamp01((age - 0.18) / 0.38)
          for (let e = 0; e < 16; e++) {
            const d = Math.abs(e / 15 - u)
            if (d < 0.24) ginHeat[first + e] = Math.max(ginHeat[first + e], 1 - d / 0.24)
          }
        }
        if (age > 0.34) {
          const first = branch * 4
          for (let e = 0; e < 4; e++) ginHeat[GIN_ENTRIES + first + e] = 1
        }
      } else {
        const nb = tree * NODES_PER_TREE
        const sb = tree * STRUTS_PER_TREE
        const leaf = pLeaf[i]
        const inner = 1 + Math.floor(leaf / 3)
        if (age < 0.5) nodeHeat[nb] = 1
        if (age > 0.1) nodeHeat[nb + inner] = 1
        if (age > 0.22) nodeHeat[nb + 5 + leaf] = 1
        if (age > 0.08 && age < 0.5) strutHeat[sb + (inner - 1)] = 1
        if (age > 0.2 && age < 0.6) strutHeat[sb + 4 + leaf] = 1
        // A range scan walks the leaf chain sideways: that is the linked list.
        if (kind === 0 && age > 0.3) {
          const step = Math.min(3, Math.floor((age - 0.3) * 12))
          for (let k = 0; k < step; k++) {
            const l2 = leaf + k
            if (l2 < LEAVES - 1) strutHeat[sb + 4 + LEAVES + l2] = 1
            if (l2 + 1 < LEAVES) nodeHeat[nb + 6 + l2] = Math.max(nodeHeat[nb + 6 + l2], 0.75)
          }
        }
      }

      // Then the heap fetch — unless the visibility map says we can skip it.
      if (!pFired[i] && age > 0.32) {
        pFired[i] = 1
        const ti = pTable[i]
        const gi = pTile[i]
        const indexOnly = kind === 0 && tileVm[gi] > 0.5
        if (indexOnly) {
          // Index-only scan: no heap page is touched, the _vm bit answered it.
          const r = Math.floor((gi - tileBase[ti]) / COLS)
          vmFlash[rowBase[ti] + clamp(r, 0, rowCap[ti] - 1)] = 1
        } else {
          ctx.flow({
            // Lookups descend index → heap. Inserts and vacuum maintenance
            // originate at the heap/worker side and travel the opposite road.
            route: kind === 0 ? rid.idxLookup(ti) : rid.vacIdx(ti),
            count: 1,
            kind: kind === 1 ? 'page_write' : 'page_read',
            color: kind === 1 ? COLOR.bufDirty : kind === 2 ? COLOR.vacuum : COLOR.index,
            size: 0.95,
          })
          tileFlash[gi] = 1
        }
      }
    }

    /* --- paint ---------------------------------------------------------- */
    for (let s = 0; s < idx.length; s++) {
      const tree = treeOf[s]
      const bloat = idxBloat[idx[s].table]
      const leaves = liveLeafCount[s]
      const reusable = 0.15 + bloat * 0.75
      for (let i = 0; i < IDX_FSM_BITS; i++) {
        const n = s * IDX_FSM_BITS + i
        const h = 0.15 + reusable * (0.45 + ((i * 37 + s * 11) % 7) / 12) * 2.2
        idxFsmMat[n * 16 + 5] = h
        const k = 0.28 + reusable * 0.9
        setColor3(idxFsmCol, n, L_WARN[0] * k, L_WARN[1] * k * 0.9, L_WARN[2] * k * 0.55)
      }
      if (tree < 0) continue
      const nb = tree * NODES_PER_TREE
      for (let n = 0; n < NODES_PER_TREE; n++) {
        if (n >= 5 && n - 5 >= leaves) {
          setColor3(nodeCol, nb + n, 0, 0, 0)
          continue
        }
        const h = nodeHeat[nb + n]
        // Leaves grey out as dead index pointers accumulate: index bloat.
        const grey = n >= 5 ? bloat : bloat * 0.35
        const base = (n === 0 ? 0.5 : n < 5 ? 0.4 : 0.32) * (1 - grey * 0.55)
        const k = base + h * 1.5
        setColor3(
          nodeCol,
          nb + n,
          mixLin(L_INDEX[0], L_GREY[0], grey) * k,
          mixLin(L_INDEX[1], L_GREY[1], grey) * k,
          mixLin(L_INDEX[2], L_GREY[2], grey) * k,
        )
      }
      const sb = tree * STRUTS_PER_TREE
      for (let n = 0; n < STRUTS_PER_TREE; n++) {
        const leafLink = n >= 4 && n < 4 + LEAVES
        const chainLink = n >= 4 + LEAVES
        const active = leafLink ? n - 4 < leaves : chainLink ? n - (4 + LEAVES) < leaves - 1 : true
        if (!active) {
          const o = (sb + n) * 6
          for (let j = 0; j < 6; j += 3) {
            strutCol[o + j] = 0
            strutCol[o + j + 1] = 0
            strutCol[o + j + 2] = 0
          }
          continue
        }
        const h = strutHeat[sb + n]
        const chain = n >= 4 + LEAVES
        const k = (chain ? 0.16 : 0.1) + h * 1.9
        const o = (sb + n) * 6
        const cr = (chain ? L_OK[0] : L_INDEX[0]) * k
        const cg = (chain ? L_OK[1] : L_INDEX[1]) * k
        const cb = (chain ? L_OK[2] : L_INDEX[2]) * k
        strutCol[o] = cr; strutCol[o + 1] = cg; strutCol[o + 2] = cb
        strutCol[o + 3] = cr; strutCol[o + 4] = cg; strutCol[o + 5] = cb
      }
    }
    if (ginSlot >= 0) {
      const bloat = idxBloat[idx[ginSlot].table]
      for (let n = 0; n < GIN_TREE_N; n++) {
        const k = (n === 0 ? 0.5 : 0.4) + ginTreeHeat[n] * 1.7
        setColor3(ginTreeCol, n, L_INDEX[0] * k, L_INDEX[1] * k, L_INDEX[2] * k)
      }
      ginTreeNodes.instanceColor!.needsUpdate = true
      for (let e = 0; e < GIN_ENTRIES + GIN_LISTS; e++) {
        const h = ginHeat[e]
        const k = 0.3 + h * 1.7
        setColor3(
          ginCol,
          e,
          mixLin(L_INDEX[0], L_GREY[0], bloat * 0.6) * k,
          mixLin(L_INDEX[1], L_GREY[1], bloat * 0.6) * k,
          mixLin(L_INDEX[2], L_GREY[2], bloat * 0.6) * k,
        )
      }
      ginEntries.instanceColor!.needsUpdate = true
    }
    idxNodes.instanceColor!.needsUpdate = true
    idxNodes.instanceMatrix.needsUpdate = true
    idxFsm.instanceMatrix.needsUpdate = true
    idxFsm.instanceColor!.needsUpdate = true
    strutColAttr.needsUpdate = true
  }

  /* =============================================================== TOAST */

  function updateToast(dt: number, sim: SimState, t: number): void {
    const docs = toastTable >= 0 ? sim.tables[toastTable] : null
    const rate = docs ? clamp01(docs.heat) * 1.6 + 0.15 : 0.15
    toastSpawn += dt * rate
    if (toastSpawn >= 1) {
      toastSpawn -= 1
      for (let i = 0; i < TOAST_SLOTS; i++) {
        if (tAge[i] < 0) {
          tAge[i] = 0
          break
        }
      }
    }
    // A vacuum of the owning table processes the toast table too, and the
    // silos come down: pg_toast is a real relation with real dead tuples.
    if (docs && docs.vacuuming) siloLevel = Math.max(0.05, siloLevel - dt * 0.06)

    for (let i = 0; i < TOAST_SLOTS; i++) {
      const o = i * (1 + TOAST_CHUNKS)
      if (tAge[i] < 0) {
        for (let k = 0; k <= TOAST_CHUNKS; k++) tbMat[(o + k) * 16 + 5] = 0.001
        continue
      }
      const a = (tAge[i] += dt * 0.85)
      if (a > 3.2) {
        tAge[i] = -1
        const storedChunks = TOAST_CHUNKS - 1
        toastChunks += storedChunks
        toastBytes += storedChunks * 2048
        siloLevel = Math.min(0.94, siloLevel + 0.012)
        continue
      }
      const lane = (i - 1) * 3

      // 0–1 arrive · 1–1.4 compress · 1.4–2.3 chop · 2.3–3.2 file
      if (a < 1.4) {
        const u = clamp01(a)
        const comp = a > 1 ? clamp01((a - 1) / 0.4) : 0
        const w = 3.4 * (1 - comp * 0.35)
        const d = 2.6 * (1 - comp * 0.35)
        setTRS(tbMat, o, lane, FLOOR_Y + 10.5, -14 + u * 7, w, 2.2, 2.6)
        tbMat[o * 16 + 10] = d
        const k = 1.1 + comp * 0.4
        setColor3(tbCol, o, L_TOAST[0] * k, L_TOAST[1] * k, L_TOAST[2] * k)
        for (let k2 = 0; k2 < TOAST_CHUNKS; k2++) tbMat[(o + 1 + k2) * 16 + 5] = 0.001
      } else {
        tbMat[o * 16 + 5] = 0.001
        const u = clamp01((a - 1.4) / 1.8)
        const chop = clamp01((a - 1.4) / 0.9)
        const storedChunks = TOAST_CHUNKS - 1
        for (let k2 = 0; k2 < TOAST_CHUNKS; k2++) {
          if (k2 >= storedChunks) {
            tbMat[(o + 1 + k2) * 16 + 5] = 0.001
            continue
          }
          const sx = 0.8 * (0.65 + chop * 0.35)
          const targetX = lane + (k2 - (storedChunks - 1) / 2) * 7 * u
          const y = FLOOR_Y + 10.5 - u * u * 6
          setTRS(
            tbMat,
            o + 1 + k2,
            lane + (k2 - (storedChunks - 1) / 2) * chop + (targetX - lane) * 0.9,
            y,
            -7 + u * 9,
            sx,
            0.9,
            1.0,
          )
          const k3 = 0.7 + chop * 0.8
          setColor3(tbCol, o + 1 + k2, L_TOAST[0] * k3, L_TOAST[1] * k3 * 0.85, L_TOAST[2] * k3 * 0.7)
        }
      }
    }
    toastBits.instanceMatrix.needsUpdate = true
    toastBits.instanceColor!.needsUpdate = true

    for (let i = 0; i < SILOS; i++) {
      const lvl = clamp01(siloLevel * (0.7 + 0.3 * ((i * 7919) % 13) / 13) + 0.05)
      setTRS(siloMat, i, (i - 1.5) * 8, FLOOR_Y + 1.4, 4, 2.9, lvl * 11, 2.9)
      const k = 0.42 + 0.3 * Math.sin(t * 1.4 + i)
      setColor3(siloCol, i, L_TOAST[0] * k, L_TOAST[1] * k * 0.8, L_TOAST[2] * k * 0.6)
    }
    siloFill.instanceMatrix.needsUpdate = true
    siloFill.instanceColor!.needsUpdate = true
  }

  /* ============================================================ OS CACHE */

  const readTile = new Int32Array(N_TABLES)
  const writeTile = new Int32Array(N_TABLES)
  {
    const pick = (routeId: string): number => {
      const c = routeCurve(routeId)
      if (!c) return (OC_ROWS >> 1) * OC_COLS + (OC_COLS >> 1)
      let best = 0
      let bestD = Infinity
      for (let k = 0; k <= 40; k++) {
        c.getPointAt(k / 40, _v)
        const d = Math.abs(_v.y - OC_Y)
        if (d < bestD) {
          bestD = d
          best = k
        }
      }
      c.getPointAt(best / 40, _v)
      const col = clamp(Math.round(_v.x / OC_PITCH + (OC_COLS - 1) / 2), 0, OC_COLS - 1)
      const row = clamp(Math.round(_v.z / OC_PITCH + (OC_ROWS - 1) / 2), 0, OC_ROWS - 1)
      return row * OC_COLS + col
    }
    for (let ti = 0; ti < N_TABLES; ti++) {
      readTile[ti] = pick(rid.ioRead(ti))
      writeTile[ti] = pick(rid.ioWrite(ti))
    }
  }

  /** Reads and writes handed over by the flow bus before the heap consumed them. */
  const pendDiskRead = new Float32Array(N_TABLES)
  const pendCacheRead = new Float32Array(N_TABLES)
  const pendWrite = new Float32Array(N_TABLES)

  function updateOsCache(dt: number, sim: SimState, t: number): void {
    // Kernel eviction: residency fades under memory pressure, faster when busy.
    const pressure = 0.05 + clamp01(sim.stats.ioReadPerSec / 900) * 0.14 + sim.stats.ioWriteLoad * 0.14
    const dec = Math.exp(-pressure * dt)
    const flashDec = dt * 2.4

    let hits = 0
    let misses = 0
    let diskReads = 0

    for (let ti = 0; ti < N_TABLES; ti++) {
      let n = pendDiskRead[ti]
      pendDiskRead[ti] = 0
      while (n >= 1) {
        n -= 1
        const i = neighbour(readTile[ti])
        // The source selected the full route, so this event reaches media.
        misses++
        diskReads++
        osResident[i] = osHole[i] ? 0 : 1
        osFlash[i] = Math.max(osFlash[i], 0.7)
        osKind[i] = 2
      }
      n = pendCacheRead[ti]
      pendCacheRead[ti] = 0
      while (n >= 1) {
        n -= 1
        const i = neighbour(readTile[ti])
        // The shortened route starts here: kernel RAM supplied the page.
        hits++
        if (!osHole[i]) osResident[i] = Math.min(1, osResident[i] + 0.25)
        osFlash[i] = 1
        osKind[i] = 0
      }
      let m = pendWrite[ti]
      pendWrite[ti] = 0
      while (m >= 1) {
        m -= 1
        const i = neighbour(writeTile[ti])
        if (osHole[i]) continue
        // A write lands in the kernel and stops there. fsync is what moves it.
        osResident[i] = 1
        osDirty[i] = Math.min(1, osDirty[i] + 0.45)
        osFlash[i] = Math.max(osFlash[i], 0.8)
        osKind[i] = 1
      }
    }

    // The checkpoint's fsync phase is where the kernel's dirty pages go to disk.
    const syncing = sim.checkpoint.phase === 'syncing'
    fsyncGlow = syncing ? Math.min(1, fsyncGlow + dt * 6) : Math.max(0, fsyncGlow - dt * 2.2)
    let drained = 0
    if (syncing) {
      for (let i = 0; i < OC_N && drained < 40; i++) {
        if (osDirty[i] <= 0.01) continue
        const d = Math.min(osDirty[i], dt * 1.6)
        osDirty[i] -= d
        if (osDirty[i] < 0.02) {
          osDirty[i] = 0
          osFlash[i] = 1
          osKind[i] = 1
          drained++
        }
      }
    }

    const tot = hits + misses
    if (tot > 0) osHitRatio += (hits / tot - osHitRatio) * clamp01(dt * 1.5 + tot * 0.04)

    let resident = 0
    let live = 0
    for (let i = 0; i < OC_N; i++) {
      if (osHole[i]) {
        setColor3(osCol, i, 0, 0, 0)
        continue
      }
      live++
      const res = (osResident[i] *= dec)
      resident += res
      let fl = osFlash[i]
      if (fl > 0) {
        fl -= flashDec
        if (fl < 0) fl = 0
        osFlash[i] = fl
      }
      const dirty = osDirty[i]
      // resident = cool blue, kernel-dirty = amber, flash = what just crossed
      let r = 0.04 + res * 0.16 + dirty * 0.5
      let g = 0.07 + res * 0.34 + dirty * 0.3
      let b = 0.14 + res * 0.7 + dirty * 0.05
      if (fl > 0) {
        const k = fl * fl
        if (osKind[i] === 0) {
          r += L_OK[0] * k * 2.2; g += L_OK[1] * k * 2.2; b += L_OK[2] * k * 2.2
        } else if (osKind[i] === 1) {
          r += L_DIRTY[0] * k * 2.0; g += L_DIRTY[1] * k * 2.0; b += L_DIRTY[2] * k * 2.0
        } else {
          r += L_CRIT[0] * k * 1.6; g += L_CRIT[1] * k * 1.6; b += L_CRIT[2] * k * 1.6
        }
      }
      setColor3(osCol, i, r, g, b)
    }
    osResidentPct = live ? resident / live : 0
    osTiles.instanceColor!.needsUpdate = true

    /* --------------------------------------------------------- disk LEDs */
    // Read LEDs consume the same disk-miss count that selected the full route;
    // OS-cache hits never light media. Writes light here only as fsync drains.
    ledBudget += diskReads
    if (syncing) ledBudget += dt * 90
    let guard = 0
    while (ledBudget >= 1 && guard++ < 24) {
      ledBudget -= 1
      const i = (rnd() * N_DRIVES) | 0
      ledHeat[i] = 1
      ledKind[i] = syncing || rnd() < 0.4 ? 1 : 0
    }
    const ledDec = Math.exp(-7 * dt)
    for (let i = 0; i < N_DRIVES; i++) {
      const h = (ledHeat[i] *= ledDec)
      const k = 0.1 + h * 1.9
      if (ledKind[i]) setColor3(driveCol, i, L_DIRTY[0] * k, L_DIRTY[1] * k * 0.7, L_DIRTY[2] * k * 0.7)
      else setColor3(driveCol, i, L_STORAGE[0] * k * 0.8, L_STORAGE[1] * k, L_STORAGE[2] * k * 0.9)
    }
    drives.instanceColor!.needsUpdate = true

    const fg = fsyncGlow * (0.7 + 0.3 * Math.sin(t * 14))
    mFsync.color.setRGB(0.08 + fg * 1.9, 0.03 + fg * 0.55, 0.06 + fg * 1.2)
    rackLight.intensity = 500 + fsyncGlow * 2200 + sim.stats.ioWriteLoad * 700
  }

  /** Spread traffic over the neighbourhood of a crossing point, not one tile. */
  function neighbour(i: number): number {
    const col = i % OC_COLS
    const row = (i / OC_COLS) | 0
    const c = clamp(col + ((rnd() * 3) | 0) - 1, 0, OC_COLS - 1)
    const r = clamp(row + ((rnd() * 3) | 0) - 1, 0, OC_ROWS - 1)
    return r * OC_COLS + c
  }

  /* ================================================================ TICK */

  function update(dt: number, sim: SimState, t: number): void {
    const d = dt > 0.1 ? 0.1 : dt
    // The heap consumes the raw event counters, so copy them for the OS cache
    // first: the same page crossing lights both layers.
    for (let ti = 0; ti < N_TABLES; ti++) {
      pendDiskRead[ti] += diskReadEvents[ti]
      pendCacheRead[ti] += cacheReadEvents[ti]
      pendWrite[ti] += writeEvents[ti]
      diskReadEvents[ti] = 0
      cacheReadEvents[ti] = 0
    }
    updateHeap(d, sim, t)
    updateIndexes(d, sim, t)
    updateToast(d, sim, t)
    updateOsCache(d, sim, t)

    const day = atmosphere().daylight
    pitLight.intensity = day ? 420 : 2000 + clamp01(sim.stats.ioReadPerSec / 300) * 1800
    rackLight.intensity = day ? 120 : 900
    pitFill.intensity = day ? 680 : 5200
    pitFillW.intensity = day ? 440 : 3600
  }

  /**
   * Far away you should still read: five files of different sizes, a cache slab
   * and a rack of blinking disks. Everything that only means something at
   * reading distance — forks, caps, index struts, walkways — goes away.
   * The drive LEDs stay: they are the only sign of life at the bottom.
   */
  function setDetail(level: 0 | 1 | 2): void {
    fine.visible = level > 0
    vmCaps.visible = level > 0
    fsmBars.visible = level > 0
    vmBits.visible = level > 0
    ginEntries.visible = level > 0
    toastBits.visible = level > 0
    struts.visible = level > 0
    heapEdges.visible = level > 0
  }

  function dispose(): void {
    offFlow()
    group.traverse((o) => {
      const ls = o as THREE.LineSegments
      if ((ls as unknown as { isLineSegments?: boolean }).isLineSegments) ls.geometry.dispose()
      const im = o as THREE.InstancedMesh
      if ((im as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) im.dispose()
    })
    for (const o of owned) o.dispose()
    owned.length = 0
    group.clear()
  }

  return { id: 'storage', group, update, setDetail, dispose }
}

/* ---------------------------------------------------------------- helpers */

function mixLin(a: number, b: number, t: number): number {
  return a + (b - a) * (t < 0 ? 0 : t > 1 ? 1 : t)
}

/**
 * The printed plan of the data directory. Everything typographic in the underworld lives
 * in this one texture: relation slots with their file paths, page rulers, fork
 * names, the directory listing, and the district title.
 */
function buildFloorTexture(rng: () => number, W: number): THREE.CanvasTexture {
  const px = W / (FLOOR_X1 - FLOOR_X0)
  const H = Math.round((FLOOR_Z1 - FLOOR_Z0) * px)
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d')!
  const X = (wx: number) => (wx - FLOOR_X0) * px
  const Y = (wz: number) => (wz - FLOOR_Z0) * px

  g.fillStyle = '#070c15'
  g.fillRect(0, 0, W, H)

  // Cast-concrete mottling, 8 m module.
  for (let wx = FLOOR_X0; wx < FLOOR_X1; wx += 8) {
    for (let wz = FLOOR_Z0; wz < FLOOR_Z1; wz += 8) {
      g.fillStyle = `rgba(120,160,220,${(0.003 + rng() * 0.01).toFixed(4)})`
      g.fillRect(X(wx), Y(wz), 8 * px, 8 * px)
    }
  }

  // Survey grid: 4 m minor, 20 m major.
  g.lineWidth = 1
  g.strokeStyle = 'rgba(48,72,112,0.25)'
  g.beginPath()
  for (let wx = FLOOR_X0; wx <= FLOOR_X1; wx += 4) {
    g.moveTo(X(wx), 0)
    g.lineTo(X(wx), H)
  }
  for (let wz = FLOOR_Z0; wz <= FLOOR_Z1; wz += 4) {
    g.moveTo(0, Y(wz))
    g.lineTo(W, Y(wz))
  }
  g.stroke()
  g.lineWidth = 2
  g.strokeStyle = 'rgba(70,104,160,0.34)'
  g.beginPath()
  for (let wx = FLOOR_X0; wx <= FLOOR_X1; wx += 20) {
    g.moveTo(X(wx), 0)
    g.lineTo(X(wx), H)
  }
  for (let wz = FLOOR_Z0; wz <= FLOOR_Z1; wz += 20) {
    g.moveTo(0, Y(wz))
    g.lineTo(W, Y(wz))
  }
  g.stroke()

  const label = (
    text: string,
    wx: number,
    wz: number,
    size: number,
    color: string,
    align: CanvasTextAlign = 'center',
    rot = 0,
  ) => {
    g.save()
    g.translate(X(wx), Y(wz))
    if (rot) g.rotate(rot)
    g.textAlign = align
    g.textBaseline = 'middle'
    g.fillStyle = color
    g.font = `600 ${Math.round(size * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
    g.fillText(text, 0, 0)
    g.restore()
  }

  /* Relation slots: one painted bay per heap file. */
  for (let ti = 0; ti < N_TABLES; ti++) {
    const def = TABLES[ti]
    const tx = tableX(ti)
    const x0 = X(tx - HALF_W - 2.5)
    const w = (HALF_W + 2.5) * 2 * px
    const y0 = Y(SLOT_Z0)
    const h = (SLOT_Z1 - SLOT_Z0) * px

    g.save()
    g.setLineDash([14, 10])
    g.lineWidth = 2.5
    g.strokeStyle = hexA(def.color, 0.42)
    g.strokeRect(x0, y0, w, h)
    g.restore()

    // Corner brackets — the bay reads as a surveyed plot.
    g.strokeStyle = hexA(def.color, 0.75)
    g.lineWidth = 4
    const br = 5 * px
    for (const [cx, cy, sx, sy] of [
      [x0, y0, 1, 1],
      [x0 + w, y0, -1, 1],
      [x0, y0 + h, 1, -1],
      [x0 + w, y0 + h, -1, -1],
    ]) {
      g.beginPath()
      g.moveTo(cx + sx * br, cy)
      g.lineTo(cx, cy)
      g.lineTo(cx, cy + sy * br)
      g.stroke()
    }

    label(def.name, tx, SLOT_Z0 - 3.4, 3.2, hexA(def.color, 0.92))
    label(`base/16384/${24591 + ti * 7}`, tx, SLOT_Z0 + 1.2, 1.9, 'rgba(143,165,196,0.75)')
    label(`${def.pages} pages · ${def.tuplesPerPage} tuples/page`, tx, SLOT_Z0 + 4.2, 1.5, 'rgba(143,165,196,0.5)')
    label('_fsm', tx - PANEL_X - 2.6, FILE_Z0 + 6, 1.6, 'rgba(255,204,85,0.7)', 'center', -Math.PI / 2)
    label('_vm', tx + PANEL_X + 2.6, FILE_Z0 + 6, 1.6, 'rgba(87,227,137,0.7)', 'center', Math.PI / 2)

    // Page ruler down the west flank: block numbers, every ten rows.
    g.fillStyle = 'rgba(120,150,200,0.5)'
    for (let r = 0; r <= ROWS_MAX; r += 10) {
      const wz = FILE_Z0 + r * PITCH
      if (wz > SLOT_Z1) break
      g.fillRect(X(tx - HALF_W - 2.2), Y(wz) - 1, 2.4 * px, 2)
      label(`${r * COLS * PAGES_PER_TILE}`, tx - HALF_W - 4.4, wz, 1.35, 'rgba(120,150,200,0.55)', 'right')
    }
  }

  /* Index row. */
  g.save()
  g.setLineDash([10, 8])
  g.lineWidth = 2
  g.strokeStyle = 'rgba(100,255,218,0.28)'
  g.strokeRect(X(-114), Y(2), 228 * px, 38 * px)
  g.restore()
  label('I N D E X E S', 0, 44, 2.6, 'rgba(100,255,218,0.5)')
  for (let ti = 0; ti < N_TABLES; ti++) {
    const defs = TABLES[ti].indexes
    for (let k = 0; k < defs.length; k++) {
      const z = indexPos(ti)[2] + (k === 0 ? 4 : -18)
      label(defs[k].name, tableX(ti), z + 6.4, 1.7, 'rgba(100,255,218,0.62)')
      label(`${defs[k].kind} · ${defs[k].pages} pages`, tableX(ti), z + 9, 1.4, 'rgba(143,165,196,0.45)')
      label('_fsm', tableX(ti) + 8.8, z + 4.2, 1.2, 'rgba(255,204,85,0.62)')
    }
  }

  /* pg_toast yard + the annex. */
  label('pg_toast', ANCHOR.toastYard[0], ANCHOR.toastYard[2] - 13, 2.6, 'rgba(255,143,90,0.75)')
  label('documents.body → 2 KiB chunks', ANCHOR.toastYard[0], ANCHOR.toastYard[2] - 10, 1.5, 'rgba(143,165,196,0.5)')
  for (const [name, ax, az] of ANNEX) {
    label(name + '/', ax, az + 7.5, 1.7, 'rgba(143,165,196,0.6)')
  }
  label('one tile = 12 × 8 KiB pages', -84, -88, 1.9, 'rgba(143,165,196,0.55)')
  label('base/pgsql_tmp/ · backend spill files', 0, -92, 1.6, 'rgba(184,144,255,0.72)')
  label('↑ N', -104, -80, 2.2, 'rgba(143,165,196,0.5)')

  /* District title. */
  g.save()
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = 'rgba(85,214,160,0.34)'
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '16px'
  g.font = `700 ${Math.round(4.4 * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  g.fillText('DATA DIRECTORY', X(0), Y(FLOOR_Z1 - 8))
  g.font = `600 ${Math.round(2.0 * px)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  g.fillStyle = 'rgba(143,165,196,0.45)'
  g.fillText('base/  global/  pg_xact/  pg_tblspc/   ·   pg_wal shown in east vault', X(0), Y(FLOOR_Z1 - 3))
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px'
  g.restore()

  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}
