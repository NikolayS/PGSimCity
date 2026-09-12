import { describe, expect, it } from 'vitest'

import { InspectionHistory } from './inspection-history'

describe('InspectionHistory', () => {
  it('returns through inspected components without repeating revisits', () => {
    const history = new InspectionHistory(4)

    history.visit('shared.buffers')
    history.visit('checkpointer')
    history.visit('walwriter')
    history.visit('checkpointer')

    expect(history.back()).toBe('walwriter')
    expect(history.back()).toBe('shared.buffers')
    expect(history.back()).toBeNull()
  })

  it('keeps only the configured number of previous components', () => {
    const history = new InspectionHistory(2)

    history.visit('a')
    history.visit('b')
    history.visit('c')
    history.visit('d')

    expect(history.back()).toBe('c')
    expect(history.back()).toBe('b')
    expect(history.back()).toBeNull()
  })

  it('does not add the current component twice and can reset at the city', () => {
    const history = new InspectionHistory()

    history.visit('a')
    history.visit('a')
    history.visit('b')
    history.reset()

    expect(history.canGoBack).toBe(false)
    expect(history.back()).toBeNull()
  })
})
