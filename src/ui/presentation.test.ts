import { describe, expect, it, vi } from 'vitest'
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
    const press = new Event('keydown', { bubbles: true })
    const stopPress = vi.spyOn(press, 'stopPropagation')
    document.querySelector('.pg-presentation')!.dispatchEvent(press)
    expect(stopPress).toHaveBeenCalledOnce()
    const release = new Event('keyup', { bubbles: true })
    const stopRelease = vi.spyOn(release, 'stopPropagation')
    document.querySelector('.pg-presentation')!.dispatchEvent(release)
    expect(stopRelease).not.toHaveBeenCalled()
    module.close()
    expect(module.isOpen()).toBe(false)
    expect(state.knobs.paused).toBe(initial)
    module.open()
    module.dispose()
    expect(state.knobs.paused).toBe(initial)
    expect(document.querySelector('.pg-presentation')).toBeNull()
  })
})


describe('presentation comparison selection', () => {
  it('refuses export during replay work without pausing, opening, or sampling context', () => {
    installTestDom()
    const bus = createBus()
    const toast = vi.fn()
    bus.on('toast', toast)
    const state = { knobs: { paused: false } }
    const setKnob = vi.fn()
    const comparison = vi.fn(() => null)
    const module = createPresentationExport({ bus, sim: { state, setKnob } } as unknown as UiContext,
      {} as RendererApi, comparison, () => false)
    try {
      module.open()
      expect(module.isOpen()).toBe(false)
      expect(setKnob).not.toHaveBeenCalled()
      expect(comparison).not.toHaveBeenCalled()
      expect(document.querySelector('.pg-presentation')!.getAttribute('open')).toBeNull()
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ text: 'Wait for replay or model advancement to finish before exporting.' }))
    } finally { module.dispose() }
  })

  it('captures available context before the export pause and explains when none exists', () => {
    installTestDom()
    const state = { knobs: { paused: false } }
    const ctx = { bus: createBus(), sim: { state, setKnob: (_key: string, value: boolean) => { state.knobs.paused = value } } } as unknown as UiContext
    const observedPause: boolean[] = []
    const module = createPresentationExport(ctx, {} as RendererApi, () => {
      observedPause.push(state.knobs.paused)
      return null
    })
    try {
      module.open()
      module.open()
      expect(observedPause).toEqual([false])
      const option = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((node) => node.getAttribute('aria-label') === 'Include comparison explanation')!
      expect(option.disabled).toBe(true)
      expect(document.body.textContent).toContain('Rewind a recorded branch to make its comparison available')
      module.close()
      expect(state.knobs.paused).toBe(false)
    } finally { module.dispose() }
  })
})
