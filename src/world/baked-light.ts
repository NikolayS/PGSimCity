import * as THREE from 'three'

import type { ColorKey } from '../core/types'
import { BOUNCE_PALETTE_KEYS } from '../core/themes'
import {
  BAKED_LIGHT_BASE64,
  BAKED_LIGHT_BAKE_MS,
  BAKED_LIGHT_BYTES,
  BAKED_LIGHT_ENTRIES,
  BAKED_LIGHT_VERSION,
} from './baked-light-data'

export const SEMANTIC_BOUNCE_KEYS = BOUNCE_PALETTE_KEYS satisfies readonly ColorKey[]

export const MAX_BLEED = 0.08
export const TRANSPORT_DIRECTIONS = 6
const INSTANCE_STRIDE = TRANSPORT_DIRECTIONS * 2
const VERTEX_STRIDE = 2
const SKY_ATTRIBUTE = 'pgBakeSky'
const TRANSFER_ATTRIBUTE = 'pgBakeTransfer'
const SKY_INSTANCE_ATTRIBUTE = 'pgBakeSky'
const TRANSFER_INSTANCE_ATTRIBUTE = 'pgBakeTransfer'
const BAKE_MAX_DISTANCE = 72
const BLEED_DISTANCE = 30
const SAMPLE_OFFSET = 0.14
const INDEX_CELL = 20
const DYNAMIC_NAME = /(flow|packet|truck|worker|water|shadow|pulse|sweep|rake|scan|cursor)/i

const DIRECTIONS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
] as const

const BASE_SKY = [0.58, 0.58, 1, 0.16, 0.58, 0.58] as const

export interface DecodedTransport {
  source: number
  weight: number
}

export function encodeTransportByte(source: number, strength: number): number {
  const semantic = Math.max(0, Math.min(SEMANTIC_BOUNCE_KEYS.length - 1, Math.round(source)))
  const transfer = Math.max(0, Math.min(15, Math.round(strength * 15)))
  return (semantic << 4) | transfer
}

export function decodeTransportByte(encoded: number): DecodedTransport {
  const byte = Math.max(0, Math.min(255, Math.round(encoded)))
  return {
    source: Math.min(SEMANTIC_BOUNCE_KEYS.length - 1, byte >>> 4),
    weight: (byte & 15) / 15 * MAX_BLEED,
  }
}

export function mixBoundaryColor(receiver: number, neighbour: number, weight: number): number {
  const t = Math.max(0, Math.min(MAX_BLEED, weight))
  const channel = (shift: number): number =>
    Math.round(
      ((receiver >>> shift) & 255) * (1 - t) +
      ((neighbour >>> shift) & 255) * t,
    )
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

interface BakedMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
  signature: number
  instanced: boolean
  count: number
}

export interface BakedLightPayload {
  version: number
  entries: Array<{
    signature: number
    instanced: boolean
    count: number
    offset: number
  }>
  base64: string
  byteLength: number
  bakeMs: number
  meshes: number
  instances: number
  vertices: number
  occluders: number
}

export interface BakedLightInstallStats {
  installed: boolean
  meshes: number
  instances: number
  vertices: number
  byteLength: number
  geometryBytes: number
  memoryBytes: number
  bakeMs: number
  elapsedMs: number
  reason?: string
}

interface BakedObjectData {
  pgBakeOriginalGeometry?: THREE.BufferGeometry
  pgBakeInPlace?: boolean
}

function materialsOf(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
): readonly THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material]
}

function opaqueStandard(material: THREE.Material): boolean {
  const standard = material as THREE.MeshStandardMaterial
  return standard.isMeshStandardMaterial === true && !material.transparent && material.opacity >= 0.99
}

function surfaced(material: THREE.Material): boolean {
  if (!opaqueStandard(material)) return false
  const data = material.userData as { pgSurface?: boolean; pgNoSurface?: boolean }
  if (data.pgSurface !== undefined) return data.pgSurface
  const standard = material as THREE.MeshStandardMaterial
  return data.pgNoSurface !== true && standard.vertexColors !== true
}

function hashSignature(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function meshSignature(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
  ordinal: number,
  count: number,
): number {
  const positions = mesh.geometry.getAttribute('position')?.count ?? 0
  return hashSignature(
    `${ordinal}:${mesh.name || '_'}:${mesh.geometry.type}:${count}:${positions}`,
  )
}

function bakedMeshes(root: THREE.Object3D): BakedMesh[] {
  const out: BakedMesh[] = []
  let ordinal = 0
  root.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    if (mesh.isMesh !== true) return
    if (!materialsOf(mesh).some(surfaced)) return
    const instanced = (mesh as THREE.InstancedMesh).isInstancedMesh === true
    const count = instanced
      ? (mesh as THREE.InstancedMesh).instanceMatrix.count
      : mesh.geometry.getAttribute('position')?.count ?? 0
    out.push({
      mesh,
      signature: meshSignature(mesh, ordinal++, count),
      instanced,
      count,
    })
  })
  return out
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  return bytes
}

function instanceAttribute(
  source: Uint8Array,
  offset: number,
  count: number,
  component: number,
): THREE.InstancedBufferAttribute {
  const values = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) {
    const sourceOffset = offset + i * INSTANCE_STRIDE + component
    const targetOffset = i * 3
    values[targetOffset] = source[sourceOffset]
    values[targetOffset + 1] = source[sourceOffset + 1]
    values[targetOffset + 2] = source[sourceOffset + 2]
  }
  return new THREE.InstancedBufferAttribute(values, 3, true)
}

function vertexAttribute(
  source: Uint8Array,
  offset: number,
  count: number,
  component: number,
): THREE.BufferAttribute {
  const values = new Uint8Array(count)
  for (let i = 0; i < count; i++) values[i] = source[offset + i * VERTEX_STRIDE + component]
  return new THREE.BufferAttribute(values, 1, true)
}

function geometryByteLength(geometry: THREE.BufferGeometry): number {
  const arrays = new Set<ArrayBufferLike>()
  const add = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null): void => {
    if (!attribute) return
    if (attribute instanceof THREE.InterleavedBufferAttribute) arrays.add(attribute.data.array.buffer)
    else arrays.add(attribute.array.buffer)
  }
  add(geometry.index)
  for (const attribute of Object.values(geometry.attributes)) add(attribute)
  for (const attributes of Object.values(geometry.morphAttributes)) {
    for (let i = 0; i < attributes.length; i++) add(attributes[i])
  }
  let bytes = 0
  for (const array of arrays) bytes += array.byteLength
  return bytes
}

function geometryForBake(mesh: BakedMesh, mustClone: boolean): THREE.BufferGeometry {
  const geometry = mesh.mesh.geometry
  const data = mesh.mesh.userData as BakedObjectData
  if (!mustClone) {
    data.pgBakeInPlace = true
    return geometry
  }
  if (!data.pgBakeOriginalGeometry) data.pgBakeOriginalGeometry = geometry
  const clone = geometry.clone()
  mesh.mesh.geometry = clone
  return clone
}

export function installBakedIndirect(root: THREE.Object3D): BakedLightInstallStats {
  const started = performance.now()
  if (BAKED_LIGHT_VERSION !== 1 || !BAKED_LIGHT_BASE64 || BAKED_LIGHT_ENTRIES.length === 0) {
    return {
      installed: false,
      meshes: 0,
      instances: 0,
      vertices: 0,
      byteLength: 0,
      geometryBytes: 0,
      memoryBytes: 0,
      bakeMs: 0,
      elapsedMs: performance.now() - started,
      reason: 'no baked payload',
    }
  }

  const meshes = bakedMeshes(root)
  if (meshes.length !== BAKED_LIGHT_ENTRIES.length) {
    return {
      installed: false,
      meshes: 0,
      instances: 0,
      vertices: 0,
      byteLength: BAKED_LIGHT_BYTES,
      geometryBytes: 0,
      memoryBytes: 0,
      bakeMs: BAKED_LIGHT_BAKE_MS,
      elapsedMs: performance.now() - started,
      reason: `scene has ${meshes.length} bake meshes; payload has ${BAKED_LIGHT_ENTRIES.length}`,
    }
  }

  for (let i = 0; i < meshes.length; i++) {
    const expected = BAKED_LIGHT_ENTRIES[i]
    const actual = meshes[i]
    if (
      expected.signature !== actual.signature ||
      expected.instanced !== actual.instanced ||
      expected.count !== actual.count
    ) {
      return {
        installed: false,
        meshes: 0,
        instances: 0,
        vertices: 0,
        byteLength: BAKED_LIGHT_BYTES,
        geometryBytes: 0,
        memoryBytes: 0,
        bakeMs: BAKED_LIGHT_BAKE_MS,
        elapsedMs: performance.now() - started,
        reason: `mesh ${i} does not match ${expected.signature}`,
      }
    }
  }

  const bytes = decodeBase64(BAKED_LIGHT_BASE64)
  if (bytes.byteLength !== BAKED_LIGHT_BYTES) {
    return {
      installed: false,
      meshes: 0,
      instances: 0,
      vertices: 0,
      byteLength: bytes.byteLength,
      geometryBytes: 0,
      memoryBytes: 0,
      bakeMs: BAKED_LIGHT_BAKE_MS,
      elapsedMs: performance.now() - started,
      reason: `decoded ${bytes.byteLength} bytes; expected ${BAKED_LIGHT_BYTES}`,
    }
  }

  let instances = 0
  let vertices = 0
  let geometryBytes = 0
  const geometryUse = new Map<THREE.BufferGeometry, number>()
  for (let i = 0; i < meshes.length; i++) {
    const geometry = meshes[i].mesh.geometry
    geometryUse.set(geometry, (geometryUse.get(geometry) ?? 0) + 1)
  }
  for (let i = 0; i < meshes.length; i++) {
    const record = meshes[i]
    const entry = BAKED_LIGHT_ENTRIES[i]
    const mustClone = (geometryUse.get(record.mesh.geometry) ?? 0) > 1
    const geometry = geometryForBake(record, mustClone)
    if (mustClone) geometryBytes += geometryByteLength(geometry)
    if (record.instanced) {
      geometry.setAttribute(
        `${SKY_INSTANCE_ATTRIBUTE}A`,
        instanceAttribute(bytes, entry.offset, entry.count, 0),
      )
      geometry.setAttribute(
        `${SKY_INSTANCE_ATTRIBUTE}B`,
        instanceAttribute(bytes, entry.offset, entry.count, 3),
      )
      geometry.setAttribute(
        `${TRANSFER_INSTANCE_ATTRIBUTE}A`,
        instanceAttribute(bytes, entry.offset, entry.count, TRANSPORT_DIRECTIONS),
      )
      geometry.setAttribute(
        `${TRANSFER_INSTANCE_ATTRIBUTE}B`,
        instanceAttribute(bytes, entry.offset, entry.count, TRANSPORT_DIRECTIONS + 3),
      )
      instances += entry.count
    } else {
      geometry.setAttribute(SKY_ATTRIBUTE, vertexAttribute(bytes, entry.offset, entry.count, 0))
      geometry.setAttribute(
        TRANSFER_ATTRIBUTE,
        vertexAttribute(bytes, entry.offset, entry.count, 1),
      )
      vertices += entry.count
    }
  }

  return {
    installed: true,
    meshes: meshes.length,
    instances,
    vertices,
    byteLength: bytes.byteLength,
    geometryBytes,
    memoryBytes: bytes.byteLength + geometryBytes,
    bakeMs: BAKED_LIGHT_BAKE_MS,
    elapsedMs: performance.now() - started,
  }
}

export function disposeBakedIndirect(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry>
    if (mesh.isMesh !== true) return
    const data = mesh.userData as BakedObjectData
    const original = data.pgBakeOriginalGeometry
    if (original) {
      mesh.geometry.dispose()
      mesh.geometry = original
      delete data.pgBakeOriginalGeometry
    } else if (data.pgBakeInPlace) {
      mesh.geometry.deleteAttribute(SKY_ATTRIBUTE)
      mesh.geometry.deleteAttribute(TRANSFER_ATTRIBUTE)
      mesh.geometry.deleteAttribute(`${SKY_INSTANCE_ATTRIBUTE}A`)
      mesh.geometry.deleteAttribute(`${SKY_INSTANCE_ATTRIBUTE}B`)
      mesh.geometry.deleteAttribute(`${TRANSFER_INSTANCE_ATTRIBUTE}A`)
      mesh.geometry.deleteAttribute(`${TRANSFER_INSTANCE_ATTRIBUTE}B`)
    }
    delete data.pgBakeInPlace
  })
}

interface Occluder {
  owner: number
  instance: number
  box: THREE.Box3
  material: string
  center: THREE.Vector3
}

type Axis = 0 | 1 | 2

interface AxisIndex {
  maps: [Map<string, number[]>, Map<string, number[]>, Map<string, number[]>]
  occluders: Occluder[]
}

function bin(value: number): number {
  return Math.floor(value / INDEX_CELL)
}

function gridKey(a: number, b: number): string {
  return `${a}:${b}`
}

function addToGrid(map: Map<string, number[]>, key: string, value: number): void {
  const bucket = map.get(key)
  if (bucket) bucket.push(value)
  else map.set(key, [value])
}

function indexOccluders(occluders: Occluder[]): AxisIndex {
  const maps: AxisIndex['maps'] = [new Map(), new Map(), new Map()]
  for (let i = 0; i < occluders.length; i++) {
    const box = occluders[i].box
    const ranges = [
      [bin(box.min.y), bin(box.max.y), bin(box.min.z), bin(box.max.z)],
      [bin(box.min.x), bin(box.max.x), bin(box.min.z), bin(box.max.z)],
      [bin(box.min.x), bin(box.max.x), bin(box.min.y), bin(box.max.y)],
    ] as const
    for (let axis = 0 as Axis; axis < 3; axis = (axis + 1) as Axis) {
      const range = ranges[axis]
      for (let a = range[0]; a <= range[1]; a++) {
        for (let b = range[2]; b <= range[3]; b++) addToGrid(maps[axis], gridKey(a, b), i)
      }
    }
  }
  return { maps, occluders }
}

function coordinate(v: THREE.Vector3, axis: Axis): number {
  return axis === 0 ? v.x : axis === 1 ? v.y : v.z
}

function nearestAlongAxis(
  index: AxisIndex,
  point: THREE.Vector3,
  direction: number,
  owner: number,
  instance: number,
): { distance: number; occluder: Occluder } | null {
  const axis = Math.floor(direction / 2) as Axis
  const positive = direction % 2 === 0
  const perpendicular = axis === 0
    ? [point.y, point.z]
    : axis === 1
      ? [point.x, point.z]
      : [point.x, point.y]
  const candidates = index.maps[axis].get(gridKey(bin(perpendicular[0]), bin(perpendicular[1])))
  if (!candidates) return null

  let nearest = BAKE_MAX_DISTANCE
  let hit: Occluder | null = null
  const p = coordinate(point, axis)
  for (let i = 0; i < candidates.length; i++) {
    const candidate = index.occluders[candidates[i]]
    if (candidate.owner === owner && candidate.instance === instance) continue
    const box = candidate.box
    const inside = axis === 0
      ? point.y >= box.min.y && point.y <= box.max.y && point.z >= box.min.z && point.z <= box.max.z
      : axis === 1
        ? point.x >= box.min.x && point.x <= box.max.x && point.z >= box.min.z && point.z <= box.max.z
        : point.x >= box.min.x && point.x <= box.max.x && point.y >= box.min.y && point.y <= box.max.y
    if (!inside) continue
    const edge = positive ? coordinate(box.min, axis) : coordinate(box.max, axis)
    const distance = positive ? edge - p : p - edge
    if (distance < -SAMPLE_OFFSET || distance >= nearest) continue
    nearest = Math.max(0, distance)
    hit = candidate
  }
  return hit ? { distance: nearest, occluder: hit } : null
}

function semanticSource(material: string, point: THREE.Vector3): number {
  const name = material.toLowerCase()
  const index = (key: typeof SEMANTIC_BOUNCE_KEYS[number]): number =>
    SEMANTIC_BOUNCE_KEYS.indexOf(key)
  if (/checkpoint/.test(name)) return index('checkpoint')
  if (/bgwriter|bg-writer/.test(name)) return index('bgwriter')
  if (/vac|maint|landfill/.test(name)) return index('vacuum')
  if (/lock/.test(name)) return index('lock')
  if (/index|gin|btree/.test(name)) return index('index')
  if (/storage|disk|data|toast/.test(name) || point.y < -8) return index('storage')
  if (/rep|standby|receiver|subscriber/.test(name) || point.z > 130) return index('replication')
  if (/wal|archive|timeline/.test(name) || point.x > 105) return index('wal')
  if (/shmem|buffer|shared/.test(name) || Math.abs(point.x) < 105) return index('shmem')
  return point.x < -105 ? index('vacuum') : index('shmem')
}

function transportAt(
  index: AxisIndex,
  point: THREE.Vector3,
  direction: number,
  owner: number,
  instance: number,
  fallbackMaterial: string,
): [number, number] {
  const hit = nearestAlongAxis(index, point, direction, owner, instance)
  let visibility = BASE_SKY[direction]
  let source = semanticSource(fallbackMaterial, point)
  let strength = direction === 3 ? 0.46 : 0.12

  if (hit) {
    const clearance = Math.max(0, hit.distance)
    const open = Math.min(1, clearance / 28)
    visibility *= 0.18 + 0.82 * open
    source = semanticSource(hit.occluder.material, hit.occluder.center)
    strength = Math.max(0, 1 - clearance / BLEED_DISTANCE)
  } else if (direction === 3) {
    const floorY = point.y < -8 ? -60 : 0
    const floorDistance = Math.max(0, point.y - floorY)
    visibility *= 0.24 + 0.76 * Math.min(1, floorDistance / 24)
    source = semanticSource(fallbackMaterial, point)
    strength = Math.max(0.12, 1 - floorDistance / BLEED_DISTANCE)
  }

  return [
    Math.round(Math.max(0, Math.min(1, visibility)) * 255),
    encodeTransportByte(source, strength),
  ]
}

function primaryMaterialName(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
): string {
  return materialsOf(mesh).find(opaqueStandard)?.name ?? ''
}

function dynamicOccluder(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>,
): boolean {
  const instanced = mesh as THREE.InstancedMesh
  return (
    DYNAMIC_NAME.test(mesh.name) ||
    (instanced.isInstancedMesh === true && instanced.instanceMatrix.usage === THREE.DynamicDrawUsage) ||
    materialsOf(mesh).some((material) => /(vehicle|tyre)/i.test(material.name))
  )
}

function gatherOccluders(root: THREE.Object3D): Occluder[] {
  const occluders: Occluder[] = []
  const local = new THREE.Matrix4()
  const world = new THREE.Matrix4()
  const box = new THREE.Box3()
  let owner = 0

  root.updateMatrixWorld(true)
  root.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    if (mesh.isMesh !== true || dynamicOccluder(mesh)) return
    if (!materialsOf(mesh).some(opaqueStandard)) return
    const geometry = mesh.geometry
    geometry.computeBoundingBox()
    if (!geometry.boundingBox) return
    const material = primaryMaterialName(mesh)
    const instanced = mesh as THREE.InstancedMesh
    const count = instanced.isInstancedMesh === true ? instanced.instanceMatrix.count : 1
    for (let i = 0; i < count; i++) {
      if (instanced.isInstancedMesh === true) {
        instanced.getMatrixAt(i, local)
        world.multiplyMatrices(mesh.matrixWorld, local)
      } else {
        world.copy(mesh.matrixWorld)
      }
      box.copy(geometry.boundingBox).applyMatrix4(world)
      const size = box.getSize(new THREE.Vector3())
      if (
        size.x > 260 ||
        size.y > 180 ||
        size.z > 260 ||
        size.x < 0.02 ||
        size.y < 0.02 ||
        size.z < 0.02
      ) {
        continue
      }
      occluders.push({
        owner,
        instance: instanced.isInstancedMesh === true ? i : -1,
        box: box.clone(),
        material,
        center: box.getCenter(new THREE.Vector3()),
      })
    }
    owner++
  })
  return occluders
}

function targetOwnerMap(root: THREE.Object3D): Map<THREE.Object3D, number> {
  const owners = new Map<THREE.Object3D, number>()
  let owner = 0
  root.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    if (mesh.isMesh !== true || dynamicOccluder(mesh)) return
    if (!materialsOf(mesh).some(opaqueStandard)) return
    owners.set(mesh, owner++)
  })
  return owners
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)))
  }
  return btoa(binary)
}

export function bakeSceneIndirect(root: THREE.Object3D): BakedLightPayload {
  const started = performance.now()
  const meshes = bakedMeshes(root)
  const occluders = gatherOccluders(root)
  const owners = targetOwnerMap(root)
  const index = indexOccluders(occluders)
  const chunks: Uint8Array[] = []
  const entries: BakedLightPayload['entries'] = []
  const local = new THREE.Matrix4()
  const world = new THREE.Matrix4()
  const box = new THREE.Box3()
  const point = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3()
  let byteLength = 0
  let instances = 0
  let vertices = 0

  root.updateMatrixWorld(true)
  for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
    const record = meshes[meshIndex]
    const mesh = record.mesh
    const owner = owners.get(mesh) ?? -1
    const material = primaryMaterialName(mesh)
    const bytes = new Uint8Array(
      record.count * (record.instanced ? INSTANCE_STRIDE : VERTEX_STRIDE),
    )
    entries.push({
      signature: record.signature,
      instanced: record.instanced,
      count: record.count,
      offset: byteLength,
    })
    byteLength += bytes.byteLength

    mesh.geometry.computeBoundingBox()
    if (record.instanced && mesh.geometry.boundingBox) {
      const instanced = mesh as THREE.InstancedMesh
      for (let instance = 0; instance < record.count; instance++) {
        instanced.getMatrixAt(instance, local)
        world.multiplyMatrices(mesh.matrixWorld, local)
        box.copy(mesh.geometry.boundingBox).applyMatrix4(world)
        box.getCenter(point)
        const centerX = point.x
        const centerY = point.y
        const centerZ = point.z
        for (let direction = 0; direction < TRANSPORT_DIRECTIONS; direction++) {
          point.set(centerX, centerY, centerZ)
          if (direction === 0) point.x = box.max.x
          else if (direction === 1) point.x = box.min.x
          else if (direction === 2) point.y = box.max.y
          else if (direction === 3) point.y = box.min.y
          else if (direction === 4) point.z = box.max.z
          else point.z = box.min.z
          point.addScaledVector(DIRECTIONS[direction], SAMPLE_OFFSET)
          const [sky, transfer] = transportAt(
            index,
            point,
            direction,
            owner,
            instance,
            material,
          )
          const base = instance * INSTANCE_STRIDE
          bytes[base + direction] = sky
          bytes[base + TRANSPORT_DIRECTIONS + direction] = transfer
        }
      }
      instances += record.count
    } else {
      const positions = mesh.geometry.getAttribute('position')
      const normals = mesh.geometry.getAttribute('normal')
      normalMatrix.getNormalMatrix(mesh.matrixWorld)
      for (let vertex = 0; vertex < record.count; vertex++) {
        point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld)
        if (normals) normal.fromBufferAttribute(normals, vertex).applyNormalMatrix(normalMatrix).normalize()
        else normal.set(0, 1, 0)
        let direction = 2
        let magnitude = normal.y
        if (Math.abs(normal.x) > Math.abs(magnitude)) {
          direction = normal.x >= 0 ? 0 : 1
          magnitude = normal.x
        }
        if (Math.abs(normal.z) > Math.abs(magnitude)) direction = normal.z >= 0 ? 4 : 5
        point.addScaledVector(normal, SAMPLE_OFFSET)
        const [sky, transfer] = transportAt(index, point, direction, owner, -1, material)
        const base = vertex * VERTEX_STRIDE
        bytes[base] = sky
        bytes[base + 1] = transfer
      }
      vertices += record.count
    }
    chunks.push(bytes)
  }

  const all = new Uint8Array(byteLength)
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    all.set(chunks[i], offset)
    offset += chunks[i].byteLength
  }
  return {
    version: 1,
    entries,
    base64: bytesToBase64(all),
    byteLength,
    bakeMs: performance.now() - started,
    meshes: meshes.length,
    instances,
    vertices,
    occluders: occluders.length,
  }
}
