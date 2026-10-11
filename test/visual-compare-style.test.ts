import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/* The ?visual= switch once sat in the #hud deck row, under the first-run tour
 * card, and inherited pointer-events: none from `#hud > *`: real clicks missed. */
const css = readFileSync(fileURLToPath(new URL('../src/styles/ui.css', import.meta.url)), 'utf8')
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`)
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
}

describe('Baseline / Polished switch layout', () => {
  it('takes layout space in flow and accepts pointer input', () => {
    const group = rule('.visual-compare')
    expect(group).not.toBe('')
    expect(group).not.toMatch(/grid-area|place-self|position:\s*(fixed|absolute)/)
    expect(group).toMatch(/display:\s*flex/)
    expect(group).toMatch(/pointer-events:\s*auto/)
  })

  it('keeps the note on the button row instead of forcing its own line', () => {
    const note = rule('.visual-compare__note')
    expect(note).not.toBe('')
    expect(note).not.toMatch(/flex-basis:\s*100%/)
  })

  it('moves the absolutely placed model-qualification badge into flow so it cannot cover the row', () => {
    expect(rule('#hud-top.has-visual-compare .hud-bar > .city-version-provenance')).toMatch(/position:\s*static/)
  })
})
