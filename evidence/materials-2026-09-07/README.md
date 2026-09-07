# Materials acceptance evidence — blocked

Baseline: `1208782068e857d8d87c9eb521e5e344028023dc` (v0.41.0).
Candidate application: `75fe2f2c3386a9a26d75d056f67b31a035a5caae` (PR23 integrated above the baseline).

## Result

**Not release acceptance.** Candidate night/medium renders a blank city canvas while DOM labels remain. The matching baseline renders the city; the candidate's following low-quality state restores it. See `materials-stable-after-night-medium-backend.row.png` and the paired before image. Source cause remains unassigned.

All12 desktop images were inspected. JSON verifies actual theme, quality and camera before and after each screenshot. The exact candidate [CI run](https://github.com/NikolayS/PGSimCity/actions/runs/34068129881) passed1029 fast tests and50 browser tests, with one optional skip, plus typecheck/build. Rendered evidence nonetheless blocks acceptance.

Daylight differences are modest: bounded material response and medium-quality detail, not a visual overhaul. Phone acceptance is not established. The inherited laptop claim-banner overlap and dark low-quality night structures remain visible.

## Reproduction

Use the repository `tools/shoot.mjs` driver with `CDP_SEQUENCE` pointing at `capture-sequence.mjs`,1280x800 and45s initial settling. Respect the shared two-browser gate. Sequence: day/high home; day/medium home; day/medium backend.row; day/medium backend.7; night/medium backend.row; night/low home. Each state settles23s before capture. The camera and actual tier are checked around each image.

The sequence temporarily supplies a synthetic render timebase to keep quality stable for visual comparison. **FPS readouts and timing are artificial; these images are not performance measurements.** Application source/adaptive behavior is unchanged. Reset warms the model without recreating its RNG closure, so workload colors and particle counts differ; compare fixed structures rather than flow counts.

## Separate audio result

The rendered audio audit twice measured zero walking signal despite six started sources. A timestamped probe found the AudioContext clock frozen for798.5ms after resume despite reporting running, with master gain zero and finite nonzero source buffers. A no-WebGL production-audio probe advanced normally after resume but showed an initial clock stall. Browser/backend versus application attribution remains unresolved; neither signal assertions nor timeouts were weakened. Audio activation and black-canvas transition require focused investigation before release.

## Narrowed reproduction

A separate three-state candidate run reproduced the blank night/medium canvas: day/medium backend.7 → night/medium backend.row → night/low home. See `materials-night-repro-night-medium-backend.row.png`, its JSON, and `capture-night-repro.mjs`. It completed without application exceptions. This strengthens reproducibility under staged quality but does not establish the source cause or unstaged-device behavior.
