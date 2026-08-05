import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { DEFAULT_KNOBS, TPS_MEASUREMENT_WINDOW_SECONDS } from '../core/types'
import { createSim } from './model'
import { FRAME_TEST_STEP } from './test-support'

describe('simulation boot lifecycle', () => {
  it('returns a warm city without reporting a user reset', () => {
    const bus = createBus()
    let resets = 0
    bus.on('sim:reset', () => resets++)

    const sim = createSim(bus)

    expect(sim.state.buffers.usedCount).toBeGreaterThan(0)
    expect(sim.state.stats.commits).toBeGreaterThan(0)
    expect(sim.state.wal.bytesPerSec).toBeGreaterThan(0)
    expect(sim.state.checkpoint.nextInSec).toBeLessThan(DEFAULT_KNOBS.checkpointTimeout)
    expect(resets).toBe(0)

    sim.reset()
    expect(resets).toBe(1)
    expect(sim.state.buffers.usedCount).toBeGreaterThan(0)
    expect(sim.state.wal.bytesPerSec).toBeGreaterThan(0)
  })
})

describe('steady-workload TPS readout', () => {
  it('does not report a collapse when achieved throughput stays healthy', { timeout: 30_000 }, () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    const start = sim.state.t
    const end = start + 900
    const offered = sim.state.knobs.tps
    const windowSeconds = 10
    let nextWindow = start + windowSeconds
    let windowCommits = sim.state.stats.commits
    let minWindowTps = Infinity
    let minReadout = Infinity

    while (sim.state.t < end) {
      const dt = Math.min(FRAME_TEST_STEP, end - sim.state.t)
      sim.update(dt)
      minReadout = Math.min(minReadout, sim.state.stats.tps)

      if (sim.state.t + 1e-9 >= nextWindow) {
        const actual = (sim.state.stats.commits - windowCommits) / windowSeconds
        minWindowTps = Math.min(minWindowTps, actual)
        windowCommits = sim.state.stats.commits
        nextWindow += windowSeconds
      }
    }

    expect(minWindowTps).toBeGreaterThan(offered * 0.4)
    expect(minReadout).toBeGreaterThan(offered * 0.4)
  })

  it('reports a sustained halt within one measurement window', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 0)
    const end = sim.state.t + TPS_MEASUREMENT_WINDOW_SECONDS + 1

    while (sim.state.t < end) {
      sim.update(Math.min(FRAME_TEST_STEP, end - sim.state.t))
    }

    expect(sim.state.stats.tps).toBeLessThan(1)
  })
})
