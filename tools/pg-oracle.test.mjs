import { describe, expect, it } from 'vitest'

import {
  compareSetting,
  expectedForMajor,
  loadOracleRegistry,
  markdownTable,
} from './pg-oracle.mjs'

describe('PostgreSQL oracle claim registry', () => {
  it('discovers every check family through the registered oracle sources', async () => {
    const registry = await loadOracleRegistry()

    expect(registry.claims.gucDefaults.length).toBeGreaterThan(8)
    expect(registry.catalog.some((entry) => entry.id === 'pg_stat_io')).toBe(true)
    expect(registry.claims.waitEvents.events).toContainEqual({
      type: 'IO',
      name: 'WalSync',
    })
    expect(registry.indexWalk.catalogSql).toContain('pg_catalog.pg_index')
  })

  it('selects versioned expectations without special-casing a major in the tool', () => {
    const claim = {
      expected: [
        { from: 13, to: 14, value: 1, unit: '' },
        { from: 15, value: 2, unit: '' },
      ],
    }

    expect(expectedForMajor(claim, 13)).toMatchObject({ value: 1 })
    expect(expectedForMajor(claim, 17)).toMatchObject({ value: 2 })
    expect(expectedForMajor(claim, 19)).toMatchObject({ value: 2 })
  })

  it('normalises PostgreSQL native units before comparing defaults', () => {
    expect(compareSetting(
      { value: 128, unit: 'MB', compare: 'bytes' },
      { boot_val: '16384', unit: '8kB' },
    )).toBe(true)
    expect(compareSetting(
      { value: 60, unit: 's', compare: 'duration' },
      { boot_val: '5', unit: 'min' },
    )).toBe(false)
  })

  it('renders report cells as a pasteable Markdown table', () => {
    const rendered = markdownTable([
      { claim: 'a|b', city: 'one\ntwo', server: 'three', verdict: 'DIVERGES' },
    ])

    expect(rendered).toContain('| Claim | City says | Server said | Verdict |')
    expect(rendered).toContain('a\\|b')
    expect(rendered).toContain('one<br>two')
  })
})
