import type { SimState } from '../core/types'
import { fmtNum } from '../core/util'

export function vacuumIndicatorSpace(top: number, bottom: number): number {
  return bottom - top >= 200 ? 90 : 0
}

/** Current table-specific facts, never inferred from landfill or saved cards. */
export function vacuumCityReading(state: SimState) {
  const table = state.tables.findIndex(t => t.def.id === 'sessions')
  const slot = state.autovac.workers.findIndex(w => w.active && w.table === table
    && w.phase !== 'travel' && w.phase !== 'return' && w.phase !== 'idle')
  const worker = state.autovac.workers[slot]
  const decision = state.scenarioDecision
  const reclaimed = decision?.kind === 'vacuum-blockade' ? decision.sessionsReclaimedAfterRelease : 0
  return {
    workerId: worker ? `autovac.worker.${slot}` : null,
    pinned: state.knobs.longRunningXact,
    constrained: !!worker?.stalledByHorizon,
    collected: reclaimed > 0,
    work: worker
      ? `AV-${slot} · ${worker.phase.replaceAll('_', ' ')}${worker.stalledByHorizon ? ' · horizon limits removal' : ''} · ${fmtNum(worker.deadCollected)} collected this pass`
      : `No worker on sessions now${reclaimed > 0 ? ' · previous collection remains counted' : ''}`,
    collection: `${fmtNum(reclaimed)} sessions versions reclaimed after release`,
  }
}
