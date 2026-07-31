import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createCollector } from '../observability/collector'
import { PROJECTIONS } from '../observability/views'
import { createSim } from './model'

function advanceBy(sim: ReturnType<typeof createSim>, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) sim.update(Math.min(1 / 30, target - sim.state.t))
}

function advanceUntil(
  sim: ReturnType<typeof createSim>,
  done: () => boolean,
  timeoutSec = 60,
): void {
  const deadline = sim.state.t + timeoutSec
  while (!done() && sim.state.t < deadline) sim.update(1 / 30)
  expect(done()).toBe(true)
}

function warmLag(sim: ReturnType<typeof createSim>, networkLagMs: number): void {
  sim.setKnob('tps', 2_000)
  sim.setKnob('writeRatio', 1)
  sim.setKnob('synchronousCommit', 'local')
  sim.setKnob('replicaNetworkLag', networkLagMs)
  advanceBy(sim, 35)
}

function runFailover(networkLagMs: number): {
  lossBytes: number
  lossTransactions: number
  forkLsn: number
  oldHistoryEndLsn: number
} {
  const sim = createSim(createBus())
  warmLag(sim, networkLagMs)

  expect(sim.startFailover('standbyA')).toBe(true)
  advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

  const ha = sim.state.highAvailability
  expect(ha.currentLeader).toBe('standbyA')
  expect(ha.timeline.current).toBe(2)
  expect(ha.timeline.parent).toBe(1)
  expect(ha.transition.lossBytes).toBe(
    ha.timeline.oldHistoryEndLsn - ha.timeline.forkLsn,
  )
  expect(ha.transition.lossTransactions).toBeGreaterThan(0)
  expect(ha.rejoin.required).toBe(true)
  expect(ha.rejoin.node).toBe('primary')
  expect(sim.state.cluster.nodes[0].online).toBe(false)

  return {
    lossBytes: ha.transition.lossBytes,
    lossTransactions: ha.transition.lossTransactions,
    forkLsn: ha.timeline.forkLsn,
    oldHistoryEndLsn: ha.timeline.oldHistoryEndLsn,
  }
}

describe('Patroni switchover and failover', () => {
  it('parks commits on SyncRep when the configured synchronous standby disconnects', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 600)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'on')
    advanceBy(sim, 15)

    sim.setKnob('replicaEnabled', false)
    advanceBy(sim, 8)
    const commitsAfterDrain = sim.state.stats.commits
    advanceBy(sim, 10)

    const waiters = sim.state.backends.filter(
      (backend) => backend.state === 'commit_wait',
    )
    const activity = PROJECTIONS.activity(
      sim.state,
      createCollector(sim),
      'total',
    )
    const waitEvents = activity.rows.map((row) => {
      const cell = row.cells.wait_event
      return typeof cell === 'string' ? cell : cell.v
    })

    expect.soft(sim.state.stats.commits).toBe(commitsAfterDrain)
    expect.soft(waiters).toHaveLength(sim.state.maxConnections)
    expect.soft(waitEvents).toContain('SyncRep')

    sim.setKnob('synchronousStandbyNames', false)
    advanceBy(sim, 8)
    expect(sim.state.stats.commits).toBeGreaterThan(commitsAfterDrain)
  })

  it('waits for a planned switchover and loses no WAL or transactions', () => {
    const sim = createSim(createBus())
    warmLag(sim, 300)
    expect(sim.state.replication.standbys[0].lagBytes).toBeGreaterThan(0)

    expect(sim.startSwitchover('standbyA')).toBe(true)
    expect(sim.state.highAvailability.acceptingWrites).toBe(false)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

    const ha = sim.state.highAvailability
    expect(ha.transition.kind).toBe('switchover')
    expect(ha.transition.waitSec).toBeGreaterThan(0)
    expect(ha.transition.lossBytes).toBe(0)
    expect(ha.transition.lossTransactions).toBe(0)
    expect(ha.timeline.oldHistoryEndLsn).toBe(ha.timeline.forkLsn)
    expect(ha.currentLeader).toBe('standbyA')
    expect(ha.acceptingWrites).toBe(true)
    expect(ha.rejoin.required).toBe(false)
    expect(sim.state.cluster.nodes.map((node) => node.role)).toEqual([
      'standby',
      'primary',
      'standby',
    ])
  })

  it('keeps the demoted primary following after a planned switchover', () => {
    const sim = createSim(createBus())
    warmLag(sim, 300)
    expect(sim.startSwitchover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    const appliedAtPromotion = sim.state.cluster.nodes[0].wal.appliedLsn

    advanceBy(sim, 60)

    const oldPrimary = sim.state.cluster.nodes[0]
    expect(oldPrimary.role).toBe('standby')
    expect(oldPrimary.online).toBe(true)
    expect(oldPrimary.wal.appliedLsn).toBeGreaterThan(appliedAtPromotion)
    expect(oldPrimary.wal.appliedLsn).toBeLessThanOrEqual(sim.state.wal.insertLsn)
  })

  it('reports more bytes and transactions lost from a more-lagged failover', () => {
    const near = runFailover(40)
    const far = runFailover(400)

    expect(near.lossBytes).toBeGreaterThan(0)
    expect(far.lossBytes).toBeGreaterThan(near.lossBytes)
    expect(far.lossTransactions).toBeGreaterThan(near.lossTransactions)
    expect(near.oldHistoryEndLsn).toBeGreaterThan(near.forkLsn)
    expect(far.oldHistoryEndLsn).toBeGreaterThan(far.forkLsn)
  })

  it('resumes default synchronous commits through the remaining follower', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 200)
    advanceBy(sim, 10)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    const committedAtPromotion = sim.state.stats.commits

    advanceBy(sim, 15)

    expect(sim.state.highAvailability.currentLeader).toBe('standbyA')
    expect(sim.state.replication.standbys[1].mode).toBe('sync')
    expect(sim.state.replication.standbys[1].connected).toBe(true)
    expect(sim.state.stats.commits).toBeGreaterThan(committedAtPromotion)
  })

  it('prices synchronous commit from the current follower after promotion', () => {
    function firstCommitWaitEstimate(networkLagMs: number): number {
      const sim = createSim(createBus())
      sim.setKnob('tps', 300)
      sim.setKnob('writeRatio', 1)
      advanceBy(sim, 10)
      expect(sim.startSwitchover('standbyA')).toBe(true)
      advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

      sim.setKnob('tps', 0)
      advanceBy(sim, 4)
      sim.setKnob('standbyBNetworkLag', networkLagMs)
      sim.setKnob('synchronousCommit', 'remote_apply')
      sim.setKnob('tps', 200)
      advanceUntil(
        sim,
        () => sim.state.backends.some((backend) => backend.state === 'commit_wait'),
      )
      const waiter = sim.state.backends.find(
        (backend) => backend.state === 'commit_wait',
      )
      expect(waiter).toBeDefined()
      return waiter?.stateDur ?? 0
    }

    const nearby = firstCommitWaitEstimate(20)
    const distant = firstCommitWaitEstimate(400)

    expect(distant - nearby).toBeGreaterThan(0.7)
  })

  it('does not acknowledge writes that a synchronous failover target lacks', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('replicaNetworkLag', 400)
    sim.setKnob('synchronousCommit', 'on')
    advanceBy(sim, 35)

    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

    expect(sim.state.highAvailability.transition.lossTransactions).toBe(0)
  })

  it('demotes a leader whose Patroni lease expires without promoting a rival', () => {
    const sim = createSim(createBus())

    sim.setKnob('patroniDcsAvailable', false)
    advanceBy(sim, sim.state.highAvailability.patroni.leaseTtlSec + 1)

    const ha = sim.state.highAvailability
    expect(ha.currentLeader).toBeNull()
    expect(ha.patroni.leaderLock).toBeNull()
    expect(ha.patroni.demotions).toBe(1)
    expect(ha.patroni.splitBrain).toBe(false)
    expect(sim.state.cluster.nodes.filter((node) => node.role === 'primary')).toHaveLength(0)
    expect(ha.acceptingWrites).toBe(false)
  })

  it('renews the same leader lease when DCS access returns before ttl', () => {
    const sim = createSim(createBus())
    const ttl = sim.state.highAvailability.patroni.leaseTtlSec

    sim.setKnob('patroniDcsAvailable', false)
    advanceBy(sim, 2)
    expect(sim.state.highAvailability.patroni.leaseRemainingSec)
      .toBeLessThan(ttl - 1.9)
    expect(sim.state.highAvailability.currentLeader).toBe('primary')

    sim.setKnob('patroniDcsAvailable', true)
    advanceBy(sim, 1.1)
    expect(sim.state.highAvailability.currentLeader).toBe('primary')
    expect(sim.state.highAvailability.patroni.leaseRemainingSec)
      .toBeGreaterThan(ttl - 0.2)
    expect(sim.state.highAvailability.acceptingWrites).toBe(true)
  })
})

describe('pg_rewind after a timeline fork', () => {
  function failedOver(walLogHints = true): ReturnType<typeof createSim> {
    const sim = createSim(createBus())
    sim.setKnob('walLogHints', walLogHints)
    sim.setKnob('standbyBEnabled', false)
    warmLag(sim, 400)
    sim.startFailover('standbyA')
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    return sim
  }

  it('takes time and fails when neither checksums nor wal_log_hints can identify changed blocks', () => {
    const sim = failedOver(false)

    expect(sim.startPgRewind()).toBe(true)
    expect(sim.state.highAvailability.rejoin.status).toBe('checking')
    advanceBy(sim, 1)
    expect(sim.state.highAvailability.rejoin.status).toBe('checking')
    advanceUntil(sim, () => sim.state.highAvailability.rejoin.status === 'failed')

    const rewind = sim.state.highAvailability.rejoin
    expect(rewind.elapsedSec).toBeGreaterThanOrEqual(2)
    expect(rewind.failureReason).toContain('wal_log_hints')
    expect(rewind.failureReason).toContain('checksums')
    expect(rewind.required).toBe(true)

    sim.setKnob('walLogHints', true)
    expect(sim.startPgRewind()).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.rejoin.status === 'failed')
    expect(sim.state.highAvailability.rejoin.failureReason).toContain('before divergence')
  })

  it('rewinds to the divergence point over a measured interval, then follows the new timeline', () => {
    const sim = failedOver()
    const oldEnd = sim.state.highAvailability.timeline.oldHistoryEndLsn
    const fork = sim.state.highAvailability.timeline.forkLsn

    expect(sim.startPgRewind()).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.rejoin.status === 'complete')

    const ha = sim.state.highAvailability
    expect(ha.rejoin.elapsedSec).toBeGreaterThan(2)
    expect(ha.rejoin.bytesRewound).toBe(oldEnd - fork)
    expect(ha.rejoin.required).toBe(false)
    expect(sim.state.cluster.nodes[0].role).toBe('standby')
    expect(sim.state.cluster.nodes[0].online).toBe(true)
    expect(sim.state.cluster.nodes[0].leaderOpinion).toBe(ha.currentLeader)
    expect(sim.state.cluster.nodes[0].wal.appliedLsn).toBeGreaterThanOrEqual(
      ha.timeline.forkLsn,
    )
  })

  it('fails after checking when the old data or divergence WAL is unavailable', () => {
    const noData = failedOver()
    noData.setKnob('oldPrimaryDataIntact', false)
    expect(noData.startPgRewind()).toBe(true)
    advanceUntil(noData, () => noData.state.highAvailability.rejoin.status === 'failed')
    expect(noData.state.highAvailability.rejoin.elapsedSec).toBeGreaterThanOrEqual(2)
    expect(noData.state.highAvailability.rejoin.failureReason).toContain('data directory')
    noData.setKnob('oldPrimaryDataIntact', true)
    expect(noData.startPgRewind()).toBe(true)
    advanceUntil(noData, () => noData.state.highAvailability.rejoin.status === 'complete')

    const noWal = failedOver()
    noWal.setKnob('rewindWalRetained', false)
    expect(noWal.startPgRewind()).toBe(true)
    advanceUntil(noWal, () => noWal.state.highAvailability.rejoin.status === 'failed')
    expect(noWal.state.highAvailability.rejoin.elapsedSec).toBeGreaterThanOrEqual(2)
    expect(noWal.state.highAvailability.rejoin.failureReason).toContain('recycled')
    noWal.setKnob('rewindWalRetained', true)
    expect(noWal.startPgRewind()).toBe(true)
    advanceUntil(noWal, () => noWal.state.highAvailability.rejoin.status === 'complete')
  })
})
