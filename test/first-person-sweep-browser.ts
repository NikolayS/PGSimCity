import * as THREE from 'three'

import type { Bus, ComponentDef, DistrictId } from '../src/core/types'
import type { CollisionWorld } from '../src/engine/collision'
import type { ViewmodelHandsApi } from '../src/engine/hands'
import type { WalkController } from '../src/engine/walk'
import { ANCHOR, CITY, DISTRICT_BOUNDS } from '../src/world/layout'
import { markedTextPlanes } from '../src/world/text-plane'
import {
  districtResolver,
  enumerateColliders,
  enumerateMeshes,
  enumerateText,
  materialForTriangle,
  materialsOf,
  objectPath,
  opaqueMaterial,
  pointInTriangle,
  recordLabel,
  renderedMaterial,
  solidMaterial,
  visibleInTree,
  waitFrames,
  type CityHandle,
  type HorizontalTriangle,
  type MeshRecord,
  type TextInstance,
} from './visual-sweep-browser'

/* The sweep uses the same dimensions as the production walk controller. These
 * are physical properties of the pedestrian, not visual-audit thresholds. */
const EYE_HEIGHT = 1.7
const CAPSULE_RADIUS = 0.35
const CAPSULE_HEIGHT = 1.8
const MAX_WALK_SLOPE_Y = Math.cos(THREE.MathUtils.degToRad(50))
const GRID_SPACING = 24
const APPROACH_SPACING = 24
const PATH_SAMPLE_SPACING = 3
const SURFACE_MATCH = 0.6
const MIN_TEXT_PIXELS = 11
const TEXT_REVIEW_DISTANCE = 24
const NEAR_SLAB_EPSILON = 0.004

type StationSource = 'surface-grid' | 'collider-approach'

interface FirstPersonCityHandle extends Omit<CityHandle, 'collision'> {
  readonly bus: Pick<Bus, 'emit'>
  readonly walk: WalkController
  readonly hands: ViewmodelHandsApi
  readonly collision: Pick<
    CollisionWorld,
    'debugMesh' | 'groundAt' | 'groundNormal' | 'groundSurface' | 'solidNear' | 'move'
  >
}

interface Station {
  readonly id: string
  readonly source: StationSource
  readonly district: DistrictId
  readonly feet: THREE.Vector3
  readonly yaw: number
  readonly surface: string
  readonly gridX: number | null
  readonly gridZ: number | null
}

interface PathPose {
  readonly id: string
  readonly district: DistrictId
  readonly feet: THREE.Vector3
  readonly yaw: number
}

export interface FirstPersonFinding {
  readonly invariant:
    | 'camera-clearance'
    | 'hands'
    | 'selection-affordance'
    | 'text-eye-level'
    | 'ground-continuity'
  readonly station: string
  readonly district: string
  readonly object: string
  readonly position: readonly [number, number, number]
  readonly camera: readonly [number, number, number]
  readonly yaw: number
  readonly detail: string
}

export interface FirstPersonStationReport {
  readonly id: string
  readonly source: StationSource
  readonly district: string
  readonly feet: readonly [number, number, number]
  readonly camera: readonly [number, number, number]
  readonly yaw: number
  readonly surface: string
}

export interface FirstPersonSweepReport {
  readonly stations: readonly FirstPersonStationReport[]
  readonly surfaceGridStations: number
  readonly colliderApproachStations: number
  readonly traversalSegments: number
  readonly traversalSamples: number
  readonly sceneObjects: number
  readonly meshObjects: number
  readonly meshInstances: number
  readonly textPlanes: number
  readonly colliderBoxes: number
  readonly hands: {
    readonly station: FirstPersonStationReport
    readonly visibleHands: number
    readonly visibleMeshes: number
    readonly meshInstances: number
  }
  readonly findings: readonly FirstPersonFinding[]
}

interface Candidate {
  source: StationSource
  x: number
  z: number
  yaw: number
  gridX: number | null
  gridZ: number | null
  boxMinY: number | null
  boxMaxY: number | null
}

interface GroundHit {
  readonly triangle: WalkTriangle
  readonly y: number
}

interface WalkTriangle extends Omit<HorizontalTriangle, 'y'> {
  readonly ay: number
  readonly by: number
  readonly cy: number
}

interface TriangleGrid {
  readonly cells: ReadonlyMap<string, readonly WalkTriangle[]>
  readonly spanning: readonly WalkTriangle[]
}

const _point = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _move = {
  position: new THREE.Vector3(),
  hitX: false,
  hitZ: false,
  blocked: false,
  stepped: 0,
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function tuple(point: THREE.Vector3): [number, number, number] {
  return [round(point.x), round(point.y), round(point.z)]
}

function cameraTuple(feet: THREE.Vector3): [number, number, number] {
  return [round(feet.x), round(feet.y + EYE_HEIGHT), round(feet.z)]
}

function viewYaw(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz)
}

function boundsContain(district: DistrictId, x: number, z: number): boolean {
  const bounds = DISTRICT_BOUNDS[district]
  return x >= bounds.x[0] && x <= bounds.x[1] && z >= bounds.z[0] && z <= bounds.z[1]
}

function districtAt(
  registry: FirstPersonCityHandle['registry'],
  x: number,
  y: number,
  z: number,
): DistrictId {
  let nearest: ComponentDef | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const component of registry.all()) {
    if (component.district !== 'world' && !boundsContain(component.district, x, z)) continue
    const target = component.focus.target
    const distance = Math.hypot(x - target[0], y - target[1], z - target[2])
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = component
    }
  }
  return nearest?.district ?? 'world'
}

function capsuleClear(
  x: number,
  feetY: number,
  z: number,
  colliders: readonly THREE.Box3[],
): boolean {
  const headY = feetY + CAPSULE_HEIGHT
  for (const box of colliders) {
    if (box.max.y <= feetY + 1e-3 || box.min.y >= headY - 1e-3) continue
    const dx = x < box.min.x ? box.min.x - x : x > box.max.x ? x - box.max.x : 0
    const dz = z < box.min.z ? box.min.z - z : z > box.max.z ? z - box.max.z : 0
    if (Math.hypot(dx, dz) < CAPSULE_RADIUS - 1e-4) return false
  }
  return true
}

function stableSurface(
  city: FirstPersonCityHandle,
  x: number,
  y: number,
  z: number,
): boolean {
  let matching = 0
  for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]] as const) {
    _point.set(x + dx, y + 0.6, z + dz)
    const nearby = city.collision.groundAt(_point, 1.8)
    if (nearby !== null && Math.abs(nearby - y) <= SURFACE_MATCH) matching++
  }
  return matching >= 3
}

function surfacesAt(
  city: FirstPersonCityHandle,
  colliders: readonly THREE.Box3[],
  x: number,
  z: number,
  top: number,
  bottom: number,
): { y: number; surface: string }[] {
  _point.set(x, top, z)
  const ground = city.collision.groundAt(_point, top - bottom)
  if (ground === null) return []
  _normal.copy(city.collision.groundNormal)
  if (
    _normal.y < MAX_WALK_SLOPE_Y
    || !capsuleClear(x, ground, z, colliders)
    || !stableSurface(city, x, ground, z)
  ) return []
  return [{ y: ground, surface: city.collision.groundSurface }]
}

function rawCandidates(colliders: readonly THREE.Box3[]): Candidate[] {
  const candidates = new Map<string, Candidate>()
  const world = DISTRICT_BOUNDS.world
  const x0 = Math.ceil(world.x[0] / GRID_SPACING) * GRID_SPACING
  const z0 = Math.ceil(world.z[0] / GRID_SPACING) * GRID_SPACING
  for (let x = x0, gx = 0; x <= world.x[1]; x += GRID_SPACING, gx++) {
    for (let z = z0, gz = 0; z <= world.z[1]; z += GRID_SPACING, gz++) {
      candidates.set(`grid:${gx}:${gz}`, {
        source: 'surface-grid',
        x,
        z,
        yaw: 0,
        gridX: gx,
        gridZ: gz,
        boxMinY: null,
        boxMaxY: null,
      })
    }
  }

  /* Every human-height collision face contributes an approach. Quantising the
   * face centres keeps repeated trim boxes from creating duplicate cameras. */
  for (const box of colliders) {
    const sx = box.max.x - box.min.x
    const sy = box.max.y - box.min.y
    const sz = box.max.z - box.min.z
    if (sy < 0.8 || Math.max(sx, sz) < 0.7) continue
    if (
      box.max.x < world.x[0] || box.min.x > world.x[1]
      || box.max.z < world.z[0] || box.min.z > world.z[1]
    ) continue
    const cx = (box.min.x + box.max.x) / 2
    const cz = (box.min.z + box.max.z) / 2
    const offset = CAPSULE_RADIUS + 0.02
    const faces = [
      { x: box.min.x - offset, z: cz, dx: 1, dz: 0 },
      { x: box.max.x + offset, z: cz, dx: -1, dz: 0 },
      { x: cx, z: box.min.z - offset, dx: 0, dz: 1 },
      { x: cx, z: box.max.z + offset, dx: 0, dz: -1 },
    ]
    for (let face = 0; face < faces.length; face++) {
      const point = faces[face]
      const qx = Math.round(point.x / APPROACH_SPACING)
      const qz = Math.round(point.z / APPROACH_SPACING)
      const key = `approach:${qx}:${qz}:${face}`
      if (!candidates.has(key)) {
        candidates.set(key, {
          source: 'collider-approach',
          x: point.x,
          z: point.z,
          yaw: viewYaw(point.dx, point.dz),
          gridX: null,
          gridZ: null,
          boxMinY: box.min.y,
          boxMaxY: box.max.y,
        })
      }
    }
  }
  return [...candidates.values()]
}

function deriveStations(
  city: FirstPersonCityHandle,
  colliders: readonly THREE.Box3[],
  groundTriangles: TriangleGrid,
): Station[] {
  const top = Math.max(48, ...colliders.map((box) => box.max.y + EYE_HEIGHT))
  const bottom = Math.min(-CITY.pit.wallDepth, CITY.storage.y) - 2
  const stations: Station[] = []
  const seen = new Set<string>()
  for (const candidate of rawCandidates(colliders)) {
    if (
      candidate.source === 'surface-grid'
      && !city.collision.solidNear(candidate.x, candidate.z, GRID_SPACING * 0.9)
    ) continue
    /* groundAt() is a top-down acquisition. Lower hits beneath the first one are
     * soffits and buried collider lids, not places the production walker can
     * reach; the excavation and planner remain discoverable because they are
     * already the topmost surface at their XZ. */
    const surface = surfacesAt(city, colliders, candidate.x, candidate.z, top, bottom)[0]
    if (surface) {
      /* A collision lid is not by itself a pedestrian surface. Flow ducts,
       * roofs, and hidden conditional scenes also own collision boxes. On
       * level ground require the live, rendered surface that the pedestrian
       * would actually see underfoot; ramps stay governed by the production
       * collision normal and are audited at the path samples below. */
      if (
        !renderedGroundAt(groundTriangles, candidate.x, candidate.z)
          .some((hit) => Math.abs(hit.y - surface.y) <= 0.12)
      ) continue
      if (
        candidate.source === 'collider-approach'
        && candidate.boxMinY !== null
        && candidate.boxMaxY !== null
        && (
          candidate.boxMaxY <= surface.y + 0.05
          || candidate.boxMinY >= surface.y + CAPSULE_HEIGHT
        )
      ) continue
      const level = Math.round(surface.y * 2)
      const key = `${candidate.source}:${Math.round(candidate.x * 4)}:${level}:${Math.round(candidate.z * 4)}:${round(candidate.yaw)}`
      if (seen.has(key)) continue
      seen.add(key)
      const feet = new THREE.Vector3(candidate.x, surface.y, candidate.z)
      const district = districtAt(city.registry, feet.x, feet.y, feet.z)
      stations.push({
        id: `${candidate.source === 'surface-grid' ? 'grid' : 'face'}:${stations.length}`,
        source: candidate.source,
        district,
        feet,
        yaw: candidate.yaw,
        surface: surface.surface,
        gridX: candidate.gridX,
        gridZ: candidate.gridZ,
      })
    }
  }
  return stations
}

function segmentPoses(
  city: FirstPersonCityHandle,
  stations: readonly Station[],
): { segments: number; poses: PathPose[] } {
  const byGrid = new Map<string, Station[]>()
  for (const station of stations) {
    if (station.gridX === null || station.gridZ === null) continue
    const key = `${station.gridX}:${station.gridZ}`
    const values = byGrid.get(key) ?? []
    values.push(station)
    byGrid.set(key, values)
  }
  const poses: PathPose[] = []
  let segments = 0
  for (const station of stations) {
    if (station.gridX === null || station.gridZ === null) continue
    for (const [ox, oz] of [[1, 0], [0, 1]] as const) {
      const neighbours = byGrid.get(`${station.gridX + ox}:${station.gridZ + oz}`) ?? []
      const neighbour = neighbours
        .filter((next) => Math.abs(next.feet.y - station.feet.y) <= GRID_SPACING * 0.35)
        .sort((a, b) => Math.abs(a.feet.y - station.feet.y) - Math.abs(b.feet.y - station.feet.y))[0]
      if (!neighbour) continue
      const dx = neighbour.feet.x - station.feet.x
      const dz = neighbour.feet.z - station.feet.z
      const length = Math.hypot(dx, dz)
      const steps = Math.ceil(length / PATH_SAMPLE_SPACING)
      let previous = station.feet.clone()
      const local: PathPose[] = []
      let clear = true
      for (let step = 1; step <= steps; step++) {
        const t = step / steps
        _point.set(
          station.feet.x + dx * t,
          previous.y,
          station.feet.z + dz * t,
        )
        city.collision.move(previous, _point, CAPSULE_RADIUS, CAPSULE_HEIGHT, _move)
        if (_move.blocked || _move.position.distanceToSquared(_point) > 0.04) {
          clear = false
          break
        }
        _point.y += 0.65
        const ground = city.collision.groundAt(_point, 1.4)
        if (
          ground === null
          || city.collision.groundNormal.y < MAX_WALK_SLOPE_Y
          || Math.abs(ground - previous.y) > PATH_SAMPLE_SPACING * 0.35
        ) {
          clear = false
          break
        }
        const feet = new THREE.Vector3(_point.x, ground, _point.z)
        local.push({
          id: `path:${station.id}:${neighbour.id}:${step}`,
          district: districtAt(city.registry, feet.x, feet.y, feet.z),
          feet,
          yaw: viewYaw(dx, dz),
        })
        previous = feet
      }
      if (clear) {
        segments++
        poses.push(...local)
      }
    }
  }
  return { segments, poses }
}

function worldRecord(record: MeshRecord): boolean {
  const path = record.path
  return !path.startsWith('viewmodel-hands')
    && !path.startsWith('picker')
    && !path.includes('walk:body-shadow')
    && markedTextPlanes(record.mesh).length === 0
    && record.materials.some(opaqueMaterial)
}

function groundRecord(record: MeshRecord): boolean {
  const path = record.path
  return !path.startsWith('viewmodel-hands')
    && !path.startsWith('picker')
    && !path.includes('walk:body-shadow')
    && markedTextPlanes(record.mesh).length === 0
    && record.materials.some(solidMaterial)
}

const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()

function walkableTriangleGrid(records: readonly MeshRecord[]): TriangleGrid {
  const cells = new Map<string, WalkTriangle[]>()
  const spanning: WalkTriangle[] = []
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (const record of records) {
    const geometry = record.mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const index = geometry.index
    const count = index ? index.count : position.count
    for (let offset = 0; offset + 2 < count; offset += 3) {
      const material = materialForTriangle(record, offset)
      if (!material || !solidMaterial(material)) continue
      const ia = index ? index.getX(offset) : offset
      const ib = index ? index.getX(offset + 1) : offset + 1
      const ic = index ? index.getX(offset + 2) : offset + 2
      _a.fromBufferAttribute(position, ia).applyMatrix4(record.matrix)
      _b.fromBufferAttribute(position, ib).applyMatrix4(record.matrix)
      _c.fromBufferAttribute(position, ic).applyMatrix4(record.matrix)
      normal.crossVectors(ab.subVectors(_b, _a), ac.subVectors(_c, _a))
      if (normal.lengthSq() < 1e-12) continue
      normal.normalize()
      const renderedUp = material.side === THREE.BackSide
        ? -normal.y
        : material.side === THREE.DoubleSide ? Math.abs(normal.y) : normal.y
      if (renderedUp < MAX_WALK_SLOPE_Y) continue
      const a = new THREE.Vector2(_a.x, _a.z)
      const b = new THREE.Vector2(_b.x, _b.z)
      const c = new THREE.Vector2(_c.x, _c.z)
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2
      if (area < 1e-6) continue
      const triangle: WalkTriangle = {
        key: `${record.key}:${offset}`,
        record,
        material,
        a,
        b,
        c,
        bounds: new THREE.Box2().setFromPoints([a, b, c]),
        ay: _a.y,
        by: _b.y,
        cy: _c.y,
        area,
      }
      const x0 = Math.floor(triangle.bounds.min.x / GRID_SPACING)
      const x1 = Math.floor(triangle.bounds.max.x / GRID_SPACING)
      const z0 = Math.floor(triangle.bounds.min.y / GRID_SPACING)
      const z1 = Math.floor(triangle.bounds.max.y / GRID_SPACING)
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 256) {
        spanning.push(triangle)
        continue
      }
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = `${x}:${z}`
          const bucket = cells.get(key) ?? []
          bucket.push(triangle)
          cells.set(key, bucket)
        }
      }
    }
  }
  return { cells, spanning }
}

function renderedGroundAt(grid: TriangleGrid, x: number, z: number): GroundHit[] {
  const hits: GroundHit[] = []
  const point = new THREE.Vector2(x, z)
  const triangles = [
    ...grid.spanning,
    ...(grid.cells.get(`${Math.floor(x / GRID_SPACING)}:${Math.floor(z / GRID_SPACING)}`) ?? []),
  ]
  for (const triangle of triangles) {
    if (!triangle.bounds.containsPoint(point) || !pointInTriangle(point, triangle)) continue
    const denominator = (
      (triangle.b.y - triangle.c.y) * (triangle.a.x - triangle.c.x)
      + (triangle.c.x - triangle.b.x) * (triangle.a.y - triangle.c.y)
    )
    if (Math.abs(denominator) < 1e-10) continue
    const wa = (
      (triangle.b.y - triangle.c.y) * (point.x - triangle.c.x)
      + (triangle.c.x - triangle.b.x) * (point.y - triangle.c.y)
    ) / denominator
    const wb = (
      (triangle.c.y - triangle.a.y) * (point.x - triangle.c.x)
      + (triangle.a.x - triangle.c.x) * (point.y - triangle.c.y)
    ) / denominator
    const wc = 1 - wa - wb
    hits.push({ triangle, y: wa * triangle.ay + wb * triangle.by + wc * triangle.cy })
  }
  return hits.sort((a, b) => b.y - a.y)
}

const _nearBox = new THREE.Box3()
const _cameraBox = new THREE.Box3()
const _triangle = new THREE.Triangle()
const _viewA = new THREE.Vector3()
const _viewB = new THREE.Vector3()
const _viewC = new THREE.Vector3()
const _faceNormal = new THREE.Vector3()
const _faceCenter = new THREE.Vector3()
const _toCamera = new THREE.Vector3()

function nearPlaneRecord(
  camera: THREE.PerspectiveCamera,
  records: readonly MeshRecord[],
): MeshRecord | null {
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.near
  const halfW = halfH * camera.aspect
  _nearBox.min.set(-halfW, -halfH, -camera.near - NEAR_SLAB_EPSILON)
  _nearBox.max.set(halfW, halfH, -camera.near + NEAR_SLAB_EPSILON)
  for (const record of records) {
    _cameraBox.copy(record.box).applyMatrix4(camera.matrixWorldInverse)
    if (!_cameraBox.intersectsBox(_nearBox)) continue
    const geometry = record.mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) continue
    const index = geometry.index
    const count = index ? index.count : position.count
    for (let offset = 0; offset + 2 < count; offset += 3) {
      const material = materialForTriangle(record, offset)
      if (!material || !opaqueMaterial(material)) continue
      const ia = index ? index.getX(offset) : offset
      const ib = index ? index.getX(offset + 1) : offset + 1
      const ic = index ? index.getX(offset + 2) : offset + 2
      _viewA.fromBufferAttribute(position, ia).applyMatrix4(record.matrix).applyMatrix4(camera.matrixWorldInverse)
      _viewB.fromBufferAttribute(position, ib).applyMatrix4(record.matrix).applyMatrix4(camera.matrixWorldInverse)
      _viewC.fromBufferAttribute(position, ic).applyMatrix4(record.matrix).applyMatrix4(camera.matrixWorldInverse)
      _faceNormal.subVectors(_viewB, _viewA).cross(_toCamera.subVectors(_viewC, _viewA))
      _faceCenter.copy(_viewA).add(_viewB).add(_viewC).multiplyScalar(1 / 3)
      const facing = _faceNormal.dot(_toCamera.copy(_faceCenter).multiplyScalar(-1))
      if (
        (material.side === THREE.FrontSide && facing <= 0)
        || (material.side === THREE.BackSide && facing >= 0)
      ) continue
      _triangle.set(_viewA, _viewB, _viewC)
      if (_nearBox.intersectsTriangle(_triangle)) return record
    }
  }
  return null
}

function finding(
  invariant: FirstPersonFinding['invariant'],
  pose: Station | PathPose,
  object: string,
  position: THREE.Vector3,
  detail: string,
): FirstPersonFinding {
  return {
    invariant,
    station: pose.id,
    district: pose.district,
    object,
    position: tuple(position),
    camera: cameraTuple(pose.feet),
    yaw: round(pose.yaw),
    detail,
  }
}

function detailedRecordLabel(record: MeshRecord): string {
  const materials = record.materials.map((material) => material.name).filter(Boolean)
  return materials.length > 0
    ? `${recordLabel(record)} <${materials.join(' / ')}>`
    : recordLabel(record)
}

function setPose(city: FirstPersonCityHandle, pose: Station | PathPose): void {
  city.walk.setPose({
    x: pose.feet.x,
    y: pose.feet.y,
    z: pose.feet.z,
    yaw: pose.yaw,
    pitch: 0,
  })
  city.gfx.scene.updateMatrixWorld(true)
}

function geometryFindings(
  city: FirstPersonCityHandle,
  stations: readonly Station[],
  paths: readonly PathPose[],
  records: readonly MeshRecord[],
): FirstPersonFinding[] {
  const findings: FirstPersonFinding[] = []
  const world = records.filter(worldRecord)
  const groundTriangles = walkableTriangleGrid(records.filter(groundRecord))
  const poses: readonly (Station | PathPose)[] = [...stations, ...paths]
  for (const pose of poses) {
    setPose(city, pose)
    const clipped = nearPlaneRecord(city.gfx.camera, world)
    if (clipped) {
      findings.push(finding(
        'camera-clearance',
        pose,
        detailedRecordLabel(clipped),
        clipped.box.getCenter(new THREE.Vector3()),
        `opaque geometry intersects the ${cameraNear(city).toFixed(3)} m camera near plane`,
      ))
    }

    _point.copy(pose.feet).addScalar(0)
    _point.y += 0.25
    const ground = city.collision.groundAt(_point, 0.9)
    if (ground === null || Math.abs(ground - pose.feet.y) > 0.08) {
      findings.push(finding(
        'ground-continuity',
        pose,
        'collision ground',
        pose.feet,
        ground === null
          ? 'production ground acquisition reaches sky underfoot'
          : `production ground moved from ${pose.feet.y.toFixed(3)} to ${ground.toFixed(3)}`,
      ))
      continue
    }

    const underfoot = renderedGroundAt(groundTriangles, pose.feet.x, pose.feet.z)
    const rendered = underfoot.find((hit) => Math.abs(hit.y - pose.feet.y) <= 0.12)
    if (!rendered) {
      const below = underfoot[0]
      findings.push(finding(
        'ground-continuity',
        pose,
        below ? recordLabel(below.triangle.record) : `collision surface:${pose.district}`,
        below ? new THREE.Vector3(pose.feet.x, below.y, pose.feet.z) : pose.feet,
        below
          ? `first rendered surface is ${(pose.feet.y - below.y).toFixed(3)} m below the collision-certified surface`
          : 'downward eye ray reaches sky before the collision-certified surface',
      ))
    } else {
      const coincident = underfoot.find((hit) => (
        hit.triangle.record.key !== rendered.triangle.record.key
        && !hit.triangle.material.polygonOffset
        && !rendered.triangle.material.polygonOffset
        && Math.abs(hit.y - rendered.y) <= 0.01
      ))
      if (coincident) {
        findings.push(finding(
          'ground-continuity',
          pose,
          `${recordLabel(rendered.triangle.record)} ↔ ${recordLabel(coincident.triangle.record)}`,
          new THREE.Vector3(pose.feet.x, rendered.y, pose.feet.z),
          `opaque surfaces underfoot differ by ${Math.abs(rendered.y - coincident.y).toFixed(4)} m without polygon offset`,
        ))
      }
    }
  }
  return findings
}

function cameraNear(city: FirstPersonCityHandle): number {
  return city.gfx.camera.near
}

function selectionFindings(
  city: FirstPersonCityHandle,
  station: Station,
): FirstPersonFinding[] {
  const picker = city.gfx.scene.getObjectByName('picker')
  if (!picker) return [finding(
    'selection-affordance', station, 'picker', station.feet,
    'the live picker group is absent, so walk-mode suppression cannot be verified',
  )]
  const components = city.registry.all()
  city.bus.emit('select', { id: components[0]?.id ?? null, source: 'building' })
  city.bus.emit('hover', { id: components[1]?.id ?? components[0]?.id ?? null })
  const rendered: string[] = []
  picker.traverse((object) => {
    const candidate = object as THREE.Mesh
    if (
      (candidate.isMesh || (candidate as THREE.LineSegments).isLineSegments)
      && visibleInTree(candidate)
      && materialsOf(candidate).some(renderedMaterial)
    ) rendered.push(objectPath(candidate))
  })
  const findings: FirstPersonFinding[] = []
  if (rendered.length > 0) {
    findings.push(finding(
      'selection-affordance', station, rendered.join(' / '), station.feet,
      'map-scale setting-out circle or selector wire remains rendered in walk mode',
    ))
  }
  if (document.body.style.cursor !== '') {
    findings.push(finding(
      'selection-affordance', station, 'document.body', station.feet,
      `walk-mode hover leaves the map picker cursor set to ${JSON.stringify(document.body.style.cursor)}`,
    ))
  }
  return findings
}

function planeVertices(plane: TextInstance): THREE.Vector3[] | null {
  const mesh = plane.object as THREE.Mesh
  if (!mesh.isMesh || !mesh.geometry) return null
  const position = mesh.geometry.getAttribute('position')
  if (!position || position.count < 4) return null
  const wanted = new THREE.Vector3().fromArray(plane.record.center)
  const localCenter = new THREE.Vector3()
  const vertex = new THREE.Vector3()
  let offset = 0
  let nearest = Number.POSITIVE_INFINITY
  for (let candidate = 0; candidate + 3 < position.count; candidate += 4) {
    localCenter.set(0, 0, 0)
    for (let index = 0; index < 4; index++) {
      localCenter.add(vertex.fromBufferAttribute(position, candidate + index))
    }
    localCenter.multiplyScalar(0.25)
    const distance = localCenter.distanceToSquared(wanted)
    if (distance < nearest) {
      nearest = distance
      offset = candidate
    }
  }
  return [0, 1, 2, 3].map((index) => (
    new THREE.Vector3().fromBufferAttribute(position, offset + index).applyMatrix4(mesh.matrixWorld)
  ))
}

function textFindings(
  city: FirstPersonCityHandle,
  stations: readonly Station[],
  planes: readonly TextInstance[],
  colliders: readonly THREE.Box3[],
  groundTriangles: TriangleGrid,
): FirstPersonFinding[] {
  const findings: FirstPersonFinding[] = []
  const center = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const up = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3()
  const eye = new THREE.Vector3()
  const projected = new THREE.Vector3()
  const height = Math.max(1, window.innerHeight)
  for (const plane of planes) {
    if (
      !plane.record.fixed
      || !visibleInTree(plane.object)
      || !city.gfx.camera.layers.test(plane.object.layers)
    ) continue
    center.fromArray(plane.record.center).applyMatrix4(plane.object.matrixWorld)
    normalMatrix.getNormalMatrix(plane.object.matrixWorld)
    normal.fromArray(plane.record.normal).applyMatrix3(normalMatrix).normalize()
    const material = (plane.object as THREE.Mesh).isMesh
      ? materialsOf(plane.object as THREE.Mesh)[0]
      : null
    if (!material || !renderedMaterial(material)) continue
    const reviewStations = [...stations]
    const horizontalNormal = Math.hypot(normal.x, normal.z)
    if (horizontalNormal > 0.8) {
      /* Every fixed sign gets the same front-normal review distances. Each
       * probe must still pass the production ground, capsule, stability, and
       * rendered-surface tests, so these are pedestrian poses rather than
       * hand-picked camera coordinates. */
      for (const distance of [4, 8, 12, 16, 20, TEXT_REVIEW_DISTANCE]) {
        const x = center.x + (normal.x / horizontalNormal) * distance
        const z = center.z + (normal.z / horizontalNormal) * distance
        const surface = surfacesAt(city, colliders, x, z, center.y + EYE_HEIGHT + 2, -CITY.pit.wallDepth - 2)[0]
        if (
          !surface
          || !renderedGroundAt(groundTriangles, x, z)
            .some((hit) => Math.abs(hit.y - surface.y) <= 0.12)
        ) continue
        const feet = new THREE.Vector3(x, surface.y, z)
        reviewStations.push({
          id: `text:${plane.planeIndex}:${distance}`,
          source: 'collider-approach',
          district: districtAt(city.registry, x, surface.y, z),
          feet,
          yaw: viewYaw(center.x - x, center.z - z),
          surface: surface.surface,
          gridX: null,
          gridZ: null,
        })
      }
    }
    const candidates: { station: Station; distance: number; side: number }[] = []
    for (const station of reviewStations) {
      eye.copy(station.feet)
      eye.y += EYE_HEIGHT
      const distance = eye.distanceTo(center)
      if (distance > TEXT_REVIEW_DISTANCE) continue
      const side = normal.dot(eye.sub(center))
      if (material.side !== THREE.DoubleSide && side <= 0) continue
      candidates.push({ station, distance, side })
    }
    if (candidates.length === 0) continue
    const mirrored = material.side === THREE.DoubleSide
      ? [...candidates].sort((a, b) => a.distance - b.distance).find((candidate) => candidate.side <= 0)
      : undefined
    if (mirrored) {
      findings.push(finding(
        'text-eye-level', mirrored.station, plane.path, center,
        `${JSON.stringify(plane.record.text)} exposes its mirrored reverse side to a pedestrian`,
      ))
      continue
    }
    const vertices = planeVertices(plane)
    if (!vertices) continue
    up.fromArray(plane.record.up).applyMatrix3(normalMatrix).normalize()
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const corner of vertices) {
      const along = projected.copy(corner).sub(center).dot(up)
      low = Math.min(low, along)
      high = Math.max(high, along)
    }
    const verticalEndpoints = [
      center.clone().addScaledVector(up, low),
      center.clone().addScaledVector(up, high),
    ]
    let readable = false
    let best: {
      station: Station
      distance: number
      minY: number
      maxY: number
      pixelHeight: number
      score: number
    } | null = null
    for (const candidate of candidates) {
      eye.copy(candidate.station.feet)
      eye.y += EYE_HEIGHT
      city.gfx.camera.position.copy(eye)
      city.gfx.camera.lookAt(center)
      city.gfx.camera.updateMatrixWorld(true)
      let minY = Number.POSITIVE_INFINITY
      let maxY = Number.NEGATIVE_INFINITY
      let behind = false
      for (const corner of verticalEndpoints) {
        projected.copy(corner).project(city.gfx.camera)
        if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || projected.z < -1 || projected.z > 1) {
          behind = true
          break
        }
        const y = ((1 - projected.y) * height) / 2
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
      if (behind) continue
      const pixelHeight = maxY - minY
      /* A pedestrian can turn along a long sign; requiring the entire line to
       * fit horizontally misclassifies readable fascia and rail labels. A
       * single text line is legible at eye level when its authored height is
       * readable and vertically contained in the viewport. */
      const verticallyContained = minY >= 0 && maxY <= height
      if (verticallyContained && pixelHeight >= MIN_TEXT_PIXELS) {
        readable = true
        break
      }
      const overflow = Math.max(0, -minY) + Math.max(0, maxY - height)
      const score = overflow + Math.max(0, MIN_TEXT_PIXELS - pixelHeight) * 10
      if (!best || score < best.score) {
        best = {
          station: candidate.station,
          distance: candidate.distance,
          minY,
          maxY,
          pixelHeight,
          score,
        }
      }
    }
    if (!readable && best) {
      const detail = best.pixelHeight < MIN_TEXT_PIXELS
        ? `${JSON.stringify(plane.record.text)} has no readable eye-level view within ${TEXT_REVIEW_DISTANCE} m; best is ${best.pixelHeight.toFixed(1)} px tall at ${best.distance.toFixed(1)} m`
        : `${JSON.stringify(plane.record.text)} has no vertically contained eye-level view within ${TEXT_REVIEW_DISTANCE} m; best is ${best.pixelHeight.toFixed(0)} px tall at ${best.distance.toFixed(1)} m`
      findings.push(finding(
        'text-eye-level', best.station, plane.path, center, detail,
      ))
    }
  }
  return findings
}

function stationReport(station: Station): FirstPersonStationReport {
  return {
    id: station.id,
    source: station.source,
    district: station.district,
    feet: tuple(station.feet),
    camera: cameraTuple(station.feet),
    yaw: round(station.yaw),
    surface: station.surface,
  }
}

function stageHandsAt(
  city: FirstPersonCityHandle,
  station: Station,
): void {
  const target = new THREE.Vector3(
    ANCHOR.handleAutovacuum[0] + 0.65,
    ANCHOR.handleAutovacuum[1] + 3.99,
    ANCHOR.handleAutovacuum[2],
  )
  const dx = target.x - station.feet.x
  const dz = target.z - station.feet.z
  city.walk.setPose({
    x: station.feet.x,
    y: station.feet.y,
    z: station.feet.z,
    yaw: viewYaw(dx, dz),
    pitch: -0.08,
  })
  city.hands.setQuality('high')
  city.hands.setNearby('lever', target.x, target.y, target.z)
  for (let frame = 0; frame < 90; frame++) city.hands.update(1 / 60)
  city.gfx.scene.updateMatrixWorld(true)
}

function handsFindings(
  city: FirstPersonCityHandle,
  stations: readonly Station[],
  worldRecords: readonly MeshRecord[],
): { report: FirstPersonSweepReport['hands']; findings: FirstPersonFinding[]; station: Station } {
  const target = new THREE.Vector3(...ANCHOR.handleAutovacuum)
  const station = [...stations].sort(
    (a, b) => a.feet.distanceToSquared(target) - b.feet.distanceToSquared(target),
  )[0]
  if (!station) throw new Error('first-person sweep derived no hand-review station')
  city.hands.clearNearby()
  for (let frame = 0; frame < 120; frame++) city.hands.update(1 / 60)
  const findings: FirstPersonFinding[] = []
  if (city.hands.group.visible) {
    findings.push(finding('hands', station, city.hands.group.name, station.feet, 'hands remain visible without an interaction cue'))
  }
  stageHandsAt(city, station)
  const visibleHands = ['viewmodel-hand:left', 'viewmodel-hand:right'].filter(
    (name) => visibleInTree(city.hands.group.getObjectByName(name) ?? new THREE.Object3D()),
  ).length
  const meshes: THREE.Mesh[] = []
  let meshInstances = 0
  city.hands.group.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !visibleInTree(mesh)) return
    meshes.push(mesh)
    meshInstances += (mesh as THREE.InstancedMesh).isInstancedMesh
      ? (mesh as THREE.InstancedMesh).count
      : 1
  })
  if (!city.hands.group.visible || visibleHands !== 1 || meshes.length === 0) {
    findings.push(finding(
      'hands', station, city.hands.group.name, station.feet,
      `interaction cue has group=${city.hands.group.visible}, visibleHands=${visibleHands}, meshes=${meshes.length}`,
    ))
  }
  const handBox = new THREE.Box3()
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position')
    if (!position || position.count < 3) {
      findings.push(finding('hands', station, objectPath(mesh), mesh.getWorldPosition(new THREE.Vector3()), 'visible hand mesh has no triangle geometry'))
      continue
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox
    if (!box || box.isEmpty()) {
      findings.push(finding('hands', station, objectPath(mesh), mesh.getWorldPosition(new THREE.Vector3()), 'visible hand mesh has a degenerate bounding box'))
      continue
    }
    const size = box.getSize(new THREE.Vector3())
    if ([size.x, size.y, size.z].filter((value) => value > 1e-4).length < 2) {
      findings.push(finding('hands', station, objectPath(mesh), mesh.getWorldPosition(new THREE.Vector3()), `visible hand mesh degenerates to ${size.toArray().join('×')}`))
    }
    handBox.setFromObject(mesh)
    const overlap = worldRecords.find((record) => worldRecord(record) && record.box.intersectsBox(handBox))
    if (overlap) {
      findings.push(finding(
        'hands', station, `${objectPath(mesh)} ↔ ${recordLabel(overlap)}`,
        handBox.getCenter(new THREE.Vector3()), 'first-person hand geometry intersects opaque world geometry',
      ))
    }
    _cameraBox.copy(handBox).applyMatrix4(city.gfx.camera.matrixWorldInverse)
    if (_cameraBox.max.z >= -city.gfx.camera.near || _cameraBox.min.z >= 0) {
      findings.push(finding(
        'hands', station, objectPath(mesh), handBox.getCenter(new THREE.Vector3()),
        'visible hand geometry crosses the camera or its near plane',
      ))
    }
  }
  return {
    report: {
      station: stationReport(station),
      visibleHands,
      visibleMeshes: meshes.length,
      meshInstances,
    },
    findings,
    station,
  }
}

function dedupeFindings(findings: readonly FirstPersonFinding[]): FirstPersonFinding[] {
  const seen = new Set<string>()
  return findings.filter((item) => {
    const key = `${item.invariant}:${item.station}:${item.object}:${item.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function runFirstPersonSweep(city: FirstPersonCityHandle): Promise<FirstPersonSweepReport> {
  city.bus.emit('camera:mode', { mode: 'walk' })
  /* The camera-mode transition starts with an asynchronous descent from the
   * orbit altitude. Put it at a production-layout outer-ground coordinate so
   * LOD has deterministically selected pedestrian detail before enumeration. */
  const worldBounds = DISTRICT_BOUNDS.world
  city.walk.setPose({
    x: worldBounds.x[0] + GRID_SPACING,
    y: 0,
    z: worldBounds.z[0] + GRID_SPACING,
    yaw: 0,
    pitch: 0,
  })
  await waitFrames(2)
  const scene = city.gfx.scene
  scene.updateMatrixWorld(true)
  const resolveDistrict = districtResolver(city.registry)
  const colliders = enumerateColliders(city.collision.debugMesh())
  const records = enumerateMeshes(scene, resolveDistrict)
  const groundTriangles = walkableTriangleGrid(records.filter(groundRecord))
  const stations = deriveStations(city, colliders, groundTriangles)
  const paths = segmentPoses(city, stations)
  const text = enumerateText(scene, resolveDistrict)
  const objectIds = new Set<string>()
  const meshIds = new Set<string>()
  scene.traverse((object) => {
    if (!visibleInTree(object)) return
    objectIds.add(object.uuid)
    if ((object as THREE.Mesh).isMesh) meshIds.add(object.uuid)
  })

  const geometry = geometryFindings(city, stations, paths.poses, records)
  const selection = selectionFindings(city, stations[0])
  const textAtEye = textFindings(city, stations, text.instances, colliders, groundTriangles)
  const hands = handsFindings(city, stations, records)
  const findings = dedupeFindings([...geometry, ...selection, ...textAtEye, ...hands.findings])

  return {
    stations: stations.map(stationReport),
    surfaceGridStations: stations.filter((station) => station.source === 'surface-grid').length,
    colliderApproachStations: stations.filter((station) => station.source === 'collider-approach').length,
    traversalSegments: paths.segments,
    traversalSamples: paths.poses.length,
    sceneObjects: objectIds.size,
    meshObjects: meshIds.size,
    meshInstances: records.length,
    textPlanes: text.instances.length,
    colliderBoxes: colliders.length,
    hands: hands.report,
    findings,
  }
}

/** Re-introduce the wall-clipping camera used before the pedestrian clearance fix. */
export async function proveNearPlaneDetection(city: FirstPersonCityHandle): Promise<FirstPersonFinding[]> {
  const camera = city.gfx.camera
  const originalNear = camera.near
  const resolveDistrict = districtResolver(city.registry)
  const colliders = enumerateColliders(city.collision.debugMesh())
  const allRecords = enumerateMeshes(city.gfx.scene, resolveDistrict)
  const groundTriangles = walkableTriangleGrid(allRecords.filter(groundRecord))
  const stations = deriveStations(city, colliders, groundTriangles).filter((station) => station.source === 'collider-approach')
  const records = allRecords.filter(worldRecord)
  camera.near = 0.5
  camera.updateProjectionMatrix()
  try {
    for (const station of stations) {
      setPose(city, station)
      const record = nearPlaneRecord(camera, records)
      if (record) {
        return [finding(
          'camera-clearance', station, recordLabel(record), record.box.getCenter(new THREE.Vector3()),
          'historical 0.500 m near plane intersects opaque geometry at collision contact',
        )]
      }
    }
    return []
  } finally {
    camera.near = originalNear
    camera.updateProjectionMatrix()
    await waitFrames(1)
  }
}

export async function stageFirstPersonFinding(
  city: FirstPersonCityHandle,
  findingToStage: FirstPersonFinding,
): Promise<void> {
  city.walk.setPose({
    x: findingToStage.camera[0],
    y: findingToStage.camera[1] - EYE_HEIGHT,
    z: findingToStage.camera[2],
    yaw: findingToStage.yaw,
    pitch: 0,
  })
  city.hands.clearNearby()
  await waitFrames(2)
}

export async function stageHandsScreenshot(
  city: FirstPersonCityHandle,
  station: FirstPersonStationReport,
): Promise<void> {
  stageHandsAt(city, {
    id: station.id,
    source: station.source,
    district: station.district as DistrictId,
    feet: new THREE.Vector3(...station.feet),
    yaw: station.yaw,
    surface: station.surface,
    gridX: null,
    gridZ: null,
  })
  await waitFrames(2)
}
