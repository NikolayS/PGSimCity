import type { VacuumLessonMode } from './vacuum-lesson-state'

export const LESSON_CASES = ['vacuum-blockade', 'vacuum-report'] as const
export type LessonCase = typeof LESSON_CASES[number]
interface CaseProgress { attempts: number; recovered: boolean; firstChallengeRecovery: boolean }
export type LessonProgress = Record<LessonCase, CaseProgress>
export interface LessonAttempt {
  lesson: LessonCase
  initialMode: VacuumLessonMode
  firstEncounter: boolean
  usedHints: boolean
}

export function emptyProgress(): LessonProgress {
  return {
    'vacuum-blockade': { attempts: 0, recovered: false, firstChallengeRecovery: false },
    'vacuum-report': { attempts: 0, recovered: false, firstChallengeRecovery: false },
  }
}

export function parseProgress(raw: string | null): LessonProgress {
  const result = emptyProgress()
  if (!raw || raw.length > 2048) return result
  try {
    const data = JSON.parse(raw)
    if (data?.version !== 1 || !data.cases) return result
    for (const lesson of LESSON_CASES) {
      const item = data.cases[lesson]
      if (!item || !Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 1_000_000
        || typeof item.recovered !== 'boolean' || typeof item.firstChallengeRecovery !== 'boolean') return emptyProgress()
      result[lesson] = { attempts: item.attempts, recovered: item.recovered, firstChallengeRecovery: item.firstChallengeRecovery }
    }
    return result
  } catch { return result }
}

export function beginAttempt(progress: LessonProgress, lesson: LessonCase, mode: VacuumLessonMode): {
  progress: LessonProgress; attempt: LessonAttempt
} {
  const previous = progress[lesson]
  return {
    progress: { ...progress, [lesson]: { ...previous, attempts: Math.min(1_000_000, previous.attempts + 1) } },
    attempt: { lesson, initialMode: mode, firstEncounter: previous.attempts === 0, usedHints: mode === 'guided' },
  }
}

export function recordRecovery(progress: LessonProgress, attempt: LessonAttempt, verified: boolean): LessonProgress {
  if (!verified) return progress
  const previous = progress[attempt.lesson]
  return { ...progress, [attempt.lesson]: {
    ...previous, recovered: true,
    firstChallengeRecovery: previous.firstChallengeRecovery
      || (attempt.firstEncounter && attempt.initialMode === 'challenge' && !attempt.usedHints),
  } }
}
