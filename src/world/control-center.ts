import * as THREE from 'three'

import type { SimState, TraceStop, WorldFactory, WorldModule } from '../core/types'
import { traceStopBit } from '../sim/model'
import { traceStageState } from '../sim/trace-presentation'
import { ANCHOR } from './layout'
import { CONTROL_TRACE_ROUTES } from './control-center-plan'

const TRACE_CYAN = 0x8fe5e7
const ROUTE_SAMPLES = 72

type BoxSpec = readonly [
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  depth: number,
]

interface RouteVisual {
  stop: Exclude<TraceStop, 'done'>
  requiresRead: boolean
  mesh: THREE.Mesh
  samples: Float32Array
}

const _matrix = new THREE.Matrix4()
const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _rotation = new THREE.Quaternion()
const _sample = new THREE.Vector3()

function fillBoxes(mesh: THREE.InstancedMesh, specs: readonly BoxSpec[]): void {
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    _position.set(spec[0], spec[1], spec[2])
    _scale.set(spec[3], spec[4], spec[5])
    _matrix.compose(_position, _rotation, _scale)
    mesh.setMatrixAt(i, _matrix)
  }
  mesh.instanceMatrix.needsUpdate = true
}

export const createControlCenterWorld: WorldFactory = (ctx): WorldModule => {
  const { theme } = ctx
  const group = new THREE.Group()
  group.name = 'control-center'
  const owned: { dispose(): void }[] = []
  const own = <T extends { dispose(): void }>(value: T): T => {
    owned.push(value)
    return value
  }

  /* The original tier-three box is front-sided. From inside it becomes the
   * outside skin; these double-sided ribs make the negative space read as a
   * room while leaving three genuine window openings onto the running city. */
  const room = new THREE.Group()
  room.name = 'control-center:room'
  room.position.set(ANCHOR.postmaster[0], ANCHOR.postmaster[1], ANCHOR.postmaster[2])
  const structure = theme.mat('control-center.struct', {
    color: 0x142629,
    roughness: 0.82,
    metalness: 0.3,
    emissive: 0x071416,
    side: THREE.DoubleSide,
    surface: false,
  })
  const roomSpecs: readonly BoxSpec[] = [
    [0, 30.1, -4.56, 9.2, 4.6, 0.42], // north instrument wall
    [-4.56, 30.1, 0, 0.42, 4.6, 9.2], // west frame
    [4.56, 30.1, 0, 0.42, 4.6, 9.2], // east frame
    [-4.22, 30.1, 4.56, 0.66, 4.6, 0.42], // panoramic south window jambs
    [4.22, 30.1, 4.56, 0.66, 4.6, 0.42],
    [0, 28.25, 4.56, 8.8, 0.9, 0.42], // sill
    [0, 32.18, 4.56, 8.8, 0.44, 0.42], // lintel
    [0, 30.2, 4.56, 0.18, 3.5, 0.5], // centre mullion
    [-4.34, 30.1, 0, 0.1, 3.5, 7.9], // side-window inner rails
    [4.34, 30.1, 0, 0.1, 3.5, 7.9],
  ]
  const roomMesh = new THREE.InstancedMesh(theme.box(1, 1, 1), structure, roomSpecs.length)
  roomMesh.name = 'control-center:structure'
  fillBoxes(roomMesh, roomSpecs)
  room.add(roomMesh)

  const trimSpecs: readonly BoxSpec[] = [
    [0, 27.86, 4.35, 8.6, 0.12, 0.34], // window threshold
  ]
  const trimMesh = new THREE.InstancedMesh(
    theme.box(1, 1, 1),
    theme.neon(TRACE_CYAN, 1.75),
    trimSpecs.length,
  )
  trimMesh.name = 'control-center:meaning'
  fillBoxes(trimMesh, trimSpecs)
  room.add(trimMesh)

  const doorSpecs: readonly BoxSpec[] = [
    [-3.05, 3.2, 12.7, 0.26, 5.8, 0.32],
    [3.05, 3.2, 12.7, 0.26, 5.8, 0.32],
    [0, 6.0, 12.7, 6.35, 0.26, 0.32],
    [0, 0.12, 12.7, 6.35, 0.2, 1.4],
  ]
  const doorMesh = new THREE.InstancedMesh(
    theme.box(1, 1, 1),
    theme.neon(TRACE_CYAN, 2.35),
    doorSpecs.length,
  )
  doorMesh.name = 'control-center:door'
  fillBoxes(doorMesh, doorSpecs)
  room.add(doorMesh)

  const plateTexture = theme.textTexture('CONTROL CENTER  ·  E', {
    size: 42,
    color: '#d9ffff',
    bg: '#091719',
    font: '700 42px ui-monospace, monospace',
    padding: 20,
  })
  const plateGeometry = own(new THREE.PlaneGeometry(11.8, 2.2))
  const plateMaterial = own(new THREE.MeshBasicMaterial({
    map: plateTexture,
    toneMapped: false,
    side: THREE.FrontSide,
  }))
  const doorPlate = new THREE.Mesh(plateGeometry, plateMaterial)
  doorPlate.name = 'control-center:door-sign'
  doorPlate.position.set(0, 8.0, 12.72)
  room.add(doorPlate)
  group.add(room)

  /* Foreground statement route. The route data is also the plan's SVG data;
   * this layer adds no state and only reads the model-owned TraceRecord. */
  const traceGroup = new THREE.Group()
  traceGroup.name = 'control-center:foreground-trace'
  const routePast = theme.neon(TRACE_CYAN, 1.35, { transparent: true, opacity: 0.34 })
  const routeNow = theme.neon(TRACE_CYAN, 3.2)
  const visuals: RouteVisual[] = []
  for (let i = 0; i < CONTROL_TRACE_ROUTES.length; i++) {
    const spec = CONTROL_TRACE_ROUTES[i]
    const points: THREE.Vector3[] = []
    for (let p = 0; p < spec.points.length; p++) {
      const point = spec.points[p]
      points.push(new THREE.Vector3(point[0], point[1], point[2]))
    }
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.18)
    const geometry = own(new THREE.TubeGeometry(curve, ROUTE_SAMPLES, 0.55, 5, false))
    const mesh = new THREE.Mesh(geometry, routePast)
    mesh.name = `control-center:trace:${spec.id}`
    mesh.visible = false
    mesh.frustumCulled = false
    traceGroup.add(mesh)

    const samples = new Float32Array((ROUTE_SAMPLES + 1) * 3)
    for (let p = 0; p <= ROUTE_SAMPLES; p++) {
      curve.getPoint(p / ROUTE_SAMPLES, _sample)
      const offset = p * 3
      samples[offset] = _sample.x
      samples[offset + 1] = _sample.y
      samples[offset + 2] = _sample.z
    }
    visuals.push({
      stop: spec.stop,
      requiresRead: spec.requiresRead === true,
      mesh,
      samples,
    })
  }

  const marker = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.9, 10, 8)),
    theme.neon(TRACE_CYAN, 3.6),
  )
  marker.name = 'control-center:statement-marker'
  marker.visible = false
  marker.frustumCulled = false
  traceGroup.add(marker)
  group.add(traceGroup)

  function placeMarker(visual: RouteVisual, t: number): void {
    const phase = (t * 0.42) % 1
    const scaled = phase * ROUTE_SAMPLES
    const index = Math.min(ROUTE_SAMPLES - 1, Math.floor(scaled))
    const mix = scaled - index
    const a = index * 3
    const b = a + 3
    const samples = visual.samples
    marker.position.set(
      samples[a] + (samples[b] - samples[a]) * mix,
      samples[a + 1] + (samples[b + 1] - samples[a + 1]) * mix,
      samples[a + 2] + (samples[b + 2] - samples[a + 2]) * mix,
    )
    const pulse = 0.84 + Math.sin(t * 7.5) * 0.16
    marker.scale.setScalar(pulse)
  }

  function update(_dt: number, sim: SimState, t: number): void {
    const trace = sim.trace
    const receipt =
      trace.stop === 'done'
      && (trace.visited & traceStopBit('done')) !== 0
    const live = trace.sql.length > 0 && !receipt
    traceGroup.visible = live
    if (!live) return

    let active: RouteVisual | null = null
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i]
      const state = traceStageState(trace, visual.stop)
      const visible =
        state !== 'wait'
        && state !== 'skip'
        && (!visual.requiresRead || trace.buffersRead > 0)
      visual.mesh.visible = visible
      if (!visible) continue
      visual.mesh.material = state === 'now' ? routeNow : routePast
      if (state === 'now') active = visual
    }
    marker.visible = active !== null
    if (active) placeMarker(active, t)
  }

  function dispose(): void {
    for (let i = 0; i < owned.length; i++) owned[i].dispose()
    visuals.length = 0
    group.clear()
  }

  return { id: 'control-center', group, update, dispose }
}
