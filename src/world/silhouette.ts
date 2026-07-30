import * as THREE from 'three'

import { makeRng } from '../core/util'
import type { QualityLevel, WorldContext, WorldModule } from '../core/types'

interface Roof {
  x: number
  y: number
  z: number
  w: number
  d: number
}

const DETAIL_BUDGET: Record<QualityLevel, number> = {
  low: 0,
  reduced: 0,
  medium: 18,
  high: 34,
  ultra: 48,
}

export function silhouetteDetailBudget(level: QualityLevel): number {
  return DETAIL_BUDGET[level]
}

const EXCLUDED_NAME = /(ground|floor|deck|road|zone|water|shadow|sky|cloud|label|flow|route|rail)/i

/**
 * Find substantial box roofs once, after the city is built. Instanced building
 * batches are expanded here; broad district roots are ignored so detail lands
 * on actual buildings, never at the top of a compound bounding box.
 */
export function findSkylineRoofs(scene: THREE.Scene): Roof[] {
  const roofs: Roof[] = []
  const box = new THREE.Box3()
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  const localMatrix = new THREE.Matrix4()
  const worldMatrix = new THREE.Matrix4()
  const seen = new Set<string>()

  scene.updateMatrixWorld(true)
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>
    if (mesh.isMesh !== true) return
    if (mesh.geometry.type !== 'BoxGeometry' || EXCLUDED_NAME.test(mesh.name)) return
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (
      !materials.some(
        (material) =>
          (material as THREE.MeshStandardMaterial).isMeshStandardMaterial === true &&
          !material.transparent,
      )
    ) {
      return
    }

    mesh.geometry.computeBoundingBox()
    if (!mesh.geometry.boundingBox) return

    const consider = (matrix: THREE.Matrix4): void => {
      box.copy(mesh.geometry.boundingBox!).applyMatrix4(matrix)
      box.getSize(size)
      box.getCenter(center)
      if (
        box.max.y < 8 ||
        box.max.y > 115 ||
        box.min.y < -1 ||
        size.y < 4.5 ||
        size.x < 7 ||
        size.z < 7 ||
        size.x > 64 ||
        size.z > 64 ||
        Math.abs(center.x) > 340 ||
        center.z < -390 ||
        center.z > 380
      ) {
        return
      }

      const key = `${Math.round(center.x / 2)}:${Math.round(center.z / 2)}:${Math.round(box.max.y)}`
      if (seen.has(key)) return
      seen.add(key)
      roofs.push({ x: center.x, y: box.max.y, z: center.z, w: size.x, d: size.z })
    }

    const instanced = mesh as THREE.InstancedMesh
    if (instanced.isInstancedMesh !== true) {
      consider(mesh.matrixWorld)
      return
    }
    for (let i = 0; i < instanced.count; i++) {
      instanced.getMatrixAt(i, localMatrix)
      worldMatrix.multiplyMatrices(mesh.matrixWorld, localMatrix)
      consider(worldMatrix)
    }
  })

  roofs.sort((a, b) => b.w * b.d - a.w * a.d || b.y - a.y || a.x - b.x || a.z - b.z)
  return roofs.slice(0, DETAIL_BUDGET.ultra)
}

function setMatrix(
  mesh: THREE.InstancedMesh,
  index: number,
  matrix: THREE.Matrix4,
  position: THREE.Vector3,
  scale: THREE.Vector3,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  position.set(x, y, z)
  scale.set(sx, sy, sz)
  matrix.compose(position, _quaternion, scale)
  mesh.setMatrixAt(index, matrix)
}

const _quaternion = new THREE.Quaternion()

export function createSilhouetteDetails(ctx: WorldContext): WorldModule {
  const group = new THREE.Group()
  group.name = 'skyline.detail'
  group.visible = false
  group.userData.pgDayOnly = true

  const roofs = findSkylineRoofs(ctx.scene)
  const count = roofs.length
  const structure = ctx.theme.mat('ground.skylinePlant', {
    color: 0x202b42,
    roughness: 0.82,
    metalness: 0.12,
  })
  const metal = ctx.theme.mat('ground.skylineMetal', {
    color: 0x27334a,
    roughness: 0.58,
    metalness: 0.62,
    surface: false,
  })
  const boxGeometry = ctx.theme.box(1, 1, 1)
  const ventGeometry = ctx.theme.cyl(0.5, 0.62, 1, 8)
  const mastGeometry = ctx.theme.cyl(0.5, 0.5, 1, 6)

  const plants = new THREE.InstancedMesh(boxGeometry, structure, count)
  const vents = new THREE.InstancedMesh(ventGeometry, metal, count)
  const masts = new THREE.InstancedMesh(mastGeometry, metal, count)
  const parapets = new THREE.InstancedMesh(boxGeometry, structure, count * 2)
  const railings = new THREE.InstancedMesh(boxGeometry, metal, count * 4)
  plants.name = 'skyline.plant'
  vents.name = 'skyline.vent'
  masts.name = 'skyline.mast'
  parapets.name = 'skyline.parapet'
  railings.name = 'skyline.railing'

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const rng = makeRng(0x60d3a7)
  for (let i = 0; i < count; i++) {
    const roof = roofs[i]
    const side = rng() < 0.5 ? -1 : 1
    const px = roof.x + side * roof.w * (0.12 + rng() * 0.12)
    const pz = roof.z + (rng() - 0.5) * roof.d * 0.28
    const pw = Math.min(roof.w * 0.34, 2.4 + rng() * 3.4)
    const pd = Math.min(roof.d * 0.3, 2.2 + rng() * 3.0)
    const ph = 1.2 + rng() * 2.4
    setMatrix(plants, i, matrix, position, scale, px, roof.y + ph / 2, pz, pw, ph, pd)

    const vh = 1.1 + rng() * 1.8
    setMatrix(
      vents,
      i,
      matrix,
      position,
      scale,
      roof.x - side * roof.w * 0.24,
      roof.y + vh / 2,
      roof.z + (rng() - 0.5) * roof.d * 0.34,
      0.55 + rng() * 0.5,
      vh,
      0.55 + rng() * 0.5,
    )

    const mh = 4.5 + rng() * 7.5
    setMatrix(
      masts,
      i,
      matrix,
      position,
      scale,
      roof.x + (rng() - 0.5) * roof.w * 0.35,
      roof.y + mh / 2,
      roof.z + (rng() - 0.5) * roof.d * 0.35,
      0.16,
      mh,
      0.16,
    )

    const parapetA = 0.45 + rng() * 0.75
    const parapetB = 0.45 + rng() * 0.75
    setMatrix(
      parapets,
      i * 2,
      matrix,
      position,
      scale,
      roof.x,
      roof.y + parapetA / 2,
      roof.z - roof.d * 0.47,
      roof.w * 0.86,
      parapetA,
      0.42,
    )
    setMatrix(
      parapets,
      i * 2 + 1,
      matrix,
      position,
      scale,
      roof.x - roof.w * 0.47,
      roof.y + parapetB / 2,
      roof.z,
      0.42,
      parapetB,
      roof.d * 0.86,
    )

    const railY = roof.y + 1.25
    setMatrix(
      railings,
      i * 4,
      matrix,
      position,
      scale,
      roof.x,
      railY,
      roof.z + roof.d * 0.46,
      roof.w * 0.72,
      0.13,
      0.13,
    )
    for (let post = 0; post < 3; post++) {
      setMatrix(
        railings,
        i * 4 + 1 + post,
        matrix,
        position,
        scale,
        roof.x + (post - 1) * roof.w * 0.34,
        roof.y + 0.65,
        roof.z + roof.d * 0.46,
        0.13,
        1.3,
        0.13,
      )
    }
  }

  const meshes = [plants, vents, masts, parapets, railings]
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i]
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.raycast = () => {}
    group.add(mesh)
  }

  function applyQuality(level: QualityLevel): void {
    const budget = Math.min(count, silhouetteDetailBudget(level))
    plants.count = budget
    vents.count = budget
    masts.count = Math.floor(budget * 0.45)
    parapets.count = budget * 2
    railings.count = budget * 4
  }

  applyQuality(ctx.quality.level)
  const offQuality = ctx.bus.on('quality', ({ level }) => applyQuality(level))

  return {
    id: 'silhouette',
    group,
    update(): void {},
    dispose(): void {
      offQuality()
    },
  }
}
