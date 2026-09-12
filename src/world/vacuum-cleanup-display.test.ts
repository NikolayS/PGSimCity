import { describe, expect, it } from 'vitest'

import { VacuumCleanupDisplay } from './vacuum-cleanup-display'

const tables = (dead = 1_200) => [{ deadTuples: dead }]
const workers = () => [{ active: false, table: 0, phase: 'idle', deadCollected: 0 }]

describe('VacuumCleanupDisplay', () => {
  it('exposes empty slots only after observed reclamation, not from unused display capacity', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables(0)
    const fleet = workers()
    display.reset(relation, fleet)
    expect(display.displayedSlots(0)).toBe(0)
    relation[0].deadTuples = 5
    Object.assign(fleet[0], { active: true, phase: 'vacuum_heap' })
    display.sync(relation, fleet)
    expect(display.displayedSlots(0)).toBe(5)
    expect(display.markerCount(0)).toBe(5)
    relation[0].deadTuples = 2
    fleet[0].deadCollected = 3
    display.sync(relation, fleet)
    expect(display.displayedSlots(0)).toBe(5)
    expect(display.markerCount(0)).toBe(2)
    display.reset(relation, fleet)
    expect(display.displayedSlots(0)).toBe(display.markerCount(0))
  })

  it('removes markers only for a same-task collection delta during vacuum_heap', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables()
    const fleet = workers()
    display.reset(relation, fleet)
    const initial = display.markerCount(0)

    Object.assign(fleet[0], { active: true, phase: 'scan_heap', deadCollected: 600 })
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBe(initial)

    fleet[0].phase = 'vacuum_heap'
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBe(initial)

    fleet[0].deadCollected = 800
    relation[0].deadTuples = 1_000
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBeLessThan(initial)
  })

  it('does not remove markers for time, stalls, phase changes, or counter resets', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables()
    const fleet = workers()
    display.reset(relation, fleet)
    const initial = display.markerCount(0)

    Object.assign(fleet[0], { active: true, phase: 'scan_heap', deadCollected: 700 })
    display.sync(relation, fleet)
    display.sync(relation, fleet)
    fleet[0].phase = 'return'
    fleet[0].deadCollected = 900
    display.sync(relation, fleet)
    Object.assign(fleet[0], { active: false, phase: 'idle', deadCollected: 0 })
    display.sync(relation, fleet)

    expect(display.markerCount(0)).toBe(initial)
  })

  it('retains a representative marker while dead versions remain and resets cleanly', () => {
    const display = new VacuumCleanupDisplay(1, 1, 4)
    const relation = tables(400)
    const fleet = workers()
    display.reset(relation, fleet)
    Object.assign(fleet[0], { active: true, phase: 'vacuum_heap', deadCollected: 0 })
    display.sync(relation, fleet)
    fleet[0].deadCollected = 10_000
    relation[0].deadTuples = 1
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBe(1)

    relation[0].deadTuples = 240
    Object.assign(fleet[0], { active: false, phase: 'idle', deadCollected: 0 })
    display.reset(relation, fleet)
    expect(display.markerCount(0)).toBeGreaterThan(1)
    expect(display.tuplesPerMarker(0)).toBe(60)
  })

  it('rebases once when a worker acquires a grown table and keeps that task scale', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables(0)
    const fleet = workers()
    display.reset(relation, fleet)
    relation[0].deadTuples = 100_000
    display.sync(relation, fleet)

    Object.assign(fleet[0], { active: true, phase: 'travel', deadCollected: 0 })
    display.sync(relation, fleet)
    const scale = display.tuplesPerMarker(0)
    expect(scale).toBe(8_334)

    Object.assign(fleet[0], { phase: 'vacuum_heap', deadCollected: 100 })
    relation[0].deadTuples -= 100
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBe(12)
    expect(display.tuplesPerMarker(0)).toBe(scale)
  })

  it('credits the final collection delta when the worker leaves vacuum_heap', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables(500)
    const fleet = workers()
    display.reset(relation, fleet)
    Object.assign(fleet[0], { active: true, phase: 'vacuum_heap', deadCollected: 0 })
    display.sync(relation, fleet)

    Object.assign(fleet[0], { phase: 'return', deadCollected: 500 })
    relation[0].deadTuples = 0
    display.sync(relation, fleet)
    expect(display.markerCount(0)).toBe(0)
  })

  it('rebases an active slot when its collection counter decreases for a new task', () => {
    const display = new VacuumCleanupDisplay(1, 1, 12)
    const relation = tables(1_200)
    const fleet = workers()
    display.reset(relation, fleet)
    Object.assign(fleet[0], { active: true, phase: 'vacuum_heap', deadCollected: 600 })
    display.sync(relation, fleet)

    relation[0].deadTuples = 24_000
    fleet[0].deadCollected = 0
    display.sync(relation, fleet)
    expect(display.tuplesPerMarker(0)).toBe(2_000)
    expect(display.markerCount(0)).toBe(12)
  })
})
