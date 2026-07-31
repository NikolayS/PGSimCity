import { describe, expect, it } from 'vitest'
import {
  fullReportProblems,
  measureWallProof,
  reservedCaptionPlace,
} from './demo-video-sequence.mjs'

describe('demo caption layout', () => {
  it('reserves the top band when the walk-up prompt owns the bottom band', () => {
    expect(reservedCaptionPlace('bottom', true)).toBe('top')
    expect(reservedCaptionPlace('top', true)).toBe('top')
    expect(reservedCaptionPlace('bottom', false)).toBe('bottom')
  })
})

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
      operatorDecision: {
        phaseSeen: 'ready',
        choiceCount: 2,
        choicesVisible: true,
        choiceMade: null,
      },
      failover: {
        forkSeen: true,
        lossTransactions: 3,
        lossBytes: 4096,
        formerPrimaryDiverged: true,
        rewindStarted: true,
        rewindComplete: true,
      },
      swim: {
        gaitSeen: true,
        submergedSeen: true,
        dragSeen: true,
        buoyancySeen: true,
        audioCaptured: true,
      },
      environment: { themes: [{ mode: 'day' }, { mode: 'night' }] },
      captions: { checkedFrames: 147 * 30, overlapFrames: 0 },
    })

    expect(problems).toEqual(['checkpointer: slid during the final hold'])
  })

  it('rejects a full film that does not prove the new v0.27.0 segments', () => {
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

    const problems = fullReportProblems({
      collision,
      labels: { maxDistrictLabels: 0 },
      body: { visible: false },
      lever: {
        approachSeen: true,
        operateSeen: true,
        before: true,
        after: false,
        activeAfterWait: 0,
      },
      door: { inside: true, mapVisible: true, maxOpenness: 1 },
      operatorDecision: {
        phaseSeen: 'staging',
        choiceCount: 1,
        choicesVisible: false,
        choiceMade: 'terminate-transaction',
      },
      failover: {
        forkSeen: false,
        lossTransactions: 0,
        lossBytes: 0,
        formerPrimaryDiverged: false,
        rewindStarted: false,
        rewindComplete: false,
      },
      swim: {
        gaitSeen: true,
        submergedSeen: false,
        dragSeen: false,
        buoyancySeen: false,
        audioCaptured: false,
      },
      environment: { themes: [{ mode: 'day' }, { mode: 'night' }] },
      captions: { checkedFrames: 158 * 30, overlapFrames: 0 },
    })

    expect(problems).toEqual([
      'operator decision did not show both unchosen branch costs',
      'failover did not show a non-zero timeline fork loss',
      'former primary divergence/pg_rewind proof was incomplete',
      'swim drag/buoyancy/submersion proof was incomplete',
      'swim audio was not captured from the app',
    ])
  })
})
