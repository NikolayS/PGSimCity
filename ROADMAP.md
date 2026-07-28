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

## 1. A real cluster, with real tools

Name the tools and model what they actually do:

- **WAL-G / pgBackRest** for disaster recovery — base backups, retention, the
  archive command, restore to a point in time. The archive gate, object store,
  backup vault and restore winch already exist as structures.
- **Patroni** for high availability — the DCS holding the leader lock, leases
  renewing, a node that loses its lease being demoted. The consensus hall and
  three lease posts are already on the plate.

The lesson these carry that nothing else in the project does: **backups and
replication are different things, and one is not a substitute for the other.**

## 2. Three nodes, properly

A primary and two standbys, each with its own buffer pool, its own WAL, its own
data directory, and its own opinion about who the leader is. `standbyB` exists;
the second standby needs the same completeness as the first.

## 3. Failover and switchover

The payoff of 1 and 2, and the reason to build them. A planned switchover is
orderly. An unplanned failover is not, and the difference is the whole lesson:
what is lost, what a timeline fork means, why the old primary cannot simply
rejoin, and what `pg_rewind` is for.

## 4. Break things from inside

The knobs exist in a control rail. In first person they should be **things you
walk to and operate** — pull the autovacuum yard's switch and then watch bloat
climb for the rest of your visit. Consequence at a distance, discovered rather
than described.

This is the single change that most turns observation into understanding, and it
costs less than any other item here because the simulation already models every
consequence.

## 5. Swimming that feels like swimming

The swim volume, the surface and the splash all exist; it still does not feel
like water. Sound is not the fix on its own — the missing parts are drag,
buoyancy, muffling under the surface, and something to see moving past you.

## 6. First-person physics

Buildings became solid in v0.10.0, when 33 merged district meshes turned out to
be silently dropped from collision — the collider count went from 765 to 989.
Slopes gained real surface normals at the same time. **Re-test before treating
this as open**; if something is still passable, it is a specific bug rather than
a missing system.

## 7. Network and multiplayer

Several people in the same city. Unclear whether the value is teaching together,
operating a cluster together, or watching someone else break something. Worth
prototyping the question before the feature.

## 8. Better simulation of problems

Eleven of twenty-two knobs have outputs that do not respond correctly — found by
sweeping every knob and watching, after three rounds of expert review missed
them all. Worst: high-load recovery leaves WAL hot for twenty simulated minutes
after the workload drops, and `wal_level = minimal` reports 677 MiB held by a
logical slot when logical decoding is impossible at that level.

**This one gates the others.** Failover, breakage and game scenarios are all
built on the simulation telling the truth.

## 9. Query path walkthrough — shipped

v0.7.0 and v0.8.0. Pick a statement, follow it from the client through parse,
plan, buffer reads, WAL and commit, narrated by the transaction's own state
machine rather than a script, with a step mode. Kept here because it was asked
for and is done.

## 10. Actual game — goals, dynamics, balance

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
process down to disk.

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
