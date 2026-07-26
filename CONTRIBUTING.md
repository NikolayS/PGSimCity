# Contributing to PGSimCity

Thanks for helping make PostgreSQL internals understandable and accurate.

## Start here

- Read [README.md](README.md) for the product and architecture overview.
- Read [CLAUDE.md](CLAUDE.md). It is the source of truth for engineering,
  style, terminology, visual accuracy, and review rules.
- Keep changes focused and preserve the simulation/world boundary.

## Development

Node.js 20 or newer is required.

```bash
npm install
npm run dev        # http://localhost:5173/
npm test           # one fast, deterministic run
npm run test:watch # rerun affected tests while editing
```

Before opening a pull request:

```bash
npm test
npm run typecheck
npm run build
```

## Bug fixes use red/green TDD

Every bug fix starts with a failing automated test that reproduces the defect.
The source fix is the change that turns that test green. **No test, no fix.**

This is mandatory because PGSimCity lost the same Slonik plate shape across
four commits. A property-based characterization test would have identified the
breaking commit immediately and prevented the regression from landing silently.
CI runs `npm test` and rejects a change if any test is red.

1. Add the smallest deterministic test that demonstrates the bug.
2. Run it and confirm that it fails for the expected reason.
3. Fix the source; do not weaken the assertion.
4. Run the full verification commands above.

Tests should assert behavior or a meaningful property, not a large snapshot.
Keep pure simulation and geometry tests independent of browsers, GPUs,
wall-clock timing, and unseeded randomness.

## Pull requests

- Keep one logical fix or feature per pull request.
- Explain the motivation, user-visible effect, and verification performed.
- Use Conventional Commits with a truthful, present-tense subject under 50
  characters.
- For visible changes, include and inspect before/after screenshots.
- Do not merge until CI is green, substantive review is complete, and the
  changed behavior has been exercised manually.
