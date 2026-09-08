# PostgreSQL reference review

The city targets the PostgreSQL 18 major line. Its reviewed reference is 18.6;
the separate opt-in PGlite engine remains PostgreSQL 18.3 (PGlite 0.5.4).
Updating the city reference does not update that engine or make the model an
implementation of every PostgreSQL feature.

## Verification boundary

On 2026-09-04, the unchanged oracle ran against PostgreSQL
`18.6 (Debian 18.6-1.pgdg13+2)`, using a local image based on the official
`postgres:18.6` image with Node 22 added. The PostgreSQL image digest was
`sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280`.
The repository was mounted read-only; the harness created and removed its own
throwaway clusters. No existing database was reused.

Before advancing the reference, 223 observations produced 218 matches, four
registered teaching-scale divergences, and one unexpected result: the reviewed
reference still named 18.4. The run took 102.85 seconds on this machine.
The version gate remains strict: a server newer than the reviewed reference
still fails. The four model exceptions are unchanged.

After advancing the reference, the same command produced 223 observations:
219 matches, the same four registered divergences, and zero unexpected results
in 111.44 seconds. No oracle comparisons or exception rules were relaxed.

The oracle covers registered defaults, diagnostic SQL, WAL, locking, memory,
backup/recovery, vacuum/MVCC, and the Machine's owned query examples. Its
coverage and omissions are listed in [ORACLE-AUDIT.md](ORACLE-AUDIT.md).
Passing these observations is not a claim that all PostgreSQL bugs or all city
content are covered by automated tests.

## Release-note review

The [18.6 release notes](https://www.postgresql.org/docs/release/18.6/) cover
changes from 18.4; 18.5 was never released. The following areas intersect the
city's explanations:

- Logical decoding now restricts output plugins through
  `output_plugin_libraries`. The decoder documentation now qualifies third-party
  plugins such as `wal2json` with installation and administrator approval;
  [the parameter's documentation](https://www.postgresql.org/docs/18/runtime-config-replication.html#GUC-OUTPUT-PLUGIN-LIBRARIES)
  is linked beside the explanation. The city does not configure plugins.
- Autovacuum scheduling and failsafe buffer use, local-buffer streaming, and
  free-space-map maintenance received fixes. The oracle checks vacuum reclamation
  and defaults, not the launcher's multi-database scheduling or failsafe ring
  behavior. The city remains a scaled model, not a reproduction of those bugs.
- Visibility-map WAL, incremental backup, timeline changes, standby startup,
  slot lifecycle, and replication progress received fixes. Existing oracle
  exercises continue to check their registered mechanisms; they do not inject
  torn pages, every concurrency race, or the complete incremental-backup path.
- Planner, datatype, security, extension, client, and statistics fixes do not
  justify claiming those internals are executed by the city. PGlite remains a
  separate measured evidence source with its own disclosed version.

This review advances the reference only within those boundaries. Independent
release review is still required; this author-produced record is evidence for
that review, not its substitute.
