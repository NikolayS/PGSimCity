import { describe, expect, it } from 'vitest'
import { BY_ID, catalogReference, VERSIONS } from './catalog'

describe('PostgreSQL 19 reference catalog, independent of the city model', () => {
  it('offers 19 without removing 18', () => {
    expect(VERSIONS).toContain(19)
    expect(VERSIONS).toContain(18)
  })
  it('selects the new WAL byte counter only for the 19 reference', () => {
    const entry = BY_ID.get('pg_stat_wal')!
    expect(catalogReference(entry, 19).columns).toEqual([
      'wal_records', 'wal_fpi', 'wal_bytes', 'wal_fpi_bytes', 'wal_buffers_full', 'stats_reset',
    ])
    expect(catalogReference(entry, 18).columns).not.toContain('wal_fpi_bytes')
    expect(entry.columns).not.toContain('wal_fpi_bytes')
  })
  it('adds vacuum initiation fields without manufacturing model rows', () => {
    expect(catalogReference(BY_ID.get('pg_stat_progress_vacuum')!, 19).columns.slice(-2))
      .toEqual(['mode', 'started_by'])
    for (const id of ['pg_stat_lock', 'pg_stat_recovery', 'pg_stat_autovacuum_scores']) {
      const entry = BY_ID.get(id)!
      expect(entry.since).toBe(19)
      expect(entry.coverage).toBe('absent')
      expect(entry.projection).toBeUndefined()
      expect(catalogReference(entry, 19).major).toBe(19)
    }
  })
  it('does not relabel unreviewed references or older-version filters as PG19', () => {
    expect(catalogReference(BY_ID.get('pg_stat_statements')!, 19).major).toBe(18)
    expect(catalogReference(BY_ID.get('pg_stat_wal')!, 17).major).toBe(18)
  })
})
