import * as THREE from 'three'
import { expect, it } from 'vitest'
import { createStorageCutaway, isWorldObjectVisible } from './storage-cutaway'

it('removes covering presentation layers, retaining storage and restoring prior visibility', () => {
  const scene = new THREE.Scene()
  const groups = ['shmem', 'os.cache', 'storage.durability', 'storage.heaps', 'maintenance'].map(name => {
    const group = new THREE.Group(); group.name = name; scene.add(group); return group
  })
  groups[1].visible = false
  const cutaway = createStorageCutaway(scene)
  cutaway.setActive(true)
  expect(groups.map(group => group.visible)).toEqual([false, false, false, true, true])
  cutaway.setActive(true)
  cutaway.setActive(false)
  expect(groups.map(group => group.visible)).toEqual([true, false, true, true, true])
  cutaway.setActive(true)
  cutaway.dispose()
  expect(groups.map(group => group.visible)).toEqual([true, false, true, true, true])
})

it('hides descendant labels while an ancestor presentation layer is hidden', () => {
  const parent = new THREE.Group()
  const object = new THREE.Group()
  parent.add(object)
  expect(isWorldObjectVisible(object)).toBe(true)
  parent.visible = false
  expect(isWorldObjectVisible(object)).toBe(false)
  parent.visible = true
  object.visible = false
  expect(isWorldObjectVisible(object)).toBe(false)
})
