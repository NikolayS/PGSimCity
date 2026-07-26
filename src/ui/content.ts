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
  return undefined
}

export function hasDoc(id: string | null | undefined): boolean {
  return !!doc(id)
}

/* ---------------------------------------------------------------------------
 * Knob metadata — how each dial is rendered, what GUC it stands for, and what
 * it teaches. The control rail and the inspector both read this.
 * -------------------------------------------------------------------------*/

export type KnobGroup = 'workload' | 'memory' | 'wal' | 'checkpoint' | 'vacuum' | 'replication' | 'chaos' | 'sim'

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
    kind: 'logrange',
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
    label: 'Standby connected',
    group: 'replication',
    kind: 'toggle',
    hint: 'Whether a physical standby is streaming from this primary.',
  },
  {
    key: 'replicaNetworkLag',
    label: 'Network latency',
    group: 'replication',
    kind: 'range',
    min: 0,
    max: 400,
    step: 5,
    unit: 'ms',
    hint: 'One-way network delay to the standby. synchronous_commit = on waits for a LOCAL flush and pays none of it; only remote_apply makes a commit wait for the round trip.',
  },
  {
    key: 'replicaSlowApply',
    label: 'Slow replay',
    group: 'replication',
    kind: 'toggle',
    hint: 'The standby receives WAL fine but cannot apply it fast enough — the classic source of replication lag.',
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
