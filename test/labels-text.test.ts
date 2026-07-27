import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  EXPANDED_LABEL_CAP,
  LabelDetail,
  detailExpansionPriority,
  requestedLabelDetail,
} from '../src/engine/label-detail'

const css = readFileSync(fileURLToPath(new URL('../src/styles/labels.css', import.meta.url)), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('floating label text', () => {
  it.each(['.lbl__name', '.lbl__role', '.lbl__read'])(
    'does not clip or ellipsize %s',
    (selector) => {
      const declarations = rule(selector)
      expect(declarations).not.toMatch(/text-overflow\s*:\s*ellipsis/)
      expect(declarations).not.toMatch(/overflow\s*:\s*hidden/)
    },
  )

  it('lets close-range roles wrap instead of imposing a one-line width cap', () => {
    const declarations = rule('.lbl__role')
    expect(declarations).toMatch(/white-space\s*:\s*normal/)
    expect(declarations).not.toMatch(/max-width\s*:/)
  })

  it('keeps readouts complete so their units cannot disappear', () => {
    const declarations = rule('.lbl__read')
    expect(declarations).toMatch(/white-space\s*:\s*normal/)
    expect(declarations).not.toMatch(/max-width\s*:/)
  })

  it('uses distance for readouts and attention for complete roles', () => {
    expect(requestedLabelDetail(220, true, false, false)).toBe(LabelDetail.Name)
    expect(requestedLabelDetail(100, true, false, false)).toBe(LabelDetail.Readout)
    expect(requestedLabelDetail(500, true, true, false)).toBe(LabelDetail.Role)
    expect(requestedLabelDetail(500, false, false, true)).toBe(LabelDetail.Role)
  })

  it('limits expansion and ranks selected, hovered, then nearest-to-centre', () => {
    expect(EXPANDED_LABEL_CAP).toBe(2)
    expect(detailExpansionPriority(true, false, 5000)).toBeLessThan(
      detailExpansionPriority(false, true, 10),
    )
    expect(detailExpansionPriority(false, true, 5000)).toBeLessThan(
      detailExpansionPriority(false, false, 10),
    )
    expect(detailExpansionPriority(false, false, 10)).toBeLessThan(
      detailExpansionPriority(false, false, 5000),
    )
  })

  it('hides full role copy outside the attention-only state', () => {
    expect(rule('.lbl.is-name-only .lbl__role')).toMatch(/display\s*:\s*none/)
    expect(rule('.lbl.is-readout-only .lbl__role')).toMatch(/display\s*:\s*none/)
  })
})
