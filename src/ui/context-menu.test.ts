import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createBus } from '../core/bus'
import { Registry } from '../core/registry'
import type { CameraRig } from '../engine/camera'
import type { PickerApi } from '../engine/picker'
import { installTestDom } from '../../test/dom'
import { contextActionIds, contextMenuPosition, createContextMenu } from './context-menu'
import type { UiModule } from './uikit'

describe('component context menu capabilities', () => {
  it('offers only supported actions for a heap file', () => {
    expect(contextActionIds({ id: 'storage.table.accounts' })).toEqual([
      'inspect',
      'fly-to',
      'page-anatomy',
    ])
  })

  it.each([
    ['an index', { id: 'storage.index.accounts_pkey' }, ['inspect', 'fly-to', 'page-anatomy']],
    ['a picked page', { id: 'storage.table.accounts', part: 'page' as const }, ['inspect', 'fly-to', 'page-anatomy']],
    ['the data directory', { id: 'storage.datadir' }, ['inspect', 'fly-to', 'directory-layout']],
    ['an ordinary component', { id: 'checkpointer' }, ['inspect', 'fly-to']],
  ])('matches the capabilities of %s', (_label, hit, expected) => {
    expect(contextActionIds(hit)).toEqual(expected)
  })

  it('offers view actions on empty ground', () => {
    expect(contextActionIds(null)).toEqual([
      'reset-camera',
      'overhead',
      'toggle-theme',
      'toggle-labels',
      'first-person',
    ])
    expect(contextActionIds({ id: 'world.ground' })).toEqual(contextActionIds(null))
  })
})

describe('context menu placement', () => {
  it('flips left and up before it can cross the viewport edges', () => {
    expect(contextMenuPosition(1270, 750, 208, 204, 1280, 760)).toEqual({
      x: 1062,
      y: 546,
    })
  })
})

describe('context menu interaction', () => {
  let menu: UiModule
  let canvas: HTMLElement
  let bus: ReturnType<typeof createBus>
  let picker: Pick<PickerApi, 'pick'>
  let camera: THREE.PerspectiveCamera

  function event(type: string, props: Record<string, unknown>): Event {
    const result = new Event(type, { cancelable: true })
    for (const [key, value] of Object.entries(props)) {
      Object.defineProperty(result, key, { value })
    }
    return result
  }

  beforeEach(() => {
    const testDom = installTestDom()
    testDom.mount('hud')
    canvas = testDom.mount('canvas') as unknown as HTMLElement
    bus = createBus()
    picker = {
      pick: vi.fn((_clientX: number, _clientY: number) => ({
        id: 'storage.table.accounts',
        part: 'page' as const,
      })),
    }
    const registry = new Registry()
    registry.register({
      id: 'storage.table.accounts',
      name: 'accounts',
      role: 'heap file',
      kind: 'storage',
      district: 'storage',
      object: new THREE.Group(),
      focus: { target: [0, 0, 0], distance: 10 },
      tier: 1,
    })
    camera = new THREE.PerspectiveCamera()
    const rig = {
      camera,
      home: vi.fn(),
      plan: vi.fn(),
    } as unknown as CameraRig
    menu = createContextMenu({ dom: canvas, picker, registry, bus, rig })
  })

  afterEach(() => {
    menu.dispose()
    vi.useRealTimers()
  })

  it('opens from a dispatched contextmenu and the HUD button click reaches the inspector', () => {
    const selected = vi.fn()
    bus.on('select', selected)

    canvas.dispatchEvent(event('contextmenu', { clientX: 200, clientY: 180 }))
    const actions = [...document.querySelectorAll<HTMLElement>('[data-context-action]')]
    expect(actions.map((node) => node.dataset.contextAction)).toEqual([
      'inspect',
      'fly-to',
      'page-anatomy',
    ])

    actions[0].dispatchEvent(new Event('click'))
    expect(selected).toHaveBeenCalledWith({ id: 'storage.table.accounts' })
  })

  it('moves focus with arrow keys and activates the focused command with Enter', () => {
    const focused = vi.fn()
    bus.on('focus', focused)
    canvas.dispatchEvent(event('contextmenu', { clientX: 200, clientY: 180 }))
    const root = document.querySelector<HTMLElement>('.pg-context')!

    root.dispatchEvent(event('keydown', { key: 'ArrowDown', shiftKey: false }))
    expect((document.activeElement as HTMLElement).dataset.contextAction).toBe('fly-to')
    root.dispatchEvent(event('keydown', { key: 'Enter', shiftKey: false }))

    expect(focused).toHaveBeenCalledWith({ id: 'storage.table.accounts' })
  })

  it('opens on a stationary long-press but cancels as soon as one-finger pan begins', () => {
    vi.useFakeTimers()
    canvas.dispatchEvent(
      event('pointerdown', {
        pointerType: 'touch',
        pointerId: 7,
        isPrimary: true,
        clientX: 220,
        clientY: 200,
      }),
    )
    canvas.dispatchEvent(event('pointermove', { pointerId: 7, clientX: 232, clientY: 200 }))
    vi.advanceTimersByTime(600)
    expect(document.querySelector<HTMLElement>('.pg-context')!.hidden).toBe(true)

    canvas.dispatchEvent(
      event('pointerdown', {
        pointerType: 'touch',
        pointerId: 8,
        isPrimary: true,
        clientX: 220,
        clientY: 200,
      }),
    )
    vi.advanceTimersByTime(560)
    expect(document.querySelector<HTMLElement>('.pg-context')!.hidden).toBe(false)
  })

  it('dismisses as soon as the camera transform changes', () => {
    canvas.dispatchEvent(event('contextmenu', { clientX: 200, clientY: 180 }))
    const root = document.querySelector<HTMLElement>('.pg-context')!
    expect(root.hidden).toBe(false)

    camera.position.x = 1
    menu.update(1 / 60)

    expect(root.hidden).toBe(true)
  })
})
