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
})
