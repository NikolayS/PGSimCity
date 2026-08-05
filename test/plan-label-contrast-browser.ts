import * as THREE from 'three'

import type { QualityLevel } from '../src/core/types'
import type { ThemeMode } from '../src/core/themes'
import { markedTextPlanes, SMALL_TEXT_CONTRAST_RATIO } from '../src/world/text-plane'

const THEMES = ['day', 'night'] as const
const TIERS: readonly QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']
const STATIONS = [
  { name: 'pedestrian', distance: 24, direction: new THREE.Vector3(0.18, 0.38, 0.91) },
  { name: 'near-orbit', distance: 62, direction: new THREE.Vector3(0.22, 0.78, 0.59) },
] as const

export interface PlanContrastCityHandle {
  readonly bus: { emit(type: 'quality', event: { level: QualityLevel }): void }
  readonly gfx: {
    readonly scene: THREE.Scene
    readonly camera: THREE.PerspectiveCamera
    readonly quality: { readonly level: QualityLevel; readonly pixelRatio: number }
  }
  setThemeMode(mode: ThemeMode, options: { persist: boolean }): void
}

export interface PlanContrastMeasurement {
  readonly district: 'shmem' | 'storage'
  readonly label: string
  readonly surface: string
  readonly theme: typeof THEMES[number]
  readonly tier: QualityLevel
  readonly station: typeof STATIONS[number]['name']
  readonly contrast: number
  readonly pixelHeight: number
}

export interface PlanContrastReport {
  readonly labels: number
  readonly measurements: readonly PlanContrastMeasurement[]
  readonly failures: readonly PlanContrastMeasurement[]
}

function districtOf(object: THREE.Object3D): 'shmem' | 'storage' | null {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current.name === 'shmem' || current.name === 'storage') return current.name
  }
  return null
}

function projectedHeight(
  object: THREE.Object3D,
  center: readonly [number, number, number],
  up: readonly [number, number, number],
  size: number,
  camera: THREE.PerspectiveCamera,
  viewportHeight: number,
  station: typeof STATIONS[number],
): number {
  const worldCenter = new THREE.Vector3().fromArray(center).applyMatrix4(object.matrixWorld)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld)
  const worldUp = new THREE.Vector3().fromArray(up).applyMatrix3(normalMatrix).normalize()
  camera.position.copy(worldCenter).addScaledVector(station.direction, station.distance)
  camera.lookAt(worldCenter)
  camera.updateMatrixWorld(true)
  const a = worldCenter.clone().addScaledVector(worldUp, -size / 2).project(camera)
  const b = worldCenter.clone().addScaledVector(worldUp, size / 2).project(camera)
  return Math.hypot(a.x - b.x, a.y - b.y) * viewportHeight / 2
}

export function measurePlanLabelContrast(
  city: PlanContrastCityHandle,
  viewportHeight = window.innerHeight,
): PlanContrastReport {
  city.gfx.scene.updateMatrixWorld(true)
  const labels: {
    object: THREE.Object3D
    district: 'shmem' | 'storage'
    record: ReturnType<typeof markedTextPlanes>[number]
  }[] = []
  city.gfx.scene.traverse((object) => {
    const district = districtOf(object)
    if (!district) return
    for (const record of markedTextPlanes(object)) {
      if (record.contrast) labels.push({ object, district, record })
    }
  })

  const measurements: PlanContrastMeasurement[] = []
  for (const theme of THEMES) {
    city.setThemeMode(theme, { persist: false })
    for (const tier of TIERS) {
      city.bus.emit('quality', { level: tier })
      for (const station of STATIONS) {
        for (const label of labels) {
          const contrast = label.record.contrast!
          measurements.push({
            district: label.district,
            label: label.record.text,
            surface: contrast.backing[theme],
            theme,
            tier,
            station: station.name,
            contrast: Number(contrast.ratio[theme].toFixed(2)),
            pixelHeight: Number((projectedHeight(
              label.object,
              label.record.center,
              label.record.up,
              contrast.fontSize,
              city.gfx.camera,
              viewportHeight * city.gfx.quality.pixelRatio,
              station,
            )).toFixed(1)),
          })
        }
      }
    }
  }

  return {
    labels: labels.length,
    measurements,
    failures: measurements.filter((measurement) => measurement.contrast < SMALL_TEXT_CONTRAST_RATIO),
  }
}
