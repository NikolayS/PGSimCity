import * as THREE from 'three'

import type { SimState, TraceStop, WorldContext, WorldModule } from '../core/types'
import { easeInOutCubic } from '../core/util'
import { traceStopBit } from '../core/model-helpers'
import { traceStageState } from '../core/trace-presentation'
import { ANCHOR } from './layout'
import { CONTROL_TRACE_ROUTES } from './control-center-plan'
import { markTextPlane } from './text-plane'

const TRACE_CYAN = 0x8fe5e7
const ROUTE_SAMPLES = 72
const DOOR_OPEN_ANGLE = Math.PI * 0.55

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

export interface ControlCenterDoorVisual {
  readonly openness: number
  setOpenness(value: number): void
}

export interface ControlCenterWorldModule extends WorldModule {
  readonly door: ControlCenterDoorVisual
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

export function createControlCenterWorld(ctx: WorldContext): ControlCenterWorldModule {
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

  const doorFrameSpecs: readonly BoxSpec[] = [
    [-3.05, 3.2, 12.7, 0.26, 5.8, 0.32],
    [3.05, 3.2, 12.7, 0.26, 5.8, 0.32],
    [0, 6.0, 12.7, 6.35, 0.26, 0.32],
  ]
  const doorFrame = new THREE.InstancedMesh(
    theme.box(1, 1, 1),
    theme.neon(TRACE_CYAN, 2.35),
    doorFrameSpecs.length,
  )
  doorFrame.name = 'control-center:door'
  fillBoxes(doorFrame, doorFrameSpecs)
  room.add(doorFrame)

  const threshold = new THREE.Mesh(
    theme.box(6.35, 0.2, 1.4),
    theme.neon(TRACE_CYAN, 2.35),
  )
  threshold.name = 'control-center:door-threshold'
  threshold.position.set(0, 0.12, 12.7)
  room.add(threshold)

  /* The old facade supplied a dark rectangle but no threshold: the paired
   * leaves, deep reveal and canopy make this a place to cross from plaza to
   * supervisor, not another luminous diagram laid over a wall. */
  const entranceMat = theme.mat('control-center.entrance', {
    color: 0x101b25,
    roughness: 0.88,
    metalness: 0.42,
    emissive: 0x050a10,
    surface: false,
  })
  const leafMat = theme.mat('control-center.door-leaf', {
    color: 0x263341,
    roughness: 0.72,
    metalness: 0.62,
    emissive: 0x090d16,
    surface: false,
  })
  const panelMat = theme.mat('control-center.door-panel', {
    color: 0x121a24,
    roughness: 0.76,
    metalness: 0.5,
    emissive: 0x04070c,
    surface: false,
  })
  const portalMaterial = own(new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
  }))
  const portal = new THREE.Mesh(theme.box(5.75, 5.55, 0.04), portalMaterial)
  portal.name = 'control-center:door-reveal'
  portal.position.set(0, 3.12, 12.51)
  room.add(portal)

  const canopy = new THREE.Mesh(theme.box(7.7, 0.42, 2.4), entranceMat)
  canopy.name = 'control-center:door-canopy'
  canopy.position.set(0, 6.55, 13.25)
  room.add(canopy)

  const doorLeaves = new THREE.Group()
  doorLeaves.name = 'control-center:door-leaves'
  const leafWidth = 2.82
  const leafHeight = 5.42
  const leafDepth = 0.36
  const hinges = 2.94
  const makeLeaf = (side: -1 | 1): THREE.Group => {
    const pivot = new THREE.Group()
    pivot.name = side < 0 ? 'control-center:door-left' : 'control-center:door-right'
    pivot.position.set(side * hinges, 0.38, 12.48)

    const centreX = -side * leafWidth * 0.5
    const leaf = new THREE.Mesh(theme.box(leafWidth, leafHeight, leafDepth), leafMat)
    leaf.name = `${pivot.name}-leaf`
    leaf.position.set(centreX, leafHeight * 0.5, 0)
    pivot.add(leaf)

    const panels = new THREE.InstancedMesh(theme.box(1, 1, 1), panelMat, 2)
    panels.name = `${pivot.name}-panels`
    fillBoxes(panels, [
      [centreX, 1.58, leafDepth * 0.55, leafWidth - 0.38, 2.0, 0.08],
      [centreX, 3.88, leafDepth * 0.55, leafWidth - 0.38, 2.0, 0.08],
    ])
    pivot.add(panels)

    const handle = new THREE.Mesh(
      theme.box(0.16, 1.15, 0.17),
      theme.neon(TRACE_CYAN, 1.72),
    )
    handle.name = `${pivot.name}-handle`
    handle.position.set(-side * (leafWidth - 0.34), 2.78, leafDepth * 0.82)
    pivot.add(handle)
    doorLeaves.add(pivot)
    return pivot
  }
  const leftDoor = makeLeaf(-1)
  const rightDoor = makeLeaf(1)
  room.add(doorLeaves)

  let doorOpenness = 0
  function setDoorOpenness(value: number): void {
    const next = value < 0 ? 0 : value > 1 ? 1 : value
    if (next === doorOpenness && leftDoor.rotation.y !== 0) return
    doorOpenness = next
    const angle = easeInOutCubic(next) * DOOR_OPEN_ANGLE
    leftDoor.rotation.y = -angle
    rightDoor.rotation.y = angle
  }
  setDoorOpenness(0)

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
  markTextPlane(doorPlate, 'CONTROL CENTER  ·  E')
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

  return {
    id: 'control-center',
    group,
    update,
    dispose,
    door: {
      get openness(): number {
        return doorOpenness
      },
      setOpenness: setDoorOpenness,
    },
  }
}
