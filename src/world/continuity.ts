import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import { CLAIM_VALUES } from '../core/claims'
import { configuredSynchronousStandby } from '../core/replication'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtDuration, fmtLsn } from '../core/util'
import { ANCHOR, CONTINUITY } from './layout'

/* ============================================================================
 * THE CONTINUITY QUARTER — backups and point-in-time recovery.
 *
 * The rest of the city answers "what is Postgres doing right now". This quarter
 * answers the two questions that decide whether anybody still has a job
 * tomorrow: can you get the data BACK, and can somebody else serve it when this
 * machine stops. It is built OFF the primary's site, because that is the whole
 * point of it, as three works:
 *
 *   ARCHIVE ESTATE   east, downstream of the archiver that already exists: a
 *                    gate you cannot carry anything back through, the TIMELINE
 *                    SWITCHYARD, the bucket, and its base-backup-object annex.
 *
 *   RECOVERY GROUND  south-west, a long haul road away, on its own iron: an
 *                    empty data directory, a winch that lifts one archived segment at
 *                    a time, a dial set to recovery_target_time, and a replay
 *                    belt with a stop line painted across it.
 *
 * THE ONE IDEA WORTH THE TRIP is the switchyard. A timeline is not a version
 * number and not a branch you can merge: it is a fork in the identity of the
 * WAL itself, taken at one LSN, recorded in a `.history` file, and stamped into
 * the first eight hex digits of every segment name after it. So it is a
 * railway. The live timeline is the through line; every other timeline is a
 * siding taken through a turnout at the LSN where it branched; the plaque at
 * the turnout is the `.history` file; and no siding ever rejoins, because no
 * timeline ever does.
 *
 * WHAT IS SIMULATED, AND WHAT IS NOT. The model owns archive retries, pg_wal
 * pressure, full backups, WAL-G retention, a restore that fetches one retained
 * backup before replaying archived WAL to recovery_target_time, a one-fork
 * recovery_target_timeline decision, and a restore drill whose proof level
 * adds modeled validation reads. Multi-fork trees and history parsing are
 * absent. The world only
 * projects that state. standby_b is a complete independent physical
 * standby. Three Patroni agents, etcd Raft consensus, the leader-key lease,
 * planned and unplanned promotion, the timeline fork, endpoint move, and
 * pg_rewind rejoin are projected across the failure-domain platforms.
 * ==========================================================================*/

/* --- module scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _qi = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _axisX = new THREE.Vector3(1, 0, 0)
const _axisY = new THREE.Vector3(0, 1, 0)

/** cx, cy, cz, w, h, d */
type Box = [number, number, number, number, number, number]

const N_VAULT = CONTINUITY.backupSlots
const N_SILO = CONTINUITY.silo.rows * CONTINUITY.silo.cols
const N_GATE_SEGMENT_CELLS = 16
const N_LEASE = 3
const BUF_B = 32
const N_TILE_B = BUF_B * BUF_B
const N_WAL_B = 8
const N_HISTORY = CONTINUITY.branches.length
/** Dark. Used for every unlit instance colour in the quarter. */
const OFF = 0x0a1120
const cssHex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0')

/** `00000002.history` — a timeline history file name. */
const historyName = (tli: number) => tli.toString(16).toUpperCase().padStart(8, '0') + '.history'

export const TIMELINE_RECOVERY_PLATE_LABEL = CLAIM_VALUES.timelineRecovery.plate

/* ==========================================================================
 * Factory.
 * ========================================================================*/

export const createContinuity: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx

  const group = new THREE.Group()
  group.name = 'world.continuity'

  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []
  const instanced: THREE.InstancedMesh[] = []

  const unitPlane = new THREE.PlaneGeometry(1, 1)
  const unitBox = new THREE.BoxGeometry(1, 1, 1)
  geos.push(unitPlane, unitBox)

  /** Detail only worth drawing when the camera is somewhere near. */
  const gDetail = new THREE.Group()
  gDetail.name = 'continuity.detail'
  group.add(gDetail)

  /* ---------------------------------------------------------------------
   * Builders. All of these run once, at construction.
   *
   * Matte structure is batched into ONE InstancedMesh per component, not one
   * for the whole quarter: the component's group has to *contain* its own
   * walls, or the picker has nothing to hit and the collision world has
   * nothing to stand on.
   * -------------------------------------------------------------------*/

  interface Part {
    host: THREE.Object3D
    boxes: Box[]
  }
  const parts: Part[] = []
  let cur: Part = { host: group, boxes: [] }
  parts.push(cur)

  const dimEdges: number[] = []
  const goldEdges: number[] = []

  function part(host: THREE.Object3D): void {
    cur = { host, boxes: [] }
    parts.push(cur)
  }

  function pushEdges(out: number[], b: Box): void {
    const [cx, cy, cz, w, h, d] = b
    const x0 = cx - w / 2, x1 = cx + w / 2
    const y0 = cy - h / 2, y1 = cy + h / 2
    const z0 = cz - d / 2, z1 = cz + d / 2
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ]
    const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
    for (let i = 0; i < e.length; i++) {
      const q = v[e[i]]
      out.push(q[0], q[1], q[2])
    }
  }

  /** Add a matte structural box to the current part. */
  function box(b: Box, edge: 'none' | 'dim' | 'gold' = 'dim'): void {
    cur.boxes.push(b)
    if (edge === 'dim') pushEdges(dimEdges, b)
    else if (edge === 'gold') pushEdges(goldEdges, b)
  }

  /**
   * A flat sign. `yaw` is the direction the face looks: 0 = south (+Z),
   * Math.PI = north, Math.PI / 2 = east, -Math.PI / 2 = west.
   */
  function plate(
    text: string,
    x: number, y: number, z: number,
    yaw: number,
    height: number,
    color: number,
    opacity = 0.9,
    host: THREE.Object3D = gDetail,
  ): THREE.Mesh {
    const tex = theme.textTexture(text, { size: 64, color: cssHex(color) })
    const img = tex.image as { width: number; height: number }
    const aspect = img && img.height ? img.width / img.height : 6
    const m = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    mats.push(m)
    const mesh = new THREE.Mesh(unitPlane, m)
    mesh.scale.set(height * aspect, height, 1)
    mesh.position.set(x, y, z)
    mesh.rotation.y = yaw
    mesh.renderOrder = 3
    mesh.raycast = () => {}
    host.add(mesh)
    return mesh
  }

  /** A neon slab with its own transform, for anything that moves or blinks. */
  function lamp(color: number, intensity: number, w: number, h: number, d: number, x: number, y: number, z: number, host: THREE.Object3D): THREE.Mesh {
    const mesh = new THREE.Mesh(unitBox, theme.neon(color, intensity))
    mesh.scale.set(w, h, d)
    mesh.position.set(x, y, z)
    mesh.raycast = () => {}
    host.add(mesh)
    return mesh
  }

  /** Instanced neon with per-instance colour. One material, one draw call. */
  function neonBank(name: string, geo: THREE.BufferGeometry, n: number, host: THREE.Object3D): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, theme.neon(0xffffff, 1.0), n)
    mesh.name = name
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    host.add(mesh)
    instanced.push(mesh)
    return mesh
  }

  /* ---------------------------------------------------------------------
   * 1. THE ARCHIVE GATE — where a segment stops being yours.
   * -------------------------------------------------------------------*/

  const gGate = new THREE.Group()
  gGate.name = 'archive.gate'
  group.add(gGate)
  part(gGate)

  const AG = ANCHOR.archiveGate
  box([AG[0], 7.5, AG[2] - 9, 3, 15, 3], 'gold')
  box([AG[0], 7.5, AG[2] + 9, 3, 15, 3], 'gold')
  box([AG[0], 15.8, AG[2], 3.4, 2.2, 21], 'gold')
  // the retry siding: where a segment waits while archive_command keeps failing
  box([AG[0] - 12, 3.4, AG[2] - 20, 16, 0.9, 6], 'dim')

  /** Three lamps under the lintel; exactly one is ever lit. */
  const gateLamp = [COLOR.ok, COLOR.warn, COLOR.crit].map((col) =>
    lamp(col, 1.5, 1.4, 0.7, 15, AG[0], 14.4, AG[2], gGate),
  )
  gateLamp[1].visible = false
  gateLamp[2].visible = false

  const retryCrate = lamp(COLOR.warn, 1.2, 4.5, 3.2, 3.2, AG[0] - 12, 5.6, AG[2] - 20, gGate)
  retryCrate.visible = false

  /** One cell per MiB in the primary's current, real 16 MiB segment. */
  const gateSegmentCells = neonBank('archive.gate.current-segment', unitBox, N_GATE_SEGMENT_CELLS, gGate)
  for (let i = 0; i < N_GATE_SEGMENT_CELLS; i++) {
    _p.set(AG[0] - 1.9, 12.8, AG[2] - 7.5 + i)
    _sc.set(0.5, 0.68, 0.72)
    _m.compose(_p, _qi, _sc)
    gateSegmentCells.setMatrixAt(i, _m)
    gateSegmentCells.setColorAt(i, _c.setHex(OFF))
  }
  gateSegmentCells.instanceMatrix.needsUpdate = true
  const gateSegmentClosed = lamp(COLOR.archive, 1.7, 0.62, 0.22, 16.2, AG[0] - 2.0, 13.35, AG[2], gGate)
  gateSegmentClosed.visible = false

  plate('RETENTION / OWNERSHIP BOUNDARY', AG[0] - 1.9, 19.4, AG[2], -Math.PI / 2, 2.1, COLOR.archive, 0.92, gGate)
  plate('PRIMARY CURRENT SEGMENT · 16 MiB · 1 CELL = 1 MiB', AG[0] - 2.0, 11.1, AG[2], -Math.PI / 2, 1.15, COLOR.wal, 0.86, gGate)
  plate(
    'wal-g wal-push: exit code 0 means STORED — otherwise the archiver retries the same file, forever',
    AG[0] - 1.9, 8.8, AG[2], -Math.PI / 2, 1.3, COLOR.inkDim, 0.62,
  )
  plate('retry siding', AG[0] - 12, 5.4, AG[2] - 24, 0, 1.6, COLOR.warn, 0.6)

  /* ---------------------------------------------------------------------
   * 2. THE TIMELINE SWITCHYARD.
   * -------------------------------------------------------------------*/

  const gYard = new THREE.Group()
  gYard.name = 'timeline.yard'
  group.add(gYard)
  part(gYard)

  const Y = CONTINUITY.yard
  const yardMidX = (Y.x0 + Y.x1) / 2

  // the through line: timeline 1, the one the city is writing into right now
  box([yardMidX, Y.deckY - 0.4, Y.z, Y.x1 - Y.x0, 0.8, Y.width], 'gold')
  for (let x = Y.x0 + 6; x <= Y.x1 - 6; x += 22) {
    box([x, (Y.deckY - 0.8) / 2, Y.z - 2.6, 1.8, Y.deckY - 0.8, 1.8], 'none')
    box([x, (Y.deckY - 0.8) / 2, Y.z + 2.6, 1.8, Y.deckY - 0.8, 1.8], 'none')
  }
  /* A lit rail down the through line. The deck is structure and stays matte;
   * the rail is the only thing here that means something — THIS is the timeline
   * being written into right now — so the rail, and only the rail, glows. */
  lamp(COLOR.wal, 1.35, Y.x1 - Y.x0, 0.32, 0.55, yardMidX, Y.deckY + 0.16, Y.z - 2.2, gYard)
  lamp(COLOR.wal, 1.35, Y.x1 - Y.x0, 0.32, 0.55, yardMidX, Y.deckY + 0.16, Y.z + 2.2, gYard)
  plate('timeline 1 · original history', Y.x0 + 20, Y.deckY + 3.4, Y.z - 5.2, Math.PI, 2.2, COLOR.wal, 0.95, gYard)

  const deckMat = theme.mat('continuity.deck', {
    color: 0x1a2032,
    roughness: 0.86,
    metalness: 0.2,
    emissive: 0x090d16,
  })

  /**
   * One siding per branch timeline, dark until a drill creates it. The ramp is
   * the turnout: it leaves the through line at the LSN of the branch, climbs
   * one step, and ends against a buffer stop — nothing on a dead timeline is
   * going anywhere.
   */
  const branchGroup: THREE.Group[] = []
  const branchLive: THREE.Mesh[] = []
  for (let k = 0; k < CONTINUITY.branches.length; k++) {
    const br = CONTINUITY.branches[k]
    const g = new THREE.Group()
    g.name = `timeline.branch.${k}`
    g.visible = false
    gYard.add(g)
    branchGroup.push(g)

    const dx = 14
    const dy = br.deckY - Y.deckY
    const dz = br.z - Y.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const ramp = new THREE.Mesh(unitBox, deckMat)
    ramp.scale.set(len, 0.8, Y.width - 1)
    ramp.position.set(br.forkX + dx / 2, Y.deckY - 0.4 + dy / 2, Y.z + dz / 2)
    _dir.set(dx, dy, dz).normalize()
    ramp.quaternion.setFromUnitVectors(_axisX, _dir)
    g.add(ramp)

    const x0 = br.forkX + dx
    const sideLen = Math.max(8, Y.x1 - x0)
    const deck = new THREE.Mesh(unitBox, deckMat)
    deck.scale.set(sideLen, 0.8, Y.width - 1)
    deck.position.set((x0 + Y.x1) / 2, br.deckY - 0.4, br.z)
    g.add(deck)

    // dead rail: gold, not amber — nothing is being written to this timeline
    lamp(COLOR.archive, 1.0, sideLen, 0.3, 0.5, (x0 + Y.x1) / 2, br.deckY + 0.16, br.z - 2.2, g)
    lamp(COLOR.archive, 1.0, sideLen, 0.3, 0.5, (x0 + Y.x1) / 2, br.deckY + 0.16, br.z + 2.2, g)
    const liveRail = lamp(COLOR.replication, 1.7, sideLen, 0.42, 0.64, (x0 + Y.x1) / 2, br.deckY + 0.22, br.z, g)
    liveRail.visible = false
    branchLive.push(liveRail)
    lamp(COLOR.crit, 1.1, 1.4, 2.4, Y.width - 1, Y.x1, br.deckY + 0.8, br.z, g)

    box([br.forkX, Y.deckY + 2.4, Y.z + 3.4, 0.9, 5.4, 0.9], 'none')
    const tli = 2 + k
    plate(historyName(tli), br.forkX, Y.deckY + 5.4, Y.z + 3.9, 0, 1.9, COLOR.archive, 0.95, g)
    plate(`timeline ${tli}`, x0 + 9, br.deckY + 2.6, br.z - 4.2, Math.PI, 1.9, COLOR.archive, 0.8, g)
  }

  const firstFork = CONTINUITY.branches[0].forkX
  const oldTailLen = Y.x1 - firstFork
  const oldTail = lamp(
    COLOR.crit,
    1.55,
    oldTailLen,
    0.48,
    0.72,
    firstFork + oldTailLen / 2,
    Y.deckY + 0.28,
    Y.z,
    gYard,
  )
  oldTail.name = 'timeline.old-divergent-tail'
  const forkBeacon = lamp(
    COLOR.warn,
    1.8,
    1.4,
    6.2,
    1.4,
    firstFork,
    Y.deckY + 3.2,
    Y.z,
    gYard,
  )
  forkBeacon.name = 'timeline.fork-beacon'
  oldTail.visible = false
  forkBeacon.visible = false

  box([yardMidX, 5.0, Y.z + 15, 24, 0.9, 0.7], 'none')
  box([yardMidX - 11, 2.5, Y.z + 15, 0.8, 5, 0.8], 'none')
  box([yardMidX + 11, 2.5, Y.z + 15, 0.8, 5, 0.8], 'none')
  plate('TIMELINE SWITCHYARD', yardMidX, 7.6, Y.z + 15, 0, 2.6, COLOR.archive, 0.9, gYard)
  plate(
    'one deck per timeline · a turnout is a fork · the plaque is the .history file · nothing ever rejoins',
    yardMidX, 4.4, Y.z + 15.5, 0, 1.35, COLOR.inkDim, 0.66,
  )
  plate(
    TIMELINE_RECOVERY_PLATE_LABEL,
    yardMidX, 2.5, Y.z + 15.5, 0, 1.35, COLOR.inkDim, 0.62,
  )

  /* ---------------------------------------------------------------------
   * 3. THE BUCKET — segments filed by timeline, and the history shelf.
   * -------------------------------------------------------------------*/

  const gStore = new THREE.Group()
  gStore.name = 'object.store'
  group.add(gStore)
  part(gStore)

  const OS = ANCHOR.objectStore
  const S = CONTINUITY.silo
  const yardHalfZ = (S.rows * S.pitchZ) / 2
  box([OS[0], 0.3, OS[2], S.cols * S.pitchX + 8, 0.6, S.rows * S.pitchZ + 10], 'none')
  box([OS[0] - 20, 1.8, OS[2] + 20, 12, 3.6, 4], 'gold')

  const siloBody = new THREE.InstancedMesh(
    theme.cyl(S.radius, S.radius, S.height, 12),
    theme.mat('continuity.silo', { color: 0x1d2438, roughness: 0.8, metalness: 0.3 }),
    N_SILO,
  )
  siloBody.name = 'object.store.silos'
  siloBody.frustumCulled = false
  gStore.add(siloBody)
  instanced.push(siloBody)

  const siloCap = neonBank('object.store.caps', theme.cyl(S.radius + 0.2, S.radius + 0.2, 0.5, 12), N_SILO, gStore)

  const siloX = (c: number) => OS[0] + (c - (S.cols - 1) / 2) * S.pitchX
  const siloZ = (r: number) => OS[2] + (r - (S.rows - 1) / 2) * S.pitchZ

  for (let r = 0; r < S.rows; r++) {
    for (let c = 0; c < S.cols; c++) {
      const i = r * S.cols + c
      _sc.set(1, 1, 1)
      _p.set(siloX(c), S.height / 2 + 0.6, siloZ(r))
      _m.compose(_p, _qi, _sc)
      siloBody.setMatrixAt(i, _m)
      _p.y = S.height + 0.85
      _m.compose(_p, _qi, _sc)
      siloCap.setMatrixAt(i, _m)
      siloCap.setColorAt(i, _c.setHex(OFF))
    }
    plate(`tl ${r + 1}`, siloX(0) - 6, 3.6, siloZ(r), -Math.PI / 2, 1.7, r === 0 ? COLOR.wal : COLOR.archive, 0.7)
  }
  siloBody.instanceMatrix.needsUpdate = true
  siloCap.instanceMatrix.needsUpdate = true

  const historyTablet = neonBank('object.store.history', unitBox, N_HISTORY, gStore)
  for (let k = 0; k < N_HISTORY; k++) {
    _p.set(OS[0] - 23.4 + k * 3.4, 4.0, OS[2] + 20)
    _sc.set(2.4, 0.4, 3.2)
    _m.compose(_p, _qi, _sc)
    historyTablet.setMatrixAt(k, _m)
    historyTablet.setColorAt(k, _c.setHex(OFF))
  }
  historyTablet.instanceMatrix.needsUpdate = true

  plate('S3 OBJECT STORAGE', OS[0], 12.4, OS[2] - yardHalfZ - 6, Math.PI, 3.0, COLOR.archive, 0.9, gStore)
  plate('one silo = one 16 MiB segment · one row = one timeline', OS[0], 9.0, OS[2] - yardHalfZ - 6.4, Math.PI, 1.45, COLOR.inkDim, 0.66)
  plate('latest 8 shown · retained archive never wraps', OS[0], 6.8, OS[2] - yardHalfZ - 6.4, Math.PI, 1.2, COLOR.inkDim, 0.6)
  plate('.history — small, and kept forever', OS[0] - 20, 5.6, OS[2] + 23, 0, 1.4, COLOR.inkDim, 0.66)

  /* ---------------------------------------------------------------------
   * 4. BASE-BACKUP OBJECTS in the same object-storage estate.
   * -------------------------------------------------------------------*/

  const gVault = new THREE.Group()
  gVault.name = 'backup.vault'
  group.add(gVault)
  part(gVault)

  const BV = ANCHOR.backupVault
  const vaultSpan = N_VAULT * 14 + 8
  const vaultX = (i: number) => BV[0] + (i - (N_VAULT - 1) / 2) * 14
  box([BV[0], 0.3, BV[2], vaultSpan, 0.6, 26], 'none')
  for (let i = 0; i < N_VAULT; i++) box([vaultX(i), 4.6, BV[2], 10, 8, 12], 'dim')
  box([BV[0], 0.35, BV[2] + 18, vaultSpan, 0.5, 2.8], 'none')

  const vaultSeam = neonBank('backup.vault.seams', unitBox, N_VAULT, gVault)
  for (let i = 0; i < N_VAULT; i++) {
    _p.set(vaultX(i), 8.9, BV[2])
    _sc.set(10.4, 0.5, 12.4)
    _m.compose(_p, _qi, _sc)
    vaultSeam.setMatrixAt(i, _m)
    vaultSeam.setColorAt(i, _c.setHex(OFF))
  }
  vaultSeam.instanceMatrix.needsUpdate = true

  /** How far back you could actually restore to: backup + the WAL after it. */
  const windowBar = lamp(COLOR.storage, 1.3, 1, 0.55, 2.2, BV[0], 0.72, BV[2] + 18, gVault)

  plate('BASE-BACKUP OBJECTS', BV[0], 12.6, BV[2] - 14, Math.PI, 2.8, COLOR.storage, 0.9, gVault)
  plate('wal-g backup-push · compressed objects and metadata · same S3 store', BV[0], 9.4, BV[2] - 14.4, Math.PI, 1.45, COLOR.inkDim, 0.68)
  plate('WAL alone restores nothing — it has to be replayed ONTO one of these', BV[0], 7.4, BV[2] - 14.4, Math.PI, 1.3, COLOR.inkDim, 0.62)
  plate('DAILY SCHEDULE · backup-push starts at standby_a', BV[0], 5.5, BV[2] - 14.4, Math.PI, 1.3, COLOR.storage, 0.78)
  plate('recovery window', BV[0], 1.6, BV[2] + 22, 0, 1.6, COLOR.storage, 0.7)

  /* ---------------------------------------------------------------------
   * 5. THE RECOVERY GROUND.
   * -------------------------------------------------------------------*/

  const gRecovery = new THREE.Group()
  gRecovery.name = 'recovery.ground'
  group.add(gRecovery)
  part(gRecovery)

  const RG = ANCHOR.recoveryGate
  const RP = ANCHOR.recoveryPad
  box([RG[0], 6, RG[2] - 9, 2.6, 12, 2.6], 'dim')
  box([RG[0], 6, RG[2] + 9, 2.6, 12, 2.6], 'dim')
  box([RG[0], 12.7, RG[2], 3, 1.8, 21], 'dim')
  box([RP[0], 0.3, RP[2], 40, 0.6, 32], 'none')
  box([RP[0] - 16, 3, RP[2] - 13, 0.8, 6, 0.8], 'none')

  plate('RECOVERY GROUND', RG[0] + 1.7, 16.2, RG[2], Math.PI / 2, 2.6, COLOR.bufClean, 0.9, gRecovery)
  plate('different site · different iron · a restore you have not rehearsed is a rumour', RG[0] + 1.7, 9.4, RG[2], Math.PI / 2, 1.35, COLOR.inkDim, 0.66)

  /** The restored data directory. Grows out of the pad as base.tar is unpacked. */
  const pgdata = new THREE.Mesh(unitBox, theme.mat('continuity.pgdata', {
    color: 0x16283a,
    roughness: 0.82,
    metalness: 0.18,
    emissive: 0x0a1a26,
  }))
  pgdata.scale.set(24, 0.2, 18)
  pgdata.position.set(RP[0], 0.7, RP[2])
  gRecovery.add(pgdata)

  lamp(COLOR.bufClean, 1.0, 40, 0.28, 0.4, RP[0], 0.72, RP[2] - 16, gRecovery)

  /** recovery.signal — a FILE, not a setting, so it gets a flagpole. */
  const signalFlag = lamp(COLOR.warn, 1.4, 0.4, 2.4, 5.5, RP[0] - 16, 5.4, RP[2] - 10.2, gRecovery)
  signalFlag.visible = false
  plate('recovery.signal', RP[0] - 16, 7.8, RP[2] - 10.2, 0, 1.5, COLOR.warn, 0.8)
  plate('restored data directory', RP[0], 1.8, RP[2] + 18, 0, 1.8, COLOR.bufClean, 0.75)

  /** PITR stopping does not itself promote; HA is operated separately. */
  const drillBoard = plate(
    'PITR STOP: CROSSING TRANSACTION RECORD · HA PROMOTION SEPARATE',
    RP[0], 12, RP[2] + 17, 0, 1.5, COLOR.warn, 0.85,
  )
  drillBoard.visible = true
  plate(
    'RESTORE DRILL · RUN IT TO MEASURE · PROVED ≠ NOT PROVED',
    RP[0], 9.2, RP[2] + 17, 0, 1.35, COLOR.bufClean, 0.82,
    gRecovery,
  )

  // One hook means ordered PostgreSQL consumption, not serial object GETs.
  const gWinch = new THREE.Group()
  gWinch.name = 'restore.winch'
  group.add(gWinch)
  part(gWinch)
  const RW = ANCHOR.restoreWinch
  box([RW[0], 1.6, RW[2], 9, 3.2, 9], 'dim')
  box([RW[0], 9.5, RW[2], 2.4, 13, 2.4], 'none')
  const jib = new THREE.Group()
  jib.position.set(RW[0], 15.2, RW[2])
  gWinch.add(jib)
  const jibArm = new THREE.Mesh(unitBox, theme.mat('continuity.jib', { color: 0x223049, roughness: 0.7, metalness: 0.4, surface: false }))
  jibArm.scale.set(1.1, 1.1, 18)
  jibArm.position.set(0, 0, 8)
  jib.add(jibArm)
  const hook = lamp(COLOR.wal, 1.5, 2.2, 2.2, 2.2, 0, -3.4, 16, jib)
  hook.visible = false
  plate('restore_command', RW[0], 20.2, RW[2], 0, 2.0, COLOR.wal, 0.9, gWinch)
  plate('ordered replay stream · WAL-G may prefetch later objects concurrently', RW[0], 17.4, RW[2] + 0.4, 0, 1.3, COLOR.inkDim, 0.66)

  // the dial: recovery_target_time
  const gClock = new THREE.Group()
  gClock.name = 'recovery.clock'
  group.add(gClock)
  part(gClock)
  const RC = ANCHOR.recoveryClock
  box([RC[0], 8, RC[2], 7, 16, 7], 'dim')
  const dialGeo = new THREE.CircleGeometry(7, 32)
  dialGeo.rotateX(-Math.PI / 2)
  geos.push(dialGeo)
  const dial = new THREE.Mesh(dialGeo, theme.mat('continuity.dial', {
    color: 0x101a2a,
    roughness: 0.9,
    metalness: 0.1,
    emissive: 0x0a1420,
    surface: false,
  }))
  dial.position.set(RC[0], 16.2, RC[2])
  gClock.add(dial)

  /** Red hand: the target. Amber hand: where replay has actually got to. */
  const targetHand = lamp(COLOR.crit, 1.5, 0.55, 0.35, 12, RC[0], 16.6, RC[2], gClock)
  targetHand.rotation.y = 2.1
  const replayHand = lamp(COLOR.wal, 1.4, 0.4, 0.3, 10, RC[0], 16.9, RC[2], gClock)
  plate('recovery_target_time', RC[0], 20.8, RC[2], 0, 2.0, COLOR.warn, 0.9, gClock)
  plate('recovery_target_action = pause · recovery_target_inclusive = on', RC[0], 18.4, RC[2] + 0.4, 0, 1.25, COLOR.inkDim, 0.7)

  // the replay belt, with the stop line painted across it
  const gReplay = new THREE.Group()
  gReplay.name = 'recovery.replay'
  group.add(gReplay)
  part(gReplay)
  const RR = ANCHOR.recoveryReplay
  box([RR[0] - 3, 1.2, RR[2], 34, 0.7, 9], 'none')
  box([RR[0] - 20, 3.6, RR[2], 6, 7.2, 7], 'dim')
  const beltFlow = lamp(COLOR.wal, 1.1, 4, 0.35, 7, RR[0] + 12, 1.75, RR[2], gReplay)
  const stopLine = lamp(COLOR.crit, 1.6, 0.7, 0.4, 9.4, RR[0] - 12, 1.8, RR[2], gReplay)
  stopLine.visible = false
  plate('startup process', RR[0] - 20, 8.6, RR[2] - 4, Math.PI, 1.7, COLOR.bufClean, 0.85)
  plate('stop line', RR[0] - 12, 3.6, RR[2] + 6, 0, 1.4, COLOR.crit, 0.75)

  /* ---------------------------------------------------------------------
   * 6. HIGH AVAILABILITY: service endpoint, Patroni lease, and rejoin.
   * -------------------------------------------------------------------*/

  const gEndpoint = new THREE.Group()
  gEndpoint.name = 'ha.endpoint'
  group.add(gEndpoint)
  part(gEndpoint)

  const EP = ANCHOR.endpoint
  box([EP[0] - 14, 6.5, EP[2], 2.2, 13, 2.2], 'dim')
  box([EP[0] + 14, 6.5, EP[2], 2.2, 13, 2.2], 'dim')
  box([EP[0], 13.8, EP[2], 30, 2.0, 3.0], 'dim')

  /** Swings to the bearing of whichever node owns the service address. */
  const epArrow = new THREE.Group()
  epArrow.position.set(EP[0], 11.2, EP[2])
  gEndpoint.add(epArrow)
  lamp(COLOR.client, 1.5, 0.7, 0.5, 7, 0, 0, 3, epArrow)
  const arrowHead = new THREE.Mesh(theme.cyl(0, 1.7, 3.2, 4), theme.neon(COLOR.client, 1.7))
  arrowHead.rotation.x = Math.PI / 2
  arrowHead.position.set(0, 0, 8)
  arrowHead.raycast = () => {}
  epArrow.add(arrowHead)

  plate('SERVICE ADDRESS', EP[0], 16.8, EP[2] - 1.7, Math.PI, 2.4, COLOR.client, 0.92, gEndpoint)
  plate('points to the Patroni leader · dark means no writable endpoint', EP[0], 13.8, EP[2] - 1.7, Math.PI, 1.3, COLOR.inkDim, 0.7)

  const gDcs = new THREE.Group()
  gDcs.name = 'ha.dcs'
  group.add(gDcs)
  part(gDcs)
  const DC = ANCHOR.consensus
  const SITE_AT = [ANCHOR.haPrimarySite, ANCHOR.haStandbyASite, ANCHOR.haStandbyBSite] as const
  const AGENT_AT = [ANCHOR.patroniNode1, ANCHOR.patroniNode2, ANCHOR.patroniNode3] as const
  const MEMBER_AT = [ANCHOR.leaseNode1, ANCHOR.leaseNode2, ANCHOR.leaseNode3] as const
  const SITE_TITLE = [
    'FAILURE DOMAIN 1 · PRIMARY NODE',
    'FAILURE DOMAIN 2 · STANDBY_A',
    'FAILURE DOMAIN 3 · STANDBY_B',
  ]
  const MEMBER_TITLE = ['etcd-1', 'etcd-2', 'etcd-3']
  const PLATFORM_W = [124, 116, 116] as const
  const PLATFORM_D = [78, 142, 142] as const

  const sitePlatformMat = theme.mat('continuity.ha-site', {
    color: 0x0b1525,
    roughness: 0.96,
    metalness: 0.08,
    emissive: 0x071424,
    emissiveIntensity: 0.82,
  })
  const sitePlatform = new THREE.InstancedMesh(unitBox, sitePlatformMat, N_LEASE)
  sitePlatform.name = 'ha.failure-domain-platforms'
  sitePlatform.frustumCulled = false
  sitePlatform.raycast = () => {}
  gDcs.add(sitePlatform)
  instanced.push(sitePlatform)

  for (let i = 0; i < N_LEASE; i++) {
    const site = SITE_AT[i]
    const platformW = PLATFORM_W[i]
    const platformD = PLATFORM_D[i]
    /* Thin enough to stay out of collision, dark enough to split the shared ground. */
    const platformBox: Box = [site[0], 0.74, site[2], platformW, 0.18, platformD]
    pushEdges(goldEdges, platformBox)
    _p.set(platformBox[0], platformBox[1], platformBox[2])
    _sc.set(platformBox[3], platformBox[4], platformBox[5])
    _m.compose(_p, _qi, _sc)
    sitePlatform.setMatrixAt(i, _m)
    const titleX = i === 0 ? site[0] - 36 : site[0]
    const titleY = i === 0 ? 21 : 2.4
    plate(SITE_TITLE[i], titleX, titleY, site[2] - platformD / 2 + 3, Math.PI, 1.55, 0xffffff, 0.92, gDcs)
    plate('PostgreSQL · Patroni agent · one etcd member', site[0], 2.2, site[2] + platformD / 2 - 3, 0, 1.05, 0xffffff, 0.78, gDcs)

    const agent = AGENT_AT[i]
    box([agent[0], 7.2, agent[2], 14, 14.4, 14], 'dim')
    plate('PATRONI', agent[0], 16.2, agent[2] + 7.2, 0, 1.8, COLOR.replication, 0.94, gDcs)

    const member = MEMBER_AT[i]
    box([member[0], 8.2, member[2], 16, 16.4, 16], 'dim')
    box([member[0], 17, member[2], 19, 1.1, 19], 'gold')
    plate(MEMBER_TITLE[i], member[0], 21, member[2] + 9.7, 0, 1.9, COLOR.ok, 0.94, gDcs)
  }
  sitePlatform.instanceMatrix.needsUpdate = true

  plate('RAFT CONSENSUS', DC[0], 42, DC[2], 0, 2.8, COLOR.ok, 0.96, gDcs)
  plate('one linearizable leader key · compare-and-swap + lease TTL', DC[0], 37.5, DC[2], 0, 1.5, 0xffffff, 0.82, gDcs)
  plate('majority is the commit mechanism · a minority cannot commit', DC[0], 33.5, DC[2], 0, 1.35, 0xffffff, 0.86, gDcs)

  const agentMesh = neonBank('ha.patroni-agents', unitBox, N_LEASE, gDcs)
  const memberMesh = neonBank('ha.etcd-members', unitBox, N_LEASE, gDcs)
  const leaseMesh = neonBank('ha.agent-leases', unitBox, N_LEASE, gDcs)
  const keyMesh = neonBank('ha.committed-key', unitBox, N_LEASE, gDcs)
  for (let i = 0; i < N_LEASE; i++) {
    const agent = AGENT_AT[i]
    _p.set(agent[0], 9, agent[2])
    _sc.set(7, 2.2, 7)
    _m.compose(_p, _qi, _sc)
    agentMesh.setMatrixAt(i, _m)
    agentMesh.setColorAt(i, _c.setHex(OFF))

    const member = MEMBER_AT[i]
    _p.set(member[0], 11, member[2])
    _sc.set(8, 2.2, 8)
    _m.compose(_p, _qi, _sc)
    memberMesh.setMatrixAt(i, _m)
    memberMesh.setColorAt(i, _c.setHex(OFF))
    _p.set(member[0], 16.4, member[2])
    _sc.set(11, 0.8, 11)
    _m.compose(_p, _qi, _sc)
    keyMesh.setMatrixAt(i, _m)
    keyMesh.setColorAt(i, _c.setHex(OFF))

    _p.set(agent[0] + 9, 5.2, agent[2])
    _sc.set(1.1, 9.2, 2.5)
    _m.compose(_p, _qi, _sc)
    leaseMesh.setMatrixAt(i, _m)
    leaseMesh.setColorAt(i, _c.setHex(OFF))
  }
  agentMesh.instanceMatrix.needsUpdate = true
  memberMesh.instanceMatrix.needsUpdate = true
  keyMesh.instanceMatrix.needsUpdate = true
  leaseMesh.instanceMatrix.needsUpdate = true

  const raftLinks = neonBank('ha.raft-links', unitBox, N_LEASE, gDcs)
  const LINK_FROM = [0, 1, 2] as const
  const LINK_TO = [1, 2, 0] as const
  const linkRotation = new THREE.Quaternion()
  for (let i = 0; i < N_LEASE; i++) {
    const from = MEMBER_AT[LINK_FROM[i]]
    const to = MEMBER_AT[LINK_TO[i]]
    const dx = to[0] - from[0]
    const dz = to[2] - from[2]
    _p.set((from[0] + to[0]) / 2, 8, (from[2] + to[2]) / 2)
    _sc.set(Math.hypot(dx, dz), 0.8, 0.8)
    linkRotation.setFromAxisAngle(_axisY, -Math.atan2(dz, dx))
    _m.compose(_p, linkRotation, _sc)
    raftLinks.setMatrixAt(i, _m)
    raftLinks.setColorAt(i, _c.setHex(COLOR.inkDim))
  }
  raftLinks.instanceMatrix.needsUpdate = true

  /* the rejoin bay — pg_rewind or a rebuild, and there is no third option */
  const gRejoin = new THREE.Group()
  gRejoin.name = 'ha.rejoin'
  group.add(gRejoin)
  part(gRejoin)
  const RJ = ANCHOR.rejoinBay
  box([RJ[0], 0.3, RJ[2], 32, 0.6, 18], 'none')
  for (const gx of [RJ[0] - 11, RJ[0] + 11]) {
    box([gx, 4, RJ[2] - 7, 1.2, 8, 1.2], 'none')
    box([gx, 4, RJ[2] + 7, 1.2, 8, 1.2], 'none')
    box([gx, 8.3, RJ[2], 1.4, 0.8, 15], 'dim')
  }
  box([RJ[0], 5, RJ[2] - 10, 30, 9, 0.7], 'dim')
  plate('pg_rewind', RJ[0] - 11, 10.6, RJ[2], 0, 1.8, COLOR.warn, 0.9, gRejoin)
  plate('pg_basebackup -R', RJ[0] + 11, 10.6, RJ[2], 0, 1.8, COLOR.storage, 0.9, gRejoin)
  plate('REJOIN BAY', RJ[0], 8.0, RJ[2] - 10.5, 0, 2.0, COLOR.ink, 0.9, gRejoin)
  plate(
    'find the fork · discard the old tail · follow the new timeline',
    RJ[0], 5.6, RJ[2] - 10.5, 0, 1.2, COLOR.inkDim, 0.72,
  )
  plate(
    'needs the old data directory + checksums or wal_log_hints + retained WAL',
    RJ[0], 3.6, RJ[2] - 10.5, 0, 1.2, COLOR.inkDim, 0.72,
  )
  const rewindBar = lamp(COLOR.warn, 1.6, 1, 0.65, 4, RJ[0] - 11, 7.4, RJ[2], gRejoin)
  const rewindFailure = lamp(COLOR.crit, 1.8, 2.2, 2.2, 2.2, RJ[0] - 11, 4.6, RJ[2], gRejoin)
  rewindBar.visible = false
  rewindFailure.visible = false

  /* node 3: a complete independent physical standby */
  const gStandbyB = new THREE.Group()
  gStandbyB.name = 'standby.b'
  group.add(gStandbyB)
  const SB = ANCHOR.standbyB
  const SBR = ANCHOR.standbyBRecv
  const SBW = ANCHOR.standbyBWal
  const SBD = ANCHOR.standbyBDeck
  const SBS = ANCHOR.standbyBStorage

  const gBReceiver = new THREE.Group()
  gBReceiver.name = 'standby.b.receiver'
  gStandbyB.add(gBReceiver)
  part(gBReceiver)
  box([SBR[0], 4, SBR[2], 12, 8, 9], 'dim')
  box([SBR[0], 8.5, SBR[2], 14, 1, 11], 'none')

  const gBWal = new THREE.Group()
  gBWal.name = 'standby.b.wal'
  gStandbyB.add(gBWal)
  part(gBWal)
  box([SBW[0], 1.1, SBW[2], 24, 2.2, 8], 'dim')
  const walB = neonBank('standby.b.wal.segments', unitBox, N_WAL_B, gBWal)
  for (let i = 0; i < N_WAL_B; i++) {
    _p.set(SBW[0] - 9.8 + i * 2.8, 2.6, SBW[2])
    _sc.set(2.1, 2.3, 5.4)
    _m.compose(_p, _qi, _sc)
    walB.setMatrixAt(i, _m)
    walB.setColorAt(i, _c.setHex(OFF))
  }
  walB.instanceMatrix.needsUpdate = true

  const gBStartup = new THREE.Group()
  gBStartup.name = 'standby.b.startup'
  gStandbyB.add(gBStartup)
  part(gBStartup)
  box([SB[0], 4, SB[2], 10, 8, 8], 'dim')
  box([SB[0], 8.5, SB[2], 12, 1, 10], 'none')

  const gBBuffers = new THREE.Group()
  gBBuffers.name = 'standby.b.buffers'
  gStandbyB.add(gBBuffers)
  part(gBBuffers)
  box([SBD[0], SBD[1] - 0.5, SBD[2], 32, 1.0, 24], 'dim')
  box([SBD[0], 6, SBD[2] - 15, 30, 8, 0.7], 'dim')

  const tileB = neonBank('standby.b.buffers.tiles', unitBox, N_TILE_B, gBBuffers)
  for (let i = 0; i < N_TILE_B; i++) {
    const col = i % BUF_B
    const row = Math.floor(i / BUF_B)
    _p.set(
      SBD[0] + (col - (BUF_B - 1) / 2) * 0.72,
      SBD[1] + 0.35,
      SBD[2] + (row - (BUF_B - 1) / 2) * 0.67,
    )
    _sc.set(0.54, 0.35, 0.5)
    _m.compose(_p, _qi, _sc)
    tileB.setMatrixAt(i, _m)
    tileB.setColorAt(i, _c.setHex(OFF))
  }
  tileB.instanceMatrix.needsUpdate = true

  const gBStorage = new THREE.Group()
  gBStorage.name = 'standby.b.storage'
  gStandbyB.add(gBStorage)
  part(gBStorage)
  box([SBS[0], SBS[1], SBS[2], 34, 1, 26], 'dim')
  box([SBS[0] - 16.5, SBS[1] + 5, SBS[2], 1, 10, 26], 'dim')
  box([SBS[0] + 16.5, SBS[1] + 5, SBS[2], 1, 10, 26], 'dim')
  box([SBS[0], SBS[1] + 5, SBS[2] + 12.5, 34, 10, 1], 'dim')

  plate('standby_b', SB[0], 10.8, SB[2] - 4.4, Math.PI, 2.2, COLOR.replication, 0.92, gStandbyB)
  plate('walreceiver', SBR[0], 10.6, SBR[2] - 5, Math.PI, 1.6, COLOR.replication, 0.8, gBReceiver)
  plate('own pg_wal', SBW[0], 6.4, SBW[2] - 4.5, Math.PI, 1.45, COLOR.wal, 0.82, gBWal)
  plate('startup process', SB[0], 8.6, SB[2] + 4.5, 0, 1.45, COLOR.replication, 0.82, gBStartup)
  plate('standby_b buffer pool', SBD[0], 8.8, SBD[2] - 15.5, Math.PI, 2.0, COLOR.replication, 0.9, gBBuffers)
  plate(
    'received · flushed · applied independently',
    SBD[0], 6.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72,
    gBBuffers,
  )
  const syncStandbyAPlate = plate("synchronous_standby_names = 'standby_a'", SBD[0], 4.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72, gBBuffers)
  syncStandbyAPlate.name = 'sync-standby-name.a'
  const syncStandbyBPlate = plate("synchronous_standby_names = 'standby_b'", SBD[0], 4.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72, gBBuffers)
  syncStandbyBPlate.name = 'sync-standby-name.b'
  syncStandbyBPlate.visible = false
  const syncStandbyNonePlate = plate("synchronous_standby_names = ''", SBD[0], 4.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72, gBBuffers)
  syncStandbyNonePlate.name = 'sync-standby-name.none'
  syncStandbyNonePlate.visible = false
  plate('standby_b data directory', SBS[0], SBS[1] + 11.5, SBS[2] + 13, 0, 1.6, COLOR.storage, 0.9, gBStorage)

  /* ---------------------------------------------------------------------
   * 7. Bake the structure and the outlines.
   * -------------------------------------------------------------------*/

  const structMat = theme.mat('continuity.struct', {
    color: 0x141c2c,
    roughness: 0.88,
    metalness: 0.22,
    emissive: 0x070c16,
    emissiveIntensity: 0.9,
  })
  _sc.set(1, 1, 1)
  for (const pt of parts) {
    if (pt.boxes.length === 0) continue
    const im = new THREE.InstancedMesh(unitBox, structMat, pt.boxes.length)
    im.name = `${pt.host.name || 'continuity'}.struct`
    im.frustumCulled = false
    for (let i = 0; i < pt.boxes.length; i++) {
      const b = pt.boxes[i]
      _p.set(b[0], b[1], b[2])
      _sc.set(b[3], b[4], b[5])
      _m.compose(_p, _qi, _sc)
      im.setMatrixAt(i, _m)
    }
    im.instanceMatrix.needsUpdate = true
    pt.host.add(im)
    instanced.push(im)
  }

  for (const [buf, col, op] of [
    [dimEdges, COLOR.inkDim, 0.2],
    [goldEdges, COLOR.archive, 0.4],
  ] as const) {
    if (buf.length === 0) continue
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf), 3))
    geos.push(g)
    const ls = new THREE.LineSegments(g, theme.line(col, op))
    ls.renderOrder = 2
    ls.raycast = () => {}
    group.add(ls)
  }

  /* ---------------------------------------------------------------------
   * 8. Live state.
   * -------------------------------------------------------------------*/

  let clock = 0
  let queueEma = 0
  let prevArchived = -1

  epArrow.visible = true

  /* ---------------------------------------------------------------------
   * 9. Registration.
   * -------------------------------------------------------------------*/

  ctx.register({
    id: 'archive.gate',
    name: 'archive ownership boundary',
    role: 'the point beyond which archive retention belongs to remote storage',
    kind: 'storage',
    district: 'wal',
    object: gGate,
    tier: 1,
    focus: { target: [AG[0], 8, AG[2]], distance: 76, dir: [-0.62, 0.44, 0.65] },
    labelAt: [AG[0], 22, AG[2]],
    color: COLOR.archive,
    readout: (s: SimState) => {
      const a = s.disasterRecovery.archive
      const q = a.queueSegments
      let bytes = 0
      let fill = 0
      for (let i = 0; i < s.wal.segments.length; i++) {
        const segment = s.wal.segments[i]
        if (segment.state !== 'current') continue
        bytes = segment.bytes
        fill = segment.fill
        break
      }
      const approach = `primary current ${fmtBytes(bytes)} / ${fmtBytes(s.wal.segmentSize)} · ${(fill * 100).toFixed(1)}% · then wal-push`
      if (a.writesBlocked) return `${approach} · ${q} queued · scaled pg_wal safety limit reached · writes rejected`
      if (!s.knobs.walGArchiveCredentialsValid) return `${approach} · ${q} queued · credentials expired · retrying oldest .ready file`
      if (q > 0) return `${approach} · wal-push active · ${q} .ready`
      return `${approach} · ${s.wal.archived} stored`
    },
  })

  ctx.register({
    id: 'timeline.yard',
    name: 'the timeline switchyard',
    role: 'one deck per timeline; a turnout is a fork',
    kind: 'concept',
    district: 'wal',
    object: gYard,
    tier: 0,
    focus: { target: [yardMidX, 10, Y.z - 4], distance: 152, dir: [-0.34, 0.56, 0.76] },
    labelAt: [yardMidX, 26, Y.z],
    color: COLOR.archive,
    readout: (s: SimState) => {
      const timeline = s.highAvailability.timeline
      if (timeline.forkLsn <= 0) return 'timeline 1 live · no promotion yet'
      return `timeline ${timeline.current} live · fork ${fmtLsn(timeline.forkLsn)} · old history ends ${fmtLsn(timeline.oldHistoryEndLsn)}`
    },
  })

  ctx.register({
    id: 'object.store',
    name: 'object storage',
    role: 'modeled backup/WAL objects and byte counts · no S3 API or files',
    kind: 'storage',
    district: 'wal',
    object: gStore,
    tier: 1,
    focus: { target: [OS[0], 6, OS[2]], distance: 98, dir: [0.3, 0.6, 0.74] },
    labelAt: [OS[0], 18, OS[2]],
    color: COLOR.archive,
    readout: (s: SimState) =>
      `${s.wal.archived} WAL objects · ${s.disasterRecovery.backups.length} full backup${s.disasterRecovery.backups.length === 1 ? '' : 's'} · ${s.knobs.walGArchiveCredentialsValid ? 'wal-push authenticated' : 'wal-push credentials expired'}`,
  })

  ctx.register({
    id: 'backup.vault',
    name: 'WAL-G base-backup objects',
    role: 'modeled backup metadata and bytes · no copied relation files',
    kind: 'storage',
    district: 'wal',
    object: gVault,
    tier: 0,
    focus: { target: [BV[0], 6, BV[2]], distance: 112, dir: [0.34, 0.5, 0.8] },
    labelAt: [BV[0], 20, BV[2]],
    color: COLOR.storage,
    readout: (s: SimState) => {
      const backups = s.disasterRecovery.backups
      const op = s.disasterRecovery.backup
      const next = fmtDuration(Math.max(0, s.disasterRecovery.backupSchedule.nextStartAt - s.t))
      if (op.status === 'copying') {
        return `${op.trigger === 'schedule' ? 'daily scheduled' : 'manual'} backup-push from standby_a · ${(op.progress * 100).toFixed(0)}%`
      }
      if (op.status === 'waiting_wal') return `${op.trigger === 'schedule' ? 'daily scheduled' : 'manual'} backup from standby_a · copied · waiting for stop WAL`
      if (backups.length === 0) return `daily backup-push from standby_a in ${next} · empty until then`
      const newest = backups[backups.length - 1]
      return `${backups.length} full backup${backups.length === 1 ? '' : 's'} held · newest ${fmtDuration(s.t - newest.completedAt)} old · next daily from standby_a in ${next}`
    },
  })

  ctx.register({
    id: 'recovery.ground',
    name: 'the recovery ground',
    role: 'aggregate restore and promotion state · no restored rows or pages',
    kind: 'storage',
    district: 'world',
    object: gRecovery,
    tier: 0,
    focus: { target: [-312, 6, 258], distance: 172, dir: [-0.24, 0.5, 0.83] },
    labelAt: [RP[0], 22, RP[2]],
    color: COLOR.bufClean,
    readout: (s: SimState) => {
      const drill = s.disasterRecovery.drill
      const r = s.disasterRecovery.restore
      if (
        drill.status === 'restoring'
        || drill.status === 'verifying'
        || drill.status === 'querying'
      ) {
        return `drill ${drill.status} · restore-to-target time ${fmtDuration(drill.estimatedRestoreToTargetSec)} estimate · ${(drill.progress * 100).toFixed(0)}%`
      }
      if (r.status === 'fetching') return `fetching full backup · ${(r.progress * 100).toFixed(0)}% of estimated recovery time`
      if (r.status === 'replaying') return `replaying ${fmtBytes(r.walBytesRequired)} of archived WAL`
      if (r.status === 'failed') return r.failureReason
      if (r.status === 'complete') return 'target reached · replay stopped · not promoted'
      if (drill.status === 'failed') return `drill FAIL · ${drill.failureReason}`
      if (drill.status === 'passed') {
        const timelinePath = s.disasterRecovery.restore.crossesTimelineFork
          ? ` · timeline ${s.disasterRecovery.restore.backupTimeline}→${s.disasterRecovery.restore.targetTimeline} via ${s.disasterRecovery.restore.historyFileName}`
          : ''
        return `drill PASS · restore-to-target time ${fmtDuration(drill.measuredRestoreToTargetSec)} · ${fmtBytes(drill.objectStoreBytesRead)} read${timelinePath}`
      }
      return 'restore drill not run · empty recovery host · choose a target'
    },
  })

  ctx.register({
    id: 'recovery.clock',
    name: 'recovery_target_time',
    role: 'the dial the whole of PITR turns on',
    kind: 'concept',
    district: 'world',
    object: gClock,
    tier: 1,
    focus: { target: [RC[0], 14, RC[2]], distance: 62, dir: [0.3, 0.55, 0.78] },
    labelAt: [RC[0], 28, RC[2]],
    color: COLOR.warn,
    readout: (s: SimState) => {
      const r = s.disasterRecovery.restore
      if (r.status === 'complete') return 'recovery_target_time reached · replay stopped'
      if (r.status === 'failed') return r.failureReason
      return `${s.knobs.recoveryTargetAge}s before now · ${(r.progress * 100).toFixed(0)}% restored`
    },
  })

  ctx.register({
    id: 'restore.winch',
    name: 'restore_command',
    role: 'ordered byte-progress model at a fixed teaching rate',
    kind: 'process',
    district: 'world',
    object: gWinch,
    tier: 2,
    focus: { target: [RW[0], 12, RW[2]], distance: 56, dir: [0.44, 0.42, 0.79] },
    labelAt: [RW[0], 26, RW[2]],
    color: COLOR.wal,
    readout: (s: SimState) =>
      s.disasterRecovery.restore.status === 'replaying'
        ? `wal-g wal-fetch / wal-prefetch · ${fmtBytes(s.disasterRecovery.restore.walBytesReplayed)} replayed in order`
        : 'idle',
  })

  ctx.register({
    id: 'recovery.replay',
    name: 'the replay belt',
    role: 'replay-progress illustration · no WAL-record or page application',
    kind: 'process',
    district: 'world',
    object: gReplay,
    tier: 2,
    focus: { target: [RR[0] - 4, 6, RR[2]], distance: 60, dir: [-0.2, 0.45, 0.87] },
    labelAt: [RR[0] - 4, 14, RR[2]],
    color: COLOR.bufClean,
    readout: (s: SimState) =>
      s.disasterRecovery.restore.status === 'complete'
        ? 'stopped on the selected recovery_target_time'
        : s.disasterRecovery.restore.status === 'replaying'
          ? 'startup process replaying archived WAL'
          : 'stopped',
  })

  ctx.register({
    id: 'ha.endpoint',
    name: 'service address',
    role: 'the client endpoint pointing to the current Patroni leader',
    kind: 'network',
    district: 'clients',
    object: gEndpoint,
    tier: 0,
    focus: { target: [EP[0], 8, EP[2]], distance: 80, dir: [0.16, 0.42, -0.89] },
    labelAt: [EP[0], 22, EP[2]],
    color: COLOR.client,
    readout: (s: SimState) =>
      s.highAvailability.currentLeader
        ? `routes writes to ${s.highAvailability.currentLeader} · timeline ${s.highAvailability.timeline.current}`
        : 'dark · no node holds a valid leader-key lease',
  })

  ctx.register({
    id: 'ha.dcs',
    name: 'Patroni agents and etcd consensus',
    role: 'Raft commits one linearizable leader key through a majority',
    kind: 'network',
    district: 'replication',
    object: gDcs,
    tier: 0,
    focus: { target: [DC[0], 8, DC[2]], distance: 480, dir: [0, 0.6, 0.8] },
    labelAt: [DC[0], 24, DC[2]],
    color: COLOR.ok,
    readout: (s: SimState) => {
      const dcs = s.highAvailability.patroni.dcs
      const key = dcs.leaderKey
      const grant = key.leaseValid && key.value ? key.value : 'none'
      return `Raft term ${dcs.term} · commit ${dcs.commitIndex} · leader key ${grant} · ${dcs.canCommit ? 'majority can commit' : 'no majority'}`
    },
  })

  ctx.register({
    id: 'ha.rejoin',
    name: 'rewind or reinitialise bay',
    role: 'modeled prerequisite checks and byte-copy progress · no block repair',
    kind: 'concept',
    district: 'replication',
    object: gRejoin,
    tier: 2,
    focus: { target: [RJ[0], 6, RJ[2]], distance: 64, dir: [-0.3, 0.5, -0.81] },
    labelAt: [RJ[0], 16, RJ[2]],
    color: COLOR.warn,
    readout: (s: SimState) => {
      const rewind = s.highAvailability.rejoin
      if (rewind.status === 'failed') return rewind.failureReason
      if (rewind.reinitializeRequired && rewind.status === 'complete') {
        return `former primary repaired · rebuilding ${rewind.reinitializeNode} ${fmtBytes(rewind.reinitializeCopiedBytes)} / ${fmtBytes(rewind.reinitializeBytes)}`
      }
      if (rewind.status === 'checking') return `checking prerequisites · ${rewind.elapsedSec.toFixed(1)} s elapsed`
      if (rewind.status === 'rewinding') return `rewinding ${fmtBytes(rewind.bytesCopied)} / ${fmtBytes(rewind.bytesRewound)}`
      if (rewind.status === 'complete') return `complete in ${rewind.elapsedSec.toFixed(1)} s · following timeline ${s.highAvailability.timeline.current}`
      return rewind.required
        ? rewind.reinitializeRequired
          ? `two nodes need repair · follower rebuild ${fmtBytes(rewind.reinitializeBytes)}`
          : `former primary diverged by ${fmtBytes(rewind.bytesRewound)} · cannot rejoin directly`
        : 'no divergent node waiting'
    },
  })

  ctx.register({
    id: 'standby.b',
    name: 'standby_b',
    role: 'independent LSN and HA state · no replica rows or pages',
    kind: 'storage',
    district: 'replication',
    object: gStandbyB,
    tier: 0,
    focus: { target: [SB[0], 6, SB[2] + 20], distance: 132, dir: [-0.5, 0.46, 0.73] },
    labelAt: [SB[0], 20, SB[2]],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const standby = s.replication.standbys[1]
      const slot = s.replication.physicalSlots[1]
      const opinion = s.cluster.nodes[2].leaderOpinion ?? 'unknown'
      if (!standby.connected) {
        return slot.exists
          ? `disconnected · sees ${opinion} as leader · slot holds ${fmtBytes(slot.retainedBytes)}`
          : `disconnected · sees ${opinion} as leader · slot dropped; no retention guarantee`
      }
      return `applied ${fmtLsn(standby.appliedLsn)} · ${standby.lagSec.toFixed(1)} s behind · sees ${opinion} as leader`
    },
  })

  ctx.register({
    id: 'standby.b.receiver',
    name: 'standby_b walreceiver',
    role: 'advances standby_b receive and write LSNs · no files',
    kind: 'process',
    district: 'replication',
    object: gBReceiver,
    tier: 1,
    focus: { target: [SBR[0], 6, SBR[2]], distance: 54, dir: [-0.45, 0.46, -0.77] },
    labelAt: [SBR[0], 15, SBR[2]],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const standby = s.replication.standbys[1]
      return standby.connected
        ? `received ${fmtLsn(standby.receivedLsn)} · written ${fmtLsn(standby.writtenLsn)}`
        : 'stopped · physical slot remains on the primary'
    },
  })

  ctx.register({
    id: 'standby.b.wal',
    name: 'standby_b write-ahead log',
    role: 'aggregate WAL positions and bytes · no segment files',
    kind: 'storage',
    district: 'replication',
    object: gBWal,
    tier: 1,
    focus: { target: [SBW[0], 4, SBW[2]], distance: 60, dir: [-0.48, 0.5, -0.72] },
    labelAt: [SBW[0], 12, SBW[2]],
    color: COLOR.wal,
    readout: (s: SimState) => {
      const standby = s.replication.standbys[1]
      return `flushed ${fmtLsn(standby.flushedLsn)} · ${fmtBytes(s.cluster.nodes[2].wal.diskBytes)} in pg_wal`
    },
  })

  ctx.register({
    id: 'standby.b.startup',
    name: 'standby_b startup process',
    role: 'advances one ordered applied-LSN frontier',
    kind: 'process',
    district: 'replication',
    object: gBStartup,
    tier: 1,
    focus: { target: [SB[0], 6, SB[2]], distance: 54, dir: [-0.46, 0.48, -0.75] },
    labelAt: [SB[0], 15, SB[2]],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const standby = s.replication.standbys[1]
      return `applied ${fmtLsn(standby.appliedLsn)} · waiting ${fmtBytes(Math.max(0, standby.flushedLsn - standby.appliedLsn))}`
    },
  })

  ctx.register({
    id: 'standby.b.buffers',
    name: 'standby_b buffer pool (shared_buffers)',
    role: 'standby_b’s independent representative buffer-frame sample',
    kind: 'memory',
    district: 'replication',
    object: gBBuffers,
    tier: 1,
    focus: { target: [SBD[0], 5, SBD[2]], distance: 74, dir: [-0.4, 0.58, 0.72] },
    labelAt: [SBD[0], 16, SBD[2]],
    color: COLOR.replication,
    readout: (s: SimState) => {
      const pool = s.cluster.nodes[2].buffers
      return `${pool.usedCount} / ${pool.sampleFrames} sampled frames used · replay activity ${(s.replication.standbys[1].applyActivity * 100).toFixed(0)}%`
    },
  })

  ctx.register({
    id: 'standby.b.storage',
    name: 'standby_b data directory',
    role: 'aggregate size and applied LSN · no copied files or pages',
    kind: 'storage',
    district: 'replication',
    object: gBStorage,
    tier: 1,
    focus: { target: [SBS[0], SBS[1] + 5, SBS[2]], distance: 72, dir: [-0.42, 0.54, 0.73] },
    labelAt: [SBS[0], SBS[1] + 17, SBS[2]],
    color: COLOR.storage,
    readout: (s: SimState) =>
      `${fmtBytes(s.cluster.nodes[2].dataDirectory.bytes)} · applied through ${fmtLsn(s.cluster.nodes[2].dataDirectory.appliedLsn)}`,
  })

  /* ---------------------------------------------------------------------
   * 10. Per-frame.
   * -------------------------------------------------------------------*/

  /** Emission accumulators, one per route. Never reallocated. */
  const emit = {
    backupPush: 0, haul: 0, unpack: 0, replay: 0, apply: 0,
    bStream: 0, bAck: 0, bApply: 0, bBuffer: 0, bIo: 0,
  }

  function pump(acc: number, perSec: number, dt: number, route: string): number {
    let a = acc + perSec * dt
    while (a >= 1) {
      a -= 1
      ctx.flow({ route, count: 1 })
    }
    return a
  }

  function update(dt: number, sim: SimState): void {
    clock += dt

    /* --- 1. continuous archiving, read off the live WAL --------------------*/
    const archive = sim.disasterRecovery.archive
    queueEma = damp(queueEma, archive.queueSegments, 2.5, dt)
    const failing = !sim.knobs.walGArchiveCredentialsValid || archive.writesBlocked
    const busy = queueEma > 0.6
    gateLamp[0].visible = !busy
    gateLamp[1].visible = busy && !failing
    gateLamp[2].visible = failing
    retryCrate.visible = failing

    let currentSegmentFill = 0
    for (let i = 0; i < sim.wal.segments.length; i++) {
      const segment = sim.wal.segments[i]
      if (segment.state !== 'current') continue
      currentSegmentFill = segment.fill
      break
    }
    const filledCells = currentSegmentFill * N_GATE_SEGMENT_CELLS
    for (let i = 0; i < N_GATE_SEGMENT_CELLS; i++) {
      const amount = clamp01(filledCells - i)
      _c.setHex(COLOR.wal).multiplyScalar(0.035 + amount * 1.75)
      gateSegmentCells.setColorAt(i, _c)
    }
    if (gateSegmentCells.instanceColor) gateSegmentCells.instanceColor.needsUpdate = true
    gateSegmentClosed.visible = archive.queueSegments > 0

    if (prevArchived < 0) prevArchived = sim.wal.archived
    let shipped = Math.max(0, sim.wal.archived - prevArchived)
    prevArchived = sim.wal.archived
    while (shipped-- > 0) ctx.flow({ route: 'archive.ship', count: 1, kind: 'archive', color: COLOR.archive, size: 1.3 })

    const timeline = sim.highAvailability.timeline
    const activeRow = Math.min(S.rows - 1, Math.max(0, timeline.current - 1))
    const forked = timeline.forkLsn > 0
    const forkSegmentStart = Math.floor(timeline.forkLsn / sim.wal.segmentSize)
      * sim.wal.segmentSize
    const forkCopyArchived = forked
      && archive.timeline === timeline.current
      && archive.archivedThroughLsn >= forkSegmentStart + sim.wal.segmentSize
    const parentGapSegments = Math.min(
      S.cols,
      Math.ceil(
        Math.max(
          0,
          (forkCopyArchived ? forkSegmentStart : timeline.forkLsn)
            - archive.parentArchivedThroughLsn,
        )
          / sim.wal.segmentSize,
      ),
    )
    const parentFill = S.cols - parentGapSegments
    const liveFill = Math.min(
      S.cols,
      forked
        ? Math.ceil(
          Math.max(0, archive.archivedThroughLsn - timeline.forkLsn)
            / sim.wal.segmentSize,
        )
        : sim.wal.archived,
    )
    for (let r = 0; r < S.rows; r++) {
      const exists = r === 0 || (forked && r === activeRow)
      const fill = r === 0 && forked ? parentFill : r === activeRow ? liveFill : 0
      for (let c = 0; c < S.cols; c++) {
        const lit = exists && c < fill
        const newest = r === activeRow && liveFill > 0 && c === liveFill - 1
        _c.setHex(
          !lit
            ? OFF
            : newest
              ? mixHex(COLOR.wal, 0xffffff, 0.45)
              : r === activeRow
                ? COLOR.wal
                : COLOR.archive,
        )
        if (lit) _c.multiplyScalar(1.25)
        siloCap.setColorAt(r * S.cols + c, _c)
      }
    }
    if (siloCap.instanceColor) siloCap.instanceColor.needsUpdate = true

    for (let k = 0; k < N_HISTORY; k++) {
      const exists = forked && k < timeline.current - 1
      const historyArchived = exists && archive.historyFileArchived
      historyTablet.setColorAt(k, _c.setHex(historyArchived ? COLOR.archive : OFF))
      branchGroup[k].visible = exists
      branchLive[k].visible = exists && k === activeRow - 1
    }
    if (historyTablet.instanceColor) historyTablet.instanceColor.needsUpdate = true
    oldTail.visible = forked
    forkBeacon.visible = forked && Math.sin(clock * 4) > -0.4

    /* --- 2. the vault and the recovery window -----------------------------*/
    const backupsHeld = sim.disasterRecovery.backups.length
    for (let i = 0; i < N_VAULT; i++) {
      const held = i >= N_VAULT - backupsHeld
      const newest = i === N_VAULT - 1
      _c.setHex(!held ? OFF : newest ? COLOR.storage : mixHex(COLOR.storage, OFF, 0.55))
      if (held) _c.multiplyScalar(newest ? 1.6 : 1.1)
      vaultSeam.setColorAt(i, _c)
    }
    if (vaultSeam.instanceColor) vaultSeam.instanceColor.needsUpdate = true
    const want = Math.max(2, vaultSpan * (backupsHeld / N_VAULT))
    windowBar.scale.x = damp(windowBar.scale.x, want, 3, dt)
    windowBar.position.x = BV[0] + vaultSpan / 2 - windowBar.scale.x / 2

    /* --- 3. explicit backup and restore operations -------------------------*/
    const backup = sim.disasterRecovery.backup
    if (backup.status === 'copying') {
      emit.backupPush = pump(emit.backupPush, 6, dt, 'backup.push')
    }
    const restore = sim.disasterRecovery.restore
    const fetching = restore.status === 'fetching'
    const replaying = restore.status === 'replaying'
    const complete = restore.status === 'complete'
    if (fetching) {
      emit.haul = pump(emit.haul, 3.5, dt, 'restore.haul')
      emit.unpack = pump(emit.unpack, 5, dt, 'restore.unpack')
    }
    const unpacked = fetching
      ? restore.backupBytesRequired > 0
        ? clamp01(restore.backupBytesFetched / restore.backupBytesRequired)
        : 0
      : replaying || complete
        ? 1
        : 0
    pgdata.scale.y = damp(pgdata.scale.y, 0.2 + unpacked * 6.8, 3, dt)
    pgdata.position.y = pgdata.scale.y / 2 + 0.6
    signalFlag.visible = fetching || replaying || complete

    if (replaying) {
      emit.haul = pump(emit.haul, 3.5, dt, 'restore.haul')
      emit.replay = pump(emit.replay, 4.5, dt, 'restore.replay')
      emit.apply = pump(emit.apply, 3.5, dt, 'restore.apply')
      jib.rotation.y = Math.sin(clock * 0.9) * 0.7
      hook.visible = Math.sin(clock * 0.9) > 0
      beltFlow.position.x = RR[0] + 12 - ((clock * 9) % 24)
    } else {
      hook.visible = false
      if (complete) beltFlow.position.x = RR[0] - 9.4
    }
    replayHand.rotation.y = damp(replayHand.rotation.y, -1.1 + restore.progress * 3.2, 4, dt)
    targetHand.rotation.y = damp(targetHand.rotation.y, -1.1 + clamp(sim.knobs.recoveryTargetAge / 300, 0, 1) * 3.2, 4, dt)
    stopLine.visible = replaying || complete

    /* --- 4. standby_b: independent receive, flush, apply and storage -------*/
    const standbyB = sim.replication.standbys[1]
    const poolB = sim.cluster.nodes[2].buffers
    if (standbyB.connected) {
      emit.bStream = pump(emit.bStream, 5, dt, 'net.streamB')
      emit.bAck = pump(emit.bAck, 2.5, dt, 'net.ackB')
      emit.bApply = pump(emit.bApply, 3.5, dt, 'replicaB.apply')
      emit.bBuffer = pump(emit.bBuffer, 2.5, dt, 'replicaB.buffer')
      emit.bIo = pump(emit.bIo, 1.4, dt, 'replicaB.io')
    }
    const pendingSegments = Math.min(
      N_WAL_B,
      Math.max(
        1,
        Math.ceil(
          Math.max(0, standbyB.receivedLsn - standbyB.appliedLsn)
          / sim.cluster.nodes[2].wal.segmentSize,
        ),
      ),
    )
    for (let i = 0; i < N_WAL_B; i++) {
      const pending = i < pendingSegments
      _c.setHex(
        !standbyB.connected
          ? i === 0 ? COLOR.warn : OFF
          : pending ? COLOR.wal : COLOR.replication,
      )
      _c.multiplyScalar(pending ? 1.35 : 0.42)
      walB.setColorAt(i, _c)
    }
    if (walB.instanceColor) walB.instanceColor.needsUpdate = true

    for (let i = 0; i < N_TILE_B; i++) {
      if (!poolB.valid[i]) {
        _c.setHex(OFF)
      } else if (poolB.dirty[i]) {
        _c.setHex(COLOR.bufDirty).multiplyScalar(1.15)
      } else {
        const age = Math.max(0, sim.t - poolB.lastTouch[i])
        _c.setHex(COLOR.bufClean).multiplyScalar(0.32 + Math.max(0, 1 - age / 8) * 0.8)
      }
      tileB.setColorAt(i, _c)
    }
    if (tileB.instanceColor) tileB.instanceColor.needsUpdate = true

    /* --- 5. Patroni lease, endpoint, roles, and pg_rewind ----------------*/
    const ha = sim.highAvailability
    const leader = ha.currentLeader
    const synchronous = configuredSynchronousStandby(sim)
    syncStandbyAPlate.visible = synchronous?.nodeId === 'standbyA'
    syncStandbyBPlate.visible = synchronous?.nodeId === 'standbyB'
    syncStandbyNonePlate.visible = synchronous === undefined
    epArrow.visible = leader !== null
    if (leader) {
      let targetX: number = ANCHOR.postmaster[0]
      let targetZ: number = ANCHOR.postmaster[2]
      if (leader === 'standbyA') {
        targetX = ANCHOR.standby[0]
        targetZ = ANCHOR.standby[2]
      } else if (leader === 'standbyB') {
        targetX = ANCHOR.standbyB[0]
        targetZ = ANCHOR.standbyB[2]
      }
      const bearing = Math.atan2(targetX - EP[0], targetZ - EP[2])
      epArrow.rotation.y = damp(epArrow.rotation.y, bearing, 4, dt)
    }

    const dcs = ha.patroni.dcs
    const key = dcs.leaderKey
    for (let i = 0; i < N_LEASE; i++) {
      const node = sim.cluster.nodes[i]
      const agent = ha.patroni.agents[i]
      const member = dcs.members[i]
      const roleColor =
        node.role === 'primary'
          ? COLOR.ok
          : node.role === 'diverged'
            ? COLOR.crit
            : COLOR.replication
      agentMesh.setColorAt(
        i,
        _c.setHex(
          !node.online && node.role !== 'diverged'
            ? OFF
            : agent.canReachConsensus
              ? roleColor
              : COLOR.warn,
        ).multiplyScalar(1.35),
      )

      memberMesh.setColorAt(
        i,
        _c.setHex(
          member.role === 'leader'
            ? COLOR.ok
            : member.inCommitMajority
              ? COLOR.replication
              : dcs.canCommit
                ? COLOR.warn
                : COLOR.crit,
        ).multiplyScalar(member.inCommitMajority ? 1.4 : 1.05),
      )
      const keyCurrent = key.leaseValid
        && member.inCommitMajority
        && member.appliedRevision === key.revision
        && member.appliedLeaderKey === key.value
      keyMesh.setColorAt(
        i,
        _c.setHex(
          member.appliedLeaderKey === null
            ? OFF
            : keyCurrent
              ? COLOR.ok
              : COLOR.warn,
        ).multiplyScalar(keyCurrent ? 1.5 : 0.95),
      )

      const leaseFraction = agent.observedLeaderKey === agent.nodeId
        ? clamp01(agent.leaseRemainingSec / key.ttlSec)
        : 0
      const a = AGENT_AT[i]
      _p.set(a[0] + 9, 0.9 + leaseFraction * 4.6, a[2])
      _sc.set(1.1, Math.max(0.08, leaseFraction * 9.2), 2.5)
      _m.compose(_p, _qi, _sc)
      leaseMesh.setMatrixAt(i, _m)
      leaseMesh.setColorAt(
        i,
        _c.setHex(
          leaseFraction <= 0
            ? OFF
            : agent.canReachConsensus
              ? COLOR.ok
              : COLOR.warn,
        ).multiplyScalar(1.45),
      )
    }
    for (let i = 0; i < N_LEASE; i++) {
      const from = LINK_FROM[i]
      const to = LINK_TO[i]
      raftLinks.setColorAt(
        i,
        _c.setHex(dcs.members[from].reachableMembers[to] ? COLOR.ok : COLOR.crit)
          .multiplyScalar(dcs.members[from].reachableMembers[to] ? 0.8 : 1.2),
      )
    }
    leaseMesh.instanceMatrix.needsUpdate = true
    if (agentMesh.instanceColor) agentMesh.instanceColor.needsUpdate = true
    if (memberMesh.instanceColor) memberMesh.instanceColor.needsUpdate = true
    if (keyMesh.instanceColor) keyMesh.instanceColor.needsUpdate = true
    if (raftLinks.instanceColor) raftLinks.instanceColor.needsUpdate = true
    if (leaseMesh.instanceColor) leaseMesh.instanceColor.needsUpdate = true

    const rewind = ha.rejoin
    const rewindActive = rewind.status === 'checking'
      || rewind.status === 'rewinding'
      || rewind.status === 'complete'
    rewindBar.visible = rewindActive
    rewindBar.scale.x = Math.max(0.2, rewind.progress * 20)
    rewindBar.position.x = RJ[0] - 21 + rewindBar.scale.x / 2
    rewindFailure.visible = rewind.status === 'failed'
      && Math.sin(clock * 5) > -0.25
  }

  function setDetail(level: 0 | 1 | 2): void {
    gDetail.visible = level > 0
  }
  setDetail(quality.level === 'low' ? 0 : 1)

  function dispose(): void {
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    for (const im of instanced) im.dispose()
    group.clear()
  }

  return { id: 'continuity', group, update, setDetail, dispose }
}
