import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'

describe('logical decoding activity provenance', () => {
  it('does not report activity for a caught-up idle decoder', () => {
    const bus = createBus(), sim = createSim(bus)
    sim.setKnob('walLevel', 'logical')
    sim.setKnob('tps', 0)
    for (let i = 0; i < 300; i++) sim.update(1 / 30)
    const before = sim.state.replication.logicalSlotLsn
    expect(before).toBe(sim.state.wal.flushLsn)
    let events = 0
    bus.on('flow', request => { if (request.route === 'logical.decode') events++ })
    for (let i = 0; i < 60; i++) sim.update(1 / 30)
    expect(sim.state.replication.logicalSlotLsn).toBe(before)
    expect(events).toBe(0)
  })

  it('samples actual decoder progress with model provenance', () => {
    const bus = createBus(), sim = createSim(bus)
    sim.setKnob('walLevel', 'logical')
    sim.setKnob('tps', 300)
    sim.setKnob('writeRatio', 1)
    let previous = sim.state.replication.logicalSlotLsn, events = 0
    bus.on('flow', request => {
      if (request.route !== 'logical.decode') return
      expect(request.source).toBe('model')
      expect(sim.state.replication.logicalSlotLsn).toBeGreaterThan(previous)
      events++
    })
    for (let i = 0; i < 300; i++) {
      previous = sim.state.replication.logicalSlotLsn
      sim.update(1 / 30)
    }
    expect(events).toBeGreaterThan(0)
  })
})
