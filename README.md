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
> The suite has **234 tests**; CI fails the build on a red test. They pin the WAL trigger point as
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
| Left-drag | Pan in orbit mode — grab the ground and move it, the way a map does |
| `Shift`-left-drag or `Ctrl`/`Cmd`-left-drag | Orbit around the city |
| Middle-drag | Pan in orbit mode |
| Right-click or touch long-press | Open the context menu |
| Wheel | Zoom towards the cursor in orbit mode · adjust movement speed in fly mode |
| 1 finger | Pan in orbit mode |
| 2 fingers | Pinch to zoom · twist to orbit · drag both up/down to tilt |
| First-person touch | Left thumb moves · right thumb looks · buttons jump and crouch (rise and dive while swimming) |
| Click | Select a building · in fly or walk mode, capture the mouse for looking |
| `W` `A` `S` `D` or the arrow keys | Move |
| `Space` or `E` · `C` or `Q` | Rise · descend in fly mode; `Space` jumps and `C` crouches in walk mode |
| `PageUp` / `PageDown` | Change altitude in orbit or fly mode |
| `Shift` · `Alt` | Boost · precision in orbit or fly mode; `Shift` runs in walk mode |
| `Esc` | Leave pointer lock |

### Keys

| Key | Action |
|---|---|
| `F` | Toggle fly / orbit camera |
| `G` | Get down and walk the city on foot, 1.7 m tall |
| `H` | Back to the establishing shot |
| `Home` | Back to the default establishing shot |
| `O` | Straight-down overview of the whole plate |
| `T` | Guided tour — the whole city in 14 chapters |
| `Enter` | Open Run a Query |
| `/` or `Ctrl`/`Cmd`-`K` | Command palette — search every component, setting and scenario |
| `?` | Keyboard map and colour legend |
| `L` | Toggle the floating labels |
| `N` | Toggle daylight / night |
| `M` | Toggle sound |
| `K` or `P` | Pause / resume |
| `,` `.` | Slower / faster (0.1× – 5×) |
| `R` | Reset to the default settings |
| `Esc` | Close the topmost overlay |
| `1` – `8` | Jump to a district: clients, backends, buffer pool, WAL, storage, query lab, maintenance, standby |

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

Stack: [three.js](https://threejs.org) r185, TypeScript, Vite. three.js is the
3D application's only bundled runtime dependency. The separate 2D Query flow
may lazy-load PGlite after reader opt-in. There is no framework, and Plausible
analytics is the sole external service.

`window.PGSIMCITY` in the browser console includes `sim`, `registry`, `bus`,
`rig`, `gfx` and `flows` if you would rather drive the city from the outside.
For the accuracy boundary and review status, see
[How much to trust this](#how-much-to-trust-this) above. Each inspector names
material simplifications at the point where they matter.

### A possible future

The [accuracy boundary described above](#how-much-to-trust-this) makes internals
such as the clock sweep's frame-by-frame victim choice observable. The separate
Query flow offers an opt-in PGlite mode: real PostgreSQL supplies parsing, plans,
catalogs, buffer counters, errors and results, while its plan drives the closest
modelled interior path. The page labels the two sources separately because
PostgreSQL exposes the former and not the latter.

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

There is no application server. The result is a static bundle. The 3D city and
Diagnose surface make only the analytics requests described below. Query flow
may, after an explicit click, load the same-origin PGlite JavaScript, data and
WebAssembly assets and run an in-memory PostgreSQL in the browser. The modelled
query flow continues to work when analytics or PGlite is blocked.

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

## Roadmap

What is being worked on, what is known to be wrong, and what is deliberately not
being done: [ROADMAP.md](ROADMAP.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Nikolay Samokhvalov. See [NOTICE](NOTICE).

PostgreSQL is a trademark of the PostgreSQL Community Association of Canada.
PGSimCity is an independent educational project and is not affiliated with,
sponsored by, or endorsed by the PostgreSQL project.
