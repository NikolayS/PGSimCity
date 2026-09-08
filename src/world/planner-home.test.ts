import * as THREE from 'three'
import { expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import { createCameraRig } from '../engine/camera'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createPlanner } from './planner'

vi.mock('./slonik', () => ({ PLAN_UP: [0, 1], sampleOutline: () => [-100, -100, 100, -100, 100, 100, -100, 100] }))

it.each([[false, 'camera'], [true, 'camera'], [true, 'focus'], [true, 'select']] as const)(
  'Home clears %s-visible query lab via %s without a model step', (visible, route) => {
  const dom = installTestDom({ canvas2d: true }).mount('surface') as unknown as HTMLElement
  Object.defineProperties(dom, {
    clientWidth: { value: 1280 }, clientHeight: { value: 900 },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, width: 1280, height: 900 }) },
  })
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1280 / 900, 0.1, 3000)
  const bus = createBus(), sim = createSim(bus), theme = createTheme()
  const rig = createCameraRig(camera, dom, bus)
  const planner = createPlanner({ scene, camera, bus, sim: sim.state, theme,
    quality: { level: 'low', pixelRatio: 1, bloom: false, shadows: false, maxParticles: 64, maxLabels: 1, antialias: false },
    register: () => {}, flow: () => {},
  })
  try {
    bus.emit('focus', { id: 'backend.row', instant: true })
    planner.update(visible ? 0.1 : 0, sim.state, sim.state.t)
    expect(planner.group.visible).toBe(visible)
    const time = sim.state.t
    if (route === 'camera') rig.home(true)
    else if (route === 'focus') bus.emit('focus', { id: 'world.ground' })
    else bus.emit('select', { id: null })
    planner.update(0, sim.state, time)
    expect(planner.group.visible).toBe(false)
    planner.update(0.1, sim.state, time)
    expect(planner.group.visible).toBe(false)
    expect(sim.state.t).toBe(time)
    bus.emit('focus', { id: 'backend.row', instant: true })
    planner.update(0.1, sim.state, time)
    expect(planner.group.visible).toBe(true)
  } finally { planner.dispose?.(); rig.dispose(); theme.dispose() }
})
