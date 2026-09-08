import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTestDom } from '../../test/dom'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { createIncidentReplay, encodeReplay } from '../sim/replay'
import { createReplayPanel } from './replay-panel'
import type { UiContext } from './uikit'

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() {
  installTestDom()
  const bus = createBus()
  const sim = createSim(bus)
  const replay = createIncidentReplay(sim, bus)
  const panel = createReplayPanel({ bus, sim } as UiContext, replay)
  cleanups.push(() => { panel.dispose(); replay.dispose() })
  panel.open()
  return { sim, replay, panel }
}

describe('incident replay panel', () => {
  it('owns navigation keydown without consuming native defaults or input releases', () => {
    setup()
    const panel = document.querySelector('.pg-replay')!
    for (const key of ['ArrowDown', 'PageDown', 'Home', 'o', 'p', 'Enter', ' ']) {
      const event = new Event('keydown', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'key', { value: key })
      const stop = vi.spyOn(event, 'stopPropagation')
      panel.dispatchEvent(event)
      expect(stop, key).toHaveBeenCalledOnce()
      expect(event.defaultPrevented, key).toBe(false)
    }
    const release = new Event('keyup', { bubbles: true })
    const stopRelease = vi.spyOn(release, 'stopPropagation')
    panel.dispatchEvent(release)
    expect(stopRelease).not.toHaveBeenCalled()
  })

  it('saves a genuine checkpoint and reconstructs that state after later work', async () => {
    const { sim, panel } = setup()
    sim.setKnob('workMem', 64)
    sim.update(1 / 30)
    panel.captureCheckpoint()
    const expected = structuredClone(sim.state)
    sim.setKnob('workMem', 8)
    sim.update(1 / 30)
    await panel.rewindCheckpoint()
    expect(sim.state).toEqual(expected)
    expect(document.body.textContent).toContain('not PostgreSQL measurements')
  })

  it('refuses imports unless replacing the incident is explicitly confirmed', async () => {
    const { sim, replay, panel } = setup()
    const record = encodeReplay(replay.exportRecord())
    sim.update(1 / 30)
    const expected = structuredClone(sim.state)
    await expect(panel.importRecord(record, false)).rejects.toThrow(/confirm/i)
    expect(sim.state).toEqual(expected)
    await panel.importRecord(record, true)
    expect(replay.status.tick).toBe(0)
    expect(panel.hasCheckpoint()).toBe(false)
  })

  it('makes an exact-duration comparison without describing it as measured PostgreSQL', async () => {
    const { sim, panel, replay } = setup()
    panel.captureCheckpoint()
    sim.update(1 / 30)
    await panel.rewindCheckpoint()
    sim.setKnob('workMem', 64)
    await panel.runComparison()
    expect(replay.compare()?.sameDuration).toBe(true)
    expect(document.body.textContent).toContain('Same model duration')
    expect(document.body.textContent).toContain('PGlite results are separate')
    expect(document.body.textContent).toContain('Export your comparison before switching views')
    expect(document.body.textContent).toContain('Counters and current gauges')
  })
})
