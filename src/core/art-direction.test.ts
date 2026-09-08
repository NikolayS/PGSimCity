import { Color } from 'three'
import { describe, expect, it } from 'vitest'
import { createTheme, setThemeMode } from './theme'
import { ATMOSPHERE, DAY_PALETTE, dayInkOpacity, daySurface, hslOf } from './themes'

const luma = (hex: number) => {
  const c = new Color(hex)
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
}

describe('architectural scene hierarchy', () => {
  it('keeps faint construction ink subordinate without erasing strong boundaries', () => {
    expect(dayInkOpacity(0.2, true)).toBeLessThanOrEqual(0.25)
    expect(dayInkOpacity(0.55, true)).toBeLessThanOrEqual(0.55)
    expect(dayInkOpacity(0.9, true)).toBeGreaterThanOrEqual(0.75)
    expect(dayInkOpacity(0, true)).toBe(0)
  })

  it('separates lit facades from the quiet paving in linear light', () => {
    for (const [key, source] of [
      ['backends.struct', 0x2a3852], ['wal.struct', 0x2a3752],
      ['shmem.struct', 0x1b2435], ['storage.struct', 0x1a2333],
    ] as const) {
      expect(luma(daySurface(source, key)) / luma(DAY_PALETTE.ground), key).toBeGreaterThan(3)
    }
    expect(hslOf(DAY_PALETTE.ground)[1]).toBeLessThan(0.15)
  })

  it('balances directional light against ambient fill within existing lamp budgets', () => {
    expect(ATMOSPHERE.night.keyIntensity).toBeGreaterThanOrEqual(1.8)
    expect(ATMOSPHERE.night.walGlow).toBeLessThanOrEqual(40)
    expect(ATMOSPHERE.night.yardGlow).toBeLessThanOrEqual(26)
    expect(ATMOSPHERE.day.keyIntensity / ATMOSPHERE.day.hemiIntensity).toBeGreaterThan(3.5)
  })
})

it('quietens only construction lines and preserves relationship strokes', () => {
  setThemeMode('day', { persist: false })
  const theme = createTheme()
  try {
    const structural = theme.line(0x8fa5c4, 0.42, 'structure')
    const relationship = theme.line(0x8fa5c4, 0.42)
    expect(structural).not.toBe(relationship)
    expect(structural.opacity).toBeLessThan(0.42)
    expect(relationship.opacity).toBe(1)
    setThemeMode('night', { persist: false })
    expect(structural.opacity).toBeCloseTo(0.42)
    expect(relationship.opacity).toBeCloseTo(0.42)
    setThemeMode('day', { persist: false })
    expect(relationship.opacity).toBe(1)
  } finally {
    setThemeMode('night', { persist: false })
    theme.dispose()
  }
})
