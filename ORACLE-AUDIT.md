# PostgreSQL oracle automation and boundary

## Automation decision

The oracle runs nightly and on manual dispatch in a `postgres:18` job
container. The container supplies the same PostgreSQL 18 `initdb`, `postgres`,
`pg_ctl`, `pg_basebackup`, and `psql` binaries that the local throwaway-cluster
path uses. The harness still creates and removes its own primary and standby;
it does not borrow the image entrypoint's server.

Measurements were taken on Ubuntu 24.04 on 2026-08-03 with the Docker and PGDG
caches initially cold:

| Route | Measured provisioning | Measured oracle | Decision |
|---|---:|---:|---|
| `postgres:18` service | 6.07 s cold image pull plus 2.60 s to readiness | Not viable alone | The physical-slot audit still needs PostgreSQL 18 `pg_basebackup`, `pg_ctl`, `postgres`, and `psql` outside the provided primary. Moving those lifecycle operations across the container boundary would add code without removing the binary requirement. |
| PGDG on Ubuntu 24.04 | 34.29 s to add PGDG and install PostgreSQL 18.4 | 40.67 s locally, about 74.96 s combined | Preserves the harness but spends almost another oracle run provisioning packages. |
| `postgres:18` job container | 6.07 s cold pull; 42.17 s warm container start plus unchanged oracle, about 48.24 s combined | 41.36 s reported by the harness | Chosen. It preserves all lifecycle checks with no harness branch and no PGDG setup. Checkout, Node setup, and `npm ci` are common workflow overhead and are not included in these route measurements. |

This is a nightly audit rather than a push gate. Repeating a fixed-server audit
on every source push spends the same PostgreSQL startup and fixture cost, while
a nightly run bounds detection to one day and lets a moving `postgres:18` tag
audit a newly released minor. `workflow_dispatch` supports immediate checks
after a relevant claim change.

An unexpected result exits nonzero, makes the workflow red, and opens one
deduplicated `PostgreSQL oracle divergence` issue containing the pasteable
report and run link. Later failures update that issue; recovery comments on and
closes it. Four teaching-scale model defaults are explicitly registered and
reported as `REGISTERED DIVERGENCE`. They do not fail the audit; any other
difference, or an unexpected match of one of those four, does.

At measurement time the floating image supplied PostgreSQL 18.4 while
`CLAIM_VALUES.postgresqlVersion` named PostgreSQL 18.3. The resulting version
difference is intentionally actionable; it is not added to the four model
exceptions.

## Expansion result

The server-checkable scope below is now implemented by `tools/pg-oracle.mjs`.
The expanded PostgreSQL 18.3 run made 188 observations in 61.58 seconds: 183
matched, four were the existing registered model divergences, and one was a new
finding. `src/ui/tour.ts` says real VACUUM truncation needs a lock, the server
demonstrated that `ACCESS SHARE` prevents tail truncation until the holder
releases it, but `CLAIM_VALUES.vacuumReclaim` does not register that facet.

The same harness made 188 observations against PostgreSQL 18.4 in 63.17
seconds. The only additional divergence was the explicit PostgreSQL 18.3
reference pin. None of the other checked city claims moved between 18.3 and
18.4.

## Survey boundary

For this survey, **server-checkable** means a controlled fixture can obtain a
repeatable verdict from stock PostgreSQL 18, its shipped client utilities, and
bundled contrib extensions. It does not include reading PostgreSQL source or
documentation, running PgBouncer/WAL-G/pgBackRest/PGlite, benchmarking elapsed
time, or checking PGSimCity's TypeScript and browser behavior. Those need a
different verifier even when the underlying prose is true.

The existing oracle already owns GUC values and contexts, catalog/view shapes,
wait-event names, `pg_stat_io` projections, Diagnose SQL executability, index
attributes, the registered model defaults, and its current MVCC/storage
experiments. The items below define the expansion boundary that the oracle now
implements.

### Server-checkable expansion scope

| Registry claim | Mechanically checkable remainder | Boundary inside the claim |
|---|---|---|
| `walSegment` | Compare `wal_segment_size`, WAL file naming/offsets, and an actual segment's size with 16 MiB. | The painted label and model constant remain repository checks. |
| `modelLatency` | Stage coordinated relation-lock and synchronous-replication waits and verify the claimed `pg_stat_activity` type/name mapping; verify that pool wait is absent from PostgreSQL activity. | Model quantiles, the 512-trip window, phase attribution, batching, 30 Hz resolution, and the meaning of an `active`/null-wait sample are model or interpretive claims. |
| `connectionPooler` | With two server sessions, exercise the connection-local behavior beneath the warning: session GUCs, advisory locks, SQL `PREPARE`, and `LISTEN` stay with a backend, while `NOTIFY` can be sent. | PgBouncer defaults, pooling modes, admission, timeout, prepared-statement tracking, multiplexing, and all model scales require PgBouncer or PGSimCity, not a PostgreSQL server alone. |
| `workMem` | Use controlled plans with multiple Sort/Hash nodes to observe per-node memory, hash multiplication, temp spill, and concurrent-backend multiplication. | The existing default checks already cover `work_mem` and `hash_mem_multiplier`; the example MiB budgets, tenfold slowdown, fixed nodes, and absent planner features are model choices. |
| `restoreDrill` | Using PostgreSQL utilities, prove that a physical backup is cluster-wide, replay to a recovery target, run row witnesses, inspect `pg_verifybackup`, and demonstrate `pg_dump -t`/`pg_restore -t` dependency behavior. | Evidence ranks, cadence examples, modeled digests/three-block reads/time/cost, WAL-G, pgBackRest, credentials, endpoint cutover, and business correctness are outside a stock-server oracle. |
| `timelineRecovery` | Build a two-timeline archive and test `latest`/`current`, history-file discovery, use of a pre-fork backup, exclusion of a parent's post-fork tail, and reached/not-reached targets. | The default is already covered. One-fork model depth, plate copy, enumerated absences, credentials, and wider unsupported interactions are PGSimCity coverage claims. |
| `vacuumReclaim` | Create interior and trailing empty pages, run plain `VACUUM`, and compare free space and relation size to show reuse versus tail truncation. | The city's truncation timing and landfill geometry remain model checks. |
| `mvccVocabulary` | Extend the existing `pageinspect` work to stage creator/deleter/locker/MultiXact `xmin`/`xmax`, `ctid` update links, line-pointer states and sizes, tuple-header fields, HOT redirects, dead-versus-removable horizons, visibility-map set/clear effects, horizon constraints, and the exact external TOAST pointer size/read paths. | Source-layout declarations that cannot be exposed or inferred by the shipped server, prose completeness, and PGSimCity's drawn tuple/page geometry remain source or application review. |
| `machineSynchronousCommitComparison` | On a controlled server, observe `synchronous_commit = off` acknowledgment ahead of the local flush and later WAL flush; crash experiments can demonstrate possible recent acknowledged loss and transaction atomicity. | The model's route, its comparison receipt, the PGlite limitation, and an exact timing/loss bound are not deterministic server-oracle verdicts. |
| `machineIndexWalk` | Run the seeded statements to verify partial-predicate implication, returned rows, and target-version plan nodes for the owner and primary-key lookups. | The current oracle covers catalog attributes, not this measured sequence. The original PGlite receipt, buffer counts, one-connection sequencing, and replay disclosures require PGlite or application checks. |

### Not checkable against a PostgreSQL server

| Registry claim | Reason it belongs elsewhere |
|---|---|
| `appVersion` | Build metadata and its rendered surfaces are repository facts. |
| `bufferSample`, `bulkReadRing` | Frame counts and the fixed ring are teaching-scale simulation and visualization choices. The PostgreSQL `shared_buffers` default is already checked separately. |
| Remaining `checkpointPolicy` | The two model values are already registered divergences; the `partners` relationship is UI/model wiring. |
| `standbyNames` | `standbyA`/`standby_a` are PGSimCity identities, not PostgreSQL-defined names. |
| `modelDuration` | `model s`, `model ms`, and formatting are application units. |
| `cityComponentRoute`, `componentNaming`, `eventConvention` | URL, registry, bus, and browser conventions exist only in PGSimCity. |
| `diagnoseBranchGates` | The input views can be server-checked, but 20/25/30/55/92 percent and byte/second cutoffs are product heuristics, not PostgreSQL invariants. Branch wiring is an application test. |
| Remaining `postgresqlVersion` | The server version is already checked; manual URLs, source-branch strings, and cross-surface labels are repository/documentation checks. |
| `pgliteVersion` | PGlite provenance requires the package lock and a PGlite execution, not the PostgreSQL 18 server. |
| `markdownRendering` | Markdown behavior belongs to the UI renderer. |
| `reviewStatus` | Review-round counts and labels come from project history. |
| `postgresqlOracle` | This is the registry-to-tool wiring contract itself; its verifier is the test suite and workflow wiring, not the database. |

The rule for future additions is therefore: register a claim with the oracle
only when a stock target server can return a stable, exact observation for it.
Model calibration, product heuristics, third-party behavior, documentation
semantics, and UI/source conventions stay outside even if a server experiment
can illustrate them.
