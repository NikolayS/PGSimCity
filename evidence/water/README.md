# Water (v0.59.1)

Graphics only. Captures are 1600x900 with HUD and labels hidden, through
`tools/shoot.mjs` (software WebGL) at the high tier.

| View | Before | After |
| --- | --- | --- |
| Day, coast | `before-day-coast-1600x900.png` | `after-day-coast-1600x900.png` |
| Day, buffer pool | `before-day-pool-1600x900.png` | `after-day-pool-1600x900.png` |
| Night, buffer pool | `before-night-pool-1600x900.png` | `after-night-pool-1600x900.png` |
| Day, overview | — | `after-day-overview-1600x900.png` |

## What the images show

- Coast: before, open water meets the wall with nothing between them (this
  cape lay outside the edge field, so the earlier wash never drew). After,
  lines of surf with lace behind them, paler water over the shelf, and the
  cloud deck mirrored in the swell.
- Pool by day: a rippled surface with a broken sun glitter path in place of a
  uniform pane. The page tiles beneath are as legible as before.
- Pool by night: the towers and neon are mirrored in the water.
- Overview: surf follows the whole coastline.

## What they do not show

- Motion. Surf was confirmed to travel shoreward by two captures of the same
  view some seconds apart, which are not kept here. Sea, surf and ripple are
  frozen under reduced motion.
- Caustics. At 7% they are barely visible in a still; they read in motion.
- Frame rate. Software WebGL only. The pool's planar reflection now also
  renders at night, which is a second scene pass at that time of day.
