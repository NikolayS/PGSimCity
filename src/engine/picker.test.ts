import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { installTestDom } from '../../test/dom'
import { createBus } from '../core/bus'
import { Registry } from '../core/registry'
import { createTheme } from '../core/theme'
import type { ComponentDef } from '../core/types'
import { createPicker } from './picker'

function registerBox(registry: Registry, id: string, x: number): THREE.Mesh {
  const object = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4))
  object.position.x = x
  object.updateMatrixWorld(true)
  const def: ComponentDef = {
    id,
    name: id,
    role: 'test component',
    kind: 'concept',
    district: 'world',
    object,
    focus: { target: [x, 2, 0], distance: 20 },
    tier: 1,
  }
  registry.register(def)
  return object
}

describe('picker markers by camera mode', () => {
  it('hides only hover while walking and restores orbit hover without a stale frame', () => {
    installTestDom()
    const bus = createBus()
    const registry = new Registry()
    const theme = createTheme()
    const hovered = registerBox(registry, 'hovered', 0)
    const selected = registerBox(registry, 'selected', 10)
    const picker = createPicker({
      dom: document.createElement('canvas'),
      camera: new THREE.PerspectiveCamera(),
      registry,
      bus,
      theme,
    })
    const [selectionMarker, hoverMarker] = picker.group.children

    bus.emit('hover', { id: 'hovered' })
    expect(hoverMarker.visible).toBe(true)
    expect(selectionMarker.visible).toBe(false)

    bus.emit('camera:mode', { mode: 'walk' })
    expect(hoverMarker.visible).toBe(false)

    bus.emit('select', { id: 'selected', source: 'building' })
    expect(selectionMarker.visible).toBe(true)

    bus.emit('hover', { id: null })
    bus.emit('hover', { id: 'hovered' })
    expect(hoverMarker.visible).toBe(false)

    bus.emit('camera:mode', { mode: 'orbit' })
    expect(hoverMarker.visible).toBe(true)
    expect(selectionMarker.visible).toBe(true)

    bus.emit('camera:mode', { mode: 'walk' })
    expect(hoverMarker.visible).toBe(false)

    picker.dispose()
    hovered.geometry.dispose()
    selected.geometry.dispose()
    theme.dispose()
  })
})
