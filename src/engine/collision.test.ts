import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import type { ComponentDef, SimState } from '../core/types'
import { createSim } from '../sim/model'
import type { AudioApi } from './audio'
import { createCollisionWorld, createMoveResult } from './collision'
import { createWalkController } from './walk'

/* ============================================================================
 * WHAT A BODY IS OWED
 *
 * Three defects, one file. Every test below drives the same code the walker
 * drives, at a distance from the origin so the buffer-pool swim volume (which
 * lives around x = z = 0) can never answer for the floor.
 * ==========================================================================*/

/** Far from the plaza, so nothing in this file is ever "swimming". */
const FAR_X = 300

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

function component(id: string, object: THREE.Object3D): ComponentDef {
  return { id, district: 'replication', object } as unknown as ComponentDef
}

/** A district that merged its whole structure into ONE childless mesh. */
function mergedBuilding(w: number, h: number, d: number, x: number, z: number): THREE.Object3D {
  const g = new THREE.Group()
  g.name = 'district'
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d))
  m.name = 'district.struct'
  m.position.set(x, h / 2, z)
  g.add(m)
  g.updateMatrixWorld(true)
  return g
}

/** A flat walkable plate — what world.ground is to the real city. */
function plate(y: number, half: number, cx: number, cz: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2))
  m.rotation.x = -Math.PI / 2
  m.position.set(cx, y, cz)
  m.updateMatrixWorld(true)
  return m
}

/**
 * A ramp rising toward -Z at `deg`, its foot at z = 0. Two triangles wound so
 * the face normal points up, which is the only thing the slope rule reads.
 */
function ramp(deg: number, length: number, width: number, cx: number): THREE.Mesh {
  const a = (deg * Math.PI) / 180
  const h = Math.sin(a) * length
  const d = Math.cos(a) * length
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-width / 2, 0, 0, width / 2, 0, 0, width / 2, h, -d, -width / 2, 0, 0, width / 2, h, -d, -width / 2, h, -d],
      3,
    ),
  )
  geo.computeVertexNormals()
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  m.position.set(cx, 0, 0)
  m.updateMatrixWorld(true)
  return m
}

interface Harness {
  walk: ReturnType<typeof createWalkController>
  collision: ReturnType<typeof createCollisionWorld>
  dispose(): void
}

/** A walker standing at `at`, already through the drop-in, facing -Z. */
function harness(collision: ReturnType<typeof createCollisionWorld>, at: THREE.Vector3): Harness {
  const bus = createBus()
  const camera = new THREE.PerspectiveCamera()
  camera.position.set(at.x, at.y + 40, at.z)
  const dom = new EventTarget() as HTMLElement
  const walk = createWalkController({
    camera,
    dom,
    collision,
    audio: fakeAudio(),
    sim: createSim(bus).state as SimState,
    bus,
  })
  void walk.enter()
  for (let i = 0; i < 14; i++) walk.update(0.1)
  walk.position.copy(at)
  walk.update(1 / 60)
  return {
    walk,
    collision,
    dispose(): void {
      walk.dispose()
      collision.dispose()
    },
  }
}

/* --------------------------------------------------------------------------
 * 1. Buildings must be solid.
 * ------------------------------------------------------------------------*/

describe('collision.build: a merged structural mesh', () => {
  it('is boxed even though it is one childless mesh wider than maxSpan', () => {
    const world = createCollisionWorld()
    // standby.b.struct, to the metre.
    world.build({ all: () => [component('standby.b', mergedBuilding(32, 10, 88.5, 0, 0))] })
    expect(world.boxCount).toBeGreaterThan(0)
    world.dispose()
  })

  it('stops move() at its face instead of letting the walker through', () => {
    const world = createCollisionWorld()
    world.build({ all: () => [component('standby.b', mergedBuilding(32, 10, 88.5, 0, 0))] })
    const out = createMoveResult()
    world.move(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, 42), 0.35, 1.8, out)
    expect(out.blocked).toBe(true)
    expect(out.position.z).toBeGreaterThan(44.25 - 1e-3)
    world.dispose()
  })

  it('stops a walker driven into it at a run', () => {
    const world = createCollisionWorld()
    world.build({ all: () => [component('standby.b', mergedBuilding(32, 10, 88.5, FAR_X, 0))] })
    world.addWalkable(plate(0, 200, FAR_X, 0), 'ground')
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 60))
    h.walk.setTouchMove(0, 1)
    for (let i = 0; i < 60; i++) h.walk.update(1 / 30)
    // The near face is at z = 44.25; a 0.35 m capsule stops at 44.60.
    expect(h.walk.position.z).toBeGreaterThan(44.5)
    h.dispose()
  })

  it('still refuses a decal-thin slab and anything in the client sky', () => {
    const world = createCollisionWorld()
    const g = new THREE.Group()
    const decal = new THREE.Mesh(new THREE.BoxGeometry(120, 0.08, 120))
    decal.position.set(0, 0.04, 0)
    g.add(decal)
    g.updateMatrixWorld(true)
    world.build({ all: () => [component('paint', g)] })
    expect(world.boxCount).toBe(0)
    world.dispose()
  })

  it('follows the silhouette: a low wing does not inherit the tower roof', () => {
    const world = createCollisionWorld()
    const g = new THREE.Group()
    const merged = new THREE.Group()
    const tower = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 20))
    tower.position.set(-30, 15, 0)
    const wing = new THREE.Mesh(new THREE.BoxGeometry(60, 4, 20))
    wing.position.set(30, 2, 0)
    merged.add(tower, wing)
    g.add(merged)
    g.updateMatrixWorld(true)
    world.build({ all: () => [component('merged', g)] })
    // Over the wing the roof is 4 m, not the tower's 30 m.
    const p = new THREE.Vector3(45, 8, 0)
    expect(world.groundAt(p, 8)).toBeCloseTo(4, 3)
    world.dispose()
  })

  it('does not create a collider for a hidden scene branch', () => {
    const world = createCollisionWorld()
    const root = new THREE.Group()
    const visible = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4))
    visible.position.set(0, 2, 0)
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4))
    hidden.position.set(100, 2, 0)
    hidden.visible = false
    root.add(visible, hidden)
    root.updateMatrixWorld(true)

    world.build({ all: () => [component('branches', root)] })

    expect(world.solidNear(0, 0, 2)).toBe(true)
    expect(world.solidNear(100, 0, 2)).toBe(false)
    world.dispose()
  })

  it('measures visible structure instead of an invisible pick proxy', () => {
    const world = createCollisionWorld()
    const root = new THREE.Group()
    const visible = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4))
    visible.position.set(0, 2, 0)
    const proxy = new THREE.Mesh(
      new THREE.BoxGeometry(20, 8, 20),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    proxy.position.set(0, 4, 0)
    root.add(visible, proxy)
    root.updateMatrixWorld(true)

    world.build({ all: () => [component('proxy', root)] })
    const out = createMoveResult()
    world.move(new THREE.Vector3(0, 0, 8), new THREE.Vector3(0, 0, 0), 0.35, 1.8, out)

    expect(out.position.z).toBeCloseTo(2.35, 3)
    world.dispose()
  })

  it('stops the real controller at a wall inside a compound component box', () => {
    const world = createCollisionWorld()
    const building = new THREE.Group()
    const wall = new THREE.Mesh(new THREE.BoxGeometry(10, 3, 1))
    wall.position.set(FAR_X, 1.5, 0)
    const northMarker = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1))
    northMarker.position.set(FAR_X + 6, 1.5, -6)
    const southMarker = northMarker.clone()
    southMarker.position.z = 6
    building.add(wall, northMarker, southMarker)
    building.updateMatrixWorld(true)
    world.build({ all: () => [component('compound', building)] })
    world.addWalkable(plate(0, 30, FAR_X, 0), 'ground')

    const h = harness(world, new THREE.Vector3(FAR_X, 0, 2))
    h.walk.setTouchMove(0, 1)
    for (let i = 0; i < 40; i++) h.walk.update(1 / 50)

    // A component-wide AABB contains this valid standing position. Ignoring a
    // containing collider must not make the visible wall inside it unreachable.
    expect(h.walk.position.z).toBeGreaterThanOrEqual(0.85 - 1e-3)
    h.dispose()
  })

  it('keeps the visible gap between compound component parts walkable', () => {
    const world = createCollisionWorld()
    const gateway = new THREE.Group()
    const west = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 10))
    west.position.set(FAR_X - 4, 1.5, 0)
    const east = west.clone()
    east.position.x = FAR_X + 4
    gateway.add(west, east)
    gateway.updateMatrixWorld(true)
    world.build({ all: () => [component('gateway', gateway)] })
    world.addWalkable(plate(0, 30, FAR_X, 0), 'ground')

    const h = harness(world, new THREE.Vector3(FAR_X, 0, 7))
    h.walk.setTouchMove(0, 1)
    for (let i = 0; i < 80; i++) h.walk.update(1 / 50)

    expect(h.walk.position.z).toBeLessThan(-1)
    h.dispose()
  })
})

describe('walk interior hand-off', () => {
  it('captures and restores the exact first-person pose', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 200, FAR_X, 0), 'ground')
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 12))
    const walk = h.walk as typeof h.walk & {
      capturePose(target: { x: number; y: number; z: number; yaw: number; pitch: number }): void
      setPose(pose: { x: number; y: number; z: number; yaw: number; pitch: number }): void
    }
    const saved = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }

    walk.setPose({ x: FAR_X + 3, y: 0, z: 8, yaw: 0.72, pitch: -0.18 })
    walk.capturePose(saved)
    walk.setPose({ x: 0, y: 27.8, z: -215, yaw: Math.PI, pitch: 0 })
    walk.setPose(saved)

    expect(walk.position.toArray()).toEqual([FAR_X + 3, 0, 8])
    expect(saved).toEqual({ x: FAR_X + 3, y: 0, z: 8, yaw: 0.72, pitch: -0.18 })
    h.dispose()
  })
})

/* --------------------------------------------------------------------------
 * 2. Slopes.
 * ------------------------------------------------------------------------*/

describe('slopes', () => {
  function slopeRun(deg: number, forward: number): { gained: number; peak: number; stuck: boolean } {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 300, FAR_X, 0), 'ground')
    world.addWalkable(ramp(deg, 40, 24, FAR_X), 'metal')
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 2))
    const y0 = h.walk.position.y
    h.walk.setTouchMove(0, forward)
    let peak = 0
    let stuck = false
    for (let i = 0; i < 200; i++) {
      h.walk.update(1 / 50)
      const up = h.walk.position.y - y0
      if (up > peak) peak = up
      // Standing still, up the face, is the failure the owner reported.
      if (h.walk.grounded && up > 0.1) stuck = true
    }
    const gained = h.walk.position.y - y0
    h.dispose()
    return { gained, peak, stuck }
  }

  it('climbs a 45-degree ramp at a walk and at a run', () => {
    expect(slopeRun(45, 0.37).gained).toBeGreaterThan(1)
    expect(slopeRun(45, 1).gained).toBeGreaterThan(1)
  })

  it('refuses a 70-degree ramp at a walk, where the old tolerance let it through', () => {
    const slow = slopeRun(70, 0.37)
    expect(slow.peak).toBeLessThan(0.5)
    // Refused, and not stuck to the face either: it slides back to the foot.
    expect(slow.stuck).toBe(false)
    expect(slow.gained).toBeLessThan(0.1)
  })

  it('refuses a 70-degree ramp at a run too', () => {
    const fast = slopeRun(70, 1)
    expect(fast.peak).toBeLessThan(0.5)
    expect(fast.stuck).toBe(false)
  })

  it('reports the surface normal of whatever it just found', () => {
    const world = createCollisionWorld()
    world.addWalkable(ramp(45, 40, 24, FAR_X), 'metal')
    const p = new THREE.Vector3(FAR_X, 6, -5)
    expect(world.groundAt(p, 8)).not.toBeNull()
    expect(world.groundNormal.y).toBeCloseTo(Math.SQRT1_2, 2)
    world.clear()
    world.addBox(new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2)))
    expect(world.groundAt(new THREE.Vector3(0, 3, 0), 2)).toBeCloseTo(3, 6)
    expect(world.groundNormal.y).toBeCloseTo(1, 6)
    world.dispose()
  })
})

/* --------------------------------------------------------------------------
 * 3. Step-up.
 * ------------------------------------------------------------------------*/

describe('step-up', () => {
  it('climbs a 0.40 m step without a jump', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 300, FAR_X, 0), 'ground')
    world.addBox(new THREE.Box3(new THREE.Vector3(FAR_X - 20, 0, -30), new THREE.Vector3(FAR_X + 20, 0.4, 2)))
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 6))
    h.walk.setTouchMove(0, 0.37)
    for (let i = 0; i < 120; i++) h.walk.update(1 / 50)
    expect(h.walk.position.z).toBeLessThan(1)
    expect(h.walk.position.y).toBeCloseTo(0.4, 2)
    h.dispose()
  })

  it('does not climb a 0.60 m wall without one', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 300, FAR_X, 0), 'ground')
    world.addBox(new THREE.Box3(new THREE.Vector3(FAR_X - 20, 0, -30), new THREE.Vector3(FAR_X + 20, 0.6, 2)))
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 6))
    h.walk.setTouchMove(0, 0.37)
    for (let i = 0; i < 120; i++) h.walk.update(1 / 50)
    expect(h.walk.position.z).toBeGreaterThan(2.3)
    expect(h.walk.position.y).toBeLessThan(0.05)
    h.dispose()
  })

  it('steps onto a kerb that only exists as a walkable surface', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0.4, 40, 0, 0), 'metal')
    // A wall the walker is pressed against: without it the probe must not run.
    world.addBox(new THREE.Box3(new THREE.Vector3(-20, 0, -30), new THREE.Vector3(20, 1.5, 2)))
    const out = createMoveResult()
    world.move(new THREE.Vector3(0, 0, 3), new THREE.Vector3(0, 0, 2), 0.35, 1.8, out)
    expect(out.blocked).toBe(true)
    expect(out.stepped).toBeCloseTo(0.4, 3)
    world.dispose()
  })

  it('refuses a step-up that would drive the head into a ceiling', () => {
    const world = createCollisionWorld()
    // A 0.40 m step inside a 1.90 m soffit: walkable at full height, but the
    // 1.80 m capsule does not fit on top of the step.
    const step = new THREE.Box3(new THREE.Vector3(-20, 0, -2), new THREE.Vector3(20, 0.4, 3))
    const out = createMoveResult()
    world.addBox(step)
    world.move(new THREE.Vector3(0, 0, 3.5), new THREE.Vector3(0, 0, 2), 0.35, 1.8, out)
    expect(out.stepped).toBeCloseTo(0.4, 3) // control: the step alone is climbable

    world.addBox(new THREE.Box3(new THREE.Vector3(-20, 1.9, -10), new THREE.Vector3(20, 3, 3)))
    world.move(new THREE.Vector3(0, 0, 3.5), new THREE.Vector3(0, 0, 2), 0.35, 1.8, out)
    expect(out.blocked).toBe(false) // the soffit clears a standing walker
    expect(out.stepped).toBe(0)
    expect(out.position.y).toBe(0)
    world.dispose()
  })
})

/* --------------------------------------------------------------------------
 * 4. Jumping onto things, and the plaza's non-solid tiles.
 * ------------------------------------------------------------------------*/

describe('landing', () => {
  it('lands on a roof, not only on the ground plane', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 300, FAR_X, 0), 'ground')
    // A 0.80 m plinth: above the step allowance, inside the 0.90 m jump.
    world.addBox(new THREE.Box3(new THREE.Vector3(FAR_X - 6, 0, -12), new THREE.Vector3(FAR_X + 6, 0.8, 0)))
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 3))
    h.walk.setTouchMove(0, 0.5)
    for (let i = 0; i < 200; i++) {
      // Jump again every half second: a body that cannot get onto a 0.80 m
      // plinth in six attempts cannot get onto it at all. The last second is
      // quiet so the assertions read a settled walker, not one mid-hop.
      h.walk.setTouchJump(i < 150 && i % 25 === 0)
      h.walk.update(1 / 50)
    }
    expect(h.walk.position.z).toBeLessThan(0)
    expect(h.walk.position.y).toBeCloseTo(0.8, 2)
    expect(h.walk.grounded).toBe(true)
    h.dispose()
  })

  it('keeps the buffer tiles out of the box set', () => {
    const world = createCollisionWorld()
    const tiles = new THREE.Group()
    const tile = new THREE.Mesh(new THREE.BoxGeometry(1.6, 6, 1.6))
    tile.position.set(0, 3, 0)
    tiles.add(tile)
    tiles.updateMatrixWorld(true)
    world.build({ all: () => [component('shared.buffers', tiles)] })
    expect(world.boxCount).toBe(0)
    world.dispose()
  })
})

/* --------------------------------------------------------------------------
 * 5. Swept movement.
 * ------------------------------------------------------------------------*/

describe('swept movement', () => {
  it('reaches a box from every spatial cell across its footprint', () => {
    const world = createCollisionWorld()
    world.addBox(new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 3, 25)))
    const out = createMoveResult()

    for (const offset of [-24, -16, -8, 0, 8, 16, 24]) {
      world.move(new THREE.Vector3(offset, 0, 35), new THREE.Vector3(offset, 0, 15), 0.35, 1.8, out)
      expect(out.blocked, `south face at x=${offset}`).toBe(true)
      expect(out.position.z, `south face at x=${offset}`).toBeGreaterThanOrEqual(25.35 - 1e-3)

      world.move(new THREE.Vector3(35, 0, offset), new THREE.Vector3(15, 0, offset), 0.35, 1.8, out)
      expect(out.blocked, `east face at z=${offset}`).toBe(true)
      expect(out.position.x, `east face at z=${offset}`).toBeGreaterThanOrEqual(25.35 - 1e-3)
    }
    world.dispose()
  })

  it('does not tunnel through a thin wall on a high-speed oblique crossing', () => {
    const world = createCollisionWorld()
    world.addBox(new THREE.Box3(new THREE.Vector3(-0.05, 0, -4), new THREE.Vector3(0.05, 3, 4)))
    const out = createMoveResult()

    world.move(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 0, 10), 0.35, 1.8, out)

    expect(out.blocked).toBe(true)
    expect(out.hitX).toBe(true)
    expect(out.position.x).toBeLessThanOrEqual(-0.4 + 1e-3)
    world.dispose()
  })

  it('stays outside both faces of an inside corner at speed', () => {
    const world = createCollisionWorld()
    world.addBox(new THREE.Box3(new THREE.Vector3(-0.05, 0, -8), new THREE.Vector3(0.05, 3, 0)))
    world.addBox(new THREE.Box3(new THREE.Vector3(-8, 0, -0.05), new THREE.Vector3(0, 3, 0.05)))
    const out = createMoveResult()

    world.move(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 0, 4), 0.35, 1.8, out)

    expect(out.hitX).toBe(true)
    expect(out.hitZ).toBe(true)
    expect(out.position.x).toBeLessThanOrEqual(-0.4 + 1e-3)
    expect(out.position.z).toBeLessThanOrEqual(-0.4 + 1e-3)
    world.dispose()
  })

  it('stops the real controller at full run gait on a thin wall', () => {
    const world = createCollisionWorld()
    world.addWalkable(plate(0, 80, FAR_X, 0), 'ground')
    world.addBox(
      new THREE.Box3(
        new THREE.Vector3(FAR_X - 20, 0, -0.05),
        new THREE.Vector3(FAR_X + 20, 3, 0.05),
      ),
    )
    const h = harness(world, new THREE.Vector3(FAR_X, 0, 8))
    h.walk.setTouchMove(0, 1)
    for (let i = 0; i < 20; i++) h.walk.update(0.1)

    expect(h.walk.position.z).toBeGreaterThanOrEqual(0.4 - 1e-3)
    expect(h.walk.position.z).toBeLessThan(0.5)
    h.dispose()
  })
})
