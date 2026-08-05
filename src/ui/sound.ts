import type { CameraMode } from '../core/types'

export const MOVEMENT_SOUND_MODE: CameraMode = 'walk'
export const MOVEMENT_SOUND_ON = 'Walk sound on'
export const MOVEMENT_SOUND_OFF = 'Walk sound off'
export const MOVEMENT_SOUND_READY = 'Walk sound ready'
export const MOVEMENT_SOUND_HELP = 'Walk sound on / off — starts off and remembers your choice'

const MOVEMENT_SOUND_TURN_ON = 'Turn walk sound on'
const MOVEMENT_SOUND_TURN_OFF = 'Turn walk sound off'
const MOVEMENT_SOUND_TURN_ON_TITLE = `${MOVEMENT_SOUND_TURN_ON}  (M)`
const MOVEMENT_SOUND_READY_TITLE = `${MOVEMENT_SOUND_READY} — interact to resume  (M)`

export function movementSoundEnabledToast(mode: CameraMode): string {
  return mode === MOVEMENT_SOUND_MODE
    ? MOVEMENT_SOUND_ON
    : `${MOVEMENT_SOUND_ON} — enter Walk to hear it`
}

export function movementSoundLabel(enabled: boolean, ready: boolean): string {
  return enabled ? MOVEMENT_SOUND_ON : ready ? MOVEMENT_SOUND_READY : MOVEMENT_SOUND_OFF
}

export function movementSoundAccessibleName(enabled: boolean): string {
  return enabled ? MOVEMENT_SOUND_TURN_OFF : MOVEMENT_SOUND_TURN_ON
}

export function movementSoundTitle(
  mode: CameraMode,
  enabled: boolean,
  ready: boolean,
  volume: number,
): string {
  if (!enabled) return ready ? MOVEMENT_SOUND_READY_TITLE : MOVEMENT_SOUND_TURN_ON_TITLE
  const level = `${Math.round(volume * 100)}%  (M)`
  return mode === MOVEMENT_SOUND_MODE
    ? `${MOVEMENT_SOUND_ON} · ${level}`
    : `${MOVEMENT_SOUND_ON} · enter Walk · ${level}`
}
