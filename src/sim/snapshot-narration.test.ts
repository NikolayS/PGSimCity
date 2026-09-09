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
    expect(opening).toMatch(/SELECT established the snapshot it still holds/)
    expect(opening).toMatch(/Plain BEGIN at READ COMMITTED does not do this/)
  })

  it('teaches the same snapshot prerequisite in the guided tour', () => {
    const chapter = CHAPTERS.find(c => c.id === 'horizon')!
    expect(chapter.body).toContain('REPEATABLE READ')
    expect(chapter.body).toContain('SELECT')
    expect(chapter.body).toContain('READ COMMITTED')
    expect(chapter.body).toMatch(/SELECT established a snapshot retained until transaction end/)
    expect(chapter.body).toMatch(/if no other older horizon remains.*later vacuum pass/)
  })
  it('distinguishes modeled scanning and conditional eligibility from actual collection', () => {
    const beats = SCENARIOS.find(s => s.id === 'xmin-horizon')!.beats!
    const scan = beats.find(b => b[0] === 30)![2]
    expect(scan).not.toMatch(/scan the whole heap/)
    const release = beats.find(b => b[0] === 108)![2]
    expect(release).toMatch(/If this was the oldest blocker/)
    expect(release).toMatch(/eligible for cleanup; a later vacuum pass/)
    expect(release).not.toMatch(/every dead row becomes removable at once/)
  })
})
