import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import type { QueryKind, TraceStop } from '../core/types'
import { TABLES } from '../core/catalog'
import { traceStopBit } from '../core/model-helpers'
import { createSim } from './model'

interface TraceCase {
  kind: QueryKind
  table: string
  expected: TraceStop[]
  hot?: boolean
}

const READ_SEQUENCE: TraceStop[] = [
  'connect',
  'parse_plan',
  'fetch',
  'work',
  'send',
  'done',
]

const WRITE_SEQUENCE: TraceStop[] = [
  'connect',
  'parse_plan',
  'fetch',
  'work',
  'wal',
  'commit',
  'send',
  'done',
]

const CASES: TraceCase[] = [
  { kind: 'select_idx', table: 'accounts', expected: READ_SEQUENCE },
  { kind: 'select_seq', table: 'sessions', expected: READ_SEQUENCE },
  { kind: 'aggregate', table: 'orders', expected: READ_SEQUENCE },
  { kind: 'insert', table: 'orders', expected: WRITE_SEQUENCE },
  { kind: 'update', table: 'sessions', expected: WRITE_SEQUENCE, hot: false },
  { kind: 'delete', table: 'sessions', expected: WRITE_SEQUENCE },
]

function runTrace(testCase: TraceCase): {
  sequence: TraceStop[]
  sim: ReturnType<typeof createSim>
} {
  const sim = createSim(createBus())
  const table = TABLES.findIndex((candidate) => candidate.id === testCase.table)
  expect(table).toBeGreaterThanOrEqual(0)

  sim.setKnob('tps', 18)
  sim.request(testCase.kind, table, { hot: testCase.hot })

  const sequence: TraceStop[] = []
  let last: TraceStop | null = null
  for (let tick = 0; tick < 900; tick++) {
    sim.update(1 / 30)
    const current = sim.state.trace.stop
    if (current !== last) {
      sequence.push(current)
      last = current
    }
    expect(sim.state.trace.visited & traceStopBit(current)).not.toBe(0)
    if (current === 'done') break
  }

  const current = sim.state.trace.stop
  if (current !== last) sequence.push(current)
  expect(sim.state.trace.visited & traceStopBit(current)).not.toBe(0)
  return { sequence, sim }
}

describe('query trace model', () => {
  it('keeps the reader statement in the model-owned trace record', () => {
    const sim = createSim(createBus())
    const sql = 'SELECT * FROM accounts WHERE id = 42'

    sim.request('select_idx', 0, { sql })
    sim.update(1 / 30)

    expect(sim.state.trace.sql).toBe(sql)
  })

  for (const testCase of CASES) {
    it(`records the complete ${testCase.kind} stop sequence at 30 Hz`, () => {
      const { sequence } = runTrace(testCase)
      expect(sequence).toEqual(testCase.expected)
    })
  }

  it('forces each requested trace trip to represent one transaction', () => {
    const { sim } = runTrace(CASES[4])

    expect(sim.state.knobs.tps).toBe(18)
    expect(sim.state.trace.trips).toBe(1)
  })

  it('keeps terminal write evidence after the backend returns to idle', () => {
    const { sim } = runTrace(CASES[4])
    const trace = sim.state.trace

    expect(trace.lastXid).toBeGreaterThan(0)
    expect(trace.lastPlanLabel).toBe('Update')
    expect(trace.lastPlanRows).toBeGreaterThan(0)
    expect(trace.lastPlanCost).toBeGreaterThan(0)
    expect(trace.walBytes).toBeGreaterThan(0)
    expect(trace.deadMade).toBeGreaterThan(0)
  })

  it('pauses inside the model when Step reaches the next stop', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 18)
    sim.request('update', TABLES.findIndex((table) => table.id === 'sessions'), { hot: false })
    while (sim.state.trace.stop !== 'parse_plan') sim.update(1 / 30)

    sim.setTraceMode('step')
    expect(sim.state.knobs.paused).toBe(true)
    sim.setTraceMode('step')
    for (let call = 0; call < 30; call++) sim.update(1 / 30)

    expect(sim.state.trace.stop).toBe('fetch')
    expect(sim.state.knobs.paused).toBe(true)
    expect(sim.state.trace.visited & traceStopBit('work')).toBe(0)
  })
})
