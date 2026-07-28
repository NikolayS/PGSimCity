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

/*
 * A mode exit can become redundant while another surface explains the same
 * view. Keep that relationship here with the exit catalogue: affordances
 * register once, and panels report only whether they are open.
 */
export const MODE_SURFACES = {
  panel: 'panel',
  drawer: 'drawer',
} as const

export type ModeSurface = (typeof MODE_SURFACES)[keyof typeof MODE_SURFACES]

const SUPPRESSED_BY: Readonly<Partial<Record<ModeId, readonly ModeSurface[]>>> = Object.freeze({
  [MODE_IDS.closeZoom]: Object.freeze([MODE_SURFACES.panel, MODE_SURFACES.drawer]),
})

interface ModeAffordance {
  id: ModeId
  setSuppressed(suppressed: boolean): void
}

const openSurfaces = new Map<object, ModeSurface>()
const affordances = new Set<ModeAffordance>()

function isSuppressed(id: ModeId): boolean {
  const suppressors = SUPPRESSED_BY[id]
  if (!suppressors) return false
  for (const surface of openSurfaces.values()) {
    if (suppressors.includes(surface)) return true
  }
  return false
}

function syncAffordances(): void {
  for (const affordance of affordances) {
    affordance.setSuppressed(isSuppressed(affordance.id))
  }
}

export function registerModeAffordance(
  id: ModeId,
  setSuppressed: (suppressed: boolean) => void,
): () => void {
  const affordance: ModeAffordance = { id, setSuppressed }
  affordances.add(affordance)
  setSuppressed(isSuppressed(id))
  return () => affordances.delete(affordance)
}

export function setModeSurface(owner: object, surface: ModeSurface | null): void {
  const previous = openSurfaces.get(owner)
  if (surface == null) {
    if (previous == null) return
    openSurfaces.delete(owner)
  } else {
    if (previous === surface) return
    openSurfaces.set(owner, surface)
  }
  syncAffordances()
}
