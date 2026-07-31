import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { ANCHOR, DISTRICT_BOUNDS } from './layout'

/* ============================================================================
 * SLONIK — the shape of the ground PGSimCity stands on.
 *
 * The city is not reshaped. What is shaped is the *plate*: the poured slab the
 * districts are bolted to now ends in the outline of the PostgreSQL elephant.
 * Seen from an orbit it reads as an island in the void; seen straight down
 * (the `O` preset) it reads as the logo.
 *
 * ---------------------------------------------------------------------------
 * THE ARTWORK
 *
 * `LOGO_OUTLINE_D` is not a hand drawing. It is the blue fill path copied from
 * Daniel Lundin's genuine PostgreSQL elephant SVG:
 *
 *   https://upload.wikimedia.org/wikipedia/commons/2/29/Postgresql_elephant.svg
 *
 * fetched 2026-07-26, SHA-256
 * 51f93e19516081fc7d6fe6ab9bbab07abe5f7819e28016eefacea6dea691bc54.
 * The Commons file identifies Daniel Lundin as the author, PostgreSQL Global
 * Development Group as copyright holder, and the PostgreSQL 3-clause licence
 * as its redistribution terms. Slonik is also a PostgreSQL Community
 * Association of Canada trademark; this use makes no claim of endorsement.
 *
 * The source SVG contains white strokes, eyes, tusk and other interior paths.
 * They are deliberately absent here: this is the single closed blue fill path,
 * i.e. the outer silhouette only.
 *
 * three.js r0.185.1's SVGLoader.parse() returns ShapePath objects in `.paths`;
 * ShapePath.toShapes() is the current API (SVGLoader.createShapes is deprecated
 * in r185). Parsing happens once at module initialisation. There is no fetch at
 * runtime: the static bundle contains the path below.
 *
 * THE PLAN TRANSFORM
 *
 * SVG x is kept rightward and SVG y-down is flipped to world north (-Z), then
 * the mark is rigidly rotated -0.4 rad in (x,z), uniformly scaled by 2.6, and
 * translated (-340,+690). It is NOT mirrored or stretched. Thus the trunk runs
 * north/north-west across the client terminal, the head and ears sit south over
 * the standby/HA/recovery districts, and the broad face covers the main city.
 * ==========================================================================*/

/**
 * Outer blue fill path from the genuine SVG cited above. Keep this byte-for-byte
 * vector data rather than replacing it with hand-authored control points.
 */
export const LOGO_OUTLINE_D =
  'M402.395,271.23c-50.302,10.376-53.76-6.655-53.76-6.655c53.111-78.808,75.313-178.843,56.153-203.326c-52.27-66.785-142.752-35.2-144.262-34.38l-0.486,0.087c-9.938-2.063-21.06-3.292-33.56-3.496c-22.761-0.373-40.026,5.967-53.127,15.902c0,0-161.411-66.495-153.904,83.63c1.597,31.938,45.776,241.657,98.471,178.312c19.26-23.163,37.869-42.748,37.869-42.748c9.243,6.14,20.308,9.272,31.908,8.147l0.901-0.765c-0.28,2.876-0.152,5.689,0.361,9.019c-13.575,15.167-9.586,17.83-36.723,23.416c-27.459,5.659-11.328,15.734-0.796,18.367c12.768,3.193,42.307,7.716,62.266-20.224l-0.796,3.188c5.319,4.26,9.054,27.711,8.428,48.969c-0.626,21.259-1.044,35.854,3.147,47.254c4.191,11.4,8.368,37.05,44.042,29.406c29.809-6.388,45.256-22.942,47.405-50.555c1.525-19.631,4.976-16.729,5.194-34.28l2.768-8.309c3.192-26.611,0.507-35.196,18.872-31.203l4.463,0.392c13.517,0.615,31.208-2.174,41.591-7c22.358-10.376,35.618-27.7,13.573-23.148z'

const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg"><path d="${LOGO_OUTLINE_D}"/></svg>`
const SOURCE_SCALE = 2.6
const SOURCE_ANGLE = -0.4
const SOURCE_COS = Math.cos(SOURCE_ANGLE)
const SOURCE_SIN = Math.sin(SOURCE_ANGLE)
const SOURCE_TX = -340
const SOURCE_TZ = 690

/** Original SVG coordinates → world plan; a uniform rigid transform. */
function sourceToWorld(x: number, y: number): [number, number] {
  return [
    SOURCE_TX + SOURCE_SCALE * (x * SOURCE_COS + y * SOURCE_SIN),
    SOURCE_TZ + SOURCE_SCALE * (x * SOURCE_SIN - y * SOURCE_COS),
  ]
}

/**
 * Normalised logo space → world plan. Ground dressing uses this small,
 * source-independent coordinate frame; the plate itself uses sourceToWorld().
 */
export function logoToWorld(xe: number, ye: number): [number, number] {
  const k = 5.3
  return [
    k * (xe * SOURCE_COS - ye * SOURCE_SIN),
    k * (xe * SOURCE_SIN + ye * SOURCE_COS),
  ]
}

/**
 * The world direction that belongs at the top of frame in the overview shot.
 * It is source SVG up (toward the ears), mapped into the world south-east.
 */
export const PLAN_UP: readonly [number, number] = [-SOURCE_SIN, SOURCE_COS]

/** One genuine SVG segment transformed into world plan coordinates. */
export type PlanCurve =
  | { readonly kind: 'line'; readonly to: [number, number] }
  | {
      readonly kind: 'cubic'
      readonly c1: [number, number]
      readonly c2: [number, number]
      readonly to: [number, number]
    }

const parsed = new SVGLoader().parse(SVG_TEXT)
const sourceShapes = parsed.paths[0]?.toShapes() ?? []
if (parsed.paths.length !== 1 || sourceShapes.length !== 1) {
  throw new Error(`Slonik outline: expected one SVG path/shape, got ${parsed.paths.length}/${sourceShapes.length}`)
}
const sourceShape = sourceShapes[0]
const firstCurve = sourceShape.curves[0]
if (!(firstCurve instanceof THREE.LineCurve) && !(firstCurve instanceof THREE.CubicBezierCurve)) {
  throw new Error('Slonik outline: unsupported first SVG curve')
}
const firstPoint = firstCurve instanceof THREE.LineCurve ? firstCurve.v1 : firstCurve.v0

/** The outline as world-space SVG segments, starting from `PLAN_START`. */
export const PLAN_START: [number, number] = sourceToWorld(firstPoint.x, firstPoint.y)
export const PLAN_CURVES: readonly PlanCurve[] = sourceShape.curves.map((curve): PlanCurve => {
  if (curve instanceof THREE.LineCurve) {
    return { kind: 'line', to: sourceToWorld(curve.v2.x, curve.v2.y) }
  }
  if (curve instanceof THREE.CubicBezierCurve) {
    return {
      kind: 'cubic',
      c1: sourceToWorld(curve.v1.x, curve.v1.y),
      c2: sourceToWorld(curve.v2.x, curve.v2.y),
      to: sourceToWorld(curve.v3.x, curve.v3.y),
    }
  }
  throw new Error(`Slonik outline: unsupported SVG curve ${curve.type}`)
})

/* --------------------------------------------------------------------------
 * Sampling.
 * ------------------------------------------------------------------------*/

/**
 * The closed outline as a flat `[x0, z0, x1, z1, …]` ring in world plan
 * coordinates, `seg` samples per cubic. The start point is included once; the
 * ring is not repeated at the end.
 */
export function sampleOutline(seg = 16): Float64Array {
  const final = PLAN_CURVES[PLAN_CURVES.length - 1].to
  const closesItself = Math.hypot(final[0] - PLAN_START[0], final[1] - PLAN_START[1]) < 1e-7
  const pointCount = PLAN_CURVES.length * seg + (closesItself ? 0 : 1)
  const out = new Float64Array(pointCount * 2)
  let px = PLAN_START[0]
  let pz = PLAN_START[1]
  out[0] = px
  out[1] = pz
  let w = 2
  for (let ci = 0; ci < PLAN_CURVES.length; ci++) {
    const c = PLAN_CURVES[ci]
    // Do not duplicate the first point when an SVG happens to close explicitly.
    const last = ci === PLAN_CURVES.length - 1 && closesItself ? seg - 1 : seg
    for (let i = 1; i <= last; i++) {
      const t = i / seg
      if (c.kind === 'line') {
        out[w++] = px + (c.to[0] - px) * t
        out[w++] = pz + (c.to[1] - pz) * t
      } else {
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const d = 3 * u * t * t
        const e = t * t * t
        out[w++] = a * px + b * c.c1[0] + d * c.c2[0] + e * c.to[0]
        out[w++] = a * pz + b * c.c1[1] + d * c.c2[1] + e * c.to[1]
      }
    }
    px = c.to[0]
    pz = c.to[1]
  }
  return out
}

/** Axis-aligned world extent of the plate. */
export interface PlanBounds {
  x0: number
  x1: number
  z0: number
  z1: number
}

export function outlineBounds(ring: Float64Array): PlanBounds {
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    const x = ring[i]
    const z = ring[i + 1]
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return { x0, x1, z0, z1 }
}

/** Signed doubled area. Positive means counter-clockwise in (x, z). */
export function ringArea2(ring: Float64Array): number {
  let a = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    a += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  }
  return a
}

/* --------------------------------------------------------------------------
 * Queries. Used by the containment check and by the edge-distance field.
 * ------------------------------------------------------------------------*/

/** Crossing-number test against a sampled ring. */
export function contains(ring: Float64Array, x: number, z: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const zi = ring[i + 1]
    const zj = ring[j + 1]
    if (zi > z !== zj > z) {
      const t = (z - zi) / (zj - zi)
      if (x < ring[i] + t * (ring[j] - ring[i])) inside = !inside
    }
  }
  return inside
}

/** Unsigned distance from (x, z) to the outline, in metres. */
export function distanceToEdge(ring: Float64Array, x: number, z: number): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[j]
    const az = ring[j + 1]
    const dx = ring[i] - ax
    const dz = ring[i + 1] - az
    const l2 = dx * dx + dz * dz
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = x - (ax + t * dx)
    const ez = z - (az + t * dz)
    const d = ex * ex + ez * ez
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/** Positive inside the plate, negative outside. Metres. */
export function clearance(ring: Float64Array, x: number, z: number): number {
  const d = distanceToEdge(ring, x, z)
  return contains(ring, x, z) ? d : -d
}

/**
 * Smallest clearance anywhere on the perimeter of an axis-aligned district
 * footprint. Negative means part of the district hangs over the void.
 */
export function rectClearance(
  ring: Float64Array,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  samples = 24,
): number {
  let worst = Infinity
  for (let i = 0; i <= samples; i++) {
    const f = i / samples
    const x = x0 + (x1 - x0) * f
    const z = z0 + (z1 - z0) * f
    worst = Math.min(
      worst,
      clearance(ring, x, z0),
      clearance(ring, x, z1),
      clearance(ring, x0, z),
      clearance(ring, x1, z),
    )
  }
  return worst
}

/* --------------------------------------------------------------------------
 * Static containment audit.
 * ------------------------------------------------------------------------*/

/** Eight metres keeps district plinths comfortably inside the 2.2 m kerb. */
const REQUIRED_CLEARANCE = 8
const CONTINUITY_ANCHORS = [
  'archiveGate',
  'timelineYard',
  'objectStore',
  'backupVault',
  'recoveryGate',
  'recoveryPad',
  'restoreWinch',
  'recoveryClock',
  'recoveryReplay',
  'rejoinBay',
  'endpoint',
  'consensus',
  'haPrimarySite',
  'haStandbyASite',
  'haStandbyBSite',
  'patroniNode1',
  'patroniNode2',
  'patroniNode3',
  'leaseNode1',
  'leaseNode2',
  'leaseNode3',
  'standbyB',
  'standbyBDeck',
  'standbyBRecv',
] as const

export interface SlonikContainmentAudit {
  readonly requiredClearance: number
  readonly union: PlanBounds
  readonly districtMinimum: number
  readonly districtAtMinimum: string
  readonly anchorMinimum: number
  readonly anchorAtMinimum: (typeof CONTINUITY_ANCHORS)[number]
}

/**
 * Verify the live layout, not a stale hand-copied box. `world` is intentionally
 * excluded: layout.ts defines it as the whole minimap, not a physical district.
 * This runs once when the static world module loads and fails loudly if layout
 * changes ever push a district or continuity work over the kerb.
 */
function auditContainment(): SlonikContainmentAudit {
  const ring = sampleOutline(48)
  const union: PlanBounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  let districtMinimum = Infinity
  let districtAtMinimum = ''

  for (const [id, bounds] of Object.entries(DISTRICT_BOUNDS)) {
    if (id === 'world') continue
    union.x0 = Math.min(union.x0, bounds.x[0])
    union.x1 = Math.max(union.x1, bounds.x[1])
    union.z0 = Math.min(union.z0, bounds.z[0])
    union.z1 = Math.max(union.z1, bounds.z[1])
    const c = rectClearance(ring, bounds.x[0], bounds.x[1], bounds.z[0], bounds.z[1], 96)
    if (c < districtMinimum) {
      districtMinimum = c
      districtAtMinimum = id
    }
  }

  let anchorMinimum = Infinity
  let anchorAtMinimum: (typeof CONTINUITY_ANCHORS)[number] = CONTINUITY_ANCHORS[0]
  for (const id of CONTINUITY_ANCHORS) {
    const [x, , z] = ANCHOR[id]
    union.x0 = Math.min(union.x0, x)
    union.x1 = Math.max(union.x1, x)
    union.z0 = Math.min(union.z0, z)
    union.z1 = Math.max(union.z1, z)
    const c = clearance(ring, x, z)
    if (c < anchorMinimum) {
      anchorMinimum = c
      anchorAtMinimum = id
    }
  }

  if (districtMinimum < REQUIRED_CLEARANCE || anchorMinimum < REQUIRED_CLEARANCE) {
    throw new Error(
      `Slonik containment failed: district ${districtAtMinimum}=${districtMinimum.toFixed(2)} m, ` +
        `anchor ${anchorAtMinimum}=${anchorMinimum.toFixed(2)} m; required ${REQUIRED_CLEARANCE} m`,
    )
  }

  return {
    requiredClearance: REQUIRED_CLEARANCE,
    union,
    districtMinimum,
    districtAtMinimum,
    anchorMinimum,
    anchorAtMinimum,
  }
}

export const SLONIK_CONTAINMENT = auditContainment()

/* --------------------------------------------------------------------------
 * Geometry helpers.
 * ------------------------------------------------------------------------*/

/**
 * Lay the outline into a THREE.Shape. Shape space is XY and the plate is laid
 * down with a -90° rotation about X, so shape Y is world -Z.
 */
export function writeShape(shape: THREE.Shape): void {
  shape.moveTo(PLAN_START[0], -PLAN_START[1])
  for (const c of PLAN_CURVES) {
    if (c.kind === 'line') {
      shape.lineTo(c.to[0], -c.to[1])
    } else {
      shape.bezierCurveTo(c.c1[0], -c.c1[1], c.c2[0], -c.c2[1], c.to[0], -c.to[1])
    }
  }
  shape.closePath()
}

/**
 * Offset a ring inward by `d` metres, as a new flat ring. Vertex normals are
 * the average of the two adjacent edge normals, which is exact for a straight
 * run and good enough for a curve sampled this finely. `ccw` must say which way
 * the ring winds so "inward" means inward.
 */
export function offsetRing(ring: Float64Array, d: number, ccw: boolean): Float64Array {
  const n = ring.length / 2
  const out = new Float64Array(ring.length)
  const s = ccw ? 1 : -1
  for (let i = 0; i < n; i++) {
    const p = i * 2
    const prev = ((i - 1 + n) % n) * 2
    const next = ((i + 1) % n) * 2
    // Rotating an edge by +90° points inward for a ring that winds CCW in (x, z).
    let nx = 0
    let nz = 0
    for (let e = 0; e < 2; e++) {
      const a = e === 0 ? prev : p
      const b = e === 0 ? p : next
      const ex = ring[b] - ring[a]
      const ez = ring[b + 1] - ring[a + 1]
      const l = Math.hypot(ex, ez) || 1
      nx += (-ez / l) * s
      nz += (ex / l) * s
    }
    const l = Math.hypot(nx, nz) || 1
    out[p] = ring[p] + (nx / l) * d
    out[p + 1] = ring[p + 1] + (nz / l) * d
  }
  return out
}
