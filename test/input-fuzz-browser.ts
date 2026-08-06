import * as THREE from 'three'

import type { Bus, CameraMode, QualityLevel, SimApi } from '../src/core/types'
import type { CameraRig } from '../src/engine/camera'
import type { CollisionWorld } from '../src/engine/collision'
import type { WalkController } from '../src/engine/walk'
import { bufferPoolSurfaceY, CITY } from '../src/world/layout'

export type InputAction =
  | { kind: 'mode'; mode: 'orbit' | 'fly' | 'walk' }
  | { kind: 'pointer-drag'; gesture: 'pan' | 'orbit' | 'look'; dx: number; dy: number }
  | { kind: 'touch-gesture'; gesture: 'pan' | 'pinch' | 'twist'; amount: number }
  | { kind: 'keyboard-move'; code: string; key: string; frames: number; shift?: boolean }
  | { kind: 'walk-touch'; hold?: boolean; dx: number; dy: number }
  | { kind: 'pool'; direction: 'enter' | 'leave' }
  | { kind: 'panel'; panel: 'console' | 'inspector' | 'help' | 'palette' | 'city-words'; open: boolean }
  | { kind: 'tour'; running: boolean }
  | { kind: 'scenario'; id: string | null }
  | { kind: 'quality'; level: QualityLevel }
  | { kind: 'theme' }
  | { kind: 'reset' }
  | { kind: 'background' }
  | { kind: 'viewport'; width: number; height: number; mobile: boolean }

export interface InputFinding {
  invariant:
    | 'camera-bounds'
    | 'camera-ownership'
    | 'frame-loop'
    | 'input-latch'
    | 'input-recovery'
    | 'transform-finite'
    | 'unhandled-exception'
    | 'walker-bounds'
    | 'walker-ground'
  detail: string
}

interface FuzzTelemetry {
  appFrames: number
  blurs: number
  errors: string[]
  rejections: string[]
}

interface InputCity {
  bus: Bus
  sim: SimApi
  rig: CameraRig
  walk: WalkController
  collision: CollisionWorld
  gfx: {
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    quality: { level: QualityLevel }
  }
  setThemeMode(mode: 'day' | 'night' | 'clock', options?: { persist?: boolean }): void
}

declare global {
  interface Window {
    __PG_INPUT_FUZZ_TELEMETRY__?: FuzzTelemetry
  }
}

const CAMERA_XZ_LIMIT = 1200
const CAMERA_Y_MIN = -300
const CAMERA_Y_MAX = 900
const WALK_XZ_LIMIT = CITY.ground / 2 + 1
const WALK_Y_MIN = -CITY.pit.wallDepth - 5
const WALK_Y_MAX = 80

function pointer(
  target: Element,
  type: string,
  init: PointerEventInit & { movementX?: number; movementY?: number },
): void {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    isPrimary: init.isPrimary ?? true,
    ...init,
  }))
}

function keyEvent(
  type: 'keydown' | 'keyup',
  key: string,
  code: string,
  shift = false,
): void {
  window.dispatchEvent(new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key,
    code,
    shiftKey: shift,
  }))
}

function tick(city: InputCity, frames: number): void {
  for (let frame = 0; frame < frames; frame++) {
    city.rig.update(1 / 50)
    city.walk.update(1 / 50)
  }
}

function canvas(city: InputCity): HTMLCanvasElement {
  const element = city.gfx.camera ? document.querySelector<HTMLCanvasElement>('#canvas-root canvas') : null
  if (!element) throw new Error('input fuzzer could not find the production canvas')
  return element
}

function setMode(city: InputCity, mode: 'orbit' | 'fly' | 'walk'): void {
  if (mode === 'orbit' && city.rig.mode === 'orbit' && !city.walk.enabled) return
  if (mode === 'fly' && city.rig.mode === 'fly' && !city.walk.enabled) return
  if (mode === 'walk' && city.rig.mode === 'walk' && city.walk.enabled) return
  city.bus.emit('camera:mode', { mode })
  tick(city, 2)
}

function pointerDrag(city: InputCity, action: Extract<InputAction, { kind: 'pointer-drag' }>): void {
  if (action.gesture === 'look') setMode(city, 'fly')
  else setMode(city, 'orbit')
  const target = canvas(city)
  const rect = target.getBoundingClientRect()
  const x = rect.left + rect.width * 0.52
  const y = rect.top + rect.height * 0.48
  const shift = action.gesture === 'orbit'
  pointer(target, 'pointerdown', {
    pointerId: 11,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
    shiftKey: shift,
  })
  pointer(target, 'pointermove', {
    pointerId: 11,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: x + action.dx,
    clientY: y + action.dy,
    movementX: action.dx,
    movementY: action.dy,
    shiftKey: shift,
  })
  tick(city, 2)
  pointer(target, 'pointerup', {
    pointerId: 11,
    pointerType: 'mouse',
    button: 0,
    buttons: 0,
    clientX: x + action.dx,
    clientY: y + action.dy,
    shiftKey: shift,
  })
  tick(city, 2)
}

function touchGesture(city: InputCity, action: Extract<InputAction, { kind: 'touch-gesture' }>): void {
  setMode(city, 'orbit')
  const target = canvas(city)
  const rect = target.getBoundingClientRect()
  const cx = rect.left + rect.width * 0.5
  const cy = rect.top + rect.height * 0.48
  const span = Math.max(70, Math.min(140, rect.width * 0.3))
  const ax = cx - span / 2
  const bx = cx + span / 2
  pointer(target, 'pointerdown', {
    pointerId: 21,
    pointerType: 'touch',
    clientX: ax,
    clientY: cy,
  })
  if (action.gesture !== 'pan') {
    pointer(target, 'pointerdown', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: bx,
      clientY: cy,
      isPrimary: false,
    })
  }

  if (action.gesture === 'pan') {
    pointer(target, 'pointermove', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: ax + action.amount,
      clientY: cy + action.amount * 0.35,
    })
  } else if (action.gesture === 'pinch') {
    pointer(target, 'pointermove', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: ax - action.amount,
      clientY: cy,
    })
    pointer(target, 'pointermove', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: bx + action.amount,
      clientY: cy,
      isPrimary: false,
    })
  } else {
    pointer(target, 'pointermove', {
      pointerId: 21,
      pointerType: 'touch',
      clientX: ax + action.amount * 0.2,
      clientY: cy - action.amount,
    })
    pointer(target, 'pointermove', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: bx - action.amount * 0.2,
      clientY: cy + action.amount,
      isPrimary: false,
    })
  }
  tick(city, 2)

  if (action.gesture !== 'pan') {
    pointer(target, 'pointerup', {
      pointerId: 22,
      pointerType: 'touch',
      clientX: bx,
      clientY: cy,
      isPrimary: false,
    })
  }
  pointer(target, 'pointerup', {
    pointerId: 21,
    pointerType: 'touch',
    clientX: ax,
    clientY: cy,
  })
  tick(city, 2)
}

function keyboardMove(city: InputCity, action: Extract<InputAction, { kind: 'keyboard-move' }>): void {
  keyEvent('keydown', action.key, action.code, action.shift)
  tick(city, action.frames)
  keyEvent('keyup', action.key, action.code, false)
  tick(city, 2)
}

function walkTouch(city: InputCity, action: Extract<InputAction, { kind: 'walk-touch' }>): void {
  setMode(city, 'walk')
  const zone = document.querySelector<HTMLElement>('.touchpad__move-zone')
  if (!zone) throw new Error('input fuzzer could not find the touch movement zone')
  const rect = zone.getBoundingClientRect()
  const x = rect.left + Math.max(24, rect.width * 0.5)
  const y = rect.top + Math.max(24, rect.height * 0.5)
  const pointerId = action.hold ? 71 : 72
  pointer(zone, 'pointerdown', {
    pointerId,
    pointerType: 'touch',
    clientX: x,
    clientY: y,
  })
  pointer(zone, 'pointermove', {
    pointerId,
    pointerType: 'touch',
    clientX: x + action.dx,
    clientY: y + action.dy,
  })
  tick(city, 8)
  if (action.hold) return
  pointer(zone, 'pointerup', {
    pointerId,
    pointerType: 'touch',
    clientX: x + action.dx,
    clientY: y + action.dy,
  })
  tick(city, 2)
}

function poolCrossing(city: InputCity, direction: 'enter' | 'leave'): InputFinding[] {
  setMode(city, 'walk')
  /* The access ramps meet the full-pool surface. At low occupancy they are dry
   * above the waterline, so stage a full representative sample before asking
   * keyboard input to prove an ordinary swim crossing. */
  city.sim.state.buffers.usedCount = city.sim.state.buffers.sampleFrames
  if (direction === 'enter') {
    city.walk.setPose({
      x: 0,
      y: CITY.deck.top,
      z: CITY.buf.halfSpan + 0.12,
      yaw: 0,
      pitch: 0,
    })
  } else {
    city.walk.setPose({
      x: 0,
      y: bufferPoolSurfaceY(city.sim.state.buffers) - 0.2,
      z: -CITY.buf.halfSpan + 1,
      yaw: 0,
      pitch: 0,
    })
  }
  keyEvent('keydown', 'w', 'KeyW')
  for (let frame = 0; frame < 180; frame++) {
    city.walk.update(1 / 50)
    if (direction === 'enter' && city.walk.surface === 'water') break
    if (direction === 'leave' && city.walk.surface === 'deck' && city.walk.grounded) break
  }
  keyEvent('keyup', 'w', 'KeyW')
  tick(city, 3)
  if (direction === 'enter' && city.walk.surface !== 'water') {
    return [{ invariant: 'walker-ground', detail: 'keyboard crossing did not enter the buffer pool' }]
  }
  if (direction === 'leave' && (city.walk.surface !== 'deck' || !city.walk.grounded)) {
    return [{ invariant: 'walker-ground', detail: 'keyboard crossing did not regain the plaza deck' }]
  }
  return []
}

function panelAction(city: InputCity, action: Extract<InputAction, { kind: 'panel' }>): void {
  if (!action.open) {
    keyEvent('keydown', 'Escape', 'Escape')
    keyEvent('keyup', 'Escape', 'Escape')
    return
  }
  if (action.panel === 'console') city.bus.emit('panel:open', { panel: 'console' })
  else if (action.panel === 'inspector') {
    city.bus.emit('select', { id: 'shared.buffers' })
    city.bus.emit('panel:open', { panel: 'inspector', item: 'shared.buffers' })
  } else if (action.panel === 'help') city.bus.emit('ui:help', { open: true })
  else if (action.panel === 'palette') city.bus.emit('ui:palette', { open: true })
  else city.bus.emit('ui:city-words', { open: true })
}

function tourAction(city: InputCity, running: boolean): void {
  if (running) city.bus.emit('tour:start', { chapter: 0, source: 'button' })
  else city.bus.emit('tour:stop', {})
}

function scenarioAction(city: InputCity, id: string | null): void {
  if (id === null) {
    city.sim.runScenario(null)
    return
  }
  const button = document.querySelector<HTMLButtonElement>(`[data-scenario="${id}"]`)
  if (button) button.click()
  else city.sim.runScenario(id)
}

function qualityAction(city: InputCity, level: QualityLevel): void {
  const select = document.querySelector<HTMLSelectElement>('.hud-perf__sel')
  if (!select) throw new Error('input fuzzer could not find the quality selector')
  select.value = level
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function finite(values: ArrayLike<number>): boolean {
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index])) return false
  }
  return true
}

function inspectTransforms(city: InputCity): InputFinding[] {
  const findings: InputFinding[] = []
  city.gfx.scene.updateMatrixWorld(true)
  city.gfx.scene.traverse((object) => {
    if (findings.some((finding) => finding.invariant === 'transform-finite')) return
    if (
      !finite(object.position.toArray())
      || !finite(object.quaternion.toArray())
      || !finite(object.scale.toArray())
      || !finite(object.matrix.elements)
      || !finite(object.matrixWorld.elements)
    ) {
      findings.push({
        invariant: 'transform-finite',
        detail: `${object.name || object.type} contains a non-finite object transform`,
      })
      return
    }
    const instanced = object as THREE.InstancedMesh
    if (instanced.isInstancedMesh && !finite(instanced.instanceMatrix.array)) {
      findings.push({
        invariant: 'transform-finite',
        detail: `${object.name || object.type} contains a non-finite instance transform`,
      })
    }
  })
  return findings
}

export function inspectInputState(city: InputCity, fullTransforms = false): InputFinding[] {
  const findings: InputFinding[] = []
  const camera = city.gfx.camera
  const cameraValues = [
    ...camera.position.toArray(),
    ...camera.quaternion.toArray(),
    ...camera.matrix.elements,
    ...camera.matrixWorld.elements,
    ...camera.projectionMatrix.elements,
    camera.near,
    camera.far,
  ]
  if (!finite(cameraValues)) {
    findings.push({ invariant: 'transform-finite', detail: 'the active camera contains a non-finite transform' })
  }
  const quaternionLength = camera.quaternion.length()
  if (
    Math.abs(camera.position.x) > CAMERA_XZ_LIMIT + 1e-4
    || Math.abs(camera.position.z) > CAMERA_XZ_LIMIT + 1e-4
    || camera.position.y < CAMERA_Y_MIN - 1e-4
    || camera.position.y > CAMERA_Y_MAX + 1e-4
    || camera.near <= 0
    || camera.far <= camera.near
    || quaternionLength < 0.99
    || quaternionLength > 1.01
  ) {
    findings.push({
      invariant: 'camera-bounds',
      detail: `camera ${camera.position.toArray().map((value) => value.toFixed(3)).join(', ')}; near/far ${camera.near}/${camera.far}; quaternion ${quaternionLength}`,
    })
  }

  if (city.walk.enabled !== (city.rig.mode === 'walk')) {
    findings.push({
      invariant: 'camera-ownership',
      detail: `rig mode is ${city.rig.mode} while walk.enabled is ${city.walk.enabled}`,
    })
  }
  const bodyWalk = document.body.classList.contains('pg-walk')
  if (bodyWalk !== (city.rig.mode === 'walk')) {
    findings.push({
      invariant: 'camera-ownership',
      detail: `body pg-walk is ${bodyWalk} while rig mode is ${city.rig.mode}`,
    })
  }

  if (city.walk.enabled) {
    const position = city.walk.position
    if (
      !finite(position.toArray())
      || Math.abs(position.x) > WALK_XZ_LIMIT
      || Math.abs(position.z) > WALK_XZ_LIMIT
      || position.y < WALK_Y_MIN
      || position.y > WALK_Y_MAX
    ) {
      findings.push({
        invariant: 'walker-bounds',
        detail: `walker feet are ${position.toArray().map((value) => value.toFixed(3)).join(', ')}`,
      })
    }
    if (city.walk.grounded) {
      const ground = city.collision.groundAt(position, 3)
      if (ground === null || Math.abs(ground - position.y) > 0.55) {
        findings.push({
          invariant: 'walker-ground',
          detail: `grounded walker feet are y=${position.y.toFixed(3)} but collision ground is ${ground}`,
        })
      }
    }
  }

  const stick = document.querySelector<HTMLElement>('.touchpad__stick')
  const jump = document.querySelector<HTMLElement>('.touchpad__jump')
  const crouch = document.querySelector<HTMLElement>('.touchpad__crouch')
  if (
    stick?.dataset.active === 'true'
    || jump?.classList.contains('is-active')
    || crouch?.classList.contains('is-pressed')
  ) {
    findings.push({
      invariant: 'input-latch',
      detail: 'a touch walking control remains visually pressed after its interaction ended',
    })
  }

  const telemetry = window.__PG_INPUT_FUZZ_TELEMETRY__
  for (const error of telemetry?.errors ?? []) {
    findings.push({ invariant: 'unhandled-exception', detail: error })
  }
  for (const rejection of telemetry?.rejections ?? []) {
    findings.push({ invariant: 'unhandled-exception', detail: rejection })
  }
  if (fullTransforms) findings.push(...inspectTransforms(city))
  return findings
}

export async function performInputAction(
  city: InputCity,
  action: InputAction,
  fullTransforms = false,
): Promise<InputFinding[]> {
  let outcomes: InputFinding[] = []
  if (action.kind === 'mode') setMode(city, action.mode)
  else if (action.kind === 'pointer-drag') pointerDrag(city, action)
  else if (action.kind === 'touch-gesture') touchGesture(city, action)
  else if (action.kind === 'keyboard-move') keyboardMove(city, action)
  else if (action.kind === 'walk-touch') walkTouch(city, action)
  else if (action.kind === 'pool') outcomes = poolCrossing(city, action.direction)
  else if (action.kind === 'panel') panelAction(city, action)
  else if (action.kind === 'tour') tourAction(city, action.running)
  else if (action.kind === 'scenario') scenarioAction(city, action.id)
  else if (action.kind === 'quality') qualityAction(city, action.level)
  else if (action.kind === 'theme') document.querySelector<HTMLButtonElement>('.hud-theme')?.click()
  else if (action.kind === 'reset') document.querySelector<HTMLButtonElement>('.hud-reset')?.click()
  // Backgrounding and viewport changes are real CDP actions owned by the Node driver.
  const stateFindings = inspectInputState(city, fullTransforms)
  if (action.kind === 'walk-touch' && action.hold) {
    return [
      ...outcomes,
      ...stateFindings.filter((finding) => finding.invariant !== 'input-latch'),
    ]
  }
  return [...outcomes, ...stateFindings]
}

export async function resetInputState(city: InputCity): Promise<InputFinding[]> {
  window.dispatchEvent(new Event('blur'))
  for (const selector of [
    '.touchpad__move-zone',
    '.touchpad__look-zone',
    '.touchpad__jump',
    '.touchpad__crouch',
  ]) {
    const target = document.querySelector<HTMLElement>(selector)
    if (!target) continue
    for (const pointerId of [71, 72]) {
      pointer(target, 'pointercancel', { pointerId, pointerType: 'touch' })
    }
  }
  city.bus.emit('tour:stop', {})
  city.sim.runScenario(null)
  city.bus.emit('ui:help', { open: false })
  city.bus.emit('ui:palette', { open: false })
  city.bus.emit('ui:city-words', { open: false })
  city.bus.emit('select', { id: null })
  /* A prior ownership defect may itself have made camera:mode unable to repair
   * the state. The replay reset must not depend on the invariant it audits. */
  if (city.walk.enabled) city.walk.exit()
  city.rig.setMode('orbit')
  city.sim.reset()
  city.setThemeMode('day', { persist: false })
  city.bus.emit('quality', { level: 'low' })
  city.rig.home(true)
  tick(city, 3)
  const telemetry = window.__PG_INPUT_FUZZ_TELEMETRY__
  if (telemetry) {
    telemetry.errors.length = 0
    telemetry.rejections.length = 0
  }
  return inspectInputState(city, true)
}

export function frameLoopCount(): number {
  return window.__PG_INPUT_FUZZ_TELEMETRY__?.appFrames ?? -1
}

export function blurCount(): number {
  return window.__PG_INPUT_FUZZ_TELEMETRY__?.blurs ?? -1
}

export async function waitForFrames(count: number): Promise<void> {
  for (let frame = 0; frame < count; frame++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

export async function proveInputRecovery(city: InputCity): Promise<InputFinding[]> {
  const findings: InputFinding[] = []
  setMode(city, 'orbit')
  city.rig.home(true)
  const before = city.gfx.camera.position.clone()
  pointerDrag(city, { kind: 'pointer-drag', gesture: 'pan', dx: 42, dy: 18 })
  if (city.gfx.camera.position.distanceTo(before) < 0.01) {
    findings.push({ invariant: 'input-recovery', detail: 'a fresh orbit pan no longer moves the camera' })
  }
  return [...findings, ...inspectInputState(city, true)]
}
