# Cinematic rendering

Graphics only. No simulation code, PostgreSQL claim, layout or palette value
changed. The daylight key is warmer and stronger, so lit surfaces render
warmer than before. Captures are 1600x900 with HUD and labels hidden, taken through
`tools/shoot.mjs` (software WebGL) at the high or ultra tier.

| View | Before | After |
| --- | --- | --- |
| Day, plaza | `before-day-plaza-1600x900.png` | `after-day-plaza-1600x900.png` |
| Night, plaza | `before-night-plaza-1600x900.png` | `after-night-plaza-1600x900.png` |
| Day, overview | — | `after-day-home-1600x900.png` |
| Day, backend towers | — | `after-day-towers-1600x900.png` |
| Day, WAL district | — | `after-day-wal-1600x900.png` |
| Day, coast | — | `after-day-coast-1600x900.png` |
| Night, overview | — | `after-night-home-1600x900.png` |
| Night, backend towers | — | `after-night-towers-1600x900.png` |
| Night, WAL at street level | — | `after-night-street-1600x900.png` |

## What the images show

- Day: the island stands in open water with a sun path; the sky carries a
  broken cloud deck; the paving is wet, tonally varied and mirrors the sky and
  nearby structure; concrete shows joints, tie holes, blotches and run-off;
  shade is deeper against sunlit stone.
- Night: lit districts glow into the haze by distance (street view); the sea
  gives the frame a horizon; wet paving returns a faint horizon glow in the
  overview. Neon, bloom and the Slonik plate outline are unchanged.

## What they do not show

- Frame rate. Every capture is software WebGL at 1–3 fps; cost on a real GPU
  is unmeasured.
- Motion. The sea, the wash against the wall and the grain are animated, and
  all three are frozen under reduced motion. Stills show neither state.
- Buildings are unchanged: the same boxes with better materials. The only new
  objects are the sea and the cloud deck, which are setting and carry no label.
- Semantic parts (capsules, ribbons, page tiles, text) keep one flat colour in
  daylight by design, and so read as less photoreal than their setting.
- Labels and the HUD. They were hidden for these captures, so nothing here
  shows text against the darker ground or the sea.
