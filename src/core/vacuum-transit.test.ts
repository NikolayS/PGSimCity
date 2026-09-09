import { describe, expect, it } from 'vitest'
import type { VacWorker } from './types'
import { vacuumTransitOwner, vacuumTransitQueued } from './vacuum-transit'

const worker = (slot: number, phase: VacWorker['phase'], progress = 0): VacWorker => ({
  slot, phase, progress, active: phase !== 'idle', table: slot,
  travel: phase === 'return' ? 1 - progress : progress,
  vacuumDelay: false, deadCollected: 0, stalledByHorizon: false,
})

describe('illustrative vacuum transit admission', () => {
  it('admits one departure without mutating any worker or inventing a cost delay', () => {
    const workers = [worker(0, 'travel'), worker(1, 'travel'), worker(2, 'scan_heap', .4)]
    const before = structuredClone(workers)
    expect(vacuumTransitOwner(workers)).toBe(0)
    expect(workers.map((_, i) => vacuumTransitQueued(workers, i))).toEqual([false, true, false])
    expect(workers).toEqual(before)
  })

  it('does not preempt a trip for a newly ready return or lower slot', () => {
    const workers = [worker(0, 'return'), worker(1, 'travel', .9), worker(2, 'travel')]
    expect(vacuumTransitOwner(workers)).toBe(1)
    workers[1] = worker(1, 'scan_heap')
    expect(vacuumTransitOwner(workers)).toBe(0)
    workers[0] = worker(0, 'idle')
    expect(vacuumTransitOwner(workers)).toBe(2)
  })

  it('needs no hidden reservation state after reset or serialization', () => {
    const workers = [worker(0, 'vacuum_heap', .8), worker(1, 'return', .3), worker(2, 'travel')]
    expect(vacuumTransitOwner(structuredClone(workers))).toBe(1)
    expect(vacuumTransitOwner(workers.map((_, i) => worker(i, 'idle')))).toBe(-1)
  })
})
