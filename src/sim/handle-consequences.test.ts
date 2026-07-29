import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import type { SimApi, SimState, TableSim } from '../core/types'
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

function relation(state: SimState, id: string): TableSim {
  const table = state.tables.find((candidate) => candidate.def.id === id)
  if (!table) throw new Error(`missing relation: ${id}`)
  return table
}

describe('autovacuum in-world handle consequence', () => {
  it('accumulates dead tuples and bloat at the shipped default workload while off', () => {
    const sim = createSim(createBus())
    const runsBefore = sim.state.autovac.totalRuns
    const deadBefore = deadTuples(sim.state)
    const bloatBefore = maxBloat(sim.state)

    sim.setKnob('autovacuum', false)
    step(sim, 300)

    expect(sim.state.autovac.enabled).toBe(false)
    expect(sim.state.autovac.workers.every((worker) => !worker.active)).toBe(true)
    expect(sim.state.autovac.totalRuns).toBe(runsBefore)
    expect(deadTuples(sim.state)).toBeGreaterThan(deadBefore)
    expect(maxBloat(sim.state)).toBeGreaterThan(bloatBefore)
  })

  it('produces material bloat under hard writes, then launches delayed cleanup', { timeout: 20_000 }, () => {
    const sim = createSim(createBus())
    sim.setKnob('autovacuum', false)
    sim.setKnob('tps', 500)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('updateRatio', 1)
    const runsBefore = sim.state.autovac.totalRuns

    step(sim, 600)
    const deadOff = deadTuples(sim.state)
    const bloatOff = maxBloat(sim.state)
    const sessionsBloatOff = relation(sim.state, 'sessions').bloat
    const sessionsPagesOff = relation(sim.state, 'sessions').pages

    expect(sim.state.autovac.totalRuns).toBe(runsBefore)
    expect(sessionsBloatOff).toBeGreaterThan(0.1)
    expect(relation(sim.state, 'events').bloat).toBe(0)

    sim.setKnob('autovacuum', true)
    expect(sim.state.autovac.enabled).toBe(true)
    expect(deadTuples(sim.state)).toBe(deadOff)
    expect(maxBloat(sim.state)).toBe(bloatOff)
    expect(relation(sim.state, 'sessions').pages).toBe(sessionsPagesOff)

    /* Re-enabling the launcher does not reset relation state. Workers wake on
     * their own schedule, and writes can briefly outrun their cleanup. */
    step(sim, 30)
    expect(sim.state.autovac.totalRuns).toBeGreaterThan(runsBefore)
    expect(maxBloat(sim.state)).toBeGreaterThanOrEqual(bloatOff)

    step(sim, 870)
    expect(deadTuples(sim.state)).toBeLessThan(deadOff * 0.95)
    expect(maxBloat(sim.state)).toBeLessThan(bloatOff * 0.8)
    expect(relation(sim.state, 'sessions').pages).toBeGreaterThanOrEqual(sessionsPagesOff)
  })
})
