import * as THREE from 'three'
import { expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { installTestDom } from './dom'
import { createWalkCityHarness } from './walk-harness'

const DEPTH_BITS = 24

function depthResolution(distance: number, near: number, far: number): number {
  return (distance * distance * (far - near)) / (far * near * (2 ** DEPTH_BITS - 1))
}

function productionSurfaceSeparation(scene: THREE.Scene): number {
  const platform = scene.getObjectByName('ha.failure-domain-platforms') as THREE.InstancedMesh | undefined
  const zone = scene.getObjectByName('ground.zone.replication') as THREE.Mesh | undefined
  if (!platform?.isInstancedMesh || !zone?.isMesh) {
    throw new Error('depth audit could not enumerate the HA platform and replication zone')
  }
  if (!platform.geometry.boundingBox) platform.geometry.computeBoundingBox()
  if (!zone.geometry.boundingBox) zone.geometry.computeBoundingBox()
  const localBox = platform.geometry.boundingBox
  const zoneLocalBox = zone.geometry.boundingBox
  if (!localBox || !zoneLocalBox) throw new Error('production depth layers have no bounding boxes')

  const instance = new THREE.Matrix4()
  const zoneBox = zoneLocalBox.clone().applyMatrix4(zone.matrixWorld)
  for (let instanceId = 0; instanceId < platform.count; instanceId++) {
    platform.getMatrixAt(instanceId, instance)
    instance.premultiply(platform.matrixWorld)
    const platformBox = localBox.clone().applyMatrix4(instance)
    const overlapX = Math.min(platformBox.max.x, zoneBox.max.x) - Math.max(platformBox.min.x, zoneBox.min.x)
    const overlapZ = Math.min(platformBox.max.z, zoneBox.max.z) - Math.max(platformBox.min.z, zoneBox.min.z)
    if (overlapX > 0 && overlapZ > 0) return Math.abs(platformBox.max.y - zoneBox.max.y)
  }
  throw new Error('HA platforms do not overlap the production replication zone')
}

it('keeps orbit depth quantization finer than overlapping production surface layers', async () => {
  const city = await createWalkCityHarness()
  const { createCameraRig } = await import('../src/engine/camera')
  const testDom = installTestDom()
  const surface = testDom.mount('camera-depth-surface') as unknown as HTMLElement
  Object.defineProperties(surface, {
    clientWidth: { value: 1280 },
    clientHeight: { value: 760 },
    getBoundingClientRect: {
      value: () => ({ left: 0, top: 0, width: 1280, height: 760 }),
    },
  })
  const camera = new THREE.PerspectiveCamera(52, 1280 / 760, 0.1, 4000)
  const rig = createCameraRig(camera, surface, createBus())
  try {
    const separation = productionSurfaceSeparation(city.scene)
    rig.focusOn({ target: [0, 3, 0], distance: Number.MAX_SAFE_INTEGER, dir: [0.55, 0.16, 0.82] }, { instant: true })
    const maximumOrbitDistance = camera.position.distanceTo(rig.pivot)
    const quantum = depthResolution(maximumOrbitDistance, camera.near, camera.far)
    const orbitNear = camera.near

    expect(maximumOrbitDistance, 'the invariant must exercise the rig maximum, not a sample distance')
      .toBeGreaterThan(1_000)
    expect(separation, 'the production overlap must retain a measurable depth layer').toBeGreaterThan(0)
    expect(
      quantum * 2,
      `two ${DEPTH_BITS}-bit orbit depth levels must fit between production surfaces ${separation.toFixed(4)} m apart`,
    ).toBeLessThan(separation)
    rig.setMode('walk')
    expect(camera.near, 'walk mode must retain the tight plane needed at collision contact')
      .toBeLessThan(orbitNear)
    rig.setMode('orbit')
    expect(camera.near, 'leaving first person must restore overview precision').toBe(orbitNear)
  } finally {
    rig.dispose()
    city.dispose()
  }
})
