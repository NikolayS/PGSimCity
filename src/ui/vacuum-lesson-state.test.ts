import { describe, expect, it } from 'vitest'
import {
  collectVacuumEvidence,
  createVacuumLessonState,
  canChooseVacuumAction,
  chooseVacuumAction,
  selectVacuumCause,
  verifyVacuumRecovery,
  VACUUM_EVIDENCE,
  type VacuumReading,
} from './vacuum-lesson-state'

const reading: VacuumReading = {
  time: 60, deadRows: 900, initialDeadRows: 100,
  pages: 120, initialPages: 100, scanObserved: true,
  snapshotAge: 58, horizon: 400, pinned: true,
  decisionReady: true, reclaimed: 0, recovered: false,
}

function investigated() {
  let state = createVacuumLessonState('challenge')
  for (const id of VACUUM_EVIDENCE) state = collectVacuumEvidence(state, id, reading, `${id} evidence`)
  return selectVacuumCause(state, 'snapshot')
}

describe('vacuum investigation evidence and recovery', () => {
  it('requires all four evidence sources and a supported explanation before intervention', () => {
    let state = createVacuumLessonState('guided')
    for (const id of ['table', 'worker', 'snapshot'] as const) {
      state = collectVacuumEvidence(state, id, reading, id)
    }
    state = selectVacuumCause(state, 'snapshot')
    expect(canChooseVacuumAction(state, reading)).toBe(false)
    expect(chooseVacuumAction(state, 'terminate', reading)).toBe(state)
    state = collectVacuumEvidence(state, 'owner', reading, 'Authored owner confirmation')
    expect(canChooseVacuumAction(state, reading)).toBe(true)
  })

  it('does not accept observations that have not happened', () => {
    const state = createVacuumLessonState('challenge')
    const quiet = { ...reading, deadRows: 100, scanObserved: false, pinned: false }
    for (const id of VACUUM_EVIDENCE) expect(collectVacuumEvidence(state, id, quiet, id)).toBe(state)
  })

  it('requires model readiness even after all the evidence is collected', () => {
    expect(canChooseVacuumAction(investigated(), { ...reading, decisionReady: false })).toBe(false)
  })

  it('keeps the captured evidence and timestamp when live values change', () => {
    const state = collectVacuumEvidence(createVacuumLessonState('guided'), 'table', reading, '900 old versions')
    const next = collectVacuumEvidence(state, 'table', { ...reading, time: 80, deadRows: 1500 }, '1500 old versions')
    expect(next.evidence.table).toEqual({ time: 60, text: '900 old versions' })
    expect(state.evidence.table).toEqual(next.evidence.table)
  })

  it('does not treat an incorrect hypothesis as a diagnosis', () => {
    const state = selectVacuumCause(investigated(), 'disabled')
    expect(canChooseVacuumAction(state, reading)).toBe(false)
    expect(state.cause).toBe('disabled')
  })

  it('does not pronounce recovery when only the snapshot has gone', () => {
    const state = chooseVacuumAction(investigated(), 'terminate', reading)
    expect(state.phase).toBe('observing')
    expect(verifyVacuumRecovery(state, { ...reading, pinned: false })).toBe(state)
    expect(verifyVacuumRecovery(state, { ...reading, pinned: false, recovered: true })).toBe(state)
    expect(verifyVacuumRecovery(state, { ...reading, reclaimed: 20, recovered: true })).toBe(state)
  })

  it('verifies resumed cleanup from a model recovery and positive collection', () => {
    const state = chooseVacuumAction(investigated(), 'terminate', reading)
    const recovered = { ...reading, pinned: false, reclaimed: 20, recovered: true }
    expect(verifyVacuumRecovery(state, recovered).phase).toBe('complete')
    expect(verifyVacuumRecovery(investigated(), recovered).phase).toBe('investigating')
  })

  it('can verify recovery after waiting and subsequently releasing the transaction', () => {
    const state = chooseVacuumAction(investigated(), 'wait', reading)
    expect(verifyVacuumRecovery(state, reading).phase).toBe('observing')
    expect(verifyVacuumRecovery(state, { ...reading, pinned: false, reclaimed: 20, recovered: true }).phase)
      .toBe('complete')
  })
})
