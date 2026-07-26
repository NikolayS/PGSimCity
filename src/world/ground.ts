import * as THREE from 'three'
import { COLOR, mixHex } from '../core/theme'
import { fmtBytes, fmtNum } from '../core/util'
import { ANCHOR, CITY, DISTRICT_BOUNDS } from './layout'
import type { DistrictId, SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'

/* ============================================================================
 * GROUND — the plate PGSimCity is bolted to, and the hole cut through it.
 *
 * Three ideas, in order of importance:
 *
 *  1. The ground is a *cut* plane. A rectangular hole over CITY.pit exposes the
 *     storage district 52 m down. That cut is the whole thesis of the model:
 *     above the line is memory, below it is disk, and you can see both at once.
 *  2. The surface is a survey grid, not a texture — a two-tier world-space grid
 *     with screen-constant line width, dissolving into the fog instead of
 *     ending at an edge.
 *  3. Districts stand on plinths with lit rims and floor signage, so a newcomer
 *     can orient themselves before they know a single Postgres word.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * Grid shader.
 * -------------------------------------------------------------------------*/

const groundVert = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`

const groundFrag = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uSweep;
uniform float uTime;
uniform float uInner;
uniform float uOuter;

varying vec3 vWorld;
#include <fog_pars_fragment>

// Anti-aliased world-space grid. fwidth() keeps the line one pixel wide at any
// distance or angle; density is handed back so we can retire a tier once its
// cells shrink below a pixel and would otherwise alias into mush.
float gridMask( vec2 p, float spacing, float thick, out float density ) {
  vec2 c = p / spacing;
  vec2 w = fwidth( c ) + 1e-5;
  density = max( w.x, w.y );
  vec2 g = abs( fract( c - 0.5 ) - 0.5 ) / w;
  return 1.0 - smoothstep( 0.0, thick, min( g.x, g.y ) );
}

void main() {
  vec2 p = vWorld.xz;
  float r = length( p );

  float dMinor, dMajor;
  float minor = gridMask( p, 10.0, 1.15, dMinor );   // 10 m survey grid
  float major = gridMask( p, 50.0, 1.70, dMajor );   // 50 m block grid

  minor *= 1.0 - smoothstep( 0.20, 0.80, dMinor );
  major *= 1.0 - smoothstep( 0.28, 1.05, dMajor );

  float camFade = 1.0 - smoothstep( 620.0, 1500.0, distance( vWorld, cameraPosition ) );
  minor *= camFade;
  major *= camFade;

  // Radial dissolve: the plate must end in fog, never in a visible edge.
  float falloff = 1.0 - smoothstep( uInner, uOuter, r );
  falloff *= falloff;

  // Sonar ping out of the city centre, one every 14 s. Deliberately almost
  // subliminal — it exists to say "this thing is live", nothing more.
  float ph = fract( uTime / 14.0 );
  float q = ( r - ph * uOuter ) / 30.0;
  float sweep = exp( - q * q ) * ( 1.0 - ph ) * 0.5;

  vec3 col = uBase * mix( 0.45, 1.0, falloff );
  col = mix( col, uMinor, minor * 0.9 );
  col = mix( col, uMajor, major );
  col += uSweep * sweep * ( 0.35 + 0.65 * max( minor, major ) );

  float alpha = clamp( falloff * ( 1.0 + sweep * 0.25 ), 0.0, 1.0 );

  gl_FragColor = vec4( col, alpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`

/* ---------------------------------------------------------------------------
 * Footprint arithmetic: every plinth is a rectangle minus the excavation.
 * -------------------------------------------------------------------------*/

interface Rect {
  x0: number
  x1: number
  z0: number
  z1: number
}

/** Keep-out box around the hole: plinths must not hang over the cut edge. */
const PIT_CLEAR = 3
const KEEP_OUT: Rect = {
  x0: -CITY.pit.x - PIT_CLEAR,
  x1: CITY.pit.x + PIT_CLEAR,
  z0: -CITY.pit.z - PIT_CLEAR,
  z1: CITY.pit.z + PIT_CLEAR,
}

const rectArea = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.z1 - r.z0)

/**
 * Largest sub-rectangle of `r` that clears the excavation. Returns null when the
 * district floats entirely over the hole — which is exactly the case for the
 * shared-memory plaza, and is why it gets a deck instead of a plinth.
 */
function clipToSolidGround(r: Rect): Rect | null {
  const overlaps = r.x0 < KEEP_OUT.x1 && r.x1 > KEEP_OUT.x0 && r.z0 < KEEP_OUT.z1 && r.z1 > KEEP_OUT.z0
  if (!overlaps) return rectArea(r) > 0 ? r : null

  const cands: Rect[] = [
    { x0: r.x0, x1: Math.min(r.x1, KEEP_OUT.x0), z0: r.z0, z1: r.z1 },
    { x0: Math.max(r.x0, KEEP_OUT.x1), x1: r.x1, z0: r.z0, z1: r.z1 },
    { x0: r.x0, x1: r.x1, z0: r.z0, z1: Math.min(r.z1, KEEP_OUT.z0) },
    { x0: r.x0, x1: r.x1, z0: Math.max(r.z0, KEEP_OUT.z1), z1: r.z1 },
  ]
  let best: Rect | null = null
  let bestArea = 0
  for (const c of cands) {
    const a = rectArea(c)
    if (a > bestArea) {
      bestArea = a
      best = c
    }
  }
  return bestArea > 400 ? best : null
}

/* ---------------------------------------------------------------------------
 * Static dressing tables.
 * -------------------------------------------------------------------------*/

interface PlinthSpec {
  district: DistrictId
  label: string
  color: number
}

/** Everything that stands on the surface. 'storage' is underground, 'planner'
 *  is in the air, 'world' is the whole map — none of them get a platform. */
const PLINTHS: readonly PlinthSpec[] = [
  { district: 'clients', label: 'CLIENTS', color: COLOR.backend },
  { district: 'backends', label: 'BACKENDS', color: COLOR.backend },
  { district: 'shmem', label: 'SHARED MEMORY', color: COLOR.shmem },
  { district: 'wal', label: 'pg_wal', color: COLOR.wal },
  { district: 'maintenance', label: 'MAINTENANCE', color: COLOR.vacuum },
  { district: 'replication', label: 'STANDBY', color: COLOR.replication },
]

const PLINTH_H = 0.6
const PLINTH_DROP = 0.5 // sink the slab below y=0 so it never z-fights the plate

/** x, z, mast height — well outside every district footprint. */
const MASTS: readonly (readonly [number, number, number])[] = [
  // ordered so that the first three already ring the city — 'low' quality keeps
  // only those and still gets a balanced silhouette
  [430, -300, 58],
  [-450, 40, 66],
  [300, 430, 62],
  [470, 120, 44],
  [-330, 360, 48],
  [-380, -320, 52],
]

/** x, z, base radius, height, colour — a light cone under each district beacon. */
const CONES: readonly (readonly [number, number, number, number, number])[] = [
  [ANCHOR.walVault[0], ANCHOR.walVault[2], 34, 62, COLOR.wal],
  [ANCHOR.checkpointer[0], ANCHOR.checkpointer[2], 26, 50, COLOR.checkpoint],
  [ANCHOR.bgWriter[0], ANCHOR.bgWriter[2], 22, 44, COLOR.bgwriter],
  [ANCHOR.autovacLauncher[0], ANCHOR.autovacLauncher[2], 24, 46, COLOR.vacuum],
  [ANCHOR.postmaster[0], ANCHOR.postmaster[2], 30, 56, COLOR.postmaster],
  [ANCHOR.standby[0], ANCHOR.standby[2], 30, 54, COLOR.replication],
]

const cssHex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0')

/* ---------------------------------------------------------------------------
 * Factory.
 * -------------------------------------------------------------------------*/

export const createGround: WorldFactory = (ctx: WorldContext): WorldModule => {
  const { theme, quality } = ctx

  const group = new THREE.Group()
  group.name = 'world.ground'

  const geos: THREE.BufferGeometry[] = []
  const mats: THREE.Material[] = []

  /* ---------------------------------------------------------------------
   * 1. The plate, with the excavation cut out of it.
   * -------------------------------------------------------------------*/

  const G = CITY.ground
  const shape = new THREE.Shape()
  shape.moveTo(-G, -G)
  shape.lineTo(G, -G)
  shape.lineTo(G, G)
  shape.lineTo(-G, G)
  shape.closePath()

  // Shape space is XY; after the -90° rotation about X, +Y becomes world -Z.
  const hole = new THREE.Path()
  hole.moveTo(-CITY.pit.x, -CITY.pit.z)
  hole.lineTo(-CITY.pit.x, CITY.pit.z)
  hole.lineTo(CITY.pit.x, CITY.pit.z)
  hole.lineTo(CITY.pit.x, -CITY.pit.z)
  hole.closePath()
  shape.holes.push(hole)

  const plateGeo = new THREE.ShapeGeometry(shape)
  geos.push(plateGeo)

  const gridUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uBase: { value: new THREE.Color(COLOR.ground) },
      uMinor: { value: new THREE.Color(COLOR.grid) },
      uMajor: { value: new THREE.Color(COLOR.gridBright) },
      uSweep: { value: new THREE.Color(mixHex(COLOR.gridBright, COLOR.backend, 0.55)) },
      uTime: { value: 0 },
      uInner: { value: 560 },
      uOuter: { value: 1320 },
    },
  ])
  const uTime = gridUniforms.uTime as { value: number }

  const plateMat = new THREE.ShaderMaterial({
    uniforms: gridUniforms,
    vertexShader: groundVert,
    fragmentShader: groundFrag,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    fog: true,
  })
  mats.push(plateMat)

  const plate = new THREE.Mesh(plateGeo, plateMat)
  plate.name = 'ground.plate'
  plate.rotation.x = -Math.PI / 2
  plate.renderOrder = -5 // first of the transparent pass, so it can occlude properly
  plate.frustumCulled = false
  group.add(plate)

  /* ---------------------------------------------------------------------
   * 2. The excavation: rim, walls, strata, floor.
   * -------------------------------------------------------------------*/

  const pit = new THREE.Group()
  pit.name = 'world.pit'
  group.add(pit)

  const px = CITY.pit.x
  const pz = CITY.pit.z
  const pitFloorY = CITY.storage.y - 8
  const pitDepth = -pitFloorY

  // The cut edge. A hard neon line reading "storage green": this is the exact
  // altitude at which shared memory stops and the filesystem starts.
  const rimPts = new Float32Array([px, 0.07, pz, -px, 0.07, pz, -px, 0.07, -pz, px, 0.07, -pz])
  const rimGeo = new THREE.BufferGeometry()
  rimGeo.setAttribute('position', new THREE.BufferAttribute(rimPts, 3))
  geos.push(rimGeo)
  const rim = new THREE.LineLoop(rimGeo, theme.line(COLOR.storage, 0.9))
  rim.renderOrder = 4
  rim.raycast = () => {}
  pit.add(rim)

  // A soft spill of light on the pavement just outside the cut.
  const bandShape = new THREE.Shape()
  bandShape.moveTo(-px - 5, -pz - 5)
  bandShape.lineTo(px + 5, -pz - 5)
  bandShape.lineTo(px + 5, pz + 5)
  bandShape.lineTo(-px - 5, pz + 5)
  bandShape.closePath()
  const bandHole = new THREE.Path()
  bandHole.moveTo(-px, -pz)
  bandHole.lineTo(-px, pz)
  bandHole.lineTo(px, pz)
  bandHole.lineTo(px, -pz)
  bandHole.closePath()
  bandShape.holes.push(bandHole)
  const bandGeo = new THREE.ShapeGeometry(bandShape)
  geos.push(bandGeo)
  const bandMat = new THREE.MeshBasicMaterial({
    color: COLOR.storage,
    transparent: true,
    opacity: 0.13,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  })
  mats.push(bandMat)
  const band = new THREE.Mesh(bandGeo, bandMat)
  band.rotation.x = -Math.PI / 2
  band.position.y = 0.04
  band.renderOrder = 3
  band.raycast = () => {}
  pit.add(band)

  // Walls. FrontSide + inward facing: invisible from outside, so the ground
  // plate reads as solid until you actually look down the hole.
  const wallMat = theme.mat('ground.pitWall', {
    color: 0x0b1220,
    roughness: 0.96,
    metalness: 0.04,
    emissive: 0x070d18,
    emissiveIntensity: 0.9,
  })
  const wallNS = new THREE.PlaneGeometry(px * 2, pitDepth)
  const wallEW = new THREE.PlaneGeometry(pz * 2, pitDepth)
  geos.push(wallNS, wallEW)

  const wallDefs: [THREE.PlaneGeometry, number, number, number][] = [
    [wallNS, 0, -pz, 0], // north wall, faces +Z
    [wallNS, 0, pz, Math.PI], // south wall, faces -Z
    [wallEW, -px, 0, Math.PI / 2], // west wall, faces +X
    [wallEW, px, 0, -Math.PI / 2], // east wall, faces -X
  ]
  for (const [geo, wx, wz, ry] of wallDefs) {
    const m = new THREE.Mesh(geo, wallMat)
    m.position.set(wx, -pitDepth / 2, wz)
    m.rotation.y = ry
    pit.add(m)
  }

  // Strata. Horizontal cuts every 6 m, cooling from grid blue to storage green
  // and fading with depth: the excavation reads as geology, not as a box.
  const sx = px - 0.35
  const sz = pz - 0.35
  for (let y = -6; y >= pitFloorY + 2; y -= 6) {
    const f = Math.min(1, -y / pitDepth)
    const pts = new Float32Array([sx, y, sz, -sx, y, sz, -sx, y, -sz, sx, y, -sz])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    geos.push(g)
    const l = new THREE.LineLoop(g, theme.line(mixHex(COLOR.gridBright, COLOR.storage, f), 0.5 - 0.4 * f))
    l.raycast = () => {}
    pit.add(l)
  }

  const pitFloorGeo = new THREE.PlaneGeometry(px * 2, pz * 2)
  geos.push(pitFloorGeo)
  const pitFloor = new THREE.Mesh(
    pitFloorGeo,
    theme.mat('ground.pitFloor', { color: 0x05080f, roughness: 1, metalness: 0, emissive: 0x02040a }),
  )
  pitFloor.rotation.x = -Math.PI / 2
  pitFloor.position.y = pitFloorY
  pit.add(pitFloor)

  /* ---------------------------------------------------------------------
   * 3. District plinths + floor signage.
   * -------------------------------------------------------------------*/

  const unitBox = new THREE.BoxGeometry(1, 1, 1)
  const unitPlane = new THREE.PlaneGeometry(1, 1)
  geos.push(unitBox, unitPlane)

  const slabMat = theme.mat('ground.plinth', {
    color: 0x0c1322,
    roughness: 0.92,
    metalness: 0.12,
    emissive: 0x060a12,
    emissiveIntensity: 0.8,
  })

  /** Flat wayfinding label. `along` 0 = text runs east–west, 1 = north–south. */
  function addDecal(text: string, color: number, cx: number, cy: number, cz: number, along: 0 | 1, avail: number) {
    // Monospace tracking done with real spaces: theme.textTexture() measures the
    // string it is given, so CSS letter-spacing would overflow the canvas.
    const label = text.length <= 8 ? text.split('').join(' ') : text
    const tex = theme.textTexture(label, { size: 96, color: cssHex(color) })
    const img = tex.image as { width: number; height: number }
    const aspect = img && img.height ? img.width / img.height : 4
    const w = avail * 0.62
    const h = w / aspect

    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.3, depthWrite: false })
    mats.push(m)
    const mesh = new THREE.Mesh(unitPlane, m)
    mesh.scale.set(w, h, 1)
    mesh.rotation.set(-Math.PI / 2, 0, along === 0 ? 0 : -Math.PI / 2)
    mesh.position.set(cx, cy, cz)
    mesh.renderOrder = 3
    mesh.raycast = () => {}
    group.add(mesh)
  }

  for (const spec of PLINTHS) {
    const b = DISTRICT_BOUNDS[spec.district]
    if (!b) continue
    const inset: Rect = { x0: b.x[0] + 4, x1: b.x[1] - 4, z0: b.z[0] + 4, z1: b.z[1] - 4 }
    const r = clipToSolidGround(inset)

    if (!r) {
      // Shared memory has no ground under it — it is a deck floating over the
      // excavation. Lay its sign on the deck instead, clear of the buffer grid.
      addDecal(spec.label, spec.color, 0, CITY.deck.top + 0.08, 51, 0, CITY.deck.w)
      continue
    }

    const w = r.x1 - r.x0
    const d = r.z1 - r.z0
    const cx = (r.x0 + r.x1) / 2
    const cz = (r.z0 + r.z1) / 2

    const slab = new THREE.Mesh(unitBox, slabMat)
    slab.scale.set(w, PLINTH_H + PLINTH_DROP, d)
    slab.position.set(cx, (PLINTH_H - PLINTH_DROP) / 2, cz)
    group.add(slab)

    // 1 m emissive kerb in the district colour — the only glowing thing at
    // street level, and the fastest way to tell districts apart from the air.
    const kerb = new THREE.Shape()
    kerb.moveTo(-w / 2, -d / 2)
    kerb.lineTo(w / 2, -d / 2)
    kerb.lineTo(w / 2, d / 2)
    kerb.lineTo(-w / 2, d / 2)
    kerb.closePath()
    const inner = new THREE.Path()
    inner.moveTo(-w / 2 + 1, -d / 2 + 1)
    inner.lineTo(-w / 2 + 1, d / 2 - 1)
    inner.lineTo(w / 2 - 1, d / 2 - 1)
    inner.lineTo(w / 2 - 1, -d / 2 + 1)
    inner.closePath()
    kerb.holes.push(inner)
    const kerbGeo = new THREE.ShapeGeometry(kerb)
    geos.push(kerbGeo)
    const kerbMesh = new THREE.Mesh(kerbGeo, theme.neon(spec.color, 1.15))
    kerbMesh.rotation.x = -Math.PI / 2
    kerbMesh.position.set(cx, PLINTH_H + 0.02, cz)
    kerbMesh.raycast = () => {}
    group.add(kerbMesh)

    const along: 0 | 1 = w >= d ? 0 : 1
    addDecal(spec.label, spec.color, cx, PLINTH_H + 0.05, cz, along, along === 0 ? w : d)
  }

  /* ---------------------------------------------------------------------
   * 4. Ambient dressing — masts and light cones. A handful of draw calls.
   * -------------------------------------------------------------------*/

  const dressing = quality.level === 'low' ? 3 : MASTS.length
  const beaconMats: THREE.MeshBasicMaterial[] = []
  const beaconPhase: number[] = []

  const mastMat = theme.mat('ground.mast', { color: 0x18233a, roughness: 0.75, metalness: 0.45 })
  const beaconGeo = new THREE.SphereGeometry(1.5, 8, 6)
  geos.push(beaconGeo)

  for (let i = 0; i < dressing; i++) {
    const [mx, mz, mh] = MASTS[i]
    const mast = new THREE.Mesh(theme.cyl(0.3, 0.55, mh, 6), mastMat)
    mast.position.set(mx, mh / 2, mz)
    group.add(mast)

    const bm = new THREE.MeshBasicMaterial({
      color: COLOR.ink,
      toneMapped: false,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
    })
    mats.push(bm)
    beaconMats.push(bm)
    beaconPhase.push((i * 0.37) % 1)

    const beacon = new THREE.Mesh(beaconGeo, bm)
    beacon.position.set(mx, mh + 1.4, mz)
    beacon.raycast = () => {}
    group.add(beacon)
  }

  if (quality.level !== 'low') {
    for (const [cx, cz, cr, ch, col] of CONES) {
      const g = new THREE.ConeGeometry(cr, ch, 18, 1, true)
      geos.push(g)
      const m = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        forceSinglePass: true,
      })
      mats.push(m)
      const cone = new THREE.Mesh(g, m)
      cone.position.set(cx, ch / 2, cz)
      cone.renderOrder = 2
      cone.raycast = () => {}
      group.add(cone)
    }
  }

  /* ---------------------------------------------------------------------
   * 5. Registration.
   * -------------------------------------------------------------------*/

  ctx.register({
    id: 'world.ground',
    name: 'PGSimCity',
    role: 'one PostgreSQL cluster',
    kind: 'concept',
    district: 'world',
    object: group,
    tier: 0,
    focus: { target: [0, 0, 10], distance: 760, dir: [0.42, 0.5, 0.86] },
    labelAt: [0, 26, 0],
    readout: (s: SimState) =>
      `${fmtNum(s.stats.tps, 0)} tps · ${s.stats.cacheHitPct.toFixed(1)}% cache hit · ${s.stats.activeBackends} active`,
  })

  ctx.register({
    id: 'world.pit',
    name: 'The excavation',
    role: 'where memory ends and disk begins',
    kind: 'concept',
    district: 'storage',
    object: pit,
    tier: 1,
    // Drop INTO the cut. The old spec parked the camera at distance 320 above
    // the plaza, where the plaza deck occludes the hole and the excavation reads
    // as a black square. Aim below the rim (target y = -40) with a shallow dir.y
    // and the filesystem underneath is what fills the frame.
    focus: { target: [0, -40, -10], distance: 200, dir: [0.26, 0.2, 0.94] },
    labelAt: [0, -6, -CITY.pit.z],
    color: COLOR.storage,
    readout: (s: SimState) =>
      `${fmtBytes(s.stats.ioReadPerSec)}/s read · ${fmtBytes(s.stats.ioWritePerSec)}/s write`,
  })

  /* ---------------------------------------------------------------------
   * 6. Per-frame. Two uniform writes and a handful of opacity assignments.
   * -------------------------------------------------------------------*/

  let clock = 0

  function update(dt: number, _sim: SimState, _t: number): void {
    // Ambient, not simulated: the sweep and the beacons keep running while the
    // simulation is paused so the model never looks dead.
    clock += dt
    uTime.value = clock

    for (let i = 0; i < beaconMats.length; i++) {
      const p = (clock * 0.38 + beaconPhase[i]) % 1
      // double-flash, aviation style
      const on = p < 0.05 ? 1 : p < 0.11 ? 0.12 : p < 0.16 ? 0.85 : 0.06
      beaconMats[i].opacity = on
    }
  }

  function dispose(): void {
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    group.clear()
  }

  return { id: 'ground', group, update, dispose }
}
