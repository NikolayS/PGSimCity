# Changelog

All notable changes to PGSimCity are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the model, the layout and the visual language
are all still moving. Expect breaking changes between minor versions.

---

## [0.2.0] — 2026-07-26

You can walk into it now. Still a prototype, still contains mistakes, and this
release names the ones we know about.

### Added

- **First person.** Press `G` and drop into the city at eye height — walk, run,
  crouch, jump. Collision is derived automatically from the component registry's
  bounding boxes, so every building is solid without per-district authoring.
- **The plaza is reachable on foot.** It was an island: its edge sits 40 m from
  solid ground across the 52 m excavation. Four ramped causeways now cross it at
  1:14, landing in the corridors that are clear of deck furniture, with gates cut
  in the previously continuous railing. Every route was verified by walking a
  capsule through the real collision world in code — 17 of 17 passed, and the
  parapet stops you 0.25 m short of the drop.
- **A descent into the excavation** — seven flights, 301 treads, from the pit rim
  to the `$PGDATA` floor. At the bottom, a sign reads *"shared memory is 52 m
  above you"*, and the plaza's pylons are overhead.
- **The continuity quarter**: anchors for base backups, point-in-time recovery
  and failover — an archive estate with a timeline switchyard, a recovery ground
  on separate iron a haul road away, and an HA quarter with a consensus store and
  three lease posts. Geometry follows.
- **A server boundary.** Clients now sit outside a fence with the gatehouse as
  `pg_hba.conf`. Previously the application tier was drawn as a district *of* the
  database, which every canonical Postgres diagram is explicit about.
- Apache 2.0 licence, a `NOTICE` with the PostgreSQL trademark disclaimer, an
  original elephant mark, favicon set and social preview.

### Changed

- **The city no longer reads as an aerial assault.** Clients came down to ground
  level, the replication link stopped arcing to y=46 and became a duct bank at
  grade, the selection marker stopped being four breathing corner brackets — a
  weapons reticle — and became a surveyor's setting-out drawing, and the blinking
  aviation beacons are gone. Red now appears only where it means something
  specific, above all the dirty page.
- **Left-drag pans, right-drag orbits.** Map convention, not CAD convention. Both
  old habits still work via middle-drag and `Ctrl`-left-drag.
- **Labels place themselves like a map.** Five zoom levels with cross-fade,
  screen-space collision, leader lines, wall-clock hysteresis, and a `+N` pill so
  a district can never read as empty. The establishing shot went from 26 labels
  with 9 overlapping pairs to 9 with none; the backend row from 29 overlapping
  pairs to one.
- **`autovacuum_vacuum_scale_factor` ships at 0.02**, not PostgreSQL's 0.2. At
  stock the demo tables need ~5,900 dead row versions to cross the threshold —
  roughly an hour at 10 tps — so the vacuum yard would be dead for a whole visit.
  0.02 is what the documentation recommends per-table for a busy relation.
- Default workload is 10 tps at 20% writes, so a single transaction can be
  followed end to end.

### Fixed

- **66 verified PostgreSQL corrections**, after four specialists reviewed every
  word and a second panel cross-examined each contested finding. The worst class
  is gone: catalog objects that did not exist — `SLRU` as a `wait_event_type`,
  `TransactionBuffer`, an Analyze phase in `pg_stat_progress_vacuum`. Also: the
  full-page-image surge begins when a checkpoint *starts*, recycled WAL segments
  are not zeroed, WAL insertion takes the lock before reserving space, the xmin
  horizon is per-database, and `synchronous_commit = on` is a *local* flush
  guarantee.
- **Binary units.** `fmtBytes()` divided by 1024 and labelled the result kB/MB/GB.
  Now KiB/MiB/GiB everywhere, except inside quoted PostgreSQL config values.
- **Pause froze nothing.** The frame loop scaled simulated time but handed real
  time to the world and the particles, so pausing drained rather than stopping,
  and `timeScale` desynchronised the two clocks.
- A WebGL context leak in the support probe, teardown firing on bfcache restore,
  the fps meter measuring the clamped delta it was designed to hide stalls with,
  and districts lit only by neon collapsing to black silhouettes at low quality.
- The quality selector did nothing at all.
- The top-bar vitals danced on every update.

### Known issues

- **Cache hit ratio reads about 57%**, which is not what an OLTP database looks
  like. Two compounding defects: the gauge is a time-average of ratios rather
  than `blks_hit/(blks_hit+blks_read)`, and the working set is sized so the
  `shared_buffers` slider never leaves the steep part of the curve.
- **Achieved throughput does not respond to bottlenecks.** A batch controller
  cancels them out, so lock contention, tiny `shared_buffers` and slow commits
  all fail to reduce committed transactions. The causes are simulated correctly;
  the effect is unreachable.
- WAL-triggered checkpoints fire at the full `max_wal_size` rather than
  `max_wal_size / (1 + checkpoint_completion_target)`.
- The shared-buffer grid saturates to white under heavy load and stops encoding
  state — exactly when the city gets interesting.
- Mobile layout: panels cover most of the viewport ([#1]).
- The minimap paints over the guided-tour caption.
- Walk mode inherits the flying camera's downward pitch on entry.

[#1]: https://github.com/NikolayS/PGSimCity/issues/1
[0.2.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.2.0

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
