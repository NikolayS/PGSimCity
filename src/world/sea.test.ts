import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { ATMOSPHERE, setThemeMode } from '../core/theme'
import { DAY_PALETTE, NIGHT_PALETTE } from '../core/themes'
import type { QualityLevel } from '../core/types'
import { perceptualColorDistance } from '../engine/color-grade'
import { CITY } from './layout'
import {
  SEA_DEEP,
  SEA_LEVEL,
  SEA_RADIUS,
  SEA_SHELF,
  SEA_UNDERCUT,
  SURF,
  createSea,
  seaWaveDetail,
  surfLinePosition,
} from './sea'

const LEVELS: readonly QualityLevel[] = ['low', 'reduced', 'medium', 'high', 'ultra']

function edgeField() {
  const texture = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType)
  return { texture, map: new THREE.Vector4(-500, -500, 1 / 1000, 1 / 1000), max: 96 }
}

describe('the sea around the island', () => {
  afterEach(() => {
    setThemeMode('night', { persist: false })
  })

  it('lies below the paving and above every excavation floor', () => {
    expect(SEA_LEVEL).toBeLessThan(0)
    expect(SEA_LEVEL).toBeGreaterThan(CITY.storage.y)
  })

  it('outruns the fog in both modes, so its rim is never in frame', () => {
    // The orbit camera can sit this far from the origin (engine/camera.ts MAX_DIST plus its pivot range).
    const furthestEye = 2000
    for (const air of [ATMOSPHERE.day, ATMOSPHERE.night]) {
      expect(SEA_RADIUS - furthestEye).toBeGreaterThan(CITY.fog.far * air.fogFarScale)
    }
  })

  it('is not the colour of a clean page or of the buffer pool water', () => {
    // Open water is setting. Clean-page blue is a fact about a buffer.
    expect(perceptualColorDistance(SEA_DEEP.day, DAY_PALETTE.bufClean)).toBeGreaterThan(0.12)
    expect(perceptualColorDistance(SEA_DEEP.night, NIGHT_PALETTE.bufClean)).toBeGreaterThan(0.12)
    // The pool's own surface, deep and shallow tints (engine/water.ts).
    for (const pool of [0x5aa9e8, 0x1f5f9d, 0x69b9df]) {
      expect(perceptualColorDistance(SEA_DEEP.day, pool)).toBeGreaterThan(0.12)
    }
    for (const hex of [SEA_DEEP.day, SEA_DEEP.night]) {
      const r = (hex >> 16) & 255
      const g = (hex >> 8) & 255
      const b = hex & 255
      const hi = Math.max(r, g, b)
      const lo = Math.min(r, g, b)
      expect((hi - lo) / (hi + lo)).toBeLessThan(0.5)
    }
  })

  it('never spends more waves on a lower tier and gives rescue tiers a flat mirror', () => {
    expect(seaWaveDetail('low')).toBe(0)
    expect(seaWaveDetail('reduced')).toBe(0)
    for (let i = 1; i < LEVELS.length; i++) {
      expect(seaWaveDetail(LEVELS[i])).toBeGreaterThanOrEqual(seaWaveDetail(LEVELS[i - 1]))
    }
  })

  it('is cut away under the island so excavations stay open', () => {
    const sea = createSea(edgeField())
    const material = sea.mesh.material as THREE.ShaderMaterial
    expect(material.fragmentShader).toContain('if ( beyond < 0.001 && inside > SEA_UNDERCUT ) discard;')
    // The edge field covers only the island's own rectangle. Past it the coast
    // is further away by the overshoot, or surf vanishes on the outermost capes.
    expect(material.fragmentShader).toContain('float beyond = length( ( euv - held ) / uEdgeMap.zw );')
    expect(Number(material.defines.SEA_UNDERCUT)).toBe(SEA_UNDERCUT)
    // The kerb overhangs the cut by more than the encoded field can mis-place it.
    expect(SEA_UNDERCUT).toBeGreaterThan(0)
    expect(SEA_UNDERCUT).toBeLessThan(10)
    sea.dispose()
  })

  it('is setting: unpickable, unshadowed and unnamed in the registry', () => {
    const sea = createSea(edgeField())
    const hits: THREE.Intersection[] = []
    sea.mesh.raycast(new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0)), hits)
    expect(hits).toHaveLength(0)
    expect(sea.mesh.userData.pgNoShadow).toBe(true)
    expect(sea.mesh.position.y).toBe(SEA_LEVEL)
    sea.dispose()
  })

  it('keeps a moon path below the night bloom threshold and a sun path brighter', () => {
    const sea = createSea(edgeField())
    const uniforms = (sea.mesh.material as THREE.ShaderMaterial).uniforms
    setThemeMode('night', { persist: false })
    sea.update(0, 'ultra')
    const nightPeak = uniforms.uGlint.value * (1 + uniforms.uSheen.value)
    // Glow is reserved for meaning; uSunColor channels never exceed one.
    expect(nightPeak).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    expect(uniforms.uWaves.value).toBe(2)
    setThemeMode('day', { persist: false })
    sea.update(0, 'low')
    expect(uniforms.uGlint.value).toBeGreaterThan(nightPeak)
    expect(uniforms.uWaves.value).toBe(0)
    sea.dispose()
  })

  it('runs its surf lines toward the wall, never out to sea', () => {
    let previous: number = SURF.reach
    for (let seconds = 1; seconds <= 10; seconds++) {
      const position = surfLinePosition(SURF.reach, seconds)
      expect(position).toBeLessThan(previous)
      previous = position
    }
    expect(surfLinePosition(SURF.reach, SURF.reach / SURF.speed)).toBeCloseTo(0, 10)
    // The shader's phase rises with time and with distance out, which is the
    // same statement: a fixed phase sits closer to the wall each second.
    const sea = createSea(edgeField())
    const material = sea.mesh.material as THREE.ShaderMaterial
    expect(material.fragmentShader).toContain(
      'float phase = shore / SURF_LENGTH + uTime * ( SURF_SPEED / SURF_LENGTH ) + ragged;',
    )
    expect(Number(material.defines.SURF_SPEED)).toBe(SURF.speed)
    expect(Number(material.defines.SURF_LENGTH)).toBe(SURF.wavelength)
    sea.dispose()
  })

  it('breaks at a walking pace over a shelf a few lines wide', () => {
    // Faster reads as a conveyor, slower as paint; fewer lines is no surf zone.
    expect(SURF.speed).toBeGreaterThan(1)
    expect(SURF.speed).toBeLessThan(5)
    expect(SURF.reach / SURF.wavelength).toBeGreaterThanOrEqual(3)
    expect(SURF.reach).toBeLessThan(96)
  })

  it('holds its surf still under reduced motion and keeps foam under the bloom threshold', () => {
    const sea = createSea(edgeField())
    const uniforms = (sea.mesh.material as THREE.ShaderMaterial).uniforms
    setThemeMode('night', { persist: false })
    sea.update(1, 'ultra')
    // Foam is lit, never luminous: wherever bloom runs it cannot cross into it.
    expect(uniforms.uFoamCap.value).toBeLessThan(ATMOSPHERE.night.bloomThreshold)
    setThemeMode('day', { persist: false })
    sea.update(1, 'ultra')
    expect(uniforms.uFoamCap.value).toBeGreaterThan(ATMOSPHERE.night.bloomThreshold)
    sea.dispose()
  })

  it('keeps shelf water away from clean-page blue and from the pool', () => {
    for (const pool of [DAY_PALETTE.bufClean, 0x5aa9e8, 0x1f5f9d, 0x69b9df]) {
      expect(perceptualColorDistance(SEA_SHELF.day, pool)).toBeGreaterThan(0.12)
    }
  })

  it('mirrors the cloud deck only on the tiers that draw it', () => {
    const sea = createSea(edgeField())
    const uniforms = (sea.mesh.material as THREE.ShaderMaterial).uniforms
    setThemeMode('day', { persist: false })
    for (const level of LEVELS) {
      sea.update(0, level)
      expect(uniforms.uCloud.value > 0, level).toBe(level === 'high' || level === 'ultra')
    }
    sea.dispose()
  })
})

