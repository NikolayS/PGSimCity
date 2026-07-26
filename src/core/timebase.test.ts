import { describe, expect, it, vi } from 'vitest'

import {
  createFrameTimebase,
  MAX_VISUAL_DELTA_SECONDS,
  MAX_WALL_DELTA_SECONDS,
  MODEL_STEP_SECONDS,
  simulationAnimationDelta,
  wallDelta,
} from './timebase'

describe('frame timebase', () => {
  it('catches the model up with wall time at two frames per second', () => {
    let simulated = 0
    const update = vi.fn((dt: number) => {
      simulated += dt
    })
    const clock = createFrameTimebase(update)

    clock.advance(wallDelta(0.5), false, 1)
    clock.advance(wallDelta(0.5), false, 1)

    expect(update).toHaveBeenCalledTimes(30)
    expect(simulated).toBeCloseTo(1, 10)
    expect(MODEL_STEP_SECONDS).toBeLessThanOrEqual(MAX_VISUAL_DELTA_SECONDS)
  })

  it('bounds a stalled frame instead of fast-forwarding the whole gap', () => {
    let simulated = 0
    const clock = createFrameTimebase((dt) => {
      simulated += dt
    })

    clock.advance(wallDelta(30), false, 1)

    expect(wallDelta(30)).toBe(MAX_WALL_DELTA_SECONDS)
    expect(simulated).toBeCloseTo(MAX_WALL_DELTA_SECONDS, 10)
  })

  it('drops pending time immediately while paused', () => {
    const update = vi.fn()
    const clock = createFrameTimebase(update)

    clock.advance(0.02, false, 1)
    clock.advance(0.5, true, 1)
    clock.advance(0.02, false, 1)

    expect(update).not.toHaveBeenCalled()
    expect(simulationAnimationDelta(0.1, true, 5)).toBe(0)
    expect(simulationAnimationDelta(0.1, false, 5)).toBe(0.5)
  })
})
