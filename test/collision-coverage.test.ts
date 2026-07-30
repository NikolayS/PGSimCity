import * as THREE from 'three'
import { expect, it } from 'vitest'
import type { TraversalRoute, WalkPoint } from './walk-harness'
import { createWalkCityHarness } from './walk-harness'

interface MeshRecord {
  mesh: THREE.Mesh
  path: string
  box: THREE.Box3
}

function objectPath(object: THREE.Object3D): string {
  const parts: string[] = []
  let current: THREE.Object3D | null = object
  while (current && !current.isScene) {
    parts.push(current.name || current.type)
    current = current.parent
  }
  return parts.reverse().join('/')
}

function isRendered(mesh: THREE.Mesh): boolean {
  let current: THREE.Object3D | null = mesh
  while (current) {
    if (!current.visible) return false
    current = current.parent
  }
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.some(
    (material) => material.visible && (!material.transparent || material.opacity > 0.01),
  )
}

function enumerateMeshes(scene: THREE.Scene): MeshRecord[] {
  const records: MeshRecord[] = []
  const localBox = new THREE.Box3()
  const matrix = new THREE.Matrix4()
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !isRendered(mesh)) return
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    if (!mesh.geometry.boundingBox || mesh.geometry.boundingBox.isEmpty()) return
    const path = objectPath(mesh)
    const instanced = mesh as THREE.InstancedMesh
    if (instanced.isInstancedMesh) {
      for (let i = 0; i < instanced.count; i++) {
        instanced.getMatrixAt(i, matrix)
        matrix.premultiply(instanced.matrixWorld)
        localBox.copy(mesh.geometry.boundingBox).applyMatrix4(matrix)
        records.push({ mesh, path, box: localBox.clone() })
      }
      return
    }
    localBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld)
    records.push({ mesh, path, box: localBox.clone() })
  })
  return records
}

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

function isHumanScaleAtWalkableHeight(box: THREE.Box3): boolean {
  // Feet can occupy the pit floor (-60), storage floor (-52), city/deck
  // (0/3), and the query-lab floor (45). Its 1.8 m capsule reaches 46.8.
  if (box.max.y <= -60.05 || box.min.y >= 46.8) return false
  const size = box.getSize(new THREE.Vector3())
  const dimensions = [size.x, size.y, size.z].sort((a, b) => b - a)
  return dimensions[0] >= 0.7 && dimensions[1] >= 0.08
}

function overlapsCapsuleMargin(mesh: THREE.Box3, collider: THREE.Box3): boolean {
  // The 0.35 m capsule stops before its centre reaches the box, so visible
  // skins and trim within that margin are covered by the same solid.
  const margin = 0.35
  return (
    mesh.max.x + margin >= collider.min.x &&
    mesh.min.x - margin <= collider.max.x &&
    mesh.max.y + margin >= collider.min.y &&
    mesh.min.y - margin <= collider.max.y &&
    mesh.max.z + margin >= collider.min.z &&
    mesh.min.z - margin <= collider.max.z
  )
}

function materialNames(mesh: THREE.Mesh): string {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.map((material) => material.name).join(',')
}

function passableReason(record: MeshRecord): string | null {
  const geometry = record.mesh.geometry.type
  const material = materialNames(record.mesh)
  if (geometry === 'PlaneGeometry') return 'zero-thickness floor, label, or sign plane'
  if (record.box.max.y - record.box.min.y < 0.3) return 'sub-collider-thickness slab or trim'
  if (material === 'shmem.liveData' || record.path.includes('shmem/shared.buffers/')) {
    return 'dynamic shared-memory data'
  }
  if (material === 'storage.liveData') return 'dynamic storage data'
  if (material === 'storage.osCache') return 'zero-thickness kernel-cache tiles'
  if (record.path.includes('storage.io.collars')) return 'overhead I/O conduit trim'
  if (record.path.startsWith('access/')) {
    return 'below-walkway truss or thin illuminated access trim'
  }
  if (record.path.includes('maint.yard') && material.startsWith('neon:')) {
    return 'painted guide or lamp head'
  }
  return null
}

function isPublishedDefectFamily(record: MeshRecord): boolean {
  const material = materialNames(record.mesh)
  return (
    record.path.includes('ground.mast.') ||
    (record.path.includes('client.terminal') && material === 'clients.struct') ||
    (record.path.includes('conn.gate') && material === 'clients.struct') ||
    record.path.includes('conn.conduit.piers') ||
    material === 'shmem.pylon' ||
    record.path.includes('storage.index.masts') ||
    material === 'storage.structLo' ||
    (material === 'storage.structHi' && !record.path.includes('storage.io.collars')) ||
    (record.path.includes('vac.depot') && material === 'maint.deep') ||
    (record.path.includes('maint.yard') && material === 'maint.deep') ||
    material === 'ground.pitWall'
  )
}

it('covers every visible human-scale solid found by scene-graph enumeration', async () => {
  const city = await createWalkCityHarness()
  try {
    const meshes = enumerateMeshes(city.scene)
    const colliders = enumerateColliders(city.collision.debugMesh())
    const candidates = meshes.filter((record) => isHumanScaleAtWalkableHeight(record.box))
    const uncovered = candidates.filter(
      (record) =>
        !colliders.some((collider) => overlapsCapsuleMargin(record.box, collider)),
    )
    const unknown = uncovered.filter((record) => passableReason(record) === null)
    const defectFamilies = candidates.filter(isPublishedDefectFamily)
    const uncoveredDefects = defectFamilies.filter(
      (record) =>
        !colliders.some((collider) => overlapsCapsuleMargin(record.box, collider)),
    )
    const colliderOnly = colliders.filter(
      (collider) =>
        !meshes.some((record) => overlapsCapsuleMargin(record.box, collider)),
    )
    const unexpectedColliderOnly = colliderOnly.filter((box) => {
      const stagedPlanner =
        box.min.y >= 43 &&
        box.min.x >= -71 &&
        box.max.x <= 71 &&
        box.min.z >= -146 &&
        box.max.z <= -114
      const thinYardRail =
        box.min.x >= -250.1 &&
        box.max.x <= -249.9 &&
        box.min.z >= -64.1 &&
        box.max.z <= 104.1
      return !stagedPlanner && !thinYardRail
    })

    expect(new Set(meshes.map((record) => record.mesh)).size).toBeGreaterThan(330)
    expect(meshes.length).toBeGreaterThan(11_000)
    expect(candidates.length).toBeGreaterThan(8_000)
    expect(defectFamilies.length).toBeGreaterThan(500)
    expect(
      unknown.map((record) => ({
        path: record.path,
        geometry: record.mesh.geometry.type,
        material: materialNames(record.mesh),
        box: [record.box.min.toArray(), record.box.max.toArray()],
      })),
    ).toEqual([])
    expect(
      uncoveredDefects.map((record) => ({
        path: record.path,
        material: materialNames(record.mesh),
        box: [record.box.min.toArray(), record.box.max.toArray()],
      })),
    ).toEqual([])
    expect(unexpectedColliderOnly).toEqual([])

    if (process.env.COLLISION_AUDIT_REPORT === '1') {
      const passable = new Map<string, number>()
      for (const record of uncovered) {
        const reason = passableReason(record) ?? 'UNKNOWN'
        passable.set(reason, (passable.get(reason) ?? 0) + 1)
      }
      console.log(JSON.stringify({
        meshObjects: new Set(meshes.map((record) => record.mesh)).size,
        meshInstances: meshes.length,
        candidateObjects: new Set(candidates.map((record) => record.mesh)).size,
        candidateInstances: candidates.length,
        colliders: colliders.length,
        rawUncovered: uncovered.length,
        realUncovered: unknown.length,
        colliderOnly: colliderOnly.length,
        unexpectedColliderOnly: unexpectedColliderOnly.length,
        passable: Object.fromEntries(passable),
      }))
    }
  } finally {
    city.dispose()
  }
})

interface WallProbe {
  id: string
  start: WalkPoint
  target: WalkPoint
  hit: THREE.Vector3
  normal: THREE.Vector3
  openAway: boolean
}

const STANDING_LEVELS = [45, 3.7, 3.2, 0.62, 0.02, -52, -60] as const

function standingFeet(
  city: Awaited<ReturnType<typeof createWalkCityHarness>>,
  x: number,
  z: number,
): number | null {
  const point = new THREE.Vector3()
  for (const level of STANDING_LEVELS) {
    point.set(x, level + 0.6, z)
    const ground = city.collision.groundAt(point, 1.2)
    if (ground !== null && Math.abs(ground - level) < 0.8) return ground
  }
  return null
}

function firstVerticalHit(
  ray: THREE.Raycaster,
  object: THREE.Object3D,
  normalMatrix: THREE.Matrix3,
  normal: THREE.Vector3,
): THREE.Intersection | null {
  const hits = ray.intersectObject(object, true)
  for (const hit of hits) {
    const mesh = hit.object as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry || !hit.face || !isRendered(mesh)) continue
    normalMatrix.getNormalMatrix(mesh.matrixWorld)
    normal.copy(hit.face.normal).applyNormalMatrix(normalMatrix).normalize()
    if (Math.abs(normal.y) < 0.55) return hit
  }
  return null
}

function sampleWallProbes(
  city: Awaited<ReturnType<typeof createWalkCityHarness>>,
): { probes: WallProbe[]; counts: Readonly<Record<string, number>> } {
  const ids = [
    'postmaster',
    'wal.buffers',
    'backend.row',
    'wal.vault',
    'storage.table.accounts',
    'checkpointer',
    'replica.standby',
  ] as const
  const probes: WallProbe[] = []
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  const ray = new THREE.Raycaster()
  const origin = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const normalMatrix = new THREE.Matrix3()
  const solidMeshes = enumerateMeshes(city.scene).filter(
    (record) => isHumanScaleAtWalkableHeight(record.box) && passableReason(record) === null,
  )
  const openSweep = new THREE.Box3()

  for (const id of ids) {
    const component = city.registry.get(id)
    if (!component) throw new Error(`Unknown reachability component: ${id}`)
    const box = new THREE.Box3().setFromObject(component.object)
    const cx = (box.min.x + box.max.x) / 2
    const cz = (box.min.z + box.max.z) / 2
    const starts: [number, number][] = []
    for (let x = Math.ceil(box.min.x / 3) * 3; x <= box.max.x; x += 3) {
      starts.push([x, box.min.z - 8], [x, box.max.z + 8])
    }
    for (let z = Math.ceil(box.min.z / 3) * 3; z <= box.max.z; z += 3) {
      starts.push([box.min.x - 8, z], [box.max.x + 8, z])
    }

    for (const start of starts) {
      const feet = standingFeet(city, start[0], start[1])
      if (feet === null) continue
      origin.set(start[0], feet + 0.9, start[1])
      direction.set(cx - start[0], 0, cz - start[1]).normalize()
      ray.set(origin, direction)
      ray.near = 0
      ray.far = Math.hypot(cx - start[0], cz - start[1]) * 2
      const hit = firstVerticalHit(ray, component.object, normalMatrix, normal)
      if (!hit) continue
      if (normal.dot(direction) > 0) normal.negate()
      const probeX = hit.point.x + normal.x * 2
      const probeZ = hit.point.z + normal.z * 2
      const probeFeet = standingFeet(city, probeX, probeZ)
      if (probeFeet === null || Math.abs(probeFeet - feet) > 0.7) continue
      const openX = probeX + normal.x
      const openZ = probeZ + normal.z
      openSweep.min.set(
        Math.min(probeX, openX) - 0.35,
        probeFeet + 0.45,
        Math.min(probeZ, openZ) - 0.35,
      )
      openSweep.max.set(
        Math.max(probeX, openX) + 0.35,
        probeFeet + 1.35,
        Math.max(probeZ, openZ) + 0.35,
      )
      const openAway = !solidMeshes.some((record) => record.box.intersectsBox(openSweep))
      const key = [
        id,
        Math.round(hit.point.x * 2),
        Math.round(hit.point.z * 2),
        Math.round(normal.x * 10),
        Math.round(normal.z * 10),
      ].join(':')
      if (seen.has(key)) continue
      seen.add(key)
      probes.push({
        id,
        start: [probeX, probeFeet, probeZ],
        target: [hit.point.x - normal.x, probeFeet, hit.point.z - normal.z],
        hit: hit.point.clone(),
        normal: normal.clone(),
        openAway,
      })
      counts[id] = (counts[id] ?? 0) + 1
    }
  }

  // The query lab is reached from its own floor; there is no standing ground
  // outside the suspended shell for the perimeter sampler to discover.
  for (let x = -56; x <= 56; x += 16) {
    probes.push({
      id: 'planner.lab',
      start: [x, 45, -142],
      target: [x, 45, -147],
      hit: new THREE.Vector3(x, 45.9, -145.5),
      normal: new THREE.Vector3(0, 0, 1),
      openAway: true,
    })
    counts['planner.lab'] = (counts['planner.lab'] ?? 0) + 1
  }
  return { probes, counts }
}

it('keeps visible building walls reachable by the real walk controller', async () => {
  const city = await createWalkCityHarness()
  try {
    /*
     * Coverage and reachability are separate properties. A component-wide box
     * can overlap every mesh yet be ignored from a valid standing position
     * inside that loose box, leaving the visible wall itself passable.
     */
    const { probes, counts } = sampleWallProbes(city)
    const failures: unknown[] = []
    const openFailures: unknown[] = []
    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i]
      const route: TraversalRoute = {
        id: `reachability:${probe.id}:${i}`,
        points: [probe.start, probe.target],
        gait: 'run',
        tolerance: 0.15,
        maxFramesPerLeg: 160,
        stopOnCollision: true,
      }
      const result = city.run(route)
      const final = new THREE.Vector3(
        result.finalPosition[0],
        result.finalPosition[1] + 0.9,
        result.finalPosition[2],
      )
      const side = probe.normal.dot(final.sub(probe.hit))
      if (result.reached || result.collisions === 0 || side < 0.3) {
        failures.push({
          id: probe.id,
          start: probe.start,
          target: probe.target,
          final: result.finalPosition,
          reached: result.reached,
          collisions: result.collisions,
          wallSide: side,
        })
      }

      // The reverse property matters too: the same reachable standing sample
      // must remain free when the controller walks away from the visible wall.
      if (probe.openAway) {
        const openTarget: WalkPoint = [
          probe.start[0] + probe.normal.x,
          probe.start[1],
          probe.start[2] + probe.normal.z,
        ]
        const open = city.run({
          id: `open-ground:${probe.id}:${i}`,
          points: [probe.start, openTarget],
          gait: 'walk',
          tolerance: 0.25,
          maxFramesPerLeg: 100,
          stopOnCollision: true,
        })
        if (!open.reached || open.collisions > 0) {
          openFailures.push({
            id: probe.id,
            start: probe.start,
            target: openTarget,
            final: open.finalPosition,
            reached: open.reached,
            collisions: open.collisions,
          })
        }
      }
    }

    expect(counts).toMatchObject({
      postmaster: expect.any(Number),
      'wal.buffers': expect.any(Number),
      'backend.row': expect.any(Number),
      'wal.vault': expect.any(Number),
      'storage.table.accounts': expect.any(Number),
      checkpointer: expect.any(Number),
      'replica.standby': expect.any(Number),
      'planner.lab': 8,
    })
    if (process.env.COLLISION_REACHABILITY_REPORT === '1') {
      console.log(JSON.stringify({
        wallProbes: counts,
        openGroundProbes: probes.filter((probe) => probe.openAway).length,
        wallFailures: failures.length,
        openGroundFailures: openFailures.length,
      }))
    }
    for (const [id, count] of Object.entries(counts)) {
      expect(count, `${id} systematic wall probes`).toBeGreaterThanOrEqual(8)
    }
    expect(probes.filter((probe) => probe.openAway).length).toBeGreaterThanOrEqual(24)
    expect(failures).toEqual([])
    expect(openFailures).toEqual([])
  } finally {
    city.dispose()
  }
}, 20_000)
