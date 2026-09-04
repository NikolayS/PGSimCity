import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef } from '../core/types'
import { fmtNum } from '../core/util'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { vacBayPos } from './layout'
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

  function fixture() {
    installTestDom({ canvas2d: true })
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
