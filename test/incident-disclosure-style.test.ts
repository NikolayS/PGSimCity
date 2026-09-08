import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps linked incident qualifications on an opaque high-contrast surface', () => {
  const css = readFileSync(new URL('../src/observability/style.css', import.meta.url), 'utf8')
  const rule = css.match(/\.incident-context\s*\{([^}]+)\}/)?.[1] ?? ''
  const color = rule.match(/(?:^|;)\s*color:\s*(#[\da-f]{6})/)?.[1]
  const background = rule.match(/background:\s*(#[\da-f]{6})/)?.[1]
  expect(color).toBeDefined()
  expect(background).toBeDefined()
  const luminance = (hex: string) => [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
  const values = [luminance(color!), luminance(background!)].sort((a, b) => a - b)
  expect((values[1] + .05) / (values[0] + .05)).toBeGreaterThanOrEqual(4.5)
  expect(css).toMatch(/\.incident-context \.staged__t\s*\{\s*color:\s*inherit;/)
})
