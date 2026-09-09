import * as THREE from 'three'

/* A shadow-only body participates in the ordinary light/depth pass. It never
 * paints a silhouette over walls or invents a shadow when the sun is disabled. */
export function createWalkShadow() {
  const group = new THREE.Group()
  group.name = 'walk:body-shadow'
  group.visible = false
  const material = new THREE.MeshStandardMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: true,
  })
  material.userData.pgNoSurface = true
  const sphere = new THREE.SphereGeometry(1, 12, 8)
  const geometries: THREE.BufferGeometry[] = [sphere]
  function part(name: string, geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `walk:shadow-${name}`
    mesh.position.set(x, y, z)
    mesh.castShadow = true
    mesh.raycast = () => {}
    group.add(mesh)
    return mesh
  }
  function capsule(radius: number, length: number) {
    const geometry = new THREE.CapsuleGeometry(radius, length, 4, 8)
    geometries.push(geometry)
    return geometry
  }
  part('head', sphere, 0, 1.55, 0).scale.set(0.135, 0.16, 0.14)
  part('torso', capsule(0.19, 0.35), 0, 1.05, 0).scale.z = 0.7
  const legGeometry = capsule(0.085, 0.53)
  const armGeometry = capsule(0.06, 0.43)
  const leftLeg = part('left-leg', legGeometry, -0.105, 0.35, 0)
  const rightLeg = part('right-leg', legGeometry, 0.105, 0.35, 0)
  const leftArm = part('left-arm', armGeometry, -0.265, 1.015, 0)
  const rightArm = part('right-arm', armGeometry, 0.265, 1.015, 0)
  part('left-foot', sphere, -0.105, 0.055, -0.05).scale.set(0.085, 0.055, 0.15)
  part('right-foot', sphere, 0.105, 0.055, -0.05).scale.set(0.085, 0.055, 0.15)

  return {
    group,
    update(position: THREE.Vector3, yaw: number, crouching: boolean, phase: number, speed: number) {
      group.position.copy(position)
      group.rotation.y = yaw
      group.scale.y = crouching ? 1.25 / 1.7 : 1
      const swing = Math.sin(phase) * speed
      leftLeg.rotation.x = swing * 0.25
      rightLeg.rotation.x = -swing * 0.25
      leftArm.rotation.x = -swing * 0.35
      rightArm.rotation.x = swing * 0.35
    },
    dispose() {
      group.removeFromParent()
      for (const geometry of geometries) geometry.dispose()
      material.dispose()
    },
  }
}
