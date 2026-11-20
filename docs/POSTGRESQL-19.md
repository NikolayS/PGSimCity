# PostgreSQL 19 support boundary

PGSimCity supports a **PostgreSQL 19 diagnostic reference surface**, not a
PostgreSQL 19 city simulator or SQL runtime. The city continues to model the
reviewed PostgreSQL 18.6 baseline; its existing scenarios and graphics are
unchanged. The optional PGlite 0.5.4 engine remains PostgreSQL 18.3, reported
separately by `SELECT version()`. Selecting 19 never upgrades that engine.

## What selecting 19 changes

In Diagnose, choose **19** in the instrument version rail. These cards show
PostgreSQL 19 column lists, documentation links and copyable SQL for a real
PostgreSQL 19 server:

- `pg_stat_wal`, including `wal_fpi_bytes`.
- `pg_stat_progress_vacuum`, including `started_by` and `mode`.
- `pg_stat_lock`, `pg_stat_recovery` and `pg_stat_autovacuum_scores`.

The new views have **absent** model coverage. Existing model grids do not grow
invented values for new columns. Unreviewed instrument shapes explicitly retain
their PostgreSQL 18 reference label, even with the 19 filter selected. Older
filters indicate object availability, not reconstructed older column lists.
PostgreSQL 18 remains the initial selection. Existing diagnostic SQL is checked
on 19 by the dedicated oracle CI job; it does not exercise a 19 query planner
inside the city.

## Mechanism inventory

The following materially different PostgreSQL 19 mechanisms are outside the
current model. The 19 instrument cards display this boundary at point of use.

| Mechanism | PostgreSQL 19 | City / Machine boundary |
| --- | --- | --- |
| Autovacuum scheduling | Score-based table prioritization | Existing simplified scheduling; no XID/MXID priority score calculation |
| Index autovacuum | Parallel workers and shared cost-delay budget | No parallel index vacuum execution or shared-worker delay accounting |
| Visibility map | Eligible table scans can set all-visible bits | No PG19 scan-driven visibility-map transition |
| Asynchronous I/O | Adaptive worker pool replaces `io_workers` | No adaptive worker lifecycle; existing scaled I/O remains unchanged |
| Logical decoding | Effective WAL level can rise from replica without restart | No `effective_wal_level` transition; existing logical stream is a teaching model |
| Physical rewrite | `REPACK`, including concurrent operation | No REPACK execution or progress projection |
| Standby consistency | `WAIT FOR LSN` | Bounded replay-rate model, no waiting SQL sessions or standby query results |
| Logical replication | Sequence replication | Not modeled |
| Planner | Advice extensions and new planner optimizations | Fixed teaching plans; PGlite plans remain those of its actual 18.3 engine |
| Defaults / compatibility | JIT off, changed lock allocation, TOAST compression and string settings | No automatic retuning or claim of PG19 default fidelity |

Unchanged WAL-before-data, MVCC and checkpoint concepts remain useful lessons,
not proof that all PostgreSQL 19 execution behavior is represented.

## Validation

`src/observability/catalog-pg19.test.ts` checks version separation, new fields,
absent coverage and preservation of the 18 reference. The
`PostgreSQL 19 reference support` workflow builds the checksum-verified official PostgreSQL 19.0 release and runs the oracle,
checking exact column order and executing the displayed reference SELECT lists,
plus the existing diagnostic SQL checks. The PostgreSQL 18 lifecycle oracle
continues independently; the new job does not claim to validate PG19 simulation.

For an isolated installed PostgreSQL 19 toolchain:

```sh
PG_VERSION=19 PG_BIN=/path/to/postgresql19/bin \
  PG_ORACLE_ONLY='PostgreSQL 19 reference,diagnostic SQL' \
  PG_ORACLE_ALL=1 npm run oracle
```

## Primary references

- [PostgreSQL 19 release notes](https://www.postgresql.org/docs/19/release-19.html)
- [PostgreSQL 19 statistics](https://www.postgresql.org/docs/19/monitoring-stats.html)
- [PostgreSQL 19 progress reporting](https://www.postgresql.org/docs/19/progress-reporting.html)
- [PostgreSQL 19 system view definitions](https://github.com/postgres/postgres/blob/REL_19_STABLE/src/backend/catalog/system_views.sql)
