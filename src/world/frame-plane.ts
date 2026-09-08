import * as THREE from 'three'

/** A UV-compatible PlaneGeometry with the buffer basin cut out of its centre. */
export function rectangularFramePlane(width: number, depth: number, holeHalf: number): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const halfW = width / 2
  const halfD = depth / 2
  const addQuad = (x0: number, y0: number, x1: number, y1: number): void => {
    const base = positions.length / 3
    positions.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0)
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1)
    uvs.push(
      (x0 + halfW) / width, (y0 + halfD) / depth,
      (x1 + halfW) / width, (y0 + halfD) / depth,
      (x1 + halfW) / width, (y1 + halfD) / depth,
      (x0 + halfW) / width, (y1 + halfD) / depth,
    )
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  addQuad(-halfW, -halfD, halfW, -holeHalf)
  addQuad(-halfW, holeHalf, halfW, halfD)
  addQuad(-halfW, -holeHalf, -holeHalf, holeHalf)
  addQuad(holeHalf, -holeHalf, halfW, holeHalf)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

