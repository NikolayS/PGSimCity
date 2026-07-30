import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import type { WalkController } from '../src/engine/walk'
import {
  createWalkUpInteraction,
  WALK_UP_APPROACH_RADIUS,
  WALK_UP_RADIUS,
  type WalkUpInteractionSite,
} from '../src/ui/walk-up'
import { installTestDom } from './dom'

function walk(position: THREE.Vector3): WalkController {
  return {
    enabled: true,
    position,
  } as unknown as WalkController
}

function keyDown(code: string, repeat = false, target?: EventTarget): Event {
  const event = new Event('keydown', { cancelable: true })
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
    ctrlKey: { value: false },
    metaKey: { value: false },
    altKey: { value: false },
  })
  if (target) Object.defineProperty(event, 'target', { value: target })
  return event
}

function site(
  id: string,
  x: number,
  z: number,
  operate = vi.fn(),
): WalkUpInteractionSite {
  return {
    id,
    x,
    z,
    owner: `${id} owner`,
    subject: `${id} subject`,
    state: () => 'ready',
    action: () => 'OPERATE',
    ariaLabel: () => `Operate ${id}`,
    operate,
  }
}

describe('reusable walk-up interaction', () => {
  it('reveals only the nearest site inside its operating radius', () => {
    installTestDom()
    const position = new THREE.Vector3(30, 0, 30)
    const interaction = createWalkUpInteraction({
      walk: walk(position),
      sites: [site('first', 0, 0), site('second', 5, 0)],
    })
    const root = document.querySelector<HTMLElement>('.walk-up-prompt')!

    interaction.update(0)
    expect(root.hidden).toBe(true)

    position.set(4, 0, 0)
    interaction.update(0)
    expect(root.hidden).toBe(false)
    expect(root.dataset.site).toBe('second')
    expect(root.textContent).toContain('second owner')
    expect(root.textContent).toContain('second subject')
    expect(root.textContent).toContain('OPERATE')

    interaction.dispose()
  })

  it('announces an approaching control before E is in operating range', () => {
    installTestDom()
    const position = new THREE.Vector3(WALK_UP_APPROACH_RADIUS - 1, 0, 0)
    const operate = vi.fn()
    const target = site('lever', 0, 0, operate)
    target.approach = 'Approach the lever'
    target.approachRadius = WALK_UP_APPROACH_RADIUS
    const interaction = createWalkUpInteraction({ walk: walk(position), sites: [target] })
    const root = document.querySelector<HTMLElement>('.walk-up-prompt')!
    const button = root.querySelector<HTMLButtonElement>('.walk-up-prompt__action')!

    interaction.update(0)
    expect(root.hidden).toBe(false)
    expect(root.dataset.range).toBe('approach')
    expect(root.textContent).toContain('Approach the lever')
    expect(button.disabled).toBe(true)

    window.dispatchEvent(keyDown('KeyE'))
    expect(operate).not.toHaveBeenCalled()

    position.set(WALK_UP_RADIUS - 0.1, 0, 0)
    interaction.update(0)
    expect(root.dataset.range).toBe('operate')
    expect(button.disabled).toBe(false)
    expect(root.textContent).toContain('OPERATE')

    interaction.dispose()
  })

  it('owns the E binding and a touch-operable action button', () => {
    installTestDom()
    const operate = vi.fn()
    const interaction = createWalkUpInteraction({
      walk: walk(new THREE.Vector3(1, 0, 0)),
      sites: [site('switch', 0, 0, operate)],
    })
    interaction.update(0)

    const keyboard = keyDown('KeyE')
    window.dispatchEvent(keyboard)
    expect(keyboard.defaultPrevented).toBe(true)
    expect(operate).toHaveBeenCalledTimes(1)

    const button = document.querySelector<HTMLButtonElement>('.walk-up-prompt__action')!
    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Operate switch')
    button.click()
    expect(operate).toHaveBeenCalledTimes(2)

    interaction.dispose()
  })

  it('repaints external state changes without operating through repeats or form fields', () => {
    installTestDom()
    let state = 'closed'
    const operate = vi.fn()
    const target = site('door', 0, 0, operate)
    target.state = () => state
    target.action = (value) => value === 'closed' ? 'OPEN' : 'ENTER'
    target.ariaLabel = (value) => value === 'closed' ? 'Open door' : 'Enter control center'
    const walker = walk(new THREE.Vector3(0, 0, 0))
    const interaction = createWalkUpInteraction({ walk: walker, sites: [target] })
    interaction.update(0)
    const button = document.querySelector<HTMLButtonElement>('.walk-up-prompt__action')!
    expect(button.textContent).toContain('OPEN')

    state = 'open'
    interaction.update(0)
    expect(button.textContent).toContain('ENTER')
    expect(button.getAttribute('aria-label')).toBe('Enter control center')

    window.dispatchEvent(keyDown('KeyE', true))
    const input = document.createElement('input')
    window.dispatchEvent(keyDown('KeyE', false, input))
    expect(operate).not.toHaveBeenCalled()

    Object.defineProperty(walker, 'enabled', { value: false })
    interaction.update(0)
    button.click()
    expect(operate).not.toHaveBeenCalled()

    interaction.dispose()
  })
})
