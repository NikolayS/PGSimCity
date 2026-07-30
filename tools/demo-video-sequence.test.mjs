import { describe, expect, it } from 'vitest'
import { fullReportProblems, measureWallProof } from './demo-video-sequence.mjs'

describe('demo wall-collision proof', () => {
  it('separates stopped wall-normal travel from lateral sliding', () => {
    const proof = measureWallProof(
      { x: -161.85, z: -42.4 },
      { x: -161.85, z: -39.0 },
      { x: 1, z: 0 },
      -161.5,
    )

    expect(proof.towardWallMetres).toBeCloseTo(0)
    expect(proof.lateralMetres).toBeCloseTo(3.4)
    expect(proof.wallGapMetres).toBeCloseTo(0.35)
  })

  it('rejects a full-film collision proof that still slides during the hold', () => {
    const stopped = {
      totalMetres: 8,
      lastSecondTowardWallMetres: 0,
      lastSecondLateralMetres: 0,
      finalWallGapMetres: 0.35,
    }
    const collision = Object.fromEntries(
      ['backends', 'checkpointer', 'maintenance', 'standby', 'wal', 'query-lab']
        .map((id) => [id, { ...stopped }]),
    )
    collision.checkpointer.lastSecondLateralMetres = 0.4

    const problems = fullReportProblems({
      collision,
      labels: { maxDistrictLabels: 0 },
      body: { visible: true },
      lever: {
        approachSeen: true,
        operateSeen: true,
        before: true,
        after: false,
        activeAfterWait: 0,
      },
      door: { inside: true, mapVisible: true, maxOpenness: 1 },
      environment: { themes: [{ mode: 'day' }, { mode: 'night' }] },
    })

    expect(problems).toEqual(['checkpointer: slid during the final hold'])
  })
})
