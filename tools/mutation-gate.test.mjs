import { describe, expect, it } from 'vitest'

import {
  OPERATORS,
  TARGETS,
  applyTextMutation,
  coverageSummary,
  discoverMutationPlan,
  isTimeoutFailure,
  markdownMutationTable,
  mutationSummary,
} from './mutation-gate.mjs'

describe('mutation gate', () => {
  it('defines the incident-derived operators and ranked critical targets', () => {
    expect(Object.keys(OPERATORS)).toEqual(['DELINK', 'GEOMETRY', 'GATE', 'GUARD'])
    expect(TARGETS.map((target) => target.id)).toEqual([
      'claims-registry',
      'action-registry',
      'oracle-checks',
      'visual-sweeps',
      'disclosure-invariants',
    ])
    expect(TARGETS.map((target) => target.rank)).toEqual([1, 2, 3, 4, 5])
    expect(TARGETS.every((target) => target.critical)).toBe(true)
  })

  it('discovers applicable production probes for every operator and target', async () => {
    const mutations = await discoverMutationPlan()

    expect(mutations.length).toBeGreaterThan(250)
    expect(new Set(mutations.map((mutation) => mutation.operator)))
      .toEqual(new Set(Object.keys(OPERATORS)))
    expect(new Set(mutations.map((mutation) => mutation.target)))
      .toEqual(new Set(TARGETS.map((target) => target.id)))
    expect(mutations.filter((mutation) => mutation.unavailableReason)).toEqual([])
  })

  it('applies only the exact source range it discovered', () => {
    expect(applyTextMutation('alpha beta gamma', {
      start: 6,
      end: 10,
      expected: 'beta',
      replacement: 'literal',
    })).toBe('alpha literal gamma')

    expect(() => applyTextMutation('alpha drift gamma', {
      start: 6,
      end: 10,
      expected: 'beta',
      replacement: 'literal',
    })).toThrow(/source range drifted/)
  })

  it('reports survivors and inconclusive skips without turning them into a score', () => {
    const results = [
      { status: 'KILLED', critical: true },
      { status: 'SURVIVED', critical: true },
      { status: 'SKIPPED', critical: true },
    ]
    expect(mutationSummary(results)).toEqual({
      total: 3,
      killed: 1,
      survived: 1,
      skipped: 1,
      criticalSurvivors: 1,
      criticalSkips: 1,
    })
  })

  it('does not confuse a failing statement-timeout check with host contention', () => {
    expect(isTimeoutFailure({
      stdout: 'FAIL tools/pg-oracle.test.mjs > statement timeout',
      stderr: 'AssertionError: expected null to equal a versioned value',
    })).toBe(false)
    expect(isTimeoutFailure({
      stdout: 'Test timed out in 360000ms.',
      stderr: '',
    })).toBe(true)
  })

  it('states exact mutated-line and target-file fractions', () => {
    expect(coverageSummary([
      { file: 'src/a.ts', line: 2 },
      { file: 'src/a.ts', line: 2 },
      { file: 'src/b.ts', line: 7 },
    ], {
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      nonblankLines: 200,
    })).toEqual({
      mutationSites: 3,
      mutatedLines: 2,
      totalNonblankLines: 200,
      lineFraction: 0.01,
      targetFiles: 2,
      totalFiles: 4,
      fileFraction: 0.5,
    })
  })

  it('renders escaped survivor details in the oracle-style divergence table', () => {
    expect(markdownMutationTable([{
      file: 'src/a.ts',
      line: 9,
      operator: 'GUARD',
      description: 'remove a | risk',
      shouldCatch: 'action spine\nsemantic invariant',
    }])).toBe([
      '| Rank | File | Line | Operator | Mutation | What should have caught it |',
      '|---:|---|---:|---|---|---|',
      '| — | src/a.ts | 9 | GUARD | remove a \\| risk | action spine<br>semantic invariant |',
    ].join('\n'))
  })
})
