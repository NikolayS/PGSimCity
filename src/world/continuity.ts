import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import type { SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtBytes, fmtDuration } from '../core/util'
import { ANCHOR, CONTINUITY } from './layout'

/* ============================================================================
 * THE CONTINUITY QUARTER — backups, point-in-time recovery, and the machinery
 * of failover.
 *
 * The rest of the city answers "what is Postgres doing right now". This quarter
 * answers the two questions that decide whether anybody still has a job
 * tomorrow: can you get the data BACK, and can somebody else serve it when this
 * machine stops. It is built OFF the primary's site, because that is the whole
 * point of it, as three works:
 *
 *   ARCHIVE ESTATE   east, downstream of the archiver that already exists: a
 *                    gate you cannot carry anything back through, the TIMELINE
 *                    SWITCHYARD, the bucket, and the backup vault.
 *
 *   RECOVERY GROUND  south-west, a long haul road away, on its own iron: an
 *                    empty data directory, a winch that lifts one archived segment at
 *                    a time, a dial set to recovery_target_time, and a replay
 *                    belt with a stop line painted across it.
 *
 *   HA QUARTER       due south: three nodes, one leader lock in a store that
 *                    holds no user data, one service address out on the
 *                    arrivals avenue, and a rejoin bay for the node that loses.
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
 * WHAT IS SIMULATED, AND WHAT IS NOT. Continuous archiving and the lease board
 * are read straight off the live simulation. The restore drill is this module's
 * own clock: it takes a base backup from the STANDBY, hauls it and the archived
 * WAL round to the recovery ground, replays to a target time, stops on the
 * line, and — for the first three drills — promotes, which forks a new timeline
 * into the yard. After that it stops at the pause and shuts the drill cluster
 * down instead, and the board says why: a rehearsal that promotes burns a
 * timeline ID into your archive forever, so a real verification drill does not
 * promote.
 *
 * An unplanned FAILOVER is deliberately NOT animated. The primary's own
 * district is visibly serving traffic two hundred metres north; showing it dead
 * down here would be the one lie this city cannot afford, and faking it would
 * cost more trust than the animation is worth. Every standing part of the story
 * is built instead — who holds the lock, whose lease is counting down, which
 * candidate is eligible and exactly why the other never is, where the service
 * address points, and the bay a demoted node must pass through before it can
 * follow anyone. Wiring the event itself needs a `primary down` state in
 * sim/model.ts; the geometry here is already driven off `primaryNode`.
 * ==========================================================================*/

/* --- module scope scratch: update() must never allocate -------------------- */
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _qi = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _axisX = new THREE.Vector3(1, 0, 0)

/** cx, cy, cz, w, h, d */
type Box = [number, number, number, number, number, number]

const N_VAULT = CONTINUITY.backupSlots
const N_SILO = CONTINUITY.silo.rows * CONTINUITY.silo.cols
const N_LEASE = 3
const BUF_B = 6
const N_TILE_B = BUF_B * BUF_B
const N_HISTORY = CONTINUITY.branches.length
/** Dark. Used for every unlit instance colour in the quarter. */
const OFF = 0x0a1120

/* --- the drill clock ------------------------------------------------------ */

type Phase = 'archive' | 'basebackup' | 'haul' | 'unpack' | 'replay' | 'hold' | 'decide' | 'teardown'

const PHASES: readonly Phase[] = ['archive', 'basebackup', 'haul', 'unpack', 'replay', 'hold', 'decide', 'teardown']
const P_UNPACK = 3
const P_DECIDE = 6

/** Simulated seconds per phase. One drill is 96 s. */
const PHASE_SEC: Readonly<Record<Phase, number>> = {
  archive: 10,
  basebackup: 16,
  haul: 12,
  unpack: 8,
  replay: 28,
  hold: 7,
  decide: 6,
  teardown: 9,
}

const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  archive: 'idle — archiving only',
  basebackup: 'pg_basebackup, from standby_a',
  haul: 'base backup + archived WAL leaving the bucket',
  unpack: 'unpacking base.tar onto an empty data directory',
  replay: 'replaying archived WAL toward the target',
  hold: 'target reached — recovery paused',
  decide: 'promote, or shut down',
  teardown: 'drill cluster dropped',
}

/**
 * Patroni's `maximum_lag_on_failover`, in bytes. A candidate further behind
 * than this is not promoted, because promoting it throws the difference away.
 */
const MAX_LAG_ON_FAILOVER = 1048576
/** Patroni's `ttl` — how long the leader lock survives without a renewal. */
const LEASE_TTL = 30
/** Patroni's `loop_wait` — how often each agent wakes up and renews. */
const LOOP_WAIT = 10
/** Node 3's `recovery_min_apply_delay`, in seconds. */
const APPLY_DELAY = 15 * 60

const cssHex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0')

/** `00000002.history` — a timeline history file name. */
const historyName = (tli: number) => tli.toString(16).toUpperCase().padStart(8, '0') + '.history'

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

  plate('RETENTION / OWNERSHIP BOUNDARY', AG[0] - 1.9, 19.4, AG[2], -Math.PI / 2, 2.1, COLOR.archive, 0.92, gGate)
  plate(
    'exit code 0 means STORED — anything else and the archiver retries the same file, forever',
    AG[0] - 1.9, 11.6, AG[2], -Math.PI / 2, 1.4, COLOR.inkDim, 0.62,
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
  plate('timeline 1 · live', Y.x0 + 17, Y.deckY + 3.4, Y.z - 5.2, Math.PI, 2.4, COLOR.wal, 0.95, gYard)

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
    lamp(COLOR.crit, 1.1, 1.4, 2.4, Y.width - 1, Y.x1, br.deckY + 0.8, br.z, g)

    box([br.forkX, Y.deckY + 2.4, Y.z + 3.4, 0.9, 5.4, 0.9], 'none')
    const tli = 2 + k
    plate(historyName(tli), br.forkX, Y.deckY + 5.4, Y.z + 3.9, 0, 1.9, COLOR.archive, 0.95, g)
    plate(`timeline ${tli}`, x0 + 9, br.deckY + 2.6, br.z - 4.2, Math.PI, 1.9, COLOR.archive, 0.8, g)
  }

  box([yardMidX, 5.0, Y.z + 15, 24, 0.9, 0.7], 'none')
  box([yardMidX - 11, 2.5, Y.z + 15, 0.8, 5, 0.8], 'none')
  box([yardMidX + 11, 2.5, Y.z + 15, 0.8, 5, 0.8], 'none')
  plate('TIMELINE SWITCHYARD', yardMidX, 7.6, Y.z + 15, 0, 2.6, COLOR.archive, 0.9, gYard)
  plate(
    'one deck per timeline · a turnout is a fork · the plaque is the .history file · nothing ever rejoins',
    yardMidX, 4.4, Y.z + 15.5, 0, 1.35, COLOR.inkDim, 0.66,
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

  plate('object storage', OS[0], 12.4, OS[2] - yardHalfZ - 6, Math.PI, 3.0, COLOR.archive, 0.9, gStore)
  plate('one silo = one 16 MiB segment · one row = one timeline', OS[0], 9.0, OS[2] - yardHalfZ - 6.4, Math.PI, 1.45, COLOR.inkDim, 0.66)
  plate('latest 8 shown · retained archive never wraps', OS[0], 6.8, OS[2] - yardHalfZ - 6.4, Math.PI, 1.2, COLOR.inkDim, 0.6)
  plate('.history — small, and kept forever', OS[0] - 20, 5.6, OS[2] + 23, 0, 1.4, COLOR.inkDim, 0.66)

  /* ---------------------------------------------------------------------
   * 4. THE BACKUP VAULT, and the host that fills it.
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

  plate('BASE BACKUPS', BV[0], 12.6, BV[2] - 14, Math.PI, 2.8, COLOR.storage, 0.9, gVault)
  plate('base.tar · pg_wal.tar · backup_label · backup_manifest', BV[0], 9.4, BV[2] - 14.4, Math.PI, 1.45, COLOR.inkDim, 0.68)
  plate('WAL alone restores nothing — it has to be replayed ONTO one of these', BV[0], 7.4, BV[2] - 14.4, Math.PI, 1.3, COLOR.inkDim, 0.62)
  plate('recovery window', BV[0], 1.6, BV[2] + 22, 0, 1.6, COLOR.storage, 0.7)

  const gHost = new THREE.Group()
  gHost.name = 'backup.host'
  group.add(gHost)
  part(gHost)
  const BH = ANCHOR.backupHost
  box([BH[0], 4, BH[2], 18, 8, 14], 'dim')
  box([BH[0], 11, BH[2], 1.4, 6, 1.4], 'none')
  const hostLamp = lamp(COLOR.storage, 1.6, 2.6, 1.0, 2.6, BH[0], 14.4, BH[2], gHost)
  hostLamp.visible = false
  plate('backup host', BH[0], 10.8, BH[2] - 7.4, Math.PI, 2.2, COLOR.storage, 0.9, gHost)
  plate(
    'pg_basebackup -h standby_a -D /bk -Ft -X stream -c fast  ·  the primary never feels it',
    BH[0], 7.6, BH[2] - 7.8, Math.PI, 1.3, COLOR.inkDim, 0.68,
  )
  plate(
    'and if standby_a is promoted mid-backup, the backup fails — that is documented, not a bug',
    BH[0], 5.6, BH[2] - 7.8, Math.PI, 1.2, COLOR.inkDim, 0.6,
  )

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

  /** Shown only when the drill will NOT promote. */
  const drillBoard = plate(
    'a drill that PROMOTES burns a timeline ID into the archive forever — verify, then shut it down',
    RP[0], 12, RP[2] + 17, 0, 1.5, COLOR.warn, 0.85,
  )
  drillBoard.visible = false

  // the winch — restore_command, one hook, one file
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
  plate('one hook, one segment — this is why recovery is single-threaded', RW[0], 17.4, RW[2] + 0.4, 0, 1.3, COLOR.inkDim, 0.66)

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
   * 6. THE HA QUARTER.
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
  plate(
    'clients dial this, never a node · Patroni moves it, and Patroni is never in the data path',
    EP[0], 13.8, EP[2] - 1.7, Math.PI, 1.3, COLOR.inkDim, 0.7,
  )

  const gDcs = new THREE.Group()
  gDcs.name = 'ha.dcs'
  group.add(gDcs)
  part(gDcs)
  const DC = ANCHOR.consensus
  box([DC[0], 5, DC[2], 26, 10, 20], 'dim')
  box([DC[0], 10.6, DC[2], 28, 0.9, 22], 'none')

  const ringGeo = new THREE.TorusGeometry(2.6, 0.55, 8, 20)
  geos.push(ringGeo)
  const lockRing = new THREE.Mesh(ringGeo, theme.neon(COLOR.ok, 1.7))
  lockRing.position.set(DC[0], 14.6, DC[2])
  lockRing.rotation.x = Math.PI / 2
  lockRing.raycast = () => {}
  gDcs.add(lockRing)
  const lockBody = lamp(COLOR.ok, 1.4, 4.4, 3.2, 2.4, DC[0], 12.6, DC[2], gDcs)

  plate('DCS · the leader lock', DC[0], 18.8, DC[2], 0, 2.4, COLOR.ink, 0.9, gDcs)
  plate(
    'a lock, a lease and cluster state — and no user data, which is why it is not painted like Postgres',
    DC[0], 16.2, DC[2] + 0.4, 0, 1.25, COLOR.inkDim, 0.68,
  )
  plate(`ttl = ${LEASE_TTL}s · loop_wait = ${LOOP_WAIT}s · lose the lock for ttl and you are demoted`, DC[0], 8.2, DC[2] - 10.4, Math.PI, 1.25, COLOR.inkDim, 0.7)

  const LEASE_AT: readonly (readonly [number, number, number])[] = [ANCHOR.leaseNode1, ANCHOR.leaseNode2, ANCHOR.leaseNode3]
  const LEASE_TITLE = ['node 1 · primary', 'node 2 · standby_a', 'node 3 · standby_b']
  for (let i = 0; i < N_LEASE; i++) {
    const a = LEASE_AT[i]
    box([a[0], 4.5, a[2], 1.1, 9, 1.1], 'none')
    plate(LEASE_TITLE[i], a[0], 12.6, a[2], 0, 1.7, i === 0 ? COLOR.ok : COLOR.replication, 0.9)
  }
  plate("ineligible: recovery_min_apply_delay = '15min'", ANCHOR.leaseNode3[0], 10.6, ANCHOR.leaseNode3[2] + 0.4, 0, 1.25, COLOR.warn, 0.85)
  plate(`eligible while lag <= ${fmtBytes(MAX_LAG_ON_FAILOVER)}`, ANCHOR.leaseNode2[0], 10.6, ANCHOR.leaseNode2[2] + 0.4, 0, 1.25, COLOR.inkDim, 0.75)

  /** 0..2 are the role lamps; 3..5 the lease bars that drain and are renewed. */
  const leaseMesh = neonBank('ha.leases', unitBox, N_LEASE * 2, gDcs)
  for (let i = 0; i < N_LEASE * 2; i++) {
    const a = LEASE_AT[i % N_LEASE]
    if (i < N_LEASE) {
      _p.set(a[0], 9.7, a[2])
      _sc.set(2.4, 1.1, 2.4)
    } else {
      _p.set(a[0], 5, a[2] + 1.1)
      _sc.set(1.6, 8, 0.4)
    }
    _m.compose(_p, _qi, _sc)
    leaseMesh.setMatrixAt(i, _m)
    leaseMesh.setColorAt(i, _c.setHex(OFF))
  }
  leaseMesh.instanceMatrix.needsUpdate = true

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
    'after an unplanned failover the old primary holds WAL nobody will ever replay — it cannot just follow the winner',
    RJ[0], 5.6, RJ[2] - 10.5, 0, 1.2, COLOR.inkDim, 0.72,
  )
  plate(
    'pg_rewind needs wal_log_hints = on (or data checksums) · full_page_writes = on · the target shut down cleanly',
    RJ[0], 3.6, RJ[2] - 10.5, 0, 1.2, COLOR.inkDim, 0.72,
  )

  /* node 3: the second standby, fifteen minutes in the past on purpose */
  const gStandbyB = new THREE.Group()
  gStandbyB.name = 'standby.b'
  group.add(gStandbyB)
  part(gStandbyB)
  const SB = ANCHOR.standbyB
  const SBR = ANCHOR.standbyBRecv
  const SBD = ANCHOR.standbyBDeck
  box([SBR[0], 4, SBR[2], 12, 8, 9], 'dim')
  box([SB[0], 4, SB[2], 10, 8, 8], 'dim')
  box([SBD[0], SBD[1] - 0.5, SBD[2], 32, 1.0, 24], 'dim')
  box([SBD[0], 6, SBD[2] - 15, 30, 8, 0.7], 'dim')

  const tileB = neonBank('standby.b.buffers', unitBox, N_TILE_B, gStandbyB)
  for (let i = 0; i < N_TILE_B; i++) {
    const col = i % BUF_B
    const row = Math.floor(i / BUF_B)
    _p.set(SBD[0] + (col - (BUF_B - 1) / 2) * 3.4, SBD[1] + 0.35, SBD[2] + (row - (BUF_B - 1) / 2) * 3.4)
    _sc.set(2.7, 0.35, 2.7)
    _m.compose(_p, _qi, _sc)
    tileB.setMatrixAt(i, _m)
    tileB.setColorAt(i, _c.setHex(OFF))
  }
  tileB.instanceMatrix.needsUpdate = true

  plate('standby_b', SB[0], 10.8, SB[2] - 4.4, Math.PI, 2.2, COLOR.replication, 0.92, gStandbyB)
  plate('walreceiver', SBR[0], 10.6, SBR[2] - 5, Math.PI, 1.6, COLOR.replication, 0.8)
  plate('a TIME-DELAYED standby', SBD[0], 8.8, SBD[2] - 15.5, Math.PI, 2.0, COLOR.warn, 0.9, gStandbyB)
  plate(
    'it receives and FLUSHES with the others — only replay waits 15 minutes, so a bad DELETE can still be outrun',
    SBD[0], 6.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72,
  )
  const syncPlate = plate("synchronous_standby_names = ''", SBD[0], 4.4, SBD[2] - 15.5, Math.PI, 1.2, COLOR.inkDim, 0.72)

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

  let phase: Phase = 'archive'
  let phaseIdx = 0
  let phaseT = 0
  let drills = 1
  let branches = 0
  /** The timeline the NEXT promotion would create. The live one is 1. */
  let nextTli = 2
  let backupsHeld = 1
  let newestBackupAge = 0
  /** 0..1 — how far replay has got toward recovery_target_time. */
  let replayProgress = 0
  let lastSimT = -1
  /** 0..1 through one Patroni loop_wait. */
  let leasePhase = 0
  let clock = 0
  let queueEma = 0
  let prevArchived = -1
  let node3LagBytes = 0
  /**
   * Which node owns the service address. Always 0 today; the arrow, the lamps
   * and the readouts all key off it, so a real failover only has to move it.
   */
  const primaryNode = 0

  const NODE_AT: readonly (readonly [number, number, number])[] = [ANCHOR.postmaster, ANCHOR.standby, ANCHOR.standbyB]

  const phaseIn = (p: Phase) => phase === p
  const willPromote = () => branches < CONTINUITY.branches.length

  function nodeEligible(i: number, s: SimState): boolean {
    if (i === primaryNode) return false // it already holds the lock
    if (!s.replication.connected) return false
    if (i === 2) return false // recovery_min_apply_delay keeps node 3 out, always
    return s.replication.lagBytes <= MAX_LAG_ON_FAILOVER
  }

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
      const q = s.wal.archiveQueue
      if (q > 6) return `${q} segments queued — the archive is falling behind`
      if (q > 0) return `${q} queued · ${s.wal.archived} shipped`
      return `clear · ${s.wal.archived} segments shipped`
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
    readout: () =>
      branches === 0
        ? 'timeline 1 · no branches yet'
        : `timeline 1 live · ${branches} branch${branches === 1 ? '' : 'es'} · next would be ${historyName(nextTli)}`,
  })

  ctx.register({
    id: 'object.store',
    name: 'object storage',
    role: 'the bucket: every archived segment, filed by timeline',
    kind: 'storage',
    district: 'wal',
    object: gStore,
    tier: 1,
    focus: { target: [OS[0], 6, OS[2]], distance: 98, dir: [0.3, 0.6, 0.74] },
    labelAt: [OS[0], 18, OS[2]],
    color: COLOR.archive,
    readout: (s: SimState) =>
      `${s.wal.archived} segments · ${branches + 1} timeline${branches === 0 ? '' : 's'} · ${fmtBytes(s.wal.archived * s.wal.segmentSize)}`,
  })

  ctx.register({
    id: 'backup.vault',
    name: 'the backup vault',
    role: 'base backups — the only thing archived WAL can be replayed onto',
    kind: 'storage',
    district: 'wal',
    object: gVault,
    tier: 0,
    focus: { target: [BV[0], 6, BV[2]], distance: 112, dir: [0.34, 0.5, 0.8] },
    labelAt: [BV[0], 20, BV[2]],
    color: COLOR.storage,
    readout: () =>
      `${backupsHeld} full backup${backupsHeld === 1 ? '' : 's'} held · newest ${fmtDuration(newestBackupAge)} old`,
  })

  ctx.register({
    id: 'backup.host',
    name: 'the backup host',
    role: 'runs pg_basebackup against the standby, not the primary',
    kind: 'process',
    district: 'replication',
    object: gHost,
    tier: 1,
    focus: { target: [BH[0], 6, BH[2]], distance: 72, dir: [0.4, 0.46, 0.79] },
    labelAt: [BH[0], 18, BH[2]],
    color: COLOR.storage,
    readout: () =>
      phaseIn('basebackup')
        ? `running · ${((phaseT / PHASE_SEC.basebackup) * 100).toFixed(0)}%`
        : 'idle — the next full backup is on the drill clock',
  })

  ctx.register({
    id: 'recovery.ground',
    name: 'the recovery ground',
    role: 'a whole other cluster, built back out of the archive',
    kind: 'storage',
    district: 'world',
    object: gRecovery,
    tier: 0,
    focus: { target: [-312, 6, 258], distance: 172, dir: [-0.24, 0.5, 0.83] },
    labelAt: [RP[0], 22, RP[2]],
    color: COLOR.bufClean,
    readout: () => `drill ${drills} · ${PHASE_LABEL[phase]}`,
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
    readout: () =>
      phaseIn('hold') || phaseIn('decide')
        ? "target reached · pg_get_wal_replay_pause_state() = 'paused'"
        : `${(replayProgress * 100).toFixed(0)}% of the way to the target`,
  })

  ctx.register({
    id: 'restore.winch',
    name: 'restore_command',
    role: 'one hook, one archived segment at a time',
    kind: 'process',
    district: 'world',
    object: gWinch,
    tier: 2,
    focus: { target: [RW[0], 12, RW[2]], distance: 56, dir: [0.44, 0.42, 0.79] },
    labelAt: [RW[0], 26, RW[2]],
    color: COLOR.wal,
    readout: () => (phaseIn('replay') ? 'fetching the next segment from the archive' : 'idle'),
  })

  ctx.register({
    id: 'recovery.replay',
    name: 'the replay belt',
    role: 'the startup process, replaying, with a line painted across it',
    kind: 'process',
    district: 'world',
    object: gReplay,
    tier: 2,
    focus: { target: [RR[0] - 4, 6, RR[2]], distance: 60, dir: [-0.2, 0.45, 0.87] },
    labelAt: [RR[0] - 4, 14, RR[2]],
    color: COLOR.bufClean,
    readout: () => (phaseIn('hold') ? 'stopped on the line' : phaseIn('replay') ? 'replaying' : 'stopped'),
  })

  ctx.register({
    id: 'ha.endpoint',
    name: 'the service address',
    role: 'what clients dial — it follows the primary, and it is not Patroni',
    kind: 'network',
    district: 'clients',
    object: gEndpoint,
    tier: 0,
    focus: { target: [EP[0], 8, EP[2]], distance: 80, dir: [0.16, 0.42, -0.89] },
    labelAt: [EP[0], 22, EP[2]],
    color: COLOR.client,
    readout: () => `pointing at node ${primaryNode + 1}`,
  })

  ctx.register({
    id: 'ha.dcs',
    name: 'the DCS',
    role: 'holds the leader lock, the lease clock, and no user data',
    kind: 'network',
    district: 'replication',
    object: gDcs,
    tier: 0,
    focus: { target: [DC[0], 8, DC[2]], distance: 98, dir: [-0.2, 0.48, 0.85] },
    labelAt: [DC[0], 24, DC[2]],
    color: COLOR.ink,
    readout: (s: SimState) => {
      const n = nodeEligible(1, s) ? 1 : 0
      return `node 1 holds the lock · renewed every ${LOOP_WAIT}s against a ${LEASE_TTL}s ttl · ${n} eligible candidate${n === 1 ? '' : 's'}`
    },
  })

  ctx.register({
    id: 'ha.rejoin',
    name: 'the rejoin bay',
    role: 'pg_rewind, or a rebuild — a demoted primary has no third option',
    kind: 'concept',
    district: 'replication',
    object: gRejoin,
    tier: 2,
    focus: { target: [RJ[0], 6, RJ[2]], distance: 64, dir: [-0.3, 0.5, -0.81] },
    labelAt: [RJ[0], 16, RJ[2]],
    color: COLOR.warn,
    readout: () => 'empty — nothing has been demoted on this cluster',
  })

  ctx.register({
    id: 'standby.b',
    name: 'standby_b',
    role: 'a time-delayed standby — 15 minutes in the past, on purpose',
    kind: 'storage',
    district: 'replication',
    object: gStandbyB,
    tier: 0,
    focus: { target: [SB[0], 6, SB[2] + 20], distance: 132, dir: [-0.5, 0.46, 0.73] },
    labelAt: [SB[0], 20, SB[2]],
    color: COLOR.replication,
    readout: (s: SimState) =>
      s.replication.connected
        ? `flushed with standby_a · replay held ${fmtDuration(APPLY_DELAY)} · ${fmtBytes(node3LagBytes)} waiting in pg_wal`
        : 'disconnected',
  })

  /* ---------------------------------------------------------------------
   * 10. Per-frame.
   * -------------------------------------------------------------------*/

  /** Emission accumulators, one per route. Never reallocated. */
  const emit = {
    take: 0, store: 0, haul: 0, unpack: 0,
    replay: 0, apply: 0, streamB: 0, applyB: 0, lease1: 0, lease2: 0, lease3: 0,
  }

  function pump(acc: number, perSec: number, dt: number, route: string): number {
    let a = acc + perSec * dt
    while (a >= 1) {
      a -= 1
      ctx.flow({ route, count: 1 })
    }
    return a
  }

  function advancePhase(): void {
    phaseIdx = (phaseIdx + 1) % PHASES.length
    phase = PHASES[phaseIdx]
    phaseT = 0

    switch (phase) {
      case 'archive':
        drills += 1
        replayProgress = 0
        break
      case 'basebackup':
        backupsHeld = Math.min(N_VAULT, backupsHeld + 1)
        newestBackupAge = 0
        break
      case 'unpack':
        signalFlag.visible = true
        break
      case 'decide':
        drillBoard.visible = !willPromote()
        if (willPromote()) {
          branchGroup[branches].visible = true
          branches += 1
          nextTli += 1
          ctx.bus.emit('fx:pulse', { at: [yardMidX, 12, Y.z], color: COLOR.archive, radius: 44 })
        }
        break
      case 'teardown':
        signalFlag.visible = false
        break
      default:
        break
    }
  }

  function update(dt: number, sim: SimState, t: number): void {
    clock += dt

    /* The drill runs on SIMULATED time, so pausing the city pauses it and the
     * speed control drives it — it is part of the model, not a screensaver. */
    if (lastSimT < 0) lastSimT = t
    const sdt = Math.max(0, Math.min(2, t - lastSimT))
    lastSimT = t
    phaseT += sdt
    newestBackupAge += sdt
    if (phaseT >= PHASE_SEC[phase]) advancePhase()

    /* --- 1. continuous archiving, read off the live WAL --------------------*/
    queueEma = damp(queueEma, sim.wal.archiveQueue, 2.5, dt)
    const failing = queueEma > 6
    const busy = queueEma > 0.6
    gateLamp[0].visible = !busy
    gateLamp[1].visible = busy && !failing
    gateLamp[2].visible = failing
    retryCrate.visible = failing

    if (prevArchived < 0) prevArchived = sim.wal.archived
    let shipped = Math.max(0, sim.wal.archived - prevArchived)
    prevArchived = sim.wal.archived
    while (shipped-- > 0) ctx.flow({ route: 'archive.ship', count: 1, kind: 'archive', color: COLOR.archive, size: 1.3 })

    /* Row 0 is the live timeline and fills from the west; the branch rows only
     * light for timelines that exist, and hold less WAL the later they forked. */
    const liveFill = Math.min(sim.wal.archived, S.cols)
    for (let r = 0; r < S.rows; r++) {
      const exists = r === 0 || r <= branches
      const fill = r === 0 ? liveFill : S.cols - (r - 1) * 2
      for (let c = 0; c < S.cols; c++) {
        const lit = exists && c < fill
        const newest = r === 0 && liveFill > 0 && c === liveFill - 1
        _c.setHex(!lit ? OFF : newest ? mixHex(COLOR.wal, 0xffffff, 0.45) : r === 0 ? COLOR.wal : COLOR.archive)
        if (lit) _c.multiplyScalar(1.25)
        siloCap.setColorAt(r * S.cols + c, _c)
      }
    }
    if (siloCap.instanceColor) siloCap.instanceColor.needsUpdate = true

    for (let k = 0; k < N_HISTORY; k++) {
      const lit = k < branches
      _c.setHex(lit ? COLOR.archive : OFF)
      if (lit) _c.multiplyScalar(1.5)
      historyTablet.setColorAt(k, _c)
    }
    if (historyTablet.instanceColor) historyTablet.instanceColor.needsUpdate = true

    /* --- 2. the vault and the recovery window -----------------------------*/
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

    /* --- 3. the restore drill ---------------------------------------------*/
    hostLamp.visible = phaseIn('basebackup') && Math.sin(clock * 2.2) > -0.2
    if (phaseIn('basebackup')) {
      emit.take = pump(emit.take, 6, dt, 'backup.take')
      emit.store = pump(emit.store, 5, dt, 'backup.store')
    }
    if (phaseIn('haul')) emit.haul = pump(emit.haul, 3.5, dt, 'restore.haul')
    if (phaseIn('unpack')) emit.unpack = pump(emit.unpack, 5, dt, 'restore.unpack')

    const unpacked = phaseIn('unpack') ? clamp01(phaseT / PHASE_SEC.unpack) : phaseIdx > P_UNPACK && phaseIdx <= P_DECIDE ? 1 : 0
    pgdata.scale.y = damp(pgdata.scale.y, 0.2 + unpacked * 6.8, 3, dt)
    pgdata.position.y = pgdata.scale.y / 2 + 0.6

    if (phaseIn('replay')) {
      replayProgress = clamp01(phaseT / PHASE_SEC.replay)
      emit.replay = pump(emit.replay, 4.5, dt, 'restore.replay')
      emit.apply = pump(emit.apply, 3.5, dt, 'restore.apply')
      jib.rotation.y = Math.sin(clock * 0.9) * 0.7
      hook.visible = Math.sin(clock * 0.9) > 0
      beltFlow.position.x = RR[0] + 12 - ((clock * 9) % 24)
    } else {
      hook.visible = false
      if (phaseIn('hold') || phaseIn('decide')) {
        replayProgress = 1
        beltFlow.position.x = RR[0] - 9.4
      }
    }
    replayHand.rotation.y = damp(replayHand.rotation.y, -1.1 + replayProgress * 3.2, 4, dt)
    stopLine.visible = phaseIdx >= P_UNPACK && phaseIdx <= P_DECIDE

    /* --- 4. the lease board ------------------------------------------------*/
    leasePhase = (leasePhase + sdt / LOOP_WAIT) % 1
    for (let i = 0; i < N_LEASE; i++) {
      const leader = i === primaryNode
      const hex = leader ? COLOR.ok : nodeEligible(i, sim) ? COLOR.replication : COLOR.warn
      _c.setHex(hex).multiplyScalar(1.5)
      leaseMesh.setColorAt(i, _c)

      // the bar drains toward the ttl and is snapped full again on renewal
      const remain = leader ? 1 - leasePhase * (LOOP_WAIT / LEASE_TTL) : 1
      _p.set(LEASE_AT[i][0], 1 + (8 * remain) / 2, LEASE_AT[i][2] + 1.1)
      _sc.set(1.6, 8 * remain, 0.4)
      _m.compose(_p, _qi, _sc)
      leaseMesh.setMatrixAt(N_LEASE + i, _m)
      _c.setHex(leader ? COLOR.ok : mixHex(hex, OFF, 0.6)).multiplyScalar(1.2)
      leaseMesh.setColorAt(N_LEASE + i, _c)
    }
    leaseMesh.instanceMatrix.needsUpdate = true
    if (leaseMesh.instanceColor) leaseMesh.instanceColor.needsUpdate = true

    // The DCS and its leader lock exist independently of streaming health.
    // Renewal visibly breathes the lock; replication only changes eligibility.
    const leasePulse = 1 + 0.07 * (1 - leasePhase)
    lockRing.visible = true
    lockRing.scale.setScalar(leasePulse)
    lockBody.visible = true
    lockBody.scale.set(1, 0.82 + 0.18 * (1 - leasePhase), 1)
    emit.lease1 = pump(emit.lease1, 1.4, dt, 'ha.lease1')
    if (sim.replication.connected) {
      emit.lease2 = pump(emit.lease2, 1.4, dt, 'ha.lease2')
      emit.lease3 = pump(emit.lease3, 1.4, dt, 'ha.lease3')
    }

    const na = NODE_AT[primaryNode]
    epArrow.rotation.y = damp(epArrow.rotation.y, Math.atan2(na[0] - EP[0], na[2] - EP[2]), 3, dt)

    /* --- 5. node 3 ---------------------------------------------------------*/
    node3LagBytes = damp(node3LagBytes, sim.stats.walBytesPerSec * APPLY_DELAY, 0.6, dt)
    if (sim.replication.connected) {
      emit.streamB = pump(emit.streamB, 3.2, dt, 'net.streamB')
      emit.applyB = pump(emit.applyB, 1.6, dt, 'replicaB.apply')
    }
    const heat = sim.replication.connected ? 0.7 + 0.3 * Math.sin(clock * 1.4) : 1
    const wave = Math.floor(clock * 1.6)
    for (let i = 0; i < N_TILE_B; i++) {
      const lit = sim.replication.connected && (i + wave) % 7 !== 0
      _c.setHex(lit ? COLOR.bufClean : OFF)
      if (lit) _c.multiplyScalar(heat)
      tileB.setColorAt(i, _c)
    }
    if (tileB.instanceColor) tileB.instanceColor.needsUpdate = true

    /* --- 6. synchronous_standby_names, kept honest with the GUC ------------*/
    const sc = sim.knobs.synchronousCommit
    const line =
      sc === 'off' || sc === 'local'
        ? "synchronous_standby_names = '' — both standbys are asynchronous"
        : sc === 'remote_apply'
          ? 'remote_apply + a 15min delay = every COMMIT waits 15 minutes. Keep standby_b out of the sync set.'
          : "synchronous_standby_names = 'ANY 1 (standby_a, standby_b)'"
    if (syncPlate.userData.line !== line) {
      syncPlate.userData.line = line
      const tex = theme.textTexture(line, { size: 64, color: cssHex(sc === 'remote_apply' ? COLOR.crit : COLOR.inkDim) })
      const img = tex.image as { width: number; height: number }
      const mat = syncPlate.material as THREE.MeshBasicMaterial
      mat.map = tex
      mat.needsUpdate = true
      syncPlate.scale.x = 1.2 * (img && img.height ? img.width / img.height : 6)
    }
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
