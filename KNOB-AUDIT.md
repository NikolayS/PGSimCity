# Knob audit — does every control produce the consequence it claims?

Roadmap item 8. Gates items 1–4 and 10, and specifically item 4: a lever you walk
up to and pull is far more persuasive than a slider in a panel, so a lever wired
to a knob with a wrong consequence chain is a machine for teaching a falsehood
convincingly.

Scope: all 23 fields of `Knobs` in `src/core/types.ts:75`. Method: read every
consumer, then drive the model directly — `createSim()` with a stub bus,
`setKnob()`, `update(1/30)`, seeded RNG, 300–400 s of warm-up before every
reading, and an explicit down-sweep afterwards to test recovery. Every number
quoted below is measured, not estimated.

**Verdict count: 13 `CORRECT`, 10 `WRONG`, 0 `MISSING`.**

The roadmap says "eleven of twenty-two". This audit re-grades four of them and
adds three the earlier sweep passed; see [Changes from the previous
sweep](#changes-from-the-previous-sweep).

---

## Verdict table

| # | Knob | Real setting | Verdict | One-line reason |
|---|---|---|---|---|
| 1 | `tps` | (workload, not a GUC) | **CORRECT** | WAL scales linearly with achieved commits once vacuum is isolated: 52 → 385 → 2 600 → 6 800 KiB/s at 10/100/1000/5000 tps. |
| 2 | `writeRatio` | (workload) | **CORRECT** | WAL 0 / 176 / 358 / 526 / 685 KiB/s across 0…1. Near-perfectly linear. |
| 3 | `updateRatio` | (workload) | **CORRECT** | Dead tuples 235k / 370k / 486k / 612k; `tup_inserted` and `tup_updated` exchange correctly; recovers to zero. |
| 4 | `seqScanRatio` | (workload) | **CORRECT** | Hit ratio 92.9 → 62.0 %, reads 147 → 7 600 pages/s, tps 308 → 0.3 at a 256 MiB pool. |
| 5 | `sharedBuffers` | `shared_buffers` | **CORRECT** | Hit ratio 34 / 76 / 96 / 100 / 100 % at 128 MiB … 64 GiB; plateau disclosed. |
| 6 | `checkpointTimeout` | `checkpoint_timeout` | **WRONG** | Schedule moves correctly; the WAL/full-page-image benefit it exists for is absent (40× the interval → 2 % less WAL). |
| 7 | `checkpointCompletionTarget` | `checkpoint_completion_target` | **CORRECT** | Write phase 5.0 → 29.8 → 31.3 s; trigger distance and I/O pressure both respond. |
| 8 | `maxWalSize` | `max_wal_size` | **CORRECT** | 61 / 14 / 7 / 7 checkpoints and 6 / 15 / 24 / 24 retained segments at 64 MiB … 4 GiB; correctly saturates once the timer takes over. |
| 9 | `bgwriterEnabled` | `bgwriter_lru_maxpages = 0` | **WRONG** | Enabling the writer *lowers* throughput 11–22 %. The benefit it exists for — backends not stalling on their own victim writes — is not modelled at all. |
| 10 | `bgwriterLruMaxpages` | `bgwriter_lru_maxpages` | **WRONG** | Inert above ~100 at every pool size. The shipped advice ("raise it to a few hundred") cannot be demonstrated. |
| 11 | `synchronousCommit` | `synchronous_commit` | **WRONG** | `on` is byte-identical to `local`, which asserts no synchronous standby; `remote_apply` waits for one. Both cannot be true. |
| 12 | `walLevel` | `wal_level` | **WRONG** | At `minimal`: 4.9 GiB of pg_wal against `max_wal_size = 256 MiB`, 4 800 MiB "held by a logical slot", 342 s of replay lag, 41.6 logical changes/s. None of these can exist. |
| 13 | `fullPageWrites` | `full_page_writes` | **WRONG** | 22× WAL swing and a 1.9× throughput reward for disabling torn-page protection at shipped settings. Correct (1.9× WAL) once vacuum is isolated. |
| 14 | `autovacuum` | `autovacuum` | **WRONG** | **Priority case.** At shipped defaults, one simulated hour with it off moves the worst table from 0.02 % to 0.58 % bloat. Vacuum's own WAL is ~9× the workload's. No wraparound safety valve. |
| 15 | `autovacuumScaleFactor` | `autovacuum_vacuum_scale_factor` | **CORRECT** | Steady-state dead tuples 211k / 312k / 552k and 10 / 8 / 3 runs at 0.01 / 0.02 / 0.5. Formula matches PostgreSQL's. |
| 16 | `longRunningXact` | an open snapshot | **CORRECT** | Horizon freezes, `oldestSnapshotAge` → 300 s, bloat climbs, release recovers within 300 s, relation size correctly does not shrink. |
| 17 | `lockContention` | `ACCESS EXCLUSIVE` lock | **CORRECT** | 15 backends blocked, 12 wait edges, throughput → 0; clears completely on release. |
| 18 | `replicaEnabled` | a streaming standby | **WRONG** | With the standby off, `replay_lag` climbs to 300 s, `lagBytes` to 1.6 GiB and "WAL held by the slot" to 1.6 GiB — all for a standby that is gone. |
| 19 | `replicaNetworkLag` | network RTT to the standby | **WRONG** | A 400 ms one-way delay is reported as 2.605 s of `replay_lag`. Fixed undisclosed 6× factor, against a documented 100× stretch. |
| 20 | `replicaSlowApply` | standby apply bottleneck | **CORRECT** | Lag 0.37 s → 168.5 s → 0.43 s; flush/replay gap opens and closes. |
| 21 | `standbyLongQuery` | `hot_standby_feedback` | **WRONG** | Pins the primary's xmin horizon with `replicaEnabled = false` **and** `wal_level = minimal` — feedback from a standby that cannot exist. |
| 22 | `timeScale` | (presentation) | **CORRECT** | 300 × `update(1/30)` at `timeScale = 3` advances model time 10.00 s; `realT` divides back out; clamps at 20. |
| 23 | `paused` | (presentation) | **CORRECT** | Advances 0.0000 s. |

---

## Cross-cutting root causes

Eight of the ten `WRONG` verdicts trace to six shared defects. Fix these and
most of the table clears without touching the knobs individually.

### RC-1 — autovacuum's WAL and I/O are roughly an order of magnitude too large

**Measured.** Identical workload (`tps 300`, `writeRatio 0.6`), 200 s window
after 300 s warm-up:

| | mean WAL | full-page-image share | achieved tps |
|---|---|---|---|
| `autovacuum = false` | 540 KiB/s | 0.65 | 190 |
| `autovacuum = true` | 4 900 KiB/s | 0.98 | 48 |

Vacuum produces **9× the WAL of the workload that created the garbage** and
takes **75 % of the throughput**. On a real server, vacuuming a relation that is
~2 % dead writes a small fraction of the WAL that the DML wrote, because one
`XLOG_HEAP2_PRUNE_VACUUM_SCAN` record covers every dead line pointer on a page.

**Cause A — one full-page image per vacuumed page, charged twice per pass.**
`walInsertPage()` (`src/sim/model.ts:1328`) charges a ~6.5 KiB image for every
page vacuum modifies. `vacHeapModified` (`src/sim/model.ts:1958`) is
`pages × (1 − e^(−dead/pages))`, which for a 220 000-page relation with 200 000
dead tuples is ~135 000 pages. Both `scan_heap` (`:2029`) and `vacuum_heap`
(`:2081`) walk that same set, and because a pass lasts far longer than a
checkpoint interval, `fpiGeneration` has advanced in between, so most pages pay
a *second* image inside one pass. Result: hundreds of MiB of WAL per vacuum
pass.

**Cause B — no vacuum cost delay.** The model has no analogue of
`vacuum_cost_delay` / `autovacuum_vacuum_cost_delay`. `scan_heap` charges
`ioReadAcc += t.pages × dt / (t.pages/900)` = 900 pages/s per worker; three
workers is exactly `DEVICE_PAGES_PER_SEC` (`src/sim/model.ts:255`). Autovacuum
therefore saturates the modelled device by construction, which is precisely the
thing PostgreSQL's cost-based delay exists to prevent.

**Right behaviour.**
- Give each vacuum worker a cost budget. PostgreSQL: `vacuum_cost_page_hit = 1`,
  `vacuum_cost_page_miss = 2` (10 before PostgreSQL 14),
  `vacuum_cost_page_dirty = 20`, `vacuum_cost_limit = 200`,
  `autovacuum_vacuum_cost_delay = 2ms` (20 ms before PostgreSQL 12). The worker
  sleeps for `cost_delay` whenever accumulated cost exceeds `cost_limit`. Model
  it as a per-worker rate cap that leaves headroom on `DEVICE_PAGES_PER_SEC` —
  a sensible scaled target is that all three workers together consume no more
  than ~25 % of the device, so foreground work still gets served.
- Charge a full-page image **once per page per checkpoint generation across the
  whole pass**, not once per phase. Pin the generation at pass start.
- Only pages that actually contain removable dead tuples should be modified.
  `scan_heap` should emit WAL only for pages it prunes; the read of the rest of
  the relation is I/O, not WAL. Today `scan_heap` and `vacuum_heap` each emit a
  record for every page in `vacHeapModified`.

**Timescale and settling point.** With the workload above, vacuum WAL should
settle at well under the foreground WAL rate — target 10–30 % of it, i.e.
50–160 KiB/s against 540 KiB/s, not 4 400 KiB/s. The full-page-image share
should land near the `autovacuum = false` value (0.65), not 0.98.

**Knobs this unblocks:** `tps`, `writeRatio`, `fullPageWrites`, `autovacuum`,
`checkpointTimeout` (partly).

### RC-2 — `tickReplication()` returns early and freezes every replication value

`src/sim/model.ts:2273`:

```ts
if (!rep.enabled || K.walLevel === 'minimal') {
  …
  rep.lagBytes = Math.max(0, wal.flushLsn - rep.replayLsn)
  updateReplayLag()
  return
}
```

The early return is above the logical-decoding block (`:2383`), so
`rep.logicalSlotLsn` and `rep.logicalChangesPerSec` are never updated. It is
also above everything that advances `rep.replayLsn`, so `updateReplayLag()`
measures the age of a pointer that will never move again. And `tickSegments()`
(`src/sim/model.ts:1605`) computes `slotHold` from `rep.flushLsn` under
`if (rep.enabled)`, which is still `true` at `wal_level = minimal`.

**Measured**, fresh sim at `wal_level = minimal`, `tps 300`, `writeRatio 0.6`:

| elapsed | pg_wal segments | pg_wal size | "WAL held by the slot" | `replay_lag` |
|---|---|---|---|---|
| 60 s | 24 | 0.38 GiB | 189 MiB | 60.5 s |
| 300 s | 79 | 1.23 GiB | 1 100 MiB | 185.2 s |
| 600 s | 179 | 2.80 GiB | 2 700 MiB | 342.2 s |
| 1200 s | 315 | **4.92 GiB** | **4 800 MiB** | 105.7 s |

`max_wal_size` is 256 MiB. Every one of those numbers is impossible: at
`wal_level = minimal` there is no standby, no replication slot and no replay
position. `logicalChangesPerSec` behaves the same way — after
`logical → minimal` it holds 41.6 changes/s indefinitely, beside a card that
reads "off — wal_level is not logical".

The same freeze fires on `replicaEnabled = false`: measured `lagSec 300.37`,
`lagBytes 1.6 GiB`, slot retention 1.6 GiB, with `connected = false`.

**Right behaviour.** Restructure `tickReplication()` so the disconnected branch
*normalises* rather than returns:

- `rep.logicalEnabled = K.walLevel === 'logical' && rep.enabled && rep.connected`.
- When not logical: `rep.logicalSlotLsn = wal.insertLsn` (so derived retention is
  zero, not negative and not stale) and decay `logicalChangesPerSec` toward 0 at
  the existing rate 3 — visible decay over ~1 s, which is honest for a decoder
  that has stopped.
- When there is no standby: `rep.replayLsn = rep.flushLsn = rep.writeLsn =
  rep.sentLsn = wal.flushLsn`, `lagBytes = 0`, `lagSec = 0`. The *fact* to
  surface is "no standby", not "a standby that is 342 s behind". `pg_wal`
  retention must fall back to `max(sinceRedo, 0)` so it is bounded by
  `max_wal_size` again.
- `slotHold` must be gated on `rep.connected`, not `rep.enabled`.

**Also fix the readouts, which are guarded on the wrong field.** Six places
guard on `replication.enabled`/`connected` and four do not:

| Location | Metric | Problem |
|---|---|---|
| `src/ui/docs-storage.ts:445` | "WAL held by the slot" | guards `!s.replication.enabled`; must guard `!s.replication.logicalEnabled` — a *logical* slot exists only at `wal_level = logical`. At `replica` it currently prints `insertLsn − flushLsn`, i.e. unflushed WAL, mislabelled as slot retention (measured 15.2 MiB). |
| `src/ui/docs-storage.ts:1744` | "WAL retained for it" | same guard, same fix. |
| `src/ui/docs-storage.ts:442`, `:1741` | "Changes / s" | unguarded; must read 0 unless `logicalEnabled`. |
| `src/ui/docs-storage.ts:1487` | "Behind by" | unguarded; prints `1.6 GiB · 5m 0s` for an absent standby. Must show `—` like `:1542`. |
| `src/world/replication.ts:1305` | standby client readout | `reads see <lsn> — 300.4 s old` for an absent standby. |

`src/observability/views.ts:744` (`pg_stat_replication`) and `:967` (`slots`)
are already correctly guarded and disagree with the panels — that disagreement
is the cheapest regression test available.

**Knobs this unblocks:** `walLevel`, `replicaEnabled`.

### RC-3 — the write working set has no repeating middle band

`src/sim/model.ts:591-600`: 93 % of heap writes land in `hotPages`, which is
`clamp(round(pages × 0.0001), 8, 32)` — at most 32 pages per relation. The other
7 % land uniformly across the whole relation (219 000 pages for `accounts`).

There is nothing in between. The hot set is re-modified many times inside any
checkpoint interval, so it pays essentially no full-page images per unit time.
The cold set is never re-modified, so **every** cold write pays an image no
matter how far apart checkpoints are. Full-page-image bytes per second is
therefore almost independent of `checkpoint_timeout`, which removes the entire
reason that GUC exists.

**Measured**, `autovacuum = false`, `writeRatio 1`, `updateRatio 1`,
`seqScanRatio 0`, `max_wal_size 4096` so the timer governs:

| `checkpoint_timeout` | WAL | full-page-image share | checkpoints in 400 s |
|---|---|---|---|
| 15 s | 1 331 KiB/s | 0.551 | 26 |
| 60 s | 986 KiB/s | 0.604 | 6 |
| 300 s | 1 024 KiB/s | 0.556 | 0 |

**Right behaviour.** Add a warm band: a few thousand pages per relation that a
15 s interval touches once or twice and a 300 s interval touches dozens of
times. Concretely, replace the two-way split with three:

- hot (~60 % of writes): today's `hotPages`, 8–32 pages — repeats constantly.
- warm (~35 % of writes): `clamp(round(pages × 0.02), 512, 8192)` pages, drawn
  with the same `u²` skew — this is the band `checkpoint_timeout` acts on.
- cold (~5 % of writes): uniform over the relation — the irreducible floor.

With that split, doubling `checkpoint_timeout` should move the full-page-image
share by roughly a factor of two over the range where the warm band is being
revisited (roughly 15 s → 300 s here), and flatten out beyond it — which is also
what happens on a real server, and is the honest shape.

Do not simply shrink the cold share to zero. A uniform-random write workload
over a relation far larger than one checkpoint's worth of writes genuinely gets
no benefit from a longer interval, and the model should still be able to show
that.

**Knobs this unblocks:** `checkpointTimeout`.

### RC-4 — a backend that evicts a dirty page pays nothing for the write

`writeOut(b, byBackend)` at `src/sim/model.ts:1148` increments `ioWriteAcc` and
`buf.dirtyEvictions` and emits a flow particle. It does not extend the
evicting backend's `stateDur` or `execTotal`. The only coupling back to latency
is the global, 250 ms-lagged, quadratic `ioLoad` in `tickStats()`.

So the model reproduces the bgwriter's *cost* (extra writes of pages that get
re-dirtied) and none of its *benefit*. In PostgreSQL, `BufferAlloc()` →
`FlushBuffer()` is synchronous for the backend that needs the frame, and it must
`XLogFlush()` the page's LSN first — that is the whole reason the background
writer exists.

**Right behaviour.** In `touchPage()`'s miss path, when `writeOut(v, true)`
actually writes a dirty frame, charge the requesting backend a synchronous write
cost — add it to `x.execTotal` and to the current `stateDur`. A scaled cost of
one device write plus the queue in front of it, i.e.
`(1 / DEVICE_PAGES_PER_SEC) × ioPressure()` per dirty eviction, is the smallest
honest version and is already dimensionally consistent with `beginExec()`.

**Knobs this unblocks:** `bgwriterEnabled`.

### RC-5 — `wal_buffers` is a constant that ignores `shared_buffers`

`src/sim/model.ts:104`:

```ts
/** wal_buffers: PostgreSQL auto-tunes this to shared_buffers/32 → 256 KiB here. */
const WAL_BUF_CAP = 256 * 1024
```

The arithmetic does not hold: `shared_buffers = 2GB` divided by 32 is 64 MiB,
capped at one WAL segment, so PostgreSQL's `wal_buffers = -1` resolves to
**16 MiB**, not 256 KiB. 256 KiB corresponds to `shared_buffers = 8MB`. And it
is a module constant, so the value does not follow the knob at all:

| `sharedBuffers` | model `wal.bufferCapacity` | PostgreSQL `wal_buffers = -1` |
|---|---|---|
| 128 MiB | 256 KiB | 4 MiB |
| 2 GiB (default) | 256 KiB | 16 MiB |
| 64 GiB | 256 KiB | 16 MiB |

Two shipped passages state the correct rule beside the wrong number:
`src/ui/docs-memory.ts:1019` ("one thirty-second of `shared_buffers` capped at
one 16 MiB segment") and `src/ui/docs-storage.ts:163` ("the default of 1/32 of
`shared_buffers` (capped at 16 MiB)"), while `src/ui/docs-memory.ts:1028` prints
`s.wal.bufferCapacity`.

**Right behaviour.** Derive it in `resizePool()`:
`wal.bufferCapacity = clamp(poolBytes(K) / 32, 64 * 1024, WAL_SEG)`. This is not
currently load-bearing for a bottleneck — measured `wal_buffers` occupancy
stayed at 0 % up to 11.7 MiB/s of WAL — so it is a low-risk correction of a
printed number that contradicts the paragraph above it.

### RC-6 — `NET_STRETCH = 6` contradicts `MODEL_TIME_STRETCH = 100`

`src/sim/model.ts:209` stretches configured network delay by 6× into simulated
seconds. `src/sim/model.ts:109` exports `MODEL_TIME_STRETCH = 100` for UI
disclosures. Measured `replay_lag` against the configured one-way delay:

| `replicaNetworkLag` | reported `replay_lag` | ratio |
|---|---|---|
| 0 ms | 0.107 s | — |
| 50 ms | 0.542 s | 10.8× |
| 200 ms | 1.397 s | 7.0× |
| 400 ms | 2.605 s | 6.5× |

The control is labelled in real milliseconds; `pg_stat_replication.replay_lag`
and the HUD's "Repl lag" are labelled in real seconds. A fixed, undisclosed 6×
distortion sits between them.

**Right behaviour.** Report replication timings in real units: divide by
`NET_STRETCH` on the way out (`rep.lagSec`, `commitWaitEstimate()`'s network
term, and the standby's `TX_LAT` readout), keeping the 6× only inside the
scheduling of `wireAt` / `ackAt` where it buys visible packet travel. A 400 ms
one-way delay should then report ~0.4–0.5 s of `replay_lag` and a `remote_apply`
commit wait of roughly one round trip. If the stretch is kept instead, the
disclosure must name 6× wherever a replication duration is printed — but
reporting real units is the better answer, because `replay_lag` is a number
operators are expected to compare against a real server's.

---

## Detail — the priority case: `autovacuum`

### What the real setting does

`autovacuum` (boolean, default `on`) controls whether the postmaster runs the
autovacuum launcher. With `track_counts` on, the launcher wakes every
`autovacuum_naptime` (default 60 s) and starts a worker per database; a worker
vacuums every relation where

```
n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples
```

(defaults 50 and 0.2), or, since PostgreSQL 13,

```
n_ins_since_vacuum > autovacuum_vacuum_insert_threshold + autovacuum_vacuum_insert_scale_factor × reltuples
```

(defaults 1000 and 0.2). At most `autovacuum_max_workers` (default 3) run at
once. Crucially: **even when `autovacuum` is off, the system still launches
autovacuum workers to prevent transaction ID wraparound**, once a relation's
`age(relfrozenxid)` exceeds `autovacuum_freeze_max_age` (default 200 million).

### What turning it off should look like

1. `n_dead_tup` climbs monotonically at the rate the workload manufactures dead
   row versions, minus what HOT pruning reclaims opportunistically.
2. Once dead tuples exceed the free space on their pages, the relation is
   **extended**: `pg_relation_size` grows and never comes back.
3. Index size grows too, because a non-HOT `UPDATE` and every `DELETE` leave
   index entries that only vacuum removes.
4. The cache hit ratio degrades as the same live rows spread over more pages.
5. Sequential scans and index scans both slow down for the same reason.
6. The visibility map stops being maintained, so index-only scans stop being
   index-only.
7. Eventually, wraparound protection starts vacuums anyway, regardless of the
   setting.

### What the model actually does

**At shipped defaults** (`tps 10`, `writeRatio 0.2`, `updateRatio 0.6`) — which
is the state a visitor who walks up to a lever is in:

| after turning it off | `sessions` bloat | `sessions` dead | `sessions` pages | `documents` bloat | `accounts` bloat |
|---|---|---|---|---|---|
| 0 s | 0.02 % | 601 | 35 840 | 0.92 % | 0.89 % |
| 300 s | 0.07 % | 1 800 | 35 840 | 0.93 % | 0.90 % |
| 1 200 s | 0.21 % | 5 200 | 35 840 | 0.99 % | 0.91 % |
| 3 600 s | **0.58 %** | 14 200 | **35 840** | 1.13 % | 0.93 % |

After **one simulated hour**, the worst-affected relation is 0.58 % dead and has
not grown by a single page. The autovacuum yard's landfill counter never moves
because no vacuum is due. The shipped hint (`src/ui/content.ts:231`) promises
"watch dead rows pile up until the tables are mostly corpses"; reaching 50 %
bloat at this rate would take roughly **60 simulated hours**.

**Under a hard workload** (`tps 500`, `writeRatio 0.8`, `updateRatio 1`) the
mechanism is visible and correct:

| after turning it off | `sessions` bloat | `sessions` pages | `documents` bloat | `events` bloat |
|---|---|---|---|---|
| 0 s | 2.27 % | +3.4 % | 3.56 % | 0.00 % |
| 600 s | 12.36 % | +7.6 % | 6.54 % | 0.00 % |
| 1 800 s | 29.74 % | +25.7 % | 16.14 % | 0.00 % |
| 3 600 s | 42.80 % | +48.8 % | 24.12 % | 0.00 % |

That is the right shape. `events` staying at 0 % is correct and is a good
lesson — it is append-only and never the target of an `UPDATE` or `DELETE`.

**Turning it back on**, from the 42.8 % state:

| after turning it on | `accounts` | `orders` | `sessions` | `documents` | pages |
|---|---|---|---|---|---|
| 60 s | 4.59 % | 9.64 % | 42.92 % | 24.23 % | unchanged |
| 300 s | 4.64 % | 9.78 % | **1.37 %** | 24.47 % | unchanged |
| 900 s | **0.18 %** | **0.38 %** | 1.92 % | **1.72 %** | unchanged |

Bloat comes down, relation size correctly does not. But for the **first 60
seconds nothing at all happens**, and three of four relations are untouched for
five simulated minutes. The delay is structural: `AV_NAPTIME` is 12 s, then a
2 s `travel` phase, then `scan_heap` runs for `max(pages/900, 1.2)` seconds —
58 s for `sessions` at 52 000 pages, 250 s for `accounts` at 225 000, and only
three workers exist for five relations.

### Verdict and required behaviour

`WRONG`. Four separate defects:

1. **The consequence is invisible at the settings a visitor is in.** The lever
   must produce a legible change within a visit. Target: with the shipped
   default workload, the hottest relation should cross 5 % bloat inside ~2
   simulated minutes and keep climbing, and its page count should be visibly
   growing within ~5 minutes. That requires the dead-tuple production rate per
   transaction to be scaled against relation size the way everything else in
   the city is scaled for observation — either by raising the per-statement row
   counts on the small hot relations, or by shrinking `sessions`/`documents`
   toward a size where the default workload can actually bloat them. Do not
   raise the default `tps`: that changes every other lesson.
2. **Turning it off is rewarded with throughput.** Measured 113 → 239 tps at
   `tps 300`, and 48 → 190 tps at `tps 300, writeRatio 0.6`. That is RC-1: the
   model's vacuum is so expensive that switching it off looks like free
   performance, with no offsetting degradation over the following ten minutes.
   After RC-1, disabling autovacuum should give a small immediate bump (single
   digit percent) that is then progressively eaten by growing relations and a
   falling cache hit ratio.
3. **Re-enabling shows nothing for a minute.** The first worker should reach a
   relation and start returning dead tuples to the landfill within ~10–15
   simulated seconds. Keep `scan_heap`'s cost proportional to relation size —
   that is true and worth teaching — but cap the phase so the largest relation
   scans in ~20 s rather than ~8 minutes, and let `vacuum_heap` begin collecting
   from the pages already scanned rather than waiting for the whole scan. Real
   vacuum interleaves: it fills `maintenance_work_mem` with dead TIDs, vacuums
   the indexes, vacuums the heap, and then continues scanning. Modelling that
   loop is what makes progress visible.
4. **No wraparound safety valve.** The model has no `age(relfrozenxid)` and
   never launches a worker while `autovacuum = false`. This is one of the most
   important things about the setting and the reason "turn autovacuum off"
   does not simply stop vacuuming forever. Add an xid-age counter per relation
   that advances with `state.xid`, and launch a worker regardless of
   `K.autovacuum` once it crosses a scaled `autovacuum_freeze_max_age`, with a
   toast naming it. This is also a prerequisite for roadmap item 10 — "the disk
   is filling, what do you do" has a wraparound sibling that is strictly worse.

### Recovery symmetry

| quantity | recovers? | correct? |
|---|---|---|
| `n_dead_tup` | yes, over 300–900 s | **yes** |
| bloat fraction | yes | **yes** |
| relation pages | **no** | **correct — legitimately asymmetric.** Vacuum makes space reusable inside the file; it does not return it. Only trailing all-empty pages are truncated, and only with an `ACCESS EXCLUSIVE` lock it surrenders on demand. A test asserting that pages return to their starting value would be wrong. |
| index pages | partial | **correct** — `deadIndexTuples` falls, so `idxPages` shrinks back toward `baseIdxPages`, but a real btree does not give leaf pages back either. Assert non-increase after re-enable, not return. |
| landfill counter | monotone | **correct** — it is a lifetime total. |
| throughput | yes | yes, once RC-1 is fixed |

---

## Detail — the other nine defective knobs

### 6. `checkpointTimeout`

**Real setting.** Maximum time between automatic checkpoints, default 5 min.
`CheckpointerMain()` schedules start-to-start from `last_checkpoint_time`, which
is stamped when a checkpoint *begins*. Longer intervals mean fewer full-page
images (each page pays at most one image per checkpoint cycle, on its first
modification after the redo point) and a longer crash-recovery replay.

**What the model does.** Schedule: correct — 40 / 9 / 3 / 3 / 3 checkpoints at
15 / 60 / 300 / 600 / 1800 s, correctly handing over to `max_wal_size` once the
timer is no longer the binding constraint. Crash-recovery volume
(`docs-storage.ts:1490`) responds correctly. **WAL and full-page-image volume do
not**: 955 / 957 / 976 / 976 / 976 KiB/s and a full-page-image share of
0.716 / 0.678 / 0.653 / 0.653 / 0.653 across a 120× range of the setting.

**Verdict: `WRONG` (magnitude).** Half of the trade-off the knob exists to teach
is missing, and `src/ui/content.ts:208` states it explicitly: "Longer means less
write amplification but slower crash recovery."

**Fix:** RC-3, and RC-1 (vacuum's per-page images dominate the total and are
interval-independent). Target after the fix: doubling `checkpoint_timeout` from
15 s to 30 s and again to 60 s should each cut the full-page-image share by
roughly a third to a half, flattening once the interval exceeds the warm band's
revisit period.

**Recovery:** schedule and segment retention return exactly. Cumulative
checkpoint counts do not and should not.

### 9. `bgwriterEnabled`

**Real setting.** There is no `bgwriter` on/off GUC; the shipped hint says so
correctly. `bgwriter_lru_maxpages = 0` disables the cleaning loop. The writer
wakes every `bgwriter_delay` (200 ms), scans a window ahead of the clock hand
sized by `bgwriter_lru_multiplier × recent allocations`, and writes dirty
buffers with `usage_count = 0` so that a backend needing a frame finds it clean.

**What the model does.** Direction on backend writes: **correct** — measured
20 100 → 15 300 dirty evictions with the writer on (−24 %), and
`buffers_backend`-equivalent falls at every pool size. Direction on throughput:
**inverted** — 474.9 → 421.7 tps (−11 %) in a clean A/B at `tps 1500`,
`sharedBuffers 512`, `autovacuum off`; and 181.6 → 140.9 tps (−22 %) in a second
configuration. Total device writes rise (73.6 → 124.0 pages/s), because the
writer cleans pages that are then re-dirtied.

**Verdict: `WRONG` (direction).** The model produces only the writer's cost.
The documented benefit — "backend writes climb and query latency picks up a long
tail almost immediately" when you turn it off, `src/ui/docs-storage.ts:1024` —
cannot be observed because RC-4 means backend writes are free.

**Fix:** RC-4. After it, enabling the writer should move latency and throughput
by a few percent in the *favourable* direction on a churning workload, while
`buffers_backend` falls by the 20–30 % already measured. The extra total writes
should stay — that is real, and is why an over-aggressive writer is not free.

**Recovery:** symmetric and already correct — toggling back off restores the
dirty/backend-write regime immediately.

### 10. `bgwriterLruMaxpages`

**Real setting.** `bgwriter_lru_maxpages`, default 100, range 0–1073741823.
The maximum buffers the writer may write in one round; at the default
`bgwriter_delay` that caps it at 500 pages/s. It binds only when the writer is
being outrun.

**What the model does.** `tickBgwriter()` (`src/sim/model.ts:1810`) loops
`while (scanned < lookahead && cleaned < K.bgwriterLruMaxpages)`. `lookahead` is
`clamp(round(ioReadPerSec × 0.5 + 32), 16, 420)` and the scan wraps modulo
`buf.sampleFrames`, which is 32–1024 frames. The binding constraint is therefore
always the number of *eligible* frames (dirty, `usage_count = 0`, unpinned)
inside a pool that is at most 1024 frames — never the cap.

| `sharedBuffers` | frames | maxpages 10 | 100 | 400 |
|---|---|---|---|---|
| 256 MiB | 32 | 15.4/s | 15.4/s | 15.4/s |
| 2 GiB | 256 | 46.8/s | 40.8/s | 40.8/s |
| 8 GiB | 1024 | 0.4/s | 0.4/s | 0.4/s |

A separate sweep at `tps 2000, writeRatio 0.8` found 10, 50, 100, 200, 400 and
1000 all bit-for-bit identical.

**Verdict: `WRONG` (inert above ~100).** `src/ui/docs-storage.ts:1024` and
`src/observability/paths.ts:1022` both recommend raising it to a few hundred;
the model cannot show any difference. Because it is also fully redundant with
`bgwriterEnabled` at the zero end, it currently carries almost no information.

**Fix options, in order of preference:**

1. Make the cap reachable by making the eligible set bigger under churn.
   `lookahead` should track *allocations*, not reads:
   `bgwriter_lru_multiplier (2.0) × allocations per bgwriter_delay`, smoothed —
   PostgreSQL's `BgBufferSync()` uses exactly that. On a 1024-frame pool being
   churned end to end that produces hundreds of eligible frames per round, and
   100 vs 400 separates.
2. Failing that, merge the two bgwriter knobs into one (`bgwriter_lru_maxpages`,
   0 = off) so the rail stops implying an independent effect that does not
   exist, and do **not** give the numeric one a lever.

**Recovery:** returning to 0 correctly stops cleaning; symmetric.

### 11. `synchronousCommit`

**Real setting.** `off` — commit returns before WAL is written; you can lose the
last `wal_writer_delay × 3` of committed transactions, but never corrupt.
`local` — wait for local flush only, regardless of `synchronous_standby_names`.
`on` — wait for local flush **and**, if `synchronous_standby_names` is set, for
the standby's *flush*. `remote_write` — standby has written but not fsynced.
`remote_apply` — standby has *applied*, so a read there sees the transaction.
With `synchronous_standby_names` empty, `on`, `remote_write` and `remote_apply`
all degrade to `local`.

**What the model does.** `src/sim/model.ts:3201`: `off` returns after 0.012 s;
`remote_apply` waits for `ackedApplyLsn`; everything else waits for local flush
only. Measured commit-wait occupancy: 71 / 1964 / 1964 / 2433 samples for
`off` / `local` / `on` / `remote_apply`; tps 191 / 127 / 127 / 62.

**Verdict: `WRONG` (internally inconsistent).** `on ≡ local` asserts that
`synchronous_standby_names` is empty. `remote_apply` making commits wait for the
standby asserts it is not. The shipped text (`src/ui/content.ts:258`,
`src/ui/docs-storage.ts:1384`) explains away the first assertion without
noticing that it contradicts the second.

**Fix.** Declare a synchronous standby whenever `replicaEnabled` is on, and give
`on` the guarantee it actually has:

```
off          → no wait
local        → wal.flushLsn >= commitLsn
on           → wal.flushLsn >= commitLsn && ackedFlushLsn >= commitLsn
remote_apply → wal.flushLsn >= commitLsn && ackedApplyLsn >= commitLsn
```

`ackedFlushLsn` needs the same acknowledgement ring as `ackedApplyLsn`, sent
when `rep.flushLsn` advances rather than `rep.replayLsn`. The observable result
is a three-step ladder — `local` < `on` < `remote_apply` — where `on` costs one
round trip and `remote_apply` costs one round trip plus apply time. That is the
lesson, and it is currently a two-step ladder with a false middle. When
`replicaEnabled` is off, `on` correctly collapses onto `local` and
`remote_apply` should warn (the "waiting for a synchronous standby that is not
there" toast at `src/sim/model.ts:3208` already exists).

**Recovery:** symmetric and correct — returning to `off` drops commit wait
immediately.

### 12. `walLevel`

**Real setting.** `minimal` — only what crash recovery needs; some bulk
operations skip WAL entirely; incompatible with `archive_mode = on` and with any
standby (the server refuses to start with both). `replica` (default) — adds what
archiving and hot standby need. `logical` — adds what logical decoding needs,
most importantly the old tuple's replica identity on `UPDATE`/`DELETE` and, in
`log_heap_update()`, disabling the prefix/suffix compression that a
non-logically-logged update gets.

**What the model does right.**
- WAL volume: `minimal` and `replica` identical, `logical` larger
  (`src/sim/model.ts:2863`, `updBody = logical ? tup : max(24, tup × 0.35)`).
  Measured 3 100 KiB/s at `replica` vs 6 500 KiB/s at `logical`. The mechanism is
  precisely right and cited correctly — `heap_update()` only computes prefix and
  suffix when `!need_tuple_data`, and `need_tuple_data` is
  `RelationIsLogicallyLogged(reln)`.
- Archiver off at `minimal` (`archiverOn()`, `src/sim/model.ts:1504`) —
  measured `archived = 0`. Correct.
- Standby disconnected at `minimal`, with the right toast. Correct.

**What is wrong.** Everything in RC-2. The headline numbers a visitor sees at
`wal_level = minimal` are 4.92 GiB of pg_wal against `max_wal_size = 256 MiB`,
4 800 MiB "held by the slot", 342 s of `replay_lag`, and 41.6 logical changes/s.

**Verdict: `WRONG`.** Fix per RC-2.

**Recovery:** `minimal → replica` restores the physical stream correctly
(measured `lagSec 0.00`, `changes 0`). `logical → replica → logical` does not
reset the slot position and must, once RC-2 normalises `logicalSlotLsn`.
Cumulative `wal.archived` legitimately does not reset.

### 13. `fullPageWrites`

**Real setting.** When on, the first modification of a page after each
checkpoint writes the whole 8 KiB page into WAL, so replay can start from a page
it trusts even if the OS wrote it torn. Turning it off is safe only on storage
that guarantees atomic 8 KiB writes.

**What the model does.** `markDirty()` (`src/sim/model.ts:1306`) and
`walInsertPage()` (`:1328`) both honour it, keyed by page and checkpoint
generation — which is the right rule (`page.LSN <= RedoRecPtr`, not residency).
Measured WAL ratios (on ÷ off), same workload:

| | WAL with images | without | ratio |
|---|---|---|---|
| `autovacuum = false` | 520 KiB/s | 271 KiB/s | **1.9×** |
| `autovacuum = true` | 2 900 KiB/s | 132 KiB/s | **22.3×** |

And throughput: 255.8 tps with images on vs 477.5 with them off — a **1.9×
reward for disabling torn-page protection**.

**Verdict: `WRONG` (magnitude, in the shipped configuration).** The mechanism is
correct; RC-1 makes it read as a near-doubling of throughput for a setting whose
real answer is "leave it on". Real full-page-image share on an OLTP server is
typically 30–70 % of WAL; 95.5 % is not.

**Fix:** RC-1. No change to the full-page-image logic itself. After RC-1 the
ratio should sit near the measured 1.9× and the throughput difference should
fall to single-digit percent except on a genuinely WAL-bound workload.

**Recovery:** symmetric and correct — `wal.fpwBurst` is zeroed on the way down
(`src/sim/model.ts:3600`) and `fpiGeneration` is bumped on both transitions.

### 18. `replicaEnabled`

**Real setting.** Whether a physical standby is streaming. If it streams through
a replication slot, the slot pins WAL on the primary even when the standby is
gone — the most reliable way to fill a production disk. Without a slot, the
primary recycles WAL and the standby needs a new base backup.

**What the model does.** Disconnects cleanly and the `pg_stat_replication`
projection correctly empties. But RC-2 leaves `lagSec` climbing to 300 s,
`lagBytes` to 1.6 GiB and slot retention to 1.6 GiB, and four readouts print
them unguarded.

**Verdict: `WRONG`.** Fix per RC-2.

**Second, smaller gap.** `tickSegments()` (`src/sim/model.ts:1605`) sets
`slotHold = 0` when `rep.enabled` is false, so pg_wal *shrinks* when the standby
goes away. The comment three lines above says the opposite: "a slot nobody is
reading pins WAL on the primary. That is how a replica takes down a primary's
disk." The model can currently only show that with `replicaSlowApply`, never
with a disconnected consumer — which is the case operators actually hit. The
honest fix is to make the slot a distinct thing from the standby: keep
`slotHold` alive while the standby is disconnected (that is what a slot does),
and let `replicaEnabled = false` mean "the standby is gone, the slot remains" —
which is exactly the situation roadmap item 10's "drop the slot or add capacity"
scenario needs.

**Recovery:** re-enabling resynchronises correctly (measured `lagSec 0.22` after
120 s, with the "required WAL had been recycled" fast-forward path). Symmetric
and right.

### 19. `replicaNetworkLag`

Fully covered by RC-6. Direction and down-sweep recovery are correct; only the
scale and the units are wrong. **Verdict: `WRONG` (magnitude / undisclosed
unit distortion).**

### 21. `standbyLongQuery`

**Real setting.** `hot_standby_feedback = on` makes a standby report the xmin of
its oldest running snapshot back to the primary through the walreceiver's status
messages. The primary holds its `xmin` horizon back accordingly, so a long read
on the standby blocks cleanup on the primary. It requires a standby, a
replication connection, and therefore `wal_level >= replica`.

**What the model does.** `setKnob()` at `src/sim/model.ts:3547` freezes the
horizon unconditionally:

```
Measured — replicaEnabled = false, walLevel = 'minimal', replication.connected = false:
  before standbyLongQuery=true : oldestSnapshotAge = 0.72 s
  after  standbyLongQuery=true : oldestSnapshotAge = 200.00 s   (and climbing)
```

A standby that provably cannot exist pins the primary's cleanup horizon. This is
the same class of defect as the logical slot at `wal_level = minimal`: not a
scaling artefact, a claim that cannot be true.

**Verdict: `WRONG`.**

**Fix.** Gate the pin on a live standby, and re-evaluate it every tick rather
than only at `setKnob` time, because the standby can go away afterwards:

- In `setKnob`, treat the effective pin as
  `K.longRunningXact || (K.standbyLongQuery && rep.enabled && rep.connected && K.walLevel !== 'minimal')`.
- Add the same check to `tickReplication()`, so that turning off
  `replicaEnabled` or moving to `wal_level = minimal` while
  `standbyLongQuery` is on releases the horizon with the existing
  "xmin pin released" toast.
- When the knob is set with no standby present, say so rather than silently
  doing nothing: "hot_standby_feedback needs a connected standby — there is
  none." A knob that refuses with a reason teaches more than one that
  silently succeeds.

`standbyLongQuery` is also the thinnest-documented knob in the project: it has a
hint in `src/ui/content.ts:276` and nothing else — no `pg_settings` row, no
entry in `src/observability/paths.ts`, no mention in either docs file, and no
test. The `hot_standby_feedback` chapter at `src/ui/docs-storage.ts:1671` does
not list it in its own `knobs:` array.

**Recovery:** correct once gated — the horizon releases immediately and
`deadRemovable` is restored for every relation (`src/sim/model.ts:3578`), then
vacuum collects over the following minutes. The bloat that accumulated while
pinned is **legitimately not recovered instantly** and must not be asserted to
be.

---

## Recovery: which knobs are legitimately asymmetric

A test asserting symmetry would be **wrong** for these:

| Knob | Asymmetric quantity | Why |
|---|---|---|
| `autovacuum` | relation pages, index pages | Vacuum makes space reusable inside the file. Only a trailing run of wholly empty pages is truncated, under an `ACCESS EXCLUSIVE` lock surrendered on demand. `pg_relation_size` does not come back. |
| `autovacuumScaleFactor` | accumulated dead tuples at the moment of change | Raising the factor does not create bloat retroactively; lowering it does not erase what accrued. Only the *trigger point* is symmetric. |
| `longRunningXact`, `standbyLongQuery` | bloat accrued while pinned | Releasing the horizon makes rows removable; it does not remove them. Vacuum has to run. |
| `updateRatio`, `writeRatio` | relation pages | Same reason as `autovacuum`. Dead tuple *counts* do recover (measured to zero in 1200 s). |
| `sharedBuffers` | pool contents | Shrinking the pool writes out and drops frames; growing it back gives cold frames. The hit ratio recovers with the working set, not instantly. |
| `walLevel` | `wal.archived`, LSN counters | Lifetime totals. |
| every knob | `stats.commits`, `stats.tup*`, `checkpoint.count`, `autovac.totalRuns`, `autovac.landfill` | Cumulative counters, exactly as in `pg_stat_*`. |

Everything else must return: rates, gauges, occupancy, queue depths, horizons,
active states, and lag.

---

## Lever readiness ranking

### Safe to give a physical lever today — 13

Ordered by how well the consequence chain reads in-world.

1. **`lockContention`** — the most dramatic honest lever in the model. Pull it
   and 15 backends queue, 12 wait edges light up, throughput goes to zero;
   release it and everything resumes. Nothing to fix.
2. **`longRunningXact`** — the xmin horizon freezes visibly, vacuum workers
   report "0 removable (old snapshot)", bloat climbs, and releasing it produces
   a visible catch-up. The asymmetry is real and is the lesson.
3. **`replicaSlowApply`** — lag 0.37 s → 168 s → 0.43 s, with the flush/replay
   gap opening and closing in the world. Clean.
4. **`sharedBuffers`** — the buffer plaza physically resizes and the hit ratio
   moves 34 % → 100 %. Best-tested knob in the project
   (`src/sim/knob-response.test.ts`).
5. **`maxWalSize`** — WAL segment count and checkpoint cause both respond, and
   the "checkpoint triggered by max_wal_size, not by the timer" toast already
   fires.
6. **`autovacuumScaleFactor`** — a dial rather than a switch, but the response
   is monotone and the formula is PostgreSQL's.
7. **`checkpointCompletionTarget`** — the write phase visibly stretches and the
   I/O spike visibly flattens.
8. **`tps`**, 9. **`writeRatio`**, 10. **`updateRatio`**, 11. **`seqScanRatio`**
   — all correct, but they are workload dials rather than server settings, so a
   physical lever is a weaker metaphor. If they get handles, put them at the
   client district, not inside the machine.
12. **`timeScale`**, 13. **`paused`** — presentation controls; correct, but they
    belong to the camera rather than the city.

### Must be fixed first — 10

Ordered by how badly a newcomer would be misled.

1. **`walLevel`** — states four physically impossible facts simultaneously
   (RC-2). A visitor who reads "4.9 GiB of pg_wal held by a logical slot" at
   `wal_level = minimal` learns something that is not merely mis-scaled but
   backwards about how slots and WAL retention work.
2. **`autovacuum`** — the roadmap's named priority. Currently teaches that
   turning autovacuum off costs nothing and buys throughput. Four fixes
   required; RC-1 is the largest.
3. **`standbyLongQuery`** — a standby that cannot exist pins the primary's
   cleanup horizon. Cheap to fix, and it is a one-line class of error that a
   test can lock down permanently.
4. **`replicaEnabled`** — a departed standby keeps reporting growing lag and
   growing slot retention. Same root cause as 1.
5. **`bgwriterEnabled`** — inverted throughput response. A lever that makes the
   database *faster* when you switch off a helper is the worst possible thing to
   put in a room a visitor can walk into.
6. **`fullPageWrites`** — advertises a 1.9× throughput reward for turning off
   corruption protection. Fixed by RC-1.
7. **`checkpointTimeout`** — half its trade-off is missing, and the shipped hint
   promises the missing half.
8. **`synchronousCommit`** — the `on`/`local` collapse contradicts
   `remote_apply`. Lower rank only because the *direction* of every step is
   right; the ladder is just missing a rung.
9. **`replicaNetworkLag`** — a fixed, undisclosed 6× on a number labelled in
   seconds. Direction and recovery are correct; only the units lie.
10. **`bgwriterLruMaxpages`** — inert above ~100. Least misleading of the ten,
    because a reader concludes "this does not matter much", which is nearly
    right; but the shipped documentation tells them to raise it, so it still
    fails the "documentation describes behaviour the app does not have" test.

### Suggested fix order

RC-2 first: it is contained, it clears two knobs outright, and the correctly
guarded observability projections already disagree with the panels, so the
regression tests write themselves. Then RC-1, which is the largest single lever
— it clears `autovacuum`, `fullPageWrites`, and the WAL-recovery tail behind
`tps` and `writeRatio`, and it is a prerequisite for `checkpointTimeout`. Then
RC-4 (small, clears `bgwriterEnabled`), RC-6 and RC-5 (both trivial), the
`standbyLongQuery` gate (trivial), RC-3 and the `synchronousCommit` ladder
(both structural but contained), and `bgwriterLruMaxpages` last.

---

## Changes from the previous sweep

The roadmap's "eleven of twenty-two" came from `TASK-knobsweep.md`. This audit
disagrees in seven places:

**Re-graded to `CORRECT`:**

- **`tps`** and **`writeRatio`** — the earlier sweep marked both as failing on
  WAL magnitude and recovery. Isolated from autovacuum, both scale near-linearly
  (measured 52 → 385 → 2 600 → 6 800 KiB/s over 10 → 5000 tps; 0 → 176 → 358 →
  526 → 685 KiB/s over `writeRatio` 0 → 1). Both defects were RC-1 wearing the
  knob's name.
- **`updateRatio`** — marked "recovery failed". It does recover, to exactly zero
  dead tuples, but it takes 1200 simulated seconds, which is longer than the
  earlier sweep's window. Slow, not broken; the slowness is RC-1.
- **`fullPageWrites`** kept its `WRONG` grade but for a different reason: the
  earlier sweep faulted the throughput reward, which is a symptom; the cause is
  that vacuum contributes 95 % of the full-page-image volume.

**Added, previously passed:**

- **`standbyLongQuery`** — passed as "same horizon pin as the local long
  transaction". It is, including when there is no standby.
- **`replicaEnabled`** — passed on the grounds that the HUD shows `—`. Four
  other readouts do not.
- **`synchronousCommit`** — explicitly listed as a non-failure. The `on ≡ local`
  simplification is only defensible if `remote_apply` also collapses, and it
  does not.

**Not reproduced:** the earlier sweep's report that `wal_buffers` "repeatedly
remains 100 % full for at least 20 simulated minutes". Measured occupancy peaked
at 39 % and was usually near 0 %, because `requestFlush()`
(`src/sim/model.ts:1429`) advances `writeLsn` to `insertLsn` on every call. What
does persist after a load drop is the **WAL rate**, which stayed at 3–5 MiB/s
for roughly 120 s and did not reach zero until ~300 s — entirely vacuum WAL
(with `autovacuum = false` the same drop reaches 0 KiB/s within 15 s). The
user-visible symptom is real; the named mechanism was not.

---

## Reproducing this audit

Everything above was measured with a temporary probe under `test/`, driving
`createSim()` with a stub bus and stepping `update(1/30)` — no browser, seeded
RNG, deterministic. Warm-up was 300–400 simulated seconds before every reading,
with the observation window stated per measurement. The probe was deleted; the
worthwhile parts to keep permanently, as CI regression tests, are:

1. `wal_level = minimal` ⇒ `wal.segmentCount × 16 MiB <= max_wal_size × 2` and
   logical slot retention is zero, after 600 simulated seconds.
2. `replicaEnabled = false` ⇒ `lagSec === 0` and `lagBytes === 0`.
3. `standbyLongQuery = true` with `replicaEnabled = false` ⇒
   `oldestSnapshotAge` stays bounded.
4. `autovacuum = true` ⇒ WAL rate is within 1.5× of the `autovacuum = false`
   rate for the same workload.
5. `bgwriterEnabled = true` ⇒ `dirtyEvictions` falls **and** achieved tps does
   not.
6. `bgwriter_lru_maxpages` 100 vs 400 ⇒ measurably different `cleanedTotal`
   under a churning workload.
7. `checkpoint_timeout` 15 s vs 120 s ⇒ full-page-image share falls by at
   least a third.
8. `wal.bufferCapacity === clamp(shared_buffers / 32, 64 KiB, 16 MiB)`.
9. `synchronous_commit` commit-wait ladder is strictly increasing across
   `off < local < on < remote_apply` with a standby connected.
10. Every knob: set, warm, unset, warm — assert every rate and gauge returns to
    within tolerance, and assert relation pages do **not**.
