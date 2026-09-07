export const VACUUM_EVIDENCE = ['table', 'worker', 'snapshot', 'owner'] as const
export type VacuumEvidenceId = typeof VACUUM_EVIDENCE[number]
export type VacuumLessonMode = 'guided' | 'challenge'
export type VacuumCause = 'disabled' | 'snapshot' | 'capacity'
export type VacuumAction = 'terminate' | 'wait'

export interface VacuumReading {
  time: number
  deadRows: number
  initialDeadRows: number
  pages: number
  initialPages: number
  scanObserved: boolean
  snapshotAge: number
  horizon: number
  pinned: boolean
  decisionReady: boolean
  reclaimed: number
  recovered: boolean
}

export interface VacuumLessonState {
  mode: VacuumLessonMode
  phase: 'investigating' | 'observing' | 'complete'
  evidence: Partial<Record<VacuumEvidenceId, { time: number; text: string }>>
  cause: VacuumCause | null
  action: VacuumAction | null
}

export function createVacuumLessonState(mode: VacuumLessonMode): VacuumLessonState {
  return { mode, phase: 'investigating', evidence: {}, cause: null, action: null }
}

export function vacuumEvidenceAvailable(id: VacuumEvidenceId, reading: VacuumReading): boolean {
  switch (id) {
    case 'table': return reading.deadRows > reading.initialDeadRows
    case 'worker': return reading.scanObserved
    case 'snapshot': return reading.pinned && reading.snapshotAge > 0
    case 'owner': return reading.pinned && reading.snapshotAge > 0
  }
}

export function collectVacuumEvidence(
  state: VacuumLessonState,
  id: VacuumEvidenceId,
  reading: VacuumReading,
  text: string,
): VacuumLessonState {
  if (state.phase !== 'investigating' || state.evidence[id] || !vacuumEvidenceAvailable(id, reading)) return state
  return { ...state, evidence: { ...state.evidence, [id]: { time: reading.time, text } } }
}

export function selectVacuumCause(state: VacuumLessonState, cause: VacuumCause): VacuumLessonState {
  if (state.phase !== 'investigating') return state
  return { ...state, cause }
}

export function canChooseVacuumAction(state: VacuumLessonState, reading: VacuumReading): boolean {
  return state.phase === 'investigating'
    && state.cause === 'snapshot'
    && VACUUM_EVIDENCE.every((id) => state.evidence[id])
    && reading.decisionReady
}

export function chooseVacuumAction(
  state: VacuumLessonState,
  action: VacuumAction,
  reading: VacuumReading,
): VacuumLessonState {
  if (!canChooseVacuumAction(state, reading)) return state
  return { ...state, phase: 'observing', action }
}

export function verifyVacuumRecovery(state: VacuumLessonState, reading: VacuumReading): VacuumLessonState {
  if (state.phase !== 'observing' || reading.pinned || !reading.recovered || reading.reclaimed <= 0) return state
  return { ...state, phase: 'complete' }
}
