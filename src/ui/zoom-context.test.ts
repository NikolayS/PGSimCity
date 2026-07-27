import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'

import type { Registry } from '../core/registry'
import type { CameraRig } from '../engine/camera'
import { createZoomContext } from './zoom-context'
import { installTestDom } from '../../test/dom'

describe('close zoom context', () => {
  it('identifies the centre component only at close orbit distance and provides a way home', () => {
    const testDom = installTestDom()
    const canvas = testDom.mount('canvas')
    const host = testDom.mount('hud')
    Object.defineProperties(canvas, {
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
    })

    const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 3000)
    camera.position.set(0, 0, 100)
    const home = vi.fn()
    const rig = {
      camera,
      mode: 'orbit',
      pivot: new THREE.Vector3(),
      home,
    } as unknown as CameraRig
    const picker = {
      pick: vi.fn(() => ({ id: 'shared.buffers' })),
    }
    const registry = {
      get: vi.fn(() => ({
        id: 'shared.buffers',
        name: 'Buffer pool (shared_buffers)',
        role: 'a representative sample of the page cache every backend reads through',
        district: 'shmem',
      })),
    } as unknown as Registry

    const context = createZoomContext({
      dom: canvas as unknown as HTMLElement,
      picker,
      registry,
      rig,
      host: host as unknown as HTMLElement,
    })
    const root = document.querySelector<HTMLElement>('.zoom-context')!

    context.update(0.25)
    expect(root.hidden).toBe(true)
    expect(picker.pick).not.toHaveBeenCalled()

    camera.position.set(0, 0, 32)
    context.update(0.25)
    expect(root.hidden).toBe(false)
    expect(root.textContent).toContain('Buffer pool (shared_buffers)')
    expect(root.textContent).toContain('representative sample of the page cache')
    expect(picker.pick).toHaveBeenCalledWith(400, 300)

    document.querySelector<HTMLButtonElement>('[data-mode-exit="close-zoom"]')!.click()
    expect(root.hidden).toBe(true)
    expect(home).toHaveBeenCalledOnce()

    camera.position.set(0, 0, 100)
    context.update(0.01)
    expect(root.hidden).toBe(true)

    context.dispose()
  })
})
