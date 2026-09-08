import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { frameLessonObject, lessonObjectBounds } from './lesson-framing'

const bounds = new THREE.Box3(new THREE.Vector3(-16, -52, -89), new THREE.Vector3(16, -27, 62))
const fallback = { target: [0, -32, -73] as [number, number, number], distance: 62, dir: [0.34, 0.56, 0.76] as [number, number, number] }

describe('investigation scene framing', () => {
  for (const [name, aspect, viewport] of [
    ['desktop beside notebook', 1280 / 900, { left: -0.96, right: 0.3, top: 0.7, bottom: -0.75 }],
    ['phone above notebook', 390 / 844, { left: -0.9, right: 0.9, top: 0.7, bottom: 0.05 }],
    ['landscape phone', 844 / 390, { left: -0.95, right: -0.1, top: 0.4, bottom: -0.4 }],
  ] as const) {
    it(`contains every selected relation corner ${name}`, () => {
      const camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 3000)
      const spec = frameLessonObject(camera, bounds, viewport, fallback)
      const target = new THREE.Vector3(...spec.target)
      camera.position.copy(target).addScaledVector(new THREE.Vector3(...spec.dir!).normalize(), spec.distance)
      camera.lookAt(target)
      camera.updateMatrixWorld()
      expect(bounds.containsPoint(camera.position)).toBe(false)
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const p = new THREE.Vector3(x, y, z).project(camera)
        expect(p.x).toBeGreaterThanOrEqual(viewport.left - 1e-6)
        expect(p.x).toBeLessThanOrEqual(viewport.right + 1e-6)
        expect(p.y).toBeGreaterThanOrEqual(viewport.bottom - 1e-6)
        expect(p.y).toBeLessThanOrEqual(viewport.top + 1e-6)
        expect(p.z).toBeLessThan(1)
        expect(p.z).toBeGreaterThan(-1)
      }
    })
  }
})

it('frames authored architecture instead of hidden animation instances', () => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2)
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(168, 8, 0))
  mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(168, -10000, 0))
  const authored = { min: [150, 0, -70] as [number, number, number], max: [186, 24, 70] as [number, number, number] }
  const b = lessonObjectBounds(mesh, authored)
  expect(b.min.toArray()).toEqual(authored.min)
  expect(b.max.toArray()).toEqual(authored.max)
  const spec = frameLessonObject(new THREE.PerspectiveCamera(50, 390 / 844, .1, 3000), b,
    { left: -.9, right: .9, top: .7, bottom: .35 },
    { target: [168, 8, 0], distance: 132, dir: [-.82, .5, -.28] })
  expect(spec.distance).toBeLessThan(1000)
  const camera = new THREE.Vector3(...spec.target).addScaledVector(new THREE.Vector3(...spec.dir!).normalize(), spec.distance)
  expect(camera.y).toBeGreaterThan(0)
  mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose()
})
