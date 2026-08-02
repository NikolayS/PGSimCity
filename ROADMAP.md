# Roadmap

Two products with different jobs, and they should stop being planned as one.

**The city (3D)** is the hook and the spatial intuition. It got people in the
door. Where it goes next is a cluster you can operate, break, and fail to save.

**The machine (2D)** is where mechanism becomes legible — a real psql prompt on
one side, PostgreSQL's architecture on the other, half the numbers reported by a
real server.

Ordered within each track by whether something misleads a reader, not by effort.

---

# The city — from visualisation to operations simulator

The direction: this stops being a diagram you look at and becomes a system you
run. That makes the name functional rather than decorative — SimCity was a
management game, and the thing that made it teach was that you could get it
wrong.

The continuity quarter now has working base backups, WAL archive and retention,
point-in-time recovery, two independently lagging standbys, leader leases,
failover, rewind and rejoin. The remaining city work is depth and new operator
situations, not wiring previously inert buildings.

## 1. A real cluster, with real tools — shipped

The city names the tools and models what they actually do:

- **WAL-G** for disaster recovery — direct object-storage base backups, WAL
  archiving, retention, and restore to a point in time. **pgBackRest** is the
  accurately described alternative.
- **Patroni** for high availability — the DCS holding the leader lock, leases
  renewing, and a node that loses its lease being demoted.

The lesson these carry that nothing else in the project does: **backups and
replication are different things, and one is not a substitute for the other.**

## 2. Three nodes, properly — shipped

A primary and two standbys now each have their own buffer state, WAL positions,
data-directory state, replay rate and leader view. The two replication links can
lag and fail independently.

## 3. Failover and switchover — shipped

The payoff of 1 and 2, and the reason to build them. A planned switchover is
orderly. An unplanned failover is not, and the difference is the whole lesson:
what is lost, what a timeline fork means, why the old primary cannot simply
rejoin, and what `pg_rewind` is for.

**Sequencing, resolved 2026-07-29.** Items 4 and 4b were paused until the machine
room's trace was right, on the reasoning that they are the same problem — making
a statement visibly cause what follows — and building them in parallel would solve
that design question three times, differently. That worked: the 2D trace shipped
first, and the control center inherited its vocabulary rather than inventing a
second one.

## 4. Break things from inside — shipped

The control rail exposes every model knob. In first person, the autovacuum yard
now has a lever you can walk to and operate, then watch bloat climb for the rest
of your visit. Consequence at a distance is discovered rather than described.

This is the single change that most turns observation into understanding, and it
costs less than any other item here because the simulation already models every
consequence.

**A lever in the world is far more persuasive than a slider in a panel.** That
is why only the audited autovacuum consequence chain has earned a physical
handle so far. Each future handle must still prove that the mechanism moves in
the right direction, by a sensible amount, and recovers on reset.

## 4b. The control center in the postmaster tower — shipped

A room you enter, in first person, now exists inside the postmaster tower. Its
operable door opens onto a **map of this city**, a psql-like prompt, and a
statement tracing across both the map and the districts visible through the
windows.

An earlier version of this item was "install the 2D machine room in the city".
That was wrong, and the reason is worth keeping: **the city's topology is already
an architecture diagram.** Districts are placed and scaled to say true things
about how PostgreSQL is organised. A second, differently-shaped diagram inside it
would teach that the layout is arbitrary and undercut the premise. The map must
be the city.

The prompt deliberately uses the same six deterministic model statements as the
city trace. It does not load PGlite: the separate Query flow and Machine own the
real-PostgreSQL boundary, while the room teaches how this finite model moves.
Together with the autovacuum lever, it gives first person concrete destinations
and actions.

## 11. Restore testing — shipped

The continuity quarter now earns a restore-drill verdict from the retained base
backups, archived WAL frontier, target time, and age of the newest usable backup.
The drill occupies the recovery host, reads real modeled object and validation
bytes, and reports measured restore time separately from total validation time.

Backups fail silently. The archive stops and nobody reads the `.ready` count. A
retention policy quietly expires the backup someone was relying on. Credentials
rotate and the push starts failing into a log nobody tails. Object storage
lifecycle rules move objects to a tier the restore path cannot read. **None of
these are visible until a restore is attempted**, and by then it is an incident.

What this teaches:

- **A restore drill has a cost and a cadence**, and both are decisions. Restoring
  the physical cluster is common to every level in this model; validating one
  table proves less and can run nightly, while broader smoke and manifest checks
  add independently falsifiable evidence. A physical backup cannot restore one
  table in place, but it can be restored on a scratch host and the table can then
  be extracted logically; no pre-existing logical archive is required.
- **What a failed drill looks like**, and that finding out this way is the good
  outcome. A real archive fault is distinct from the healthy unarchived tail of
  the current 16 MiB segment. That tail is the archive-only RPO floor;
  `archive_timeout` can shorten it at the cost of padded segments. An uncovered
  old target likewise distinguishes expired retention from history for which no
  earlier base backup was ever taken.
- **What a drill actually proves.** That the backup restores is not that the data
  is correct; the panel states what each level proved and did not prove. The
  full-cluster level can reject an empty restored table that the accounts-only
  level misses, and the strongest level can reject a restored-object digest
  mismatch that smoke queries miss. Every level says it does not exercise
  failover, promotion, or service cutover.
- **Restore-to-target time is measured, not assumed.** The city already relates
  backup age to replay volume. The drill reports time from the bytes it actually
  fetches and replays, so the number grows as the backup ages, then reports the
  additional verification and targeted smoke-query time. It does not call that
  number RTO because promotion, endpoint cutover, client reconnection, and
  service restoration are outside the clock.

This extends item 10's scenarios: the drill that has not been run is still a
situation with a correct answer, and the answer is unwelcome.

## 5. Swimming that feels like swimming — shipped

The buffer-pool water now has translational and rotational drag, buoyancy,
surface transitions and splashes, an underwater veil and muffled audio, and a
particulate field that gives movement parallax. Keyboard and touch controls can
rise and dive while swimming.

## 6. First-person physics — shipped

v0.13.0. The re-test found the real defect, and it was not missing colliders:
**the solver resolved each axis independently**, so a fast oblique move could pass
through a thin wall between samples and an inside corner could be squeezed
through. Collision now sweeps the movement segment against each box continuously.

Three specific surfaces were also passable — the replication cable bundle, the
query lab's floor and posts, and a route blocked by an invisible selection proxy.

A scene-graph coverage test now enumerates every visible human-scale mesh in reach
and asserts a collider covers it, and asserts the reverse: nothing solid where
nothing is visible. A district that grows a building cannot silently become
passable.

## 7. Network and multiplayer

Several people in the same city. Unclear whether the value is teaching together,
operating a cluster together, or watching someone else break something. Worth
prototyping the question before the feature.

## 8. Better simulation of problems — shipped

v0.13.0 and v0.16.0. A measured audit of the original 23 knobs
(`KNOB-AUDIT.md`) graded ten wrong, and eight of those traced to six shared root
causes. All are fixed. Later disaster-recovery, node and failover addenda bring
the current control surface to 33 knobs and record their own verdicts there.

The two that mattered most: **turning autovacuum off was rewarded with roughly 2x
throughput**, because vacuum charged a full-page image for every page it touched
and nothing modelled cost-based throttling — which was also the true cause of WAL
staying hot for twenty simulated minutes after a load drop. And `wal_level =
minimal` froze replication mid-flight, reporting 4.92 GiB of pg_wal against a
256 MiB `max_wal_size` and 4,800 MiB held by a logical slot, when logical decoding
is impossible at that level.

**This gated the others**, and it no longer does. Two limitations are now
disclosed rather than implied away: anti-wraparound vacuum is unmodelled, and at
low write rates bloat accrues too slowly to see — which is true of real
PostgreSQL and is taught rather than tuned.

## 9. Query path walkthrough — shipped

v0.7.0 and v0.8.0. Pick a statement, follow it from the client through parse,
plan, buffer reads, WAL and commit, narrated by the transaction's own state
machine rather than a script, with a step mode. Kept here because it was asked
for and is done.

## 10. Actual game — goals, dynamics, balance — shipped

The reframe the rest points at. Not points and badges: **situations with a
correct answer you have to find.** The replica is lagging and the disk is
filling — do you drop the slot or add capacity? A long transaction is blocking
cleanup — do you kill it? Every one of these has a real answer that operators
learn the hard way, and this is a place to learn it where nothing is lost.

The shipped operator scenarios keep failures survivable, legible, and
recoverable. Expanding their range without weakening that balance remains the
hard part.

---

# The machine — 2D, half real

A psql prompt and controls on the left, PostgreSQL's architecture on the right,
one screen. PGlite supplies what only a real server can — the parse, the plan,
the catalogs, the results. The model supplies the interior and everything
concurrent, which a single connection cannot produce.

**Shipped foundation:** the layout that was specified from the start, and structure rather than
arrangement — one shared memory segment visibly containing the buffer pool,
wal_buffers, the ProcArray and the lock table, with backend private memory
visibly outside it, the postmaster and its fork, the client, and layers from
process down to disk. Published at `machine/`.

**Shipped — the statement visibly causes what follows.** v0.13.0 to v0.16.0. The
architecture pane used to run on free-running rhythms and never read the query at
all. A submitted statement now traces the board with ambient work dimmed, the
buffer pool is driven by measured `Shared Hit Blocks` / `Shared Read Blocks`, and
measured values carry `P` against modelled `M`. An index lookup reports 3 shared
hits; an aggregate reports 102.

It works on a phone: the board renders where its type is legible rather than
shrinking to fit, follows the active stage so a reader is carried along the route,
and takes pinch, drag, double-tap and wheel. A viewing-rate control changes how
fast you watch without touching the modelled periods or the measured values.

The page is called **The Machine**, and PGlite by ElectricSQL is credited where
the real-PostgreSQL claim is made.

**Shipped — controlled comparison.** One PostgreSQL execution report feeds two
aligned model replays of the same write statement, side by side. The control
keeps `synchronous_commit` on; the treatment turns it off, so acknowledgement
moves ahead of the local WAL flush while that flush continues. The view labels
this difference as model evidence because PGlite cannot measure a real durability
wait. The value is the controlled experiment, not two noisy executions.

---

# Both

- **Documentation instruction contract — shipped.** The city keyboard map,
  README keyboard/control-surface walkthroughs, and Machine footer keys are
  driven through production handlers. Visual interpretation, touch hardware and
  free-form explanatory prose still require editorial and browser review.
- **Contextual links** — one per mechanism, in the same register as the citations
  around it, tagged for attribution.
- **A corrections pipeline** — an issue template for "this does not match
  PostgreSQL" and a per-panel link that opens it pre-filled.

---

# Not doing

- **Replacing the model with real PostgreSQL.** A running server exposes
  catalogs, `pg_stat_*`, `EXPLAIN` and log output, and nothing else — not the
  clock sweep choosing a victim, not the checkpointer's write phase. Real
  PostgreSQL is added alongside, never instead.
- **Connecting to a live production database.** Different product.

---

# Known limitations

- Touch controls verified only in Chrome's mobile emulation, never on a device.
- The plate's containment audit constrains the Slonik silhouette.
- Modest hardware falls to the `reduced` quality tier, which is not what the
  screenshots show.
