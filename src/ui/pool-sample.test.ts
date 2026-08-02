import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { DOCS } from './content'

describe('buffer-pool metrics', () => {
  it('derives every buffer-pool-labelled value from shared_buffers, never the visual sample', () => {
    const state = createSim(createBus()).state
    const originalSampleSize = state.buffers.sampleFrames
    const originalPoolSize = state.knobs.sharedBuffers
    const violations: string[] = []
    let inspected = 0

    for (const doc of DOCS) {
      for (const metric of doc.metrics ?? []) {
        if (!/(?:buffer pool|pool size)/i.test(metric.label) && !/^shared_buffers$/i.test(metric.label)) continue
        inspected++

        const original = metric.get(state)
        state.buffers.sampleFrames = 1 as typeof state.buffers.sampleFrames
        const withSmallerSample = metric.get(state)
        state.buffers.sampleFrames = originalSampleSize
        state.knobs.sharedBuffers = originalPoolSize * 2
        const withLargerPool = metric.get(state)
        state.knobs.sharedBuffers = originalPoolSize

        if (withSmallerSample !== original || withLargerPool === original) {
          violations.push(
            `${doc.id} — ${metric.label}: "${original}" (sample: "${withSmallerSample}", pool: "${withLargerPool}")`,
          )
        }
      }
    }

    expect(inspected).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })
})
