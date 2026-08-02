import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createCollector } from '../src/observability/collector'
import { CATALOG } from '../src/observability/catalog'
import { ALL_STEPS, ALL_VERDICTS } from '../src/observability/paths'
import { PROJECTIONS } from '../src/observability/views'
import { createSim } from '../src/sim/model'
import { SCENARIOS } from '../src/sim/scenarios'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'

const bodies = [...DOCS_MEMORY, ...DOCS_STORAGE]
  .flatMap((doc) => [doc.tldr, ...doc.sections.map((section) => section.body)])
  .join('\n')

const diagnosticCopy = [...ALL_STEPS, ...ALL_VERDICTS]
  .flatMap((node) => node.kind === 'step'
    ? [node.title, node.why, node.look, node.note ?? '']
    : [node.title, node.because, node.mechanism, node.fix])
  .join('\n')

describe('PostgreSQL 18 content corrections', () => {
  it('keeps every storage entry cited with current recovery section numbering', () => {
    expect(
      DOCS_STORAGE.filter((doc) => !doc.refs).map((doc) => doc.id),
    ).toEqual([])

    const recoveryLabels = DOCS_STORAGE
      .flatMap((doc) => doc.refs?.docs ?? [])
      .map((ref) => ref.label)
      .filter((label) => label.includes('Recovering Using a Continuous Archive Backup'))

    expect(recoveryLabels).not.toHaveLength(0)
    expect(new Set(recoveryLabels)).toEqual(
      new Set(['25.3.5 Recovering Using a Continuous Archive Backup']),
    )
  })

  it('records the major-version target and current bulk-read strategy durably', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

    expect(readme).toContain('targets the PostgreSQL 18 major line')
    expect(readme).toContain('fixed 32-frame ring')
    expect(bodies).toContain('io_combine_limit')
    expect(`${bodies}\n${diagnosticCopy}`).not.toMatch(/small (?:256 kB|256 KiB) ring/i)
  })

  it('does not overclaim what cumulative statistics prove', () => {
    expect(diagnosticCopy).not.toContain('every miss is a real trip to storage')
    expect(diagnosticCopy).not.toContain('is on CPU — that is work')
    expect(diagnosticCopy).not.toContain('Every number here is a counter')
    expect(diagnosticCopy).toContain('not currently reporting an instrumented wait')
  })

  it('uses restart_lsn as the retention position for logical slots', () => {
    expect(bodies).toContain('For both physical and logical slots, `restart_lsn`')
    expect(bodies).not.toContain('`restart_lsn` for physical slots, `confirmed_flush_lsn` for logical ones')

    const sim = createSim(createBus())
    sim.setKnob('walLevel', 'logical')
    const result = PROJECTIONS.slots(sim.state, createCollector(sim), 'total')
    const logical = result.rows.find((row) => row.key === 'sub')

    expect(logical?.cells.restart_lsn).not.toEqual({ v: '—', tone: 'dim' })
    expect(logical?.cells.confirmed_flush_lsn).not.toBeUndefined()
    expect(result.caption).toContain('minus restart_lsn for every slot')
  })

  it('makes slot-pressure correctness depend on visible recovery evidence', () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'slot-pressure')!
    const preserve = scenario.decision!.choices.find((choice) => choice.id === 'add-wal-capacity')!

    expect(scenario.blurb).toContain('required standby')
    expect(preserve.label).toBe('Add validated 512 MiB headroom')
    expect(preserve.hint).toContain('measured WAL rate')
    expect(preserve.hint).toContain('temporary headroom')
  })

  it('lists the complete PostgreSQL 18 pg_stat_replication surface', () => {
    const replication = CATALOG.find((entry) => entry.id === 'pg_stat_replication')!
    expect(replication.columns.at(-1)).toBe('reply_time')
  })

  it('treats dead-tuple statistics as pressure estimates, not measured bloat', () => {
    const first = ALL_STEPS.find((step) => step.id === 'bloat.1')!
    const noBloat = ALL_VERDICTS.find((verdict) => verdict.id === 'v.no_bloat')!
    const tableCatalog = CATALOG.find((entry) => entry.id === 'pg_stat_all_tables')!

    expect(`${first.why} ${first.look}`).toMatch(/estimated/i)
    expect(first.sql).toContain('pg_total_relation_size')
    expect(first.look).toContain('pgstattuple')
    expect(noBloat.title).not.toMatch(/not bloated/i)
    expect(tableCatalog.what).not.toMatch(/bloat becomes visible/i)
  })

  it('never converts the pg_stat_wal FPI count into a byte share', () => {
    const wal = ALL_STEPS.find((step) => step.id === 'stall.2')!
    const storm = ALL_VERDICTS.find((verdict) => verdict.id === 'v.ckpt_storm')!
    const copy = `${wal.look} ${wal.note} ${storm.because} ${storm.mechanism}`

    expect(copy).toContain('cannot be converted')
    expect(copy).toContain('wal_compression')
    expect(storm.evidence({} as never, {
      total: { ckptTimed: 0, ckptRequested: 0, walFpi: 12 },
      rate: { walFpi: 3, walBytes: 4096 },
    } as never).map((item) => item.label)).not.toContain('full-page images')
  })

  it('keeps aggregate and per-backend I/O attribution distinct', () => {
    const io = ALL_STEPS.find((step) => step.id === 'io.1')!
    const verdict = ALL_VERDICTS.find((entry) => entry.id === 'v.backend_writes')!
    const catalog = CATALOG.find((entry) => entry.id === 'pg_stat_io')!

    expect(`${io.why} ${io.look} ${io.note}`).toContain('backend type')
    expect(io.note).toContain('pg_stat_get_backend_io(pid)')
    expect(io.look).not.toContain('only writes a page when')
    expect(verdict.because).not.toContain('exactly one situation')
    expect(catalog.what).not.toMatch(/names the process/i)
  })

  it('shows waited locks separately from blocker activity', () => {
    const locks = ALL_STEPS.find((step) => step.id === 'lock.1')!

    expect(locks.sql).toContain('waited_mode')
    expect(locks.sql).toContain('blocker_query')
    expect(locks.sql).not.toContain('OR l.pid IN')
    expect(locks.look).toContain('does not claim which of the blocker’s locks conflicts')
  })

  it('does not infer pool size from a usage-count histogram', () => {
    const cache = ALL_STEPS.find((step) => step.id === 'io.2')!
    const churn = ALL_VERDICTS.find((verdict) => verdict.id === 'v.small_pool')!

    expect(cache.look).toContain('cannot distinguish')
    expect(cache.note).toContain('do not acquire buffer-manager locks')
    expect(churn.title).not.toContain('too small')
    expect(churn.fix).toContain('one-pass')
  })

  it('checks every documented xmin-horizon source before tuning vacuum', () => {
    const horizon = ALL_STEPS.find((step) => step.id === 'bloat.2')!

    expect(horizon.sql).toContain('backend_xid IS NOT NULL')
    expect(horizon.sql).toContain('pg_prepared_xacts')
    expect(horizon.sql).toContain('pg_replication_slots')
    expect(horizon.sql).toContain('pg_stat_replication')
    expect(horizon.look).not.toContain('**is** the horizon')
    expect(horizon.note).toContain('READ COMMITTED')
  })

  it('separates raw parsing from analysis locks and avoids planner-cost recipes', () => {
    const parser = DOCS_MEMORY.find((doc) => doc.id === 'planner.parser')!
    const planner = DOCS_MEMORY.find((doc) => doc.id === 'planner.planner')!
    const planTree = DOCS_MEMORY.find((doc) => doc.id === 'planner.plantree')!
    const parserCopy = parser.sections.map((section) => section.body).join('\n')
    const plannerCopy = planner.sections.map((section) => section.body).join('\n')
    const planTreeCopy = planTree.sections.map((section) => section.body).join('\n')

    expect(parserCopy).toContain('Raw parsing alone')
    expect(parserCopy).not.toContain('merely *parsed*')
    expect(plannerCopy).toContain('cache assumptions')
    expect(plannerCopy).toContain('representative workload')
    expect(plannerCopy).not.toMatch(/spinning disk|single most valuable|1\.1 and 2\.0/i)
    expect(planTreeCopy).toContain('cannot safely isolate')
    expect(planTreeCopy).not.toContain('subtract to see what a node cost')
  })

  it('does not repeat the planner-cost recipe on the storage surface', () => {
    const storage = DOCS_STORAGE.find((doc) => doc.id === 'disk.array')!
    const copy = storage.sections.map((section) => section.body).join('\n')

    expect(copy).toContain('workload and cache residency')
    expect(copy).not.toMatch(/calibrated for spinning disks|something like 1\.1/i)
  })
})
