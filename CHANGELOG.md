# Changelog

All notable changes to PGSimCity are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the model, the layout and the visual language
are all still moving. Expect breaking changes between minor versions.

---

## [0.1.0] — 2026-07-25

First public release. A prototype: it works end to end, and it contains
mistakes.

PGSimCity is an explorable 3D city, running entirely in the browser, in which
every building is a real PostgreSQL mechanism. It is built for engineers who are
good at their job and have never had to operate a database.

### The city

- **Shared memory plaza** at the centre — a 32×32 field of 8 kB page frames whose
  height *is* their clock-sweep `usage_count` and whose colour is their true
  state: free, clean, dirty, pinned. The replacement clock hand sweeps across it,
  and evicted pages visibly collapse and re-rise.
- **`wal_buffers`** drawn as what it actually is, a circular buffer: a ring
  filling clockwise, with the angle between the insert and write arms showing
  exactly how much WAL is unflushed.
- **ProcArray** as a ring of per-backend pillars, with the **xmin horizon** as a
  blade cutting through them. Pin the horizon and the blade sinks and reddens.
- **Lock manager** with its 16 partitions, drawing a taut beam from each waiter
  to the holder it is queued behind.
- **CLOG/SLRU**, the **buffer mapping table**, and the cumulative statistics
  structure, all inside shared memory where they belong.
- **Backend row** — 16 towers, one per connection, whose lighting *is* their
  state, including `idle in transaction`.
- **The excavation**: the ground plane is cut away over the storage district, so
  the plaza visibly floats above the data files 52 m below. Memory above the
  line, disk beneath it, both in one frame.
- **Storage** — heap files as fields of 8 kB pages that grow as they bloat,
  B-trees as actual trees with a linked leaf level, TOAST, the free space map,
  the visibility map, the OS page cache and the disks.
- **WAL district** — walwriter, a vault of 16 MiB segments with real file names
  and real lifecycle states, the archiver, the walsender and logical decoding.
- **Maintenance yard** — checkpointer, background writer, and autovacuum workers
  that drive out to a table, fill their hoppers with dead tuples, and empty them
  at the landfill.
- **Standby** to the south: walsender → wire → walreceiver → startup process,
  with the four replication LSNs readable as four marks on one ruler.
- **Query lab** floating above the backend row: select a backend and its
  statement unfolds through parse → rewrite → plan → execute, with three costed
  candidate plans and the winner lighting up.

### The simulation

- Clock-sweep buffer replacement with real `usage_count` semantics, pinning, and
  dirty eviction by backends when nothing clean can be found.
- WAL with distinct insert, write and flush positions; commit waits that differ
  per `synchronous_commit` level; full-page-write volume that spikes after a
  checkpoint.
- Checkpoints triggered by time or by WAL volume, paced against
  `checkpoint_completion_target`, with a visible fsync phase.
- Autovacuum with per-table thresholds, worker phases, HOT updates that skip
  index maintenance, and an xmin horizon that genuinely blocks cleanup.
- Streaming replication with network delay and independently tracked
  sent/write/flush/replay positions.
- Nine scenarios: checkpoint storm, bloat and vacuum, xmin horizon, cache
  thrash, lock pile-up, replication lag, WAL flood, index vs seq scan, steady
  state.

### Interface

- 52 component explanations written to be read by non-experts, reachable by
  clicking any building.
- A 14-chapter guided tour that flies itself.
- A control rail exposing the real GUCs — `shared_buffers`,
  `checkpoint_timeout`, `max_wal_size`, `synchronous_commit`, `wal_level`,
  `autovacuum_vacuum_scale_factor` and more — each of which actually changes the
  city.
- Command palette (`/`), keyboard help (`?`), live vitals with sparklines, and a
  compass.
- Orbit and fly cameras, arrow-key movement, click to select, double-click to
  fly to.

### Engineering

- three.js r185, TypeScript, Vite. Three runtime dependencies, no framework, no
  CDN, no telemetry, no network calls at all.
- Adaptive quality: the renderer measures its own frame rate and steps down
  rather than stuttering.
- Instanced rendering throughout; the simulation never imports three.js and the
  world never mutates the simulation.
- Apache 2.0, with a `NOTICE` recording that PostgreSQL is a trademark of the
  PostgreSQL Community Association and that this project is not affiliated with
  or endorsed by it.
- Deployed to GitHub Pages on every push to `main`, gated on typecheck and build.

### Known issues

Listed deliberately. These are real, they are being worked on, and reports of
others are welcome.

- **Labels overlap** at some camera distances and become hard to read. The label
  system caps how many are shown but does no screen-space collision detection.
- **Several shared memory structures are effectively unfindable** — `wal_buffers`
  and CLOG among them — because they are labelled only at close range while the
  buffer grid dominates the plaza.
- **The disk array is positioned below the floor of the excavation** and is not
  visible at all. The `ckpt.fsync` traffic therefore terminates inside solid
  geometry.
- **Lock contention understates its own damage.** It blocks only queries against
  the locked table, so throughput dips rather than collapsing. The real
  production mechanism — blocked sessions holding connections until the pool is
  exhausted and unrelated queries stall too — is not modelled yet.
- **WAL-triggered checkpoints fire at the wrong threshold.** PostgreSQL triggers
  at `max_wal_size / (1 + checkpoint_completion_target)`, roughly 53% at the
  default; the model uses the full `max_wal_size`.
- **Pausing drains rather than freezes** in some builds: in-flight particles
  continue to their destinations instead of stopping where they are.
- **First-person walk mode ships but is not reachable** — the controller and
  collision system are present and unwired.
- The **aerial motion of the client tier** reads more like aircraft than like
  data. This is being reworked toward ground-level infrastructure.
- **`og.png` is around 620 KiB**, heavier than a social preview should be.

### Credits

The explanatory material leans on Bruce Momjian's talks, Hironobu Suzuki's
*The Internals of PostgreSQL*, Egor Rogov's *PostgreSQL Internals*, and the
PostgreSQL documentation and source. Any errors are this project's own.

[0.1.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.1.0
