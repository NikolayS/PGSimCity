import { expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { SCENARIOS } from './scenarios'

type Sim = ReturnType<typeof createSim>

function steps(sim: Sim, count: number): void {
  for (let i = 0; i < count; i++) sim.update(1 / 30)
}

function scenarioTo(sim: Sim, seconds: number): void {
  while (sim.state.scenarioT < seconds) {
    sim.update(Math.min(1 / 30, seconds - sim.state.scenarioT))
  }
}

it('measures working-set behavior', { timeout: 120_000 }, () => {
  const sizes = [16, 64, 96, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536]
  const sweep = sizes.map((sharedBuffers) => {
    const sim = createSim(createBus())
    sim.setKnob('sharedBuffers', sharedBuffers)
    steps(sim, 6000)
    return {
      sharedBuffers,
      frames: sim.state.buffers.size,
      hitPct: Number(sim.state.stats.cacheHitPct.toFixed(3)),
      evictions: sim.state.buffers.evictions,
      backendWrites: sim.state.buffers.dirtyEvictions,
    }
  })

  const writeHeavy = createSim(createBus())
  writeHeavy.setKnob('sharedBuffers', 128)
  writeHeavy.setKnob('tps', 800)
  writeHeavy.setKnob('writeRatio', 0.5)
  steps(writeHeavy, 414 * 30)

  const noBgwriter = createSim(createBus())
  noBgwriter.runScenario('no-bgwriter')
  const noBgwriterTimeline = [0, 14, 30, 48, 64, 80, 84].map((second) => {
    scenarioTo(noBgwriter, second)
    return {
      second,
      backendWrites: noBgwriter.state.buffers.dirtyEvictions,
      evictions: noBgwriter.state.buffers.evictions,
      bgwriterEnabled: noBgwriter.state.bgwriter.enabled,
      bgwriterCleaned: noBgwriter.state.bgwriter.cleanedTotal,
    }
  })

  const cacheThrash = createSim(createBus())
  cacheThrash.runScenario('cache-thrash')
  scenarioTo(cacheThrash, 84)

  const bloat = createSim(createBus())
  bloat.runScenario('bloat-and-vacuum')
  const sessions = bloat.state.tables.findIndex((table) => table.def.id === 'sessions')
  const bloatTimeline = [0, 16, 52, 70, 88, 112, 126].map((second) => {
    scenarioTo(bloat, second)
    const table = bloat.state.tables[sessions]
    return {
      second,
      pages: table.pages,
      bloatPct: Number((table.bloat * 100).toFixed(3)),
      deadTuples: Math.round(table.deadTuples),
      vacuumRuns: bloat.state.autovac.totalRuns,
      workers: bloat.state.autovac.workers
        .filter((worker) => worker.active)
        .map((worker) => `${worker.table}:${worker.phase}`),
    }
  })

  const seqScan = createSim(createBus())
  seqScan.runScenario('index-vs-seqscan')
  const seqTimeline = [0, 28, 74, 84].map((second) => {
    scenarioTo(seqScan, second)
    return {
      second,
      hitPct: Number(seqScan.state.stats.cacheHitPct.toFixed(3)),
      readsPerSec: Number(seqScan.state.stats.ioReadPerSec.toFixed(3)),
      tps: Number(seqScan.state.stats.tps.toFixed(3)),
      evictions: seqScan.state.buffers.evictions,
    }
  })

  console.log(JSON.stringify({
    sweep,
    writeHeavy: {
      hitPct: Number(writeHeavy.state.stats.cacheHitPct.toFixed(3)),
      evictions: writeHeavy.state.buffers.evictions,
      backendWrites: writeHeavy.state.buffers.dirtyEvictions,
    },
    noBgwriterTimeline,
    cacheThrash: {
      hitPct: Number(cacheThrash.state.stats.cacheHitPct.toFixed(3)),
      readsPerSec: Number(cacheThrash.state.stats.ioReadPerSec.toFixed(3)),
      evictions: cacheThrash.state.buffers.evictions,
      backendWrites: cacheThrash.state.buffers.dirtyEvictions,
    },
    bloatTimeline,
    seqTimeline,
  }, null, 2))
  expect(sweep).toHaveLength(sizes.length)
})

it('measures scenario health', { timeout: 120_000 }, () => {
  const summaries = SCENARIOS.map((scenario) => {
    const sim = createSim(createBus())
    sim.runScenario(scenario.id)
    const timeline = [30, 60, Math.min(84, scenario.duration - 1)].map((second) => {
      scenarioTo(sim, second)
      const states: Record<string, number> = {}
      for (const backend of sim.state.backends) {
        states[backend.state] = (states[backend.state] ?? 0) + 1
      }
      return {
        second,
        tps: Number(sim.state.stats.tps.toFixed(3)),
        hitPct: Number(sim.state.stats.cacheHitPct.toFixed(3)),
        readsPerSec: Number(sim.state.stats.ioReadPerSec.toFixed(3)),
        writesPerSec: Number(sim.state.stats.ioWritePerSec.toFixed(3)),
        evictions: sim.state.buffers.evictions,
        backendWrites: sim.state.buffers.dirtyEvictions,
        checkpoint: `${sim.state.checkpoint.phase}:${sim.state.checkpoint.count}`,
        vacuumRuns: sim.state.autovac.totalRuns,
        workers: sim.state.autovac.workers
          .filter((worker) => worker.active)
          .map((worker) => `${sim.state.tables[worker.table].def.id}:${worker.phase}`),
        states,
      }
    })
    return { id: scenario.id, timeline }
  })

  console.log(JSON.stringify(summaries, null, 2))
  expect(summaries).toHaveLength(SCENARIOS.length)
})

it('measures steady-state scan calibration', { timeout: 120_000 }, () => {
  const rows = [0.005, 0.01, 0.02, 0.04, 0.06, 0.08].map((seqScanRatio) => {
    const sim = createSim(createBus())
    sim.runScenario('steady-state')
    sim.setKnob('sharedBuffers', 4096)
    sim.setKnob('seqScanRatio', seqScanRatio)
    scenarioTo(sim, 80)
    return {
      seqScanRatio,
      hitPct: Number(sim.state.stats.cacheHitPct.toFixed(3)),
      tps: Number(sim.state.stats.tps.toFixed(3)),
      readsPerSec: Number(sim.state.stats.ioReadPerSec.toFixed(3)),
    }
  })
  console.log(JSON.stringify(rows, null, 2))
  expect(rows).toHaveLength(6)
})
