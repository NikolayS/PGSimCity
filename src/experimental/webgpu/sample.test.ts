import { expect, it } from 'vitest'
import { frameAppearance } from './sample'
import { DAY_PALETTE } from '../../core/themes'

it('preserves semantic precedence without conflating dirtiness and usage', () => {
  expect(frameAppearance(false, true, true, 5, 5.2)).toEqual({ color: DAY_PALETTE.bufFree, height: 0.15 })
  expect(frameAppearance(true, true, true, 0, 5.2)).toEqual({ color: DAY_PALETTE.bufPinned, height: 0.35 })
  expect(frameAppearance(true, false, true, 5, 5.2)).toEqual({ color: DAY_PALETTE.bufDirty, height: 5.55 })
  expect(frameAppearance(true, false, false, 0, 5.2)).toEqual({ color: DAY_PALETTE.bufClean, height: 0.35 })
})
