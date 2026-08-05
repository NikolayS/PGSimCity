import * as THREE from 'three'
import { COLOR } from '../core/theme'
import { CLAIM_VALUES, ordinaryConnectionCapacity } from '../core/claims'
import { N_BACKEND_SLOTS } from '../core/types'
import type { BackendState, SimState, WorldFactory, WorldModule } from '../core/types'
import { clamp, clamp01, damp, fmtNum, lerp, makeRng } from '../core/util'
import { ANCHOR, CONDUIT, DISTRICT_BOUNDS, conduitX, rid, routeCurve } from './layout'
import { OPACITY_TIER } from './storage'
import { markTextPlane } from './text-plane'

const connectionCapacity = (s: SimState): number => ordinaryConnectionCapacity(
  s.maxConnections,
  s.superuserReservedConnections,
  s.reservedConnections,
)

/* ============================================================================
 * CLIENTS — the application tier, the server boundary, and the postmaster.
 *
 * The story of every Postgres session starts here:
 *   a client arrives at the terminal → optionally waits at the pooler → a
 *   server connection crosses the boundary and is authenticated at the gate →
 *   the postmaster fork()s a backend → a conduit opens from the terminal to
 *   that backend, and from then on the postmaster is out of the loop entirely.
 *   It is the only process in the whole city that never touches your data.
 *
 * Two things this district has to say that the rest of the city cannot:
 *
 *   1. Clients are OUTSIDE. There is a fence at z = -252 with one gate in it,
 *      and the ground treatment changes as you cross. Everything north of that
 *      line is somebody else's program.
 *
 *   2. A connection is a PERSISTENT THING — a socket, a process, a slab of
 *      memory, held for the whole session — not a series of events. So it is
 *      drawn as a duct you can walk under. Sixteen of them standing in a row is
 *      "one process per connection", legible from the far side of the city. A
 *      duct that is lit but perfectly still is idle_in_transaction, which is
 *      exactly what that state is and exactly how wrong it should look.
 *
 * The client fleet is the one place in PGSimCity where ambient motion is
 * allowed: it is outside the database, so it shuffles. It shuffles on tarmac.
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

const N = N_BACKEND_SLOTS
const RING_SLOTS = 4
const RING_DUR = 0.62
export const CONNECTION_POOLER_PLATE_LABEL = CLAIM_VALUES.connectionPooler.plateLabel

/* --- conduit tessellation ------------------------------------------------- */
/** Samples along one duct. 26 is smooth at the radius we draw. */
const TUBE_RINGS = 26
/** Sides around one duct. 8 reads as round and costs almost nothing. */
const TUBE_RADIAL = 8
/** Light bands per duct — sets how far apart the travelling glows sit. */
const TUBE_BANDS = 5
/** Where piers go, as fractions along the duct. */
const PIER_T = [0.05, 0.19, 0.33, 0.6, 0.76, 0.9] as const
/** Nothing may be planted inside the postmaster's apron. */
const PM_KEEPOUT = { x: 16, z0: -232, z1: -198 }

/* The pooler is a switchyard, not a lamp. Width carries the exact many-to-few
 * ratio; repeated paths make each modeled PostgreSQL server connection count. */
const POOLER_CLIENT_WIDTH = 24
const POOLER_CLIENT_PATHS_HIGH = 24
const POOLER_CLIENT_PATHS_LOW = 12
const POOLER_DISPLAY_DIGITS = 4
const DIGIT_SEGMENTS = 7
const DIGIT_MASK = [63, 6, 91, 79, 102, 109, 125, 7, 127, 111] as const
const RELEASE_BOUNDARIES = 3

/**
 * The duct wall.
 *
 * `position` is the duct's centre line and `normal` the outward direction, so
 * the vertex shader can collapse the radius to nothing past the growing tip —
 * that is how a conduit extends on fork and retracts on disconnect without ever
 * touching the geometry. Per-slot state arrives as a 16 x 1 float texture:
 * (extend, lit, phase, stuck).
 */
const CONDUIT_VERT = /* glsl */ `
uniform sampler2D uState;
uniform float uSlots;
uniform float uRadius;

attribute float aU;
attribute float aSlot;

varying float vU;
varying vec4 vSt;
varying vec3 vNrm;
varying vec3 vView;

#include <fog_pars_vertex>

void main() {
  vec4 st = texture2D( uState, vec2( ( aSlot + 0.5 ) / uSlots, 0.5 ) );
  float grow = 1.0 - smoothstep( st.x - 0.07, st.x, aU );
  vec3 p = position + normal * ( uRadius * grow );

  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );
  vU = aU;
  vSt = st;
  vNrm = normalize( normalMatrix * normal );
  vView = normalize( - mvPosition.xyz );
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`

const CONDUIT_FRAG = /* glsl */ `
uniform vec3 uIdle;
uniform vec3 uBusy;
uniform vec3 uStuck;
uniform float uBands;

varying float vU;
varying vec4 vSt;
varying vec3 vNrm;
varying vec3 vView;

#include <fog_pars_fragment>

void main() {
  if ( vU > vSt.x ) discard;

  float lit = vSt.y;
  float phase = vSt.z;
  float stuck = vSt.w;

  // A bright edge gives the solid duct a readable round silhouette.
  float rim = 1.0 - abs( dot( vNrm, vView ) );
  rim *= rim;

  vec3 tint = mix( mix( uIdle, uBusy, lit ), uStuck, stuck );

  // The travelling wall light marks an active socket and always runs from the
  // terminal to the backend. Coloured packets, not the wall, show the two data
  // directions; reversing this phase for results makes the duct itself appear
  // to oscillate over every statement cycle.
  float w = fract( vU * uBands - phase );
  float band = pow( 1.0 - w, 4.0 );

  // An open transaction doing nothing is lit and completely still. It must not
  // outshine a duct that is doing work: the loudest thing in the district has
  // to be traffic, not the absence of it. So the wall lands just under a busy
  // duct's, and the travelling light is all but extinguished — what is left of
  // it stops dead where it was, because the phase no longer advances. Stalled
  // bands frozen in the pipe is what idle_in_transaction actually looks like.
  float sick = stuck * 0.018;

  // Matte near-black infrastructure, lifted at the rim. The wall stays present
  // around the traffic but is translucent enough that the two coloured packet
  // streams remain legible inside their one shared socket.
  float wall = 0.11 + 0.10 * lit + sick;
  float stripe = band * ( 0.08 + 0.42 * lit ) * ( 1.0 - stuck * 0.78 );
  vec3 base = vec3( 0.014, 0.021, 0.037 ) * ( 0.72 + 0.28 * rim );
  vec3 col = base + tint * (
    wall * ( 0.35 + 0.65 * rim ) +
    stripe * ( 0.45 + 0.55 * rim )
  );
  gl_FragColor = vec4( col, 0.72 );

  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogF = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    // Night fog takes distant colour away instead of washing it grey.
    gl_FragColor.rgb *= 1.0 - fogF;
  #endif

  #include <colorspace_fragment>
}
`

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

function setInstanceBox(
  mesh: THREE.InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
): void {
  _p.set(x, y, z)
  _q.identity()
  _sc.set(w, h, d)
  _m.compose(_p, _q, _sc)
  mesh.setMatrixAt(index, _m)
}

/** A unit box stretched between two points in the horizontal plane. */
function setHorizontalBeam(
  mesh: THREE.InstancedMesh,
  index: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  y: number,
  thickness: number,
): void {
  const dx = x1 - x0
  const dz = z1 - z0
  _p.set((x0 + x1) / 2, y, (z0 + z1) / 2)
  _e.set(0, Math.atan2(dx, dz), 0)
  _q.setFromEuler(_e)
  _sc.set(thickness, thickness, Math.hypot(dx, dz))
  _m.compose(_p, _q, _sc)
  mesh.setMatrixAt(index, _m)
}

function releaseBoundaryIndex(mode: SimState['pooler']['mode']): number {
  switch (mode) {
    case 'session':
      return 0
    case 'transaction':
      return 1
    case 'statement':
      return 2
    default:
      return -1
  }
}

/** How fast the duct's terminal-to-backend wall light travels. */
function phaseRate(st: BackendState): number {
  switch (st) {
    case 'starting':
      return 1.6
    case 'parse':
    case 'plan':
      return 2.4
    case 'exec_cpu':
    case 'exec_io':
    case 'sort':
    case 'wal_insert':
      return 1.5
    case 'eviction_flush':
    case 'commit_wait':
      return 0.5
    case 'sending':
      return 2.8
    case 'ending':
      return 1.2
    case 'idle':
      return 0.05 // a held socket is not a dead one
    default:
      // idle_in_xact and blocked are lit and going nowhere. That is the point.
      return 0
  }
}

/** How brightly the duct burns. */
function litLevel(st: BackendState): number {
  switch (st) {
    case 'free':
      return 0
    case 'idle':
      return 0.1
    case 'idle_in_xact':
      return 0.72
    case 'eviction_flush':
    case 'commit_wait':
    case 'blocked':
      return 0.55
    default:
      return 1
  }
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

  const TX = ANCHOR.clientTerminal[0]
  const TZ = ANCHOR.clientTerminal[2] // -300
  // The Slonik containment audit can only protect visible paving that reads
  // its extent from the district geography it audits.
  const clientBounds = DISTRICT_BOUNDS.clients
  const forecourt = {
    x0: clientBounds.x[0],
    x1: clientBounds.x[1],
    z0: clientBounds.z[0] + 4,
    z1: ANCHOR.connGate[2],
  }

  /* =======================================================================
   * 1. THE CLIENT TERMINAL — the application tier, on the ground, outside.
   *
   * A shed either side for the connection ducts to leave from and an arrivals
   * hall in the middle for the avenue. World coordinates throughout: this
   * district's pieces have to line up with a fence and a road, not with each
   * other.
   * =====================================================================*/

  const terminal = new THREE.Group()
  terminal.name = 'client.terminal'

  const termMass: BoxSpec[] = [
    [TX, 0.5, TZ, 186, 1.0, 36], // platform slab
    [TX - 52, 5.5, TZ + 1, 68, 11, 18], // west shed
    [TX + 52, 5.5, TZ + 1, 68, 11, 18], // east shed
    [TX, 7, TZ - 2, 36, 14, 26], // arrivals hall
    [TX - 52, 11.3, TZ + 1, 71, 0.6, 20], // shed roofs
    [TX + 52, 11.3, TZ + 1, 71, 0.6, 20],
    [TX, 14.4, TZ - 2, 39, 0.8, 29], // hall roof
    [TX, 8.2, TZ + 16, 26, 0.5, 12], // entrance canopy
    [TX - 12, 4.1, TZ + 21, 0.7, 8.2, 0.7], // canopy legs
    [TX + 12, 4.1, TZ + 21, 0.7, 8.2, 0.7],
  ]
  const termStruct = new THREE.InstancedMesh(unitBox, matStruct, termMass.length)
  fillBoxes(termStruct, termMass)
  terminal.add(termStruct)
  for (const s of termMass) pushBoxEdges(edgeVerts, s)

  // Lit glazing. Dim and steady — this building is not the show.
  const termGlowSpecs: BoxSpec[] = [
    [TX, 8.6, TZ + 11.1, 30, 3.0, 0.12], // hall, south face
    [TX, 4.0, TZ + 11.1, 30, 1.4, 0.12],
    [TX - 52, 9.4, TZ - 8.06, 60, 1.0, 0.12], // shed bands, south face
    [TX + 52, 9.4, TZ - 8.06, 60, 1.0, 0.12],
    [TX - 52, 1.8, TZ - 8.06, 60, 0.7, 0.12],
    [TX + 52, 1.8, TZ - 8.06, 60, 0.7, 0.12],
  ]
  const termGlow = new THREE.InstancedMesh(unitBox, neonWhite, termGlowSpecs.length)
  fillBoxes(termGlow, termGlowSpecs)
  _c.setHex(COLOR.client).multiplyScalar(0.34)
  for (let i = 0; i < termGlowSpecs.length; i++) termGlow.setColorAt(i, _c)
  termGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  terminal.add(termGlow)

  // The forecourt. Plain tarmac laid over the city's survey grid: the ground
  // treatment changing is what tells you which side of the boundary you are on.
  const apronGeo = own(new THREE.PlaneGeometry(
    forecourt.x1 - forecourt.x0,
    forecourt.z1 - forecourt.z0,
  ))
  const apronMat = theme.mat('clients.forecourt', {
    color: 0x0a1119,
    roughness: 0.98,
    metalness: 0.02,
    emissive: 0x020408,
    opacity: OPACITY_TIER.solid,
    // The forecourt is a large paint layer over the city plate. Six physical
    // centimetres alone are not enough depth separation in the far view.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
  const apron = new THREE.Mesh(apronGeo, apronMat)
  apron.name = 'client.forecourt'
  apron.rotation.x = -Math.PI / 2
  apron.position.set(
    (forecourt.x0 + forecourt.x1) / 2,
    0.06,
    (forecourt.z0 + forecourt.z1) / 2,
  )
  apron.renderOrder = -4
  apron.raycast = () => {}
  terminal.add(apron)

  // Bay markings, so the forecourt reads as a place things park.
  const bayVerts: number[] = []
  for (let r = 0; r < 3; r++) {
    const z = -352 + r * 11
    bayVerts.push(-104, 0.09, z, 104, 0.09, z)
  }
  bayVerts.push(forecourt.x0, 0.09, forecourt.z0, forecourt.x1, 0.09, forecourt.z0)
  const bayGeo = own(new THREE.BufferGeometry())
  bayGeo.setAttribute('position', new THREE.Float32BufferAttribute(bayVerts, 3))
  const bayLines = new THREE.LineSegments(bayGeo, theme.line(COLOR.inkDim, 0.1))
  bayLines.raycast = () => {}
  terminal.add(bayLines)

  group.add(terminal)

  /* --- the client fleet, parked on the forecourt -------------------------- */

  const nClients = ctx.quality.level === 'low' ? 27 : 42
  const poolGroup = new THREE.Group()
  poolGroup.name = 'client.pool'

  const cRng = makeRng(0xc0ffee)
  const cBaseX = new Float32Array(nClients)
  const cBaseZ = new Float32Array(nClients)
  const cPhase = new Float32Array(nClients)
  const cSpeed = new Float32Array(nClients)
  const cAmp = new Float32Array(nClients)
  const cSize = new Float32Array(nClients)
  const cBlink = new Float32Array(nClients) // 0..1, decays
  const cAcc = new Float32Array(nClients) // statement accumulator

  const cols = Math.ceil(nClients / 3)
  const colStep = 200 / Math.max(1, cols - 1)
  for (let i = 0; i < nClients; i++) {
    const row = i % 3
    const col = Math.floor(i / 3)
    cBaseX[i] = -100 + col * colStep + (cRng() - 0.5) * 2.2
    cBaseZ[i] = -347 + row * 11 + (cRng() - 0.5) * 1.4
    cPhase[i] = cRng() * Math.PI * 2
    cSpeed[i] = 0.09 + cRng() * 0.14
    cAmp[i] = 0.5 + cRng() * 1.1
    cSize[i] = 0.86 + cRng() * 0.3
    cAcc[i] = cRng()
  }

  // Chassis: dark, matte, never glows. Only the lamp carries state.
  const podStruct = new THREE.InstancedMesh(unitBox, matDeep, nClients)
  podStruct.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  podStruct.frustumCulled = false
  poolGroup.add(podStruct)

  const podLamp = new THREE.InstancedMesh(unitBox, neonWhite, nClients)
  podLamp.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  podLamp.frustumCulled = false
  podLamp.raycast = () => {}
  _c.setHex(COLOR.client)
  for (let i = 0; i < nClients; i++) podLamp.setColorAt(i, _c)
  podLamp.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolGroup.add(podLamp)

  group.add(poolGroup)

  /* --- PgBouncer: a server-concurrency gate, not a PostgreSQL process. --- */
  const PB = ANCHOR.pooler
  const poolerGroup = new THREE.Group()
  poolerGroup.name = 'client.pooler'
  const poolerMass: BoxSpec[] = [
    [PB[0] - 17, 6, PB[2], 2.2, 12, 2.2],
    [PB[0] + 17, 6, PB[2], 2.2, 12, 2.2],
    [PB[0], 12.4, PB[2], 36.2, 2.2, 2.2],
    [PB[0] - 9.2, 16.1, PB[2], 16.5, 5.2, 0.8],
    [PB[0] + 9.2, 16.1, PB[2], 16.5, 5.2, 0.8],
    [PB[0], 20.1, PB[2], 39, 2.4, 0.8],
  ]
  const poolerStruct = new THREE.InstancedMesh(unitBox, matStruct, poolerMass.length)
  fillBoxes(poolerStruct, poolerMass)
  poolerGroup.add(poolerStruct)
  for (const spec of poolerMass) pushBoxEdges(edgeVerts, spec)

  const poolerGlowSpecs: BoxSpec[] = []
  for (let i = 0; i < 12; i++) {
    poolerGlowSpecs.push([PB[0] - 13.2 + i * 2.4, 11.1, PB[2] + 1.15, 0.9, 0.9, 0.16])
  }
  const poolerGlow = new THREE.InstancedMesh(unitBox, neonWhite, poolerGlowSpecs.length)
  fillBoxes(poolerGlow, poolerGlowSpecs)
  _c.setHex(COLOR.client).multiplyScalar(0.12)
  for (let i = 0; i < poolerGlowSpecs.length; i++) poolerGlow.setColorAt(i, _c)
  poolerGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerGlow)

  /* Exact aggregate widths. The north bar is all admitted clients; the south
   * bar is their currently open PostgreSQL server connections. */
  const poolerClientBand = new THREE.InstancedMesh(unitBox, neonWhite, 1)
  poolerClientBand.name = 'pooler.client-band'
  poolerClientBand.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  poolerClientBand.frustumCulled = false
  poolerClientBand.raycast = () => {}
  setInstanceBox(poolerClientBand, 0, PB[0], 9.25, PB[2] - 1.05, POOLER_CLIENT_WIDTH, 0.62, 0.5)
  _c.setHex(COLOR.client)
  poolerClientBand.setColorAt(0, _c)
  poolerClientBand.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerClientBand)

  const poolerServerBand = new THREE.InstancedMesh(unitBox, neonWhite, 1)
  poolerServerBand.name = 'pooler.server-band'
  poolerServerBand.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  poolerServerBand.frustumCulled = false
  poolerServerBand.raycast = () => {}
  setInstanceBox(poolerServerBand, 0, PB[0], 9.25, PB[2] + 1.05, POOLER_CLIENT_WIDTH, 0.62, 0.5)
  _c.setHex(COLOR.backend)
  poolerServerBand.setColorAt(0, _c)
  poolerServerBand.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerServerBand)

  const poolerFunnel = new THREE.InstancedMesh(unitBox, neonWhite, 2)
  poolerFunnel.name = 'pooler.funnel-rails'
  poolerFunnel.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  poolerFunnel.frustumCulled = false
  poolerFunnel.raycast = () => {}
  _c.setHex(COLOR.client)
  poolerFunnel.setColorAt(0, _c)
  poolerFunnel.setColorAt(1, _c)
  poolerFunnel.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerFunnel)

  /* A bounded representative sample on the client side; the four-digit
   * display and exact-width band retain the real value beyond this sample. */
  const nPoolClientPaths = ctx.quality.level === 'low' || ctx.quality.level === 'reduced'
    ? POOLER_CLIENT_PATHS_LOW
    : POOLER_CLIENT_PATHS_HIGH
  const clientPathSpecs: BoxSpec[] = []
  const clientPathCols = nPoolClientPaths === POOLER_CLIENT_PATHS_LOW ? 6 : 8
  const clientPathRows = Math.ceil(nPoolClientPaths / clientPathCols)
  for (let i = 0; i < nPoolClientPaths; i++) {
    const col = i % clientPathCols
    const row = Math.floor(i / clientPathCols)
    const x = clientPathCols > 1 ? -11.5 + col * 23 / (clientPathCols - 1) : 0
    const y = 4.5 + row * (clientPathRows > 2 ? 1.9 : 2.5)
    clientPathSpecs.push([PB[0] + x, y, PB[2] - 2.45, 0.28, 0.28, 2.9])
  }
  const poolerClientPaths = new THREE.InstancedMesh(unitBox, neonWhite, nPoolClientPaths)
  poolerClientPaths.name = 'pooler.client-paths'
  fillBoxes(poolerClientPaths, clientPathSpecs)
  poolerClientPaths.frustumCulled = false
  poolerClientPaths.raycast = () => {}
  _c.setHex(COLOR.client).multiplyScalar(1.8)
  for (let i = 0; i < nPoolClientPaths; i++) poolerClientPaths.setColorAt(i, _c)
  poolerClientPaths.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerClientPaths)

  /* Each live PostgreSQL connection owns the same number of segments. `count`
   * therefore remains a scene-derived exact server-connection count. */
  const serverPathSegments = ctx.quality.level === 'low' || ctx.quality.level === 'reduced' ? 2 : 4
  const poolerServerPaths = new THREE.InstancedMesh(unitBox, neonWhite, N * serverPathSegments)
  poolerServerPaths.name = 'pooler.server-paths'
  poolerServerPaths.userData.segmentsPerConnection = serverPathSegments
  poolerServerPaths.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  poolerServerPaths.frustumCulled = false
  poolerServerPaths.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < N * serverPathSegments; i++) {
    setInstanceBox(poolerServerPaths, i, PB[0], -1000, PB[2], 0.001, 0.001, 0.001)
    poolerServerPaths.setColorAt(i, _c)
  }
  poolerServerPaths.instanceMatrix.needsUpdate = true
  poolerServerPaths.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerServerPaths)

  /* Direct mode is not a dim PgBouncer. One straight luminous run per open
   * backend visibly bypasses the switchyard and preserves the 1:1 mapping. */
  const directSpecs: BoxSpec[] = []
  const directStartZ = ANCHOR.endpoint[2] + 8
  const directEndZ = CONDUIT.boundaryZ - 1
  for (let i = 0; i < N; i++) {
    const col = i % 8
    const row = Math.floor(i / 8)
    directSpecs.push([
      PB[0] - 12 + col * 24 / 7,
      5.1 + row * 2.6,
      (directStartZ + directEndZ) / 2,
      0.34,
      0.34,
      directEndZ - directStartZ,
    ])
  }
  const poolerDirectPaths = new THREE.InstancedMesh(unitBox, neonWhite, N)
  poolerDirectPaths.name = 'pooler.direct-paths'
  fillBoxes(poolerDirectPaths, directSpecs)
  poolerDirectPaths.frustumCulled = false
  poolerDirectPaths.raycast = () => {}
  _c.setHex(COLOR.client).multiplyScalar(1.8)
  for (let i = 0; i < N; i++) poolerDirectPaths.setColorAt(i, _c)
  poolerDirectPaths.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerDirectPaths)

  const releaseMarkerSpecs: BoxSpec[] = []
  for (let i = 0; i < RELEASE_BOUNDARIES; i++) {
    releaseMarkerSpecs.push([PB[0] - 10 + i * 10, 10.8, PB[2] + 1.5, 1.15, 2.5, 0.22])
  }
  const poolerReleaseMarkers = new THREE.InstancedMesh(unitBox, neonWhite, RELEASE_BOUNDARIES)
  poolerReleaseMarkers.name = 'pooler.release-markers'
  fillBoxes(poolerReleaseMarkers, releaseMarkerSpecs)
  poolerReleaseMarkers.raycast = () => {}
  _c.setHex(COLOR.inkDim).multiplyScalar(0.08)
  for (let i = 0; i < RELEASE_BOUNDARIES; i++) poolerReleaseMarkers.setColorAt(i, _c)
  poolerReleaseMarkers.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerReleaseMarkers)

  function countDigitSpecs(centerX: number): BoxSpec[] {
    const specs: BoxSpec[] = []
    for (let digit = 0; digit < POOLER_DISPLAY_DIGITS; digit++) {
      const x = centerX - 3.12 + digit * 2.08
      const y = 16.15
      const z = PB[2] + 0.52
      specs.push(
        [x, y + 1.34, z, 1.35, 0.24, 0.16],
        [x + 0.72, y + 0.67, z, 0.24, 1.15, 0.16],
        [x + 0.72, y - 0.67, z, 0.24, 1.15, 0.16],
        [x, y - 1.34, z, 1.35, 0.24, 0.16],
        [x - 0.72, y - 0.67, z, 0.24, 1.15, 0.16],
        [x - 0.72, y + 0.67, z, 0.24, 1.15, 0.16],
        [x, y, z, 1.35, 0.24, 0.16],
      )
    }
    return specs
  }

  const clientDigitSpecs = countDigitSpecs(PB[0] - 9.2)
  const poolerClientDigits = new THREE.InstancedMesh(unitBox, neonWhite, clientDigitSpecs.length)
  poolerClientDigits.name = 'pooler.client-count'
  fillBoxes(poolerClientDigits, clientDigitSpecs)
  poolerClientDigits.raycast = () => {}
  _c.setRGB(0, 0, 0)
  for (let i = 0; i < clientDigitSpecs.length; i++) poolerClientDigits.setColorAt(i, _c)
  poolerClientDigits.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerClientDigits)

  const serverDigitSpecs = countDigitSpecs(PB[0] + 9.2)
  const poolerServerDigits = new THREE.InstancedMesh(unitBox, neonWhite, serverDigitSpecs.length)
  poolerServerDigits.name = 'pooler.server-count'
  fillBoxes(poolerServerDigits, serverDigitSpecs)
  poolerServerDigits.raycast = () => {}
  for (let i = 0; i < serverDigitSpecs.length; i++) poolerServerDigits.setColorAt(i, _c)
  poolerServerDigits.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  poolerGroup.add(poolerServerDigits)

  const poolerPlate = makePlate(CONNECTION_POOLER_PLATE_LABEL, 1.9, 0xffffff)
  poolerPlate.position.set(PB[0], 20.2, PB[2] + 0.5)
  const poolerPlateMaterial = poolerPlate.material as THREE.MeshBasicMaterial
  poolerPlateMaterial.color.setHex(0xffffff)
  poolerPlateMaterial.side = THREE.FrontSide
  poolerPlateMaterial.depthTest = false
  poolerPlateMaterial.depthWrite = false
  poolerPlateMaterial.needsUpdate = true
  poolerPlate.renderOrder = 4
  poolerGroup.add(poolerPlate)

  const clientCountPlate = makePlate('CLIENTS', 1.0, 0xffffff)
  clientCountPlate.position.set(PB[0] - 9.2, 13.75, PB[2] + 0.54)
  clientCountPlate.renderOrder = 4
  poolerGroup.add(clientCountPlate)
  const serverCountPlate = makePlate('BACKENDS', 1.0, 0xffffff)
  serverCountPlate.position.set(PB[0] + 9.2, 13.75, PB[2] + 0.54)
  serverCountPlate.renderOrder = 4
  poolerGroup.add(serverCountPlate)
  const countArrowPlate = makePlate('→', 1.2, COLOR.ink)
  countArrowPlate.position.set(PB[0], 16.15, PB[2] + 0.56)
  countArrowPlate.renderOrder = 4
  poolerGroup.add(countArrowPlate)

  const poolModePlates = [
    makePlate('DIRECT · 1:1 BYPASS', 1.35, 0xffffff),
    makePlate('SESSION · RELEASE: DISCONNECT', 1.35, 0xffffff),
    makePlate('TRANSACTION · RELEASE: COMMIT', 1.35, 0xffffff),
    makePlate('STATEMENT · RELEASE: STATEMENT', 1.35, 0xffffff),
  ]
  for (let i = 0; i < poolModePlates.length; i++) {
    const plate = poolModePlates[i]
    plate.name = `pooler.mode.${i}`
    plate.position.set(PB[0], 19.0, PB[2] + 0.58)
    const material = plate.material as THREE.MeshBasicMaterial
    material.depthTest = false
    material.depthWrite = false
    material.needsUpdate = true
    plate.renderOrder = 4
    plate.visible = i === 0
    poolerGroup.add(plate)
  }
  group.add(poolerGroup)

  /* =======================================================================
   * 2. THE SERVER BOUNDARY — a fence, and one gate in it.
   *
   * Every canonical Postgres diagram draws this line and the city did not have
   * it: clients were rendered as a district of the database. They are not. They
   * are on the far side of a fence, and they get in through pg_hba.conf.
   * =====================================================================*/

  const gate = new THREE.Group()
  gate.name = 'conn.gate'
  gate.position.set(ANCHOR.connGate[0], ANCHOR.connGate[1], ANCHOR.connGate[2])
  const GZ = ANCHOR.connGate[2] // local z = world z - GZ

  const gateMass: BoxSpec[] = [
    [-9, 5, 0, 3.6, 10, 5.2], // west pylon
    [9, 5, 0, 3.6, 10, 5.2], // east pylon
    [0, 11, 0, 23.6, 2.0, 5.2], // header
    [0, 12.9, 0, 19, 1.4, 2.6], // sign beam
    [-9, 0.5, 0, 6.4, 1.0, 7.4], // footings
    [9, 0.5, 0, 6.4, 1.0, 7.4],
    [-11.2, 6.2, 2.7, 1.8, 5.4, 0.6], // verdict lamp backer
  ]
  // Fence: posts and a low wall running out to either side, with the gate as
  // the only opening. Skipped where the ducts cross — they get their own bay.
  for (let x = -150; x <= 150; x += 12) {
    if (Math.abs(x) < 13) continue
    gateMass.push([x, 2.3, 0, 0.7, 4.6, 0.7])
    if (x < 144) gateMass.push([x + 6, 0.6, 0, 11.4, 1.2, 0.8])
  }
  const gateStruct = new THREE.InstancedMesh(unitBox, matStruct, gateMass.length)
  fillBoxes(gateStruct, gateMass)
  gate.userData.collisionBoxes = gateMass.map(
    ([x, y, z, sx, sy, sz]) =>
      new THREE.Box3(
        new THREE.Vector3(
          x + gate.position.x - sx / 2,
          y + gate.position.y - sy / 2,
          z + gate.position.z - sz / 2,
        ),
        new THREE.Vector3(
          x + gate.position.x + sx / 2,
          y + gate.position.y + sy / 2,
          z + gate.position.z + sz / 2,
        ),
      ),
  )
  gate.add(gateStruct)
  for (const s of gateMass) pushBoxEdges(edgeVerts, [s[0], s[1], s[2] + GZ, s[3], s[4], s[5]])

  // Lit elements: a threshold across the road, an illuminated portal, and the
  // top rail of the fence running off into the dark on both sides.
  const gateGlowSpecs: BoxSpec[] = [
    [0, 0.09, 0, 15, 0.18, 1.8], // threshold on the tarmac
    [-7.05, 5.2, 0, 0.16, 8.2, 0.7], // portal jambs
    [7.05, 5.2, 0, 0.16, 8.2, 0.7],
    [0, 9.4, 0, 14.3, 0.16, 0.7], // lintel
    [-81, 4.55, 0, 138, 0.14, 0.26], // fence rail, west
    [81, 4.55, 0, 138, 0.14, 0.26], // fence rail, east
  ]
  const gateGlow = new THREE.InstancedMesh(unitBox, neonWhite, gateGlowSpecs.length)
  fillBoxes(gateGlow, gateGlowSpecs)
  _c.setHex(COLOR.client).multiplyScalar(0.22)
  for (let i = 0; i < gateGlowSpecs.length; i++) gateGlow.setColorAt(i, _c)
  gateGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gate.add(gateGlow)

  // pass / reject lamps — the pg_hba verdict
  const lampGeo = own(new THREE.SphereGeometry(0.72, 10, 8))
  const lamps = new THREE.InstancedMesh(lampGeo, neonWhite, 2)
  fillBoxes(lamps, [
    [-11.2, 7.6, 3.1, 1, 1, 1],
    [-11.2, 4.9, 3.1, 1, 1, 1],
  ])
  _c.setRGB(0, 0, 0)
  lamps.setColorAt(0, _c)
  lamps.setColorAt(1, _c)
  lamps.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  gate.add(lamps)

  const gatePlate = makePlate('pg_hba.conf', 1.9, COLOR.ink)
  gatePlate.position.set(0, 12.9, 1.5)
  gate.add(gatePlate)

  const boundPlate = makePlate('postgresql server', 2.1, COLOR.inkDim)
  boundPlate.position.set(-48, 6.6, 0.7)
  gate.add(boundPlate)

  group.add(gate)

  /* =======================================================================
   * 3. THE POSTMASTER — the gatehouse tower.
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
    // Tier 3 is the hollow control room built by world/control-center.ts.
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
    // the doorway every connection walks through, facing the gate
    [0, 3.2, -10.6, 5.2, 5.6, 0.9],
    [-3.1, 3.2, -10.6, 1.2, 5.6, 1.1],
    [3.1, 3.2, -10.6, 1.2, 5.6, 1.1],
    // the south door the fork leaves by
    [0, 3.2, 10.6, 5.2, 5.6, 0.9],
    // sign backer
    [0, 8.6, 8.7, 11.5, 2.4, 0.5],
  ]
  const pmStruct = new THREE.InstancedMesh(unitBox, matStruct, pmMass.length)
  fillBoxes(pmStruct, pmMass)
  const pmDetailMesh = new THREE.InstancedMesh(unitBox, matDeep, pmDetail.length)
  fillBoxes(pmDetailMesh, pmDetail)
  pm.add(pmStruct, pmDetailMesh)
  for (const s of pmMass) {
    pushBoxEdges(edgeVerts, [s[0], s[1] + ANCHOR.postmaster[1], s[2] + ANCHOR.postmaster[2], s[3], s[4], s[5]])
  }

  // lantern + mast (cylinders)
  const pmCyl = new THREE.InstancedMesh(unitCyl, matStruct, 3)
  fillBoxes(pmCyl, [
    [0, 33.4, 0, 11.6, 1.6, 11.6], // lantern floor
    [0, PM_TOP + 1.4, 0, 8.4, 3.2, 8.4], // lantern housing
    [0, PM_TOP + 5.2, 0, 0.5, 4.6, 0.5], // mast
  ])
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
  ]
  const pmGlow = new THREE.InstancedMesh(unitBox, neonWhite, pmGlowSpecs.length)
  fillBoxes(pmGlow, pmGlowSpecs)
  _c.setHex(COLOR.postmaster)
  for (let i = 0; i < pmGlowSpecs.length; i++) pmGlow.setColorAt(i, _c)
  pmGlow.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  pm.add(pmGlow)

  // One solid neon core. The housing and mast supply its silhouette; a halo
  // would fog the roof and whatever district happens to sit behind it.
  const sphereGeo = own(new THREE.SphereGeometry(1, 12, 8))
  const pmBeacon = new THREE.InstancedMesh(sphereGeo, neonWhite, 1)
  fillBoxes(pmBeacon, [
    [0, PM_TOP, 0, 3.2, 3.2, 3.2],
  ])
  _c.setHex(COLOR.postmaster)
  pmBeacon.setColorAt(0, _c)
  pmBeacon.instanceColor!.setUsage(THREE.DynamicDrawUsage)
  pm.add(pmBeacon)

  // Fork pulses: a ring runs *down* the tower each time a backend is forked.
  const ringGeo = own(new THREE.TorusGeometry(1, 0.055, 6, 28))
  const pmRings = new THREE.InstancedMesh(ringGeo, neonWhite, RING_SLOTS)
  pmRings.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  pmRings.frustumCulled = false
  pmRings.raycast = () => {}
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

  const pmPlate = makePlate('postmaster', 2.0, COLOR.ink)
  pmPlate.position.set(0, 8.6, 9.0)
  pm.add(pmPlate)

  group.add(pm)

  /* =======================================================================
   * 4. THE CONNECTION CONDUITS.
   *
   * One duct per live backend, running dead flat from the terminal wall to the
   * backend flank on piers. The whole bank is a single draw call: 16 ducts in
   * one merged geometry, with a per-vertex slot index and a 16 x 1 state
   * texture doing all the work in the shader.
   * =====================================================================*/

  const conduits = new THREE.Group()
  conduits.name = 'conn.conduits'

  const ringCount = TUBE_RINGS * TUBE_RADIAL
  const vertCount = N * ringCount
  const tubePos = new Float32Array(vertCount * 3)
  const tubeNrm = new Float32Array(vertCount * 3)
  const tubeU = new Float32Array(vertCount)
  const tubeSlot = new Float32Array(vertCount)
  const tubeIdx = new Uint16Array(N * (TUBE_RINGS - 1) * TUBE_RADIAL * 6)

  // Pier placement rides the same curves, so a pier is always under its duct.
  const pierSpecs: BoxSpec[] = []
  const pierH = CONDUIT.y - CONDUIT.radius

  let ii = 0
  for (let i = 0; i < N; i++) {
    const curve = routeCurve(rid.query(i))
    if (!curve) continue
    const frames = curve.computeFrenetFrames(TUBE_RINGS - 1, false)
    const base = i * ringCount

    for (let j = 0; j < TUBE_RINGS; j++) {
      const u = j / (TUBE_RINGS - 1)
      curve.getPointAt(u, _p)
      const nrm = frames.normals[j]
      const bin = frames.binormals[j]
      for (let k = 0; k < TUBE_RADIAL; k++) {
        const a = (k / TUBE_RADIAL) * Math.PI * 2
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const v = base + j * TUBE_RADIAL + k
        tubePos[v * 3] = _p.x
        tubePos[v * 3 + 1] = _p.y
        tubePos[v * 3 + 2] = _p.z
        tubeNrm[v * 3] = nrm.x * ca + bin.x * sa
        tubeNrm[v * 3 + 1] = nrm.y * ca + bin.y * sa
        tubeNrm[v * 3 + 2] = nrm.z * ca + bin.z * sa
        tubeU[v] = u
        tubeSlot[v] = i
      }
    }
    for (let j = 0; j < TUBE_RINGS - 1; j++) {
      for (let k = 0; k < TUBE_RADIAL; k++) {
        const a0 = base + j * TUBE_RADIAL + k
        const a1 = base + j * TUBE_RADIAL + ((k + 1) % TUBE_RADIAL)
        const b0 = a0 + TUBE_RADIAL
        const b1 = a1 + TUBE_RADIAL
        tubeIdx[ii++] = a0
        tubeIdx[ii++] = a1
        tubeIdx[ii++] = b1
        tubeIdx[ii++] = a0
        tubeIdx[ii++] = b1
        tubeIdx[ii++] = b0
      }
    }

    for (let s = 0; s < PIER_T.length; s++) {
      curve.getPointAt(PIER_T[s], _p)
      const inKeepout =
        Math.abs(_p.x) < PM_KEEPOUT.x && _p.z > PM_KEEPOUT.z0 && _p.z < PM_KEEPOUT.z1
      if (inKeepout) continue
      pierSpecs.push([_p.x, pierH / 2, _p.z, 1.4, pierH, 1.4])
      pierSpecs.push([_p.x, pierH + 0.35, _p.z, 3.4, 0.7, 1.8]) // pier head
    }
  }
  // Tie beams where the ducts leave the terminal parallel: a pipe rack, held.
  const bankMid = (CONDUIT.bankInner + CONDUIT.bankOuter) / 2
  const bankSpan = CONDUIT.bankOuter - CONDUIT.bankInner + 6
  for (const z of [-268, CONDUIT.boundaryZ]) {
    pierSpecs.push([-bankMid, pierH + 0.35, z, bankSpan, 0.7, 1.0])
    pierSpecs.push([bankMid, pierH + 0.35, z, bankSpan, 0.7, 1.0])
  }

  const tubeGeo = own(new THREE.BufferGeometry())
  tubeGeo.setAttribute('position', new THREE.BufferAttribute(tubePos, 3))
  tubeGeo.setAttribute('normal', new THREE.BufferAttribute(tubeNrm, 3))
  tubeGeo.setAttribute('aU', new THREE.BufferAttribute(tubeU, 1))
  tubeGeo.setAttribute('aSlot', new THREE.BufferAttribute(tubeSlot, 1))
  tubeGeo.setIndex(new THREE.BufferAttribute(tubeIdx, 1))
  tubeGeo.computeBoundingSphere()
  if (tubeGeo.boundingSphere) tubeGeo.boundingSphere.radius += CONDUIT.radius

  const stateArr = new Float32Array(N * 4)
  const stateTex = own(new THREE.DataTexture(stateArr, N, 1, THREE.RGBAFormat, THREE.FloatType))
  stateTex.minFilter = THREE.NearestFilter
  stateTex.magFilter = THREE.NearestFilter
  stateTex.generateMipmaps = false
  stateTex.needsUpdate = true

  const tubeUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uSlots: { value: N },
      uRadius: { value: CONDUIT.radius },
      uBands: { value: TUBE_BANDS },
      uIdle: { value: new THREE.Color(COLOR.client) },
      uBusy: { value: new THREE.Color(COLOR.backend) },
      uStuck: { value: new THREE.Color(COLOR.warn) },
    },
  ])
  // Assigned after the merge: UniformsUtils clones, and a texture should not be.
  tubeUniforms.uState = { value: stateTex }

  const tubeMat = own(
    new THREE.ShaderMaterial({
      uniforms: tubeUniforms,
      vertexShader: CONDUIT_VERT,
      fragmentShader: CONDUIT_FRAG,
      depthWrite: true,
      transparent: true,
      side: THREE.FrontSide,
      fog: true,
    }),
  )
  tubeMat.name = 'clients:conduit'

  const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat)
  tubeMesh.name = 'conn.conduit.tubes'
  // The vertex shader moves every vertex off the spine; a raycast against the
  // stored positions would hit the centre line, which is not where the wall is.
  tubeMesh.raycast = () => {}
  tubeMesh.renderOrder = 3
  conduits.add(tubeMesh)

  const piers = new THREE.InstancedMesh(unitBox, matStruct, pierSpecs.length)
  piers.name = 'conn.conduit.piers'
  fillBoxes(piers, pierSpecs)
  piers.raycast = () => {}
  conduits.add(piers)
  // The piers are what make a duct read as carried rather than floating, so
  // they get blueprint edges like every other structure in the district.
  for (const s of pierSpecs) pushBoxEdges(edgeVerts, s)

  // The manifold: sixteen duct mouths in the terminal wall. This is the
  // pickable body of the component — a wall you can point at, rather than a
  // 150-metre bounding box that would pave the whole northern approach.
  const manifoldSpecs: BoxSpec[] = []
  for (let i = 0; i < N; i++) {
    manifoldSpecs.push([conduitX(i), CONDUIT.y, CONDUIT.terminalFace + 0.6, 3.6, 3.6, 2.0])
  }
  const manifold = new THREE.InstancedMesh(unitBox, matStruct, manifoldSpecs.length)
  fillBoxes(manifold, manifoldSpecs)
  for (const s of manifoldSpecs) pushBoxEdges(edgeVerts, s)
  const manifoldGroup = new THREE.Group()
  manifoldGroup.name = 'conn.manifold'
  manifoldGroup.add(manifold)
  conduits.add(manifoldGroup)

  group.add(conduits)
  group.userData.collisionBoxes = [...termMass, ...poolerMass, ...pierSpecs].map(
    ([x, y, z, sx, sy, sz]) =>
      new THREE.Box3(
        new THREE.Vector3(x - sx / 2, y - sy / 2, z - sz / 2),
        new THREE.Vector3(x + sx / 2, y + sy / 2, z + sz / 2),
      ),
  )

  const termPlate = makePlate('client applications', 2.2, COLOR.inkDim)
  termPlate.position.set(TX, 11.4, TZ + 11.2)
  terminal.add(termPlate)

  /* --- one blueprint line pass for the whole district --------------------- */
  const edgeGeo = own(new THREE.BufferGeometry())
  edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgeVerts, 3))
  const edgeLines = new THREE.LineSegments(edgeGeo, lineInk)
  edgeLines.raycast = () => {}
  edgeLines.renderOrder = 2
  group.add(edgeLines)

  /* --- text plate helper -------------------------------------------------- */
  function makePlate(text: string, height: number, color: number): THREE.Mesh {
    const tex = theme.textTexture(text, {
      size: 64,
      // Literal white is reserved for text mounted on the pooler's dark count
      // boards; neutral extremes remain white in both theme translations.
      color: color === 0xffffff ? '#ffffff' : '#dbe7ff',
      letterSpacing: '2px',
    })
    const img = tex.image as { width: number; height: number }
    const aspect = img.width / Math.max(1, img.height)
    const geo = own(new THREE.PlaneGeometry(height * aspect, height))
    const mat = own(
      new THREE.MeshBasicMaterial({
        map: tex,
        color,
        // The texture's alpha cuts out glyphs; the plate itself stays solid.
        alphaTest: 0.08,
        toneMapped: false,
      }),
    )
    const mesh = new THREE.Mesh(geo, mat)
    mesh.raycast = () => {}
    markTextPlane(mesh, text)
    return mesh
  }

  /* =======================================================================
   * Registration.
   * =====================================================================*/

  ctx.register({
    id: 'client.pooler',
    name: 'PgBouncer pooler',
    role: 'client admission and PostgreSQL concurrency limit',
    kind: 'client',
    district: 'clients',
    object: poolerGroup,
    tier: 0,
    focus: { target: [PB[0], 10, PB[2]], distance: 60, dir: [0.72, 0.44, 0.7] },
    labelAt: [PB[0], 23, PB[2]],
    color: COLOR.client,
    readout: (s) => `${s.pooler.mode === 'disabled' ? 'direct · ' : ''}`
      + `${s.pooler.acceptedClients} clients → ${s.pooler.serverConnections}/${s.pooler.serverCapacity} PostgreSQL backends`,
  })

  ctx.register({
    id: 'client.pool',
    name: 'Client pool',
    role: 'the application tier — outside the database',
    kind: 'client',
    district: 'clients',
    object: poolGroup,
    tier: 0,
    focus: { target: [TX, 6, TZ - 6], distance: 132, dir: [0.12, 0.36, 1] },
    labelAt: [TX, 18, TZ + 6],
    color: COLOR.client,
    readout: (s) => `${fmtNum(s.stats.tps)} tps · ${s.stats.activeBackends} open sessions`,
  })

  ctx.register({
    id: 'conn.conduits',
    name: 'Connections',
    role: 'one modeled slot per duct · socket and process costs are absent',
    kind: 'network',
    district: 'clients',
    object: manifoldGroup,
    tier: 1,
    focus: { target: [0, 8, -228], distance: 168, dir: [0.52, 0.30, 0.80] },
    labelAt: [0, 16, -262],
    color: COLOR.client,
    readout: (s) => {
      let idleXact = 0
      for (const b of s.backends) if (b.state === 'idle_in_xact') idleXact++
      const open = s.stats.activeBackends
      return idleXact > 0
        ? `${open} open · ${idleXact} idle in transaction`
        : `${open} / ${connectionCapacity(s)} open`
    },
  })

  ctx.register({
    id: 'postmaster',
    name: 'Postmaster',
    role: 'PostgreSQL supervisor metaphor · model tracks admission only',
    kind: 'process',
    district: 'clients',
    object: pm,
    tier: 0,
    focus: { target: [0, 18, ANCHOR.postmaster[2]], distance: 96, dir: [0.35, 0.34, 1] },
    labelAt: [0, PM_TOP + 6, ANCHOR.postmaster[2]],
    color: COLOR.postmaster,
    readout: (s) => `${s.stats.activeBackends} / ${connectionCapacity(s)} connections`,
  })

  ctx.register({
    id: 'conn.gate',
    name: 'Connection gate',
    role: 'fixed slot-capacity gate · authentication is not modeled',
    kind: 'network',
    district: 'clients',
    object: gate,
    tier: 1,
    focus: { target: [0, 7, ANCHOR.connGate[2]], distance: 84, dir: [0.3, 0.26, 1] },
    labelAt: [-34, 16, ANCHOR.connGate[2]],
    color: COLOR.ok,
    readout: (s) =>
      slotsFree === 0 || s.stats.activeBackends >= connectionCapacity(s)
        ? 'FATAL: sorry, too many clients already'
        : `${fmtNum(accepted)} accepted · ${slotsFree}/${N} slots free`,
  })

  /* =======================================================================
   * Runtime state.
   * =====================================================================*/

  let accepted = 0
  let slotsFree = N
  let prevT = -1
  let prevPulse = -1
  let beaconFlash = 0
  let gateFlash = 0
  let rejectLevel = 0
  const prevFree = new Uint8Array(N)
  prevFree.fill(1)
  let primed = false

  // Per-conduit smoothed state: extend, lit, phase, stuck.
  const cExt = new Float32Array(N)
  const cLit = new Float32Array(N)
  const cPh = new Float32Array(N)
  const cStuck = new Float32Array(N)

  function paintPoolerDigits(
    mesh: THREE.InstancedMesh,
    specs: BoxSpec[],
    rawValue: number,
    hex: number,
  ): void {
    const value = Math.min(9999, Math.max(0, Math.floor(rawValue)))
    mesh.userData.value = value
    let divisor = 1000
    let leading = true
    for (let digit = 0; digit < POOLER_DISPLAY_DIGITS; digit++) {
      const numeral = Math.floor(value / divisor) % 10
      const show = !leading || numeral !== 0 || digit === POOLER_DISPLAY_DIGITS - 1
      if (show) leading = false
      const mask = show ? DIGIT_MASK[numeral] : 0
      for (let segment = 0; segment < DIGIT_SEGMENTS; segment++) {
        const index = digit * DIGIT_SEGMENTS + segment
        const spec = specs[index]
        if (show) {
          setInstanceBox(mesh, index, spec[0], spec[1], spec[2], spec[3], spec[4], spec[5])
        } else {
          setInstanceBox(mesh, index, spec[0], -1000, spec[2], 0.001, 0.001, 0.001)
        }
        const on = (mask & (1 << segment)) !== 0
        _c.setHex(on ? hex : COLOR.inkDim).multiplyScalar(on ? 2.15 : 0.035)
        mesh.setColorAt(index, _c)
      }
      divisor /= 10
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor!.needsUpdate = true
  }

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
    // the connection itself, arriving up the avenue from the terminal
    ctx.flow({ route: 'conn.in', count: 1, kind: 'fork', color: COLOR.client, size: 1.5 })
    if (slot >= 0) {
      // postmaster → new backend: the fork() itself
      ctx.flow({ route: rid.fork(slot), count: 3, kind: 'fork', color: COLOR.postmaster, stagger: 0.06 })
    }
  }

  /* =======================================================================
   * Update.
   * =====================================================================*/

  function update(dt: number, sim: SimState, t: number): void {
    if (prevT < 0) prevT = t
    const dts = clamp(t - prevT, 0, 0.25) // simulated dt: freezes when paused
    prevT = t

    /* --- fork detection: a slot leaving 'free' is a fork ------------------ */
    const nb = Math.min(N, sim.backends.length)
    let fired = false
    let free = 0
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
    /* --- the conduits ----------------------------------------------------- */
    for (let i = 0; i < N; i++) {
      const b = i < nb ? sim.backends[i] : undefined
      const st: BackendState = b ? b.state : 'free'
      const live = st !== 'free'
      // Extends briskly when the postmaster forks; withdraws more slowly.
      cExt[i] = damp(cExt[i], live ? 1 : 0, live ? 4.2 : 2.4, dt)
      cLit[i] = damp(cLit[i], litLevel(st), 6, dt)
      cStuck[i] = damp(cStuck[i], st === 'idle_in_xact' ? 1 : 0, 2.6, dt)
      // The phase is the traffic. It uses simulated dt so a paused city stops.
      cPh[i] = (cPh[i] + phaseRate(st) * dts) % 1
      const o = i * 4
      stateArr[o] = cExt[i]
      stateArr[o + 1] = cLit[i]
      stateArr[o + 2] = cPh[i]
      stateArr[o + 3] = cStuck[i]
    }
    stateTex.needsUpdate = true

    /* --- the client fleet -------------------------------------------------- */
    const tps = sim.stats.tps
    const perNode = clamp(tps / nClients, 0, 7)
    for (let i = 0; i < nClients; i++) {
      cAcc[i] += dts * perNode
      while (cAcc[i] >= 1) {
        cAcc[i] -= 1
        cBlink[i] = 1
      }
      cBlink[i] = Math.max(0, cBlink[i] - dt * 3.4)

      // Shuffling in the bay. Horizontal only: nothing here ever leaves the deck.
      const sp = cSpeed[i]
      const ph = cPhase[i]
      const x = cBaseX[i] + Math.sin(t * sp + ph) * cAmp[i]
      const z = cBaseZ[i] + Math.cos(t * sp * 0.61 + ph * 0.6) * cAmp[i] * 0.22
      const s = cSize[i]

      _e.set(0, Math.sin(t * sp * 0.5 + ph) * 0.05, 0)
      _q.setFromEuler(_e)
      _p.set(x, 0.85 * s, z)
      _sc.set(3.0 * s, 1.7 * s, 4.6 * s)
      _m.compose(_p, _q, _sc)
      podStruct.setMatrixAt(i, _m)

      _p.set(x, 1.55 * s, z - 1.9 * s)
      _sc.set(2.2 * s, 0.36 * s, 0.3 * s)
      _m.compose(_p, _q, _sc)
      podLamp.setMatrixAt(i, _m)

      _c.setHex(COLOR.client).multiplyScalar(0.22 + cBlink[i] * 2.6)
      podLamp.setColorAt(i, _c)
    }
    podStruct.instanceMatrix.needsUpdate = true
    podLamp.instanceMatrix.needsUpdate = true
    podLamp.instanceColor!.needsUpdate = true

    /* --- postmaster ------------------------------------------------------- */
    beaconFlash = Math.max(0, beaconFlash - dt * 2.6)
    const load = clamp01(sim.stats.activeBackends / Math.max(1, connectionCapacity(sim)))
    const breathe = 0.55 + 0.45 * Math.sin(t * 1.5)
    const beaconLevel = 0.7 + breathe * 0.5 + beaconFlash * 3.2
    _c.setHex(COLOR.postmaster).multiplyScalar(beaconLevel * 2.4)
    pmBeacon.setColorAt(0, _c)
    pmBeacon.instanceColor!.needsUpdate = true

    // window slits brighten with the number of live sessions
    const slitLevel = 0.16 + load * 0.5 + beaconFlash * 0.35
    _c.setHex(COLOR.postmaster).multiplyScalar(slitLevel)
    for (let i = 0; i < pmGlowSpecs.length; i++) pmGlow.setColorAt(i, _c)
    pmGlow.instanceColor!.needsUpdate = true

    // terminal glazing tracks how much work the application tier is offering
    _c.setHex(COLOR.client).multiplyScalar(0.24 + clamp01(tps / 60) * 0.5)
    for (let i = 0; i < termGlowSpecs.length; i++) termGlow.setColorAt(i, _c)
    termGlow.instanceColor!.needsUpdate = true

    // The pooler remains legible when bypassed; active queue bars cross the
    // bloom threshold in proportion to clients waiting for a server slot.
    const pooled = sim.pooler.mode !== 'disabled'
    const waiting = sim.pooler.acceptedClients > 0
      ? clamp01(sim.pooler.waitingClients / sim.pooler.acceptedClients)
      : 0
    _c.setHex(COLOR.client).multiplyScalar(pooled ? 1.08 + waiting * 0.65 : 0.12)
    if (waiting > 0.5) {
      _c2.setHex(COLOR.warn).multiplyScalar(1.25 + waiting * 0.35)
      _c.lerp(_c2, waiting)
    }
    for (let i = 0; i < poolerGlowSpecs.length; i++) poolerGlow.setColorAt(i, _c)
    poolerGlow.instanceColor!.needsUpdate = true

    /* --- pooling switchyard --------------------------------------------- */
    const acceptedClients = Math.max(0, Math.floor(sim.pooler.acceptedClients))
    const serverConnections = Math.min(N, Math.max(0, Math.floor(sim.pooler.serverConnections)))
    const ratio = acceptedClients > 0 ? clamp01(serverConnections / acceptedClients) : 0
    const clientWidth = acceptedClients > 0 ? POOLER_CLIENT_WIDTH : 0.001
    const serverWidth = acceptedClients > 0
      ? Math.max(0.001, POOLER_CLIENT_WIDTH * ratio)
      : 0.001

    poolerClientBand.visible = pooled
    poolerServerBand.visible = pooled
    poolerFunnel.visible = pooled
    poolerClientPaths.visible = pooled
    poolerServerPaths.visible = pooled
    poolerReleaseMarkers.visible = pooled
    poolerDirectPaths.visible = !pooled

    setInstanceBox(poolerClientBand, 0, PB[0], 9.25, PB[2] - 1.05, clientWidth, 0.62, 0.5)
    setInstanceBox(poolerServerBand, 0, PB[0], 9.25, PB[2] + 1.05, serverWidth, 0.62, 0.5)
    poolerClientBand.instanceMatrix.needsUpdate = true
    poolerServerBand.instanceMatrix.needsUpdate = true
    _c.setHex(COLOR.client).multiplyScalar(1.28)
    poolerClientBand.setColorAt(0, _c)
    _c.setHex(COLOR.backend).multiplyScalar(1.35)
    poolerServerBand.setColorAt(0, _c)
    poolerClientBand.instanceColor!.needsUpdate = true
    poolerServerBand.instanceColor!.needsUpdate = true

    setHorizontalBeam(
      poolerFunnel,
      0,
      PB[0] - clientWidth / 2,
      PB[2] - 0.8,
      PB[0] - serverWidth / 2,
      PB[2] + 0.8,
      9.25,
      0.24,
    )
    setHorizontalBeam(
      poolerFunnel,
      1,
      PB[0] + clientWidth / 2,
      PB[2] - 0.8,
      PB[0] + serverWidth / 2,
      PB[2] + 0.8,
      9.25,
      0.24,
    )
    poolerFunnel.instanceMatrix.needsUpdate = true
    _c.setHex(COLOR.client).multiplyScalar(1.18)
    poolerFunnel.setColorAt(0, _c)
    poolerFunnel.setColorAt(1, _c)
    poolerFunnel.instanceColor!.needsUpdate = true

    const activeClientPaths = Math.min(nPoolClientPaths, acceptedClients)
    poolerClientPaths.count = activeClientPaths
    const warningPaths = Math.round(activeClientPaths * waiting)
    for (let i = 0; i < activeClientPaths; i++) {
      _c.setHex(i >= activeClientPaths - warningPaths ? COLOR.warn : COLOR.client)
        .multiplyScalar(1.16)
      poolerClientPaths.setColorAt(i, _c)
    }
    poolerClientPaths.instanceColor!.needsUpdate = true

    const pathZ0 = PB[2] + 1.6
    const pathZ1 = CONDUIT.boundaryZ - 0.9
    const pathSpan = Math.max(0.1, pathZ1 - pathZ0)
    const segmentFill = sim.pooler.mode === 'session'
      ? 0.94
      : sim.pooler.mode === 'transaction'
        ? 0.68
        : 0.4
    poolerServerPaths.count = serverConnections * serverPathSegments
    for (let connection = 0; connection < serverConnections; connection++) {
      const row = Math.floor(connection / 8)
      const col = connection % 8
      const rowConnections = Math.min(8, serverConnections - row * 8)
      const x = rowConnections > 1
        ? PB[0] - serverWidth / 2 + serverWidth * col / (rowConnections - 1)
        : PB[0]
      const y = 4.8 + row * 2.6
      for (let segment = 0; segment < serverPathSegments; segment++) {
        const index = connection * serverPathSegments + segment
        const z = pathZ0 + pathSpan * (segment + 0.5) / serverPathSegments
        setInstanceBox(
          poolerServerPaths,
          index,
          x,
          y,
          z,
          0.34,
          0.34,
          pathSpan * segmentFill / serverPathSegments,
        )
        let intensity = 1.25
        if (sim.pooler.mode === 'session') {
          // Held links stay solid; the disconnect marker supplies the hand-off.
          intensity += 0.08 * Math.sin(t * 0.32 + connection * 0.19)
        } else if (sim.pooler.mode === 'transaction') {
          // One synchronized wave marks release at a transaction boundary.
          const phase = (t * 0.72 + segment / serverPathSegments) % 1
          intensity = phase < 0.25 ? 1.9 : 0.48
        } else if (sim.pooler.mode === 'statement') {
          // Per-link stagger marks release after individual statements.
          const phase = (t * 1.45 + connection * 0.17 + segment * 0.31) % 1
          intensity = phase < 0.42 ? 1.85 : 0.3
        }
        _c.setHex(COLOR.backend).multiplyScalar(intensity)
        poolerServerPaths.setColorAt(index, _c)
      }
    }
    poolerServerPaths.instanceMatrix.needsUpdate = true
    poolerServerPaths.instanceColor!.needsUpdate = true

    poolerDirectPaths.count = Math.min(N, acceptedClients, serverConnections)
    _c.setHex(COLOR.client).multiplyScalar(1.25)
    for (let i = 0; i < poolerDirectPaths.count; i++) poolerDirectPaths.setColorAt(i, _c)
    poolerDirectPaths.instanceColor!.needsUpdate = true

    const selectedBoundary = releaseBoundaryIndex(sim.pooler.mode)
    for (let i = 0; i < RELEASE_BOUNDARIES; i++) {
      if (i !== selectedBoundary) {
        _c.setHex(COLOR.inkDim).multiplyScalar(0.06)
      } else {
        const rate = i === 0 ? 1 / 15 : i === 1 ? 0.72 : 1.45
        const phase = (t * rate) % 1
        const pulse = Math.max(0, 1 - Math.abs(phase - 0.5) * 5)
        _c.setHex(COLOR.client).multiplyScalar(1.16 + pulse * 0.84)
      }
      poolerReleaseMarkers.setColorAt(i, _c)
    }
    poolerReleaseMarkers.instanceColor!.needsUpdate = true

    paintPoolerDigits(poolerClientDigits, clientDigitSpecs, acceptedClients, COLOR.client)
    paintPoolerDigits(poolerServerDigits, serverDigitSpecs, serverConnections, COLOR.backend)
    const modePlateIndex = sim.pooler.mode === 'disabled'
      ? 0
      : sim.pooler.mode === 'session'
        ? 1
        : sim.pooler.mode === 'transaction'
          ? 2
          : 3
    for (let i = 0; i < poolModePlates.length; i++) poolModePlates[i].visible = i === modePlateIndex

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
    const full = free === 0 || sim.stats.activeBackends >= connectionCapacity(sim)
    rejectLevel = damp(rejectLevel, full ? 1 : 0, 6, dt)

    _c.setHex(COLOR.client).multiplyScalar(0.22 + gateFlash * 1.6)
    if (rejectLevel > 0.01) {
      _c2.setHex(COLOR.crit).multiplyScalar(0.9)
      _c.lerp(_c2, rejectLevel * 0.8)
    }
    for (let i = 0; i < 4; i++) gateGlow.setColorAt(i, _c)
    // the fence rail is boundary, not traffic: steady and low
    _c.setHex(COLOR.inkDim).multiplyScalar(0.34)
    gateGlow.setColorAt(4, _c)
    gateGlow.setColorAt(5, _c)
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
    piers.visible = level >= 1
    bayLines.visible = level >= 1
    podLamp.visible = level >= 1
    pmPlate.visible = level >= 2
    gatePlate.visible = level >= 2
    boundPlate.visible = level >= 2
    termPlate.visible = level >= 2
    // Counts, ratio and release boundary are the mechanism, not close-up trim.
    poolerPlate.visible = true
    clientCountPlate.visible = true
    serverCountPlate.visible = true
    countArrowPlate.visible = true
    // update() owns the one visible mode plate; fidelity never overrides it.
    lamps.visible = level >= 1
  }

  function dispose(): void {
    for (const o of owned) o.dispose()
    owned.length = 0
    podStruct.dispose()
    podLamp.dispose()
    poolerStruct.dispose()
    poolerGlow.dispose()
    poolerClientBand.dispose()
    poolerServerBand.dispose()
    poolerFunnel.dispose()
    poolerClientPaths.dispose()
    poolerServerPaths.dispose()
    poolerDirectPaths.dispose()
    poolerReleaseMarkers.dispose()
    poolerClientDigits.dispose()
    poolerServerDigits.dispose()
    termStruct.dispose()
    termGlow.dispose()
    pmStruct.dispose()
    pmDetailMesh.dispose()
    pmCyl.dispose()
    pmGlow.dispose()
    pmBeacon.dispose()
    pmRings.dispose()
    gateStruct.dispose()
    gateGlow.dispose()
    lamps.dispose()
    piers.dispose()
    manifold.dispose()
  }

  return { id: 'clients', group, update, setDetail, dispose }
}
