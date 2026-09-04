import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { installTestDom } from '../../test/dom'
import { createPresentationExport, wrapPresentationText } from './presentation'
import type { UiContext } from './uikit'
import type { RendererApi } from '../engine/renderer'

describe('presentation qualifications', () => {
  it('wraps long names and disclosures without losing content', () => {
    const copy = 'Representative educational model, not measured PostgreSQL. Selected: very_long_component_name'
    const lines = wrapPresentationText(copy, 20, (v) => v.length)
    expect(lines.every((line) => line.length <= 20)).toBe(true)
    expect(lines.join('').replaceAll(' ', '')).toBe(copy.replaceAll(' ', ''))
  })
})

describe('presentation dialog lifetime', () => {
  it.each([false, true])('retains original pause %s through repeated open/close and disposal', (initial) => {
    installTestDom()
    const state = { knobs: { paused: initial } }
    const ctx = { bus: createBus(), sim: { state, setKnob: (_key: string, value: boolean) => { state.knobs.paused = value } } } as unknown as UiContext
    const module = createPresentationExport(ctx, {} as RendererApi)
    module.open()
    module.open()
    expect(module.isOpen()).toBe(true)
    expect(state.knobs.paused).toBe(true)
    module.close()
    expect(module.isOpen()).toBe(false)
    expect(state.knobs.paused).toBe(initial)
    module.open()
    module.dispose()
    expect(state.knobs.paused).toBe(initial)
    expect(document.querySelector('.pg-presentation')).toBeNull()
  })
})
