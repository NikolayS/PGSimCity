import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createTheme } from '../core/theme'
import type { QualityLevel } from '../core/types'
import type { WalkController } from './walk'
import {
  handOcclusionBounds,
  projectReachTarget,
  createViewmodelHands,
  type ReachProjection,
} from './hands'

describe('first-person hand targeting', () => {
  it('aims toward a visible world control without crossing the teaching-safe centre', () => {
    const camera = new THREE.PerspectiveCamera(52, 1400 / 900, 0.5, 4000)
    camera.position.set(0, 1.7, 0)
    camera.lookAt(0, 1.7, -10)
    camera.updateMatrixWorld(true)
    const reach: ReachProjection = { x: 0, y: 0, visible: false }

    projectReachTarget(camera, -4, 4, -10, reach)

    expect(reach.visible).toBe(true)
    expect(reach.x).toBeLessThanOrEqual(-0.79)
    expect(reach.x).toBeGreaterThanOrEqual(-0.9)
    expect(reach.y).toBeGreaterThanOrEqual(-0.52)
    expect(reach.y).toBeLessThanOrEqual(-0.38)

    projectReachTarget(camera, 4, 20, -10, reach)
    expect(reach.visible).toBe(true)
    expect(reach.x).toBeGreaterThanOrEqual(0.79)
    expect(reach.y).toBeLessThanOrEqual(-0.38)

    projectReachTarget(camera, -4, 2, 10, reach)
    expect(reach.visible).toBe(false)
    expect(reach.x).toBeLessThan(0)
  })

  it.each([
    [390, 844],
    [1400, 900],
  ])('keeps the idle and fullest reach silhouettes peripheral at %ix%i', (width, height) => {
    for (const reaching of [false, true]) {
      const bounds = handOcclusionBounds(width, height, reaching)
      const centreLeft = width * 0.25
      const centreRight = width * 0.75
      const teachingBottom = height * (reaching ? 0.45 : 0.68)

      expect(bounds.left.right).toBeLessThanOrEqual(centreLeft)
      expect(bounds.right.left).toBeGreaterThanOrEqual(centreRight)
      expect(bounds.left.top).toBeGreaterThanOrEqual(teachingBottom)
      expect(bounds.right.top).toBeGreaterThanOrEqual(teachingBottom)
      expect(bounds.left.bottom).toBeLessThanOrEqual(height)
      expect(bounds.right.bottom).toBeLessThanOrEqual(height)
    }
  })
})

describe('first-person hand quality', () => {
  it('shows hands only for nearby controls, actions, and swimming', () => {
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.5, 4000)
    const theme = createTheme()
    const walk = {
      enabled: true,
      gait: 'walk',
      speed: 0,
      distance: 0,
      submerged: false,
    } as WalkController
    const hands = createViewmodelHands({
      scene,
      camera,
      theme,
      walk,
      quality: 'high',
      reducedMotion: true,
    })
    const left = hands.group.getObjectByName('viewmodel-hand:left')!
    const right = hands.group.getObjectByName('viewmodel-hand:right')!
    const details = hands.group.getObjectByName('viewmodel-hands:detail')!

    hands.update(1 / 60)
    expect(hands.group.visible).toBe(false)
    expect(details.visible).toBe(true)

    const idleY = right.position.y
    const idleZ = right.position.z
    hands.setNearby('lever', 4, 2, -10)
    for (let i = 0; i < 30; i++) hands.update(1 / 60)
    expect(hands.group.visible).toBe(true)
    expect(left.visible).toBe(false)
    expect(right.visible).toBe(true)
    expect(right.position.y).toBeGreaterThan(idleY + 0.02)

    hands.perform('lever', 4, 2, -10)
    for (let i = 0; i < 30; i++) hands.update(1 / 60)
    expect(right.position.y).toBeGreaterThan(idleY + 0.05)
    expect(right.position.z).toBeLessThan(idleZ - 0.02)

    hands.clearNearby()
    for (let i = 0; i < 120; i++) hands.update(1 / 60)
    expect(hands.group.visible).toBe(false)

    Object.defineProperty(walk, 'submerged', { value: true, configurable: true })
    Object.defineProperty(walk, 'gait', { value: 'swim', configurable: true })
    hands.update(1 / 60)
    expect(hands.group.visible).toBe(true)
    expect(left.visible).toBe(true)
    expect(right.visible).toBe(true)

    hands.setQuality('reduced' satisfies QualityLevel)
    hands.update(1 / 60)
    expect(hands.group.visible).toBe(false)

    hands.setQuality('low' satisfies QualityLevel)
    hands.update(1 / 60)
    expect(hands.group.visible).toBe(false)

    hands.setQuality('medium' satisfies QualityLevel)
    hands.update(1 / 60)
    expect(hands.group.visible).toBe(true)
    expect(details.visible).toBe(true)

    hands.dispose()
    expect(scene.getObjectByName('viewmodel-hands')).toBeUndefined()
    theme.dispose()
  })
})
