import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import { TABLES } from '../world/layout'
import { createSim, traceStopBit } from './model'
import {
  createRepresentativeRow,
  mvccVersionCollectable,
  recordRepresentativeUpdate,
  takeMvccSnapshot,
  visibleVersion,
} from './mvcc'

describe('representative MVCC row', () => {
  it('lets snapshots on opposite sides of an update see different row versions', () => {
    const row = createRepresentativeRow(100, 7)
    const beforeUpdate = takeMvccSnapshot(101, 0)

    recordRepresentativeUpdate(row, 101, 1, true)
    const afterCommit = takeMvccSnapshot(102, 2)

    expect(visibleVersion(row.versions, beforeUpdate)?.revision).toBe(1)
    expect(visibleVersion(row.versions, afterCommit)?.revision).toBe(2)
    expect(row.versions[0]).toMatchObject({
      xmin: 100,
      xmax: 101,
      ctidBlock: 7,
      ctidOffset: 2,
      nextRevision: 2,
      nextHot: true,
    })
    expect(row.versions[1]).toMatchObject({ xmin: 101, xmax: 0 })
  })

  it('makes the replaced version collectable only after the horizon passes its xmax', () => {
    const row = createRepresentativeRow(100, 7)

    recordRepresentativeUpdate(row, 101, 1, true)
    const replaced = row.versions[0]

    expect(mvccVersionCollectable(replaced, 100)).toBe(false)
    expect(mvccVersionCollectable(replaced, 101)).toBe(false)
    expect(mvccVersionCollectable(replaced, 102)).toBe(true)
  })

  it('is driven by committed UPDATE trips and the long-running transaction knob', () => {
    const sim = createSim(createBus())
    const tableIndex = TABLES.findIndex((table) => table.id === 'sessions')
    const row = sim.state.tables[tableIndex].mvcc
    const initialRevision = row.versions[row.versions.length - 1].revision

    sim.setKnob('longRunningXact', true)
    sim.request('update', tableIndex, { hot: false })
    for (let tick = 0; tick < 900; tick++) {
      sim.update(1 / 30)
      if (
        sim.state.trace.stop === 'done'
        && (sim.state.trace.visited & traceStopBit('done')) !== 0
      ) {
        break
      }
    }

    expect(row.earlierSnapshot.active).toBe(true)
    expect(row.versions[row.versions.length - 1].revision).toBeGreaterThan(
      initialRevision,
    )
    expect(row.earlierSnapshot.visibleRevision).not.toBe(
      row.laterSnapshot.visibleRevision,
    )
    expect(row.versions.some((version) => version.xmax > 0 && !version.collectable))
      .toBe(true)
  })

  it('lets vacuum collect the sampled dead version after the pin is released', () => {
    const sim = createSim(createBus())
    const tableIndex = TABLES.findIndex((table) => table.id === 'sessions')
    const row = sim.state.tables[tableIndex].mvcc
    const collectedBefore = row.collectedVersions

    sim.setKnob('tps', 18)
    sim.setKnob('longRunningXact', true)
    sim.request('update', tableIndex, { hot: false })
    for (let tick = 0; tick < 900; tick++) {
      sim.update(1 / 30)
      if (
        sim.state.trace.stop === 'done'
        && (sim.state.trace.visited & traceStopBit('done')) !== 0
      ) {
        break
      }
    }
    expect(row.versions.some((version) => version.xmax > 0 && !version.collectable))
      .toBe(true)

    sim.setKnob('longRunningXact', false)
    sim.setKnob('autovacuumScaleFactor', 0)
    sim.setKnob('tps', 0)
    // Keep this focused on MVCC eligibility rather than vacuum's FPI backlog.
    sim.setKnob('fullPageWrites', false)
    const deadline = sim.state.t + 90
    while (sim.state.t < deadline) sim.update(1 / 30)

    expect(row.collectedVersions).toBeGreaterThan(collectedBefore)
  })
})
