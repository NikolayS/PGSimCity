# Lit structure: narrow semantic-safe conversion

## Decision

**Do not ship the conversion.** The scope gate admitted only one surface,
`ground.kerbTop`. Lighting that cap adds real form without weakening any
district or state colour, but the paired medium-tier run moved from
17.73 / 39.85 ms to 25.75 / 70.50 ms median / p95. The median crossed the
22.22 ms budget, and the regression appeared in both condition orders.

The candidate was therefore reverted. This branch contains the classification,
reproduction tool, screenshots, and raw timings, but no production material or
fidelity-threshold change. This is the narrow scope's result: one modestly useful
surface is not worth spending medium-tier frame budget.

## Classification before conversion

This table is the scope gate. It was written before changing a production
material. The baseline is the runtime material census at
`spike/visual-quality` commit `ca3c8ab`; the current source was then checked for
material changes since its parent `d8ecec4`. Current `main` adds unlit labels
and effects, but no new opaque structural mass.

The decision rule comes from `CLAUDE.md`: a district identity, live state, or a
colour named by the registry, inspector, or legend is semantic. A mechanism
whose changing colour is the information is semantic too. Concrete, metal, or
deck colour is not. A semantic surface remains unlit even when lighting it
would add form.

| Production surface | Authored colour and code evidence | Is colour semantic? | Decision before conversion |
| --- | --- | --- | --- |
| Existing structural families: `clients.struct` / `clients.deep` / `clients.forecourt`; `access.deck` / `access.struct` / `access.steel` / `access.tread`; `backends.struct` / `backends.trim` / `backends.shaft`; `shmem.struct*` / `shmem.pylon` / `shmem.coping`; `storage.struct*`; `wal.struct` / `wal.deep` / `wal.heavy`; `maint.struct` / `maint.deep` / `maint.heavy` / `maint.vehicle` / `maint.tyre`; `rep.struct` / `rep.deep` / `rep.heavy` / `rep.cool`; planner, continuity, control-centre, handle, skyline, pit and rim mass | Neutral authored masonry/metal values in `src/world/*.ts`, all constructed with `theme.mat()` or `MeshStandardMaterial` | No, but already lit | No change. These are the existing diagram-safe endpoint established by the spike. |
| `ground.kerbTop` | Blue-grey mix of black and `RIM_LIGHT`; opaque `MeshBasicMaterial` in `src/world/ground.ts`. The code calls the geometry the kerb's concrete “capping”; `world.ground` is registered as the whole cluster, with `COLOR.ink`, not this hue. No legend row names it. | **No.** The ring geometry and contrast mark the city boundary; this particular hue encodes no district, state, or PostgreSQL mechanism. | **Convert.** One shared lit material for the one perimeter mesh, at every tier. Keep the additive edge line and halo unlit. |
| `control-center:door-reveal` | Literal black, opaque `MeshBasicMaterial` in `src/world/control-center.ts` | **Yes, as a visual mechanism.** Black is the depth/void cue behind opening door leaves. Lighting it would turn a reveal into visible mass. | Leave unlit. |
| `shmem/wal.buffers` ring | `COLOR.walDim`, then animated toward `COLOR.crit` when the ring stalls in `src/world/shmem.ts` | **Yes.** WAL identity and critical state are both palette/legend meanings; the hue transition is the information. | Leave unlit. |
| `shmem/proc.array/xmin.horizon` ring | `COLOR.index`, animated toward `COLOR.crit` as transaction age becomes dangerous in `src/world/shmem.ts` | **Yes.** The index-to-critical transition is live state, not surface finish. | Leave unlit. |
| `shmem/stats.shmem` beacon | `COLOR.ok`, pulsed on shared-counter updates in `src/world/shmem.ts` | **Yes.** Green and the pulse report update activity; `ok` is a status palette slot. | Leave unlit. |
| `storage/disk.array` fsync bar | Dark idle colour, animated magenta as `fsyncGlow` rises in `src/world/storage.ts` | **Yes.** The colour is the live fsync indicator. | Leave unlit. |
| `wal/logical.decoder` prism core | Literal black while off, animated to `COLOR.toast` when logical decoding is active in `src/world/wal.ts` | **Yes.** Black/off versus TOAST-coloured/on is the mechanism state. | Leave unlit. |

The spike's 200 other `MeshBasicMaterial` instances remain outside this table
because the census identified them as labels, decals, helpers, picking,
transparent effects, semantic neon, or per-instance live state. Lighting those
would change meaning or break their rendering model, not improve structure.

## Baseline carried forward from the spike

The spike's paired median / paired p95 frame times are the “before” baseline;
they are not rerun here. The applicable baseline condition is its production
material state (the `all` column), because this branch retains the shipped
GTAO and PMREM tier boundaries and starts from the already-lit structural city.

| Tier | Before median / p95 (ms) | 45 fps budget (ms) |
| --- | ---: | ---: |
| low | 9.25 / 23.80 | 22.22 |
| reduced | 9.77 / 19.15 | 22.22 |
| medium | 17.77 / 34.80 | 22.22 |
| high | 18.95 / 36.40 | 22.22 |
| ultra | 23.77 / 44.10 | 22.22 |

These short SwiftShader runs are noisy; the spike explicitly treats differences
under several milliseconds as unresolved. Its defensible tier result remains:
GTAO and the PMREM environment stay off on low/reduced, and no threshold may be
moved to accommodate this conversion.

## Candidate and red/green checks

The candidate changed the cap's one shared `MeshBasicMaterial` to one matte
`MeshStandardMaterial` (`roughness: 0.86`, `metalness: 0.08`). It did not add an
object, draw, per-object material, per-frame allocation, light, post-processing
pass, or tier branch. The separate `ground.edgeLight` line and two additive
halos stayed Basic, so low/reduced retained the same distance cue even without
GTAO or the PMREM environment.

Before the candidate, `npx vitest run src/world/lit-structure.test.ts` was red in
the intended place: all five production quality tiers found
`ground.kerbTop.isMeshStandardMaterial` undefined. The theme/registry semantic
colour enumeration already passed. After the candidate, all six checks passed:

- theme and registry colours were enumerated from production, toggled day →
  night, and compared exactly rather than copied into a test list;
- every production tier constructed exactly one cap mesh using one material;
- the candidate was opaque and its deterministic diffuse response changed with
  irradiance, proving it was light-responsive rather than emissive-only.

The browser timing sweep was the budget acceptance test. Encoding noisy host
wall time as a Vitest assertion would violate the repository's deterministic
test rule. That acceptance test failed, so the candidate and its now-inapplicable
unit test were removed rather than weakening either threshold.

## Screenshot protocol

- Chromium/SwiftShader through the repository's two-slot gated driver; runs
  were made sequentially after a two-browser attempt proved CPU-contentious.
- deterministic warm simulation reset, then paused;
- high tier, reduced motion, fixed 60 fps governor input;
- one browser-side material toggle: `before` is the shipped Basic cap and
  `after` is the rejected Standard candidate; all geometry, cameras, semantic
  materials, renderer thresholds, GTAO and PMREM state are shared;
- two synchronized full-pipeline renders before every capture;
- floating map labels hidden in both conditions, so district legibility is
  judged from the colour system rather than text;
- each condition is restaged independently. Metadata verifies one camera
  transform per pair, including the computed walk-mode eye station.

### Contact sheets

| View | Evidence |
| --- | --- |
| Desktop day: home, clients, WAL, standby, eye level | [contact-day-desktop.png](contact-day-desktop.png) |
| Desktop night: home and WAL | [contact-night-desktop.png](contact-night-desktop.png) |
| Mobile day: home, clients and WAL | [contact-day-mobile.png](contact-day-mobile.png) |
| Mobile night: 400 m multi-district view | [contact-night-mobile.png](contact-night-mobile.png) |
| First-person east-perimeter pair | [contact-eye-desktop.png](contact-eye-desktop.png) |

Raw capture metadata: [desktop](screenshots-desktop.json),
[390 × 844](screenshots-mobile.json), and the corrected exact-camera
[eye-level pair](screenshots-eye.json). The individual PNGs use
`before|after`-`day|night`-`station`-`viewport`.png in this directory.

### Visual result

The effect is real but narrow. In day at eye level the Basic cap is a flat,
saturated blue strip; the candidate breaks it into light and shade facets while
the thin perimeter line remains bright. The 400 m curved perimeter also gains
form. Clients shows the same distinction clearly. WAL and standby change only
slightly because less of the cap is visible. At night, home and WAL retain the
boundary cue and gain restrained shading; client/standby close cameras do not
see useful lit scene content and are retained only as raw zero-delta captures,
not as evidence of improvement.

Normalized image RMSE is a size-of-change check, not a quality score:

| Station | Desktop day | Desktop night | Mobile day | Mobile night |
| --- | ---: | ---: | ---: | ---: |
| Home | 0.0191 | 0.0304 | 0.0127 | 0.0200 |
| Clients | 0.0177 | 0.0000 | 0.0116 | 0.0000 |
| WAL | 0.0044 | 0.0063 | 0.0062 | 0.0000 |
| Standby | 0.0052 | 0.0000 | — | — |
| Eye level | 0.0549 | — | — | — |

## Legibility verdict

**Pass, but not a ship decision.** With labels hidden, clients remains blue,
shared memory indigo, WAL amber, storage green, maintenance violet, and standby
orange in both conditions. Dirty/pinned/warn/status colours, inspector/registry
colours, neon, routes, and district plates are untouched. Every semantic colour
still reads as itself, and no district identity weakens. The candidate is
rejected solely because its modest non-semantic form improvement does not pass
the frame budget.

## Paired frame time

[timing.json](timing.json) contains every sample and material/tier state. Each
cell below is paired median / paired p95 milliseconds, averaging a forward and
reverse 12-frame run after one synchronized warm/drain frame.

| Tier | Current Basic cap | Lit candidate | Median change | Budget verdict |
| --- | ---: | ---: | ---: | --- |
| low | 12.25 / 25.55 | 11.50 / 27.75 | −0.75 | Median holds; p95 was already over and worsens 2.20 ms. |
| reduced | 10.65 / 29.60 | 12.05 / 23.65 | +1.40 | Median holds; noisy p95 improves. |
| medium | 17.73 / 39.85 | **25.75 / 70.50** | **+8.02** | **Fail: candidate median crosses 22.22 ms.** |
| high | 39.23 / 79.40 | 39.40 / 66.05 | +0.17 | Both medians over on this host; change unresolved. |
| ultra | 30.95 / 70.20 | 22.48 / 53.95 | −8.47 | Both medians over; apparent speed-up is noise, not credited. |

The raw samples remain noisy, as in the spike. Medium is the actionable result:
forward medians moved 19.50 → 28.05 ms and reverse medians 15.95 → 23.45 ms,
so order reversal did not remove the regression. No tier setting or threshold
was changed to fit the candidate.

## Reproduction paths

- `tools/lit-structure-evidence.mjs` reconstructs the rejected candidate in
  browser memory from the unchanged production cap. Use it through
  `tools/shoot.mjs` with `PG_LIT_EVIDENCE_MODE=desktop`, `mobile`, `eye`, or
  `timing` and a unique `CDP_PORT`.
- `evidence/lit-structure/screenshots-*.json` records camera, material and
  viewport state for every screenshot.
- `evidence/lit-structure/timing.json` records the complete paired timing sweep.
- The prior renderer/material audit remains at commit `ca3c8ab` on
  `spike/visual-quality`; its measurements were used as the historical baseline
  above and were not rerun.

## Final verification

- `npm test -- --maxWorkers=1`: 123 files, 991 tests passed. An earlier parallel
  run reached 990/991 when `touch-action.browser.test.ts` timed out waiting on a
  gate shared with another worktree; that test passed alone in 6.15 s after the
  slot cleared, and the complete serialized rerun was green.
- `npm run typecheck`: passed.
- `npm run build`: passed; only the existing PGlite browser-external/eval
  warnings were emitted.
- `node --check tools/lit-structure-evidence.mjs`: passed.
