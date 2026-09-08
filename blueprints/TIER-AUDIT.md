# Renderer tier teaching audit

This audit covers the live adaptive path: the city is constructed at `high`,
then `gfx.setQuality()` moves it through the requested tier. Construction-only
`quality.level === 'low'` branches in individual world factories are therefore
not tier removals: adaptive changes do not rebuild those factories.

## Measured teaching floors

The colour readings use the same semantic materials and combined output path as
the renderer: the tier's bloom fallback, daylight grade, shaft addition and
height haze. Each entry is the minimum of all 45 semantic pairs. Disclosure and
touch readings come from a real 390 × 844 browser after each live quality
transition.

| Tier | Day minimum | Night minimum | Disclosure minimum | Touch minimum |
| --- | --- | --- | --- | --- |
| ultra | 0.047647 (`storage` / `index`) | 0.041117 (`wal` / `replication`) | 9px | 44 × 44px |
| high | 0.049394 (`bufDirty` / `lock`) | 0.040915 (`wal` / `replication`) | 9px | 44 × 44px |
| medium | 0.055711 (`bufDirty` / `lock`) | 0.042326 (`bufDirty` / `lock`) | 9px | 44 × 44px |
| reduced | 0.066574 (`bufDirty` / `lock`) | 0.044247 (`bufDirty` / `lock`) | 9px | 44 × 44px |
| low | 0.066574 (`bufDirty` / `lock`) | 0.044247 (`bufDirty` / `lock`) | 9px | 44 × 44px |

The existing floors remain unchanged: 0.045 by day, 0.038 by night, 9px for
disclosures and 44px for touch targets. All 13 rendered City disclosures and
all 20 reachable City controls were measured at every tier.

## What the live tiers remove

- `ultra` removes nothing. It uses the full 2× render scale, environment,
  half-resolution water reflection, AO, aerial perspective, 2048px soft
  shadows, ten-tap shafts, SMAA, bevels, full ground response and all rooftop
  dressing.
- `high` removes 14 rooftop-detail anchors and reduces AO resolution/samples,
  aerial perspective, shadow resolution/softness and shaft resolution/samples.
  It retains every effect family, 2× render scale, SMAA and bevels.
- `medium` additionally removes cast shadows (including the decorative
  shared-buffer raking shadows), SMAA and box bevels. It reduces the render cap
  to 1.5×, water reflection to quarter-resolution, ground response to its joint
  layer, and rooftop dressing to 18 anchors. Environment, AO, haze, shafts,
  daylight sky scattering, clouds and bloom remain.
- `reduced` additionally removes the environment map, planar water reflection,
  AO, aerial perspective, light shafts, daylight sky scattering and clouds,
  ground-surface aggregate/joint response, rooftop dressing, ambient ground
  light cones and articulated finger detail. It renders at 1× and retains the
  cheaper legacy sky, hand silhouettes and bloom.
- `low` removes bloom as well, and bypasses the post chain at night. Its
  no-bloom semantic palette and compensating hemisphere/fill/district lights
  preserve the glow's colour meaning without paying for the halo. Its other
  live geometry and atmosphere cuts match `reduced`.

Every tier retains the full route-particle and label budgets, semantic colours,
plates, disclosures and controls. The Machine P/M medallions are outside the
City renderer and are unchanged by its tier. Lower tiers retain both hand
silhouettes and their actions; only articulated detail is decorative.

## Cost of restoring meaning

The fix raises the particle ceiling from 700 to 4200 at `low`/`reduced`, from
1500 at `medium`, and from 2600 at `high`. At `low`, the extra 3500 slots cost
about 0.36 MiB of typed-array memory and 0.25 MiB of GPU instance buffers. An
idle or ordinary scene submits only the used high-water mark, so the larger
ceiling adds no empty instance draw. A saturated teaching scene can now submit
up to 3500 more small packet instances instead of silently dropping routes.

The label ceiling rises from 18 to 44 at `low`/`reduced`, 26 at `medium`, and 34
at `high`. Label DOM nodes already exist for the registry; the cost is at most
26 additional visible placements/composites in a dense low-tier view, not 26
newly allocated labels. Establishing-view renders stayed below the old ceiling.

## Render verification

`tools/tier-audit-sequence.mjs` drives `tools/shoot.mjs` through every tier in
both themes, records the tier actually rendered, and writes each frame plus a
JSON report. The audit was read at 1400 × 900 and 390 × 844. Across the 20 day
and night frames in total, lower tiers became flatter and less atmospheric as
intended; route hues, labels, plates and disclosure bands stayed legible. Low
night visibly lost its halo but retained bright, distinct district colour.
