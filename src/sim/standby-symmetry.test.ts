import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { DEFAULT_KNOBS } from '../core/types'
import { createSim } from './model'

const STANDBY_KNOB = /^standby([AB])(Enabled|LongQuery|NetworkLag|SlowApply)$/
const LEGACY_REPLICATION_FIELDS = [
  'enabled',
  'connected',
  'mode',
  'sentLsn',
  'writeLsn',
  'flushLsn',
  'replayLsn',
  'lagBytes',
  'lagSec',
  'networkLagMs',
  'applyActivity',
  'inFlight',
] as const

describe('physical standby symmetry', () => {
  it('gives standby A and B the same knob vocabulary without an A-only replication shadow', () => {
    const suffixes = { A: new Set<string>(), B: new Set<string>() }
    for (const key of Object.keys(DEFAULT_KNOBS)) {
      const match = STANDBY_KNOB.exec(key)
      if (match) suffixes[match[1] as 'A' | 'B'].add(match[2])
    }

    expect([...suffixes.A].sort()).toEqual(['Enabled', 'LongQuery', 'NetworkLag', 'SlowApply'])
    expect([...suffixes.B].sort()).toEqual([...suffixes.A].sort())

    const replication = createSim(createBus()).state.replication
    for (const field of LEGACY_REPLICATION_FIELDS) {
      expect(replication).not.toHaveProperty(field)
    }
    expect(replication.standbys).toHaveLength(2)
  })

  it('keeps paired failover lag readouts for the two candidate nodes', () => {
    const sim = createSim(createBus())
    sim.runScenario('failover-candidate')

    expect(sim.state.scenarioDecision).toMatchObject({
      kind: 'failover-candidate',
      standbyALagBytes: expect.any(Number),
      standbyBLagBytes: expect.any(Number),
    })
  })

  it('keeps synchronous status as an explicit selectable configuration difference', () => {
    const sim = createSim(createBus())

    sim.setKnob('synchronousStandbyNames', 'standbyA')
    sim.update(1 / 30)
    expect(sim.state.replication.standbys.map((standby) => standby.mode)).toEqual(['sync', 'async'])

    sim.setKnob('synchronousStandbyNames', 'standbyB')
    sim.update(1 / 30)
    expect(sim.state.replication.standbys.map((standby) => standby.mode)).toEqual(['async', 'sync'])
  })
})
