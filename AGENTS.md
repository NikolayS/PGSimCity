# AGENTS.md

Read and follow [`CLAUDE.md`](CLAUDE.md) before changing this repository. It is
the source of truth for architecture, style, testing, visual accuracy, and
delivery rules. [`CONTRIBUTING.md`](CONTRIBUTING.md) is the shorter human guide.

## Codex workflow

- Do not commit or push. Leave the working tree for the project owner.
- Preserve unrelated changes. If work touches `src/engine/renderer.ts`,
  `src/main.ts`, `src/world/layout.ts`, or `src/core/types.ts`, follow the
  dedicated-worktree rule in `CLAUDE.md`.
- Install with `npm install`. Run the development server with `npm run dev` at
  `http://localhost:5173/`; reuse an existing server rather than starting a
  competing process. Vite preview uses port 4173.
- Run `npm test`, `npm run typecheck`, and `npm run build` before handoff.
  During TDD, `npm run test:watch` is the fast loop.

## Visual verification

For Slonik plate work, start with:

```bash
node tools/plot-plate.mjs
```

An alternate source file may be passed as the first argument. This prints the
silhouette, bounding box, segment count, and trunk proportion without a browser
or GPU.

For anything visible, use the headless driver in this repository:

```bash
CDP_PORT=9501 node tools/shoot.mjs \
  http://localhost:5173/ /tmp/pgsimcity.png 45000 1280 760
```

Choose a unique `CDP_PORT` from 9500–9900 for every concurrent driver. Software
WebGL runs at roughly 1–3 fps, so allow 45–70 seconds for the scene to settle.
The optional final argument is JavaScript evaluated before the screenshot.

### At most two browsers at once

`tools/shoot.mjs` takes a slot from a directory semaphore at
`/tmp/claude-1000/cdp-gate` before it launches, and waits if all slots are
taken. The cap is two, overridable with `CDP_MAX`.

**Do not raise it, and do not launch Chrome around the driver to avoid it.**
Each browser rasterises WebGL through SwiftShader on the CPU and spikes to
1–2 GiB while a frame is in flight. Ten agents screenshotting at once put this
machine into swap and then into the OOM killer — twice in one session, losing
in-flight work from every agent running at the time. Queuing is slower per
screenshot and it finishes; colliding is faster and it does not.

If a run is killed, its slot is reaped after ten minutes, so a dead agent
cannot deadlock the gate. `tools/reap.sh` clears them immediately along with
browsers older than fifteen minutes.

`window.PGSIMCITY` exposes `bus`, `sim`, `rig`, `registry`, `gfx`, and `flows`.
Use `sim.setKnob()`, `sim.runScenario()`, or `bus.emit('focus', { id: '...' })`
to stage a view. Inspect the screenshot itself and the driver's console and
exception output; creating an image file alone is not verification.
