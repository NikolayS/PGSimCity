import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { N_BACKEND_SLOTS } from '../core/types'
import type { SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtNum, lerp, makeRng } from '../core/util'
import { ANCHOR, rid } from './layout'

/* ============================================================================
 * CLIENTS — the application tier, the postmaster, and the front gate.
 *
 * The story of every Postgres session starts here:
 *   a client opens a socket → the connection is authenticated at the gate →
 *   the postmaster fork()s a backend → from then on the postmaster is out of
 *   the loop entirely. It is the only process in the whole city that never
 *   touches your data.
 *
 * The client constellation is the one place in PGSimCity where ambient motion is
 * allowed: it is *outside* the database, so it drifts.
 * ==========================================================================*/

/* --- module-scope scratch: update() must never allocate ------------------- */
const _p = new THREE.Vector3()
const _sc = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _e = new THREE.Euler()
const _m = new THREE.Matrix4()
const _c = new THREE.Color()
const _c2 = new THREE.Color()

/** cx, cy, cz, w, h, d */
type BoxSpec = [number, number, number, number, number, number]

const RING_SLOTS = 4
const RING_DUR = 0.62

function pushBoxEdges(out: number[], s: BoxSpec): void {
  const [cx, cy, cz, w, h, d] = s
  const x0 = cx - w / 2,
    x1 = cx + w / 2
  const y0 = cy - h / 2,
    y1 = cy + h / 2
  const z0 = cz - d / 2,
    z1 = cz + d / 2
  const v: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
    [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
  ]
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  for (let i = 0; i < e.length; i++) {
    const p = v[e[i]]
    out.push(p[0], p[1], p[2])
  }
}

function fillBoxes(mesh: THREE.InstancedMesh, specs: BoxSpec[]): void {
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    _p.set(s[0], s[1], s[2])
    _sc.set(s[3], s[4], s[5])
    _q.identity()
    _m.compose(_p, _q, _sc)
    mesh.setMatrixAt(i, _m)
  }
  mesh.instanceMatrix.needsUpdate = true
}

export const createClients: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'district:clients'

  /** Everything this module created and must therefore destroy. Theme-cached
   *  materials/geometries are shared and are NOT owned. */
  const owned: { dispose(): void }[] = []
  function own<T extends { dispose(): void }>(x: T): T {
    owned.push(x)
    return x
  }

  /* --- shared materials ------------------------------------------------- */
  // Structure: matte, cool, faint self-lift so silhouettes read at night.
  const matStruct = theme.mat('clients.struct', {
    color: 0x2c3a56,
    roughness: 0.74,
    metalness: 0.24,
    emissive: 0x0c1524,
  })
  const matDeep = theme.mat('clients.deep', {
    color: 0x182133,
    roughness: 0.88,
    metalness: 0.12,
    emissive: 0x080e1a,
  })
  // White neon base — per-instance colour supplies the hue and the brightness.
  const neonWhite = theme.neon(0xffffff, 1)
  const lineInk = theme.line(COLOR.inkDim, 0.2)

  const unitBox = theme.box(1, 1, 1)
  const unitCyl = theme.cyl(0.5, 0.5, 1, 14)

  const edgeVerts: number[] = []

  /* =======================================================================
   * 1. CLIENT POOL — the application tier, drifting above and north of town.
   * =====================================================================*/

  const nClients = ctx.quality.level === 'low' ? 26 : 40
  const poolGroup = new THREE.Group()
  poolGroup.name = 'client.pool'

  const cRng = makeRng(0xc0ffee)
  const cBaseX = new Float32Array(nClients)
  const cBaseY = new Float32Array(nClients)
  const cBaseZ = new Float32Array(nClients)
  const cPhase = new Float32Array(nClients)
  const cSpeed = new Float32Array(nClients)
  const cAmp = new Float32Array(nClients)
  const cSize = new Float32Array(nClients)
  const cBlink = new Float32Array(nClients) // 0..1, decays
  const cAcc = new Float32Array(nClients) // statement accumulator
  const cX = new Float32Array(nClients)
  const cY = new Float32Array(nClients)
  const cZ = new Float32Array(nClients)

  for (let i = 0; i < nClients; i++) {
    // triangular spread keeps the constellation denser over the city centre
    cBaseX[i] = (cRng() + cRng() - 1) * 116
    cBaseY[i] = 40 + cRng() * 40
    cBaseZ[i] = -360 + cRng() * 108
    cPhase[i] = cRng() * Math.PI * 2
    cSpeed[i] = 0.06 + cRng() * 0.11
    cAmp[i] = 1.6 + cRng() * 2.8
    cSize[i] = 1.15 + cRng() * 0.95
    cAcc[i] = cRng()
  }

  const clientGeo = own(new THREE.OctahedronGeometry(1, 0))
  const clientMesh = new THREE.InstancedMesh(clientGeo, neonWhite, nClients)
  clientMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  clientMesh.frustumCulled = false
  _c.setHex(COLOR.client)
  for (let i = 0; i < nClients; i++) clientMesh.setColorAt(i, _c)
  clientMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolGroup.add(clientMesh)

  // Faint pale-blue beams: sockets held open to the postmaster.
  const nBeams = Math.min(14, nClients)
  const beamStride = Math.max(1, Math.floor(nClients / nBeams))
  const beamPos = new Float32Array(nBeams * 6)
  const beamCol = new Float32Array(nBeams * 6)
  const beamGeo = own(new THREE.BufferGeometry())
  beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3))
  beamGeo.setAttribute('color', new THREE.BufferAttribute(beamCol, 3))
  const beamMat = own(
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  const beamLines = new THREE.LineSegments(beamGeo, beamMat)
  beamLines.frustumCulled = false
  beamLines.raycast = () => {}
  poolGroup.add(beamLines)

  group.add(poolGroup)

  /* =======================================================================
   * 2. THE POSTMASTER — the gatehouse tower.
   * =====================================================================*/

  const pm = new THREE.Group()
  pm.name = 'postmaster'
  pm.position.set(ANCHOR.postmaster[0], ANCHOR.postmaster[1], ANCHOR.postmaster[2])

  const PM_TOP = ANCHOR.postmasterTop[1] // 34

  // Massing: wide at the base, stepped back three times, lantern on top.
  const pmMass: BoxSpec[] = [
    [0, 1.6, 0, 25, 3.2, 25], // apron
    [0, 4.6, 0, 21, 3.0, 21], // plinth
    [0, 11.4, 0, 17, 10.6, 17], // tier 1
    [0, 17.2, 0, 18.2, 1.0, 18.2], // service band
    [0, 22.4, 0, 13, 9.4, 13], // tier 2
    [0, 27.4, 0, 14, 0.8, 14], // service band
    [0, 30.2, 0, 9.2, 4.8, 9.2], // tier 3 / control room
  ]
  const pmDetail: BoxSpec[] = [
    // corner fins — vertical structure, reads as ribs up close
    [-8.2, 11.4, -8.2, 1.1, 10.6, 1.1],
    [8.2, 11.4, -8.2, 1.1, 10.6, 1.1],
    [-8.2, 11.4, 8.2, 1.1, 10.6, 1.1],
    [8.2, 11.4, 8.2, 1.1, 10.6, 1.1],
    [-6.2, 22.4, -6.2, 0.9, 9.4, 0.9],
    [6.2, 22.4, -6.2, 0.9, 9.4, 0.9],
    [-6.2, 22.4, 6.2, 0.9, 9.4, 0.9],
    [6.2, 22.4, 6.2, 0.9, 9.4, 0.9],
    // service walkways
    [0, 6.4, 0, 23.4, 0.36, 23.4],
    [0, 16.9, 0, 19.6, 0.34, 19.6],
    [0, 27.2, 0, 15.2, 0.32, 15.2],
    // the doorway every connection walks through
    [0, 3.2, 10.6, 5.2, 5.6, 0.9],
    [-3.1, 3.2, 10.6, 1.2, 5.6, 1.1],
    [3.1, 3.2, 10.6, 1.2, 5.6, 1.1],
    // sign backer
    [0, 8.6, 8.7, 11.5, 2.4, 0.5],
  ]
  const pmStruct = new THREE.InstancedMesh(unitBox, matStruct, pmMass.length)
  fillBoxes(pmStruct, pmMass)
  const pmDetailMesh = new THREE.InstancedMesh(unitBox, matDeep, pmDetail.length)
  fillBoxes(pmDetailMesh, pmDetail)
  pm.add(pmStruct, pmDetailMesh)
  for (const s of pmMass) pushBoxEdges(edgeVerts, [s[0], s[1] + ANCHOR.postmaster[1], s[2] + ANCHOR.postmaster[2], s[3], s[4], s[5]])

  // lantern + mast (cylinders)
  const pmCyl = new THREE.InstancedMesh(unitCyl, matStruct, 3)
  ;(() => {
    const specs: BoxSpec[] = [
      [0, 33.4, 0, 11.6, 1.6, 11.6], // lantern floor
      [0, PM_TOP + 1.4, 0, 8.4, 3.2, 8.4], // lantern housing
      [0, PM_TOP + 7.4, 0, 0.5, 9.0, 0.5], // mast
    ]
    fillBoxes(pmCyl, specs)
  })()
  pm.add(pmCyl)

  // Lit slits: the postmaster is always listening, so it is never fully dark.
  const pmGlowSpecs: BoxSpec[] = [
    [0, 11.4, 8.62, 12.5, 0.55, 0.12],
    [0, 13.6, 8.62, 12.5, 0.55, 0.12],
    [0, 11.4, -8.62, 12.5, 0.55, 0.12],
    [8.62, 11.4, 0, 0.12, 0.55, 12.5],
    [-8.62, 11.4, 0, 0.12, 0.55, 12.5],
    [0, 22.4, 6.62, 9.5, 0.5, 0.12],
    [0, 24.2, 6.62, 9.5, 0.5, 0.12],
    [0, 22.4, -6.62, 9.5, 0.5, 0.12],
    [6.62, 22.4, 0, 0.12, 0.5, 9.5],
    [-6.62, 22.4, 0, 0.12, 0.5, 9.5],
    [0, 30.2, 4.72, 8.4, 1.5, 0.1], // control room glazing
    [0, 30.2, -4.72, 8.4, 1.5, 0.1],
  ]
  const pmGlow = new THREE.InstancedMesh(unitBox, neonWhite, pmGlowSpecs.length)
  fillBoxes(pmGlow, pmGlowSpecs)
  _c.setHex(COLOR.postmaster)
  for (let i = 0; i < pmGlowSpecs.length; i++) pmGlow.setColorAt(i, _c)
  pmGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  pm.add(pmGlow)

  // Beacon: core + halo + mast tip, animated purely through instance colour.
  const sphereGeo = own(new THREE.SphereGeometry(1, 12, 8))
  const pmBeacon = new THREE.InstancedMesh(sphereGeo, neonWhite, 3)
  ;(() => {
    const specs: BoxSpec[] = [
      [0, PM_TOP, 0, 3.0, 3.0, 3.0],
      [0, PM_TOP, 0, 6.6, 6.6, 6.6],
      [0, PM_TOP + 12.2, 0, 1.1, 1.1, 1.1],
    ]
    fillBoxes(pmBeacon, specs)
  })()
  _c.setHex(COLOR.postmaster)
  for (let i = 0; i < 3; i++) pmBeacon.setColorAt(i, _c)
  pmBeacon.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  pm.add(pmBeacon)

  // Fork pulses: a ring runs *down* the tower each time a backend is forked.
  const ringGeo = own(new THREE.TorusGeometry(1, 0.055, 6, 28))
  const pmRings = new THREE.InstancedMesh(ringGeo, neonWhite, RING_SLOTS)
  pmRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  pmRings.frustumCulled = false
  _c.setRGB(0, 0, 0)
  _p.set(0, -1000, 0)
  _q.identity()
  _sc.set(0.001, 0.001, 0.001)
  _m.compose(_p, _q, _sc)
  for (let i = 0; i < RING_SLOTS; i++) {
    pmRings.setMatrixAt(i, _m)
    pmRings.setColorAt(i, _c)
  }
  pmRings.instanceMatrix.needsUpdate = true
  pmRings.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  pm.add(pmRings)
  const ringT = new Float32Array(RING_SLOTS)
  const ringOn = new Uint8Array(RING_SLOTS)

  // name plate
  const pmPlate = makePlate('postmaster', 2.0, COLOR.ink)
  pmPlate.position.set(0, 8.6, 9.0)
  pm.add(pmPlate)

  group.add(pm)

  /* =======================================================================
   * 3. CONNECTION GATE — authentication, i.e. pg_hba.conf made of concrete.
   * =====================================================================*/

  const gate = new THREE.Group()
  gate.name = 'conn.gate'
  gate.position.set(ANCHOR.connGate[0], ANCHOR.connGate[1], ANCHOR.connGate[2])
  const GY = ANCHOR.connGate[1] // local y = world y - GY

  const gateMass: BoxSpec[] = [
    [-17.5, 29 - GY, 0, 4.6, 58, 7.2], // west pylon: ground to y=58
    [17.5, 29 - GY, 0, 4.6, 58, 7.2], // east pylon
    [0, 59 - GY, 0, 44, 3.2, 7.2], // header
    [-17.5, 1.4 - GY, 0, 8.4, 2.8, 10.4], // footings
    [17.5, 1.4 - GY, 0, 8.4, 2.8, 10.4],
    [-17.5, 30 - GY, 3.9, 3.0, 9.0, 0.8], // indicator backer
    [0, 61.4 - GY, 0, 30, 1.6, 3.4], // sign beam
  ]
  const gateStruct = new THREE.InstancedMesh(unitBox, matStruct, gateMass.length)
  fillBoxes(gateStruct, gateMass)
  gate.add(gateStruct)
  for (const s of gateMass) {
    pushBoxEdges(edgeVerts, [s[0] + ANCHOR.connGate[0], s[1] + GY, s[2] + ANCHOR.connGate[2], s[3], s[4], s[5]])
  }

  // The aperture the connection particles actually fly through. conn.in passes
  // through (0, ~44, -250), so the ring is centred exactly there.
  const gateRingY = 44 - GY
  const ringOuterGeo = own(new THREE.TorusGeometry(13.4, 0.7, 8, 44))
  const gateRing = new THREE.Mesh(ringOuterGeo, matStruct)
  gateRing.position.set(0, gateRingY, 0)
  gate.add(gateRing)

  const ringInnerGeo = own(new THREE.TorusGeometry(12.5, 0.22, 6, 44))
  const gateGlow = new THREE.InstancedMesh(ringInnerGeo, neonWhite, 1)
  gateGlow.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _p.set(0, gateRingY, 0)
  _q.identity()
  _sc.set(1, 1, 1)
  _m.compose(_p, _q, _sc)
  gateGlow.setMatrixAt(0, _m)
  gateGlow.instanceMatrix.needsUpdate = true
  _c.setHex(COLOR.client)
  gateGlow.setColorAt(0, _c)
  gateGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gate.add(gateGlow)

  // pass / reject lamps — the pg_hba verdict
  const lampGeo = own(new THREE.SphereGeometry(0.9, 10, 8))
  const lamps = new THREE.InstancedMesh(lampGeo, neonWhite, 2)
  ;(() => {
    const specs: BoxSpec[] = [
      [-17.5, 32.6 - GY, 4.5, 1, 1, 1],
      [-17.5, 27.4 - GY, 4.5, 1, 1, 1],
    ]
    fillBoxes(lamps, specs)
  })()
  _c.setRGB(0, 0, 0)
  lamps.setColorAt(0, _c)
  lamps.setColorAt(1, _c)
  lamps.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gate.add(lamps)

  const gatePlate = makePlate('pg_hba.conf', 2.6, COLOR.ink)
  gatePlate.position.set(0, 61.4 - GY, 1.9)
  gate.add(gatePlate)

  group.add(gate)

  /* --- one blueprint line pass for the whole district --------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)

  /* --- text plate helper -------------------------------------------------- */
  function makePlate(text: string, height: number, color: number): THREE.Mesh {
    const tex = theme.textTexture(text, { size: 64, color: '#dbe7ff', letterSpacing: '2px' })
    const img = tex.image as { width: number; height: number }
    const aspect = img.width / Math.max(1, img.height)
    const geo = own(new THREE.PlaneGeometry(height * aspect, height))
    const mat = own(
      new THREE.MeshBasicMaterial({
        map: tex,
        color,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        toneMapped: false,
      }),
    )
    const mesh = new THREE.Mesh(geo, mat)
    mesh.raycast = () => {}
    return mesh
  }

  /* =======================================================================
   * Registration.
   * =====================================================================*/

  ctx.register({
    id: 'client.pool',
    name: 'Client pool',
    role: 'the application tier — outside the database',
    kind: 'client',
    district: 'clients',
    object: poolGroup,
    tier: 0,
    focus: { target: [ANCHOR.clientSky[0], ANCHOR.clientSky[1] + 6, ANCHOR.clientSky[2]], distance: 210, dir: [0.18, 0.42, 1] },
    labelAt: [ANCHOR.clientSky[0], ANCHOR.clientSky[1] + 30, ANCHOR.clientSky[2]],
    color: COLOR.client,
    readout: (s) => `${fmtNum(s.stats.tps)} tps · ${s.stats.activeBackends} open sessions`,
  })

  ctx.register({
    id: 'postmaster',
    name: 'Postmaster',
    role: 'the only process that never touches your data',
    kind: 'process',
    district: 'clients',
    object: pm,
    tier: 0,
    focus: { target: [0, 18, ANCHOR.postmaster[2]], distance: 96, dir: [0.35, 0.34, 1] },
    labelAt: [0, PM_TOP + 6, ANCHOR.postmaster[2]],
    color: COLOR.postmaster,
    readout: (s) => `${s.stats.activeBackends} / ${s.maxConnections} connections`,
  })

  ctx.register({
    id: 'conn.gate',
    name: 'Connection gate',
    role: 'authentication — pg_hba.conf, one verdict per connection',
    kind: 'network',
    district: 'clients',
    object: gate,
    tier: 1,
    focus: { target: [0, 42, ANCHOR.connGate[2]], distance: 86, dir: [0.3, 0.22, 1] },
    labelAt: [0, 62, ANCHOR.connGate[2]],
    color: COLOR.ok,
    readout: (s) =>
      slotsFree === 0 || s.stats.activeBackends >= s.maxConnections
        ? 'FATAL: sorry, too many clients already'
        : `${fmtNum(accepted)} accepted · ${slotsFree}/${N_BACKEND_SLOTS} slots free`,
  })

  /* =======================================================================
   * Runtime state.
   * =====================================================================*/

  let accepted = 0
  let slotsFree = N_BACKEND_SLOTS
  let prevT = -1
  let prevPulse = -1
  let beaconFlash = 0
  let gateFlash = 0
  let rejectLevel = 0
  let forkedThisFrame = false
  const prevFree = new Uint8Array(N_BACKEND_SLOTS)
  prevFree.fill(1)
  let primed = false

  function spawnRing(): void {
    for (let r = 0; r < RING_SLOTS; r++) {
      if (!ringOn[r]) {
        ringOn[r] = 1
        ringT[r] = 0
        return
      }
    }
    // all busy — recycle the oldest
    let oldest = 0
    for (let r = 1; r < RING_SLOTS; r++) if (ringT[r] > ringT[oldest]) oldest = r
    ringT[oldest] = 0
  }

  /** A connection was accepted and a backend forked into `slot` (-1 unknown). */
  function fireFork(slot: number): void {
    accepted++
    beaconFlash = 1
    gateFlash = 1
    spawnRing()
    // the connection itself arriving down the road from the client sky
    ctx.flow({ route: 'conn.in', count: 1, kind: 'fork', color: COLOR.client, size: 1.5 })
    if (slot >= 0) {
      // postmaster → new backend: the fork() itself
      ctx.flow({ route: rid.fork(slot), count: 3, kind: 'fork', color: COLOR.postmaster, stagger: 0.06 })
    }
    forkedThisFrame = true
  }

  /* =======================================================================
   * Update.
   * =====================================================================*/

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated dt: freezes when paused
    prevT = t

    /* --- fork detection: a slot leaving 'free' is a fork ------------------ */
    const nb = Math.min(N_BACKEND_SLOTS, sim.backends.length)
    let fired = false
    let free = 0
    forkedThisFrame = false
    for (let i = 0; i < nb; i++) {
      const isFree = sim.backends[i].state === 'free' ? 1 : 0
      free += isFree
      // whatever the sim starts with is not a fork — prime, then watch
      if (primed && prevFree[i] === 1 && isFree === 0) {
        fireFork(i)
        fired = true
      }
      prevFree[i] = isFree
    }
    if (prevPulse < 0) prevPulse = sim.forkPulse
    if (primed && sim.forkPulse > prevPulse + 1e-6 && !fired) {
      // the sim announced a fork we could not attribute to a slot
      let slot = -1
      for (let i = 0; i < nb; i++) if (sim.backends[i].state === 'starting') { slot = i; break }
      fireFork(slot)
    }
    prevPulse = sim.forkPulse
    primed = true
    slotsFree = free
    // one shockwave per frame however many connections landed at once
    if (forkedThisFrame) {
      ctx.bus.emit('fx:pulse', {
        at: [ANCHOR.postmasterTop[0], ANCHOR.postmasterTop[1], ANCHOR.postmasterTop[2]],
        color: COLOR.postmaster,
        radius: 18,
      })
    }

    /* --- client constellation -------------------------------------------- */
    const tps = sim.stats.tps
    const perNode = clamp(tps / nClients, 0, 7)
    for (let i = 0; i < nClients; i++) {
      cAcc[i] += dts * perNode
      while (cAcc[i] >= 1) {
        cAcc[i] -= 1
        cBlink[i] = 1
      }
      cBlink[i] = Math.max(0, cBlink[i] - dt * 3.4)

      const sp = cSpeed[i]
      const ph = cPhase[i]
      const a = cAmp[i]
      const x = cBaseX[i] + Math.sin(t * sp + ph) * a
      const y = cBaseY[i] + Math.sin(t * sp * 0.73 + ph * 1.7) * a * 0.55
      const z = cBaseZ[i] + Math.cos(t * sp * 0.88 + ph * 0.6) * a
      cX[i] = x
      cY[i] = y
      cZ[i] = z

      const s = cSize[i] * (1 + cBlink[i] * 0.45)
      _p.set(x, y, z)
      _e.set(t * 0.11 + ph, t * 0.17 + ph * 0.5, 0)
      _q.setFromEuler(_e)
      _sc.set(s, s, s)
      _m.compose(_p, _q, _sc)
      clientMesh.setMatrixAt(i, _m)

      _c.setHex(COLOR.client).multiplyScalar(0.2 + cBlink[i] * 2.8)
      clientMesh.setColorAt(i, _c)
    }
    clientMesh.instanceMatrix.needsUpdate = true
    clientMesh.instanceColor!.needsUpdate = true

    /* --- beams: sockets held open to the postmaster ----------------------- */
    const px = ANCHOR.postmasterTop[0]
    const py = ANCHOR.postmasterTop[1]
    const pz = ANCHOR.postmasterTop[2]
    for (let b = 0; b < nBeams; b++) {
      const i = (b * beamStride) % nClients
      const o = b * 6
      beamPos[o] = cX[i]
      beamPos[o + 1] = cY[i]
      beamPos[o + 2] = cZ[i]
      beamPos[o + 3] = px
      beamPos[o + 4] = py
      beamPos[o + 5] = pz
      const lit = 0.055 + cBlink[i] * 0.55
      _c.setHex(COLOR.client).multiplyScalar(lit)
      beamCol[o] = _c.r
      beamCol[o + 1] = _c.g
      beamCol[o + 2] = _c.b
      _c.multiplyScalar(0.35)
      beamCol[o + 3] = _c.r
      beamCol[o + 4] = _c.g
      beamCol[o + 5] = _c.b
    }
    beamGeo.attributes.position.needsUpdate = true
    beamGeo.attributes.color.needsUpdate = true

    /* --- postmaster ------------------------------------------------------- */
    beaconFlash = Math.max(0, beaconFlash - dt * 2.6)
    const load = clamp01(sim.stats.activeBackends / Math.max(1, sim.maxConnections))
    const breathe = 0.55 + 0.45 * Math.sin(t * 1.5)
    const beaconLevel = 0.7 + breathe * 0.5 + beaconFlash * 3.2
    _c.setHex(COLOR.postmaster).multiplyScalar(beaconLevel)
    pmBeacon.setColorAt(0, _c)
    _c.setHex(COLOR.postmaster).multiplyScalar(beaconLevel * 0.16)
    pmBeacon.setColorAt(1, _c)
    _c.setHex(COLOR.crit).multiplyScalar(0.5 + 0.5 * Math.sin(t * 2.4))
    pmBeacon.setColorAt(2, _c)
    pmBeacon.instanceColor!.needsUpdate = true

    // window slits brighten with the number of live sessions
    const slitLevel = 0.16 + load * 0.5 + beaconFlash * 0.35
    _c.setHex(COLOR.postmaster).multiplyScalar(slitLevel)
    for (let i = 0; i < pmGlowSpecs.length; i++) pmGlow.setColorAt(i, _c)
    pmGlow.instanceColor!.needsUpdate = true

    // fork rings travelling down the shaft
    let ringDirty = false
    for (let r = 0; r < RING_SLOTS; r++) {
      if (!ringOn[r]) continue
      ringT[r] += dt / RING_DUR
      if (ringT[r] >= 1) {
        ringOn[r] = 0
        ringT[r] = 0
        _c.setRGB(0, 0, 0)
        pmRings.setColorAt(r, _c)
        _p.set(0, -1000, 0)
        _q.identity()
        _sc.set(0.001, 0.001, 0.001)
        _m.compose(_p, _q, _sc)
        pmRings.setMatrixAt(r, _m)
        ringDirty = true
        continue
      }
      const k = ringT[r]
      const y = lerp(PM_TOP - 1, 1.6, k * k * (3 - 2 * k))
      const rad = lerp(5.6, 13.6, k)
      _p.set(0, y, 0)
      _e.set(-Math.PI / 2, 0, 0)
      _q.setFromEuler(_e)
      _sc.set(rad, rad, rad)
      _m.compose(_p, _q, _sc)
      pmRings.setMatrixAt(r, _m)
      _c.setHex(COLOR.postmaster).multiplyScalar(2.4 * (1 - k) * (1 - k))
      pmRings.setColorAt(r, _c)
      ringDirty = true
    }
    if (ringDirty) {
      pmRings.instanceMatrix.needsUpdate = true
      pmRings.instanceColor!.needsUpdate = true
    }

    /* --- gate ------------------------------------------------------------- */
    gateFlash = Math.max(0, gateFlash - dt * 3.2)
    // "sorry, too many clients already" — every slot taken, or max_connections hit
    const full = free === 0 || sim.stats.activeBackends >= sim.maxConnections
    rejectLevel = damp(rejectLevel, full ? 1 : 0, 6, dt)

    _c.setHex(COLOR.client).multiplyScalar(0.22 + gateFlash * 1.6)
    if (rejectLevel > 0.01) {
      _c2.setHex(COLOR.crit).multiplyScalar(0.9)
      _c.lerp(_c2, rejectLevel * 0.8)
    }
    gateGlow.setColorAt(0, _c)
    gateGlow.instanceColor!.needsUpdate = true

    _c.setHex(COLOR.ok).multiplyScalar(0.12 + gateFlash * 2.6)
    lamps.setColorAt(0, _c)
    _c.setHex(COLOR.crit).multiplyScalar(0.06 + rejectLevel * (1.6 + 0.8 * Math.sin(t * 7)))
    lamps.setColorAt(1, _c)
    lamps.instanceColor!.needsUpdate = true
  }

  function setDetail(level: 0 | 1 | 2): void {
    pmDetailMesh.visible = level >= 1
    pmCyl.visible = level >= 1
    edgeLines.visible = level >= 1
    pmPlate.visible = level >= 2
    gatePlate.visible = level >= 2
    lamps.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    clientMesh.dispose()
    pmStruct.dispose()
    pmDetailMesh.dispose()
    pmCyl.dispose()
    pmGlow.dispose()
    pmBeacon.dispose()
    pmRings.dispose()
    gateStruct.dispose()
    gateGlow.dispose()
    lamps.dispose()
  }

  return { id: 'clients', group, update, setDetail, dispose }
}
