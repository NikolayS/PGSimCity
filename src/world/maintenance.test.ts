import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef } from '../core/types'
import { fmtNum } from '../core/util'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { vacBayPos, vacuumServicePoint, vacuumLiftX, vacuumLiftZ, tableX, VACUUM_SERVICE, CITY } from './layout'
import { createStorage } from './storage'
import { createWalkCityHarness } from '../../test/walk-harness'
import { CKPT_MASS, VACUUM_DOCKS, VACUUM_ROBOT_BODY, createMaintenance } from './maintenance'

type Box = readonly [number, number, number, number, number, number]

const x0 = (b: Box) => b[0] - b[3] / 2
const x1 = (b: Box) => b[0] + b[3] / 2
const y0 = (b: Box) => b[1] - b[4] / 2
const y1 = (b: Box) => b[1] + b[4] / 2
const z0 = (b: Box) => b[2] - b[5] / 2
const z1 = (b: Box) => b[2] + b[5] / 2

/** The engine hall itself: the largest single volume in the table. */
const hall = [...CKPT_MASS].sort((a, b) => b[3] * b[4] * b[5] - a[3] * a[4] * a[5])[0] as Box

describe('the checkpointer hall silhouette', () => {
  it('is not a crate: something breaks the plan at every height', () => {
    /* The complaint this answers is that a building reads as one box. Slice
     * the massing every four metres from grade to the roof and require the
     * plan outline to change between slices — a silhouette that is constant
     * over 25 m is a crate however it is shaded. */
    const widths: number[] = []
    for (let y = 2; y < y1(hall) + 8; y += 4) {
      let w = 0
      for (const b of CKPT_MASS) {
        if (b === hall) continue
        if (y < y0(b) || y > y1(b)) continue
        w = Math.max(w, x1(b) - x0(b))
      }
      widths.push(Math.round(w * 10) / 10)
    }
    expect(new Set(widths).size).toBeGreaterThanOrEqual(4)
  })

  it('crowns the wall with a cornice that actually projects', () => {
    // Concentric with the hall and sitting on top of it: the crown, and not
    // the sync stack that happens to reach the same height off to the west.
    const crown = CKPT_MASS.filter(
      (b) =>
        y0(b) >= y1(hall) - 0.6 &&
        y0(b) < y1(hall) + 1.2 &&
        Math.abs(b[0] - hall[0]) < 1 &&
        Math.abs(b[2] - hall[2]) < 1,
    )
    expect(crown.length).toBeGreaterThanOrEqual(2)
    // A 0.8 m projection on a 26 m hall is invisible at any distance a viewer
    // meets it from; the crown has to reach further than that, in two stages.
    const reach = crown.map((b) => x1(b as Box) - x1(hall)).sort((a, b) => a - b)
    expect(reach[0]).toBeGreaterThan(0.9)
    expect(reach[reach.length - 1]).toBeGreaterThan(reach[0])
  })

  it('stands the roofline behind a parapet on all four sides', () => {
    const top = Math.max(...CKPT_MASS.map((b) => y1(b as Box)))
    const parapet = CKPT_MASS.filter((b) => {
      const box = b as Box
      return y0(box) > y1(hall) + 0.8 && y1(box) < top && Math.min(box[3], box[5]) < 1
    })
    expect(parapet.length).toBe(4)
    // Two run in X and two in Z, or the roof is fenced on two sides only.
    expect(parapet.filter((b) => (b as Box)[3] > (b as Box)[5]).length).toBe(2)
    expect(parapet.filter((b) => (b as Box)[5] > (b as Box)[3]).length).toBe(2)
  })

  it('sits the hall on a plinth rather than on the pavement', () => {
    const base = CKPT_MASS.filter((b) => {
      const box = b as Box
      return box !== hall && y0(box) <= y0(hall) + 0.1 && y1(box) > y0(hall) + 0.3
    })
    expect(base.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...base.map((b) => x1(b as Box)))).toBeGreaterThan(x1(hall))
  })

  it('puts plant on the roof so the top is not a clean rectangle', () => {
    const roofTop = Math.max(...CKPT_MASS.filter((b) => (b as Box)[4] < 1).map((b) => y1(b as Box)))
    const plant = CKPT_MASS.filter((b) => y0(b as Box) >= roofTop - 0.2 && (b as Box)[4] > 1)
    expect(plant.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps every added volume inside the district apron', () => {
    // The apron is the widest, thinnest slab in the table; nothing the hall
    // grows may overhang it, or the building floats off its own plot.
    const apron = [...CKPT_MASS].sort((a, b) => a[4] - b[4])[0] as Box
    for (const b of CKPT_MASS) {
      const box = b as Box
      if (box === apron) continue
      expect(x0(box), `${box}`).toBeGreaterThanOrEqual(x0(apron) - 12)
      expect(x1(box), `${box}`).toBeLessThanOrEqual(x1(apron) + 6)
      expect(z0(box), `${box}`).toBeGreaterThanOrEqual(z0(apron) - 4)
      expect(z1(box), `${box}`).toBeLessThanOrEqual(z1(apron) + 4)
    }
  })

  it('articulates the long faces without overhanging the cornice', () => {
    const pilasters = CKPT_MASS.filter((b) => {
      const box = b as Box
      return box[5] < 1 && box[4] > 10 && box[3] > 1
    })
    expect(pilasters.length).toBe(10)
    const cornice = [...CKPT_MASS].sort((a, b) => b[5] - a[5])[0] as Box
    for (const p of pilasters) {
      expect(z1(p as Box)).toBeLessThanOrEqual(z1(cornice))
      expect(z0(p as Box)).toBeGreaterThanOrEqual(z0(cornice))
      // A pilaster has to stand PROUD of the wall or it is not there at all.
      const proud = Math.max(z1(p as Box) - z1(hall), z0(hall) - z0(p as Box))
      expect(proud).toBeGreaterThan(0.2)
    }
  })
})

describe('robot vacuum service station', () => {
  const dispose: Array<() => void> = []
  afterEach(() => {
    while (dispose.length) dispose.pop()!()
  })

  function fixture(drawText?: (text: string) => void) {
    installTestDom({ canvas2d: true })
    if (drawText) {
      const create = document.createElement.bind(document)
      vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
        const element = create(tag)
        if (tag === 'canvas') {
          const canvas = element as HTMLCanvasElement
          const context = canvas.getContext('2d')!
          context.fillText = (text: string) => drawText(text)
          canvas.getContext = (() => context) as unknown as typeof canvas.getContext
        }
        return element
      })
    }
    const bus = createBus()
    const sim = createSim(bus)
    const theme = createTheme()
    const components = new Map<string, ComponentDef>()
    const module = createMaintenance({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
      theme,
      quality: { level: 'high', pixelRatio: 1, bloom: true, shadows: true, maxParticles: 1, maxLabels: 1, antialias: true },
      register: (component) => components.set(component.id, component),
      flow: () => {},
    })
    dispose.push(() => {
      module.dispose?.()
      theme.dispose()
    })
    module.update(1 / 60, sim.state, 0)
    return { module, sim, components }
  }

  it('keeps bays selectable and worker focus attached to the departed robot', () => {
    const { module, sim, components } = fixture()
    const depot = components.get('autovac.depot')!
    expect(depot.object.name).toBe('vac.depot')
    const worker = components.get('autovac.worker.0')!
    const parked = [...worker.focus.target]
    Object.assign(sim.state.autovac.workers[0], { active: true, table: 3, phase: 'scan_heap', deadCollected: 0 })
    module.update(0.21, sim.state, 1)
    expect(worker.focus.target).not.toEqual(parked)
    const body = worker.object.children[0] as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    body.getMatrixAt(0, matrix)
    const bodyCenter = new THREE.Vector3().setFromMatrixPosition(matrix)
    expect(worker.focus.target[0]).toBeCloseTo(bodyCenter.x)
    expect(worker.focus.target[2]).toBeCloseTo(bodyCenter.z)
  })

  it('refreshes physical worker counters at a paused first-removal checkpoint', () => {
    const drawn: string[] = []
    const { module, sim } = fixture(text => drawn.push(text))
    const worker = sim.state.autovac.workers[0]
    Object.assign(worker, { active: true, table: 3, phase: 'scan_heap', deadCollected: 0 })
    module.update(0.21, sim.state, 1)
    drawn.length = 0
    Object.assign(worker, { phase: 'vacuum_heap', deadCollected: 67.89263992786228 })
    // A final render after a native step may receive no elapsed model time.
    module.update(0, sim.state, 1)
    expect(drawn).toContain('68 dead tuples')
    expect(drawn.some(text => text.includes('vacuum_heap'))).toBe(true)
    drawn.length = 0
    module.update(0, sim.state, 1)
    expect(drawn).toEqual([]) // unchanged captions must not repaint the atlas
    worker.deadCollected = 1
    module.update(0, sim.state, 1)
    expect(drawn).toContain('1 dead tuples')
    drawn.length = 0
    worker.active = false
    module.update(0, sim.state, 1)
    expect(drawn).toContain('AV-0 idle')
    expect(drawn).toContain('in bay')
  })

  it('fits the lift cars in the open corridor outside the OS cache slab', () => {
    for (let slot = 0; slot < 3; slot++) {
      expect(vacuumLiftZ(slot) - 4.7).toBeGreaterThan(-CITY.pit.z)
      expect(vacuumLiftZ(slot) + 4.7).toBeLessThan(CITY.pit.z)
    }
    for (let slot = 0; slot < 3; slot++) {
      expect(Math.abs(vacuumLiftX(slot)) + 4.7).toBeLessThan(CITY.pit.x)
      expect(vacuumLiftZ(slot) + 4.7).toBeLessThan(-CITY.osCache.d / 2)
    }
  })

  it('keeps the service route clear of gantry head houses and plaza pylons', () => {
    const p = new THREE.Vector3()
    for (let slot = 0; slot < 3; slot++) for (let table = 0; table < 5; table++) {
      for (let n = 0; n <= 200; n++) {
        vacuumServicePoint(slot, table, n / 200, p)
        if (p.y > VACUUM_SERVICE.workY + 0.1) continue
        for (let t = 0; t < 5; t++) {
          expect(Math.abs(p.x - tableX(t)) > 6.3 || Math.abs(p.z + 60) > 6,
            `slot ${slot}, table ${table}, sample ${n}: gantry`).toBe(true)
        }
        for (const x of [-58, -20, 20, 58]) for (const z of [-44, 44]) {
          expect(Math.abs(p.x - x) > 8.6 || Math.abs(p.z - z) > 8.6).toBe(true)
        }
      }
    }
  })

  it('clears instantiated storage solids along every worker route', () => {
    const { module, sim } = fixture()
    const theme = createTheme()
    const storage = createStorage({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      bus: createBus(), sim: sim.state, theme,
      quality: { level: 'high', pixelRatio: 1, bloom: true, shadows: true, maxParticles: 1, maxLabels: 1, antialias: true },
      register: () => {}, flow: () => {} })
    dispose.push(() => { storage.dispose?.(); theme.dispose() })
    for (let frame = 0; frame < 120; frame++) storage.update(1 / 30, sim.state, frame / 30)
    storage.group.updateMatrixWorld(true)
    const solids: THREE.Box3[] = []
    const matrix = new THREE.Matrix4()
    const gather = (object: THREE.Object3D, maintenance = false): void => {
      if (maintenance && object instanceof THREE.InstancedMesh && object.instanceMatrix.usage === THREE.DynamicDrawUsage) return
      if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BoxGeometry) && !(maintenance && object instanceof THREE.InstancedMesh) || object.name === 'autovac.worker-lifts') return
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      if (materials.every(material => !material.visible)) return
      object.geometry.computeBoundingBox()
      if (object instanceof THREE.InstancedMesh) {
        for (let i = 0; i < object.count; i++) {
          object.getMatrixAt(i, matrix)
          matrix.premultiply(object.matrixWorld)
          solids.push(object.geometry.boundingBox!.clone().applyMatrix4(matrix))
        }
      } else solids.push(object.geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld))
    }
    storage.group.traverse(gather)
    module.group.updateMatrixWorld(true)
    module.group.traverse(object => {
      if (object.parent?.name.startsWith('autovac.worker.')) return
      gather(object, true)
    })
    expect(solids.length).toBeGreaterThan(100)
    const p = new THREE.Vector3()
    const failures: string[] = []
    for (let slot = 0; slot < 3; slot++) for (let table = 0; table < 5; table++) {
      for (let sample = 0; sample <= 400; sample++) {
        vacuumServicePoint(slot, table, sample / 400, p)
        for (const box of solids) {
          // Circular bumper footprint, including the full height of its chassis.
          if (box.max.y <= p.y + 0.35 || box.min.y >= p.y + 2.31) continue
          const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x)
          const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z)
          if (dx * dx + dz * dz < 3.6 ** 2 - 0.001) {
            failures.push(`${slot}/${table}/${sample}: robot ${p.toArray()} solid ${box.min.toArray()}..${box.max.toArray()}`)
            break
          }
        }
        if (failures.length >= 12) break
      }
      if (failures.length >= 12) break
    }
    expect(failures).toEqual([])
  })

  it('clears the actual island rim and access stairs across every service route', async () => {
    const city = await createWalkCityHarness()
    try {
      city.scene.updateMatrixWorld(true)
      const solids: THREE.Triangle[] = []
      city.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !object.name.match(/^(ground\.rim|access\.(steel|struct|surfaces|treads))$/)) return
        const geometry = object.geometry, positions = geometry.getAttribute('position'), indices = geometry.index
        for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
          const vertex = (n: number): THREE.Vector3 => new THREE.Vector3()
            .fromBufferAttribute(positions, indices ? indices.getX(n) : n).applyMatrix4(object.matrixWorld)
          solids.push(new THREE.Triangle(vertex(i), vertex(i + 1), vertex(i + 2)))
        }
      })
      expect(solids.length).toBeGreaterThan(100)
      const p = new THREE.Vector3(), box = new THREE.Box3(), failures: string[] = []
      for (let slot = 0; slot < 3; slot++) for (let table = 0; table < 5; table++) {
        for (let step = 0; step <= 300; step++) {
          vacuumServicePoint(slot, table, step / 300, p)
          // Inscribed chassis box: an intersection is inside the round bumper, not its bounding-box corners.
          box.min.set(p.x - 2.4, p.y + 0.36, p.z - 2.4)
          box.max.set(p.x + 2.4, p.y + 0.94, p.z + 2.4)
          if (solids.some(triangle => box.intersectsTriangle(triangle))) {
            failures.push(`${slot}/${table}/${step}: ${p.toArray()}`)
            break
          }
        }
      }
      expect(failures).toEqual([])
    } finally { city.dispose() }
  })

  it('keeps rotating side brushes clear of the actual lift guides', () => {
    const { module, sim } = fixture()
    module.setDetail?.(2)
    module.group.updateMatrixWorld(true)
    const service = module.group.getObjectByName('autovac.service-lanes')!
    const guides = service.children.find(object => object instanceof THREE.InstancedMesh &&
      object.name !== 'autovac.worker-lifts') as THREE.InstancedMesh
    const brushes = module.group.getObjectByName('autovac.workers.brushes') as THREE.InstancedMesh
    const transform = new THREE.Matrix4(), triangle = new THREE.Triangle()
    guides.geometry.computeBoundingBox()
    const boxes = Array.from({ length: guides.count }, (_, i) => {
      guides.getMatrixAt(i, transform)
      return guides.geometry.boundingBox!.clone().applyMatrix4(transform)
    })
    expect(boxes.length).toBe(12)
    const positions = brushes.geometry.getAttribute('position'), indices = brushes.geometry.index
    const failures: string[] = []
    for (let slot = 0; slot < 3; slot++) {
      const worker = sim.state.autovac.workers[slot]
      worker.active = true
      worker.table = 0
      for (const phase of ['travel', 'scan_heap', 'vacuum_index', 'vacuum_heap', 'return'] as const) {
        worker.phase = phase
        for (let n = 0; n <= 100; n++) {
          worker.progress = worker.travel = n / 100
          module.update(1 / 30, sim.state, n / 30)
          for (let brush = slot * 6; brush < slot * 6 + 6; brush++) {
            brushes.getMatrixAt(brush, transform)
            for (let i = 0; i < (indices?.count ?? positions.count); i += 3) {
              triangle.a.fromBufferAttribute(positions, indices ? indices.getX(i) : i).applyMatrix4(transform)
              triangle.b.fromBufferAttribute(positions, indices ? indices.getX(i + 1) : i + 1).applyMatrix4(transform)
              triangle.c.fromBufferAttribute(positions, indices ? indices.getX(i + 2) : i + 2).applyMatrix4(transform)
              if (boxes.some(box => box.intersectsTriangle(triangle))) failures.push(`${slot}/${phase}/${n}/${brush}`)
            }
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('updates aggregate removal only when collection occurs, not during the depot return', () => {
    const { module, sim } = fixture()
    const worker = sim.state.autovac.workers[0]
    worker.active = true
    worker.table = 0
    const pile = module.group.getObjectByName('landfill')!.children.find(
      object => object instanceof THREE.InstancedMesh && object.count === 303) as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    const live = (): number => {
      let count = 0
      for (let i = 3; i < pile.count; i++) {
        pile.getMatrixAt(i, matrix)
        if (new THREE.Vector3().setFromMatrixScale(matrix).length() > 0.01) count++
      }
      return count
    }
    worker.phase = 'vacuum_heap'
    worker.deadCollected = 0
    module.update(1 / 30, sim.state, 1)
    expect(live()).toBe(0)
    worker.deadCollected = 100
    module.update(1 / 30, sim.state, 2)
    const collected = live()
    expect(collected).toBeGreaterThan(0)
    worker.phase = 'return'
    worker.progress = 0.9
    module.update(1 / 30, sim.state, 3)
    expect(live()).toBe(collected)
  })

  it('keeps native simultaneous dispatch and return clear across the fleet', () => {
    const { module, sim } = fixture()
    sim.runScenario('bloat-and-vacuum')
    const matrix = new THREE.Matrix4()
    const centers = Array.from({ length: 3 }, () => new THREE.Vector3())
    const seen = new Set<number>()
    let concurrentWork = false
    for (let frame = 0; frame < 90000; frame++) {
      sim.update(1 / 30)
      module.update(1 / 30, sim.state, sim.state.t)
      const workers = sim.state.autovac.workers
      if (workers.filter(w => w.active && w.phase !== 'travel' && w.phase !== 'return').length > 1) concurrentWork = true
      for (let slot = 0; slot < 3; slot++) {
        const body = module.group.getObjectByName(`autovac.worker.${slot}`)!.children[0] as THREE.InstancedMesh
        body.getMatrixAt(1, matrix)
        centers[slot].setFromMatrixPosition(matrix)
        if (workers[slot].phase === 'return') seen.add(slot)
      }
      for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
        expect(centers[a].distanceTo(centers[b]),
          `t=${sim.state.t} slots=${a}/${b} phases=${workers[a].phase}/${workers[b].phase}`,
        ).toBeGreaterThan(9.52)
      }
    }
    expect(concurrentWork).toBe(true)
    expect([...seen].sort(), JSON.stringify(sim.state.autovac.workers)).toEqual([0, 1, 2])
  })

  it('keeps concurrently working relations on separate lanes', () => {
    const { module, sim } = fixture()
    const matrix = new THREE.Matrix4()
    const centers = [new THREE.Vector3(), new THREE.Vector3()]
    for (let first = 0; first < 5; first++) for (let second = first + 1; second < 5; second++) {
      for (const [slot, table] of [first, second].entries()) {
        const worker = sim.state.autovac.workers[slot]
        worker.active = true
        worker.table = table
        worker.phase = 'scan_heap'
        worker.progress = 0.5
      }
      module.update(1 / 30, sim.state, 1)
      for (let slot = 0; slot < 2; slot++) {
        const body = module.group.getObjectByName(`autovac.worker.${slot}`)!.children[0] as THREE.InstancedMesh
        body.getMatrixAt(1, matrix)
        centers[slot].setFromMatrixPosition(matrix)
      }
      expect(centers[0].distanceTo(centers[1]), `${first}/${second}: overlapping work lanes`).toBeGreaterThan(9.52)
    }
  })

  it('keeps fixed road and curb faces outside each full moving lift footprint', () => {
    const { module } = fixture()
    const deck = module.group.getObjectByName('autovac.service-decks') as THREE.Mesh
    const positions = deck.geometry.getAttribute('position'), triangle = new THREE.Triangle()
    const failures: string[] = []
    for (let slot = 0; slot < 3; slot++) {
      const x = vacuumLiftX(slot), z = vacuumLiftZ(slot), half = VACUUM_SERVICE.liftWidth / 2 - 0.01
      const shaft = new THREE.Box3(
        new THREE.Vector3(x - half, VACUUM_SERVICE.workY - 0.4, z - half),
        new THREE.Vector3(x + half, VACUUM_SERVICE.surfaceY + 0.025, z + half))
      for (let i = 0; i < positions.count; i += 3) {
        triangle.a.fromBufferAttribute(positions, i)
        triangle.b.fromBufferAttribute(positions, i + 1)
        triangle.c.fromBufferAttribute(positions, i + 2)
        if (shaft.intersectsTriangle(triangle)) failures.push(`${slot}/${i}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('lands each lift when frame progress skips its endpoint', () => {
    const { module, sim } = fixture()
    const lifts = module.group.getObjectByName('autovac.worker-lifts') as THREE.InstancedMesh
    const transform = new THREE.Matrix4()
    for (let slot = 0; slot < sim.state.autovac.workers.length; slot++) {
      const worker = sim.state.autovac.workers[slot]
      worker.active = true
      worker.table = 0
      for (const phase of ['travel', 'return'] as const) {
        worker.phase = phase
        for (const progress of phase === 'travel' ? [0.64, 0.655] : [0.54, 0.555]) {
          worker.travel = worker.progress = progress
          module.update(1 / 30, sim.state, progress)
        }
        lifts.getMatrixAt(slot, transform)
        const carTop = new THREE.Vector3().setFromMatrixPosition(transform).y + 0.2
        expect(carTop, `${slot}/${phase}: lift must reach destination before departure`).toBeCloseTo(
          (phase === 'travel' ? VACUUM_SERVICE.workY : VACUUM_SERVICE.surfaceY) + 0.025, 4)
      }
    }
  })

  it('keeps robots upright with wheel contact on service lanes and lifts', () => {
    const { module, sim } = fixture()
    const ray = new THREE.Raycaster()
    const matrix = new THREE.Matrix4()
    for (let slot = 0; slot < 3; slot++) for (let table = 0; table < 5; table++) for (const phase of ['travel', 'scan_heap', 'vacuum_index', 'vacuum_heap', 'return'] as const) {
      const worker = sim.state.autovac.workers[slot]
      worker.active = true
      worker.table = table
      worker.phase = phase
      for (let n = 0; n <= 20; n++) {
        worker.travel = worker.progress = n / 20
        module.update(1 / 30, sim.state, n / 30)
        module.group.updateMatrixWorld(true)
        const body = module.group.getObjectByName(`autovac.worker.${slot}`)!.children[0] as THREE.InstancedMesh
        body.getMatrixAt(0, matrix)
        const base = new THREE.Vector3().setFromMatrixPosition(matrix)
        base.y -= VACUUM_ROBOT_BODY[0][1]
        expect(new THREE.Vector3().setFromMatrixColumn(matrix, 1).normalize().y).toBeCloseTo(1, 5)
        const road = module.group.getObjectByName('autovac.service-lanes')
        expect(road, 'the robot needs a physical supporting surface').toBeDefined()
        ray.set(new THREE.Vector3(base.x, base.y + 1, base.z), new THREE.Vector3(0, -1, 0))
        const hits = ray.intersectObject(road!, true)
        expect(hits.length, `${table}/${phase}/${n}: unsupported robot`).toBeGreaterThan(0)
        expect(hits[0].point.y, `${table}/${phase}/${n}: wheel contact`).toBeCloseTo(base.y + 0.025, 2)
      }
    }
  })

  it('keeps overlapping disc tops at distinct heights to avoid flicker', () => {
    for (let a = 0; a < VACUUM_ROBOT_BODY.length; a++) {
      for (let b = a + 1; b < VACUUM_ROBOT_BODY.length; b++) {
        const x = VACUUM_ROBOT_BODY[a], y = VACUUM_ROBOT_BODY[b]
        if (Math.hypot(x[0] - y[0], x[2] - y[2]) >= (x[3] + y[3]) / 2) continue
        expect(Math.abs(y1(x) - y1(y))).toBeGreaterThan(0.001)
      }
    }
  })

  it('keeps every physical caption within the signage atlas', () => {
    const { module } = fixture()
    let atlases = 0
    module.group.traverse((object) => {
      if (object.name !== 'maintenance.signage.walk') return
      const uv = (object as THREE.Mesh).geometry.getAttribute('uv')
      atlases++
      for (let i = 0; i < uv.count; i++) {
        expect(uv.getY(i)).toBeGreaterThanOrEqual(0)
        expect(uv.getY(i)).toBeLessThanOrEqual(1)
      }
    })
    expect(atlases).toBe(2)
  })

  it('ties dock indication to its worker rather than decorative charging', () => {
    const { module, sim } = fixture()
    const lamps = module.group.getObjectByName('autovac.docks.state') as THREE.InstancedMesh
    const idle = new THREE.Color(), active = new THREE.Color(), held = new THREE.Color()
    lamps.getColorAt(0, idle)
    const worker = sim.state.autovac.workers[0]
    worker.active = true
    worker.phase = 'scan_heap'
    worker.table = 0
    module.update(1 / 30, sim.state, 1)
    lamps.getColorAt(0, active)
    expect(active.equals(idle)).toBe(false)
    worker.stalledByHorizon = true
    module.update(1 / 30, sim.state, 2)
    lamps.getColorAt(0, held)
    expect(held.equals(active)).toBe(false)
    expect(worker.deadCollected).toBe(0)
  })

  it('fits a low circular chassis on each dock tray with an open east exit', () => {
    const radius = Math.max(...VACUUM_ROBOT_BODY.map((part) => Math.max(part[3], part[5]) / 2))
    const height = Math.max(...VACUUM_ROBOT_BODY.map((part) => y1(part)))
    expect(height / (radius * 2)).toBeLessThan(0.4)

    for (const [slot, dock] of VACUUM_DOCKS.entries()) {
      const bay = vacBayPos(slot)
      expect(dock.center).toEqual([bay[0] - 4, bay[2]])
      const [x, z] = dock.center
      expect(x0(dock.tray)).toBeLessThan(x - radius)
      expect(x1(dock.tray)).toBeGreaterThan(x + radius)
      expect(z0(dock.tray)).toBeLessThan(z - radius)
      expect(z1(dock.tray)).toBeGreaterThan(z + radius)
      expect(x1(dock.housing)).toBeLessThan(x - radius - 0.2)
      expect(y1(dock.housing)).toBeGreaterThan(height * 3)
      expect(x0(dock.housing)).toBeGreaterThanOrEqual(x0(dock.tray))
    }
  })

  it('draws the worker as a disc and keeps dock architecture visible at city distance', () => {
    const { module, components } = fixture()
    const worker = components.get('autovac.worker.0')!.object
    const body = new THREE.Box3().setFromObject(worker)
    const size = body.getSize(new THREE.Vector3())
    expect(size.x / size.z).toBeCloseTo(1, 1)
    expect(size.y / size.x).toBeLessThan(0.4)

    module.setDetail?.(0)
    const dock = module.group.getObjectByName('autovac.docks.housing')!
    expect(dock.visible).toBe(true)
    expect(new THREE.Box3().setFromObject(dock).getSize(new THREE.Vector3()).y).toBeGreaterThan(10)
  })

  it('uses the measured shells for geometry and collision without closing the exit', () => {
    const { module } = fixture()
    const housing = module.group.getObjectByName('autovac.docks.housing') as THREE.InstancedMesh
    const collisions = module.group.userData.collisionBoxes as THREE.Box3[]
    housing.geometry.computeBoundingBox()
    const transform = new THREE.Matrix4()
    for (const [slot, dock] of VACUUM_DOCKS.entries()) {
      housing.getMatrixAt(slot, transform)
      const bounds = housing.geometry.boundingBox!.clone().applyMatrix4(transform)
      const [x, y, z, width, height, depth] = dock.housing
      expect(bounds.min.x).toBeCloseTo(x - width / 2, 4)
      expect(bounds.max.y).toBeCloseTo(y + height / 2, 4)
      expect(bounds.max.z).toBeCloseTo(z + depth / 2, 4)
      expect(collisions.some((box) => box.containsPoint(new THREE.Vector3(x, y, z)))).toBe(true)
      for (let dx = 0; dx <= 8; dx += 2) {
        const exit = new THREE.Vector3(dock.center[0] + dx, 2, dock.center[1])
        expect(collisions.some((box) => box.containsPoint(exit))).toBe(false)
      }
    }
  })

  it('visits the heap even when xmin prevents collection and returns to its existing bay', () => {
    const { module, sim, components } = fixture()
    const worker = sim.state.autovac.workers[0]
    const focus = components.get('autovac.worker.0')!.focus!.target
    const originalBay = [...focus]
    const tablesBefore = JSON.stringify(sim.state.tables)
    worker.active = true
    worker.table = 0
    worker.phase = 'travel'
    worker.travel = 0.6
    worker.stalledByHorizon = true
    for (let frame = 0; frame < 30; frame++) module.update(1 / 30, sim.state, frame / 30)
    expect(focus[0]).toBeGreaterThan(originalBay[0] + 20)

    worker.phase = 'scan_heap'
    worker.progress = 0.5
    for (let frame = 0; frame < 30; frame++) module.update(1 / 30, sim.state, 1 + frame / 30)
    const lamps = module.group.getObjectByName('autovac.workers.indicators') as THREE.InstancedMesh
    const matrix = new THREE.Matrix4()
    lamps.getMatrixAt(0, matrix)
    expect(new THREE.Vector3().setFromMatrixScale(matrix).x).toBeLessThan(0.1)
    expect(components.get('autovac.worker.0')!.readout!(sim.state)).toContain('0 dead tuples collected')

    worker.phase = 'return'
    worker.progress = 1
    module.update(0.25, sim.state, 3)
    worker.active = false
    worker.phase = 'idle'
    worker.stalledByHorizon = false
    for (let frame = 0; frame < 180; frame++) module.update(1 / 30, sim.state, 3 + frame / 30)
    expect(focus[0]).toBeCloseTo(originalBay[0], 1)
    expect(focus[2]).toBeCloseTo(originalBay[2], 1)
    expect(JSON.stringify(sim.state.tables)).toBe(tablesBefore)
  })

  it('keeps partial cleanup visible when xmin still protects newer row versions', () => {
    const { module, sim, components } = fixture()
    const worker = sim.state.autovac.workers[0]
    worker.active = true
    worker.table = 0
    worker.phase = 'vacuum_heap'
    worker.stalledByHorizon = true
    worker.deadCollected = 1200
    sim.state.tables[0].deadTuples = 10000
    sim.state.oldestSnapshotAge = 90
    for (let i = 0; i < 120; i++) module.update(1 / 30, sim.state, i / 30)
    const lamps = module.group.getObjectByName('autovac.workers.indicators') as THREE.InstancedMesh
    const transform = new THREE.Matrix4()
    lamps.getMatrixAt(0, transform)
    expect(new THREE.Vector3().setFromMatrixScale(transform).x).toBeGreaterThan(0.3)
    const readout = components.get('autovac.worker.0')!.readout!(sim.state)
    expect(readout).toContain(`${fmtNum(1200)} dead tuples collected`)
    expect(readout).toContain('xmin limits removal')
    expect(readout).not.toContain('0 of')
  })

  it('does not fill the collection indicator merely because heap scanning advanced', () => {
    const { module, sim } = fixture()
    const worker = sim.state.autovac.workers[0]
    worker.active = true
    worker.table = 0
    worker.phase = 'scan_heap'
    worker.progress = 0.9
    worker.deadCollected = 0
    worker.stalledByHorizon = false
    sim.state.oldestSnapshotAge = 0
    for (let i = 0; i < 120; i++) module.update(1 / 30, sim.state, i / 30)
    const lamps = module.group.getObjectByName('autovac.workers.indicators') as THREE.InstancedMesh
    const transform = new THREE.Matrix4()
    lamps.getMatrixAt(0, transform)
    expect(new THREE.Vector3().setFromMatrixScale(transform).x).toBeLessThanOrEqual(0.021)
  })

  it('reports eligible cleanup from the real blockade scenario without claiming everything is removable', () => {
    const { module, sim, components } = fixture()
    sim.runScenario('vacuum-blockade')
    let slot = -1
    for (let step = 0; step < 30000 && slot < 0; step++) {
      sim.update(1 / 30)
      slot = sim.state.autovac.workers.findIndex((worker) => worker.active && worker.stalledByHorizon && worker.deadCollected > 0)
    }
    expect(slot).toBeGreaterThanOrEqual(0)
    const worker = sim.state.autovac.workers[slot]
    expect(sim.state.tables[worker.table].deadTuples).toBeGreaterThan(worker.deadCollected)
    module.update(1 / 30, sim.state, 0)
    const readout = components.get(`autovac.worker.${slot}`)!.readout!(sim.state)
    expect(readout).toContain(`${fmtNum(worker.deadCollected)} dead tuples collected`)
    expect(readout).toContain('xmin limits removal')
    expect(readout).not.toContain('0 of')
  }, 30000)
})
