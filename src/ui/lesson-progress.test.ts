import { describe, expect, it } from 'vitest'
import { beginAttempt, emptyProgress, parseProgress, recordRecovery } from './lesson-progress'

describe('local two-case investigation progress', () => {
  it('counts verified first-encounter challenge recovery separately from repeats and hints', () => {
    const first = beginAttempt(emptyProgress(), 'vacuum-report', 'challenge')
    expect(first.attempt.firstEncounter).toBe(true)
    const done = recordRecovery(first.progress, first.attempt, true)
    expect(done['vacuum-report']).toEqual({ attempts: 1, recovered: true, firstChallengeRecovery: true })
    expect(recordRecovery(first.progress, { ...first.attempt, usedHints: true }, true)['vacuum-report'].firstChallengeRecovery).toBe(false)
    const repeat = beginAttempt(first.progress, 'vacuum-report', 'challenge')
    expect(repeat.attempt.firstEncounter).toBe(false)
    expect(recordRecovery(repeat.progress, repeat.attempt, true)['vacuum-report'].firstChallengeRecovery).toBe(false)
  })

  it('cannot credit an unverified outcome or guided attempt as unassisted first challenge', () => {
    const first = beginAttempt(emptyProgress(), 'vacuum-blockade', 'guided')
    expect(recordRecovery(first.progress, first.attempt, false)).toEqual(first.progress)
    expect(recordRecovery(first.progress, first.attempt, true)['vacuum-blockade'])
      .toEqual({ attempts: 1, recovered: true, firstChallengeRecovery: false })
  })

  it('only accepts bounded versioned aggregate local data', () => {
    const progress = beginAttempt(emptyProgress(), 'vacuum-report', 'challenge').progress
    expect(parseProgress(JSON.stringify({ version: 1, cases: progress }))).toEqual(progress)
    for (const data of ['', '{}', 'null', '{', JSON.stringify({ version: 2, cases: progress }),
      JSON.stringify({ version: 1, cases: { ...progress, 'vacuum-report': { attempts: -1 } } }), 'x'.repeat(2049)]) {
      expect(parseProgress(data)).toEqual(emptyProgress())
    }
    const foreign = { ...progress, sql: 'private text' }
    expect(parseProgress(JSON.stringify({ version: 1, cases: foreign }))).toEqual(progress)
  })
})
