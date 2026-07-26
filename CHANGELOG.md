# Changelog

All notable changes to PGSimCity are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the model, the layout and the visual language
are all still moving. Expect breaking changes between minor versions.

---

## [0.5.0] — 2026-07-26

Daylight arrives, and the city stops going dark on ordinary hardware.

### Fixed

- **The city no longer goes black when the frame rate drops.** A user sent two
  screenshots side by side: a vivid city at `medium` quality, and near-black
  silhouettes on the same build. The night theme's whole visual language rides
  on the bloom pass — structure is matte, meaning is neon, and only emissive
  above 1.0 crosses the threshold — so turning bloom off did not dim the city,
  it stopped it communicating. And it was automatic, which meant the people who
  saw it were those on the weakest hardware. Bloom is now the **last** thing
  dropped: a new `reduced` tier turns down pixel ratio, particles, labels and
  antialiasing while keeping the lighting, and measures about 40% faster than
  `medium`. Below that, neon repaints as saturated base colour with a minimum
  luminance, so a dirty page still reads as dirty.
- **The quality downgrade no longer fires on a boot stall.** Three seconds
  ignored, a four-second settle, then three sustained seconds under the floor.
  The notice now names what was lost and offers one click to undo it.
- **Labels no longer draw through solid buildings.** They are DOM elements
  positioned by `CSS2DRenderer`, so they never took part in depth testing; a
  label behind a tower had always drawn over it. They are now occluded by
  raycasting against the collision structure the walker already maintains,
  amortised across frames and faded rather than snapped.
- **`$PGDATA` is gone from the user-facing text.** It names an environment
  variable, and in a configuration where it points at a config-only directory
  the data lives elsewhere. The excavation is the **data directory**. A test
  holds the line — and immediately caught a regression that a later merge
  reintroduced.

### Added

- **A daylight theme for the city, not just the panels.** Day mode used to stop
  at the edge of the UI: paper panels over a city still lit for night. It is now
  a sunlit model in the spirit of SimCity — flat saturated colour with a hard
  split between the lit and shaded faces of every mass, a warm directional sun
  casting real shadows from 172 architectural casters (about 4% of frame time,
  with the buffer field excluded because its heights change every frame), light
  ground the city sits on top of, and **districts wearing their semantic colours
  as zones** so the layout can be read from altitude before a single label.
  Night's rule is structure matte, meaning neon; day's is structure sunlit,
  meaning saturated. The colours keep their meanings exactly.
- **A visible theme switcher.** Daylight was toggled by pressing `N` and by
  nothing else — undiscoverable on a desktop and unreachable on a phone.
- **Google Maps mouse convention.** Left-drag pans, shift-left-drag rotates and
  tilts, and right-click is freed for a **context menu** that offers what the
  thing under the cursor actually supports — including opening the page anatomy
  view directly from a heap file or an index, which is a better home for it than
  any panel. Touch is unchanged.
- **`CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`.** Every rule carries the
  reason it exists, because a rule without one gets dropped the first time it is
  inconvenient. Red/green TDD is mandatory and CI fails the build on a red test.

### Known issues

- Cache hit ratio settles near 87% where a healthy production system sits at
  98–99%.
- The touch controls have been verified only in Chrome's mobile emulation, which
  differs from iOS Safari in touch handling and viewport units.

---

## [0.4.0] — 2026-07-26

The buildings start telling the truth, and the elephant comes back.

### Fixed — the geometry

The prose in this city had been through two rounds of expert review. The
geometry had been through none. A geometry-truth audit — four PostgreSQL
specialists auditing buildings, adjacencies, animations and scale as *claims*
rather than reading the text beside them — found the city contradicting its own
documentation in places where a reader would believe the building.

- **The xmin horizon blade floated above every active backend.** It was computed
  independently of the PGPROC pillars it cuts through, so fourteen backends
  could all sit below the "oldest transaction ID anyone can still see" plane —
  arithmetically impossible, and an inversion of the single lesson that
  structure exists to teach.
- **The OS page cache was drawn inside the excavation**, below a line the city's
  own signage says separates memory from durable storage. It is volatile kernel
  memory outside PostgreSQL's address space. `pg_wal` broke the same line in the
  other direction — printed on the pit floor as a data-directory subdirectory
  while built as a surface vault outside the cut.
- **`archive_command` was built twice**, with archived WAL parked in two stores
  in series, teaching a two-stage archive pipeline PostgreSQL does not have.
- **TOAST sliced before it compressed.** PostgreSQL compresses first and slices
  only what still does not fit.
- **Index maintenance flew from the index into the heap**, and the
  buffer-mapping probe ran backwards.
- **The LSN ruler displayed an equation its own rows failed to satisfy** — the
  lag bar spanned standby-flush→replay while the byte count beside it was
  computed from primary-flush→replay.
- **Cumulative statistics was a rolling sixty-bar time series.** PostgreSQL
  keeps monotonic counters and no history whatsoever.

### Fixed — the plate

- **The Slonik plate is the real mark again.** v0.3.0 built the outline from the
  blue fill path of the genuine PostgreSQL SVG. The commit that followed it —
  titled "trace the plate from the real PostgreSQL logo artwork" — replaced that
  vector data with hand-authored control points, which is the opposite of what
  its message claims. Four later passes then edited the hand drawing, each
  widening it slightly to satisfy the containment audit, until the trunk was 3%
  of the plate's height and the silhouette was a rounded blob. The vector data
  is restored: front-on head, both ears, both tusks, trunk down the centreline.

### Added

- **Sound.** The audio engine had existed for some time as 505 lines that
  nothing imported. It is now driven from the walk controller, so footstep
  cadence comes from distance travelled and surfaces are read from what the
  collision layer says is underfoot. Off by default.
- **Swimming in the buffer pool (`shared_buffers`).** The plaza is 1,024 page
  frames whose height is their clock-sweep `usage_count` and whose colour is
  their state. You can now be inside it, at the scale of the pages.
- **Walking and swimming on a phone.** Pointer lock does not exist on iOS
  Safari, so first person was unreachable on mobile. There are now thumb
  controls: a stick that appears where the thumb lands, and look-by-drag with
  sensitivity in degrees per centimetre so it feels the same on any screen.
- **`tools/plot-plate.mjs`** — prints the plate's silhouette, bounding box and
  trunk proportion straight from the source in about two seconds. Five attempts
  at the shape had been judged through a seventy-second software render with the
  side panels covering two thirds of the frame, which is why none of them could
  iterate.
- The page-anatomy and data-directory views now open from where their question
  arises, rather than from a tab strip pinned to a corner.

### Changed

- The panel design drops the coloured accent bars, and then the corner brackets
  that briefly replaced them. Both are generated-interface clichés; the fix was
  to subtract rather than to substitute.

### Known issues

- Cache hit ratio settles near 87% where a healthy production system sits at
  98–99%.
- The plate's containment audit still constrains the silhouette; the shape holds
  the city, and the city was not laid out to be an elephant.
- iOS Safari differs from Chrome's mobile emulation in touch handling and
  viewport units. The touch controls have not been tested on a real device.

---

## [0.3.0] — 2026-07-26

The numbers stop being wrong, and the city stops looking like a night raid.

### Fixed — the simulator

- **Bottlenecks are reachable at last.** A batch controller was silently
  cancelling every constraint in the model: sweeping the workload knob from 1 to
  50,000 tps returned 90–100% of what was offered every time, and breaking
  *everything* at once — 32 buffers, lock contention, no background writer,
  `remote_apply` at 400 ms, no autovacuum — still committed 4,724 transactions a
  second. The causes were all simulated correctly; only the effect was
  unreachable. Achieved throughput now emerges from the model's own limits:
  measured over ten simulated minutes at the shipped defaults, 10 tps offered
  yields **7 achieved**, with nine checkpoints and five autovacuum runs.
- **WAL-triggered checkpoints fire at the right threshold.** PostgreSQL uses
  `max_wal_size / (1 + checkpoint_completion_target)` — about 53% of
  `max_wal_size` at the default — per `CalculateCheckPointSegments()` in
  `xlog.c`. The model used the whole of `max_wal_size`, and the countdown
  estimate carried the same error. Both now call one shared function, so the
  display cannot drift from the behaviour.
- **The cache hit gauge is computed the way `pg_stat_database` computes it** —
  `blks_hit / (blks_hit + blks_read)` — rather than as a time-average of ratios.
  Measured at steady state it reads **87%**, against **57%** before.
- Vacuum is charged WAL and I/O instead of being free theatre; truncation
  returns only trailing empty pages; the autovacuum launcher no longer starves
  large tables behind small hot ones.

### Fixed — the city was telling lies

- **Local memory is part of each backend, not a building beside them.**
  `work_mem`, `maintenance_work_mem` and `temp_buffers` were drawn as one shared
  structure next to the backend row. The prose said "per backend" and the
  geometry said otherwise, and geometry wins: a visitor who correctly reads the
  plaza as "one shared thing every process maps" then meets a second,
  similar-looking memory building and reasonably concludes the wrong thing.
- **`shared_buffers` no longer claims a maximum of 8 MiB.** The slider was
  labelled with the literal tile count, so its ceiling was 1,024 × 8 KiB — a
  size nobody runs. The pool is now sized in realistic units and the 1,024 tiles
  are declared as what they are: *a 1,024-frame sample of the page cache*.
- The plaza is called the **buffer pool**, which is the structure;
  `shared_buffers` is the parameter that sizes it.

### Changed — it no longer reads as an aerial assault

- The walsender was a 49 m transmission tower with a parabolic dish, a feed
  horn, expanding torus pulses launched along the aim vector, and a blinking
  crimson beacon. Under load it read as a muzzle blast. It is now a cable head
  topping out at 16.1 m — the same height as its neighbours.
- The standby's read-only client was a ringed disc at 34 m with a lit beam
  angling down onto the deck. It is a terminal at grade with its read path along
  the ground.
- Nothing was deleted outright; every mechanism was re-housed. The push that
  spawned the torus pulses now advances a ratchet on the replication slot drum,
  one tooth per chunk. The archive backlog strobe became a steady lamp whose
  brightness *is* the queue depth — strictly more informative than a flash,
  since it was previously black except when critical.
- **Forty-three translucent materials** had turned the city to fog with no
  silhouettes. Opacity is now a semantic tier rather than atmosphere.

### Added

- **A daylight theme.** The night model is "structure matte, meaning neon, only
  neon blooms", which inverts under a bright sky — so daylight is toon shading,
  ink lines, bloom off, sun and shadows, with every semantic colour re-derived
  to hold its meaning on a light background.
- **Open a page and read it.** A heap page can be opened to its real layout:
  the header with `pd_lower` and `pd_upper`, the line pointer array growing
  forward with `LP_NORMAL` / `LP_REDIRECT` / `LP_DEAD` distinguished, free space
  in the middle, and tuples growing *backward* from the end — with a tuple
  header opened to `t_xmin`, `t_xmax` and `t_ctid`, where MVCC visibility
  actually lives. The data directory gets the same treatment.
- **Walk mode has a floor.** It believed it was standing on something 76 m in
  the air, which is why it felt like flying. Plus procedural footstep audio,
  synthesised rather than sampled — no assets, no dependency — with cadence
  driven by distance travelled, so it is correct at every gait and stops dead
  when you stop.
- **Backups, PITR and failover**, sited off the primary as they must be: an
  archive estate with a timeline switchyard where the live timeline is the
  through line and every fork is a siding that never rejoins, a recovery ground
  on separate iron, and an HA quarter with a consensus store holding the lock
  and no user data.
- **Touch works properly** — one finger pans, two fingers pinch to zoom, twist
  to turn and drag to tilt. **Mobile is usable**: worst-case chrome coverage at
  390×844 went from 87.9% of the viewport to 48.9%, horizontal overflow from 26
  elements to none, and touch targets under 44 px from 49 to none.
- Left-drag pans and right-drag orbits — map convention rather than CAD.

### Known issues

- **The cache hit ratio is 87%, not the 98–99% a real OLTP database shows.**
  Much better than the 57% of v0.2.0, and the gauge is now computed correctly,
  but the working set is still sized so the pool cannot dominate it.
- Achieved throughput sits at 70% of offered at the defaults. Some shortfall is
  honest — a real database does not serve everything it is asked — but this has
  not been calibrated against anything.
- The elephant-shaped ground plate is derived from the real logo artwork; judge
  the likeness for yourself from the plan view.
- Mobile is verified in Chrome emulation with touch, not on a real iPhone.

[0.3.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.3.0

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
  to the data-directory floor. At the bottom, a sign reads *"shared memory is 52 m
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
