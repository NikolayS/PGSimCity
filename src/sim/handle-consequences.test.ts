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

describe('candidate in-world handle consequences', () => {
  it('autovacuum off accumulates visible bloat and switching it back on recovers', () => {
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
    step(sim, 360)

    expect(sim.state.autovac.totalRuns).toBeGreaterThan(runsBefore)
    expect(deadTuples(sim.state)).toBeLessThan(deadOff * 0.95)
    expect(maxBloat(sim.state)).toBeLessThan(bloatOff * 0.8)
  })

  it('bgwriter off shifts dirty eviction writes to backends and switching it back on recovers', () => {
    const sim = createSim(createBus())
    sim.setKnob('sharedBuffers', 128)
    sim.setKnob('tps', 1_200)
    sim.setKnob('writeRatio', 0.65)
    sim.setKnob('updateRatio', 0.8)
    step(sim, 20)

    sim.setKnob('bgwriterEnabled', false)
    expect(sim.state.bgwriter.enabled).toBe(false)
    const offEvictionsBefore = sim.state.buffers.dirtyEvictions
    const offCleanedBefore = sim.state.bgwriter.cleanedTotal
    step(sim, 45)
    const offEvictions = sim.state.buffers.dirtyEvictions - offEvictionsBefore

    expect(sim.state.bgwriter.cleanedTotal).toBe(offCleanedBefore)
    expect(offEvictions).toBeGreaterThan(100)

    sim.setKnob('bgwriterEnabled', true)
    expect(sim.state.bgwriter.enabled).toBe(true)
    const onEvictionsBefore = sim.state.buffers.dirtyEvictions
    const onCleanedBefore = sim.state.bgwriter.cleanedTotal
    step(sim, 45)
    const onEvictions = sim.state.buffers.dirtyEvictions - onEvictionsBefore

    expect(sim.state.bgwriter.cleanedTotal).toBeGreaterThan(onCleanedBefore)
    expect(onEvictions).toBeLessThan(offEvictions * 0.8)
  })

  it('full_page_writes off reduces WAL and switching it back on restores full-page images', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 600)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('updateRatio', 0.8)
    sim.setKnob('maxWalSize', 32)
    sim.setKnob('checkpointTimeout', 15)
    step(sim, 30)

    sim.setKnob('fullPageWrites', false)
    expect(sim.state.knobs.fullPageWrites).toBe(false)
    const offLsn = sim.state.wal.insertLsn
    step(sim, 30)
    const offBytes = sim.state.wal.insertLsn - offLsn
    const offBurst = sim.state.wal.fpwBurst

    sim.setKnob('fullPageWrites', true)
    expect(sim.state.knobs.fullPageWrites).toBe(true)
    const onLsn = sim.state.wal.insertLsn
    step(sim, 30)
    const onBytes = sim.state.wal.insertLsn - onLsn
    const onBurst = sim.state.wal.fpwBurst

    expect(offBurst).toBeLessThan(0.01)
    expect(onBurst).toBeGreaterThan(0.05)
    expect(onBytes).toBeGreaterThan(offBytes * 1.2)
  })
})
