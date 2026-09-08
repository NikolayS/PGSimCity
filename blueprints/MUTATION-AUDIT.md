# Critical-target mutation audit

This report records the complete mutation run against main commit
`7351e1808067da21bea64919479c9d7006f533ef` on 2026-08-05. The runner applied
one mutant at a time, restored its source before continuing, and ran every
verifier with `--maxWorkers=1`. No survivor was fixed in this change.

## Ranked critical targets

| Rank | Critical target | Mutants | Why it is selected |
|---:|---|---:|---|
| 1 | Claims registry ownership | 228 | A byte-identical literal must not be able to replace the registered owner at a consuming surface. |
| 2 | Action registry ownership | 30 | Operator actions must retain their registry wiring, preconditions, risks, and version boundaries. |
| 3 | PostgreSQL oracle checks | 4 | The external oracle is only a gate if its own comparison boundaries and independent terms are defended. |
| 4 | Rendered visual sweeps | 4 | Geometry is factual content; holes, displaced surfaces, inverted facing, and submerged rims must be noticed. |
| 5 | Disclosure invariants | 12 | A qualification that disappears while its claim remains is a correctness failure, not a layout detail. |

Every listed target is critical. A survivor or an inconclusive skip makes the
scheduled gate fail; rank orders investigation and does not dilute that rule.

## Actual reach and limits

The harness applied 278 explicit sites on 228 distinct source lines out of
95,553 nonblank production/tool lines under `src/`, `machine/`, and `tools/`:
0.239% of that defined codebase. Those sites occupy 30 of 144 eligible files
(20.833%). The exact-line fraction is the mutation reach; target-file coverage
is not evidence that every line in those files was mutated.

- The denominator includes production `.ts`, `.js`, `.mjs`, `.css`, and
  `.html` in those three roots, including generated source data. Tests,
  workflows, documentation, configuration, assets, and root entry points
  outside those roots are neither in that denominator nor mutation targets.
- DELINK reaches direct `CLAIM_VALUES.<claim>` property reads and
  literal-argument `renderAction(...)`/`renderActions(...)` calls discovered in
  production TypeScript/JavaScript. It does not reach aliases, destructuring,
  reflective access, computed action IDs, or values assembled outside those
  registries.
- GEOMETRY is four incident-derived probes: one 24 × 24 ground hole, one
  displaced world coordinate, one inverted plate normal, and one rim sunk
  below its deck. It does not generically mutate every mesh, shader, collider,
  route, animation state, quality tier, browser, or GPU.
- GATE covers selected Diagnose thresholds and oracle boundaries/independent
  terms. It does not enumerate general arithmetic, boolean, loop, SQL, or
  timing mutations.
- GUARD covers registered action preconditions/risks, selected load-bearing
  claim disclosures, and one real 390 px CSS hiding fault. It cannot infer
  unregistered prose qualifications or facts that ought to have a disclosure
  but do not.
- Each mutant runs only the named closest plausible verifier. SURVIVED means
  that scoped verifier accepted the mutation; it does not claim that the full
  suite would accept it. A full-suite-per-mutant loop is deliberately not
  implied by this report.
- Browser mutations use the live Chrome/SwiftShader sweep at its staged
  day/medium state. Time-dependent scenes, other quality/theme states,
  transient host contention, and visual defects below the sweep thresholds
  remain outside this run.

## Surviving mutants

| Rank | File | Line | Operator | Mutation | What should have caught it |
|---:|---|---:|---|---|---|
| 1 | `src/observability/paths.ts` | 768 | GATE | Include the exact requested-checkpoint share boundary in both opposing branches. | `test/claims-spine.test.ts` disjoint threshold-boundary characterization. |
| 1 | `src/observability/paths.ts` | 970 | GATE | Include the exact client-backend-write warning boundary in the positive branch. | `test/claims-spine.test.ts` exact Diagnose branch-boundary characterization. |
| 2 | `src/core/actions.ts` | 57 | GUARD | Remove precondition 2 from `ACTIONS.restoreReplayCapacity`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 60 | GUARD | Remove risk 1 from `ACTIONS.restoreReplayCapacity`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 76 | GUARD | Remove precondition 1 from `ACTIONS.resumePausedRecovery`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 79 | GUARD | Remove risk 1 from `ACTIONS.resumePausedRecovery`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 120 | GUARD | Remove precondition 1 from `ACTIONS.restoreConnectionCapacity`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 123 | GUARD | Remove risk 1 from `ACTIONS.restoreConnectionCapacity`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 141 | GUARD | Remove precondition 1 from `ACTIONS.enableRelationAutovacuum`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 144 | GUARD | Remove risk 1 from `ACTIONS.enableRelationAutovacuum`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 162 | GUARD | Remove precondition 1 from `ACTIONS.tuneAutovacuum`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 2 | `src/core/actions.ts` | 165 | GUARD | Remove risk 1 from `ACTIONS.tuneAutovacuum`. | `test/action-spine.test.ts` semantic requirements, not registry/surface byte agreement alone. |
| 5 | `src/core/claims.ts` | 110 | GUARD | Remove `CLAIM_VALUES.bulkReadRing.disclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 131 | GUARD | Remove `CLAIM_VALUES.modelLatency.disclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 133 | GUARD | Remove `CLAIM_VALUES.modelLatency.taxonomyDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 159 | GUARD | Remove `CLAIM_VALUES.connectionPooler.coverageDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 175 | GUARD | Remove `CLAIM_VALUES.workMem.coverageDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 203 | GUARD | Remove `CLAIM_VALUES.restoreDrill.smokeDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 205 | GUARD | Remove `CLAIM_VALUES.restoreDrill.cadenceDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |
| 5 | `src/core/claims.ts` | 215 | GUARD | Remove `CLAIM_VALUES.timelineRecovery.coverageDisclosure`. | The claim-specific disclosure invariant in `test/claims-spine.test.ts`. |

## Conclusive non-survivors and skips

All discovered DELINK mutations were killed, including every direct claims
consumer and every literal-argument action renderer. All four oracle mutations,
all four rendered geometry mutations, and the rendered CSS disclosure-hiding
mutation were also killed. The run skipped no mutants and had no inconclusive
timeout. It finished in 1,302.72 seconds with 258 killed and 20 surviving
mutants. No mutation score is calculated.
