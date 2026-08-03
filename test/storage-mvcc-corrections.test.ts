import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { SCENARIOS } from '../src/sim/scenarios'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'
import { CHAPTERS } from '../src/ui/tour'

const doc = (id: string) => {
  const entry = [...DOCS_MEMORY, ...DOCS_STORAGE].find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`Missing documentation entry ${id}`)
  return entry
}

const section = (id: string, heading: string) => {
  const entry = doc(id).sections.find((candidate) => candidate.heading === heading)
  if (!entry) throw new Error(`Missing section ${id}/${heading}`)
  return entry.body
}

describe('storage and MVCC pageinspect corrections', () => {
  it('distinguishes a lock-only xmax from an effective deleter', () => {
    const heapMvcc = section('storage.table', 'MVCC: row versions, not rows')
    const visibility = section('proc.array', 'How a row version is judged')
    const vacuum = section('autovac.worker', 'Dead is not the same as removable')
    const copy = `${heapMvcc}\n${visibility}\n${vacuum}`

    expect(copy).toContain('HEAP_XMAX_LOCK_ONLY')
    expect(copy).toMatch(/xmax[^.]{0,180}(?:delete|update|lock)/is)
    expect(copy).toMatch(/committed[^.]{0,220}(?:deleting|updating)[^.]{0,120}(?:dead|gone)/is)
    expect(copy).toMatch(/lock-only[^.]{0,180}(?:live|not dead|does not make)/is)
    expect(vacuum).not.toMatch(/tuple whose `xmax` has committed is dead/i)
  })

  it('carries PostgreSQL 18 summarizing-index HOT semantics across the lesson', () => {
    const table = doc('storage.table')
    const hot = section('storage.table', 'HOT updates and page pruning')
    const hotMetric = table.metrics.find((metric) => metric.label === 'HOT share')
    const scenario = SCENARIOS.find((candidate) => candidate.id === 'bloat-and-vacuum')
    const hotBeat = scenario?.beats.find((beat) => beat[1] === 'HOT is the quiet hero')?.[2] ?? ''
    const copy = `${hot}\n${hotMetric?.hint ?? ''}\n${hotBeat}`

    expect(hot).toMatch(/PostgreSQL 18[^.]{0,240}summarizing index/is)
    expect(hot).toMatch(/BRIN/)
    expect(hot).toMatch(/summarizing index[^.]{0,220}(?:maintenance|maintain|work)/is)
    expect(hot).toMatch(/ordinary non-summarizing index/is)
    expect(copy).not.toMatch(/(?:does not touch|avoided touching|No) any index/i)
    expect(copy).not.toContain('No index work happens at all')
  })

  it('states that REINDEX TABLE rebuilds indexes without rewriting the heap', () => {
    const relationFiles = section('storage.datadir', 'relfilenode is not oid')

    expect(relationFiles).toMatch(/REINDEX TABLE[^.]{0,180}(?:does not|without)[^.]{0,80}(?:rewrite|replace)[^.]{0,80}heap/is)
    expect(relationFiles).toMatch(/REINDEX[^.]{0,120}rebuilds?[^.]{0,80}index/is)
  })

  it('describes the configurable TOAST tuple target', () => {
    const why = section('storage.toast', 'Why it exists')
    const controls = section('storage.toast', 'What you can control')
    const copy = `${why}\n${controls}`

    expect(why).toMatch(/roughly 2 KiB[^.]{0,180}default[^.]{0,120}8 KiB/is)
    expect(copy).toContain('toast_tuple_target')
    expect(copy).toMatch(/per table/i)
  })

  it('separates inline, compressed, and out-of-line wide-value read paths', () => {
    const reads = section('storage.toast', 'What a wide column costs to read')

    expect(reads).toMatch(/inline[^.]{0,180}(?:no|without)[^.]{0,100}(?:TOAST|chunk)/is)
    expect(reads).toMatch(/inline[^.]{0,180}compressed[^.]{0,180}decompress/is)
    expect(reads).toMatch(/out-of-line[^.]{0,180}(?:index|chunk)/is)
    expect(reads).toMatch(/decompress[^.]{0,180}(?:only|if)[^.]{0,100}compressed/is)
    expect(reads).not.toMatch(/Selecting a wide column means[^.]+decompression/i)
  })

  it('labels xmin as a snapshot and removal horizon', () => {
    const shmem = readFileSync(new URL('../src/world/shmem.ts', import.meta.url), 'utf8')
    const horizon = doc('xmin.horizon')
    const explanation = section('xmin.horizon', 'What the horizon is')
    const tour = CHAPTERS.find((stop) => stop.focus === 'xmin.horizon')?.body ?? ''

    expect(shmem).toContain("role: 'snapshot and removal horizon'")
    expect(shmem).not.toContain("role: 'oldest xid anyone can still see'")
    expect(horizon.subtitle).toMatch(/snapshot.*removal horizon/i)
    expect(explanation).toMatch(/committed and frozen[^.]{0,180}older[^.]{0,100}visible/is)
    expect(tour).toMatch(/snapshot.*removal horizon/i)
    expect(tour).not.toMatch(/oldest transaction anyone can still see/i)
  })

  it('does not treat backend_xid as proof that user data was written', () => {
    const production = section('proc.array', 'What you would see in production')
    const procArray = doc('proc.array')
    const inTransaction = procArray.metrics.find((metric) => metric.label === 'Assigned XIDs')
    const copy = `${production}\n${inTransaction?.hint ?? ''}`

    expect(production).toMatch(/ordinary read-only transactions[^.]{0,180}(?:avoid|without)[^.]{0,100}(?:assign|transaction id|XID)/is)
    expect(production).toContain('pg_current_xact_id()')
    expect(production).toMatch(/backend_xid[^.]{0,220}not proof[^.]{0,100}(?:written|write)/is)
    expect(copy).not.toMatch(/only once a transaction has written/i)
    expect(copy).not.toMatch(/inside a transaction that has written/i)
  })
})
