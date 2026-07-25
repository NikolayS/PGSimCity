# PGSimCity

**An explorable 3D city that shows how PostgreSQL actually works.**

Every building is a real mechanism. The plaza in the centre is `shared_buffers` —
1024 page frames whose height is their clock-sweep usage count and whose colour is
their true state. The amber district to the east is the write-ahead log. The pit
under the plaza is `$PGDATA`, and the heap files down there grow when you bloat
them. To the south, a standby replays what the primary sends it, always a little
behind.

It is built for engineers who are good at their job and have never had to operate
a database — the people who need to understand why a checkpoint spikes latency,
why one forgotten transaction bloats a table forever, and what `synchronous_commit`
is really charging them.

---

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # static bundle in dist/
npm run preview
npm run typecheck
```

No server, no database, no network calls. It is a single static bundle.

---

## Controls

| | |
|---|---|
| **Orbit** | left-drag to orbit · right/middle-drag to pan · wheel to zoom |
| **Fly** | click the scene to capture the mouse, `Esc` to release |
| **Move** | `W` `A` `S` `D` or the **arrow keys** · `Space`/`E` up · `C`/`Q` down |
| **Faster / finer** | `Shift` boost · `Alt` precision · `PageUp`/`PageDown` altitude |
| **Look at things** | click to select · double-click to fly to it |
| `F` | toggle fly / orbit |
| `H` | back to the establishing shot |
| `T` | guided tour |
| `/` or `Ctrl-K` | command palette — search every component, setting and scenario |
| `?` | keyboard map and colour legend |
| `K` / `P` | pause · `,` `.` slower / faster · `R` reset |
| `1`–`8` | jump to a district |

---

## What you are looking at

| District | What it is |
|---|---|
| **Client sky** (north, above) | Connections arriving from the application tier |
| **Postmaster** | The supervisor. Forks one backend per connection and never touches your data |
| **Backend row** | 16 backend processes. Their lighting *is* their state — including `idle in transaction` |
| **Shared memory plaza** | `shared_buffers`, `wal_buffers`, the ProcArray, the lock table, CLOG, the buffer mapping table |
| **The excavation** | Where memory ends and disk begins |
| **Storage** (below) | Heap files as fields of 8 kB pages, B-trees as actual trees, TOAST, the FSM and visibility map, the OS page cache, the disks |
| **WAL district** (east) | walwriter → `pg_wal` segments → archiver → walsender |
| **Maintenance yard** (west) | checkpointer, background writer, autovacuum launcher and its workers |
| **Standby** (south) | walreceiver, the startup process replaying WAL, and the lag between them |
| **Query lab** (above the backends) | Select a backend and its statement unfolds: parse → rewrite → plan → execute |

Colour is semantic everywhere and never decorative: **WAL is amber**, **dirty pages
are red**, **clean pages are blue**, **vacuum is violet**, **checkpoints are pink**,
**the background writer is teal**, **replication is orange**, **storage is green**,
**indexes are aqua**, **locks are red**.

---

## Things worth trying

- Drag **`shared_buffers`** down to 64 pages and watch the plaza thrash: usage
  counts collapse, the clock hand races, and backends start writing out their own
  dirty pages because nothing clean is left to evict.
- Turn on **Long-running transaction**. The xmin horizon blade in the ProcArray
  sinks and goes red, the autovacuum trucks keep driving their whole route, and
  their scoops come up empty every single time. The `sessions` table bloats and
  never recovers. This is the most expensive lesson in the app.
- Run the **checkpoint storm** scenario. Watch the checkpointer's flywheel spin
  up, the fsync phase shudder, and then a wall of full-page writes flood the WAL
  district immediately afterwards.
- Set **`synchronous_commit`** to `off` and watch every backend stop waiting in
  `commit_wait`. Then read what you just traded away.
- Turn on **Slow replay** and watch the four LSNs on the standby's ruler — sent,
  written, flushed, applied — pull apart. That gap is `pg_stat_replication`.

---

## How it is built

```
src/
  core/      contracts — types, the event bus, the palette, the component registry
  engine/    renderer + post-processing, camera rig, particle flows, labels, picking
  sim/       the PostgreSQL model. No three.js in here, ever.
  world/     layout.ts is the city plan; one module per district
  ui/        HUD, control rail, inspector, guided tour, command palette, and the
             written explanations for every component
```

Three rules hold it together:

1. **`world/layout.ts` is the single source of truth for geography.** Anchors,
   table definitions and the route network live there. No district hard-codes a
   coordinate another district needs.
2. **The simulation never imports three.js, and the world never mutates the
   simulation.** They meet at `SimState`.
3. **Structure is matte, meaning is neon.** Only emissive materials cross the
   bloom threshold, so anything that glows is carrying information.

Stack: [three.js](https://threejs.org) r185, TypeScript, Vite. Three runtime
dependencies, no framework, no CDN, no telemetry.

---

## Honesty

This is a *model*, not an emulator. The algorithms are real — clock-sweep
replacement, WAL insert/write/flush positions, checkpoint pacing against
`checkpoint_completion_target`, autovacuum thresholds, the xmin horizon blocking
cleanup, HOT updates skipping index maintenance — but the numbers are scaled so a
human can watch them. 1024 buffers stand in for a million; one particle stands in
for thousands of tuples.

Where it simplifies, the inspector says so.
