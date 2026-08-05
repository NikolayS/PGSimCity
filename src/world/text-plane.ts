import * as THREE from 'three'

/** Construction-time geometry needed to audit which side of rendered text is legible. */
export interface TextPlaneRecord {
  readonly text: string
  readonly center: readonly [number, number, number]
  readonly normal: readonly [number, number, number]
  readonly up: readonly [number, number, number]
  readonly fixed: boolean
}

const TEXT_PLANES = 'pgTextPlanes'
const _layerNormal = new THREE.Vector3()

/** City-plan floor lettering is an orbit aid, not first-person signage. */
export const MAP_TEXT_LAYER = 2

/** Mark one independently oriented text quad on an object, including an atlas mesh. */
export function markTextPlane(
  object: THREE.Object3D,
  text: string,
  center: readonly [number, number, number] = [0, 0, 0],
  normal: readonly [number, number, number] = [0, 0, 1],
  up: readonly [number, number, number] = [0, 1, 0],
  fixed = true,
): void {
  const data = object.userData as { [TEXT_PLANES]?: TextPlaneRecord[] }
  const records = data[TEXT_PLANES] ?? (data[TEXT_PLANES] = [])
  records.push({ text, center, normal, up, fixed })
  const mapOnly = records.every((record) => {
    _layerNormal.fromArray(record.normal).applyQuaternion(object.quaternion)
    return record.fixed && Math.abs(_layerNormal.y) > 0.8
  })
  object.layers.set(mapOnly ? MAP_TEXT_LAYER : 0)
}

export function markedTextPlanes(object: THREE.Object3D): readonly TextPlaneRecord[] {
  const data = object.userData as { [TEXT_PLANES]?: TextPlaneRecord[] }
  return data[TEXT_PLANES] ?? []
}

/** Let scene audits discover text maps even when the material is not a plate helper. */
export function markTextTexture(texture: THREE.Texture, text: string): void {
  const data = texture.userData as { pgText?: string[] }
  const strings = data.pgText ?? (data.pgText = [])
  if (!strings.includes(text)) strings.push(text)
}
