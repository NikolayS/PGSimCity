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
const tokens = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8')

function rule(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))
  expect(match, `missing ${selector} rule`).not.toBeNull()
  return match?.[1] ?? ''
}

function token(name: string, day: boolean): string {
  const root = day ? ':root[data-theme="day"]' : ':root'
  const start = tokens.indexOf(`${root} {`)
  const body = tokens.slice(start, tokens.indexOf('}', start))
  const value = body.match(new RegExp(`${name}:\\s*([^;]+)`))?.[1]
  if (!value) throw new Error(`missing ${name} in ${root}`)
  return value
}

function color(value: string, day: boolean): number[] {
  if (value.startsWith('var(')) return color(token(value.slice(4, -1), day), day)
  if (value.startsWith('#')) {
    return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).concat(1)
  }
  const channels = value.match(/[\d.]+/g)?.map(Number)
  if (!channels || channels.length < 3) throw new Error(`unsupported color ${value}`)
  return channels.length === 3 ? [...channels, 1] : channels
}

function luminance(rgb: number[]): number {
  return rgb.slice(0, 3).reduce((sum, value, index) => {
    const srgb = value / 255
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]
  }, 0)
}

describe('floating label text', () => {
  it.each([false, true])('keeps name-only text legible over bright and dark scenery (day=%s)', (day) => {
    /* Name-only and the day override have equal specificity; labels.css is
     * loaded later, so its own background wins when it supplies one. */
    const defaultSurface = day
      ? rule(':root[data-theme="day"] .lbl__chip', tokens)
      : rule('.lbl__chip')
    const background = rule('.lbl.is-name-only .lbl__chip').match(/background:\s*([^;]+)/)?.[1]
      ?? defaultSurface.match(/background:\s*([^;]+)/)![1]
    const foreground = rule('.lbl.is-name-only .lbl__name').match(/color:\s*([^;]+)/)![1]
    const fg = luminance(color(foreground, day))
    const surface = color(background, day)
    for (const scenery of [0, 255]) {
      const composited = surface.slice(0, 3).map(
        (channel) => channel * surface[3] + scenery * (1 - surface[3]),
      )
      const bg = luminance(composited)
      const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      expect(contrast, `name-only label over ${scenery === 0 ? 'black' : 'white'} scenery`)
        .toBeGreaterThanOrEqual(4.5)
    }
  })

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
