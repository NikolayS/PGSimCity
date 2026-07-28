import { describe, expect, it } from 'vitest'

import type { QueryKind, TraceRecord, TraceStop } from '../core/types'
import { traceStopBit } from '../sim/model'
import {
  FLOW_CHOICES,
  FLOW_PATH,
  FlowTiming,
  laneSettings,
  parseFlowQuery,
  segmentStatus,
  serializeFlowQuery,
} from './flow2d'

function record(query: QueryKind = 'update'): TraceRecord {
  return {
    slot: 2,
    query,
    table: 3,
    sql: 'UPDATE sessions SET updated_at = now() WHERE id = ANY ($1)',
    stop: 'connect',
    stopT: 0,
    visited: traceStopBit('connect'),
    trips: 0,
    lastXid: 0,
    lastPlanLabel: '',
    lastPlanRows: 0,
    lastPlanCost: 0,
    rowsSent: 0,
    buffersHit: 0,
    buffersRead: 0,
    walBytes: 0,
    walFpiBytes: 0,
    deadMade: 0,
    lastTripSec: 0,
  }
}

describe('2D query lifecycle state', () => {
  it('offers exactly the six statements implemented by the model', () => {
    expect(FLOW_CHOICES.map((choice) => choice.kind)).toEqual([
      'select_idx',
      'select_seq',
      'aggregate',
      'insert',
      'update',
      'delete',
    ])
    expect(new Set(FLOW_CHOICES.map((choice) => choice.tableId))).toEqual(
      new Set(['accounts', 'sessions', 'orders']),
    )
  })

  it('uses model trace bits for progress and strikes read-only write stops', () => {
    const trace = record('select_idx')
    trace.stop = 'work'
    trace.visited |=
      traceStopBit('parse_plan') |
      traceStopBit('fetch') |
      traceStopBit('work')

    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'fetch')!)).toBe('done')
    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'work')!)).toBe('current')
    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'wal')!)).toBe('skipped')
    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'commit')!)).toBe('skipped')
    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'send')!)).toBe('pending')
  })

  it('keeps commit applicable to a write even when synchronous_commit is off', () => {
    const trace = record('update')
    trace.stop = 'commit'
    trace.visited |=
      traceStopBit('parse_plan') |
      traceStopBit('fetch') |
      traceStopBit('work') |
      traceStopBit('wal') |
      traceStopBit('commit')

    expect(segmentStatus(trace, FLOW_PATH.find((segment) => segment.stop === 'commit')!)).toBe('current')
  })

  it('captures elapsed stop durations only from trace transition timestamps', () => {
    const trace = record()
    const timing = new FlowTiming()
    timing.observe(trace)

    const enter = (stop: TraceStop, at: number) => {
      trace.stop = stop
      trace.stopT = at
      trace.lastTripSec = at
      trace.visited |= traceStopBit(stop)
      timing.observe(trace)
    }

    enter('parse_plan', 0.04)
    enter('fetch', 0.12)
    enter('work', 0.42)
    enter('wal', 0.65)
    enter('commit', 0.71)
    enter('send', 1.31)
    enter('done', 1.39)

    expect(timing.duration('parse_plan', trace)).toBeCloseTo(0.08)
    expect(timing.duration('fetch', trace)).toBeCloseTo(0.3)
    expect(timing.duration('commit', trace)).toBeCloseTo(0.6)
    expect(timing.duration('send', trace)).toBeCloseTo(0.08)
    expect(timing.duration('done', trace)).toBe(0)
  })

  it('round-trips a linkable statement and one-setting comparison', () => {
    const parsed = parseFlowQuery(
      '?view=flow&statement=aggregate&setting=shared_buffers&a=2048&b=128',
    )
    expect(parsed).toEqual({
      statement: 'aggregate',
      setting: 'shared_buffers',
      a: 2048,
      b: 128,
    })
    expect(parseFlowQuery(serializeFlowQuery(parsed))).toEqual(parsed)
    expect(laneSettings(parsed)).toEqual([
      { synchronousCommit: 'on', sharedBuffers: 2048 },
      { synchronousCommit: 'on', sharedBuffers: 128 },
    ])
  })

  it('falls back to the useful write comparison for invalid URL state', () => {
    const parsed = parseFlowQuery('?view=flow&statement=vacuum&setting=nope&a=x&b=y')
    expect(parsed).toEqual({
      statement: 'update',
      setting: 'synchronous_commit',
      a: 'on',
      b: 'off',
    })
  })
})
