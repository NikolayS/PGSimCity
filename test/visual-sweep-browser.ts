import * as THREE from 'three'

import type { ComponentDef, DistrictId, FocusSpec } from '../src/core/types'
import { CITY, DISTRICT_BOUNDS, type Bounds } from '../src/world/layout'
import { markedTextPlanes, type TextPlaneRecord } from '../src/world/text-plane'

const UP = new THREE.Vector3(0, 1, 0)
const TEXT_CLEARANCE = 2.5
const SURFACE_SUPPORT_GAP = 0.15
const BORDER_LEVEL_TOLERANCE = 0.01
const Z_FIGHT_Y_TOLERANCE = 0.01
const MIN_SURFACE_AREA = 64
const MIN_TRIANGLE_AREA = 0.002
const GROUND_PROBE_MAX_SPACING = 8
const GROUND_BOUNDARY_TOLERANCE = 0.02
const SURFACE_WORD = /(?:^|[.:/\s-])(ground|floor|deck|apron|forecourt|yard|platform|pad|plinth|surface|stylobate)(?:$|[.:/\s-])/i

export interface CityHandle {
  readonly gfx: {
    readonly scene: THREE.Scene
    readonly camera: THREE.PerspectiveCamera
  }
  readonly rig: {
    focusOn(spec: FocusSpec, options?: { instant?: boolean }): void
  }
  readonly registry: {
    all(): readonly ComponentDef[]
  }
  readonly collision: {
    debugMesh(): THREE.LineSegments
  }
}

export interface SweepFinding {
  readonly invariant: 'text-legibility' | 'no-sky' | 'surfaces-seated' | 'border-alignment' | 'z-fighting'
  readonly station: string
  readonly district: string
  readonly object: string
  readonly position: readonly [number, number, number]
  readonly detail: string
}

export interface SweepStationReport {
  readonly district: string
  readonly target: readonly [number, number, number]
  readonly camera: readonly [number, number, number]
  readonly objects: number
  readonly meshInstances: number
  readonly textPlanes: number
  readonly surfaces: number
  readonly borders: number
  readonly opaqueTriangles: number
}

export interface VisualSweepReport {
  readonly stations: readonly SweepStationReport[]
  readonly sceneObjects: number
  readonly meshObjects: number
  readonly meshInstances: number
  readonly textPlanes: number
  readonly districtSurfaces: number
  readonly borderStrips: number
  readonly opaqueHorizontalTriangles: number
  readonly findings: readonly SweepFinding[]
}

interface Station {
  readonly district: DistrictId
  readonly bounds: Bounds
  readonly target: readonly [number, number, number]
  readonly focus: FocusSpec
}

export interface MeshRecord {
  readonly mesh: THREE.Mesh
  readonly instanceId: number | null
  readonly key: string
  readonly path: string
  readonly district: DistrictId | null
  readonly box: THREE.Box3
  readonly matrix: THREE.Matrix4
  readonly materials: readonly THREE.Material[]
}

export interface HorizontalTriangle {
  readonly key: string
  readonly record: MeshRecord
  readonly material: THREE.Material
  readonly a: THREE.Vector2
  readonly b: THREE.Vector2
  readonly c: THREE.Vector2
  readonly bounds: THREE.Box2
  readonly y: number
  readonly area: number
}

interface SurfaceRecord {
  readonly record: MeshRecord
  readonly triangles: readonly HorizontalTriangle[]
  readonly area: number
}

export interface TextInstance {
  readonly object: THREE.Object3D
  readonly record: TextPlaneRecord
  readonly planeIndex: number
  readonly district: DistrictId | null
  readonly path: string
}

function round(value: number): number {
  return Number(value.toFixed(3))
}

function pointTuple(point: THREE.Vector3): [number, number, number] {
  return [round(point.x), round(point.y), round(point.z)]
}

export function objectPath(object: THREE.Object3D): string {
  const parts: string[] = []
  let current: THREE.Object3D | null = object
  while (current && !current.isScene) {
    parts.push(current.name || current.type)
    current = current.parent
  }
  return parts.reverse().join('/')
}

export function visibleInTree(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  return true
}

export function renderedMaterial(material: THREE.Material): boolean {
  return material.visible && material.colorWrite && material.opacity > 0.01
}

export function solidMaterial(material: THREE.Material): boolean {
  return renderedMaterial(material) && material.opacity >= 0.98 && material.depthWrite !== false
}

export function opaqueMaterial(material: THREE.Material): boolean {
  return solidMaterial(material) && !material.transparent
}

export function materialsOf(mesh: THREE.Mesh): readonly THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

export function districtResolver(registry: CityHandle['registry']): (object: THREE.Object3D) => DistrictId | null {
  const roots = new Map<THREE.Object3D, DistrictId>()
  for (const component of registry.all()) roots.set(component.object, component.district)
  const districtNames = new Set(Object.keys(DISTRICT_BOUNDS) as DistrictId[])

  return (object: THREE.Object3D): DistrictId | null => {
    /* Ground sub-components such as the pit are registered for picking as the
     * district they explain. Geometrically they remain the world foundation. */
    for (let owner: THREE.Object3D | null = object; owner && !owner.isScene; owner = owner.parent) {
      const zone = owner.name.match(/^ground\.zone\.(.+)$/)?.[1]
      if (zone && districtNames.has(zone as DistrictId)) return zone as DistrictId
      if (owner.name === 'world.ground') return 'world'
      if (owner.name === 'world.continuity') return 'world'
      if (owner.name === 'buffer.water') return 'shmem'
    }
    let current: THREE.Object3D | null = object
    while (current && !current.isScene) {
      const registered = roots.get(current)
      if (registered) return registered
      const named = current.name.startsWith('district:')
        ? current.name.slice('district:'.length)
        : current.name
      if (districtNames.has(named as DistrictId)) return named as DistrictId
      if (current.name === 'access' || current.name === 'roads') {
        return 'world'
      }
      current = current.parent
    }
    return null
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function createStations(registry: CityHandle['registry']): Station[] {
  const components = registry.all()
  return (Object.entries(DISTRICT_BOUNDS) as [DistrictId, Bounds][]).map(([district, bounds]) => {
    const targets = components
      .filter((component) => component.district === district)
      .map((component) => component.focus.target)
    const x = (bounds.x[0] + bounds.x[1]) / 2
    const z = (bounds.z[0] + bounds.z[1]) / 2
    const y = median(targets.map((target) => target[1]))
    const distance = Math.min(130, Math.max(58, Math.hypot(
      bounds.x[1] - bounds.x[0],
      bounds.z[1] - bounds.z[0],
    ) * 0.38))
    const target: [number, number, number] = [x, y, z]
    return {
      district,
      bounds,
      target,
      focus: { target, distance, dir: [0.82, 0.46, 1] },
    }
  })
}

export function enumerateMeshes(
  scene: THREE.Scene,
  resolveDistrict: (object: THREE.Object3D) => DistrictId | null,
): MeshRecord[] {
  scene.updateMatrixWorld(true)
  const records: MeshRecord[] = []
  const localBox = new THREE.Box3()
  const instanceMatrix = new THREE.Matrix4()
  const worldMatrix = new THREE.Matrix4()

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !visibleInTree(mesh)) return
    const materials = materialsOf(mesh)
    if (!materials.some(renderedMaterial)) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const geometryBox = mesh.geometry.boundingBox
    if (!geometryBox || geometryBox.isEmpty()) return
    const path = objectPath(mesh)
    const district = resolveDistrict(mesh)
    const instanced = mesh as THREE.InstancedMesh
    if (instanced.isInstancedMesh) {
      for (let instanceId = 0; instanceId < instanced.count; instanceId++) {
        instanced.getMatrixAt(instanceId, instanceMatrix)
        worldMatrix.multiplyMatrices(instanced.matrixWorld, instanceMatrix)
        localBox.copy(geometryBox).applyMatrix4(worldMatrix)
        if (localBox.isEmpty()) continue
        const size = localBox.getSize(new THREE.Vector3())
        if (size.lengthSq() < 1e-10) continue
        records.push({
          mesh,
          instanceId,
          key: `${mesh.uuid}:${instanceId}`,
          path,
          district,
          box: localBox.clone(),
          matrix: worldMatrix.clone(),
          materials,
        })
      }
      return
    }
    localBox.copy(geometryBox).applyMatrix4(mesh.matrixWorld)
    records.push({
      mesh,
      instanceId: null,
      key: mesh.uuid,
      path,
      district,
      box: localBox.clone(),
      matrix: mesh.matrixWorld.clone(),
      materials,
    })
  })
  return records
}

export function materialForTriangle(
  record: MeshRecord,
  triangleOffset: number,
): THREE.Material | null {
  if (record.materials.length === 1) return record.materials[0]
  const groups = record.mesh.geometry.groups
  const group = groups.find(
    (candidate) => triangleOffset >= candidate.start && triangleOffset < candidate.start + candidate.count,
  )
  return record.materials[group?.materialIndex ?? 0] ?? null
}

export function horizontalTriangles(record: MeshRecord, opaqueOnly: boolean): HorizontalTriangle[] {
  const geometry = record.mesh.geometry
  const position = geometry.getAttribute('position')
  if (!position) return []
  const index = geometry.index
  const count = index ? index.count : position.count
  const a3 = new THREE.Vector3()
  const b3 = new THREE.Vector3()
  const c3 = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const triangles: HorizontalTriangle[] = []

  for (let offset = 0; offset + 2 < count; offset += 3) {
    const material = materialForTriangle(record, offset)
    if (!material || !(opaqueOnly ? opaqueMaterial(material) : solidMaterial(material))) continue
    const ia = index ? index.getX(offset) : offset
    const ib = index ? index.getX(offset + 1) : offset + 1
    const ic = index ? index.getX(offset + 2) : offset + 2
    a3.fromBufferAttribute(position, ia).applyMatrix4(record.matrix)
    b3.fromBufferAttribute(position, ib).applyMatrix4(record.matrix)
    c3.fromBufferAttribute(position, ic).applyMatrix4(record.matrix)
    ab.subVectors(b3, a3)
    ac.subVectors(c3, a3)
    normal.crossVectors(ab, ac)
    if (normal.lengthSq() < 1e-12) continue
    normal.normalize()
    if (normal.y < 0.995) continue
    const a = new THREE.Vector2(a3.x, a3.z)
    const b = new THREE.Vector2(b3.x, b3.z)
    const c = new THREE.Vector2(c3.x, c3.z)
    const area = Math.abs(
      (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x),
    ) / 2
    if (area < MIN_TRIANGLE_AREA) continue
    triangles.push({
      key: `${record.key}:${offset}`,
      record,
      material,
      a,
      b,
      c,
      bounds: new THREE.Box2().setFromPoints([a, b, c]),
      y: (a3.y + b3.y + c3.y) / 3,
      area,
    })
  }
  return triangles
}

function mappedText(mesh: THREE.Mesh): string[] {
  const text: string[] = []
  for (const material of materialsOf(mesh)) {
    const map = (material as THREE.Material & { map?: THREE.Texture | null }).map
    const strings = map?.userData.pgText as string[] | undefined
    if (strings) text.push(...strings)
  }
  return text
}

export function enumerateText(
  scene: THREE.Scene,
  resolveDistrict: (object: THREE.Object3D) => DistrictId | null,
): { instances: TextInstance[]; unmarked: string[] } {
  const instances: TextInstance[] = []
  const unmarked: string[] = []
  scene.traverse((object) => {
    const records = markedTextPlanes(object)
    for (let planeIndex = 0; planeIndex < records.length; planeIndex++) {
      instances.push({
        object,
        record: records[planeIndex],
        planeIndex,
        district: resolveDistrict(object),
        path: objectPath(object),
      })
    }
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !visibleInTree(mesh)) return
    const text = mappedText(mesh)
    if (text.length > 0 && markedTextPlanes(mesh).length === 0) {
      unmarked.push(`${objectPath(mesh)} maps ${text.join(' / ')} without legibility geometry`)
    }
  })
  return { instances, unmarked }
}

export function enumerateColliders(debug: THREE.LineSegments): THREE.Box3[] {
  const position = debug.geometry.getAttribute('position')
  const boxes: THREE.Box3[] = []
  const point = new THREE.Vector3()
  for (let offset = 0; offset < position.count; offset += 24) {
    const box = new THREE.Box3()
    for (let index = offset; index < offset + 24; index++) {
      point.fromBufferAttribute(position, index)
      box.expandByPoint(point)
    }
    boxes.push(box)
  }
  return boxes
}

function firstColliderDistance(
  center: THREE.Vector3,
  normal: THREE.Vector3,
  colliders: readonly THREE.Box3[],
): number | null {
  const start = 0.08
  const origin = center.clone().addScaledVector(normal, start)
  const ray = new THREE.Ray(origin, normal)
  const hit = new THREE.Vector3()
  let nearest = Number.POSITIVE_INFINITY
  for (const box of colliders) {
    if (box.containsPoint(center)) continue
    if (box.containsPoint(origin)) return start
    if (!ray.intersectBox(box, hit)) continue
    const distance = hit.distanceTo(center)
    if (distance >= start && distance <= TEXT_CLEARANCE && distance < nearest) nearest = distance
  }
  return Number.isFinite(nearest) ? nearest : null
}

function firstRenderedDistance(
  scene: THREE.Scene,
  center: THREE.Vector3,
  normal: THREE.Vector3,
  ignored: THREE.Object3D,
  raycaster: THREE.Raycaster,
): number | null {
  raycaster.set(center, normal)
  raycaster.near = 0.08
  raycaster.far = TEXT_CLEARANCE
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    const mesh = hit.object as THREE.Mesh
    if (!mesh.isMesh || mesh === ignored || !visibleInTree(mesh)) continue
    if (markedTextPlanes(mesh).length > 0 || !materialsOf(mesh).some(solidMaterial)) continue
    return hit.distance
  }
  return null
}

function stationForDistrict(district: DistrictId | null): DistrictId {
  return district && DISTRICT_BOUNDS[district] ? district : 'world'
}

function textFindings(
  city: CityHandle,
  text: ReturnType<typeof enumerateText>,
  colliders: readonly THREE.Box3[],
): SweepFinding[] {
  const findings: SweepFinding[] = text.unmarked.map((detail) => ({
    invariant: 'text-legibility',
    station: 'world',
    district: 'world',
    object: detail.split(' maps ')[0],
    position: [0, 0, 0],
    detail,
  }))
  const center = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const up = new THREE.Vector3()
  const expectedUp = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3()
  const raycaster = new THREE.Raycaster()
  const minimumUpDot = Math.cos(THREE.MathUtils.degToRad(35))

  for (const plane of text.instances) {
    const determinant = plane.object.matrixWorld.determinant()
    const station = stationForDistrict(plane.district)
    center.fromArray(plane.record.center).applyMatrix4(plane.object.matrixWorld)
    if (!(determinant > 0)) {
      findings.push({
        invariant: 'text-legibility',
        station,
        district: station,
        object: plane.path,
        position: pointTuple(center),
        detail: `${JSON.stringify(plane.record.text)} has mirrored world determinant ${determinant.toFixed(3)}`,
      })
      continue
    }
    if (!plane.record.fixed) continue
    normalMatrix.getNormalMatrix(plane.object.matrixWorld)
    normal.fromArray(plane.record.normal).applyMatrix3(normalMatrix).normalize()
    up.fromArray(plane.record.up).transformDirection(plane.object.matrixWorld)
    expectedUp.copy(UP).addScaledVector(normal, -UP.dot(normal))
    if (expectedUp.lengthSq() > 0.0625) {
      expectedUp.normalize()
      const upDot = up.dot(expectedUp)
      if (upDot < minimumUpDot) {
        findings.push({
          invariant: 'text-legibility',
          station,
          district: station,
          object: plane.path,
          position: pointTuple(center),
          detail: `${JSON.stringify(plane.record.text)} is not upright (up dot ${upDot.toFixed(3)})`,
        })
      }
    }
    const collider = firstColliderDistance(center, normal, colliders)
    const rendered = firstRenderedDistance(city.gfx.scene, center, normal, plane.object, raycaster)
    const blocked = collider === null ? rendered : rendered === null ? collider : Math.min(collider, rendered)
    if (blocked !== null) {
      findings.push({
        invariant: 'text-legibility',
        station,
        district: station,
        object: plane.path,
        position: pointTuple(center),
        detail: `${JSON.stringify(plane.record.text)} faces into structure ${blocked.toFixed(2)} units from its readable side`,
      })
    }
  }
  return findings
}

function semanticSurface(record: MeshRecord): boolean {
  const identity = `${record.mesh.name} ${record.materials.map((material) => material.name).join(' ')}`
  return SURFACE_WORD.test(identity) || mappedText(record.mesh).some((text) => /floor plan/i.test(text))
}

function semanticBorder(record: MeshRecord): boolean {
  const identity = `${record.mesh.name} ${record.materials.map((material) => material.name).join(' ')}`
  return /rim|kerb|curb|border|coping|edge/i.test(identity)
}

function discoverSurfaces(
  records: readonly MeshRecord[],
  trianglesByRecord: ReadonlyMap<string, readonly HorizontalTriangle[]>,
): SurfaceRecord[] {
  const surfaces: SurfaceRecord[] = []
  for (const record of records) {
    if (!record.district || record.district === 'world') continue
    const size = record.box.getSize(new THREE.Vector3())
    const footprint = size.x * size.z
    if (footprint < MIN_SURFACE_AREA || size.y > 1.25 || !semanticSurface(record)) continue
    const triangles = trianglesByRecord.get(record.key) ?? []
    const area = triangles.reduce((sum, triangle) => sum + triangle.area, 0)
    if (area < Math.min(16, footprint * 0.12)) continue
    /* A strip or hollow ring is a boundary, even when its parent is a deck. */
    if (Math.min(size.x, size.z) <= 2 || area / footprint < 0.45) continue
    surfaces.push({ record, triangles, area })
  }
  return surfaces
}

export function recordLabel(record: MeshRecord): string {
  return record.instanceId === null ? record.path : `${record.path}[${record.instanceId}]`
}

function sampleSurfacePoints(surface: SurfaceRecord): THREE.Vector3[] {
  const source = surface.triangles
  const samples: THREE.Vector3[] = []
  const count = Math.min(9, source.length)
  for (let index = 0; index < count; index++) {
    const triangle = source[Math.floor((index * source.length) / count)]
    samples.push(new THREE.Vector3(
      (triangle.a.x + triangle.b.x + triangle.c.x) / 3,
      triangle.y,
      (triangle.a.y + triangle.b.y + triangle.c.y) / 3,
    ))
  }
  return samples
}

export function pointInTriangle(point: THREE.Vector2, triangle: HorizontalTriangle): boolean {
  const sign = (p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2): number => (
    (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y)
  )
  const d1 = sign(point, triangle.a, triangle.b)
  const d2 = sign(point, triangle.b, triangle.c)
  const d3 = sign(point, triangle.c, triangle.a)
  const hasNegative = d1 < -1e-7 || d2 < -1e-7 || d3 < -1e-7
  const hasPositive = d1 > 1e-7 || d2 > 1e-7 || d3 > 1e-7
  return !(hasNegative && hasPositive)
}

function closestSupportAt(
  point: THREE.Vector3,
  level: number,
  candidate: MeshRecord,
  supportTriangles: readonly HorizontalTriangle[],
): HorizontalTriangle | null {
  const projected = new THREE.Vector2(point.x, point.z)
  let support: HorizontalTriangle | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const triangle of supportTriangles) {
    if (triangle.record.key === candidate.key || !triangle.bounds.containsPoint(projected)) continue
    const levelDistance = Math.abs(triangle.y - level)
    if (levelDistance >= distance || !pointInTriangle(projected, triangle)) continue
    support = triangle
    distance = levelDistance
  }
  return support
}

function closestSolidSupport(
  surface: SurfaceRecord,
  bottom: number,
  supportTriangles: readonly HorizontalTriangle[],
): { triangle: HorizontalTriangle; area: number } | null {
  let support: { triangle: HorizontalTriangle; area: number } | null = null
  let distance = Number.POSITIVE_INFINITY
  for (const own of surface.triangles) {
    for (const candidate of supportTriangles) {
      if (candidate.record.key === surface.record.key) continue
      const levelDistance = Math.abs(candidate.y - bottom)
      if (levelDistance > SURFACE_SUPPORT_GAP || levelDistance > distance) continue
      if (!own.bounds.intersectsBox(candidate.bounds)) continue
      const area = triangleOverlapArea(own, candidate)
      if (area <= 0.001) continue
      support = { triangle: candidate, area }
      distance = levelDistance
    }
  }
  return support
}

function surfaceFindings(
  surfaces: readonly SurfaceRecord[],
  supportTriangles: readonly HorizontalTriangle[],
): SweepFinding[] {
  const findings: SweepFinding[] = []
  for (const surface of surfaces) {
    const district = surface.record.district!
    const bounds = DISTRICT_BOUNDS[district]
    const box = surface.record.box
    if (
      box.min.x < bounds.x[0] - BORDER_LEVEL_TOLERANCE
      || box.max.x > bounds.x[1] + BORDER_LEVEL_TOLERANCE
      || box.min.z < bounds.z[0] - BORDER_LEVEL_TOLERANCE
      || box.max.z > bounds.z[1] + BORDER_LEVEL_TOLERANCE
    ) {
      findings.push({
        invariant: 'surfaces-seated',
        station: district,
        district,
        object: recordLabel(surface.record),
        position: pointTuple(box.getCenter(new THREE.Vector3())),
        detail: `surface bounds x=[${box.min.x.toFixed(2)}, ${box.max.x.toFixed(2)}], z=[${box.min.z.toFixed(2)}, ${box.max.z.toFixed(2)}] exceed declared x=[${bounds.x[0]}, ${bounds.x[1]}], z=[${bounds.z[0]}, ${bounds.z[1]}]`,
      })
    }
    const thickness = box.max.y - box.min.y
    const bottom = thickness < 0.005 ? box.max.y : box.min.y
    if (thickness >= 0.005) {
      const support = closestSolidSupport(surface, bottom, supportTriangles)
      if (!support) {
        findings.push({
          invariant: 'surfaces-seated',
          station: district,
          district,
          object: recordLabel(surface.record),
          position: pointTuple(box.getCenter(new THREE.Vector3())),
          detail: `solid surface has no rendered support meeting its bottom at y=${bottom.toFixed(3)}`,
        })
      }
      continue
    }
    for (const point of sampleSurfacePoints(surface)) {
      const support = closestSupportAt(point, bottom, surface.record, supportTriangles)
      if (!support) {
        findings.push({
          invariant: 'surfaces-seated',
          station: district,
          district,
          object: recordLabel(surface.record),
          position: pointTuple(point),
          detail: 'surface has sky beneath it; no rendered support covers this sample',
        })
        break
      }
      const gap = bottom - support.y
      if (gap > SURFACE_SUPPORT_GAP || gap < -BORDER_LEVEL_TOLERANCE) {
        findings.push({
          invariant: 'surfaces-seated',
          station: district,
          district,
          object: recordLabel(surface.record),
          position: pointTuple(point),
          detail: gap > 0
            ? `surface floats ${gap.toFixed(3)} units above ${recordLabel(support.record)}`
            : `surface is sunk ${Math.abs(gap).toFixed(3)} units below ${recordLabel(support.record)}`,
        })
        break
      }
    }
  }
  return findings
}

function discoverBorders(
  records: readonly MeshRecord[],
  trianglesByRecord: ReadonlyMap<string, readonly HorizontalTriangle[]>,
  supportSurfaces: readonly SurfaceRecord[],
): SurfaceRecord[] {
  const borders: SurfaceRecord[] = []
  for (const record of records) {
    if (!record.district) continue
    const size = record.box.getSize(new THREE.Vector3())
    const footprint = size.x * size.z
    if (footprint < 1 || size.y > 0.4) continue
    const triangles = trianglesByRecord.get(record.key) ?? []
    const area = triangles.reduce((sum, triangle) => sum + triangle.area, 0)
    if (area < 0.2) continue
    const semantic = semanticBorder(record)
    const strip = Math.min(size.x, size.z) <= 2 && Math.max(size.x, size.z) >= 2
    const ring = record.mesh.geometry.type === 'ShapeGeometry'
      && Math.min(size.x, size.z) > 2
      && footprint > 0
      && area / footprint < 0.45
    let geometricBoundary = ring
    if (!semantic && strip && !geometricBoundary) {
      const surfaceParent = SURFACE_WORD.test(record.mesh.parent?.name ?? '')
      geometricBoundary = surfaceParent && supportSurfaces.some((surface) => {
        if (surface.record.key === record.key) return false
        if (surface.record.mesh === record.mesh || !semanticSurface(surface.record)) return false
        const surfaceBox = surface.record.box
        const levelDistance = Math.abs(surfaceBox.max.y - record.box.max.y)
        if (levelDistance > 1) return false
        const hugsX = Math.abs(record.box.min.x - surfaceBox.min.x) <= 1
          || Math.abs(record.box.max.x - surfaceBox.max.x) <= 1
        const hugsZ = Math.abs(record.box.min.z - surfaceBox.min.z) <= 1
          || Math.abs(record.box.max.z - surfaceBox.max.z) <= 1
        return hugsX || hugsZ
      })
    }
    if (semantic || geometricBoundary) borders.push({ record, triangles, area })
  }
  return borders
}

function borderFindings(
  borders: readonly SurfaceRecord[],
  supportSurfaces: readonly SurfaceRecord[],
): SweepFinding[] {
  const findings: SweepFinding[] = []
  for (const border of borders) {
    const box = border.record.box
    let adjacent: { surface: SurfaceRecord; borderY: number; surfaceY: number; area: number } | null = null
    let nearest = Number.POSITIVE_INFINITY
    for (const surface of supportSurfaces) {
      if (surface.record.key === border.record.key) continue
      if (stationForDistrict(surface.record.district) !== stationForDistrict(border.record.district)) continue
      if (surface.area < border.area * 1.25) continue
      for (const borderTriangle of border.triangles) {
        for (const surfaceTriangle of surface.triangles) {
          const levelDistance = Math.abs(surfaceTriangle.y - borderTriangle.y)
          if (levelDistance > 1 || levelDistance > nearest) continue
          if (!borderTriangle.bounds.intersectsBox(surfaceTriangle.bounds)) continue
          const area = triangleOverlapArea(borderTriangle, surfaceTriangle)
          if (area <= 0.001 || area / borderTriangle.area < 0.05) continue
          adjacent = {
            surface,
            borderY: borderTriangle.y,
            surfaceY: surfaceTriangle.y,
            area,
          }
          nearest = levelDistance
        }
      }
    }
    if (!adjacent || adjacent.surfaceY <= adjacent.borderY + BORDER_LEVEL_TOLERANCE) continue
    const district = stationForDistrict(border.record.district)
    findings.push({
      invariant: 'border-alignment',
      station: district,
      district,
      object: recordLabel(border.record),
      position: pointTuple(box.getCenter(new THREE.Vector3())),
      detail: `border top ${adjacent.borderY.toFixed(3)} sits below adjacent ${recordLabel(adjacent.surface.record)} surface ${adjacent.surfaceY.toFixed(3)} (XZ overlap ${adjacent.area.toFixed(3)})`,
    })
  }
  return findings
}

function signedArea(points: readonly THREE.Vector2[]): number {
  let area = 0
  for (let index = 0; index < points.length; index++) {
    const a = points[index]
    const b = points[(index + 1) % points.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

function inside(point: THREE.Vector2, edgeA: THREE.Vector2, edgeB: THREE.Vector2, orientation: number): boolean {
  const cross = (edgeB.x - edgeA.x) * (point.y - edgeA.y) - (edgeB.y - edgeA.y) * (point.x - edgeA.x)
  return orientation * cross >= -1e-9
}

function lineIntersection(
  a: THREE.Vector2,
  b: THREE.Vector2,
  edgeA: THREE.Vector2,
  edgeB: THREE.Vector2,
): THREE.Vector2 {
  const rx = b.x - a.x
  const ry = b.y - a.y
  const sx = edgeB.x - edgeA.x
  const sy = edgeB.y - edgeA.y
  const denominator = rx * sy - ry * sx
  if (Math.abs(denominator) < 1e-12) return b.clone()
  const t = ((edgeA.x - a.x) * sy - (edgeA.y - a.y) * sx) / denominator
  return new THREE.Vector2(a.x + t * rx, a.y + t * ry)
}

function triangleOverlapArea(a: HorizontalTriangle, b: HorizontalTriangle): number {
  let polygon = [a.a.clone(), a.b.clone(), a.c.clone()]
  const clip = [b.a, b.b, b.c]
  const orientation = Math.sign(signedArea(clip)) || 1
  for (let edge = 0; edge < 3 && polygon.length > 0; edge++) {
    const edgeA = clip[edge]
    const edgeB = clip[(edge + 1) % 3]
    const input = polygon
    polygon = []
    let previous = input[input.length - 1]
    for (const current of input) {
      const currentInside = inside(current, edgeA, edgeB, orientation)
      const previousInside = inside(previous, edgeA, edgeB, orientation)
      if (currentInside !== previousInside) {
        polygon.push(lineIntersection(previous, current, edgeA, edgeB))
      }
      if (currentInside) polygon.push(current.clone())
      previous = current
    }
  }
  return polygon.length >= 3 ? Math.abs(signedArea(polygon)) : 0
}

function zFightFindings(triangles: readonly HorizontalTriangle[]): SweepFinding[] {
  const surfaceLayer = (record: MeshRecord): boolean => {
    const thickness = record.box.max.y - record.box.min.y
    return thickness <= 0.2
      || record.mesh.geometry.type === 'PlaneGeometry'
      || semanticSurface(record)
      || semanticBorder(record)
  }
  const cellSize = 32
  const cells = new Map<string, HorizontalTriangle[]>()
  for (const triangle of triangles) {
    const yBucket = Math.floor(triangle.y / Z_FIGHT_Y_TOLERANCE)
    const x0 = Math.floor(triangle.bounds.min.x / cellSize)
    const x1 = Math.floor(triangle.bounds.max.x / cellSize)
    const z0 = Math.floor(triangle.bounds.min.y / cellSize)
    const z1 = Math.floor(triangle.bounds.max.y / cellSize)
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const key = `${yBucket}:${x}:${z}`
        const bucket = cells.get(key) ?? []
        bucket.push(triangle)
        cells.set(key, bucket)
      }
    }
  }

  const compared = new Set<string>()
  const overlaps = new Map<string, { a: HorizontalTriangle; b: HorizontalTriangle; area: number }>()
  for (const [key, bucket] of cells) {
    const [rawY, rawX, rawZ] = key.split(':').map(Number)
    const neighbours: HorizontalTriangle[] = []
    for (let y = rawY - 1; y <= rawY + 1; y++) {
      neighbours.push(...(cells.get(`${y}:${rawX}:${rawZ}`) ?? []))
    }
    for (const a of bucket) {
      for (const b of neighbours) {
        if (
          a === b
          || a.record.key === b.record.key
          || !surfaceLayer(a.record)
          || !surfaceLayer(b.record)
        ) continue
        const pair = a.record.key < b.record.key
          ? `${a.record.key}|${b.record.key}|${round(Math.min(a.y, b.y))}`
          : `${b.record.key}|${a.record.key}|${round(Math.min(a.y, b.y))}`
        const trianglePair = a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`
        if (compared.has(trianglePair)) continue
        compared.add(trianglePair)
        if (Math.abs(a.y - b.y) > Z_FIGHT_Y_TOLERANCE + 1e-7) continue
        if (a.material.polygonOffset || b.material.polygonOffset || !a.bounds.intersectsBox(b.bounds)) continue
        const area = triangleOverlapArea(a, b)
        if (area <= 0.001) continue
        const existing = overlaps.get(pair)
        if (existing) existing.area += area
        else overlaps.set(pair, { a, b, area })
      }
    }
  }

  return [...overlaps.values()]
    .filter((overlap) => overlap.area > 0.01)
    .map(({ a, b, area }) => {
      const district = stationForDistrict(a.record.district ?? b.record.district)
      const position = new THREE.Vector3(
        (Math.max(a.bounds.min.x, b.bounds.min.x) + Math.min(a.bounds.max.x, b.bounds.max.x)) / 2,
        (a.y + b.y) / 2,
        (Math.max(a.bounds.min.y, b.bounds.min.y) + Math.min(a.bounds.max.y, b.bounds.max.y)) / 2,
      )
      return {
        invariant: 'z-fighting' as const,
        station: district,
        district,
        object: `${recordLabel(a.record)} ↔ ${recordLabel(b.record)}`,
        position: pointTuple(position),
        detail: `opaque horizontal surfaces differ by ${Math.abs(a.y - b.y).toFixed(4)} units and overlap ${area.toFixed(3)} square units in XZ`,
      }
    })
}

interface BoundaryLoop {
  readonly points: readonly THREE.Vector2[]
  readonly area: number
}

function boundaryLoops(surface: MeshRecord): BoundaryLoop[] {
  const geometry = surface.mesh.geometry
  const position = geometry.getAttribute('position')
  const index = geometry.index
  if (!position) return []
  const count = index ? index.count : position.count
  const point = new THREE.Vector3()
  const vertices = new Map<string, THREE.Vector2>()
  const edges = new Map<string, { a: string; b: string; count: number }>()
  const vertexKey = (indexValue: number): string => {
    point.fromBufferAttribute(position, indexValue).applyMatrix4(surface.matrix)
    const key = `${Math.round(point.x * 1000)},${Math.round(point.z * 1000)}`
    if (!vertices.has(key)) vertices.set(key, new THREE.Vector2(point.x, point.z))
    return key
  }
  for (let offset = 0; offset + 2 < count; offset += 3) {
    const ids = [
      index ? index.getX(offset) : offset,
      index ? index.getX(offset + 1) : offset + 1,
      index ? index.getX(offset + 2) : offset + 2,
    ]
    const keys = ids.map(vertexKey)
    for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
      const a = keys[edgeIndex]
      const b = keys[(edgeIndex + 1) % 3]
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      const edge = edges.get(key)
      if (edge) edge.count++
      else edges.set(key, { a, b, count: 1 })
    }
  }
  const adjacency = new Map<string, string[]>()
  for (const edge of edges.values()) {
    if (edge.count !== 1) continue
    const from = adjacency.get(edge.a) ?? []
    const to = adjacency.get(edge.b) ?? []
    from.push(edge.b)
    to.push(edge.a)
    adjacency.set(edge.a, from)
    adjacency.set(edge.b, to)
  }
  const visited = new Set<string>()
  const loops: BoundaryLoop[] = []
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue
    const keys: string[] = []
    let previous: string | null = null
    let current = start
    for (let guard = 0; guard < adjacency.size + 1; guard++) {
      keys.push(current)
      visited.add(current)
      const neighbours = adjacency.get(current) ?? []
      const next = neighbours.find((candidate) => candidate !== previous)
      if (!next || next === start) break
      previous = current
      current = next
    }
    const points = keys.map((key) => vertices.get(key)!).filter(Boolean)
    if (points.length >= 3) loops.push({ points, area: signedArea(points) })
  }
  return loops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area))
}

function pointInPolygon(point: THREE.Vector2, polygon: readonly THREE.Vector2[]): boolean {
  let insidePolygon = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (
      (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) insidePolygon = !insidePolygon
  }
  return insidePolygon
}

export function directRaycast(mesh: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    THREE.InstancedMesh.prototype.raycast.call(mesh, raycaster, hits)
  } else {
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, hits)
  }
}

export function nearestDirectHit(
  meshes: readonly THREE.Mesh[],
  raycaster: THREE.Raycaster,
  hits: THREE.Intersection[],
): THREE.Intersection | null {
  let nearest: THREE.Intersection | null = null
  for (const mesh of meshes) {
    hits.length = 0
    directRaycast(mesh, raycaster, hits)
    for (const hit of hits) {
      if (hit.distance < raycaster.near || hit.distance > raycaster.far) continue
      if (!nearest || hit.distance < nearest.distance) nearest = hit
    }
  }
  return nearest
}

interface GroundAperture {
  readonly label: string
  readonly x: readonly [number, number]
  readonly z: readonly [number, number]
}

const EXPECTED_GROUND_APERTURES: readonly GroundAperture[] = [{
  label: 'storage excavation',
  x: [-CITY.pit.x, CITY.pit.x],
  z: [-CITY.pit.z, CITY.pit.z],
}]

function belongsTo(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current === root) return true
  }
  return false
}

function discoverGroundSurface(
  records: readonly MeshRecord[],
  registry: CityHandle['registry'],
): { surface: MeshRecord | null; findings: SweepFinding[] } {
  const roots = registry.all().filter((component) => component.id === 'world.ground')
  const candidates = roots.length === 1
    ? records.filter((record) => (
        record.instanceId === null
        && record.mesh.name === 'ground.plate'
        && belongsTo(record.mesh, roots[0].object)
        && record.materials.some(solidMaterial)
      ))
    : []
  if (roots.length === 1 && candidates.length === 1) return { surface: candidates[0], findings: [] }
  return {
    surface: null,
    findings: [{
      invariant: 'no-sky',
      station: 'world',
      district: 'world',
      object: 'world.ground/ground.plate',
      position: [0, 0, 0],
      detail: `registered world ground resolves to ${roots.length} roots and ${candidates.length} rendered plates`,
    }],
  }
}

function axisProbes(bounds: readonly [number, number]): number[] {
  const start = bounds[0] + 1
  const end = bounds[1] - 1
  if (end <= start) return [(bounds[0] + bounds[1]) / 2]
  const segments = Math.ceil((end - start) / GROUND_PROBE_MAX_SPACING)
  return Array.from({ length: segments + 1 }, (_, index) => start + (end - start) * index / segments)
}

function insideExpectedAperture(x: number, z: number): boolean {
  return EXPECTED_GROUND_APERTURES.some((aperture) => (
    x > aperture.x[0] && x < aperture.x[1] && z > aperture.z[0] && z < aperture.z[1]
  ))
}

/** An eight-unit district lattice targets the registered ground plate itself.
 * Its ~3,650 direct raycasts add no painted frames; station renders still
 * dominate runtime. Perimeter samples retain the outward sightline. */
function districtGroundFindings(groundSurface: MeshRecord, stations: readonly Station[]): SweepFinding[] {
  const meshes = [groundSurface.mesh]
  const raycaster = new THREE.Raycaster()
  const hits: THREE.Intersection[] = []
  const down = new THREE.Vector3(0, -1, 0)
  const origin = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const findings: SweepFinding[] = []
  for (const station of stations) {
    if (station.district === 'world') continue
    const xProbes = axisProbes(station.bounds.x)
    const zProbes = axisProbes(station.bounds.z)
    for (let xIndex = 0; xIndex < xProbes.length; xIndex++) {
      for (let zIndex = 0; zIndex < zProbes.length; zIndex++) {
        const x = xProbes[xIndex]
        const z = zProbes[zIndex]
        if (insideExpectedAperture(x, z)) continue
        origin.set(x, groundSurface.box.max.y + 2, z)
        raycaster.set(origin, down)
        raycaster.near = 0
        raycaster.far = 4
        const ground = nearestDirectHit(meshes, raycaster, hits)
        const object = `declared ground lattice[${xIndex},${zIndex}]`
        if (!ground) {
          findings.push({
            invariant: 'no-sky',
            station: station.district,
            district: station.district,
            object,
            position: pointTuple(origin),
            detail: `downward district ray misses the registered ground plate on a ${GROUND_PROBE_MAX_SPACING}-unit lattice`,
          })
          continue
        }
        const outwards: readonly (readonly [number, number])[] = [
          ...(xIndex === 0 ? [[-1, 0] as const] : []),
          ...(xIndex === xProbes.length - 1 ? [[1, 0] as const] : []),
          ...(zIndex === 0 ? [[0, -1] as const] : []),
          ...(zIndex === zProbes.length - 1 ? [[0, 1] as const] : []),
        ]
        for (const outward of outwards) {
          origin.set(
            ground.point.x - outward[0] * 2,
            ground.point.y + 0.45,
            ground.point.z - outward[1] * 2,
          )
          direction.set(outward[0], -0.2, outward[1]).normalize()
          raycaster.set(origin, direction)
          raycaster.near = 0.05
          raycaster.far = 10
          if (!nearestDirectHit(meshes, raycaster, hits)) {
            findings.push({
              invariant: 'no-sky',
              station: station.district,
              district: station.district,
              object,
              position: pointTuple(ground.point),
              detail: 'outward district-edge ray misses the registered ground plate where it should continue',
            })
          }
        }
      }
    }
  }
  return findings
}

function loopBounds(loop: BoundaryLoop): { x: readonly [number, number]; z: readonly [number, number] } {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const point of loop.points) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minZ = Math.min(minZ, point.y)
    maxZ = Math.max(maxZ, point.y)
  }
  return { x: [minX, maxX], z: [minZ, maxZ] }
}

function matchesAperture(loop: BoundaryLoop, aperture: GroundAperture): boolean {
  const bounds = loopBounds(loop)
  const expectedArea = (aperture.x[1] - aperture.x[0]) * (aperture.z[1] - aperture.z[0])
  return Math.abs(bounds.x[0] - aperture.x[0]) <= GROUND_BOUNDARY_TOLERANCE
    && Math.abs(bounds.x[1] - aperture.x[1]) <= GROUND_BOUNDARY_TOLERANCE
    && Math.abs(bounds.z[0] - aperture.z[0]) <= GROUND_BOUNDARY_TOLERANCE
    && Math.abs(bounds.z[1] - aperture.z[1]) <= GROUND_BOUNDARY_TOLERANCE
    && Math.abs(Math.abs(loop.area) - expectedArea) <= 0.25
}

function stationAtPoint(x: number, z: number, stations: readonly Station[]): DistrictId {
  return [...stations]
    .filter((station) => (
      station.district !== 'world'
      && x >= station.bounds.x[0]
      && x <= station.bounds.x[1]
      && z >= station.bounds.z[0]
      && z <= station.bounds.z[1]
    ))
    .sort((a, b) => (
      (a.bounds.x[1] - a.bounds.x[0]) * (a.bounds.z[1] - a.bounds.z[0])
      - (b.bounds.x[1] - b.bounds.x[0]) * (b.bounds.z[1] - b.bounds.z[0])
    ))[0]?.district ?? 'world'
}

function groundShellFindings(
  groundSurface: MeshRecord,
  stations: readonly Station[],
): SweepFinding[] {
  const loops = boundaryLoops(groundSurface)
  if (loops.length === 0) return [{
    invariant: 'no-sky',
    station: 'world',
    district: 'world',
    object: recordLabel(groundSurface),
    position: pointTuple(groundSurface.box.getCenter(new THREE.Vector3())),
    detail: 'largest rendered surface has no discoverable boundary loop',
  }]
  const outer = loops[0]
  const holes = loops.slice(1)
  const findings: SweepFinding[] = []
  const matchedApertures = new Set<number>()
  for (let index = 0; index < holes.length; index++) {
    const hole = holes[index]
    const apertureIndex = EXPECTED_GROUND_APERTURES.findIndex((aperture, candidate) => (
      !matchedApertures.has(candidate) && matchesAperture(hole, aperture)
    ))
    if (apertureIndex >= 0) {
      matchedApertures.add(apertureIndex)
      continue
    }
    const bounds = loopBounds(hole)
    const x = (bounds.x[0] + bounds.x[1]) / 2
    const z = (bounds.z[0] + bounds.z[1]) / 2
    const district = stationAtPoint(x, z, stations)
    findings.push({
      invariant: 'no-sky',
      station: district,
      district,
      object: `${recordLabel(groundSurface)} interior boundary[${index}]`,
      position: [round(x), round(groundSurface.box.max.y), round(z)],
      detail: `rendered ground has undeclared ${round(bounds.x[1] - bounds.x[0])} × ${round(bounds.z[1] - bounds.z[0])} interior boundary (${round(Math.abs(hole.area))} square units)`,
    })
  }
  for (let index = 0; index < EXPECTED_GROUND_APERTURES.length; index++) {
    if (matchedApertures.has(index)) continue
    const aperture = EXPECTED_GROUND_APERTURES[index]
    const x = (aperture.x[0] + aperture.x[1]) / 2
    const z = (aperture.z[0] + aperture.z[1]) / 2
    findings.push({
      invariant: 'no-sky',
      station: 'world',
      district: 'world',
      object: recordLabel(groundSurface),
      position: [round(x), round(groundSurface.box.max.y), round(z)],
      detail: `rendered ground has no boundary matching the declared ${aperture.label}`,
    })
  }
  const sourceStation = [...stations]
    .filter((station) => {
      const point = new THREE.Vector2(station.target[0], station.target[2])
      return pointInPolygon(point, outer.points) && !holes.some((hole) => pointInPolygon(point, hole.points))
    })
    .sort((a, b) => Math.hypot(a.target[0], a.target[2]) - Math.hypot(b.target[0], b.target[2]))[0]
  if (!sourceStation) return findings
  const lowestStationY = Math.min(...stations.map((station) => station.target[1]))
  const eye = new THREE.Vector3(sourceStation.target[0], lowestStationY + 1.8, sourceStation.target[2])
  const shellRoot = groundSurface.mesh.parent ?? groundSurface.mesh
  const shellMeshes: THREE.Mesh[] = []
  shellRoot.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh && visibleInTree(mesh) && materialsOf(mesh).some(solidMaterial)) shellMeshes.push(mesh)
  })
  const raycaster = new THREE.Raycaster()
  const direction = new THREE.Vector3()
  const midpoint = new THREE.Vector3()
  const hits: THREE.Intersection[] = []
  const misses: SweepFinding[] = []
  for (let index = 0; index < outer.points.length; index++) {
    const a = outer.points[index]
    const b = outer.points[(index + 1) % outer.points.length]
    midpoint.set((a.x + b.x) / 2, eye.y, (a.y + b.y) / 2)
    direction.copy(midpoint).sub(eye)
    const edgeDistance = direction.length()
    if (edgeDistance < 1e-6) continue
    direction.divideScalar(edgeDistance)
    raycaster.set(eye, direction)
    raycaster.near = 0
    raycaster.far = edgeDistance + 20
    let blocked = false
    for (const mesh of shellMeshes) {
      hits.length = 0
      directRaycast(mesh, raycaster, hits)
      if (hits.some((hit) => hit.distance <= raycaster.far)) {
        blocked = true
        break
      }
    }
    if (!blocked) {
      misses.push({
        invariant: 'no-sky',
        station: sourceStation.district,
        district: 'world',
        object: `${recordLabel(groundSurface)} boundary[${index}]`,
        position: pointTuple(midpoint),
        detail: `underground outward ray from ${pointTuple(eye).join(',')} reaches sky through the rendered ground edge`,
      })
    }
  }
  return [...findings, ...misses]
}

function recordsForStation(records: readonly MeshRecord[], station: Station): MeshRecord[] {
  return records.filter((record) => {
    if (record.district === station.district) return true
    if (record.district !== null && record.district !== 'world') return false
    return !(
      record.box.max.x < station.bounds.x[0]
      || record.box.min.x > station.bounds.x[1]
      || record.box.max.z < station.bounds.z[0]
      || record.box.min.z > station.bounds.z[1]
    )
  })
}

export function waitFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const next = (remaining: number): void => {
      if (remaining <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => next(remaining - 1))
    }
    next(count)
  })
}

export async function runVisualSweep(city: CityHandle): Promise<VisualSweepReport> {
  const scene = city.gfx.scene
  const resolveDistrict = districtResolver(city.registry)
  const stations = createStations(city.registry)
  const objectIds = new Set<string>()
  const meshIds = new Set<string>()
  const recordsByKey = new Map<string, MeshRecord>()
  const stationSnapshots: {
    station: Station
    records: MeshRecord[]
    objects: number
    camera: readonly [number, number, number]
  }[] = []

  for (const station of stations) {
    city.rig.focusOn(station.focus, { instant: true })
    // `instant` updates the rig and scene matrices synchronously; one painted
    // frame proves the station rendered without burning two extra SwiftShader
    // frames while the browser suite shares the CPU.
    await waitFrames(1)
    scene.updateMatrixWorld(true)
    let objects = 0
    scene.traverse((object) => {
      if (!visibleInTree(object)) return
      objects++
      objectIds.add(object.uuid)
      if ((object as THREE.Mesh).isMesh) meshIds.add(object.uuid)
    })
    const records = enumerateMeshes(scene, resolveDistrict)
    for (const record of records) recordsByKey.set(record.key, record)
    stationSnapshots.push({
      station,
      records: recordsForStation(records, station),
      objects,
      camera: pointTuple(city.gfx.camera.position),
    })
  }

  const records = [...recordsByKey.values()]
  const solidTrianglesByRecord = new Map<string, readonly HorizontalTriangle[]>()
  const opaqueTrianglesByRecord = new Map<string, readonly HorizontalTriangle[]>()
  for (const record of records) {
    solidTrianglesByRecord.set(record.key, horizontalTriangles(record, false))
    opaqueTrianglesByRecord.set(record.key, horizontalTriangles(record, true))
  }
  const solidTriangles = [...solidTrianglesByRecord.values()].flat()
  const opaqueTriangles = [...opaqueTrianglesByRecord.values()].flat()
  const text = enumerateText(scene, resolveDistrict)
  const colliders = enumerateColliders(city.collision.debugMesh())
  const surfaces = discoverSurfaces(records, solidTrianglesByRecord)
  const supportSurfaces = records
    .map((record) => ({
      record,
      triangles: solidTrianglesByRecord.get(record.key) ?? [],
      area: (solidTrianglesByRecord.get(record.key) ?? []).reduce((sum, triangle) => sum + triangle.area, 0),
    }))
    .filter((surface) => surface.area >= 0.2)
  const borders = discoverBorders(records, solidTrianglesByRecord, supportSurfaces)
  const ground = discoverGroundSurface(records, city.registry)
  const findings = [
    ...textFindings(city, text, colliders),
    ...ground.findings,
    ...(ground.surface ? districtGroundFindings(ground.surface, stations) : []),
    ...(ground.surface ? groundShellFindings(ground.surface, stations) : []),
    ...surfaceFindings(surfaces, solidTriangles),
    ...borderFindings(borders, supportSurfaces),
    ...zFightFindings(opaqueTriangles),
  ]

  const stationReports = stationSnapshots.map(({ station, records: localRecords, objects, camera }) => {
    const localKeys = new Set(localRecords.map((record) => record.key))
    return {
      district: station.district,
      target: station.target,
      camera,
      objects,
      meshInstances: localRecords.length,
      textPlanes: text.instances.filter((plane) => stationForDistrict(plane.district) === station.district).length,
      surfaces: surfaces.filter((surface) => surface.record.district === station.district).length,
      borders: borders.filter((border) => border.record.district === station.district).length,
      opaqueTriangles: opaqueTriangles.filter((triangle) => localKeys.has(triangle.record.key)).length,
    }
  })

  return {
    stations: stationReports,
    sceneObjects: objectIds.size,
    meshObjects: meshIds.size,
    meshInstances: records.length,
    textPlanes: text.instances.length,
    districtSurfaces: surfaces.length,
    borderStrips: borders.length,
    opaqueHorizontalTriangles: opaqueTriangles.length,
    findings,
  }
}

/** Calibration proof: introduce the historical mirror defect in one live plane. */
export async function proveMirroredTextDetection(city: CityHandle): Promise<SweepFinding[]> {
  const resolveDistrict = districtResolver(city.registry)
  const text = enumerateText(city.gfx.scene, resolveDistrict)
  const candidate = text.instances.find((plane) => plane.object.scale.x > 0)
  if (!candidate) throw new Error('visual sweep found no text plane to mirror')
  candidate.object.scale.x *= -1
  city.gfx.scene.updateMatrixWorld(true)
  try {
    return textFindings(city, { instances: [candidate], unmarked: [] }, []).filter(
      (finding) => finding.detail.includes('mirrored world determinant'),
    )
  } finally {
    candidate.object.scale.x *= -1
    city.gfx.scene.updateMatrixWorld(true)
    await waitFrames(1)
  }
}
