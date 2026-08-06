import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import type { SimState } from '../core/types'
import { createSim } from '../sim/model'
import { bufferPoolSurfaceY, CITY } from '../world/layout'
import type { AudioApi } from './audio'
import { createCollisionWorld } from './collision'
import { createBufferWater, waterReflectionScale } from './water'
import { createWalkController } from './walk'

const POOL_HALF = CITY.buf.halfSpan
const POOL_BOTTOM = CITY.buf.baseY

function fullPoolSurface(): number {
  return CITY.buf.fullSurfaceY
}

function fakeAudio(): AudioApi {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(),
    preferred: false,
    enabled: true,
    volume: 0.35,
    step: vi.fn(),
    land: vi.fn(),
    jump: vi.fn(),
    splash: vi.fn<(intensity: number) => void>(),
    dispose: vi.fn(),
  }
}

interface WalkHarness {
  audio: AudioApi
  collision: ReturnType<typeof createCollisionWorld>
  deck: THREE.Group
  sim: SimState
  visualSplash: ReturnType<typeof vi.fn>
  walk: ReturnType<typeof createWalkController>
  dispose(): void
}

function createWalkHarness(
  tuning?: Parameters<typeof createWalkController>[0]['tuning'],
  occupancy = 1,
): WalkHarness {
  const bus = createBus()
  const audio = fakeAudio()
  const visualSplash = vi.fn()
  const collision = createCollisionWorld()
  const deck = new THREE.Group()
  const deckMaterial = new THREE.MeshBasicMaterial()
  const addDeckPlane = (width: number, depth: number, x: number, z: number): void => {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), deckMaterial)
    plane.rotation.x = -Math.PI / 2
    plane.position.set(x, CITY.deck.top, z)
    deck.add(plane)
  }
  const sideWidth = CITY.deck.w / 2 - POOL_HALF
  const endDepth = CITY.deck.d / 2 - POOL_HALF
  addDeckPlane(CITY.deck.w, endDepth, 0, -POOL_HALF - endDepth / 2)
  addDeckPlane(CITY.deck.w, endDepth, 0, POOL_HALF + endDepth / 2)
  addDeckPlane(sideWidth, POOL_HALF * 2, -POOL_HALF - sideWidth / 2, 0)
  addDeckPlane(sideWidth, POOL_HALF * 2, POOL_HALF + sideWidth / 2, 0)
  deck.updateMatrixWorld(true)
  collision.addWalkable(deck, 'deck')

  const camera = new THREE.PerspectiveCamera()
  camera.position.set(0, 30, 40)
  const dom = new EventTarget() as HTMLElement
  const sim = createSim(bus).state as SimState
  sim.buffers.usedCount = Math.round(sim.buffers.sampleFrames * occupancy) as typeof sim.buffers.usedCount
  const walk = createWalkController({
    camera,
    dom,
    collision,
    audio,
    sim,
    bus,
    water: { splash: visualSplash },
    tuning,
  })
  void walk.enter(new THREE.Vector3(0, CITY.deck.top + 3.2, 48))
  for (let i = 0; i < 4; i++) walk.update(0.1)

  return {
    audio,
    collision,
    deck,
    sim,
    visualSplash,
    walk,
    dispose(): void {
      walk.dispose()
      collision.dispose()
      deck.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      deckMaterial.dispose()
    },
  }
}

describe('buffer-pool swimming', () => {
  it('budgets one rippled planar reflection only on medium and higher tiers', () => {
    expect(waterReflectionScale('low')).toBe(0)
    expect(waterReflectionScale('reduced')).toBe(0)
    expect(waterReflectionScale('medium')).toBe(0.25)
    expect(waterReflectionScale('high')).toBe(0.5)
    expect(waterReflectionScale('ultra')).toBe(0.5)
  })

  it('enters the pool by walking without needing a jump or crouch', () => {
    const harness = createWalkHarness()
    const { audio, walk } = harness
    walk.position.set(0, CITY.deck.top, POOL_HALF + 0.12)
    walk.update(0.02)
    expect(walk.grounded).toBe(true)
    expect(walk.surface).toBe('deck')

    walk.setTouchMove(0, 1)
    for (let i = 0; i < 50 && !walk.submerged; i++) walk.update(0.02)

    expect(walk.position.z).toBeLessThan(POOL_HALF)
    expect(walk.grounded).toBe(false)
    expect(walk.gait).toBe('swim')
    expect(walk.submerged).toBe(true)
    expect(walk.surface).toBe('water')
    expect(audio.splash).toHaveBeenCalledTimes(1)
    harness.dispose()
  })

  it('submerges a walker standing on the pool bottom without input', () => {
    const harness = createWalkHarness()
    const { audio, walk } = harness
    walk.position.set(0, POOL_BOTTOM, 0)

    walk.update(0.02)

    expect(walk.gait).toBe('swim')
    expect(walk.submerged).toBe(true)
    expect(walk.grounded).toBe(false)
    expect(walk.surface).toBe('water')
    expect(audio.step).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({
        gait: 'swim',
        grounded: false,
        submerged: true,
        surface: 'water',
      }),
    )
    harness.dispose()
  })

  it('keeps the empty basin floor solid until rising water reaches the walker', () => {
    const harness = createWalkHarness(undefined, 0)
    const { sim, walk } = harness
    walk.position.set(0, POOL_BOTTOM, 0)

    for (let i = 0; i < 20; i++) walk.update(0.02)

    expect(walk.position.y).toBeCloseTo(POOL_BOTTOM, 5)
    expect(walk.grounded).toBe(true)
    expect(walk.gait).toBe('walk')
    expect(walk.surface).not.toBe('water')

    sim.buffers.usedCount = sim.buffers.sampleFrames
    walk.update(0.02)

    expect(walk.position.y).toBeGreaterThanOrEqual(POOL_BOTTOM)
    expect(walk.grounded).toBe(false)
    expect(walk.gait).toBe('swim')
    expect(walk.submerged).toBe(true)
    expect(walk.surface).toBe('water')
    harness.dispose()
  })

  it('lands on the basin floor when the water drains completely under a swimmer', () => {
    const harness = createWalkHarness()
    const { sim, walk } = harness
    walk.position.set(0, POOL_BOTTOM + 1, 0)
    walk.update(0.02)
    expect(walk.gait).toBe('swim')

    sim.buffers.usedCount = 0 as typeof sim.buffers.usedCount
    let minFeetY = walk.position.y
    for (let i = 0; i < 120; i++) {
      walk.update(0.02)
      minFeetY = Math.min(minFeetY, walk.position.y)
    }

    expect(minFeetY).toBeGreaterThanOrEqual(POOL_BOTTOM)
    expect(walk.position.y).toBeCloseTo(POOL_BOTTOM, 5)
    expect(walk.grounded).toBe(true)
    expect(walk.gait).toBe('walk')
    expect(walk.surface).not.toBe('water')
    harness.dispose()
  })

  it.each([0.4, 1])(
    'keeps bottom-standing and falling entries coherent at %s sample occupancy',
    (occupancy) => {
      const bottomHarness = createWalkHarness(undefined, occupancy)
      const surfaceY = bufferPoolSurfaceY(bottomHarness.sim.buffers)
      bottomHarness.walk.position.set(0, POOL_BOTTOM, 0)
      bottomHarness.walk.update(0.02)

      expect(surfaceY).toBeGreaterThan(POOL_BOTTOM + 1.7)
      expect(bottomHarness.walk.gait).toBe('swim')
      expect(bottomHarness.walk.submerged).toBe(true)
      expect(bottomHarness.walk.grounded).toBe(false)
      expect(bottomHarness.walk.surface).toBe('water')
      bottomHarness.dispose()

      const fallingHarness = createWalkHarness({ gravity: 10 }, occupancy)
      fallingHarness.walk.position.set(0, surfaceY + 0.3, 0)
      for (let frame = 0; frame < 100 && fallingHarness.walk.surface !== 'water'; frame++) {
        fallingHarness.walk.update(0.02)
      }

      expect(fallingHarness.walk.gait).toBe('swim')
      expect(fallingHarness.walk.grounded).toBe(false)
      expect(fallingHarness.walk.surface).toBe('water')
      fallingHarness.dispose()
    },
  )

  it('swims in the water column without treating the deck as ground', () => {
    const harness = createWalkHarness()
    const { walk } = harness
    walk.position.set(0, POOL_BOTTOM + 1, 0)
    walk.update(0.02)

    expect(walk.gait).toBe('swim')
    expect(walk.grounded).toBe(false)
    expect(walk.surface).toBe('water')
    expect(walk.verticalSpeed).toBeGreaterThan(0)
    harness.dispose()
  })

  it('remains submerged on the pool bottom without an exit splash', () => {
    const harness = createWalkHarness()
    const splash = vi.mocked(harness.audio.splash)
    harness.walk.position.set(0, POOL_BOTTOM + 1, 0)
    harness.walk.setTouchCrouch(true)
    harness.walk.update(0.02)

    for (let i = 0; i < 500; i++) harness.walk.update(0.02)
    harness.walk.setTouchCrouch(false)

    expect(harness.walk.position.y).toBeCloseTo(POOL_BOTTOM, 4)
    expect(harness.walk.grounded).toBe(false)
    expect(harness.walk.gait).toBe('swim')
    expect(harness.walk.submerged).toBe(true)
    expect(harness.walk.surface).toBe('water')
    expect(harness.walk.verticalSpeed).toBe(0)
    expect(splash).toHaveBeenCalledTimes(1)
    harness.dispose()
  })

  it('keeps downward entry at the surface instead of teleporting to float depth', () => {
    const harness = createWalkHarness({ gravity: 10 })
    const splash = vi.mocked(harness.audio.splash)
    harness.walk.position.set(0, fullPoolSurface() + 0.2, 0)

    for (let i = 0; i < 80 && splash.mock.calls.length === 0; i++) {
      harness.walk.update(0.02)
    }

    expect(splash).toHaveBeenCalledTimes(1)
    expect(harness.walk.position.y).toBeGreaterThan(fullPoolSurface() - 0.5)
    expect(harness.walk.verticalSpeed).toBeLessThan(0)
    expect(harness.walk.gait).toBe('swim')
    expect(harness.walk.grounded).toBe(false)
    expect(harness.walk.surface).toBe('water')
    harness.dispose()
  })

  it('fires exactly one entry splash with intensity proportional to impact speed', () => {
    function drop(height: number): number {
      const harness = createWalkHarness({ gravity: 10 })
      const splash = vi.mocked(harness.audio.splash)
      harness.walk.position.set(0, fullPoolSurface() + height, 0)
      for (let i = 0; i < 80 && splash.mock.calls.length === 0; i++) {
        harness.walk.update(0.02)
      }
      for (let i = 0; i < 8; i++) harness.walk.update(0.02)
      expect(splash).toHaveBeenCalledTimes(1)
      expect(harness.visualSplash).toHaveBeenCalledTimes(1)
      const intensity = splash.mock.calls[0][0]
      harness.dispose()
      return intensity
    }

    const slow = drop(0.2)
    const fast = drop(0.8)
    expect(slow).toBeGreaterThan(0.18)
    expect((fast - 0.18) / (slow - 0.18)).toBeCloseTo(2, 1)
  })

  it('limits horizontal speed in water below the same input in air', () => {
    const waterHarness = createWalkHarness()
    waterHarness.walk.position.set(0, POOL_BOTTOM + 1, 0)
    waterHarness.walk.setTouchMove(0, 1)

    const airHarness = createWalkHarness()
    airHarness.walk.position.set(POOL_HALF + 4, fullPoolSurface() + 2, 0)
    airHarness.walk.setTouchMove(0, 1)

    for (let i = 0; i < 25; i++) {
      waterHarness.walk.update(0.02)
      airHarness.walk.update(0.02)
    }

    expect(waterHarness.walk.speed).toBeLessThan(airHarness.walk.speed)
    expect(waterHarness.walk.speed).toBeLessThan(2)
    waterHarness.dispose()
    airHarness.dispose()
  })

  it('builds water momentum in fixed substeps and coasts instead of stopping like a walker', () => {
    const fine = createWalkHarness()
    const coarse = createWalkHarness()
    fine.walk.position.set(0, POOL_BOTTOM + 1, 0)
    coarse.walk.position.set(0, POOL_BOTTOM + 1, 0)
    fine.walk.setTouchMove(0, 1)
    coarse.walk.setTouchMove(0, 1)

    for (let i = 0; i < 75; i++) fine.walk.update(0.02)
    for (let i = 0; i < 15; i++) coarse.walk.update(0.1)

    expect(coarse.walk.speed).toBeCloseTo(fine.walk.speed, 6)
    expect(coarse.walk.position.z).toBeCloseTo(fine.walk.position.z, 6)
    const cruising = fine.walk.speed
    fine.walk.setTouchMove(0, 0)
    for (let i = 0; i < 15; i++) fine.walk.update(0.02)

    expect(fine.walk.speed).toBeLessThan(cruising)
    expect(fine.walk.speed).toBeGreaterThan(cruising * 0.65)
    fine.dispose()
    coarse.dispose()
  })

  it('floats an idle swimmer to a restrained surface rest and recovers after a touch dive', () => {
    const harness = createWalkHarness()
    const splash = vi.mocked(harness.audio.splash)
    const startY = POOL_BOTTOM + 1
    harness.walk.position.set(0, startY, 0)

    for (let i = 0; i < 250; i++) harness.walk.update(0.02)

    const restY = harness.walk.position.y
    expect(restY).toBeGreaterThan(startY + 2)
    expect(restY).toBeLessThanOrEqual(fullPoolSurface() - 1.4)
    expect(Math.abs(harness.walk.verticalSpeed)).toBeLessThan(0.08)
    expect(harness.walk.gait).toBe('swim')
    expect(harness.walk.submerged).toBe(false)
    expect(splash).toHaveBeenCalledTimes(2)

    harness.walk.setTouchCrouch(true)
    for (let i = 0; i < 60; i++) harness.walk.update(0.02)
    harness.walk.setTouchCrouch(false)
    expect(harness.walk.position.y).toBeLessThan(restY - 0.35)
    expect(harness.walk.submerged).toBe(true)

    for (let i = 0; i < 180; i++) harness.walk.update(0.02)
    expect(harness.walk.position.y).toBeGreaterThan(restY - 0.15)
    expect(Math.abs(harness.walk.verticalSpeed)).toBeLessThan(0.13)
    expect(harness.walk.submerged).toBe(false)
    harness.dispose()
  })

  it('leaves the pool onto the deck without falling through it', () => {
    const harness = createWalkHarness()
    harness.walk.position.set(0, fullPoolSurface() - 0.2, -POOL_HALF + 1)
    harness.walk.setTouchMove(0, 1)
    harness.walk.update(0.02)

    for (let i = 0; i < 150 && harness.walk.surface === 'water'; i++) {
      harness.walk.update(0.02)
    }
    harness.walk.setTouchMove(0, 0)
    let minY = harness.walk.position.y
    for (let i = 0; i < 150; i++) {
      harness.walk.update(0.02)
      minY = Math.min(minY, harness.walk.position.y)
    }

    expect(harness.walk.surface).toBe('deck')
    expect(harness.walk.grounded).toBe(true)
    expect(harness.walk.position.y).toBeCloseTo(CITY.deck.top, 5)
    expect(minY).toBeGreaterThanOrEqual(POOL_BOTTOM)
    harness.dispose()
  })

  it('makes crossing the surface an audio and visual event and keeps water movement dense', () => {
    const harness = createWalkHarness()
    const { audio, visualSplash, walk } = harness

    walk.position.set(0, POOL_BOTTOM + 1, 0)
    walk.setTouchMove(0, 1)
    walk.update(0.1)
    expect(walk.gait).toBe('swim')
    expect(walk.submerged).toBe(true)
    expect(audio.splash).toHaveBeenCalledTimes(1)
    expect(visualSplash).toHaveBeenCalledTimes(1)

    walk.setTouchMove(0, 0)
    const moving = walk.speed
    walk.update(0.1)
    expect(walk.speed).toBeGreaterThan(0)
    expect(walk.speed).toBeLessThan(moving)

    walk.position.set(60, POOL_BOTTOM + 1, 0)
    walk.update(0.1)
    expect(audio.splash).toHaveBeenCalledTimes(2)
    expect(visualSplash).toHaveBeenCalledTimes(2)

    harness.dispose()
  })

  it('renders a readable top boundary and replaces long-range air clarity underwater', () => {
    const sim = createSim(createBus()).state
    sim.buffers.usedCount = sim.buffers.sampleFrames
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, (POOL_BOTTOM + fullPoolSurface()) * 0.5, 0)
    const water = createBufferWater(scene, undefined, { buffers: sim.buffers, camera })
    const surface = water.group.getObjectByName('buffer.water.surface') as THREE.Mesh
    const volume = water.group.getObjectByName('buffer.water.volume') as THREE.Mesh

    expect(surface).toBeInstanceOf(THREE.Mesh)
    expect((surface as THREE.Mesh & { isReflector?: boolean }).isReflector).toBe(true)
    const surfaceMaterial = surface.material as THREE.ShaderMaterial
    expect(surfaceMaterial.side).toBe(THREE.DoubleSide)
    expect(surfaceMaterial.transparent).toBe(true)
    expect(surfaceMaterial.depthWrite).toBe(false)
    expect(surfaceMaterial.uniforms.uTime.value).toBe(0)
    expect(surfaceMaterial.uniforms.uShallowColor.value).toBeInstanceOf(THREE.Color)
    expect(surfaceMaterial.uniforms.uDeepColor.value).toBeInstanceOf(THREE.Color)
    expect(surfaceMaterial.uniforms.uShallowColor.value.getHex()).not.toBe(
      surfaceMaterial.uniforms.uDeepColor.value.getHex(),
    )
    expect(new THREE.Box3().setFromObject(volume).min.y).toBeCloseTo(CITY.buf.baseY, 5)

    water.update(0.5)
    expect(surfaceMaterial.uniforms.uTime.value).toBeCloseTo(0.5)
    expect((scene.fog as THREE.Fog).far).toBeLessThan(90)
    water.splash(0, 0, 1)
    expect(water.group.children.some((child) => child.name === 'buffer.water.ripple' && child.visible)).toBe(true)

    water.dispose()
  })

  it('derives underwater atmosphere from camera position across camera modes', () => {
    const sim = createSim(createBus()).state
    sim.buffers.usedCount = sim.buffers.sampleFrames
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, (POOL_BOTTOM + fullPoolSurface()) * 0.5, 0)
    const water = createBufferWater(scene, undefined, { buffers: sim.buffers, camera })

    // The same physical camera position is underwater whether it was reached
    // in walk, fly, or orbit mode. No input-mode flag participates here.
    water.update(0.5)
    expect((scene.fog as THREE.Fog).far).toBeLessThan(90)

    camera.position.x = POOL_HALF + 2
    water.update(1)
    expect((scene.fog as THREE.Fog).far).toBeGreaterThan(1100)

    water.dispose()
  })

  it('updates the camera medium while simulation time is paused', () => {
    const sim = createSim(createBus()).state
    sim.buffers.usedCount = sim.buffers.sampleFrames
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, (POOL_BOTTOM + fullPoolSurface()) * 0.5, 0)
    const water = createBufferWater(scene, undefined, { buffers: sim.buffers, camera })

    water.update(0, 0.5)

    expect((scene.fog as THREE.Fog).far).toBeLessThan(90)
    water.dispose()
  })

  it('adds sparse depth-tested particulate motion without washing out the buffer tiles', () => {
    const sim = createSim(createBus()).state
    sim.buffers.usedCount = sim.buffers.sampleFrames
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, (POOL_BOTTOM + fullPoolSurface()) * 0.5, 0)
    const water = createBufferWater(scene, undefined, { buffers: sim.buffers, camera })
    const particulate = water.group.getObjectByName('buffer.water.particulate') as THREE.Points

    expect(particulate).toBeInstanceOf(THREE.Points)
    const material = particulate.material as THREE.PointsMaterial
    const positions = particulate.geometry.getAttribute('position') as THREE.BufferAttribute
    const y0 = positions.getY(0)
    expect(material.transparent).toBe(true)
    expect(material.depthTest).toBe(true)
    expect(material.depthWrite).toBe(false)
    expect(material.blending).toBe(THREE.NormalBlending)
    expect(material.opacity).toBeLessThan(0.25)

    water.update(0.5)
    expect(particulate.visible).toBe(true)
    expect(positions.getY(0)).not.toBe(y0)
    water.dispose()
  })

  it('keeps underwater depth cues static when reduced motion is requested', () => {
    const sim = createSim(createBus()).state
    sim.buffers.usedCount = sim.buffers.sampleFrames
    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x101820, 220, 1150)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, (POOL_BOTTOM + fullPoolSurface()) * 0.5, 0)
    const water = createBufferWater(scene, undefined, {
      buffers: sim.buffers,
      reducedMotion: true,
      camera,
    })
    const particulate = water.group.getObjectByName('buffer.water.particulate') as THREE.Points
    const surface = water.group.getObjectByName('buffer.water.surface') as THREE.Mesh
    const positions = particulate.geometry.getAttribute('position') as THREE.BufferAttribute
    const y0 = positions.getY(0)

    water.update(0.5)
    expect(particulate.visible).toBe(true)
    expect(positions.getY(0)).toBe(y0)
    expect((surface.material as THREE.ShaderMaterial).uniforms.uTime.value).toBe(0)
    water.dispose()
  })

  it.each(['low', 'ultra'] as const)(
    'keeps the modeled level at %s fidelity',
    (level) => {
      const sim = createSim(createBus()).state
      sim.buffers.usedCount = Math.round(sim.buffers.sampleFrames * 0.5) as typeof sim.buffers.usedCount
      const scene = new THREE.Scene()
      const water = createBufferWater(scene, { level }, { buffers: sim.buffers })
      const surface = water.group.getObjectByName('buffer.water.surface') as THREE.Mesh

      water.update(0.02)

      expect(surface.position.y).toBeCloseTo(bufferPoolSurfaceY(sim.buffers), 6)
      water.dispose()
    },
  )
})
