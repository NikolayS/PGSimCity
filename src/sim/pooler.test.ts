import { describe, expect, it } from 'vitest'

import { DEFAULT_KNOBS } from '../core/types'
import { createAggregateSim } from './test-support'

function advanceBy(
  sim: ReturnType<typeof createAggregateSim>,
  seconds: number,
  step = 1 / 15,
): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) sim.update(Math.min(step, until - sim.state.t))
}

describe('connection pooler', () => {
  it('separates PgBouncer clients from its bounded PostgreSQL backends', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'transaction')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 1_000)
    sim.setKnob('tps', 3_200)
    sim.setKnob('synchronousCommit', 'off')
    sim.setKnob('autovacuum', false)
    advanceBy(sim, 12)

    expect(sim.state.pooler.clientConnections).toBe(1_000)
    expect(sim.state.pooler.acceptedClients).toBe(1_000)
    expect(sim.state.pooler.refusedClients).toBe(0)
    expect(sim.state.pooler.serverLimit).toBe(8)
    expect(sim.state.stats.activeBackends).toBeLessThanOrEqual(8)
    expect(sim.state.pooler.serverConnections).toBe(sim.state.stats.activeBackends)
    expect(sim.state.stats.latency.p99.waits.poolSlotMs).toBeGreaterThan(0)
  })

  it('makes max_client_conn an admission limit, not a PostgreSQL backend limit', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'transaction')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 100)
    sim.setKnob('tps', 1_000)
    advanceBy(sim, 10)

    expect(sim.state.pooler.acceptedClients).toBe(100)
    expect(sim.state.pooler.refusedClients).toBe(900)
    expect(sim.state.pooler.serverLimit).toBe(8)
  })

  it('caps session pooling without claiming transaction-boundary queue attribution', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'session')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 1_000)
    sim.setKnob('tps', 3_200)
    advanceBy(sim, 12)

    expect(sim.state.pooler.acceptedClients).toBe(1_000)
    expect(sim.state.pooler.serverLimit).toBe(8)
    expect(sim.state.stats.activeBackends).toBeLessThanOrEqual(8)
    expect(sim.state.stats.latency.p99.waits.poolSlotMs).toBe(0)
  })

  it('keeps PgBouncer disabled in the stock city', () => {
    expect(DEFAULT_KNOBS.poolMode).toBe('disabled')
  })

  function stormReading(sim: ReturnType<typeof createAggregateSim>, seconds: number) {
    const commits = sim.state.stats.commits
    advanceBy(sim, seconds, 1 / 30)
    const latency = sim.state.stats.latency
    return {
      tps: (sim.state.stats.commits - commits) / seconds,
      p50: latency.p50.totalMs,
      p99: latency.p99.totalMs,
      poolSlotP50: latency.p50.waits.poolSlotMs,
      poolSlotP99: latency.p99.waits.poolSlotMs,
      runningP50: latency.p50.waits.runningMs,
      runningP99: latency.p99.waits.runningMs,
      backends: sim.state.stats.activeBackends,
      acceptedClients: sim.state.pooler.acceptedClients,
      refusedClients: sim.state.pooler.refusedClients,
    }
  }

  it('moves a connection storm from backend pressure to a transaction-pool queue', () => {
    const sim = createAggregateSim()
    sim.runScenario('connection-storm')
    advanceBy(sim, 28, 1 / 30)
    const direct = stormReading(sim, 15)
    advanceBy(sim, 33, 1 / 30)
    const pooled = stormReading(sim, 19)
    console.info('connection storm pooler measurement', { direct, pooled })

    expect(pooled.tps).toBeGreaterThan(direct.tps)
    expect(pooled.backends).toBeLessThan(direct.backends)
    expect(direct.poolSlotP50).toBe(0)
    expect(direct.poolSlotP99).toBe(0)
    expect(pooled.poolSlotP50).toBeGreaterThan(pooled.runningP50)
    expect(pooled.poolSlotP99).toBeGreaterThan(0)
    expect(direct.runningP99 / direct.p99).toBeGreaterThan(pooled.runningP99 / pooled.p99)
    expect(direct.refusedClients).toBeGreaterThan(0)
    expect(pooled.acceptedClients).toBe(1_000)
  })
})
