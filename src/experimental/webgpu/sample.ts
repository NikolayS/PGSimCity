import { DAY_PALETTE } from '../../core/themes'

export function frameAppearance(valid: boolean, pinned: boolean, dirty: boolean, usage: number, rise: number) {
  return {
    color: !valid ? DAY_PALETTE.bufFree : pinned ? DAY_PALETTE.bufPinned : dirty ? DAY_PALETTE.bufDirty : DAY_PALETTE.bufClean,
    height: valid ? 0.35 + (usage / 5) * rise : 0.15,
  }
}
