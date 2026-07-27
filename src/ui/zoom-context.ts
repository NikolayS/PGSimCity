import '../styles/zoom-context.css'

import type { Registry } from '../core/registry'
import type { CameraRig } from '../engine/camera'
import type { PickerApi } from '../engine/picker'
import { MODE_IDS } from './mode-exits'
import { el, icon, setText } from './uikit'
import type { UiModule } from './uikit'

/** Below this orbit distance, one component can fill the viewport. */
export const ZOOM_CONTEXT_DISTANCE = 40
/** Hysteresis keeps the caption from flickering at the activation boundary. */
const ZOOM_CONTEXT_RELEASE_DISTANCE = 46
/** Centre-screen raycasts are informative, not frame-critical. */
const PICK_INTERVAL_SECONDS = 0.2

interface ZoomContextOptions {
  dom: HTMLElement
  picker: Pick<PickerApi, 'pick'>
  registry: Pick<Registry, 'get'>
  rig: Pick<CameraRig, 'camera' | 'mode' | 'pivot' | 'home'>
  host?: HTMLElement
}

export function createZoomContext(opts: ZoomContextOptions): UiModule {
  const { dom, picker, registry, rig } = opts
  const host = opts.host ?? document.getElementById('hud') ?? document.body

  const name = el('strong', { class: 'zoom-context__name' })
  const role = el('span', { class: 'zoom-context__role' })
  const exit = el(
    'button',
    {
      class: 'zoom-context__exit',
      type: 'button',
      data: { modeExit: MODE_IDS.closeZoom },
      'aria-label': 'Back to city overview',
    },
    icon('home', 15),
    el('span', { text: 'Back to city' }),
    el('kbd', { text: 'Home' }),
  )
  const root = el(
    'div',
    {
      class: 'zoom-context',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    },
    el(
      'div',
      { class: 'zoom-context__copy' },
      el('span', { class: 'zoom-context__eyebrow', text: 'You’re looking at' }),
      name,
      role,
    ),
    exit,
  )
  root.hidden = true
  host.append(root)

  let centerX = 0
  let centerY = 0
  let sampleT = PICK_INTERVAL_SECONDS
  let close = false
  let currentId: string | null = null

  function measureCanvas(): void {
    const rect = dom.getBoundingClientRect()
    centerX = rect.left + rect.width * 0.5
    centerY = rect.top + rect.height * 0.5
  }

  function hide(): void {
    if (!root.hidden) root.hidden = true
    currentId = null
  }

  function onExit(): void {
    hide()
    rig.home(false)
  }

  function onResize(): void {
    measureCanvas()
    sampleT = PICK_INTERVAL_SECONDS
  }

  exit.addEventListener('click', onExit)
  window.addEventListener('resize', onResize)
  measureCanvas()

  return {
    update(dt: number): void {
      if (rig.mode !== 'orbit') {
        close = false
        sampleT = PICK_INTERVAL_SECONDS
        hide()
        return
      }

      const dx = rig.camera.position.x - rig.pivot.x
      const dy = rig.camera.position.y - rig.pivot.y
      const dz = rig.camera.position.z - rig.pivot.z
      const distanceSq = dx * dx + dy * dy + dz * dz
      const threshold = close ? ZOOM_CONTEXT_RELEASE_DISTANCE : ZOOM_CONTEXT_DISTANCE
      if (distanceSq > threshold * threshold) {
        close = false
        sampleT = PICK_INTERVAL_SECONDS
        hide()
        return
      }
      close = true

      sampleT += dt
      if (sampleT < PICK_INTERVAL_SECONDS) return
      sampleT = 0

      const hit = picker.pick(centerX, centerY)
      const def = hit ? registry.get(hit.id) : undefined
      if (!def) {
        hide()
        return
      }
      if (def.id !== currentId) {
        currentId = def.id
        root.dataset.district = def.district
        setText(name, def.name)
        setText(role, def.role)
      }
      root.hidden = false
    },
    dispose(): void {
      exit.removeEventListener('click', onExit)
      window.removeEventListener('resize', onResize)
      root.remove()
    },
  }
}
