import { expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { vacuumCityReading } from './vacuum-city-state'

it('distinguishes current sessions work, horizon constraints and actual collection', () => {
  const sim = createSim(createBus(), { scheduledBackups: false })
  sim.runScenario('vacuum-blockade')
  const table = sim.state.tables.findIndex(t => t.def.id === 'sessions')
  const w = sim.state.autovac.workers[0]
  w.active = true; w.table = table; w.phase = 'scan_heap'; w.stalledByHorizon = true; w.deadCollected = 0
  let r = vacuumCityReading(sim.state)
  expect(r.workerId).toBe('autovac.worker.0')
  expect(r.work).toContain('scan heap')
  expect(r.work).toContain('horizon limits removal')
  expect(r.collection).toContain('0 sessions versions')
  w.deadCollected = 7
  r = vacuumCityReading(sim.state)
  expect(r.work).toContain('7 collected this pass')
  expect(r.collection).toContain('0 sessions versions')
  w.table = (table + 1) % sim.state.tables.length
  expect(vacuumCityReading(sim.state).workerId).toBeNull()
  expect(vacuumCityReading(sim.state).work).toContain('No worker on sessions now')
  sim.setKnob('longRunningXact', false)
  expect(vacuumCityReading(sim.state).collection).toContain('0 sessions versions')
  const decision = sim.state.scenarioDecision!
  if (decision.kind !== 'vacuum-blockade') throw new Error('wrong scenario')
  decision.sessionsReclaimedAfterRelease = 23
  expect(vacuumCityReading(sim.state).collection).toContain('23 sessions versions')
  expect(vacuumCityReading(sim.state).collected).toBe(true)
  w.table = table; w.phase = 'return'
  expect(vacuumCityReading(sim.state).workerId).toBeNull()
})
