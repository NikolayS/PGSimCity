import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import type { TraceRecord } from '../core/types'
import type { FlowsApi } from '../engine/flows'
import type { WalkController, WalkPose } from '../engine/walk'
import { createSim } from '../sim/model'
import { traceStopBit } from '../sim/model'
import { installTestDom } from '../../test/dom'
import { createControlCenter } from './control-center'
import {
  classifyModelStatement,
  traceStageState,
} from './control-center-model'
import type { UiContext } from './uikit'

const trace: TraceRecord = {
  slot: 2,
  query: 'select_idx',
  table: 0,
  sql: 'SELECT * FROM accounts WHERE id = 42',
  stop: 'fetch',
  stopT: 0.12,
  visited:
    traceStopBit('connect')
    | traceStopBit('parse_plan')
    | traceStopBit('fetch'),
  trips: 0,
  lastXid: 0,
  lastPlanLabel: 'Index Scan',
  lastPlanRows: 1,
  lastPlanCost: 4.2,
  rowsSent: 0,
  buffersHit: 3,
  buffersRead: 1,
  walBytes: 0,
  walFpiBytes: 0,
  deadMade: 0,
  lastTripSec: 0,
}

describe('control-center model prompt', () => {
  it.each([
    ['SELECT * FROM accounts WHERE id = 42', 'select_idx', 'accounts'],
    ['SELECT * FROM sessions WHERE updated_at > now() - interval \'1 hour\'', 'select_seq', 'sessions'],
    ['SELECT status, count(*) FROM orders GROUP BY status', 'aggregate', 'orders'],
    ['INSERT INTO events (kind) VALUES (\'login\')', 'insert', 'events'],
    ['UPDATE sessions SET updated_at = now() WHERE id = 7', 'update', 'sessions'],
    ['DELETE FROM sessions WHERE expires_at < now()', 'delete', 'sessions'],
  ] as const)('maps %s onto the existing %s trace', (sql, kind, table) => {
    expect(classifyModelStatement(sql)).toMatchObject({ kind, table })
  })

  it('rejects SQL outside the model grammar instead of implying PostgreSQL ran it', () => {
    expect(classifyModelStatement('CREATE INDEX ON accounts (id)')).toEqual({
      error: 'This model traces SELECT, INSERT, UPDATE, and DELETE statements against the five city tables.',
    })
  })
})

describe('control-center trace rail', () => {
  it('derives foreground state only from SimState.trace', () => {
    expect(traceStageState(trace, 'connect')).toBe('done')
    expect(traceStageState(trace, 'fetch')).toBe('now')
    expect(traceStageState(trace, 'work')).toBe('wait')
    expect(traceStageState(trace, 'wal')).toBe('skip')
    expect(traceStageState(trace, 'commit')).toBe('skip')
    expect(traceStageState({ ...trace, stop: 'blocked' }, 'work')).toBe('now')
  })
})

describe('control-center room hand-off', () => {
  it('opens fully before touch can enter, runs through SimApi, and restores the walker', () => {
    const dom = installTestDom()
    const bus = createBus()
    const sim = createSim(bus)
    const ctx: UiContext = {
      bus,
      sim,
      registry: { get: () => undefined } as unknown as UiContext['registry'],
      getFps: () => 60,
      getQuality: () => ({
        level: 'high',
        pixelRatio: 1,
        bloom: true,
        shadows: true,
        maxParticles: 100,
        maxLabels: 20,
        antialias: true,
      }),
      getFlowStats: () => ({ active: 0, dropped: 0 }),
    }
    const position = new THREE.Vector3(1.5, 0, -202)
    let yaw = 0.4
    let pitch = -0.1
    const walk = {
      enabled: true,
      position,
      capturePose(target: WalkPose): WalkPose {
        Object.assign(target, { x: position.x, y: position.y, z: position.z, yaw, pitch })
        return target
      },
      setPose(pose: Readonly<WalkPose>): void {
        position.set(pose.x, pose.y, pose.z)
        yaw = pose.yaw
        pitch = pose.pitch
      },
    } as unknown as WalkController
    const dimmed: boolean[] = []
    const flows = {
      setAmbientDimmed(value: boolean): void {
        dimmed.push(value)
      },
    } as unknown as FlowsApi
    const canvas = dom.document.createElement('canvas') as unknown as HTMLElement
    const door = {
      openness: 0,
      setOpenness(value: number): void {
        this.openness = value
      },
    }
    const control = createControlCenter({ ctx, walk, flows, canvas, door })
    const outside = position.clone()

    control.update(0)
    const enter = document.querySelector('.control-center-door-prompt button') as HTMLButtonElement
    expect(enter).not.toBeNull()
    expect(enter.textContent).toContain('OPEN')
    enter.click()
    expect(control.inside).toBe(false)
    expect(enter.disabled).toBe(true)
    expect(enter.textContent).toContain('OPENING')

    control.update(0.4)
    expect(control.inside).toBe(false)
    expect(door.openness).toBeGreaterThan(0)
    expect(door.openness).toBeLessThan(1)

    control.update(0.5)
    expect(enter.disabled).toBe(false)
    expect(enter.textContent).toContain('ENTER')
    expect(door.openness).toBe(1)

    enter.click()
    expect(control.inside).toBe(true)
    expect(dimmed).toEqual([true])
    control.update(0.9)
    expect(control.doorState).toBe('closed')
    expect(door.openness).toBe(0)

    const input = document.querySelector('.control-center__sql-input') as HTMLTextAreaElement
    input.value = 'UPDATE sessions SET updated_at = now() WHERE id = 7'
    const form = document.querySelector('.control-center__prompt') as HTMLFormElement
    expect(form.textContent).toContain('SQL-SHAPED ROUTE SELECTOR')
    expect(form.textContent).toContain('NOT PARSED OR NAME-RESOLVED')
    form.dispatchEvent(new Event('submit'))
    for (let tick = 0; tick < 900; tick++) {
      sim.update(1 / 30)
      control.update(0)
      if (sim.state.trace.stop === 'done') break
    }

    expect(sim.state.trace.sql).toBe(input.value)
    expect(document.querySelector('.control-center__receipt')?.textContent).toContain('M MODELLED')
    expect(document.querySelector('.control-center__receipt')?.textContent).toContain('PERSISTS')
    expect(sim.state.t).toBeGreaterThan(0)

    const leave = document.querySelector('.control-center__leave') as HTMLButtonElement
    leave.click()
    expect(control.inside).toBe(false)
    expect(position.toArray()).toEqual(outside.toArray())
    expect(dimmed).toEqual([true, false])
    control.dispose()
  })

  it('opens without animation under reduced motion but still waits for explicit entry', () => {
    const dom = installTestDom()
    const bus = createBus()
    const sim = createSim(bus)
    const ctx = {
      bus,
      sim,
      registry: { get: () => undefined },
      getFps: () => 60,
      getQuality: () => ({
        level: 'high',
        pixelRatio: 1,
        bloom: true,
        shadows: true,
        maxParticles: 100,
        maxLabels: 20,
        antialias: true,
      }),
      getFlowStats: () => ({ active: 0, dropped: 0 }),
    } as unknown as UiContext
    const position = new THREE.Vector3(0, 0, -206)
    const walk = {
      enabled: true,
      position,
      capturePose(target: WalkPose): WalkPose {
        Object.assign(target, { x: position.x, y: position.y, z: position.z, yaw: 0, pitch: 0 })
        return target
      },
      setPose(pose: Readonly<WalkPose>): void {
        position.set(pose.x, pose.y, pose.z)
      },
    } as unknown as WalkController
    const flows = { setAmbientDimmed: () => {} } as unknown as FlowsApi
    const door = { openness: 0, setOpenness(value: number): void { this.openness = value } }
    const control = createControlCenter({
      ctx,
      walk,
      flows,
      canvas: dom.document.createElement('canvas') as unknown as HTMLElement,
      door,
      reducedMotion: true,
    })

    control.update(0)
    const enter = document.querySelector('.control-center-door-prompt button') as HTMLButtonElement
    enter.click()
    expect(control.inside).toBe(false)
    expect(door.openness).toBe(1)
    expect(enter.textContent).toContain('ENTER')
    enter.click()
    expect(control.inside).toBe(true)

    control.dispose()
  })
})
