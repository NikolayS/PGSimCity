import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type {
  ComponentDef,
  PoolMode,
  QualityLevel,
  SimState,
  WorldContext,
  WorldModule,
} from '../core/types'
import { createSim } from '../sim/model'
import { DOCS_MEMORY } from '../ui/docs-memory'
import { installTestDom } from '../../test/dom'
import { createClients } from './clients'
import { ANCHOR, CONDUIT } from './layout'

interface PoolerFixture {
  components: Map<string, ComponentDef>
  module: WorldModule
  state: SimState
}

const disposers: (() => void)[] = []
const matrix = new THREE.Matrix4()
const position = new THREE.Vector3()
const rotation = new THREE.Quaternion()
const scale = new THREE.Vector3()
const color = new THREE.Color()

afterEach(() => {
  while (disposers.length) disposers.pop()!()
})

function fixture(level: QualityLevel = 'high'): PoolerFixture {
  installTestDom({ canvas2d: true })
  const bus = createBus()
  const sim = createSim(bus)
  const theme = createTheme()
  const components = new Map<string, ComponentDef>()
  const ctx: WorldContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    bus,
    sim: sim.state,
    quality: {
      level,
      pixelRatio: 1,
      bloom: level !== 'low',
      shadows: level !== 'low',
      maxParticles: 1,
      maxLabels: 1,
      antialias: level !== 'low',
    },
    register: (component) => components.set(component.id, component),
    flow: () => undefined,
    theme,
  }
  const module = createClients(ctx)
  disposers.push(() => {
    module.dispose?.()
    theme.dispose()
  })
  return { components, module, state: sim.state }
}

function stage(
  target: PoolerFixture,
  mode: PoolMode,
  acceptedClients = 96,
  serverConnections = 8,
  serverCapacity = 8,
): void {
  target.state.pooler.mode = mode
  target.state.pooler.acceptedClients = acceptedClients
  target.state.pooler.clientConnections = acceptedClients
  target.state.pooler.serverConnections = serverConnections
  target.state.pooler.serverCapacity = serverCapacity
  target.state.pooler.waitingClients = Math.max(0, acceptedClients - serverConnections)
  target.state.stats.activeBackends = serverConnections
  target.module.update(1 / 60, target.state, 4.25)
}

function mesh(target: PoolerFixture, name: string): THREE.InstancedMesh {
  const object = target.module.group.getObjectByName(name)
  expect(object, `missing rendered pooler object ${name}`).toBeInstanceOf(THREE.InstancedMesh)
  return object as THREE.InstancedMesh
}

function instanceWidth(object: THREE.InstancedMesh): number {
  object.getMatrixAt(0, matrix)
  matrix.decompose(position, rotation, scale)
  return scale.x
}

function renderSignature(target: PoolerFixture): string {
  const names = [
    'pooler.client-band',
    'pooler.server-band',
    'pooler.direct-paths',
    'pooler.server-paths',
    'pooler.release-markers',
  ]
  const values: string[] = []
  for (const name of names) {
    const object = mesh(target, name)
    values.push(name, String(object.visible), String(object.count))
    for (let index = 0; index < object.count; index++) {
      object.getMatrixAt(index, matrix)
      values.push(...matrix.elements.map((value) => value.toFixed(3)))
      if (object.instanceColor) {
        object.getColorAt(index, color)
        values.push(color.r.toFixed(3), color.g.toFixed(3), color.b.toFixed(3))
      }
    }
  }
  return values.join('|')
}

describe('PgBouncer geometry', () => {
  it('renders four measurably distinct connection and release patterns', () => {
    const signatures = new Map<PoolMode, string>()
    for (const mode of ['disabled', 'session', 'transaction', 'statement'] as const) {
      const target = fixture()
      stage(target, mode)
      signatures.set(mode, renderSignature(target))
    }

    expect(new Set(signatures.values()).size).toBe(4)
    expect(new Set([
      signatures.get('session'),
      signatures.get('transaction'),
      signatures.get('statement'),
    ]).size).toBe(3)
  })

  it('draws the model serverConnections/acceptedClients ratio', () => {
    const target = fixture()
    stage(target, 'transaction', 120, 6, 8)

    const clientWidth = instanceWidth(mesh(target, 'pooler.client-band'))
    const serverWidth = instanceWidth(mesh(target, 'pooler.server-band'))
    const paths = mesh(target, 'pooler.server-paths')

    expect(serverWidth / clientWidth).toBeCloseTo(6 / 120, 6)
    expect(paths.count / Number(paths.userData.segmentsPerConnection)).toBe(6)
  })

  it('keeps the readout and rendered ratio on the same model values', () => {
    const target = fixture()
    stage(target, 'statement', 137, 7, 16)

    const readout = target.components.get('client.pooler')?.readout?.(target.state) ?? ''
    const match = readout.match(/(\d+) clients → (\d+)\/(\d+) PostgreSQL backends/)
    expect(match, `unparseable pooler readout: ${readout}`).not.toBeNull()

    const [, clients, servers, capacity] = match!
    const renderedRatio = instanceWidth(mesh(target, 'pooler.server-band'))
      / instanceWidth(mesh(target, 'pooler.client-band'))
    expect(Number(clients)).toBe(target.state.pooler.acceptedClients)
    expect(Number(servers)).toBe(target.state.pooler.serverConnections)
    expect(Number(capacity)).toBe(target.state.pooler.serverCapacity)
    expect(renderedRatio).toBeCloseTo(Number(servers) / Number(clients), 6)
  })

  it('does not call PostgreSQL backends application client sessions', () => {
    const target = fixture()
    stage(target, 'transaction', 137, 7, 16)

    const readout = target.components.get('client.pool')?.readout?.(target.state) ?? ''
    const doc = DOCS_MEMORY.find((entry) => entry.id === 'client.pool')
    const clients = doc?.metrics?.find((entry) => entry.label === 'Application clients')
    const backends = doc?.metrics?.find((entry) => entry.label === 'PostgreSQL backends')

    expect(readout).toContain('137 application clients')
    expect(readout).toContain('7/16 PostgreSQL backends')
    expect(readout).not.toMatch(/7 open sessions/)
    expect(clients?.get(target.state)).toBe('137 offered · 137 admitted')
    expect(backends?.get(target.state)).toBe('7 / 16 capacity')
  })

  it.each(['low', 'reduced'] as const)('keeps the mechanism visible at %s fidelity', (level) => {
    const target = fixture(level)
    stage(target, 'transaction', 100, 8, 8)
    target.module.setDetail?.(0)

    expect(mesh(target, 'pooler.client-band').visible).toBe(true)
    expect(mesh(target, 'pooler.server-band').visible).toBe(true)
    expect(mesh(target, 'pooler.server-paths').visible).toBe(true)
    expect(Number(mesh(target, 'pooler.server-paths').userData.segmentsPerConnection))
      .toBeGreaterThanOrEqual(1)
  })

  it('places the centralized pooler separately and nearer the server boundary', () => {
    const poolerZ = ANCHOR.pooler[2]
    expect(poolerZ).toBeLessThan(CONDUIT.boundaryZ)
    expect(CONDUIT.boundaryZ - poolerZ)
      .toBeLessThan(poolerZ - ANCHOR.clientTerminal[2])
    expect(Math.abs(poolerZ - ANCHOR.endpoint[2])).toBeGreaterThanOrEqual(10)
  })

  it('keeps pooler traffic out of the HA endpoint clearance', () => {
    const firstSouthZ = ANCHOR.endpoint[2] + 8
    const pooled = fixture()
    stage(pooled, 'transaction', 100, 8, 8)
    pooled.module.group.updateMatrixWorld(true)
    expect(new THREE.Box3().setFromObject(mesh(pooled, 'pooler.client-paths')).min.z)
      .toBeGreaterThanOrEqual(firstSouthZ)

    const direct = fixture()
    stage(direct, 'disabled', 16, 16, 16)
    direct.module.group.updateMatrixWorld(true)
    expect(new THREE.Box3().setFromObject(mesh(direct, 'pooler.direct-paths')).min.z)
      .toBeGreaterThanOrEqual(firstSouthZ)
  })

  it('discloses the depicted topology and legitimate deployment alternatives', () => {
    const doc = DOCS_MEMORY.find((entry) => entry.id === 'client.pooler')
    const topology = doc?.sections.find((section) => section.heading === 'Where this city places PgBouncer')
    const urls = doc?.refs?.docs?.map((ref) => ref.url) ?? []

    expect(topology?.body).toMatch(/centralized, database-facing/i)
    expect(topology?.body).toMatch(/application.*sidecar.*database host/is)
    expect(urls).toContain(
      'https://www.pgbouncer.org/faq.html#should-pgbouncer-be-installed-on-the-web-server-or-database-server',
    )
    expect(urls).toContain(
      'https://learn.microsoft.com/en-us/azure/postgresql/connectivity/concepts-connection-pooling-best-practices',
    )
  })
})
