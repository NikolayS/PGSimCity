# Roadmap

What is being worked on, what is known to be wrong, and what is deliberately not
being done. Ordered by whether it misleads a reader, not by effort.

This file is the single place to look. Before it existed, the same information
was scattered across GitHub issues that had gone stale, a "Known issues" list in
the changelog that still named fixed defects, and a survey nobody had read.

---

## Now

### The 2D prototype — a machine, not a diagram

The observability page's flow view was judged the wrong direction: a pipeline of
boxes, not architecture. It is superseded by a prototype in the visual language
of Zachtronics' *Opus Magnum* — axonometric 2D, every element a machine part
with a visible pivot, and the whole cast running on different periods.

The rhythm is the lesson. Backends cycle fast, the bgwriter sweeps steadily, the
walwriter never stops, the checkpointer fires rarely and heavily, autovacuum
carts travel and return, and the walsender feeds a second machine off to one
side. A viewer should see those relationships without reading anything.

It is a **semi-simulator**: PGlite supplies what only real PostgreSQL can — the
parse, the plan, the catalogs, the results — and the model supplies the interior
and everything concurrent, which a single-connection engine cannot produce. Which
is which must be visible at a glance.

### Labels take over the screen on a phone — [#4](https://github.com/NikolayS/PGSimCity/issues/4)

Reported by a user. The floating labels are DOM elements at a fixed pixel size,
so zooming out shrinks the model and not the text. On a 390 px viewport a single
chip is about 44% of the width. Detail tiering in v0.9.0 reduced how much text
appears but not how large it is, so the problem returns at distance.

Being fixed with a measurable guarantee rather than a heuristic: total label area
must not exceed a stated fraction of the frame, at any distance and any viewport.

---

## Next

### Eleven knobs whose outputs do not respond correctly

A systematic sweep — turn every knob across its range, record every output, then
turn it back — found defects in eleven of twenty-two. Three rounds of expert
review had missed all of them, because every review asked *"is this mechanism
correct?"* statically. These are only visible when something **changes**.

Worst first:

- **High-load recovery.** After `tps` 5000 → 1 or `writeRatio` 1 → 0, the WAL
  rate and `wal_buffers` stay high for at least twenty simulated minutes. The
  original drain defect is fixed; what remains is an undisclosed long tail of
  vacuum work over relations the stress phase enlarged. Indistinguishable to a
  viewer from the bug that was fixed.
- **`wal_level = minimal` reports 677 MiB held by a logical slot** while
  `replica` reports 512 KiB. Backwards by a factor of 1,300, and logical decoding
  is impossible at `minimal`, so the slot should hold nothing.
- `updateRatio` dead-row response, `checkpointTimeout` WAL rate,
  `replicaNetworkLag` under `remote_apply`, `bgwriterLruMaxpages` cleaning,
  `fullPageWrites`, `seqScanRatio`, `standbyLongQuery`.

The survey is the input; each fix needs a failing test that reproduces it first.

### Documentation that describes behaviour the app no longer has

Caught three times now — a control binding wrong for three releases, an
instruction to drag a slider below its own minimum, and a duplicated README from
a bad merge. A sweep of every actionable instruction against the running
application is in progress. The durable fix is a test that drives each documented
instruction, not another proofread.

---

## Later

- **Contextual links** — one per mechanism panel, pointing at content that
  answers the reader's problem, tagged for attribution. The existing 33+ external
  references are a strength; a link that looks like the citations around it
  converts on curiosity, one that is visually privileged reads as an ad.
- **A corrections pipeline** — an issue template for "this does not match how
  PostgreSQL behaves", and a per-panel link that opens it pre-filled. The README
  calls corrections the most valuable contribution; make them one click.
- **A low-friction way to follow the project.** RSS and the repository watch
  button may serve this audience better than an email field, and ask for less.
- **Blog-post format explainers**, in the manner of Bartosz Ciechanowski — one
  mechanism, one page, live diagrams. A different form from the city and better
  suited to depth on a single idea.
- **Text-to-speech narration** for the tour, using the browser's own speech API.

---

## Not doing

- **Replacing the hand-written simulation with real PostgreSQL.** A running
  server exposes catalogs, `pg_stat_*`, `EXPLAIN` and log output — and nothing
  else. Not the clock sweep choosing a victim frame, not a page landing in a
  specific buffer, not the checkpointer's write phase. Those are what this
  project draws. Real PostgreSQL is added alongside the model, never instead of
  it.
- **Connecting to a live production database.** Different product, and it changes
  this from a teaching model into an observability tool.
- **New districts or mechanisms** while the existing ones still have defects.
  Polish what is there.

---

## Known limitations

Carried honestly rather than hidden:

- Touch controls have been verified only in Chrome's mobile emulation, which
  differs from iOS Safari in touch handling and viewport units. No real-device
  pass has been done.
- The plate's containment audit constrains the Slonik silhouette. The shape holds
  the city, and the city was not laid out to be an elephant.
- Rendering on modest hardware falls to the `reduced` quality tier. That tier is
  now genuinely usable, but it is not what the screenshots show.
