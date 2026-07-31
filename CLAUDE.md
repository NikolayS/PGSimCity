# CLAUDE.md -- PGSimCity

## Project

PGSimCity is an explorable 3D city that teaches how PostgreSQL works. The
buildings and motion represent real mechanisms; the numbers are deliberately
scaled so people can see those mechanisms operate. The city is a model, not an
emulator, and no PostgreSQL source code runs in the 3D application. The separate
2D Query flow at `observability/` and workbench at `machine/` may run opt-in
PostgreSQL WebAssembly under the dependency and loading rules below.

Use **PGSimCity** in prose and headings and `pgsimcity` for package-style names.
Repository: `NikolayS/PGSimCity`.

The intended reader is technically capable but may be new to database
operations. Explain PostgreSQL precisely without assuming operator vocabulary,
and disclose every simplification that could change the lesson.

## Architecture

The 3D city and Diagnose interface share six source layers; the Machine is a
standalone 2D entry point:

```text
src/
  core/           shared contracts, event bus, registry, theme, utilities
  sim/            pure TypeScript PostgreSQL model
  world/          three.js city geometry, one module per district
  engine/         renderer, camera, flows, labels, picking, collision, audio
  ui/             HUD, controls, inspector, tour, search, written explanations
  observability/  separate diagnostic interface over the same simulation
machine/           psql workbench and 2D architecture board
```

- `src/core/types.ts` defines `SimState`, the contract between simulation and
  presentation.
- `src/sim` never imports three.js. It owns and mutates simulation state.
- `src/world` may read `SimState` but never mutates it.
- `src/world/layout.ts` is the single source of truth for geography. Shared
  anchors, district bounds, table definitions, and routes belong there.
- `src/engine` turns state and world geometry into an interactive scene.
- `src/ui` and `src/observability` explain and expose state; they do not become
  alternate simulation engines.

The browser debugging surface is `window.PGSIMCITY`, including the simulation,
event bus, registry, camera rig, renderer state, and flow controller.

## Stack

- TypeScript in strict mode, targeting ES2022
- three.js r185 for 3D and WebGL
- Vite for development and the static production bundle
- Vitest for deterministic unit and characterization tests
- Node.js 20 or newer for local development
- WebGL2 in the browser

three.js is the only bundled runtime dependency of the 3D application.
PGlite is permitted only for Query flow at `observability/` and the workbench at
`machine/`. It must be split out of the city bundle, loaded only after explicit
reader action, and never enter the city or Diagnose model-path critical path.
No other runtime dependency, framework, CDN resource, remote font, binary
asset, telemetry service, or analytics provider may be added.

Plausible's cookie-free analytics script is the sole allowed external runtime
resource. No cookies, consent banner, fingerprinting, personal data, session
recording, third-party ad, or tracking network. Aggregate, privacy-preserving
page and interaction counts only. The shipped application remains a static
site with no application server. The city and Diagnose model path make no
application network calls beyond Plausible; Query flow and the Machine may fetch
same-origin PGlite JavaScript, data, and WebAssembly assets after reader action.
Analytics or PGlite failure and blocking must never break the model path.

## Style Rules

Follow the shared Postgres.AI engineering rules:
https://gitlab.com/postgres-ai/rules/-/tree/main/rules

The rules below are PGSimCity additions and clarifications. If they conflict
with the shared rules, this file wins.

### TypeScript and comments

- Keep TypeScript strict and make state ownership visible in types.
- Preserve the `sim` / `world` boundary; convenience is not a reason to import
  three.js into the model or mutate the model from a building.
- Per-frame paths must allocate nothing. Reuse vectors, colors, arrays, scratch
  objects, and materials rather than creating garbage in animation loops.
- Comments state what the code cannot: a constraint, a non-obvious invariant,
  or a concurrency/performance hazard. Do not narrate the next line.
- Prefer `/* ... */` for comments spanning multiple lines and `//` for a
  single-line constraint.
- Keep per-function comments to one to three lines. Put longer rationale in one
  consolidated design note or the relevant task/design document.

### PostgreSQL language and units

- Use binary units in prose and UI: KiB, MiB, GiB, and TiB. PostgreSQL
  configuration values keep PostgreSQL's native spelling, for example
  `shared_buffers = '2GB'`.
- Say **data directory**, never `$PGDATA`. `PGDATA` may name a configuration
  directory while the data lives elsewhere.
- Name the plaza **buffer pool (`shared_buffers`)**.
- Bare **log** never means WAL. Say **write-ahead log** or **WAL**. Reserve
  server log or PostgreSQL log for diagnostic logging.
- Cite Egor Rogov's *PostgreSQL 14 Internals* by chapter and never link it.
  Hironobu Suzuki's *The Internals of PostgreSQL* may be linked.
- PostgreSQL claims in geometry, animation, metrics, and prose require the same
  technical review. A caption cannot correct a misleading building.
- Write docs for a reader arriving today. Put historical change narration in
  `CHANGELOG.md`, not in the README or user-facing explanations.

### Visual language

- At night, structure is matte through `theme.mat()` and meaning is neon
  through `theme.neon()`.
- Only emissive intensity above 1.0 crosses the bloom threshold. Glow therefore
  carries information and is never decoration.
- Day mode is intentionally different: saturated hue and value carry meaning;
  daylight does not depend on bloom.
- Color is semantic across districts. Do not reuse a mechanism's color merely
  because it looks good.
- Judge visible work at the scale and camera angle a user will encounter.
  Review screenshots, not only source coordinates.

### Shell

Shell scripts start with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
```

Use two-space indentation, no tabs, and quote every variable expansion.

### Git history

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- Keep the subject under 50 characters and in the present tense.
- A commit message must describe what the commit actually did. Inspect the diff
  before naming it. One commit claimed to trace the real PostgreSQL artwork
  while replacing genuine SVG data with hand-drawn points; that false history
  cost five failed attempts to locate the regression.
- Never amend or force-push unless the project owner explicitly asks.

## Agentic Engineering Rules

### Red/green TDD is mandatory

Every bug fix starts with the smallest deterministic test that reproduces the
defect. Run it and confirm that it fails for the expected reason, make the
source change that turns it green, then refactor with the suite green. Do not
weaken the assertion to accommodate the bug.

This rule exists because the Slonik plate silhouette degraded across four
commits and no test could identify the breaking commit. CI runs `npm test` and
a red test fails the build.

Tests assert behavior and properties, not existence or opaque snapshots. A test
that merely finds a symbol cannot prove it is wired or correct. Prefer exact
answers for PostgreSQL formulas and durable directional properties for scaled
simulation behavior. Use the seeded RNG; never depend on wall-clock timing,
unseeded randomness, a browser, or a GPU when the underlying claim is pure.

### Verify the deliverable, not a nearby state

- Run `npm test`, `npm run typecheck`, and `npm run build` before handing off a
  code change.
- Exercise visible changes in the browser and read the resulting screenshots.
  A successful render command is not visual verification.
- Verify that new code is imported, constructed, and called. The 505-line audio
  engine once existed without anything importing it; presence was reported as
  delivery. For that feature, `grep -c createAudio src/main.ts` is the minimum
  wiring check.
- When an authorized maintainer prepares a commit, use `git add -A` and confirm
  `git status --porcelain | grep -v '^[AMD]'` is empty. The Pages deployment
  was broken twice by commits that contained only part of the working feature,
  including once when an untracked dependency was invisible to an explicit
  add list.

### Do not launch more than two browsers

Visual verification goes through `tools/shoot.mjs`, which takes a slot from a
two-way semaphore before launching. Each browser rasterises WebGL in software
and spikes to 1-2 GiB per frame; ten at once exhausted this machine's memory
twice in one session and killed every agent's in-flight work. Queue, do not
collide. `AGENTS.md` has the details.

### Isolate cross-cutting work

Anything touching `src/engine/renderer.ts`, `src/main.ts`,
`src/world/layout.ts`, or `src/core/types.ts` goes in a dedicated git worktree.
Do not use `git stash` to isolate that work. A stash used for isolation erased
roughly 700 lines of another agent's in-flight work across six files.

Keep changes focused and preserve unrelated edits in a dirty tree. Do not
silently replace another worktree's version of a file.

### Treat visual work as engineering

- Geometry is a factual claim. Measure silhouettes, bounds, containment,
  direction, and relative placement with tests where possible, then inspect the
  rendered result. The xmin horizon once floated above every active backend
  even after two prose reviews passed.
- Build a fast feedback loop before visual iteration. Use the plate plotter for
  Slonik geometry before paying for a software WebGL render. Five plate attempts
  were judged through 70-second renders with most of the object obscured.
- Capture before/after evidence for visible fixes. Let software rendering
  settle, inspect console exceptions, and report what the image actually shows.

### Review and delivery

- CI must be green before review.
- Use REV for substantive pull-request review; address blocking findings and
  explain non-blocking findings that are intentionally left.
- Manually verify the changed surface. Documentation and geometry require
  visual/editorial review; simulation changes require behavioral execution.
- Green CI is necessary, not proof that a feature is correct or complete.
- Keep one logical fix or feature per pull request.

## Key Design Rules

1. **The architecture boundary is hard.** `sim` owns state, `world` presents it,
   and both meet at `SimState`.
2. **Geography has one owner.** Cross-district positions and routes live in
   `src/world/layout.ts`.
3. **The model must be honest.** Preserve real algorithms and formulas, scale
   only what is necessary for observation, and state material simplifications.
4. **Meaning controls appearance.** Night uses matte structure and neon
   meaning; day uses hue and value; decorative bloom is forbidden.
5. **Frame loops allocate nothing.** Visual richness is not permission to make
   the frame-starved renderer collect garbage.
6. **Code must be wired.** An unimported subsystem is not delivered.
7. **Geometry must be reviewed as content.** Buildings can teach a falsehood
   more persuasively than nearby text teaches the truth.
8. **The dependency boundary stays small.** three.js remains the only bundled
   runtime dependency of the 3D application. PGlite is allowed only as a lazy,
   opt-in dependency of Query flow in `observability/` and `machine/`; it must
   not grow the city bundle.
   Plausible is the only external runtime service, and the application remains
   a static site that works when analytics or PGlite is unavailable.

## Copyright

Copyright 2026 Nikolay Samokhvalov. Apache-2.0 license.

Keep `NOTICE` with distributions. PostgreSQL is a trademark of the PostgreSQL
Community Association of Canada. Never imply that PGSimCity is affiliated with,
sponsored by, or endorsed by the PostgreSQL project, PostgreSQL Global
Development Group, or PostgreSQL Community Association of Canada. Preserve
third-party copyright and license notices.
