import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps image export and the walk exit in the first-person toolbar', () => {
  const css = readFileSync(new URL('../src/styles/hud.css', import.meta.url), 'utf8')
  const hide = css.match(/body\.pg-walk \.hud-tools > ([^{]+)\{\s*display: none;/)?.[1]
  expect(hide).toBeDefined()
  const exceptions = Array.from(hide!.matchAll(/:not\(\.([\w-]+)\)/g), (match) => match[1])
  const hidden = (classes: string[]) => exceptions.every((name) => !classes.includes(name))
  expect(hidden(['pg-btn', 'hud-export'])).toBe(false)
  expect(hidden(['pg-btn', 'hud-walk'])).toBe(false)
  expect(hidden(['pg-btn', 'hud-tour'])).toBe(true)
})

it('gives walk export an opaque, readable tap target in both themes', () => {
  const css = readFileSync(new URL('../src/styles/hud.css', import.meta.url), 'utf8')
  const rule = css.match(/body\.pg-walk \.hud-export\s*\{([^}]+)\}/)?.[1] ?? ''
  expect(rule).toMatch(/background:\s*var\(--bg-panel-solid\)/)
  expect(rule).toMatch(/color:\s*var\(--ink\)/)
  expect(rule).toMatch(/min-height:\s*var\(--tap\)/)
  const header = css.match(/body\.pg-walk \.hud-bar\s*\{([^}]+)\}/)?.[1] ?? ''
  expect(header).toMatch(/min-height:\s*var\(--tap\)/)
  const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
  const values = (token: string) => Array.from(tokens.matchAll(new RegExp(`--${token}:\\s*(#[\\da-f]{6})`, 'gi')), (match) => match[1])
  function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map((offset) => {
      const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return r * 0.2126 + g * 0.7152 + b * 0.0722
  }
  const backgrounds = values('bg-panel-solid')
  const inks = values('ink')
  expect(backgrounds.length).toBe(2)
  backgrounds.forEach((color, index) => {
    const lightness = [luminance(color), luminance(inks[index])].sort((a, b) => a - b)
    expect((lightness[1] + 0.05) / (lightness[0] + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
})
