import { describe, expect, it } from 'vitest'

import { ARCHITECTURE_LAYOUT, contains } from './architecture.js'

describe('Magnum PostgreSQL architecture containment', () => {
  it('puts every shared structure inside one visible shared-memory segment', () => {
    const { sharedMemory, bufferPool, walBuffers, procArray, lockTable, pgXact } =
      ARCHITECTURE_LAYOUT

    expect([
      bufferPool,
      walBuffers,
      procArray,
      lockTable,
      pgXact,
    ].every((box) => contains(sharedMemory, box))).toBe(true)
  })

  it('keeps backend-private memory outside shared memory', () => {
    const { sharedMemory, privateMemory } = ARCHITECTURE_LAYOUT

    expect(contains(sharedMemory, privateMemory)).toBe(false)
    expect(privateMemory.y + privateMemory.height).toBeLessThan(sharedMemory.y)
  })
})
