import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTheme, setBloomAvailable, setThemeMode } from './theme'
import { NIGHT_PALETTE } from './themes'

const READABLE_LUMINANCE = 0.24

function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('bloom-off neon fallback', () => {
  /* This suite is about NIGHT behaviour -- the neon repaint that carries meaning
   * when the bloom pass is unavailable. It used to rely on night being the
   * default mode, which quietly coupled it to an unrelated product decision.
   * Say which mode it means. */
  beforeEach(() => {
    setThemeMode('night', { persist: false })
  })

  afterEach(() => {
    setBloomAvailable(true)
  })

  it('keeps representative semantic colours readable without bloom', () => {
    const theme = createTheme()
    const materials = [
      ['dirty page', theme.neon(NIGHT_PALETTE.bufDirty, 0.55)],
      ['clean page', theme.neon(NIGHT_PALETTE.bufClean, 0.55)],
      ['WAL', theme.neon(NIGHT_PALETTE.wal, 0.55)],
      ['storage', theme.neon(NIGHT_PALETTE.storage, 0.55)],
    ] as const
    setBloomAvailable(false)

    for (const [meaning, material] of materials) {
      expect(luminance(material.color), meaning).toBeGreaterThanOrEqual(READABLE_LUMINANCE)
    }

    theme.dispose()
  })

  it('restores the authored night neon exactly when bloom returns', () => {
    const theme = createTheme()
    const material = theme.neon(NIGHT_PALETTE.bufDirty, 0.55)
    const authored = material.color.clone()

    setBloomAvailable(false)
    setBloomAvailable(true)

    expect(material.color.equals(authored)).toBe(true)

    theme.dispose()
  })
})
