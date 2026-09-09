import { expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { doc, docSource } from './content'

it('inspects the selected worker, not the first active worker or fleet totals', () => {
  const sim = createSim(createBus(), { scheduledBackups: false })
  const s = sim.state
  Object.assign(s.autovac.workers[0], { active: true, table: 0, phase: 'scan_heap', progress: .2, deadCollected: 900, stalledByHorizon: true })
  Object.assign(s.autovac.workers[1], { active: true, table: 3, phase: 'vacuum_heap', progress: .4, deadCollected: 17, stalledByHorizon: false })
  const entry = doc('autovac.worker.1')!
  const value = (label: string) => entry.metrics!.find(m => m.label === label)!.get(s)
  expect(value('Current table')).toBe(`${s.tables[3].def.name} · 40%`)
  expect(value('Blocked by horizon')).toBe('no')
  expect(value('Collected: current/last pass')).toBe('17')
  expect(value('Worker state')).toBe('vacuuming heap')
  expect(doc('autovac.worker.1')).toBe(entry)
  expect(docSource('autovac.worker.1')).toBe('src/ui/docs-storage.ts#ComponentDoc[id=autovac.worker]')

  Object.assign(s.autovac.workers[1], { active: false, phase: 'idle', deadCollected: 23, stalledByHorizon: true })
  expect(value('Current table')).toBe('—')
  expect(value('Worker state')).toBe('idle')
  expect(value('Blocked by horizon')).toBe('no')
  expect(value('Collected: current/last pass')).toBe('23')
  expect(entry.metrics!.find(m => m.label === 'Collected: current/last pass')!.hint).toContain('latest completed pass')
  expect(doc('autovac.worker')!.metrics!.map(m => m.label)).toContain('First active table')
  s.autovac.workers[1] = { ...s.autovac.workers[1], active: true, table: 2, progress: .1, phase: 'scan_heap', deadCollected: 0, stalledByHorizon: true, vacuumDelay: true }
  expect(value('Current table')).toBe(`${s.tables[2].def.name} · 10%`)
  expect(value('Worker state')).toBe('cost-delay sleep')
  expect(value('Collected: current/last pass')).toBe('0')
  expect(value('Blocked by horizon')).toContain('YES')
  expect(doc('autovac.worker.0')!.metrics!.find(m => m.label === 'Collected: current/last pass')!.get(s)).toBe('900')
  expect(doc('autovac.worker')!.metrics!.find(m => m.label === 'Fleet')!.get(s)).toContain('first:')
})
