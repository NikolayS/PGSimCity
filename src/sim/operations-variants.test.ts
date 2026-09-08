import { describe, expect, it } from 'vitest'
import { createAggregateSim } from './test-support'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { createIncidentReplay } from './replay'

const MIB = 1024 * 1024
const step = 1 / 3

function staged(id: string) {
  const sim = createAggregateSim(step)
  sim.runScenario(id)
  sim.state.disasterRecovery.archive.pgWalCapacityBytes = 384 * MIB
  for (let i = 0; i < 3600 && sim.state.scenarioDecision?.phase !== 'ready'; i++) sim.update(step)
  expect(sim.state.scenarioDecision?.phase).toBe('ready')
  return sim
}

describe('operations variants: ownership changes the WAL decision', () => {
  it('keeps a retired consumer stopped and verifies actual release after dropping its inactive slot', () => {
    const sim = staged('retired-slot')
    const decision = sim.state.scenarioDecision!
    expect(decision.kind).toBe('slot-pressure')
    if (decision.kind !== 'slot-pressure') return
    expect(decision.recoveryIntent).toBe('retired')
    expect(sim.state.replication.standbys[1].enabled).toBe(false)
    expect(sim.state.replication.physicalSlots[1].active).toBe(false)
    expect(sim.state.replication.physicalSlots[1].retainedBytes).toBeGreaterThan(64 * MIB)
    const before = sim.state.disasterRecovery.archive.pgWalBytes
    expect(sim.chooseScenario('drop-replication-slot')).toBe(true)
    expect(decision.correct).toBe(true)
    expect(decision.phase).toBe('outcome')
    expect(sim.state.disasterRecovery.archive.pgWalBytes).toBe(before)
    expect(sim.state.replication.standbys[1].enabled).toBe(false)
    for (let i = 0; i < 720 && decision.phase !== 'recovered'; i++) sim.update(step)
    expect(decision.phase).toBe('recovered')
    expect(sim.state.disasterRecovery.archive.pgWalBytes).toBeLessThan(before)
    expect(sim.state.disasterRecovery.archive.writesBlocked).toBe(false)
  })

  it('retains physical WAL files after slot drop until checkpoint completion', () => {
    const sim = staged('retired-slot')
    const bytes = sim.state.disasterRecovery.archive.pgWalBytes
    const checkpoints = sim.state.checkpoint.count
    expect(sim.chooseScenario('drop-replication-slot')).toBe(true)
    sim.update(.1)
    expect(sim.state.checkpoint.count).toBe(checkpoints)
    expect(sim.state.disasterRecovery.archive.pgWalBytes).toBeGreaterThanOrEqual(bytes)
    expect(sim.state.scenarioDecision?.phase).not.toBe('recovered')
    for (let i = 0; i < 2400 && sim.state.scenarioDecision?.phase !== 'recovered'; i++) sim.update(.1)
    expect(sim.state.checkpoint.count).toBeGreaterThan(checkpoints)
    expect(sim.state.disasterRecovery.archive.pgWalBytes).toBeLessThan(bytes)
    expect(sim.state.scenarioDecision?.phase).toBe('recovered')
  })

  it('treats extra capacity as containment, not resolution of retired retention', () => {
    const sim = staged('retired-slot')
    expect(sim.chooseScenario('add-wal-capacity')).toBe(true)
    const decision = sim.state.scenarioDecision!
    expect(decision.correct).toBe(false)
    const retained = sim.state.replication.physicalSlots[1].retainedBytes
    for (let i = 0; i < 180; i++) sim.update(step)
    expect(sim.state.replication.physicalSlots[1].retainedBytes).toBeGreaterThan(retained)
    expect(decision.phase).not.toBe('recovered')
    expect(sim.state.replication.standbys[1].enabled).toBe(false)
  })

  it('preserves the required consumer variant and its opposite decision', () => {
    const sim = staged('slot-pressure')
    const decision = sim.state.scenarioDecision!
    if (decision.kind !== 'slot-pressure') throw Error('Expected slot decision')
    expect(decision.recoveryIntent).toBe('required')
    expect(sim.state.replication.standbys[1].enabled).toBe(true)
    expect(sim.chooseScenario('add-wal-capacity')).toBe(true)
    expect(decision.correct).toBe(true)
  })

  it('rejects the retired-slot operation if the consumer has been restarted', () => {
    const sim = staged('retired-slot')
    sim.setKnob('standbyBEnabled', true)
    sim.update(step)
    const before = structuredClone(sim.state.replication.physicalSlots[1])
    expect(sim.chooseScenario('drop-replication-slot')).toBe(false)
    expect(sim.state.replication.physicalSlots[1]).toEqual(before)
    expect(sim.state.scenarioDecision?.choice).toBeNull()
  })

  it('does not replace the current case with unfinishable staging after its slot was removed', () => {
    const sim = staged('retired-slot')
    sim.chooseScenario('drop-replication-slot')
    const before = structuredClone(sim.state)
    sim.runScenario('retired-slot')
    expect(sim.state).toEqual(before)
    sim.reset()
    sim.runScenario('retired-slot')
    expect(sim.state.scenarioDecision?.phase).toBe('staging')
    expect(sim.state.replication.physicalSlots[1].exists).toBe(true)
  })

  it('reconstructs the retired decision and observed recovery from its real replay record', async () => {
    const bus = createBus()
    const sim = createSim(bus, { seed: 42 })
    const replay = createIncidentReplay(sim, bus, { seed: 42 })
    try {
      sim.runScenario('retired-slot')
      sim.setKnob('paused', true)
      for (let i = 0; i < 18000 && sim.state.scenarioDecision?.phase !== 'ready'; i++) sim.advance(.1)
      expect(sim.state.scenarioDecision?.phase).toBe('ready')
      expect(sim.chooseScenario('drop-replication-slot')).toBe(true)
      for (let i = 0; i < 2400 && sim.state.scenarioDecision?.phase !== 'recovered'; i++) sim.advance(.1)
      expect(sim.state.scenarioDecision?.phase).toBe('recovered')
      const expected = structuredClone(sim.state)
      const record = replay.exportRecord()
      await replay.loadRecord(record)
      expect(sim.state).toEqual(expected)
    } finally {
      replay.dispose()
    }
  })
})
