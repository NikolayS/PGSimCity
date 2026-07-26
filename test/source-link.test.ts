import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { createHud } from '../src/ui/hud'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

const REPOSITORY_URL = 'https://github.com/NikolayS/PGSimCity'

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { get: () => undefined } as UiContext['registry'],
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

describe('source code entry point', () => {
  beforeEach(() => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
  })

  it('exposes a working repository link in the global HUD controls', () => {
    const hud = createHud(context())
    const link = document.querySelector('#hud-top .hud-source') as HTMLAnchorElement | null

    expect(link).not.toBeNull()
    expect(link!.textContent).toBe('Source')
    expect(link!.getAttribute('href')).toBe(REPOSITORY_URL)
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.getAttribute('rel')).toBe('noopener')

    const clicked = vi.fn()
    link!.addEventListener('click', clicked)
    link!.dispatchEvent(new Event('click'))
    expect(clicked).toHaveBeenCalledOnce()

    hud.dispose()
  })
})
