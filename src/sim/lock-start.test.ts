import { expect, it } from 'vitest'
import { createAggregateSim } from './test-support'

it('forms direct lock waiters during the opening of a running case', () => {
  const sim = createAggregateSim()
  sim.runScenario('lock-pileup')
  for (let i = 0; i < 30 * 20; i++) sim.update(1 / 30)
  expect(sim.state.locks.length).toBeGreaterThan(0)
})
