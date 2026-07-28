import { describe, expect, it } from 'vitest'
import {
  LABEL_AREA_BUDGET,
  LABEL_AREA_PLACEMENT_BUDGET,
  LABEL_PHONE_SCALE_CEILING,
  LABEL_SCALE_CEILING,
  LABEL_SCALE_FLOOR,
  labelScale,
} from './label-layout'

describe('floating label screen budget', () => {
  it('reserves less than the stated four-percent hard cap', () => {
    expect(LABEL_AREA_BUDGET).toBe(0.04)
    expect(LABEL_AREA_PLACEMENT_BUDGET).toBeLessThan(LABEL_AREA_BUDGET)
  })

  it('scales toward the 11px legibility floor with distance', () => {
    expect(labelScale(20, 1280)).toBe(LABEL_SCALE_CEILING)
    expect(labelScale(20, 390)).toBe(LABEL_PHONE_SCALE_CEILING)
    expect(labelScale(300, 1280)).toBeGreaterThan(labelScale(500, 1280))
    expect(labelScale(900, 1280)).toBe(LABEL_SCALE_FLOOR)
    expect(labelScale(900, 390)).toBe(LABEL_SCALE_FLOOR)
  })
})
