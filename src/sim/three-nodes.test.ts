import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { PROJECTIONS } from '../observability/views'
import { createSim } from './model'
import { AGGREGATE_TEST_STEP, createAggregateSim } from './test-support'

const MIB = 1024 * 1024

type Sim = ReturnType<typeof createSim>

function advanceBy(sim: Sim, seconds: number): void {
  const target = sim.state.t + seconds
  while (sim.state.t < target) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, target - sim.state.t))
  }
}

function advanceUntil(
  sim: Sim,
  done: () => boolean,
  seconds: number,
): void {
  const deadline = sim.state.t + seconds
  while (!done() && sim.state.t < deadline) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, deadline - sim.state.t))
  }
}

describe('three-node physical cluster', () => {
  it('gives every node its own buffer pool, WAL, data directory, and leader opinion', () => {
    const sim = createSim(createBus())
    const [primary, standbyA, standbyB] = sim.state.cluster.nodes

    expect([primary.id, standbyA.id, standbyB.id]).toEqual([
      'primary',
      'standbyA',
      'standbyB',
    ])
    expect([primary.role, standbyA.role, standbyB.role]).toEqual([
      'primary',
      'standby',
      'standby',
    ])
    expect(new Set(sim.state.cluster.nodes.map((node) => node.buffers)).size).toBe(3)
    expect(new Set(sim.state.cluster.nodes.map((node) => node.wal)).size).toBe(3)
    expect(new Set(sim.state.cluster.nodes.map((node) => node.dataDirectory)).size).toBe(3)
    expect(sim.state.cluster.nodes.map((node) => node.leaderOpinion)).toEqual([
      'primary',
      'primary',
      'primary',
    ])
    expect(sim.state.replication.standbys).toHaveLength(2)
    expect(sim.state.replication.physicalSlots).toHaveLength(2)
  })

  it('lets one standby replay slowly while the other disconnects independently', () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('standbyBSlowApply', true)
    advanceBy(sim, 45)

    const [standbyA, standbyB] = sim.state.replication.standbys
    expect(standbyA.connected).toBe(true)
    expect(standbyB.connected).toBe(true)
    expect(standbyB.receivedLsn).toBeGreaterThanOrEqual(standbyB.flushedLsn)
    expect(standbyB.flushedLsn).toBeGreaterThan(standbyB.appliedLsn)
    expect(standbyB.lagBytes).toBeGreaterThan(standbyA.lagBytes + 8 * MIB)

    const disconnectedAt = standbyA.flushedLsn
    sim.setKnob('standbyAEnabled', false)
    advanceBy(sim, 25)

    expect(standbyA.connected).toBe(false)
    expect(standbyA.flushedLsn).toBe(disconnectedAt)
    expect(standbyB.connected).toBe(true)
    expect(standbyB.flushedLsn).toBeGreaterThan(disconnectedAt)
    expect(sim.state.replication.physicalSlots[0].active).toBe(false)
    expect(sim.state.replication.physicalSlots[0].retainedBytes).toBeGreaterThan(0)
    expect(sim.state.replication.physicalSlots[1].active).toBe(true)
  })

  it('fills the primary WAL volume through a slot for a disconnected standby', { timeout: 20_000 }, () => {
    const sim = createAggregateSim()
    sim.setKnob('walGArchiveCredentialsValid', true)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyAEnabled', false)
    sim.setKnob('tps', 5000)
    sim.setKnob('writeRatio', 1)

    const deadline = sim.state.t + 240
    while (!sim.state.disasterRecovery.archive.writesBlocked && sim.state.t < deadline) {
      sim.update(AGGREGATE_TEST_STEP)
    }

    const slot = sim.state.replication.physicalSlots[0]
    expect(slot.active).toBe(false)
    expect(slot.retainedBytes).toBeGreaterThan(256 * MIB)
    expect(sim.state.disasterRecovery.archive.pgWalBytes).toBeGreaterThanOrEqual(
      sim.state.disasterRecovery.archive.pgWalCapacityBytes,
    )
    expect(sim.state.disasterRecovery.archive.writesBlocked).toBe(true)

    const heldAt = slot.restartLsn
    sim.setKnob('standbyAEnabled', true)
    advanceUntil(
      sim,
      () => slot.active
        && slot.restartLsn > heldAt
        && slot.retainedBytes < 64 * MIB
        && !sim.state.disasterRecovery.archive.writesBlocked,
      90,
    )

    expect(slot.active).toBe(true)
    expect(slot.restartLsn).toBeGreaterThan(heldAt)
    expect(slot.retainedBytes).toBeLessThan(64 * MIB)
    expect(sim.state.disasterRecovery.archive.writesBlocked).toBe(false)
  })

  it('stores disagreement without electing or promoting a node', () => {
    const sim = createSim(createBus())

    sim.setLeaderOpinion('standbyB', 'standbyA')

    expect(sim.state.cluster.nodes.map((node) => node.leaderOpinion)).toEqual([
      'primary',
      'primary',
      'standbyA',
    ])
    expect(sim.state.cluster.nodes.map((node) => node.role)).toEqual([
      'primary',
      'standby',
      'standby',
    ])
  })

  it('projects one pg_stat_replication row and one physical slot per standby', () => {
    const sim = createSim(createBus())
    const replication = PROJECTIONS.replication(sim.state, undefined as never, 'rate')
    const slots = PROJECTIONS.slots(sim.state, undefined as never, 'rate')

    expect(replication.rows.map((row) => row.key)).toEqual(['standbyA', 'standbyB'])
    expect(slots.rows.map((row) => row.key)).toEqual([
      'standby_a_slot',
      'standby_b_slot',
    ])

    sim.setKnob('standbyBEnabled', false)
    advanceBy(sim, 2)
    const disconnected = PROJECTIONS.replication(
      sim.state,
      undefined as never,
      'rate',
    )
    const heldSlots = PROJECTIONS.slots(sim.state, undefined as never, 'rate')

    expect(disconnected.rows.map((row) => row.key)).toEqual(['standbyA'])
    expect(heldSlots.rows).toHaveLength(2)
  })
})
