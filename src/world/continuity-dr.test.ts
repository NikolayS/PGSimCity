import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createTheme } from '../core/theme'
import type { ComponentDef, FlowRequest, QualitySettings, WorldContext } from '../core/types'
import { createSim } from '../sim/model'
import { createContinuity } from './continuity'
import { ANCHOR, CONTINUITY, ROUTES } from './layout'

function fakeCanvas(): HTMLCanvasElement {
  const gradient = { addColorStop: () => undefined }
  let canvas: HTMLCanvasElement
  const context = new Proxy(
    {
      canvas: undefined as unknown,
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: (value: string) => ({ width: value.length * 12 }),
      fillText: (value: string) => {
        canvas.dataset.plateText = value
        canvas.dataset.plateColor = String(context.fillStyle)
      },
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property)
        return () => undefined
      },
      set(target, property, value) {
        Reflect.set(target, property, value)
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D
  canvas = {
    width: 1,
    height: 1,
    style: {},
    dataset: {},
    getContext: (kind: string) => (kind === '2d' ? context : null),
  } as unknown as HTMLCanvasElement
  ;(context as unknown as { canvas: HTMLCanvasElement }).canvas = canvas
  return canvas
}

function plateText(object: THREE.Object3D): string | undefined {
  if (!(object instanceof THREE.Mesh)) return undefined
  const material = Array.isArray(object.material) ? object.material[0] : object.material
  if (!(material instanceof THREE.MeshBasicMaterial)) return undefined
  const image = material.map?.image as HTMLCanvasElement | undefined
  return image?.dataset.plateText
}

describe('continuity and three-node projection', () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  beforeAll(() => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: (tag: string) => {
          if (tag !== 'canvas') throw new Error(`unexpected headless element: ${tag}`)
          return fakeCanvas()
        },
        documentElement: { dataset: {}, style: {} },
      },
    })
  })

  afterAll(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })

  it('projects Patroni leases, a promoted leader, and the visible timeline fork', () => {
    const bus = createBus()
    const flows: FlowRequest[] = []
    bus.on('flow', (request) => flows.push(request))
    const sim = createSim(bus)
    const theme = createTheme()
    const defs: ComponentDef[] = []
    const ctx: WorldContext = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      bus,
      sim: sim.state,
      quality: {
        level: 'low',
        pixelRatio: 1,
        bloom: false,
        shadows: false,
        maxParticles: 64,
        maxLabels: 32,
        antialias: false,
      } satisfies QualitySettings,
      theme,
      register: (def) => defs.push(def),
      flow: (request) => flows.push(request),
    }
    const continuity = createContinuity(ctx)

    expect(defs.map((def) => def.id)).toEqual([
      'archive.gate',
      'timeline.yard',
      'object.store',
      'backup.vault',
      'recovery.ground',
      'recovery.clock',
      'restore.winch',
      'recovery.replay',
      'ha.endpoint',
      'ha.dcs',
      'ha.rejoin',
      'standby.b',
      'standby.b.receiver',
      'standby.b.wal',
      'standby.b.startup',
      'standby.b.buffers',
      'standby.b.storage',
    ])
    expect(
      defs
        .filter((def) => def.id.startsWith('ha.'))
        .every((def) => def.readout !== undefined),
    ).toBe(true)
    expect(
      defs
        .filter((def) => def.id.startsWith('standby.b'))
        .every((def) => def.readout !== undefined),
    ).toBe(true)

    const archiveGate = defs.find((def) => def.id === 'archive.gate')
    expect(archiveGate?.readout?.(sim.state)).toMatch(/primary.*16\.0 MiB.*%.*wal-push/i)
    const backupVault = defs.find((def) => def.id === 'backup.vault')
    expect(backupVault?.readout?.(sim.state)).toMatch(/daily.*standby_a/i)
    const recoveryGround = defs.find((def) => def.id === 'recovery.ground')
    expect(recoveryGround?.readout?.(sim.state)).toMatch(/drill.*not run/i)
    const recoveryPlates: string[] = []
    recoveryGround?.object.traverse((object) => {
      const text = plateText(object)
      if (text) recoveryPlates.push(text)
    })
    expect(recoveryPlates.some((text) => /RESTORE DRILL.*RUN.*MEASURE.*PROVED/i.test(text))).toBe(true)
    expect(recoveryPlates.some((text) => /RTO MEASURED|COST COUNTED/i.test(text))).toBe(false)

    sim.state.disasterRecovery.drill.status = 'passed'
    sim.state.disasterRecovery.restore.status = 'fetching'
    expect(recoveryGround?.readout?.(sim.state)).toMatch(/fetching full backup/i)
    expect(recoveryGround?.readout?.(sim.state)).not.toMatch(/drill PASS/i)
    sim.state.disasterRecovery.restore.status = 'complete'
    expect(recoveryGround?.readout?.(sim.state)).toMatch(/target reached.*not promoted/i)

    const dcs = defs.find((def) => def.id === 'ha.dcs')
    expect(dcs).toBeDefined()
    const focus = dcs!.focus
    const focusDir = new THREE.Vector3(...(focus.dir ?? [0, 0.5, 1])).normalize()
    expect(focus.distance).toBeLessThan(700)
    expect(focusDir.y).toBeGreaterThan(0.25)
    expect(focusDir.y).toBeLessThan(0.75)

    const focusCamera = new THREE.PerspectiveCamera(52, 1400 / 900, 0.5, 4_000)
    focusCamera.position
      .set(...focus.target)
      .addScaledVector(focusDir, focus.distance)
    focusCamera.lookAt(...focus.target)
    focusCamera.updateMatrixWorld()
    for (const member of [ANCHOR.leaseNode1, ANCHOR.leaseNode2, ANCHOR.leaseNode3]) {
      const projected = new THREE.Vector3(...member).project(focusCamera)
      expect(Math.abs(projected.x)).toBeLessThan(0.92)
      expect(Math.abs(projected.y)).toBeLessThan(0.85)
      expect(Math.abs(projected.z)).toBeLessThan(1)
    }
    const platformFrames = [
      [ANCHOR.haPrimarySite, 124, 78],
      [ANCHOR.haStandbyASite, 116, 142],
      [ANCHOR.haStandbyBSite, 116, 142],
    ] as const
    let minFrameX = Infinity
    let maxFrameX = -Infinity
    let minFrameY = Infinity
    let maxFrameY = -Infinity
    for (const [site, width, depth] of platformFrames) {
      for (const dx of [-width / 2, width / 2]) {
        for (const dz of [-depth / 2, depth / 2]) {
          const projected = new THREE.Vector3(site[0] + dx, 0.9, site[2] + dz)
            .project(focusCamera)
          expect(Math.abs(projected.x)).toBeLessThan(0.92)
          expect(Math.abs(projected.y)).toBeLessThan(0.78)
          minFrameX = Math.min(minFrameX, projected.x)
          maxFrameX = Math.max(maxFrameX, projected.x)
          minFrameY = Math.min(minFrameY, projected.y)
          maxFrameY = Math.max(maxFrameY, projected.y)
        }
      }
    }
    expect(maxFrameX - minFrameX).toBeGreaterThan(1.5)
    expect(maxFrameY - minFrameY).toBeGreaterThan(1)

    const plateMeshes = new Map<string, THREE.Mesh[]>()
    dcs!.object.traverse((object) => {
      const text = plateText(object)
      if (!text) return
      const matches = plateMeshes.get(text) ?? []
      matches.push(object as THREE.Mesh)
      plateMeshes.set(text, matches)
    })

    const siteTitles = [
      'FAILURE DOMAIN 1 · PRIMARY NODE',
      'FAILURE DOMAIN 2 · STANDBY_A',
      'FAILURE DOMAIN 3 · STANDBY_B',
    ] as const
    const siteAt = [ANCHOR.haPrimarySite, ANCHOR.haStandbyASite, ANCHOR.haStandbyBSite] as const
    const agentAt = [ANCHOR.patroniNode1, ANCHOR.patroniNode2, ANCHOR.patroniNode3] as const
    const memberAt = [ANCHOR.leaseNode1, ANCHOR.leaseNode2, ANCHOR.leaseNode3] as const
    const platformW = [124, 116, 116] as const
    for (let i = 0; i < siteTitles.length; i++) {
      const title = plateMeshes.get(siteTitles[i])
      expect(title).toHaveLength(1)
      expect(title![0].scale.x).toBeLessThan(platformW[i] - 6)
      expect(Math.abs(title![0].position.x - siteAt[i][0]) + title![0].scale.x / 2)
        .toBeLessThan(platformW[i] / 2)
      const material = title![0].material as THREE.MeshBasicMaterial
      const canvas = material.map!.image as HTMLCanvasElement
      expect(canvas.dataset.plateColor).toBe('#ffffff')
    }
    const primaryTitle = plateMeshes.get(siteTitles[0])![0]
    expect(Math.abs(primaryTitle.position.x - ANCHOR.endpoint[0]) - primaryTitle.scale.x / 2)
      .toBeGreaterThan(15)
    expect(primaryTitle.position.y - primaryTitle.scale.y / 2).toBeGreaterThan(17)

    const siteDescriptions = plateMeshes.get('PostgreSQL · Patroni agent · one etcd member')
    expect(siteDescriptions).toHaveLength(3)
    for (let i = 0; i < siteDescriptions!.length; i++) {
      expect(Math.abs(siteDescriptions![i].position.x - siteAt[i][0]) + siteDescriptions![i].scale.x / 2)
        .toBeLessThan(platformW[i] / 2)
      const material = siteDescriptions![i].material as THREE.MeshBasicMaterial
      const canvas = material.map!.image as HTMLCanvasElement
      expect(canvas.dataset.plateColor).toBe('#ffffff')
    }

    const patroniPlates = plateMeshes.get('PATRONI')
    expect(patroniPlates).toHaveLength(3)
    for (let i = 0; i < patroniPlates!.length; i++) {
      expect(patroniPlates![i].position.z - agentAt[i][2]).toBeGreaterThan(7)
      expect(Math.abs(patroniPlates![i].position.x - agentAt[i][0]) + patroniPlates![i].scale.x / 2)
        .toBeLessThan(7)
    }

    for (let i = 0; i < memberAt.length; i++) {
      const memberPlate = plateMeshes.get(`etcd-${i + 1}`)
      expect(memberPlate).toHaveLength(1)
      expect(memberPlate![0].position.z - memberAt[i][2]).toBeGreaterThan(9.5)
      expect(Math.abs(memberPlate![0].position.x - memberAt[i][0]) + memberPlate![0].scale.x / 2)
        .toBeLessThan(9.5)
    }

    for (const text of [
      'RAFT CONSENSUS',
      'one linearizable leader key · compare-and-swap + lease TTL',
      'majority is the commit mechanism · a minority cannot commit',
    ]) {
      const consensusPlate = plateMeshes.get(text)
      expect(consensusPlate).toHaveLength(1)
      expect(consensusPlate![0].position.y - consensusPlate![0].scale.y / 2)
        .toBeGreaterThan(32)
      if (text !== 'RAFT CONSENSUS') {
        const material = consensusPlate![0].material as THREE.MeshBasicMaterial
        const canvas = material.map!.image as HTMLCanvasElement
        expect(canvas.dataset.plateColor).toBe('#ffffff')
      }
    }
    expect([...plateMeshes.values()].reduce((count, meshes) => count + meshes.length, 0)).toBe(15)
    sim.setKnob('walGArchiveCredentialsValid', false)
    continuity.update(1 / 30, sim.state, sim.state.t)
    expect(defs.find((def) => def.id === 'archive.gate')?.readout?.(sim.state))
      .toContain('credentials expired')
    sim.setKnob('walGArchiveCredentialsValid', true)

    sim.startBaseBackup()
    for (let i = 0; i < 900; i++) {
      sim.update(1 / 30)
      continuity.update(1 / 30, sim.state, sim.state.t)
    }

    expect(flows.some((flow) => flow.route === 'backup.push')).toBe(true)
    expect(flows.some((flow) => flow.route === 'backup.take')).toBe(false)
    expect(flows.some((flow) => flow.route === 'backup.store')).toBe(false)
    expect(continuity.group.getObjectByName('backup.host')).toBeUndefined()
    expect(defs.some((def) => def.id === 'backup.host')).toBe(false)
    expect(ROUTES['backup.take']).toBeUndefined()
    expect(ROUTES['backup.store']).toBeUndefined()
    expect(ROUTES['backup.push'].points.at(-1)).toEqual([
      ANCHOR.backupVault[0],
      6,
      ANCHOR.backupVault[2] + 16,
    ])
    expect(ROUTES['backup.push'].points[0]).toEqual([
      ANCHOR.standby[0] + 16,
      6,
      ANCHOR.standby[2] + 8,
    ])
    expect(ROUTES['archive.ship'].points[0]).toEqual([
      ANCHOR.archiver[0] + 8,
      8,
      ANCHOR.archiver[2] - 4,
    ])
    expect(flows.some((flow) => flow.route === 'net.streamB')).toBe(true)
    expect(flows.some((flow) => flow.route === 'net.ackB')).toBe(true)
    expect(flows.some((flow) => flow.route === 'replicaB.apply')).toBe(true)
    expect(flows.some((flow) => flow.route === 'replicaB.buffer')).toBe(true)
    expect(flows.some((flow) => flow.route === 'replicaB.io')).toBe(true)
    expect(flows.some((flow) => flow.route.startsWith('ha.lease'))).toBe(true)

    const firstBranch = continuity.group.getObjectByName('timeline.branch.0')
    const oldTail = continuity.group.getObjectByName('timeline.old-divergent-tail')
    const forkBeacon = continuity.group.getObjectByName('timeline.fork-beacon')
    const siloCaps = continuity.group.getObjectByName('object.store.caps') as THREE.InstancedMesh
    const syncStandbyA = continuity.group.getObjectByName('sync-standby-name.a')
    const syncStandbyB = continuity.group.getObjectByName('sync-standby-name.b')
    const syncStandbyNone = continuity.group.getObjectByName('sync-standby-name.none')
    expect(firstBranch?.visible).toBe(false)
    expect(oldTail?.visible).toBe(false)
    expect(forkBeacon?.visible).toBe(false)
    expect(syncStandbyA?.visible).toBe(true)
    expect(syncStandbyB?.visible).toBe(false)
    expect(syncStandbyNone?.visible).toBe(false)

    sim.setKnob('synchronousStandbyNames', 'none')
    continuity.update(1 / 30, sim.state, sim.state.t)
    expect(syncStandbyA?.visible).toBe(false)
    expect(syncStandbyB?.visible).toBe(false)
    expect(syncStandbyNone?.visible).toBe(true)
    sim.setKnob('synchronousStandbyNames', 'standbyA')
    continuity.update(1 / 30, sim.state, sim.state.t)

    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('standbyANetworkLag', 400)
    sim.setKnob('walGArchiveCredentialsValid', false)
    const parentFrontierBeforeOutage = sim.state.disasterRecovery.archive.archivedThroughLsn
    for (let i = 0; i < 1_050; i++) sim.update(1 / 30)
    expect(sim.startFailover()).toBe(true)
    for (let i = 0; i < 300; i++) {
      sim.update(1 / 30)
      continuity.update(1 / 30, sim.state, sim.state.t)
      if (sim.state.highAvailability.transition.status === 'complete') break
    }

    expect(sim.state.highAvailability.transition.status).toBe('complete')
    expect(sim.state.highAvailability.timeline.forkLsn).toBeGreaterThan(parentFrontierBeforeOutage)
    expect(firstBranch?.visible).toBe(true)
    expect(oldTail?.visible).toBe(true)
    expect(syncStandbyA?.visible).toBe(false)
    expect(syncStandbyB?.visible).toBe(true)
    expect(defs.find((def) => def.id === 'timeline.yard')?.readout?.(sim.state))
      .toContain('fork')

    const parentGapSegments = Math.min(
      CONTINUITY.silo.cols,
      Math.ceil(
        (sim.state.highAvailability.timeline.forkLsn - parentFrontierBeforeOutage)
          / sim.state.wal.segmentSize,
      ),
    )
    const color = new THREE.Color()
    let litParentSilos = 0
    for (let c = 0; c < CONTINUITY.silo.cols; c++) {
      siloCaps.getColorAt(c, color)
      if (color.getHex() !== 0x0a1120) litParentSilos++
    }
    expect(litParentSilos).toBe(CONTINUITY.silo.cols - parentGapSegments)

    continuity.dispose?.()
    theme.dispose()
  })
})
