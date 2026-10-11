import { searchWithVisualMode } from '../engine/visual-polish'
import type { VisualMode } from '../engine/visual-polish'
import { el } from './uikit'
import type { UiModule } from './uikit'

/* ============================================================================
 * Baseline / Polished switch for the ?visual=polish comparison preview.
 *
 * Mounted only on a comparison URL. Switching changes light uniforms, the day
 * grade and the style of the *next* focus move: no rebuild, no reload, and no
 * camera, simulation or theme state is touched.
 * ==========================================================================*/

export interface VisualCompareDeps {
  getMode(): VisualMode
  setMode(mode: VisualMode): void
  /** Records the choice so a reload keeps it; defaults to history.replaceState. */
  record?(mode: VisualMode): void
}

export const VISUAL_COMPARE_NOTE = 'Same model, geometry and palette. Polished retunes daylight and focus moves.'

const OPTIONS: readonly { mode: VisualMode; label: string }[] = [
  { mode: 'baseline', label: 'Baseline' },
  { mode: 'polish', label: 'Polished' },
]

/* Appended after .hud-bar inside #hud-top so it reserves its own row in the
 * top strip; the #hud deck row belongs to the first-run tour card. */
export function visualCompareHost(doc: Pick<Document, 'getElementById'>): HTMLElement | null {
  return doc.getElementById('hud-top')
}

function recordInAddressBar(mode: VisualMode): void {
  try {
    const { pathname, search, hash } = window.location
    window.history.replaceState(window.history.state, '', `${pathname}${searchWithVisualMode(search, mode)}${hash}`)
  } catch {
    // A sandboxed or file:// page may refuse; the switch still works in place.
  }
}

export function createVisualCompare(root: HTMLElement, deps: VisualCompareDeps): UiModule {
  const record = deps.record ?? recordInAddressBar
  const buttons = OPTIONS.map(({ mode, label }) =>
    el('button', {
      type: 'button',
      class: 'pg-btn visual-compare__option',
      text: label,
      data: { visualMode: mode },
      on: { click: () => choose(mode) },
    }),
  )
  const node = el(
    'div',
    { class: 'visual-compare', role: 'group', 'aria-label': 'Renderer comparison preview' },
    el('span', { class: 'visual-compare__label', text: 'Preview' }),
    ...buttons,
    el('p', { class: 'visual-compare__note', text: VISUAL_COMPARE_NOTE }),
  )
  root.append(node)
  root.classList.add('has-visual-compare')
  sync()

  function sync(): void {
    const current = deps.getMode()
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(OPTIONS[i].mode === current))
    }
  }

  function choose(mode: VisualMode): void {
    if (mode !== deps.getMode()) {
      deps.setMode(mode)
      record(mode)
    }
    sync()
  }

  return {
    update() {},
    dispose() {
      node.remove()
      root.classList.remove('has-visual-compare')
    },
  }
}
