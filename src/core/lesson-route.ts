export type LessonMode = 'guided' | 'challenge'

const PREFIX = '#lesson/vacuum-blockade/'

export function lessonHref(mode: LessonMode): string {
  return `${PREFIX}${mode}`
}

export function lessonShareUrl(currentHref: string, mode: LessonMode): string {
  const url = new URL(currentHref)
  url.search = ''
  url.hash = lessonHref(mode)
  return url.href
}

export function lessonMode(hash: string): LessonMode | null {
  if (hash === lessonHref('guided')) return 'guided'
  if (hash === lessonHref('challenge')) return 'challenge'
  return null
}

export function installLessonRoutes(options: {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  location: { hash: string }
  open(mode: LessonMode): void
}): () => void {
  const sync = (): void => {
    const mode = lessonMode(options.location.hash)
    if (mode) options.open(mode)
  }
  options.target.addEventListener('hashchange', sync)
  sync()
  return () => options.target.removeEventListener('hashchange', sync)
}
