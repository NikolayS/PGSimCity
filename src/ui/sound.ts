import type { CameraMode } from '../core/types'

export const MOVEMENT_SOUND_MODE: CameraMode = 'walk'
export const MOVEMENT_SOUND_ON = 'Walk sound on'
export const MOVEMENT_SOUND_OFF = 'Walk sound off'
export const MOVEMENT_SOUND_READY = 'Walk sound ready'

export function movementSoundEnabledToast(mode: CameraMode): string {
  return mode === MOVEMENT_SOUND_MODE
    ? MOVEMENT_SOUND_ON
    : `${MOVEMENT_SOUND_ON} — enter Walk to hear it`
}

export function movementSoundTitle(mode: CameraMode, volume: number): string {
  const level = `${Math.round(volume * 100)}%  (M)`
  return mode === MOVEMENT_SOUND_MODE
    ? `${MOVEMENT_SOUND_ON} · ${level}`
    : `${MOVEMENT_SOUND_ON} · enter Walk · ${level}`
}
