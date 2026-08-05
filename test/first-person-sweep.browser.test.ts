import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

interface Finding {
  invariant: string
  station: string
  district: string
  object: string
  position: [number, number, number]
  camera: [number, number, number]
  yaw: number
  detail: string
}

interface Station {
  id: string
  source: 'surface-grid' | 'collider-approach'
  district: string
  feet: [number, number, number]
  camera: [number, number, number]
  yaw: number
  surface: string
}

interface Report {
  stations: Station[]
  surfaceGridStations: number
  colliderApproachStations: number
  traversalSegments: number
  traversalSamples: number
  sceneObjects: number
  meshObjects: number
  meshInstances: number
  textPlanes: number
  colliderBoxes: number
  hands: {
    station: Station
    visibleHands: number
    visibleMeshes: number
    meshInstances: number
  }
  findings: Finding[]
}

async function saveScreenshot(
  send: (method: string, params?: Record<string, unknown>) => Promise<{ data: string }>,
  path: string,
): Promise<void> {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(image.data, 'base64'))
}

describe('live rendered city first-person sweep', () => {
  it('walks production-derived eye-level stations and enforces pedestrian invariants', async () => {
    const artifactDir = process.env.FIRST_PERSON_SWEEP_ARTIFACT_DIR
    const [result] = await inspectRenderedPages([{
      name: 'City first-person sweep',
      path: '/',
      readySelector: '#canvas-root canvas',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 240 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not expose its browser handle')
        window.PGSIMCITY.sim.setKnob('paused', true)
        window.PGSIMCITY.bus.emit('quality', { level: 'high' })
      })()`,
    }], async ({ evaluate, send }) => {
      const report = await evaluate(`(async () => {
        const sweep = await import('/test/first-person-sweep-browser.ts')
        return sweep.runFirstPersonSweep(window.PGSIMCITY)
      })()`) as Report

      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        writeFileSync(join(artifactDir, 'first-person-report.json'), JSON.stringify(report, null, 2))
        if (process.env.FIRST_PERSON_SWEEP_SCREENSHOTS === '1') {
          const worst = report.findings.find((finding) => finding.invariant === 'camera-clearance')
            ?? report.findings[0]
          if (worst) {
            await evaluate(`(async () => {
              const sweep = await import('/test/first-person-sweep-browser.ts')
              await sweep.stageFirstPersonFinding(window.PGSIMCITY, ${JSON.stringify(worst)})
            })()`)
            await saveScreenshot(send, join(artifactDir, 'first-person-worst.png'))
          }
          await evaluate(`(async () => {
            const sweep = await import('/test/first-person-sweep-browser.ts')
            await sweep.stageHandsScreenshot(window.PGSIMCITY, ${JSON.stringify(report.hands.station)})
          })()`)
          await saveScreenshot(send, join(artifactDir, 'first-person-hands.png'))
        }
      }

      const nearPlaneProof = await evaluate(`(async () => {
        const sweep = await import('/test/first-person-sweep-browser.ts')
        return sweep.proveNearPlaneDetection(window.PGSIMCITY)
      })()`) as Finding[]
      return { report, nearPlaneProof }
    }) as [{ report: Report; nearPlaneProof: Finding[] }]

    if (process.env.FIRST_PERSON_SWEEP_REPORT === '1') {
      console.info(JSON.stringify(result, null, 2))
    } else if (process.env.FIRST_PERSON_SWEEP_REPORT === 'summary') {
      console.info(JSON.stringify({
        counts: {
          stations: result.report.stations.length,
          surfaceGridStations: result.report.surfaceGridStations,
          colliderApproachStations: result.report.colliderApproachStations,
          traversalSegments: result.report.traversalSegments,
          traversalSamples: result.report.traversalSamples,
          sceneObjects: result.report.sceneObjects,
          meshObjects: result.report.meshObjects,
          meshInstances: result.report.meshInstances,
          textPlanes: result.report.textPlanes,
          colliderBoxes: result.report.colliderBoxes,
          hands: result.report.hands,
        },
        districts: [...new Set(result.report.stations.map((station) => station.district))],
        findings: result.report.findings,
        nearPlaneProof: result.nearPlaneProof,
      }, null, 2))
    }

    expect(result.report.stations.length).toBeGreaterThan(900)
    expect(result.report.surfaceGridStations).toBeGreaterThan(400)
    expect(result.report.colliderApproachStations).toBeGreaterThan(500)
    expect(result.report.traversalSegments).toBeGreaterThan(400)
    expect(result.report.traversalSamples).toBeGreaterThan(3_000)
    expect(new Set(result.report.stations.map((station) => station.district))).toEqual(new Set([
      'clients',
      'backends',
      'shmem',
      'wal',
      'storage',
      'maintenance',
      'replication',
      'planner',
      'world',
    ]))
    expect(result.report.sceneObjects).toBeGreaterThan(400)
    expect(result.report.meshObjects).toBeGreaterThan(300)
    expect(result.report.meshInstances).toBeGreaterThan(11_000)
    expect(result.report.textPlanes).toBeGreaterThan(100)
    expect(result.report.colliderBoxes).toBeGreaterThan(4_500)
    expect(result.report.hands.visibleHands).toBe(1)
    expect(result.report.hands.visibleMeshes).toBeGreaterThanOrEqual(5)
    expect(result.report.hands.meshInstances).toBeGreaterThanOrEqual(8)
    expect(result.nearPlaneProof).toEqual([
      expect.objectContaining({
        invariant: 'camera-clearance',
        detail: expect.stringContaining('historical 0.500 m near plane'),
      }),
    ])
    expect(result.report.findings).toEqual([])
  /* The shared Chrome semaphore can queue behind two other software-WebGL
   * jobs, and this sweep then performs thousands of deterministic CPU ray
   * tests. Timeout is host-contention headroom, not a visual acceptance value. */
  }, 360_000)
})
