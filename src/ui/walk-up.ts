import '../styles/walk-up.css'

import type { WalkController } from '../engine/walk'
import type { HandAction } from '../engine/hands'
import { el, setText } from './uikit'
import type { UiModule } from './uikit'

export type WalkUpState = string | number | boolean | null

/**
 * One world-space interaction bound to the shared proximity prompt.
 *
 * `state()` must return a primitive. It is polled every frame so the prompt can
 * follow changes made elsewhere without allocating in the proximity path.
 */
export interface WalkUpInteractionSite {
  id: string
  x: number
  z: number
  radius?: number
  owner: string
  subject: string
  /** Non-actionable cue shown before the visitor is close enough to operate. */
  approach?: string
  /** Discovery distance; the operating radius remains `radius`. */
  approachRadius?: number
  /** CSS colour used by the prompt, for example `var(--c-vacuum)`. */
  accent?: string
  /** Viewmodel cue; the target stays below the teaching-safe screen centre. */
  handAction?: HandAction
  handTarget?: readonly [number, number, number]
  state(): WalkUpState
  action(state: WalkUpState): string
  ariaLabel(state: WalkUpState): string
  operate(): void
}

export interface WalkUpInteractionOptions {
  walk: WalkController
  sites: readonly WalkUpInteractionSite[]
  keyCode?: string
  keyLabel?: string
  onOperate?(site: WalkUpInteractionSite): void
  /** Fires only when the nearest site or its operating-range state changes. */
  onProximityChange?(site: WalkUpInteractionSite | null, actionable: boolean): void
}

/** Kept beyond arm's reach because solid cabinets stop the walker's capsule. */
export const WALK_UP_RADIUS = 7.5
/** Early enough to teach that an approaching city-scale control is interactive. */
export const WALK_UP_APPROACH_RADIUS = 28

function typingTarget(target: EventTarget | null): boolean {
  const node = target as { tagName?: string; isContentEditable?: boolean } | null
  const tag = node?.tagName?.toUpperCase()
  return (
    tag === 'INPUT'
    || tag === 'SELECT'
    || tag === 'TEXTAREA'
    || node?.isContentEditable === true
  )
}

export function createWalkUpInteraction(opts: WalkUpInteractionOptions): UiModule {
  const { walk, sites } = opts
  const keyCode = opts.keyCode ?? 'KeyE'
  const keyLabel = opts.keyLabel ?? 'E'

  const owner = el('span', { class: 'walk-up-prompt__owner' })
  const subject = el('span', { class: 'walk-up-prompt__subject' })
  const key = el('kbd', { class: 'walk-up-prompt__key', text: keyLabel })
  const actionText = el('span', { class: 'walk-up-prompt__action-text' })
  const action = el(
    'button',
    {
      class: 'walk-up-prompt__action',
      type: 'button',
    },
    key,
    actionText,
  )
  const root = el(
    'section',
    {
      class: 'walk-up-prompt',
      'aria-live': 'polite',
      'aria-label': 'Nearby interaction',
    },
    owner,
    subject,
    action,
  )
  root.hidden = true
  document.body.append(root)

  let active = -1
  let actionable = false
  let paintedState: WalkUpState
  let hasPaintedState = false

  function paintSelection(index: number, canOperate: boolean): void {
    if (index === active && canOperate === actionable) return
    active = index
    actionable = canOperate
    opts.onProximityChange?.(sites[index] ?? null, canOperate)
    hasPaintedState = false
    const site = sites[index]
    root.hidden = site === undefined
    if (!site) {
      delete root.dataset.site
      delete root.dataset.range
      return
    }
    root.dataset.site = site.id
    root.dataset.range = canOperate ? 'operate' : 'approach'
    root.style.setProperty('--walk-up-accent', site.accent ?? 'var(--ink)')
    setText(owner, site.owner)
    setText(subject, site.subject)
    action.disabled = !canOperate
    key.hidden = !canOperate
    if (!canOperate) {
      setText(actionText, site.approach ?? 'Approach to interact')
      action.setAttribute('aria-label', site.approach ?? 'Approach to interact')
      delete action.dataset.state
    }
  }

  function paintState(): void {
    if (active < 0 || !actionable) return
    const site = sites[active]
    const next = site.state()
    if (hasPaintedState && Object.is(next, paintedState)) return
    hasPaintedState = true
    paintedState = next
    setText(actionText, site.action(next))
    action.setAttribute('aria-label', site.ariaLabel(next))
    if (next === null) delete action.dataset.state
    else action.dataset.state = String(next)
  }

  function operate(): void {
    if (active < 0 || !actionable || !walk.enabled) return
    const site = sites[active]
    opts.onOperate?.(site)
    site.operate()
    paintState()
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (
      event.code !== keyCode
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
      paintSelection(-1, false)
      return
    }

    const px = walk.position.x
    const pz = walk.position.z
    let nearest = -1
    let nearestSq = Number.POSITIVE_INFINITY
    let nearestActionable = false
    for (let i = 0; i < sites.length; i++) {
      const site = sites[i]
      const radius = site.radius ?? WALK_UP_RADIUS
      const approachRadius = Math.max(radius, site.approachRadius ?? radius)
      const dx = px - site.x
      const dz = pz - site.z
      const distanceSq = dx * dx + dz * dz
      if (distanceSq <= approachRadius * approachRadius && distanceSq < nearestSq) {
        nearestSq = distanceSq
        nearest = i
        nearestActionable = distanceSq <= radius * radius
      }
    }

    paintSelection(nearest, nearestActionable)
    paintState()
  }

  function dispose(): void {
    window.removeEventListener('keydown', onKeyDown)
    action.removeEventListener('click', operate)
    root.remove()
  }

  return { update, dispose }
}
