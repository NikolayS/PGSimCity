import { expect, it } from 'vitest'
import type { SampleFrames, SimState } from '../core/types'

// @ts-expect-error A plain number must not cross the sample-scale boundary.
const unbrandedSampleFrames: SampleFrames = 1
void unbrandedSampleFrames

declare const state: SimState
if (false) {
  // @ts-expect-error Only the simulation may construct a sampled-frame count.
  state.buffers.sampleFrames = 1
  // @ts-expect-error Full-stream numbers cannot be assigned to sample counters.
  state.buffers.dirtyCount = state.buffers.hits
  // @ts-expect-error Full-stream numbers cannot be assigned to sample counters.
  state.buffers.usedCount = state.buffers.misses
  // @ts-expect-error Plain numbers cannot be assigned to sample counters.
  state.buffers.pinnedCount = 0
  // @ts-expect-error Plain numbers cannot be assigned to sample counters.
  state.buffers.evictions = 0
  // @ts-expect-error Plain numbers cannot be assigned to sample counters.
  state.bgwriter.cleanedTotal = 0
  // @ts-expect-error Plain numbers cannot be assigned to sample counters.
  state.checkpoint.buffersWritten = 0
  // @ts-expect-error Full-stream page rates cannot be assigned to sample rates.
  state.stats.ioWritePerSec = state.stats.ioReadPerSec
}

it('brands every representative-sample counter', () => {
  expect(true).toBe(true)
})
