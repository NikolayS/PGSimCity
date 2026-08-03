import { beforeEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import type { KnobSpec } from './paths'
import { knobRow } from './ui'

describe('Diagnose knob semantics', () => {
  beforeEach(() => installTestDom())

  it('names a range with its GUC and help text and exposes its formatted value', () => {
    const sim = createSim(createBus())
    const spec: KnobSpec = {
      key: 'tps',
      guc: 'workload_tps',
      kind: 'range',
      min: 1,
      max: 1000,
      step: 1,
      unit: 'transactions/s',
      help: 'Change the offered transaction rate.',
      fmt: (value) => `${value} transactions/s`,
    }
    const row = knobRow(sim, spec)
    document.body.append(row.root)
    const input = row.root.querySelector('input') as HTMLInputElement

    expect(input.getAttribute('aria-labelledby')).toBe(row.root.querySelector('code')?.id)
    expect(input.getAttribute('aria-describedby')).toBe(row.root.querySelector('.knob__help')?.id)
    expect(input.getAttribute('aria-valuetext')).toBe(`${sim.state.knobs.tps} transactions/s`)
  })

  it('announces toggle and choice state without relying on colour', () => {
    const sim = createSim(createBus())
    const toggle = knobRow(sim, {
      key: 'bgwriterEnabled',
      guc: 'bgwriter_enabled',
      kind: 'toggle',
      help: 'Enable or disable the modeled background writer.',
    })
    const choice = knobRow(sim, {
      key: 'synchronousCommit',
      guc: 'synchronous_commit',
      kind: 'choice',
      choices: ['on', 'off'],
      help: 'Choose the commit policy.',
    })
    document.body.append(toggle.root, choice.root)

    const toggleButton = toggle.root.querySelector('button') as HTMLButtonElement
    expect(toggleButton.getAttribute('aria-label')).toContain('bgwriter_enabled')
    expect(toggleButton.getAttribute('aria-pressed')).toBe('true')

    const choices = Array.from(choice.root.querySelectorAll('button'))
    expect(choice.root.querySelector('.knob__choices')?.getAttribute('role')).toBe('group')
    expect(choices.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false'])
  })
})
