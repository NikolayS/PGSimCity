import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

interface SweepReport {
  stations: { district: string; camera: [number, number, number] }[]
  sceneObjects: number
  meshObjects: number
  meshInstances: number
  textPlanes: number
  districtSurfaces: number
  borderStrips: number
  opaqueHorizontalTriangles: number
  findings: {
    invariant: string
    object: string
    detail: string
  }[]
}

interface SweepFinding {
  invariant: string
  object: string
  detail: string
}

describe('live rendered city visual sweep', () => {
  it('walks every district station and enforces geometric invariants', async () => {
    const [result] = await inspectRenderedPages([{
      name: 'City visual sweep',
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
    }], async ({ evaluate }) => evaluate(`(async () => {
      const sweep = await import('/test/visual-sweep-browser.ts')
      const report = await sweep.runVisualSweep(window.PGSIMCITY)
      const mirrorProof = await sweep.proveMirroredTextDetection(window.PGSIMCITY)
      return { report, mirrorProof }
    })()`)) as [{ report: SweepReport; mirrorProof: SweepFinding[] }]

    if (process.env.VISUAL_SWEEP_REPORT === '1') {
      console.info(JSON.stringify(result, null, 2))
    } else if (process.env.VISUAL_SWEEP_REPORT === 'summary') {
      console.info(JSON.stringify({
        counts: {
          stations: result.report.stations.length,
          sceneObjects: result.report.sceneObjects,
          meshObjects: result.report.meshObjects,
          meshInstances: result.report.meshInstances,
          textPlanes: result.report.textPlanes,
          districtSurfaces: result.report.districtSurfaces,
          borderStrips: result.report.borderStrips,
          opaqueHorizontalTriangles: result.report.opaqueHorizontalTriangles,
        },
        findings: result.report.findings,
        mirrorProof: result.mirrorProof,
      }, null, 2))
    }

    expect(result.report.stations.map((station) => station.district)).toEqual([
      'clients',
      'backends',
      'shmem',
      'wal',
      'storage',
      'maintenance',
      'replication',
      'planner',
      'world',
    ])
    expect(new Set(
      result.report.stations.map((station) => station.camera.map((value) => value.toFixed(2)).join(',')),
    ).size).toBe(result.report.stations.length)
    expect(result.report.sceneObjects).toBeGreaterThan(400)
    expect(result.report.meshObjects).toBeGreaterThan(300)
    expect(result.report.meshInstances).toBeGreaterThan(11_000)
    expect(result.report.textPlanes).toBeGreaterThan(100)
    expect(result.report.districtSurfaces).toBeGreaterThanOrEqual(3)
    expect(result.report.borderStrips).toBeGreaterThan(20)
    expect(result.report.opaqueHorizontalTriangles).toBeGreaterThan(10_000)
    expect(result.mirrorProof).toEqual([
      expect.objectContaining({
        invariant: 'text-legibility',
        detail: expect.stringContaining('mirrored world determinant'),
      }),
    ])
    expect(result.report.findings).toEqual([])
  // The shared Chrome semaphore can legitimately queue this behind two other
  // software-WebGL browser jobs before the sweep itself gets a slot.
  }, 360_000)
})
