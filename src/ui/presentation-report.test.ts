import { describe, expect, it } from 'vitest'
import type { ReplayComparison, ReplayOutcome } from '../sim/replay'
import { presentationComparisonLines } from './presentation-report'

function comparison(sameDuration = true): ReplayComparison {
  const baseline: ReplayOutcome = {
    elapsedTicks: 90, elapsedModelSeconds: 3, scenario: 'vacuum-blockade',
    commits: 1234, rollbacks: 2, throughputTps: 51.25, latencyP99ModelMs: 3.5,
    deadTuples: 876, tablePages: 40, reclaimedTuples: 22, retainedWalBytes: 4096,
    rejectedWrites: 0, lostTransactions: 4,
  }
  return {
    seed: 42, checkpoint: { tick: 30, actionCount: 2 }, baseline,
    current: { ...baseline, elapsedModelSeconds: sameDuration ? 3 : 2, reclaimedTuples: 30 },
    sameDuration,
    baselineActions: [{ tick: 30, type: 'decision', choice: 'wait-for-transaction' }],
    currentActions: [{ tick: 30, type: 'knob', key: 'workMem', value: 64 }],
  } as ReplayComparison
}

describe('presentation comparison explanation', () => {
  it('retains seeded checkpoint provenance, model clock basis and both outcome values', () => {
    const text = presentationComparisonLines(comparison()).join('\n')
    expect(text).toContain('Seed 42; checkpoint step 30, after recorded action 2')
    expect(text).toContain('Original 3.00; alternative 3.00 model seconds since replay origin')
    expect(text).toContain('Tuples reclaimed (tuples): original 22; alternative 30')
    expect(text).toContain('p99 latency (model ms): original 3.5; alternative 3.5')
    expect(text).toContain('WAL retained by physical slots (bytes): original 4,096; alternative 4,096')
    expect(text).toContain('not PostgreSQL measurements')
    expect(text).toContain('PGlite results are separate')
    expect(text).toContain('not changes since checkpoint')
    expect(text).toContain('city scene shows the alternative')
  })

  it('makes unequal duration explicit while retaining original and alternative readings', () => {
    const text = presentationComparisonLines(comparison(false)).join('\n')
    expect(text).toContain('Different model durations — not a controlled comparison')
    expect(text).toContain('Original 3.00; alternative 2.00 model seconds')
    expect(text).not.toContain('Same model duration')
  })

  it('records both branches choices with step order and distinguishes raw model knobs', () => {
    const text = presentationComparisonLines(comparison()).join('\n')
    expect(text).toContain('Original recorded actions after checkpoint (1 total)')
    expect(text).toContain('step 30: decision wait-for-transaction')
    expect(text).toContain('Alternative recorded actions after checkpoint (1 total)')
    expect(text).toContain('step 30: knob workMem = 64 (raw model value)')
  })

  it('bounds action lists with an explicit omitted count and does not mutate evidence', () => {
    const result = comparison()
    result.baselineActions = Array.from({ length: 1024 }, (_, tick) => ({ tick, type: 'recover' }))
    result.currentActions = []
    const before = structuredClone(result)
    const lines = presentationComparisonLines(result)
    expect(lines.filter((line) => line.includes(': recover'))).toHaveLength(6)
    expect(lines).toContain('1,018 additional recorded actions omitted from this image.')
    expect(lines).toContain('Alternative recorded actions after checkpoint (0 total): none.')
    expect(result).toEqual(before)
  })
})
