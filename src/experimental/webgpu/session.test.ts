import { describe, expect, it, vi } from 'vitest'
import { createLabSession } from './session'

describe('explicit renderer experiment boundary', () => {
  it('does not import or probe a renderer before user action', () => {
    const load = vi.fn()
    createLabSession(load)
    expect(load).not.toHaveBeenCalled()
  })
  it('starts once even when the start button is clicked twice', async () => {
    const load = vi.fn(async () => 'webgl2' as const)
    const session = createLabSession(load)
    await Promise.all([session.start(), session.start()])
    expect(load).toHaveBeenCalledTimes(1)
    expect(session.state()).toEqual({ status: 'ready', backend: 'webgl2' })
  })
  it('reports failure without redirecting or retry loops', async () => {
    const session = createLabSession(async () => { throw new Error('device denied') })
    await session.start()
    expect(session.state()).toEqual({ status: 'unavailable' })
    await session.start()
    expect(session.state()).toEqual({ status: 'unavailable' })
  })
})
