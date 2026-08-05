import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { sharedBuffersReadout } from './shmem'
import { bufferPoolOccupancy, bufferPoolSurfaceY, CITY } from './layout'

describe('buffer-pool elevation', () => {
  it('recesses the water volume while keeping the full surface at plaza level', () => {
    expect(CITY.buf.baseY).toBeLessThan(CITY.deck.top - 1.7)
    expect(CITY.buf.fullSurfaceY).toBeGreaterThanOrEqual(CITY.deck.top)
    expect(CITY.buf.fullSurfaceY).toBeLessThanOrEqual(CITY.deck.top + 0.2)
    expect(CITY.buf.copingTopY).toBeLessThanOrEqual(CITY.deck.top + 0.6)
  })

  it('maps representative-frame occupancy monotonically across the basin depth', () => {
    const buffers = createSim(createBus()).state.buffers
    const capacity = buffers.sampleFrames

    buffers.usedCount = 0 as typeof buffers.usedCount
    const empty = bufferPoolSurfaceY(buffers)
    buffers.usedCount = Math.round(capacity / 2) as typeof buffers.usedCount
    const half = bufferPoolSurfaceY(buffers)
    buffers.usedCount = capacity
    const full = bufferPoolSurfaceY(buffers)

    expect(bufferPoolOccupancy(buffers)).toBe(1)
    expect(empty).toBe(CITY.buf.baseY)
    expect(half).toBeGreaterThan(empty)
    expect(half).toBeCloseTo((CITY.buf.baseY + CITY.buf.fullSurfaceY) / 2, 2)
    expect(full).toBe(CITY.buf.fullSurfaceY)
  })

  it('discloses the quantity carried by the moving waterline', () => {
    const state = createSim(createBus()).state
    state.buffers.usedCount = Math.round(
      state.buffers.sampleFrames / 2,
    ) as typeof state.buffers.usedCount

    expect(sharedBuffersReadout(state)).toContain('water level 50% sample occupancy')
  })
})
