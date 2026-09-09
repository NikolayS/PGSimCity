import { describe, expect, it } from 'vitest'
import { CHAPTERS } from '../ui/tour'
import { SCENARIOS } from './scenarios'

describe('snapshot blocker narration', () => {
  it('establishes a retained snapshot, not merely BEGIN, in the opening note', () => {
    const scenario = SCENARIOS.find(s => s.id === 'xmin-horizon')!
    const opening = scenario.beats![0].slice(1).join(' ')
    expect(opening).toContain('REPEATABLE READ')
    expect(opening).toContain('SELECT')
    expect(opening).toContain('READ COMMITTED')
    expect(opening).not.toContain('Somebody typed BEGIN')
  })

  it('teaches the same snapshot prerequisite in the guided tour', () => {
    const chapter = CHAPTERS.find(c => c.id === 'horizon')!
    expect(chapter.body).toContain('REPEATABLE READ')
    expect(chapter.body).toContain('SELECT')
    expect(chapter.body).toContain('READ COMMITTED')
  })
})
