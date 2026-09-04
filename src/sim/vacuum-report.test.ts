import { describe, expect, it } from 'vitest'
import { createAggregateSim } from './test-support'

const step = 1 / 3
function staged() {
  const sim = createAggregateSim(step)
  sim.runScenario('vacuum-report')
  for (let i = 0; i < 180; i++) sim.update(step)
  expect(sim.state.scenarioDecision?.phase).toBe('ready')
  return sim
}

describe('required read-only report investigation', () => {
  it('requires collection after snapshot release even when earlier cleanup was observed', () => {
    const sim = staged()
    const decision = sim.state.scenarioDecision!
    if (decision.kind !== 'vacuum-blockade') throw new Error('wrong decision')
    // A counter baseline before existing eligible-version cleanup must not
    // certify a later snapshot release as a successful cleanup pass.
    decision.landfillAtDecision = sim.state.autovac.landfill - 100
    sim.chooseScenario('terminate-transaction')
    const releasedAt = sim.state.autovac.landfill
    sim.update(step)
    expect(sim.state.autovac.landfill).toBe(releasedAt)
    expect(decision.phase).not.toBe('recovered')
  })

  it('preserves the snapshot until authored report completion, then observes cleanup', () => {
    const sim = staged()
    expect(sim.chooseScenario('wait-for-transaction')).toBe(true)
    const decision = sim.state.scenarioDecision!
    if (decision.kind !== 'vacuum-blockade') throw new Error('wrong decision')
    expect(decision.correct).toBe(true)
    for (let i = 0; i < 89; i++) sim.update(step)
    expect(sim.state.knobs.longRunningXact).toBe(true)
    expect(decision.report?.status).toBe('running')
    expect(decision.deadTuplesReclaimed).toBe(0)
    for (let i = 0; i < 2; i++) sim.update(step)
    expect(decision.report?.status).toBe('completed')
    expect(decision.transactionTerminated).toBe(false)
    expect(sim.state.knobs.longRunningXact).toBe(false)
    expect(decision.phase).not.toBe('recovered')
    for (let i = 0; i < 2700 && decision.phase !== 'recovered'; i++) sim.update(step)
    expect(decision.phase).toBe('recovered')
    expect(decision.deadTuplesReclaimed).toBeGreaterThan(0)
  }, 30_000)

  it('does not complete required work when the session is terminated', () => {
    const sim = staged()
    expect(sim.chooseScenario('terminate-transaction')).toBe(true)
    const decision = sim.state.scenarioDecision!
    if (decision.kind !== 'vacuum-blockade') throw new Error('wrong decision')
    expect(decision.correct).toBe(false)
    expect(decision.report?.status).toBe('interrupted')
    for (let i = 0; i < 120; i++) sim.update(step)
    expect(decision.report?.status).toBe('interrupted')
    expect(sim.recoverScenario()).toBe(false)
  })

  it('cannot bypass preserving the report with the abandoned-session recovery shortcut', () => {
    const sim = staged()
    expect(sim.chooseScenario('wait-for-transaction')).toBe(true)
    expect(sim.recoverScenario()).toBe(false)
    expect(sim.state.knobs.longRunningXact).toBe(true)
  })

  it('does not call an externally released snapshot a completed report', () => {
    const sim = staged()
    sim.chooseScenario('wait-for-transaction')
    sim.setKnob('longRunningXact', false)
    for (let i = 0; i < 100; i++) sim.update(step)
    const decision = sim.state.scenarioDecision!
    if (decision.kind !== 'vacuum-blockade') throw new Error('wrong decision')
    expect(decision.report?.status).toBe('interrupted')
    expect(decision.correct).toBe(false)
  })
})
