import * as THREE from 'three'
import type { Bus, FlowKind, FlowRequest, QualitySettings, ThemeApi } from '../core/types'
import { ROUTES, routeCurve } from '../world/layout'
import { makeRng, reduceMotion } from '../core/util'

/* ============================================================================
 * FLOWS — every moving packet in the city.
 *
 * A query arriving at a backend, an 8 KiB page climbing out of storage, a WAL
 * record heading east to the vault, a dead tuple riding to the landfill: all of
 * them are one instance of one InstancedMesh travelling along one route.
 *
 * Hard rules that shape this file:
 *   - one draw call for the whole city's traffic;
 *   - a fixed pool with a free list, so a traffic spike costs nothing new;
 *   - zero allocation in update(): every Vector3/Quaternion/Matrix4 is hoisted;
 *   - routes are baked to a polyline once. CatmullRomCurve3.getPointAt() walks
 *     an arc-length LUT and allocates internally — calling it thousands of
 *     times per frame is not survivable, so we sample 96 points up front and
 *     lerp between them.
 * ==========================================================================*/

/** Polyline resolution per route. 96 segments is smooth at city scale. */
const SAMPLES = 96
/** Staggered emissions waiting for their turn. Oldest is dropped on overflow. */
const PENDING_CAP = 512
/** Multiplier on the pod's own 0.92 x 0.72 body for a size-1 packet. */
const PACKET_SCALE = 1.8
/**
 * Instance colours are pushed past 1.0 so they clear the bloom threshold
 * (0.85, see engine/renderer.ts). Structure never glows; data always does.
 */
const COLOR_GAIN = 2.0
const FADE_IN = 0.05
const FADE_OUT = 0.12
/** Sanity clamp: nobody gets to ask for ten thousand packets in one call. */
const MAX_BURST = 256

/* Packet silhouette per FlowKind. Meaning is carried by *bulk*, never by
 * elongation: a page is a wide pallet, a stat ping is a small crate. No kind is
 * allowed a length-to-width ratio above the pod's own 1.28, so nothing on any
 * route can read as a dart no matter how fast it is travelling. */
const KIND_ORDER: readonly FlowKind[] = [
  'query',
  'result',
  'page_read',
  'page_write',
  'wal',
  'wal_flush',
  'archive',
  'stream',
  'ack',
  'dead',
  'fork',
  'stat',
]
/** Index 12 is the "no kind given" default. */
const KIND_DEFAULT = KIND_ORDER.length
const KIND_W = Float32Array.from([1.05, 1.0, 1.4, 1.4, 1.0, 1.1, 1.2, 1.0, 0.75, 1.25, 1.1, 0.7, 1.0])
const KIND_L = Float32Array.from([0.95, 0.92, 1.05, 1.05, 1.0, 1.05, 1.0, 1.0, 0.7, 0.9, 0.95, 0.65, 1.0])
const KIND_INDEX = new Map<string, number>()
for (let i = 0; i < KIND_ORDER.length; i++) KIND_INDEX.set(KIND_ORDER[i], i)

/* ---------------------------------------------------------------------------
 * Baked routes.
 * -------------------------------------------------------------------------*/

interface RouteBake {
  /** (SAMPLES+1)*3 world positions */
  pts: Float32Array
  /** unit tangents at each sample */
  tan: Float32Array
  /** horizontal perpendicular — lateral lane offset */
  bin: Float32Array
  /** the third axis — vertical-ish lane offset */
  nor: Float32Array
  /** cumulative arc length, cum[0] = 0 */
  cum: Float32Array
  length: number
  color: number
  speed: number
  size: number
}

const UP = new THREE.Vector3(0, 1, 0)
const SIDE = new THREE.Vector3(1, 0, 0)
const FORWARD = new THREE.Vector3(0, 0, 1)

/* Module-scope scratch. Nothing below allocates once the pool is built. */
const _p0 = new THREE.Vector3()
const _p1 = new THREE.Vector3()
const _t0 = new THREE.Vector3()
const _b0 = new THREE.Vector3()
const _n0 = new THREE.Vector3()
const _pos = new THREE.Vector3()
const _tan = new THREE.Vector3()
const _bin = new THREE.Vector3()
const _nor = new THREE.Vector3()
const _scl = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _mat = new THREE.Matrix4()
const _col = new THREE.Color()

/** Largest i with cum[i] <= d, clamped so i+1 is always a valid sample. */
function segFor(cum: Float32Array, d: number): number {
  let lo = 0
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid - 1
  }
  return lo > cum.length - 2 ? cum.length - 2 : lo
}

/**
 * The freight pod: a chamfered 4-sided body 0.92 long on +Z and 0.72 across,
 * so it is very nearly as fat as it is long. 18 vertices, 32 triangles.
 *
 * This shape is load-bearing. The packet used to be a tapered dart oriented
 * along travel and stretched by speed, which at commit rates drew a 5-unit
 * streak — and a lit streak crossing the sky over a city at night is a tracer
 * round, whatever the label on it says. A pod cannot make that picture. It
 * still points along the tangent, so motion stays purposeful, but the
 * silhouette is cargo: something being carried somewhere on purpose.
 *
 * Vertex colour dims the two end caps, which gives the body a lit-carriage
 * read up close and costs nothing — the instance colour still supplies the hue.
 */
function packetGeometry(): THREE.BufferGeometry {
  const r = 0.36 // body radius
  const rc = 0.21 // chamfered end radius
  const zb = 0.26 // where the body stops and the chamfer starts
  const zc = 0.46 // the very end

  const pos: number[] = []
  const col: number[] = []
  /** One 4-vertex ring on the +X/+Y/-X/-Y axes. */
  const ring = (z: number, rad: number, bright: number): void => {
    pos.push(rad, 0, z, 0, rad, z, -rad, 0, z, 0, -rad, z)
    for (let i = 0; i < 4; i++) col.push(bright, bright, bright)
  }
  ring(-zc, rc, 0.45) // 0..3   back rim
  ring(-zb, r, 1) // 4..7   body
  ring(zb, r, 1) // 8..11  body
  ring(zc, rc, 0.45) // 12..15 front rim
  pos.push(0, 0, -zc, 0, 0, zc) // 16, 17 cap centres
  col.push(0.4, 0.4, 0.4, 0.4, 0.4, 0.4)

  const idx: number[] = []
  // Three bands. (A_k, A_k+1, B_k+1) faces outward when B is further along +Z.
  for (let band = 0; band < 3; band++) {
    const a = band * 4
    const b = a + 4
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4
      idx.push(a + k, a + k1, b + k1)
      idx.push(a + k, b + k1, b + k)
    }
  }
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4
    idx.push(16, k1, k) // back cap, normal -Z
    idx.push(17, 12 + k, 12 + k1) // front cap, normal +Z
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  // vertexColors is on, so the shader reads `color`: the per-instance colour
  // supplies the hue and this only shades the ends down.
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeBoundingSphere()
  return geo
}

export interface FlowsApi {
  group: THREE.Object3D
  emit(req: FlowRequest): void
  update(dt: number): void
  /** Reduce ambient packets while a foreground statement owns the reading frame. */
  setAmbientDimmed(dimmed: boolean): void
  readonly active: number
  readonly dropped: number
  setQuality(q: QualitySettings): void
  dispose(): void
}

export function createFlows(
  scene: THREE.Scene,
  bus: Bus,
  quality: QualitySettings,
  theme: ThemeApi,
): FlowsApi {
  const rng = makeRng(0x7f10a5)

  const group = new THREE.Group()
  group.name = 'flows'
  scene.add(group)

  const geo = packetGeometry()
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    side: THREE.FrontSide,
  })
  material.name = 'flow:packet'
  let ambientDimmed = false

  /* ---- route bakery -----------------------------------------------------*/

  const bakes: RouteBake[] = []
  const bakeIndex = new Map<string, number>()
  const unknown = new Set<string>()

  function bakeRoute(id: string): number {
    const hit = bakeIndex.get(id)
    if (hit !== undefined) return hit
    const def = ROUTES[id]
    const curve = def ? routeCurve(id) : null
    if (!def || !curve) {
      if (!unknown.has(id)) {
        unknown.add(id)
        console.warn(`[flows] emit on unknown route "${id}"`)
      }
      return -1
    }

    const n = SAMPLES
    const pts = new Float32Array((n + 1) * 3)
    const tan = new Float32Array((n + 1) * 3)
    const bin = new Float32Array((n + 1) * 3)
    const nor = new Float32Array((n + 1) * 3)
    const cum = new Float32Array(n + 1)

    for (let i = 0; i <= n; i++) {
      curve.getPointAt(i / n, _p0)
      pts[i * 3] = _p0.x
      pts[i * 3 + 1] = _p0.y
      pts[i * 3 + 2] = _p0.z
    }
    for (let i = 1; i <= n; i++) {
      const a = (i - 1) * 3
      const b = i * 3
      const dx = pts[b] - pts[a]
      const dy = pts[b + 1] - pts[a + 1]
      const dz = pts[b + 2] - pts[a + 2]
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz)
    }

    for (let i = 0; i <= n; i++) {
      // Central difference where possible; endpoints fall back to one side.
      const lo = i > 0 ? i - 1 : i
      const hi = i < n ? i + 1 : i
      _t0.set(
        pts[hi * 3] - pts[lo * 3],
        pts[hi * 3 + 1] - pts[lo * 3 + 1],
        pts[hi * 3 + 2] - pts[lo * 3 + 2],
      )
      if (_t0.lengthSq() < 1e-10) _t0.copy(FORWARD)
      else _t0.normalize()

      _b0.crossVectors(_t0, UP)
      if (_b0.lengthSq() < 1e-6) _b0.crossVectors(_t0, SIDE) // vertical run
      _b0.normalize()
      _n0.crossVectors(_t0, _b0).normalize()

      tan[i * 3] = _t0.x
      tan[i * 3 + 1] = _t0.y
      tan[i * 3 + 2] = _t0.z
      bin[i * 3] = _b0.x
      bin[i * 3 + 1] = _b0.y
      bin[i * 3 + 2] = _b0.z
      nor[i * 3] = _n0.x
      nor[i * 3 + 1] = _n0.y
      nor[i * 3 + 2] = _n0.z
    }

    const idx = bakes.length
    bakes.push({
      pts,
      tan,
      bin,
      nor,
      cum,
      length: Math.max(1e-3, cum[n]),
      color: def.color,
      speed: def.speed,
      size: def.size ?? 1,
    })
    bakeIndex.set(id, idx)
    return idx
  }

  /* ---- particle pool ----------------------------------------------------*/

  let pool = Math.max(64, Math.floor(quality.maxParticles * (reduceMotion() ? 0.28 : 1)))
  let mesh!: THREE.InstancedMesh
  let mArr!: Float32Array
  let cArr!: Float32Array

  let pT!: Float32Array
  let pSpeed!: Float32Array
  let pSize!: Float32Array
  let pLatA!: Float32Array
  let pLatB!: Float32Array
  let pRoute!: Int32Array
  let pKind!: Uint8Array

  let free!: Int32Array
  let nFree = 0
  let act!: Int32Array
  let nAct = 0

  let colorDirty = false
  let dropped = 0
  let clock = 0

  function buildPool(size: number): void {
    pool = Math.max(64, Math.floor(size))

    mesh = new THREE.InstancedMesh(geo, material, pool)
    mesh.name = 'flows:packets'
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(pool * 3), 3)
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage)
    // Instances span the entire city; a geometry-derived bounding sphere would
    // cull the whole batch the moment the camera looks away from the origin.
    mesh.frustumCulled = false
    mesh.raycast = () => {} // packets are never pickable
    // Only the used head of the pool is submitted; see the high-water mark in
    // update(). An empty city costs nothing.
    mesh.count = 0
    group.add(mesh)

    mArr = mesh.instanceMatrix.array as Float32Array
    cArr = mesh.instanceColor.array as Float32Array

    pT = new Float32Array(pool)
    pSpeed = new Float32Array(pool)
    pSize = new Float32Array(pool)
    pLatA = new Float32Array(pool)
    pLatB = new Float32Array(pool)
    pRoute = new Int32Array(pool)
    pKind = new Uint8Array(pool)

    free = new Int32Array(pool)
    act = new Int32Array(pool)
    nFree = pool
    nAct = 0
    for (let i = 0; i < pool; i++) {
      free[i] = pool - 1 - i // pop from the top → hand out 0,1,2,…
      park(i)
    }

    // Default ink, overwritten on every spawn.
    _col.setHex(theme.color.ink).multiplyScalar(COLOR_GAIN)
    for (let i = 0; i < pool; i++) {
      cArr[i * 3] = _col.r
      cArr[i * 3 + 1] = _col.g
      cArr[i * 3 + 2] = _col.b
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.instanceColor.needsUpdate = true
  }

  /** Zero-scale matrix, for any parked instance still inside the draw range. */
  function park(i: number): void {
    const o = i * 16
    for (let k = 0; k < 16; k++) mArr[o + k] = 0
    mArr[o + 15] = 1
  }

  function destroyPool(): void {
    group.remove(mesh)
    mesh.dispose()
  }

  buildPool(pool)

  /* ---- staggered emission ring ------------------------------------------*/

  const qDue = new Float32Array(PENDING_CAP)
  const qRoute = new Int32Array(PENDING_CAP)
  const qColor = new Int32Array(PENDING_CAP)
  const qSpeed = new Float32Array(PENDING_CAP)
  const qSize = new Float32Array(PENDING_CAP)
  const qSpread = new Float32Array(PENDING_CAP)
  const qKind = new Uint8Array(PENDING_CAP)
  let qHead = 0
  let qCount = 0

  function enqueue(
    due: number,
    route: number,
    color: number,
    speed: number,
    size: number,
    spread: number,
    kind: number,
  ): void {
    if (qCount === PENDING_CAP) {
      // Backlog full: the oldest pending packet never gets to leave.
      qHead = (qHead + 1) % PENDING_CAP
      qCount--
      dropped++
    }
    const i = (qHead + qCount) % PENDING_CAP
    qDue[i] = due
    qRoute[i] = route
    qColor[i] = color
    qSpeed[i] = speed
    qSize[i] = size
    qSpread[i] = spread
    qKind[i] = kind
    qCount++
  }

  function drainPending(): void {
    if (qCount === 0) return
    let keep = 0
    for (let k = 0; k < qCount; k++) {
      const i = (qHead + k) % PENDING_CAP
      if (qDue[i] <= clock) {
        spawn(qRoute[i], qColor[i], qSpeed[i], qSize[i], qSpread[i], qKind[i])
        continue
      }
      const j = (qHead + keep) % PENDING_CAP
      if (j !== i) {
        qDue[j] = qDue[i]
        qRoute[j] = qRoute[i]
        qColor[j] = qColor[i]
        qSpeed[j] = qSpeed[i]
        qSize[j] = qSize[i]
        qSpread[j] = qSpread[i]
        qKind[j] = qKind[i]
      }
      keep++
    }
    qCount = keep
  }

  /* ---- spawn / emit -----------------------------------------------------*/

  function spawn(
    route: number,
    color: number,
    speed: number,
    size: number,
    spread: number,
    kind: number,
  ): void {
    if (nFree === 0) {
      dropped++ // pool exhausted — the city is busier than the budget allows
      return
    }
    const i = free[--nFree]
    act[nAct++] = i

    // Per-packet speed jitter, otherwise traffic marches in lockstep.
    const jitter = 0.88 + rng() * 0.26
    pT[i] = 0
    pSpeed[i] = speed * jitter
    pSize[i] = size
    pLatA[i] = (rng() * 2 - 1) * spread
    pLatB[i] = (rng() * 2 - 1) * spread * 0.5
    pRoute[i] = route
    pKind[i] = kind

    _col.setHex(color).multiplyScalar(COLOR_GAIN)
    cArr[i * 3] = _col.r
    cArr[i * 3 + 1] = _col.g
    cArr[i * 3 + 2] = _col.b
    colorDirty = true
  }

  function emit(req: FlowRequest): void {
    const r = bakeRoute(req.route)
    if (r < 0) {
      dropped++
      return
    }
    const b = bakes[r]
    const count = Math.min(MAX_BURST, Math.max(1, Math.round(req.count ?? 1)))
    const color = req.color ?? b.color
    const speed = req.speed ?? b.speed
    const size = req.size ?? b.size
    const spread = req.spread ?? 1.0
    const kind = req.kind !== undefined ? KIND_INDEX.get(req.kind) ?? KIND_DEFAULT : KIND_DEFAULT
    const stagger = req.stagger ?? 0

    if (stagger <= 0) {
      for (let i = 0; i < count; i++) spawn(r, color, speed, size, spread, kind)
      return
    }
    // First packet leaves now, the rest are spread across `stagger` seconds.
    spawn(r, color, speed, size, spread, kind)
    for (let i = 1; i < count; i++) {
      enqueue(clock + (i / count) * stagger, r, color, speed, size, spread, kind)
    }
  }

  const offFlow = bus.on('flow', emit)

  /* ---- update -----------------------------------------------------------*/

  function update(dt: number): void {
    // A backgrounded tab hands back a huge dt; teleporting every packet to the
    // end of its route looks like a glitch, so clamp it.
    if (dt > 0.25) dt = 0.25
    if (dt < 0) dt = 0
    clock += dt

    drainPending()

    /* High-water mark of live instance indices. Slots are handed out from the
     * low end of the pool, so on a quiet city this is a couple of hundred out of
     * a couple of thousand, and the rest of the pool is never submitted. That
     * matters more than it used to: the packet is a freight pod now, four times
     * the triangles of the dart it replaced, and paying for all of them on an
     * idle frame would be a real regression rather than a bookkeeping one. */
    let hi = 0

    for (let a = nAct - 1; a >= 0; a--) {
      const i = act[a]
      const b = bakes[pRoute[i]]
      const t = pT[i] + (pSpeed[i] * dt) / b.length

      if (t >= 1) {
        park(i)
        nAct--
        act[a] = act[nAct]
        free[nFree++] = i
        continue
      }
      pT[i] = t
      if (i >= hi) hi = i + 1

      const cum = b.cum
      const d = t * b.length
      const s = segFor(cum, d)
      const c0 = cum[s]
      const c1 = cum[s + 1]
      const f = c1 > c0 ? (d - c0) / (c1 - c0) : 0
      const o0 = s * 3
      const o1 = o0 + 3
      const pts = b.pts
      const tanA = b.tan
      const binA = b.bin
      const norA = b.nor

      _pos.set(
        pts[o0] + (pts[o1] - pts[o0]) * f,
        pts[o0 + 1] + (pts[o1 + 1] - pts[o0 + 1]) * f,
        pts[o0 + 2] + (pts[o1 + 2] - pts[o0 + 2]) * f,
      )
      _tan.set(
        tanA[o0] + (tanA[o1] - tanA[o0]) * f,
        tanA[o0 + 1] + (tanA[o1 + 1] - tanA[o0 + 1]) * f,
        tanA[o0 + 2] + (tanA[o1 + 2] - tanA[o0 + 2]) * f,
      )
      if (_tan.lengthSq() < 1e-8) _tan.copy(FORWARD)
      else _tan.normalize()

      // Lane offsets keep several packets on one road from occupying the same
      // pixel; they ride a tube around the centre line.
      const la = pLatA[i]
      const lb = pLatB[i]
      if (la !== 0 || lb !== 0) {
        _bin.set(
          binA[o0] + (binA[o1] - binA[o0]) * f,
          binA[o0 + 1] + (binA[o1 + 1] - binA[o0 + 1]) * f,
          binA[o0 + 2] + (binA[o1 + 2] - binA[o0 + 2]) * f,
        )
        _nor.set(
          norA[o0] + (norA[o1] - norA[o0]) * f,
          norA[o0 + 1] + (norA[o1 + 1] - norA[o0 + 1]) * f,
          norA[o0 + 2] + (norA[o1 + 2] - norA[o0 + 2]) * f,
        )
        _pos.addScaledVector(_bin, la)
        _pos.addScaledVector(_nor, lb)
      }

      // Fade by scale, never opacity: the material is shared by every packet.
      let fade = 1
      if (t < FADE_IN) fade = t / FADE_IN
      else if (t > 1 - FADE_OUT) fade = (1 - t) / FADE_OUT
      fade = fade * fade * (3 - 2 * fade)

      const k = pKind[i]
      const w = pSize[i] * PACKET_SCALE * fade * KIND_W[k]
      const len = pSize[i] * PACKET_SCALE * fade * KIND_L[k]

      _quat.setFromUnitVectors(FORWARD, _tan)
      _scl.set(w, w, len)
      _mat.compose(_pos, _quat, _scl)
      mesh.setMatrixAt(i, _mat)
    }

    mesh.count = hi
    mesh.instanceMatrix.needsUpdate = true
    if (colorDirty && mesh.instanceColor) {
      mesh.instanceColor.needsUpdate = true
      colorDirty = false
    }
  }

  /* ---- quality / teardown -----------------------------------------------*/

  function setQuality(q: QualitySettings): void {
    // Streams of particles crossing the whole screen are the loudest motion in
    // the city. Keep enough to read the routes, drop the rest.
    const budget = reduceMotion() ? q.maxParticles * 0.28 : q.maxParticles
    const want = Math.max(64, Math.floor(budget))
    if (want === pool) return
    destroyPool()
    qHead = 0
    qCount = 0 // pending emissions reference the old pool's budget; drop them
    buildPool(want)
  }

  function setAmbientDimmed(dimmed: boolean): void {
    if (dimmed === ambientDimmed) return
    ambientDimmed = dimmed
    material.transparent = dimmed
    material.opacity = dimmed ? 0.14 : 1
    material.depthWrite = !dimmed
    material.needsUpdate = true
  }

  function dispose(): void {
    offFlow()
    destroyPool()
    scene.remove(group)
    geo.dispose()
    material.dispose()
    bakes.length = 0
    bakeIndex.clear()
    unknown.clear()
  }

  return {
    group,
    emit,
    update,
    setAmbientDimmed,
    get active() {
      return nAct
    },
    get dropped() {
      return dropped
    },
    setQuality,
    dispose,
  }
}
