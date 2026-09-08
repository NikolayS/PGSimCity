import '../styles/operations-campaign.css'
import type { SimState, ScenarioChoiceId } from '../core/types'
import { campaignHref, loadCampaignProgress, saveCampaignProgress, clearCampaignProgress, type CampaignMode, type CampaignVariant, type CampaignStorage } from '../core/operations-campaign'
import { fmtBytes } from '../core/util'
import { el, setText, type UiContext, type UiModule } from './uikit'

type Progress = { event: string; variant: CampaignVariant; mode: CampaignMode }
export interface OperationsCampaign extends UiModule {
  open(variant?: CampaignVariant, mode?: CampaignMode): void
  close(): void
}

export function createOperationsCampaign(ctx: UiContext, options: {
  storage?: CampaignStorage | null
  onProgress?: (progress: Progress) => void
  canMutate?: () => boolean
  beforeOpen?: () => void
} = {}): OperationsCampaign {
  let storage = options.storage ?? null
  if (options.storage === undefined) { try { storage = window.localStorage } catch { /* Session-only progress remains usable. */ } }
  let progress = loadCampaignProgress(storage)
  let variant: CampaignVariant = 'slot-pressure'
  let mode: CampaignMode = 'guided'
  let owned: SimState['scenarioDecision'] = null
  let evidence = false
  let complete = false
  let opened = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let remaining = 0
  let refreshIn = 0
  let returnFocus: HTMLElement | null = null
  let snapshot = ''
  const report = (event: string): void => options.onProgress?.({ event, variant, mode })
  const title = el('h2', { id: 'operations-title', tabindex: '-1', text: 'WAL operations campaign' })
  const status = el('p', { role: 'status', 'aria-live': 'polite', data: { campaignStatus: '' } })
  const objectives = el('p')
  const owner = el('p')
  const live = el('p', { class: 'operations-campaign__reading', data: { campaignLive: '' } })
  const saved = el('p', { data: { campaignSaved: '' } })
  const local = el('p', { data: { campaignProgress: '' } })
  const hint = el('p', { hidden: true, data: { campaignHintText: '' } })
  const note = el('textarea', { rows: 2, maxlength: 1000, 'aria-label': 'Explain your decision and its trade-off', placeholder: 'Explain the ownership constraint, your decision and the recovery evidence. Notes stay in this attempt only.' })
  const button = (name: string, text: string, fn: () => void): HTMLButtonElement => el('button', { type: 'button', class: 'pg-btn', text, data: { [`campaign${name[0].toUpperCase()}${name.slice(1)}`]: '' }, on: { click: fn } })
  const start = button('start', 'Reset city and start this case', begin)
  const retry = button('retry', 'Reset city and retry this case', begin)
  const record = button('record', 'Record ownership and live pressure', () => {
    if (!current() || owned?.phase !== 'ready') return
    render()
    evidence = true
    snapshot = `Saved at ${ctx.sim.state.t.toFixed(1)} model s · ${owner.textContent} ${live.textContent}`
    report('evidence-collected'); render()
  })
  const capacity = button('capacity', 'Add validated 512 MiB headroom', () => choose('add-wal-capacity'))
  const drop = button('drop', 'Drop the slot', () => choose('drop-replication-slot'))
  const verify = button('verify', 'Verify recovery from live state', () => {
    if (!recovered() || complete) return
    complete = true
    if (!progress.completed.includes(variant)) progress.completed.push(variant)
    progress.available = saveCampaignProgress(storage, progress.completed)
    report('recovery-verified'); report('completed'); render()
  })
  const advance = button('advance', 'Observe up to 300 model seconds', () => {
    if (!current() || running || complete) return
    running = true; remaining = 300; ctx.sim.setKnob('paused', true)
    pump()
  })
  const cancel = button('cancel', 'Stop observation', () => { stop(); render() })
  const guidance = button('hint', 'Show a hint', () => {
    hint.hidden = false; report('hint-used')
  })
  const links = el('nav', { 'aria-label': 'Campaign cases and modes', class: 'operations-campaign__links' })
  for (const id of ['slot-pressure', 'retired-slot'] as const) {
    for (const m of ['guided', 'challenge'] as const) {
      links.append(el('a', { href: campaignHref(id, m), text: `${id === 'slot-pressure' ? 'Required standby' : 'Retired consumer'} · ${m}`, on: { click: (event) => { event.preventDefault(); open(id, m); try { window.history.replaceState(null, '', campaignHref(id, m)) } catch { /* Embedded environments may disallow URL updates. */ } } } }))
    }
  }
  const panel = el('section', { class: 'operations-campaign', role: 'region', 'aria-labelledby': 'operations-title' },
    el('header', {}, title, button('close', 'Back to city', close)),
    el('div', { class: 'operations-campaign__body' },
      links, objectives,
      el('p', { text: 'Starting or retrying resets the entire city, replay history and this attempt’s notes. Switching cases discards this attempt’s evidence and notes; opening or changing guidance mode preserves them. Opening this panel does not reset anything. Export existing evidence first. Closing stops observation and leaves current model state and pause unchanged.' }),
      start, retry, status,
      el('h3', { text: '1 · Establish ownership and pressure' }), owner, live,
      button('focus', 'Locate WAL storage in the live city', focusCity),
      record, saved,
      el('h3', { text: '2 · Intervene, then observe' }), capacity, drop, guidance, hint, advance, cancel,
      el('h3', { text: '3 · Verify and explain' }), verify, note,
      el('p', { text: 'City model: scaled WAL bytes and model seconds, not PostgreSQL measurements. Dropping a slot removes a retention requirement; checkpoint/recycling and other retainers still determine pg_wal occupancy. max_wal_size is not a hard disk limit. Ownership and available extra capacity are authored case constraints, not discovered facts.' }),
      local, button('clear', 'Clear local completion history', () => {
        const cleared = clearCampaignProgress(storage)
        progress = { available: cleared, completed: [] }; render()
      }),
    ),
  )

  function position(): void {
    const top = document.getElementById('hud-top')?.getBoundingClientRect().bottom ?? 74
    const dock = document.getElementById('hud-bottom')?.getBoundingClientRect().top ?? window.innerHeight - 80
    panel.style.setProperty('--operations-top', `${Math.ceil(top) + 12}px`)
    panel.style.setProperty('--operations-bottom', `${Math.ceil(window.innerHeight - dock) + 8}px`)
  }
  function focusCity(): void {
    position()
    const rect = panel.getBoundingClientRect()
    const width = window.innerWidth, height = window.innerHeight
    const top = (document.getElementById('hud-top')?.getBoundingClientRect().bottom ?? 74) + 24
    const bottom = width <= 600 ? rect.top - 12 : (document.getElementById('hud-bottom')?.getBoundingClientRect().top ?? height - 100) - 12
    const right = width <= 600 ? width - 16 : rect.left - 16
    const viewport = { left: -1 + 32 / width, right: 2 * right / width - 1, top: 1 - 2 * top / height, bottom: 1 - 2 * bottom / height }
    ctx.bus.emit('select', { id: 'wal.vault', outlineOnly: true })
    ctx.bus.emit('focus', { id: 'wal.vault', ...(rect.width > 0 && bottom > top && right > 16 ? { viewport } : {}) })
  }
  const canMutate = (): boolean => options.canMutate?.() ?? true
  function current(): boolean { return canMutate() && !!owned && ctx.sim.state.scenarioDecision === owned && ctx.sim.state.scenario === variant }
  function recovered(): boolean {
    if (!current() || !evidence || owned?.kind !== 'slot-pressure' || owned.phase !== 'recovered' || !owned.correct) return false
    const { replication, disasterRecovery } = ctx.sim.state
    if (disasterRecovery.archive.writesBlocked) return false
    return variant === 'retired-slot'
      ? !replication.physicalSlots[1].exists && !replication.standbys[1].enabled && disasterRecovery.archive.pgWalBytes < owned.walBytesAtDecision
      : replication.physicalSlots[1].exists && replication.standbys[1].connected && replication.physicalSlots[1].retainedBytes <= Math.max(16 * 1024 * 1024, owned.slotRetainedAtDecision * .1)
  }
  function choose(choice: ScenarioChoiceId): void {
    if (!current() || !evidence || owned?.phase !== 'ready') return
    stop()
    ctx.sim.chooseScenario(choice)
    render()
  }
  function stop(): void { if (timer !== undefined) clearTimeout(timer); timer = undefined; running = false }
  function pump(): void {
    if (!opened || !current() || !running) { stop(); return }
    const before = owned?.phase
    for (let i = 0; i < 100 && remaining > 0; i++) {
      const elapsed = ctx.sim.advance(.1)
      if (elapsed <= 0) { stop(); break }
      remaining -= elapsed
      if (owned?.phase !== before) { stop(); break }
    }
    if (remaining <= 0) stop()
    render()
    if (running) timer = setTimeout(pump, 0)
  }
  function begin(): void {
    if (!canMutate()) { render(); return }
    stop()
    ctx.sim.reset()
    ctx.sim.runScenario(variant)
    ctx.sim.setKnob('paused', true)
    owned = ctx.sim.state.scenarioDecision
    evidence = false; complete = false; snapshot = ''; note.value = ''; hint.hidden = true
    focusCity()
    syncAttemptOverlay(); report('started'); render()
  }
  function render(): void {
    const valid = current()
    const d = valid && owned?.kind === 'slot-pressure' ? owned : null
    const s = ctx.sim.state
    setText(objectives, variant === 'slot-pressure'
      ? 'Required standby · restore writes while preserving slot-backed continuity. The owner requires a resume without a rebuild; 512 MiB of additional scaled capacity has been validated for catch-up.'
      : 'Retired consumer · restore write headroom without retaining WAL for a consumer that will never return. Release unused retention only after verifying ownership and inactivity.')
    setText(owner, variant === 'slot-pressure'
      ? 'Owner note: standby_b is required. Its link is repaired when the decision is ready; preserve its retention guarantee. The drop option bundles stop, detach primary_slot_name, drop inactive slot and restart. It removes slot-backed continuity; retained or archived WAL may still allow streaming, but resume is no longer guaranteed.'
      : 'Owner note: standby_b is retired, its process is stopped, and no resume or recovery obligation remains. Confirm that the slot is inactive before removing it.')
    setText(live, `Live ${s.t.toFixed(1)} model s · pg_wal ${fmtBytes(s.disasterRecovery.archive.pgWalBytes)} / ${fmtBytes(s.disasterRecovery.archive.pgWalCapacityBytes)} capacity · slot retention ${fmtBytes(s.replication.physicalSlots[1].retainedBytes)} · slot ${s.replication.physicalSlots[1].exists ? (s.replication.physicalSlots[1].active ? 'active' : 'inactive') : 'absent'} · writes ${s.disasterRecovery.archive.writesBlocked ? 'blocked' : 'available'}${d ? ` · rejected writes since decision ${d.rejectedWrites}` : ''}`)
    setText(saved, snapshot || 'No evidence recorded. Saved readings remain historical; the city above is live.')
    setText(hint, variant === 'slot-pressure'
      ? 'Preserve the required slot. Added capacity is temporary containment; verify catch-up and writes before declaring recovery.'
      : 'Adding capacity alone does not retire an unused retention requirement. Confirm inactivity, remove that requirement, then observe actual WAL occupancy and writes.')
    setText(status, !canMutate() ? 'Replay reconstruction is in progress. Campaign actions are unavailable until it finishes.' : complete && valid ? 'Recovery verified. Explain the trade-off below; completion records an observed model outcome, not a graded explanation.'
      : owned && !valid ? 'The incident changed. Reset and retry to collect fresh evidence; previous evidence cannot verify this city.'
      : !valid ? `${mode === 'challenge' ? 'Challenge · hints are optional.' : 'Guided · record the case constraints and live readings before choosing.'} Ready to start a fresh case.`
      : running ? `Observing the live model · ${Math.ceil(remaining)} model seconds left in this bounded request.`
      : d?.phase === 'staging' ? 'Observe until retention pressure and the intervention are ready. This may take multiple bounded requests.'
      : d?.phase === 'ready' ? (evidence ? 'Evidence recorded. Choose an intervention consistent with the owner’s constraint.' : 'Pressure observed. Record the ownership constraint and live readings before choosing.')
      : d?.correct === false ? 'The constraint is not resolved. Observe the consequences, explain the trade-off, then explicitly reset and retry.'
      : recovered() ? 'Recovery is observable. Verify the live result to complete this case.' : 'Intervention applied. Observe actual recovery; the action itself is not evidence of recovery.')
    setText(local, `Local completion: ${progress.completed.length} of 2 cases. ${progress.completed.map(id => id === 'slot-pressure' ? 'Required standby' : 'Retired consumer').join(', ')} ${progress.available ? 'Completion identifiers only; no notes or replay data saved.' : 'Storage unavailable: progress is session-only; previously saved history may remain on disk.'}`)
    start.hidden = valid; retry.hidden = !owned
    start.disabled = retry.disabled = !canMutate()
    record.disabled = !valid || d?.phase !== 'ready' || evidence
    capacity.disabled = drop.disabled = !valid || !evidence || d?.phase !== 'ready'
    verify.disabled = !recovered() || complete
    advance.disabled = !valid || running || complete
    cancel.hidden = !running
    guidance.hidden = !valid || !hint.hidden
    setText(drop, variant === 'slot-pressure' ? 'Stop, detach slot, drop and restart standby' : 'Drop the verified inactive slot')
    setText(capacity, variant === 'slot-pressure' ? 'Add validated 512 MiB headroom' : 'Add 512 MiB temporary headroom')
  }
  function open(id: CampaignVariant = variant, m: CampaignMode = mode): void {
    options.beforeOpen?.()
    stop()
    if (variant !== id) { owned = null; evidence = false; complete = false; snapshot = ''; note.value = ''; hint.hidden = true }
    variant = id; mode = m
    setText(title, `WAL operations · ${mode}`)
    if (!opened) returnFocus = document.activeElement as HTMLElement | null
    opened = true
    ctx.bus.emit('tour:stop', {})
    document.body.classList.add('pg-operations-campaign')
    document.body.append(panel)
    position(); render(); title.focus()
  }
  function syncAttemptOverlay(): void {
    const owns = !!owned && ctx.sim.state.scenarioDecision === owned && ctx.sim.state.scenario === variant
    document.body.classList.toggle('pg-operations-attempt', owns)
  }
  function close(): void {
    stop(); opened = false; panel.remove(); document.body.classList.remove('pg-operations-campaign')
    syncAttemptOverlay()
    returnFocus?.focus()
  }
  panel.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); close() } })
  const offReset = ctx.bus.on('sim:reset', () => { stop(); syncAttemptOverlay() })
  const offScenario = ctx.bus.on('scenario', () => { stop(); syncAttemptOverlay() })
  return { open, close, update(dt) { if (!opened) return; refreshIn -= dt; if (refreshIn <= 0) { refreshIn = .2; position(); render() } }, dispose() { close(); offReset(); offScenario(); document.body.classList.remove('pg-operations-attempt') } }
}
