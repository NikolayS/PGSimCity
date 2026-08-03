import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { createBus } from '../src/core/bus'
import type { CameraMode } from '../src/core/types'
import { createSim } from '../src/sim/model'
import { createCityExit, installCityEscape } from '../src/observability/shell'
import { SCENARIOS } from '../src/sim/scenarios'
import { createAnatomy } from '../src/ui/anatomy'
import { createContextMenu } from '../src/ui/context-menu'
import { createCityWords } from '../src/ui/city-words'
import { createControls } from '../src/ui/controls'
import { createHelp } from '../src/ui/help'
import { createHud } from '../src/ui/hud'
import { ENTERABLE_MODE_IDS } from '../src/ui/mode-exits'
import { createInspector } from '../src/ui/panel'
import { createSearch } from '../src/ui/search'
import { createTour } from '../src/ui/tour'
import { createTouchpad } from '../src/ui/touchpad'
import { createZoomContext } from '../src/ui/zoom-context'
import type { UiContext, UiModule } from '../src/ui/uikit'
import type { WalkController } from '../src/engine/walk'
import { installTestDom } from './dom'

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

describe('enterable mode exits', () => {
  it('keeps a DOM exit control for every declared mode', () => {
    const dom = installTestDom()
    for (const id of [
      'hud',
      'hud-top',
      'hud-bottom',
      'toast-stack',
      'compass',
      'help-overlay',
      'tour-layer',
    ]) {
      dom.mount(id)
    }

    const canvas = dom.mount('canvas')
    const ctx = context()
    const camera = {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    }
    const modules: UiModule[] = [
      createHud(ctx),
      createHelp(ctx),
      createTour(ctx),
      createSearch(ctx),
      createCityWords(ctx),
      createAnatomy(ctx),
      createContextMenu({
        dom: canvas as unknown as HTMLElement,
        picker: { pick: () => null },
        registry: ctx.registry,
        bus: ctx.bus,
        rig: {
          camera,
          home: () => {},
          plan: () => {},
        } as unknown as Parameters<typeof createContextMenu>[0]['rig'],
      }),
      createZoomContext({
        dom: canvas as unknown as HTMLElement,
        picker: { pick: () => null },
        registry: ctx.registry,
        rig: {
          camera,
          mode: 'orbit',
          pivot: { x: 0, y: 0, z: 0 },
          home: () => {},
        } as unknown as Parameters<typeof createZoomContext>[0]['rig'],
      }),
    ]
    document.body.append(createCityExit())

    const contextEvent = new Event('contextmenu', { cancelable: true })
    Object.defineProperties(contextEvent, {
      clientX: { value: 80 },
      clientY: { value: 80 },
    })
    canvas.dispatchEvent(contextEvent)

    const exits = Array.from(document.querySelectorAll<HTMLElement>('[data-mode-exit]'))
      .flatMap((node) => node.dataset.modeExit?.split(/\s+/) ?? [])
    const machine = readFileSync(
      fileURLToPath(new URL('../machine/index.html', import.meta.url)),
      'utf8',
    )
    const machineExit = machine.match(/data-mode-exit="([^"]+)"/)?.[1]
    expect(machineExit).toBeTruthy()
    exits.push(...(machineExit?.split(/\s+/) ?? []))
    exits.sort()

    expect([...new Set(exits)].sort()).toEqual([...ENTERABLE_MODE_IDS].sort())
    for (const node of document.querySelectorAll<HTMLElement>('[data-mode-exit]')) {
      expect(['A', 'BUTTON']).toContain(node.tagName.toUpperCase())
    }

    for (const module of modules.reverse()) module.dispose()
  })

  it('makes the Diagnose exit labelled and binds Escape to the same route', () => {
    installTestDom()
    const exit = createCityExit()
    const navigate = vi.fn()
    const disposeEscape = installCityEscape(navigate)

    expect(exit.textContent).toContain('Back to city')
    expect(exit.getAttribute('href')).toBe('../')

    const escape = new Event('keydown', { cancelable: true })
    Object.defineProperty(escape, 'key', { value: 'Escape' })
    window.dispatchEvent(escape)
    expect(navigate).toHaveBeenCalledOnce()
    expect(escape.defaultPrevented).toBe(true)

    const machine = readFileSync(
      fileURLToPath(new URL('../machine/index.html', import.meta.url)),
      'utf8',
    )
    expect(machine).toMatch(/href="\.\.\/"[^>]*data-mode-exit="machine-room"/)
    expect(machine).toContain('Back to city')

    disposeEscape()
  })

  it('labels and activates camera and scenario exits as their modes start', () => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
    const ctx = context()
    const modes: CameraMode[] = []
    const focuses: (string | null)[] = []
    ctx.bus.on('camera:mode', ({ mode }) => modes.push(mode))
    ctx.bus.on('focus', ({ id }) => focuses.push(id))
    const hud = createHud(ctx)

    const view = document.querySelector<HTMLButtonElement>('.hud-view-toggle')!
    ctx.bus.emit('camera:mode', { mode: 'fly' })
    expect(view.textContent).toContain('Exit fly')
    view.click()
    expect(modes.at(-1)).toBe('orbit')

    ctx.bus.emit('camera:preset', { preset: 'plan' })
    expect(view.textContent).toContain('Exit overview')
    view.click()
    expect(focuses.at(-1)).toBe('world.ground')

    const walk = document.querySelector<HTMLButtonElement>('.hud-walk')!
    ctx.bus.emit('camera:mode', { mode: 'walk' })
    expect(walk.textContent).toContain('Exit')
    expect(document.body.classList.contains('pg-walk')).toBe(true)
    walk.click()
    expect(modes.at(-1)).toBe('orbit')
    ctx.bus.emit('camera:mode', { mode: 'orbit' })
    expect(document.body.classList.contains('pg-walk')).toBe(false)

    const scenario = SCENARIOS[0]
    const stop = document.querySelector<HTMLButtonElement>('button.hud-now')!
    ctx.sim.runScenario(scenario.id)
    expect(stop.disabled).toBe(false)
    expect(stop.textContent).toContain('Stop')
    stop.click()
    expect(ctx.sim.state.scenario).toBeNull()

    ctx.sim.runScenario(scenario.id)
    const phoneStop = document.querySelector<HTMLButtonElement>('.hud-scn__toggle')!
    expect(phoneStop.textContent).toContain('Stop scenario')
    phoneStop.click()
    expect(ctx.sim.state.scenario).toBeNull()

    hud.dispose()
  })

  it('closes each overlay through its rendered button', () => {
    const dom = installTestDom()
    for (const id of [
      'hud-top',
      'hud-bottom',
      'toast-stack',
      'compass',
      'help-overlay',
      'tour-layer',
    ]) {
      dom.mount(id)
    }
    const ctx = context()
    const help = createHelp(ctx)
    const search = createSearch(ctx)
    const cityWords = createCityWords(ctx)
    const tour = createTour(ctx)
    const anatomy = createAnatomy(ctx)
    const loose = ctx.bus as unknown as {
      emit(type: string, payload: unknown): void
    }

    loose.emit('ui:help', { open: true })
    const helpRoot = document.querySelector<HTMLElement>('.help-overlay')!
    expect(helpRoot.hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-mode-exit="help"]')!.click()
    expect(helpRoot.hidden).toBe(true)

    loose.emit('ui:palette', { open: true })
    const palette = document.querySelector<HTMLElement>('.pal-overlay')!
    expect(palette.hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-mode-exit="command-palette"]')!.click()
    expect(palette.hidden).toBe(true)

    ctx.bus.emit('ui:city-words', { open: true })
    const cityWordsRoot = document.querySelector<HTMLElement>('.city-words')!
    expect(cityWordsRoot.hidden).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-mode-exit="city-in-words"]')!.click()
    expect(cityWordsRoot.hidden).toBe(true)

    ctx.bus.emit('tour:start', {})
    expect(document.body.classList.contains('pg-tour')).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-mode-exit="guided-tour"]')!.click()
    expect(document.body.classList.contains('pg-tour')).toBe(false)

    ctx.bus.emit('anatomy:open', { view: 'page' })
    const anatomyRoot = document.querySelector<HTMLElement>('.an-overlay')!
    expect(anatomyRoot.hidden).toBe(false)
    const anatomyExit = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mode-exit]'))
      .find((node) => node.dataset.modeExit?.split(/\s+/).includes('anatomy-page'))
    anatomyExit!.click()
    expect(anatomyRoot.hidden).toBe(true)

    anatomy.dispose()
    cityWords.dispose()
    tour.dispose()
    search.dispose()
    help.dispose()
  })

  it('keeps the touch walk and swim exit active when the HUD is hidden', () => {
    const dom = installTestDom()
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => Object.assign(new EventTarget(), { matches: true }),
    })
    const bus = createBus()
    const modes: CameraMode[] = []
    bus.on('camera:mode', ({ mode }) => modes.push(mode))
    const walk = {
      enabled: true,
      surface: 'water',
      setTouchMove: () => {},
      setTouchJump: () => {},
      setTouchCrouch: () => {},
      addTouchLook: () => {},
    } as unknown as WalkController
    const touchpad = createTouchpad({ bus, walk })

    touchpad.update(0)
    const exit = document.querySelector<HTMLButtonElement>('.touchpad__exit')!
    expect(document.querySelector<HTMLElement>('.touchpad')!.dataset.enabled).toBe('true')
    expect(exit.textContent).toContain('Exit walk')
    exit.click()
    expect(modes.at(-1)).toBe('orbit')

    touchpad.dispose()
  })

  it.each([
    ['panel', false],
    ['drawer', true],
  ])('suppresses the close-zoom affordance while a %s is open', (_surface, compact) => {
    const dom = installTestDom()
    Object.defineProperty(dom.window, 'matchMedia', {
      value: () => Object.assign(new EventTarget(), { matches: compact }),
    })
    const canvas = dom.mount('canvas')
    const host = dom.mount('hud')
    dom.mount('hud-left')
    dom.mount('hud-right')
    Object.defineProperties(canvas, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    })

    const ctx = context()
    const def = {
      id: 'shared.buffers',
      name: 'Buffer pool (shared_buffers)',
      role: 'a representative sample of the page cache every backend reads through',
      district: 'shmem',
      kind: 'memory',
      color: 0x7b6cff,
    }
    ctx.registry = {
      all: () => [def],
      get: () => def,
    } as unknown as UiContext['registry']

    const camera = {
      position: { x: 0, y: 0, z: 32 },
    }
    const zoom = createZoomContext({
      dom: canvas as unknown as HTMLElement,
      picker: { pick: () => ({ id: def.id }) },
      registry: ctx.registry,
      rig: {
        camera,
        mode: 'orbit',
        pivot: { x: 0, y: 0, z: 0 },
        home: () => {},
      } as unknown as Parameters<typeof createZoomContext>[0]['rig'],
      host: host as unknown as HTMLElement,
    })
    const controls = createControls(ctx)
    const inspector = createInspector(ctx)
    const root = document.querySelector<HTMLElement>('.zoom-context')!

    zoom.update(0.25)
    expect(root.hidden).toBe(false)
    expect(root.querySelector('[data-mode-exit="close-zoom"]')).not.toBeNull()

    ctx.bus.emit('select', { id: def.id })
    expect(document.querySelector('.pgc-host--right')?.classList.contains('is-open')).toBe(true)
    expect(root.hidden).toBe(true)

    ctx.bus.emit('select', { id: null })
    expect(root.hidden).toBe(false)

    document.querySelector<HTMLButtonElement>('.pgc-tab--left')!.click()
    expect(root.hidden).toBe(true)
    document.querySelector<HTMLButtonElement>('.pgc-tab--left')!.click()
    expect(root.hidden).toBe(false)

    inspector.dispose()
    controls.dispose()
    zoom.dispose()
  })
})
