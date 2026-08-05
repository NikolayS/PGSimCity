import { describe, expect, it } from 'vitest'

import { DEFAULT_KNOBS, N_BACKEND_SLOTS } from '../core/types'
import { backendConcurrencyMultiplier } from './model'
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
    advanceBy(sim, 20)

    expect(sim.state.pooler.clientConnections).toBe(1_000)
    expect(sim.state.pooler.acceptedClients).toBe(1_000)
    expect(sim.state.pooler.refusedClients).toBe(0)
    expect(sim.state.pooler.serverLimit).toBe(8)
    expect(sim.state.pooler.serverCapacity).toBe(8)
    expect(sim.state.pooler.boundClients).toBe(0)
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

  it('binds session clients until their modeled connection lifetime ends', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'session')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 1_000)
    sim.setKnob('tps', 100)
    advanceBy(sim, 20)

    expect(sim.state.pooler.acceptedClients).toBe(1_000)
    expect(sim.state.pooler.serverLimit).toBe(8)
    expect(sim.state.pooler.boundClients).toBe(8)
    expect(sim.state.pooler.waitingClients).toBe(992)
    expect(sim.state.pooler.serverOfferedTps).toBeCloseTo(0.8)
    expect(sim.state.pooler.sessionPendingTransactions.slice(8)).toEqual(Array(8).fill(0))
    expect(sim.state.pooler.sessionPendingTransactions.slice(0, 8).some((count) => count > 0))
    expect(sim.state.stats.activeBackends).toBeLessThanOrEqual(8)
    expect(sim.state.stats.latency.p99.waits.poolSlotMs).toBeGreaterThan(0)

    advanceBy(sim, 110)
    expect(sim.state.stats.poolerQueryWaitTimeouts).toBeGreaterThan(0)
    expect(sim.state.pooler.disconnectedClients).toBeGreaterThan(0)
  })

  it('keeps PgBouncer disabled in the stock city', () => {
    expect(DEFAULT_KNOBS.poolMode).toBe('disabled')
    expect(DEFAULT_KNOBS.queryWaitTimeout).toBe(120)
  })

  it('enforces autocommit by rejecting transaction blocks in statement mode', () => {
    const transaction = createAggregateSim()
    transaction.setKnob('poolMode', 'transaction')
    transaction.setKnob('longRunningXact', true)

    expect(transaction.state.knobs.longRunningXact).toBe(true)
    expect(transaction.state.pooler.statementTransactionRejects).toBe(0)
    expect(transaction.state.pooler.disconnectedClients).toBe(0)

    transaction.setKnob('poolMode', 'statement')
    expect(transaction.state.knobs.longRunningXact).toBe(false)
    expect(transaction.state.pooler.statementTransactionRejects).toBe(1)
    expect(transaction.state.pooler.disconnectedClients).toBe(1)

    const statement = createAggregateSim()
    statement.setKnob('poolMode', 'statement')
    statement.setKnob('longRunningXact', true)

    expect(statement.state.knobs.longRunningXact).toBe(false)
    expect(statement.state.pooler.statementTransactionRejects).toBe(1)
    expect(statement.state.pooler.disconnectedClients).toBe(1)

    statement.setKnob('lockContention', true)
    expect(statement.state.knobs.lockContention).toBe(false)
    expect(statement.state.pooler.statementTransactionRejects).toBe(2)
    expect(statement.state.pooler.disconnectedClients).toBe(2)
  })

  it('uses the multiplexed query queue and wait timeout in statement mode', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'statement')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 1_000)
    sim.setKnob('queryWaitTimeout', 20)
    sim.setKnob('tps', 3_200)
    sim.setKnob('synchronousCommit', 'off')
    sim.setKnob('autovacuum', false)
    advanceBy(sim, 40, 0.1)

    expect(sim.state.pooler.acceptedClients).toBe(1_000)
    expect(sim.state.pooler.boundClients).toBe(0)
    expect(sim.state.stats.activeBackends).toBeLessThanOrEqual(8)
    expect(sim.state.stats.latency.p99.waits.poolSlotMs).toBeGreaterThan(0)
    expect(sim.state.stats.poolerQueryWaitTimeouts).toBeGreaterThan(0)
    expect(sim.state.pooler.disconnectedClients).toBeGreaterThan(0)
  })

  it('keeps every transaction queued until query_wait_timeout expires', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 1_000)
    sim.setKnob('poolMode', 'transaction')
    sim.setKnob('defaultPoolSize', 8)
    sim.setKnob('maxClientConn', 1_000)
    sim.setKnob('queryWaitTimeout', 120)
    sim.setKnob('tps', 3_200)
    sim.setKnob('synchronousCommit', 'off')
    sim.setKnob('autovacuum', false)
    advanceBy(sim, 35)

    expect(sim.state.stats.poolerQueryWaitTimeouts).toBe(0)
    expect(sim.state.stats.poolerQueuedTransactions).toBeGreaterThan(3_200 * 10)
    expect(sim.state.stats.latency.p99.waits.poolSlotMs).toBeGreaterThan(10_500)
    expect(sim.state.pooler.disconnectedClients).toBe(0)
  })

  it('disconnects timed-out waiters while zero queues indefinitely', () => {
    const timed = createAggregateSim()
    timed.setKnob('clientConnections', 1_000)
    timed.setKnob('poolMode', 'transaction')
    timed.setKnob('defaultPoolSize', 8)
    timed.setKnob('maxClientConn', 1_000)
    timed.setKnob('queryWaitTimeout', 20)
    timed.setKnob('tps', 3_200)
    timed.setKnob('synchronousCommit', 'off')
    timed.setKnob('autovacuum', false)

    const indefinite = createAggregateSim()
    indefinite.setKnob('clientConnections', 1_000)
    indefinite.setKnob('poolMode', 'transaction')
    indefinite.setKnob('defaultPoolSize', 8)
    indefinite.setKnob('maxClientConn', 1_000)
    indefinite.setKnob('queryWaitTimeout', 0)
    indefinite.setKnob('tps', 3_200)
    indefinite.setKnob('synchronousCommit', 'off')
    indefinite.setKnob('autovacuum', false)

    advanceBy(timed, 40, 0.1)
    advanceBy(indefinite, 40, 0.1)

    expect(timed.state.stats.poolerQueryWaitTimeouts).toBeGreaterThan(0)
    expect(timed.state.pooler.disconnectedClients).toBeGreaterThan(0)
    expect(indefinite.state.stats.poolerQueryWaitTimeouts).toBe(0)
    expect(indefinite.state.pooler.disconnectedClients).toBe(0)
    expect(indefinite.state.stats.poolerQueuedTransactions)
      .toBeGreaterThan(timed.state.stats.poolerQueuedTransactions)
  })

  it('derives statement pressure only from connected PostgreSQL backends', () => {
    const sim = createAggregateSim()
    sim.runScenario('connection-storm')
    advanceBy(sim, 8)

    expect(sim.state.stats.backendConcurrencyMultiplier)
      .toBe(backendConcurrencyMultiplier(sim.state.stats.activeBackends))

    sim.setKnob('clientConnections', N_BACKEND_SLOTS + 1)
    advanceBy(sim, 0.1)

    expect(sim.state.pooler.refusedClients).toBe(1)
    expect(sim.state.stats.backendConcurrencyMultiplier)
      .toBe(backendConcurrencyMultiplier(sim.state.stats.activeBackends))
  })

  it('keeps aggregate offered work independent of refused direct client sockets', () => {
    function directReading(clientConnections: number) {
      const sim = createAggregateSim()
      sim.setKnob('clientConnections', clientConnections)
      sim.setKnob('poolMode', 'disabled')
      sim.setKnob('tps', 3_200)
      sim.setKnob('writeRatio', 0.4)
      sim.setKnob('updateRatio', 0.6)
      sim.setKnob('seqScanRatio', 0)
      sim.setKnob('sharedBuffers', 640)
      sim.setKnob('synchronousCommit', 'off')
      sim.setKnob('autovacuum', false)
      advanceBy(sim, 20)
      return {
        serverOfferedTps: sim.state.pooler.serverOfferedTps,
        achievedTps: sim.state.stats.tps,
        backends: sim.state.stats.activeBackends,
      }
    }

    const sixteen = directReading(16)
    const hundred = directReading(100)
    const thousand = directReading(1_000)

    expect([sixteen.serverOfferedTps, hundred.serverOfferedTps, thousand.serverOfferedTps])
      .toEqual([3_200, 3_200, 3_200])
    expect([hundred.backends, thousand.backends]).toEqual([
      sixteen.backends,
      sixteen.backends,
    ])
    expect(hundred.achievedTps).toBeCloseTo(sixteen.achievedTps, 8)
    expect(thousand.achievedTps).toBeCloseTo(sixteen.achievedTps, 8)
  })

  it('shows session binding trading throughput for compatibility under held clients', () => {
    function pooledReading(mode: 'session' | 'transaction') {
      const sim = createAggregateSim()
      sim.setKnob('clientConnections', 1_000)
      sim.setKnob('poolMode', mode)
      sim.setKnob('defaultPoolSize', 8)
      sim.setKnob('maxClientConn', 1_000)
      sim.setKnob('tps', 3_200)
      sim.setKnob('writeRatio', 0.4)
      sim.setKnob('updateRatio', 0.6)
      sim.setKnob('seqScanRatio', 0)
      sim.setKnob('sharedBuffers', 640)
      sim.setKnob('synchronousCommit', 'off')
      sim.setKnob('autovacuum', false)
      advanceBy(sim, 40)
      return {
        tps: sim.state.stats.tps,
        waiting: sim.state.pooler.waitingClients,
        poolSlotP99: sim.state.stats.latency.p99.waits.poolSlotMs,
        bound: sim.state.pooler.boundClients,
      }
    }

    const session = pooledReading('session')
    const transaction = pooledReading('transaction')

    expect(session.bound).toBe(8)
    expect(session.waiting).toBe(992)
    expect(session.poolSlotP99).toBeGreaterThan(0)
    expect(transaction.tps).toBeGreaterThan(session.tps)
  })

  it('does not make PgBouncer coordinate its server target with max_connections', () => {
    const sim = createAggregateSim()
    sim.setKnob('clientConnections', 100)
    sim.setKnob('poolMode', 'transaction')
    sim.setKnob('defaultPoolSize', 20)
    sim.setKnob('tps', 1_000)
    advanceBy(sim, 8)

    expect(sim.state.pooler.serverLimit).toBe(20)
    expect(sim.state.pooler.serverCapacity).toBe(N_BACKEND_SLOTS)
    expect(sim.state.pooler.serverConnectionErrors).toBe(4)
    expect(sim.state.stats.activeBackends).toBeLessThanOrEqual(N_BACKEND_SLOTS)
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
      queuedTransactions: sim.state.stats.poolerQueuedTransactions,
      waitTimeouts: sim.state.stats.poolerQueryWaitTimeouts,
      pressureMultiplier: sim.state.stats.backendConcurrencyMultiplier,
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

    expect(pooled.backends).toBeLessThan(direct.backends)
    expect(direct.poolSlotP50).toBe(0)
    expect(direct.poolSlotP99).toBe(0)
    expect(pooled.poolSlotP99).toBeGreaterThan(0)
    expect(direct.pressureMultiplier).toBeGreaterThan(pooled.pressureMultiplier)
    expect(direct.refusedClients).toBe(0)
    expect(pooled.acceptedClients).toBe(1_000)
    expect(pooled.waitTimeouts).toBe(0)
    expect(pooled.queuedTransactions).toBeGreaterThan(0)
  })
})
