import { describe, expect, it, vi } from 'vitest'
import { createBus } from '../src/core/bus'
import type { WalkController } from '../src/engine/walk'
import { createTouchpad } from '../src/ui/touchpad'
import { installTestDom } from './dom'

function fixture() {
  const dom = installTestDom()
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => Object.assign(new EventTarget(), { matches: true }),
  })
  const walk = {
    enabled: true, surface: 'ground',
    setTouchMove: vi.fn(), setTouchJump: vi.fn(),
    setTouchCrouch: vi.fn(), addTouchLook: vi.fn(),
  }
  const pad = createTouchpad({ bus: createBus(), walk: walk as unknown as WalkController })
  pad.update(0)
  const pointer = (selector: string, type: string, id: number, y = 100) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { pointerType: 'touch', pointerId: id, clientX: 100, clientY: y })
    document.querySelector(selector)!.dispatchEvent(event)
  }
  const hold = (id = 1) => {
    pointer('.touchpad__move-zone', 'pointerdown', id)
    pointer('.touchpad__move-zone', 'pointermove', id, 50)
    pointer('.touchpad__look-zone', 'pointerdown', id + 1)
    pointer('.touchpad__jump', 'pointerdown', id + 2)
    pointer('.touchpad__crouch', 'pointerdown', id + 3)
  }
  const pressed = () => ({
    move: document.querySelector<HTMLElement>('.touchpad__stick')!.dataset.active,
    look: document.querySelector('.touchpad__hint--look')!.classList.contains('is-active'),
    jump: document.querySelector('.touchpad__jump')!.classList.contains('is-active'),
    crouch: document.querySelector('.touchpad__crouch')!.classList.contains('is-pressed'),
  })
  return { dom, pad, walk, hold, pressed }
}

describe('touch controls losing focus', () => {
  it.each(['blur', 'hidden'])('clears held controls on %s and accepts a new gesture', (reason) => {
    const { dom, pad, walk, hold, pressed } = fixture()
    hold()
    expect(pressed()).toEqual({ move: 'true', look: true, jump: true, crouch: true })
    if (reason === 'blur') dom.window.dispatchEvent(new Event('blur'))
    else {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    expect(pressed()).toEqual({ move: 'false', look: false, jump: false, crouch: false })
    expect(walk.setTouchMove).toHaveBeenLastCalledWith(0, 0)
    expect(walk.setTouchJump).toHaveBeenLastCalledWith(false)
    expect(walk.setTouchCrouch).toHaveBeenLastCalledWith(false)
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    hold(10)
    expect(pressed()).toEqual({ move: 'true', look: true, jump: true, crouch: true })
    pad.dispose()
    const calls = walk.setTouchMove.mock.calls.length
    dom.window.dispatchEvent(new Event('blur'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(walk.setTouchMove.mock.calls.length).toBe(calls)
  })
})
