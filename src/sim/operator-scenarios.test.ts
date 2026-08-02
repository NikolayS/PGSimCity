import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import {
  AGGREGATE_TEST_STEP,
  createAggregateSim,
  FRAME_TEST_STEP,
} from './test-support'

type Sim = ReturnType<typeof createAggregateSim>

function advanceBy(sim: Sim, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, target - sim.state.t))
  }
}

function advanceUntil(
  sim: Sim,
  done: () => boolean,
  timeoutSec = 240,
  step = AGGREGATE_TEST_STEP,
): void {
  const deadline = sim.state.t + timeoutSec
  while (!done() && sim.state.t < deadline) sim.update(step)
  expect(done()).toBe(true)
}

function readyDecision(
  sim: Sim,
  step = AGGREGATE_TEST_STEP,
): NonNullable<Sim['state']['scenarioDecision']> {
  advanceUntil(sim, () => sim.state.scenarioDecision?.phase === 'ready', 240, step)
  const decision = sim.state.scenarioDecision
  expect(decision).not.toBeNull()
  return decision!
}

describe('operator scenario: a replication slot is filling pg_wal', () => {
  it('plays capacity and slot removal, then rebuilds after the destructive choice', () => {
    const preserve = createAggregateSim(1 / 10)
    preserve.runScenario('slot-pressure')
    // A smaller test volume reaches the same pressure branch at this cadence.
    preserve.state.disasterRecovery.archive.pgWalCapacityBytes = 384 * 1024 * 1024
    const preserveReady = readyDecision(preserve, 1 / 10)
    expect(preserveReady.kind).toBe('slot-pressure')
    if (preserveReady.kind !== 'slot-pressure') return
    expect(preserveReady.slotRetainedAtDecision).toBeGreaterThan(64 * 1024 * 1024)
    expect(
      preserve.state.disasterRecovery.archive.pgWalBytes
      / preserve.state.disasterRecovery.archive.pgWalCapacityBytes,
    ).toBeGreaterThan(0.5)

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

    const discard = createAggregateSim(1 / 10)
    discard.runScenario('slot-pressure')
    // Keep both choices at the same capacity so only the branch differs.
    discard.state.disasterRecovery.archive.pgWalCapacityBytes = 384 * 1024 * 1024
    readyDecision(discard, 1 / 10)
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
    const terminate = createAggregateSim(1 / 3)
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
    advanceUntil(
      terminate,
      () => terminate.state.scenarioDecision?.phase === 'recovered',
      900,
      1 / 3,
    )
    expect(killed.deadTuplesReclaimed).toBeGreaterThan(0)

    const wait = createAggregateSim(1 / 3)
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
    advanceUntil(
      wait,
      () => wait.state.scenarioDecision?.phase === 'recovered',
      900,
      1 / 3,
    )
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
      const decision = readyDecision(sim, FRAME_TEST_STEP)
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
    expect(laggingChoice.lossBytes).toBeGreaterThan(laggingChoice.standbyBLagBytes * 0.5)
    expect(laggingChoice.lossTransactions).toBeGreaterThan(lagging.state.stats.commits * 0.01)

    const healthyStandbys = lagging.state.cluster.nodes.filter(
      (node) => node.role === 'standby' && node.online,
    )
    const aheadFollower = lagging.state.cluster.nodes[1]
    expect.soft(healthyStandbys).toHaveLength(0)
    expect.soft(aheadFollower.role).toBe('diverged')
    expect.soft(aheadFollower.online).toBe(false)
    expect.soft(lagging.state.replication.standbys[0].connected).toBe(false)
    expect.soft(laggingChoice.rejoinBytes).toBeGreaterThan(1024 * 1024 * 1024)
    expect.soft(lagging.state.highAvailability.rejoin.reinitializeRequired).toBe(true)
    expect.soft(lagging.state.highAvailability.rejoin.reinitializeNode).toBe('standbyA')
    expect.soft(lagging.state.highAvailability.rejoin.reinitializeBytes)
      .toBeGreaterThan(1024 * 1024 * 1024)

    expect(lagging.recoverScenario()).toBe(true)
    advanceUntil(lagging, () => lagging.state.scenarioDecision?.phase === 'recovered')
    expect(lagging.state.cluster.nodes[0].online).toBe(true)
    expect(lagging.state.cluster.nodes[0].role).toBe('standby')
    expect(lagging.state.cluster.nodes[1].online).toBe(true)
    expect(lagging.state.cluster.nodes[1].role).toBe('standby')
    expect(lagging.state.replication.standbys[0].connected).toBe(true)
    expect(lagging.state.highAvailability.rejoin.required).toBe(false)
  })
})
