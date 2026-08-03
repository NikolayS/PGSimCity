import * as THREE from 'three'
import { createBus } from '../src/core/bus'
import { Registry } from '../src/core/registry'
import { createTheme } from '../src/core/theme'
import type {
  ComponentDef,
  FlowRequest,
  QualitySettings,
  SimState,
  WorldContext,
  WorldModule,
} from '../src/core/types'
import type { AudioApi } from '../src/engine/audio'
import {
  createCollisionWorld,
  DEFAULT_EXCLUDE_IDS,
  type CollisionWorld,
} from '../src/engine/collision'
import { createWalkController, type WalkController } from '../src/engine/walk'
import { createSim } from '../src/sim/model'
import { createAccess, type AccessModule } from '../src/world/access'
import { createBackends } from '../src/world/backends'
import { createClients } from '../src/world/clients'
import { createControlCenterWorld } from '../src/world/control-center'
import { createContinuity } from '../src/world/continuity'
import { createWorldHandles } from '../src/world/handles'
import { createMaintenance } from '../src/world/maintenance'
import { createPlanner } from '../src/world/planner'
import { createReplication } from '../src/world/replication'
import { createShmem } from '../src/world/shmem'
import { createStorage } from '../src/world/storage'
import { createWal } from '../src/world/wal'
import { installTestDom } from './dom'

export type WalkPoint = readonly [x: number, feetY: number, z: number]

export interface TraversalRoute {
  id: string
  points: readonly WalkPoint[]
  gait: 'walk' | 'run'
  /** Horizontal distance from the last waypoint that counts as arrival. */
  tolerance?: number
  /** Slow browser frame used to exercise the controller's fixed sub-steps. */
  frameDt?: number
  /** Stops a blocked or misdirected route deterministically. */
  maxFramesPerLeg?: number
  /** Structure probes finish as soon as the real controller reports contact. */
  stopOnCollision?: boolean
  /** Repeated jump attempts, expressed in harness frames. */
  jumpEveryFrames?: number
  /** Frames allowed for a final fall or landing to settle. Default 6. */
  settleFrames?: number
}

export interface TraversalStep {
  readonly frame: number
  readonly leg: number
  readonly position: readonly [x: number, feetY: number, z: number]
  readonly grounded: boolean
  readonly gait: string
  readonly collision: boolean
}

export interface TraversalResult {
  readonly route: TraversalRoute
  readonly steps: readonly TraversalStep[]
  readonly reached: boolean
  readonly collisions: number
  readonly minFeetY: number
  readonly finalPosition: readonly [x: number, feetY: number, z: number]
}

export interface WalkCityHarness {
  readonly scene: THREE.Scene
  readonly registry: Registry
  readonly collision: CollisionWorld
  readonly colliderCount: number
  readonly platePerimeter: readonly WalkPoint[]
  componentBox(id: string): THREE.Box3
  run(route: TraversalRoute): TraversalResult
  dispose(): void
}

export interface WalkCityHarnessOptions {
  includeControlCenter?: boolean
}

const QUALITY: QualitySettings = {
  level: 'high',
  pixelRatio: 1,
  bloom: true,
  shadows: true,
  maxParticles: 2400,
  maxLabels: 90,
  antialias: true,
}

const WALK_INPUT = 2.4 / 6.5
const SLOW_FRAME = 0.1

class SvgElement {
  readonly nodeType = 1
  readonly style: Readonly<Record<string, string>> = {}

  constructor(
    readonly nodeName: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly childNodes: readonly SvgElement[] = [],
  ) {}

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name)
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getAttributeNS(_namespace: string, name: string): string | null {
    return this.getAttribute(name)
  }

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class TestDomParser {
  parseFromString(text: string): Document {
    const paths = [...text.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
      (match) => new SvgElement('path', { d: match[1] }),
    )
    return {
      documentElement: new SvgElement('svg', {}, paths),
      querySelectorAll: () => [],
    } as unknown as Document
  }
}

function silentAudio(): AudioApi {
  return {
    enable: async () => {},
    disable: () => {},
    preferred: false,
    enabled: false,
    volume: 0,
    step: () => {},
    land: () => {},
    jump: () => {},
    splash: () => {},
    dispose: () => {},
  }
}

function addModule(scene: THREE.Scene, modules: WorldModule[], module: WorldModule): WorldModule {
  modules.push(module)
  scene.add(module.group)
  return module
}

/**
 * Production city geometry + production collision build + production walk
 * controller, without WebGL. Canvas calls are inert because collision only
 * needs the resulting scene graph and matrices.
 */
export async function createWalkCityHarness(options: WalkCityHarnessOptions = {}): Promise<WalkCityHarness> {
  const dom = installTestDom({ canvas2d: true })
  const nativeDomParser = globalThis.DOMParser
  globalThis.DOMParser = TestDomParser as unknown as typeof DOMParser
  const { createGround } = await import('../src/world/ground')
  const { offsetRing, ringArea2 } = await import('../src/world/slonik')
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 5000)
  const bus = createBus()
  const sim = createSim(bus)
  const registry = new Registry()
  const theme = createTheme()
  const modules: WorldModule[] = []
  const ctx: WorldContext = {
    scene,
    camera,
    bus,
    sim: sim.state,
    quality: QUALITY,
    theme,
    register: (def: ComponentDef) => registry.register(def),
    flow: (_req: FlowRequest) => {},
  }

  const ground = addModule(scene, modules, createGround(ctx))
  const shmem = addModule(scene, modules, createShmem(ctx))
  const access = addModule(scene, modules, createAccess(ctx)) as AccessModule
  addModule(scene, modules, createClients(ctx))
  addModule(scene, modules, createBackends(ctx))
  addModule(scene, modules, createWal(ctx))
  addModule(scene, modules, createStorage(ctx))
  addModule(scene, modules, createMaintenance(ctx))
  addModule(scene, modules, createWorldHandles(ctx))
  addModule(scene, modules, createReplication(ctx))
  addModule(scene, modules, createPlanner(ctx))
  addModule(scene, modules, createContinuity(ctx))
  if (options.includeControlCenter) addModule(scene, modules, createControlCenterWorld(ctx))
  scene.updateMatrixWorld(true)

  const collision = createCollisionWorld()
  collision.build(registry, { excludeIds: [...DEFAULT_EXCLUDE_IDS, 'shmem.deck'] })
  collision.addWalkable(ground.group, 'ground')
  collision.addWalkable(shmem.group.getObjectByName('shmem.deck') ?? shmem.group, 'deck')
  collision.addPublished(scene)
  access.installCollision(collision)
  const slonik = ground.group.userData.slonik as {
    ring: Float64Array
    contains(x: number, z: number): boolean
  }
  let insetRing = offsetRing(slonik.ring, 14, ringArea2(slonik.ring) > 0)
  if (!slonik.contains(insetRing[0], insetRing[1])) {
    insetRing = offsetRing(slonik.ring, -14, ringArea2(slonik.ring) > 0)
  }
  const platePerimeter: WalkPoint[] = []
  for (let i = 0; i < insetRing.length; i += 2) {
    const point: WalkPoint = [insetRing[i], 0, insetRing[i + 1]]
    const previous = platePerimeter.at(-1)
    if (previous) {
      const fenceZ = -252
      const crossesFence = (previous[2] - fenceZ) * (point[2] - fenceZ) < 0
      const t = crossesFence ? (fenceZ - previous[2]) / (point[2] - previous[2]) : 0
      const crossX = previous[0] + (point[0] - previous[0]) * t
      if (crossesFence && Math.abs(crossX) < 150) {
        const side = Math.sign(previous[2] - fenceZ)
        platePerimeter.push([0, 0, fenceZ + side * 6], [0, 0, fenceZ - side * 6])
      }
    }
    platePerimeter.push(point)
  }
  platePerimeter.push(platePerimeter[0])

  let moveCollision = false
  const realMove = collision.move
  collision.move = (from, to, radius, height, out) => {
    const result = realMove(from, to, radius, height, out)
    moveCollision ||= result.blocked
    return result
  }

  function componentBox(id: string): THREE.Box3 {
    const component = registry.get(id)
    if (!component) throw new Error(`Unknown traversal component: ${id}`)
    return new THREE.Box3().setFromObject(component.object)
  }

  function settle(walk: WalkController, at: WalkPoint): void {
    walk.position.set(at[0], at[1] + 0.04, at[2])
    walk.setTouchMove(0, 0)
    for (let i = 0; i < 8; i++) walk.update(SLOW_FRAME)
  }

  function run(route: TraversalRoute): TraversalResult {
    if (route.points.length < 2) throw new Error(`${route.id}: a traversal needs at least two points`)
    const start = route.points[0]
    camera.position.set(start[0], start[1] + 32, start[2])
    camera.quaternion.identity()
    const walk = createWalkController({
      camera,
      dom: dom.document.createElement('canvas') as unknown as HTMLElement,
      collision,
      audio: silentAudio(),
      sim: sim.state as SimState,
      bus,
      overlayRoot: undefined,
    })
    void walk.enter()
    for (let i = 0; i < 12; i++) walk.update(SLOW_FRAME)
    settle(walk, start)

    const steps: TraversalStep[] = []
    const magnitude = route.gait === 'run' ? 1 : WALK_INPUT
    const dt = route.frameDt ?? SLOW_FRAME
    const maxFrames = route.maxFramesPerLeg ?? 1600
    const tolerance = route.tolerance ?? 0.7
    let reached = true
    let collisions = 0
    let minFeetY = walk.position.y
    let frame = 0

    for (let leg = 1; leg < route.points.length; leg++) {
      const target = route.points[leg]
      let arrived = false
      let stoppedOnCollision = false
      for (let i = 0; i < maxFrames; i++) {
        const dx = target[0] - walk.position.x
        const dz = target[2] - walk.position.z
        const distance = Math.hypot(dx, dz)
        if (distance <= tolerance) {
          arrived = true
          break
        }
        // The controller enters at yaw zero: +strafe is +X, +forward is -Z.
        walk.setTouchMove((dx / distance) * magnitude, (-dz / distance) * magnitude)
        const jumpEvery = route.jumpEveryFrames ?? 0
        walk.setTouchJump(jumpEvery > 0 && frame % jumpEvery === 0)
        moveCollision = false
        walk.update(dt)
        if (moveCollision) collisions++
        if (walk.position.y < minFeetY) minFeetY = walk.position.y
        steps.push({
          frame: frame++,
          leg,
          position: [walk.position.x, walk.position.y, walk.position.z],
          grounded: walk.grounded,
          gait: walk.gait,
          collision: moveCollision,
        })
        if (moveCollision && route.stopOnCollision === true) {
          stoppedOnCollision = true
          break
        }
      }
      if (!arrived || stoppedOnCollision) {
        reached = false
        break
      }
    }
    walk.setTouchMove(0, 0)
    walk.setTouchJump(false)
    for (let i = 0; i < (route.settleFrames ?? 6); i++) {
      moveCollision = false
      walk.update(dt)
      if (moveCollision) collisions++
      if (walk.position.y < minFeetY) minFeetY = walk.position.y
      steps.push({
        frame: frame++,
        leg: route.points.length,
        position: [walk.position.x, walk.position.y, walk.position.z],
        grounded: walk.grounded,
        gait: walk.gait,
        collision: moveCollision,
      })
    }
    const finalPosition: WalkPoint = [walk.position.x, walk.position.y, walk.position.z]
    walk.dispose()
    return { route, steps, reached, collisions, minFeetY, finalPosition }
  }

  return {
    scene,
    registry,
    collision,
    colliderCount: collision.boxCount,
    platePerimeter,
    componentBox,
    run,
    dispose(): void {
      collision.move = realMove
      collision.dispose()
      for (let i = modules.length - 1; i >= 0; i--) modules[i].dispose?.()
      registry.clear()
      theme.dispose()
      scene.clear()
      globalThis.DOMParser = nativeDomParser
    },
  }
}
