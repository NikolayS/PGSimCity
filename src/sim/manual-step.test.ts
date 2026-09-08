import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'
import { createAggregateSim } from './test-support'

describe('deliberate model-second advancement', () => {
  it('advances while paused without consuming wall time or unpausing', () => {
    const sim = createSim(createBus())
    sim.setKnob('paused', true)
    const before = sim.state.t
    const realT = sim.state.realT
    sim.update(0.5)
    expect(sim.state.t).toBe(before)
    expect(sim.advance(0.5)).toBeCloseTo(0.5, 12)
    expect(sim.state.t - before).toBeCloseTo(0.5, 12)
    expect(sim.state.realT).toBe(realT)
    expect(sim.state.knobs.paused).toBe(true)
    sim.update(0.5)
    expect(sim.state.t - before).toBeCloseTo(0.5, 12)
  })

  it('rejects running, invalid and nonpositive requests without mutation', () => {
    const sim = createSim(createBus())
    const before = structuredClone(sim.state)
    expect(sim.advance(0.5)).toBe(0)
    expect(sim.state).toEqual(before)
    sim.setKnob('paused', true)
    const paused = structuredClone(sim.state)
    for (const duration of [NaN, Infinity, -Infinity, -1, 0]) {
      expect(sim.advance(duration)).toBe(0)
      expect(sim.state).toEqual(paused)
    }
  })

  it('bounds excessive requests and ignores the speed multiplier', () => {
    for (const speed of [0.25, 1, 4]) {
      const sim = createSim(createBus())
      sim.setKnob('timeScale', speed)
      sim.setKnob('paused', true)
      const before = sim.state.t
      const actual = sim.advance(1000)
      expect(actual).toBeCloseTo(2 / 3, 12)
      expect(sim.state.t - before).toBeCloseTo(actual, 12)
      expect(sim.state.knobs.timeScale).toBe(speed)
    }
  })

  it('uses the same subdivisions, events and seeded workload as normal update', () => {
    const runningBus = createBus()
    const pausedBus = createBus()
    const running = createSim(runningBus)
    const paused = createSim(pausedBus)
    const runningEvents: unknown[] = []
    const pausedEvents: unknown[] = []
    runningBus.on('flow', event => runningEvents.push(structuredClone(event)))
    pausedBus.on('flow', event => pausedEvents.push(structuredClone(event)))
    paused.setKnob('paused', true)
    for (let i = 0; i < 40; i++) {
      running.update(0.5)
      paused.advance(0.5)
    }
    expect(pausedEvents.length).toBeGreaterThan(0)
    expect(pausedEvents).toEqual(runningEvents)
    const actual = structuredClone(paused.state)
    actual.knobs.paused = false
    actual.realT = running.state.realT
    expect(actual).toEqual(running.state)
  })
})


it('steps a real vacuum intervention through eligibility and later sessions collection', () => {
  const sim = createAggregateSim(1 / 3)
  sim.runScenario('vacuum-blockade')
  sim.setKnob('paused', true)
  for (let i = 0; i < 180; i++) sim.advance(1 / 3)
  const decision = sim.state.scenarioDecision
  if (decision?.kind !== 'vacuum-blockade') throw Error('Missing vacuum decision')
  expect(decision.phase).toBe('ready')
  expect(sim.state.knobs.longRunningXact).toBe(true)
  const oldHorizon = sim.state.xminHorizon
  const sessions = sim.state.tables.find(t => t.def.id === 'sessions')!
  const pages = sessions.pages
  expect(sim.chooseScenario('terminate-transaction')).toBe(true)
  expect(decision.sessionsReclaimedAfterRelease).toBe(0)
  expect(decision.phase).toBe('outcome')
  sim.advance(1 / 3)
  expect(sim.state.xminHorizon).toBeGreaterThan(oldHorizon)
  expect(decision.sessionsReclaimedAfterRelease).toBe(0)
  for (let i = 0; i < 2700 && decision.phase !== 'recovered'; i++) sim.advance(1 / 3)
  expect(decision.phase).toBe('recovered')
  expect(decision.sessionsReclaimedAfterRelease).toBeGreaterThan(0)
  expect(sessions.pages).toBeGreaterThanOrEqual(pages)
  expect(sim.state.knobs.paused).toBe(true)
})

it('emits only completed manual durations for presentation, without fake wall-clock ticks', () => {
  const bus = createBus()
  const sim = createSim(bus)
  const durations: number[] = []
  bus.on('sim:advance', e => durations.push(e.seconds))
  sim.advance(0.1)
  sim.update(0.1)
  expect(durations).toEqual([])
  sim.setKnob('paused', true)
  sim.advance(NaN)
  sim.advance(0.1)
  sim.advance(0.1)
  expect(durations).toHaveLength(2)
  expect(durations[0]).toBeCloseTo(0.1, 12)
  expect(durations[1]).toBeCloseTo(0.1, 12)
  expect(sim.state.realT).toBeCloseTo(0.1, 12)
})
