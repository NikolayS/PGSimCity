import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { HELP_READING } from './help'

describe('help claims agree with the model', () => {
  it('discloses the representative standby buffer sample touched by replay', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6000)
    sim.setKnob('writeRatio', 1)
    for (let i = 0; i < 600; i++) sim.update(1 / 30)

    expect(sim.state.cluster.nodes[1].buffers.misses).toBeGreaterThan(0)
    const standby = HELP_READING.find((entry) => entry.h === 'The standby')?.p ?? ''
    expect(standby).toContain('representative buffer-frame sample')
    expect(standby).not.toContain('not TCP sockets, replica pages')
  })
})
