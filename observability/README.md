# Diagnose — the symptom console

A second page in PGSimCity, served at `/observability/`. It is not a map of the
`pg_stat_*` views. It is the other half of that idea: you start from a complaint
in plain language, the simulation is put into a state that produces it, and you
are walked to the view and the column that proves what is wrong — reading live
rows out of the running model at every step.

## Why it is not a diagram

The reference in this space is [Alexey Lesovsky's PostgreSQL Observability
map](https://pgstats.dev/), which maps every subsystem to the views and
functions that observe it. It is one glanceable image, it is printable, and it
is the product of a great deal of domain judgement. PGSimCity is not going to
out-index it, and an earlier attempt to redraw it here was worse than the
original on the one axis that makes the original good.

But that diagram has a structural limit it can never escape: there is no
database behind it. It can tell you `pg_stat_replication.flush_lsn` exists and
what it means. It cannot show you a `flush_lsn` that is falling behind right now.

PGSimCity has a server — `src/sim/model.ts`, a real PostgreSQL model with a
clock sweep, three WAL positions, WAL-triggered checkpoints, an xmin horizon and
a single-threaded standby. That is the one asset this project holds that no
other Postgres learning resource has, and this page is built to spend it.

## What is on the page

* **Eight complaints**, in the words people actually use: *everything is slow*,
  *writes stall every few minutes*, *a table keeps growing and VACUUM is not
  helping*, *the read replica is serving stale data*, and so on. Picking one
  stages the model into a configuration that produces that symptom, runs it
  forward ninety model-seconds so the cumulative counters mean something, and
  opens step one.
* **A decision tree** with about twenty steps and twenty verdicts. Each step
  asks one question, shows the SQL you would actually type, renders a **live
  result set** from the model in real column names, tells you what to look for,
  and lists the branches. Every branch carries a predicate over live state, so
  the tool evaluates them itself and marks the ones that are true this second.
* **Verdicts** that end at a diagnosis, live evidence, the mechanism, the fix,
  and the GUC you can turn right there — under its real name — plus a query to
  re-run and confirm the fix worked.
* **A verdict that grades itself.** Thirteen of the diagnoses re-run their own
  finding against live state and report `STILL PRESENT`, `RESOLVED`, or
  `NO EVIDENCE YET`, with the reading that decided it. This is the one thing a
  diagram structurally cannot do — it can tell you what is wrong and it cannot
  tell you whether you fixed it — and it is the reason the page is built on a
  running model rather than on a picture. The third state is not padding:
  counter-based views genuinely have nothing to say for the first few seconds
  after a reset, and grading an empty counter as a pass would be this page
  committing the exact error it spends a paragraph warning against.
* **An instrument list**: every view the model can serve, live, with the full
  verified column list, what changed in which release, and a PG version rail.
  Select PostgreSQL 15 and `pg_stat_io` and `pg_stat_checkpointer` become blind
  spots that say what you would use instead.
* **A cumulative ⇄ per-second toggle** and a working `SELECT pg_stat_reset()`,
  because "these are counters, not rates" is the most common misreading of
  `pg_stat_*` and it is impossible to teach in prose and trivial to teach with
  a switch.

## The honesty rules

These are hard constraints in the code, not aspirations.

1. **Names are real.** Every view, function, column and enum value — every
   `wait_event_type`/`wait_event` pair, every vacuum `phase` string, every
   `pg_stat_io` `object` and `context` value — was checked against
   postgresql.org/docs/current (PostgreSQL 18.4) while it was written. Where a
   name changed between releases the change is recorded and shown. The
   capitalisation counts: PostgreSQL 17 began generating the wait event list
   from a table and normalised it on the way through, so the WAL flush wait is
   `WALSync` on 16 and older and `WalSync` from 17 on. This page says `WalSync`,
   and says why.
2. **The query above a table is the query that produced it.** If a step prints a
   `WHERE` clause or an `ORDER BY`, the rows underneath honour it. A page whose
   whole argument is "these names are checkable" cannot afford a result set its
   own query would not have returned.
3. **Hand-computed ratios say "—" when there is nothing to divide.** `forced %`,
   `hit %` and `fpi share` are arithmetic on counters, not columns, and zero over
   zero is undefined rather than zero. This matters at precisely the moment the
   reader cares most — just after a fix and a `pg_stat_reset()` — where printing
   a reassuring green `0%` would be the page inventing a measurement.
4. **Numbers are the model's, and the page says so.** A column appears only if
   the model genuinely produces it. Nothing is padded with a plausible-looking
   figure. Each instrument carries a coverage badge — `live`, `partial` or
   `absent` — and the partial ones say exactly which columns the model cannot
   fill and why.
5. **Two counters are derived, and are labelled as derived.** `wal_bytes` is
   exact (it is the LSN advance); `wal_records` and `wal_fpi` are shaped by the
   model rather than measured, and the caption says so on the table itself.
6. **`pg_stat_statements` and `pg_stat_slru` are marked absent.** The model has
   no per-statement history and no SLRU counters, and the page will not fake
   them. That absence is instructive: `pg_stat_statements` is not installed by
   default on a real server either.

## Colour

The palette comes from `src/styles/tokens.css` via a single `@import`, and the
subsystem accents agree with `src/core/theme.ts`: WAL amber, checkpointer pink,
background writer teal, replication orange, vacuum violet, locks red. A reader
who has learned the city's colour language must not be misinformed by this page.
There is no remote font, no CDN and no network request of any kind.

## Files

| | |
|---|---|
| `observability/index.html` | the shell |
| `src/observability/main.ts` | app assembly, navigation, render |
| `src/observability/catalog.ts` | verified view metadata and column lists |
| `src/observability/collector.ts` | the cumulative statistics system, model edition |
| `src/observability/views.ts` | `SimState` → live `pg_stat_*` row projections |
| `src/observability/paths.ts` | the symptoms, the decision tree, the verdicts |
| `src/observability/ui.ts` | result grid, SQL block, knobs, vitals |
| `src/observability/style.css` | page styles, on the city's tokens |

## Run

```bash
npm run dev        # http://localhost:5173/observability/
npm run typecheck
npm run build
```

`vite.config.ts` only adds this entry when `observability/index.html`,
`src/observability/main.ts` and `src/observability/style.css` all exist. Never
leave the tree with one of those missing.

## How you get here

The city links to this page from one HUD button (the bolt icon, next to the
tour and the command palette). That single link in `src/ui/hud.ts` is the only
edit this feature makes outside `observability/**` and `src/observability/**`.
It is a plain `<a href="observability/">` — relative, so it survives being
served from `/PGSimCity/` on GitHub Pages — and it needs no wiring because the
console runs its own instance of the simulation.

Every verdict links back the other way, into the city component that implements
the mechanism, via `../#/c/<component-id>`.

## Known limits

* The model has one global xmin horizon rather than a per-session
  `backend_xmin`, so on the bloat path the abandoned session is that held
  snapshot drawn as the session holding it. Its age and its xmin are real; the
  table caption says so.
* There is no `autovacuum worker` row in `pg_stat_io` because the model does not
  attribute vacuum's own I/O separately. On a real server there would be one.
* `pg_replication_slots` never decays to `unreserved` or `lost` — the model
  always keeps its subscriber fed. That is the one failure this page cannot
  demonstrate, and the caption admits it.
* The page shares a JavaScript chunk with the city that still carries part of
  three.js, because `src/sim/model.ts` imports `src/world/layout.ts` for its
  table definitions. Moving those definitions to a renderer-free module would
  shrink this page; that change is outside this feature's files.
* The eight complaints cover the failures this model can actually produce. The
  ones it cannot — transaction ID wraparound, a lost replication slot, a bad
  plan after a missing ANALYZE, temp file spill — are absent rather than faked,
  and they are the obvious next paths if the model grows to support them.

## Layout note, recorded because it was a real bug

`#app` states `grid-template-columns: minmax(0, 1fr)` explicitly. Left implicit
the single column is an `auto` track, which takes its growth limit from
max-content — and the max-content of the top bar is the six vitals at their
minimum width, about 806px. On a 390px phone the track sized to 806, and since
`body` clips overflow the excess was not scrolled to, it was *destroyed*: the
right-hand third of every row, including half of each complaint, ceased to
exist with no scrollbar to reveal it. The old page failed the same test at
900px. Check narrow widths before shipping anything here.
