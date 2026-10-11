import { describe, expect, it } from 'vitest'

import { installTestDom } from '../../test/dom'
import type { VisualMode } from '../engine/visual-polish'
import { VISUAL_COMPARE_NOTE, createVisualCompare, visualCompareHost } from './visual-compare'

function fixture(initial: VisualMode) {
  const dom = installTestDom()
  const root = dom.mount('hud') as unknown as HTMLElement
  let mode = initial
  const applied: VisualMode[] = []
  const recorded: VisualMode[] = []
  const ui = createVisualCompare(root, {
    getMode: () => mode,
    setMode: (next) => {
      mode = next
      applied.push(next)
    },
    record: (next) => recorded.push(next),
  })
  const button = (m: VisualMode) =>
    root.querySelector(`[data-visual-mode="${m}"]`) as unknown as HTMLButtonElement
  return { root, ui, button, applied, recorded, mode: () => mode }
}

describe('Baseline / Polished switch', () => {
  it('reflects the live mode in aria-pressed on mount', () => {
    const f = fixture('polish')
    expect(f.button('polish').getAttribute('aria-pressed')).toBe('true')
    expect(f.button('baseline').getAttribute('aria-pressed')).toBe('false')
    expect(f.applied).toEqual([])
  })

  it('applies and records a change once, and ignores a repeat press', () => {
    const f = fixture('polish')
    f.button('baseline').click()
    f.button('baseline').click()
    expect(f.applied).toEqual(['baseline'])
    expect(f.recorded).toEqual(['baseline'])
    expect(f.button('baseline').getAttribute('aria-pressed')).toBe('true')
    expect(f.button('polish').getAttribute('aria-pressed')).toBe('false')
    f.button('polish').click()
    expect(f.mode()).toBe('polish')
    expect(f.recorded).toEqual(['baseline', 'polish'])
  })

  it('states what differs and what does not, and removes itself on dispose', () => {
    const f = fixture('baseline')
    const group = f.root.querySelector('.visual-compare')
    expect(group?.getAttribute('role')).toBe('group')
    expect(f.root.querySelector('.visual-compare__note')?.textContent).toBe(VISUAL_COMPARE_NOTE)
    expect(VISUAL_COMPARE_NOTE).toMatch(/same model, geometry and palette/i)
    f.ui.dispose()
    expect(f.root.querySelector('.visual-compare')).toBeNull()
  })
})

/* Screenshot review: in the #hud deck row the first-run tour card covered both
 * buttons. Layout rules are asserted in test/visual-compare-style.test.ts. */
describe('Baseline / Polished switch placement', () => {
  it('mounts in the top instrument strip, below the bar, not the tour deck row', () => {
    const dom = installTestDom()
    dom.mount('hud')
    const top = dom.mount('hud-top')
    expect(visualCompareHost(document)).toBe(top as unknown as HTMLElement)
  })

  it('marks its host while mounted so the model-qualification badge can yield the row', () => {
    const f = fixture('polish')
    expect(f.root.classList.contains('has-visual-compare')).toBe(true)
    f.ui.dispose()
    expect(f.root.classList.contains('has-visual-compare')).toBe(false)
  })
})
