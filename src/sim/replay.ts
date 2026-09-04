import { BUILD_SHA, BUILD_VERSION } from '../core/build'
import { DEFAULT_KNOBS } from '../core/types'
import type { Bus, BusEvents, Knobs, ScenarioChoiceId, SimApi } from '../core/types'
import { simulationReplayConfiguration } from './model'
import { SCENARIOS } from './scenarios'

export const REPLAY_MAX_TICKS = 18_000
export const REPLAY_MAX_ACTIONS = 1024
export const REPLAY_MAX_BYTES = 96 * 1024
export const REPLAY_MODEL_VERSION = `incident-1/${BUILD_VERSION}/${BUILD_SHA}`
const MAX_MODEL_SECONDS = 600
const MAX_DELTA = 2
const SEEK_BATCH = 64
const attached = new WeakSet<SimApi>()
const attachedBuses = new WeakSet<Bus>()

export type ReplayAction = { tick: number } & (
  | { type: 'knob'; key: keyof Knobs; value: Knobs[keyof Knobs]; source?: 'user' }
  | { type: 'scenario'; id: string | null }
  | { type: 'decision'; choice: ScenarioChoiceId }
  | { type: 'recover' }
)

export interface ReplayRecord {
  version: 1
  modelVersion: string
  seed: number
  ticks: number
  steps: { count: number; dt: number }[]
  actions: ReplayAction[]
}

export interface ReplayPoint {
  tick: number
  /** Distinguishes before and after a decision made without advancing time. */
  actionCount: number
}

export interface ReplayStatus extends ReplayPoint {
  totalTicks: number
  valid: boolean
  reason: string
  seeking: boolean
  seekProgress: number
}

export interface ReplayOutcome {
  elapsedTicks: number
  elapsedModelSeconds: number
  scenario: string | null
  commits: number
  rollbacks: number
  throughputTps: number
  latencyP99ModelMs: number
  deadTuples: number
  tablePages: number
  reclaimedTuples: number
  retainedWalBytes: number
  rejectedWrites: number
  lostTransactions: number
}

const numericBounds: Partial<Record<keyof Knobs, readonly [number, number]>> = {
  tps: [0, 10_000], clientConnections: [1, 2000], defaultPoolSize: [1, 100],
  maxClientConn: [1, 2000], queryWaitTimeout: [0, 600], writeRatio: [0, 1],
  updateRatio: [0, 1], seqScanRatio: [0, 1], sharedBuffers: [128, 65536],
  workMem: [1, 256], checkpointTimeout: [1, 3600], checkpointCompletionTarget: [0.1, 1],
  maxWalSize: [1, 8192], bgwriterLruMaxpages: [0, 400], autovacuumScaleFactor: [0, 1],
  standbyANetworkLag: [0, 400], standbyBNetworkLag: [0, 400],
  walGDownloadConcurrency: [1, 16], backupRetention: [1, 5], recoveryTargetAge: [0, 300],
  timeScale: [0.05, 20],
}
const enums: Partial<Record<keyof Knobs, readonly string[]>> = {
  poolMode: ['disabled', 'session', 'transaction', 'statement'],
  synchronousCommit: ['off', 'local', 'remote_write', 'on', 'remote_apply'],
  synchronousStandbyNames: ['none', 'standbyA', 'standbyB'],
  walLevel: ['minimal', 'replica', 'logical'], recoveryTargetTimeline: ['latest', 'current'],
  restoreDrillFault: ['none', 'empty_other_table', 'corrupt_object'],
  haPartition: ['healthy', 'isolate_node', 'isolate_dcs_majority', 'split_dcs'],
}
const scenarioIds = new Set(SCENARIOS.map((scenario) => scenario.id))
const choices = new Set(SCENARIOS.flatMap((scenario) => scenario.decision?.choices.map((choice) => choice.id) ?? []))

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid replay object')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid replay prototype')
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown replay field: ${key}`)
  }
}

function integer(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid replay ${name}`)
  }
  return value
}

function knob(key: unknown, value: unknown): key is keyof Knobs {
  if (typeof key !== 'string' || !Object.hasOwn(DEFAULT_KNOBS, key)) return false
  const name = key as keyof Knobs
  if (typeof DEFAULT_KNOBS[name] === 'boolean') return typeof value === 'boolean'
  const range = numericBounds[name]
  if (range) return typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1]
  return typeof value === 'string' && enums[name]?.includes(value) === true
}

function action(value: unknown, ticks: number): ReplayAction {
  const item = object(value)
  const tick = integer(item.tick, 0, ticks, 'action tick')
  switch (item.type) {
    case 'knob':
      fields(item, ['tick', 'type', 'key', 'value', 'source'])
      if (!knob(item.key, item.value) || (item.source !== undefined && item.source !== 'user')) {
        throw new Error('Invalid replay knob')
      }
      return { tick, type: 'knob', key: item.key, value: item.value as Knobs[keyof Knobs],
        ...(item.source === 'user' ? { source: 'user' as const } : {}) }
    case 'scenario':
      fields(item, ['tick', 'type', 'id'])
      if (item.id !== null && (typeof item.id !== 'string' || !scenarioIds.has(item.id))) {
        throw new Error('Invalid replay scenario')
      }
      return { tick, type: 'scenario', id: item.id as string | null }
    case 'decision':
      fields(item, ['tick', 'type', 'choice'])
      if (!choices.has(item.choice as ScenarioChoiceId)) throw new Error('Invalid replay decision')
      return { tick, type: 'decision', choice: item.choice as ScenarioChoiceId }
    case 'recover':
      fields(item, ['tick', 'type'])
      return { tick, type: 'recover' }
    default:
      throw new Error('Unsupported replay action')
  }
}

function validateRecord(value: unknown): ReplayRecord {
  const item = object(value)
  fields(item, ['version', 'modelVersion', 'seed', 'ticks', 'steps', 'actions'])
  if (item.version !== 1) throw new Error('Unsupported replay format version')
  if (item.modelVersion !== REPLAY_MODEL_VERSION) throw new Error('Replay model-version mismatch')
  const seed = integer(item.seed, 0, 0xffff_ffff, 'seed')
  const ticks = integer(item.ticks, 0, REPLAY_MAX_TICKS, 'tick limit')
  if (!Array.isArray(item.steps) || item.steps.length > REPLAY_MAX_TICKS) throw new Error('Replay step limit exceeded')
  if (!Array.isArray(item.actions) || item.actions.length > REPLAY_MAX_ACTIONS) throw new Error('Replay action limit exceeded')
  const steps: ReplayRecord['steps'] = []
  let count = 0
  let seconds = 0
  for (const entry of item.steps) {
    const run = object(entry)
    fields(run, ['count', 'dt'])
    const n = integer(run.count, 1, REPLAY_MAX_TICKS, 'step count')
    if (typeof run.dt !== 'number' || !Number.isFinite(run.dt) || run.dt <= 0 || run.dt > MAX_DELTA) {
      throw new Error('Invalid replay step duration')
    }
    count += n
    seconds += n * run.dt
    if (count > ticks || seconds > MAX_MODEL_SECONDS + 1e-7) throw new Error('Replay duration limit exceeded')
    steps.push({ count: n, dt: run.dt })
  }
  if (count !== ticks) throw new Error('Replay step count does not match ticks')
  const actions: ReplayAction[] = []
  let previous = 0
  for (const entry of item.actions) {
    const parsed = action(entry, ticks)
    if (parsed.tick < previous) throw new Error('Replay actions are out of order')
    previous = parsed.tick
    actions.push(parsed)
  }
  return { version: 1, modelVersion: REPLAY_MODEL_VERSION, seed, ticks, steps, actions }
}

export function encodeReplay(value: unknown): string {
  const text = JSON.stringify(validateRecord(value))
  if (text.length > REPLAY_MAX_BYTES) throw new Error('Replay share size limit exceeded')
  return text
}

export function decodeReplay(text: string): ReplayRecord {
  if (typeof text !== 'string' || text.length > REPLAY_MAX_BYTES) throw new Error('Replay share size limit exceeded')
  return validateRecord(JSON.parse(text))
}

/** Attach to a fresh model before consumers capture its methods (timebase/UI). */
export function createIncidentReplay(
  sim: SimApi,
  bus: Bus,
  options: { seed?: number; onChange?: () => void } = {},
) {
  const configuration = simulationReplayConfiguration(sim)
  const seed = configuration?.seed
  if (seed === undefined || (options.seed !== undefined && options.seed !== seed)) {
    throw new Error('Replay seed does not match the model instance')
  }
  if (!configuration?.standard) throw new Error('Unsupported replay model configuration')
  if (attached.has(sim) || attachedBuses.has(bus)) throw new Error('Replay is already attached')
  if (sim.state.realT !== 0) throw new Error('Replay must attach before the first model update')
  attached.add(sim)
  attachedBuses.add(bus)
  const original = { ...sim }
  const originalEmit = bus.emit
  const durations = new Float64Array(REPLAY_MAX_TICKS)
  const log: ReplayAction[] = []
  const status: ReplayStatus = {
    tick: 0, actionCount: 0, totalTicks: 0, valid: true, reason: '', seeking: false, seekProgress: 0,
  }
  let elapsed = 0
  let originTime = sim.state.t
  let busy = 0
  let disposed = false
  let baseline: ReplayOutcome | null = null
  const restoredListeners = new Set<() => void>()

  function notify(): void { options.onChange?.() }
  function invalidate(reason: string): void {
    if (!status.valid) return
    status.valid = false
    status.reason = reason
    notify()
  }
  function requireReady(): void {
    if (disposed) throw new Error('Replay controller is disposed')
    if (status.seeking) throw new Error('Cannot change the model while seeking a replay')
  }
  function requireValid(): void {
    requireReady()
    if (!status.valid) throw new Error(status.reason)
  }
  function branch(): void {
    log.length = status.actionCount
    status.totalTicks = status.tick
  }
  function record(next: ReplayAction): void {
    if (!status.valid) return
    branch()
    if (log.length >= REPLAY_MAX_ACTIONS) {
      invalidate('Replay action limit reached; reset to record another incident')
      return
    }
    log.push(next)
    status.actionCount = log.length
    notify()
  }
  function invoke<T>(next: ReplayAction, execute: () => T): T {
    requireReady()
    record(action(next, status.tick))
    busy++
    try { return execute() } finally { busy-- }
  }
  function apply(next: ReplayAction): void {
    switch (next.type) {
      case 'knob': original.setKnob(next.key, next.value, next.source); break
      case 'scenario': original.runScenario(next.id); break
      case 'decision': original.chooseScenario(next.choice); break
      case 'recover': original.recoverScenario(); break
    }
  }
  function outcome(): ReplayOutcome {
    const state = sim.state
    let deadTuples = 0
    let tablePages = 0
    let retainedWalBytes = 0
    for (const table of state.tables) { deadTuples += table.deadTuples; tablePages += table.pages }
    // Both slots retain overlapping suffixes of the same WAL stream.
    for (const slot of state.replication.physicalSlots) retainedWalBytes = Math.max(retainedWalBytes, slot.retainedBytes)
    return {
      elapsedTicks: status.tick, elapsedModelSeconds: state.t - originTime, scenario: state.scenario,
      commits: state.stats.commits, rollbacks: state.stats.rollbacks, throughputTps: state.stats.tps,
      latencyP99ModelMs: state.stats.latency.p99.totalMs, deadTuples, tablePages,
      reclaimedTuples: state.autovac.landfill, retainedWalBytes,
      rejectedWrites: state.disasterRecovery.archive.rejectedWrites,
      lostTransactions: state.highAvailability.transition.lossTransactions,
    }
  }

  sim.update = (dt: number): void => {
    if (status.seeking) return
    if (Number.isFinite(dt) && dt > 0 && !sim.state.knobs.paused) {
      if (status.valid) {
        branch()
        if (status.tick >= REPLAY_MAX_TICKS || dt > MAX_DELTA || elapsed + dt > MAX_MODEL_SECONDS + 1e-7) {
          invalidate('Replay duration limit reached; reset to record another incident')
        } else {
          durations[status.tick] = dt
          elapsed += dt
          status.totalTicks++
        }
      }
      status.tick++
    }
    busy++
    try { original.update(dt) } finally { busy-- }
  }
  sim.setKnob = (key, value, source) => invoke(
    { tick: status.tick, type: 'knob', key, value, ...(source ? { source } : {}) },
    () => original.setKnob(key, value, source),
  )
  sim.runScenario = (id) => invoke({ tick: status.tick, type: 'scenario', id }, () => original.runScenario(id))
  sim.chooseScenario = (choice) => invoke({ tick: status.tick, type: 'decision', choice }, () => original.chooseScenario(choice))
  sim.recoverScenario = () => invoke({ tick: status.tick, type: 'recover' }, () => original.recoverScenario())

  bus.emit = <K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void => {
    if (status.seeking && (type === 'flow' || type === 'toast' || type === 'narrate' || type === 'focus')) return
    if (!busy && (type === 'knob' || type === 'scenario')) {
      const next = type === 'knob'
        ? { tick: status.tick, type: 'knob', ...(payload as BusEvents['knob']) }
        : { tick: status.tick, type: 'scenario', ...(payload as BusEvents['scenario']) }
      requireReady()
      // The bus ignores a repeated scenario; a direct runScenario restarts it.
      if (type !== 'scenario' || (payload as BusEvents['scenario']).id !== sim.state.scenario) {
        record(action(next, status.tick))
      }
      busy++
      try { originalEmit(type, payload) } finally { busy-- }
      return
    }
    originalEmit(type, payload)
  }

  const unsupported = [
    'request', 'setTraceMode', 'endTrace', 'startBaseBackup', 'startPointInTimeRestore',
    'startRestoreDrill', 'setLeaderOpinion', 'startSwitchover', 'startFailover', 'startPgRewind',
  ] as const
  for (const method of unsupported) {
    const raw = original[method] as (...args: unknown[]) => unknown
    ;(sim as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      requireReady()
      invalidate(`Unsupported replay action: ${method}; reset to record another incident`)
      busy++
      try { return raw(...args) } finally { busy-- }
    }
  }

  function reset(): void {
    requireReady()
    log.length = 0
    status.tick = status.totalTicks = status.actionCount = 0
    status.valid = true
    status.reason = ''
    status.seekProgress = 0
    elapsed = 0
    baseline = null
    busy++
    try { original.reset() } finally { busy-- }
    originTime = sim.state.t
    notify()
  }
  sim.reset = reset

  function pointAt(value: number | ReplayPoint): ReplayPoint {
    const tick = integer(typeof value === 'number' ? value : value.tick, 0, status.totalTicks, 'rewind tick')
    let actionCount = 0
    while (actionCount < log.length && log[actionCount].tick <= tick) actionCount++
    if (typeof value !== 'number') {
      actionCount = integer(value.actionCount, 0, actionCount, 'checkpoint action count')
      if (actionCount < log.length && log[actionCount].tick < tick) throw new Error('Invalid replay checkpoint order')
    }
    return { tick, actionCount }
  }

  async function seek(target: ReplayPoint): Promise<void> {
    status.seeking = true
    status.seekProgress = 0
    notify()
    busy++
    try {
      original.reset()
      originTime = sim.state.t
      elapsed = 0
      let at = 0
      for (let tick = 0; tick <= target.tick; tick++) {
        if (disposed) throw new Error('Replay controller was disposed during rewind')
        while (at < target.actionCount && log[at].tick === tick) apply(log[at++])
        if (tick === target.tick) break
        original.update(durations[tick])
        elapsed += durations[tick]
        status.seekProgress = (tick + 1) / Math.max(1, target.tick)
        if ((tick + 1) % SEEK_BATCH === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      status.tick = target.tick
      status.actionCount = target.actionCount
      status.seekProgress = 1
      originalEmit('sim:reset', {})
    } catch (error) {
      invalidate('Replay reconstruction failed; reset before recording again')
      throw error
    } finally {
      busy--
      status.seeking = false
      notify()
    }
    for (const listener of restoredListeners) listener()
  }

  return {
    status: status as Readonly<ReplayStatus>,
    onRestored(listener: () => void): () => void {
      restoredListeners.add(listener)
      return () => { restoredListeners.delete(listener) }
    },
    checkpoint: (): ReplayPoint => ({ tick: status.tick, actionCount: status.actionCount }),
    async rewind(value: number | ReplayPoint): Promise<void> {
      requireValid()
      const target = pointAt(value)
      baseline = outcome()
      await seek(target)
    },
    compare(): { baseline: ReplayOutcome; current: ReplayOutcome; sameDuration: boolean } | null {
      if (!baseline) return null
      const current = outcome()
      return { baseline: { ...baseline }, current,
        sameDuration: Math.abs(baseline.elapsedModelSeconds - current.elapsedModelSeconds) < 1e-7 }
    },
    exportRecord(): ReplayRecord {
      requireValid()
      const steps: ReplayRecord['steps'] = []
      for (let tick = 0; tick < status.tick; tick++) {
        const previous = steps[steps.length - 1]
        if (previous && previous.dt === durations[tick]) previous.count++
        else steps.push({ count: 1, dt: durations[tick] })
      }
      const record: ReplayRecord = {
        version: 1, modelVersion: REPLAY_MODEL_VERSION, seed, ticks: status.tick, steps,
        actions: log.slice(0, status.actionCount).map((entry) => ({ ...entry })),
      }
      encodeReplay(record)
      return record
    },
    async loadRecord(value: unknown): Promise<void> {
      requireReady()
      const record = decodeReplay(encodeReplay(value))
      if (record.seed !== seed) throw new Error('Replay seed does not match this model instance')
      let tick = 0
      for (const run of record.steps) {
        durations.fill(run.dt, tick, tick + run.count)
        tick += run.count
      }
      log.length = 0
      log.push(...record.actions)
      status.valid = true
      status.reason = ''
      status.totalTicks = record.ticks
      baseline = null
      await seek({ tick: record.ticks, actionCount: log.length })
    },
    reset,
    dispose(): void {
      disposed = true
      restoredListeners.clear()
      Object.assign(sim, original)
      bus.emit = originalEmit
      attached.delete(sim)
      attachedBuses.delete(bus)
    },
  }
}

export type IncidentReplay = ReturnType<typeof createIncidentReplay>
