import { describe, expect, it, vi } from 'vitest'

import { installLessonRoutes, lessonHref, lessonMode, lessonShareUrl } from './lesson-route'

describe('shareable vacuum investigation', () => {
  it('shares only the lesson and mode, dropping current query input and replay state', () => {
    expect(lessonShareUrl('https://example.org/PGSimCity/?sql=private#replay/private', 'challenge'))
      .toBe('https://example.org/PGSimCity/#lesson/vacuum-blockade/challenge')
  })

  it.each(['guided', 'challenge'] as const)('round-trips %s without session data', (mode) => {
    expect(lessonMode(lessonHref(mode))).toBe(mode)
    expect(lessonHref(mode)).toBe(`#lesson/vacuum-blockade/${mode}`)
  })

  it.each(['', '#lesson/vacuum-blockade', '#lesson/vacuum-blockade/expert',
    '#lesson/vacuum-blockade/challenge?sql=select', '#lesson/unknown/guided',
    '#lesson/vacuum-blockade/%67uided'])('ignores unsupported input %s', (hash) => {
    expect(lessonMode(hash)).toBeNull()
  })

  it('opens the chosen mode on arrival or hash change and removes its listener', () => {
    const target = new EventTarget()
    const location = { hash: lessonHref('challenge') }
    const open = vi.fn()
    const dispose = installLessonRoutes({ target, location, open })
    expect(open).toHaveBeenCalledExactlyOnceWith('challenge')
    location.hash = lessonHref('guided')
    target.dispatchEvent(new Event('hashchange'))
    expect(open).toHaveBeenLastCalledWith('guided')
    location.hash = '#component/storage.table.sessions'
    target.dispatchEvent(new Event('hashchange'))
    expect(open).toHaveBeenCalledTimes(2)
    dispose()
    location.hash = lessonHref('challenge')
    target.dispatchEvent(new Event('hashchange'))
    expect(open).toHaveBeenCalledTimes(2)
  })
})
