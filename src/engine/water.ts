import * as THREE from 'three'
import { damp } from '../core/util'
import { CITY } from '../world/layout'

export interface BufferWaterApi {
  group: THREE.Group
  /** Advances the fixed ripple pool and the underwater atmosphere. */
  update(dt: number, submerged: boolean): void
  /** Surface-space one-shot. Uses a preallocated ripple slot. */
  splash(x: number, z: number, intensity: number): void
  dispose(): void
}

const SPAN = (CITY.buf.grid - 1) * CITY.buf.pitch + CITY.buf.tile
const SURFACE_Y = CITY.buf.baseY + CITY.buf.maxRise + 0.4
const DEPTH = SURFACE_Y - CITY.deck.top
const RIPPLE_COUNT = 6
const RIPPLE_SECONDS = 1.15
const WATER_COLOR = 0x5aa9e8
const UNDERWATER_FOG = 0x163a66
const UNDERWATER_NEAR = 3
const UNDERWATER_FAR = 55
const FOG_SETTLE = 8

interface Ripple {
  mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  age: number
  strength: number
}

/**
 * The buffer columns remain data and remain non-solid. This is a separate,
 * purely visual volume spanning the already-defined swim region above the
 * plaza deck.
 */
export function createBufferWater(scene: THREE.Scene): BufferWaterApi {
  const group = new THREE.Group()
  group.name = 'buffer.water'

  const surfaceGeometry = new THREE.PlaneGeometry(SPAN, SPAN)
  const surfaceMaterial = new THREE.MeshBasicMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const surface = new THREE.Mesh(surfaceGeometry, surfaceMaterial)
  surface.name = 'buffer.water.surface'
  surface.rotation.x = -Math.PI / 2
  surface.position.y = SURFACE_Y
  surface.renderOrder = 3
  surface.raycast = () => {}
  group.add(surface)

  // A faint inside face gives the volume a boundary at grazing angles without
  // changing collision or hiding the live-height buffer columns.
  const volumeGeometry = new THREE.BoxGeometry(SPAN, DEPTH, SPAN)
  const volumeMaterial = new THREE.MeshBasicMaterial({
    color: 0x356fd0,
    transparent: true,
    opacity: 0.025,
    depthWrite: false,
    side: THREE.BackSide,
  })
  const volume = new THREE.Mesh(volumeGeometry, volumeMaterial)
  volume.name = 'buffer.water.volume'
  volume.position.y = CITY.deck.top + DEPTH * 0.5
  volume.renderOrder = 2
  volume.raycast = () => {}
  group.add(volume)

  const grid = new THREE.GridHelper(SPAN, 16, 0x8fd6ff, 0x477ed0)
  grid.name = 'buffer.water.surface-grid'
  grid.position.y = SURFACE_Y + 0.025
  const gridMaterial = grid.material as THREE.LineBasicMaterial
  gridMaterial.transparent = true
  gridMaterial.opacity = 0.16
  gridMaterial.depthWrite = false
  grid.raycast = () => {}
  group.add(grid)

  const rippleGeometry = new THREE.RingGeometry(0.78, 1, 32)
  const ripples: Ripple[] = []
  for (let i = 0; i < RIPPLE_COUNT; i++) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xb9e7ff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(rippleGeometry, material)
    mesh.name = 'buffer.water.ripple'
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = SURFACE_Y + 0.055 + i * 0.002
    mesh.visible = false
    mesh.renderOrder = 4
    mesh.raycast = () => {}
    group.add(mesh)
    ripples.push({ mesh, age: RIPPLE_SECONDS, strength: 0 })
  }
  let rippleCursor = 0

  const fog = scene.fog instanceof THREE.Fog ? scene.fog : null
  let airFog = fog?.color.getHex() ?? 0
  let airNear = fog?.near ?? 0
  let airFar = fog?.far ?? 0
  let fogAmount = 0
  let wasSubmerged = false

  function splash(x: number, z: number, intensity: number): void {
    const strength = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity
    if (strength <= 0) return
    const ripple = ripples[rippleCursor]
    rippleCursor = (rippleCursor + 1) % ripples.length
    ripple.age = 0
    ripple.strength = strength
    ripple.mesh.position.x = x
    ripple.mesh.position.z = z
    ripple.mesh.scale.setScalar(0.65 + strength * 0.35)
    ripple.mesh.material.opacity = 0.42 + strength * 0.3
    ripple.mesh.visible = true
  }

  function update(dt: number, submerged: boolean): void {
    const d = dt > 0 ? dt : 0
    for (let i = 0; i < ripples.length; i++) {
      const ripple = ripples[i]
      if (!ripple.mesh.visible) continue
      ripple.age += d
      if (ripple.age >= RIPPLE_SECONDS) {
        ripple.mesh.visible = false
        ripple.mesh.material.opacity = 0
        continue
      }
      const t = ripple.age / RIPPLE_SECONDS
      const scale = 0.65 + ripple.strength * 0.35 + t * (5.5 + ripple.strength * 3)
      ripple.mesh.scale.setScalar(scale)
      ripple.mesh.material.opacity = (1 - t) * (0.34 + ripple.strength * 0.34)
    }

    if (!fog) return
    if (submerged && !wasSubmerged) {
      airFog = fog.color.getHex()
      airNear = fog.near
      airFar = fog.far
    } else if (!submerged && fogAmount < 0.001) {
      // Theme changes are free to repaint the atmosphere while the swimmer is
      // in air; capture that current state instead of restoring an old palette.
      airFog = fog.color.getHex()
      airNear = fog.near
      airFar = fog.far
    }
    wasSubmerged = submerged
    fogAmount = damp(fogAmount, submerged ? 1 : 0, FOG_SETTLE, d)
    if (!submerged && fogAmount < 0.001) fogAmount = 0

    const ar = ((airFog >> 16) & 255) / 255
    const ag = ((airFog >> 8) & 255) / 255
    const ab = (airFog & 255) / 255
    const wr = ((UNDERWATER_FOG >> 16) & 255) / 255
    const wg = ((UNDERWATER_FOG >> 8) & 255) / 255
    const wb = (UNDERWATER_FOG & 255) / 255
    fog.color.setRGB(
      ar + (wr - ar) * fogAmount,
      ag + (wg - ag) * fogAmount,
      ab + (wb - ab) * fogAmount,
      THREE.SRGBColorSpace,
    )
    fog.near = airNear + (UNDERWATER_NEAR - airNear) * fogAmount
    fog.far = airFar + (UNDERWATER_FAR - airFar) * fogAmount
    surfaceMaterial.opacity = 0.18 + fogAmount * 0.13
    volumeMaterial.opacity = 0.025 + fogAmount * 0.055
  }

  function dispose(): void {
    if (fog) {
      fog.color.setHex(airFog)
      fog.near = airNear
      fog.far = airFar
    }
    group.removeFromParent()
    surfaceGeometry.dispose()
    surfaceMaterial.dispose()
    volumeGeometry.dispose()
    volumeMaterial.dispose()
    grid.geometry.dispose()
    gridMaterial.dispose()
    rippleGeometry.dispose()
    for (let i = 0; i < ripples.length; i++) ripples[i].mesh.material.dispose()
    ripples.length = 0
  }

  return { group, update, splash, dispose }
}
