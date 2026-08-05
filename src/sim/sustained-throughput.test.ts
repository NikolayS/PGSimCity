import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { N_BACKEND_SLOTS } from '../core/types'
import { createSim } from './model'
import { FRAME_TEST_STEP } from './test-support'

type Sim = ReturnType<typeof createSim>

function advanceTo(sim: Sim, seconds: number): void {
  while (sim.state.t < seconds) {
    sim.update(FRAME_TEST_STEP)
  }
}

function addFlushedWalBacklog(sim: Sim, bytes: number): void {
  sim.state.wal.insertLsn += bytes
  sim.state.wal.writeLsn += bytes
  sim.state.wal.flushLsn += bytes
}

describe('free-running throughput', () => {
  it('continues completing work after scheduled maintenance', () => {
    const sim = createSim(createBus())

    advanceTo(sim, 35)
    const baselineStart = sim.state.stats.commits
    advanceTo(sim, 55)
    const baselineCommits = sim.state.stats.commits - baselineStart
    const baselineTps = baselineCommits / 20

    advanceTo(sim, 90)
    const sustainedStart = sim.state.stats.commits
    advanceTo(sim, 105)
    const sustainedCommits = sim.state.stats.commits - sustainedStart
    const sustainedTps = sustainedCommits / 15

    expect(
      sustainedTps,
      `steady throughput fell from ${baselineTps} to ${sustainedTps} tps`,
    ).toBeGreaterThan(baselineTps * 0.5)
  })

  it('uses one transport capacity for connected and reconnect WAL backlog', () => {
    const connected = createSim(createBus(), { scheduledBackups: false })
    const reconnect = createSim(createBus(), { scheduledBackups: false })
    for (const sim of [connected, reconnect]) {
      sim.setKnob('tps', 0)
      sim.setKnob('autovacuum', false)
    }

    reconnect.setKnob('standbyAEnabled', false)
    reconnect.update(FRAME_TEST_STEP)
    addFlushedWalBacklog(connected, 32 * 1024 * 1024)
    addFlushedWalBacklog(reconnect, 32 * 1024 * 1024)
    reconnect.setKnob('standbyAEnabled', true)

    const connectedStart = connected.state.replication.standbys[0].sentLsn
    const reconnectStart = reconnect.state.replication.standbys[0].sentLsn
    advanceTo(connected, connected.state.t + 0.5)
    advanceTo(reconnect, reconnect.state.t + 0.5)

    const connectedSent = connected.state.replication.standbys[0].sentLsn - connectedStart
    const reconnectSent = reconnect.state.replication.standbys[0].sentLsn - reconnectStart
    expect(connectedSent).toBe(reconnectSent)
  })

  it('keeps committing after the default scheduled backup without filling every wait slot', () => {
    const sim = createSim(createBus())
    let commitsAt100 = -1
    let maxCommitWaiters = 0

    while (sim.state.t < 105) {
      sim.update(FRAME_TEST_STEP)
      if (commitsAt100 < 0 && sim.state.t >= 100) commitsAt100 = sim.state.stats.commits
      maxCommitWaiters = Math.max(
        maxCommitWaiters,
        sim.state.backends.filter((backend) => backend.state === 'commit_wait').length,
      )
    }

    expect(maxCommitWaiters).toBeLessThan(N_BACKEND_SLOTS)
    expect(sim.state.stats.commits).toBeGreaterThan(commitsAt100)
  })

  it('preserves a full SyncRep outage behind a named slow-apply standby', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('synchronousCommit', 'remote_apply')
    sim.setKnob('synchronousStandbyNames', 'standbyA')
    sim.setKnob('standbyASlowApply', true)
    sim.setKnob('standbyANetworkLag', 65)
    sim.setKnob('tps', 1_100)
    sim.setKnob('writeRatio', 0.75)
    advanceTo(sim, 25)

    expect(
      sim.state.backends.filter((backend) => backend.state === 'commit_wait'),
    ).toHaveLength(N_BACKEND_SLOTS)
    const commits = sim.state.stats.commits
    for (let sample = 0; sample < 25; sample++) {
      sim.update(FRAME_TEST_STEP)
      expect(sim.state.stats.commits).toBe(commits)
    }

    sim.setKnob('standbyAEnabled', false)
    for (let sample = 0; sample < 25; sample++) {
      sim.update(FRAME_TEST_STEP)
      expect(
        sim.state.backends.filter((backend) => backend.state === 'commit_wait'),
      ).toHaveLength(N_BACKEND_SLOTS)
      expect(sim.state.stats.commits).toBe(commits)
    }
  })
})
