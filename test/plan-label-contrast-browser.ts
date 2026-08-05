import * as THREE from 'three'

import type { QualityLevel } from '../src/core/types'
import type { ThemeMode } from '../src/core/themes'
import {
  markedPlanLabelSemanticCarriers,
  type MarkedPlanLabelSemanticCarrier,
} from '../src/world/plan-label'
import { markedTextPlanes } from '../src/world/text-plane'

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

export interface PlanSemanticMeasurement {
  readonly district: 'shmem' | 'storage'
  readonly label: string
  readonly surface: string
  readonly theme: typeof THEMES[number]
  readonly tier: QualityLevel
  readonly station: typeof STATIONS[number]['name']
  readonly semanticLuminance: number
  readonly semanticContrast: number
  readonly semanticPixelWidth: number
  readonly semanticPixelHeight: number
  readonly semanticSized: boolean
  readonly semanticProtected: boolean
  readonly semanticBlooms: boolean
}

export interface PlanContrastReport {
  readonly labels: number
  readonly semanticCarriers: number
  readonly measurements: readonly PlanContrastMeasurement[]
  readonly semanticMeasurements: readonly PlanSemanticMeasurement[]
}

interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

function parseCssColor(css: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) {
    const value = Number.parseInt(hex[1], 16)
    return {
      r: (value >> 16) / 255,
      g: ((value >> 8) & 0xff) / 255,
      b: (value & 0xff) / 255,
      a: 1,
    }
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(css.trim())
  if (!rgba) throw new Error(`Unsupported semantic-carrier colour: ${css}`)
  return {
    r: Number(rgba[1]) / 255,
    g: Number(rgba[2]) / 255,
    b: Number(rgba[3]) / 255,
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  }
}

function linear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function linearColor(color: Rgba): THREE.Color {
  return new THREE.Color(linear(color.r), linear(color.g), linear(color.b))
}

function rasterCarrierColor(carrier: MarkedPlanLabelSemanticCarrier): THREE.Color {
  const foreground = parseCssColor(carrier.authoredColor)
  const backing = parseCssColor(carrier.backingColor)
  return linearColor({
    r: foreground.r * foreground.a + backing.r * (1 - foreground.a),
    g: foreground.g * foreground.a + backing.g * (1 - foreground.a),
    b: foreground.b * foreground.a + backing.b * (1 - foreground.a),
    a: 1,
  })
}

function luminance(color: THREE.Color): number {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

function contrastRatio(a: THREE.Color, b: THREE.Color): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
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

function projectedSpan(
  object: THREE.Object3D,
  center: readonly [number, number, number],
  direction: readonly [number, number, number],
  length: number,
  camera: THREE.PerspectiveCamera,
  viewportHeight: number,
): number {
  const localCenter = new THREE.Vector3().fromArray(center)
  const localDirection = new THREE.Vector3().fromArray(direction).normalize()
  const a = localCenter.clone().addScaledVector(localDirection, -length / 2)
    .applyMatrix4(object.matrixWorld).project(camera)
  const b = localCenter.clone().addScaledVector(localDirection, length / 2)
    .applyMatrix4(object.matrixWorld).project(camera)
  return Math.hypot(a.x - b.x, a.y - b.y) * viewportHeight / 2
}

function stageCamera(
  object: THREE.Object3D,
  center: readonly [number, number, number],
  camera: THREE.PerspectiveCamera,
  station: typeof STATIONS[number],
): void {
  const worldCenter = new THREE.Vector3().fromArray(center).applyMatrix4(object.matrixWorld)
  camera.position.copy(worldCenter).addScaledVector(station.direction, station.distance)
  camera.lookAt(worldCenter)
  camera.updateMatrixWorld(true)
}

function carrierHasAuthoredSize(carrier: MarkedPlanLabelSemanticCarrier): boolean {
  const mesh = carrier.mesh
  if (!mesh) return false
  const geometry = mesh.geometry
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const size = geometry.boundingBox!.getSize(new THREE.Vector3())
  const dimensions = [
    size.x * Math.abs(mesh.scale.x),
    size.y * Math.abs(mesh.scale.y),
    size.z * Math.abs(mesh.scale.z),
  ].filter((value) => value > 1e-6).sort((a, b) => a - b)
  const expected = [carrier.width, carrier.height].sort((a, b) => a - b)
  return dimensions.length === 2
    && Math.abs(dimensions[0] - expected[0]) < 1e-6
    && Math.abs(dimensions[1] - expected[1]) < 1e-6
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
  const carriers = new Map<string, {
    object: THREE.Object3D
    district: 'shmem' | 'storage'
    record: MarkedPlanLabelSemanticCarrier
  }[]>()
  city.gfx.scene.traverse((object) => {
    const district = districtOf(object)
    if (!district) return
    for (const record of markedTextPlanes(object)) {
      if (record.contrast) labels.push({ object, district, record })
    }
    for (const record of markedPlanLabelSemanticCarriers(object)) {
      const key = `${district}|${record.text}`
      const matches = carriers.get(key) ?? []
      matches.push({ object, district, record })
      carriers.set(key, matches)
    }
  })

  const measurements: PlanContrastMeasurement[] = []
  const semanticMeasurements: PlanSemanticMeasurement[] = []
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
            contrast: contrast.ratio[theme],
            pixelHeight: projectedHeight(
              label.object,
              label.record.center,
              label.record.up,
              contrast.fontSize,
              city.gfx.camera,
              viewportHeight * city.gfx.quality.pixelRatio,
              station,
            ),
          })
        }
        for (const matches of carriers.values()) {
          for (const carrierMatch of matches) {
            const carrier = carrierMatch.record
            const material = carrier.material
            const semanticColor = material?.color ?? rasterCarrierColor(carrier)
            const backingColor = linearColor(parseCssColor(carrier.backingColor))
            const semanticProtected = material?.userData.pgTheme === true
              && material.isMeshBasicMaterial
              && material.toneMapped === false
              && carrier.mesh?.material === material
              && carrier.mesh.visible
              && carrier.mesh.parent === carrierMatch.object
            stageCamera(carrierMatch.object, carrier.center, city.gfx.camera, station)
            semanticMeasurements.push({
              district: carrierMatch.district,
              label: carrier.text,
              surface: carrier.backingName,
              theme,
              tier,
              station: station.name,
              semanticLuminance: luminance(semanticColor),
              semanticContrast: contrastRatio(semanticColor, backingColor),
              semanticPixelWidth: projectedSpan(
                carrierMatch.object,
                carrier.center,
                carrier.across,
                carrier.width,
                city.gfx.camera,
                viewportHeight * city.gfx.quality.pixelRatio,
              ),
              semanticPixelHeight: projectedSpan(
                carrierMatch.object,
                carrier.center,
                carrier.up,
                carrier.height,
                city.gfx.camera,
                viewportHeight * city.gfx.quality.pixelRatio,
              ),
              semanticSized: carrierHasAuthoredSize(carrier),
              semanticProtected,
              semanticBlooms: Math.max(semanticColor.r, semanticColor.g, semanticColor.b) > 1,
            })
          }
        }
      }
    }
  }

  return {
    labels: labels.length,
    semanticCarriers: [...carriers.values()].reduce((count, records) => count + records.length, 0),
    measurements,
    semanticMeasurements,
  }
}
