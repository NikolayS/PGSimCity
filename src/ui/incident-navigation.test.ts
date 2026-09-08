import { expect, it, vi } from 'vitest'
import { incidentDiagnosticCaption, installIncidentCacheGuard, isSameTabIncidentClick } from './incident-navigation'

it('never claims a chosen symptom staged the linked city incident', () => {
  expect(incidentDiagnosticCaption(true, 'Checkpoint storm')).toBe(
    'Inspecting the linked city incident. Choosing a complaint has not changed its workload.',
  )
  expect(incidentDiagnosticCaption(false, 'Checkpoint storm')).toContain('Checkpoint storm')
})

it('stops stale cache returns but leaves first navigation alone', () => {
  const target = new EventTarget()
  const stale = vi.fn()
  const stop = installIncidentCacheGuard(stale, target)
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
  expect(stale).not.toHaveBeenCalled()
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(stale).toHaveBeenCalledOnce()
  stop()
  target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  expect(stale).toHaveBeenCalledOnce()
})

it('only transfers explicit same-tab primary clicks', () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
  expect(isSameTabIncidentClick(click, '', false)).toBe(true)
  for (const key of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
    expect(isSameTabIncidentClick({ ...click, [key]: true }, '', false)).toBe(false)
  }
  expect(isSameTabIncidentClick({ ...click, button: 1 }, '', false)).toBe(false)
  expect(isSameTabIncidentClick(click, '_blank', false)).toBe(false)
  expect(isSameTabIncidentClick(click, '', true)).toBe(false)
})
