import type * as THREE from 'three'

/** Presentation only: uncover the heap without changing memory or model state. */
export function createStorageCutaway(scene: THREE.Scene): { setActive(active: boolean): void; dispose(): void } {
  const layers = ['shmem', 'os.cache', 'storage.durability']
    .map(name => scene.getObjectByName(name)).filter((object): object is THREE.Object3D => !!object)
  const saved = new Map<THREE.Object3D, boolean>()
  function setActive(active: boolean): void {
    if (active) {
      for (const object of layers) {
        if (!saved.has(object)) saved.set(object, object.visible)
        object.visible = false
      }
    } else {
      for (const [object, visible] of saved) object.visible = visible
      saved.clear()
    }
  }
  return { setActive, dispose: () => setActive(false) }
}

export function isWorldObjectVisible(object: THREE.Object3D): boolean {
  for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return false
  return true
}
