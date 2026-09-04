import type { ScenarioDecisionState } from '../core/types'
import { decodeReplay, encodeReplay, REPLAY_MAX_BYTES } from '../sim/replay'
import type { IncidentReplay, ReplayPoint, ReplayOutcome } from '../sim/replay'
import { el, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'
import '../styles/replay-panel.css'

export interface ReplayPanel extends UiModule {
  open(): void
  close(): void
  captureCheckpoint(): void
  hasCheckpoint(): boolean
  rewindCheckpoint(): Promise<void>
  runComparison(): Promise<void>
  importRecord(text: string, confirmed: boolean): Promise<void>
}

/** A local model notebook: never uploads records or treats them as PGlite evidence. */
export function createReplayPanel(ctx: UiContext, replay: IncidentReplay): ReplayPanel {
  let checkpoint: ReplayPoint | null = null
  let decision: ScenarioDecisionState | null = null
  let visible = false
  let clock = 0
  let returnFocus: HTMLElement | null = null
  const heading = el('h2', { text: 'Rewind an incident', id: 'replay-heading' })
  const message = el('p', { class: 'pg-replay__message', role: 'status', 'aria-live': 'polite' })
  const status = el('p', { class: 'pg-replay__status' })
  const checkpointText = el('p', { class: 'pg-replay__checkpoint', text: 'No checkpoint saved yet.' })
  const comparison = el('div', { class: 'pg-replay__comparison' })
  const shareText = el('textarea', {
    class: 'pg-replay__record', 'aria-label': 'Local incident record JSON', spellcheck: false,
    maxLength: REPLAY_MAX_BYTES, rows: 5,
  })
  const confirm = el('input', { type: 'checkbox' })
  const controls: HTMLButtonElement[] = []
  function button(text: string, action: () => void | Promise<void>): HTMLButtonElement {
    const node = el('button', { type: 'button', class: 'pg-btn', text })
    node.addEventListener('click', () => {
      setText(message, '')
      Promise.resolve().then(action).catch((error: unknown) => {
        setText(message, error instanceof Error ? error.message : 'The replay action failed.')
      }).finally(render)
    })
    controls.push(node)
    return node
  }

  const save = button('Save checkpoint', captureCheckpoint)
  const rewind = button('Rewind to checkpoint', rewindCheckpoint)
  const run = button('Run alternative to same duration', runComparison)
  const exportButton = button('Prepare record to copy', () => {
    shareText.value = encodeReplay(replay.exportRecord())
    shareText.focus()
    shareText.select()
    setText(message, 'Record prepared locally. Copy it to share; nothing was uploaded.')
  })
  const importButton = button('Import and replace incident', () => importRecord(shareText.value, confirm.checked))
  const closeButton = el('button', { type: 'button', class: 'pg-btn', text: 'Close', 'aria-label': 'Close incident replay' })
  closeButton.addEventListener('click', close)
  const panel = el('section', {
    class: 'pg-replay', role: 'dialog', 'aria-labelledby': 'replay-heading', hidden: true,
  },
  el('div', { class: 'pg-replay__heading' }, heading, closeButton),
  el('p', { class: 'pg-replay__disclosure', data: { disclosure: 'model' }, text: 'Scaled model outcomes, not PostgreSQL measurements. PGlite results are separate. Replaying does not operate a real database.' }),
  el('p', { text: 'Save a checkpoint before an intervention. Try one choice and observe its outcome, then rewind, change your choice, and compare after the same model duration.' }),
  status, checkpointText,
  el('div', { class: 'pg-replay__actions' }, save, rewind, run),
  comparison, message,
  el('details', {}, el('summary', { text: 'Share or import a local replay' }),
    el('p', { text: 'Records contain a version, seed, elapsed steps, and allowlisted model actions. Limits: 10 model minutes, 18,000 steps, 1,024 actions, 96 KiB. Only this exact model build and seed can import them. No SQL, lesson answers, or PGlite data are included.' }),
    exportButton, shareText,
    el('label', { class: 'pg-replay__confirm' }, confirm, ' I confirm that import will replace the current model incident.'),
    importButton),
  )
  document.body.append(panel)

  function captureCheckpoint(): void {
    if (!replay.status.valid || replay.status.seeking) throw new Error(replay.status.reason || 'Wait for replay to finish')
    checkpoint = replay.checkpoint()
    render()
  }
  async function rewindCheckpoint(): Promise<void> {
    if (!checkpoint) throw new Error('Save a checkpoint before rewinding')
    await replay.rewind(checkpoint)
    setText(message, 'Checkpoint restored. Choose a different intervention, then run the alternative to the same duration.')
    render()
  }
  async function runComparison(): Promise<void> {
    await replay.runToComparison()
    setText(message, 'The alternative is paused at the original branch’s model duration. Compare the outcomes below.')
    render()
  }
  async function importRecord(text: string, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Confirm replacement of the current incident before importing')
    const record = decodeReplay(text)
    await replay.loadRecord(record)
    checkpoint = null
    decision = ctx.sim.state.scenarioDecision
    confirm.checked = false
    setText(message, 'Local replay imported. Save a new checkpoint before another intervention.')
    render()
  }

  const metrics: readonly [keyof ReplayOutcome, string, string][] = [
    ['commits', 'Commits', ''], ['rollbacks', 'Rollbacks', ''],
    ['latencyP99ModelMs', 'p99 latency', ' model ms'],
    ['deadTuples', 'Dead tuples', ''], ['tablePages', 'Table pages', ''],
    ['reclaimedTuples', 'Tuples reclaimed', ''], ['retainedWalBytes', 'WAL retained by physical slots', ' bytes'],
    ['rejectedWrites', 'Rejected writes', ''], ['lostTransactions', 'Lost transactions', ''],
  ]
  let comparisonSignature = ''
  function render(): void {
    const state = replay.status
    setText(status, state.seeking ? `Reconstructing model: ${Math.round(state.seekProgress * 100)}%`
      : state.valid ? `Recorded ${state.tick} steps and ${state.actionCount} actions.` : `Recording unavailable: ${state.reason}`)
    setText(checkpointText, checkpoint ? `Checkpoint: step ${checkpoint.tick}, after action ${checkpoint.actionCount}.`
      : 'No checkpoint saved yet. A ready operator decision also saves one automatically.')
    for (const control of controls) control.disabled = state.seeking
    save.disabled ||= !state.valid
    rewind.disabled ||= !state.valid || !checkpoint
    exportButton.disabled ||= !state.valid
    const result = replay.compare()
    run.disabled ||= !state.valid || !result || result.current.elapsedModelSeconds > result.baseline.elapsedModelSeconds + 1e-7
    if (!visible) return
    const signature = JSON.stringify(result)
    if (signature === comparisonSignature) return
    comparisonSignature = signature
    comparison.replaceChildren()
    if (!result) return
    comparison.append(el('h3', { text: result.sameDuration ? 'Same model duration' : 'Different model durations — not yet a controlled comparison' }),
      el('p', { text: `Original: ${result.baseline.elapsedModelSeconds.toFixed(2)} model seconds. Alternative: ${result.current.elapsedModelSeconds.toFixed(2)} model seconds. Same seed and checkpoint; only your subsequent actions differ.` }))
    if (!result.sameDuration) return
    const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Model outcome', scope: 'col' }),
      el('th', { text: 'Original', scope: 'col' }), el('th', { text: 'Alternative', scope: 'col' }))))
    const body = el('tbody')
    for (const [key, label, unit] of metrics) {
      const format = (value: ReplayOutcome[typeof key]): string => `${typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : value}${unit}`
      body.append(el('tr', {}, el('th', { text: label, scope: 'row' }), el('td', { text: format(result.baseline[key]) }), el('td', { text: format(result.current[key]) })))
    }
    table.append(body)
    comparison.append(table, el('p', { text: 'Counters and current gauges are model outputs, not production capacity estimates. Both branches start from the same seeded warm model. Reusable table space is not a promise that ordinary VACUUM shrinks a relation file.' }))
  }
  function open(): void {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    visible = true
    panel.hidden = false
    render()
    closeButton.focus()
  }
  function close(): void {
    visible = false
    panel.hidden = true
    returnFocus?.focus()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (visible && event.key === 'Escape') { event.stopPropagation(); close() }
  }
  panel.addEventListener('keydown', onKey)
  const offReset = ctx.bus.on('sim:reset', () => {
    if (replay.status.seeking) return
    checkpoint = null
    decision = null
    render()
  })
  return {
    open, close, captureCheckpoint, hasCheckpoint: () => checkpoint !== null,
    rewindCheckpoint, runComparison, importRecord,
    update(dt): void {
      if (!replay.status.seeking) {
        const current = ctx.sim.state.scenarioDecision
        if (current && current !== decision && current.phase === 'ready' && replay.status.valid) {
          checkpoint = replay.checkpoint()
          decision = current
        }
      }
      clock += dt
      if (clock < 0.25) return
      clock = 0
      if (visible) render()
    },
    dispose(): void { offReset(); panel.removeEventListener('keydown', onKey); panel.remove() },
  }
}
