import { expect, it } from 'vitest'
import { createAggregateSim } from './test-support'

it('does not count pre-release vacuum collection as post-release recovery', () => {
  const step = 1 / 3
  const sim = createAggregateSim(step)
  sim.runScenario('vacuum-blockade')
  for (let i = 0; i < 180; i++) sim.update(step)
  const decision = sim.state.scenarioDecision!
  expect(decision.phase).toBe('ready')
  if (decision.kind !== 'vacuum-blockade') throw new Error('wrong decision')
  // Eligible older versions can be collected while newer versions remain pinned.
  decision.landfillAtDecision = sim.state.autovac.landfill - 100
  sim.chooseScenario('terminate-transaction')
  const releasedAt = sim.state.autovac.landfill
  sim.update(step)
  expect(sim.state.autovac.landfill).toBe(releasedAt)
  expect(decision.phase).not.toBe('recovered')
  for (let i = 0; i < 2700 && decision.phase !== 'recovered'; i++) sim.update(step)
  expect(decision.phase).toBe('recovered')
  expect(sim.state.autovac.landfill).toBeGreaterThan(releasedAt)
})
