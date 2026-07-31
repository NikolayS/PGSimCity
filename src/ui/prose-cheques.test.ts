import { describe, expect, it } from 'vitest'
import { SCENARIOS } from '../sim/scenarios'
import { DOCS } from './content'
import { CHAPTERS } from './tour'

const sourceFiles = import.meta.glob([
  '../world/{planner,backends,clients,storage,maintenance,replication,continuity,shmem,wal}.ts',
  '../sim/model.ts',
  '../observability/{flow2d,flow-architecture,paths,real-postgres-ui}.ts',
  './{control-center,trace-copy,help,content}.ts',
], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

function chapter(id: string): string {
  const hit = CHAPTERS.find((candidate) => candidate.id === id)
  if (!hit) throw new Error(`missing tour chapter ${id}`)
  return `${hit.title}\n${hit.body}`
}

function scenario(id: string): string {
  const hit = SCENARIOS.find((candidate) => candidate.id === id)
  if (!hit) throw new Error(`missing scenario ${id}`)
  return [hit.name, hit.blurb, ...(hit.beats ?? []).flatMap((beat) => beat.slice(1))].join('\n')
}

function doc(id: string): string {
  const hit = DOCS.find((candidate) => candidate.id === id)
  if (!hit) throw new Error(`missing component doc ${id}`)
  return [
    hit.title,
    hit.tldr,
    ...hit.sections.flatMap((section) => [section.heading, section.body]),
    ...(hit.metrics ?? []).flatMap((metric) => [metric.label, metric.hint ?? '']),
  ].join('\n')
}

function source(suffix: string): string {
  const hit = Object.entries(sourceFiles).find(([file]) => file.endsWith(suffix))
  if (!hit) throw new Error(`missing raw source ${suffix}`)
  return hit[1]
}

describe('prose does not promise behavior absent from the model', () => {
  it('marks fixed query grammar and plan selection at the tour and lab', () => {
    expect(chapter('connect')).toMatch(/authentication (?:is|itself is) not simulated/i)
    expect(chapter('plan')).toMatch(/fixed single-table.*plan template/i)
    expect(chapter('plan')).toMatch(/no joins/i)
    expect(chapter('plan')).toMatch(/no .*cost-driven choice/i)
    expect(doc('planner.lab')).toMatch(/fixed statement templates/i)
    expect(doc('planner.planner')).toMatch(/no joins/i)
    expect(doc('planner.planner')).toMatch(/statistics do not choose/i)
  })

  it('marks scenario effects that have no modeled latency, lock, or ProcArray signal', () => {
    expect(scenario('checkpoint-storm')).toMatch(/does not measure (?:query )?latency/i)
    expect(scenario('no-bgwriter')).toMatch(/does not measure (?:query )?latency/i)
    expect(scenario('lock-pileup')).toMatch(/does not model lock-queue fairness/i)
    expect(scenario('lock-pileup')).toMatch(/fixed 15 model-second timeout/i)
    expect(scenario('lock-pileup')).toMatch(/no lock_timeout knob/i)
    expect(scenario('connection-storm')).toMatch(/does not charge ProcArray/i)
    expect(scenario('connection-storm')).toMatch(/has no latency series/i)
  })

  it('marks renderer-only teaching visuals as illustrative', () => {
    expect(doc('backend.localmem')).toMatch(/private-memory and temp-file visuals are illustrative/i)
    expect(doc('backend.localmem')).toMatch(/does not model .*work_mem/i)
    expect(doc('os.cache')).toMatch(/route animation is illustrative/i)
    expect(doc('os.cache')).toMatch(/does not change model time/i)
    expect(doc('storage.vm')).toMatch(/no index-only plan/i)
    expect(doc('storage.toast')).toMatch(/does not store TOAST chunks/i)

    expect(source('/world/backends.ts')).toMatch(/illustrative.*no modeled work_mem/i)
    expect(source('/world/storage.ts')).toMatch(/illustrative TOAST route.*no modeled chunk/i)
    expect(source('/world/storage.ts')).toMatch(/illustrative cache route.*no modeled kernel cache/i)
    expect(source('/observability/flow-architecture.ts')).toMatch(/illustrative; no work_mem spill model/i)
  })

  it('marks architectural buildings that have no process, file, or cache mechanism', () => {
    expect(doc('world.ground')).toMatch(/does not create operating-system processes/i)
    expect(doc('shmem.deck')).toMatch(/does not allocate a shared-memory segment/i)
    expect(doc('buf.mapping')).toMatch(/does not model 128 buffer-mapping partitions/i)
    expect(doc('storage.datadir')).toMatch(/does not create a data-directory tree/i)
    expect(doc('disk.array')).toMatch(/no device queue/i)

    expect(source('/world/clients.ts')).toMatch(/slot per duct.*socket and process costs are absent/i)
    expect(source('/world/backends.ts')).toMatch(/activity slot, not an OS process model/i)
    expect(source('/world/shmem.ts')).toMatch(/no process mappings/i)
    expect(source('/world/storage.ts')).toMatch(/no filesystem or relation forks/i)
    expect(source('/observability/flow-architecture.ts')).toMatch(/model uses activity slots/i)
  })

  it('marks replication projections that do not contain sockets, pages, rows, or subscribers', () => {
    expect(doc('net.wire')).toMatch(/no TCP packets/i)
    expect(doc('walreceiver')).toMatch(/does not run a walreceiver/i)
    expect(doc('startup.proc')).toMatch(/does not parse WAL records/i)
    expect(doc('replica.standby')).toMatch(/no copied heap or index pages/i)
    expect(doc('replica.storage')).toMatch(/does not copy or extend relation files/i)
    expect(doc('subscriber')).toMatch(/illustrative endpoint/i)
    expect(scenario('logical-replication')).toMatch(/without decoded rows/i)

    expect(source('/world/replication.ts')).toMatch(/no socket transport/i)
    expect(source('/world/replication.ts')).toMatch(/no decoded rows or subscriber state/i)
    expect(source('/world/wal.ts')).toMatch(/no decoded rows/i)
    expect(source('/world/continuity.ts')).toMatch(/no replica rows or pages/i)
  })

  it('does not present post-hoc planner cards as causal model inputs', () => {
    const planner = source('/world/planner.ts')
    expect(planner).not.toContain('prices every path and takes the cheapest')
    expect(planner).not.toContain('stale stats here would misprice every card')
    expect(planner).toMatch(/illustrative.*not model inputs/i)
    expect(planner).toMatch(/model.*plan template/i)
  })

  it('marks display-only plan fields and decorative parallel nodes', () => {
    expect(doc('planner.executor')).toMatch(/does not .*launch parallel workers/i)
    expect(doc('planner.plantree')).toMatch(/row figures and costs are display-only/i)
    const model = source('/sim/model.ts')
    expect(model).not.toContain('Workers Launched:')
    expect(model).not.toMatch(/Sort Key:.*Memory:/)
    expect(model).toMatch(/no parallel workers modeled/i)
    expect(source('trace-copy.ts')).toMatch(/process startup and memory are absent/i)
  })

  it('marks latency prose where the city exposes only causal counters', () => {
    expect(chapter('checkpoint')).toMatch(/no latency series/i)
    expect(doc('checkpointer')).toMatch(/city has no query-latency series/i)
    expect(doc('bgwriter')).toMatch(/city has no query-latency series/i)
    expect(source('/world/maintenance.ts')).toMatch(/no latency metric/i)
    expect(source('/observability/paths.ts')).toMatch(/model has no latency series/i)
  })

  it('labels every stretched statement duration as model time', () => {
    const files = [
      source('control-center.ts'),
      source('/observability/flow2d.ts'),
      source('/observability/real-postgres-ui.ts'),
    ]
    for (const text of files) {
      for (const line of text.split('\n')) {
        if (/lastTripSec|actualMs|elapsed \* 1000|duration \* 1000|max \* 1000/.test(line)) {
          if (/interface |actualMs: number|actualMs: node\.actualMs|lastTripSec !==|lastTime =|const elapsed|from ===|this\.elapsed/.test(line)) continue
          expect(line, line.trim()).toMatch(/model|formatModel/)
        }
      }
    }
    expect(source('/observability/flow2d.ts')).toContain("metric('Model time')")
    expect(source('/observability/flow2d.ts')).toContain("text: 'Model time by stop'")
  })
})
