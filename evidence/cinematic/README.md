# Cinematic rendering

Graphics only. No simulation code, PostgreSQL claim, layout or semantic colour
changed. Captures are 1600x900 with HUD and labels hidden, taken through
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
| Night, WAL district | — | `after-night-wal-1600x900.png` |
| Day, WAL at street level | — | `after-day-street-1600x900.png` |

## What the images show

- Day: the island stands in open water with a sun path; the sky carries a
  broken cloud deck; the paving is wet, tonally varied and mirrors the sky and
  nearby structure; concrete shows joints, tie holes, blotches and run-off;
  shade is deeper against sunlit stone.
- Day, street level: WAL capsules carry shade and a glint instead of one flat
  colour; their hue is unchanged.
- Night, WAL district: the platform is lit by the flows passing over it.
- Night: lit districts glow into the haze by distance (street view); the sea
  gives the frame a horizon; wet paving returns a faint horizon glow in the
  overview. Neon, bloom and the Slonik plate outline are unchanged.

## What they do not show

- Frame rate. Every capture is software WebGL at 1–3 fps; cost on a real GPU
  is unmeasured.
- Motion. The sea, the wash against the wall and the grain are animated and
  are frozen under reduced motion; stills cannot show either.
- Geometry is unchanged. Buildings are the same boxes with better materials;
  no objects were added, because every object in this city is a claim.
- Flat semantic parts (ribbons, page tiles, text) keep one flat colour by
  design: a plane has no form to shade.
