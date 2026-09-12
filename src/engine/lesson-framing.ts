import * as THREE from 'three'
import type { FocusSpec } from '../core/types'

/** Available canvas rectangle in normalized device coordinates. */
export interface FocusViewport { left: number; top: number; right: number; bottom: number }

export function frameLessonObject(
  camera: THREE.PerspectiveCamera, bounds: THREE.Box3, viewport: FocusViewport, fallback: FocusSpec,
): FocusSpec {
  if (bounds.isEmpty() || viewport.right - viewport.left < 0.05 || viewport.top - viewport.bottom < 0.05) return fallback
  const direction = new THREE.Vector3(...(fallback.dir ?? [0.1, 1, 0.2])).normalize()
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), direction).normalize()
  if (right.lengthSq() < 0.01) return fallback
  const up = new THREE.Vector3().crossVectors(direction, right)
  const center = bounds.getCenter(new THREE.Vector3())
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom
  const tanX = tanY * camera.aspect
  const cx = (viewport.left + viewport.right) / 2
  const cy = (viewport.bottom + viewport.top) / 2
  const corner = new THREE.Vector3()
  let distance = 24
  /* Solve all eight perspective corner inequalities, including depth, instead
   * of fitting a sphere to the whole canvas behind an opaque notebook. */
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    corner.set(x, y, z).sub(center)
    const px = corner.dot(right) / tanX
    const py = corner.dot(up) / tanY
    const depth = corner.dot(direction)
    distance = Math.max(distance, depth + camera.near + 1,
      (px + viewport.right * depth) / (viewport.right - cx),
      (-px - viewport.left * depth) / (cx - viewport.left),
      (py + viewport.top * depth) / (viewport.top - cy),
      (-py - viewport.bottom * depth) / (cy - viewport.bottom))
  }
  center.addScaledVector(right, -cx * distance * tanX).addScaledVector(up, -cy * distance * tanY)
  return { target: center.toArray(), distance, dir: direction.toArray(), viewportFitted: true }
}

/** Authored architecture bounds avoid parked/hidden instance transforms. */
export function lessonObjectBounds(object: THREE.Object3D,
  authored?: { min: [number, number, number]; max: [number, number, number] },
): THREE.Box3 {
  return authored
    ? new THREE.Box3(new THREE.Vector3(...authored.min), new THREE.Vector3(...authored.max))
    : new THREE.Box3().setFromObject(object)
}
