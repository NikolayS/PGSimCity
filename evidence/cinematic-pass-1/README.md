# Cinematic rendering, first pass

Graphics only. No simulation code, PostgreSQL claim, layout or semantic colour
changed. Captures are ultra quality, 1600x900, HUD and labels hidden, through
`tools/shoot.mjs` (software WebGL).

| View | Before | After |
| --- | --- | --- |
| Day, plaza | `before-day-plaza-1600x900.png` | `after-day-plaza-1600x900.png` |
| Night, plaza | `before-night-plaza-1600x900.png` | `after-night-plaza-1600x900.png` |
| Day, overview | — | `after-day-overview-1600x900.png` |
| Day, low angle | — | `after-day-low-angle-1600x900.png` |

`after-day-low-angle` was captured before the structural weathering and the
contrast curve were added; it is kept for the wet paving and sun mirror only.

## What the images show

- Day: the ground plate is darker and tonally varied, standing water mirrors
  the sky and the sun-side glow, and the plaza deck edge is mirrored in the
  paving in front of it. Shade is deeper against sunlit stone.
- Night: the change is small. The frame gains a vignette; mirrored structure is
  visible under the plaza's access bridge. Neon, bloom and the Slonik plate
  outline are unchanged.

## What they do not show

This is not yet the level of the reference the work was measured against.
Structures are still flat-shaded boxes with light weathering, the day sky and
clouds are unchanged, and night reflections are sparse because little neon
stands directly on the plate. Those are the next passes.
