import '../styles/context-menu.css'

import type { Registry } from '../core/registry'
import type { Bus } from '../core/types'
import type { CameraRig } from '../engine/camera'
import type { PickerApi, PickHit } from '../engine/picker'
import { MODE_IDS } from './mode-exits'
import { el } from './uikit'
import type { UiModule } from './uikit'

export type ContextActionId =
  | 'inspect'
  | 'fly-to'
  | 'page-anatomy'
  | 'directory-layout'
  | 'reset-camera'
  | 'overhead'
  | 'toggle-theme'
  | 'toggle-labels'
  | 'first-person'

const VIEW_ACTIONS: ContextActionId[] = [
  'reset-camera',
  'overhead',
  'toggle-theme',
  'toggle-labels',
  'first-person',
]

/** The anatomy actions reflect existing instruments, never inferred commands. */
export function contextActionIds(hit: PickHit | null): ContextActionId[] {
  if (!hit || hit.id === 'world.ground') return VIEW_ACTIONS.slice()
  const actions: ContextActionId[] = ['inspect', 'fly-to']
  if (
    hit.part === 'page' ||
    hit.id.startsWith('storage.table.') ||
    hit.id.startsWith('storage.index.') ||
    hit.id === 'storage.toast'
  ) {
    actions.push('page-anatomy')
  }
  if (hit.id === 'storage.datadir') actions.push('directory-layout')
  return actions
}

interface ContextMenuOptions {
  dom: HTMLElement
  picker: Pick<PickerApi, 'pick'>
  registry: Registry
  bus: Bus
  rig: CameraRig
  host?: HTMLElement
}

interface LooseBus {
  emit(type: string, payload: unknown): void
}

const LABEL: Record<ContextActionId, string> = {
  inspect: 'Open in inspector',
  'fly-to': 'Fly to it',
  'page-anatomy': 'Open page anatomy',
  'directory-layout': 'Open directory layout',
  'reset-camera': 'Reset camera',
  overhead: 'Overhead view',
  'toggle-theme': 'Cycle light mode',
  'toggle-labels': 'Toggle labels',
  'first-person': 'Walk in first person',
}

const EDGE = 8
const LONG_PRESS_MS = 560
const LONG_PRESS_PX = 8
const CAMERA_EPS = 1e-8

export function contextMenuPosition(
  clientX: number,
  clientY: number,
  width: number,
  height: number,
  viewportW: number,
  viewportH: number,
  edge = EDGE,
): { x: number; y: number } {
  let x = clientX
  let y = clientY
  if (x + width + edge > viewportW) x = clientX - width
  if (y + height + edge > viewportH) y = clientY - height
  x = Math.max(edge, Math.min(x, viewportW - width - edge))
  y = Math.max(edge, Math.min(y, viewportH - height - edge))
  return { x, y }
}

export function createContextMenu(opts: ContextMenuOptions): UiModule {
  const { dom, picker, registry, bus, rig } = opts
  const host = opts.host ?? document.getElementById('hud') ?? document.body
  const loose = bus as unknown as LooseBus

  const root = el('div', {
    class: 'pg-context interactive',
    role: 'menu',
    'aria-label': 'Context menu',
    tabindex: '-1',
  })
  root.hidden = true
  host.append(root)

  let open = false
  let currentHit: PickHit | null = null
  let buttons: HTMLButtonElement[] = []
  let active = 0
  let lastFocus: HTMLElement | null = null

  let cameraX = 0
  let cameraY = 0
  let cameraZ = 0
  let cameraQx = 0
  let cameraQy = 0
  let cameraQz = 0
  let cameraQw = 1

  let longPressTimer = 0
  let longPressId = -1
  let longPressX = 0
  let longPressY = 0

  function rememberCamera(): void {
    const c = rig.camera
    cameraX = c.position.x
    cameraY = c.position.y
    cameraZ = c.position.z
    cameraQx = c.quaternion.x
    cameraQy = c.quaternion.y
    cameraQz = c.quaternion.z
    cameraQw = c.quaternion.w
  }

  function cameraMoved(): boolean {
    const c = rig.camera
    return (
      Math.abs(c.position.x - cameraX) > CAMERA_EPS ||
      Math.abs(c.position.y - cameraY) > CAMERA_EPS ||
      Math.abs(c.position.z - cameraZ) > CAMERA_EPS ||
      Math.abs(c.quaternion.x - cameraQx) > CAMERA_EPS ||
      Math.abs(c.quaternion.y - cameraQy) > CAMERA_EPS ||
      Math.abs(c.quaternion.z - cameraQz) > CAMERA_EPS ||
      Math.abs(c.quaternion.w - cameraQw) > CAMERA_EPS
    )
  }

  function cancelLongPress(): void {
    if (longPressTimer !== 0) window.clearTimeout(longPressTimer)
    longPressTimer = 0
    longPressId = -1
  }

  function close(restoreFocus = true): void {
    if (!open) return
    open = false
    root.hidden = true
    root.replaceChildren()
    buttons = []
    currentHit = null
    const back = lastFocus
    lastFocus = null
    if (restoreFocus && back && document.contains(back)) back.focus()
  }

  function run(action: ContextActionId): void {
    const hit = currentHit
    close()
    switch (action) {
      case 'inspect':
        if (hit) bus.emit('select', { id: hit.id })
        return
      case 'fly-to':
        if (hit) bus.emit('focus', { id: hit.id })
        return
      case 'page-anatomy':
        if (hit) bus.emit('anatomy:open', { view: 'page', id: hit.id })
        return
      case 'directory-layout':
        if (hit) bus.emit('anatomy:open', { view: 'directory', id: hit.id })
        return
      case 'reset-camera':
        rig.home(false)
        return
      case 'overhead':
        rig.plan(false)
        return
      case 'toggle-theme':
        loose.emit('ui:theme-toggle', {})
        return
      case 'toggle-labels':
        loose.emit('ui:labels-toggle', {})
        return
      case 'first-person':
        bus.emit('camera:mode', { mode: 'walk' })
        return
    }
  }

  function focusAt(index: number): void {
    if (buttons.length === 0) return
    active = (index + buttons.length) % buttons.length
    buttons[active].focus()
  }

  function positionAt(clientX: number, clientY: number): void {
    root.style.left = `${EDGE}px`
    root.style.top = `${EDGE}px`
    const width = root.offsetWidth
    const height = root.offsetHeight
    const viewportW = Math.max(1, window.innerWidth)
    const viewportH = Math.max(1, window.innerHeight)
    const position = contextMenuPosition(clientX, clientY, width, height, viewportW, viewportH)
    root.style.left = `${Math.round(position.x)}px`
    root.style.top = `${Math.round(position.y)}px`
  }

  function openAt(clientX: number, clientY: number): void {
    if (open) close(false)
    const picked = picker.pick(clientX, clientY)
    currentHit = picked?.id === 'world.ground' ? null : picked
    const actions = contextActionIds(currentHit)
    const title = currentHit ? registry.get(currentHit.id)?.name ?? currentHit.id : 'View'
    const closeButton = el('button', {
      class: 'pg-context__close',
      type: 'button',
      data: { modeExit: MODE_IDS.contextMenu },
      text: 'Close',
      role: 'menuitem',
      tabindex: '-1',
      'aria-label': 'Close context menu',
      on: { click: () => close() },
    })
    const heading = el(
      'div',
      { class: 'pg-context__head', role: 'presentation' },
      el('span', { class: 'pg-context__title', text: title }),
      closeButton,
    )
    const actionButtons = actions.map((action) =>
      el('button', {
        class: 'pg-context__item',
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        data: { contextAction: action },
        text: LABEL[action],
        on: { click: () => run(action) },
      }),
    )
    buttons = [...actionButtons, closeButton]
    root.replaceChildren(heading, ...actionButtons)
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.hidden = false
    open = true
    active = 0
    rememberCamera()
    positionAt(clientX, clientY)
    focusAt(0)
  }

  function onContextMenu(event: MouseEvent): void {
    event.preventDefault()
    cancelLongPress()
    openAt(event.clientX, event.clientY)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return
    if (longPressId !== -1 || event.isPrimary === false) {
      cancelLongPress()
      return
    }
    longPressId = event.pointerId
    longPressX = event.clientX
    longPressY = event.clientY
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0
      if (longPressId === event.pointerId) openAt(longPressX, longPressY)
    }, LONG_PRESS_MS)
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== longPressId) return
    if (
      Math.abs(event.clientX - longPressX) > LONG_PRESS_PX ||
      Math.abs(event.clientY - longPressY) > LONG_PRESS_PX
    ) {
      cancelLongPress()
    }
  }

  function onPointerEnd(event: PointerEvent): void {
    if (event.pointerId === longPressId) cancelLongPress()
  }

  function onDocumentPointerDown(event: PointerEvent): void {
    if (open && !root.contains(event.target as Node)) close(false)
  }

  function onFocusIn(event: FocusEvent): void {
    if (open && !root.contains(event.target as Node)) focusAt(active)
  }

  function onResize(): void {
    close(false)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!open) return
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        event.stopPropagation()
        focusAt(active + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        event.stopPropagation()
        focusAt(active - 1)
        return
      case 'Home':
        event.preventDefault()
        event.stopPropagation()
        focusAt(0)
        return
      case 'End':
        event.preventDefault()
        event.stopPropagation()
        focusAt(buttons.length - 1)
        return
      case 'Tab':
        event.preventDefault()
        event.stopPropagation()
        focusAt(active + (event.shiftKey ? -1 : 1))
        return
      case 'Enter':
      case ' ':
        event.preventDefault()
        event.stopPropagation()
        buttons[active]?.click()
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close()
        return
    }
  }

  dom.addEventListener('contextmenu', onContextMenu)
  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerup', onPointerEnd)
  dom.addEventListener('pointercancel', onPointerEnd)
  root.addEventListener('keydown', onKeyDown)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('focusin', onFocusIn)
  window.addEventListener('resize', onResize)

  return {
    update(_dt: number): void {
      if (open && cameraMoved()) close(false)
    },
    dispose(): void {
      cancelLongPress()
      close(false)
      dom.removeEventListener('contextmenu', onContextMenu)
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerup', onPointerEnd)
      dom.removeEventListener('pointercancel', onPointerEnd)
      root.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      document.removeEventListener('focusin', onFocusIn)
      window.removeEventListener('resize', onResize)
      root.remove()
    },
  }
}
