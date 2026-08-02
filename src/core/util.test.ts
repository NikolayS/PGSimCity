import { describe, expect, it, vi } from 'vitest'

import { pushHistory } from './util'

describe('pushHistory', () => {
  it('reuses a full history without splice allocation', () => {
    const history = [1, 2, 3]
    const splice = vi.spyOn(history, 'splice')

    pushHistory(history, 4, 3)

    expect(history).toEqual([2, 3, 4])
    expect(splice).not.toHaveBeenCalled()
  })
})
