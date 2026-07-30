# Changelog

All notable changes to PGSimCity are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the model, the layout and the visual language
are all still moving. Expect breaking changes between minor versions.

---

## [0.20.0] — 2026-07-30

### Buildings are solid. This time the diagnosis was right.

Two previous releases fixed real collision bugs and the city was still walkable
through. The third attempt found why, and it was neither of the obvious answers.

The spatial grid was innocent — every box was already inserted into every cell it
overlapped, and the solver already queried the whole swept segment.

**A compound building was one loose bounding box containing its walls, its
protrusions, and the valid standing space between them.** The solver deliberately
skips any collider the walker starts inside, so that nobody can be trapped in a
box. So the grid returned the building and the solver ignored it — including the
visible wall inside it. The larger and more compound the building, the worse it
was, which is why it read as "many buildings".

The coverage test could not see this because it asked whether *any collider
overlapped a mesh*. That was true. It was ignored at runtime. Existence and
reachability are different properties, and the tests now assert the second.

Compound roots and instanced batches are decomposed into tight per-child boxes at
build time. Colliders **1,821 → 3,982**. The per-frame path is unchanged and still
allocates nothing.

### A street is not a map legend

Standing in first person showed twelve district chips across the sky at full
size, naming districts a kilometre away — wayfinding labels for an orbit map,
leaking into a view where you are a person standing in a street. Walk mode now has
its own policy. Orbit is untouched.

### The autovacuum lever can be found

It was reachable all along: the 7.5 m operating radius was fine and the prompt had
good contrast. It was simply **invisible** — a 6.42 m cabinet with a small caption
standing next to a 41 m launcher, with no cue whatsoever until you were already in
range. A 13 m illuminated control header now reads from **53.5 m**, "Approach the
lever" appears at 28 m, and activation stays at 7.5 m.

### Ground that reads as a material, and a sky with weather

The previous graphics pass added environment lighting and ambient occlusion to a
scene whose largest surface was an untextured grey plane — correct techniques,
wrong bottleneck.

Procedural textures, generated in code with no image files, give the ground and
building faces a material and a sense of scale: **16 KiB of source data, 2.4–5.2 ms
at boot**. The clouds that already existed are now actually visible. Day mode has a
committed value hierarchy instead of pale on pale.

Clouds cost **+2.8 ms per frame** under software rendering — 0.8%, below the run's
own baseline drift. The chunk grew 2.08 kB, because procedural texture costs code
rather than bytes.

### A door that opens, and a body that exists

The postmaster door is where a reader crosses from outside the system to inside
it, and that crossing was instant and unmarked. It now reads as an entrance and
animates open, respecting `prefers-reduced-motion`. First person had a floating
camera; it now has a body, driven from the existing gait state.

---

## [0.19.0] — 2026-07-30

### Environment lighting and ambient occlusion

Two techniques were entirely absent. `scene.environment` was never set and there
was no `PMREMGenerator` anywhere, so the gloss, glass and metal the cel shader
already computes had nothing to reflect. And there was no ambient occlusion of
any kind, which is why geometry read as slightly floating.

The sky is now prefiltered into an environment map, regenerated when the theme
changes rather than per frame. GTAO grounds geometry where surfaces meet. Shadows
go to 1536² with a softer penumbra.

Tiered so `low` and `reduced` are unchanged. The semantic colours were checked
and still read: dirty-page red and lock red stay distinguishable, and maintenance
violet does not converge with shared-memory indigo.

**Honest note on the payoff.** Matched before/after pairs — identical camera,
identical simulated time, UI animation hidden on both sides — show a real but
modest difference. Close and dense views gain grounding; wide and phone views
change little. This is a correct foundation rather than a transformation, and the
remaining gap against comparable browser work is art direction — palette, value
contrast, atmosphere — not more render passes.

### The screenshot driver stops leaking browser profiles

Every verification run created a Chrome user-data directory keyed on its port and
never removed it. **106 accumulated to 8.6 GB**, took the host to 99% disk with
swap fully exhausted, and killed two agents' in-flight work.

Profiles are now removed on exit including signals — a killed run was the common
case — and stale ones are reaped by age on startup, following the concurrency
gate's existing pattern. A live run's profile is never touched, and an explicitly
supplied `CDP_PROFILE` is left alone, since a caller that named the directory owns
its lifetime.

---

## [0.18.0] — 2026-07-29

### The continuity quarter gets behaviour

`archiveGate`, `objectStore`, `backupVault`, `recoveryPad`, `restoreWinch` and
`timelineYard` have been standing since they were built — buildings without
mechanisms. They now do what they are named for.

Modelled on **pgBackRest**, with **WAL-G** named as an alternative and its
differing commands and deletion model identified rather than implied to be the
same:

- Timed full backups that wait for the stop WAL to archive before completing.
- An archive queue with retries — and **a stalled archive is reachable as a
  failure**, which is the most common real backup incident. At 5,000 tps it
  queued 28 segments, reached 512 MiB of `pg_wal` in 137 seconds, and then
  rejected 51,194 writes. The city rejects writes where a real server can PANIC
  as the WAL filesystem fills, and says so rather than implying otherwise.
- Count-based retention, which is what makes a recovery window finite. Asking to
  restore to a target older than the oldest retained backup fails with a reason
  you can act on.
- Point-in-time recovery that fetches a retained backup and replays WAL forward
  to a target, without promoting.

**Backup age is visibly a cost, not a number in a panel.** Taking the age from
19.0 s to 57.6 s took WAL replay from 41.0 to 88.9 MiB. That relationship is the
whole reason backup frequency is a decision.

The lesson the rest of the project could not carry: **backups and replication are
different things, and one is not a substitute for the other.** A replica applies
`DELETE FROM accounts` faithfully and instantly.

Patroni, promotion and failover are deliberately absent — those are the second
half of roadmap item 1 and item 3. The high-availability buildings remain visible
and explicitly inert.

Scaled rates are disclosed rather than implied: 384 MiB/s backup, 640 MiB/s
restore, 24 MiB/s replay, and an illustrative 65% repository compression.

---

## [0.17.0] — 2026-07-29

### Something in the city you can operate

The autovacuum yard has a lever. Walk up to it in first person, press `E`, and
autovacuum turns off — the lever reverses, a red lamp lights, and the vacuum
trucks stop launching. Workers already mid-cycle are described as finishing,
because that is what really happens.

It is the same knob as the control rail's, in both directions. There is one
walk-up interaction vocabulary shared with the postmaster tower's door, not two.

**The rate at which bloat accrues was not changed to make the lever feel
responsive.** Bloat follows write volume — that is a fact about PostgreSQL and one
of the better lessons available here, and faking it would have been exactly the
kind of persuasive falsehood the knob audit existed to prevent. Instead the lever
says so: it teaches that bloat follows writes and will appear slowly at the
current workload, and offers a control that takes you straight to the write rate.
Raise it and watch.

Measured: under hard writes, ten simulated minutes with autovacuum off takes
`sessions` past 10% bloat and grows it by thousands of pages, while append-only
`events` correctly stays at zero. Re-enabled, workers launch within fifteen
simulated seconds and dead tuples fall — but relation pages do not shrink back,
because vacuum does not return space to the filesystem.

---

## [0.16.0] — 2026-07-29

### The simulation stops lying about the last of its knobs

`KNOB-AUDIT.md` graded ten of twenty-three knobs WRONG. The two worst were fixed
in 0.13.0; these are the remaining four root causes, and they close the audit.

- **A backend paid nothing for evicting a dirty buffer**, so the background
  writer had cost and no benefit and neither `bgwriter` knob could show what it
  is for. Backend writes now fall from 129.0 to 76.0 per second when the writer
  runs. `bgwriter_lru_maxpages` at 100 and at 400 were previously identical;
  they now clean 28.4 and 54.2 pages per second.
- **`wal_buffers` was a 256 KiB constant.** It now follows PostgreSQL's rule —
  `shared_buffers/32`, floored at 64 kB, capped at one WAL segment.
- **Two disclosed time constants disagreed with each other.** The wording now
  consistently says one-way delay, across the observability paths, the panel
  content and the storage documentation.
- **`checkpoint_timeout` could not amortise full-page images** — the whole lesson
  of the setting. The write set had no repeating middle band, so pages were never
  re-touched within a checkpoint cycle. Scaled hot, warm and cold bands at
  60/35/5 make the amortisation visible: raising the timeout from 15 s to 120 s
  now moves estimated full-page images from 867 to 425 KiB/s, where before it
  barely moved from 699 to 612.

Every figure here was measured against the model with a seeded RNG and a warm-up,
then re-measured on the way back down to check recovery — including the cases
where recovery is legitimately asymmetric and a symmetry assertion would be wrong.

---

## [0.15.0] — 2026-07-29

### The machine room has a name and gives credit

The page was called **The Update Works** — a pun on *works* as in gasworks or
waterworks, the plant where `UPDATE`s get processed. Nobody parsed it. It is now
**The Machine**, which is what the roadmap has called it all along and what pairs
with the city.

**PGlite is credited where the claim is made.** The page's whole proposition is
that half its numbers come from a real PostgreSQL, and it named PGlite only as a
bare label. It now credits PGlite by ElectricSQL beside that claim, links
`pglite.dev` and the source repository, and says what PGlite actually is —
PostgreSQL compiled to WebAssembly, not a reimplementation — which is the honest
reason its measurements can be trusted.

The Legal disclosure mirrors `NOTICE`, including Electric DB Limited and
Apache-2.0. The Query flow carries the same credit. Links only: nothing is
fetched from an external host.

---

## [0.14.0] — 2026-07-29

Watching the machine at your own pace, and typing into it on a phone.

### Speed control

The only time control in the machine room was binary `PAUSE` / `RUN` against a
fixed 36 s clock, so a reader who wanted to follow a mechanism could freeze it
or keep up. There is now a rate control.

**Rate is a viewing speed, not a change to the model.** The modelled periods and
the values measured by PostgreSQL are identical at every setting — the same
statement reports 3 shared hits, 0 reads, 0.1 ms planning, 0.2 ms execution and
an Index Scan whether you watch it at a quarter speed or five times over. At 5x
the full 36 s clock takes 7.2 wall seconds.

### Typing SQL on a phone no longer hides the machine

iOS Safari zooms the page whenever a focused input computes below 16 px. The
terminal inherited the console's smaller monospace sizing, so tapping the prompt
scaled the page and pushed the board off screen entirely. The field now computes
to 16 px and the visual viewport stays at scale 1 on focus.

No viewport zoom restriction was added. It would have appeared to fix this while
disabling the reader's own zoom and fighting the board's pinch gesture.

**Submitting a statement is a request to watch something happen**, so on a phone
Enter now moves focus to the board and collapses the terminal. An error is the
exception — it refocuses and expands the terminal, because an error belongs
where it can be read.

### And the two of them together

The rate control and the collapsing terminal were verified independently and
never in combination. Together, the speed cluster took 39% of the width of a
390 px rack and its touch targets protruded past it. Landscape now reserves a
toolbar area with real clearance from the board controls.

---

## [0.13.0] — 2026-07-29

The city stops letting you walk through it, the machine room becomes something
you can operate on a phone, and the simulation stops rewarding a bad habit.

### The machine room is a place you can go

Published at `machine/`, linked from the city and from Diagnose, with its own
identity in a browser tab.

- **A statement now visibly causes what follows.** The architecture pane used to
  run on free-running rhythms and never read the query at all — the left half
  executed real PostgreSQL while the right half animated beside it. A submitted
  statement now traces the board: client, the process pipeline, the shared memory
  segment, the buffer pool, and back, with ambient work dimmed while it runs.
- **Half the numbers are measured.** Buffer counts and timings come from
  `EXPLAIN (ANALYZE, BUFFERS)`. An index lookup reports 3 shared hits; an
  aggregate reports 102. Measured values carry `P`, modelled ones carry `M`.
- **It works on a phone.** The board no longer tries to fit — it renders where
  its type is legible, 9.25 device pixels at the smallest label, and follows the
  active stage so the reader is carried along the route without touching
  anything.
- **Pinch, drag, double-tap and wheel.** Continuous zoom from fit to 2.3x. Any
  manual gesture hands control back from stage-following, and one control
  returns it.

### You can no longer walk through the city

- **Collision resolved each axis independently**, so a fast oblique move could
  pass through a thin wall between samples and an inside corner could be
  squeezed through. It now sweeps the movement segment against each box
  continuously.
- Three specific surfaces were passable: the replication cable bundle, the
  elevated query lab's floor and posts, and a painted route blocked by an
  invisible selection proxy.
- A scene-graph coverage test enumerates every visible human-scale mesh in reach
  and asserts a collider covers it — and the reverse, that nothing is solid where
  nothing is visible.

### The simulation stops teaching two falsehoods

A measured audit of all 23 knobs (`KNOB-AUDIT.md`) graded 13 correct and 10
wrong. Two shared root causes behind most of them are fixed.

- **Turning autovacuum off was rewarded with roughly 2x throughput.** Vacuum
  charged a full-page image for every page it touched and nothing modelled
  cost-based throttling, so three workers consumed the entire device budget.
  This was also the true cause of WAL staying hot for twenty simulated minutes
  after a load drop.
- **`wal_level = minimal` froze replication mid-flight** and then drifted,
  reporting 4.92 GiB of pg_wal against a 256 MiB `max_wal_size` and 4,800 MiB
  held by a logical slot — when logical decoding is impossible at that level. The
  same gating let a standby that does not exist pin the primary's xmin horizon.

Anti-wraparound vacuum is still unmodelled and is now disclosed rather than
implied away.

### The control center

The postmaster is the supervisor that owns the cluster, so it is the city hall.
Enter it in first person and find a map of this city, a psql prompt, and your
statement tracing across both the map and the districts visible through the
windows. The map is the city's own topology — a differently-shaped diagram
inside it would teach that the geography is arbitrary.

### Labels and chrome

- Label scale ran from 1.0 to 1.12, and to 1.06 on a phone — a range too small
  to perceive, so labels never appeared to scale at all. Now 1.50 to 1.00, with
  chips retiring past roughly 690 m rather than clamping at the legibility floor.
  A zoomed-out phone view keeps three district names at 1.9% of the frame.
- The checkpoint indicator painted through the PGSimCity wordmark. It was grid
  overflow, not a stacking order problem.

---

## [0.12.0] — 2026-07-28

psql on the left, PostgreSQL's architecture on the right.

### Changed

- **The machine board is the layout it should always have been**: one screen,
  a real psql workbench on the left, the architecture on the right. The previous
  version was machine parts arranged on a floor — the Opus Magnum aesthetic
  applied to a layout rather than to a structure — with a textarea and a Run
  button standing in for a CLI.

  The right half now draws **structure instead of arrangement**: one shared
  memory segment as a real container holding the buffer pool, wal_buffers, the
  ProcArray, the lock table and pg_xact, with backend private memory drawn
  deliberately outside it. The postmaster forks backends, the client the query
  arrives from is present, and the layers run client → processes → shared memory
  → kernel → disk. Cover every label and the containment is still legible, which
  is the test the earlier version failed.

  The left half is a prompt you type into, with history on the arrow keys, real
  PostgreSQL error text, and the backslash commands that can be answered
  honestly from the real catalogs.

  The machine language, the rhythm strip and the arm reach following real buffer
  counters are unchanged — those were right.

---

## [0.11.0] — 2026-07-28

A machine view of a transaction, half of it real.

### Added

- **`machine/` — the shop floor.** The observability flow view was a
  pipeline of boxes: order, and nothing else. This is the same subject in the
  visual language of Zachtronics' *Opus Magnum* — axonometric, every element a
  machine part with a visible pivot, and the whole cast on one floor.

  **The rhythm is the lesson**, and it is explicit: one shared 36-second clock
  with the walwriter at 3s, backends at 6s, the walsender at 9s, the bgwriter at
  12s, autovacuum at 18s and the checkpointer at 36s, on a strip labelled top is
  fast and continuous, bottom is rare and heavy. A viewer can see that the
  checkpointer is slow and periodic while backends are frantic, and that
  autovacuum is off doing something unrelated to the query in front of them —
  relationships the city teaches through geography and a pipeline cannot express.

  **Half of it is real.** PGlite supplies what only PostgreSQL can: the parse, so
  a typo is a genuine error; the plan, with real node types, costs and estimates
  against actuals; the catalogs; the results. The model supplies the interior and
  everything concurrent, which a single-connection engine cannot produce. They
  meet where it matters — `EXPLAIN` reports `shared hit=26 read=0` and the arm
  makes the short reach, so the board's central claim stopped being an assertion
  and became a measurement. Which components are real and which are modelled is
  marked, because with a single connection most of them cannot be real.

### Fixed

- **Labels no longer take over the screen on a phone** ([#4](https://github.com/NikolayS/PGSimCity/issues/4)).
  They were DOM elements at a fixed pixel size, so zooming out shrank the model
  and not the text — a single chip was about 44% of a 390px viewport. The v0.9.0
  detail tiering reduced how much text appeared but not how large it was, so the
  problem returned at distance. Label area is now budgeted as a fraction of the
  viewport at any camera distance and any screen size: a promise that can be
  tested rather than an improvement that can be argued about.

---

## [0.10.1] — 2026-07-28

### Fixed

- **The README was duplicated by a bad merge.** A restructuring branch was
  merged into a main that had moved, and git produced both orderings rather than
  one — `Controls`, `Camera`, `A possible future` and `Run it` each appeared
  twice, and the file grew from 267 lines to 334. That was the README of a
  tagged release. Deduplicated to 227 lines, keeping whichever copy held current
  facts: the camera table now says shift-left-drag orbits and right-click opens
  the context menu, which has been true since v0.6.0 and was still documented
  wrongly in one of the surviving copies.
- **The reordering that was asked for is applied.** What you are looking at and
  what to try now come before build instructions and the analytics disclosure,
  because almost nobody arriving from a link runs it locally. The
  model-not-emulator point is made once rather than three times.

---

## [0.10.0] — 2026-07-28

Real PostgreSQL behind the query surface, and a 2D view that draws the
architecture rather than a row of boxes.

### Added

- **Real PostgreSQL, opt-in.** A running server exposes catalogs, `pg_stat_*`
  counters, `EXPLAIN` and log output — and nothing else. Not the clock sweep
  choosing a victim frame, not a page landing in a specific buffer, not the
  checkpointer's write phase. Those are exactly what this project draws, so
  neither source alone is enough. PGlite now supplies what only it can: real
  parsing, so a typo produces a genuine PostgreSQL error; the **real plan**,
  with true node types, costs, estimates against actuals and real buffer
  counters; real catalogs; real results. The model keeps supplying the interior.
  They meet at the plan — the real one drives the animation. It is lazy and
  opt-in, so the city's bundle is unchanged, and which numbers are real and
  which are modelled is visible at a glance, because that distinction is the
  entire reason for adding it.
- **The 2D view draws architecture now.** The first version was a pipeline: a
  line of stops with the current one lit, which communicates order and nothing
  else. Following the conventions of Momjian's internals diagrams and Lesovsky's
  observability map, it now has containment — one shared segment visibly holding
  the buffer pool, wal_buffers, the ProcArray and the lock table, with private
  backend memory visibly outside it — connections with direction, layers where
  the axis means something, and the query path animating across the structure
  rather than replacing it.

### Fixed

- **Analytics were never being received.** The deployed integration was
  Plausible's older form while the account issues the current one, where the site
  identity is embedded in the script filename. The script was serving correctly
  and the account was looking for something else.
- **The controls table had been wrong for three releases.** It said right-drag
  orbits; right-drag was freed for the context menu in v0.6.0 and rotation is
  shift with left-drag. Someone asked how to rotate the camera on Hacker News,
  and this table is what they would have found.
- **Overlays no longer print on top of the inspector on a phone.** Two elements
  shared a z-index with the drawer, so paint order was decided by document order
  rather than intent. z-index is a named scale now.

### Removed

- Plausible dashboard setup steps from the README. That is a one-time task for
  one person's account, not documentation, and it is GitHub issue #3 now.

---

## [0.9.0] — 2026-07-28

The city reached the top of Hacker News. This is what the thread asked for.

### Added

- **A 2D query lifecycle view**, at `observability/`. The city answers what
  PostgreSQL is made of and the 3D trace answers what happens when you run
  something — but a camera can only point at one place at a time. This shows the
  whole journey at once, from client to commit, with your position marked and
  the stops a statement skips struck through rather than hidden. The plan tree is
  finally drawn as a tree: `BackendSim.plan` has carried per-node rows, cost and
  timing since the beginning with nothing rendering it. SVG rather than canvas,
  so a keyboard and a screen reader can follow it.
- **Measurement.** The largest traffic event in this project's history was
  invisible. Cookieless, no consent banner, no fingerprinting, no personal data —
  aggregate counts plus outbound clicks tagged by the panel they came from.

### Fixed

- **WAL responds to the workload again.** Watching the city at one transaction
  per second showed the `wal_buffers` ring racing. Two defects: the buffer filled
  under load and never drained once demand stopped, and ten times the transaction
  rate produced only 1.4 times the WAL. That second one broke the causal chain
  the city exists to teach, since write volume is what drives checkpoint
  frequency. Three rounds of expert review missed both, because both are visible
  only when something *changes*.
- **The tour stops burying the city.** Three people said so independently.
  Measuring showed the narration card was not the problem — a scrim draining
  contrast from the whole scene was, along with spotlight cones rendering as flat
  diagonal slabs at the quality tier most visitors get. Attention is directed
  additively now: the target is marked and everything else is left alone.

### Changed

- The dependency rule said "no telemetry, no analytics". It was written against
  surveillance rather than measurement, so it now states what is actually true
  instead of a blanket denial the software no longer honours.

---

## [0.8.0] — 2026-07-27

### Added

- **The trademark notice.** PGSimCity is an independent, non-commercial
  educational visualization of PostgreSQL internals, not affiliated with,
  sponsored, endorsed or approved by Electronic Arts Inc., and SimCity is a
  trademark of Electronic Arts Inc. The notice appears on the loading screen,
  near the top of the README, in the help surface, and in a footer reachable
  from every screen including the observability page. The claim that this
  project contains no SimCity code, assets, artwork, logos, characters, audio or
  game content was added only after auditing for it — the favicon and boot mark
  are hand-authored SVG, the audio engine synthesises everything and ships no
  files, and the only traced artwork here is the PostgreSQL logo, a different
  trademark already disclaimed in `NOTICE`.
- **Row versions.** MVCC is what most reliably surprises someone arriving from
  another database, and it was modelled without being shown at the level where
  it teaches: dead tuples accumulated and vacuum removed them, but nothing said
  why. You can now see an UPDATE write a second copy of a row, two transactions
  looking at the same row and seeing different versions of it, and the old
  version becoming collectable only once the horizon passes it.

### Changed

- **The tour waits for you.** Chapters advanced on a clock, whether or not you
  had finished reading — and at 60 to 110 words each, anyone who stopped to look
  at the thing being described lost their place. They now advance when you do,
  auto-play is opt-in, and the card says which chapter of fourteen you are on.

---

## [0.7.2] — 2026-07-27

### Fixed

- **At full zoom the city now tells you what you are looking at.** v0.7.1 stopped
  the camera dollying inside the buildings, and that held. But what replaced the
  blank frame was a wall of buffer-pool tiles with nothing naming them —
  legible only to someone who already knew that was `shared_buffers` at page
  scale. The literal blank was gone and the disorientation was not, which is
  plausibly what the original reporter experienced. Close range now identifies
  what fills the view and registers itself as a mode with a documented way back.
- **One camera distance floor instead of two.** `MIN_DOLLY_DIST` guarded the
  wheel at 24 while `MIN_DIST` let six other paths reach 8, and the measured
  blank range starts near 16 — so the shipped fix held only because nothing
  happened to point the camera that close. A test guarded it from the outside;
  now a single constant means the mistake cannot be written.

---

## [0.7.1] — 2026-07-27

Two things a stranger hit within minutes of arriving.

### Fixed

- **The screen no longer goes blank when you zoom in.** Reported from Hacker
  News: "the site is going blank sometimes if I zoom in a bit too much."
  Reproduced by sweeping the camera through its dolly range and reading every
  frame — from 16 units inward the readable city disappears, and at 12 and 8
  units the canvas is a near-flat ground or roof surface. The camera was being
  allowed to dolly inside the buildings it was looking at, so every surface in
  frame was back-faced and there was nothing to see, with no indication of what
  had happened or how to get back out.
- **The rotate gesture is discoverable.** Someone asked "How to rotate camera?"
  — the controls follow the Google Maps convention, where left-drag pans and
  shift with left-drag rotates, which is a good scheme that nobody could find.
  That was the sixth time in this project that something has been built, wired
  and left invisible, so the hint now appears where the gesture is being
  attempted rather than in the help overlay where the previous five already
  were.

---

## [0.7.0] — 2026-07-27

You can walk into the buildings, the clock sweep finally evicts, and one query
can be followed across the whole city.

### Fixed

- **Buildings are solid.** Nine of the city's landmarks could be walked straight
  through. The collision builder classifies an oversized mesh as needing a split
  and then recurses into its children — and a district that merges its whole
  structure into one geometry has no children, so the loop was empty and nothing
  was ever added. Thirty-three oversized meshes were being silently discarded,
  including the standby, the recovery ground, the backup vault, the WAL vault
  and the disk array. A collision query along the line the walker took agreed
  with him: there was no building there. Merged meshes are now split by their
  own triangles. Collider count went from 765 to 989.
- **Slopes work.** There were no surface normals anywhere in the collision code
  and no maximum-slope rule, only a fixed tolerance — which made the climb limit
  a function of speed: about 52 degrees at a run and 74 at a walk, and nothing
  ever slid.
- **The buffer pool now behaves like a cache.** The five demo relations totalled
  98 MiB while the `shared_buffers` slider starts at 128 MiB, so the smallest
  pool a user could pick was already bigger than the whole database. Every
  slider position gave an identical sample, the clock sweep never evicted
  anything, no backend ever wrote a victim page, and the `no-bgwriter` scenario
  produced nothing at all. The working set is now larger, and the access skew is
  tuned so the hot set still fits: **98.9% hit ratio with 7,602 evictions**,
  which is what a real server looks like.
- **The labels stopped covering the city.** Roles were told to stop truncating,
  which was right on its own, but in aggregate every label then rendered name,
  role and readout at every zoom — fifteen at once obscured more than the side
  panels ever had. Detail follows attention now.
- **Every mode has a visible way out.** The observability page's only exit was a
  tooltip on the wordmark, which does not exist on touch. A test now enumerates
  the modes and asserts each has a reachable exit control, not merely a key
  binding.

### Added

- **Trace a query.** Pick a statement and follow it from the client terminal
  through parse, plan, buffer reads, WAL and commit, narrated by the
  transaction's own state machine rather than a script. Three people asked for
  this independently, and a fourth said "even at 0.1x it is too quick — I should
  be able to fire individual transactions and watch them flow", which is why it
  has a step mode.
- **The version and build hash** are on screen, so a bug report can say which
  build it came from.

### Changed

- **The sample-versus-pool mistake is now unwritable.** A reviewer found
  thirteen readouts whose label made a claim their computation did not satisfy —
  a pool figure computed from the visualisation sample — after four had already
  been fixed one at a time. The sample-scale counters now carry a nominal type
  and the compiler rejects the mistake, with contract tests that assert a
  readout named for the pool actually moves when the pool moves.

---

## [0.6.0] — 2026-07-27

Hacker News arrived, said the panels were in the way, and was right.

### Fixed

- **The city gets the screen back.** Four commenters said the same thing
  independently — "eighty percent of the visual space is popups that completely
  block it", "remove ~50% of the UI blocking the view", "on mobile especially".
  Measured, they were right: at 1280 px the two side panels took 743 px and left
  a ~540 px strip that the minimap covered further. They now start collapsed,
  and the choice is remembered.
- **The guided tour is findable.** Two people asked for a narrated walkthrough
  that already existed and a third had to tell them so. That is a
  discoverability failure, not a missing feature. It is now an obvious first
  action rather than a keyboard shortcut behind a caution triangle.
- **The flicker was z-fighting**, correctly diagnosed by a commenter — coplanar
  ground surfaces, now separated with documented offsets.
- **Swimming involves water.** The swim volume began at deck level, so anywhere
  inside the tile field the walker was flagged as swimming while standing on
  solid floor: feet planted, never sinking, never crossing a surface. The entry
  splash fired once and then nothing ever happened again.
- **The sample stops calling itself the pool.** The plaza's 1,024 tiles are a
  sample of `shared_buffers`; several readouts multiplied that frame count by
  8 KiB and called the result the pool, so one panel could say "2.0 GiB pool"
  and "BUFFER POOL 8.0 MiB of 8.0 MiB" in consecutive lines.

### Known issues

- The declared working set is ~98 MiB while the `shared_buffers` slider starts
  at 128 MiB, so every reachable setting saturates the sampled pool. The clock
  sweep therefore never evicts and no backend ever writes a victim page. Being
  fixed by enlarging the relations.
- Buildings are not yet solid to a walker in first person.
- Touch controls have been verified only in Chrome's mobile emulation.

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
  a sunlit architectural model — flat saturated colour with a hard
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
