import type {
  Knobs,
  PlanNode,
  QueryKind,
  SimApi,
  SyncCommit,
  TraceRecord,
  TraceStop,
} from '../core/types'
import { fmtBytes } from '../core/util'
import { traceStopBit } from '../sim/model'
import { sqlFor } from '../sim/model'
import { TRACE_COPY } from '../ui/trace-copy'
import { el, setClass, setText } from '../ui/uikit'
import { TABLES } from '../world/layout'
import { createFlowArchitecture } from './flow-architecture'
import type { FlowArchitecture } from './flow-architecture'

export interface FlowChoice {
  kind: QueryKind
  tableId: 'accounts' | 'sessions' | 'orders'
  label: string
  hot?: boolean
}

export const FLOW_CHOICES: readonly FlowChoice[] = [
  { kind: 'select_idx', tableId: 'accounts', label: 'Point SELECT' },
  { kind: 'select_seq', tableId: 'sessions', label: 'Sequential scan' },
  { kind: 'aggregate', tableId: 'orders', label: 'Aggregate' },
  { kind: 'insert', tableId: 'orders', label: 'INSERT' },
  { kind: 'update', tableId: 'sessions', label: 'Non-HOT UPDATE', hot: false },
  { kind: 'delete', tableId: 'sessions', label: 'DELETE' },
]

export interface FlowSegment {
  stop: Exclude<TraceStop, 'blocked'>
  label: string
  detail: string
  skipOnRead?: boolean
}

export const FLOW_PATH: readonly FlowSegment[] = [
  {
    stop: 'connect',
    label: 'Client → connection',
    detail: 'postmaster → backend',
  },
  {
    stop: 'parse_plan',
    label: 'Parse → plan',
    detail: 'SQL becomes a plan tree',
  },
  {
    stop: 'fetch',
    label: 'Buffer pool ⇄ storage',
    detail: 'shared_buffers first',
  },
  {
    stop: 'work',
    label: 'Execute',
    detail: 'the backend runs the plan',
  },
  {
    stop: 'wal',
    label: 'wal_buffers',
    detail: 'record the change',
    skipOnRead: true,
  },
  {
    stop: 'commit',
    label: 'pg_wal (fsync) → commit',
    detail: 'wait for the requested durability',
    skipOnRead: true,
  },
  {
    stop: 'send',
    label: 'Rows out',
    detail: 'results or command status',
  },
  {
    stop: 'done',
    label: 'Complete',
    detail: 'one statement trip',
  },
]

export type FlowSegmentStatus = 'pending' | 'current' | 'done' | 'skipped'

function isWrite(query: QueryKind): boolean {
  return query === 'insert' || query === 'update' || query === 'delete'
}

export function segmentStatus(
  trace: TraceRecord,
  segment: FlowSegment,
): FlowSegmentStatus {
  if (segment.skipOnRead && !isWrite(trace.query)) return 'skipped'
  if (trace.stop === segment.stop) return 'current'
  return (trace.visited & traceStopBit(segment.stop)) !== 0 ? 'done' : 'pending'
}

/**
 * Captures only timestamps emitted by the model trace. A missed transition
 * remains unknown; the view never fills a gap with a UI-owned stop sequence.
 */
export class FlowTiming {
  private entered: Partial<Record<TraceStop, number>> = {}
  private elapsed: Partial<Record<TraceStop, number>> = {}
  private lastStop: TraceStop | null = null
  private lastVisited = 0
  private sql = ''

  reset(): void {
    this.entered = {}
    this.elapsed = {}
    this.lastStop = null
    this.lastVisited = 0
    this.sql = ''
  }

  observe(trace: TraceRecord): void {
    if (trace.visited === 0 || !trace.sql) return
    if (
      trace.sql !== this.sql
      || trace.visited < this.lastVisited
      || (this.lastStop === 'done' && trace.stop === 'connect')
    ) {
      this.reset()
      this.sql = trace.sql
    }

    if (trace.stop !== this.lastStop) {
      if (this.lastStop !== null) {
        const from = this.entered[this.lastStop]
        if (from !== undefined && trace.stopT >= from) {
          this.elapsed[this.lastStop] = trace.stopT - from
        }
      }
      this.entered[trace.stop] = trace.stopT
      this.lastStop = trace.stop
    }

    this.lastVisited = trace.visited
  }

  duration(stop: TraceStop, trace: TraceRecord): number | null {
    if (stop === 'done') return 0
    const finished = this.elapsed[stop]
    if (finished !== undefined) return finished
    if (trace.stop !== stop) return null
    const from = this.entered[stop]
    return from === undefined ? null : Math.max(0, trace.lastTripSec - from)
  }

  snapshot(trace: TraceRecord): Partial<Record<TraceStop, number>> {
    const result = { ...this.elapsed }
    if (this.lastStop !== null && result[this.lastStop] === undefined) {
      result[this.lastStop] = this.duration(this.lastStop, trace) ?? undefined
    }
    return result
  }
}

export type FlowLinkState =
  | {
      statement: QueryKind
      setting: 'synchronous_commit'
      a: SyncCommit
      b: SyncCommit
    }
  | {
      statement: QueryKind
      setting: 'shared_buffers'
      a: number
      b: number
    }

const QUERY_KINDS = new Set<QueryKind>(FLOW_CHOICES.map((choice) => choice.kind))
const SYNC_VALUES = new Set<SyncCommit>(['off', 'local', 'on', 'remote_apply'])
const DEFAULT_FLOW_STATE: FlowLinkState = {
  statement: 'update',
  setting: 'synchronous_commit',
  a: 'on',
  b: 'off',
}

function parseBuffers(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 32 && parsed <= 16_384 ? parsed : null
}

export function parseFlowQuery(search: string): FlowLinkState {
  const params = new URLSearchParams(search)
  const statement = params.get('statement') as QueryKind | null
  if (!statement || !QUERY_KINDS.has(statement)) return { ...DEFAULT_FLOW_STATE }

  if (params.get('setting') === 'shared_buffers') {
    const a = parseBuffers(params.get('a'))
    const b = parseBuffers(params.get('b'))
    if (a !== null && b !== null) {
      return { statement, setting: 'shared_buffers', a, b }
    }
    return { ...DEFAULT_FLOW_STATE }
  }

  if (params.get('setting') === 'synchronous_commit') {
    const a = params.get('a') as SyncCommit | null
    const b = params.get('b') as SyncCommit | null
    if (a && b && SYNC_VALUES.has(a) && SYNC_VALUES.has(b)) {
      return { statement, setting: 'synchronous_commit', a, b }
    }
  }

  return { ...DEFAULT_FLOW_STATE }
}

export function serializeFlowQuery(state: FlowLinkState): string {
  const params = new URLSearchParams({
    view: 'flow',
    statement: state.statement,
    setting: state.setting,
    a: String(state.a),
    b: String(state.b),
  })
  return `?${params.toString()}`
}

export interface FlowLaneSettings {
  synchronousCommit: SyncCommit
  sharedBuffers: number
}

export function laneSettings(
  state: FlowLinkState,
): readonly [FlowLaneSettings, FlowLaneSettings] {
  if (state.setting === 'synchronous_commit') {
    return [
      { synchronousCommit: state.a, sharedBuffers: 2048 },
      { synchronousCommit: state.b, sharedBuffers: 2048 },
    ]
  }
  return [
    { synchronousCommit: 'on', sharedBuffers: state.a },
    { synchronousCommit: 'on', sharedBuffers: state.b },
  ]
}

interface PlanSnapshot {
  id: number
  label: string
  detail: string
  rows: number
  cost: number
  actualMs: number
  activity: number
  children: PlanSnapshot[]
}

interface RunSnapshot {
  trace: TraceRecord
  timings: Partial<Record<TraceStop, number>>
  plan: PlanSnapshot | null
}

type LanePhase = 'ready' | 'waiting' | 'running' | 'done'

interface LaneState {
  phase: LanePhase
  timing: FlowTiming
  snapshot: RunSnapshot | null
  plan: PlanSnapshot | null
  planFinalized: boolean
}

interface TimeElements {
  timeBar: HTMLElement
  timeLabel: HTMLElement
}

interface LaneElements {
  root: HTMLElement
  phase: HTMLElement
  architecture: FlowArchitecture
  timeStops: TimeElements[]
  narrative: HTMLElement
  narrativeTitle: HTMLElement
  narrativeLine: HTMLElement
  narrativeHint: HTMLElement
  metrics: Record<'hits' | 'reads' | 'wal' | 'rows' | 'xid' | 'total', HTMLElement>
  plan: HTMLElement
  timeAxisEnd: HTMLElement
}

export interface Flow2dView {
  root: HTMLElement
  update(): void
  dispose(): void
}

type FlowBaseline = Pick<
  Knobs,
  | 'tps'
  | 'timeScale'
  | 'paused'
  | 'synchronousCommit'
  | 'sharedBuffers'
  | 'lockContention'
>

const BUFFER_OPTIONS = [32, 128, 512, 2048, 8192] as const
const SYNC_OPTIONS: readonly SyncCommit[] = ['on', 'off', 'local', 'remote_apply']

const flowTableIndex = (choice: FlowChoice): number =>
  TABLES.findIndex((table) => table.id === choice.tableId)

function copyPlan(node: PlanNode): PlanSnapshot {
  return {
    id: node.id,
    label: node.label,
    detail: node.detail,
    rows: node.rows,
    cost: node.cost,
    actualMs: node.actualMs,
    activity: node.activity,
    children: node.children.map(copyPlan),
  }
}

function metric(label: string): { root: HTMLElement; value: HTMLElement } {
  const value = el('dd', { text: '—' })
  return {
    root: el('div', { class: 'flow-metric' }, el('dt', { text: label }), value),
    value,
  }
}

function planTree(plan: PlanSnapshot | PlanNode): HTMLElement {
  const item = el(
    'li',
    {
      class: `flow-plan__node${plan.activity > 0.14 ? ' is-active' : ''}`,
      role: 'treeitem',
      'aria-label': `${plan.label}, ${plan.rows} rows, cost ${plan.cost}, ${plan.actualMs.toFixed(1)} milliseconds`,
    },
    el(
      'div',
      { class: 'flow-plan__row' },
      el('strong', { text: plan.label }),
      el('span', { text: `${plan.rows} rows` }),
      el('span', { text: `cost ${plan.cost}` }),
      el('span', { text: `${plan.actualMs.toFixed(1)} ms` }),
    ),
    el('code', { text: plan.detail }),
  )
  if (plan.children.length) {
    item.append(
      el(
        'ul',
        { role: 'group' },
        ...plan.children.map((child) => planTree(child).firstElementChild as HTMLElement),
      ),
    )
  }
  return el('ul', { class: 'flow-plan', role: 'tree', 'aria-label': 'Execution plan' }, item)
}

function makeLane(
  name: 'A' | 'B',
  settings: FlowLaneSettings,
): LaneElements {
  const phase = el('span', { class: 'flow-lane__phase', text: 'READY' })
  const setting = el('code', {
    class: 'flow-lane__setting',
    text: `synchronous_commit=${settings.synchronousCommit} · shared_buffers=${settings.sharedBuffers} MiB`,
  })
  const architecture = createFlowArchitecture(`flow-${name.toLowerCase()}`)
  const timeStops = FLOW_PATH.map((segment) => {
    const timeLabel = el('span', { class: 'flow-time__label' })
    const timeBar = el(
      'span',
      { class: `flow-time__bar stop-${segment.stop}` },
      timeLabel,
    )
    return { timeBar, timeLabel }
  })

  const hits = metric('Buffer hits')
  const reads = metric('Storage reads')
  const wal = metric('WAL bytes')
  const rows = metric('Rows sent')
  const xid = metric('xid')
  const total = metric('Total time')
  const plan = el(
    'div',
    { class: 'flow-plan-wrap' },
    el('p', { class: 'flow-empty', text: 'The model will put the execution plan tree here.' }),
  )
  const narrativeTitle = el('strong')
  const narrativeLine = el('span')
  const narrativeHint = el('small')
  const narrative = el(
    'div',
    { class: 'flow-narrative', 'aria-live': 'polite', 'aria-atomic': 'true' },
    narrativeTitle,
    narrativeLine,
    narrativeHint,
  )
  const timeAxisEnd = el('span', { text: '—' })

  return {
    root: el(
      'section',
      { class: 'flow-lane', 'aria-label': `Comparison run ${name}` },
      el(
        'header',
        { class: 'flow-lane__head' },
        el('span', { class: 'flow-lane__letter', text: name }),
        el('div', {}, setting),
        phase,
      ),
      el(
        'div',
        { class: 'flow-architecture-wrap' },
        architecture.root,
      ),
      el(
        'div',
        { class: 'flow-architecture-legend', 'aria-label': 'Connection legend' },
        el('span', { class: 'legend-control', text: 'query / process control' }),
        el('span', { class: 'legend-read', text: 'buffer read' }),
        el('span', { class: 'legend-wal', text: 'WAL write / flush' }),
        el('span', { class: 'legend-background', text: 'background work' }),
      ),
      narrative,
      el(
        'dl',
        { class: 'flow-metrics', 'aria-label': 'Numbers for this statement trip' },
        hits.root,
        reads.root,
        wal.root,
        rows.root,
        xid.root,
        total.root,
      ),
      el(
        'section',
        { class: 'flow-time' },
        el('h3', { text: 'Time by stop' }),
        el('div', { class: 'flow-time__axis' }, el('span', { text: '0' }), timeAxisEnd),
        el('div', { class: 'flow-time__bars' }, ...timeStops.map((stop) => stop.timeBar)),
      ),
      el(
        'section',
        { class: 'flow-plan-section' },
        el('h3', { text: 'Live plan tree' }),
        plan,
      ),
    ),
    phase,
    architecture,
    timeStops,
    narrative,
    narrativeTitle,
    narrativeLine,
    narrativeHint,
    metrics: {
      hits: hits.value,
      reads: reads.value,
      wal: wal.value,
      rows: rows.value,
      xid: xid.value,
      total: total.value,
    },
    plan,
    timeAxisEnd,
  }
}

function selectOption(value: string, label = value): HTMLOptionElement {
  return el('option', { value, text: label })
}

const TRACE_COMPONENTS: Readonly<
  Record<Exclude<TraceStop, 'blocked'>, readonly string[]>
> = {
  connect: ['client', 'postmaster', 'backend'],
  parse_plan: ['backend'],
  fetch: ['backend', 'buffer-pool'],
  work: ['backend', 'private-memory'],
  wal: ['backend', 'wal-buffers'],
  commit: ['wal-buffers', 'kernel-page-cache', 'pg-wal-store'],
  send: ['backend', 'postmaster', 'client'],
  done: ['client'],
}

function paintArchitecture(
  architecture: FlowArchitecture,
  trace: TraceRecord | null,
  query: QueryKind,
): void {
  for (const component of architecture.components.values()) {
    component.classList.remove('is-current', 'is-visited')
  }
  architecture.root.dataset.stop = trace?.stop ?? 'ready'
  if (!trace) return

  for (const segment of FLOW_PATH) {
    const status = segmentStatus(trace, segment)
    if (status !== 'current' && status !== 'done') continue
    const ids = TRACE_COMPONENTS[segment.stop]
    for (const id of ids) {
      const component = architecture.components.get(id)
      if (component) component.classList.add(status === 'current' ? 'is-current' : 'is-visited')
    }
    if (
      segment.stop === 'fetch'
      && trace.buffersRead > 0
      && (status === 'current' || status === 'done')
    ) {
      architecture.components.get('kernel-page-cache')?.classList.add(
        status === 'current' ? 'is-current' : 'is-visited',
      )
      architecture.components.get('base-store')?.classList.add(
        status === 'current' ? 'is-current' : 'is-visited',
      )
    }
  }

  if (trace.stop === 'blocked') {
    architecture.components.get('backend')?.classList.add('is-current')
    architecture.components.get('lock-table')?.classList.add('is-current')
  }

  if (!isWrite(query)) {
    architecture.components.get('wal-buffers')?.classList.remove('is-current', 'is-visited')
    architecture.components.get('pg-wal-store')?.classList.remove('is-current', 'is-visited')
  }
}

/**
 * The lifecycle is a projection of the shared SimApi. Calls go through the
 * public API; the view never writes SimState or manufactures lifecycle stops.
 */
export function createFlow2dView(
  sim: SimApi,
  initial: FlowLinkState,
  onLinkChange: (state: FlowLinkState) => void,
): Flow2dView {
  let linkState = initial
  let selected = FLOW_CHOICES.find((choice) => choice.kind === linkState.statement)
    ?? FLOW_CHOICES[4]
  let settings = laneSettings(linkState)
  let baseline: FlowBaseline | null = null
  let activeLane: 0 | 1 | null = null
  let awaitingTrace = false
  let disposed = false
  let lastPaintAt = -Infinity

  const lanes: [LaneState, LaneState] = [
    {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    },
    {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    },
  ]
  let laneEls: [LaneElements, LaneElements]

  const choiceButtons = FLOW_CHOICES.map((choice) => {
    const table = TABLES[flowTableIndex(choice)]
    const button = el(
      'button',
      {
        class: 'flow-choice',
        type: 'button',
        'aria-pressed': String(choice.kind === selected.kind),
      },
      el(
        'span',
        { class: 'flow-choice__meta' },
        el('strong', { text: choice.label }),
        el('span', { text: table.name }),
      ),
      el('code', { text: sqlFor(choice.kind, flowTableIndex(choice)) }),
    )
    button.addEventListener('click', () => {
      if (choice.kind === selected.kind) return
      cancelRun()
      selected = choice
      linkState = { ...linkState, statement: choice.kind } as FlowLinkState
      choiceButtons.forEach((candidate, index) => {
        const on = FLOW_CHOICES[index].kind === selected.kind
        setClass(candidate, 'is-selected', on)
        candidate.setAttribute('aria-pressed', String(on))
      })
      rebuildLanes()
      syncControls()
      onLinkChange(linkState)
    })
    return button
  })

  const settingSelect = el(
    'select',
    { class: 'flow-control__select', 'aria-label': 'Setting to compare' },
    selectOption('synchronous_commit'),
    selectOption('shared_buffers'),
  )
  const valueA = el('select', {
    class: 'flow-control__select',
    'aria-label': 'Run A setting value',
  })
  const valueB = el('select', {
    class: 'flow-control__select',
    'aria-label': 'Run B setting value',
  })
  const comparisonNote = el('p', { class: 'flow-control__note' })
  const runButton = el('button', {
    class: 'flow-run',
    type: 'button',
    text: 'Run A, then B',
  })
  const runStatus = el('span', {
    class: 'flow-run__status',
    'aria-live': 'polite',
    text: 'Ready for a controlled comparison.',
  })
  const sql = el('code', { class: 'flow-sql' })
  const laneGrid = el('div', { class: 'flow-lanes' })

  function rebuildLanes(): void {
    settings = laneSettings(linkState)
    laneEls = [makeLane('A', settings[0]), makeLane('B', settings[1])]
    laneGrid.replaceChildren(laneEls[0].root, laneEls[1].root)
    lanes[0] = {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    }
    lanes[1] = {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    }
    setText(sql, sqlFor(selected.kind, flowTableIndex(selected)))
    paint(true)
  }

  function refillValues(): void {
    valueA.replaceChildren()
    valueB.replaceChildren()
    if (linkState.setting === 'synchronous_commit') {
      for (const value of SYNC_OPTIONS) {
        valueA.append(selectOption(value))
        valueB.append(selectOption(value))
      }
    } else {
      for (const value of BUFFER_OPTIONS) {
        const label = `${value} MiB`
        valueA.append(selectOption(String(value), label))
        valueB.append(selectOption(String(value), label))
      }
    }
  }

  function syncControls(): void {
    settingSelect.value = linkState.setting
    refillValues()
    valueA.value = String(linkState.a)
    valueB.value = String(linkState.b)
    const identical = linkState.a === linkState.b
    runButton.disabled = identical || activeLane !== null
    setText(
      comparisonNote,
      linkState.setting === 'synchronous_commit'
        ? 'Only synchronous_commit changes. Both runs use 2 GiB of shared_buffers. Each lane is a fresh model trip, so its row and plan sample can vary.'
        : 'Only shared_buffers changes. Both runs use synchronous_commit = on. Each lane is a fresh model trip, so its row and plan sample can vary.',
    )
    if (identical) setText(runStatus, 'Choose two different values so only one setting changes.')
  }

  function updateLinkFromControls(): void {
    cancelRun()
    if (settingSelect.value === 'shared_buffers') {
      linkState = {
        statement: selected.kind,
        setting: 'shared_buffers',
        a: Number(valueA.value),
        b: Number(valueB.value),
      }
    } else {
      linkState = {
        statement: selected.kind,
        setting: 'synchronous_commit',
        a: valueA.value as SyncCommit,
        b: valueB.value as SyncCommit,
      }
    }
    rebuildLanes()
    syncControls()
    onLinkChange(linkState)
  }

  settingSelect.addEventListener('change', () => {
    cancelRun()
    linkState = settingSelect.value === 'shared_buffers'
      ? {
          statement: selected.kind,
          setting: 'shared_buffers',
          a: 2048,
          b: 128,
        }
      : {
          statement: selected.kind,
          setting: 'synchronous_commit',
          a: 'on',
          b: 'off',
        }
    rebuildLanes()
    syncControls()
    onLinkChange(linkState)
  })
  valueA.addEventListener('change', updateLinkFromControls)
  valueB.addEventListener('change', updateLinkFromControls)

  function captureBaseline(): FlowBaseline {
    const knobs = sim.state.knobs
    return {
      tps: knobs.tps,
      timeScale: knobs.timeScale,
      paused: knobs.paused,
      synchronousCommit: knobs.synchronousCommit,
      sharedBuffers: knobs.sharedBuffers,
      lockContention: knobs.lockContention,
    }
  }

  function restoreBaseline(): void {
    if (!baseline) return
    const saved = baseline
    baseline = null
    sim.endTrace()
    sim.setKnob('tps', saved.tps)
    sim.setKnob('timeScale', saved.timeScale)
    sim.setKnob('synchronousCommit', saved.synchronousCommit)
    sim.setKnob('sharedBuffers', saved.sharedBuffers)
    sim.setKnob('lockContention', saved.lockContention)
    sim.setKnob('paused', saved.paused)
  }

  function applyLane(index: 0 | 1): void {
    const lane = lanes[index]
    const config = settings[index]
    sim.setKnob('tps', 18)
    sim.setKnob('timeScale', 0.2)
    sim.setKnob('paused', false)
    sim.setKnob('lockContention', false)
    sim.setKnob('synchronousCommit', config.synchronousCommit)
    sim.setKnob('sharedBuffers', config.sharedBuffers)
    sim.setTraceMode('slow')
    sim.request(selected.kind, flowTableIndex(selected), { hot: selected.hot })
    lane.phase = 'waiting'
    lane.timing.reset()
    lane.snapshot = null
    lane.plan = null
    lane.planFinalized = false
    activeLane = index
    awaitingTrace = true
    setText(runStatus, `Run ${index === 0 ? 'A' : 'B'} is waiting for a backend.`)
  }

  function startRun(): void {
    if (linkState.a === linkState.b || activeLane !== null) return
    baseline = captureBaseline()
    sim.endTrace()
    lanes[0] = {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    }
    lanes[1] = {
      phase: 'ready',
      timing: new FlowTiming(),
      snapshot: null,
      plan: null,
      planFinalized: false,
    }
    runButton.disabled = true
    applyLane(0)
    paint(true)
  }
  runButton.addEventListener('click', startRun)

  function cancelRun(): void {
    if (activeLane === null && baseline === null) return
    activeLane = null
    awaitingTrace = false
    restoreBaseline()
    setText(runStatus, 'Comparison stopped.')
  }

  function traceForLane(index: 0 | 1): TraceRecord | null {
    const lane = lanes[index]
    if (lane.snapshot) return lane.snapshot.trace
    return activeLane === index && !awaitingTrace ? sim.state.trace : null
  }

  function planForLane(index: 0 | 1): PlanSnapshot | PlanNode | null {
    const lane = lanes[index]
    if (lane.snapshot) return lane.snapshot.plan
    if (activeLane !== index || awaitingTrace) return null
    const trace = sim.state.trace
    if (trace.slot < 0) return null
    const backend = sim.state.backends[trace.slot]
    if (!backend || backend.query !== selected.kind || backend.table !== flowTableIndex(selected)) {
      return null
    }
    return backend.plan ?? lane.plan
  }

  function finishLane(index: 0 | 1): void {
    const lane = lanes[index]
    const trace = sim.state.trace
    lane.timing.observe(trace)
    lane.snapshot = {
      trace: { ...trace },
      timings: lane.timing.snapshot(trace),
      plan: lane.plan,
    }
    lane.phase = 'done'
    if (index === 0) {
      setText(runStatus, 'Run A is complete. Run B is starting with one setting changed.')
      applyLane(1)
    } else {
      activeLane = null
      awaitingTrace = false
      restoreBaseline()
      setText(runStatus, 'Both runs are complete. Their paths share the same time scale.')
      runButton.disabled = false
    }
    paint(true)
  }

  function updateRun(): void {
    if (activeLane === null) return
    const trace = sim.state.trace
    if (awaitingTrace) {
      const requested =
        trace.sql.length > 0
        && trace.query === selected.kind
        && (trace.visited & traceStopBit('connect')) !== 0
        && trace.stop !== 'done'
      if (!requested) return
      awaitingTrace = false
      lanes[activeLane].phase = 'running'
      setText(runStatus, `Run ${activeLane === 0 ? 'A' : 'B'} is moving through PostgreSQL.`)
    }

    const lane = lanes[activeLane]
    lane.timing.observe(trace)
    if (trace.slot >= 0) {
      const plan = sim.state.backends[trace.slot]?.plan
      if (plan && lane.plan === null) lane.plan = copyPlan(plan)
      if (plan && trace.stop === 'send' && !lane.planFinalized) {
        lane.plan = copyPlan(plan)
        lane.planFinalized = true
      }
    }
    if (trace.stop === 'done' && (trace.visited & traceStopBit('done')) !== 0) {
      finishLane(activeLane)
    }
  }

  function paintLane(index: 0 | 1): void {
    const lane = lanes[index]
    const elements = laneEls[index]
    const trace = traceForLane(index)
    setText(elements.phase, lane.phase.toUpperCase())
    elements.root.dataset.phase = lane.phase

    for (let i = 0; i < FLOW_PATH.length; i++) {
      const segment = FLOW_PATH[i]
      const stage = elements.architecture.stages[segment.stop]
      const status = trace
        ? segmentStatus(trace, segment)
        : segment.skipOnRead && !isWrite(selected.kind)
          ? 'skipped'
          : 'pending'

      const elapsed = lane.snapshot
        ? lane.snapshot.timings[segment.stop] ?? null
        : trace
          ? lane.timing.duration(segment.stop, trace)
          : null
      stage.root.setAttribute('class', `flow-trace-stage is-${status}`)
      stage.root.setAttribute(
        'aria-label',
        `${segment.label}. ${
          status === 'current'
            ? 'Current step'
            : status === 'done'
              ? 'Done'
              : status === 'skipped'
                ? 'Skipped for this statement'
                : 'Waiting'
        }. ${
          status === 'skipped'
            ? 'Not visited'
            : elapsed === null
              ? 'Duration not known'
              : `${(elapsed * 1000).toFixed(0)} milliseconds`
        }. ${segment.detail}`,
      )
      if (status === 'current') stage.root.setAttribute('aria-current', 'step')
      else stage.root.removeAttribute('aria-current')
    }
    paintArchitecture(elements.architecture, trace, selected.kind)

    if (!trace) {
      setText(elements.narrativeTitle, index === 0 ? 'Run A is ready' : 'Run B follows automatically')
      setText(elements.narrativeLine, 'The complete path stays visible while the model advances.')
      setText(elements.narrativeHint, 'Skipped write stops remain in the path and are struck through.')
    } else {
      const copy = TRACE_COPY[trace.stop]
      setText(elements.narrativeTitle, copy.title)
      setText(elements.narrativeLine, copy.line(trace))
      setText(elements.narrativeHint, copy.hint)
    }

    setText(elements.metrics.hits, trace ? String(trace.buffersHit) : '—')
    setText(elements.metrics.reads, trace ? String(trace.buffersRead) : '—')
    setText(elements.metrics.wal, trace ? fmtBytes(trace.walBytes) : '—')
    setText(elements.metrics.rows, trace ? String(trace.rowsSent) : '—')
    setText(
      elements.metrics.xid,
      trace ? (trace.lastXid > 0 ? String(trace.lastXid) : 'not assigned') : '—',
    )
    setText(
      elements.metrics.total,
      trace ? `${(trace.lastTripSec * 1000).toFixed(0)} ms` : '—',
    )

    const plan = planForLane(index)
    if (plan) {
      elements.plan.replaceChildren(planTree(plan))
    } else {
      elements.plan.replaceChildren(
        el('p', {
          class: 'flow-empty',
          text: trace?.stop === 'done'
            ? 'No plan was captured for this trip.'
            : 'The model will put the execution plan tree here.',
        }),
      )
    }
  }

  function durationFor(index: 0 | 1, stop: TraceStop): number {
    const lane = lanes[index]
    const trace = traceForLane(index)
    if (!trace) return 0
    return lane.snapshot?.timings[stop] ?? lane.timing.duration(stop, trace) ?? 0
  }

  function paintTimeAxes(): void {
    const totals = ([0, 1] as const).map((lane) =>
      FLOW_PATH.reduce((sum, segment) => sum + durationFor(lane, segment.stop), 0),
    )
    const max = Math.max(0.001, totals[0], totals[1])
    for (const index of [0, 1] as const) {
      setText(laneEls[index].timeAxisEnd, `${(max * 1000).toFixed(0)} ms`)
      for (let i = 0; i < FLOW_PATH.length; i++) {
        const segment = FLOW_PATH[i]
        const duration = durationFor(index, segment.stop)
        const stop = laneEls[index].timeStops[i]
        stop.timeBar.style.flexBasis = `${(duration / max) * 100}%`
        stop.timeBar.hidden =
          segment.skipOnRead && !isWrite(selected.kind)
          || duration <= 0
        setText(stop.timeLabel, `${segment.label} ${(duration * 1000).toFixed(0)} ms`)
        stop.timeBar.title = `${segment.label}: ${(duration * 1000).toFixed(0)} ms`
      }
    }
  }

  function paint(force = false): void {
    const now = performance.now()
    if (!force && now - lastPaintAt < 120) return
    lastPaintAt = now
    paintLane(0)
    paintLane(1)
    paintTimeAxes()
  }

  const root = el(
    'article',
    { class: 'flow2d' },
    el(
      'header',
      { class: 'flow-hero' },
      el('p', { class: 'eyebrow', text: 'ONE STATEMENT · THE WHOLE JOURNEY' }),
      el('h1', { text: 'See the entire query lifecycle without moving a camera.' }),
      el('p', {
        class: 'lede',
        text: 'The same TypeScript model that runs the city writes this trace at 30 Hz. The path, plan and figures below are projections of that record—not a PostgreSQL server and not a second lifecycle engine.',
      }),
      sql,
    ),
    el(
      'section',
      { class: 'flow-picker', 'aria-labelledby': 'flow-picker-title' },
      el('h2', { id: 'flow-picker-title', text: 'Choose one honest model statement' }),
      el('p', {
        text: 'These six statements are the complete v1 grammar. Free-text SQL would imply behavior the model does not have.',
      }),
      el('div', { class: 'flow-choices', role: 'group', 'aria-label': 'Statement' }, ...choiceButtons),
    ),
    el(
      'section',
      { class: 'flow-controls', 'aria-labelledby': 'flow-compare-title' },
      el(
        'div',
        {},
        el('h2', { id: 'flow-compare-title', text: 'Change one setting' }),
        comparisonNote,
      ),
      el(
        'label',
        { class: 'flow-control' },
        el('span', { text: 'Compare' }),
        settingSelect,
      ),
      el(
        'label',
        { class: 'flow-control' },
        el('span', { text: 'A' }),
        valueA,
      ),
      el(
        'label',
        { class: 'flow-control' },
        el('span', { text: 'B' }),
        valueB,
      ),
      runButton,
      runStatus,
    ),
    laneGrid,
    el('p', {
      class: 'flow-scale-note',
      text: 'Times are simulated and deliberately stretched so sub-second mechanisms remain visible. The bars compare model duration; they are not database benchmarks.',
    }),
  )

  rebuildLanes()
  choiceButtons.forEach((button, index) => {
    setClass(button, 'is-selected', FLOW_CHOICES[index].kind === selected.kind)
  })
  syncControls()

  return {
    root,
    update() {
      if (disposed) return
      if (activeLane === null) return
      updateRun()
      if (activeLane !== null) paint()
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelRun()
    },
  }
}
