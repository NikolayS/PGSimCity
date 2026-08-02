import { describe, expect, it } from 'vitest'
import type { SyncCommit } from '../core/types'
import { createAggregateSim, AGGREGATE_TEST_STEP, FRAME_TEST_STEP } from './test-support'

function advanceBy(sim: ReturnType<typeof createAggregateSim>, seconds: number): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
  }
}

describe('modeled transaction latency', () => {
  it('keeps independent ordered quantiles and an additive mean anatomy', () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    advanceBy(sim, 60)

    const { latency } = sim.state.stats
    expect(latency.transactions).toBeGreaterThan(100)
    expect(latency.p50.totalMs).toBeGreaterThan(0)
    expect(latency.p99.totalMs).toBeGreaterThanOrEqual(latency.p50.totalMs)
    const meanWaits = latency.mean.waits
    expect(
      meanWaits.bufferReadMs
      + meanWaits.dirtyWriteMs
      + meanWaits.commitMs
      + meanWaits.lockMs
      + meanWaits.runningMs,
    ).toBeCloseTo(latency.mean.totalMs, 4)

    for (const component of Object.keys(latency.p50.waits) as (keyof typeof latency.p50.waits)[]) {
      expect(latency.p99.waits[component]).toBeGreaterThanOrEqual(latency.p50.waits[component])
    }
  })

  function evictionWalWaitMean(bgwriterEnabled: boolean): number {
    let collecting = false
    let weightedWait = 0
    let transactions = 0
    const sim = createAggregateSim(FRAME_TEST_STEP, (observation) => {
      if (!collecting) return
      weightedWait += observation.evictionWalFlushMs * observation.transactions
      transactions += observation.transactions
    })
    sim.setKnob('tps', 450)
    sim.setKnob('writeRatio', 0.75)
    sim.setKnob('updateRatio', 0.65)
    sim.setKnob('seqScanRatio', 0)
    sim.setKnob('sharedBuffers', 384)
    sim.setKnob('bgwriterEnabled', bgwriterEnabled)
    sim.setKnob('bgwriterLruMaxpages', 100)
    sim.setKnob('autovacuum', false)
    sim.setKnob('checkpointTimeout', 150)
    sim.setKnob('maxWalSize', 512)
    // Commit acknowledgements stop waiting, but FlushBuffer's write-ahead rule does not.
    sim.setKnob('synchronousCommit', 'off')
    advanceBy(sim, 300)
    collecting = true
    advanceBy(sim, 120)
    return weightedWait / transactions
  }

  it('raises inline dirty-victim WAL-flush wait with the bgwriter off', { timeout: 30_000 }, () => {
    const withBgwriter = evictionWalWaitMean(true)
    const withoutBgwriter = evictionWalWaitMean(false)

    expect(
      withoutBgwriter,
      `with bgwriter=${withBgwriter}; without bgwriter=${withoutBgwriter}`,
    ).toBeGreaterThan(withBgwriter)
  })

  function synchronousCommitReading(mode: SyncCommit): { p50: number; p99: number; tps: number } {
    const sim = createAggregateSim(FRAME_TEST_STEP)
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    sim.setKnob('seqScanRatio', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('standbyANetworkLag', 50)
    sim.setKnob('synchronousCommit', mode)
    advanceBy(sim, 180)
    const commits = sim.state.stats.commits
    advanceBy(sim, 60)
    return {
      p50: sim.state.stats.latency.p50.totalMs,
      p99: sim.state.stats.latency.p99.totalMs,
      tps: (sim.state.stats.commits - commits) / 60,
    }
  }

  it('measures the synchronous_commit latency ladder directly', { timeout: 30_000 }, () => {
    const modes: SyncCommit[] = ['off', 'local', 'remote_write', 'on', 'remote_apply']
    const readings = modes.map((mode) => synchronousCommitReading(mode))
    console.info('synchronous_commit latency measurement',
      Object.fromEntries(modes.map((mode, index) => [mode, readings[index]])))

    for (let i = 1; i < readings.length; i++) {
      expect(readings[i].p50, `${modes[i - 1]}=${readings[i - 1].p50}; ${modes[i]}=${readings[i].p50}`)
        .toBeGreaterThan(readings[i - 1].p50)
      expect(readings[i].p99, `${modes[i - 1]}=${readings[i - 1].p99}; ${modes[i]}=${readings[i].p99}`)
        .toBeGreaterThan(readings[i - 1].p99)
    }
  })

  it('attributes a completed lock timeout to the latency tail', () => {
    const sim = createAggregateSim(FRAME_TEST_STEP)
    sim.runScenario('lock-pileup')
    advanceBy(sim, 80)

    expect(sim.state.stats.latency.p99.waits.lockMs).toBeGreaterThan(10_000)
    expect(sim.state.stats.latency.p99.totalMs)
      .toBeGreaterThan(sim.state.stats.latency.p50.totalMs * 5)
  })
})
