import { describe, expect, it } from 'vitest'

import {
  checkGucContexts,
  compareSetting,
  expectedForMajor,
  indexWalkAttributeChecks,
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
    expect(registry.claims.pgStatIo.projectionRows).toContainEqual({
      backendType: 'checkpointer',
      object: 'relation',
      context: 'normal',
      operations: ['writes', 'writebacks', 'fsyncs'],
    })
    expect(registry.claims.pgStatIo.projectionRows).toContainEqual({
      backendType: 'background writer',
      object: 'relation',
      context: 'normal',
      operations: ['writes', 'writebacks', 'fsyncs'],
    })
    expect(registry.claims.autovacuumThreshold).toMatchObject({
      reltuples: 1_000,
      liveTuples: 1_700,
      deadTuples: 300,
    })
    expect(registry.claims.checkpointTimerSkip).toMatchObject({
      since: 18,
      timeoutSeconds: 30,
    })
    expect(registry.claims.gucDefaults).toContainEqual(
      expect.objectContaining({ setting: 'autovacuum_vacuum_max_threshold' }),
    )
    expect(registry.claims.gucContexts.map((claim) => claim.setting)).toEqual([
      'shared_buffers',
      'wal_buffers',
      'max_connections',
      'max_locks_per_transaction',
      'max_prepared_transactions',
      'max_wal_senders',
      'max_replication_slots',
      'checkpoint_timeout',
      'checkpoint_completion_target',
      'max_wal_size',
      'bgwriter_lru_maxpages',
      'bgwriter_delay',
      'synchronous_commit',
      'synchronous_standby_names',
      'wal_level',
      'full_page_writes',
      'autovacuum',
      'autovacuum_vacuum_scale_factor',
      'autovacuum_max_workers',
      'track_io_timing',
      'logging_collector',
      'shared_preload_libraries',
    ])
    expect(registry.indexWalk.catalogSql).toContain('pg_catalog.pg_index')
  })

  it('qualifies the autovacuum worker context at its PostgreSQL 18 boundary', async () => {
    const registry = await loadOracleRegistry()
    const claim = registry.claims.gucContexts.find(
      (candidate) => candidate.setting === 'autovacuum_max_workers',
    )

    expect(claim.cityClaim).toMatch(/PostgreSQL 17.*postmaster.*PostgreSQL 18.*sighup/is)
    expect(expectedForMajor(claim, 13)).toMatchObject({ context: 'postmaster' })
    expect(expectedForMajor(claim, 17)).toMatchObject({ context: 'postmaster' })
    expect(expectedForMajor(claim, 18)).toMatchObject({ context: 'sighup' })
  })

  it('compares registered contexts with pg_settings in one query', async () => {
    const query = async () => [
      { name: 'stable_setting', context: 'sighup' },
      { name: 'changed_setting', context: 'postmaster' },
    ]
    const registry = {
      claims: {
        gucContexts: [
          {
            setting: 'stable_setting',
            cityClaim: 'reloadable',
            expected: { context: 'sighup' },
          },
          {
            setting: 'changed_setting',
            cityClaim: 'version-qualified',
            expected: [
              { from: 13, to: 17, context: 'postmaster' },
              { from: 18, context: 'sighup' },
            ],
          },
        ],
      },
    }

    await expect(checkGucContexts(query, registry, 17)).resolves.toEqual([
      {
        claim: 'GUC-context/stable_setting',
        city: 'reloadable: sighup',
        server: 'sighup',
        verdict: 'MATCH',
      },
      {
        claim: 'GUC-context/changed_setting',
        city: 'version-qualified: postmaster',
        server: 'postmaster',
        verdict: 'MATCH',
      },
    ])
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

  it('renders pasteable reports and gates every index usability attribute', () => {
    const rendered = markdownTable([
      { claim: 'a|b', city: 'one\ntwo', server: 'three', verdict: 'DIVERGES' },
    ])

    expect(rendered).toContain('| Claim | City says | Server said | Verdict |')
    expect(rendered).toContain('a\\|b')
    expect(rendered).toContain('one<br>two')

    const index = (
      index_name,
      index_definition,
      {
        access_method = 'btree',
        uniqueness = 'non-unique',
        validity = 'valid',
        predicate = null,
      } = {},
    ) => ({
      index_name,
      access_method,
      uniqueness,
      validity,
      predicate,
      index_definition,
    })
    const serverRows = [
      index('accounts_tenant_owner_idx', 'CREATE INDEX accounts_tenant_owner_idx ON oracle_fixture.accounts USING btree (tenant_id, owner)'),
      index('accounts_owner_include_idx', 'CREATE INDEX accounts_owner_include_idx ON oracle_fixture.accounts USING btree (owner) INCLUDE (balance, email)'),
      index('accounts_lower_owner_idx', 'CREATE INDEX accounts_lower_owner_idx ON oracle_fixture.accounts USING btree (lower(owner))'),
      index(
        'accounts_open_balance_idx',
        'CREATE INDEX accounts_open_balance_idx ON oracle_fixture.accounts USING btree (balance) WHERE (deleted_at IS NULL)',
        { predicate: '(deleted_at IS NULL)' },
      ),
      index('accounts_hash_idx', 'CREATE INDEX accounts_hash_idx ON oracle_fixture.accounts USING hash (owner)', { access_method: 'hash' }),
      index('accounts_collate_idx', 'CREATE INDEX accounts_collate_idx ON oracle_fixture.accounts USING btree (owner COLLATE "C")'),
      index('accounts_opclass_idx', 'CREATE INDEX accounts_opclass_idx ON oracle_fixture.accounts USING btree (owner text_pattern_ops)'),
      index('accounts_desc_idx', 'CREATE INDEX accounts_desc_idx ON oracle_fixture.accounts USING btree (balance DESC NULLS LAST)'),
      index('accounts_modifiers_idx', 'CREATE INDEX accounts_modifiers_idx ON oracle_fixture.accounts USING btree (owner COLLATE "C" text_pattern_ops DESC)'),
      index('accounts_metadata_gin_idx', 'CREATE INDEX accounts_metadata_gin_idx ON oracle_fixture.accounts USING gin (metadata)', { access_method: 'gin' }),
      index('accounts_created_brin_idx', 'CREATE INDEX accounts_created_brin_idx ON oracle_fixture.accounts USING brin (created_at)', { access_method: 'brin' }),
      index('accounts_pkey', 'CREATE UNIQUE INDEX accounts_pkey ON oracle_fixture.accounts USING btree (id)', { uniqueness: 'unique' }),
      index('accounts_invalid_owner_idx', 'CREATE UNIQUE INDEX accounts_invalid_owner_idx ON oracle_fixture.accounts USING btree (owner)', { uniqueness: 'unique', validity: 'INVALID' }),
    ]
    const catalogSql = 'SELECT pg_catalog.pg_get_indexdef(i.indexrelid) FROM pg_catalog.pg_index AS i'
    const check = (rows = serverRows, sql = catalogSql) =>
      indexWalkAttributeChecks(rows, serverRows, sql)
    const byClaim = (rows = serverRows, sql = catalogSql) =>
      new Map(check(rows, sql).map((entry) => [entry.claim, entry.verdict]))

    expect(check().map((entry) => entry.claim)).toEqual([
      'index-walk/composite-key-order',
      'index-walk/include-columns',
      'index-walk/expression-key',
      'index-walk/partial-predicate',
      'index-walk/non-btree-access-method',
      'index-walk/collation',
      'index-walk/operator-class',
      'index-walk/key-ordering',
      'index-walk/combined-modifiers',
      'index-walk/uniqueness',
      'index-walk/invalid-index',
    ])
    expect(check().every((entry) => entry.verdict === 'MATCH')).toBe(true)

    const mutate = (name, field, value) => serverRows.map((row) =>
      row.index_name === name ? { ...row, [field]: value } : row)
    expect(byClaim(mutate('accounts_tenant_owner_idx', 'index_definition', '(owner, tenant_id)')).get('index-walk/composite-key-order')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_owner_include_idx', 'index_definition', '(owner)')).get('index-walk/include-columns')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_lower_owner_idx', 'index_definition', '(owner)')).get('index-walk/expression-key')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_open_balance_idx', 'predicate', null)).get('index-walk/partial-predicate')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_hash_idx', 'access_method', 'btree')).get('index-walk/non-btree-access-method')).toBe('DIVERGES')
    expect(byClaim(serverRows, `${catalogSql}, k.position` ).get('index-walk/non-btree-access-method')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_collate_idx', 'index_definition', '(owner)')).get('index-walk/collation')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_opclass_idx', 'index_definition', '(owner)')).get('index-walk/operator-class')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_desc_idx', 'index_definition', '(balance)')).get('index-walk/key-ordering')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_modifiers_idx', 'index_definition', '(owner)')).get('index-walk/combined-modifiers')).toBe('DIVERGES')
    expect(byClaim(mutate('accounts_pkey', 'uniqueness', 'non-unique')).get('index-walk/uniqueness')).toBe('DIVERGES')
    expect(byClaim(serverRows.filter((row) => row.validity !== 'INVALID')).get('index-walk/invalid-index')).toBe('DIVERGES')
  })
})
