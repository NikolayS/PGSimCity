import * as THREE from 'three'
import { ANCHOR, DISTRICT_BOUNDS } from './layout'

/* ============================================================================
 * SLONIK — the shape of the ground PGSimCity stands on.
 *
 * The city is not reshaped. What is shaped is the *plate*: the poured slab the
 * districts are bolted to now ends in the outline of the PostgreSQL elephant.
 * Seen from an orbit it reads as an island in the void; seen straight down
 * (the `O` preset) it reads as the mark.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A DRAWING AND NOT THE OFFICIAL SVG
 *
 * The obvious move is to drop in the official Slonik path and transform it.
 * That was tried, rendered, and looked at, and it does not survive contact with
 * the city. The mark is a head seen near-front-on: a broad cranium, two ears,
 * two short tusks, a blunt trunk down the middle. Rigidly scaled until it
 * contains a footprint 830 m wide — the archive estate east, the recovery
 * ground south-west, the client terminal north — the trunk becomes a stub, the
 * two ears become two equal lobes, and from a kilometre up in a near-black
 * palette the plate reads as a molar. An unrecognisable logo is worse than
 * none, and it would still be somebody else's artwork embedded in the bundle.
 *
 * So this is a drawing, in the same language as the project's own mark in
 * public/favicon.svg: domed brow, temple dip, one big fanned ear, the notch
 * where the ear meets the cheek, and a long tapering trunk with a curl. It is
 * drawn to hold the city — the trunk is fat because the client terminal is
 * 300 m wide, the ear is huge because the recovery ground sits 130 m out — and
 * every departure from the official mark is in service of what stands on it.
 *
 * ---------------------------------------------------------------------------
 * THE FRAME
 *
 * The drawing is authored in "logo space" — x right, y up, exactly as the mark
 * is drawn — and mapped into the world plan by one rotation. The mapping was
 * chosen so the anatomy lands on the districts the city already has:
 *
 *      logo +x (the elephant's back, toward the ear)  ->  world south-west
 *      logo +y (the elephant's crown)                 ->  world south-east
 *
 * which puts
 *
 *      TRUNK      north, over the client terminal, the boundary fence and the
 *                 arrivals avenue — z -180 out to z ≈ -800, tapering to a curl
 *      EAR        south-west, the big rounded flap, over the HA quarter and the
 *                 recovery ground
 *      CROWN      south-east, over the standby and the backup vault
 *      BROW       east, the domed forehead, over the WAL district and the
 *                 archive estate
 *      JAW/CHEEK  west and centre, over the maintenance yard, the backend row,
 *                 the plaza and the excavation
 *
 * Because a top-down view maps world → screen with a fixed handedness, this is
 * the only family of orientations that draws the mark the right way round (face
 * to the left, trunk falling away from it) rather than mirrored. `PLAN_UP` is
 * the world direction the overview camera puts at the top of frame.
 *
 * ---------------------------------------------------------------------------
 * EDITING THE DRAWING
 *
 * `LOGO_PATH` is the whole design: a start point followed by cubic segments,
 * six numbers each (two control points, one anchor), read in the order the mark
 * is drawn — face, brow, crown, temple dip, ear, notch, jaw, trunk, curl, back
 * up the trunk to the face. Every district must stay inside it with margin, and
 * `auditContainment()` below asserts exactly that against the *live* layout at
 * module load, so a district that grows can never quietly end up over the void.
 * ==========================================================================*/

/** World metres per logo unit. */
const K = 17.5
/** Where the elephant's head centre sits in the world plan. */
const HX = 40
const HZ = 90

const S = Math.SQRT1_2

/**
 * The drawing, in logo space. Start point, then 17 cubic segments of
 * `c1x c1y c2x c2y x y`. Closed by the last segment returning to the start.
 */
const LOGO_START: readonly [number, number] = [-27.0, -21.0]
const LOGO_PATH: readonly (readonly number[])[] = [
  // the face front, and the brow ridge above it
  [-27.4, -12.0, -28.9, -2.0, -29.0, 6.0],
  // the domed forehead
  [-29.3, 15.0, -26.5, 21.5, -19.5, 24.5],
  // over the crown
  [-14.5, 27.5, -10.0, 29.1, -5.0, 28.8],
  // the temple dip, between forehead and ear
  [0.0, 28.6, 2.5, 26.7, 4.0, 25.0],
  // the ear, rising
  [8.0, 22.5, 13.5, 27.6, 19.5, 29.0],
  // the ear's outer sweep
  [30.5, 31.2, 39.0, 18.5, 37.0, 4.0],
  [36.8, -7.0, 35.0, -14.2, 31.2, -18.4],
  // the bottom of the ear — pushed out to hold the recovery ground, which is
  // the tightest thing on the whole plate
  [29.4, -20.4, 28.0, -21.8, 26.0, -22.4],
  // …and back up into the notch where the ear meets the cheek
  [23.4, -21.0, 21.3, -17.4, 19.8, -14.6],
  // the jaw
  [18.4, -18.4, 10.5, -20.8, 5.0, -22.4],
  // the corner where the trunk leaves the jaw
  [1.5, -23.2, -1.2, -23.0, -3.4, -22.4],
  // the trunk, front edge, tapering
  [-7.2, -26.0, -11.8, -29.0, -17.0, -31.0],
  [-21.2, -32.8, -25.4, -34.6, -29.5, -36.3],
  // round the tip
  [-33.2, -38.0, -36.8, -36.8, -37.6, -33.4],
  // the curl, hooking back on itself
  [-38.1, -31.4, -38.7, -29.4, -37.4, -28.4],
  [-35.4, -27.9, -33.6, -30.0, -32.8, -32.4],
  // the trunk's back edge, up to the face
  [-31.3, -30.1, -28.8, -25.3, -27.0, -21.0],
]

/** Logo space → world plan. */
export function logoToWorld(xe: number, ye: number): [number, number] {
  return [HX + K * S * (ye - xe), HZ + K * S * (xe + ye)]
}

/**
 * The world direction that belongs at the top of frame in the overview shot.
 * It is the elephant's own "up" — world south-east.
 */
export const PLAN_UP: readonly [number, number] = [S, S]

/** One cubic segment of the outline, in world plan coordinates. */
export interface PlanCurve {
  c1: [number, number]
  c2: [number, number]
  to: [number, number]
}

/** The outline as world-space cubics, starting from `PLAN_START`. */
export const PLAN_START: [number, number] = logoToWorld(LOGO_START[0], LOGO_START[1])
export const PLAN_CURVES: readonly PlanCurve[] = LOGO_PATH.map((c) => ({
  c1: logoToWorld(c[0], c[1]),
  c2: logoToWorld(c[2], c[3]),
  to: logoToWorld(c[4], c[5]),
}))

/* --------------------------------------------------------------------------
 * Sampling.
 * ------------------------------------------------------------------------*/

/**
 * The closed outline as a flat `[x0, z0, x1, z1, …]` ring in world plan
 * coordinates, `seg` samples per cubic. The start point is included once; the
 * ring is not repeated at the end.
 */
export function sampleOutline(seg = 16): Float64Array {
  const out = new Float64Array(PLAN_CURVES.length * seg * 2)
  let px = PLAN_START[0]
  let pz = PLAN_START[1]
  out[0] = px
  out[1] = pz
  let w = 2
  for (let ci = 0; ci < PLAN_CURVES.length; ci++) {
    const c = PLAN_CURVES[ci]
    // The final segment lands back on the start point: stop one short of it.
    const last = ci === PLAN_CURVES.length - 1 ? seg - 1 : seg
    for (let i = 1; i <= last; i++) {
      const t = i / seg
      const u = 1 - t
      const a = u * u * u
      const b = 3 * u * u * t
      const d = 3 * u * t * t
      const e = t * t * t
      out[w++] = a * px + b * c.c1[0] + d * c.c2[0] + e * c.to[0]
      out[w++] = a * pz + b * c.c1[1] + d * c.c2[1] + e * c.to[1]
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
 * Queries. Used by the containment audit and by the edge-distance field.
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
 * THE CONTAINMENT AUDIT
 *
 * The hard constraint of the whole exercise: every district stands on the
 * plate. This checks it against the live layout, not against a copy of it, so
 * widening a footprint in layout.ts cannot quietly leave a corner of it hanging
 * over the void. It runs once, at module load, and costs about a millisecond.
 * ------------------------------------------------------------------------*/

/** Metres of plate a footprint must have between it and the kerb. */
const REQUIRED_CLEARANCE = 18

/**
 * Continuity works are anchor points, not boxes — layout.ts gives them no
 * bounds — so each is checked as a square of this half-width. 26 m covers what
 * world/continuity.ts actually builds around an anchor; measured against the
 * live scene the widest of them reaches about 22 m from its anchor.
 */
const ANCHOR_RADIUS = 26
const CONTINUITY_ANCHORS = [
  'archiveGate',
  'timelineYard',
  'objectStore',
  'backupVault',
  'backupHost',
  'recoveryGate',
  'recoveryPad',
  'restoreWinch',
  'recoveryClock',
  'recoveryReplay',
  'rejoinBay',
  'endpoint',
  'consensus',
  'leaseNode1',
  'leaseNode2',
  'leaseNode3',
  'standbyB',
  'standbyBDeck',
  'standbyBRecv',
] as const

export interface SlonikContainment {
  readonly requiredClearance: number
  /** Union of every district footprint and continuity anchor, in world plan. */
  readonly union: PlanBounds
  /** Extent of the plate itself. */
  readonly bounds: PlanBounds
  readonly districtMinimum: number
  readonly districtAtMinimum: string
  readonly anchorMinimum: number
  readonly anchorAtMinimum: string
  readonly ok: boolean
}

function auditContainment(): SlonikContainment {
  const ring = sampleOutline(40)
  const union: PlanBounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  let districtMinimum = Infinity
  let districtAtMinimum = ''

  for (const id of Object.keys(DISTRICT_BOUNDS)) {
    // 'world' is the minimap's extent, not a physical footprint: it is defined
    // as the whole map, so nothing can be inside it but itself.
    if (id === 'world') continue
    const b = DISTRICT_BOUNDS[id]
    union.x0 = Math.min(union.x0, b.x[0])
    union.x1 = Math.max(union.x1, b.x[1])
    union.z0 = Math.min(union.z0, b.z[0])
    union.z1 = Math.max(union.z1, b.z[1])
    const c = rectClearance(ring, b.x[0], b.x[1], b.z[0], b.z[1], 64)
    if (c < districtMinimum) {
      districtMinimum = c
      districtAtMinimum = id
    }
  }

  let anchorMinimum = Infinity
  let anchorAtMinimum = ''
  for (const id of CONTINUITY_ANCHORS) {
    const [x, , z] = ANCHOR[id]
    union.x0 = Math.min(union.x0, x - ANCHOR_RADIUS)
    union.x1 = Math.max(union.x1, x + ANCHOR_RADIUS)
    union.z0 = Math.min(union.z0, z - ANCHOR_RADIUS)
    union.z1 = Math.max(union.z1, z + ANCHOR_RADIUS)
    const c = rectClearance(ring, x - ANCHOR_RADIUS, x + ANCHOR_RADIUS, z - ANCHOR_RADIUS, z + ANCHOR_RADIUS, 16)
    if (c < anchorMinimum) {
      anchorMinimum = c
      anchorAtMinimum = id
    }
  }

  const ok = districtMinimum >= REQUIRED_CLEARANCE && anchorMinimum >= REQUIRED_CLEARANCE
  if (!ok) {
    const msg =
      `[PGSimCity] the plate no longer holds the city: district ${districtAtMinimum} clears ` +
      `${districtMinimum.toFixed(1)} m, continuity anchor ${anchorAtMinimum} clears ` +
      `${anchorMinimum.toFixed(1)} m, and ${REQUIRED_CLEARANCE} m is required. ` +
      `Widen the outline in world/slonik.ts — do not clip the district.`
    // Loud where the outline is being edited; survivable in a deployed build,
    // where the alternative is a blank page for every visitor because somebody
    // widened a district by five metres.
    if (import.meta.env.DEV) throw new Error(msg)
    console.error(msg)
  }

  return {
    requiredClearance: REQUIRED_CLEARANCE,
    union,
    bounds: outlineBounds(ring),
    districtMinimum,
    districtAtMinimum,
    anchorMinimum,
    anchorAtMinimum,
    ok,
  }
}

export const SLONIK_CONTAINMENT: SlonikContainment = auditContainment()

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
    shape.bezierCurveTo(c.c1[0], -c.c1[1], c.c2[0], -c.c2[1], c.to[0], -c.to[1])
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
