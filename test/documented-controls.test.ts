import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/world/slonik', () => ({
  PLAN_UP: [0, 1],
  sampleOutline: () => [-100, -100, 100, -100, 100, 100, -100, 100],
}))

import { createBus } from '../src/core/bus'
import { DESTINATIONS } from '../src/core/destinations'
import { themeMode } from '../src/core/theme'
import type { CameraMode } from '../src/core/types'
import { DEFAULT_KNOBS } from '../src/core/types'
import { createCameraRig, type CameraRig } from '../src/engine/camera'
import { createSim } from '../src/sim/model'
import { KNOB_META } from '../src/ui/content'
import { createControls } from '../src/ui/controls'
import { APP_KEYS, CAMERA_KEYS, createHelp, type KeyRow } from '../src/ui/help'
import { createHud } from '../src/ui/hud'
import { createSearch } from '../src/ui/search'
import type { UiContext, UiModule } from '../src/ui/uikit'
import { installTestDom } from './dom'

interface Fixture {
  ctx: UiContext
  modules: UiModule[]
  cameraRig?: CameraRig
  camera?: THREE.PerspectiveCamera
  cameraSurface?: HTMLElement
}

const liveFixtures: Fixture[] = []

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { all: () => [], get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

function fixture(withCamera = false): Fixture {
  const dom = installTestDom()
  for (const id of [
    'hud-top',
    'hud-bottom',
    'hud-left',
    'toast-stack',
    'compass',
    'help-overlay',
  ]) dom.mount(id)

  const ctx = context()
  const modules = [createSearch(ctx), createHud(ctx), createHelp(ctx), createControls(ctx)]
  const created: Fixture = { ctx, modules }
  if (withCamera) {
    const surface = dom.mount('documented-camera') as unknown as HTMLElement
    Object.defineProperties(surface, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
      getBoundingClientRect: {
        value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      },
      setPointerCapture: { value: () => {} },
      releasePointerCapture: { value: () => {} },
      hasPointerCapture: { value: () => false },
    })
    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 3000)
    created.camera = camera
    created.cameraSurface = surface
    created.cameraRig = createCameraRig(camera, surface, ctx.bus)
  }
  liveFixtures.push(created)
  return created
}

afterEach(() => {
  while (liveFixtures.length) {
    const current = liveFixtures.pop()!
    current.cameraRig?.dispose()
    for (const module of current.modules.reverse()) module.dispose()
  }
})

function instruction(rows: readonly KeyRow[], id: string): KeyRow {
  const row = rows.find((candidate) => candidate.id === id)
  expect(row, `documented instruction ${id}`).toBeDefined()
  return row!
}

function keyEvent(token: string, overrides: Partial<{
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}> = {}): Event {
  const compact = token.replace(/\s+/g, '')
  const named = compact.split('+').at(-1) ?? compact
  const aliases: Record<string, { key: string; code: string }> = {
    Esc: { key: 'Escape', code: 'Escape' },
    Home: { key: 'Home', code: 'Home' },
    Enter: { key: 'Enter', code: 'Enter' },
    Space: { key: ' ', code: 'Space' },
    PgUp: { key: 'PageUp', code: 'PageUp' },
    PgDn: { key: 'PageDown', code: 'PageDown' },
    '/': { key: '/', code: 'Slash' },
    '?': { key: '?', code: 'Slash' },
    ',': { key: ',', code: 'Comma' },
    '.': { key: '.', code: 'Period' },
  }
  const resolved = aliases[named] ?? (
    /^[A-Za-z]$/.test(named)
      ? { key: named, code: `Key${named.toUpperCase()}` }
      : /^[1-8]$/.test(named)
        ? { key: named, code: `Digit${named}` }
        : { key: named, code: named }
  )
  const event = new Event('keydown', { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    key: { value: resolved.key },
    code: { value: resolved.code },
    repeat: { value: false },
    altKey: { value: false },
    ctrlKey: { value: overrides.ctrlKey ?? compact.includes('Ctrl') },
    metaKey: { value: overrides.metaKey ?? compact.includes('Cmd') },
    shiftKey: { value: overrides.shiftKey ?? compact.includes('Shift+') },
  })
  return event
}

function press(token: string, overrides?: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>): Event {
  const event = keyEvent(token, overrides)
  window.dispatchEvent(event)
  return event
}

function release(token: string): void {
  const down = keyEvent(token)
  const event = new Event('keyup', { bubbles: true })
  for (const key of ['key', 'code', 'altKey', 'ctrlKey', 'metaKey'] as const) {
    Object.defineProperty(event, key, { value: (down as unknown as Record<string, unknown>)[key] })
  }
  Object.defineProperty(event, 'shiftKey', { value: false })
  window.dispatchEvent(event)
}

function pointer(
  type: string,
  token: string,
  x: number,
  y: number,
): Event {
  const event = new Event(type, { cancelable: true })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    button: { value: token.includes('RMB') ? 2 : token.includes('MMB') ? 1 : 0 },
    clientX: { value: x },
    clientY: { value: y },
    movementX: { value: 0 },
    movementY: { value: 0 },
    shiftKey: { value: token.includes('Shift+') },
    ctrlKey: { value: token.includes('Ctrl+') },
    metaKey: { value: token.includes('Cmd+') },
  })
  return event
}

function drag(surface: HTMLElement, token: string): void {
  surface.dispatchEvent(pointer('pointerdown', token, 280, 260))
  surface.dispatchEvent(pointer('pointermove', token, 340, 305))
}

describe('documented city keyboard instructions', () => {
  it('covers every globally documented application action', () => {
    expect(APP_KEYS.map((row) => row.id)).toEqual([
      'pause',
      'playback-rate',
      'tour',
      'reset',
      'fly',
      'walk',
      'walk-button',
      'home',
      'default-home',
      'overview',
      'trace',
      'palette',
      'help',
      'labels',
      'theme',
      'sound',
      'escape',
      'districts',
    ])
  })

  it('drives pause, playback rate, tour, and reset from the printed keys', () => {
    const current = fixture()
    const pause = instruction(APP_KEYS, 'pause')
    press(pause.keys[0])
    expect(current.ctx.sim.state.knobs.paused).toBe(true)
    press(pause.keys[1])
    expect(current.ctx.sim.state.knobs.paused).toBe(false)

    const rate = instruction(APP_KEYS, 'playback-rate')
    press(rate.keys[0])
    expect(current.ctx.sim.state.knobs.timeScale).toBeLessThan(DEFAULT_KNOBS.timeScale)
    press(rate.keys[1])
    expect(current.ctx.sim.state.knobs.timeScale).toBe(DEFAULT_KNOBS.timeScale)

    let tourStarts = 0
    current.ctx.bus.on('tour:start', () => { tourStarts += 1 })
    press(instruction(APP_KEYS, 'tour').keys[0])
    expect(tourStarts).toBe(1)

    current.ctx.sim.setKnob('tps', 999)
    press(instruction(APP_KEYS, 'reset').keys[0])
    expect(current.ctx.sim.state.knobs.tps).toBe(DEFAULT_KNOBS.tps)
  })

  it('drives every documented camera-mode and framing key', () => {
    const current = fixture(true)
    const modes: CameraMode[] = []
    const focuses: (string | null)[] = []
    const presets: ('plan' | null)[] = []
    current.ctx.bus.on('camera:mode', ({ mode }) => modes.push(mode))
    current.ctx.bus.on('focus', ({ id }) => focuses.push(id))
    current.ctx.bus.on('camera:preset', ({ preset }) => presets.push(preset))

    press(instruction(APP_KEYS, 'fly').keys[0])
    expect(modes.at(-1)).toBe('fly')
    current.ctx.bus.emit('camera:mode', { mode: 'orbit' })
    press(instruction(APP_KEYS, 'walk').keys[0])
    expect(modes.at(-1)).toBe('walk')
    current.ctx.bus.emit('camera:mode', { mode: 'orbit' })
    press(instruction(APP_KEYS, 'home').keys[0])
    expect(focuses.at(-1)).toBe('world.ground')
    press(instruction(APP_KEYS, 'overview').keys[0])
    expect(presets.at(-1)).toBe('plan')
    press(instruction(APP_KEYS, 'default-home').keys[0])
    expect(presets.at(-1)).toBeNull()
  })

  it('drives trace, palette, help, labels, theme, sound, and Escape', () => {
    const current = fixture()
    let traces = 0
    current.ctx.bus.on('trace:open', () => { traces += 1 })
    press(instruction(APP_KEYS, 'trace').keys[0])
    expect(traces).toBe(1)

    let palettes = 0
    ;(current.ctx.bus as unknown as { on(type: string, fn: () => void): () => void })
      .on('ui:palette', () => { palettes += 1 })
    const palette = instruction(APP_KEYS, 'palette')
    press(palette.keys[0])
    expect(palettes).toBe(1)
    expect(document.body.classList.contains('pg-palette-open')).toBe(true)
    press('Esc')
    press(palette.keys[1], { ctrlKey: true, metaKey: false })
    expect(document.body.classList.contains('pg-palette-open')).toBe(true)
    press('Esc')
    press(palette.keys[1], { ctrlKey: false, metaKey: true })
    expect(document.body.classList.contains('pg-palette-open')).toBe(true)
    press('Esc')

    const help = document.getElementById('help-overlay')!
    press(instruction(APP_KEYS, 'help').keys[0])
    expect(help.hidden).toBe(false)
    press(instruction(APP_KEYS, 'escape').keys[0])
    expect(help.hidden).toBe(true)

    press(instruction(APP_KEYS, 'labels').keys[0])
    expect(document.body.classList.contains('pg-labels-off')).toBe(true)

    const beforeTheme = themeMode()
    press(instruction(APP_KEYS, 'theme').keys[0])
    expect(themeMode()).not.toBe(beforeTheme)

    let audioToggles = 0
    current.ctx.bus.on('audio:toggle', () => { audioToggles += 1 })
    press(instruction(APP_KEYS, 'sound').keys[0])
    expect(audioToggles).toBe(1)
  })

  it('drives every district number printed as the documented range', () => {
    const current = fixture()
    const focused: (string | null)[] = []
    current.ctx.bus.on('focus', ({ id }) => focused.push(id))
    const range = instruction(APP_KEYS, 'districts').keys
    expect(range).toEqual(['1', '…', '8'])
    for (let index = 0; index < DESTINATIONS.length; index += 1) {
      press(String(index + 1))
      expect(focused.at(-1)).toBe(DESTINATIONS[index].id)
    }
  })

  it('drives the printed touch-equivalent Walk button', () => {
    const current = fixture()
    const modes: CameraMode[] = []
    current.ctx.bus.on('camera:mode', ({ mode }) => modes.push(mode))
    expect(instruction(APP_KEYS, 'walk-button').keys).toEqual(['Walk button'])
    document.querySelector<HTMLButtonElement>('.hud-walk')!.click()
    expect(modes.at(-1)).toBe('walk')
  })
})

describe('documented map-camera instructions', () => {
  it('keeps every printed camera action in the executable map', () => {
    expect(CAMERA_KEYS.map((row) => row.id)).toEqual([
      'pan',
      'orbit',
      'context-menu',
      'wheel',
      'touch-pan',
      'touch-orbit',
      'touch-move',
      'touch-look',
      'touch-vertical',
      'click',
      'move',
      'rise',
      'operate',
      'descend',
      'boost',
      'precision',
      'altitude',
      'pointer-lock-exit',
    ])
  })

  it('drives the printed pan gesture', () => {
    const current = fixture(true)
    const before = current.cameraRig!.pivot.clone()
    drag(current.cameraSurface!, instruction(CAMERA_KEYS, 'pan').keys[0])
    current.cameraRig!.update(1 / 60)
    expect(current.cameraRig!.pivot.distanceTo(before)).toBeGreaterThan(0.1)
  })

  it('drives the printed orbit gesture', () => {
    const current = fixture(true)
    const before = current.camera!.quaternion.clone()
    drag(current.cameraSurface!, instruction(CAMERA_KEYS, 'orbit').keys[0])
    current.cameraRig!.update(1 / 60)
    expect(current.camera!.quaternion.angleTo(before)).toBeGreaterThan(0.01)
  })

  it.each(['W', 'A', 'S', 'D', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'])(
    'moves the real orbit camera with documented key %s',
    (key) => {
      const current = fixture(true)
      const before = current.cameraRig!.pivot.clone()
      press(key)
      current.cameraRig!.update(0.1)
      release(key)
      expect(current.cameraRig!.pivot.distanceTo(before)).toBeGreaterThan(0.01)
    },
  )

  it.each([
    ['PgUp', 1],
    ['PgDn', -1],
  ] as const)('changes orbit altitude with documented key %s', (key, direction) => {
    const current = fixture(true)
    const before = current.cameraRig!.pivot.y
    press(key)
    current.cameraRig!.update(0.1)
    release(key)
    expect(Math.sign(current.cameraRig!.pivot.y - before)).toBe(direction)
  })

  it.each([
    ['Space', 1],
    ['E', 1],
    ['C', -1],
    ['Q', -1],
  ] as const)('changes fly altitude with documented key %s', (key, direction) => {
    const current = fixture(true)
    current.cameraRig!.setMode('fly')
    const before = current.camera!.position.y
    press(key)
    current.cameraRig!.update(0.1)
    release(key)
    expect(Math.sign(current.camera!.position.y - before)).toBe(direction)
  })

  it('drives the documented wheel behavior in orbit and fly modes', () => {
    const current = fixture(true)
    const wheel = new Event('wheel', { cancelable: true })
    Object.defineProperties(wheel, {
      deltaY: { value: -100 },
      deltaMode: { value: 0 },
      clientX: { value: 400 },
      clientY: { value: 300 },
    })
    const beforeDistance = current.camera!.position.distanceTo(current.cameraRig!.pivot)
    current.cameraSurface!.dispatchEvent(wheel)
    current.cameraRig!.update(0.1)
    expect(current.camera!.position.distanceTo(current.cameraRig!.pivot)).toBeLessThan(beforeDistance)

    current.cameraRig!.setMode('fly')
    const beforeSpeed = current.cameraRig!.speed
    current.cameraSurface!.dispatchEvent(wheel)
    expect(current.cameraRig!.speed).toBeGreaterThan(beforeSpeed)
  })

  it('keeps the documented context-menu gesture out of camera movement', () => {
    const current = fixture(true)
    const before = current.camera!.quaternion.clone()
    const menu = new Event('contextmenu', { cancelable: true })
    current.cameraSurface!.dispatchEvent(menu)
    current.cameraRig!.update(0.1)
    expect(menu.defaultPrevented).toBe(true)
    expect(current.camera!.quaternion.angleTo(before)).toBeLessThan(1e-6)
  })
})

describe('README control-surface instructions', () => {
  const readme = readFileSync(
    fileURLToPath(new URL('../README.md', import.meta.url)),
    'utf8',
  )

  it('renders a working control for every model knob', () => {
    fixture()
    expect(KNOB_META.map((meta) => String(meta.key)).sort())
      .toEqual(Object.keys(DEFAULT_KNOBS).sort())
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[data-knob]'))
        .map((node) => node.dataset.knob)
        .sort(),
    ).toEqual(Object.keys(DEFAULT_KNOBS).sort())
  })

  it.each([
    ['cache-thrash', 'Cache thrash'],
    ['checkpoint-storm', 'Checkpoint storm'],
  ])('runs the documented %s scenario from its real button', (id, label) => {
    const current = fixture()
    expect(readme).toContain(`**${label}**`)
    document.querySelector<HTMLButtonElement>(`[data-scenario="${id}"]`)!.click()
    expect(current.ctx.sim.state.scenario).toBe(id)
  })

  it.each([
    ['longRunningXact', true, 'Long-running transaction'],
    ['synchronousCommit', 'off', '`synchronous_commit`'],
    ['standbyASlowApply', true, 'Slow replay'],
  ] as const)('changes documented control %s through the rendered input', (key, value, label) => {
    const current = fixture()
    expect(readme).toContain(label)
    const root = document.querySelector<HTMLElement>(`[data-knob="${key}"]`)
    expect(root, `rendered control for ${key}`).not.toBeNull()
    const input = root!.querySelector<HTMLInputElement>('input')
      ?? root!.querySelector<HTMLSelectElement>('select')
    expect(input, `rendered input for ${key}`).not.toBeNull()
    if (input instanceof HTMLInputElement && input.type === 'checkbox') {
      input.checked = Boolean(value)
    } else {
      input.value = String(value)
    }
    input.dispatchEvent(new Event('input'))
    expect(current.ctx.sim.state.knobs[key]).toBe(value)
  })
})

describe('README keyboard table', () => {
  it('contains every key instruction exercised from the in-app map', () => {
    const readme = readFileSync(
      fileURLToPath(new URL('../README.md', import.meta.url)),
      'utf8',
    )
    const keyTable = readme.slice(readme.indexOf('### Keys'), readme.indexOf('\n---', readme.indexOf('### Keys')))
    for (const row of APP_KEYS) {
      if (row.id === 'walk-button') continue
      for (const key of row.keys) {
        if (key === '…') continue
        expect(keyTable, `README key table documents ${row.id}: ${key}`).toContain(`\`${key}\``)
      }
    }
  })
})
