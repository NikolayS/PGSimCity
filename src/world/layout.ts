import * as THREE from 'three'
import { N_TABLES, TABLES } from '../core/catalog'
import { rid } from '../core/route-ids'
import { COLOR } from '../core/theme'
import { N_BACKEND_SLOTS, N_VAC_WORKERS, N_WAL_SEG_SLOTS, BUF_GRID } from '../core/types'
import type { RouteDef } from '../core/types'

export { N_TABLES, TABLES } from '../core/catalog'
export { rid } from '../core/route-ids'

/* ============================================================================
 * THE CITY PLAN
 *
 * One coordinate system for everybody. Y is up, ground plane is y = 0.
 * North is -Z, east is +X. One world unit ≈ one metre; a person would be ~1.8.
 *
 *                              ▲ -Z  (north)
 *              CLIENT TERMINAL  z ≈ -352 .. -288   (outside the server)
 *              SERVER BOUNDARY  z = -252           (fence + gatehouse)
 *              POSTMASTER  z = -215
 *              BACKENDS    z = -130   x = -112 .. 112
 *   MAINTENANCE            SHARED MEMORY PLAZA            WAL DISTRICT
 *   x = -250..-110         x = -78..78  z = -62..62       x = 110..250
 *              STORAGE (underground, y = -52)  x = -150..150  z = -110..110
 *              REPLICATION  z = +150 .. +340
 *                              ▼ +Z  (south)
 *
 * Districts must stay inside their footprint and must read every shared
 * position from ANCHOR / the helpers below — never hard-code a coordinate that
 * another district also needs.
 * ==========================================================================*/

export const CITY = {
  /** shared-memory plaza deck */
  deck: { w: 156, d: 124, top: 3, thickness: 2.4 },
  /** shared buffer grid */
  buf: { pitch: 2.9, tile: 2.3, baseY: 3.2, maxRise: 5.2, grid: BUF_GRID },
  /** backend row */
  backend: { z: -130, span: 224, w: 10, minH: 12, maxH: 26 },
  /** underground storage */
  storage: { y: -52, w: 300, d: 220, warehouseTop: -30 },
  /** OS page cache slab */
  osCache: { y: -24, w: 220, d: 160 },
  /** Explicit volatile-memory / durable-storage boundary below the kernel cache. */
  durability: { y: -27.4 },
  /**
   * The excavation. The ground plane is cut away over this rectangle so the
   * storage layer below is visible from the surface — the plaza floats over it.
   * Nothing that lives at y≈0 may be placed inside these bounds.
   */
  pit: { x: 118, z: 104, wallDepth: 60 },
  /** replica */
  replica: { z: 300, bufPitch: 3.0 },
  /** how far the ground plane / grid extends */
  ground: 1400,
  /** fog */
  fog: { near: 220, far: 1150 },
} as const

/* --------------------------------------------------------------------------
 * Named anchors. `[x, y, z]`.
 * ------------------------------------------------------------------------*/

export const ANCHOR = {
  cityCenter: [0, 6, 0],

  // clients & postmaster
  /**
   * The client terminal, at grade, outside the server boundary. `clientSky` is
   * the historical name and stays an export so nothing breaks; `clientTerminal`
   * is the one to reach for. Both are the same point.
   */
  clientSky: [0, 6, -300],
  clientTerminal: [0, 6, -300],
  postmaster: [0, 0, -215],
  postmasterTop: [0, 34, -215],
  /** Feet position in the postmaster's windowed top-floor control room. */
  controlCenter: [0, 27.8, -217],
  /** The gatehouse in the boundary fence — pg_hba.conf, at ground level. */
  connGate: [0, 0, -252],
  /** Where a connection is handed to the postmaster: its south door. */
  postmasterDoor: [0, 1.8, -206],

  // shared memory plaza
  plaza: [0, 3, 0],
  bufferGrid: [0, CITY.buf.baseY, 0],
  bufMapping: [-62, 3, 0],
  procArray: [-62, 3, -44],
  lockManager: [62, 3, -44],
  clogSlru: [-62, 3, 44],
  statsShmem: [62, 3, 44],
  walBuffers: [66, 3, 0],

  // WAL district
  walWriter: [128, 0, -34],
  walVault: [168, 0, 0],
  walVaultTop: [168, 14, 0],
  archiver: [210, 0, -50],
  archiveStore: [248, 0, -72],
  walSender: [210, 0, 46],
  logicalDecoder: [212, 0, 100],

  // maintenance yard
  checkpointer: [-140, 0, -40],
  bgWriter: [-140, 0, 34],
  autovacLauncher: [-196, 0, 0],
  vacDepot: [-212, 0, 0],
  landfill: [-234, 0, 76],
  logger: [-140, 0, 100],
  statsCollector: [-196, 0, 76],

  // walk-up controls, outside their owners' collision volumes
  handleAutovacuum: [-179.5, 0.72, 0],

  // storage underworld
  dataDir: [0, CITY.storage.y, 0],
  osCache: [0, CITY.osCache.y, 0],
  toastYard: [26, CITY.storage.y, 84],
  indexRow: [0, CITY.storage.y, 26],
  diskArray: [0, CITY.storage.y - 10, -104],

  // replication
  standby: [120, 0, 246],
  walReceiver: [120, 0, 200],
  startupProc: [120, 0, 246],
  replicaBuffers: [120, 3, 300],
  replicaStorage: [120, -34, 300],
  /**
   * The read-only client's terminal, at grade south-west of the standby deck.
   * It is an application tier, so it stands off the cluster's own ground with
   * its own apron, exactly like the primary's client terminal — and its reads
   * reach the deck along a surface run, not down from above.
   */
  replicaClient: [56, 0, 330],
  subscriber: [252, 0, 208],

  /* --- the continuity quarter: backups, PITR, and failover ---------------
   *
   * Three works, deliberately OFF the primary's site, because that is what
   * makes them worth anything. The archive estate is east, downstream of the
   * archiver that already exists. The recovery ground is south-west, on its
   * own iron, a long haul road away — restoring is not a local operation.
   * HA coordination spans the three failure-domain platforms; it is not a
   * fourth central machine between the standbys.
   * --------------------------------------------------------------------- */

  // the archive estate (east, outside the server): WAL-G's object storage
  /** Where the city hands a finished segment to something it does not own. */
  archiveGate: [300, 0, -70],
  /** The switchyard. One deck per timeline; a turnout onto a siding is a fork. */
  timelineYard: [344, 0, -44],
  /** The bucket: WAL segment silos, grouped by timeline, plus the .history shelf. */
  objectStore: [396, 0, -80],
  /** WAL-G backup-push objects in the same object-storage estate. */
  backupVault: [396, 0, 96],

  // the recovery ground (south-west, a different machine on a different site)
  recoveryGate: [-286, 0, 300],
  /** The empty data directory the base backup is unpacked onto. */
  recoveryPad: [-320, 0, 246],
  /** restore_command: ordered replay; WAL-G may prefetch later objects. */
  restoreWinch: [-262, 0, 214],
  /** recovery_target_time — the dial the whole of PITR turns on. */
  recoveryClock: [-320, 0, 178],
  /** The startup process replaying, with a stop line painted across the belt. */
  recoveryReplay: [-372, 0, 208],

  // high availability: three failure domains, one Raft-committed leader key
  /**
   * The rejoin bay. A node that has lost the leader key cannot simply follow
   * the winner: after an UNPLANNED failover its own pg_wal has diverged, so it
   * must be rewound (pg_rewind) or rebuilt (pg_basebackup) first. Two gates,
   * one siding, and the prerequisite list on a board.
   */
  rejoinBay: [-56, 0, 232],
  /**
   * The endpoint clients actually dial. It stands on the arrivals avenue,
   * OUTSIDE the server boundary, in the central corridor the conduits are
   * forbidden to enter (|x| < CONDUIT.clearX) — a router in front of the
   * database, which is the only place a router can honestly be. It is inside
   * DISTRICT_BOUNDS.clients; the clients district must keep |x| <= 18,
   * z = -284 .. -268 clear.
   */
  endpoint: [0, 0, -276],
  /** Label anchor for the Raft links; consensus itself is not a central node. */
  consensus: [0, 0, 150],
  /** Raised platforms make the independent failure domains legible. */
  haPrimarySite: [0, 0, -215],
  haStandbyASite: [170, 0, 260],
  haStandbyBSite: [-170, 0, 262],
  /** One local Patroni process beside each PostgreSQL node. */
  patroniNode1: [-50, 0, -200],
  patroniNode2: [140, 0, 224],
  patroniNode3: [-140, 0, 226],
  /** One etcd member on each failure-domain platform. */
  leaseNode1: [50, 0, -200],
  leaseNode2: [200, 0, 224],
  leaseNode3: [-200, 0, 226],
  /** Node 3: the second streaming standby, on the western platform. */
  standbyB: [-112, 0, 262],
  standbyBDeck: [-112, 3, 288],
  /** Node 3's walreceiver, where its own wire makes landfall. */
  standbyBRecv: [-112, 0, 216],
  /** Node 3's own pg_wal, between its walreceiver and startup process. */
  standbyBWal: [-126, 0, 240],
  /** Node 3's own data directory, below its buffer-pool deck. */
  standbyBStorage: [-112, -34, 310],

  // the query lab floats above the backend row
  planner: [0, 66, -130],
} as const satisfies Record<string, readonly [number, number, number]>

export type AnchorId = keyof typeof ANCHOR

export const v3 = (a: readonly [number, number, number]) => new THREE.Vector3(a[0], a[1], a[2])
export const at = (id: AnchorId) => v3(ANCHOR[id])

/* --------------------------------------------------------------------------
 * THE TIMELINE SWITCHYARD.
 *
 * Plan-level because two things need it: world/continuity.ts builds the decks,
 * and the archive road below has to run along the live one.
 *
 * Time runs EAST. The live timeline is the through line, at the yard's own
 * grade. Every other timeline is a siding one step above it, taken through a
 * turnout at the LSN where it branched — and a siding never rejoins, because
 * a timeline never does. The plaque at each turnout is the `.history` file.
 * Later timelines fork further east and are shorter, which is true: they hold
 * only the WAL written after the branch.
 * ------------------------------------------------------------------------*/

export const CONTINUITY = {
  yard: {
    /** Through line: timeline 1, the one the city is writing right now. */
    x0: 302,
    x1: 390,
    z: -44,
    /** Top of the deck slab. Traffic rides ~1.6 m above it. */
    deckY: 7,
    width: 7,
  },
  /** Sidings, west to east. `forkX` is the turnout; the deck starts 14 m later. */
  branches: [
    { forkX: 316, z: -30, deckY: 10.5 },
    { forkX: 330, z: -16, deckY: 10.5 },
    { forkX: 344, z: -2, deckY: 10.5 },
  ],
  /** Object-store silos: rows are timelines, columns are segments. */
  silo: { rows: 2, cols: 8, pitchX: 6.4, pitchZ: 7, radius: 2.4, height: 6 },
  /** Base backups kept in the vault, newest last. */
  backupSlots: 5,
} as const

/* --------------------------------------------------------------------------
 * Per-slot helpers.
 * ------------------------------------------------------------------------*/

/** X position of backend slot i (0 … N_BACKEND_SLOTS-1). */
export function backendX(i: number): number {
  const step = CITY.backend.span / (N_BACKEND_SLOTS - 1)
  return -CITY.backend.span / 2 + i * step
}
/** Canonical PID shown everywhere a backend process is identified. */
export function backendPid(i: number): number {
  return 21519 + i * 7
}
export function backendPos(i: number): [number, number, number] {
  return [backendX(i), 0, CITY.backend.z]
}

/* --------------------------------------------------------------------------
 * The connection conduits.
 *
 * A Postgres connection is not an event, it is a *thing*: a socket, a process,
 * a slab of memory, held for the whole session. So it is drawn as a physical
 * duct running from the client terminal to one backend, and it never leaves
 * the horizontal — `y` is constant the whole way, from the terminal wall to
 * the backend flank, carried on piers.
 *
 * Sixteen of them leave the terminal in two banks of eight, flanking the
 * central avenue that carries the postmaster. That gap is not decoration: the
 * postmaster forks the backend and then drops out of the data path entirely,
 * so no conduit is allowed to touch it.
 * ------------------------------------------------------------------------*/

export const CONDUIT = {
  /** Running height. Flat for the whole length — nothing here climbs or dives. */
  y: 6,
  /** Outer radius of the duct. Packets ride inside it. */
  radius: 2.4,
  /** |x| of the innermost / outermost duct where it leaves the terminal. */
  bankInner: 22,
  bankOuter: 82,
  /** No duct may come closer than this to the centre line — the postmaster's. */
  clearX: 21,
  /** Terminal wall the ducts emerge from. */
  terminalFace: -290,
  /** The server boundary the ducts cross. */
  boundaryZ: -252,
  /** Backend wall the ducts plug into. */
  backendFace: -136,
} as const

/** X of connection conduit i where it leaves the client terminal. */
export function conduitX(i: number): number {
  const half = N_BACKEND_SLOTS / 2
  const step = (CONDUIT.bankOuter - CONDUIT.bankInner) / (half - 1)
  const west = i < half
  const k = west ? half - 1 - i : i - half
  const x = CONDUIT.bankInner + k * step
  return west ? -x : x
}

/** X position of table i in the storage underworld. */
export function tableX(i: number): number {
  const xs = [-104, -52, 0, 52, 104]
  return xs[i % xs.length]
}
export function tablePos(i: number): [number, number, number] {
  return [tableX(i), CITY.storage.y, -60]
}
export function indexPos(i: number): [number, number, number] {
  return [tableX(i), CITY.storage.y, 26]
}

/** Z position of WAL segment slot i in the vault. */
export function walSegZ(i: number): number {
  const step = 9
  return -((N_WAL_SEG_SLOTS - 1) * step) / 2 + i * step
}

/** Home position of autovacuum worker slot i. */
export function vacBayPos(i: number): [number, number, number] {
  return [ANCHOR.vacDepot[0], 0, -26 + i * 26]
}

/** World position of shared-buffer tile index (0 … N_BUFFERS-1). */
export function bufferTilePos(idx: number): [number, number, number] {
  const g = CITY.buf.grid
  const col = idx % g
  const row = Math.floor(idx / g)
  const half = ((g - 1) * CITY.buf.pitch) / 2
  return [-half + col * CITY.buf.pitch, CITY.buf.baseY, -half + row * CITY.buf.pitch]
}

/* --------------------------------------------------------------------------
 * ROUTES — the road network.
 *
 * Every animated packet in the city travels along one of these. Districts emit
 * onto a route by id; engine/flows.ts owns the particles. Routes whose
 * `visible` flag is set also get a faint physical "road" drawn along them.
 * ------------------------------------------------------------------------*/

const R: Record<string, RouteDef> = {}

function route(
  id: string,
  points: [number, number, number][],
  opts: Partial<Omit<RouteDef, 'id' | 'points'>> = {},
): RouteDef {
  const def: RouteDef = {
    id,
    points,
    color: opts.color ?? COLOR.backend,
    speed: opts.speed ?? 90,
    size: opts.size ?? 1.1,
    visible: opts.visible ?? false,
    roadOpacity: opts.roadOpacity ?? 0.16,
    tension: opts.tension ?? 0.5,
    linear: opts.linear ?? false,
  }
  R[id] = def
  return def
}

/* --- clients & postmaster ------------------------------------------------ */

/* The arrivals avenue: terminal door → boundary gate → the postmaster's door.
 * A street, walked at a walking pace, entirely at grade. */
route('conn.in', [
  [0, 1.8, -288],
  [0, 1.8, -270],
  [0, 1.8, CONDUIT.boundaryZ],
  [0, 1.8, -230],
  [ANCHOR.postmasterDoor[0], ANCHOR.postmasterDoor[1], ANCHOR.postmasterDoor[2]],
], { color: COLOR.client, speed: 70, visible: true, roadOpacity: 0.14, size: 1.4 })

/* --- per-backend routes -------------------------------------------------- */

for (let i = 0; i < N_BACKEND_SLOTS; i++) {
  const bx = backendX(i)
  const bz = CITY.backend.z
  const lean = bx * 0.42

  // postmaster forks a new backend: out of its south door, down the yard road
  route(rid.fork(i), [
    [0, 1.8, -202],
    [bx * 0.35, 1.8, -184],
    [bx * 0.8, 1.8, -158],
    [bx, 1.8, -140],
    [bx, 4.5, bz - 4],
  ], { color: COLOR.postmaster, speed: 110, size: 1.4 })

  /* The connection conduit. `query` is the duct's centre line, so the tube in
   * world/clients.ts is built straight off this curve. `result` reverses that
   * same spine: PostgreSQL requests and rows share one bidirectional socket,
   * while the flow renderer's sub-radius scatter keeps passing packets apart. */
  const cx = conduitX(i)
  const cy = CONDUIT.y
  let mx = cx + (bx - cx) * 0.25
  if (Math.abs(mx) < CONDUIT.clearX) mx = mx < 0 ? -CONDUIT.clearX : CONDUIT.clearX
  const fx = cx + (bx - cx) * 0.72
  route(rid.query(i), [
    [cx, cy, CONDUIT.terminalFace],
    [cx, cy, -262],
    [mx, cy, -224],
    [fx, cy, -180],
    [bx, cy, -150],
    [bx, cy, CONDUIT.backendFace],
  ], { color: COLOR.client, speed: 96, size: 1.1, tension: 0.4 })

  route(rid.result(i), [
    [bx, cy, CONDUIT.backendFace],
    [bx, cy, -150],
    [fx, cy, -180],
    [mx, cy, -224],
    [cx, cy, -262],
    [cx, cy, CONDUIT.terminalFace],
  ], { color: COLOR.ok, speed: 104, size: 0.95, tension: 0.4 })

  // backend asks shared buffers for a page, and gets one back
  route(rid.bufReq(i), [
    [bx, 10, bz + 4],
    [lean, 12, -96],
    [lean * 0.5, 9, -68],
    [lean * 0.28, 7, -46],
  ], { color: COLOR.backend, speed: 105, size: 1.0 })

  route(rid.bufRet(i), [
    [lean * 0.28, 7, -46],
    [lean * 0.5 + 2, 10, -70],
    [lean + 2, 13, -98],
    [bx + 2, 10, bz + 4],
  ], { color: COLOR.bufClean, speed: 105, size: 1.0 })

  // WAL records travel east from the backend to wal_buffers
  route(rid.walIns(i), [
    [bx, 11, bz + 2],
    [bx * 0.4 + 44, 20, -84],
    [78, 14, -38],
    [ANCHOR.walBuffers[0], 6, ANCHOR.walBuffers[2]],
  ], { color: COLOR.wal, speed: 125, size: 1.15 })

  // a blocked backend's "please let me in" ping to the lock manager
  route(rid.lockWait(i), [
    [bx, 12, bz + 2],
    [bx * 0.5 + 30, 16, -86],
    [ANCHOR.lockManager[0], 8, ANCHOR.lockManager[2]],
  ], { color: COLOR.lock, speed: 90, size: 1.0 })
}

/* --- storage I/O --------------------------------------------------------- */

for (let t = 0; t < N_TABLES; t++) {
  const tx = tableX(t)
  const c = TABLES[t].color

  // page fault: disk rack → OS cache → shared buffers
  route(rid.ioRead(t), [
    [tx, CITY.storage.y + 6, -99],
    [tx * 0.85, CITY.osCache.y, -34],
    [tx * 0.45, -8, -6],
    [tx * 0.22, 6, 22],
  ], { color: c, speed: 78, size: 1.2, visible: true, roadOpacity: 0.08 })

  // kernel-cache hit: the short path never descends to the disk rack
  route(rid.ioReadCache(t), [
    [tx * 0.85, CITY.osCache.y, -34],
    [tx * 0.45, -8, -6],
    [tx * 0.22, 6, 22],
  ], { color: COLOR.ok, speed: 92, size: 1.05, visible: true, roadOpacity: 0.05 })

  // eviction / checkpoint write: shared buffers → kernel → disk rack
  route(rid.ioWrite(t), [
    [tx * 0.22 - 3, 6, 26],
    [tx * 0.45 - 3, -8, -2],
    [tx * 0.85 - 3, CITY.osCache.y, -32],
    [tx, CITY.storage.y + 6, -99],
  ], { color: COLOR.bufDirty, speed: 78, size: 1.2 })

  // index probe: heap ← → index structure
  route(rid.idxLookup(t), [
    [tx, CITY.storage.warehouseTop + 4, 26],
    [tx, CITY.storage.warehouseTop + 6, -18],
    [tx, CITY.storage.warehouseTop + 2, -56],
  ], { color: COLOR.index, speed: 70, size: 0.9 })

  // autovacuum worker's road out to the table and back to the landfill
  route(rid.vacGo(t), [
    [ANCHOR.vacDepot[0], 4, ANCHOR.vacDepot[2]],
    [-176, -8, -30],
    [-150, CITY.osCache.y, -50],
    [tx - 26, CITY.storage.warehouseTop + 3, -62],
    [tx, CITY.storage.warehouseTop + 3, -60],
  ], { color: COLOR.vacuum, speed: 60, size: 1.3, visible: true, roadOpacity: 0.1 })

  route(rid.vacIdx(t), [
    [tx, CITY.storage.warehouseTop + 3, -58],
    [tx, CITY.storage.warehouseTop + 8, -16],
    [tx, CITY.storage.warehouseTop + 3, 24],
  ], { color: COLOR.vacuum, speed: 55, size: 1.1 })

  route(rid.vacBack(t), [
    [tx, CITY.storage.warehouseTop + 3, -58],
    [-150, CITY.osCache.y - 4, -40],
    [-196, -10, 20],
    [ANCHOR.landfill[0], 8, ANCHOR.landfill[2]],
  ], { color: COLOR.vacuum, speed: 62, size: 1.25 })

  // Removed tuple bodies are only a temporary teaching pile. Their space is
  // returned to the originating relation's _fsm fork for reuse.
  route(rid.fsmReturn(t), [
    [ANCHOR.landfill[0] + 7, 5, ANCHOR.landfill[2]],
    [-196, -10, 30],
    [-150, CITY.osCache.y - 4, -34],
    [tx - 8.3, CITY.storage.warehouseTop + 2, -58],
  ], { color: COLOR.vacuum, speed: 72, size: 0.8 })
}

/* --- WAL pipeline -------------------------------------------------------- */

route('wal.flush', [
  [ANCHOR.walBuffers[0], 6, ANCHOR.walBuffers[2]],
  [96, 10, -14],
  [116, 9, -30],
  [ANCHOR.walWriter[0], 9, ANCHOR.walWriter[2]],
], { color: COLOR.wal, speed: 110, size: 1.3, visible: true, roadOpacity: 0.18 })

route('wal.write', [
  [ANCHOR.walWriter[0], 9, ANCHOR.walWriter[2]],
  [148, 12, -18],
  [ANCHOR.walVaultTop[0], 12, ANCHOR.walVaultTop[2]],
], { color: COLOR.wal, speed: 100, size: 1.4, visible: true, roadOpacity: 0.18 })

route('wal.fsync', [
  [ANCHOR.walVault[0], 6, ANCHOR.walVault[2]],
  [168, -20, -40],
  [140, CITY.storage.y + 8, -96],
], { color: COLOR.wal, speed: 90, size: 1.2 })

route('wal.archive', [
  [ANCHOR.walVault[0] + 6, 8, -34],
  [ANCHOR.archiver[0], 8, ANCHOR.archiver[2]],
], { color: COLOR.archive, speed: 85, size: 1.3, visible: true, roadOpacity: 0.14 })

/* archive_command's one output path: out of the archiver, across the ownership
 * boundary, along the live timeline, and into the only archive store. */
route('archive.ship', [
  [ANCHOR.archiver[0] + 8, 8, ANCHOR.archiver[2] - 4],
  [284, 8.2, -70],
  [ANCHOR.archiveGate[0], 8.2, ANCHOR.archiveGate[2]],
  [CONTINUITY.yard.x0 + 1, CONTINUITY.yard.deckY + 1.6, -52],
  [CONTINUITY.yard.x0 + 12, CONTINUITY.yard.deckY + 1.6, CONTINUITY.yard.z],
  [350, CONTINUITY.yard.deckY + 1.6, CONTINUITY.yard.z],
  [CONTINUITY.yard.x1, CONTINUITY.yard.deckY + 1.6, CONTINUITY.yard.z],
  [ANCHOR.objectStore[0], 8.0, -62],
  [ANCHOR.objectStore[0], 7.0, ANCHOR.objectStore[2] + 8],
], { color: COLOR.archive, speed: 92, size: 1.3, visible: true, roadOpacity: 0.15, tension: 0.4 })

route('wal.stream', [
  [ANCHOR.walVault[0] + 6, 8, 32],
  [ANCHOR.walSender[0], 9, ANCHOR.walSender[2]],
], { color: COLOR.replication, speed: 105, size: 1.2, visible: true, roadOpacity: 0.14 })

route('logical.decode', [
  [ANCHOR.walVault[0] + 8, 8, 22],
  [ANCHOR.logicalDecoder[0], 9, ANCHOR.logicalDecoder[2]],
  [ANCHOR.subscriber[0], 10, ANCHOR.subscriber[2]],
], { color: COLOR.toast, speed: 90, size: 1.1, visible: true, roadOpacity: 0.12 })

/* --- replication over the wire ------------------------------------------- */

/* A cable route, not a trajectory. The duct climbs a riser out of the
 * walsender's cabinet, dives into the ground, runs south at grade for 130 m
 * along the east verge — clear of the excavation and of the logical decoder's
 * apron — and climbs a second riser into the landfall gantry at the
 * walreceiver. The ack duct is the same route in reverse, six metres inboard,
 * so the two share one bank. */
route('net.stream', [
  [ANCHOR.walSender[0] + 1, 7.0, ANCHOR.walSender[2] + 12],
  [207, 1.9, 68],
  [190, 1.6, 100],
  [176, 1.6, 140],
  [152, 1.8, 172],
  [132, 2.0, 184],
  [ANCHOR.walReceiver[0] + 4, 7.0, ANCHOR.walReceiver[2] - 12],
], { color: COLOR.replication, speed: 115, size: 1.4, visible: true, roadOpacity: 0.2 })

route('net.ack', [
  [ANCHOR.walReceiver[0] - 2, 7.0, ANCHOR.walReceiver[2] - 14],
  [127, 1.8, 181],
  [147, 1.5, 167],
  [171, 1.4, 136],
  [185, 1.4, 97],
  [201, 1.7, 67],
  [ANCHOR.walSender[0] - 5, 7.0, ANCHOR.walSender[2] + 12],
], { color: COLOR.ok, speed: 130, size: 1.0 })

route('replica.apply', [
  [ANCHOR.walReceiver[0], 8, ANCHOR.walReceiver[2]],
  [ANCHOR.startupProc[0], 9, ANCHOR.startupProc[2] - 14],
  [ANCHOR.startupProc[0], 8, ANCHOR.startupProc[2]],
], { color: COLOR.replication, speed: 80, size: 1.2 })

route('replica.buffer', [
  [ANCHOR.startupProc[0], 8, ANCHOR.startupProc[2] + 6],
  [ANCHOR.replicaBuffers[0], 7, ANCHOR.replicaBuffers[2] - 20],
  [ANCHOR.replicaBuffers[0], 6, ANCHOR.replicaBuffers[2]],
], { color: COLOR.bufDirty, speed: 75, size: 1.0 })

route('replica.io', [
  [ANCHOR.replicaBuffers[0], 4, ANCHOR.replicaBuffers[2] + 8],
  [ANCHOR.replicaStorage[0], -18, ANCHOR.replicaStorage[2] + 4],
  [ANCHOR.replicaStorage[0], -32, ANCHOR.replicaStorage[2]],
], { color: COLOR.storage, speed: 70, size: 1.0 })

/* A surface run: out of the terminal's east canopy, north-east across the
 * apron on a shallow duct, up the deck's west ramp onto the read-only landing
 * pad. hot_standby_feedback comes back along the same run before it joins the
 * ack duct north, so the standby's xmin never leaves the ground either. */
route('replica.read', [
  [ANCHOR.replicaClient[0] + 17, 2.4, ANCHOR.replicaClient[2] - 2],
  [78, 2.0, 322],
  [92, 2.2, 308],
  [ANCHOR.replicaBuffers[0] - 22, 3.0, ANCHOR.replicaBuffers[2]],
  [ANCHOR.replicaBuffers[0] - 18, 5.6, ANCHOR.replicaBuffers[2]],
], { color: COLOR.client, speed: 110, size: 1.0, visible: true, roadOpacity: 0.14 })

/* --- maintenance --------------------------------------------------------- */

route('ckpt.sweep', [
  [ANCHOR.checkpointer[0] + 10, 12, ANCHOR.checkpointer[2]],
  [-104, 12, -30],
  [-74, 9, -16],
  [-46, 7, -6],
], { color: COLOR.checkpoint, speed: 95, size: 1.3, visible: true, roadOpacity: 0.16 })

route('bgw.sweep', [
  [ANCHOR.bgWriter[0] + 10, 10, ANCHOR.bgWriter[2]],
  [-104, 10, 30],
  [-74, 8, 20],
  [-46, 7, 10],
], { color: COLOR.bgwriter, speed: 95, size: 1.1, visible: true, roadOpacity: 0.16 })

route('ckpt.fsync', [
  [-46, 7, 8],
  [-30, -14, 20],
  [-10, CITY.storage.y + 12, -20],
  [ANCHOR.diskArray[0], CITY.storage.y + 6, ANCHOR.diskArray[2] + 10],
], { color: COLOR.checkpoint, speed: 80, size: 1.2 })

route('vac.launch', [
  [ANCHOR.autovacLauncher[0], 12, ANCHOR.autovacLauncher[2]],
  [ANCHOR.postmaster[0], 12, ANCHOR.postmaster[2]],
  [ANCHOR.vacDepot[0] + 4, 8, 0],
], { color: COLOR.vacuum, speed: 90, size: 1.2 })

route('stats.in', [
  [0, 10, CITY.backend.z + 4],
  [42, 9, -30],
  [ANCHOR.statsShmem[0], 6, ANCHOR.statsShmem[2]],
], { color: COLOR.inkDim, speed: 100, size: 0.8 })

route('clog.in', [
  [0, 10, CITY.backend.z + 4],
  [-42, 9, -22],
  [ANCHOR.clogSlru[0], 6, ANCHOR.clogSlru[2]],
], { color: COLOR.shmem, speed: 100, size: 0.8 })

route('procarray.in', [
  [0, 10, CITY.backend.z + 4],
  [-40, 9, -66],
  [ANCHOR.procArray[0], 6, ANCHOR.procArray[2]],
], { color: COLOR.shmem, speed: 100, size: 0.8 })

route('bufmap.in', [
  [0, 10, CITY.backend.z + 4],
  [-42, 8, -62],
  [ANCHOR.bufMapping[0], 6, ANCHOR.bufMapping[2]],
], { color: COLOR.shmem, speed: 110, size: 0.8 })

/* --- continuity: the archive estate, the recovery ground, the HA quarter --
 *
 * Four roads matter here and the rest are local moves:
 *
 *   wal.archive    the finished segment leaving the site for good
 *   backup.push    WAL-G from standby_a straight to the S3 backup prefix
 *   restore.haul   the ONE road back — base backup and archived WAL both ride
 *                  it, because they both come out of the same bucket
 *   net.streamB    the second standby's wire, a third duct in the same bank
 *                  as far as z ≈ 150, then peeling west on its own
 * ------------------------------------------------------------------------*/

/* WAL-G runs on standby_a and streams the full backup directly into the
 * base-backup prefix of the object store. There is no repository host. */
route('backup.push', [
  [ANCHOR.standby[0] + 16, 6, ANCHOR.standby[2] + 8],
  [180, 5, 258],
  [240, 5, 252],
  [300, 6, 232],
  [352, 6, 200],
  [378, 6, 152],
  [ANCHOR.backupVault[0], 6, ANCHOR.backupVault[2] + 16],
], { color: COLOR.storage, speed: 78, size: 1.25, visible: true, roadOpacity: 0.13 })

/* The long way home. Deliberately long: restoring is not a local operation,
 * and the road runs right round the outside of the city to say so. */
route('restore.haul', [
  [400, 4, 20],
  [402, 3, 90],
  [386, 3, 170],
  // wide of the standby's plinth (replication ends at x 280 / z 350) the whole
  // way round: the haul road belongs to nobody's district
  [356, 3, 286],
  [286, 3, 364],
  [160, 3, 404],
  [0, 3, 412],
  [-150, 3, 398],
  [-244, 3, 352],
  [ANCHOR.recoveryGate[0], 3, ANCHOR.recoveryGate[2]],
], { color: COLOR.archive, speed: 96, size: 1.2, visible: true, roadOpacity: 0.09 })

/* base-backup tar objects onto an empty data directory */
route('restore.unpack', [
  [ANCHOR.recoveryGate[0], 3, ANCHOR.recoveryGate[2]],
  [-306, 3, 278],
  [ANCHOR.recoveryPad[0] + 4, 4, ANCHOR.recoveryPad[2] + 12],
], { color: COLOR.storage, speed: 70, size: 1.3, visible: true, roadOpacity: 0.14 })

/* restore_command: the winch lays one segment onto PostgreSQL's ordered replay
 * belt. WAL-G may already be prefetching later objects concurrently. */
route('restore.replay', [
  [ANCHOR.recoveryGate[0] + 2, 4, 284],
  [ANCHOR.restoreWinch[0], 8, ANCHOR.restoreWinch[2] + 8],
  [-300, 7, 212],
  [ANCHOR.recoveryReplay[0] + 16, 6, ANCHOR.recoveryReplay[2]],
], { color: COLOR.wal, speed: 72, size: 1.25, visible: true, roadOpacity: 0.15 })

/* the startup process writing replayed pages into the restored cluster */
route('restore.apply', [
  [ANCHOR.recoveryReplay[0], 6, ANCHOR.recoveryReplay[2] - 10],
  [-350, 6, 214],
  [-330, 6, 232],
  [ANCHOR.recoveryPad[0], 5, ANCHOR.recoveryPad[2]],
], { color: COLOR.bufClean, speed: 68, size: 1.1, visible: true, roadOpacity: 0.12 })

/* Node 3's wire. One more walsender in the same cabinet, one more duct in the
 * same bank down the east verge, then west across the southern approach. */
route('net.streamB', [
  [ANCHOR.walSender[0] - 7, 7.0, ANCHOR.walSender[2] + 10],
  [196, 1.9, 70],
  [180, 1.6, 102],
  [164, 1.6, 140],
  [130, 1.7, 163],
  [60, 1.7, 172],
  [-30, 1.7, 178],
  [-92, 1.8, 196],
  [ANCHOR.standbyBRecv[0] + 4, 7.0, ANCHOR.standbyBRecv[2] - 8],
], { color: COLOR.replication, speed: 115, size: 1.3, visible: true, roadOpacity: 0.16 })

route('net.ackB', [
  [ANCHOR.standbyBRecv[0] - 2, 7.0, ANCHOR.standbyBRecv[2] - 10],
  [-94, 1.8, 190],
  [-32, 1.7, 172],
  [58, 1.7, 166],
  [126, 1.7, 157],
  [160, 1.6, 135],
  [176, 1.6, 99],
  [193, 1.9, 68],
  [ANCHOR.walSender[0] - 11, 7.0, ANCHOR.walSender[2] + 8],
], { color: COLOR.ok, speed: 130, size: 0.95 })

/* Node 3 has the same received → flushed → applied pipeline as standby_a. */
route('replicaB.apply', [
  [ANCHOR.standbyBRecv[0], 8, ANCHOR.standbyBRecv[2]],
  [ANCHOR.standbyBWal[0], 8, ANCHOR.standbyBWal[2]],
  [ANCHOR.standbyB[0], 9, ANCHOR.standbyB[2] - 14],
  [ANCHOR.standbyB[0], 8, ANCHOR.standbyB[2]],
], { color: COLOR.replication, speed: 76, size: 1.1 })

route('replicaB.buffer', [
  [ANCHOR.standbyB[0], 8, ANCHOR.standbyB[2]],
  [ANCHOR.standbyBDeck[0], 6, ANCHOR.standbyBDeck[2] - 8],
  [ANCHOR.standbyBDeck[0], 5, ANCHOR.standbyBDeck[2]],
], { color: COLOR.replication, speed: 76, size: 1.1 })

route('replicaB.io', [
  [ANCHOR.standbyBDeck[0], 4, ANCHOR.standbyBDeck[2] + 8],
  [ANCHOR.standbyBStorage[0], -18, ANCHOR.standbyBStorage[2] - 4],
  [ANCHOR.standbyBStorage[0], -32, ANCHOR.standbyBStorage[2]],
], { color: COLOR.storage, speed: 70, size: 1.0 })

/* Each Patroni agent talks to its local etcd endpoint. Raft peer links are
 * separate from physical replication: they carry coordination, never WAL. */
route('ha.lease1', [
  [ANCHOR.patroniNode1[0], 6, ANCHOR.patroniNode1[2]],
  [ANCHOR.leaseNode1[0], 6, ANCHOR.leaseNode1[2]],
], { color: COLOR.inkDim, speed: 120, size: 0.85, visible: true, roadOpacity: 0.1 })

route('ha.lease2', [
  [ANCHOR.patroniNode2[0], 6, ANCHOR.patroniNode2[2]],
  [ANCHOR.leaseNode2[0], 6, ANCHOR.leaseNode2[2]],
], { color: COLOR.inkDim, speed: 120, size: 0.85, visible: true, roadOpacity: 0.1 })

route('ha.lease3', [
  [ANCHOR.patroniNode3[0], 6, ANCHOR.patroniNode3[2]],
  [ANCHOR.leaseNode3[0], 6, ANCHOR.leaseNode3[2]],
], { color: COLOR.inkDim, speed: 120, size: 0.85, visible: true, roadOpacity: 0.1 })

route('ha.raft12', [
  [ANCHOR.leaseNode1[0], 8, ANCHOR.leaseNode1[2]],
  [ANCHOR.leaseNode2[0], 8, ANCHOR.leaseNode2[2]],
], { color: COLOR.ok, speed: 150, size: 1.2, visible: true, roadOpacity: 0.16 })

route('ha.raft13', [
  [ANCHOR.leaseNode1[0], 8, ANCHOR.leaseNode1[2]],
  [ANCHOR.leaseNode3[0], 8, ANCHOR.leaseNode3[2]],
], { color: COLOR.ok, speed: 150, size: 1.2, visible: true, roadOpacity: 0.16 })

route('ha.raft23', [
  [ANCHOR.leaseNode2[0], 8, ANCHOR.leaseNode2[2]],
  [ANCHOR.leaseNode3[0], 8, ANCHOR.leaseNode3[2]],
], { color: COLOR.ok, speed: 150, size: 1.2, visible: true, roadOpacity: 0.16 })

/* --- exports ------------------------------------------------------------- */

export const ROUTES: Readonly<Record<string, RouteDef>> = R
export const ROUTE_IDS = Object.keys(R)

const curveCache = new Map<string, THREE.CatmullRomCurve3>()

/**
 * Memoised curve for a route. Districts can use this to move *meshes* along a
 * road (autovacuum trucks, the WAL train) — not just particles.
 */
export function routeCurve(id: string): THREE.CatmullRomCurve3 | null {
  const cached = curveCache.get(id)
  if (cached) return cached
  const def = ROUTES[id]
  if (!def) {
    console.warn(`[layout] unknown route "${id}"`)
    return null
  }
  const curve = new THREE.CatmullRomCurve3(
    def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    false,
    def.linear ? 'catmullrom' : 'catmullrom',
    def.tension ?? 0.5,
  )
  curveCache.set(id, curve)
  return curve
}

/** Convenience: point + tangent at t along a route. */
const _tmp = new THREE.Vector3()
export function routePoint(id: string, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = routeCurve(id)
  if (!c) return out.set(0, 0, 0)
  return c.getPointAt(Math.max(0, Math.min(1, t)), out)
}
export function routeTangent(id: string, t: number, out = _tmp): THREE.Vector3 {
  const c = routeCurve(id)
  if (!c) return out.set(0, 0, 1)
  return c.getTangentAt(Math.max(0, Math.min(1, t)), out)
}

/** Approximate arc length, cached by three's curve implementation. */
export function routeLength(id: string): number {
  const c = routeCurve(id)
  return c ? c.getLength() : 1
}

export interface Bounds {
  x: [number, number]
  z: [number, number]
}

/** Every district's bounding footprint — used by the minimap and by district dimming. */
export const DISTRICT_BOUNDS: Record<string, Bounds> = {
  clients: { x: [-120, 120], z: [-360, -240] },
  backends: { x: [-124, 124], z: [-150, -110] },
  shmem: { x: [-84, 84], z: [-68, 68] },
  wal: { x: [108, 268], z: [-92, 120] },
  storage: { x: [-156, 156], z: [-116, 116] },
  maintenance: { x: [-256, -108], z: [-70, 110] },
  /* standby_a owns this district apron; standby_b has its own western site. */
  replication: { x: [40, 280], z: [150, 350] },
  planner: { x: [-70, 70], z: [-170, -90] },
  world: { x: [-400, 400], z: [-400, 400] },
} as const satisfies Record<string, { x: readonly [number, number] | number[]; z: readonly [number, number] | number[] }>
