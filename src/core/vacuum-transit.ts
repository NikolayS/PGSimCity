import type { VacWorker } from './types'

/** City-road staging, not a PostgreSQL lock or cost-delay mechanism. */
export function vacuumTransitOwner(workers: readonly VacWorker[]): number {
  let waiting = -1
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i]
    if (!w.active || (w.phase !== 'travel' && w.phase !== 'return')) continue
    // An admitted trip cannot be preempted midway along a shared road.
    if (w.progress > 0) return i
    if (waiting < 0 || (w.phase === 'return' && workers[waiting].phase !== 'return')) waiting = i
  }
  return waiting
}

export function vacuumTransitQueued(workers: readonly VacWorker[], slot: number): boolean {
  const w = workers[slot]
  return !!w?.active && (w.phase === 'travel' || w.phase === 'return')
    && vacuumTransitOwner(workers) !== slot
}
