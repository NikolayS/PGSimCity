# Readable-city candidate acceptance

Baseline: public v0.40.1, main `0f8cc67`.
Composition source: PR 22 `1576225557171155038d06d9bc48c566548bdbae`, merged without unrelated features at `d656dc7aa407a648a5ec9d939030635b260cfe60`.
Notice-placement fix: `97fa73eb098adb549a2e0ff44c36074aaa3ea1ec`.

## Evidence states

- `initial-*.png` / `initial.json`: original integrated PR22, **before** the notice placement fix, simulation paused after initial settling. These revealed a quality warning blocking the model qualification; do not use them as proof that the fix shipped.
- `before-*.png` / `before.json`: public v0.40.1, simulation reset and paused before the comparison sequence.
- `after-*.png` / `after-manual-index.json`: candidate with notice fix, simulation reset and paused before the same comparison sequence.
- `capture.mjs`: repository-driver sequence; the baseline/initial reports record actual quality tier, viewport and theme. The final run was interrupted after all eight PNGs but before its aggregate JSON flush; its manual index reads quality directly from the screenshots and contains no inferred frame-rate data. It changes no application code or adaptive-quality behavior.

Screenshots use the repository's two-browser semaphore and software WebGL. Requested high/medium can automatically downgrade while shader compilation/software rendering is slow. The JSON records actual quality; software frame rate is **not** a hardware benchmark. Images must not be described as a same-tier comparison unless their actual tiers match.

## Scope

Raised three-quarter opening composition; less competitive survey marks; theme-aware labels with less letter spacing; compact laptop instruments. No new PostgreSQL mechanism, architecture, simulation dynamics or lesson is introduced. This is an orientation/legibility increment, not the complete graphics redesign.

The separate minimal notice repair anchors transient notices above the transport in the free city row, away from the PostgreSQL qualification below the top instruments. It does not remove the warning, qualification, or restore-quality action.

## Regression evidence

`test/quality-notice.browser.test.ts` failed before the fix: `qualificationBlocked: true`, `qualificationHit: false`, with warning visibly present and transport unblocked. The same test passed after the CSS-only placement fix. Full check and rendered acceptance results are recorded in the final handoff.

## Checks completed

- Integrated full `npm test -- --maxWorkers=2`: 136 files passed, one skipped; **1,072 tests passed**, one optional skipped (742.64 seconds). Began before the notice fix; the separate focused browser test covers that change.
- Exact post-fix `npm test -- --exclude '**/*.browser.test.ts' --maxWorkers=2`: **1,050 passed** in 126 files (265.68 seconds).
- Notice placement rendered regression: RED before fix, GREEN afterward (one test).
- Post-fix `npm run typecheck` and `npm run build`: passed. Build retains existing PGlite bundler warnings; no new dependency was added.
- Initial candidate and public baseline capture logs: no JavaScript exceptions.

## Known remaining limits

The 768×1024 capture after a phone-to-tablet resize contains no labels in both the baseline and initial candidate. It is inherited and must not be presented as fixed by this release. The mobile opening remains a small overview, and night structures remain dark at reduced quality. This increment should not be marketed as the substantial materials/architecture/dynamics overhaul.

## Final rendered acceptance

All eight final day/night images were visually inspected. At 1440 and 1280, clients/backends/buffer-pool/storage are identifiable, grid competition is reduced, and day names no longer appear dark-on-dark. At 390, the visible backend/client chips are legible, and a physical touch on Backends opens the inspector with its model qualification (`label-touch.png` and JSON). The tablet resize-label limitation remains as described above.

The final matrix process exited 143 (SIGTERM) after its eight images; the cause was not established. Its aggregate console/probe report was not flushed. Thus the final matrix is inspected visual evidence, **not** a completed console audit. The separately completed label-touch run logs no exceptions.

The separate final qualification run completed: at 390×844, an actual touch opens the full PostgreSQL claim scope while the quality warning and its Restore action remain visible above the transport. `qualification-touch.png` was inspected; its JSON records `qualificationOpen: true`, `warningVisible: true`, actual quality `low`, and no exceptions.

## What to try after deployment

Open on a laptop in Day mode; identify Clients, Backends, Buffer pool and Storage. Switch Night/Day, tap the Backends label on a phone, and read its inspector qualification. Return to the opening view. These changes improve orientation and label contrast; richer materials, architecture and causal lessons remain separate increments.
