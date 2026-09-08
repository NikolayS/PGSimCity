import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import { createSim } from '../sim/model'
import type { FlowRequest, QualitySettings } from '../core/types'
import { createFlows } from './flows'

const preference = vi.hoisted(() => ({ reduced: false }))
vi.mock('../core/util', async (original) => ({ ...await original<typeof import('../core/util')>(), reduceMotion: () => preference.reduced }))
const q: QualitySettings = { level: 'low', pixelRatio: 1, bloom: false, shadows: false, maxParticles: 64, maxLabels: 1, antialias: false }
const disposers: (() => void)[] = []
afterEach(() => { while (disposers.length) disposers.pop()!(); preference.reduced = false })
function fixture() {
  const bus = createBus(), theme = createTheme(), scene = new THREE.Scene()
  const flows = createFlows(scene, bus, q, theme)
  disposers.push(() => { flows.dispose(); theme.dispose() })
  const position = () => {
    const mesh = scene.getObjectByName('flows:packets') as THREE.InstancedMesh
    const matrix = new THREE.Matrix4(); mesh.getMatrixAt(0, matrix)
    return new THREE.Vector3().setFromMatrixPosition(matrix)
  }
  return { bus, flows, position }
}
const event = { route: 'wal.write', kind: 'wal', count: 1, spread: 0, source: 'model' } as FlowRequest

describe('sampled model transport', () => {
  it('marks model emissions so display animation cannot masquerade as observed transport', () => {
    const bus = createBus(), sim = createSim(bus), requests: FlowRequest[] = []
    bus.on('flow', (request) => requests.push(request))
    for (let i = 0; i < 300; i++) sim.update(1 / 30)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((request) => 'source' in request && request.source === 'model')).toBe(true)
  })

  it('renders reduced-motion activity at a stationary route location then expires it', () => {
    preference.reduced = true
    const { flows, position } = fixture()
    flows.emit(event); flows.update(0.1)
    const first = position()
    flows.update(0.2)
    expect(position().distanceTo(first)).toBeLessThan(1e-6)
    expect(flows.active).toBe(1)
    for (let i = 0; i < 12; i++) flows.update(0.2)
    expect(flows.active).toBe(0)
  })

  it('coalesces recent activity, freezes on pause, and clears on a return to motion', () => {
    preference.reduced = true
    const { flows } = fixture()
    flows.emit(event); flows.update(0.1)
    const mesh = flows.group.getObjectByName('flows:packets') as THREE.InstancedMesh
    const before = Array.from(mesh.instanceMatrix.array.slice(0, 16))
    flows.update(0.2)
    expect(Array.from(mesh.instanceMatrix.array.slice(0, 16))).toEqual(before)
    for (let i = 0; i < 8; i++) { flows.update(0.2); flows.emit(event) }
    expect(flows.active).toBe(1)
    for (let i = 0; i < 40; i++) flows.update(0)
    expect(flows.active).toBe(1)
    expect(Array.from(mesh.instanceMatrix.array.slice(0, 16))).toEqual(before)
    preference.reduced = false; flows.update(0)
    expect(flows.active).toBe(0)
  })

  it('applies preference changes immediately and does not invent recent model activity', () => {
    const { flows, position } = fixture()
    flows.emit(event); flows.update(0.1)
    const first = position(); flows.update(0.2)
    expect(position().distanceTo(first)).toBeGreaterThan(0.1)
    preference.reduced = true
    flows.update(0)
    expect(flows.active).toBe(0)
    flows.emit({ route: 'wal.write', kind: 'wal' }); flows.update(0.1)
    expect(flows.active).toBe(0)
    flows.emit(event); flows.update(0.1)
    expect(flows.active).toBe(1)
  })
})
