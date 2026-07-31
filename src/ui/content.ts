import {
  SHARED_BUFFERS_MAX_MIB,
  SHARED_BUFFERS_MIN_MIB,
} from '../core/types'
import type { ComponentDoc, Knobs } from '../core/types'
import { DOCS_MEMORY } from './docs-memory'
import { DOCS_STORAGE } from './docs-storage'

/* ============================================================================
 * The knowledge layer.
 *
 * DOCS_MEMORY  — clients, postmaster, backends, shared memory, the query lab
 * DOCS_STORAGE — WAL, storage, maintenance processes, replication
 * ==========================================================================*/

export const DOCS: ComponentDoc[] = [...DOCS_MEMORY, ...DOCS_STORAGE]

const _byId = new Map<string, ComponentDoc>(DOCS.map((d) => [d.id, d]))

export function doc(id: string | null | undefined): ComponentDoc | undefined {
  if (!id) return undefined
  const hit = _byId.get(id)
  if (hit) return hit
  // per-instance ids fall back to their family doc: backend.7 -> backend.slot
  if (/^backend\.\d+$/.test(id)) return _byId.get('backend.slot')
  if (/^autovac\.worker\.\d+$/.test(id)) return _byId.get('autovac.worker')
  if (id.startsWith('storage.table.')) return _byId.get('storage.table')
  if (id.startsWith('storage.index.')) return _byId.get('storage.index')
  if (id.startsWith('storage.fsm.')) return _byId.get('storage.fsm')
  if (id.startsWith('storage.vm.')) return _byId.get('storage.vm')
  return undefined
}

export function hasDoc(id: string | null | undefined): boolean {
  return !!doc(id)
}

/* ---------------------------------------------------------------------------
 * Knob metadata — how each dial is rendered, what GUC it stands for, and what
 * it teaches. The control rail and the inspector both read this.
 * -------------------------------------------------------------------------*/

export type KnobGroup = 'workload' | 'memory' | 'wal' | 'checkpoint' | 'vacuum' | 'replication' | 'recovery' | 'chaos' | 'sim'

export interface KnobMeta {
  key: keyof Knobs
  label: string
  /** the real postgresql.conf parameter, if there is one */
  guc?: string
  group: KnobGroup
  kind: 'range' | 'logrange' | 'toggle' | 'select'
  min?: number
  max?: number
  step?: number
  options?: { value: string; label: string }[]
  unit?: string
  /** one line: what moving this actually does inside the engine */
  hint: string
  /** format the current value for display */
  fmt?: (v: never) => string
  /** flag the settings that make people lose data or sleep */
  danger?: boolean
}

export const KNOB_GROUPS: { id: KnobGroup; label: string; hint: string }[] = [
  { id: 'workload', label: 'Workload', hint: 'What the application is asking for' },
  { id: 'memory', label: 'Memory', hint: 'How much of the database fits in RAM' },
  { id: 'wal', label: 'Write-ahead log', hint: 'Durability, and what it costs' },
  { id: 'checkpoint', label: 'Checkpoints', hint: 'Getting dirty pages onto disk' },
  { id: 'vacuum', label: 'Autovacuum', hint: 'Reclaiming dead rows' },
  { id: 'replication', label: 'Replication', hint: 'Keeping a second copy' },
  { id: 'recovery', label: 'Disaster recovery', hint: 'Backups, archive health, retention and PITR' },
  { id: 'chaos', label: 'Break something', hint: 'The failure modes worth recognising' },
  { id: 'sim', label: 'Playback', hint: 'Simulation controls' },
]

function fmtSharedBuffers(mib: number): string {
  if (mib < 1024) return `${Math.round(mib)} MiB`
  const gib = mib / 1024
  return `${Number.isInteger(gib) ? gib.toFixed(0) : gib.toFixed(1)} GiB`
}

export const KNOB_META: KnobMeta[] = [
  {
    key: 'tps',
    label: 'Transactions / sec',
    group: 'workload',
    kind: 'logrange',
    min: 1,
    max: 5000,
    step: 1,
    unit: 'tps',
    hint: 'How hard the application hammers the database. Everything downstream scales from here.',
  },
  {
    key: 'writeRatio',
    label: 'Writes',
    group: 'workload',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'Share of statements that modify data. Reads are cheap; writes create WAL, dirty pages and dead tuples.',
  },
  {
    key: 'updateRatio',
    label: 'Updates vs inserts',
    group: 'workload',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'An UPDATE in Postgres writes a new row version and leaves the old one behind for vacuum.',
  },
  {
    key: 'seqScanRatio',
    label: 'Sequential scans',
    group: 'workload',
    kind: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '%',
    hint: 'Reads that walk the whole table instead of using an index — watch the buffer cache churn.',
  },
  {
    key: 'sharedBuffers',
    label: 'shared_buffers',
    guc: 'shared_buffers',
    group: 'memory',
    kind: 'range',
    min: SHARED_BUFFERS_MIN_MIB,
    max: SHARED_BUFFERS_MAX_MIB,
    step: 128,
    fmt: fmtSharedBuffers,
    hint: "Postgres's own page cache, sized here in real MiB/GiB. The plaza is a fixed 1,024-frame sample of that pool; each MiB implies 128 8 KiB buffers.",
  },
  {
    key: 'bgwriterEnabled',
    label: 'Background writer',
    group: 'memory',
    kind: 'toggle',
    hint: 'Trickles dirty pages out just ahead of the clock sweep so backends rarely have to write a victim themselves. There is no on/off GUC — in Postgres you disable it with bgwriter_lru_maxpages = 0, the slider below; bgwriter_delay only changes how often it wakes.',
  },
  {
    key: 'bgwriterLruMaxpages',
    label: 'bgwriter_lru_maxpages',
    guc: 'bgwriter_lru_maxpages',
    group: 'memory',
    kind: 'range',
    min: 0,
    max: 400,
    step: 10,
    unit: 'pages/round',
    hint: 'Ceiling on how much the background writer may clean per round.',
  },
  {
    key: 'synchronousCommit',
    label: 'synchronous_commit',
    guc: 'synchronous_commit',
    group: 'wal',
    kind: 'select',
    options: [
      { value: 'off', label: 'off — fast, can lose commits' },
      { value: 'local', label: 'local — fsync here only' },
      { value: 'on', label: 'on — fsync before ack' },
      { value: 'remote_apply', label: 'remote_apply — standby applied it' },
    ],
    hint: 'How long COMMIT waits before telling the client yes. The single biggest latency/durability trade-off in Postgres.',
    danger: true,
  },
  {
    key: 'walLevel',
    label: 'wal_level',
    guc: 'wal_level',
    group: 'wal',
    kind: 'select',
    options: [
      { value: 'minimal', label: 'minimal — no replication' },
      { value: 'replica', label: 'replica — physical standbys' },
      { value: 'logical', label: 'logical — row-level decoding' },
    ],
    hint: 'How much detail goes into the WAL. More detail means more bytes, and more things you can build on it.',
  },
  {
    key: 'fullPageWrites',
    label: 'full_page_writes',
    guc: 'full_page_writes',
    group: 'wal',
    kind: 'toggle',
    hint: 'The first write to a page after a checkpoint logs the entire 8 KiB page — protection against torn writes, and the reason WAL volume surges from the moment each checkpoint starts.',
    danger: true,
  },
  {
    key: 'maxWalSize',
    label: 'max_wal_size',
    guc: 'max_wal_size',
    group: 'checkpoint',
    kind: 'range',
    min: 32,
    max: 2048,
    step: 32,
    unit: 'MiB',
    hint: 'When WAL grows past this, a checkpoint is forced whether it was due or not.',
  },
  {
    key: 'checkpointTimeout',
    label: 'checkpoint_timeout',
    guc: 'checkpoint_timeout',
    group: 'checkpoint',
    kind: 'range',
    min: 15,
    max: 600,
    step: 5,
    unit: 's',
    hint: 'Maximum time between checkpoints. Longer means less write amplification but slower crash recovery.',
  },
  {
    key: 'checkpointCompletionTarget',
    label: 'checkpoint_completion_target',
    guc: 'checkpoint_completion_target',
    group: 'checkpoint',
    kind: 'range',
    min: 0.1,
    max: 1,
    step: 0.05,
    hint: 'Spreads the checkpoint write phase over this fraction of the interval instead of dumping it all at once.',
  },
  {
    key: 'autovacuum',
    label: 'autovacuum',
    guc: 'autovacuum',
    group: 'vacuum',
    kind: 'toggle',
    hint: 'Turn it off and watch dead rows pile up until the tables are mostly corpses. Never do this in production.',
    danger: true,
  },
  {
    key: 'autovacuumScaleFactor',
    label: 'autovacuum_vacuum_scale_factor',
    guc: 'autovacuum_vacuum_scale_factor',
    group: 'vacuum',
    kind: 'range',
    min: 0.01,
    max: 0.5,
    step: 0.01,
    hint: 'A table is vacuumed once this fraction of its rows are dead. Lower means more frequent, cheaper vacuums. PostgreSQL defaults to 0.2; this city starts at 0.02, the kind of per-table setting the docs recommend for a busy relation, so the yard is not idle for a whole visit.',
  },
  {
    key: 'replicaEnabled',
    label: 'standby_a connected',
    group: 'replication',
    kind: 'toggle',
    hint: 'Whether standby_a is streaming from the primary. Its physical slot remains when this is off and retains WAL.',
  },
  {
    key: 'replicaNetworkLag',
    label: 'standby_a network',
    group: 'replication',
    kind: 'range',
    min: 0,
    max: 400,
    step: 5,
    unit: 'ms',
    hint: 'One-way network delay to standby_a. This is the standby named as synchronous: on waits for its flush and remote_apply waits for replay.',
  },
  {
    key: 'replicaSlowApply',
    label: 'standby_a slow replay',
    group: 'replication',
    kind: 'toggle',
    hint: 'standby_a receives and flushes WAL but its startup process cannot apply it fast enough.',
  },
  {
    key: 'standbyBEnabled',
    label: 'standby_b connected',
    group: 'replication',
    kind: 'toggle',
    hint: 'Disconnect standby_b without dropping standby_b_slot. The inactive slot keeps holding primary WAL.',
  },
  {
    key: 'standbyBNetworkLag',
    label: 'standby_b network',
    group: 'replication',
    kind: 'range',
    min: 0,
    max: 400,
    step: 5,
    unit: 'ms',
    hint: 'One-way network delay to standby_b. It has its own walsender, wire, walreceiver, and status replies.',
  },
  {
    key: 'standbyBSlowApply',
    label: 'standby_b slow replay',
    group: 'replication',
    kind: 'toggle',
    hint: 'Slow only standby_b’s startup process. Received and flushed WAL can stay current while applied WAL falls behind.',
  },
  {
    key: 'standbyLongQuery',
    label: 'Long standby query',
    group: 'replication',
    kind: 'toggle',
    hint: 'A long read on the standby reports its xmin through hot_standby_feedback and pins cleanup on the primary.',
    danger: true,
  },
  {
    key: 'archiveAvailable',
    label: 'Archive object store',
    group: 'recovery',
    kind: 'toggle',
    hint: 'Reachability of the remote repository used by pgBackRest archive-push. Off makes archive_command return nonzero, so PostgreSQL retries the oldest completed segment while pg_wal grows.',
    danger: true,
  },
  {
    key: 'backupRetention',
    label: 'repo1-retention-full',
    group: 'recovery',
    kind: 'range',
    min: 1,
    max: 5,
    step: 1,
    unit: 'full backups',
    hint: 'pgBackRest full-backup count retention. Expiring a backup also expires the older archived WAL recovery window tied to it.',
  },
  {
    key: 'recoveryTargetAge',
    label: 'recovery_target_time',
    group: 'recovery',
    kind: 'range',
    min: 0,
    max: 300,
    step: 5,
    unit: 's ago',
    hint: 'Choose a point before now. PITR fetches the newest retained full backup old enough for that target, then replays archived WAL forward.',
  },
  {
    key: 'patroniDcsAvailable',
    label: 'Patroni DCS available',
    group: 'replication',
    kind: 'toggle',
    hint: 'The DCS holds Patroni’s leader lock. If it becomes unreachable, the lease drains and the current leader demotes; no standby may promote without acquiring that lock.',
    danger: true,
  },
  {
    key: 'walLogHints',
    label: 'wal_log_hints',
    guc: 'wal_log_hints',
    group: 'recovery',
    kind: 'toggle',
    hint: 'Records enough full-page information for pg_rewind to find changed blocks when data checksums are off. It must have been enabled before the divergence.',
    danger: true,
  },
  {
    key: 'oldPrimaryDataIntact',
    label: 'Former primary data intact',
    group: 'chaos',
    kind: 'toggle',
    hint: 'Whether pg_rewind can still read the former primary’s data directory. If the storage is gone, rebuilding from a base backup is the remaining path.',
    danger: true,
  },
  {
    key: 'rewindWalRetained',
    label: 'Divergence WAL retained',
    group: 'chaos',
    kind: 'toggle',
    hint: 'Whether the WAL needed to reach the common checkpoint is still available. Recycled required WAL makes pg_rewind fail.',
    danger: true,
  },
  {
    key: 'longRunningXact',
    label: 'Long-running transaction',
    group: 'chaos',
    kind: 'toggle',
    hint: 'One forgotten open transaction pins the xmin horizon, so vacuum can no longer remove row versions whose deleting transaction has not fallen behind it. Bloat forever.',
    danger: true,
  },
  {
    key: 'lockContention',
    label: 'Lock contention',
    group: 'chaos',
    kind: 'toggle',
    hint: 'A conflicting lock on a hot table. Watch the waiters queue up and latency go vertical.',
    danger: true,
  },
  {
    key: 'timeScale',
    label: 'Speed',
    group: 'sim',
    kind: 'range',
    min: 0.1,
    max: 5,
    step: 0.1,
    unit: '×',
    hint: 'Simulation speed. Slow it down to watch a single commit; speed it up to watch a day of checkpoints.',
  },
  {
    key: 'paused',
    label: 'Pause',
    group: 'sim',
    kind: 'toggle',
    hint: 'Freeze the city mid-flight and fly around it.',
  },
]

const _knobById = new Map<string, KnobMeta>(KNOB_META.map((k) => [k.key as string, k]))

export function knobMeta(key: keyof Knobs): KnobMeta | undefined {
  return _knobById.get(key as string)
}

export function knobsInGroup(group: KnobGroup): KnobMeta[] {
  return KNOB_META.filter((k) => k.group === group)
}

/* ---------------------------------------------------------------------------
 * Tiny markdown: **bold**, `code`, *em*, [text](url). Escapes HTML first, so it
 * is safe to feed it doc strings.
 * -------------------------------------------------------------------------*/

export function mdToHtml(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n\n/g, '<br><br>')
}
