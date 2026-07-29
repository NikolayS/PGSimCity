import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import type { SimApi, SimState } from '../core/types'
import { createSim } from './model'

function step(sim: SimApi, seconds: number): void {
  const frames = Math.ceil(seconds * 30)
  for (let i = 0; i < frames; i++) sim.update(1 / 30)
}

function deadTuples(state: SimState): number {
  let total = 0
  for (let i = 0; i < state.tables.length; i++) total += state.tables[i].deadTuples
  return total
}

function maxBloat(state: SimState): number {
  let max = 0
  for (let i = 0; i < state.tables.length; i++) max = Math.max(max, state.tables[i].bloat)
  return max
}

describe('autovacuum in-world handle consequence', () => {
  it('accumulates bloat while off, then launches delayed cleanup when re-enabled', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    step(sim, 45)

    expect(sim.state.autovac.enabled).toBe(false)
    expect(sim.state.autovac.workers.every((worker) => !worker.active)).toBe(true)

    sim.setKnob('tps', 180)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('updateRatio', 0.9)
    const runsBefore = sim.state.autovac.totalRuns
    const deadBefore = deadTuples(sim.state)
    const bloatBefore = maxBloat(sim.state)

    step(sim, 240)
    const deadOff = deadTuples(sim.state)
    const bloatOff = maxBloat(sim.state)

    expect(sim.state.autovac.totalRuns).toBe(runsBefore)
    expect(deadOff).toBeGreaterThan(deadBefore + 1_000)
    expect(bloatOff).toBeGreaterThan(bloatBefore + 0.025)

    sim.setKnob('autovacuum', true)
    expect(sim.state.autovac.enabled).toBe(true)
    expect(deadTuples(sim.state)).toBe(deadOff)
    expect(maxBloat(sim.state)).toBe(bloatOff)

    /* Re-enabling the launcher does not reset relation state. Workers wake on
     * their own schedule, and writes can briefly outrun their cleanup. */
    step(sim, 30)
    expect(sim.state.autovac.totalRuns).toBeGreaterThan(runsBefore)
    expect(maxBloat(sim.state)).toBeGreaterThanOrEqual(bloatOff)

    step(sim, 330)
    expect(deadTuples(sim.state)).toBeLessThan(deadOff * 0.95)
    expect(maxBloat(sim.state)).toBeLessThan(bloatOff * 0.8)
  })
})
