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

The PostgreSQL lessons have keyboard and text-first routes, including a city
architecture description generated from the layout, but the 3D scene and
first-person walk do not have a nonvisual equivalent. See the
[accessibility boundary and alternatives](ACCESSIBILITY.md) for what is covered
and what remains irreducibly spatial.

![PGSimCity at golden hour: the reflective shared-buffers pool and backend avenue sit at the centre of the Slonik-shaped plate, surrounded by the WAL, maintenance, standby, recovery, and continuity districts under a scattering sky.](docs/screenshot.png)

---

> ### How much to trust this
>
> PGSimCity is still **0.x**: early and moving. The 3D city is a *model* of
> PostgreSQL, not an emulator: no PostgreSQL source code runs in that city, and
> the numbers are scaled so a human can watch them. The opt-in Query flow and
> [Machine](machine/) can run PGlite, a real in-memory PostgreSQL compiled to
> WebAssembly.
>
> PGSimCity targets the PostgreSQL 18 major line. PostgreSQL 18.4 is the
> reviewed reference release against which its claims were verified; mechanism
> claims follow the [`REL_18_STABLE` source](https://github.com/postgres/postgres/tree/REL_18_STABLE).
> For example, PostgreSQL 18's bulk-read strategy starts at 256 KiB and grows
> with `io_combine_limit × effective_io_concurrency`, subject to its caps
> ([`GetAccessStrategy`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/storage/buffer/freelist.c#L505-L611)).
> The current TypeScript buffer sample still uses a fixed 32-frame ring: that is
> a disclosed historical simplification for the animation, not PostgreSQL 18's
> ring-sizing rule. The animation must not be used as numeric version evidence
> until that model is aligned.
>
> Four review rounds have checked the project: three specialist reviews compared PostgreSQL
> correctness with `postgresql.org/docs` and the source rather than memory, and a separate audit
> treated buildings, adjacencies, and animations as claims. Every finding was independently checked
> by a reviewer tasked with refuting it.
>
> The deterministic suite fails CI on a red test. Its checks pin the model's scaled WAL
> trigger approximation as `max_wal_size / (1 + checkpoint_completion_target)` at every
> call site. PostgreSQL 18 calculates the moving threshold in whole WAL segments through
> `ConvertToXSegs(max_wal_size_mb) / (1 + checkpoint_completion_target)` and therefore
> rounds it ([`CalculateCheckpointSegments`](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/access/transam/xlog.c#L2166-L2197)).
> The suite also pins cache hit ratio as `blks_hit / (blks_hit + blks_read)` and the
> clock-sweep `usage_count` cap at 5.
>
> Mistakes have been found and fixed throughout; the commit history records them. Known limitation:
> touch controls have been verified only in Chrome's mobile emulation. Corrections from people who
> know the engine are exactly what this needs: [open the correction template](https://github.com/NikolayS/PGSimCity/issues/new?template=postgresql-mismatch.md)
> or send a [pull request](https://github.com/NikolayS/PGSimCity/pulls).

---

## What you are looking at

| District | What it is |
|---|---|
| **Client sky** (north, above) | Connections arriving from the application tier |
| **Postmaster** | The supervisor. Forks one backend per connection and never touches your data |
| **Backend row** | 16 backend processes. Their lighting *is* their state — including `idle in transaction` |
| **Buffer pool (`shared_buffers`)** | Up to 1,024 representative frames (256 active at the 2 GiB model default; PostgreSQL 18 defaults to 128 MiB), beside `wal_buffers`, the ProcArray, lock table, CLOG and buffer mapping table |
| **The excavation** | The data directory: where memory ends and storage begins |
| **Storage** (below) | Heap files as fields of 8 KiB pages, B-trees as actual trees, TOAST, the FSM and visibility map, the OS page cache and the disks |
| **WAL district** (east) | Backends and walwriter write WAL into `pg_wal`; the archiver copies completed segments, while walsenders independently stream WAL as it is generated |
| **Maintenance yard** (west) | Checkpointer, background writer, autovacuum launcher and its workers |
| **Standbys** (south) | Two independent walreceivers, startup processes replaying WAL, and the lag on each stream |
| **Continuity quarter** (outer east and south) | WAL archive, base backups, point-in-time recovery, delayed replay, leader lease and rejoin machinery |
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
- Run **The work_mem cliff**. Its fixed Sort and HashAggregate nodes spill at
  2 MiB, then fit at 4 MiB without replanning; the private reservoirs,
  `base/pgsql_tmp`, temp counters and latency breakdown show the consequence.
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
  Press **`E`** at the autovacuum lever or the postmaster door to operate it;
  the control center inside can trace one of six statements across a map of the city.
- Try an operator scenario, wait for its decision, and choose a response. Slot
  pressure, failover, and recovery make the consequence visible and offer a safe reset.

---

## Controls

Press **`?`** in the city for the city control map and colour legend.

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
| Double-click | Focus a component — semantic focus instead of a map-style zoom step |
| `W` `A` `S` `D` or the arrow keys | Move |
| `Shift` + left/right arrow | Turn left/right in orbit, fly, or walk mode |
| `Shift` + up/down arrow | Tilt or look up/down in orbit, fly, or walk mode |
| `+` / `-` | Zoom in/out in orbit mode |
| `Space` or `E` · `C` or `Q` | Rise · descend in fly mode; in walk mode, `Space` jumps, `E` operates nearby levers, doors, or consoles, and `C` crouches |
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
| `T` | Guided tour — the core query and maintenance path in 14 chapters |
| `Enter` | Open Run a Query |
| `/` or `Ctrl/Cmd+K` | Command palette — search every component, setting and scenario |
| `?` | Keyboard map and colour legend |
| `L` | Toggle the floating labels |
| `N` | Cycle night / golden hour / approximate local-time light |
| `M` | Toggle walk sound |
| `K` or `P` | Pause / resume |
| `,` `.` | Slower / faster (0.1× – 5×) |
| `R` | Reset to the default settings |
| `Esc` | Close the topmost overlay |
| `1` – `8` | Jump to a district: clients, backends, buffer pool, WAL, storage, query lab, maintenance, standby |

### Export a presentation image

Choose **Export image** in the city toolbar. The model pauses until you return
to the city. PNG export keeps the current camera and graphics quality; visible
object names are optional, but the model disclosure, version, and model clock
always remain in the image footer.

The default 2× option caps the scene at 4 megapixels. An explicit 4K scene option
fits the camera aspect within 3840 × 2160 (rotated for a portrait view), subject
to GPU limits. The disclosure footer adds height. Large captures can exhaust GPU
memory; try 1× if an export fails. A prepared-image link remains available if
the browser blocks the automatic download.

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
machine/           a separate psql workbench and 2D architecture board
```

Three rules hold it together:

1. **`world/layout.ts` is the single source of truth for geography.** Anchors,
   table definitions and the route network live there. No district hard-codes a
   coordinate another district needs.
2. **The simulation never imports three.js, and the world never mutates the
   simulation.** They meet at `SimState`.
3. **Rendering carries meaning differently by theme.** At night structure is
   matte and meaning is neon; in daylight hue and value carry meaning without
   relying on bloom. Local-time light follows an approximate 06:00–18:00 path
   from the reader's clock; it uses neither geolocation nor an astronomical
   latitude/season model.

Stack: [three.js](https://threejs.org) r185, TypeScript, Vite. three.js is the
3D application's only bundled runtime dependency. The separate 2D Query flow
and Machine may lazy-load PGlite after reader opt-in. There is no framework,
and Plausible analytics is the sole external service.

`window.PGSIMCITY` in the browser console includes `sim`, `registry`, `bus`,
`rig`, `gfx` and `flows` if you would rather drive the city from the outside.
For the accuracy boundary and review status, see
[How much to trust this](#how-much-to-trust-this) above. Each inspector names
material simplifications at the point where they matter.

### Real PostgreSQL beside the model

The [accuracy boundary described above](#how-much-to-trust-this) makes internals
such as the clock sweep's frame-by-frame victim choice observable. The separate
Query flow and the [Machine](machine/) offer opt-in PGlite modes: real PostgreSQL
supplies parsing, plans, catalogs, buffer counters, errors and results, while the
visual model supplies the otherwise hidden interior. Each surface labels those
sources separately because PostgreSQL exposes the former and not the latter.

---

## Run it locally

You need Node.js `^20.19.0 || >=22.12.0` and a browser with WebGL2.

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
Diagnose model path make only the analytics requests described below. Query flow
and the Machine may, after an explicit click or first submitted query, load the
same-origin PGlite JavaScript, data and WebAssembly assets and run an in-memory
PostgreSQL in the browser. Their model paths continue to work when analytics or
PGlite is blocked.

**Analytics and privacy.** PGSimCity uses
[Plausible](https://plausible.io/) for aggregate, cookie-free analytics on the
city, observability, and Machine pages. It records pageviews, unique visitors,
referring sites, bounce rate, visit duration and interactions such as starting
the tour, changing playback, opening a panel, tracing a statement, selecting a
building or following an outbound link. PGSimCity sends no names, email addresses,
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
