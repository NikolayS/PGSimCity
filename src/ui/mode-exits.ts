/*
 * Every persistent surface or camera state a visitor can enter must advertise
 * a DOM control that leaves it. Tests enumerate this catalogue and the
 * data-mode-exit tokens rendered by the real UI modules.
 */
export const MODE_IDS = {
  diagnose: 'diagnose',
  anatomyPage: 'anatomy-page',
  anatomyDirectory: 'anatomy-directory',
  walk: 'camera-walk',
  swim: 'buffer-swim',
  fly: 'camera-fly',
  plan: 'camera-plan',
  tour: 'guided-tour',
  scenario: 'scenario',
  help: 'help',
  palette: 'command-palette',
  contextMenu: 'context-menu',
  closeZoom: 'close-zoom',
} as const

export type ModeId = (typeof MODE_IDS)[keyof typeof MODE_IDS]

export const ENTERABLE_MODE_IDS: readonly ModeId[] = Object.freeze(Object.values(MODE_IDS))

export function modeTokens(...ids: ModeId[]): string {
  return ids.join(' ')
}
