import { describe, expect, it } from 'vitest'
import type { LatencyWaits, SyncCommit } from '../core/types'
import { createAggregateSim, AGGREGATE_TEST_STEP, FRAME_TEST_STEP } from './test-support'

function advanceBy(sim: ReturnType<typeof createAggregateSim>, seconds: number): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
  }
}

describe('modeled transaction latency', () => {
  it('keeps ordered quantiles whose p99 trip decomposes into its causes', () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 0.6)
    advanceBy(sim, 60)

    const { latency } = sim.state.stats
    expect(latency.transactions).toBeGreaterThan(100)
    expect(latency.p50.totalMs).toBeGreaterThan(0)
    expect(latency.p99.totalMs).toBeGreaterThanOrEqual(latency.p50.totalMs)
    expect(
      latency.p99.waits.bufferReadMs
      + latency.p99.waits.dirtyWriteMs
      + latency.p99.waits.commitMs
      + latency.p99.waits.lockMs
      + latency.p99.waits.runningMs,
    ).toBeCloseTo(latency.p99.totalMs, 4)
  })

  interface BgwriterReading {
    tps: number
    p50: number
    p99: number
    waits: LatencyWaits
  }

  function readBgwriterWindow(
    sim: ReturnType<typeof createAggregateSim>,
    seconds: number,
  ): BgwriterReading {
    const commits = sim.state.stats.commits
    advanceBy(sim, seconds)
    return {
      tps: (sim.state.stats.commits - commits) / seconds,
      p50: sim.state.stats.latency.p50.totalMs,
      p99: sim.state.stats.latency.p99.totalMs,
      waits: { ...sim.state.stats.latency.p99.waits },
    }
  }

  function bgwriterReadings(): { before: BgwriterReading; after: BgwriterReading } {
    const sim = createAggregateSim(FRAME_TEST_STEP)
    sim.setKnob('tps', 450)
    sim.setKnob('writeRatio', 0.75)
    sim.setKnob('updateRatio', 0.65)
    sim.setKnob('seqScanRatio', 0)
    sim.setKnob('sharedBuffers', 384)
    sim.setKnob('bgwriterEnabled', true)
    sim.setKnob('bgwriterLruMaxpages', 100)
    sim.setKnob('autovacuum', false)
    sim.setKnob('checkpointTimeout', 150)
    sim.setKnob('maxWalSize', 512)
    advanceBy(sim, 300)
    const before = readBgwriterWindow(sim, 120)
    sim.setKnob('bgwriterEnabled', false)
    const after = readBgwriterWindow(sim, 120)
    return { before, after }
  }

  it('measures the no-bgwriter claim without assuming that it holds', { timeout: 30_000 }, () => {
    const { before, after } = bgwriterReadings()
    console.info('bgwriter latency measurement', { before, after })

    expect(
      Math.abs(after.tps - before.tps) / before.tps,
      `before=${before.tps}; after=${after.tps}`,
    ).toBeLessThan(0.03)
    expect(after.p50).toBeGreaterThan(0)
    expect(after.p99).toBeGreaterThanOrEqual(after.p50)
    expect(after.p99, `the shipped claim unexpectedly changed: before=${before.p99}; after=${after.p99}`)
      .toBeLessThanOrEqual(before.p99)
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
