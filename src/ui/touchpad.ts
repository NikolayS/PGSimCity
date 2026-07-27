import '../styles/touchpad.css'

import type { Bus } from '../core/types'
import type { WalkController } from '../engine/walk'
import { MODE_IDS, modeTokens } from './mode-exits'
import { el, setClass, setText } from './uikit'
import type { UiModule } from './uikit'

/* ============================================================================
 * Touch pedestrian controls.
 *
 * The transparent zones own independent pointerIds: a left thumb can keep the
 * analogue stick pinned while a right thumb turns the head. No touch event is
 * forwarded to the canvas, so orbit's pan/pinch recogniser stays dormant while
 * the walker owns the camera. Pointer lock is deliberately absent.
 * ==========================================================================*/

export interface TouchpadOptions {
  bus: Bus
  walk: WalkController
}

const STICK_RADIUS = 58
const DEAD_ZONE = 0.08
/** CSS defines one inch as 96 px, independent of device pixel ratio. */
const CSS_PIXELS_PER_CM = 96 / 2.54

export function createTouchpad(opts: TouchpadOptions): UiModule {
  const { bus, walk } = opts
  const cleanup: (() => void)[] = []
  const coarse = window.matchMedia('(pointer: coarse)')

  const moveZone = el('div', {
    class: 'touchpad__move-zone',
    'aria-label': 'Movement stick area',
  })
  const lookZone = el('div', {
    class: 'touchpad__look-zone',
    'aria-label': 'Drag to look',
  })
  const stick = el(
    'div',
    { class: 'touchpad__stick', 'data-active': 'false', 'aria-hidden': 'true' },
    el('i', { class: 'touchpad__stick-ring' }),
    el('i', { class: 'touchpad__stick-knob' }),
  )
  const moveHint = el('span', { class: 'touchpad__hint touchpad__hint--move', text: 'MOVE' })
  const lookHint = el('span', { class: 'touchpad__hint touchpad__hint--look', text: 'DRAG TO LOOK' })

  const jumpText = el('span', { text: 'Jump' })
  const jumpBtn = el(
    'button',
    {
      class: 'touchpad__action touchpad__jump',
      type: 'button',
      'aria-label': 'Jump',
    },
    jumpText,
  )
  const crouchText = el('span', { text: 'Crouch' })
  const crouchBtn = el(
    'button',
    {
      class: 'touchpad__action touchpad__crouch',
      type: 'button',
      'aria-label': 'Toggle crouch',
      'aria-pressed': 'false',
    },
    crouchText,
  )
  const actions = el('div', { class: 'touchpad__actions' }, crouchBtn, jumpBtn)
  const exitBtn = el(
    'button',
    {
      class: 'touchpad__exit',
      type: 'button',
      data: { modeExit: modeTokens(MODE_IDS.walk, MODE_IDS.swim) },
      'aria-label': 'Exit walk mode',
      on: {
        click: () => bus.emit('camera:mode', { mode: 'orbit' }),
      },
    },
    el('span', { 'aria-hidden': 'true', text: '↑' }),
    'Exit walk',
  )

  const root = el(
    'section',
    {
      class: 'touchpad',
      'data-enabled': 'false',
      'aria-label': 'Touch walking controls',
      'aria-hidden': 'true',
    },
    moveZone,
    lookZone,
    moveHint,
    lookHint,
    stick,
    actions,
    exitBtn,
  )
  document.body.append(root)

  let movePointerId: number | null = null
  let lookPointerId: number | null = null
  let jumpPointerId: number | null = null
  let crouchPointerId: number | null = null
  let stickX = 0
  let stickY = 0
  let lookX = 0
  let lookY = 0
  let crouchToggled = false
  let crouchIsDive = false
  let active = false
  let lastSwimming = false

  function bind(
    node: HTMLElement,
    type: string,
    fn: EventListener,
    options?: AddEventListenerOptions,
  ): void {
    node.addEventListener(type, fn, options)
    cleanup.push(() => node.removeEventListener(type, fn, options))
  }

  function capture(node: HTMLElement, pointerId: number): void {
    try {
      node.setPointerCapture(pointerId)
    } catch {
      // A cancelled contact can disappear between pointerdown and capture.
    }
  }

  function release(node: HTMLElement, pointerId: number): void {
    try {
      if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId)
    } catch {
      // The browser already released it.
    }
  }

  function paintStick(x: number, y: number, on: boolean): void {
    stick.style.setProperty('--stick-x', `${x}px`)
    stick.style.setProperty('--stick-y', `${y}px`)
    stick.dataset.active = String(on)
  }

  function applyStick(clientX: number, clientY: number): void {
    let dx = clientX - stickX
    let dy = clientY - stickY
    let magnitude = Math.hypot(dx, dy) / STICK_RADIUS
    if (magnitude > 1) {
      dx /= magnitude
      dy /= magnitude
      magnitude = 1
    }
    const rawX = dx / STICK_RADIUS
    const rawY = dy / STICK_RADIUS
    const scaled = magnitude <= DEAD_ZONE ? 0 : (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE)
    const directionScale = magnitude > 1e-6 ? scaled / magnitude : 0
    walk.setTouchMove(rawX * directionScale, -rawY * directionScale)
    stick.style.setProperty('--knob-x', `${dx}px`)
    stick.style.setProperty('--knob-y', `${dy}px`)
  }

  function neutralStick(): void {
    walk.setTouchMove(0, 0)
    stick.style.setProperty('--knob-x', '0px')
    stick.style.setProperty('--knob-y', '0px')
    stick.dataset.active = 'false'
  }

  function onMoveDown(event: Event): void {
    const e = event as PointerEvent
    if (!active || e.pointerType !== 'touch' || movePointerId !== null) return
    e.preventDefault()
    movePointerId = e.pointerId
    stickX = e.clientX
    stickY = e.clientY
    capture(moveZone, e.pointerId)
    paintStick(stickX, stickY, true)
    applyStick(e.clientX, e.clientY)
  }

  function onMoveMove(event: Event): void {
    const e = event as PointerEvent
    if (e.pointerId !== movePointerId) return
    e.preventDefault()
    applyStick(e.clientX, e.clientY)
  }

  function onMoveEnd(event: Event): void {
    const e = event as PointerEvent
    if (e.pointerId !== movePointerId) return
    e.preventDefault()
    movePointerId = null
    release(moveZone, e.pointerId)
    neutralStick()
  }

  function onLookDown(event: Event): void {
    const e = event as PointerEvent
    if (!active || e.pointerType !== 'touch' || lookPointerId !== null) return
    e.preventDefault()
    lookPointerId = e.pointerId
    lookX = e.clientX
    lookY = e.clientY
    capture(lookZone, e.pointerId)
    setClass(lookHint, 'is-active', true)
  }

  function onLookMove(event: Event): void {
    const e = event as PointerEvent
    if (e.pointerId !== lookPointerId) return
    e.preventDefault()
    const dx = e.clientX - lookX
    const dy = e.clientY - lookY
    lookX = e.clientX
    lookY = e.clientY
    walk.addTouchLook(dx / CSS_PIXELS_PER_CM, dy / CSS_PIXELS_PER_CM)
  }

  function onLookEnd(event: Event): void {
    const e = event as PointerEvent
    if (e.pointerId !== lookPointerId) return
    e.preventDefault()
    lookPointerId = null
    release(lookZone, e.pointerId)
    setClass(lookHint, 'is-active', false)
  }

  function onJumpDown(event: Event): void {
    const e = event as PointerEvent
    if (!active || e.pointerType !== 'touch' || jumpPointerId !== null) return
    e.preventDefault()
    e.stopPropagation()
    jumpPointerId = e.pointerId
    capture(jumpBtn, e.pointerId)
    walk.setTouchJump(true)
    setClass(jumpBtn, 'is-active', true)
  }

  function onJumpEnd(event: Event): void {
    const e = event as PointerEvent
    if (e.pointerId !== jumpPointerId) return
    e.preventDefault()
    e.stopPropagation()
    jumpPointerId = null
    release(jumpBtn, e.pointerId)
    walk.setTouchJump(false)
    setClass(jumpBtn, 'is-active', false)
  }

  function onCrouchDown(event: Event): void {
    const e = event as PointerEvent
    if (!active || e.pointerType !== 'touch' || crouchPointerId !== null) return
    e.preventDefault()
    e.stopPropagation()
    crouchPointerId = e.pointerId
    crouchIsDive = walk.surface === 'water'
    capture(crouchBtn, e.pointerId)
    if (crouchIsDive) walk.setTouchCrouch(true)
    setClass(crouchBtn, 'is-pressed', true)
  }

  function finishCrouch(e: PointerEvent, toggle: boolean): void {
    if (e.pointerId !== crouchPointerId) return
    e.preventDefault()
    e.stopPropagation()
    crouchPointerId = null
    release(crouchBtn, e.pointerId)
    setClass(crouchBtn, 'is-pressed', false)
    if (crouchIsDive) {
      walk.setTouchCrouch(false)
    } else if (toggle) {
      crouchToggled = !crouchToggled
      walk.setTouchCrouch(crouchToggled)
      crouchBtn.setAttribute('aria-pressed', String(crouchToggled))
      setClass(crouchBtn, 'is-active', crouchToggled)
    }
    crouchIsDive = false
  }

  function onCrouchUp(event: Event): void {
    finishCrouch(event as PointerEvent, true)
  }

  function onCrouchCancel(event: Event): void {
    finishCrouch(event as PointerEvent, false)
  }

  bind(moveZone, 'pointerdown', onMoveDown, { passive: false })
  bind(moveZone, 'pointermove', onMoveMove, { passive: false })
  bind(moveZone, 'pointerup', onMoveEnd, { passive: false })
  bind(moveZone, 'pointercancel', onMoveEnd, { passive: false })
  bind(lookZone, 'pointerdown', onLookDown, { passive: false })
  bind(lookZone, 'pointermove', onLookMove, { passive: false })
  bind(lookZone, 'pointerup', onLookEnd, { passive: false })
  bind(lookZone, 'pointercancel', onLookEnd, { passive: false })
  bind(jumpBtn, 'pointerdown', onJumpDown, { passive: false })
  bind(jumpBtn, 'pointerup', onJumpEnd, { passive: false })
  bind(jumpBtn, 'pointercancel', onJumpEnd, { passive: false })
  bind(crouchBtn, 'pointerdown', onCrouchDown, { passive: false })
  bind(crouchBtn, 'pointerup', onCrouchUp, { passive: false })
  bind(crouchBtn, 'pointercancel', onCrouchCancel, { passive: false })

  function resetPointers(): void {
    movePointerId = null
    lookPointerId = null
    jumpPointerId = null
    crouchPointerId = null
    crouchToggled = false
    crouchIsDive = false
    walk.setTouchMove(0, 0)
    walk.setTouchJump(false)
    walk.setTouchCrouch(false)
    neutralStick()
    setClass(lookHint, 'is-active', false)
    setClass(jumpBtn, 'is-active', false)
    setClass(crouchBtn, 'is-active', false)
    setClass(crouchBtn, 'is-pressed', false)
    crouchBtn.setAttribute('aria-pressed', 'false')
  }

  function setActive(next: boolean): void {
    if (next === active) return
    active = next
    root.dataset.enabled = String(active)
    root.setAttribute('aria-hidden', String(!active))
    document.body.classList.toggle('touch-walk-active', active)
    if (!active) resetPointers()
  }

  const onCoarseChange = (): void => setActive(walk.enabled && coarse.matches)
  coarse.addEventListener('change', onCoarseChange)
  cleanup.push(() => coarse.removeEventListener('change', onCoarseChange))

  function update(): void {
    setActive(walk.enabled && coarse.matches)
    if (!active) return
    const swimming = walk.surface === 'water'
    if (swimming === lastSwimming) return
    lastSwimming = swimming
    setText(jumpText, swimming ? 'Rise' : 'Jump')
    jumpBtn.setAttribute('aria-label', swimming ? 'Rise while swimming' : 'Jump')
    setText(crouchText, swimming ? 'Dive' : 'Crouch')
    crouchBtn.setAttribute('aria-label', swimming ? 'Hold to dive' : 'Toggle crouch')
  }

  function dispose(): void {
    setActive(false)
    for (const off of cleanup) off()
    cleanup.length = 0
    root.remove()
  }

  return { update, dispose }
}
