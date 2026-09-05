import '../styles/vacuum-lesson.css'

import type { SimState } from '../core/types'
import { lessonShareUrl } from '../core/lesson-route'
import { beginAttempt, emptyProgress, LESSON_CASES, parseProgress, recordRecovery,
  type LessonAttempt, type LessonCase } from './lesson-progress'
import { fmtBytes, fmtNum, reduceMotion } from '../core/util'
import {
  canChooseVacuumAction, chooseVacuumAction, collectVacuumEvidence,
  createVacuumLessonState, rebindVacuumLesson, selectVacuumCause, vacuumEvidenceAvailable,
  verifyVacuumRecovery, VACUUM_EVIDENCE,
  type VacuumAction, type VacuumCause, type VacuumEvidenceId,
  type VacuumLessonMode, type VacuumReading,
} from './vacuum-lesson-state'
import { el, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

export interface VacuumLessonModule extends UiModule {
  open(mode?: VacuumLessonMode, lesson?: LessonCase): void
  close(): void
  isOpen(): boolean
  rebind(): void
}

export interface VacuumLessonProgress {
  event: 'started' | 'hint-used' | 'evidence-collected' | 'recovery-verified' | 'completed'
  mode: VacuumLessonMode
  lesson: LessonCase
  firstEncounter: boolean
  unassisted: boolean
}

export interface VacuumLessonOptions {
  onProgress?: (progress: VacuumLessonProgress) => void
  isReplaying?: () => boolean
  /** The replay controller records each fixed step and releases ownership synchronously on abort. */
  advanceUntil?: (
    condition: () => boolean,
    options: { maxTicks: number; signal: AbortSignal },
  ) => Promise<'condition' | 'cancelled' | 'limit'>
}

const TABLE = 'storage.table.sessions'
const EVIDENCE_COPY: Record<VacuumEvidenceId, { title: string; source: string; guidance: string; focus: string }> = {
  table: {
    title: 'Table health', source: 'Live model · pg_stat_user_tables vocabulary', focus: TABLE,
    guidance: 'Compare old row versions with the start of this attempt. A rising count tells you cleanup is falling behind; it does not tell you why.',
  },
  worker: {
    title: 'Vacuum work', source: 'Observed model worker · pg_stat_progress_vacuum vocabulary', focus: 'autovac.launcher',
    guidance: 'A worker can scan a table while old versions remain. Running and successfully reclaiming space are different observations.',
  },
  snapshot: {
    title: 'Open transactions', source: 'Live model · transaction and snapshot state', focus: 'proc.array',
    guidance: 'This REPEATABLE READ transaction retains an old snapshot. Compare it with the cleanup horizon: versions it might still need must remain.',
  },
  owner: {
    title: 'Owner’s incident note', source: 'Authored scenario context · not a database measurement', focus: 'proc.array',
    guidance: 'An old transaction is not automatically safe to terminate. Confirm the session, its owner and the consequences of aborting its work.',
  },
}

export function createVacuumLesson(ctx: UiContext, options: VacuumLessonOptions = {}): VacuumLessonModule {
  let opened = false
  let changingScenario = false
  let changingTiming = false
  let ownedDecision: SimState['scenarioDecision'] = null
  let state = createVacuumLessonState('guided')
  let localProgress = emptyProgress()
  try { localProgress = parseProgress(window.localStorage.getItem('pgsimcity.lessons.v1')) } catch { /* Storage is optional. */ }
  let attempt: LessonAttempt = { lesson: 'vacuum-blockade', initialMode: 'guided', firstEncounter: true, usedHints: true }
  let recoveryRecorded = false
  let activeAdvance: AbortController | null = null
  let selected: VacuumEvidenceId = 'table'
  let lastFocus: HTMLElement | null = null
  let savedPaused = false
  let savedTimeScale = 1
  let restorePaused = false
  let restoreTimeScale = false
  let refreshIn = 0
  let observedWorker = ''
  let observedWorkerSlot = -1
  let tableIndex = 0
  const reading: VacuumReading = {
    time: 0, deadRows: 0, initialDeadRows: 0, pages: 0, initialPages: 0,
    scanObserved: false, snapshotAge: 0, horizon: 0, pinned: false,
    decisionReady: false, reclaimed: 0, recovered: false,
  }

  const title = el('h2', { id: 'vacuum-lesson-title', tabindex: '-1', text: 'Autovacuum is running. Why is this table still growing?' })
  const modeLabel = el('span', { class: 'vacuum-lesson__mode' })
  const clock = el('span', { class: 'vacuum-lesson__clock' })
  const phaseLabel = el('p', { class: 'vacuum-lesson__step' })
  const campaignProgress = el('p', { class: 'vacuum-lesson__source', data: { vacuumProgress: '' } })
  const closeButton = el('button', {
    type: 'button', class: 'pg-btn vacuum-lesson__close', text: 'Exit',
    'aria-label': 'Exit the vacuum investigation', on: { click: () => close() },
  })
  const evidenceTitle = el('h3', { id: 'vacuum-evidence-title' })
  const evidenceSource = el('p', { class: 'vacuum-lesson__source' })
  const evidenceReading = el('p', { class: 'vacuum-lesson__reading' })
  const guidance = el('p', { class: 'vacuum-lesson__guidance' })
  const announcement = el('p', { class: 'vacuum-lesson__announcement', role: 'status', 'aria-live': 'polite' })
  const notebook = el('ol', { class: 'vacuum-lesson__notebook', data: { vacuumNotebook: '' } })
  const notebookSummary = el('summary', { text: 'Evidence notebook · 0 of 4' })
  const notes = el('textarea', {
    id: 'vacuum-personal-notes', rows: 3, maxlength: 4000,
    placeholder: 'Your explanation, questions or next checks…', data: { vacuumNotes: '' },
  })
  const recordButton = el('button', {
    type: 'button', class: 'pg-btn vacuum-lesson__primary', data: { vacuumRecord: '' },
    on: { click: recordEvidence },
  })
  const evidenceButtons = new Map<VacuumEvidenceId, HTMLButtonElement>()
  const evidenceNav = el('nav', { class: 'vacuum-lesson__evidence', 'aria-label': 'Investigation evidence' })
  for (const id of VACUUM_EVIDENCE) {
    const button = el('button', {
      type: 'button', class: 'vacuum-lesson__evidence-button',
      text: EVIDENCE_COPY[id].title, data: { vacuumEvidence: id },
      'aria-controls': 'vacuum-evidence-detail', 'aria-pressed': 'false',
      on: { click: () => inspect(id) },
    })
    evidenceButtons.set(id, button)
    evidenceNav.append(button)
  }
  const evidenceDetail = el('section', {
    id: 'vacuum-evidence-detail', class: 'vacuum-lesson__detail', 'aria-labelledby': 'vacuum-evidence-title',
  }, evidenceSource, evidenceTitle, evidenceReading, guidance, recordButton)

  const causeFeedback = el('p', { class: 'vacuum-lesson__feedback' })
  const causes = el('section', { class: 'vacuum-lesson__causes' },
    el('h3', { text: 'What is preventing cleanup?' }),
  )
  const causeButtons = new Map<VacuumCause, HTMLButtonElement>()
  for (const [cause, text] of [
    ['disabled', 'Autovacuum is switched off'],
    ['snapshot', 'An older snapshot still needs the row versions'],
    ['capacity', 'The table only needs more disk capacity'],
  ] as const) {
    const button = el('button', {
      type: 'button', class: 'pg-btn vacuum-lesson__answer', text,
      data: { vacuumCause: cause }, 'aria-pressed': 'false',
      on: { click: () => { state = selectVacuumCause(state, cause); render() } },
    })
    causeButtons.set(cause, button)
    causes.append(button)
  }
  causes.append(causeFeedback)

  const terminateButton = actionButton('terminate', 'End this session')
  const waitButton = actionButton('wait', 'Keep the transaction open')
  const decisionContext = el('p')
  const decisionStatus = el('p', { class: 'vacuum-lesson__source' })
  const decision = el('section', { class: 'vacuum-lesson__decision' },
    el('h3', { text: 'Choose an intervention' }),
    decisionContext,
    terminateButton, waitButton, decisionStatus,
  )
  const result = el('p', { class: 'vacuum-lesson__result', data: { vacuumResult: '' } })
  const resourceOutcome = el('p', { class: 'vacuum-lesson__source', data: { vacuumResources: '' } })
  const recoverButton = el('button', {
    type: 'button', class: 'pg-btn vacuum-lesson__primary', text: 'End the abandoned session now',
    data: { vacuumRecover: '' }, on: { click: () => {
      if (state.phase !== 'observing' || !state.evidence.owner || !ctx.sim.recoverScenario()) return
      announce('The abandoned transaction has ended. Now verify that cleanup actually resumes.')
      focus(TABLE)
      refresh()
    } },
  })
  const verifyButton = el('button', {
    type: 'button', class: 'pg-btn vacuum-lesson__primary', text: 'Check whether cleanup resumed',
    data: { vacuumVerify: '' }, on: { click: verify },
  })
  const advanceButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Advance model until cleanup', data: { vacuumAdvance: '' },
    on: { click: () => { void advanceToCleanup() } },
  })
  const stopAdvanceButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Stop advancing', data: { vacuumAdvanceStop: '' },
    on: { click: () => activeAdvance?.abort() },
  })
  const advanceDisclosure = el('p', {
    class: 'vacuum-lesson__source', data: { vacuumAdvanceDisclosure: '' },
    text: 'Advances model time in recorded 1/30-second steps, without changing workload or vacuum speed. You can stop it. Cleanup must occur in the model; this does not verify the lesson for you.',
  })
  const observation = el('section', { class: 'vacuum-lesson__observation' },
    el('h3', { text: 'Verify the outcome' }), result, resourceOutcome, recoverButton,
    advanceButton, stopAdvanceButton, advanceDisclosure, verifyButton,
  )
  const pauseButton = el('button', {
    type: 'button', class: 'pg-btn', data: { vacuumPause: '' }, on: { click: () => {
      setTiming('paused', !ctx.sim.state.knobs.paused)
      refresh()
    } },
  })
  const pageButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Inspect a page and its row versions', data: { vacuumPage: '' },
    on: { click: () => ctx.bus.emit('anatomy:open', { view: 'page', id: TABLE }) },
  })
  const hintButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Use guided explanations', data: { vacuumHint: '' },
    on: { click: () => {
      if (state.mode !== 'challenge' || state.phase !== 'investigating') return
      attempt.usedHints = true
      progress('hint-used')
      state = { ...state, mode: 'guided' }
      render()
    } },
  })
  const retryButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Start another attempt', data: { vacuumRetry: '' },
    on: { click: () => { const { mode, lesson } = state; close(); open(mode, lesson) } },
  })
  const challengeButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Start a challenge attempt',
    on: { click: () => { const lesson = state.lesson; close(); open('challenge', lesson) } },
  })
  const shareButton = el('button', {
    type: 'button', class: 'pg-btn', text: 'Share this lesson',
    on: { click: async () => {
      const url = lessonShareUrl(window.location.href, state.mode, state.lesson)
      try {
        await navigator.clipboard.writeText(url)
        announce('Lesson link copied. It opens a new attempt in this mode; notes and current model state are not included.')
      } catch {
        shareLink.href = url
        shareLink.hidden = false
        announce('Clipboard unavailable. Copy the lesson link below; it does not include your notes or current model state.')
      }
    } },
  })
  const shareLink = el('a', { class: 'pg-btn', text: 'Open a new attempt', hidden: true })
  const otherCase = el('button', {
    type: 'button', class: 'pg-btn', data: { vacuumNext: '' },
    on: { click: () => { const lesson = state.lesson === 'vacuum-blockade' ? 'vacuum-report' : 'vacuum-blockade'; close(); open('challenge', lesson) } },
  })
  const retry = el('div', { class: 'vacuum-lesson__retry' }, retryButton,
    el('p', { text: 'A new attempt uses the city’s current state and clears this notebook. It does not rewind the previous workload.' }),
  )
  const disclosure = el('p', {
    class: 'vacuum-lesson__disclosure', data: { disclosure: 'vacuum-model' },
    text: 'City model, not PostgreSQL execution. Pages and row versions are representative samples; relation counts are aggregate model state. VACUUM normally makes space reusable inside the file. A smaller file is not required to verify cleanup.',
  })
  const panel = el('section', {
    class: 'vacuum-lesson pg-panel', hidden: true, 'aria-labelledby': 'vacuum-lesson-title',
  },
  el('header', { class: 'vacuum-lesson__head' },
    el('div', { class: 'vacuum-lesson__meta' }, modeLabel, clock), closeButton, title, phaseLabel),
  el('div', { class: 'vacuum-lesson__body' },
    evidenceNav, evidenceDetail, causes, decision, observation, announcement,
    el('div', { class: 'vacuum-lesson__tools' }, pageButton, pauseButton, hintButton, challengeButton, shareButton, shareLink),
    el('details', { class: 'vacuum-lesson__notes' }, notebookSummary, notebook,
      el('label', { htmlFor: 'vacuum-personal-notes', text: 'Your notes' }), notes,
      el('p', { text: 'Evidence and notes stay here until you start another attempt.' })),
    retry, el('section', { class: 'vacuum-lesson__campaign' },
      el('h3', { text: 'Two-case operations practice' }), campaignProgress, otherCase,
      el('p', { text: 'Objective: establish the cause, respect the owner’s requirement, then verify cleanup. These local completion observations are not proof of learning. A new case clears the notebook and uses the current city state.' })), disclosure),
  )

  function positionPanel(): void {
    if (!opened) return
    const bottom = document.getElementById('hud-top')?.getBoundingClientRect().bottom ?? 0
    panel.style.setProperty('--vacuum-top', `${Math.max(78, Math.ceil(bottom) + 12)}px`)
  }
  const toolbar = document.getElementById('hud-top')
  const toolbarObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(positionPanel)
  if (toolbar) toolbarObserver?.observe(toolbar)
  window.addEventListener('resize', positionPanel)

  function announce(text: string): void { setText(announcement, text) }

  function progress(event: VacuumLessonProgress['event']): void {
    try { options.onProgress?.({ event, mode: state.mode, lesson: state.lesson,
      firstEncounter: attempt.firstEncounter, unassisted: attempt.initialMode === 'challenge' && !attempt.usedHints }) } catch {
      /* Optional aggregate analytics must never interrupt the model path. */
    }
  }

  function saveProgress(): void {
    try { window.localStorage.setItem('pgsimcity.lessons.v1', JSON.stringify({ version: 1, cases: localProgress })) } catch {
      /* Local progress is optional and contains no notebook, SQL or user identifier. */
    }
  }

  function focus(id: string): void {
    ctx.bus.emit('select', { id, outlineOnly: true })
    ctx.bus.emit('focus', { id, instant: reduceMotion() || ctx.getQuality().level === 'reduced' })
  }

  function setTiming(key: 'paused', value: boolean): void
  function setTiming(key: 'timeScale', value: number): void
  function setTiming(key: 'paused' | 'timeScale', value: boolean | number): void {
    changingTiming = true
    if (key === 'paused') ctx.sim.setKnob(key, value as boolean)
    else ctx.sim.setKnob(key, value as number)
    changingTiming = false
  }

  function sample(): void {
    const sim = ctx.sim.state
    const table = sim.tables[tableIndex]
    reading.time = sim.scenarioT
    reading.deadRows = table.deadTuples
    reading.pages = table.pages
    reading.snapshotAge = sim.oldestSnapshotAge
    reading.horizon = sim.xminHorizon
    reading.pinned = sim.knobs.longRunningXact
    const current = sim.scenarioDecision
    reading.decisionReady = current?.kind === 'vacuum-blockade' && current.phase === 'ready'
    reading.reclaimed = current?.kind === 'vacuum-blockade' ? current.deadTuplesReclaimed : 0
    reading.recovered = current?.kind === 'vacuum-blockade' && current.phase === 'recovered'
    reading.reportStatus = current?.kind === 'vacuum-blockade' ? current.report?.status ?? null : null
    for (let i = 0; i < sim.autovac.workers.length; i++) {
      const worker = sim.autovac.workers[i]
      if (!worker.active || worker.phase === 'travel' || worker.phase === 'return' || worker.phase === 'idle') continue
      reading.scanObserved = true
      observedWorkerSlot = i
      observedWorker = `At model ${reading.time.toFixed(1)} s, AV-${i} was in ${worker.phase} on ${sim.tables[worker.table].def.name}; ${fmtNum(worker.deadCollected)} versions collected in that pass.`
      break
    }
  }

  function evidenceText(id: VacuumEvidenceId): string {
    switch (id) {
      case 'table': return `sessions: ${fmtNum(reading.deadRows)} dead row versions (${fmtNum(reading.deadRows - reading.initialDeadRows)} added since this attempt began). Relation size: ${fmtBytes(reading.pages * 8192)}, from ${fmtBytes(reading.initialPages * 8192)}. These are exact model counts; PostgreSQL’s n_dead_tup is an estimate.`
      case 'worker': return observedWorker || 'Waiting to observe a worker enter a vacuum phase. Let the model run, then record what the worker actually did.'
      case 'snapshot': {
        const backend = ctx.sim.state.backends.find((candidate) => candidate.state === 'idle_in_xact')
        return reading.pinned
          ? `${backend ? `Model backend slot ${backend.slot}: idle in transaction.` : 'The model’s long-running transaction retains a snapshot; its backend is not represented in the current visual sample.'} Oldest snapshot age: ${reading.snapshotAge.toFixed(1)} model s. Cleanup horizon: XID ${fmtNum(reading.horizon)}. This case has an old REPEATABLE READ snapshot.`
          : 'There is no retained transaction snapshot from this case now. Watch the next vacuum pass to establish whether cleanup resumes.'
      }
      case 'owner': return state.lesson === 'vacuum-report'
        ? 'Authored scenario context: the owner confirmed a required read-only report using a REPEATABLE READ transaction. The client is processing results between statements and still needs the snapshot. The owner accepts temporary relation growth and has headroom for this case. After you choose to wait, the authored client completes in 30 model seconds and ends its transaction. This is neither a pg_stat_activity prediction nor a production deadline guarantee. Termination interrupts report work, not committed database data.'
        : 'Authored scenario context: the application owner checked this case’s idle session and confirmed an abandoned, read-only REPEATABLE READ transaction. The client is gone; no uncommitted row changes need preserving. Ending the session aborts that transaction. This owner confirmation is supplied by the lesson, not measured by pg_stat_activity.'
    }
  }

  function inspect(id: VacuumEvidenceId): void {
    selected = id
    focus(id === 'worker' && observedWorkerSlot >= 0 ? `autovac.worker.${observedWorkerSlot}` : EVIDENCE_COPY[id].focus)
    refresh()
  }

  function recordEvidence(): void {
    sample()
    const next = collectVacuumEvidence(state, selected, reading, evidenceText(selected))
    if (next === state) return
    state = next
    notebook.append(el('li', {},
      el('strong', { text: `${EVIDENCE_COPY[selected].title} · model ${reading.time.toFixed(1)} s` }),
      el('p', { text: state.evidence[selected]!.text }),
    ))
    announce(`${EVIDENCE_COPY[selected].title} saved in your evidence notebook.`)
    progress('evidence-collected')
    render()
  }

  function actionButton(action: VacuumAction, text: string): HTMLButtonElement {
    return el('button', {
      type: 'button', class: 'pg-btn vacuum-lesson__answer', text, data: { vacuumAction: action },
      on: { click: () => {
        sample()
        const next = chooseVacuumAction(state, action, reading)
        if (next === state || !ctx.sim.chooseScenario(action === 'terminate' ? 'terminate-transaction' : 'wait-for-transaction')) return
        state = next
        announce(action === 'terminate'
          ? 'The transaction ended. Releasing a snapshot makes cleanup possible; it does not itself reclaim the bytes.'
          : 'You kept the transaction open. Watch the retained versions and compare the consequence with your evidence.')
        focus(TABLE)
        refresh()
      } },
    })
  }

  function verify(): void {
    sample()
    const next = verifyVacuumRecovery(state, reading)
    if (next !== state) {
      state = next
      announce('Verified: the old snapshot is gone and a modeled vacuum pass has reclaimed row versions.')
      if (!recoveryRecorded) {
        recoveryRecorded = true
        localProgress = recordRecovery(localProgress, attempt, true)
        saveProgress()
        progress('recovery-verified')
        progress('completed')
      }
    } else {
      announce(!VACUUM_EVIDENCE.every((id) => state.evidence[id])
        ? 'This restored decision has no complete evidence notebook. Rewind before the decision or start another attempt and investigate before acting.'
        : reading.reportStatus === 'interrupted'
        ? 'Cleanup alone does not meet this case’s objective: the required report was interrupted. Start another attempt to preserve its work.'
        : reading.pinned
        ? 'Not yet: the transaction still holds its old snapshot.'
        : 'Not yet: the snapshot has ended, but the model has not reported resumed cleanup. Let the worker finish its pass.')
    }
    render()
  }

  async function advanceToCleanup(): Promise<void> {
    if (!options.advanceUntil || activeAdvance || state.phase !== 'observing' || advanceButton.disabled) return
    const controller = new AbortController()
    const decision = ownedDecision
    const startedAt = ctx.sim.state.t
    activeAdvance = controller
    announce('Advancing recorded model time. The workload and vacuum pace are unchanged; use Stop advancing to return to normal playback.')
    render()
    try {
      const outcome = await options.advanceUntil(
        () => ctx.sim.state.scenarioDecision !== decision || decision?.phase === 'recovered',
        { maxTicks: 54_000, signal: controller.signal },
      )
      if (!opened || ownedDecision !== decision) return
      if (controller.signal.aborted || outcome === 'cancelled') {
        announce('Model advancement stopped. Your evidence remains available; no recovery was credited.')
        return
      }
      const elapsed = Math.max(0, ctx.sim.state.t - startedAt).toFixed(1)
      announce(outcome === 'limit'
        ? `Advanced ${elapsed} model seconds and reached the recording limit. No recovery has been credited; inspect the current evidence.`
        : `Advanced ${elapsed} model seconds. Inspect the actual cleanup result, then choose Check whether cleanup resumed to verify it.`)
    } catch {
      if (opened && ownedDecision === decision) announce('Model advancement stopped. No recovery was credited; normal playback and the evidence notebook remain available.')
    } finally {
      if (activeAdvance === controller) activeAdvance = null
      if (opened && ownedDecision === decision) refresh()
    }
  }

  function render(): void {
    panel.dataset.phase = state.phase
    const count = VACUUM_EVIDENCE.filter((id) => state.evidence[id]).length
    setText(modeLabel, state.mode === 'guided' ? 'Guided investigation' : 'Challenge · evidence first')
    setText(campaignProgress, `${LESSON_CASES.filter((lesson) => localProgress[lesson].recovered).length} / 2 cases verified locally. ${attempt.usedHints ? 'Guidance used in this attempt.' : attempt.firstEncounter ? 'First recorded attempt · no hints used.' : 'Repeat attempt · no hints used.'}`)
    setText(otherCase, state.lesson === 'vacuum-blockade' ? 'Start case 2 as a challenge' : 'Start case 1 as a challenge')
    setText(title, state.lesson === 'vacuum-report'
      ? 'The same symptom. Should this transaction end?'
      : 'Autovacuum is running. Why is this table still growing?')
    setText(clock, `${reading.time.toFixed(0)} model s`)
    setText(phaseLabel, state.phase === 'complete' ? '3 / 3 · Cleanup verified'
      : state.phase === 'observing' ? '3 / 3 · Observe and verify'
        : count === 4 ? '2 / 3 · Explain the evidence and act' : `1 / 3 · Investigate · ${count} of 4 evidence sources`)
    for (const [id, button] of evidenceButtons) {
      button.setAttribute('aria-pressed', String(id === selected))
      button.dataset.recorded = String(!!state.evidence[id])
      setText(button, `${state.evidence[id] ? '✓ ' : ''}${EVIDENCE_COPY[id].title}`)
    }
    setText(evidenceTitle, EVIDENCE_COPY[selected].title)
    setText(evidenceSource, EVIDENCE_COPY[selected].source)
    setText(evidenceReading, evidenceText(selected))
    setText(guidance, EVIDENCE_COPY[selected].guidance)
    guidance.hidden = state.mode === 'challenge'
    recordButton.hidden = state.phase !== 'investigating'
    recordButton.disabled = !!state.evidence[selected] || !vacuumEvidenceAvailable(selected, reading)
    setText(recordButton, state.evidence[selected] ? 'Evidence recorded'
      : recordButton.disabled ? 'Waiting for model evidence' : selected === 'owner' ? 'Acknowledge owner and abort consequences' : 'Record this evidence')
    setText(notebookSummary, `Evidence notebook · ${count} of 4`)
    causes.hidden = count < 4 || state.phase !== 'investigating'
    for (const [cause, button] of causeButtons) button.setAttribute('aria-pressed', String(cause === state.cause))
    setText(causeFeedback, state.cause === 'snapshot'
      ? 'Supported: the old snapshot holds the cleanup horizon back. Vacuum can scan, but must preserve versions the snapshot might still need.'
      : state.cause === 'disabled' ? 'Your worker evidence shows vacuum is running. Recheck the transaction evidence.'
        : state.cause === 'capacity' ? 'More capacity cannot advance a retained snapshot’s cleanup horizon. Recheck the transaction evidence.' : '')
    decision.hidden = causes.hidden || state.cause !== 'snapshot'
    setText(decisionContext, state.lesson === 'vacuum-report'
      ? 'Use the owner’s requirement alongside live model evidence. Both actions release the snapshot eventually, but they do not preserve the same work.'
      : 'The owner confirmed this session is abandoned. Ending it aborts its transaction; this scenario has no uncommitted row changes to preserve.')
    terminateButton.disabled = waitButton.disabled = !canChooseVacuumAction(state, reading)
    setText(decisionStatus, reading.decisionReady ? 'Both choices affect this running city model.' : 'The incident is still being established. Keep the model running; your evidence remains saved.')
    observation.hidden = state.phase === 'investigating'
    const outcome = ctx.sim.state.scenarioDecision
    setText(resourceOutcome, outcome?.kind === 'vacuum-blockade'
      ? `Resource cost since the decision: up to ${fmtBytes(outcome.pagesAdded * 8192)} additional relation pages and ${fmtNum(outcome.deadTuplesAdded)} additional dead versions across modeled tables. Both cases are authored read-only transactions: terminating them does not lose committed data. Required report work is a separate outcome.`
      : '')
    recoverButton.hidden = state.lesson === 'vacuum-report' || state.action !== 'wait' || !reading.pinned || state.phase === 'complete'
    verifyButton.hidden = state.phase === 'complete'
    verifyButton.disabled = !!activeAdvance
    advanceButton.hidden = !options.advanceUntil || state.phase === 'complete'
    advanceButton.disabled = !!activeAdvance || reading.reportStatus === 'interrupted'
      || (reading.pinned && state.lesson !== 'vacuum-report')
    stopAdvanceButton.hidden = !activeAdvance
    advanceDisclosure.hidden = !options.advanceUntil
    setText(result, reading.reportStatus === 'interrupted'
      ? `The required report was interrupted. Committed data was not lost. ${fmtNum(reading.reclaimed)} row versions reclaimed; cleanup cannot restore that report work. This attempt does not meet the owner’s requirement.`
      : state.phase === 'complete'
      ? `${reading.reportStatus === 'completed' ? 'The authored required report completed. ' : ''}Cleanup has resumed: ${fmtNum(reading.reclaimed)} row versions reclaimed across modeled tables since the decision. Remaining old versions may need further passes. Watch reusable capacity inside the existing relation, rather than expecting its file to shrink.`
      : reading.pinned
        ? `The old snapshot remains. sessions now has ${fmtNum(reading.deadRows)} dead versions; its relation occupies ${fmtBytes(reading.pages * 8192)}. The worker can keep scanning while retained versions accumulate.`
        : `The old snapshot has ended. ${fmtNum(reading.reclaimed)} row versions reclaimed across modeled tables since the decision. Cleanup eligibility and actual collection are separate events.`)
    setText(pauseButton, ctx.sim.state.knobs.paused ? 'Run model' : 'Pause model')
    pauseButton.setAttribute('aria-pressed', String(ctx.sim.state.knobs.paused))
    pauseButton.disabled = !!activeAdvance
    hintButton.hidden = state.mode === 'guided' || state.phase !== 'investigating'
    challengeButton.hidden = state.mode === 'challenge'
    retry.hidden = state.phase === 'investigating'
  }

  function refresh(): void { sample(); render() }

  function rebind(): void {
    if (!opened) return
    if (ctx.sim.state.scenario !== state.lesson) { close(false, false); return }
    ownedDecision = ctx.sim.state.scenarioDecision
    observedWorker = ''
    observedWorkerSlot = -1
    reading.scanObserved = false
    sample()
    const choice = ownedDecision?.choice
    state = rebindVacuumLesson(state, reading,
      choice === 'terminate-transaction' ? 'terminate' : choice === 'wait-for-transaction' ? 'wait' : null)
    notebook.replaceChildren()
    for (const id of VACUUM_EVIDENCE) {
      const item = state.evidence[id]
      if (item) notebook.append(el('li', {},
        el('strong', { text: `${EVIDENCE_COPY[id].title} · model ${item.time.toFixed(1)} s` }),
        el('p', { text: item.text })))
    }
    announce('Incident restored. Evidence recorded after this point has been removed; verify recovery again before completing.')
    render()
  }

  function open(mode: VacuumLessonMode = 'guided', lesson: LessonCase = 'vacuum-blockade'): void {
    if (opened && state.lesson === lesson) {
      if (state.mode !== mode) {
        if (mode === 'guided') { attempt.usedHints = true; progress('hint-used') }
        state = { ...state, mode }
        shareLink.hidden = true
        announce('Mode changed; the notebook and attempt remain. Earlier guidance still counts as guidance used.')
        render()
      }
      return
    }
    if (opened) close()
    ctx.bus.emit('tour:stop', {})
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (lastFocus?.closest('.tour-first')) lastFocus = document.querySelector<HTMLElement>('.hud-investigate')
    savedPaused = ctx.sim.state.knobs.paused
    savedTimeScale = ctx.sim.state.knobs.timeScale
    ctx.sim.endTrace()
    ctx.bus.emit('narrate', null)
    restorePaused = restoreTimeScale = true
    opened = true
    document.body.append(panel)
    panel.hidden = false
    positionPanel()
    document.body.classList.add('pg-vacuum-lesson')
    state = createVacuumLessonState(mode, lesson)
    const started = beginAttempt(localProgress, lesson, mode)
    localProgress = started.progress
    attempt = started.attempt
    recoveryRecorded = false
    saveProgress()
    shareLink.hidden = true
    selected = 'table'
    notebook.replaceChildren()
    notes.value = ''
    observedWorker = ''
    observedWorkerSlot = -1
    reading.scanObserved = false
    changingScenario = true
    ctx.sim.runScenario(lesson)
    ownedDecision = ctx.sim.state.scenarioDecision
    changingScenario = false
    tableIndex = ctx.sim.state.tables.findIndex((table) => table.def.id === 'sessions')
    reading.initialDeadRows = ctx.sim.state.tables[tableIndex].deadTuples
    reading.initialPages = ctx.sim.state.tables[tableIndex].pages
    setTiming('timeScale', 1)
    setTiming('paused', reduceMotion() || ctx.getQuality().level === 'reduced' ? savedPaused : false)
    announce('Inspect four evidence sources at your own pace. Starting this lesson applies a scenario to the current city; Exit restores its previous settings.')
    focus(TABLE)
    refresh()
    title.focus()
    progress('started')
  }

  function close(stopScenario = true, restoreTiming = true): void {
    if (!opened) return
    activeAdvance?.abort()
    activeAdvance = null
    opened = false
    panel.hidden = true
    panel.remove()
    document.body.classList.remove('pg-vacuum-lesson')
    if (stopScenario && ctx.sim.state.scenarioDecision === ownedDecision && ctx.sim.state.scenario === state.lesson) ctx.sim.runScenario(null)
    ownedDecision = null
    if (restoreTiming && restorePaused) setTiming('paused', savedPaused)
    if (restoreTiming && restoreTimeScale) setTiming('timeScale', savedTimeScale)
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus()
    lastFocus = null
  }

  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  })
  const off = [
    ctx.bus.on('scenario', () => { if (opened && !changingScenario && !options.isReplaying?.()) close(false) }),
    ctx.bus.on('sim:reset', () => { if (!options.isReplaying?.()) close(false, false) }),
    ctx.bus.on('knob', ({ key }) => {
      if (!opened || changingTiming || activeAdvance || options.isReplaying?.()) return
      if (key === 'paused') restorePaused = false
      if (key === 'timeScale') restoreTimeScale = false
    }),
    ctx.bus.on('tour:start', () => close()),
    ctx.bus.on('trace:open', () => close()),
    ctx.bus.on('ui:escape', (event) => {
      if (!opened || event.handled) return
      const anatomy = document.querySelector<HTMLElement>('.an-overlay')
      if (anatomy && !anatomy.hidden) return
      close()
      event.handled = true
    }),
  ]

  return {
    open, close, rebind, isOpen: () => opened,
    update(dt) {
      if (!opened || options.isReplaying?.()) return
      if (ctx.sim.state.scenarioDecision !== ownedDecision) { close(false); return }
      refreshIn -= dt
      if (refreshIn > 0) return
      refreshIn = 0.25
      refresh()
    },
    dispose() {
      toolbarObserver?.disconnect()
      window.removeEventListener('resize', positionPanel)
      for (const unsubscribe of off) unsubscribe()
      close()
      panel.remove()
    },
  }
}
