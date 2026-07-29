import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { routePoint } from '../src/world/layout'
import type { TraversalRoute, WalkCityHarness, WalkPoint } from './walk-harness'
import { createWalkCityHarness } from './walk-harness'

function bothDirections(id: string, points: readonly WalkPoint[], gait: 'walk' | 'run' = 'run'): TraversalRoute[] {
  return [
    { id: `${id}:outbound`, points, gait },
    { id: `${id}:return`, points: [...points].reverse(), gait },
  ]
}

const CAUSEWAYS: TraversalRoute[] = [
  ...bothDirections('causeway:north', [[0, 0.02, -110], [0, 3, -55]]),
  ...bothDirections('causeway:south', [[3.78, 0.02, 110], [3.78, 3, 55]]),
  ...bothDirections('causeway:east', [[126, 0.62, 26.075], [72, 3, 26.075]]),
  ...bothDirections('causeway:west', [[-126, 0.62, -11.175], [-72, 3, -11.175]]),
]

const PLINTH_RAMPS: TraversalRoute[] = [
  ...bothDirections('ramp:backends', [[16, 0.02, -105], [16, 0.62, -115]], 'walk'),
  ...bothDirections('ramp:wal', [[150, 0.02, -97], [150, 0.62, -87]], 'walk'),
  ...bothDirections('ramp:maintenance', [[-170, 0.02, -75], [-170, 0.62, -65]], 'walk'),
  ...bothDirections('ramp:replication', [[120, 0.02, 145], [120, 0.62, 155]], 'walk'),
  ...bothDirections('ramp:clients', [[0, 0.02, -235], [0, 0.62, -245]], 'walk'),
]

const STAIR_DOWN: readonly WalkPoint[] = [
  [89, 0.02, -108],
  [89, 0.02, -92],
  [68, -7.41, -92],
  [68, -7.41, -88],
  [88, -14.85, -88],
  [88, -14.85, -92],
  [68, -22.28, -92],
  [68, -22.28, -88],
  [88, -29.71, -88],
  [88, -29.71, -92],
  [68, -37.14, -92],
  [68, -37.14, -88],
  [88, -44.57, -88],
  [88, -44.57, -92],
  [68, -52, -92],
  [53, -52, -92],
]

const DISTRICT_BOUNDARIES: TraversalRoute[] = [
  ...bothDirections('boundary:clients-backends', [[100, 0.62, -286], [100, 0.62, -156]]),
  ...bothDirections('boundary:backends-shmem', [[0, 0.02, -110], [0, 3, -55]]),
  ...bothDirections('boundary:shmem-wal', [[72, 3, 26.075], [126, 0.62, 26.075]]),
  ...bothDirections('boundary:shmem-maintenance', [[-72, 3, -11.175], [-126, 0.62, -11.175]]),
  ...bothDirections('boundary:shmem-storage', STAIR_DOWN, 'walk'),
  ...bothDirections('boundary:shmem-replication', [[3.78, 3, 55], [3.78, 0.02, 160]]),
  ...bothDirections('boundary:wal-replication', [[260, 0.62, 118], [260, 0.62, 150]]),
  ...bothDirections('boundary:maintenance-world', [[-254, 0.62, 80], [-280, 0.02, 120]]),
]

interface SolidProbe {
  id: string
  at: WalkPoint
  halfX: number
  halfZ: number
}

function structureProbes(spec: SolidProbe): TraversalRoute[] {
  const [x, y, z] = spec.at
  const approaches: [string, WalkPoint][] = [
    ['west', [x - spec.halfX - 8, y, z]],
    ['east', [x + spec.halfX + 8, y, z]],
    ['north', [x, y, z - spec.halfZ - 8]],
    ['south', [x, y, z + spec.halfZ + 8]],
  ]
  const routes: TraversalRoute[] = []
  for (const gait of ['walk', 'run'] as const) {
    for (const [direction, start] of approaches) {
      routes.push({
        id: `structure:${spec.id}:${direction}:${gait}`,
        points: [start, spec.at],
        gait,
        tolerance: 0.2,
        maxFramesPerLeg: 500,
        stopOnCollision: true,
      })
    }
  }
  return routes
}

const STRUCTURES: TraversalRoute[] = [
  ...structureProbes({ id: 'standby.b', at: [-112, 0.02, 262], halfX: 5, halfZ: 4 }),
  ...structureProbes({ id: 'recovery.ground', at: [-286, 0.02, 291], halfX: 1.3, halfZ: 1.3 }),
  ...structureProbes({ id: 'backup.vault', at: [396, 0.6, 96], halfX: 5, halfZ: 6 }),
  ...structureProbes({ id: 'wal.vault', at: [168, 1, 4.5], halfX: 8, halfZ: 4 }),
  ...structureProbes({ id: 'disk.array', at: [0, -60, -99], halfX: 66, halfZ: 4.5 }),
  ...structureProbes({
    id: 'net.wire',
    at: (() => {
      const stream = routePoint('net.stream', 0.5)
      const ack = routePoint('net.ack', 0.5)
      return [(stream.x + ack.x) / 2, 0.02, (stream.z + ack.z) / 2] as WalkPoint
    })(),
    halfX: 4.5,
    halfZ: 4.5,
  }),
]

const PLANNER_PROBES: TraversalRoute[] = []
for (const gait of ['walk', 'run'] as const) {
  for (const [direction, start, target] of [
    ['west', [-60, 45, -145], [-70, 45, -145]],
    ['east', [60, 45, -145], [70, 45, -145]],
    ['north', [-70, 45, -135], [-70, 45, -145]],
    ['south', [-70, 45, -125], [-70, 45, -115]],
  ] as const) {
    PLANNER_PROBES.push({
      id: `structure:planner.lab:${direction}:${gait}`,
      points: [start, target],
      gait,
      tolerance: 0.2,
      stopOnCollision: true,
    })
  }
}

const PLAZA_ROUTES: TraversalRoute[] = [
  ...bothDirections('plaza:north-south', [
    [0, 3, -58],
    [0, 3.2, -46],
    [30, 3.2, -38],
    [30, 3.2, 38],
    [3.78, 3.2, 46],
    [3.78, 3, 58],
  ]),
  ...bothDirections('plaza:east-west', [
    [-72, 3, -11.175],
    [-46, 3.2, -11.175],
    [-38, 3.2, -15],
    [38, 3.2, -15],
    [46, 3.2, 26.075],
    [72, 3, 26.075],
  ]),
]

const EXCAVATION_FLOOR: readonly WalkPoint[] = [
  [53, -52, -92],
  [40, -52, -90],
  [30, -52, -90],
  [30, -52, -30],
  [22, -52, -20],
  [12, -52, -16],
  [4, -52, -12],
]

const EXCAVATION_ROUTES: TraversalRoute[] = [
  ...bothDirections('excavation:floor', EXCAVATION_FLOOR, 'walk'),
  {
    id: 'excavation:rim',
    gait: 'run',
    tolerance: 1.2,
    points: [
      [-121, 0.62, -107],
      [0, 0.02, -107],
      [75, 0.02, -110],
      [100, 0.02, -110],
      [121, 0.62, -107],
      [121, 0.62, 26.075],
      [121, 0.62, 107],
      [3.78, 0.02, 107],
      [-121, 0.62, 107],
      [-119, 0.02, 55],
      [-170, 0.62, 55],
      [-170, 0.62, -75],
      [-119, 0.02, -80],
      [-121, 0.62, -107],
    ],
  },
]

describe('real-city first-person traversal', () => {
  let city: WalkCityHarness

  beforeAll(async () => {
    city = await createWalkCityHarness()
  })

  afterAll(() => {
    city.dispose()
  })

  it('builds the same collision world as the browser', () => {
    expect(city.colliderCount).toBeGreaterThan(900)
    for (const id of [
      'standby.b',
      'recovery.ground',
      'backup.vault',
      'wal.vault',
      'disk.array',
      'planner.lab',
      'net.wire',
    ]) {
      const box = city.componentBox(id)
      expect(box.isEmpty()).toBe(false)
    }
  })

  it('walks the complete plate perimeter at slow-frame cadence', () => {
    const start = city.platePerimeter[0]
    expect(city.collision.groundAt(new THREE.Vector3(start[0], 1, start[2]), 2)).not.toBeNull()
    const result = city.run({
      id: 'world:plate-perimeter',
      points: city.platePerimeter,
      gait: 'run',
      maxFramesPerLeg: 400,
      tolerance: 4,
    })
    expect(
      result.reached,
      `${result.steps.at(-1)?.leg ?? 0}: start=${JSON.stringify(city.platePerimeter[0])}, ` +
        `target=${JSON.stringify(city.platePerimeter[result.steps.at(-1)?.leg ?? 1])}, ` +
        `firstFall=${JSON.stringify(result.steps.find((step) => step.position[1] < -0.1))}, ` +
        `final=${JSON.stringify(result.finalPosition)}, minY=${result.minFeetY}, collisions=${result.collisions}`,
    ).toBe(true)
    expect(result.minFeetY).toBeGreaterThan(-0.1)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it.each(DISTRICT_BOUNDARIES)('$id traverses both sides', (route) => {
    const result = city.run(route)
    expect(
      result.reached,
      `${result.steps.at(-1)?.leg ?? 0}: ${JSON.stringify(result.finalPosition)}, collisions=${result.collisions}`,
    ).toBe(true)
    expect(result.minFeetY).toBeGreaterThan(-61)
  })

  it.each([...CAUSEWAYS, ...PLINTH_RAMPS])('$id remains climbable', (route) => {
    const result = city.run(route)
    expect(result.reached).toBe(true)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it.each(PLAZA_ROUTES)('$id crosses the non-solid buffer field', (route) => {
    const result = city.run(route)
    expect(
      result.reached,
      `final=${JSON.stringify(result.finalPosition)}, minY=${result.minFeetY}, ` +
        `collisions=${result.collisions}, last=${JSON.stringify(result.steps.at(-7))}`,
    ).toBe(true)
    expect(result.minFeetY).toBeGreaterThanOrEqual(3)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it.each(EXCAVATION_ROUTES)('$id remains traversable', (route) => {
    const result = city.run(route)
    expect(
      result.reached,
      `final=${JSON.stringify(result.finalPosition)}, minY=${result.minFeetY}, ` +
        `collisions=${result.collisions}, last=${JSON.stringify(result.steps.at(-7))}`,
    ).toBe(true)
    expect(result.minFeetY).toBeGreaterThanOrEqual(-60)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it('keeps the query lab floor under the real walker', () => {
    const result = city.run({
      id: 'planner:lab-floor',
      points: [[-64, 45, -130], [64, 45, -130]],
      gait: 'run',
    })
    expect(result.reached).toBe(true)
    expect(result.minFeetY).toBeGreaterThanOrEqual(45)
  })

  it.each([...STRUCTURES, ...PLANNER_PROBES])('$id reports a solid collision', (route) => {
    const result = city.run(route)
    expect(
      result.reached,
      `final=${JSON.stringify(result.finalPosition)}, minY=${result.minFeetY}, collisions=${result.collisions}`,
    ).toBe(false)
    expect(result.collisions).toBeGreaterThan(0)
  })

  it('jumps onto a district plinth that is too tall to step onto', () => {
    const result = city.run({
      id: 'jump:client-plinth',
      points: [[30, 0.02, -238], [30, 0.62, -249]],
      gait: 'run',
      jumpEveryFrames: 12,
    })
    expect(result.reached).toBe(true)
    expect(result.finalPosition[1]).toBeCloseTo(0.62, 1)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it('cannot jump through a wall onto the standby B roof', () => {
    const result = city.run({
      id: 'jump:standby-b-roof',
      points: [[-112, 0.02, 250], [-112, 8, 262]],
      gait: 'run',
      jumpEveryFrames: 12,
      maxFramesPerLeg: 500,
      tolerance: 0.2,
      stopOnCollision: true,
    })
    expect(result.reached).toBe(false)
    expect(result.collisions).toBeGreaterThan(0)
    expect(result.finalPosition[1]).toBeLessThan(1)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it('jumps the excavation parapet, lands on the floor, and does not fall through the world', () => {
    const result = city.run({
      id: 'jump:excavation-edge',
      points: [[30, 0.02, -108], [30, -52, -90]],
      gait: 'run',
      jumpEveryFrames: 12,
      settleFrames: 180,
    })
    expect(result.reached).toBe(true)
    expect(result.minFeetY).toBeGreaterThanOrEqual(-60)
    expect(result.finalPosition[1]).toBeCloseTo(-52, 1)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })

  it('lands after running off the query lab instead of floating or sinking', () => {
    const result = city.run({
      id: 'jump:planner-edge',
      points: [[0, 45, -120], [0, -60, -100]],
      gait: 'run',
      settleFrames: 180,
    })
    expect(result.reached).toBe(true)
    expect(result.minFeetY).toBeGreaterThanOrEqual(-60)
    expect(result.steps.at(-1)?.grounded).toBe(true)
  })
})
