import type { UiContext } from './uikit'
import { applyKnob } from './controls'
import type { WalkUpInteractionSite, WalkUpState } from './walk-up'
import type { WorldHandleBinding } from '../world/handles'

const PULL_ON = 'PULL · CURRENTLY ON'
const PULL_OFF = 'PULL · CURRENTLY OFF'
const TURN_ON = 'Turn autovacuum on'
const TURN_OFF = 'Turn autovacuum off'

function stateLabel(ctx: UiContext): 'on' | 'off' {
  return ctx.sim.state.knobs.autovacuum ? 'on' : 'off'
}

function actionLabel(state: WalkUpState): string {
  return state === 'on' ? PULL_ON : PULL_OFF
}

function ariaLabel(state: WalkUpState): string {
  return state === 'on' ? TURN_OFF : TURN_ON
}

/**
 * Adapts world-owned handle positions to the shared prompt. A postmaster door
 * supplies another `WalkUpInteractionSite` beside these; it needs no new input
 * listener, prompt, or proximity loop.
 */
export function createWorldHandleSites(
  ctx: UiContext,
  handles: readonly WorldHandleBinding[],
): WalkUpInteractionSite[] {
  const sites: WalkUpInteractionSite[] = []
  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i]
    sites.push({
      id: handle.id,
      x: handle.x,
      z: handle.z,
      owner: handle.owner,
      subject: handle.guc,
      accent: 'var(--c-vacuum)',
      state: () => stateLabel(ctx),
      action: actionLabel,
      ariaLabel,
      operate: () => {
        applyKnob(ctx.sim, 'autovacuum', !ctx.sim.state.knobs.autovacuum)
      },
    })
  }
  return sites
}
