export type LessonMode = 'guided' | 'challenge'
export type LessonId = 'vacuum-blockade' | 'vacuum-report'

export function lessonHref(mode: LessonMode, lesson: LessonId = 'vacuum-blockade'): string {
  return `#lesson/${lesson}/${mode}`
}

export function lessonShareUrl(currentHref: string, mode: LessonMode, lesson: LessonId = 'vacuum-blockade'): string {
  const url = new URL(currentHref)
  url.search = ''
  url.hash = lessonHref(mode, lesson)
  return url.href
}

export function lessonMode(hash: string): LessonMode | null {
  for (const lesson of ['vacuum-blockade', 'vacuum-report'] as const) {
    if (hash === lessonHref('guided', lesson)) return 'guided'
    if (hash === lessonHref('challenge', lesson)) return 'challenge'
  }
  return null
}

export function installLessonRoutes(options: {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  location: { hash: string }
  open(mode: LessonMode, lesson: LessonId): void
}): () => void {
  const sync = (): void => {
    const mode = lessonMode(options.location.hash)
    if (mode) options.open(mode, options.location.hash.startsWith('#lesson/vacuum-report/') ? 'vacuum-report' : 'vacuum-blockade')
  }
  options.target.addEventListener('hashchange', sync)
  sync()
  return () => options.target.removeEventListener('hashchange', sync)
}
