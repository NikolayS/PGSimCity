import * as THREE from 'three'
import { expect, it } from 'vitest'

import { markedTextPlanes, type TextPlaneRecord } from '../src/world/text-plane'
import { createWalkCityHarness } from './walk-harness'

interface PlaneInstance {
  object: THREE.Object3D
  record: TextPlaneRecord
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const RAY_START = 0.08
const RAY_LENGTH = 2.5
const MIN_UP_DOT = Math.cos(THREE.MathUtils.degToRad(35))

function enumerateColliders(debug: THREE.LineSegments): THREE.Box3[] {
  const position = debug.geometry.getAttribute('position')
  const boxes: THREE.Box3[] = []
  const point = new THREE.Vector3()
  for (let offset = 0; offset < position.count; offset += 24) {
    const box = new THREE.Box3()
    for (let i = offset; i < offset + 24; i++) {
      point.fromBufferAttribute(position, i)
      box.expandByPoint(point)
    }
    boxes.push(box)
  }
  return boxes
}

function mappedText(mesh: THREE.Mesh): string[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const text: string[] = []
  for (const material of materials) {
    const map = (material as THREE.Material & { map?: THREE.Texture | null }).map
    const strings = map?.userData.pgText as string[] | undefined
    if (strings) text.push(...strings)
  }
  return text
}

function plateName(text: string): string {
  return `plate(${JSON.stringify(text)})`
}

function firstBlockedDistance(
  center: THREE.Vector3,
  normal: THREE.Vector3,
  colliders: readonly THREE.Box3[],
): number | null {
  const origin = center.clone().addScaledVector(normal, RAY_START)
  const ray = new THREE.Ray(origin, normal)
  const hit = new THREE.Vector3()
  let nearest = Number.POSITIVE_INFINITY
  for (const box of colliders) {
    // A coarse component collider can already contain a thin sign even when
    // the rendered host stops behind it. It cannot establish which face is
    // reachable; only a collider entered after leaving the plate can.
    if (box.containsPoint(center)) continue
    if (box.containsPoint(origin)) return RAY_START
    if (!ray.intersectBox(box, hit)) continue
    const distance = hit.distanceTo(center)
    if (distance >= RAY_START && distance <= RAY_LENGTH && distance < nearest) {
      nearest = distance
    }
  }
  return Number.isFinite(nearest) ? nearest : null
}

function isVisible(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  return true
}

function firstHostDistance(
  scene: THREE.Scene,
  center: THREE.Vector3,
  normal: THREE.Vector3,
  raycaster: THREE.Raycaster,
): number | null {
  raycaster.set(center, normal)
  raycaster.near = RAY_START
  raycaster.far = RAY_LENGTH
  const hits = raycaster.intersectObjects(scene.children, true)
  for (const hit of hits) {
    const mesh = hit.object as THREE.Mesh
    if (!mesh.isMesh || !isVisible(mesh) || markedTextPlanes(mesh).length > 0) continue
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (!materials.some((material) => material.visible && (!material.transparent || material.opacity > 0.01))) {
      continue
    }
    return hit.distance
  }
  return null
}

it('keeps every fixed text plane readable from reachable, unmirrored space', async () => {
  const city = await createWalkCityHarness({ includeControlCenter: true })
  try {
    const failures: string[] = []
    const planes: PlaneInstance[] = []
    city.scene.traverse((object) => {
      for (const record of markedTextPlanes(object)) planes.push({ object, record })
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const text = mappedText(mesh)
      if (text.length > 0 && markedTextPlanes(mesh).length === 0) {
        failures.push(`${plateName(text.join(' / '))} has no legibility geometry`)
      }
    })

    expect(planes.length, 'the audit must cover the city-wide text-plane class').toBeGreaterThan(100)

    const colliders = enumerateColliders(city.collision.debugMesh())
    const center = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const up = new THREE.Vector3()
    const expectedUp = new THREE.Vector3()
    const normalMatrix = new THREE.Matrix3()
    const raycaster = new THREE.Raycaster()

    for (const { object, record } of planes) {
      const name = plateName(record.text)
      const determinant = object.matrixWorld.determinant()
      if (!(determinant > 0)) {
        failures.push(`${name} has reflected world transform (determinant ${determinant.toFixed(3)})`)
        continue
      }
      if (!record.fixed) continue

      center.fromArray(record.center).applyMatrix4(object.matrixWorld)
      normalMatrix.getNormalMatrix(object.matrixWorld)
      normal.fromArray(record.normal).applyMatrix3(normalMatrix).normalize()
      up.fromArray(record.up).transformDirection(object.matrixWorld)

      expectedUp.copy(WORLD_UP).addScaledVector(normal, -WORLD_UP.dot(normal))
      if (expectedUp.lengthSq() > 0.0625) {
        expectedUp.normalize()
        const upDot = up.dot(expectedUp)
        if (upDot < MIN_UP_DOT) {
          failures.push(`${name} is not upright (up dot ${upDot.toFixed(3)})`)
        }
      }

      const colliderDistance = firstBlockedDistance(center, normal, colliders)
      const hostDistance = firstHostDistance(city.scene, center, normal, raycaster)
      const blockedAt = colliderDistance === null
        ? hostDistance
        : hostDistance === null
          ? colliderDistance
          : Math.min(colliderDistance, hostDistance)
      if (blockedAt !== null) {
        if (process.env.TEXT_PLANE_AUDIT_REPORT === '1') {
          const ray = new THREE.Ray(center.clone().addScaledVector(normal, RAY_START), normal)
          const hit = new THREE.Vector3()
          const colliderBoxes = colliders.flatMap((box) => {
            if (box.containsPoint(center) || !ray.intersectBox(box, hit)) return []
            const distance = hit.distanceTo(center)
            if (distance > RAY_LENGTH) return []
            return [{
              distance: Number(distance.toFixed(2)),
              bounds: box.min.toArray().concat(box.max.toArray())
                .map((value) => Number(value.toFixed(2))).join(','),
            }]
          })
          console.info(name, {
            center: center.toArray().map((value) => Number(value.toFixed(2))),
            normal: normal.toArray().map((value) => Number(value.toFixed(2))),
            colliderDistance,
            hostDistance,
            colliderBoxes,
          })
        }
        failures.push(`${name} faces into geometry at ${blockedAt.toFixed(2)} units`)
      }
    }

    if (failures.length > 0) {
      throw new Error(`text-plane geometric invariant failed (${failures.length}):\n${failures.join('\n')}`)
    }
  } finally {
    city.dispose()
  }
})
