import * as THREE from 'three'

import type { QualityLevel } from './types'

/** Four centimetres catches the sun without making architectural edges round. */
export const BOX_BEVEL_METRES = 0.04
/** Unit boxes are instance-scaled; 0.3% becomes 3–9 cm on the main 10–30 m masses. */
export const INSTANCED_BOX_BEVEL_RATIO = 0.003
export const BOX_TRIANGLES = 12
export const BEVELED_BOX_TRIANGLES = 44

interface BoxGeometryPair {
  plain: THREE.BoxGeometry
  beveled: THREE.BufferGeometry
}

interface BoxGeometryData {
  pgBoxPair?: BoxGeometryPair
}

export interface BoxBevelStats {
  boxes: number
  triangles: number
  triangleDelta: number
}

export function boxBevelDetail(level: QualityLevel): 0 | 1 {
  return level === 'high' || level === 'ultra' ? 1 : 0
}

function pushFace(
  positions: number[],
  normals: number[],
  uvs: number[],
  indices: number[],
  vertices: readonly THREE.Vector3[],
  outward: THREE.Vector3,
): void {
  const a = vertices[0]
  const b = vertices[1]
  const c = vertices[2]
  const cross = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
  const ordered = cross.dot(outward) < 0 ? [...vertices].reverse() : vertices
  const start = positions.length / 3
  const normal = outward.clone().normalize()

  for (let i = 0; i < ordered.length; i++) {
    const vertex = ordered[i]
    positions.push(vertex.x, vertex.y, vertex.z)
    normals.push(normal.x, normal.y, normal.z)
    const angle = (i / ordered.length) * Math.PI * 2 + Math.PI * 0.25
    uvs.push(Math.cos(angle) * 0.5 + 0.5, Math.sin(angle) * 0.5 + 0.5)
  }
  for (let i = 1; i < ordered.length - 1; i++) indices.push(start, start + i, start + i + 1)
}

/**
 * A box with six planar faces, twelve flat 45° edge strips, and eight corner
 * cuts. One segment is enough: the highlight should read as a chamfer, not a
 * rounded consumer-product edge.
 */
export function createBeveledBoxGeometry(
  width: number,
  height: number,
  depth: number,
  requestedBevel = BOX_BEVEL_METRES,
): THREE.BufferGeometry {
  const hx = width / 2
  const hy = height / 2
  const hz = depth / 2
  const bevel = Math.max(0, Math.min(requestedBevel, Math.min(width, height, depth) * 0.18))
  if (bevel === 0) return new THREE.BoxGeometry(width, height, depth)

  const ix = hx - bevel
  const iy = hy - bevel
  const iz = hz - bevel
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)

  for (const sx of [-1, 1] as const) {
    pushFace(
      positions,
      normals,
      uvs,
      indices,
      [v(sx * hx, -iy, -iz), v(sx * hx, iy, -iz), v(sx * hx, iy, iz), v(sx * hx, -iy, iz)],
      v(sx, 0, 0),
    )
  }
  for (const sy of [-1, 1] as const) {
    pushFace(
      positions,
      normals,
      uvs,
      indices,
      [v(-ix, sy * hy, -iz), v(ix, sy * hy, -iz), v(ix, sy * hy, iz), v(-ix, sy * hy, iz)],
      v(0, sy, 0),
    )
  }
  for (const sz of [-1, 1] as const) {
    pushFace(
      positions,
      normals,
      uvs,
      indices,
      [v(-ix, -iy, sz * hz), v(ix, -iy, sz * hz), v(ix, iy, sz * hz), v(-ix, iy, sz * hz)],
      v(0, 0, sz),
    )
  }

  for (const sy of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      pushFace(
        positions,
        normals,
        uvs,
        indices,
        [v(-ix, sy * hy, sz * iz), v(ix, sy * hy, sz * iz), v(ix, sy * iy, sz * hz), v(-ix, sy * iy, sz * hz)],
        v(0, sy, sz),
      )
    }
  }
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      pushFace(
        positions,
        normals,
        uvs,
        indices,
        [v(sx * hx, -iy, sz * iz), v(sx * hx, iy, sz * iz), v(sx * ix, iy, sz * hz), v(sx * ix, -iy, sz * hz)],
        v(sx, 0, sz),
      )
    }
  }
  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      pushFace(
        positions,
        normals,
        uvs,
        indices,
        [v(sx * hx, sy * iy, -iz), v(sx * hx, sy * iy, iz), v(sx * ix, sy * hy, iz), v(sx * ix, sy * hy, -iz)],
        v(sx, sy, 0),
      )
    }
  }

  for (const sx of [-1, 1] as const) {
    for (const sy of [-1, 1] as const) {
      for (const sz of [-1, 1] as const) {
        pushFace(
          positions,
          normals,
          uvs,
          indices,
          [v(sx * hx, sy * iy, sz * iz), v(sx * ix, sy * hy, sz * iz), v(sx * ix, sy * iy, sz * hz)],
          v(sx, sy, sz),
        )
      }
    }
  }

  const geometry = new THREE.BufferGeometry()
  Object.defineProperty(geometry, 'type', { value: 'BoxGeometry' })
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

export function pairBoxGeometries(
  width: number,
  height: number,
  depth: number,
): BoxGeometryPair {
  const plain = new THREE.BoxGeometry(width, height, depth)
  const requested =
    width === 1 && height === 1 && depth === 1
      ? INSTANCED_BOX_BEVEL_RATIO
      : BOX_BEVEL_METRES
  const beveled = createBeveledBoxGeometry(width, height, depth, requested)
  const pair = { plain, beveled }
  ;(plain.userData as BoxGeometryData).pgBoxPair = pair
  ;(beveled.userData as BoxGeometryData).pgBoxPair = pair
  return pair
}

/** Swap geometry only when quality changes; the frame loop never touches it. */
export function applyBoxBevelDetail(root: THREE.Object3D, level: QualityLevel): BoxBevelStats {
  const detailed = boxBevelDetail(level) === 1
  let boxes = 0
  let triangles = 0
  let triangleDelta = 0

  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh !== true) return
    const pair = (mesh.geometry.userData as BoxGeometryData).pgBoxPair
    if (!pair) return
    mesh.geometry = detailed ? pair.beveled : pair.plain
    const count = (mesh as THREE.InstancedMesh).isInstancedMesh === true
      ? (mesh as THREE.InstancedMesh).count
      : 1
    boxes += count
    triangles += (detailed ? BEVELED_BOX_TRIANGLES : BOX_TRIANGLES) * count
    triangleDelta += (detailed ? BEVELED_BOX_TRIANGLES - BOX_TRIANGLES : 0) * count
  })

  return { boxes, triangles, triangleDelta }
}
