# Observability Lab

## Verdict: VALIDATED

Question: can Lesovsky's dense 2D PostgreSQL Observability map become a useful 3D experience without losing the mapping between server subsystems and their statistics?

The experiment uses depth for the execution and durability layers, buildings for subsystems, orbiting probes for views/functions, and click/search for exact lookup. It deliberately does not copy the original diagram's assets or layout.

Run:

```bash
npm run dev
```

Open `http://localhost:5173/observability/`.

Build:

```bash
npm run typecheck
npm run build
```

Stress case: narrow/mobile screens keep the inspector readable and collapse the introductory copy; users without WebGL2 receive a plain fallback instead of a blank canvas.

Next production step: validate the taxonomy against the current Postgres release and add direct documentation links per probe before merging the experiment into the main city navigation.
