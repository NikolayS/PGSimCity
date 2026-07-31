import { describe, expect, it } from 'vitest'

import { createStatementReplay } from './architecture.js'
import {
  VIEWING_RATES,
  nudgeViewingRate,
  stageWallDurationMs,
  viewingElapsed,
} from './playback.js'

const REPORT = Object.freeze({
  source: 'postgres',
  sql: 'SELECT * FROM accounts WHERE id = 42;',
  error: null,
  results: [
    {
      source: 'postgres',
      fields: [{ name: 'id', dataTypeId: 23 }],
      rows: [{ id: 42 }],
      affectedRows: null,
    },
  ],
  plan: {
    source: 'postgres',
    planningTimeMs: 0.35,
    executionTimeMs: 1.8,
    buffers: {
      source: 'postgres',
      sharedHits: 12,
      sharedReads: 3,
    },
    root: {
      nodeType: 'Index Scan',
      actualRows: 1,
      actualLoops: 1,
    },
  },
})

describe('machine room viewing speed', () => {
  it('uses the city speed stops and moves between them', () => {
    expect(VIEWING_RATES).toEqual([0.1, 0.25, 0.5, 1, 2, 3, 5])
    expect(nudgeViewingRate(1, -1)).toBe(0.5)
    expect(nudgeViewingRate(1, 1)).toBe(2)
    expect(nudgeViewingRate(0.1, -1)).toBe(0.1)
    expect(nudgeViewingRate(5, 1)).toBe(5)
  })

  it('scales only elapsed viewing time and stops it while paused', () => {
    for (const rate of VIEWING_RATES) {
      expect(viewingElapsed(0.2, rate, false)).toBeCloseTo(0.2 * rate)
      expect(viewingElapsed(0.2, rate, true)).toBe(0)
    }
    expect(viewingElapsed(10, 1, false)).toBe(2)
  })

  it('changes wall-clock stage duration without changing the PostgreSQL receipt', () => {
    const replay = createStatementReplay(REPORT)
    const receipt = replay.receipt
    const client = replay.stages.find((stage) => stage.id === 'client')

    expect(client).toBeDefined()
    expect(VIEWING_RATES.map((rate) => stageWallDurationMs(client.durationMs, rate)))
      .toEqual([6500, 2600, 1300, 650, 325, 650 / 3, 130])
    expect(replay.receipt).toBe(receipt)
    expect(replay.receipt).toEqual({
      source: 'postgres',
      sharedHits: 12,
      sharedReads: 3,
      planningTimeMs: 0.35,
      executionTimeMs: 1.8,
      rows: 1,
      rowLabel: 'RESULT ROWS',
      planNode: 'Index Scan',
    })
  })
})
