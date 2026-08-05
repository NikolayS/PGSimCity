/*
 * Cross-surface remedial actions that have drifted before. The complete action,
 * its qualifications, and its surface list live here, like facts in claims.ts.
 */

export type ActionSurface =
  | { kind: 'diagnose-verdict'; id: string }
  | { kind: 'scenario-beat'; scenario: string; at: number }
  | { kind: 'inspector-section'; doc: string; section: string }

declare const diagnoseRemedyBrand: unique symbol
declare const registeredActionRemedyBrand: unique symbol

/* These brands prevent accidental mixing only; a TypeScript assertion can
 * forge either one. The binding-aware action-spine test proves production use. */
export type DiagnoseRemedy = string & { readonly [diagnoseRemedyBrand]: true }
export type RegisteredActionRemedy = DiagnoseRemedy & {
  readonly [registeredActionRemedyBrand]: true
}

interface ActionVersionVariant {
  from: number
  to?: number
  context: 'postmaster' | 'sighup'
  activation: 'server restart' | 'configuration reload'
}

interface ActionVersionSpecificity {
  setting: string
  variants: readonly ActionVersionVariant[]
}

interface ActionOperationalTarget {
  kind: 'configuration' | 'function'
  name: string
}

interface ActionContract {
  owner: string
  label: string
  what: string
  preconditions: readonly string[]
  risks: readonly string[]
  versionSpecificity: ActionVersionSpecificity | null
  operationalTargets: readonly ActionOperationalTarget[]
  surfaces: readonly ActionSurface[]
}

export const ACTIONS = {
  restoreReplayCapacity: {
    owner: 'src/core/actions.ts#ACTIONS.restoreReplayCapacity',
    label: 'Restore replay capacity',
    what:
      'After excluding a stopped recovery path, reduce avoidable WAL generation, restore standby replay capacity, or route reads that require current data to the primary while the standby catches up. Track the current primary-LSN minus replay-LSN byte gap rather than treating replay_lag as current staleness or catch-up time.',
    preconditions: [
      'On the affected standby, pg_is_wal_replay_paused() is false.',
      'The startup process and its wait event, pg_stat_wal_receiver, and the standby log have been checked; the LSN gaps localise the investigation but do not prove a capacity root cause.',
    ],
    risks: [
      'Reducing primary WAL can shed or delay production work, and accepting lag can serve stale reads; neither move resumes paused recovery or repairs a stopped receiver.',
    ],
    versionSpecificity: null,
    operationalTargets: [],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.replay' },
      { kind: 'scenario-beat', scenario: 'replication-lag', at: 104 },
      { kind: 'inspector-section', doc: 'walsender', section: 'What you would see in production' },
    ],
  },
  resumePausedRecovery: {
    owner: 'src/core/actions.ts#ACTIONS.resumePausedRecovery',
    label: 'Resume paused recovery',
    what:
      'If recovery is paused unintentionally, run pg_wal_replay_resume() on the affected standby and confirm that replay_lsn advances toward flush_lsn.',
    preconditions: [
      'pg_is_wal_replay_paused() is true on the affected standby, and the owner confirms that the pause is not an intentional recovery or inspection boundary.',
    ],
    risks: [
      'Resuming recovery applies queued WAL and can move the standby beyond the state an operator intentionally paused to inspect; that state cannot be recovered without another recovery procedure.',
    ],
    versionSpecificity: null,
    operationalTargets: [
      { kind: 'function', name: 'pg_wal_replay_resume' },
    ],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.replay_paused' },
      { kind: 'scenario-beat', scenario: 'replication-lag', at: 86 },
      { kind: 'inspector-section', doc: 'startup.proc', section: 'What you would see in production' },
    ],
  },
  limitSlotWalRetention: {
    owner: 'src/core/actions.ts#ACTIONS.limitSlotWalRetention',
    label: 'Limit replication-slot WAL retention',
    what:
      'Set max_slot_wal_keep_size only as an explicit limit on how much primary WAL a slot may retain, then monitor retained_bytes, wal_status, safe_wal_size, archive coverage, and time to volume exhaustion.',
    preconditions: [
      'Confirm slot ownership and recovery intent, required continuity, archive coverage, measured WAL and catch-up rates, available headroom, and the accepted rebuild cost before enforcing the cap.',
    ],
    risks: [
      'Enforcing the cap intentionally permits required WAL to be removed, can invalidate the slot and strand its standby, and can require a rebuild from a new base backup when the removed WAL is unavailable from every archive or other source.',
    ],
    versionSpecificity: null,
    operationalTargets: [
      { kind: 'configuration', name: 'max_slot_wal_keep_size' },
      { kind: 'function', name: 'pg_drop_replication_slot' },
    ],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.replay' },
      { kind: 'scenario-beat', scenario: 'replication-lag', at: 104 },
      { kind: 'inspector-section', doc: 'wal.vault', section: 'What you would see in production' },
      { kind: 'inspector-section', doc: 'walsender', section: 'How a slot takes down a primary' },
    ],
  },
  restoreConnectionCapacity: {
    owner: 'src/core/actions.ts#ACTIONS.restoreConnectionCapacity',
    label: 'Restore ordinary connection capacity',
    what:
      'Use protected administrative access, calculate ordinary admission capacity after reserved slots, identify session owners, and release only verified abandoned sessions before changing the long-term admission architecture. Once capacity exists, size every pool and bypass path together and leave measured headroom.',
    preconditions: [
      'Count max_connections minus superuser_reserved_connections and, where available, reserved_connections; verify each candidate session owner, transaction state, and business impact before disconnecting it.',
    ],
    risks: [
      'Terminating a backend aborts its transaction and disconnects its client. A newly introduced pooler cannot open its first ordinary server connection while ordinary capacity is already exhausted, and an undersized or incompatible pool can move the outage into its queue.',
    ],
    versionSpecificity: null,
    operationalTargets: [
      { kind: 'configuration', name: 'max_connections' },
    ],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.saturation' },
      { kind: 'scenario-beat', scenario: 'connection-storm', at: 44 },
      { kind: 'inspector-section', doc: 'client.pooler', section: 'The queue and connection controls' },
    ],
  },
  enableRelationAutovacuum: {
    owner: 'src/core/actions.ts#ACTIONS.enableRelationAutovacuum',
    label: 'Restore relation-level autovacuum eligibility',
    what:
      'Inspect pg_class.reloptions for the affected relation and every storage-owning child in a partitioned layout. If the opt-out is no longer intentional, set autovacuum_enabled = true on each affected relation and confirm a worker completes cleanup.',
    preconditions: [
      'Global autovacuum is on, pg_class.reloptions shows autovacuum_enabled=false for the affected relation, and the relation owner confirms that reenabling routine vacuum is compatible with the maintenance plan.',
    ],
    risks: [
      'Reenabling autovacuum introduces cleanup I/O and can expose an already accumulated maintenance backlog; schedule and observe that work instead of assuming the first launcher pass is free.',
    ],
    versionSpecificity: null,
    operationalTargets: [
      { kind: 'configuration', name: 'autovacuum_enabled' },
    ],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.av_relation_off' },
      { kind: 'scenario-beat', scenario: 'bloat-and-vacuum', at: 126 },
      { kind: 'inspector-section', doc: 'autovac.launcher', section: 'What you would see in production' },
    ],
  },
  tuneAutovacuum: {
    owner: 'src/core/actions.ts#ACTIONS.tuneAutovacuum',
    label: 'Tune autovacuum throughput and cadence',
    what:
      'Lower per-table vacuum thresholds on large hot relations, then raise cost capacity and autovacuum_max_workers only when measurements show workers are saturated by too many eligible relations rather than each worker lacking I/O bandwidth.',
    preconditions: [
      'Global and per-relation autovacuum are enabled, no old snapshot or other xmin holder explains the backlog, pg_class.reloptions have been inspected for the target and partition children, and worker occupancy plus pg_stat_progress_vacuum show that the proposed limit is the bottleneck.',
    ],
    risks: [
      'More vacuum capacity consumes additional I/O and WAL bandwidth. Raising autovacuum_max_workers without raising the shared cost budget can divide the same throughput among more workers, while changing thresholds does nothing for a relation with autovacuum_enabled=false.',
    ],
    versionSpecificity: {
      setting: 'autovacuum_max_workers',
      variants: [
        { from: 13, to: 17, context: 'postmaster', activation: 'server restart' },
        { from: 18, context: 'sighup', activation: 'configuration reload' },
      ],
    },
    operationalTargets: [
      { kind: 'configuration', name: 'autovacuum_vacuum_scale_factor' },
      { kind: 'configuration', name: 'autovacuum_vacuum_threshold' },
      { kind: 'configuration', name: 'autovacuum_vacuum_cost_limit' },
      { kind: 'configuration', name: 'autovacuum_max_workers' },
    ],
    surfaces: [
      { kind: 'diagnose-verdict', id: 'v.av_tuning' },
      { kind: 'scenario-beat', scenario: 'bloat-and-vacuum', at: 126 },
      { kind: 'inspector-section', doc: 'autovac.launcher', section: 'Why the defaults are too timid' },
      { kind: 'inspector-section', doc: 'autovac.launcher', section: 'Throttling, and the trap in it' },
    ],
  },
} as const satisfies Record<string, ActionContract>

export type ActionId = keyof typeof ACTIONS
type DiagnoseActionSurface = Extract<
  (typeof ACTIONS)[ActionId]['surfaces'][number],
  { kind: 'diagnose-verdict' }
>
export type DiagnoseActionVerdictId = DiagnoseActionSurface['id']

export function actionSurfaceLabel(surface: ActionSurface): string {
  if (surface.kind === 'diagnose-verdict') return `Diagnose:${surface.id}`
  if (surface.kind === 'scenario-beat') return `scenario:${surface.scenario}@${surface.at}`
  return `inspector:${surface.doc}/${surface.section}`
}

function renderVersionSpecificity(
  specificity: ActionVersionSpecificity,
): string {
  return specificity.variants.map((variant) => {
    const range = variant.to === undefined
      ? `PostgreSQL ${variant.from} and later`
      : `PostgreSQL ${variant.from} through ${variant.to}`
    return `${range}: ${variant.activation} (pg_settings.context = ${variant.context}).`
  }).join(' ')
}

export function diagnosticGuidance(copy: string): DiagnoseRemedy {
  return copy as DiagnoseRemedy
}

/**
 * Marks an exact registered target name as explanatory rather than prescriptive.
 * This review marker is not a semantic or runtime boundary.
 */
export function operationalReference(copy: string): string {
  return copy
}

export function renderAction(actionId: ActionId): RegisteredActionRemedy {
  const action = ACTIONS[actionId]
  const sections = [
    `**Action — ${action.label}:** ${action.what}`,
    `**Preconditions:** ${action.preconditions.join(' ')}`,
    `**Risks:** ${action.risks.join(' ')}`,
  ]
  if (action.versionSpecificity) {
    sections.push(
      `**Version specificity:** ${renderVersionSpecificity(action.versionSpecificity)}`,
    )
  }
  return sections.join('\n\n') as RegisteredActionRemedy
}

export function renderActions(...actionIds: readonly ActionId[]): RegisteredActionRemedy {
  return actionIds.map(renderAction).join('\n\n') as RegisteredActionRemedy
}
