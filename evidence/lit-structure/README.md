# Lit structure: narrow semantic-safe conversion

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

## Implementation and evidence

Pending. This section will record the red/green tests, identical-station visual
evidence, after timings, and the semantic legibility verdict after the scope
gate above has been reviewed against the implementation.
