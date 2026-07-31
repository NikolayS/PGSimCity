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

Much of the scaffolding is already standing. `archiveGate`, `timelineYard`,
`objectStore`, `backupVault`, `recoveryPad`, `restoreWinch`, `consensus` and
`leaseNode1..3` were all built as part of the continuity quarter, and `standbyB`
already makes this a three-node cluster. **They are buildings without
behaviour.** The work is giving them mechanisms that can fail.

## 1. A real cluster, with real tools — shipped

Name the tools and model what they actually do:

- **WAL-G / pgBackRest** for disaster recovery — base backups, retention, the
  archive command, restore to a point in time. The archive gate, object store,
  backup vault and restore winch already exist as structures.
- **Patroni** for high availability — the DCS holding the leader lock, leases
  renewing, a node that loses its lease being demoted. The consensus hall and
  three lease posts are already on the plate.

The lesson these carry that nothing else in the project does: **backups and
replication are different things, and one is not a substitute for the other.**

## 2. Three nodes, properly — shipped

A primary and two standbys, each with its own buffer pool, its own WAL, its own
data directory, and its own opinion about who the leader is. `standbyB` exists;
the second standby needs the same completeness as the first.

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

The knobs exist in a control rail. In first person they should be **things you
walk to and operate** — pull the autovacuum yard's switch and then watch bloat
climb for the rest of your visit. Consequence at a distance, discovered rather
than described.

This is the single change that most turns observation into understanding, and it
costs less than any other item here because the simulation already models every
consequence.

The dependency is item 8, and it is sharp: **a lever in the world is far more
persuasive than a slider in a panel.** Eleven knobs currently respond wrongly, so
each knob's consequence chain has to be verified — moves, right direction,
sensible amount, recovers on reset — before it earns a handle. A handle on a
broken knob is a machine for teaching a falsehood convincingly.

## 4b. The control center in the postmaster tower — shipped

A room you enter, in first person, inside the postmaster tower — the supervisor
process that owns the cluster is the city hall, and it already stands at the head
of the central avenue with a door defined. Inside: a **map of this city**, a psql
prompt, and your statement tracing across both the map and the districts visible
through the windows.

An earlier version of this item was "install the 2D machine room in the city".
That was wrong, and the reason is worth keeping: **the city's topology is already
an architecture diagram.** Districts are placed and scaled to say true things
about how PostgreSQL is organised. A second, differently-shaped diagram inside it
would teach that the layout is arbitrary and undercut the premise. The map must
be the city.

Most of the machinery exists — `sim.request()`, `setTraceMode()` with step
playback, `SimState.trace`, and the v0.7.0 narration. This gives it a home, a
front door and a prompt. The open question is whether the statement is really
planned by PGlite, loaded lazily on entering, so that an index scan and a
sequential scan differ in the world because the planner chose differently.

It also gives first person a destination. Today you can explore the city and
there is nothing in it to do.

## 5. Swimming that feels like swimming — shipped

The swim volume, the surface and the splash all exist; it still does not feel
like water. Sound is not the fix on its own — the missing parts are drag,
buoyancy, muffling under the surface, and something to see moving past you.

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

v0.13.0 and v0.16.0. A measured audit of all 23 knobs (`KNOB-AUDIT.md`) graded
ten wrong, and eight of those traced to six shared root causes. All are fixed.

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

Balance is the hard part and the reason to build it last: the failure must be
survivable, legible, and clearly your own fault.

---

# The machine — 2D, half real

A psql prompt and controls on the left, PostgreSQL's architecture on the right,
one screen. PGlite supplies what only a real server can — the parse, the plan,
the catalogs, the results. The model supplies the interior and everything
concurrent, which a single connection cannot produce.

**Now:** the layout that was specified from the start, and structure rather than
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

**Then:** comparison — the same statement run twice with one setting changed,
side by side. `synchronous_commit` on and off, collapsing the commit wait. The
value of this view is the experiment, not the playthrough.

---

# Both

- **Documentation that describes behaviour the app no longer has.** Caught three
  times. The durable fix is a test that drives each documented instruction.
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
