# Changelog

All notable changes to PGSimCity are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

While the major version is `0`, the model, the layout and the visual language
are all still moving. Expect breaking changes between minor versions.

---

## [Unreleased]

### Fixed

- Advance the reviewed PostgreSQL reference from 18.4 to 18.6 after checking
  the release notes and rerunning all 223 oracle observations: 219 matches,
  four existing teaching-scale divergences, no unexpected results. The version
  gate still rejects unreviewed newer releases. Logical-decoding guidance now
  includes the trusted output-plugin allowlist; PGlite remains separately
  labeled as PostgreSQL 18.3. See [the reference review](POSTGRESQL-REFERENCE-REVIEW.md)
  for evidence and coverage limits.
- The CDP profile guard that keeps two concurrent screenshot runs from deleting
  each other's live Chrome profile only worked on Linux. `profileIsInUse()` read
  `/proc`, which macOS does not have, so the read threw and the guard reported
  that no profile was ever in use — on the platform this project is developed on.
  `cleanup()` could therefore remove a profile directory out from under a running
  Chrome, and `reapStaleProfiles()` lost its active-profile check entirely. The
  process list now comes from `/proc` where it exists and `ps -A -ww -o args=`
  everywhere else. CI runs on Ubuntu, which is why 998 tests never saw it.
- The two tests covering that guard raced the process table: they read it the
  instant Node reported `spawn`, which on a loaded Linux host is sometimes before
  the child is listed. Reproduced at 2 failures in 5 runs in a container, and
  fixed by waiting for the transition instead of assuming it — 12 of 12 after.
- `record-demo.sh` sized its output with `stat -c`, which is GNU-only. The script
  already refuses to run outside Linux because it requires PulseAudio, so this
  was latent rather than live; it now uses `wc -c`.

## [0.40.0] - 2026-08-06

Nik asked how the project could find more bugs on its own, after a session in
which he found six by walking around a city that 998 tests, an orbit sweep, a
first-person sweep, a mutation gate and a PostgreSQL oracle had all passed.

Five hunts were aimed at the classes those checks structurally cannot see. They
found nineteen defects. The lesson is in which hunts paid: the two aimed at
guesses came back clean, and the ones aimed at shapes he had already surfaced —
state that accumulates, surfaces that drift from the model, boundaries crossed in
motion — found everything.

### Fixed — surfaces that disagreed with the simulation

Twelve findings, and the important ones were **model** bugs, not prose:

- A promoted `standby_a` reported `"primary — accepting writes"` with
  `online=true`, then refused to act as a backup source: `"standby_a … is
  unavailable"` and `startBaseBackup()` returning `false`. Backup availability now
  follows the physical node's role and data-directory frontier.
- Promotion left the old standby's surfaces running. `SimState` said
  `role=primary` while readouts still said `"offline"` and `"disconnected"`, the
  walsender could report `"primary sees primary"`, and B referenced the old
  primary's LSN.
- Follower reinitialisation kept the state it claimed to discard: the UI said
  `"Reinitialising follower"` from a fresh base backup while 3,227 old buffer
  misses and warm geometry survived it.
- Object storage counted lifetime archive successes as retained objects — `"17
  WAL objects"` when seven segments remained in the recovery chain.
- `standby_a`'s cache geometry ignored `SimState` entirely, drawing five relation
  colours from private randomness while every modelled frame was invalid.
- The two standby storage inspectors disagreed with each other: 7.0 GiB against
  8.3 GiB for the same cluster.
- Help and Diagnose denied replay work the model was doing, and heap prose named
  the wrong dimension — `"height is its page count"` while height stayed fixed and
  footprint length grew from 1,024 to 100,000 pages.

### Fixed — bodies crossing boundaries

Six findings from crossing every district edge, ramp, kerb, plate perimeter, pool
wall and aperture in motion rather than standing near them. Among them: pressing
Fly while walking silently performed a *focus* transition instead.

### Fixed — two controllers owning one camera

Long random input sequences reached `rig.mode=focus` with `walk.enabled=true`:
scripted camera motion and the pedestrian both writing the transform, with a tour
card stacked over Exit Walk, Crouch and Jump. Focus now exits walking first.

### Added — a fuzzer and a soak, and what they did not find

Persisted-state fuzzing over 96 dense knob sets, every UI extreme, 180
synchronous-commit prerequisite combinations, 24 HA topologies, and corrupt,
partial, wrong-typed, stale and legacy records found **no** new deadlock beyond
the one v0.39.5 fixed.

A two-hour-per-workload soak, plus 1,788 model seconds in-browser, found no
leak: scene objects, geometries, textures and shader programs constant, post-GC
heap growth 1.17 MiB, no unbounded array.

Both state their limits rather than claiming coverage they do not have — 96
seeded sets are not the cross-product, and headless SwiftShader is not a phone.

### Added — a moon, with tonight's phase

Its phase is a pure function of the date: mean lunation 29.530588853 days from
epoch 2000-01-06T18:14:00Z, both from the USNO Astronomical Almanac, validated
against USNO primary phase data at eight known new and full moons with a worst
error of 0.331 day.

It is registered as what it is — a mean estimate, ±0.5 day, qualified for
2000–2030, not a location-aware ephemeris. The same phase angle drives both the
illumination and the sun–moon separation, so the lit limb cannot drift out of
agreement with the sun the sky already computes. Its apparent diameter follows
the established 1.5° convention shared with the sun.

Restrained bloom was allowed because the illuminated shape carries a checkable
fact, which is the test `CLAUDE.md` sets for glow. Low fidelity drops the bloom
and keeps the phase: the decoration is optional, the information is not.

## [0.39.6] - 2026-08-05

### Fixed — the buffer pool stood two storeys above the plaza

Nik: *"pool surface is still much higher than ground level."* It was. The water
sat at `y = 8.8` over a plaza at `y = 3.0`, walled by coping to `9.2` — a tank
proud of the ground rather than a pool in it.

Worse, the level was a constant. `SURFACE_Y` was computed once from the maximum
tile rise and assigned once, so the water stood at full height no matter how much
of `shared_buffers` was in use. The most natural way to show how full the pool is
was showing nothing at all.

The basin is now recessed — bottom `-2.1`, full waterline `3.12`, coping `3.58` —
and **the level tracks occupancy**, `usedCount / sampleFrames`. The tiles keep
their own fact, per-frame `usage_count` with transient pin and touch lifts, so the
two carry different information rather than the same one twice. Both are
disclosed.

Because the surface now moves, the swim predicate follows the live level instead
of a constant. Walking in, falling in, and standing on the bottom were re-verified
at 40% and 100% occupancy.

### Fixed — you could walk into the pool and stay dry

The swim test asked whether the walker's feet were above the pool floor rather
than whether there was water overhead, so walking in left you strolling across
the bottom of a full pool. Jumping lifted your feet clear and swimming began
abruptly. Standing on the bottom of a full pool is submerged, and now reads that
way.

### Documented — lighting the city further is not worth its frame budget

Nik asked why a comparable browser scene looks better, and approved a narrow
conversion: light the structural surfaces whose colour is not carrying meaning.

The scope gate was written before any material changed, and it admitted **one
surface**, `ground.kerbTop`. Lighting it added real form and weakened no district
identity — and moved medium-tier frame time from **17.73 / 39.85 ms to 25.75 /
70.50 ms** median / p95, crossing the 22.22 ms budget in both condition orders.

It was reverted. No production material or fidelity threshold changed. The
classification table, the reproduction tool, the screenshots and the raw timings
are kept in `evidence/lit-structure/` so the question does not have to be asked
again from scratch.

The finding underneath is the useful one: almost every surface in this city is
semantic. A district identity, a live state, or any colour the registry,
inspector or legend names is information, and information stays unlit. What
remains is concrete and kerbstone. The distance to an asset-driven scene is
authored geometry and materials, which this project does not have and is not
getting — not a lighting technique it forgot to switch on.

## [0.39.5] - 2026-08-05

### Fixed — a saved setting could load the city into a permanent stall

Nik found this one, and he found it the way none of the instrumentation did: *"What
helps is to press reset — after it TPS is not dying."*

Knob preferences persist to `localStorage`. A saved set with the standbys
disabled while `synchronous_standby_names` still named one is individually legal
in every part and collectively a deadlock: on load the standbys disconnect,
`synchronous_commit` waits for an acknowledgement that cannot arrive, and every
backend lands in `commit_wait`. The city said so plainly — *"commits are waiting
for a synchronous standby that is not there"* — and then offered no way out.

Restore now reconciles the contradiction, keeps the disabled standby the reader
chose, clears the impossible `synchronous_standby_names`, persists that, and says
that local durability was selected. It does not silently rewrite a preference.
Creating the same stall deliberately during a session still works, because it is a
real PostgreSQL trap worth teaching. The registered remedy — enable the standby,
name another, clear the setting, or use `synchronous_commit = local` — now reaches
the toast, Diagnose and the inspector, and tapping it opens the exact control.

Other persisted states that can stop the city were audited and left alone: split
DCS, an isolated node with no promotable target, sustained writes under lock
contention, and a disabled standby's slot filling `pg_wal`. Those are lessons.

**Why three reproductions missed it:** every probe ran in a clean browser profile
with empty storage. They were all testing a first-time visitor.

### Fixed — the throughput gauge was lying

Measured over 900 model seconds: the readout swung between 0.56 and 25.83 while
actual commits, counted in independent ten-second windows, held steady between
8.0 and 12.0. Checkpoints made no difference (9.79 against 9.82), nor did vacuum
(9.86 against 9.64). The estimator, not the model, produced the alarm — and the
HUD paints red below 40% of offered load, so a healthy city regularly announced
itself as dead. It is now an explicit trailing window. The threshold is unchanged.

### Fixed — the city loaded cold

`reset()` warms the model for 420 quiet steps so "the city is never empty on
load". Nothing called it on load. The buffer pool started empty, WAL was not
flowing, and the checkpoint countdown sat at zero until the reader pressed a
button they had no reason to press.

### Fixed — the buffer pool had no water until you jumped

Walking into the pool left the walker standing on the floor, dry, because the
swim test asked whether the feet were above the bottom rather than whether there
was water overhead. Jumping lifted them clear and swimming began abruptly.
Standing on the bottom of a full pool is submerged; it now reads that way,
entering by walking and by falling reach the same state, and no input is needed
to change medium.

### Changed — pooling is something you can see

Switching between direct and `pool_mode = transaction` changed one glow value and
nothing else. The central fact about a connection pooler — many client
connections collapsing onto few server connections — existed only as a text
readout while the geometry said nothing, and geometry teaches louder than text.

Direct now shows sixteen 1:1 bypass links. Pooled modes show a hundred clients
collapsing through a ratio funnel onto eight backend paths, and each mode states
when it releases the server connection: on disconnect, on commit, on statement.
That difference is temporal, so it is animated rather than coloured.

PgBouncer also moved from `z=-276` to `z=-264`. Nik asked why it stood so close to
the clients, and the honest answer is that there is no universal placement —
PgBouncer's own FAQ and Azure's guidance both document application-host,
database-side and centralized deployments. The city now depicts a centralized
database-facing tier deliberately and discloses the alternatives.

### Fixed — the city died after a minute, and had since v0.31.0

Nik left the city running on a phone and reported it dead: nothing moving, the
buffer pool still, TPS painted red at zero, P99 at 13,000 model ms.

Throughput decayed over the first minute and flatlined. The scheduled base
backup forced a WAL segment switch that advanced the LSN by up to 16 MiB, and
that padding was excluded from the replication rate — so the standby caught up at
roughly 480 KiB/s, fell 8.18 MiB behind, and under `synchronous_commit` every
backend ended waiting on its acknowledgement. At model time 100, all sixteen
backends sat in `commit_wait`. The city was not broken; it was waiting.

It has behaved this way since `3c547a9` first shipped in **0.31.0**, nine minor
releases ago. It needed someone to leave the city running and look.

**The first fix was wrong in an instructive way.** It gave the segment-switch
padding a privileged catch-up rate — and a reviewer staging real clusters found
that the triggering event does not exist. The scheduled backup is sourced from
the standby, and a standby cannot switch WAL: `pg_basebackup -X stream` from a
standby moved the primary by **zero bytes** on 13.23, 17.9 and 18.3, and
`pg_switch_wal()` there fails outright with *recovery is in progress*. The model
was inventing a primary switch, and the fix tuned around the invention.

The padding is not special either. With a standby stopped and eight switches
forced, 134,217,728 LSN bytes produced 134,576,677 wire bytes — a ratio of
1.0027. Zero padding is neither skipped nor compressed; it streams like every
other byte. So the transport capacity is now one uniform per-link rate, owned by
the claims registry and disclosed as a teaching rate — where previously the
prose told readers the modelled link had *no* bandwidth while a hard-coded one
decided whether commits stalled.

The honest failure is still reachable: `synchronous_commit = remote_apply` with a
slow standby still drives all sixteen backends into `commit_wait`. Only the
accident was removed, not the lesson.

### Fixed — the storage district was unreadable up close

Measured rather than eyeballed: `ProcArray` at 4.47:1 against a 4.5 floor, and
failures across relation paths, block rulers, `_fsm`/`_vm`, index names,
`pg_toast`, directory names and spill-file captions.

Labels now sit on a neutral matte overlay, ink at 10.25:1 or better and at least
17.5 px projected, verified across 2,140 theme, tier and camera combinations.

**And that fix was also wrong first.** Moving the mechanism's colour into a
two-pixel rule put the meaning into a carrier that bloom never reaches and the
no-bloom luminance floor never repaints — eight semantic classes fell below it,
`SHARED MEMORY SEGMENT` at 0.054 and 1.82:1. The audit stayed green because it
measured the neutral ink and never the colour. Colour is semantic in this city,
so a carrier invisible at low quality carries nothing. The rule is now a half-em
square routed through `theme.neon()`, and the audit covers 720 semantic
combinations alongside the ink.

### Added — PgBouncer statement pooling

Hannu Krosing pointed out publicly that `statement` mode was missing: *"like
transaction, but also enforces auto commit mode."* He was right — the control
offered two of PgBouncer's three pooling modes, and nothing enumerated the set
from an authoritative source, so the gap was invisible.

Verified against a real PgBouncer 1.25.2 in front of PostgreSQL 18.3: statement
mode releases the server connection after each query and rejects a transaction
block with `FATAL 08P01: transaction blocks not allowed in statement pooling
mode`. The city discloses that its ordinary simulated visits are one statement
per transaction, so their queue timing matches transaction mode — the difference
is stated rather than pretended.

The mode set is now owned by the claims registry and the type derives from it, so
a missing mode is a compile error rather than a reader's discovery.

## [0.39.4] - 2026-08-05

### Fixed — the spines proved text, not wiring

The claims spine gives every fact about PostgreSQL one owner, so no two surfaces
can disagree. That is the mechanism this project's credibility rests on.

It did not work. Replacing `CLAIM_VALUES.bulkReadRing.modelFrames` with the bare
literal `32` passed all twenty-six claims-spine tests. A full sweep — substitute
each registered claim's literal value at each consuming surface — found that
**twenty of twenty-two testable claims survived**. Only `postgresqlVersion` was
caught; `reviewStatus` was not wired at all.

The spine verified that today's rendered text equals today's registry output. It
never verified that a surface *reads from* the registry. So a surface could be
silently disconnected and a later correction would never reach it — precisely
the failure the spine exists to prevent, latent since it was written.

Wiring is now proven from the syntax tree rather than by comparing strings, and
five model constants are branded so a raw literal will not compile. The honest
limit: an unmarked `32` or `16 MiB` in prose carries no identity proving which
claim it represents, so newly added anonymous copies cannot be discovered
automatically.

### Added — remedial actions have one owner

Staging the city's operational advice on real PostgreSQL 13, 17 and 18 — not
reading it, but following it literally as a tired operator would — produced five
findings, recorded in `ADVICE-AUDIT.md`.

Read together they were not five content errors but one structural one: **the
correct qualification already existed in the city, just not where the operator
acts.** The inspector said enforcing `max_slot_wal_keep_size` permits required
WAL to be removed; the action that recommended it did not. The inspector said
replication gaps localise investigation without proving a cause; the verdict
prescribed capacity work anyway.

Actions now have the single-source discipline facts already had. A Diagnose
remedy that is not a registered action reference does not compile.

Two of the five were not prose problems at all, and fixing the sentence would
have buried them:

- The connection-saturation gate marked trouble at `max_connections - 1`, so a
  cluster whose ordinary slots were all held looked healthy whenever superuser
  connections were reserved. Capacity is now counted after
  `superuser_reserved_connections` and `reserved_connections`.
- Raising `autovacuum_max_workers` needs a **restart** on 13 and 17 but only a
  **reload** on 18. Silently version-specific advice is a trap; the difference is
  registry data, checked by the oracle, now at 223 checks.

### Added — mutation testing runs nightly

Three holes this cycle were found the same way: break production code
deliberately and see whether anything objects. A green suite of nine hundred
tests found none of them. That was a thing someone had to remember to ask for.

It now runs nightly, like the PostgreSQL oracle, with operators drawn from what
actually went wrong rather than a generic catalogue — the one that found all
three replaces a registry read with its current literal value.

Its first run found nine survivors of one shape: **an honesty disclosure could be
deleted and nothing objected.** `bulkReadRing.disclosure`,
`modelLatency.disclosure` and `taxonomyDisclosure`,
`connectionPooler.coverageDisclosure`, `workMem.coverageDisclosure`,
`restoreDrill.smokeDisclosure` and `cadenceDisclosure`,
`timelineRecovery.coverageDisclosure`, and one registered action risk — every one
of them load-bearing content by rule 10, none of them enforced.

Disclosures are now required to exist *and to reach the reader* on the surfaces
making the qualified claim. Presence is not enough: a disclosure reduced to
whitespace, or rendered where no reader sees it, fails with the registry path and
the unqualified surfaces named. Because `panel.ts` builds each document section
independently, a qualification in a neighbouring collapsed section no longer
qualifies anything. Two unrelated threshold-boundary survivors surfaced during
the fix and were killed with exact-boundary assertions.

The harness mutates 228 of 95,553 production lines — **0.239%**, across 30 of
144 eligible files. A mutation tool that silently sampled would be worse than
none, because a green run reads as proof; `MUTATION-AUDIT.md` states exactly
what it reaches and what it cannot.

### Fixed — seventy-six things you could only see by walking

The city's sweep looked at itself from above, so every defect visible only at
eye level was structurally invisible to it. A first-person sweep now walks 1,036
stations derived from the real walkable surfaces, sampling 3,752 poses.

It found fifty near-plane intersections, hands passing through the autovacuum
lever, a sign 860 px tall at walking distance, floor labels built to read at
400 m and unreadable up close, coplanar surfaces, and an animated `commit_wait`
torus escaping its collision envelope.

Depth precision is now derived from the camera's situation rather than a single
global value, after a reviewer measured that a uniform tight near plane costs
5.0005× depth resolution at every distance and produced striping on the HA
failure-domain platform at ordinary orbit range. Text atlases are split by
record orientation; previously one horizontal record could move seventy-five
walking labels onto an orbit-only layer.

## [0.39.3] - 2026-08-05

### Fixed — two fingers did not rotate the city

Nik reported it on an iPhone twice, and the first fix was written against the
wrong cause. A parallel two-finger swipe does produce near-zero twist, so making
horizontal drag yaw looked like the answer. It was not.

Pointer Events fire **per contact**. When one finger had moved and the other had
not yet, the handler read the changed separation as a pinch, `applyZoom` cleared
the rotation anchor, and the next yaw was discarded by `rotateOrbit`'s early
return. **4% of the intended rotation survived** — 0.076 of 1.885 rad — with a
spurious dolly from 48 to 45.2. The committed test passed throughout because it
fed both contacts in before a single frame update, which never happens on a
phone. That defect predated the swipe work and degraded twist too.

Gesture state is now sampled from both contacts **together**, and a gesture delta
is only committed once every active contact has reported since the last commit,
so a frame cannot pair one finger's new position with the other's stale one.
Yaw, tilt and scale derive from totals since gesture start rather than per-event
increments, which makes the result independent of delivery order by construction.

Two review panels then blocked the first rework and were right to. Also fixed:

- **Visible zoom pumping.** Half-delivered frames expanded the view 17.65% or
  contracted it 13.04% on every step. Now flat at the starting distance, maximum
  error 1.6e-13.
- **The gesture classifier could not change its mind.** A "lifetime lock" meant a
  pinch that became a twist yawed 0° instead of 60°, and 2px of finger settling
  could hijack an entire gesture. It also had a cliff: 59px of translation did
  nothing where 61px gave a full 36.6°. Real hysteresis, continuous weighting,
  and the largest adjacent-pixel jump is now 1.34°.
- **Quick flicks were discarded.** Motion delivered between the last frame and
  `pointerup`/`pointercancel` was lost entirely; correctness depended on a tick
  winning a race against the finger lifting.

Off-centre twist, which applied 163.9° for an intended 60°, is now 1.000×.

### Added — the city is swept for things that look wrong

Every recent visual defect was found the same way: Nik walked the city and saw
it. Each got an invariant afterwards. This is the sweep that finds them first.

Nine deterministic stations, enumerated from the live scene — 760 objects, 14,309
rendered instances, 239 text planes, 101 borders and rims, 22,309 opaque
horizontal triangles — checked for mirrored text, sky visible through ground,
surfaces outside their district bounds or without ground beneath, rims sitting
below the surface they border, and coplanar z-fighting.

The strict first run reported **138 overlapping surface pairs**, which resolved
to seven real geometry defects: deck-rim and coping corners in shared memory,
pylon marker crosses, excavation parapets, WAL walkway rails, fifteen stacked
inactive TOAST instances, and bay road paint. All fixed; no threshold relaxed.

The sweep proves its own teeth by mirroring a live label and catching it:
`"POSTGRESQL ADDRESS SPACE ENDS HERE" has mirrored world determinant -1556.820`.

### Fixed — sound claimed a state it could not deliver

Every audio call site in the codebase is in `walk.ts`. Outside first-person walk
mode the toggle reported sound was on and produced silence, permanently, with no
explanation. Measured in a real browser: peak amplitude is exactly zero in orbit
and non-zero while walking. The walking figure varies by host, so the test — and
this note — assert the durable property rather than a number.

The control now says **walk sound** on every surface that describes it, from one
module, so those surfaces cannot drift apart.
An invariant derives the audio call sites from the production source, so adding
one outside `walk.ts` fails the build rather than quietly making the label lie.
No ambient soundscape was invented; that is a product decision, not a bug fix.

### Fixed — the version disclosure was a billboard

The PostgreSQL version statement filled three lines across the top of a 390px
phone, in front of the city. It is load-bearing content, not chrome, so it could
not simply be cut — but it did not need to be permanent furniture either. It is
now a compact `PostgreSQL 18.4 · city claims` marker with the full statement one
tap away, and the qualification travels with every claim-bearing surface
enumerated from the claims registry.

### Fixed — the correction link read as a statement, not an action

Two GitHub issues arrived containing nothing but the unedited template. The link
said *This does not match PostgreSQL*, which reads as an assertion; nothing
signalled that clicking it opens a bug report. It now reads **Report a problem
with this claim on GitHub**, with an accessible name to match and clearer
guidance in the prefilled body.

### Added — the oracle checks what the audit claimed it checked

`ORACLE-AUDIT.md` stated the oracle implemented all ten server-checkable areas.
Four were only partial. `machineIndexWalk` was the worst: it ran look-alike SQL
and accepted any single row, so it was barely checking anything.

Now 215 checks against PostgreSQL 18.3, 211 matching, 4 registered divergences, 0
unexpected, with 44/44 on the focused 13 and 17 rails. Additions include
independent WAL filename arithmetic from LSN, per-node hash allowance, the
visibility map's index-only-scan effect (heap fetches 0 → 100 → 0), inline TOAST
read paths, and tuple retention across assigned-XID, prepared-transaction and
standby-feedback horizons. The machine's statements are owned in a spine module
so they cannot drift from what the oracle runs.

## [0.39.2] - 2026-08-04

### Fixed — the ground plate had no underside

Nik kept seeing sky through the city's edge. The clients-forecourt overhang fixed
in 0.39.1 was real but was not the whole story.

The plate is cut to the Slonik outline with a 14-unit skirt for its poured depth —
and nothing below or behind it. **All 417 outer-edge probes saw sky through the
plate** on the first run of the new invariant. There is now an underside, an outer
face carried down to the excavation floor, and a capped base.

The invariant is a raycast over every outer-edge segment looking up and down, not
a screenshot: no reachable camera position may see sky through the plate.

The gantry visible in the report was checked and is sound — it is the HA rejoin
bay projected across the edge, with all eight structural instances landing on
physical plate ground about 209 m from the nearest edge.

### Fixed — first person was uncomfortable

- **The hands are now interaction-driven.** They are absent while you walk, one
  reaches for the autovacuum lever, both appear for the control-centre door and
  for swimming, and they recede again. The boxy mittens are replaced with tapered
  low-poly palms, thumbs, fingers and forearms; `reduced` and `low` drop them
  entirely.
- **The selection marker is suppressed in walk mode.** `picker.ts` builds a
  deliberate architect's drawing — setting-out circle, squared footprint,
  roof-level crown, staffs and dimension lines — because that is *"what makes the
  selection read from 400 m away."* Standing 1.7 m away you were inside it,
  looking through a cage of green lines. Hover was already suppressed in walk
  mode; the marker now is too. Selection state is unchanged.

### Fixed — six components showed a reader an apology

A stranger clicked the new *"This does not match PostgreSQL"* link out of
curiosity, filled in nothing, and the pre-filled context still surfaced that
`ha.endpoint` renders *"No notes for this one yet."*

Measured honestly: **6 of 110** inspectable components had no documentation —
`ha.endpoint`, `archive.status`, `conn.conduits`, `lsn.ruler`,
`storage.durability`, `storage.tempfiles`. All six are written; coverage is
110/110, enforced by a test that enumerates the production registry dynamically
rather than a hand-maintained list.

### Changed — a keyboard assertion that pinned a number

The accessibility test asserted an exact nine-key sequence to a Diagnose verdict.
The first-person work made the path one keystroke shorter, which is an
improvement — but a test that pins an observed measurement is the failure this
project has a rule against. It now asserts the durable property: the verdict is
reachable by keyboard within a bounded number of keystrokes and exposed in the
accessibility tree, with the actual sequence still reported for a human to read.


## [0.39.1] - 2026-08-04

### Fixed — the clients forecourt hung over nothing

`clients.ts` built its forecourt at x = -150…150 while `DISTRICT_BOUNDS.clients`
declares -120…120, so the west edge overhung the ground plate by 30 units with
nothing beneath it — visible from a phone as a slab floating over sky.

`layout.ts` is meant to be the single source of truth for geography, and a module
carrying its own extents is exactly the drift it exists to prevent. The forecourt
now derives from layout geography, and `collision-coverage.test.ts` asserts every
district surface stays inside its district **and** has physical ground under it.

### Fixed — the city could only be navigated with a mouse

A controls review against Google Maps/Earth conventions found that keyboard input
moved the camera but never turned it: orbit keys translated only, and fly and
walk both required pointer movement to look. **A keyboard reader could move
through the city but could not turn toward anything in it.**

(The keyboard path to a Diagnose verdict shipped in 0.38.1 was through the text
surfaces and remains correct — this was the 3D camera.)

Now, in orbit, fly and walk alike:

| Keys | Action |
|---|---|
| `Shift` + ←/→ | Turn |
| `Shift` + ↑/↓ | Tilt / look |
| `+` / `-` | Zoom |
| Arrows | Move, unchanged |

Measured: keyboard rotation of 0.145 rad where previously heading never changed.

### Fixed — reduced motion was only half honoured

`focusOn()` already cut immediately, so component focus, Home, tour framing and
walk exit did not tween. But orbit and pan **inertia were unchanged** — a
reduced-motion run showed an angular tail identical to normal motion, and for a
reader who set that preference because motion makes them unwell, the drift after
every drag is the part that matters. The measured tail is now exactly `0`, while
direct drag response is retained.

### Also

- Exiting the guided tour now cancels its in-flight camera move.
- After a two-finger touch gesture, the remaining finger returns to one-finger
  pan rather than staying in rotate.
- Double-click remains **semantic component focus** rather than a Maps-style zoom
  step — deliberate, and now documented rather than surprising.
- Ground-anchored pan was reported as a defect and found to be already correct;
  it is now protected by a test alongside the viewport-centre orbit invariant.


## [0.39.0] - 2026-08-04

Four defects Nik found by walking the city, and the tests that make each class
impossible to reintroduce.

### Fixed — text readable only in a mirror

`REJOIN BAY` and its caption block rendered backwards. The cause: `plate()` built
every text plane with `side: THREE.DoubleSide`, and a text plane seen from behind
is mirrored. The plate sat on the far side of its wall facing *into* the
structure.

`DoubleSide` is why no test caught it — the plate existed, carried the right
string, and rendered.

**Ten plates across five modules were affected.** A geometric invariant now
asserts, for every text plane, that its legible normal does not point into
geometry, that its world matrix has positive determinant (a reflection mirrors
text from either side, including via a parent group's negative scale), and that
its up vector stays near world up. Failures name the offending plate by its text.

### Fixed — the buffer pool stood above its own borders

The water surface sat at Y 8.80, the deck at 3.05, and the indigo strip described
in its own comment as *"the plaza's outline"* at 2.27–2.49 — below the deck. No
basin, coping or retaining wall existed anywhere: nothing contained the water.

Glazed coping now runs from the deck up past the water surface, collidable on all
four sides with an access gate so swimming still works. The geometry now says the
true thing: `shared_buffers` is a fixed allocation.

### Fixed — rotation orbited the map centre, not the view

Zoomed in near a map edge, rotation pivoted around the middle of the city. Three
compounding causes: the pivot clamp pulled the pivot *inward* at the edges;
rotation never re-anchored the pivot to what was under the viewport; and
zoom-to-cursor capped its shift so the pivot trailed what you zoomed into.

Camera gestures now follow the conventions hands already know — rotate and tilt
about the ground point under the cursor or the view centre, zoom holding that
point fixed, pan keeping the ground under your finger. The invariant asserted:
after a rotate drag, the world point at the viewport centre is still at the
viewport centre — tested at several distances and hard against the map edge.

### Fixed — 16 MiB WAL segments are a default, not a constant

Three surfaces stated fixed 16 MiB segments without the initdb scope. A real
cluster built with `--wal-segsize=32` reports 32MB; `wal_segment_size` is chosen
at initdb and cannot change afterwards. Found by the oracle, not by reading.

### Added

- **The city's layout in words** — districts, containment, adjacency and the
  reason each adjacency is meaningful, generated from `layout.ts` so it cannot
  drift, with a test that fails if a district exists in one and not the other.
  It closes the layout gap `ACCESSIBILITY.md` named; it does not pretend to
  replace the walk.
- The oracle reached **211 checks**, now covering WAL segment size, wait-event
  mappings, connection-local session behaviour and the remaining page-layout
  experiments. 0 unexpected divergences.


## [0.38.1] - 2026-08-03

### Added — the city works without a mouse, and without sight where it can

The teaching content is text — panels, docs, Diagnose steps and verdicts, the
Machine's transcript and receipts — and none of it had been checked for
keyboard-only or screen-reader use.

A complete lesson is now reachable by keyboard alone: `Tab, Enter, Tab, Enter,
Tab, Tab, Tab, Tab, Enter` from the skip link to a Diagnose verdict, no pointer.

The `P`/`M` distinction — the project's integrity line — survives translation to
a medium with no colour or glyphs. A Machine receipt announces as *"PostgreSQL
measured receipt: … 1 row. **Modelled architecture replay complete.**"*, and a
replay stage as *"Modelled architecture replay, stage 1 of N … PostgreSQL
measurements are reported separately in the receipt."*

`ACCESSIBILITY.md` records the structural limits honestly rather than covering
them with labels. A first-person walk through a 3D city will not work without
sight; what matters is that the lessons are reachable another way, and where a
mechanism is taught only through geometry that is named as a gap.

### Fixed — the lower fidelity tiers still teach

Every visual rule this project enforces had only ever been verified at `high` or
`ultra`. A reader on older hardware gets `reduced` or `low`.

Measured at every tier, day and night: the worst semantic colour pair holds at
0.0666 day / 0.0442 night, disclosures hold 9px, touch targets hold 44x44px.

`low` needed work to make that true. It drops bloom and the night post-chain, and
bloom is what carries semantic glow at night — so a brighter semantic palette and
compensating lights restore the meaning, at roughly 0.6 MiB and up to 3,500
additional semantic packets. Plates, labels, routes, disclosures and semantic
hues all survive. Key Design Rule 4 says meaning must survive degradation while
decoration need not; that is now measured rather than assumed, and the colour,
disclosure and touch tests sweep the tier axis.

City chunk: **+6 bytes**. `TIER-AUDIT.md` records what each tier removes.

### Fixed — vacuum can succeed and still not return space

`VACUUM` truncation needs a brief `ACCESS EXCLUSIVE`, and the attempt is
non-blocking: with an `ACCESS SHARE` held, truncation did not happen until the
lock was released. The city taught reclamation without the lock facet, so an
operator watching disk not fall after a clean vacuum had no explanation.

### Changed — PostgreSQL 18.4

The oracle ran its full suite against 18.4: 188 checks, and **only the version
label differed**. No checked behaviour moved between 18.3 and 18.4. That is the
evidence for a safe bump, so the reference is now 18.4 — while the city continues
to target the **18 major line**, since a point release is not where behaviour
changes.

### Oracle

**188 checks, 61.8 s, 0 unexpected divergences.** The four that remain each carry
their justification inline, so a reader can tell deliberate from accidental.


## [0.38.0] - 2026-08-03

A lens created **real** conditions on a real PostgreSQL 18.3 — genuine lock waits,
genuine slot retention, genuine checkpoint pressure — then walked Diagnose using
only the evidence its own steps gather. It found the three failure modes that
matter for a diagnostic tool, and this release fixes them.

### Added — an entry point for the most common WAL-disk incident

**"The disk is filling and `pg_wal` keeps growing" was not a symptom you could
start from.** The root list had no disk-growth entry, no step used the `slots`
projection that already existed, and slot advice appeared only *after* a
replication verdict. An operator arriving with the actual symptom had nowhere to
go.

There is now a path, discriminating on `pg_replication_slots.wal_status`
(`reserved` → `extended` → `unreserved` → `lost`) and `max_slot_wal_keep_size`,
reaching the slot-drop consequence corrected in 0.37.2 — that dropping a slot
removes its retention *guarantee*, not the WAL.

### Fixed — a confident wrong verdict

**Every lock wait reached the `ACCESS EXCLUSIVE` verdict solely because a waiter
existed.** Ending the holder is sound advice for any blocking lock, so the action
survived — but the asserted lock type, the DDL framing and the `lock_timeout`
emphasis were wrong for an ordinary row-lock or `SHARE`-mode conflict, which is
the far more common case. A reader with a `FOR UPDATE` conflict was told they had
a DDL problem. The verdict now reports the mode actually observed, which
`pg_locks.mode` was already supplying.

### Fixed — evidence that narrows rather than concludes

Two materially different conditions both reached `v.ckpt_storm`. The verdict was
already honest that counters cannot establish cause; the branch now says so too —
*"counters correlate; this narrows the path but does not establish cause"* —
rather than letting a reader believe they had diagnosed something they had not.

### Changed — the oracle audits itself, nightly

`tools/pg-oracle.mjs` ran only when someone typed `npm run oracle`. The reasoning
for keeping it out of CI was sound — hosted runners ship PostgreSQL 16, the
oracle needs 18 — and is exactly the reasoning that left the test suite gating
nothing for this project's entire history.

Measured: a service container is fast (6.07 s pull, 2.60 s readiness) but cannot
serve the standby audit, which needs real 18 binaries; a PGDG install costs
34.29 s provisioning plus 40.67 s of oracle. It now runs as a **scheduled daily
audit** rather than a push gate, because it legitimately reports four deliberate
model divergences and a gate that cries wolf gets ignored.

`ORACLE-AUDIT.md` records the boundary explicitly: which registered claims are
mechanically checkable against a server, and which — model calibration,
PgBouncer/WAL-G/PGlite behaviour, product thresholds, UI routing — are not.

The harness is now at **131 checks**, from 58 when it was built.


## [0.37.2] - 2026-08-03

Everything here was found by running PostgreSQL, not by reading about it. Six
lenses drove real 13/17/18 clusters; two came back clean.

### Fixed — advice an operator would act on

- **"Dropping the slot means rebuilding the standby" is false.** Measured: an
  inactive slot retaining 65 MiB was dropped, `pg_wal` did not shrink, and the
  standby was restarted **without** `primary_slot_name` and kept streaming —
  120,000 rows replayed, no base backup. Dropping a slot removes its retention
  *guarantee*, not the WAL. The standby continues if the WAL is still in
  `pg_wal`, recovers through `restore_command` if not, and needs a rebuild only
  when the WAL is gone from every source.

  This inverted the decision under pressure: an operator watching a disk fill,
  believing a drop forces a rebuild, leaves the slot in place.

- **Raising `bgwriter_lru_maxpages` is not "nearly free".** Backend writes nearly
  vanish, which is the mechanism working — but total writes can rise, because a
  page may be written repeatedly before the next checkpoint. It moves writes off
  the query path at the cost of doing more of them.

- **`statement_timeout` does not stop a forgotten idle transaction.** It is
  measured only while a statement is *processing*. A session with
  `statement_timeout = 100ms` was still connected after 500 ms idle. Both
  timeouts are worth setting; they guard different things.

### Fixed — MVCC and storage

- **A committed `xmax` does not mean the tuple is dead.** `HEAP_XMAX_LOCK_ONLY`
  records a row lock, and the tuple stays live after that locker commits; a
  MultiXact must be read from its members and flags. `anatomy.ts` already said
  "deleting or locking" — the prose contradicted the geometry, and the claims
  spine did not catch it because field *meanings* were never registered. They are
  now.

- **HOT is not blocked by summarizing indexes.** Measured: 5,000 of 5,000 updates
  went HOT with a BRIN-indexed column changing, against 0 of 5,000 for B-tree —
  a rule introduced in PostgreSQL 16, not 18, verified across 13/17/18. The BRIN
  summary still required maintenance, so "no index work happens at all" was wrong
  twice.

- `REINDEX TABLE` does not rewrite the heap; the ~2 KiB TOAST figure is a default
  target changeable per table via `toast_tuple_target`; a wide value does not
  always mean chunk reads *and* decompression; the xmin horizon is a
  snapshot/removal horizon, not "the oldest xid anyone can still see"; and a
  `READ ONLY` transaction can hold an XID via `pg_current_xact_id()`.

### Fixed — the SQL we hand operators

- **A lock-diagnosis query that stresses the lock manager.** `pg_blocking_pids()`
  was called for every `pg_stat_activity` row; PostgreSQL documents that each
  call briefly requires exclusive access to lock-manager shared state. Replaced
  with the waiter-limited shape `lock.1` already used.
- **`buffers_clean` non-zero is not a health invariant** — a healthy idle server
  returns 0.
- **PostgreSQL 15 did not make statistics survive restarts.** PostgreSQL 13
  preserved them across a *clean* restart; 15 replaced the collector with
  shared-memory accounting.
- Queries using `num_done` and per-operation byte columns are PostgreSQL 18 SQL;
  each now carries the PostgreSQL 17 form beside it.

### Fixed — the front door

- The README described `walwriter → segments → archiver → walsender` as a serial
  pipeline. PostgreSQL branches these: the archiver copies completed segments
  while walsenders stream independently. The project's own docs already said so.
- 2 GiB `shared_buffers` was called "the default"; that is the **model** default,
  against PostgreSQL's 128 MiB.
- Regenerated the hero and the social preview — the deployed preview still showed
  one standby and no continuity quarter.
- The `reduced` tier is not a fixed destination; the renderer steps adaptively.
- Node `^20.19.0 || >=22.12.0`, not "20 or newer" — Vite 7.3.6 requires it.
- Contributors are told they need Chrome for the browser lane, and given the fast
  lane without it.

### Also

- The index walk now exposes partial predicates, access method, `COLLATE`,
  operator class and ordering — everything that decides whether an index serves a
  given query — and `\d` marks an invalid index `INVALID` as psql does.
- MVCC vocabulary is registered in the claims spine, so a label and its prose
  cannot narrow apart again.
- The oracle grew **58 → 100 checks**. GUC context, index attributes and
  cross-version query executability are now classes it owns.


## [0.37.1] - 2026-08-03

### Fixed — configuration semantics, found against a running server

- **"Changing one here changes the running model, exactly as a `SET` or a reload
  would" was false for half its own projection.** `shared_buffers`, `wal_buffers`,
  `max_connections` and `wal_level` are `postmaster` context and need a restart —
  demonstrated with `pending_restart = t`. The city teaches people to change
  settings, and the difference between "now", "on reload" and "needs a
  maintenance window" is among the first things an operator must internalise. The
  settings projection now reports `pg_settings.context` per row.

- **`autovacuum_max_workers` changed context in PostgreSQL 18.** Measured:
  `postmaster` on 13 and 17, **`sighup` on 18**, with a reload applying it. The
  city reported `postmaster` — telling operators to schedule a restart they do
  not need, in the exact version it targets. Now looked up rather than asserted,
  and qualified by version.

- **A quoted "server log" crash sequence mixed in client-only text.** After
  `SIGKILL`ing a backend, `WARNING: terminating connection because of crash of
  another server process` appeared only in the surviving client — absent from
  `.log`, `.csv` and `.json`. An operator greps the server log; the real lines are
  now quoted, and client-side ones are marked as such.

- **Preload and restart steps were missing where they gate the feature.** A reader
  following the city's `pg_stat_statements` advice got
  `ERROR: pg_stat_statements must be loaded via "shared_preload_libraries"`.
  `logging_collector` and `shared_preload_libraries` are `postmaster` context, and
  installing `pg_prewarm` does not activate autoprewarm.

### Fixed — the touch-target guard checked CSS text, not the rendered box

The previous guard was a regex over stylesheet source: it proved a rule existed,
not that it won — which is exactly how a control shipped at 7px, with
`.machine-nav button` (0,1,1) beating `button { min-height: 28px }` (0,0,1).

The audit now derives its control list from the rendered DOM, measures
`getBoundingClientRect()` at 390x844 and hit-tests the centre with
`elementFromPoint()`, proven by an injected 1x1px probe that fails naming the
element. Several controls beyond the three known were undersized and are fixed.

### Changed — the suite now gates the deploy

`npm test` never ran in CI: typecheck and build only. This project's flow is
agent branches merged straight into `main`, so a PR-only trigger would have gated
nothing either — CI now runs on push to `main` as well.

Two lanes: `Tests (fast)` excluding browser specs, and `Tests (Chrome)` with
provisioned Chrome. Verified by pushing a deliberate failing assertion —
`Tests (fast)` red while typecheck and build stayed green (run 30801057070) — and
by the trigger fix running green on push (run 30801280366, 51s / 82s / 105s).

### Added

`npm run oracle`. The harness grew from 58 to **80 checks**: `pg_settings.context`
is now a checked class across 13/17/18, so the next GUC whose context shifts
between versions is caught rather than discovered. It stays local rather than in
CI because hosted runners ship PostgreSQL 16 and the oracle needs 18 binaries.


## [0.37.0] - 2026-08-03

### Added

- **An oracle: the city's claims, checked against a real PostgreSQL.**
  `tools/pg-oracle.mjs` spins a throwaway cluster on a probed port, derives its
  checks from the claims registry rather than a hand-written list, and prints a
  divergence table. 58 checks in 34 s; runs against 13, 17 and 18, and will take
  19 without code changes. Registering a claim now automatically subjects it to a
  real server.

  Cross-version runs double as a finder: anything that diverges on 17 or 13 but
  not 18 is by definition version-dependent, which is how four unqualified claims
  were found and qualified.

- **Version provenance.** The city, the Machine and Diagnose each now say which
  PostgreSQL they describe. The Machine separately reports the engine it actually
  queried — `PostgreSQL 18.3 (PGlite 0.5.4)`, `server_version_num = 180003`,
  obtained from `SELECT version()` rather than assumed. It matches the teaching
  target, but it is a different fact and is stated as one.

- **A PgBouncer connection pooler**, rebuilt after the first attempt was reverted
  on four blocking defects. It now shows the honest result: at equal admitted
  load the pooler *costs* throughput (1,170 direct vs 996 pooled), and session
  mode binds eight clients to eight backends while 992 await assignment. The
  trade the feature exists to teach is no longer inverted.

### Fixed — found by running PostgreSQL, not by reading about it

- **Autovacuum uses `pg_class.reltuples`, not `pg_stat_user_tables.n_live_tup`.**
  A live server launched autovacuum when the `reltuples` threshold was crossed
  and the `n_live_tup` threshold was not. The city said `n_live_tup` in three
  places and implemented it. `reltuples` is a planner estimate refreshed by
  `VACUUM`/`ANALYZE`, so the two diverge exactly when a table changes fast —
  which is when autovacuum matters. Six rounds of documentation review passed
  this, because the manual's phrasing admits both readings.

- **PostgreSQL 18's `autovacuum_vacuum_max_threshold`** (default 100,000,000) caps
  the scale term and was neither modelled nor mentioned. Now both.

- **`num_timed` counts timer expiries, not checkpoints.** On an idle server:
  `num_timed 1, num_done 0`, no checkpoint messages. If nothing changed, the timer
  fires and the checkpoint is *skipped*. The city set
  `ckptDone = ckptTimed + ckptRequested` and let Diagnose say a timer checkpoint
  "fired". PostgreSQL 18 exposes `num_done` for exactly this reason.

- **`pg_stat_io` operations were wrong for the writers** — the city projected
  `reads, hits, evictions` for `checkpointer` and `background writer`; the server
  reports `writes, writebacks, fsyncs`. Those processes write.

- **`\d` rendered an invalid index as usable**, where real psql prints `INVALID`;
  and the index walk had over-corrected into hiding invalid indexes entirely.
  Neither is right: a failed `CREATE INDEX CONCURRENTLY` leaves an index that
  consumes space, is maintained on write, and the planner will not use.

- **The index walk stripped what determines usability** — predicates, access
  method, `COLLATE`, operator class and ordering. `text_pattern_ops` is what makes
  `LIKE 'x%'` indexable; a partial index serves only queries matching its
  predicate; a hash index has no key order at all.

### Verified clean against a real server

WAL, recovery, replication and backup — checked with real streaming replication,
a real promotion and a real `00000002.history`. Locks, concurrency and isolation —
checked with six concurrent sessions producing real lock waits, real deadlock
reports and a real `40001` serialization failure. Both lenses returned no defects.


## [0.36.2] - 2026-08-02

### Fixed

- **The flake recorded as unexplained since 0.33.0 is diagnosed and fixed at the
  root.** `vite.config.ts` set no `testTimeout`, so all 754 tests ran on Vitest's
  5 s default — including 55 disaster-recovery tests with no per-test override,
  several of which already take 3–5 s alone. Under the suite's own worker
  parallelism on a 4-core box they crossed the deadline and failed at
  5436–5743 ms, while passing 55/55 in isolation *at the same load average*. The
  trigger was inter-worker parallelism, not ambient load, which is why an earlier
  hunt using CPU-busy loops missed it across fifteen runs.

  The fix is a 60 s `testTimeout`/`hookTimeout`, not shorter tests. These are
  deterministic model tests — no `Date.now`, no `Math.random`, no `setTimeout`
  anywhere in `src/sim` — so a wall-clock deadline measures the host rather than
  the code. Trimming them to fit is how the vacuum-blockade lesson was lost once
  already.

### Note

- 0.36.1 was never red. Its apparent failures were produced by a review agent
  running the full suite while its own browser audits saturated the machine at
  load average 25 — the reviewer diagnosed and reported this against itself.


## [0.36.1] - 2026-08-02

### Fixed

- **The index-walk catalog recipe was wrong four ways.** `ORDER BY a.attnum` gave
  table column order rather than index key order — for a btree, the single most
  consequential fact. There was no `indnkeyatts` split, so `INCLUDE` payload
  columns read as indexed; expression indexes vanished because their `indkey`
  entries are `0`; and without an `indisvalid` filter an invalid index left by a
  failed `CREATE INDEX CONCURRENTLY` read as an available access path — exactly
  the case the step exists to teach. Nothing displayed was false only because the
  seed schema happened to be single-column, valid and non-expression. Verified
  against a real PostgreSQL 18.3 cluster.
- **The 45-pair semantic colour claim was day-only, presented as global.** Night
  ran the same aerial-perspective haze, but the night test applied no fog, so the
  minimum pair fell to 0.03605 / 0.03424 / 0.03439 against the project's own
  0.038 floor. Fixed in the artifact, not the assertion: fog density, the haze
  ceiling and all five presets are byte-identical; two semantic hues moved by
  ~0.007 OKLab each. The night test now applies fog at every tier.
- **`START HERE` was untappable on a phone** — 7px with `min-height: 0`, because
  `.machine-nav button` outranks the mobile `button` minimum on specificity. Now
  86×44px. The browser audit's programmatic `.click()` had proved the handler was
  bound, not that a finger could reach it.
- Two vitest timeouts set to `0` (unbounded) now have real bounds, and the
  vacuum-blockade scenario's lesson — terminate the blocking transaction and
  vacuum reclaims — is covered again by directional assertions rather than the
  magic thresholds that were removed.

### Process

- **v0.36.0 was tagged while its review panel was still running**, and the panel
  then returned two blocking defects that were by then live. `CLAUDE.md` now
  states that "an independent review panel has read it" means the panel has
  *reported*, not been *dispatched*, and that when a deadline and the panel
  conflict, the release ships less rather than sooner.

### Known

- The catalog recipe omits partial-index predicates, the access method, and
  opclass/`DESC`/`COLLATE` modifiers; the neighbouring `\d` implementation keeps
  them. The mobile touch guard asserts CSS source text rather than the rendered
  box, so three sibling header controls remain below the 44px minimum. Both are
  logged for the next release.

## [0.36.0] - 2026-08-02

### Added

- **The Machine adopts your first query.** `SELECT 1` becomes a four-statement
  walk through real `pg_class`, `pg_attribute` and `pg_index`, then
  `EXPLAIN (ANALYZE, BUFFERS)` twice on the same table, with `Result`,
  `Index Scan` and `Seq Scan` receipts retained side by side.
- **First person has hands** that reach for the autovacuum lever, push the
  control-centre door, and move differently underwater.
- A graphics pass: contact darkening and aerial perspective, with all 45 semantic
  colour pairs held above threshold and frame time unchanged.

### Fixed

- Reference coverage in `docs-storage.ts` is 44 of 44, with every PostgreSQL 18
  section number verified. "Recovering Using a Continuous Archive Backup" is
  §25.3.5, now enforced by a test.
- The unexplained suite failure recorded in 0.33.0 is fixed. Five agents running
  in parallel made it reproducible — three of ten loaded runs — and the fixes are
  at the cause: duplicate browser audits consolidated, a vacuum assertion that
  waited for a full cycle now asserts released xmin, and host-speed deadlines
  removed from deterministic checks.

### Held back

- **A PgBouncer connection pooler**, built and reverted before release on four
  blocking defects: the pooled run silently discarded ~3,050 transactions/second
  into a counter absent from `SimStats` while the panel read "0 refused"; session
  mode was transaction multiplexing with its wait attribution erased; the
  headline throughput gain was `batchSize` collapsing under the admission gate
  rather than the pooling mechanism; and "not a speed feature" was too categorical
  against PgBouncer's own documented aim.

## [0.35.0] - 2026-08-02

### Added

- **One timeline fork, enforced in the restore path.** A promotion increments the
  timeline and writes `00000002.history`; parent and child archive frontiers are
  tracked separately; `recovery_target_timeline = latest` follows the history file
  across the fork while `current` stays on the backup's timeline; and the
  divergent tail is quantified rather than hidden.
- Recovery requires evidence: a time target is reached only when a
  transaction-end record's timestamp crosses it. The archive is re-read live
  rather than snapshotted at restore start. The fork segment is copied forward as
  `XLogFileCopy` does. A backup spanning a promotion is stored as two WAL ranges.

### Fixed

- Six review rounds' worth of defects, including a fabricated archive-durability
  claim that appeared four times by four different routes before an invariant
  closed the class, and a correction that over-corrected into refusing every
  cross-fork PITR.


## [0.34.0] — 2026-08-02

### Restore drills now distinguish evidence from claims

Restore drills now distinguish the healthy unarchived tail of the current WAL
segment from an actual archive fault, and distinguish expired retention from a
target for which no earlier base backup was ever taken. The normal tail teaches
the archive-only RPO floor and the `archive_timeout` padded-segment trade-off.

Full-cluster smoke can now catch an empty restored table that the one-table
level misses, while manifest verification can catch retained-object corruption
that every smoke query misses. Smoke checks are priced as targeted expected-row
lookups instead of relation scans. The former RTO label is now
**restore-to-target time**, explicitly excluding promotion, cutover, client
reconnection, and service restoration.

### Work memory and correction paths

The city now shows `work_mem` as a per-node allowance for Sort and
HashAggregate, including `hash_mem_multiplier`, temp-file spill evidence, and
the resulting model-latency movement. It states that join spills, parallel
execution, and cost-based replanning are outside the model.

Every claim-bearing panel now offers a pre-filled PostgreSQL correction report
with its displayed wording, source, app version, and minimum reproduction
state. Correction anchors opt out of Plausible's outbound-link capture in code,
so issue bodies are never sent as analytics URLs. Restore-drill review also
separated a healthy unarchived WAL tail from an archive fault and corrected the
cost of smoke checks.

## [0.33.0] — 2026-08-02

### Latency becomes an observable model result

The city now reports a rolling distribution of completed backend trips with
separate quantiles for buffer reads, dirty-victim I/O, eviction WAL flushes,
commit waits, relation-lock waits, and the remaining modeled work. Dirty page
writers now obey the write-ahead rule, evictors join in-flight WAL group
flushes, `synchronous_commit = off` does not accrue commit wait, and vacuum
throttling appears as `Timeout/VacuumDelay`.

### One measured execution, two modeled commit policies

The Machine comparison replays one PGlite receipt through
`synchronous_commit = on` and `off`, labels the replay as modeled rather than a
controlled PostgreSQL experiment, completes the deferred flush, and explains
the acknowledged-commit loss window. Mobile disclosures now have a tested 9 px
floor. Registry names, deep-link destinations, and production event routes are
checked so navigation and claim ownership cannot drift silently.

## [0.32.0] — 2026-08-02

### A spine: claims now have an owner

Four review rounds found dozens of real errors. A coherence review then named the
pattern behind most of them, and was explicit that more review would not fix it:

> *"Nothing in this project owns a claim, a convention, or a link across the
>  surfaces that carry it. Every failure is one shape — a fix, a feature, or a
>  convention landed on some surfaces and not the rest."*
>
> *"More review will not fix this; three rounds already found dozens of genuine
>  errors **and produced most of the drift**, because each fix was scoped to a
>  file."*

The evidence was concrete. `standby_b` reached the model, the world and the views
projection — and not the Diagnose branch logic, so the tool announced "the
standby is current" with 17 MiB of lag on screen. The `max_wal_size` fix reached
the model **with a comment explaining why** and not the dial. A truncation fix
reached four prose surfaces and not the plate painted in the world.

Claims now have one source, and surfaces that restate them are checked against
it. Proven by deliberate breakage: changing a model value makes the tests name
the surfaces that disagree —

```
bufferSample: model:default active frames disagrees with ...
bulkReadRing:  model:bulk-read ring disagrees with ...
```

— rather than leaving them quietly wrong until someone runs the app and notices.

### Three links nobody owned

The **deep links into the city did nothing** — around thirty-six of them, and the
only edge joining a symptom to the mechanism that causes it. The **tour rendered
raw markdown** while `mdToHtml()` sat unused. And the **boot screen still said
"unreviewed"** after four review rounds.

Each is the same shape: a convention that existed on one surface and not the one
that needed it.

---

## [0.31.0] — 2026-08-01

### You can watch a WAL segment fill

Archiving was correctly modelled and effectively invisible. At the shipped
defaults a real 16 MiB segment fills every **seventy-eight model minutes**, so a
headline disaster-recovery mechanism fired about once an hour and a reader never
saw it. The compression made time watchable and left the segment size real, so
the ratio between them stopped supporting observation.

`WAL_SEG` stays 16 MiB — segment names, `max_wal_size` arithmetic and retention
all lean on it. What changed is that the **approach** is visible: the archive gate
shows the current segment filling toward completion, so the lesson that WAL ships
in whole segments, and nothing is archived until one closes, is legible
continuously instead of once an hour.

Base backups now run on a schedule. Without a cadence, retention expressed in
backups never bites and backup age never grows and resets, so neither lesson
could be felt. `backup-push` runs from the standby and `wal-push` from the
primary, which was already true and is now visible.

### The two standbys are siblings

Standby A carried the name it had when there was only one — `replicaEnabled`,
`replicaNetworkLag`, `replicaSlowApply` — while standby B arrived with the
cluster arc under a different scheme. **Three concepts, two vocabularies, decided
by build order.**

Worse, the top-level replication fields were copied from the first standby, so
reading the aggregate silently gave you standby A without the call site saying
so. **That shadow is what let a Diagnose branch announce "the standby is current"
while the grid beside it showed the other one 17 MiB behind.** v0.30.0 fixed that
branch; this removes the thing that made it easy to write.

Differences that are real configuration are kept — which node is synchronous is
driven by `synchronous_standby_names`, not by history.

---

## [0.30.0] — 2026-07-31

**The second review round, and it found what the first structurally could not** —
because two of its four lenses required *running* the app rather than reading it.

### The Machine executed your SQL twice

`EXPLAIN (ANALYZE, BUFFERS)` ran the statement inside a transaction that was
rolled back, then the statement ran again for the displayed result. `ANALYZE`
executes — and **PostgreSQL documents that sequence changes are not rolled
back**. A `nextval()` advanced twice; volatile functions ran twice; delays ran
twice. Proven through the UI with `CREATE SEQUENCE`.

A submitted statement now executes once and the displayed rows come from that
execution. Verified the same way: `nextval = 1`, `last_value = 1`.

### Diagnose reached the wrong verdict while showing the evidence against it

Three of eight diagnostic paths. The replication step read the **single-standby
aggregate** while the grid above it rendered both walsenders, so it concluded
"the standby is current" with a 17 MiB lag row on screen and `REPLAY LAG 7.42 s`
in the header. The bloat path gated above a threshold the model cannot reach, so
following the tool led to *"These tables are not bloated"* — its own headline
lesson unreachable. The slow-server path required a CPU share the staged storm
never produces.

The cause is nameable and general: the three-node cluster work reached the model,
the world and the views projection, and **never reached the branch logic.**

Two tests now stop the class recurring: **every branch gate must be reachable in
the state its path stages**, and **a branch must read the same source as the view
beside it.**

### The simulation was importing three.js

`CLAUDE.md` states twice that `src/sim` never imports three.js and that
simulation and presentation meet only at `SimState`. Neither was true: the model
took table definitions as input, flow identity, and toast anchors from
`world/layout.ts`, while world modules imported simulation helpers back. **A
presentation-layout edit could change simulation behaviour.** The boundary this
project's honesty argument rests on was circular.

It is now enforced by a test asserting the import graph is acyclic and
three.js-free, rather than by a sentence that had quietly become false.

### A knob could be wired to nothing and every test passed

`replicaSlowApply` could be disconnected from the model with **591 of 591 tests
green**, because the broad every-knob test asserted only that a snapshot exists
and every value is a string. Knob coverage now asserts a measurable output
responds.

### Prose promised what the model cannot do

The rules named one failure mode — buildings teaching falsehoods more
persuasively than text teaches truth. A review of the project's *premise* found
the inverse running throughout: the tour promising join-order costing with **no
join node in the codebase**, a plate promising that stale statistics misprice
plans with no path from `ANALYZE` to a plan, a scenario telling the reader to
watch a latency spike when `SimStats` has **no latency field at all**.

Those claims are corrected or marked absent. Key Design Rule 7 now names both
directions.

Also fixed: the control center and the 2D flow printed the roughly hundredfold
stretched model clock as plain milliseconds beside four faithful counters, making
PostgreSQL look two orders of magnitude slower than it is.

---

## [0.29.0] — 2026-07-31

**The first release gated by an independent review panel**, and it found things
twenty-one previous releases and a green suite did not.

Three reviewers read `main` with distinct lenses — the simulation's PostgreSQL
fidelity, the operational claims, and the user-facing prose — two on Opus and one
on GPT, independently. Everything below was **measured**, not inferred.

### Falsehoods, now fixed

- **`wal_level = minimal` froze the whole database, permanently.** `standby.enabled`
  was assigned before the guard that disconnects the standby at that level, so the
  synchronous commit branch was entered against a frozen acknowledgement — and that
  branch had no watchdog while the local branch did. Measured: 16 backends in
  `commit_wait`, **0 tps**, no recovery. One click from the control rail.
- **Losing the synchronous standby silently downgraded durability and made the
  city faster** — 272 tps to **366 tps**. Real PostgreSQL enters
  `SyncRepWaitForLSN()` and waits forever. The app's own documentation already
  said so: *"commits hang — not fail, hang."* Commits now hang, and the plated
  `synchronous_standby_names` can be cleared to release them, which is what an
  operator actually does.
- **A follower ahead of the new leader silently followed the new timeline.**
  PostgreSQL refuses — *"requested timeline 2 does not contain minimum recovery
  point"*. Promoting a laggard leaves **zero** healthy standbys, not one; the
  scenario now says so and reports both repair costs.
- **Vacuum's cost throttle scaled the reported I/O instead of vacuum's pace** —
  eleven of every twelve heap reads unaccounted, so autovacuum could not produce
  the I/O event the Diagnose page tells readers to suspect. Real cost-based vacuum
  sleeps. And the disclosure was itself false: under the heading *"Where this
  model cheats"* it claimed a shared cost budget that did not exist.
- **A bulk-read sequential scan scored a 99% buffer hit, and rising** — the ring
  was implemented correctly and defeated by the hit accounting, contradicting both
  the model's own code and its own prose.
- **The background writer never lapped an idle pool**, because its cursor
  re-anchored to the clock hand every round. Real `BgBufferSync()` keeps a
  persistent cursor precisely so idle periods end with clean buffers.
- **The Query Lab printed plans PostgreSQL cannot produce**, and plans that
  contradicted their own displayed SQL.

### Consensus, not an arbiter

The model had one central Patroni, one boolean for DCS reachability, and every
node and DCS member on one plate — teaching that split-brain is prevented by a
lock server you can switch off.

Patroni is now an agent per node; etcd is a member per site running a consensus
protocol with terms and commit indices; three failure-domain platforms sit 320 m
apart. **A minority is not outvoted — it cannot commit**, so it never observes
itself holding the leader key. Isolating the primary elects on the majority side
and keeps serving. Splitting every member leaves no leader at all: availability
given up to keep correctness.

### 43 reviewed content claims

39 corrected, 4 deferred as structural. Among them: a shared-buffer miss is not
proof of physical I/O, `active` with no wait event is not proof of CPU time, a
deadlock victim does not fail with `serialization_failure`, and *"nothing is ever
modified in place"* was false in the sentence asserting it.

**The project now states which PostgreSQL it describes — 18** — after two
reviewers disagreed about the bulk-read ring and both turned out to be right
about different versions.

### Deliberately left

Four structural findings are deferred rather than fixed, and `KNOB-AUDIT.md` is
marked re-verified with its stale line references labelled historical rather than
silently rewritten.

---

## [0.28.0] — 2026-07-31

### The documentation says what the app does

Twenty releases in a day, and the docs had drifted. `CLAUDE.md` warns about
exactly this and records that it has been caught three times before.

**The worst was a claim about the project's own premise.** The README said "no
PostgreSQL source code runs here" — true when it was written, false once the
Machine shipped PGlite. The 3D city is still a model and no PostgreSQL runs in
it; the Machine and the opt-in Query flow run a real PostgreSQL compiled to
WebAssembly. That distinction is now made rather than flattened, in the README
and in `CLAUDE.md`'s own dependency rules.

Also corrected: a single standby described where there are now two independent
ones, a screenshot caption describing the pre-golden-hour look, and a fixed test
count that had been stale for eighteen releases. **Counts in prose go stale by
construction**, so that claim no longer carries a number.

### A test that drives each documented instruction

The durable fix the roadmap has asked for since the first time this happened.
It exercises every district key, the touch Walk button, all 33 rendered knob
controls, the README's scenario walkthroughs, and the Machine's key routing.
Changing documented walk from `G` to `X` makes it fail.

**What it cannot prove is written down beside it**: real-device touch, pointer
lock, audible sound under browser autoplay policy, whether a consequence looks
semantically right, and whether the prose is true about PostgreSQL. Those still
need eyes, and a green suite should not be mistaken for them.

---

## [0.27.0] — 2026-07-31

### Swimming that feels like swimming

The swim volume, the surface and the splash all existed, and it still felt like
walking in a different pose. The roadmap named the four missing parts; these are
they.

**Drag** gives momentum, so speed builds and decays instead of switching on and
off. **Buoyancy** surfaces you passively rather than holding you wherever the
controller left you.

**Muffling** was simply absent — the audio engine had no notion of being
underwater at all. The low-pass now moves from 5,600 Hz to 620 Hz and ducks
output to 48%, which is the strongest submersion cue available and it cost
almost nothing. Muted audio stays silent.

**Something moving past you**: 192 softly textured motes in an 18 m
camera-following field.

`prefers-reduced-motion` freezes mote drift, surface motion and ripple expansion,
and damps buoyancy so swimming still works without oscillation. No camera bob was
added — buoyant bobbing in a first-person view makes people ill.

The buffer tiles beneath keep their colours and their readability: depth testing
and normal blending, no tile material touched. This is the one item on the
roadmap with no teaching content, so delight was the bar — but delight does not
get to degrade the thing that teaches.

Chunk +1.94 kB. One submerged-only draw call.

---

## [0.26.0] — 2026-07-31

### Three situations with a correct answer

Roadmap item 10, and it was always going to be last: it needs a cluster that can
genuinely go wrong, and only v0.25.0 finished making one.

Not points and badges. Each of these has a real answer that operators learn the
hard way, and a wrong choice that is **survivable, legible and clearly yours**.

**Slot pressure.** `pg_wal` at 416 of 512 MiB, 363 MiB of it retained for a
lagging standby. Adding capacity is right — the standby catches up and no writes
are rejected. Dropping the slot frees WAL to 224 MiB immediately and costs an
8.36 GiB, 22-second rebuild. Both are legitimate; which is right depends on how
far behind the standby is and how fast the disk is filling.

**Vacuum blockade.** A pinned xmin horizon, dead rows climbing, three autovacuum
workers reclaiming nothing. Terminating the idle transaction is right, because it
holds no uncommitted work. Waiting twenty seconds costs 101,567 dead versions and
1,689 pages — and is still recoverable.

**Failover candidate.** Promoting `standby_a` loses 598.80 KiB and **zero
acknowledged writes**. Promoting `standby_b` loses 13.26 MiB and **4,284
acknowledged transactions**, then needs a 6.03-second rewind. The cost of
choosing wrong is measured in transactions a client was told had committed.

Decisions appear in a non-modal instruments dock — the situation is discovered
from the world and the readouts, not announced by a dialogue. No score, no
badges, no countdown. The scaled WAL rate is labelled rather than implied.

All three share the existing scenario rail and `runScenario` spine, and each is
played **both ways** by a test that also recovers from the wrong branch. A
scenario that cannot be played by a test cannot be trusted.

Chunk +6.68 kB.

---

## [0.25.0] — 2026-07-31

### Failover, switchover, and why the old primary cannot rejoin

This is what the continuity work was for. Roadmap item 3.

**A planned switchover costs time and loses nothing.** It closes write admission,
lets accepted work finish, flushes the old primary, and waits until the chosen
standby holds every byte. Only then does the leader lock and the service address
move. The wait is the price; the loss is zero, and both are shown.

**An unplanned failover starts with the primary already gone.** The candidate
promotes at whatever durable LSN it happens to own, so the byte gap — and the
committed transactions inside it — are lost. How much depends on how far behind
that standby was, which is the entire argument for watching replication lag.

### The timeline forks

Promotion increments the timeline. Timeline 2 diverges from timeline 1 at the
standby's durable LSN, the old primary is marked **diverged**, and its
incompatible tail is shown. **Two histories, not one history where somebody is
behind** — the concept most readers miss, and now a thing you can look at. The
`timelineYard` has stood empty since the continuity quarter was built.

### `pg_rewind` takes time and can fail

It repaired a **6,707,050 byte** divergence in 6.03 s. It also fails, after a
visible check, when the data directory is gone, when block-change tracking was
absent before divergence, or when the required WAL has been recycled — following
PostgreSQL's documented prerequisites. A rewind that always succeeds instantly
teaches the opposite of the lesson.

### Patroni

The DCS lock and its renewable lease are modelled. Losing the lease demotes the
leader, and promotion without the DCS is forbidden — which is what prevents
split-brain. Quorum membership, asymmetric partitions, watchdog failure and DCS
failsafe mode are **explicitly excluded and disclosed** rather than implied.

Knob verdicts 30–33 added to `KNOB-AUDIT.md`. Chunk +12.79 kB.

---

## [0.24.0] — 2026-07-31

### Three nodes, each with its own opinion

A primary and two standbys, each owning its buffer pool, its WAL, its data
directory, its replay position — and its own view of who the leader is. **Nodes
that share a single global truth cannot disagree**, and disagreement is the whole
lesson of failover, so this is the groundwork item 3 needs.

Streaming replication is modelled per standby with **received, flushed and
applied tracked separately** — the distinction `synchronous_commit` levels are
actually about — plus a replication slot per standby.

The slot lesson works, measured: disconnecting standby B retained **35.96 MiB**
of WAL on the primary after thirty seconds, and reconnecting drained it to
84.5 KiB. Slowing B's replay grew its gap from 542 KiB to **30.47 MiB** while A
stayed healthy, then recovered to 221 KiB. A slot held for a node that is not
there is one of the most valuable operational lessons available, and it is now
demonstrable rather than described.

Three knob verdicts added to `KNOB-AUDIT.md`: `standbyBEnabled`,
`standbyBNetworkLag` and `standbyBSlowApply`, all correct with recovery.

No failover, promotion, election, Patroni or rewind. Leader opinions are
observations only — nothing acts on them yet. That is item 3.

Chunk +16.51 kB.

---

## [0.23.0] — 2026-07-31

### Indirect light, baked

Direct lighting was right after v0.22.0 and shadow was still flat dark. There was
no skylight fill, no bounce, and no colour carried from one surface to another —
GTAO approximates the darkening screen-space, but it knows nothing about geometry
beyond the depth buffer and nothing at all about colour.

The city is almost entirely static, which is exactly the condition under which
baking pays. Indirect light is now precomputed across **140 meshes, 3,038
instances and 10,809 vertices**, serialised and checked in, so a reader never
computes it: a 58 KB payload installed in **7–24 ms** in a fresh browser.

Under an overhang the surface bounce is unmistakable; on a building side it is
subtle. Deep recesses and contacts stay dark, which is the point.

**The cost is real and worth stating plainly**: the chunk grows 89.57 kB raw and
22.54 kB gzipped — about 7% and 5.3%. That is the largest single increase this
project has taken, and it buys the one thing shader work cannot fake.

### Light shafts where the city blocks the sun

At 8.4° the sun rakes between buildings, which is the geometry that produces
shafts. They are generated from **real occlusion** rather than painted where they
would look good, so they remain information about the space — where the sun
reaches and where the city stops it — rather than decoration. That distinction is
the house rule and it is not negotiable.

Three draws at 320×190 through 512×304 depending on tier. `low` and `reduced` get
none. Chunk +7.46 kB raw, +1.91 kB gzip.

---

## [0.22.0] — 2026-07-31

Three absences closed, all of them things the renderer simply did not do.

### Surfaces respond to the light

v0.21.0 put the sun at 8.4°, and the procedural textures were **albedo only** —
no normal or roughness map anywhere in the project. Every surface answered that
raking light exactly as a painted plane would, which is why the city still read
flat after the light was right. Dramatic lighting on unresponsive surfaces is
half a feature.

Normals and roughness are now derived from the same noise the albedo already
used: **64 KiB** of storage including mips, 1.84 kB of bundle. Box edges are
chamfered so they catch a highlight without reading as rounded — 117,856 added
triangles on `high` and `ultra`, none below.

### Water reflects

Nothing in the scene reflected anything: no `Reflector`, and the water had no
reflect or refract term. Water now takes a planar reflection at quarter to half
resolution, blurred from **1.3 to 5.2 texels over 26 to 240 m** at roughness
0.74, so it reads wet rather than mirrored — a mirror-sharp surface looks like a
bug.

It stays transparent enough that the buffer pool tiles beneath remain legible.
That deck is a data display before it is a scene, and legibility wins.

### The sky is scattering, not a ramp

It was a gradient dome with a sun drawn into it. It is now Rayleigh and Mie
scattering, which at a low sun produces the warm horizon band and deepening
zenith that a hand-tuned ramp only approximates. Because the environment map is
prefiltered from the sky, **every glossy surface improved with it for free**.

`low` and `reduced` keep the gradient deliberately. Night and the starfield are
unchanged, and all 45 semantic colour pairs still pass the distance threshold.

Cost: one extra quarter-to-half resolution pass for reflections, none for
scattering. Chunk 1,262.80 → 1,273.80 kB.

---

## [0.21.0] — 2026-07-30

### Daylight commits to an hour

Two previous graphics passes specified techniques — environment lighting, ambient
occlusion, procedural textures — and both were competently done and visually
quiet. Techniques do not produce a look. This one specifies a look.

**The sun is now at 8.4°**, giving 6.81 metres of shadow run per metre of height.
The plaza carries long directional bands, buildings cast across each other, and
a warm `#ffc47d` key is opposed by a genuinely cool hemisphere, ground bounce and
fill — so faces split warm against blue shade rather than tinting orange. Clouds
take the same light: warm sunward edges, blue-grey bodies.

**Aerial perspective** runs from 264 m to 1,897 m, so the far side of an 830 m
city sits about 35% into the haze. Distance now reads as distance, which is the
strongest depth cue available and was entirely absent.

**A colour grade** — lift 0.008, gamma 0.96, gain 1.035, midtone saturation 1.07,
vignette 0.075 — fused into the existing output pass rather than added as another
one.

**Silhouette detail**: build-time roof discovery adds instanced plant housings,
vents, masts, varied parapets and railings, budgeted 0 / 0 / 18 / 34 / 48 roofs
from `low` through `ultra`. A textured box still reads as a box against a bright
sky; an interrupted outline does not.

**Every semantic colour survives.** All ten meanings were measured before and
after the grade and all 45 pairs remain distinguishable, the closest margin being
lock red against dirty-page red at 0.0666. A grade that costs a colour its
identity would be wrong however good it looked.

Night is untouched — it already had a point of view. Frame cost: `low` one fused
fullscreen draw, `reduced` none, `medium` five instanced draws, `high`/`ultra`
twelve. Chunk +6.84 kB.

### No wireframes follow the crosshair on foot

The picker drew hover as line segments and nothing in it gated on walk mode, so
in first person — where the pointer is locked to screen centre — it painted a
wireframe on whatever the walker faced, continuously. In orbit the highlight
answers "this one" because someone pointed at it. On foot nobody pointed at
anything, so it was answering a question that was never asked.

---

## [0.20.0] — 2026-07-30

### Buildings are solid. This time the diagnosis was right.

Two previous releases fixed real collision bugs and the city was still walkable
through. The third attempt found why, and it was neither of the obvious answers.

The spatial grid was innocent — every box was already inserted into every cell it
overlapped, and the solver already queried the whole swept segment.

**A compound building was one loose bounding box containing its walls, its
protrusions, and the valid standing space between them.** The solver deliberately
skips any collider the walker starts inside, so that nobody can be trapped in a
box. So the grid returned the building and the solver ignored it — including the
visible wall inside it. The larger and more compound the building, the worse it
was, which is why it read as "many buildings".

The coverage test could not see this because it asked whether *any collider
overlapped a mesh*. That was true. It was ignored at runtime. Existence and
reachability are different properties, and the tests now assert the second.

Compound roots and instanced batches are decomposed into tight per-child boxes at
build time. Colliders **1,821 → 3,982**. The per-frame path is unchanged and still
allocates nothing.

### A street is not a map legend

Standing in first person showed twelve district chips across the sky at full
size, naming districts a kilometre away — wayfinding labels for an orbit map,
leaking into a view where you are a person standing in a street. Walk mode now has
its own policy. Orbit is untouched.

### The autovacuum lever can be found

It was reachable all along: the 7.5 m operating radius was fine and the prompt had
good contrast. It was simply **invisible** — a 6.42 m cabinet with a small caption
standing next to a 41 m launcher, with no cue whatsoever until you were already in
range. A 13 m illuminated control header now reads from **53.5 m**, "Approach the
lever" appears at 28 m, and activation stays at 7.5 m.

### Ground that reads as a material, and a sky with weather

The previous graphics pass added environment lighting and ambient occlusion to a
scene whose largest surface was an untextured grey plane — correct techniques,
wrong bottleneck.

Procedural textures, generated in code with no image files, give the ground and
building faces a material and a sense of scale: **16 KiB of source data, 2.4–5.2 ms
at boot**. The clouds that already existed are now actually visible. Day mode has a
committed value hierarchy instead of pale on pale.

Clouds cost **+2.8 ms per frame** under software rendering — 0.8%, below the run's
own baseline drift. The chunk grew 2.08 kB, because procedural texture costs code
rather than bytes.

### A door that opens, and a body that exists

The postmaster door is where a reader crosses from outside the system to inside
it, and that crossing was instant and unmarked. It now reads as an entrance and
animates open, respecting `prefers-reduced-motion`. First person had a floating
camera; it now has a body, driven from the existing gait state.

---

## [0.19.0] — 2026-07-30

### Environment lighting and ambient occlusion

Two techniques were entirely absent. `scene.environment` was never set and there
was no `PMREMGenerator` anywhere, so the gloss, glass and metal the cel shader
already computes had nothing to reflect. And there was no ambient occlusion of
any kind, which is why geometry read as slightly floating.

The sky is now prefiltered into an environment map, regenerated when the theme
changes rather than per frame. GTAO grounds geometry where surfaces meet. Shadows
go to 1536² with a softer penumbra.

Tiered so `low` and `reduced` are unchanged. The semantic colours were checked
and still read: dirty-page red and lock red stay distinguishable, and maintenance
violet does not converge with shared-memory indigo.

**Honest note on the payoff.** Matched before/after pairs — identical camera,
identical simulated time, UI animation hidden on both sides — show a real but
modest difference. Close and dense views gain grounding; wide and phone views
change little. This is a correct foundation rather than a transformation, and the
remaining gap against comparable browser work is art direction — palette, value
contrast, atmosphere — not more render passes.

### The screenshot driver stops leaking browser profiles

Every verification run created a Chrome user-data directory keyed on its port and
never removed it. **106 accumulated to 8.6 GB**, took the host to 99% disk with
swap fully exhausted, and killed two agents' in-flight work.

Profiles are now removed on exit including signals — a killed run was the common
case — and stale ones are reaped by age on startup, following the concurrency
gate's existing pattern. A live run's profile is never touched, and an explicitly
supplied `CDP_PROFILE` is left alone, since a caller that named the directory owns
its lifetime.

---

## [0.18.0] — 2026-07-29

### The continuity quarter gets behaviour

`archiveGate`, `objectStore`, `backupVault`, `recoveryPad`, `restoreWinch` and
`timelineYard` have been standing since they were built — buildings without
mechanisms. They now do what they are named for.

Modelled on **pgBackRest**, with **WAL-G** named as an alternative and its
differing commands and deletion model identified rather than implied to be the
same:

- Timed full backups that wait for the stop WAL to archive before completing.
- An archive queue with retries — and **a stalled archive is reachable as a
  failure**, which is the most common real backup incident. At 5,000 tps it
  queued 28 segments, reached 512 MiB of `pg_wal` in 137 seconds, and then
  rejected 51,194 writes. The city rejects writes where a real server can PANIC
  as the WAL filesystem fills, and says so rather than implying otherwise.
- Count-based retention, which is what makes a recovery window finite. Asking to
  restore to a target older than the oldest retained backup fails with a reason
  you can act on.
- Point-in-time recovery that fetches a retained backup and replays WAL forward
  to a target, without promoting.

**Backup age is visibly a cost, not a number in a panel.** Taking the age from
19.0 s to 57.6 s took WAL replay from 41.0 to 88.9 MiB. That relationship is the
whole reason backup frequency is a decision.

The lesson the rest of the project could not carry: **backups and replication are
different things, and one is not a substitute for the other.** A replica applies
`DELETE FROM accounts` faithfully and instantly.

Patroni, promotion and failover are deliberately absent — those are the second
half of roadmap item 1 and item 3. The high-availability buildings remain visible
and explicitly inert.

Scaled rates are disclosed rather than implied: 384 MiB/s backup, 640 MiB/s
restore, 24 MiB/s replay, and an illustrative 65% repository compression.

---

## [0.17.0] — 2026-07-29

### Something in the city you can operate

The autovacuum yard has a lever. Walk up to it in first person, press `E`, and
autovacuum turns off — the lever reverses, a red lamp lights, and the vacuum
trucks stop launching. Workers already mid-cycle are described as finishing,
because that is what really happens.

It is the same knob as the control rail's, in both directions. There is one
walk-up interaction vocabulary shared with the postmaster tower's door, not two.

**The rate at which bloat accrues was not changed to make the lever feel
responsive.** Bloat follows write volume — that is a fact about PostgreSQL and one
of the better lessons available here, and faking it would have been exactly the
kind of persuasive falsehood the knob audit existed to prevent. Instead the lever
says so: it teaches that bloat follows writes and will appear slowly at the
current workload, and offers a control that takes you straight to the write rate.
Raise it and watch.

Measured: under hard writes, ten simulated minutes with autovacuum off takes
`sessions` past 10% bloat and grows it by thousands of pages, while append-only
`events` correctly stays at zero. Re-enabled, workers launch within fifteen
simulated seconds and dead tuples fall — but relation pages do not shrink back,
because vacuum does not return space to the filesystem.

---

## [0.16.0] — 2026-07-29

### The simulation stops lying about the last of its knobs

`KNOB-AUDIT.md` graded ten of twenty-three knobs WRONG. The two worst were fixed
in 0.13.0; these are the remaining four root causes, and they close the audit.

- **A backend paid nothing for evicting a dirty buffer**, so the background
  writer had cost and no benefit and neither `bgwriter` knob could show what it
  is for. Backend writes now fall from 129.0 to 76.0 per second when the writer
  runs. `bgwriter_lru_maxpages` at 100 and at 400 were previously identical;
  they now clean 28.4 and 54.2 pages per second.
- **`wal_buffers` was a 256 KiB constant.** It now follows PostgreSQL's rule —
  `shared_buffers/32`, floored at 64 kB, capped at one WAL segment.
- **Two disclosed time constants disagreed with each other.** The wording now
  consistently says one-way delay, across the observability paths, the panel
  content and the storage documentation.
- **`checkpoint_timeout` could not amortise full-page images** — the whole lesson
  of the setting. The write set had no repeating middle band, so pages were never
  re-touched within a checkpoint cycle. Scaled hot, warm and cold bands at
  60/35/5 make the amortisation visible: raising the timeout from 15 s to 120 s
  now moves estimated full-page images from 867 to 425 KiB/s, where before it
  barely moved from 699 to 612.

Every figure here was measured against the model with a seeded RNG and a warm-up,
then re-measured on the way back down to check recovery — including the cases
where recovery is legitimately asymmetric and a symmetry assertion would be wrong.

---

## [0.15.0] — 2026-07-29

### The machine room has a name and gives credit

The page was called **The Update Works** — a pun on *works* as in gasworks or
waterworks, the plant where `UPDATE`s get processed. Nobody parsed it. It is now
**The Machine**, which is what the roadmap has called it all along and what pairs
with the city.

**PGlite is credited where the claim is made.** The page's whole proposition is
that half its numbers come from a real PostgreSQL, and it named PGlite only as a
bare label. It now credits PGlite by ElectricSQL beside that claim, links
`pglite.dev` and the source repository, and says what PGlite actually is —
PostgreSQL compiled to WebAssembly, not a reimplementation — which is the honest
reason its measurements can be trusted.

The Legal disclosure mirrors `NOTICE`, including Electric DB Limited and
Apache-2.0. The Query flow carries the same credit. Links only: nothing is
fetched from an external host.

---

## [0.14.0] — 2026-07-29

Watching the machine at your own pace, and typing into it on a phone.

### Speed control

The only time control in the machine room was binary `PAUSE` / `RUN` against a
fixed 36 s clock, so a reader who wanted to follow a mechanism could freeze it
or keep up. There is now a rate control.

**Rate is a viewing speed, not a change to the model.** The modelled periods and
the values measured by PostgreSQL are identical at every setting — the same
statement reports 3 shared hits, 0 reads, 0.1 ms planning, 0.2 ms execution and
an Index Scan whether you watch it at a quarter speed or five times over. At 5x
the full 36 s clock takes 7.2 wall seconds.

### Typing SQL on a phone no longer hides the machine

iOS Safari zooms the page whenever a focused input computes below 16 px. The
terminal inherited the console's smaller monospace sizing, so tapping the prompt
scaled the page and pushed the board off screen entirely. The field now computes
to 16 px and the visual viewport stays at scale 1 on focus.

No viewport zoom restriction was added. It would have appeared to fix this while
disabling the reader's own zoom and fighting the board's pinch gesture.

**Submitting a statement is a request to watch something happen**, so on a phone
Enter now moves focus to the board and collapses the terminal. An error is the
exception — it refocuses and expands the terminal, because an error belongs
where it can be read.

### And the two of them together

The rate control and the collapsing terminal were verified independently and
never in combination. Together, the speed cluster took 39% of the width of a
390 px rack and its touch targets protruded past it. Landscape now reserves a
toolbar area with real clearance from the board controls.

---

## [0.13.0] — 2026-07-29

The city stops letting you walk through it, the machine room becomes something
you can operate on a phone, and the simulation stops rewarding a bad habit.

### The machine room is a place you can go

Published at `machine/`, linked from the city and from Diagnose, with its own
identity in a browser tab.

- **A statement now visibly causes what follows.** The architecture pane used to
  run on free-running rhythms and never read the query at all — the left half
  executed real PostgreSQL while the right half animated beside it. A submitted
  statement now traces the board: client, the process pipeline, the shared memory
  segment, the buffer pool, and back, with ambient work dimmed while it runs.
- **Half the numbers are measured.** Buffer counts and timings come from
  `EXPLAIN (ANALYZE, BUFFERS)`. An index lookup reports 3 shared hits; an
  aggregate reports 102. Measured values carry `P`, modelled ones carry `M`.
- **It works on a phone.** The board no longer tries to fit — it renders where
  its type is legible, 9.25 device pixels at the smallest label, and follows the
  active stage so the reader is carried along the route without touching
  anything.
- **Pinch, drag, double-tap and wheel.** Continuous zoom from fit to 2.3x. Any
  manual gesture hands control back from stage-following, and one control
  returns it.

### You can no longer walk through the city

- **Collision resolved each axis independently**, so a fast oblique move could
  pass through a thin wall between samples and an inside corner could be
  squeezed through. It now sweeps the movement segment against each box
  continuously.
- Three specific surfaces were passable: the replication cable bundle, the
  elevated query lab's floor and posts, and a painted route blocked by an
  invisible selection proxy.
- A scene-graph coverage test enumerates every visible human-scale mesh in reach
  and asserts a collider covers it — and the reverse, that nothing is solid where
  nothing is visible.

### The simulation stops teaching two falsehoods

A measured audit of all 23 knobs (`KNOB-AUDIT.md`) graded 13 correct and 10
wrong. Two shared root causes behind most of them are fixed.

- **Turning autovacuum off was rewarded with roughly 2x throughput.** Vacuum
  charged a full-page image for every page it touched and nothing modelled
  cost-based throttling, so three workers consumed the entire device budget.
  This was also the true cause of WAL staying hot for twenty simulated minutes
  after a load drop.
- **`wal_level = minimal` froze replication mid-flight** and then drifted,
  reporting 4.92 GiB of pg_wal against a 256 MiB `max_wal_size` and 4,800 MiB
  held by a logical slot — when logical decoding is impossible at that level. The
  same gating let a standby that does not exist pin the primary's xmin horizon.

Anti-wraparound vacuum is still unmodelled and is now disclosed rather than
implied away.

### The control center

The postmaster is the supervisor that owns the cluster, so it is the city hall.
Enter it in first person and find a map of this city, a psql prompt, and your
statement tracing across both the map and the districts visible through the
windows. The map is the city's own topology — a differently-shaped diagram
inside it would teach that the geography is arbitrary.

### Labels and chrome

- Label scale ran from 1.0 to 1.12, and to 1.06 on a phone — a range too small
  to perceive, so labels never appeared to scale at all. Now 1.50 to 1.00, with
  chips retiring past roughly 690 m rather than clamping at the legibility floor.
  A zoomed-out phone view keeps three district names at 1.9% of the frame.
- The checkpoint indicator painted through the PGSimCity wordmark. It was grid
  overflow, not a stacking order problem.

---

## [0.12.0] — 2026-07-28

psql on the left, PostgreSQL's architecture on the right.

### Changed

- **The machine board is the layout it should always have been**: one screen,
  a real psql workbench on the left, the architecture on the right. The previous
  version was machine parts arranged on a floor — the Opus Magnum aesthetic
  applied to a layout rather than to a structure — with a textarea and a Run
  button standing in for a CLI.

  The right half now draws **structure instead of arrangement**: one shared
  memory segment as a real container holding the buffer pool, wal_buffers, the
  ProcArray, the lock table and pg_xact, with backend private memory drawn
  deliberately outside it. The postmaster forks backends, the client the query
  arrives from is present, and the layers run client → processes → shared memory
  → kernel → disk. Cover every label and the containment is still legible, which
  is the test the earlier version failed.

  The left half is a prompt you type into, with history on the arrow keys, real
  PostgreSQL error text, and the backslash commands that can be answered
  honestly from the real catalogs.

  The machine language, the rhythm strip and the arm reach following real buffer
  counters are unchanged — those were right.

---

## [0.11.0] — 2026-07-28

A machine view of a transaction, half of it real.

### Added

- **`machine/` — the shop floor.** The observability flow view was a
  pipeline of boxes: order, and nothing else. This is the same subject in the
  visual language of Zachtronics' *Opus Magnum* — axonometric, every element a
  machine part with a visible pivot, and the whole cast on one floor.

  **The rhythm is the lesson**, and it is explicit: one shared 36-second clock
  with the walwriter at 3s, backends at 6s, the walsender at 9s, the bgwriter at
  12s, autovacuum at 18s and the checkpointer at 36s, on a strip labelled top is
  fast and continuous, bottom is rare and heavy. A viewer can see that the
  checkpointer is slow and periodic while backends are frantic, and that
  autovacuum is off doing something unrelated to the query in front of them —
  relationships the city teaches through geography and a pipeline cannot express.

  **Half of it is real.** PGlite supplies what only PostgreSQL can: the parse, so
  a typo is a genuine error; the plan, with real node types, costs and estimates
  against actuals; the catalogs; the results. The model supplies the interior and
  everything concurrent, which a single-connection engine cannot produce. They
  meet where it matters — `EXPLAIN` reports `shared hit=26 read=0` and the arm
  makes the short reach, so the board's central claim stopped being an assertion
  and became a measurement. Which components are real and which are modelled is
  marked, because with a single connection most of them cannot be real.

### Fixed

- **Labels no longer take over the screen on a phone** ([#4](https://github.com/NikolayS/PGSimCity/issues/4)).
  They were DOM elements at a fixed pixel size, so zooming out shrank the model
  and not the text — a single chip was about 44% of a 390px viewport. The v0.9.0
  detail tiering reduced how much text appeared but not how large it was, so the
  problem returned at distance. Label area is now budgeted as a fraction of the
  viewport at any camera distance and any screen size: a promise that can be
  tested rather than an improvement that can be argued about.

---

## [0.10.1] — 2026-07-28

### Fixed

- **The README was duplicated by a bad merge.** A restructuring branch was
  merged into a main that had moved, and git produced both orderings rather than
  one — `Controls`, `Camera`, `A possible future` and `Run it` each appeared
  twice, and the file grew from 267 lines to 334. That was the README of a
  tagged release. Deduplicated to 227 lines, keeping whichever copy held current
  facts: the camera table now says shift-left-drag orbits and right-click opens
  the context menu, which has been true since v0.6.0 and was still documented
  wrongly in one of the surviving copies.
- **The reordering that was asked for is applied.** What you are looking at and
  what to try now come before build instructions and the analytics disclosure,
  because almost nobody arriving from a link runs it locally. The
  model-not-emulator point is made once rather than three times.

---

## [0.10.0] — 2026-07-28

Real PostgreSQL behind the query surface, and a 2D view that draws the
architecture rather than a row of boxes.

### Added

- **Real PostgreSQL, opt-in.** A running server exposes catalogs, `pg_stat_*`
  counters, `EXPLAIN` and log output — and nothing else. Not the clock sweep
  choosing a victim frame, not a page landing in a specific buffer, not the
  checkpointer's write phase. Those are exactly what this project draws, so
  neither source alone is enough. PGlite now supplies what only it can: real
  parsing, so a typo produces a genuine PostgreSQL error; the **real plan**,
  with true node types, costs, estimates against actuals and real buffer
  counters; real catalogs; real results. The model keeps supplying the interior.
  They meet at the plan — the real one drives the animation. It is lazy and
  opt-in, so the city's bundle is unchanged, and which numbers are real and
  which are modelled is visible at a glance, because that distinction is the
  entire reason for adding it.
- **The 2D view draws architecture now.** The first version was a pipeline: a
  line of stops with the current one lit, which communicates order and nothing
  else. Following the conventions of Momjian's internals diagrams and Lesovsky's
  observability map, it now has containment — one shared segment visibly holding
  the buffer pool, wal_buffers, the ProcArray and the lock table, with private
  backend memory visibly outside it — connections with direction, layers where
  the axis means something, and the query path animating across the structure
  rather than replacing it.

### Fixed

- **Analytics were never being received.** The deployed integration was
  Plausible's older form while the account issues the current one, where the site
  identity is embedded in the script filename. The script was serving correctly
  and the account was looking for something else.
- **The controls table had been wrong for three releases.** It said right-drag
  orbits; right-drag was freed for the context menu in v0.6.0 and rotation is
  shift with left-drag. Someone asked how to rotate the camera on Hacker News,
  and this table is what they would have found.
- **Overlays no longer print on top of the inspector on a phone.** Two elements
  shared a z-index with the drawer, so paint order was decided by document order
  rather than intent. z-index is a named scale now.

### Removed

- Plausible dashboard setup steps from the README. That is a one-time task for
  one person's account, not documentation, and it is GitHub issue #3 now.

---

## [0.9.0] — 2026-07-28

The city reached the top of Hacker News. This is what the thread asked for.

### Added

- **A 2D query lifecycle view**, at `observability/`. The city answers what
  PostgreSQL is made of and the 3D trace answers what happens when you run
  something — but a camera can only point at one place at a time. This shows the
  whole journey at once, from client to commit, with your position marked and
  the stops a statement skips struck through rather than hidden. The plan tree is
  finally drawn as a tree: `BackendSim.plan` has carried per-node rows, cost and
  timing since the beginning with nothing rendering it. SVG rather than canvas,
  so a keyboard and a screen reader can follow it.
- **Measurement.** The largest traffic event in this project's history was
  invisible. Cookieless, no consent banner, no fingerprinting, no personal data —
  aggregate counts plus outbound clicks tagged by the panel they came from.

### Fixed

- **WAL responds to the workload again.** Watching the city at one transaction
  per second showed the `wal_buffers` ring racing. Two defects: the buffer filled
  under load and never drained once demand stopped, and ten times the transaction
  rate produced only 1.4 times the WAL. That second one broke the causal chain
  the city exists to teach, since write volume is what drives checkpoint
  frequency. Three rounds of expert review missed both, because both are visible
  only when something *changes*.
- **The tour stops burying the city.** Three people said so independently.
  Measuring showed the narration card was not the problem — a scrim draining
  contrast from the whole scene was, along with spotlight cones rendering as flat
  diagonal slabs at the quality tier most visitors get. Attention is directed
  additively now: the target is marked and everything else is left alone.

### Changed

- The dependency rule said "no telemetry, no analytics". It was written against
  surveillance rather than measurement, so it now states what is actually true
  instead of a blanket denial the software no longer honours.

---

## [0.8.0] — 2026-07-27

### Added

- **The trademark notice.** PGSimCity is an independent, non-commercial
  educational visualization of PostgreSQL internals, not affiliated with,
  sponsored, endorsed or approved by Electronic Arts Inc., and SimCity is a
  trademark of Electronic Arts Inc. The notice appears on the loading screen,
  near the top of the README, in the help surface, and in a footer reachable
  from every screen including the observability page. The claim that this
  project contains no SimCity code, assets, artwork, logos, characters, audio or
  game content was added only after auditing for it — the favicon and boot mark
  are hand-authored SVG, the audio engine synthesises everything and ships no
  files, and the only traced artwork here is the PostgreSQL logo, a different
  trademark already disclaimed in `NOTICE`.
- **Row versions.** MVCC is what most reliably surprises someone arriving from
  another database, and it was modelled without being shown at the level where
  it teaches: dead tuples accumulated and vacuum removed them, but nothing said
  why. You can now see an UPDATE write a second copy of a row, two transactions
  looking at the same row and seeing different versions of it, and the old
  version becoming collectable only once the horizon passes it.

### Changed

- **The tour waits for you.** Chapters advanced on a clock, whether or not you
  had finished reading — and at 60 to 110 words each, anyone who stopped to look
  at the thing being described lost their place. They now advance when you do,
  auto-play is opt-in, and the card says which chapter of fourteen you are on.

---

## [0.7.2] — 2026-07-27

### Fixed

- **At full zoom the city now tells you what you are looking at.** v0.7.1 stopped
  the camera dollying inside the buildings, and that held. But what replaced the
  blank frame was a wall of buffer-pool tiles with nothing naming them —
  legible only to someone who already knew that was `shared_buffers` at page
  scale. The literal blank was gone and the disorientation was not, which is
  plausibly what the original reporter experienced. Close range now identifies
  what fills the view and registers itself as a mode with a documented way back.
- **One camera distance floor instead of two.** `MIN_DOLLY_DIST` guarded the
  wheel at 24 while `MIN_DIST` let six other paths reach 8, and the measured
  blank range starts near 16 — so the shipped fix held only because nothing
  happened to point the camera that close. A test guarded it from the outside;
  now a single constant means the mistake cannot be written.

---

## [0.7.1] — 2026-07-27

Two things a stranger hit within minutes of arriving.

### Fixed

- **The screen no longer goes blank when you zoom in.** Reported from Hacker
  News: "the site is going blank sometimes if I zoom in a bit too much."
  Reproduced by sweeping the camera through its dolly range and reading every
  frame — from 16 units inward the readable city disappears, and at 12 and 8
  units the canvas is a near-flat ground or roof surface. The camera was being
  allowed to dolly inside the buildings it was looking at, so every surface in
  frame was back-faced and there was nothing to see, with no indication of what
  had happened or how to get back out.
- **The rotate gesture is discoverable.** Someone asked "How to rotate camera?"
  — the controls follow the Google Maps convention, where left-drag pans and
  shift with left-drag rotates, which is a good scheme that nobody could find.
  That was the sixth time in this project that something has been built, wired
  and left invisible, so the hint now appears where the gesture is being
  attempted rather than in the help overlay where the previous five already
  were.

---

## [0.7.0] — 2026-07-27

You can walk into the buildings, the clock sweep finally evicts, and one query
can be followed across the whole city.

### Fixed

- **Buildings are solid.** Nine of the city's landmarks could be walked straight
  through. The collision builder classifies an oversized mesh as needing a split
  and then recurses into its children — and a district that merges its whole
  structure into one geometry has no children, so the loop was empty and nothing
  was ever added. Thirty-three oversized meshes were being silently discarded,
  including the standby, the recovery ground, the backup vault, the WAL vault
  and the disk array. A collision query along the line the walker took agreed
  with him: there was no building there. Merged meshes are now split by their
  own triangles. Collider count went from 765 to 989.
- **Slopes work.** There were no surface normals anywhere in the collision code
  and no maximum-slope rule, only a fixed tolerance — which made the climb limit
  a function of speed: about 52 degrees at a run and 74 at a walk, and nothing
  ever slid.
- **The buffer pool now behaves like a cache.** The five demo relations totalled
  98 MiB while the `shared_buffers` slider starts at 128 MiB, so the smallest
  pool a user could pick was already bigger than the whole database. Every
  slider position gave an identical sample, the clock sweep never evicted
  anything, no backend ever wrote a victim page, and the `no-bgwriter` scenario
  produced nothing at all. The working set is now larger, and the access skew is
  tuned so the hot set still fits: **98.9% hit ratio with 7,602 evictions**,
  which is what a real server looks like.
- **The labels stopped covering the city.** Roles were told to stop truncating,
  which was right on its own, but in aggregate every label then rendered name,
  role and readout at every zoom — fifteen at once obscured more than the side
  panels ever had. Detail follows attention now.
- **Every mode has a visible way out.** The observability page's only exit was a
  tooltip on the wordmark, which does not exist on touch. A test now enumerates
  the modes and asserts each has a reachable exit control, not merely a key
  binding.

### Added

- **Trace a query.** Pick a statement and follow it from the client terminal
  through parse, plan, buffer reads, WAL and commit, narrated by the
  transaction's own state machine rather than a script. Three people asked for
  this independently, and a fourth said "even at 0.1x it is too quick — I should
  be able to fire individual transactions and watch them flow", which is why it
  has a step mode.
- **The version and build hash** are on screen, so a bug report can say which
  build it came from.

### Changed

- **The sample-versus-pool mistake is now unwritable.** A reviewer found
  thirteen readouts whose label made a claim their computation did not satisfy —
  a pool figure computed from the visualisation sample — after four had already
  been fixed one at a time. The sample-scale counters now carry a nominal type
  and the compiler rejects the mistake, with contract tests that assert a
  readout named for the pool actually moves when the pool moves.

---

## [0.6.0] — 2026-07-27

Hacker News arrived, said the panels were in the way, and was right.

### Fixed

- **The city gets the screen back.** Four commenters said the same thing
  independently — "eighty percent of the visual space is popups that completely
  block it", "remove ~50% of the UI blocking the view", "on mobile especially".
  Measured, they were right: at 1280 px the two side panels took 743 px and left
  a ~540 px strip that the minimap covered further. They now start collapsed,
  and the choice is remembered.
- **The guided tour is findable.** Two people asked for a narrated walkthrough
  that already existed and a third had to tell them so. That is a
  discoverability failure, not a missing feature. It is now an obvious first
  action rather than a keyboard shortcut behind a caution triangle.
- **The flicker was z-fighting**, correctly diagnosed by a commenter — coplanar
  ground surfaces, now separated with documented offsets.
- **Swimming involves water.** The swim volume began at deck level, so anywhere
  inside the tile field the walker was flagged as swimming while standing on
  solid floor: feet planted, never sinking, never crossing a surface. The entry
  splash fired once and then nothing ever happened again.
- **The sample stops calling itself the pool.** The plaza's 1,024 tiles are a
  sample of `shared_buffers`; several readouts multiplied that frame count by
  8 KiB and called the result the pool, so one panel could say "2.0 GiB pool"
  and "BUFFER POOL 8.0 MiB of 8.0 MiB" in consecutive lines.

### Known issues

- The declared working set is ~98 MiB while the `shared_buffers` slider starts
  at 128 MiB, so every reachable setting saturates the sampled pool. The clock
  sweep therefore never evicts and no backend ever writes a victim page. Being
  fixed by enlarging the relations.
- Buildings are not yet solid to a walker in first person.
- Touch controls have been verified only in Chrome's mobile emulation.

---

## [0.5.0] — 2026-07-26

Daylight arrives, and the city stops going dark on ordinary hardware.

### Fixed

- **The city no longer goes black when the frame rate drops.** A user sent two
  screenshots side by side: a vivid city at `medium` quality, and near-black
  silhouettes on the same build. The night theme's whole visual language rides
  on the bloom pass — structure is matte, meaning is neon, and only emissive
  above 1.0 crosses the threshold — so turning bloom off did not dim the city,
  it stopped it communicating. And it was automatic, which meant the people who
  saw it were those on the weakest hardware. Bloom is now the **last** thing
  dropped: a new `reduced` tier turns down pixel ratio, particles, labels and
  antialiasing while keeping the lighting, and measures about 40% faster than
  `medium`. Below that, neon repaints as saturated base colour with a minimum
  luminance, so a dirty page still reads as dirty.
- **The quality downgrade no longer fires on a boot stall.** Three seconds
  ignored, a four-second settle, then three sustained seconds under the floor.
  The notice now names what was lost and offers one click to undo it.
- **Labels no longer draw through solid buildings.** They are DOM elements
  positioned by `CSS2DRenderer`, so they never took part in depth testing; a
  label behind a tower had always drawn over it. They are now occluded by
  raycasting against the collision structure the walker already maintains,
  amortised across frames and faded rather than snapped.
- **`$PGDATA` is gone from the user-facing text.** It names an environment
  variable, and in a configuration where it points at a config-only directory
  the data lives elsewhere. The excavation is the **data directory**. A test
  holds the line — and immediately caught a regression that a later merge
  reintroduced.

### Added

- **A daylight theme for the city, not just the panels.** Day mode used to stop
  at the edge of the UI: paper panels over a city still lit for night. It is now
  a sunlit architectural model — flat saturated colour with a hard
  split between the lit and shaded faces of every mass, a warm directional sun
  casting real shadows from 172 architectural casters (about 4% of frame time,
  with the buffer field excluded because its heights change every frame), light
  ground the city sits on top of, and **districts wearing their semantic colours
  as zones** so the layout can be read from altitude before a single label.
  Night's rule is structure matte, meaning neon; day's is structure sunlit,
  meaning saturated. The colours keep their meanings exactly.
- **A visible theme switcher.** Daylight was toggled by pressing `N` and by
  nothing else — undiscoverable on a desktop and unreachable on a phone.
- **Google Maps mouse convention.** Left-drag pans, shift-left-drag rotates and
  tilts, and right-click is freed for a **context menu** that offers what the
  thing under the cursor actually supports — including opening the page anatomy
  view directly from a heap file or an index, which is a better home for it than
  any panel. Touch is unchanged.
- **`CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`.** Every rule carries the
  reason it exists, because a rule without one gets dropped the first time it is
  inconvenient. Red/green TDD is mandatory and CI fails the build on a red test.

### Known issues

- Cache hit ratio settles near 87% where a healthy production system sits at
  98–99%.
- The touch controls have been verified only in Chrome's mobile emulation, which
  differs from iOS Safari in touch handling and viewport units.

---

## [0.4.0] — 2026-07-26

The buildings start telling the truth, and the elephant comes back.

### Fixed — the geometry

The prose in this city had been through two rounds of expert review. The
geometry had been through none. A geometry-truth audit — four PostgreSQL
specialists auditing buildings, adjacencies, animations and scale as *claims*
rather than reading the text beside them — found the city contradicting its own
documentation in places where a reader would believe the building.

- **The xmin horizon blade floated above every active backend.** It was computed
  independently of the PGPROC pillars it cuts through, so fourteen backends
  could all sit below the "oldest transaction ID anyone can still see" plane —
  arithmetically impossible, and an inversion of the single lesson that
  structure exists to teach.
- **The OS page cache was drawn inside the excavation**, below a line the city's
  own signage says separates memory from durable storage. It is volatile kernel
  memory outside PostgreSQL's address space. `pg_wal` broke the same line in the
  other direction — printed on the pit floor as a data-directory subdirectory
  while built as a surface vault outside the cut.
- **`archive_command` was built twice**, with archived WAL parked in two stores
  in series, teaching a two-stage archive pipeline PostgreSQL does not have.
- **TOAST sliced before it compressed.** PostgreSQL compresses first and slices
  only what still does not fit.
- **Index maintenance flew from the index into the heap**, and the
  buffer-mapping probe ran backwards.
- **The LSN ruler displayed an equation its own rows failed to satisfy** — the
  lag bar spanned standby-flush→replay while the byte count beside it was
  computed from primary-flush→replay.
- **Cumulative statistics was a rolling sixty-bar time series.** PostgreSQL
  keeps monotonic counters and no history whatsoever.

### Fixed — the plate

- **The Slonik plate is the real mark again.** v0.3.0 built the outline from the
  blue fill path of the genuine PostgreSQL SVG. The commit that followed it —
  titled "trace the plate from the real PostgreSQL logo artwork" — replaced that
  vector data with hand-authored control points, which is the opposite of what
  its message claims. Four later passes then edited the hand drawing, each
  widening it slightly to satisfy the containment audit, until the trunk was 3%
  of the plate's height and the silhouette was a rounded blob. The vector data
  is restored: front-on head, both ears, both tusks, trunk down the centreline.

### Added

- **Sound.** The audio engine had existed for some time as 505 lines that
  nothing imported. It is now driven from the walk controller, so footstep
  cadence comes from distance travelled and surfaces are read from what the
  collision layer says is underfoot. Off by default.
- **Swimming in the buffer pool (`shared_buffers`).** The plaza is 1,024 page
  frames whose height is their clock-sweep `usage_count` and whose colour is
  their state. You can now be inside it, at the scale of the pages.
- **Walking and swimming on a phone.** Pointer lock does not exist on iOS
  Safari, so first person was unreachable on mobile. There are now thumb
  controls: a stick that appears where the thumb lands, and look-by-drag with
  sensitivity in degrees per centimetre so it feels the same on any screen.
- **`tools/plot-plate.mjs`** — prints the plate's silhouette, bounding box and
  trunk proportion straight from the source in about two seconds. Five attempts
  at the shape had been judged through a seventy-second software render with the
  side panels covering two thirds of the frame, which is why none of them could
  iterate.
- The page-anatomy and data-directory views now open from where their question
  arises, rather than from a tab strip pinned to a corner.

### Changed

- The panel design drops the coloured accent bars, and then the corner brackets
  that briefly replaced them. Both are generated-interface clichés; the fix was
  to subtract rather than to substitute.

### Known issues

- Cache hit ratio settles near 87% where a healthy production system sits at
  98–99%.
- The plate's containment audit still constrains the silhouette; the shape holds
  the city, and the city was not laid out to be an elephant.
- iOS Safari differs from Chrome's mobile emulation in touch handling and
  viewport units. The touch controls have not been tested on a real device.

---

## [0.3.0] — 2026-07-26

The numbers stop being wrong, and the city stops looking like a night raid.

### Fixed — the simulator

- **Bottlenecks are reachable at last.** A batch controller was silently
  cancelling every constraint in the model: sweeping the workload knob from 1 to
  50,000 tps returned 90–100% of what was offered every time, and breaking
  *everything* at once — 32 buffers, lock contention, no background writer,
  `remote_apply` at 400 ms, no autovacuum — still committed 4,724 transactions a
  second. The causes were all simulated correctly; only the effect was
  unreachable. Achieved throughput now emerges from the model's own limits:
  measured over ten simulated minutes at the shipped defaults, 10 tps offered
  yields **7 achieved**, with nine checkpoints and five autovacuum runs.
- **WAL-triggered checkpoints fire at the right threshold.** PostgreSQL uses
  `max_wal_size / (1 + checkpoint_completion_target)` — about 53% of
  `max_wal_size` at the default — per `CalculateCheckPointSegments()` in
  `xlog.c`. The model used the whole of `max_wal_size`, and the countdown
  estimate carried the same error. Both now call one shared function, so the
  display cannot drift from the behaviour.
- **The cache hit gauge is computed the way `pg_stat_database` computes it** —
  `blks_hit / (blks_hit + blks_read)` — rather than as a time-average of ratios.
  Measured at steady state it reads **87%**, against **57%** before.
- Vacuum is charged WAL and I/O instead of being free theatre; truncation
  returns only trailing empty pages; the autovacuum launcher no longer starves
  large tables behind small hot ones.

### Fixed — the city was telling lies

- **Local memory is part of each backend, not a building beside them.**
  `work_mem`, `maintenance_work_mem` and `temp_buffers` were drawn as one shared
  structure next to the backend row. The prose said "per backend" and the
  geometry said otherwise, and geometry wins: a visitor who correctly reads the
  plaza as "one shared thing every process maps" then meets a second,
  similar-looking memory building and reasonably concludes the wrong thing.
- **`shared_buffers` no longer claims a maximum of 8 MiB.** The slider was
  labelled with the literal tile count, so its ceiling was 1,024 × 8 KiB — a
  size nobody runs. The pool is now sized in realistic units and the 1,024 tiles
  are declared as what they are: *a 1,024-frame sample of the page cache*.
- The plaza is called the **buffer pool**, which is the structure;
  `shared_buffers` is the parameter that sizes it.

### Changed — it no longer reads as an aerial assault

- The walsender was a 49 m transmission tower with a parabolic dish, a feed
  horn, expanding torus pulses launched along the aim vector, and a blinking
  crimson beacon. Under load it read as a muzzle blast. It is now a cable head
  topping out at 16.1 m — the same height as its neighbours.
- The standby's read-only client was a ringed disc at 34 m with a lit beam
  angling down onto the deck. It is a terminal at grade with its read path along
  the ground.
- Nothing was deleted outright; every mechanism was re-housed. The push that
  spawned the torus pulses now advances a ratchet on the replication slot drum,
  one tooth per chunk. The archive backlog strobe became a steady lamp whose
  brightness *is* the queue depth — strictly more informative than a flash,
  since it was previously black except when critical.
- **Forty-three translucent materials** had turned the city to fog with no
  silhouettes. Opacity is now a semantic tier rather than atmosphere.

### Added

- **A daylight theme.** The night model is "structure matte, meaning neon, only
  neon blooms", which inverts under a bright sky — so daylight is toon shading,
  ink lines, bloom off, sun and shadows, with every semantic colour re-derived
  to hold its meaning on a light background.
- **Open a page and read it.** A heap page can be opened to its real layout:
  the header with `pd_lower` and `pd_upper`, the line pointer array growing
  forward with `LP_NORMAL` / `LP_REDIRECT` / `LP_DEAD` distinguished, free space
  in the middle, and tuples growing *backward* from the end — with a tuple
  header opened to `t_xmin`, `t_xmax` and `t_ctid`, where MVCC visibility
  actually lives. The data directory gets the same treatment.
- **Walk mode has a floor.** It believed it was standing on something 76 m in
  the air, which is why it felt like flying. Plus procedural footstep audio,
  synthesised rather than sampled — no assets, no dependency — with cadence
  driven by distance travelled, so it is correct at every gait and stops dead
  when you stop.
- **Backups, PITR and failover**, sited off the primary as they must be: an
  archive estate with a timeline switchyard where the live timeline is the
  through line and every fork is a siding that never rejoins, a recovery ground
  on separate iron, and an HA quarter with a consensus store holding the lock
  and no user data.
- **Touch works properly** — one finger pans, two fingers pinch to zoom, twist
  to turn and drag to tilt. **Mobile is usable**: worst-case chrome coverage at
  390×844 went from 87.9% of the viewport to 48.9%, horizontal overflow from 26
  elements to none, and touch targets under 44 px from 49 to none.
- Left-drag pans and right-drag orbits — map convention rather than CAD.

### Known issues

- **The cache hit ratio is 87%, not the 98–99% a real OLTP database shows.**
  Much better than the 57% of v0.2.0, and the gauge is now computed correctly,
  but the working set is still sized so the pool cannot dominate it.
- Achieved throughput sits at 70% of offered at the defaults. Some shortfall is
  honest — a real database does not serve everything it is asked — but this has
  not been calibrated against anything.
- The elephant-shaped ground plate is derived from the real logo artwork; judge
  the likeness for yourself from the plan view.
- Mobile is verified in Chrome emulation with touch, not on a real iPhone.

[0.3.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.3.0

---

## [0.2.0] — 2026-07-26

You can walk into it now. Still a prototype, still contains mistakes, and this
release names the ones we know about.

### Added

- **First person.** Press `G` and drop into the city at eye height — walk, run,
  crouch, jump. Collision is derived automatically from the component registry's
  bounding boxes, so every building is solid without per-district authoring.
- **The plaza is reachable on foot.** It was an island: its edge sits 40 m from
  solid ground across the 52 m excavation. Four ramped causeways now cross it at
  1:14, landing in the corridors that are clear of deck furniture, with gates cut
  in the previously continuous railing. Every route was verified by walking a
  capsule through the real collision world in code — 17 of 17 passed, and the
  parapet stops you 0.25 m short of the drop.
- **A descent into the excavation** — seven flights, 301 treads, from the pit rim
  to the data-directory floor. At the bottom, a sign reads *"shared memory is 52 m
  above you"*, and the plaza's pylons are overhead.
- **The continuity quarter**: anchors for base backups, point-in-time recovery
  and failover — an archive estate with a timeline switchyard, a recovery ground
  on separate iron a haul road away, and an HA quarter with a consensus store and
  three lease posts. Geometry follows.
- **A server boundary.** Clients now sit outside a fence with the gatehouse as
  `pg_hba.conf`. Previously the application tier was drawn as a district *of* the
  database, which every canonical Postgres diagram is explicit about.
- Apache 2.0 licence, a `NOTICE` with the PostgreSQL trademark disclaimer, an
  original elephant mark, favicon set and social preview.

### Changed

- **The city no longer reads as an aerial assault.** Clients came down to ground
  level, the replication link stopped arcing to y=46 and became a duct bank at
  grade, the selection marker stopped being four breathing corner brackets — a
  weapons reticle — and became a surveyor's setting-out drawing, and the blinking
  aviation beacons are gone. Red now appears only where it means something
  specific, above all the dirty page.
- **Left-drag pans, right-drag orbits.** Map convention, not CAD convention. Both
  old habits still work via middle-drag and `Ctrl`-left-drag.
- **Labels place themselves like a map.** Five zoom levels with cross-fade,
  screen-space collision, leader lines, wall-clock hysteresis, and a `+N` pill so
  a district can never read as empty. The establishing shot went from 26 labels
  with 9 overlapping pairs to 9 with none; the backend row from 29 overlapping
  pairs to one.
- **`autovacuum_vacuum_scale_factor` ships at 0.02**, not PostgreSQL's 0.2. At
  stock the demo tables need ~5,900 dead row versions to cross the threshold —
  roughly an hour at 10 tps — so the vacuum yard would be dead for a whole visit.
  0.02 is what the documentation recommends per-table for a busy relation.
- Default workload is 10 tps at 20% writes, so a single transaction can be
  followed end to end.

### Fixed

- **66 verified PostgreSQL corrections**, after four specialists reviewed every
  word and a second panel cross-examined each contested finding. The worst class
  is gone: catalog objects that did not exist — `SLRU` as a `wait_event_type`,
  `TransactionBuffer`, an Analyze phase in `pg_stat_progress_vacuum`. Also: the
  full-page-image surge begins when a checkpoint *starts*, recycled WAL segments
  are not zeroed, WAL insertion takes the lock before reserving space, the xmin
  horizon is per-database, and `synchronous_commit = on` is a *local* flush
  guarantee.
- **Binary units.** `fmtBytes()` divided by 1024 and labelled the result kB/MB/GB.
  Now KiB/MiB/GiB everywhere, except inside quoted PostgreSQL config values.
- **Pause froze nothing.** The frame loop scaled simulated time but handed real
  time to the world and the particles, so pausing drained rather than stopping,
  and `timeScale` desynchronised the two clocks.
- A WebGL context leak in the support probe, teardown firing on bfcache restore,
  the fps meter measuring the clamped delta it was designed to hide stalls with,
  and districts lit only by neon collapsing to black silhouettes at low quality.
- The quality selector did nothing at all.
- The top-bar vitals danced on every update.

### Known issues

- **Cache hit ratio reads about 57%**, which is not what an OLTP database looks
  like. Two compounding defects: the gauge is a time-average of ratios rather
  than `blks_hit/(blks_hit+blks_read)`, and the working set is sized so the
  `shared_buffers` slider never leaves the steep part of the curve.
- **Achieved throughput does not respond to bottlenecks.** A batch controller
  cancels them out, so lock contention, tiny `shared_buffers` and slow commits
  all fail to reduce committed transactions. The causes are simulated correctly;
  the effect is unreachable.
- WAL-triggered checkpoints fire at the full `max_wal_size` rather than
  `max_wal_size / (1 + checkpoint_completion_target)`.
- The shared-buffer grid saturates to white under heavy load and stops encoding
  state — exactly when the city gets interesting.
- Mobile layout: panels cover most of the viewport ([#1]).
- The minimap paints over the guided-tour caption.
- Walk mode inherits the flying camera's downward pitch on entry.

[#1]: https://github.com/NikolayS/PGSimCity/issues/1
[0.2.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.2.0

---

## [0.1.0] — 2026-07-25

First public release. A prototype: it works end to end, and it contains
mistakes.

PGSimCity is an explorable 3D city, running entirely in the browser, in which
every building is a real PostgreSQL mechanism. It is built for engineers who are
good at their job and have never had to operate a database.

### The city

- **Shared memory plaza** at the centre — a 32×32 field of 8 kB page frames whose
  height *is* their clock-sweep `usage_count` and whose colour is their true
  state: free, clean, dirty, pinned. The replacement clock hand sweeps across it,
  and evicted pages visibly collapse and re-rise.
- **`wal_buffers`** drawn as what it actually is, a circular buffer: a ring
  filling clockwise, with the angle between the insert and write arms showing
  exactly how much WAL is unflushed.
- **ProcArray** as a ring of per-backend pillars, with the **xmin horizon** as a
  blade cutting through them. Pin the horizon and the blade sinks and reddens.
- **Lock manager** with its 16 partitions, drawing a taut beam from each waiter
  to the holder it is queued behind.
- **CLOG/SLRU**, the **buffer mapping table**, and the cumulative statistics
  structure, all inside shared memory where they belong.
- **Backend row** — 16 towers, one per connection, whose lighting *is* their
  state, including `idle in transaction`.
- **The excavation**: the ground plane is cut away over the storage district, so
  the plaza visibly floats above the data files 52 m below. Memory above the
  line, disk beneath it, both in one frame.
- **Storage** — heap files as fields of 8 kB pages that grow as they bloat,
  B-trees as actual trees with a linked leaf level, TOAST, the free space map,
  the visibility map, the OS page cache and the disks.
- **WAL district** — walwriter, a vault of 16 MiB segments with real file names
  and real lifecycle states, the archiver, the walsender and logical decoding.
- **Maintenance yard** — checkpointer, background writer, and autovacuum workers
  that drive out to a table, fill their hoppers with dead tuples, and empty them
  at the landfill.
- **Standby** to the south: walsender → wire → walreceiver → startup process,
  with the four replication LSNs readable as four marks on one ruler.
- **Query lab** floating above the backend row: select a backend and its
  statement unfolds through parse → rewrite → plan → execute, with three costed
  candidate plans and the winner lighting up.

### The simulation

- Clock-sweep buffer replacement with real `usage_count` semantics, pinning, and
  dirty eviction by backends when nothing clean can be found.
- WAL with distinct insert, write and flush positions; commit waits that differ
  per `synchronous_commit` level; full-page-write volume that spikes after a
  checkpoint.
- Checkpoints triggered by time or by WAL volume, paced against
  `checkpoint_completion_target`, with a visible fsync phase.
- Autovacuum with per-table thresholds, worker phases, HOT updates that skip
  index maintenance, and an xmin horizon that genuinely blocks cleanup.
- Streaming replication with network delay and independently tracked
  sent/write/flush/replay positions.
- Nine scenarios: checkpoint storm, bloat and vacuum, xmin horizon, cache
  thrash, lock pile-up, replication lag, WAL flood, index vs seq scan, steady
  state.

### Interface

- 52 component explanations written to be read by non-experts, reachable by
  clicking any building.
- A 14-chapter guided tour that flies itself.
- A control rail exposing the real GUCs — `shared_buffers`,
  `checkpoint_timeout`, `max_wal_size`, `synchronous_commit`, `wal_level`,
  `autovacuum_vacuum_scale_factor` and more — each of which actually changes the
  city.
- Command palette (`/`), keyboard help (`?`), live vitals with sparklines, and a
  compass.
- Orbit and fly cameras, arrow-key movement, click to select, double-click to
  fly to.

### Engineering

- three.js r185, TypeScript, Vite. Three runtime dependencies, no framework, no
  CDN, no telemetry, no network calls at all.
- Adaptive quality: the renderer measures its own frame rate and steps down
  rather than stuttering.
- Instanced rendering throughout; the simulation never imports three.js and the
  world never mutates the simulation.
- Apache 2.0, with a `NOTICE` recording that PostgreSQL is a trademark of the
  PostgreSQL Community Association and that this project is not affiliated with
  or endorsed by it.
- Deployed to GitHub Pages on every push to `main`, gated on typecheck and build.

### Known issues

Listed deliberately. These are real, they are being worked on, and reports of
others are welcome.

- **Labels overlap** at some camera distances and become hard to read. The label
  system caps how many are shown but does no screen-space collision detection.
- **Several shared memory structures are effectively unfindable** — `wal_buffers`
  and CLOG among them — because they are labelled only at close range while the
  buffer grid dominates the plaza.
- **The disk array is positioned below the floor of the excavation** and is not
  visible at all. The `ckpt.fsync` traffic therefore terminates inside solid
  geometry.
- **Lock contention understates its own damage.** It blocks only queries against
  the locked table, so throughput dips rather than collapsing. The real
  production mechanism — blocked sessions holding connections until the pool is
  exhausted and unrelated queries stall too — is not modelled yet.
- **WAL-triggered checkpoints fire at the wrong threshold.** PostgreSQL triggers
  at `max_wal_size / (1 + checkpoint_completion_target)`, roughly 53% at the
  default; the model uses the full `max_wal_size`.
- **Pausing drains rather than freezes** in some builds: in-flight particles
  continue to their destinations instead of stopping where they are.
- **First-person walk mode ships but is not reachable** — the controller and
  collision system are present and unwired.
- The **aerial motion of the client tier** reads more like aircraft than like
  data. This is being reworked toward ground-level infrastructure.
- **`og.png` is around 620 KiB**, heavier than a social preview should be.

### Credits

The explanatory material leans on Bruce Momjian's talks, Hironobu Suzuki's
*The Internals of PostgreSQL*, Egor Rogov's *PostgreSQL Internals*, and the
PostgreSQL documentation and source. Any errors are this project's own.

[0.1.0]: https://github.com/NikolayS/PGSimCity/releases/tag/v0.1.0
