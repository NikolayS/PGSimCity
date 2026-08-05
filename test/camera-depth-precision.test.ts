import * as THREE from 'three'
import { expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { installTestDom } from './dom'
import { createWalkCityHarness } from './walk-harness'

const DEPTH_BITS = 24

function depthResolution(distance: number, near: number, far: number): number {
  return (distance * distance * (far - near)) / (far * near * (2 ** DEPTH_BITS - 1))
}

function viewDepth(camera: THREE.PerspectiveCamera, point: THREE.Vector3): number {
  return -point.clone().applyMatrix4(camera.matrixWorldInverse).z
}

function insideSidePlanes(camera: THREE.PerspectiveCamera, point: THREE.Vector3): boolean {
  const projected = point.clone().project(camera)
  return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
}

function walkForeground(camera: THREE.PerspectiveCamera): THREE.Vector3[] {
  const points: THREE.Vector3[] = []
  for (let xi = -32; xi <= 32; xi++) {
    for (let zi = 1; zi <= 160; zi++) {
      const point = new THREE.Vector3(xi / 20, 0, -zi / 20)
      const depth = viewDepth(camera, point)
      if (insideSidePlanes(camera, point) && depth >= 0.1 && depth <= camera.far) {
        points.push(point)
      }
    }
  }
  return points
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

it('keeps every still-framed walk foreground point through the whole orbit handoff', async () => {
  const { createCameraRig } = await import('../src/engine/camera')
  const testDom = installTestDom()
  const surface = testDom.mount('camera-transition-surface') as unknown as HTMLElement
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
    rig.setMode('walk')
    camera.position.set(0, 1.7, 0)
    camera.lookAt(0, 0, -3)
    camera.updateMatrixWorld()
    const foreground = walkForeground(camera)
    expect(foreground.length, 'the property needs a substantial pre-transition floor sample')
      .toBeGreaterThan(1_000)

    /* This is the production walk exit shape: up 60 m and back 60 m, with the
     * focus tween entered synchronously after the mode handoff. */
    rig.setMode('orbit')
    rig.focusOn(
      { target: [0, 6, -12], distance: Math.hypot(60, 72), dir: [0, 60, 72] },
      { duration: 1.1 },
    )

    for (let frame = 0; frame <= 70; frame++) {
      const clipped = foreground.filter((point) => {
        const depth = viewDepth(camera, point)
        return insideSidePlanes(camera, point)
          && depth >= 0.1
          && depth < camera.near
      })
      expect(
        clipped,
        `frame ${frame} raised near to ${camera.near} while old foreground remained framed`,
      ).toEqual([])
      rig.update(1 / 60)
    }

    /* Focus and scenario requests can arrive without main.ts's orbit pre-step.
     * Changing the framed subject still cannot change clipping at a fixed eye. */
    rig.setMode('walk')
    camera.position.set(0, 1.7, 0)
    camera.lookAt(0, 0, -3)
    camera.updateMatrixWorld()
    rig.focusOn(
      { target: [0, 3, -300], distance: 400, dir: [0, 1, 1] },
      { duration: 1.1 },
    )
    for (let frame = 0; frame <= 70; frame++) {
      const clipped = foreground.filter((point) => {
        const depth = viewDepth(camera, point)
        return insideSidePlanes(camera, point)
          && depth >= 0.1
          && depth < camera.near
      })
      expect(
        clipped,
        `direct focus frame ${frame} raised near before the eye cleared old foreground`,
      ).toEqual([])
      rig.update(1 / 60)
    }
  } finally {
    rig.dispose()
  }
})

it('uses live framing distance for focus, tour, and orbit-to-walk cameras', async () => {
  const { createCameraRig } = await import('../src/engine/camera')
  const testDom = installTestDom()
  const surface = testDom.mount('camera-scripted-depth-surface') as unknown as HTMLElement
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
    const reviewPosition = new THREE.Vector3(329.9175, 98.9760, 491.8770)
    const reviewTarget = new THREE.Vector3(0, 3, 0)
    const reviewDirection = reviewPosition.clone().sub(reviewTarget).normalize()
    rig.focusOn({
      target: reviewTarget.toArray(),
      distance: 600,
      dir: reviewDirection.toArray(),
    }, { instant: true })
    expect(camera.position.distanceTo(reviewPosition)).toBeLessThan(0.001)
    expect(camera.near, 'the HA review shot must retain the overview depth plane').toBe(2)

    rig.focusOn({ target: [0, 3, 0], distance: 24, dir: [0, 0.2, 1] }, { instant: true })
    expect(camera.near, 'a close scenario focus needs first-person clearance').toBe(0.1)

    void rig.flyPath(
      [[0, 3, 20], reviewPosition.toArray()],
      [reviewTarget.toArray(), reviewTarget.toArray()],
      0.2,
    )
    rig.update(1 / 60)
    expect(camera.near, 'the close end of a tour shot needs first-person clearance').toBe(0.1)
    rig.update(0.1)
    rig.update(0.1)
    expect(camera.near, 'the distant end of a tour shot needs overview precision').toBe(2)

    rig.setMode('walk')
    expect(camera.near, 'orbit-to-walk may only reveal more foreground').toBe(0.1)
  } finally {
    rig.dispose()
  }
})
