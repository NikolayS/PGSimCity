import * as THREE from 'three'
import { destinationForDistrict } from '../core/destinations'
import { ATMOSPHERE, COLOR, DAY_PALETTE, atmosphere, mixHex } from '../core/theme'
import { clamp01, fmtBytes, fmtNum } from '../core/util'
import { ANCHOR, CITY, DISTRICT_BOUNDS } from './layout'
import { plateFogK } from './plate-fog'
import {
  GROUND_SURFACE_CHANNELS,
  GROUND_SURFACE_SIZE,
  createGroundSurfaceData,
  groundSurfaceDetail,
} from './ground-surface'
import {
  clearance,
  contains,
  offsetRing,
  outlineBounds,
  ringArea2,
  sampleOutline,
  writeShape,
} from './slonik'
import type { PlanBounds } from './slonik'
import type { DistrictId, SimState, WorldContext, WorldFactory, WorldModule } from '../core/types'

export function worldGroundReadout(s: SimState): string {
  return `${fmtNum(s.stats.tps, 0)} tps · ${s.stats.cacheHitPct.toFixed(1)}% cache hit · ${s.stats.runningBackends} active`
}

export function worldPitReadout(s: SimState): string {
  return `${fmtNum(s.stats.ioReadPerSec)} read pages/s · ${fmtNum(s.stats.ioWritePerSec)} sampled write frames/s`
}

/* ============================================================================
 * GROUND — the plate PGSimCity is bolted to, and the hole cut through it.
 *
 * Four ideas, in order of importance:
 *
 *  1. The ground is a *cut* plane. A rectangular hole over CITY.pit exposes the
 *     storage district 52 m down. That cut is the whole thesis of the model:
 *     above the line is memory, below it is disk, and you can see both at once.
 *  2. The plate ENDS. Its outer boundary is the Slonik outline (world/slonik.ts)
 *     — a poured slab with real thickness, a kerb and an edge light, standing in
 *     an empty void. No district moves; only the shape of the ground under them.
 *     Look straight down (the `O` preset) and the ground is the PostgreSQL mark.
 *  3. The surface is poured civic paving: one small runtime-generated aggregate
 *     tile under staggered cast-panel joints, then a two-tier world-space survey
 *     grid. Mips retire aggregate before it aliases; screen-space derivatives
 *     keep both joint systems honest from walking range through plan view.
 *  4. Districts stand on plinths with lit rims and floor signage, so a newcomer
 *     can orient themselves before they know a single Postgres word.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * Grid shader.
 * -------------------------------------------------------------------------*/

const groundVert = /* glsl */ `
uniform float uFogK;
varying vec3 vWorld;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
  #ifdef USE_FOG
  // The plate is now a kilometre across and the overview shot looks at all of
  // it from 1.3 km up. At full strength the scene fog would swallow the whole
  // silhouette, so the slab — and only the slab — reads the fog short.
  vFogDepth *= uFogK;
  #endif
}
`

const groundFrag = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uSweep;
uniform vec3 uRim;
uniform float uTime;
uniform float uSweepR;
uniform sampler2D uSurface;
uniform float uSurfaceDetail;
uniform float uSurfaceResponse;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform sampler2D uEdge;
uniform vec4 uEdgeMap;   // x0, z0, 1/width, 1/depth of the edge field
uniform float uEdgeMax;  // metres encoded across the signed field

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

  // Distance from the kerb, in metres, from a baked signed field. One texture
  // fetch buys the grid cut-off, the slab's shading and the edge-light spill —
  // all of which have to follow an outline no analytic function describes.
  vec2 euv = ( p - uEdgeMap.xy ) * uEdgeMap.zw;
  float edge = ( texture2D( uEdge, euv ).r - 0.5 ) * 2.0 * uEdgeMax;

  float dMinor, dMajor;
  float minor = gridMask( p, 10.0, 1.15, dMinor );   // 10 m survey grid
  float major = gridMask( p, 50.0, 1.70, dMajor );   // 50 m block grid

  minor *= 1.0 - smoothstep( 0.20, 0.80, dMinor );
  major *= 1.0 - smoothstep( 0.28, 1.05, dMajor );

  // Survives the overview shot: the camera sits 1.3 km up there and the survey
  // grid is most of what makes the plate read as a poured surface at all.
  float camFade = 1.0 - smoothstep( 950.0, 2700.0, distance( vWorld, cameraPosition ) );
  minor *= camFade;
  major *= camFade;

  // The survey grid stops at the plate, not in the fog: it dies in the last
  // 34 m so the kerb is a boundary and not just the place the lines get cut.
  float hem = smoothstep( 0.0, 34.0, edge );
  minor *= hem;
  major *= hem;

  // Sonar ping out of the city centre, one every 14 s. Deliberately almost
  // subliminal — it exists to say "this thing is live", nothing more.
  float ph = fract( uTime / 14.0 );
  float q = ( r - ph * uSweepR ) / 30.0;
  float sweep = exp( - q * q ) * ( 1.0 - ph ) * 0.5;

  // Keep enough surface value at the boundary to separate the poured plate
  // from the void before the practical lights are added.
  vec3 col = uBase * mix( 0.72, 1.08, smoothstep( 0.0, 230.0, edge ) );

  if ( uSurfaceDetail > 0.5 ) {
    // 4.2 × 3.1 m cast panels give a standing visitor scale. Alternate rows
    // shift half a bay, so the paving reads as laid work instead of graph paper.
    float row = floor( p.y / 3.1 );
    vec2 panelP = vec2( p.x + mod( row, 2.0 ) * 2.1, p.y * ( 4.2 / 3.1 ) );
    float dPanel;
    float panel = gridMask( panelP, 4.2, 1.18, dPanel );
    panel *= 1.0 - smoothstep( 0.16, 0.58, dPanel );
    col *= 1.0 - panel * 0.115;
  }
  if ( uSurfaceDetail > 1.5 ) {
    // One mipmapped lookup carries albedo, a two-component normal and roughness.
    // Medium skips it: sampling over the largest surface in the framebuffer is
    // precisely the tax that tier exists to avoid.
    vec2 surfaceUv = mat2( 0.9239, -0.3827, 0.3827, 0.9239 ) * p / 52.0;
    vec4 surface = texture2D( uSurface, surfaceUv );
    float aggregate = surface.b - 0.515;
    col *= 1.0 + aggregate * 0.24;

    // Mips average RG toward neutral, so the normal becomes flat before a
    // distant texel can shimmer. Reconstructing Y preserves unit length without
    // spending a third channel.
    vec2 tangentXZ = ( surface.rg * 2.0 - 1.0 ) * 0.12;
    float tangentY = sqrt( max( 0.0, 1.0 - dot( tangentXZ, tangentXZ ) ) );
    vec3 surfaceNormal = normalize( vec3(
      0.9239 * tangentXZ.x + 0.3827 * tangentXZ.y,
      tangentY,
      -0.3827 * tangentXZ.x + 0.9239 * tangentXZ.y
    ) );
    float roughness = surface.a;
    float raking = dot( surfaceNormal, uSunDirection ) - uSunDirection.y;
    col *= 1.0 + clamp( raking * 0.72, -0.075, 0.09 ) * uSurfaceResponse;

    vec3 halfDirection = normalize( uSunDirection + normalize( cameraPosition - vWorld ) );
    float gloss = 1.0 - roughness;
    float highlight = pow( max( dot( surfaceNormal, halfDirection ), 0.0 ), mix( 12.0, 46.0, gloss ) );
    col += uSunColor * highlight * gloss * 0.12 * uSurfaceResponse;
  }

  col = mix( col, uMinor, minor * 0.9 );
  col = mix( col, uMajor, major );
  col += uSweep * sweep * ( 0.35 + 0.65 * max( minor, major ) );
  // …and then the kerb light spills back in over it. The broad, quiet falloff
  // survives the plan altitude; the physical cap below supplies the hard edge.
  col += uRim * exp( - max( edge, 0.0 ) / 52.0 ) * 1.05;

  gl_FragColor = vec4( col, 1.0 );
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
  dayColor: number
}

/** Everything that stands on the surface. 'storage' is underground, 'planner'
 *  is in the air, 'world' is the whole map — none of them get a platform. */
const PLINTHS: readonly PlinthSpec[] = [
  { district: 'clients', label: destinationForDistrict('clients')?.name ?? '', color: COLOR.client, dayColor: DAY_PALETTE.client },
  { district: 'backends', label: destinationForDistrict('backends')?.name ?? '', color: COLOR.backend, dayColor: DAY_PALETTE.backend },
  { district: 'shmem', label: destinationForDistrict('shmem')?.name ?? '', color: COLOR.shmem, dayColor: DAY_PALETTE.shmem },
  { district: 'wal', label: destinationForDistrict('wal')?.name ?? '', color: COLOR.wal, dayColor: DAY_PALETTE.wal },
  { district: 'maintenance', label: destinationForDistrict('maintenance')?.name ?? '', color: COLOR.vacuum, dayColor: DAY_PALETTE.vacuum },
  { district: 'replication', label: destinationForDistrict('replication')?.name ?? '', color: COLOR.replication, dayColor: DAY_PALETTE.replication },
]

const PLINTH_H = 0.6
const PLINTH_DROP = 0.5 // sink the slab below y=0 so it never z-fights the plate

/** Warm sodium, the colour of a building that is still occupied at night. */
const MAST_LAMP = 0xffca8a

/** Mast heights, tallest first — 'low' quality keeps only the first three. */
const MAST_HEIGHTS: readonly number[] = [66, 58, 62, 52, 50, 46]
/** How far in from the kerb a mast stands, and how far it must clear a district. */
const MAST_INSET = 70
const MAST_DISTRICT_CLEAR = 80

/**
 * Site the survey masts by walking the plate's own rim rather than by writing
 * down six coordinates. Masts exist to give the empty parts of the plate — the
 * brow, the ear, the long run of the trunk — something to read against, and
 * they must never land on a district or off the edge. Deriving them from the
 * outline means a redrawn outline moves them instead of stranding them.
 */
function siteMasts(ring: Float64Array, ccw: boolean, want: number): [number, number, number][] {
  const inward = offsetRing(ring, MAST_INSET, ccw)
  const n = inward.length / 2
  const out: [number, number, number][] = []
  const clearOfCity = (x: number, z: number): boolean => {
    for (const id of Object.keys(DISTRICT_BOUNDS)) {
      if (id === 'world') continue
      const b = DISTRICT_BOUNDS[id]
      const dx = Math.max(b.x[0] - x, 0, x - b.x[1])
      const dz = Math.max(b.z[0] - z, 0, z - b.z[1])
      if (Math.hypot(dx, dz) < MAST_DISTRICT_CLEAR) return false
    }
    return true
  }
  const stride = n / want
  for (let k = 0; k < want; k++) {
    for (let t = 0; t < Math.ceil(stride); t++) {
      const i = (Math.round(k * stride) + t) % n
      const x = inward[i * 2]
      const z = inward[i * 2 + 1]
      // The trunk is narrower than the inset, so an offset point can fall
      // outside its own plate; and two masts on one lobe read as a fence.
      if (clearance(ring, x, z) < MAST_INSET * 0.55) continue
      if (!clearOfCity(x, z)) continue
      if (out.some((m) => Math.hypot(m[0] - x, m[1] - z) < 200)) continue
      out.push([x, z, MAST_HEIGHTS[out.length % MAST_HEIGHTS.length]])
      break
    }
  }
  return out
}

/* --- the rim -------------------------------------------------------------- */

/** Slab thickness. Invisible from above, unmistakable from a low orbit. */
const SKIRT_DROP = 14
/** Kerb upstand. Chest height on a 1.8 m body — this is also the parapet. */
const KERB_H = 1.15
/** How far in from the true edge the kerb's inner face stands. At the plan
 * altitude 2.2 m was sub-pixel; this still reads as a kerb at street level but
 * gives the overview a dependable two-pixel cap. */
const KERB_W = 4.2
/** A very low outer spill separates the cap from the void without becoming a
 * neon outline. Two bands avoid asking a hardware-width line to fake a glow. */
const HALO_NEAR = 5
const HALO_FAR = 14
/** Samples per cubic along the outline. 17 cubics × 16 ≈ 15 m of kerb each. */
const RIM_SEG = 16
const RIM_SEG_LOW = 9
/** Metres encoded across the signed edge field. */
const EDGE_MAX = 96
/** Edge-field resolution across the plate's width. */
const EDGE_TEX_W = 128

/** x, z, base radius, height, colour — a light cone standing over each district. */
const CONES: readonly (readonly [number, number, number, number, number])[] = [
  [ANCHOR.walVault[0], ANCHOR.walVault[2], 34, 62, COLOR.wal],
  [ANCHOR.checkpointer[0], ANCHOR.checkpointer[2], 26, 50, COLOR.checkpoint],
  [ANCHOR.bgWriter[0], ANCHOR.bgWriter[2], 22, 44, COLOR.bgwriter],
  [ANCHOR.autovacLauncher[0], ANCHOR.autovacLauncher[2], 24, 46, COLOR.vacuum],
  [ANCHOR.postmaster[0], ANCHOR.postmaster[2], 30, 56, COLOR.postmaster],
  [ANCHOR.standby[0], ANCHOR.standby[2], 30, 54, COLOR.replication],
]

const cssHex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0')

/** Cool architectural white for the kerb light. Structure, not a Postgres fact. */
const RIM_LIGHT = mixHex(COLOR.gridBright, COLOR.ink, 0.58)

/* ---------------------------------------------------------------------------
 * Rim construction.
 * -------------------------------------------------------------------------*/

/**
 * Make the material read the scene fog at `plateFogK` of its true depth, so the
 * rim survives the same distances the slab does. Patched rather than switched
 * off: an edge light that ignores the fog entirely floats.
 */
function dampFog<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFogK = plateFogK
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_pars_vertex>',
      '#include <fog_pars_vertex>\nuniform float uFogK;',
    )
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      '#include <fog_vertex>\n#ifdef USE_FOG\n\tvFogDepth *= uFogK;\n#endif',
    )
  }
  m.customProgramCacheKey = () => 'pgc-rim-fog'
  return m
}

/**
 * A private, fog-damped copy of a shared theme material. The theme cache hands
 * the same object to everybody, so this clones before patching — and it is why
 * the district kerbs, the floor signage and the pit rim are still legible from
 * the overview shot 1.3 km up, where full fog would erase all three.
 */
function damped<T extends THREE.Material>(src: T): T {
  return dampFog(src.clone() as T)
}

/**
 * A closed quad strip between two rings held at two heights: `a[i]`@ya to
 * `b[i]`@yb. Non-indexed so computeVertexNormals() gives flat facets, which is
 * what a poured edge wants. Drawn DoubleSide, so the winding is free.
 */
function ribbon(a: Float64Array, ya: number, b: Float64Array, yb: number): THREE.BufferGeometry {
  const n = a.length / 2
  const pos = new Float32Array(n * 6 * 3)
  let w = 0
  const put = (r: Float64Array, i: number, y: number) => {
    pos[w++] = r[i]
    pos[w++] = y
    pos[w++] = r[i + 1]
  }
  for (let i = 0; i < n; i++) {
    const p = i * 2
    const q = ((i + 1) % n) * 2
    put(a, p, ya)
    put(b, p, yb)
    put(b, q, yb)
    put(a, p, ya)
    put(b, q, yb)
    put(a, q, ya)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/**
 * Bake distance-to-the-kerb into a one-channel texture, signed and biased so
 * that 0.5 is exactly the outline and bilinear filtering stays honest across
 * it. The fragment shader cannot evaluate a 272-segment outline per pixel; it
 * can afford one fetch.
 */
function bakeEdgeField(bounds: PlanBounds): THREE.DataTexture {
  const w = EDGE_TEX_W
  const spanX = bounds.x1 - bounds.x0
  const spanZ = bounds.z1 - bounds.z0
  const h = Math.max(16, Math.round((w * spanZ) / spanX))
  const data = new Uint8Array(w * h)
  // A coarse ring is plenty: this field is only ever read at tens of metres.
  const coarse = sampleOutline(6)
  for (let j = 0; j < h; j++) {
    const z = bounds.z0 + ((j + 0.5) / h) * spanZ
    for (let i = 0; i < w; i++) {
      const x = bounds.x0 + ((i + 0.5) / w) * spanX
      const sd = clearance(coarse, x, z)
      data[j * w + i] = Math.round(clamp01((sd / EDGE_MAX) * 0.5 + 0.5) * 255)
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.needsUpdate = true
  return tex
}

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

  // The outer boundary is the elephant. Everything else about the plate — the
  // excavation, the plinths, the decals — is unchanged; what changed is where
  // the ground stops.
  const shape = new THREE.Shape()
  writeShape(shape)

  // Shape space is XY; after the -90° rotation about X, +Y becomes world -Z.
  const hole = new THREE.Path()
  hole.moveTo(-CITY.pit.x, -CITY.pit.z)
  hole.lineTo(-CITY.pit.x, CITY.pit.z)
  hole.lineTo(CITY.pit.x, CITY.pit.z)
  hole.lineTo(CITY.pit.x, -CITY.pit.z)
  hole.closePath()
  shape.holes.push(hole)

  const plateGeo = new THREE.ShapeGeometry(shape, 12)
  geos.push(plateGeo)

  /* The same outline, sampled, for everything that is not the slab itself:
   * the kerb, the skirt, the edge light, the walker's parapet and the baked
   * distance field. One ring, one winding, so they can never disagree. */
  const ring = sampleOutline(quality.level === 'low' ? RIM_SEG_LOW : RIM_SEG)
  const ccw = ringArea2(ring) > 0
  const bounds = outlineBounds(ring)
  const edgeTex = bakeEdgeField(bounds)
  const surfaceStarted = performance.now()
  const surfaceTex = new THREE.DataTexture(
    createGroundSurfaceData(),
    GROUND_SURFACE_SIZE,
    GROUND_SURFACE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  )
  surfaceTex.name = 'ground.proceduralSurface'
  surfaceTex.wrapS = THREE.RepeatWrapping
  surfaceTex.wrapT = THREE.RepeatWrapping
  surfaceTex.minFilter = THREE.LinearMipmapLinearFilter
  surfaceTex.magFilter = THREE.LinearFilter
  surfaceTex.generateMipmaps = true
  surfaceTex.anisotropy = 4
  surfaceTex.needsUpdate = true
  const surfaceBootMs = performance.now() - surfaceStarted
  group.userData.surfaceTexture = {
    width: GROUND_SURFACE_SIZE,
    height: GROUND_SURFACE_SIZE,
    bytes: GROUND_SURFACE_SIZE * GROUND_SURFACE_SIZE * GROUND_SURFACE_CHANNELS,
    bytesWithMipmaps: Math.floor(
      GROUND_SURFACE_SIZE * GROUND_SURFACE_SIZE * GROUND_SURFACE_CHANNELS * (4 / 3),
    ),
    bootMs: surfaceBootMs,
  }

  const gridUniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uBase: { value: new THREE.Color(COLOR.ground) },
      uMinor: { value: new THREE.Color(COLOR.grid) },
      uMajor: { value: new THREE.Color(COLOR.gridBright) },
      uSweep: { value: new THREE.Color(mixHex(COLOR.gridBright, COLOR.backend, 0.55)) },
      uRim: { value: new THREE.Color(mixHex(0x000000, RIM_LIGHT, 0.72)) },
      uTime: { value: 0 },
      uSweepR: { value: 900 },
      uSurface: { value: surfaceTex },
      uSurfaceDetail: { value: 0 },
      uSurfaceResponse: { value: 0 },
      uSunDirection: {
        value: new THREE.Vector3(...ATMOSPHERE.day.keyPos)
          .sub(new THREE.Vector3(...ATMOSPHERE.day.keyTarget))
          .normalize(),
      },
      uSunColor: { value: new THREE.Color(ATMOSPHERE.day.keyColor) },
      uEdgeMax: { value: EDGE_MAX },
      uEdgeMap: {
        value: new THREE.Vector4(bounds.x0, bounds.z0, 1 / (bounds.x1 - bounds.x0), 1 / (bounds.z1 - bounds.z0)),
      },
      uEdge: { value: edgeTex },
    },
  ])
  // UniformsUtils.merge clones values, so both of these are handed over after:
  // the texture by reference, and the fog damping so the slab shares the one
  // live object the rim materials were patched with.
  ;(gridUniforms.uEdge as { value: THREE.Texture | null }).value = edgeTex
  ;(gridUniforms.uSurface as { value: THREE.Texture | null }).value = surfaceTex
  gridUniforms.uFogK = plateFogK
  const uTime = gridUniforms.uTime as { value: number }
  const uSurfaceDetail = gridUniforms.uSurfaceDetail as { value: number }
  const uSurfaceResponse = gridUniforms.uSurfaceResponse as { value: number }

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

  // The paving is deliberately a custom unlit shader, so it cannot receive
  // Three's shadow chunks. A transparent ShadowMaterial over the exact same cut
  // shape contributes only the sun shadow and leaves every grid line visible.
  const dayShadowMat = new THREE.ShadowMaterial({
    color: 0x28333d,
    transparent: true,
    opacity: 0.38,
    fog: true,
    // This repeats the plate silhouette exactly. Depth bias, not another tiny
    // Y nudge, keeps the two surfaces ordered at every camera distance.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
  dayShadowMat.name = 'ground.dayShadow'
  dayShadowMat.userData.pgTheme = true
  mats.push(dayShadowMat)
  const dayShadow = new THREE.Mesh(plateGeo, dayShadowMat)
  dayShadow.name = 'ground.dayShadow'
  dayShadow.rotation.x = -Math.PI / 2
  dayShadow.position.y = 0.035
  dayShadow.renderOrder = -3
  dayShadow.frustumCulled = false
  dayShadow.raycast = () => {}
  dayShadow.userData.pgDayOnly = true
  dayShadow.userData.pgNoShadow = true
  dayShadow.userData.pgShadowReceiver = true
  dayShadow.visible = false
  group.add(dayShadow)

  /* ---------------------------------------------------------------------
   * 1b. The rim: slab thickness, kerb, edge light, and a parapet a walker
   *     cannot step over. The city now stands on an island, and an island
   *     has to look and behave like one from every side.
   * -------------------------------------------------------------------*/

  const kerbInner = offsetRing(ring, KERB_W, ccw)

  const skirtGeo = ribbon(ring, 0, ring, -SKIRT_DROP) // the poured depth of the slab
  const kerbOutGeo = ribbon(ring, KERB_H, ring, 0) // the kerb's outer face
  const kerbTopGeo = ribbon(ring, KERB_H, kerbInner, KERB_H) // its capping
  const kerbInGeo = ribbon(kerbInner, KERB_H, kerbInner, 0) // and the face a walker meets
  geos.push(skirtGeo, kerbOutGeo, kerbTopGeo, kerbInGeo)

  const rimMat = dampFog(
    new THREE.MeshStandardMaterial({
      color: 0x111b2d,
      roughness: 0.94,
      metalness: 0.1,
      emissive: 0x080e1b,
      emissiveIntensity: 1.0,
      side: THREE.DoubleSide,
    }),
  )
  rimMat.name = 'ground.rim'
  mats.push(rimMat)

  // The kerb's capping is lit. 2.2 m of it reads as a hairline from the
  // overview and as a lit edge to walk along when you are standing on it.
  const kerbTopMat = dampFog(
    new THREE.MeshBasicMaterial({
      color: mixHex(0x000000, RIM_LIGHT, 0.84),
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  )
  kerbTopMat.name = 'ground.kerbTop'
  mats.push(kerbTopMat)

  for (const [g, m] of [
    [skirtGeo, rimMat],
    [kerbOutGeo, rimMat],
    [kerbTopGeo, kerbTopMat],
    [kerbInGeo, rimMat],
  ] as const) {
    const mesh = new THREE.Mesh(g, m)
    mesh.name = 'ground.rim'
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    group.add(mesh)
  }

  // The edge light. A line, not a strip: it is the one element that has to
  // survive at 1.3 km, where a 0.4 m band of geometry is a third of a pixel.
  // Same treatment as the pit rim, one stop dimmer — this edge is architecture,
  // not a Postgres fact.
  const edgePts = new Float32Array((ring.length / 2) * 3)
  for (let i = 0, w = 0; i < ring.length; i += 2) {
    edgePts[w++] = ring[i]
    edgePts[w++] = KERB_H + 0.03
    edgePts[w++] = ring[i + 1]
  }
  const edgeGeo = new THREE.BufferGeometry()
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePts, 3))
  geos.push(edgeGeo)
  const edgeMat = dampFog(
    new THREE.LineBasicMaterial({ color: RIM_LIGHT, transparent: true, opacity: 0.95, toneMapped: false }),
  )
  mats.push(edgeMat)
  const edgeLine = new THREE.LineLoop(edgeGeo, edgeMat)
  edgeLine.name = 'ground.edgeLight'
  edgeLine.frustumCulled = false
  edgeLine.renderOrder = 4
  edgeLine.raycast = () => {}
  group.add(edgeLine)

  // A restrained spill just outside the slab makes the silhouette separable
  // from a near-black clear colour. It is geometry-backed because WebGL line
  // width is fixed to one pixel on the browsers this project targets.
  const haloNearRing = offsetRing(ring, -HALO_NEAR, ccw)
  const haloFarRing = offsetRing(ring, -HALO_FAR, ccw)
  const haloNearGeo = ribbon(ring, -0.04, haloNearRing, -0.04)
  const haloFarGeo = ribbon(haloNearRing, -0.05, haloFarRing, -0.05)
  geos.push(haloNearGeo, haloFarGeo)
  const haloNearMat = dampFog(
    new THREE.MeshBasicMaterial({
      color: RIM_LIGHT,
      transparent: true,
      opacity: 0.11,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  )
  const haloFarMat = dampFog(
    new THREE.MeshBasicMaterial({
      color: RIM_LIGHT,
      transparent: true,
      opacity: 0.035,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  )
  mats.push(haloNearMat, haloFarMat)
  for (const [g, m] of [
    [haloFarGeo, haloFarMat],
    [haloNearGeo, haloNearMat],
  ] as const) {
    const halo = new THREE.Mesh(g, m)
    halo.name = 'ground.edgeHalo'
    halo.frustumCulled = false
    halo.renderOrder = -4
    halo.raycast = () => {}
    group.add(halo)
  }

  /* Solids for the pedestrian: one box per kerb segment. world.ground is on
   * collision.ts's exclude list (it is a *walkable*, not an obstacle), so these
   * are published here and handed to the collision world by main.ts instead. */
  const rimColliders: THREE.Box3[] = []
  {
    const n = kerbInner.length / 2
    for (let i = 0; i < n; i++) {
      const a = i * 2
      const b = ((i + 1) % n) * 2
      rimColliders.push(
        new THREE.Box3(
          new THREE.Vector3(Math.min(ring[a], kerbInner[b]) - 0.6, -0.5, Math.min(ring[a + 1], kerbInner[b + 1]) - 0.6),
          new THREE.Vector3(
            Math.max(ring[a], kerbInner[b]) + 0.6,
            KERB_H + 0.4,
            Math.max(ring[a + 1], kerbInner[b + 1]) + 0.6,
          ),
        ),
      )
    }
  }
  group.userData.rimColliders = rimColliders
  const collisionBoxes = [...rimColliders]
  group.userData.collisionBoxes = collisionBoxes
  /** Published so the plate's containment of every district can be *checked*. */
  group.userData.slonik = {
    ring,
    bounds,
    contains: (x: number, z: number) => contains(ring, x, z),
    clearance: (x: number, z: number) => clearance(ring, x, z),
  }

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
  const rimLineMat = damped(theme.line(COLOR.storage, 0.9))
  mats.push(rimLineMat)
  const rim = new THREE.LineLoop(rimGeo, rimLineMat)
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
  const bandMat = dampFog(
    new THREE.MeshBasicMaterial({
      color: COLOR.storage,
      transparent: true,
      opacity: 0.13,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  )
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
  // world.pit stays excluded because its combined bounds would pave over the
  // excavation. Publish the four zero-thickness rendered walls as honest thin
  // solids instead; their top is still low enough to enter from the rim.
  const wallT = 0.1
  collisionBoxes.push(
    new THREE.Box3(
      new THREE.Vector3(-px, pitFloorY, -pz - wallT / 2),
      new THREE.Vector3(px, 0, -pz + wallT / 2),
    ),
    new THREE.Box3(
      new THREE.Vector3(-px, pitFloorY, pz - wallT / 2),
      new THREE.Vector3(px, 0, pz + wallT / 2),
    ),
    new THREE.Box3(
      new THREE.Vector3(-px - wallT / 2, pitFloorY, -pz),
      new THREE.Vector3(-px + wallT / 2, 0, pz),
    ),
    new THREE.Box3(
      new THREE.Vector3(px - wallT / 2, pitFloorY, -pz),
      new THREE.Vector3(px + wallT / 2, 0, pz),
    ),
  )

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

  const slabMat = dampFog(
    new THREE.MeshStandardMaterial({
      color: 0x0c1322,
      roughness: 0.92,
      metalness: 0.12,
      emissive: 0x060a12,
      emissiveIntensity: 0.8,
    }),
  )
  slabMat.name = 'ground.plinth'
  mats.push(slabMat)

  function makeZoneMaterial(spec: PlinthSpec): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: spec.color,
      roughness: 0.96,
      metalness: 0,
      flatShading: true,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    m.name = `ground.zone.${spec.district}`
    // City-planning zone colours are saturated but printed on the same warm
    // stock. Fourteen percent stone keeps it architectural without
    // making neighboring quarters collapse into beige.
    m.userData.pgDayColor = mixHex(spec.dayColor, DAY_PALETTE.ground, 0.14)
    // Zoning is meaning painted on the ground; masonry joints do not belong on it.
    m.userData.pgNoSurface = true
    mats.push(m)
    return m
  }

  function addDayZone(spec: PlinthSpec, cx: number, cy: number, cz: number, w: number, d: number): void {
    const zone = new THREE.Mesh(unitPlane, makeZoneMaterial(spec))
    zone.name = `ground.zone.${spec.district}`
    zone.scale.set(w, d, 1)
    zone.rotation.x = -Math.PI / 2
    zone.position.set(cx, cy, cz)
    zone.raycast = () => {}
    zone.userData.pgDayOnly = true
    zone.userData.pgNoShadow = true
    zone.visible = false
    group.add(zone)
  }

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

    const m = dampFog(
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        // Labels are the top coat over slab, zone paint, and kerb.
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    )
    mats.push(m)
    const mesh = new THREE.Mesh(unitPlane, m)
    mesh.scale.set(w, h, 1)
    mesh.rotation.set(-Math.PI / 2, 0, along === 0 ? 0 : -Math.PI / 2)
    mesh.position.set(cx, cy, cz)
    mesh.renderOrder = 3
    mesh.raycast = () => {}
    group.add(mesh)
  }

  // The excavation rim marks the end of PostgreSQL's own address space, not
  // the end of RAM: the kernel page cache remains volatile below this cut.
  addDecal('POSTGRESQL ADDRESS SPACE ENDS HERE', COLOR.shmem, 0, 0.08, -CITY.pit.z - 5, 0, 180)
  addDecal('POSTGRESQL ADDRESS SPACE ENDS HERE', COLOR.shmem, 0, 0.08, CITY.pit.z + 5, 0, 180)

  for (const spec of PLINTHS) {
    const b = DISTRICT_BOUNDS[spec.district]
    if (!b) continue
    const inset: Rect = { x0: b.x[0] + 4, x1: b.x[1] - 4, z0: b.z[0] + 4, z1: b.z[1] - 4 }
    const r = clipToSolidGround(inset)

    if (!r) {
      // Shared memory has no ground under it — it is a deck floating over the
      // excavation. Lay its sign on the deck instead, clear of the buffer grid.
      addDayZone(spec, 0, CITY.deck.top + 0.025, 0, CITY.deck.w - 2, CITY.deck.d - 2)
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

    addDayZone(spec, cx, PLINTH_H + 0.025, cz, w - 2, d - 2)

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
    const kerbMat = damped(
      theme.neon(spec.color, 1.15, {
        // The kerb overlaps the daylight zone around the slab perimeter.
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    )
    mats.push(kerbMat)
    const kerbMesh = new THREE.Mesh(kerbGeo, kerbMat)
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

  const masts = siteMasts(ring, ccw, 6)
  const dressing = Math.min(masts.length, quality.level === 'low' ? 3 : masts.length)

  const mastMat = theme.mat('ground.mast', { color: 0x18233a, roughness: 0.75, metalness: 0.45 })
  /**
   * Warm, steady, and the same every frame. A distant tower reads as somewhere
   * people work; a tower that flashes reads as a hazard the sky is being warned
   * about, which is not what the outskirts of this city are for.
   */
  const lampMat = theme.neon(MAST_LAMP, 1.05)
  const crownGeo = new THREE.BoxGeometry(2.2, 1.1, 2.2)
  const floorGeo = new THREE.BoxGeometry(2.8, 0.5, 2.8)
  geos.push(crownGeo, floorGeo)
  const collisionSolids: THREE.Object3D[] = []

  for (let i = 0; i < dressing; i++) {
    const [mx, mz, mh] = masts[i]
    const mast = new THREE.Mesh(theme.cyl(0.3, 0.55, mh, 6), mastMat)
    mast.name = `ground.mast.${i}`
    mast.position.set(mx, mh / 2, mz)
    group.add(mast)
    collisionSolids.push(mast)

    // one lit floor near the top, one crown light — a building, not a beacon
    const lit = new THREE.Mesh(floorGeo, lampMat)
    lit.position.set(mx, mh * 0.72, mz)
    lit.raycast = () => {}
    group.add(lit)

    const crown = new THREE.Mesh(crownGeo, lampMat)
    crown.position.set(mx, mh + 0.4, mz)
    crown.raycast = () => {}
    group.add(crown)
  }
  group.userData.collisionSolids = collisionSolids

  const coneLayer = new THREE.Group()
  coneLayer.name = 'ground.lightCones'
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
    coneLayer.add(cone)
  }

  let coneLayerAttached = false
  function syncConeLayer(): void {
    const next = quality.level !== 'low' && quality.level !== 'reduced'
    if (next === coneLayerAttached) return
    coneLayerAttached = next
    if (next) group.add(coneLayer)
    else group.remove(coneLayer)
  }
  syncConeLayer()

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
    readout: worldGroundReadout,
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
    readout: worldPitReadout,
  })

  /* ---------------------------------------------------------------------
   * 6. Per-frame. Two uniform writes and a handful of opacity assignments.
   * -------------------------------------------------------------------*/

  let clock = 0
  let surfaceDetail = -1

  function update(dt: number, _sim: SimState, _t: number): void {
    syncConeLayer()
    const daylight = atmosphere().daylight
    const nextSurfaceDetail = groundSurfaceDetail(daylight ? 'day' : 'night', quality.level)
    if (nextSurfaceDetail !== surfaceDetail) {
      surfaceDetail = nextSurfaceDetail
      uSurfaceDetail.value = surfaceDetail
      uSurfaceResponse.value = daylight && surfaceDetail > 1 ? 1 : 0
    }
    // Ambient, not simulated: the survey sweep keeps running while the
    // simulation is paused so the model never looks dead. The mast lights do
    // not move at all — they are lit windows, and lit windows hold still.
    clock += dt
    uTime.value = clock
  }

  function dispose(): void {
    for (const g of geos) g.dispose()
    for (const m of mats) m.dispose()
    // The edge field is ours alone — the theme cache never saw it.
    edgeTex.dispose()
    surfaceTex.dispose()
    coneLayer.clear()
    group.clear()
  }

  return { id: 'ground', group, update, dispose }
}
