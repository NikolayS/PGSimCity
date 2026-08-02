import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { cityComponentHref, cityComponentId } from '../src/core/city-route'
import {
  CLAIMS,
  CLAIM_VALUES,
} from '../src/core/claims'
import { MACHINE_SYNCHRONOUS_COMMIT_COMPARISON } from '../src/spine/machine-comparison'
import type { ClaimId } from '../src/core/claims'
import { formatModelMilliseconds } from '../src/core/trace-presentation'
import { N_BUFFERS } from '../src/core/types'
import { createBus } from '../src/core/bus'
import { CATALOG } from '../src/observability/catalog'
import { createCollector } from '../src/observability/collector'
import { ALL_STEPS, ALL_VERDICTS } from '../src/observability/paths'
import { PROJECTIONS } from '../src/observability/views'
import { MODEL_BULK_READ_RING_FRAMES, MODEL_LATENCY_WINDOW_TRIPS, createSim } from '../src/sim/model'
import { CHAPTERS } from '../src/ui/tour'
import { DOCS_STORAGE } from '../src/ui/docs-storage'
import { KNOB_META, doc, mdToHtml } from '../src/ui/content'
import { MODEL_LATENCY_VITAL_LABEL } from '../src/ui/hud'
import { VACUUM_RECLAIM_PLATE_LINES } from '../src/world/maintenance'
import { SHARED_BUFFER_SAMPLE_PLATE_LABEL } from '../src/world/shmem'
import { WAL_SEGMENT_PLATE_LABEL, WAL_SEGMENT_SIZE_PLATE_LABEL } from '../src/world/wal'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function agrees<T>(claimId: ClaimId, surface: string, actual: T, expected: T): void {
  expect(
    actual,
    `${claimId}: ${surface} disagrees with ${CLAIMS[claimId].owner}`,
  ).toEqual(expected)
}

function storageDocCopy(id: string): string {
  const entry = DOCS_STORAGE.find((candidate) => candidate.id === id)
  expect(entry, `missing documentation surface ${id}`).toBeDefined()
  return [entry!.tldr, ...entry!.sections.map((section) => section.body)].join('\n')
}

describe('claims and conventions spine', () => {
  it('owns exactly the eleven drift-prone contracts in this pass', () => {
    expect(Object.keys(CLAIMS)).toEqual([
      'walSegment',
      'bufferSample',
      'bulkReadRing',
      'checkpointPolicy',
      'standbyNames',
      'modelDuration',
      'modelLatency',
      'vacuumReclaim',
      'cityComponentRoute',
      'markdownRendering',
      'reviewStatus',
      'machineSynchronousCommitComparison',
    ])
    for (const claim of Object.values(CLAIMS)) {
      expect(claim.owner).not.toBe('')
      expect(claim.surfaces.length).toBeGreaterThan(1)
    }
  })

  it('keeps the WAL-segment model, painted vault, and prose on 16 MiB', () => {
    const state = createSim(createBus()).state
    agrees('walSegment', 'model:wal.segmentSize', state.wal.segmentSize, CLAIM_VALUES.walSegment.bytes)
    agrees('walSegment', 'world:wal.vault size plate', WAL_SEGMENT_SIZE_PLATE_LABEL, CLAIM_VALUES.walSegment.label)
    expect(WAL_SEGMENT_PLATE_LABEL, 'walSegment: world:wal.vault plate omits the owned label')
      .toContain(CLAIM_VALUES.walSegment.label)
    expect(storageDocCopy('wal.vault'), 'walSegment: prose:WAL vault disagrees with the painted vault')
      .toContain(`${CLAIM_VALUES.walSegment.label} segments`)
  })

  it('distinguishes the 1,024-frame capacity from 256 active default frames', () => {
    const state = createSim(createBus()).state
    agrees('bufferSample', 'model:default active frames', state.buffers.sampleFrames, CLAIM_VALUES.bufferSample.defaultActiveFrames)
    agrees('bufferSample', 'model:sample capacity', N_BUFFERS, CLAIM_VALUES.bufferSample.capacityFrames)
    expect(state.cluster.nodes.map((node) => node.buffers.sampleFrames), 'bufferSample: model:node samples disagree')
      .toEqual(Array(3).fill(CLAIM_VALUES.bufferSample.defaultActiveFrames))
    expect(SHARED_BUFFER_SAMPLE_PLATE_LABEL, 'bufferSample: world:shared_buffers plate disagrees')
      .toContain(`UP TO ${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')} FRAMES`)

    const hint = KNOB_META.find((knob) => knob.key === 'sharedBuffers')?.hint ?? ''
    expect(hint, 'bufferSample: controls:shared_buffers hint omits the default active sample')
      .toContain(String(CLAIM_VALUES.bufferSample.defaultActiveFrames))
    expect(read('README.md'), 'bufferSample: README:buffer-pool row disagrees')
      .toContain(`${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')} representative frames (${CLAIM_VALUES.bufferSample.defaultActiveFrames} active at the default 2 GiB setting)`)
    expect(storageDocCopy('standby.b'), 'bufferSample: prose:standby sample disclosure disagrees')
      .toContain(`${CLAIM_VALUES.bufferSample.capacityFrames.toLocaleString('en-US')}-frame sample capacity; at the default 2 GiB setting ${CLAIM_VALUES.bufferSample.defaultActiveFrames} frames are active`)
  })

  it('keeps the historical bulk-read approximation explicit on every surface', () => {
    agrees(
      'bulkReadRing',
      'model:bulk-read ring',
      MODEL_BULK_READ_RING_FRAMES,
      CLAIM_VALUES.bulkReadRing.modelFrames,
    )
    expect(read('README.md'), 'bulkReadRing: README:bulk-read disclosure disagrees')
      .toContain(CLAIM_VALUES.bulkReadRing.disclosure)
    const cacheVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.io_ok')
    expect(cacheVerdict?.mechanism, 'bulkReadRing: Diagnose:cache verdict omits the fixed approximation')
      .toContain(CLAIM_VALUES.bulkReadRing.diagnoseDisclosure)
  })

  it('keeps max_wal_size beside checkpoint_timeout in the model and both dial sets', () => {
    const state = createSim(createBus()).state
    agrees(
      'checkpointPolicy',
      'model:checkpoint_timeout default',
      state.knobs.checkpointTimeout,
      CLAIM_VALUES.checkpointPolicy.defaultTimeoutSeconds,
    )
    agrees(
      'checkpointPolicy',
      'model:max_wal_size default',
      state.knobs.maxWalSize,
      CLAIM_VALUES.checkpointPolicy.defaultMaxWalSizeMiB,
    )

    const controlPartners = KNOB_META
      .filter((knob) => CLAIM_VALUES.checkpointPolicy.partners.some((key) => key === knob.key))
    expect(controlPartners.map((knob) => knob.key), 'checkpointPolicy: controls:checkpoint dials disagree')
      .toEqual(CLAIM_VALUES.checkpointPolicy.partners)
    expect(controlPartners.map((knob) => knob.group), 'checkpointPolicy: controls:dials are not siblings')
      .toEqual(['checkpoint', 'checkpoint'])

    const verdict = ALL_VERDICTS.find((candidate) => candidate.id === 'v.ckpt_storm')
    expect(verdict?.knobs.slice(0, 2).map((knob) => knob.key), 'checkpointPolicy: Diagnose:checkpoint controls disagree')
      .toEqual(CLAIM_VALUES.checkpointPolicy.partners)
  })

  it('keeps internal standby IDs and reader-facing names paired', () => {
    const sim = createSim(createBus())
    const expected = CLAIM_VALUES.standbyNames.internal.map((id, index) => [
      id,
      CLAIM_VALUES.standbyNames.display[index],
    ])
    agrees(
      'standbyNames',
      'model:physical standbys',
      sim.state.replication.standbys.map((standby) => [standby.nodeId, standby.applicationName]),
      expected,
    )

    const control = KNOB_META.find((knob) => knob.key === 'synchronousStandbyNames')
    expect(control?.options?.slice(1).map((option) => option.label.split(' — ')[0]), 'standbyNames: controls:standby choices disagree')
      .toEqual(CLAIM_VALUES.standbyNames.display)

    const rows = PROJECTIONS.replication(sim.state, createCollector(sim), 'total').rows
    expect(rows.map((row) => row.cells.application_name), 'standbyNames: Diagnose:replication rows disagree')
      .toEqual(CLAIM_VALUES.standbyNames.display)
  })

  it('labels deliberately stretched durations as model time', () => {
    expect(formatModelMilliseconds(12), 'modelDuration: Query flow:duration readout disagrees')
      .toBe(`12 ${CLAIM_VALUES.modelDuration.millisecondUnit}`)

    const sim = createSim(createBus())
    const lockVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.lock_holder')
    const oldest = lockVerdict?.evidence(sim.state, createCollector(sim))
      .find((item) => item.label === 'oldest wait')?.value
    expect(oldest, 'modelDuration: Diagnose:lock duration disagrees')
      .toBe(`0 ${CLAIM_VALUES.modelDuration.shortUnit}`)
    expect(storageDocCopy('net.wire'), 'modelDuration: prose:network duration omits the convention')
      .toContain(CLAIM_VALUES.modelDuration.prose)
  })

  it('keeps rolling latency quantiles and units aligned across model, HUD, and prose', () => {
    agrees(
      'modelLatency',
      'shared:model-duration unit',
      CLAIM_VALUES.modelLatency.unit,
      CLAIM_VALUES.modelDuration.millisecondUnit,
    )
    agrees(
      'modelLatency',
      'model:rolling window',
      MODEL_LATENCY_WINDOW_TRIPS,
      CLAIM_VALUES.modelLatency.windowTrips,
    )
    const sim = createSim(createBus())
    for (let i = 0; i < 1800; i++) sim.update(1 / 30)
    agrees(
      'modelLatency',
      'model:quantile names',
      Object.keys(sim.state.stats.latency).filter((key) => key === 'p50' || key === 'p99'),
      CLAIM_VALUES.modelLatency.quantiles,
    )
    expect(MODEL_LATENCY_VITAL_LABEL, 'modelLatency: HUD unit disagrees')
      .toContain(CLAIM_VALUES.modelLatency.unit)
    expect(storageDocCopy('checkpointer'), 'modelLatency: prose omits the owned window')
      .toContain(CLAIM_VALUES.modelLatency.disclosure)
    expect(storageDocCopy('bgwriter'), 'modelLatency: prose omits real-server percentile limits')
      .toContain('production long-tail consequence is not validated')
  })

  it('keeps vacuum truncation qualified on the model, plate, tour, and docs', () => {
    agrees(
      'vacuumReclaim',
      'world:landfill plate',
      VACUUM_RECLAIM_PLATE_LINES,
      CLAIM_VALUES.vacuumReclaim.plateLines,
    )
    const vacuumChapter = CHAPTERS.find((chapter) => chapter.id === 'vacuum')
    expect(vacuumChapter?.body, 'vacuumReclaim: tour:vacuum chapter disagrees')
      .toContain(CLAIM_VALUES.vacuumReclaim.rule)
    expect(storageDocCopy('autovac.worker'), 'vacuumReclaim: prose:vacuum docs omit trailing-empty-page rule')
      .toContain('only shortens the file if the very last pages are entirely empty')
    expect(read('src/sim/scenarios.ts'), 'vacuumReclaim: model:vacuum narration omits its tail-density simplification')
      .toContain('truncation uses a tail-density heuristic')
  })

  it('keeps every Diagnose city-link producer connected to the city hash consumer', () => {
    const targets = [...ALL_STEPS, ...ALL_VERDICTS, ...CATALOG]
      .map((entry) => entry.city)
      .filter((id): id is string => Boolean(id))
    expect(targets.length).toBeGreaterThanOrEqual(36)

    for (const id of targets) {
      const href = cityComponentHref(id, '../')
      expect(href, `cityComponentRoute: Diagnose:city link for ${id} uses the wrong convention`)
        .toBe(`../${CLAIM_VALUES.cityComponentRoute.hashPrefix}${id}`)
      expect(cityComponentId(href.slice(3)), `cityComponentRoute: city:hash consumer rejects ${id}`)
        .toBe(id)
      expect(doc(id), `cityComponentRoute: ${id} has no selectable city component document`).toBeDefined()
    }
  })

  it('uses the owned markdown renderer for inspector and tour prose', () => {
    agrees(
      'markdownRendering',
      'renderer owner',
      CLAIMS.markdownRendering.value.owner,
      'mdToHtml',
    )
    expect(mdToHtml('turn **on** `synchronous_commit`'), 'markdownRendering: inspector:document body disagrees')
      .toBe('turn <strong>on</strong> <code>synchronous_commit</code>')
    expect(CHAPTERS[6].body, 'markdownRendering: tour:chapter body has no markdown to exercise')
      .toContain('`synchronous_commit`')
  })

  it('keeps the reviewed status aligned between README and boot screen', () => {
    expect(read('README.md'), 'reviewStatus: README:trust statement disagrees')
      .toContain(CLAIM_VALUES.reviewStatus.summary)
    const index = read('index.html')
    expect(index, 'reviewStatus: index:boot honesty still says unreviewed').not.toMatch(/unreviewed/i)
    expect(index, 'reviewStatus: index:boot honesty disagrees')
      .toContain(`<strong>${CLAIM_VALUES.reviewStatus.bootLabel}</strong>`)
  })

  it('keeps the Machine comparison attached to the modelled commit-wait claim', () => {
    agrees(
      'machineSynchronousCommitComparison',
      'Machine:comparison claim',
      CLAIMS.machineSynchronousCommitComparison.value,
      MACHINE_SYNCHRONOUS_COMMIT_COMPARISON,
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.evidenceSource).toBe('model')
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.finding).toContain(
      'WAL still flushes later',
    )
    expect(MACHINE_SYNCHRONOUS_COMMIT_COMPARISON.pgliteDisclosure).toContain(
      'cannot measure this durability-wait difference',
    )
    expect(read('machine/comparison.js'), 'Machine:comparison does not consume the owned claim')
      .toContain('MACHINE_SYNCHRONOUS_COMMIT_COMPARISON as claim')
  })
})
