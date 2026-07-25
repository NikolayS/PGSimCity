import * as THREE from 'three'
import type { RouteDef, ThemeApi } from '../core/types'
import { ROUTES, routeCurve } from '../world/layout'
import { clamp } from '../core/util'

/* ============================================================================
 * ROADS — the static infrastructure the flow particles run on.
 *
 * A route is only drawn if it is marked `visible` in the city plan: the roads
 * that teach something (client → postmaster, buffers ↔ storage, the WAL
 * pipeline, the replication wire, the maintenance sweeps) are drawn, the
 * sixteen per-backend capillaries are not — they would be visual noise.
 *
 * Roads are faint by design. They are dark infrastructure; the traffic on them
 * is the only thing that glows.
 * ==========================================================================*/

/** Samples along each road polyline. */
const SEGMENTS = 64
/** Roads shorter than this are junctions, not trunk roads — no ticks. */
const TRUNK_MIN_LENGTH = 80
/** Sleeper spacing, world units. */
const TICK_SPACING = 14
/** Half-width of a tick mark. */
const TICK_HALF = 1.6
/** Keep sleepers off the endpoints, where roads meet buildings. */
const TICK_MARGIN = 8

const UP = new THREE.Vector3(0, 1, 0)
const SIDE = new THREE.Vector3(1, 0, 0)

const _p = new THREE.Vector3()
const _t = new THREE.Vector3()
const _perp = new THREE.Vector3()

/**
 * Draw the road network. One `Line` per visible route, plus one merged
 * `LineSegments` of tick marks per colour+opacity pair — roughly 30 draw calls
 * for the whole city.
 */
export function createRoads(theme: ThemeApi): THREE.Group {
  const group = new THREE.Group()
  group.name = 'roads'

  /** key = `${color}|${opacity}` → flat xyz pairs for LineSegments. */
  const ticks = new Map<string, number[]>()

  for (const id of Object.keys(ROUTES)) {
    const def: RouteDef = ROUTES[id]
    if (!def.visible) continue
    const curve = routeCurve(id)
    if (!curve) continue

    const opacity = def.roadOpacity ?? 0.16

    /* --- the road itself --------------------------------------------------*/
    const pos = new Float32Array((SEGMENTS + 1) * 3)
    for (let i = 0; i <= SEGMENTS; i++) {
      curve.getPointAt(i / SEGMENTS, _p)
      pos[i * 3] = _p.x
      pos[i * 3 + 1] = _p.y
      pos[i * 3 + 2] = _p.z
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const line = new THREE.Line(geo, theme.line(def.color, opacity))
    line.name = `road:${id}`
    line.renderOrder = -1
    line.raycast = () => {}
    group.add(line)

    /* --- sleepers ---------------------------------------------------------*/
    const length = curve.getLength()
    if (length < TRUNK_MIN_LENGTH) continue

    const tickOpacity = clamp(opacity * 1.6, 0.1, 0.32)
    const key = `${def.color}|${tickOpacity}`
    let buf = ticks.get(key)
    if (!buf) ticks.set(key, (buf = []))

    for (let s = TICK_MARGIN; s <= length - TICK_MARGIN; s += TICK_SPACING) {
      const u = s / length
      curve.getPointAt(u, _p)
      curve.getTangentAt(u, _t)
      _perp.crossVectors(_t, UP)
      if (_perp.lengthSq() < 1e-6) _perp.crossVectors(_t, SIDE) // vertical run
      _perp.normalize().multiplyScalar(TICK_HALF)
      buf.push(
        _p.x - _perp.x, _p.y - _perp.y, _p.z - _perp.z,
        _p.x + _perp.x, _p.y + _perp.y, _p.z + _perp.z,
      )
    }
  }

  for (const [key, buf] of ticks) {
    if (buf.length === 0) continue
    const sep = key.indexOf('|')
    const color = Number(key.slice(0, sep))
    const opacity = Number(key.slice(sep + 1))
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf), 3))
    const seg = new THREE.LineSegments(geo, theme.line(color, opacity))
    seg.name = `road:ticks:${key}`
    seg.renderOrder = -1
    seg.raycast = () => {}
    group.add(seg)
  }

  return group
}
