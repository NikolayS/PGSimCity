import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { PG_PAGE_BYTES } from '../core/types'
import { fmtBytes } from '../core/util'
import { createSim } from '../sim/model'
import { createCollector } from './collector'
import type { Cell } from './views'
import { PROJECTIONS } from './views'

const MIB = 1024 * 1024

function cellValue(cell: Cell | string | undefined): string | undefined {
  return typeof cell === 'string' ? cell : cell?.v
}

describe('observability buffer-pool readouts', () => {
  it('separates the pg_buffercache sample from shared_buffers', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const originalSampleSize = sim.state.buffers.sampleFrames
    const originalPoolSize = sim.state.knobs.sharedBuffers

    const caption = PROJECTIONS.buffercache(sim.state, collector, 'total').caption
    expect(caption).toContain(`${originalSampleSize.toLocaleString()} sampled frames`)
    expect(caption).toContain(`shared_buffers = ${fmtBytes(originalPoolSize * MIB)}`)

    sim.state.buffers.sampleFrames = 1 as typeof sim.state.buffers.sampleFrames
    const withSmallerSample = PROJECTIONS.buffercache(sim.state, collector, 'total').caption
    expect(withSmallerSample).toContain('1 sampled frames')
    expect(withSmallerSample).toContain(`shared_buffers = ${fmtBytes(originalPoolSize * MIB)}`)

    sim.state.knobs.sharedBuffers = originalPoolSize * 2
    const withLargerPool = PROJECTIONS.buffercache(sim.state, collector, 'total').caption
    expect(withLargerPool).toContain('1 sampled frames')
    expect(withLargerPool).toContain(`shared_buffers = ${fmtBytes(originalPoolSize * 2 * MIB)}`)
  })

  it('reports the MiB knob in pg_settings native 8kB blocks', () => {
    const sim = createSim(createBus())
    const collector = createCollector(sim)
    const projection = PROJECTIONS.settings(sim.state, collector, 'total')
    const row = projection.rows.find((candidate) => candidate.key === 'shared_buffers')

    expect(cellValue(row?.cells.setting)).toBe(String(sim.state.knobs.sharedBuffers * (MIB / PG_PAGE_BYTES)))
    expect(cellValue(row?.cells.unit)).toBe('8kB')
  })
})
