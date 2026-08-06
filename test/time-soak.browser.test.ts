import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

const MIB = 1024 * 1024

interface BrowserSnapshot {
  t: number
  commits: number
  sceneObjects: number
  flowChildren: number
  activeFlows: number
  particleLimit: number
  droppedFlows: number
  waterRipples: number
  labels: number
  geometries: number
  textures: number
  programs: number
  histories: number[]
  backups: number
}

interface BrowserSoakReport {
  baseline: BrowserSnapshot
  samples: BrowserSnapshot[]
  baselineHeap: number
  finalHeap: number
  finalMode: string
  finalServerLimit: number
  finalQuality: string
  errors: string[]
}

const SNAPSHOT = `(() => {
  const pg = window.PGSIMCITY
  let sceneObjects = 0
  pg.gfx.scene.traverse(() => sceneObjects++)
  return {
    t: pg.sim.state.t,
    commits: pg.sim.state.stats.commits,
    sceneObjects,
    flowChildren: pg.flows.group.children.length,
    activeFlows: pg.flows.active,
    particleLimit: pg.gfx.quality.maxParticles,
    droppedFlows: pg.flows.dropped,
    waterRipples: pg.water.group.children.filter((child) => child.name === 'buffer.water.ripple').length,
    labels: document.querySelectorAll('#labels-root > *').length,
    geometries: pg.gfx.renderer.info.memory.geometries,
    textures: pg.gfx.renderer.info.memory.textures,
    programs: pg.gfx.renderer.info.programs?.length ?? 0,
    histories: Object.values(pg.sim.state.stats.history).map((history) => history.length),
    backups: pg.sim.state.disasterRecovery.backups.length,
  }
})()`

function metric(metrics: { metrics: { name: string; value: number }[] }, name: string): number {
  return metrics.metrics.find((candidate) => candidate.name === name)?.value ?? -1
}

// Keep this deliberately long browser run opt-in so it does not consume one of
// the two shared browser slots for the duration of the default test suite.
describe.skipIf(process.env.PGSIMCITY_BROWSER_SOAK !== '1')('long browser-path soak', () => {
  it('keeps renderer-owned pools and heap bounded while model time advances', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'City time soak',
      path: '/',
      readySelector: '#canvas-root canvas',
      beforeLoad: `(() => {
        const errors = []
        Object.defineProperty(window, '__PG_TIME_SOAK_ERRORS', { value: errors })
        addEventListener('error', (event) => errors.push(String(event.error?.stack ?? event.message)))
        addEventListener('unhandledrejection', (event) => errors.push(String(event.reason?.stack ?? event.reason)))
        const originalError = console.error.bind(console)
        console.error = (...args) => {
          errors.push(args.map((value) => String(value?.stack ?? value)).join(' '))
          originalError(...args)
        }
      })()`,
      prepare: `(async () => {
        for (let attempt = 0; attempt < 240 && !window.PGSIMCITY; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not expose its browser handle')
        const pg = window.PGSIMCITY
        pg.bus.emit('quality', { level: 'low' })
        pg.sim.setKnob('timeScale', 20)
        pg.sim.setKnob('tps', 80)
        pg.sim.setKnob('writeRatio', 0.5)
        const { ROUTES } = await import('/src/world/layout.ts')
        for (const route of Object.keys(ROUTES)) pg.flows.emit({ route, count: 1 })
      })()`,
    }], async ({ evaluate, send }) => {
      await send('Performance.enable')
      await send('HeapProfiler.enable')
      await evaluate('new Promise((resolve) => setTimeout(resolve, 15000))')
      await send('HeapProfiler.collectGarbage')
      const baselineHeap = metric(await send('Performance.getMetrics'), 'JSHeapUsedSize')
      const baseline = await evaluate(SNAPSHOT) as BrowserSnapshot
      const samples: BrowserSnapshot[] = []

      for (let sample = 0; sample < 6; sample++) {
        await evaluate('new Promise((resolve) => setTimeout(resolve, 15000))')
        samples.push(await evaluate(SNAPSHOT) as BrowserSnapshot)
      }

      await evaluate(`(async () => {
        const pg = window.PGSIMCITY
        pg.sim.setKnob('poolMode', 'transaction')
        pg.sim.setKnob('defaultPoolSize', 4)
        pg.bus.emit('quality', { level: 'medium' })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        pg.bus.emit('quality', { level: 'low' })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      })()`)
      await send('HeapProfiler.collectGarbage')
      const finalHeap = metric(await send('Performance.getMetrics'), 'JSHeapUsedSize')
      const interaction = await evaluate(`({
        mode: window.PGSIMCITY.sim.state.pooler.mode,
        serverLimit: window.PGSIMCITY.sim.state.pooler.serverLimit,
        quality: window.PGSIMCITY.gfx.quality.level,
      })`)

      return {
        baseline,
        samples,
        baselineHeap,
        finalHeap,
        finalMode: interaction.mode,
        finalServerLimit: interaction.serverLimit,
        finalQuality: interaction.quality,
        errors: await evaluate('[...window.__PG_TIME_SOAK_ERRORS]'),
      } satisfies BrowserSoakReport
    }) as BrowserSoakReport[]

    if (process.env.SOAK_REPORT === '1') {
      console.info('browser time soak', JSON.stringify(report, null, 2))
    }
    const final = report.samples.at(-1)!
    expect(final.t - report.baseline.t).toBeGreaterThan(20 * 60)
    expect(final.commits).toBeGreaterThan(report.baseline.commits)
    expect(new Set(report.samples.map((sample) => sample.sceneObjects))).toEqual(
      new Set([report.baseline.sceneObjects]),
    )
    expect(new Set(report.samples.map((sample) => sample.flowChildren))).toEqual(new Set([1]))
    expect(new Set(report.samples.map((sample) => sample.waterRipples))).toEqual(
      new Set([report.baseline.waterRipples]),
    )
    expect(new Set(report.samples.map((sample) => sample.labels))).toEqual(
      new Set([report.baseline.labels]),
    )
    expect(report.samples.every((sample) => sample.activeFlows <= sample.particleLimit)).toBe(true)
    expect(report.samples.every((sample, index) => (
      index === 0 || sample.droppedFlows >= report.samples[index - 1].droppedFlows
    ))).toBe(true)
    expect(Math.max(...report.samples.map((sample) => sample.geometries)))
      .toBeLessThanOrEqual(report.baseline.geometries)
    expect(Math.max(...report.samples.map((sample) => sample.textures)))
      .toBeLessThanOrEqual(report.baseline.textures)
    expect(Math.max(...report.samples.map((sample) => sample.programs)))
      .toBeLessThanOrEqual(Math.ceil(report.baseline.programs * 1.1) + 5)
    expect(report.samples.flatMap((sample) => sample.histories).every((length) => length <= 120))
      .toBe(true)
    expect(Math.max(...report.samples.map((sample) => sample.backups))).toBeLessThanOrEqual(3)
    expect(report.baselineHeap).toBeGreaterThan(0)
    expect(report.finalHeap).toBeGreaterThan(0)
    expect(report.finalHeap - report.baselineHeap).toBeLessThan(8 * MIB)
    expect(report.finalMode).toBe('transaction')
    expect(report.finalServerLimit).toBe(4)
    expect(report.finalQuality).toBe('low')
    expect(report.errors).toEqual([])
  }, 600_000)
})
