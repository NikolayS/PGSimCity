import { expect, it } from 'vitest'
import type { SyncCommit } from '../core/types'
import type { ModelLatencyObservation } from './model'
import { createAggregateSim, FRAME_TEST_STEP } from './test-support'

const WARMUP_SECONDS = 300
const WINDOW_SECONDS = 120

function advanceBy(sim: ReturnType<typeof createAggregateSim>, seconds: number): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) {
    sim.update(Math.min(FRAME_TEST_STEP, until - sim.state.t))
  }
}

function weightedQuantile(
  observations: readonly ModelLatencyObservation[],
  read: (observation: ModelLatencyObservation) => number,
  fraction: number,
): number {
  const ordered = observations
    .map((observation) => ({ value: read(observation), weight: observation.transactions }))
    .sort((a, b) => a.value - b.value)
  const population = ordered.reduce((sum, observation) => sum + observation.weight, 0)
  const rank = Math.max(1, Math.ceil(population * fraction))
  let cumulative = 0
  for (const observation of ordered) {
    cumulative += observation.weight
    if (cumulative >= rank) return observation.value
  }
  return ordered.at(-1)?.value ?? 0
}

function weightedMean(
  observations: readonly ModelLatencyObservation[],
  read: (observation: ModelLatencyObservation) => number,
): number {
  let sum = 0
  let population = 0
  for (const observation of observations) {
    sum += read(observation) * observation.transactions
    population += observation.transactions
  }
  return population > 0 ? sum / population : 0
}

function distribution(
  observations: readonly ModelLatencyObservation[],
  read: (observation: ModelLatencyObservation) => number,
): { p50: number; p99: number; p999: number; mean: number } {
  return {
    p50: weightedQuantile(observations, read, 0.5),
    p99: weightedQuantile(observations, read, 0.99),
    p999: weightedQuantile(observations, read, 0.999),
    mean: weightedMean(observations, read),
  }
}

function roundDistribution(values: ReturnType<typeof distribution>): ReturnType<typeof distribution> {
  return {
    p50: Number(values.p50.toFixed(3)),
    p99: Number(values.p99.toFixed(3)),
    p999: Number(values.p999.toFixed(3)),
    mean: Number(values.mean.toFixed(3)),
  }
}

function measureArm(bgwriterEnabled: boolean, synchronousCommit: SyncCommit) {
  const observations: ModelLatencyObservation[] = []
  const sim = createAggregateSim(FRAME_TEST_STEP, (observation) => {
    observations.push(observation)
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
  sim.setKnob('synchronousCommit', synchronousCommit)
  advanceBy(sim, WARMUP_SECONDS)

  observations.length = 0
  const commits = sim.state.stats.commits
  advanceBy(sim, WINDOW_SECONDS)
  const transactions = observations.reduce((sum, observation) => sum + observation.transactions, 0)
  const evictionWalWaitTransactions = observations.reduce(
    (sum, observation) => sum + (
      observation.evictionWalFlushMs > 0 ? observation.transactions : 0
    ),
    0,
  )
  return {
    bgwriter: bgwriterEnabled ? 'on' : 'off',
    synchronousCommit,
    observations: observations.length,
    transactions,
    evictionWalWaitTransactionsPercent: Number(
      ((evictionWalWaitTransactions / transactions) * 100).toFixed(3),
    ),
    tps: Number(((sim.state.stats.commits - commits) / WINDOW_SECONDS).toFixed(3)),
    totalMs: roundDistribution(distribution(observations, (observation) => observation.totalMs)),
    dirtyWriteMs: roundDistribution(
      distribution(observations, (observation) => observation.waits.dirtyWriteMs),
    ),
    evictionWalFlushMs: roundDistribution(
      distribution(observations, (observation) => observation.evictionWalFlushMs),
    ),
  }
}

it('measures full-window bgwriter latency populations', { timeout: 30_000 }, () => {
  const rows = [
    measureArm(true, 'on'),
    measureArm(false, 'on'),
    measureArm(true, 'off'),
    measureArm(false, 'off'),
  ]

  console.info('full-window bgwriter latency populations', JSON.stringify(rows, null, 2))
  expect(rows.every((row) => row.observations > 512)).toBe(true)
})
