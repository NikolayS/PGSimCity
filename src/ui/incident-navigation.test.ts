import { expect, it } from 'vitest'
import { incidentDiagnosticCaption } from './incident-navigation'

it('never claims a chosen symptom staged the linked city incident', () => {
  expect(incidentDiagnosticCaption(true, 'Checkpoint storm')).toBe(
    'Inspecting the linked city incident. Choosing a complaint has not changed its workload.',
  )
  expect(incidentDiagnosticCaption(false, 'Checkpoint storm')).toContain('Checkpoint storm')
})
