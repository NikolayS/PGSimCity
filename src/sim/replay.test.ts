import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { SCENARIOS } from './scenarios'
import {
  createIncidentReplay,
  decodeReplay,
  encodeReplay,
  REPLAY_MAX_ACTIONS,
  REPLAY_MAX_TICKS,
} from './replay'

const STEP = 1 / 30

function run(sim: ReturnType<typeof createSim>, steps: number): void {
  for (let i = 0; i < steps; i++) sim.update(STEP)
}

describe('reproducible incident initialization', () => {
  it('restores the same complete warm state after prior work', () => {
    const sim = createSim(createBus())
    const initial = structuredClone(sim.state)
    sim.runScenario('vacuum-blockade')
    run(sim, 600)
    sim.reset()
    expect(sim.state).toEqual(initial)
  })

  it('repeats a seeded workload and distinguishes another seed', () => {
    const first = createSim(createBus(), { seed: 42 })
    const repeat = createSim(createBus(), { seed: 42 })
    const other = createSim(createBus(), { seed: 43 })
    run(first, 90)
    run(repeat, 90)
    run(other, 90)
    expect(first.state).toEqual(repeat.state)
    expect(first.state.backends).not.toEqual(other.state.backends)
  })

  it.each([-1, 0x1_0000_0000, 1.5, NaN, Infinity])('rejects invalid seed %s', (seed) => {
    expect(() => createSim(createBus(), { seed })).toThrow('seed')
  })

  it.each(SCENARIOS.map((scenario) => scenario.id))('resets all warm state after %s', (id) => {
    const sim = createSim(createBus(), { seed: 7 })
    const initial = structuredClone(sim.state)
    sim.runScenario(id)
    run(sim, 123)
    sim.reset()
    expect(sim.state).toEqual(initial)
  })
})

function incident(seed = 42) {
  const bus = createBus()
  const sim = createSim(bus, { seed })
  const replay = createIncidentReplay(sim, bus, { seed })
  return { sim, bus, replay }
}

describe('bounded incident replay', () => {
  it('counts overlapping physical slot WAL retention once', async () => {
    const { sim, replay } = incident()
    sim.state.replication.physicalSlots[0].retainedBytes = 100
    sim.state.replication.physicalSlots[1].retainedBytes = 150
    await replay.rewind(0)
    expect(replay.compare()?.baseline.retainedWalBytes).toBe(150)
    replay.dispose()
  })
  it('notifies restored listeners only after reconstructed state is ready', async () => {
    const { sim, replay } = incident()
    run(sim, 70)
    const expected = structuredClone(sim.state)
    let calls = 0
    const unsubscribe = replay.onRestored(() => {
      expect(replay.status.seeking).toBe(false)
      expect(sim.state).toEqual(expected)
      calls++
    })
    await replay.rewind(70)
    expect(calls).toBe(1)
    unsubscribe()
    await replay.rewind(70)
    expect(calls).toBe(1)
    replay.dispose()
  })
  it('rejects an incorrect seed and nonstandard model step configuration at attachment', () => {
    const bus = createBus()
    const sim = createSim(bus, { seed: 43 })
    expect(() => createIncidentReplay(sim, bus, { seed: 42 })).toThrow(/seed/i)
    const probeBus = createBus()
    const probe = createSim(probeBus, { maxStep: 0.1 })
    expect(() => createIncidentReplay(probe, probeBus)).toThrow(/configuration/i)
  })

  it('exports only the restored prefix while retaining future ticks until a branch starts', async () => {
    const { sim, replay } = incident()
    sim.setKnob('tps', 500)
    run(sim, 10)
    const prefix = replay.checkpoint()
    const initial = structuredClone(sim.state)
    sim.setKnob('workMem', 64)
    run(sim, 10)
    const end = structuredClone(sim.state)
    await replay.rewind(prefix)
    expect(sim.state).toEqual(initial)
    expect(replay.status.totalTicks).toBe(20)
    expect(replay.status.tick).toBe(10)
    expect(replay.exportRecord().ticks).toBe(10)
    expect(replay.exportRecord().actions).toHaveLength(1)
    await replay.rewind(20)
    expect(sim.state).toEqual(end)
    await replay.rewind(prefix)
    sim.setKnob('workMem', 128)
    sim.update(STEP)
    expect(replay.status.totalTicks).toBe(11)
    expect(replay.exportRecord().actions.at(-1)).toMatchObject({ key: 'workMem', value: 128 })
    await expect(replay.rewind(20)).rejects.toThrow()
    replay.dispose()
  })

  it('preserves same-tick before/after action checkpoints without dropping earlier actions', async () => {
    const { sim, replay } = incident()
    sim.setKnob('workMem', 8)
    const first = replay.checkpoint()
    sim.setKnob('workMem', 64)
    run(sim, 1)
    await replay.rewind(first)
    expect(sim.state.knobs.workMem).toBe(8)
    expect(replay.exportRecord().actions).toHaveLength(1)
    await expect(replay.rewind({ tick: 1, actionCount: 0 })).rejects.toThrow(/order/i)
    replay.dispose()
  })

  it('restores complete state, same-tick action order, and shared state references', async () => {
    const { sim, replay } = incident()
    const state = sim.state
    const buffers = state.buffers
    const backends = state.backends
    sim.runScenario('vacuum-blockade')
    run(sim, 180)
    const point = replay.checkpoint()
    const expected = structuredClone(state)
    sim.setKnob('tps', 1400, 'user')
    sim.setKnob('timeScale', 2, 'user')
    run(sim, 90)
    await replay.rewind(point)
    expect(sim.state).toBe(state)
    expect(sim.state.buffers).toBe(buffers)
    expect(sim.state.backends).toBe(backends)
    expect(sim.state).toEqual(expected)
    expect(replay.status.seeking).toBe(false)
    const record = replay.exportRecord()
    const repeat = incident()
    await repeat.replay.loadRecord(record)
    expect(repeat.sim.state).toEqual(expected)
    replay.dispose()
    repeat.replay.dispose()
  })

  it('rewinds a real decision, records another branch, and compares measured model outcomes', async () => {
    const { sim, replay } = incident()
    sim.runScenario('vacuum-blockade')
    for (let i = 0; i < 1800 && sim.state.scenarioDecision?.phase !== 'ready'; i++) sim.update(STEP)
    expect(sim.state.scenarioDecision?.phase).toBe('ready')
    const decision = replay.checkpoint()
    const staged = structuredClone(sim.state)
    expect(sim.chooseScenario('wait-for-transaction')).toBe(true)
    sim.setKnob('tps', 1800, 'user')
    run(sim, 90)
    const waiting = structuredClone(sim.state)
    const waitingRecord = replay.exportRecord()
    await replay.rewind(decision)
    expect(sim.state).toEqual(staged)
    expect(sim.chooseScenario('terminate-transaction')).toBe(true)
    sim.setKnob('tps', 1800, 'user')
    run(sim, 90)
    const alternative = structuredClone(sim.state)
    expect(alternative.knobs.longRunningXact).toBe(false)
    expect(waiting.knobs.longRunningXact).toBe(true)
    expect(replay.compare()?.sameDuration).toBe(true)
    expect(replay.compare()?.baseline.elapsedTicks).toBe(replay.compare()?.current.elapsedTicks)
    const alternativeRecord = replay.exportRecord()
    expect(alternativeRecord.actions.some((action) => action.type === 'decision' && action.choice === 'wait-for-transaction')).toBe(false)
    await replay.loadRecord(waitingRecord)
    expect(sim.state).toEqual(waiting)
    await replay.loadRecord(alternativeRecord)
    expect(sim.state).toEqual(alternative)
    replay.dispose()
  }, 30_000)

  it('records direct and bus actions once while ignoring scenario-generated changes', async () => {
    const { sim, bus, replay } = incident()
    bus.emit('scenario', { id: 'work-mem-spill' })
    bus.emit('knob', { key: 'tps', value: 500, source: 'user' })
    sim.setKnob('workMem', 16, 'user')
    run(sim, 45)
    expect(replay.exportRecord().actions.map((action) => action.type)).toEqual(['scenario', 'knob', 'knob'])
    const expected = structuredClone(sim.state)
    const record = replay.exportRecord()
    await replay.loadRecord(record)
    expect(sim.state).toEqual(expected)
    replay.dispose()
  })

  it('does not replay a duplicate bus scenario as a scenario restart', async () => {
    const { sim, bus, replay } = incident()
    bus.emit('scenario', { id: 'vacuum-blockade' })
    run(sim, 45)
    bus.emit('scenario', { id: 'vacuum-blockade' })
    run(sim, 3)
    const expected = structuredClone(sim.state)
    const record = replay.exportRecord()
    await replay.loadRecord(record)
    expect(sim.state).toEqual(expected)
    replay.dispose()
  })

  it('records exact update durations and pause boundaries without a per-frame action', async () => {
    const { sim, replay } = incident()
    sim.update(1 / 60)
    sim.update(1 / 60)
    sim.setKnob('paused', true)
    sim.update(0.1)
    sim.setKnob('paused', false)
    sim.setKnob('timeScale', 3)
    sim.update(0.1)
    expect(replay.status.tick).toBe(3)
    const expected = structuredClone(sim.state)
    const record = replay.exportRecord()
    expect(record.steps).toEqual([{ count: 2, dt: 1 / 60 }, { count: 1, dt: 0.1 }])
    await replay.loadRecord(record)
    expect(sim.state).toEqual(expected)
    replay.dispose()
  })

  it('exposes seeking during reset events and yields without advancing from live frames', async () => {
    const { sim, bus, replay } = incident()
    run(sim, 70)
    const expected = structuredClone(sim.state)
    const seekingAtReset: boolean[] = []
    bus.on('sim:reset', () => seekingAtReset.push(replay.status.seeking))
    const seek = replay.rewind(70)
    expect(replay.status.seeking).toBe(true)
    sim.update(2)
    expect(() => sim.setKnob('tps', 1)).toThrow(/seeking|rewind/i)
    await seek
    expect(sim.state).toEqual(expected)
    expect(seekingAtReset.length).toBeGreaterThan(0)
    expect(seekingAtReset.every(Boolean)).toBe(true)
    replay.dispose()
  })

  it.each(['startBaseBackup', 'startPgRewind', 'endTrace'] as const)(
    'invalidates export after unsupported mutation %s until reset', (method) => {
      const { sim, replay } = incident()
      sim[method]()
      expect(replay.status.valid).toBe(false)
      expect(() => replay.exportRecord()).toThrow(/unsupported/i)
      sim.reset()
      expect(replay.status.valid).toBe(true)
      expect(replay.status.tick).toBe(0)
      replay.dispose()
    },
  )

  it('stops recording explicitly at the action limit without blocking the model', () => {
    const { sim, replay } = incident()
    for (let i = 0; i <= REPLAY_MAX_ACTIONS; i++) sim.setKnob('tps', i % 2 ? 100 : 200)
    expect(replay.status.actionCount).toBe(REPLAY_MAX_ACTIONS)
    expect(sim.state.knobs.tps).toBe(200)
    expect(() => replay.exportRecord()).toThrow(/limit/i)
    replay.dispose()
  })

  it('round-trips owned share data and rejects hostile records before changing state', async () => {
    const { sim, replay } = incident()
    sim.runScenario('vacuum-blockade')
    run(sim, 3)
    const record = replay.exportRecord()
    expect(decodeReplay(encodeReplay(record))).toEqual(record)
    const expected = structuredClone(sim.state)
    const badRecords: unknown[] = [
      { ...record, version: 999 },
      { ...record, modelVersion: 'different-model' },
      { ...record, seed: 43 },
      { ...record, ticks: REPLAY_MAX_TICKS + 1 },
      { ...record, steps: [{ count: 3, dt: Infinity }] },
      { ...record, steps: [{ count: 3, dt: -1 }] },
      { ...record, steps: [{ count: 3, dt: 1000 }] },
      { ...record, actions: [{ tick: 0, type: 'knob', key: '__proto__', value: {} }] },
      { ...record, actions: [{ tick: 0, type: 'knob', key: 'tps', value: 1e100 }] },
      { ...record, actions: [{ tick: 0, type: 'scenario', id: '<script>' }] },
      { ...record, actions: [{ tick: 0, type: 'decision', choice: 'arbitrary-code' }] },
      { ...record, actions: [{ tick: 4, type: 'recover' }] },
      { ...record, actions: [{ tick: 2, type: 'recover' }, { tick: 1, type: 'recover' }] },
      { ...record, actions: Array(REPLAY_MAX_ACTIONS + 1).fill({ tick: 0, type: 'recover' }) },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ]
    for (const bad of badRecords) {
      await expect(replay.loadRecord(bad)).rejects.toThrow()
      expect(sim.state).toEqual(expected)
    }
    expect(() => decodeReplay('['.repeat(100_000))).toThrow(/size|large|limit/i)
    expect(() => decodeReplay('not json')).toThrow()
    replay.dispose()
  })
})
