# Model accuracy and limitations

PGSimCity is still **0.x**: early and moving. The 3D city is a *model* of
PostgreSQL, not an emulator: no PostgreSQL source code runs in that city, and
the numbers are scaled so a human can watch them. The opt-in Query flow and
[Machine](https://nikolays.github.io/PGSimCity/machine/) can run PGlite, a real in-memory PostgreSQL compiled to
WebAssembly.

PGSimCity targets the PostgreSQL 18 major line. PostgreSQL 18.6 is the
reviewed reference release against which its claims were verified; mechanism
claims follow the [`REL_18_STABLE` source](https://github.com/postgres/postgres/tree/REL_18_STABLE).
For example, PostgreSQL 18's bulk-read strategy starts at 256 KiB and grows
with `io_combine_limit × effective_io_concurrency`, subject to its caps
([`GetAccessStrategy`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/storage/buffer/freelist.c#L505-L611)).
The current TypeScript buffer sample still uses a fixed 32-frame ring: that is
a disclosed historical simplification for the animation, not PostgreSQL 18's
ring-sizing rule. The animation must not be used as numeric version evidence
until that model is aligned.

Four review rounds have checked the project: three specialist reviews compared PostgreSQL
correctness with `postgresql.org/docs` and the source rather than memory, and a separate audit
treated buildings, adjacencies, and animations as claims. Every finding was independently checked
by a reviewer tasked with refuting it.

The deterministic suite fails CI on a red test. Its checks pin the model's scaled WAL
trigger approximation as `max_wal_size / (1 + checkpoint_completion_target)` at every
call site. PostgreSQL 18 calculates the moving threshold in whole WAL segments through
`ConvertToXSegs(max_wal_size_mb) / (1 + checkpoint_completion_target)` and therefore
rounds it ([`CalculateCheckpointSegments`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/access/transam/xlog.c#L2166-L2197)).
The suite also pins cache hit ratio as `blks_hit / (blks_hit + blks_read)` and the
clock-sweep `usage_count` cap at 5.

Mistakes have been found and fixed throughout; the commit history records them. Known limitation:
touch controls have been verified only in Chrome's mobile emulation. Corrections from people who
know the engine are exactly what this needs: [open the correction template](https://github.com/NikolayS/PGSimCity/issues/new?template=postgresql-mismatch.md)
or send a [pull request](https://github.com/NikolayS/PGSimCity/pulls).

[Back to the README](../README.md).
