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
