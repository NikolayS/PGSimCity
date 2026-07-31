import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import type { QueryKind, TraceRecord, TraceStop } from '../core/types'
import { traceStopBit } from '../core/model-helpers'
import { createSim, sqlFor } from '../sim/model'
import { TABLES } from '../world/layout'
import { installTestDom } from '../../test/dom'
import {
  FLOW_CHOICES,
  FLOW_PATH,
  FlowTiming,
  createFlow2dView,
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

  it('uses model SQL that resolves against the adjacent seeded schema', () => {
    const statements = FLOW_CHOICES.map((choice) => {
      const table = TABLES.findIndex((candidate) => candidate.id === choice.tableId)
      return sqlFor(choice.kind, table)
    })

    expect(statements).toEqual([
      'SELECT * FROM accounts WHERE id = $1',
      'SELECT * FROM sessions WHERE expires_at > $1',
      'SELECT status, count(*), sum(total) FROM orders GROUP BY 1',
      'INSERT INTO orders (id, account_id, status, total, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      'UPDATE sessions SET last_seen_at = now(), expires_at = $1 WHERE id = ANY ($2)',
      'DELETE FROM sessions WHERE expires_at < now()',
    ])
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

  it('round-trips PostgreSQL remote_write durability comparisons', () => {
    const parsed = parseFlowQuery(
      '?view=flow&statement=update&setting=synchronous_commit&a=remote_write&b=on',
    )

    expect(parsed).toEqual({
      statement: 'update',
      setting: 'synchronous_commit',
      a: 'remote_write',
      b: 'on',
    })
    expect(parseFlowQuery(serializeFlowQuery(parsed))).toEqual(parsed)
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

  it('draws containment and layers as accessible SVG architecture', () => {
    installTestDom()
    const view = createFlow2dView(
      createSim(createBus()),
      {
        statement: 'select_idx',
        setting: 'synchronous_commit',
        a: 'on',
        b: 'off',
      },
      () => {},
    )

    const maps = view.root.querySelectorAll<SVGSVGElement>('svg.flow-architecture')
    expect(maps).toHaveLength(2)

    for (const map of maps) {
      expect(map.getAttribute('role')).toBe('group')
      expect(
        Array.from(
          map.querySelectorAll<SVGGElement>('[data-layer]'),
          (layer) => layer.dataset.layer,
        ),
      ).toEqual(['client', 'processes', 'shared-memory', 'kernel', 'disk'])

      const shared = map.querySelector<SVGGElement>('[data-component="shared-memory"]')!
      expect(shared).not.toBeNull()
      expect(
        Array.from(
          shared.querySelectorAll<SVGGElement>('[data-component]'),
          (component) => component.dataset.component,
        ),
      ).toEqual([
        'buffer-pool',
        'wal-buffers',
        'proc-array',
        'lock-table',
        'pg-xact-cache',
      ])

      const privateMemory = map.querySelector<SVGGElement>('[data-component="private-memory"]')!
      expect(privateMemory).not.toBeNull()
      expect(shared.contains(privateMemory)).toBe(false)

      expect(
        new Set(
          Array.from(
            map.querySelectorAll<SVGPathElement>('[data-relation]'),
            (connection) => connection.dataset.relation,
          ),
        ),
      ).toEqual(
        new Set([
          'connection',
          'fork',
          'read',
          'wal-write',
          'flush',
          'background',
          'return',
        ]),
      )
      expect(map.querySelectorAll<SVGGElement>('[data-component][tabindex="0"]').length)
        .toBeGreaterThanOrEqual(16)
      expect(map.querySelector('[data-component="kernel-page-cache"]')).not.toBeNull()
      expect(map.querySelector('[data-component="base-store"]')).not.toBeNull()
      expect(map.querySelector('[data-component="pg-wal-store"]')).not.toBeNull()
    }

    expect(view.root.querySelector('.flow-path')).toBeNull()
    expect(
      view.root.querySelectorAll('[data-stop="wal"].is-skipped'),
    ).toHaveLength(2)
    expect(
      view.root.querySelectorAll('[data-stop="commit"].is-skipped'),
    ).toHaveLength(2)
    view.dispose()
  })
})
