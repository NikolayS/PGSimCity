import type { SimApi } from '../core/types'

export type VacuumCheckpointKind = 'pinned' | 'released' | 'eligible' | 'collected'
export interface VacuumCheckpoint {
  readonly kind: VacuumCheckpointKind
  readonly time: number
  readonly horizon: number
  readonly pinned: boolean
  readonly reclaimed: number
  readonly deadRows: number
  readonly pages: number
}
export type ObservationStatus = 'idle' | 'running' | 'observed' | 'cancelled' | 'exhausted' | 'unavailable'

/* Observation is over the existing model, never a second simulation. Batches
 * yield to the caller for cancellation; every 0.1 s uses normal subdivisions. */
export function createVacuumObservation(sim: SimApi) {
  const owner = sim.state.scenarioDecision
  const tableIndex = sim.state.tables.findIndex(t => t.def.id === 'sessions')
  const checkpoints: VacuumCheckpoint[] = []
  let status: ObservationStatus = 'idle'
  let steps = 0
  let advanced = 0
  const valid = () => owner?.kind === 'vacuum-blockade'
    && sim.state.scenarioDecision === owner && sim.state.scenario === 'vacuum-blockade'

  function observe(): boolean {
    if (!valid() || owner?.kind !== 'vacuum-blockade') return false
    const state = sim.state
    const table = state.tables[tableIndex]
    let kind: VacuumCheckpointKind | undefined
    const previous = checkpoints.at(-1)
    if (!previous && state.knobs.longRunningXact && owner.phase === 'ready') kind = 'pinned'
    else if (previous?.kind === 'pinned' && !state.knobs.longRunningXact) kind = 'released'
    else if (previous?.kind === 'released' && !state.knobs.longRunningXact
      && state.xminHorizon > checkpoints[0].horizon) kind = 'eligible'
    else if (previous?.kind === 'eligible' && !state.knobs.longRunningXact
      && owner.sessionsReclaimedAfterRelease > 0 && owner.phase === 'recovered') kind = 'collected'
    if (!kind) return false
    checkpoints.push(Object.freeze({ kind, time: state.scenarioT, horizon: state.xminHorizon,
      pinned: state.knobs.longRunningXact, reclaimed: owner.sessionsReclaimedAfterRelease,
      deadRows: table.deadTuples, pages: table.pages }))
    return true
  }

  return {
    get checkpoints(): readonly VacuumCheckpoint[] { return checkpoints },
    get status(): ObservationStatus { return status },
    get advanced(): number { return advanced },
    observe,
    start(): boolean {
      if (status === 'running' || !valid() || !sim.state.knobs.paused || checkpoints.at(-1)?.kind === 'collected') return false
      steps = 0
      advanced = 0
      status = observe() ? 'observed' : 'running'
      return true
    },
    cancel(): void { if (status === 'running') status = 'cancelled' },
    tick(): void {
      if (status !== 'running') return
      if (!valid() || !sim.state.knobs.paused) { status = 'unavailable'; return }
      if (observe()) { status = 'observed'; return }
      for (let i = 0; i < 100 && steps < 9000; i++) {
        const duration = sim.advance(0.1)
        if (duration <= 0) { status = 'unavailable'; return }
        advanced += duration
        steps++
        if (observe()) { status = 'observed'; return }
      }
      if (steps >= 9000) status = 'exhausted'
    },
  }
}
