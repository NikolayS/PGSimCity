import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
})
