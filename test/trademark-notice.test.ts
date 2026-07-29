import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { createHelp } from '../src/ui/help'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

const TRADEMARK_NOTICE =
  'PGSimCity is an independent, non-commercial educational visualization of PostgreSQL internals. ' +
  'It is not affiliated with, sponsored, endorsed, or approved by Electronic Arts Inc. ' +
  'SimCity is a trademark of Electronic Arts Inc.'

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { all: () => [], get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

describe('Electronic Arts trademark notice', () => {
  it('stays in the boot markup and the help attribution surface', () => {
    const index = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8')
    const machine = readFileSync(
      fileURLToPath(new URL('../machine/index.html', import.meta.url)),
      'utf8',
    )
    expect(normalize(index)).toContain(TRADEMARK_NOTICE)
    expect(normalize(machine)).toContain(TRADEMARK_NOTICE)

    const dom = installTestDom()
    const root = dom.mount('help-overlay')
    const help = createHelp(context())

    expect(normalize(root.textContent)).toContain(TRADEMARK_NOTICE)
    help.dispose()
  })
})
