import { describe, expect, it } from 'vitest'

import { BUF_GRID } from '../core/types'
import { rakingShadowTileIndices } from './shmem'

describe('shared-buffer raking shadow catch', () => {
  it('runs sparse north-west to south-east bands across the plaza', () => {
    const indices = [...rakingShadowTileIndices()]
    expect(indices.length).toBeGreaterThan(60)
    expect(indices.length).toBeLessThan(300)

    const averageColumn = (rowsFrom: number, rowsTo: number): number => {
      const columns = indices
        .filter((index) => {
          const row = Math.floor(index / BUF_GRID)
          return row >= rowsFrom && row < rowsTo
        })
        .map((index) => index % BUF_GRID)
      return columns.reduce((sum, column) => sum + column, 0) / columns.length
    }

    expect(averageColumn(BUF_GRID - 8, BUF_GRID) - averageColumn(0, 8)).toBeGreaterThan(10)
  })
})
