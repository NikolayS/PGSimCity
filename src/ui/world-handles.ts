import '../styles/world-handles.css'

import type { WalkController } from '../engine/walk'
import type { WorldHandleBinding } from '../world/handles'
import { applyKnob } from './controls'
import { el, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

export interface WorldHandleUiOptions {
  ctx: UiContext
  walk: WalkController
  handles: readonly WorldHandleBinding[]
}

/** Kept beyond arm's reach because collision stops the walker at the cabinet. */
export const WORLD_HANDLE_RADIUS = 7.5
const WORLD_HANDLE_RADIUS_SQ = WORLD_HANDLE_RADIUS * WORLD_HANDLE_RADIUS

function typingTarget(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: string } | null)?.tagName?.toUpperCase()
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

export function createWorldHandleUi(opts: WorldHandleUiOptions): UiModule {
  const { ctx, walk, handles } = opts

  const owner = el('span', { class: 'world-handle-prompt__owner' })
  const guc = el('code', { class: 'world-handle-prompt__guc' })
  const key = el('kbd', { class: 'world-handle-prompt__key', text: 'E' })
  const actionText = el('span', { class: 'world-handle-prompt__action-text' })
  const action = el(
    'button',
    {
      class: 'world-handle-prompt__action',
      type: 'button',
    },
    key,
    actionText,
  )
  const root = el(
    'section',
    {
      class: 'world-handle-prompt',
      'aria-live': 'polite',
      'aria-label': 'Nearby in-world control',
    },
    owner,
    guc,
    action,
  )
  root.hidden = true
  document.body.append(root)

  let active = -1
  let paintedState: boolean | null = null

  function paintSelection(index: number): void {
    if (index === active) return
    active = index
    paintedState = null
    const binding = handles[index]
    root.hidden = binding === undefined
    if (!binding) return
    setText(owner, binding.owner)
    setText(guc, binding.guc)
  }

  function paintState(): void {
    if (active < 0) return
    const binding = handles[active]
    const on = ctx.sim.state.knobs[binding.key]
    if (on === paintedState) return
    paintedState = on
    setText(actionText, `PULL · CURRENTLY ${on ? 'ON' : 'OFF'}`)
    action.setAttribute('aria-label', `Turn ${binding.guc} ${on ? 'off' : 'on'}`)
    action.dataset.state = on ? 'on' : 'off'
  }

  function operate(): void {
    if (active < 0 || !walk.enabled) return
    const binding = handles[active]
    const next = !ctx.sim.state.knobs[binding.key]
    applyKnob(ctx.sim, binding.key, next)
    paintState()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (
      event.code !== 'KeyE'
      || event.repeat
      || event.ctrlKey
      || event.metaKey
      || event.altKey
      || typingTarget(event.target)
      || active < 0
      || !walk.enabled
    ) {
      return
    }
    event.preventDefault()
    operate()
  }

  action.addEventListener('click', operate)
  window.addEventListener('keydown', onKeyDown)

  function update(): void {
    if (!walk.enabled) {
      paintSelection(-1)
      return
    }

    const px = walk.position.x
    const pz = walk.position.z
    let nearest = -1
    let nearestSq = WORLD_HANDLE_RADIUS_SQ
    for (let i = 0; i < handles.length; i++) {
      const dx = px - handles[i].x
      const dz = pz - handles[i].z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq < nearestSq) {
        nearestSq = distanceSq
        nearest = i
      }
    }

    paintSelection(nearest)
    paintState()
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown)
    action.removeEventListener('click', operate)
    root.remove()
  }

  return { update, dispose }
}
