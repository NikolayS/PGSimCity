import { afterEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { cityComponentHref } from '../core/city-route'
import { DESTINATIONS } from '../core/destinations'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createCityWords } from './city-words'
import { createHelp } from './help'
import { createSearch } from './search'
import type { UiContext, UiModule } from './uikit'

const live: UiModule[] = []

function fixture(): UiContext {
  const dom = installTestDom()
  for (const id of ['stage', 'hud', 'help-overlay']) dom.mount(id)
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: {
      all: () => [],
      get: () => undefined,
      search: () => [],
    } as unknown as UiContext['registry'],
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

afterEach(() => {
  while (live.length) live.pop()!.dispose()
})

describe('City in words route', () => {
  it('opens from the command palette and renders every district with a link', () => {
    const ctx = fixture()
    live.push(createCityWords(ctx), createSearch(ctx))

    ctx.bus.emit('ui:palette', { open: true })
    const input = document.querySelector<HTMLInputElement>('#pal-input')!
    input.value = 'city in words'
    input.dispatchEvent(new Event('input'))

    const result = document.querySelector<HTMLElement>('[data-kind="guide"]')!
    expect(result.textContent).toContain('City in words')
    result.click()

    const overlay = document.querySelector<HTMLElement>('.city-words')!
    expect(overlay.hidden).toBe(false)
    expect(document.querySelectorAll('[data-city-district]')).toHaveLength(9)
    expect(document.querySelectorAll('[data-city-relationship]')).toHaveLength(11)
    for (const destination of DESTINATIONS) {
      expect(
        document.querySelector<HTMLAnchorElement>(`[data-city-district="${destination.district}"] a`)?.getAttribute('href'),
      ).toBe(cityComponentHref(destination.id))
    }
    expect(overlay.querySelector('[data-disclosure="city-words-limit"]')?.textContent)
      .toMatch(/does not replace the first-person walk/i)
  })

  it('opens from the help accessibility route and restores modal isolation on close', () => {
    const ctx = fixture()
    live.push(createCityWords(ctx), createHelp(ctx))
    const opener = document.createElement('button')
    opener.textContent = 'Open help'
    document.body.append(opener)
    opener.focus()

    ctx.bus.emit('ui:help', { open: true, section: 'reading' })
    const route = document.querySelector<HTMLButtonElement>('.help-city-words')!
    route.focus()
    route.click()

    const overlay = document.querySelector<HTMLElement>('.city-words')!
    expect(overlay.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('.help-overlay')!.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#stage')!.inert).toBe(true)
    expect(document.querySelector<HTMLElement>('#hud')!.inert).toBe(true)

    document.querySelector<HTMLButtonElement>('[data-mode-exit="city-in-words"]')!.click()
    expect(overlay.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('#stage')!.inert).toBe(false)
    expect(document.querySelector<HTMLElement>('#hud')!.inert).toBe(false)
    expect(document.activeElement).toBe(opener)
  })
})
