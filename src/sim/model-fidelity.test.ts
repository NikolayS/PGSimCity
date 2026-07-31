import { describe, expect, it } from 'vitest'

import { createBus } from '../core/bus'
import type { PlanNode, QueryKind } from '../core/types'
import { TABLES } from '../core/catalog'
import { createSim } from './model'
import { AGGREGATE_TEST_STEP, createAggregateSim } from './test-support'

type Sim = ReturnType<typeof createSim>

function tableIndex(id: string): number {
  const index = TABLES.findIndex((table) => table.id === id)
  expect(index).toBeGreaterThanOrEqual(0)
  return index
}

function advanceBy(sim: Sim, seconds: number): void {
  const until = sim.state.t + seconds
  while (sim.state.t < until) {
    sim.update(Math.min(AGGREGATE_TEST_STEP, until - sim.state.t))
  }
}

function capturePlan(kind: QueryKind, table: number): {
  plan: PlanNode
  sim: Sim
} {
  const sim = createSim(createBus())
  sim.setKnob('tps', 0)
  sim.setKnob('autovacuum', false)
  sim.request(kind, table)

  for (let tick = 0; tick < 120; tick++) {
    sim.update(1 / 30)
    const slot = sim.state.trace.slot
    const plan = slot >= 0 ? sim.state.backends[slot].plan : null
    if (plan) return { plan, sim }
  }
  throw new Error(`trace did not produce a ${kind} plan`)
}

function capturePlanSequence(kind: QueryKind, table: number, count: number): PlanNode[] {
  const sim = createSim(createBus())
  sim.setKnob('tps', 0)
  sim.setKnob('autovacuum', false)
  const plans: PlanNode[] = []

  for (let sample = 0; sample < count; sample++) {
    sim.request(kind, table)
    let started = false
    let captured: PlanNode | null = null
    for (let tick = 0; tick < 1800; tick++) {
      sim.update(1 / 30)
      if (sim.state.trace.stop !== 'done') started = true
      const slot = sim.state.trace.slot
      if (slot >= 0 && sim.state.backends[slot].plan) {
        captured = sim.state.backends[slot].plan
      }
      if (started && sim.state.trace.stop === 'done') break
    }
    if (!captured) throw new Error(`trace did not complete a ${kind} plan`)
    plans.push(captured)
  }
  return plans
}

function flattenPlan(root: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = []
  const visit = (node: PlanNode): void => {
    nodes.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return nodes
}

describe('model fidelity regressions', () => {
  it('scores a BAS_BULKREAD scan as a cold stream even when the pool exceeds the table', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    sim.request('select_seq', tableIndex('accounts'))

    let started = false
    for (let tick = 0; tick < 1800; tick++) {
      sim.update(1 / 30)
      if (sim.state.trace.stop !== 'done') started = true
      else if (started) break
    }

    const touched = sim.state.trace.buffersHit + sim.state.trace.buffersRead
    expect(touched).toBeGreaterThan(1000)
    expect(
      sim.state.trace.buffersRead / touched,
      `${sim.state.trace.buffersHit} hits / ${sim.state.trace.buffersRead} reads`,
    ).toBeGreaterThan(0.95)
  })

  it('keeps enough idle bgwriter scan progress to lap the pool in two minutes', () => {
    const sim = createAggregateSim()
    sim.setKnob('tps', 0)
    sim.setKnob('autovacuum', false)
    sim.setKnob('sharedBuffers', 8192)
    sim.setKnob('checkpointTimeout', 1800)
    sim.setKnob('maxWalSize', 4096)
    advanceBy(sim, 30)
    sim.setKnob('bgwriterEnabled', false)
    advanceBy(sim, 1)
    sim.setKnob('bgwriterEnabled', true)

    sim.state.buffers.dirty.fill(0)
    sim.state.buffers.usage.fill(0)
    sim.state.buffers.pinned.fill(0)
    const cleanedBefore = sim.state.bgwriter.cleanedTotal
    sim.state.bgwriter.scanPos = sim.state.buffers.clockHand
    const frame =
      (sim.state.buffers.clockHand + sim.state.buffers.sampleFrames - 1)
      % sim.state.buffers.sampleFrames
    sim.state.buffers.valid[frame] = 1
    sim.state.buffers.dirty[frame] = 1
    sim.state.buffers.usage[frame] = 0
    sim.state.buffers.pinned[frame] = 0
    advanceBy(sim, 121)

    expect(sim.state.buffers.dirty[frame]).toBe(0)
    expect(sim.state.bgwriter.cleanedTotal - cleanedBefore).toBe(1)
  })

  it('keeps an aggregate plan on the table named by its SQL', () => {
    const { plan } = capturePlan('aggregate', tableIndex('orders'))
    const nodes = flattenPlan(plan)

    expect(nodes.some((node) => node.label.endsWith('Join'))).toBe(false)
  })

  it('never feeds Gather Merge unordered partial-hash output', () => {
    const gatherMerges = capturePlanSequence('aggregate', tableIndex('orders'), 6)
      .flatMap((plan) => flattenPlan(plan))
      .filter((node) => node.label === 'Gather Merge')

    expect(gatherMerges.length).toBeGreaterThan(0)
    for (const gatherMerge of gatherMerges) {
      expect(gatherMerge.children[0]?.label).toBe('Sort')
    }
  })

  it('uses the primary-key Index Scan promised by select_idx SQL', () => {
    const { plan } = capturePlan('select_idx', tableIndex('accounts'))

    expect(plan.label).toBe('Index Scan')
    expect(plan.detail).toContain('using accounts_pkey on accounts')
    expect(plan.detail).toContain('Index Cond: id = $1')
    expect(plan.rows).toBe(1)
  })

  it('renders each select_seq predicate and ordering from the displayed SQL', () => {
    const accounts = capturePlan('select_seq', tableIndex('accounts')).plan
    const accountNodes = flattenPlan(accounts)
    const accountScan = accountNodes.find((node) => node.label === 'Seq Scan')
    expect(accountScan?.detail).toContain('Filter: updated_at > $1')
    expect(accountNodes.some((node) => node.label === 'Sort' || node.label === 'Limit')).toBe(false)

    const events = capturePlan('select_seq', tableIndex('events')).plan
    const eventNodes = flattenPlan(events)
    const eventScan = eventNodes.find((node) => node.label === 'Seq Scan')
    expect(eventScan?.detail).toContain('Filter: payload @> $1')
    expect(events.label).toBe('Limit')
    expect(events.children[0]?.label).toBe('Sort')
  })

  it('does not amortize Parallel Seq Scan disk cost across workers', () => {
    const table = tableIndex('orders')
    const { plan, sim } = capturePlan('aggregate', table)
    const parallelScan = flattenPlan(plan).find((node) => node.label === 'Parallel Seq Scan')

    expect(parallelScan, 'aggregate plan must use its parallel base-table scan').toBeDefined()
    expect(parallelScan!.cost).toBeGreaterThanOrEqual(sim.state.tables[table].pages)
  })
})
