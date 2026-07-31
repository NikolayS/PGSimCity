import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'

type Sim = ReturnType<typeof createSim>

function advanceBy(sim: Sim, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 30, target - sim.state.t))
}

function advanceUntil(sim: Sim, done: () => boolean, timeoutSec = 240): void {
  const deadline = sim.state.t + timeoutSec
  while (!done() && sim.state.t < deadline) sim.update(1 / 30)
  expect(done()).toBe(true)
}

function readyDecision(sim: Sim): NonNullable<Sim['state']['scenarioDecision']> {
  advanceUntil(sim, () => sim.state.scenarioDecision?.phase === 'ready')
  const decision = sim.state.scenarioDecision
  expect(decision).not.toBeNull()
  return decision!
}

describe('operator scenario: a replication slot is filling pg_wal', () => {
  it('plays capacity and slot removal, then rebuilds after the destructive choice', () => {
    const preserve = createSim(createBus())
    preserve.runScenario('slot-pressure')
    const preserveReady = readyDecision(preserve)
    expect(preserveReady.kind).toBe('slot-pressure')
    if (preserveReady.kind !== 'slot-pressure') return
    expect(preserveReady.slotRetainedAtDecision).toBeGreaterThan(64 * 1024 * 1024)
    expect(
      preserve.state.disasterRecovery.archive.pgWalBytes
      / preserve.state.disasterRecovery.archive.pgWalCapacityBytes,
    ).toBeGreaterThanOrEqual(0.8)

    expect(preserve.chooseScenario('add-wal-capacity')).toBe(true)
    const capacity = preserve.state.scenarioDecision
    expect(capacity?.kind).toBe('slot-pressure')
    if (capacity?.kind !== 'slot-pressure') return
    expect(capacity.correct).toBe(true)
    expect(capacity.addedCapacityBytes).toBe(512 * 1024 * 1024)
    expect(preserve.state.disasterRecovery.archive.pgWalCapacityBytes)
      .toBe(capacity.capacityAtDecision + capacity.addedCapacityBytes)
    advanceUntil(preserve, () => preserve.state.scenarioDecision?.phase === 'recovered')
    expect(capacity.rejectedWrites).toBe(0)
    expect(preserve.state.replication.physicalSlots[1].exists).toBe(true)
    expect(preserve.state.replication.standbys[1].connected).toBe(true)

    const discard = createSim(createBus())
    discard.runScenario('slot-pressure')
    readyDecision(discard)
    const pgWalBeforeDrop = discard.state.disasterRecovery.archive.pgWalBytes
    expect(discard.chooseScenario('drop-replication-slot')).toBe(true)
    const dropped = discard.state.scenarioDecision
    expect(dropped?.kind).toBe('slot-pressure')
    if (dropped?.kind !== 'slot-pressure') return
    expect(dropped.correct).toBe(false)
    expect(dropped.rebuildRequired).toBe(true)
    expect(discard.state.replication.physicalSlots[1].exists).toBe(false)
    advanceBy(discard, 1)
    expect(discard.state.replication.physicalSlots[1].retainedBytes).toBe(0)
    expect(discard.state.disasterRecovery.archive.pgWalBytes).toBeLessThan(pgWalBeforeDrop)
    const pgWalAfterDrop = discard.state.disasterRecovery.archive.pgWalBytes

    expect(discard.recoverScenario()).toBe(true)
    advanceUntil(discard, () => discard.state.scenarioDecision?.phase === 'recovered')
    const rebuilt = discard.state.scenarioDecision
    expect(rebuilt?.kind).toBe('slot-pressure')
    if (rebuilt?.kind !== 'slot-pressure') return
    expect(rebuilt.rebuildBytes).toBeGreaterThan(8 * 1024 * 1024 * 1024)
    expect(rebuilt.rebuildCopiedBytes).toBe(rebuilt.rebuildBytes)
    expect(discard.state.replication.physicalSlots[1].exists).toBe(true)
    expect(discard.state.replication.standbys[1].connected).toBe(true)
  })
})

describe('operator scenario: an old transaction pins xmin', () => {
  it('plays termination and waiting, then releases the wait branch for cleanup', () => {
    const terminate = createSim(createBus())
    terminate.runScenario('vacuum-blockade')
    const terminateReady = readyDecision(terminate)
    expect(terminateReady.kind).toBe('vacuum-blockade')
    if (terminateReady.kind !== 'vacuum-blockade') return
    expect(terminate.state.oldestSnapshotAge).toBeGreaterThan(20)
    expect(terminateReady.deadTuplesAtDecision).toBeGreaterThan(0)

    expect(terminate.chooseScenario('terminate-transaction')).toBe(true)
    const killed = terminate.state.scenarioDecision
    expect(killed?.kind).toBe('vacuum-blockade')
    if (killed?.kind !== 'vacuum-blockade') return
    expect(killed.correct).toBe(true)
    expect(killed.transactionTerminated).toBe(true)
    expect(terminate.state.knobs.longRunningXact).toBe(false)
    advanceUntil(terminate, () => terminate.state.scenarioDecision?.phase === 'recovered')
    expect(killed.deadTuplesReclaimed).toBeGreaterThan(0)

    const wait = createSim(createBus())
    wait.runScenario('vacuum-blockade')
    readyDecision(wait)
    expect(wait.chooseScenario('wait-for-transaction')).toBe(true)
    advanceBy(wait, 20)
    const waited = wait.state.scenarioDecision
    expect(waited?.kind).toBe('vacuum-blockade')
    if (waited?.kind !== 'vacuum-blockade') return
    expect(waited.correct).toBe(false)
    expect(waited.deadTuplesAdded).toBeGreaterThan(50_000)
    expect(waited.pagesAdded).toBeGreaterThan(1_000)
    expect(waited.blockedVacuumWorkers).toBe(3)
    expect(wait.state.knobs.longRunningXact).toBe(true)

    expect(wait.recoverScenario()).toBe(true)
    advanceUntil(wait, () => wait.state.scenarioDecision?.phase === 'recovered')
    expect(wait.state.knobs.longRunningXact).toBe(false)
    expect(waited.deadTuplesReclaimed).toBeGreaterThan(0)
    expect(waited.deadTuplesAdded).toBeGreaterThan(killed.deadTuplesAdded)
  })
})

describe('operator scenario: select a failover candidate', () => {
  it('plays both candidates, measures the extra loss, and rewinds after the bad promotion', () => {
    function promote(choice: 'promote-standby-a' | 'promote-standby-b'): Sim {
      const sim = createSim(createBus())
      sim.runScenario('failover-candidate')
      const decision = readyDecision(sim)
      expect(decision.kind).toBe('failover-candidate')
      if (decision.kind === 'failover-candidate') {
        expect(decision.standbyBLagBytes).toBeGreaterThan(decision.standbyALagBytes)
      }
      expect(sim.state.cluster.nodes[0].online).toBe(false)
      expect(sim.state.highAvailability.acceptingWrites).toBe(false)
      expect(sim.chooseScenario(choice)).toBe(true)
      advanceUntil(
        sim,
        () => sim.state.highAvailability.transition.status === 'complete',
      )
      expect(sim.state.scenarioDecision?.phase).toBe('outcome')
      return sim
    }

    const current = promote('promote-standby-a')
    const currentChoice = current.state.scenarioDecision
    expect(currentChoice?.kind).toBe('failover-candidate')
    if (currentChoice?.kind !== 'failover-candidate') return
    expect(currentChoice.correct).toBe(true)
    expect(current.state.highAvailability.currentLeader).toBe('standbyA')
    expect(currentChoice.lossTransactions).toBe(0)

    const lagging = promote('promote-standby-b')
    const laggingChoice = lagging.state.scenarioDecision
    expect(laggingChoice?.kind).toBe('failover-candidate')
    if (laggingChoice?.kind !== 'failover-candidate') return
    expect(laggingChoice.correct).toBe(false)
    expect(lagging.state.highAvailability.currentLeader).toBe('standbyB')
    expect(laggingChoice.lossBytes).toBeGreaterThan(currentChoice.lossBytes)
    expect(laggingChoice.lossTransactions).toBeGreaterThan(currentChoice.lossTransactions)
    expect(laggingChoice.lossBytes).toBeGreaterThan(10 * 1024 * 1024)
    expect(laggingChoice.lossTransactions).toBeGreaterThan(4_000)

    expect(lagging.recoverScenario()).toBe(true)
    advanceUntil(lagging, () => lagging.state.scenarioDecision?.phase === 'recovered')
    expect(lagging.state.cluster.nodes[0].online).toBe(true)
    expect(lagging.state.cluster.nodes[0].role).toBe('standby')
    expect(lagging.state.highAvailability.rejoin.required).toBe(false)
  })
})
