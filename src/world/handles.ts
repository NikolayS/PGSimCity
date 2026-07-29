import * as THREE from 'three'

import { COLOR } from '../core/theme'
import type { Knobs, SimState, WorldContext, WorldModule } from '../core/types'
import { ANCHOR } from './layout'

export type WorldHandleKey =
  | 'autovacuum'
  | 'bgwriterEnabled'
  | 'fullPageWrites'

export interface WorldHandleBinding {
  id: string
  key: WorldHandleKey
  /** PostgreSQL spelling shown in the walk-up prompt. */
  guc: string
  owner: string
  /** Ground-plane interaction point; proximity checks intentionally ignore Y. */
  x: number
  z: number
}

export interface WorldHandlesModule extends WorldModule {
  readonly handles: readonly WorldHandleBinding[]
}

interface HandleSpec {
  id: string
  key: WorldHandleKey
  guc: string
  owner: string
  at: readonly [number, number, number]
  yaw: number
  color: number
}

interface HandleVisual {
  key: WorldHandleKey
  lever: THREE.Group
  onLamp: THREE.Object3D
  offLamp: THREE.Object3D
  onText: THREE.Object3D
  offText: THREE.Object3D
}

const SPECS: readonly HandleSpec[] = [
  {
    id: 'handle.autovacuum',
    key: 'autovacuum',
    guc: 'autovacuum',
    owner: 'autovacuum launcher',
    at: ANCHOR.handleAutovacuum,
    yaw: Math.PI / 2,
    color: COLOR.vacuum,
  },
  {
    id: 'handle.bgwriter',
    key: 'bgwriterEnabled',
    guc: 'bgwriter_lru_maxpages > 0',
    owner: 'background writer',
    at: ANCHOR.handleBgwriter,
    yaw: 0,
    color: COLOR.bgwriter,
  },
  {
    id: 'handle.full-page-writes',
    key: 'fullPageWrites',
    guc: 'full_page_writes',
    owner: 'WAL write / flush station',
    at: ANCHOR.handleFullPageWrites,
    yaw: 0,
    color: COLOR.wal,
  },
] as const

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`
}

function boolKnob(state: SimState, key: WorldHandleKey): boolean {
  return state.knobs[key] as Knobs[WorldHandleKey] as boolean
}

export function createWorldHandles(ctx: WorldContext): WorldHandlesModule {
  const group = new THREE.Group()
  group.name = 'world.handles'

  const structure = ctx.theme.mat('world.handle.case', {
    color: COLOR.inkDim,
    roughness: 0.84,
    metalness: 0.16,
    surface: false,
  })
  const hardware = ctx.theme.mat('world.handle.hardware', {
    color: COLOR.ink,
    roughness: 0.42,
    metalness: 0.72,
    surface: false,
  })
  const plateGeo = new THREE.PlaneGeometry(1, 1)
  const knobGeo = new THREE.SphereGeometry(0.34, 12, 8)
  const labelMaterials: THREE.MeshBasicMaterial[] = []
  const visuals: HandleVisual[] = []
  const handles: WorldHandleBinding[] = []

  function label(
    parent: THREE.Object3D,
    text: string,
    y: number,
    width: number,
    height: number,
    color: number,
    size: number,
  ): THREE.Mesh {
    const texture = ctx.theme.textTexture(text, {
      size,
      color: cssColor(color),
      bg: '#07101c',
      padding: size * 0.34,
      letterSpacing: '0.04em',
    })
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    labelMaterials.push(material)
    const mesh = new THREE.Mesh(plateGeo, material)
    mesh.position.set(0, y, 0.43)
    mesh.scale.set(width, height, 1)
    mesh.renderOrder = 3
    mesh.raycast = () => {}
    parent.add(mesh)
    return mesh
  }

  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i]
    const root = new THREE.Group()
    root.name = spec.id
    root.position.set(spec.at[0], spec.at[1], spec.at[2])
    root.rotation.y = spec.yaw
    group.add(root)

    const plinth = new THREE.Mesh(ctx.theme.box(6.2, 0.5, 2.8), structure)
    plinth.position.set(0, 0.25, 0)
    root.add(plinth)

    const cabinet = new THREE.Mesh(ctx.theme.box(5.3, 5.8, 0.7), structure)
    cabinet.position.set(0, 3.25, 0)
    root.add(cabinet)

    const crown = new THREE.Mesh(ctx.theme.box(5.8, 0.34, 1.0), hardware)
    crown.position.set(0, 6.25, 0)
    root.add(crown)

    const trim = new THREE.Mesh(ctx.theme.box(4.8, 0.16, 0.12), ctx.theme.neon(spec.color, 0.92))
    trim.position.set(0, 5.72, 0.43)
    root.add(trim)

    label(root, spec.guc, 5.28, 4.65, 0.72, spec.color, 42)
    const onText = label(root, 'ON', 4.25, 1.6, 0.64, spec.color, 46)
    const offText = label(root, 'OFF', 4.25, 1.6, 0.64, COLOR.crit, 46)
    label(root, 'WALK UP · E / TAP', 0.94, 4.4, 0.54, COLOR.ink, 30)

    const onLamp = new THREE.Mesh(ctx.theme.box(0.76, 0.76, 0.32), ctx.theme.neon(spec.color, 1.9))
    onLamp.position.set(-1.6, 4.24, 0.56)
    root.add(onLamp)
    const offLamp = new THREE.Mesh(ctx.theme.box(0.76, 0.76, 0.32), ctx.theme.neon(COLOR.crit, 1.9))
    offLamp.position.set(1.6, 4.24, 0.56)
    root.add(offLamp)

    const pivot = new THREE.Group()
    pivot.name = `${spec.id}.lever`
    pivot.position.set(0, 1.75, 0.65)
    root.add(pivot)
    const axle = new THREE.Mesh(ctx.theme.cyl(0.5, 0.5, 0.48, 16), hardware)
    axle.rotation.x = Math.PI / 2
    pivot.add(axle)
    const arm = new THREE.Mesh(ctx.theme.cyl(0.16, 0.2, 2.2, 10), hardware)
    arm.position.y = 1.08
    pivot.add(arm)
    const knob = new THREE.Mesh(knobGeo, ctx.theme.neon(spec.color, 1.45))
    knob.position.y = 2.24
    pivot.add(knob)

    handles.push({
      id: spec.id,
      key: spec.key,
      guc: spec.guc,
      owner: spec.owner,
      x: spec.at[0],
      z: spec.at[2],
    })
    visuals.push({
      key: spec.key,
      lever: pivot,
      onLamp,
      offLamp,
      onText,
      offText,
    })
  }

  function update(_dt: number, state: SimState): void {
    for (let i = 0; i < visuals.length; i++) {
      const visual = visuals[i]
      const on = boolKnob(state, visual.key)
      visual.lever.rotation.z = on ? -0.62 : 0.62
      visual.onLamp.visible = on
      visual.offLamp.visible = !on
      visual.onText.visible = on
      visual.offText.visible = !on
    }
  }

  /* Initialise before the first rendered frame, including a restored/scenario
   * value that differs from the default. */
  update(0, ctx.sim)

  function dispose(): void {
    for (let i = 0; i < labelMaterials.length; i++) labelMaterials[i].dispose()
    plateGeo.dispose()
    knobGeo.dispose()
  }

  return { id: 'world.handles', group, handles, update, dispose }
}
