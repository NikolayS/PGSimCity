# PGSimCity

**An explorable 3D city that shows how PostgreSQL actually works.**

PGSimCity turns a PostgreSQL cluster into a city you can inspect, walk through,
and break. It is for engineers who are good at their job and have never had to
operate a database — the people who need to understand why a checkpoint spikes
latency, why one forgotten transaction bloats a table forever, and what
`synchronous_commit` is really charging them.

**[Explore the live city](https://nikolays.github.io/PGSimCity/)** — no install
required.

PGSimCity is an independent, non-commercial educational visualization of
PostgreSQL internals. It is not affiliated with, sponsored, endorsed, or
approved by Electronic Arts Inc. SimCity is a trademark of Electronic Arts Inc.

This project contains no SimCity code, assets, artwork, logos, characters,
audio, or game content.

![A daylight view into PGSimCity's storage excavation: the shared buffers plaza spans the pit above teal storage machinery, with backend towers behind and the checkpointer and WAL districts on either side.](docs/screenshot.png)

---

> ### How much to trust this
>
> PGSimCity is still **0.x**: early and moving. It is a *model* of PostgreSQL, not an emulator:
> no PostgreSQL source code runs here, and the numbers are scaled so a human can watch them.
>
> Three specialist review rounds checked PostgreSQL correctness against `postgresql.org/docs`
> and the source rather than memory; every finding was independently checked by a reviewer tasked
> with refuting it. A separate audit treated buildings, adjacencies, and animations as claims.
>
> The suite has **210 tests**; CI fails the build on a red test. They pin the WAL trigger point as
> `max_wal_size / (1 + checkpoint_completion_target)` at every call site, cache hit ratio as
> `blks_hit / (blks_hit + blks_read)`, and the clock-sweep `usage_count` cap at 5.
>
> Mistakes have been found and fixed throughout; the commit history records them. Known limitation:
> touch controls have been verified only in Chrome's mobile emulation. Corrections from people who
> know the engine are exactly what this needs: [open an issue](https://github.com/NikolayS/PGSimCity/issues/new)
> or send a [pull request](https://github.com/NikolayS/PGSimCity/pulls).

---

## What you are looking at

| District | What it is |
|---|---|
| **Client sky** (north, above) | Connections arriving from the application tier |
| **Postmaster** | The supervisor. Forks one backend per connection and never touches your data |
| **Backend row** | 16 backend processes. Their lighting *is* their state — including `idle in transaction` |
| **Buffer pool (`shared_buffers`)** | A representative sample of 1,024 frames, beside `wal_buffers`, the ProcArray, lock table, CLOG and buffer mapping table |
| **The excavation** | The data directory: where memory ends and storage begins |
| **Storage** (below) | Heap files as fields of 8 KiB pages, B-trees as actual trees, TOAST, the FSM and visibility map, the OS page cache and the disks |
| **WAL district** (east) | walwriter → `pg_wal` segments → archiver → walsender |
| **Maintenance yard** (west) | Checkpointer, background writer, autovacuum launcher and its workers |
| **Standby** (south) | walreceiver, the startup process replaying WAL, and the lag between them |
| **Continuity quarter** (outer east and south) | WAL archive, base backups, point-in-time recovery, a second delayed standby, leader lease and rejoin machinery |
| **Query lab** (above the backends) | Select a backend and its statement unfolds: parse → rewrite → plan → execute |

Colour is semantic everywhere and never decorative: **WAL is amber**, **dirty
pages are red**, **clean pages are blue**, **vacuum is violet**, **checkpoints
are pink**, **the background writer is teal**, **replication is orange**,
**storage is green**, **indexes are aqua**, **locks are red**.

---

## Things worth trying

- Press **`T`** for the 14-chapter guided tour. It follows one connection from
  the client through planning, caching, WAL, checkpoints, vacuum and replication.
- Press **`Enter`** to trace one statement. Pick **Non-HOT UPDATE** and slow
  playback exposes where it enters the buffer pool, creates WAL and waits to
  commit.
- Run **Cache thrash** from the Scenarios menu. It sets `shared_buffers` to
  16 MiB — below the manual control's 128 MiB minimum — so the clock sweep races
  and backends write their own dirty victims before they can read another page.
- Turn on **Long-running transaction**. The xmin horizon blade sinks and goes
  red; autovacuum still travels to the tables, but reports zero removable rows
  while the `sessions` table keeps bloating. Release the transaction and cleanup
  can begin again.
- Run **Checkpoint storm**. Watch the checkpointer's flywheel spin up, the fsync
  phase shudder, and a wall of full-page writes flood the WAL district after
  each checkpoint begins.
- Set **`synchronous_commit`** to `off` and watch backends stop waiting in
  `commit_wait`. Then read what you just traded away.
- Turn on **Slow replay** and watch `sent_lsn`, `write_lsn`, `flush_lsn` and
  `replay_lsn` pull apart on the standby.
- Press **`G`** and walk through the city at eye level. A buffer frame that read
  as one tile from the establishing shot becomes a structure above your head.

---

## Controls

Press **`?`** in the city for the complete input map and colour legend.

### Camera

| Input | Action |
|---|---|
| Left-drag | Pan — grab the ground and move it |
| `Shift` / `Ctrl` / `Cmd` + left-drag | Orbit around the city |
| Middle-drag | Pan with model-viewer controls |
| Right-click / touch long-press | Open contextual actions |
| Wheel | Zoom toward the cursor |
| Touch | One finger pans; two fingers pinch to zoom, twist to turn and drag vertically to tilt |
| Click | Select a building; in fly mode, capture the mouse |
| `W` `A` `S` `D` or arrow keys | Move |
| `Space` or `E` · `C` or `Q` | Rise · descend in fly mode |
| `PageUp` / `PageDown` | Change altitude in fly or orbit mode |
| `Shift` · `Alt` | Boost · precision |
| `Esc` | Leave pointer lock |

In walk mode, `W` `A` `S` `D` or the arrows walk, `Shift` runs, `Space` jumps
and `C` crouches. On touch devices, the Walk button adds separate move and look
thumb controls plus jump and crouch.

### Application

| Key | Action |
|---|---|
| `T` | Start the 14-chapter guided tour |
| `Enter` | Trace one query through PostgreSQL |
| `H` · `O` | Establishing shot · top-down overview |
| `F` · `G` | Toggle fly mode · walk the city at 1.7 m eye height |
| `/` or `Ctrl-K` / `Cmd-K` | Search every component, setting, scenario and tour chapter |
| `?` | Open the input map and colour legend |
| `L` · `N` · `M` | Toggle labels · daylight/night · sound |
| `K` or `P` | Pause or resume |
| `,` · `.` | Slower · faster (0.1×–5×) |
| `R` | Reset to the default settings |
| `1`–`8` | Jump to clients, backends, buffer pool, WAL, storage, query lab, maintenance or standby |
| `Esc` | Close the topmost overlay |

---

## How it is built

```text
src/
  core/           shared contracts, event bus, registry, themes and utilities
  sim/            the PostgreSQL simulation
  world/          the city geometry, one module per district
  engine/         renderer, camera, flows, labels, picking, collision and audio
  ui/             controls, inspector, tour, search and written explanations
  observability/  a separate diagnostic interface over the same simulation
```

Three rules hold it together:

1. **`world/layout.ts` is the single source of truth for geography.** Anchors,
   table definitions and the route network live there. No district hard-codes a
   coordinate another district needs.
2. **The simulation never imports three.js, and the world never mutates the
   simulation.** They meet at `SimState`.
3. **Rendering carries meaning differently by theme.** At night structure is
   matte and meaning is neon; in daylight hue and value carry meaning without
   relying on bloom.

Stack: [three.js](https://threejs.org) r185, TypeScript and Vite. three.js is
the only bundled runtime dependency; the only external runtime service is the
cookie-free analytics described below.

`window.PGSIMCITY` in the browser console includes `sim`, `registry`, `bus`,
`rig`, `gfx` and `flows` if you would rather drive the city from the outside.
For the accuracy boundary and review status, see
[How much to trust this](#how-much-to-trust-this) above. Each inspector names
material simplifications at the point where they matter.

### A possible future

The [accuracy boundary described above](#how-much-to-trust-this) also creates a
useful trade-off: the city can expose internal steps such as the clock sweep's
frame-by-frame victim choice. A PostgreSQL build compiled to WebAssembly could
supply authoritative query results and plans; without extra instrumentation,
the city could observe only catalogs, `pg_stat_*` views and `EXPLAIN`, not those
internal steps. A future hybrid could let execution and plans drive the visible
interior; that is a direction, not a promise.

---

## Run it locally

You need Node.js 20 or newer and a browser with WebGL2.

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test
npm run typecheck
npm run build    # static bundle in dist/
npm run preview  # http://localhost:4173
```

There is no application server or database. The result is a static bundle.

**Analytics and privacy.** PGSimCity uses
[Plausible](https://plausible.io/) for aggregate, cookie-free analytics on the
city and observability pages. It records pageviews, unique visitors, referring
sites, bounce rate, visit duration and interactions such as starting the tour,
changing playback, opening a panel, tracing a statement, selecting a building
or following an outbound link. PGSimCity sends no names, email addresses,
free-form input, browser fingerprint or application-supplied personal data, and
creates no analytics cookies, analytics local storage, advertising identifier
or session recording. Blocking `plausible.io` stops measurement without
affecting the application.

---

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Nikolay Samokhvalov. See [NOTICE](NOTICE).

PostgreSQL is a trademark of the PostgreSQL Community Association of Canada.
PGSimCity is an independent educational project and is not affiliated with,
sponsored by, or endorsed by the PostgreSQL project.
