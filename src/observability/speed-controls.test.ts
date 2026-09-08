import { expect, it } from 'vitest'
import { installTestDom } from '../../test/dom'
import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { createIncidentReplay } from '../sim/replay'
import { createModelSpeedControls } from './speed-controls'

it('synchronizes linked imported speed and does not invent a selected preset', async () => {
  installTestDom()
  const sourceBus = createBus()
  const source = createSim(sourceBus)
  const sourceReplay = createIncidentReplay(source, sourceBus)
  source.setKnob('timeScale', 4)
  const bus = createBus()
  const sim = createSim(bus)
  const replay = createIncidentReplay(sim, bus)
  const controls = createModelSpeedControls(sim)
  await replay.loadRecord(sourceReplay.exportRecord())
  controls.sync()
  expect(controls.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true'])
  expect(controls.buttons.map((button) => button.classList.contains('on'))).toEqual([false, false, true])
  sim.setKnob('timeScale', 3)
  controls.sync()
  expect(controls.buttons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true)
  controls.buttons[1].click()
  expect(sim.state.knobs.timeScale).toBe(2)
  expect(controls.buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  sourceReplay.dispose()
  replay.dispose()
})
