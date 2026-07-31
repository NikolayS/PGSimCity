import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  LIGHT_SHAFT_PRESETS,
  LightShaftPass,
  lightShaftContrast,
  lightShaftPathWeight,
  lightShaftSource,
  screenSpaceSunVisibility,
} from './light-shafts'

describe('screen-space light shafts', () => {
  it('removes the pass entirely from low and reduced quality', () => {
    for (const level of ['low', 'reduced'] as const) {
      expect(LIGHT_SHAFT_PRESETS[level]).toEqual({
        scale: 0,
        samples: 0,
        strength: 0,
      })
    }
  })

  it('spends progressively more resolution and samples on upper tiers', () => {
    const medium = LIGHT_SHAFT_PRESETS.medium
    const high = LIGHT_SHAFT_PRESETS.high
    const ultra = LIGHT_SHAFT_PRESETS.ultra

    expect(medium.scale).toBeGreaterThan(0)
    expect(medium.samples).toBeGreaterThan(0)
    expect(high.scale).toBeGreaterThan(medium.scale)
    expect(high.samples).toBeGreaterThan(medium.samples)
    expect(ultra.scale).toBeGreaterThanOrEqual(high.scale)
    expect(ultra.samples).toBeGreaterThan(high.samples)
    expect(ultra.strength).toBeLessThanOrEqual(0.02)
  })

  it('admits light only where the depth buffer says the sun source is unoccluded', () => {
    expect(lightShaftSource(1, 0)).toBe(1)
    expect(lightShaftSource(0.999, 0)).toBe(0)
    expect(lightShaftSource(0.4, 0)).toBe(0)
    expect(lightShaftSource(1, 1)).toBe(0)
  })

  it('produces shaft contrast only from partial real occlusion', () => {
    expect(lightShaftContrast(1, 1)).toBe(0)
    expect(lightShaftContrast(0, 1)).toBe(0)
    expect(lightShaftContrast(0.5, 1)).toBe(1)
    expect(lightShaftContrast(0, 0)).toBe(0)
  })

  it('suppresses the overlay on nearby structure and lets long air paths carry it', () => {
    const near = lightShaftPathWeight(0.5, 0.5, 4000)
    const street = lightShaftPathWeight(0.96, 0.5, 4000)
    const sky = lightShaftPathWeight(1, 0.5, 4000)

    expect(near).toBe(0)
    expect(street).toBeGreaterThan(near)
    expect(street).toBeLessThan(sky)
    expect(sky).toBe(1)
  })

  it('fades at the viewport boundary and vanishes off-screen or behind the eye', () => {
    expect(screenSpaceSunVisibility(0.5, 0.5, 1)).toBe(1)
    expect(screenSpaceSunVisibility(0.03, 0.5, 1)).toBeGreaterThan(0)
    expect(screenSpaceSunVisibility(0.03, 0.5, 1)).toBeLessThan(1)
    expect(screenSpaceSunVisibility(0, 0.5, 1)).toBe(0)
    expect(screenSpaceSunVisibility(-0.01, 0.5, 1)).toBe(0)
    expect(screenSpaceSunVisibility(0.5, 1.01, 1)).toBe(0)
    expect(screenSpaceSunVisibility(0.5, 0.5, 0)).toBe(0)
  })

  it('preserves the beauty buffer by disabling auto-clear only for the in-place composite', () => {
    const camera = new THREE.PerspectiveCamera(52, 1, 0.5, 4000)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    const depth = new THREE.DepthTexture(1, 1)
    const pass = new LightShaftPass(camera, { sceneDepthTexture: depth })
    pass.setSunDirection(0, 0, -1)
    pass.setQuality('high', true)

    const autoClearStates: boolean[] = []
    const rendererState = {
      autoClear: true,
      setRenderTarget: () => undefined,
      render() {
        autoClearStates.push(rendererState.autoClear)
      },
    }
    const renderer = rendererState as unknown as THREE.WebGLRenderer
    const readBuffer = new THREE.WebGLRenderTarget(1, 1)
    const writeBuffer = new THREE.WebGLRenderTarget(1, 1)

    pass.render(renderer, writeBuffer, readBuffer)

    expect(autoClearStates).toEqual([true, true, false])
    expect(renderer.autoClear).toBe(true)
    pass.dispose()
    depth.dispose()
    readBuffer.dispose()
    writeBuffer.dispose()
  })
})
