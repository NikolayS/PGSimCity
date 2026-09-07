import { describe, expect, it } from 'vitest'
import { waitForAudioClock } from './audio-clock.mjs'

function clockHarness(update) {
  let wall = 0
  return {
    now: () => wall,
    sleep: async (ms) => { wall += ms; update(wall) },
    timeoutMs: 3000,
  }
}

describe('audio clock readiness (not latency acceptance)', () => {
  it('does not accept a frozen clock merely because its state is running', async () => {
    const context = { state: 'running', currentTime: 2 }
    await expect(waitForAudioClock([context], clockHarness(() => {})))
      .rejects.toThrow(/audio clock.*3000 ms/i)
  })

  it('reports delayed readiness only after real audio time advances', async () => {
    const context = { state: 'running', currentTime: 2 }
    const report = await waitForAudioClock([context], clockHarness((wall) => {
      context.currentTime = 2 + Math.max(0, wall - 2000) / 1000
    }))
    expect(report.elapsedMs).toBeGreaterThanOrEqual(2050)
    expect(report.elapsedMs).toBeLessThan(2100)
    expect(report.advances[0]).toBeGreaterThanOrEqual(0.05)
  })

  it('requires every observed context to advance', async () => {
    const contexts = [{ state: 'running', currentTime: 0 }, { state: 'running', currentTime: 0 }]
    await expect(waitForAudioClock(contexts, clockHarness((wall) => {
      contexts[0].currentTime = wall / 1000
    }))).rejects.toThrow(/audio clock/i)
  })

  it('rejects missing contexts instead of vacuously passing', async () => {
    await expect(waitForAudioClock([], clockHarness(() => {})))
      .rejects.toThrow('No audio contexts')
  })
})
