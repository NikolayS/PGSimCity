import { describe, expect, it } from 'vitest'

import { CLAIM_VALUES } from '../core/claims'
import type { BackendSim } from '../core/types'
import { AGGREGATE_TEST_STEP, createAggregateSim } from './test-support'

interface Reading {
  planLabels: string[]
  planDetails: string[]
  totalMs: number
  tempFileMs: number
  tempFiles: number
  tempBytes: number
  workMemNodes: number
  hashNodes: number
  allowanceBytes: number
  spillNodes: number
}

function flattenLabels(node: BackendSim['plan'], out: string[]): void {
  if (!node) return
  for (const child of node.children) flattenLabels(child, out)
  out.push(node.label)
}

function flattenDetails(node: BackendSim['plan'], out: string[]): void {
  if (!node) return
  for (const child of node.children) flattenDetails(child, out)
  out.push(node.detail)
}

function aggregateReading(workMemMiB: number): Reading {
  let collecting = false
  let completed: { totalMs: number; tempFileMs: number } | undefined
  const sim = createAggregateSim(AGGREGATE_TEST_STEP, (observation) => {
    if (!collecting) return
    completed = {
      totalMs: observation.totalMs,
      tempFileMs: observation.waits.tempFileMs,
    }
  })
  const table = sim.state.tables.findIndex((candidate) => candidate.def.id === 'sessions')
  sim.setKnob('tps', 0)
  sim.setKnob('workMem', workMemMiB)
  sim.setKnob('autovacuum', false)
  collecting = true
  sim.request('aggregate', table)

  const planLabels: string[] = []
  const planDetails: string[] = []
  let workMemNodes = 0
  let hashNodes = 0
  let allowanceBytes = 0
  let spillNodes = 0
  const deadline = sim.state.t + 180
  while (sim.state.trace.trips === 0 && sim.state.t < deadline) {
    sim.update(AGGREGATE_TEST_STEP)
    const backend = sim.state.backends.find((candidate) => candidate.slot === sim.state.trace.slot)
    if (!backend?.plan) continue
    if (planLabels.length === 0) flattenLabels(backend.plan, planLabels)
    if (backend.state === 'sort') {
      planDetails.length = 0
      flattenDetails(backend.plan, planDetails)
    }
    workMemNodes = Math.max(workMemNodes, backend.workMemNodes)
    hashNodes = Math.max(hashNodes, backend.workMemHashNodes)
    allowanceBytes = Math.max(allowanceBytes, backend.workMemAllowanceBytes)
    spillNodes = Math.max(spillNodes, backend.workMemSpillNodes)
  }

  if (!completed || sim.state.trace.trips === 0) {
    throw new Error(`aggregate did not complete at work_mem=${workMemMiB} MiB`)
  }
  return {
    planLabels,
    planDetails,
    totalMs: completed.totalMs,
    tempFileMs: completed.tempFileMs,
    tempFiles: sim.state.workMem.tempFiles,
    tempBytes: sim.state.workMem.tempBytes,
    workMemNodes,
    hashNodes,
    allowanceBytes,
    spillNodes,
  }
}

describe('work_mem spill model', () => {
  it('turns the same fixed operation into temp-file I/O below its per-node allowance', () => {
    const spilled = aggregateReading(CLAIM_VALUES.workMem.spillExample.lowMiB)
    const fitted = aggregateReading(CLAIM_VALUES.workMem.spillExample.highMiB)

    console.info('work_mem spill measurement', { spilled, fitted })

    expect(spilled.planLabels).toEqual(fitted.planLabels)
    expect(spilled.planDetails.join(' ')).toContain('Disk:')
    expect(spilled.planDetails.join(' ')).toContain('Batches: 2')
    expect(fitted.planDetails.join(' ')).not.toContain('Disk:')
    expect(fitted.planDetails.join(' ')).toContain('Batches: 1')
    expect(spilled.workMemNodes).toBeGreaterThan(1)
    expect(spilled.hashNodes).toBeGreaterThan(0)
    expect(spilled.allowanceBytes).toBeGreaterThan(
      CLAIM_VALUES.workMem.spillExample.lowMiB * 1024 * 1024,
    )
    expect(spilled.spillNodes).toBeGreaterThan(0)
    expect(fitted.spillNodes).toBe(0)
    expect(spilled.tempFiles).toBeGreaterThan(fitted.tempFiles)
    expect(spilled.tempBytes).toBeGreaterThan(fitted.tempBytes)
    expect(spilled.tempFileMs).toBeGreaterThan(0)
    expect(fitted.tempFileMs).toBe(0)
    const slowdown = spilled.totalMs / fitted.totalMs
    expect(slowdown).toBeGreaterThan(CLAIM_VALUES.workMem.spillSlowdown - 2)
    expect(slowdown).toBeLessThan(CLAIM_VALUES.workMem.spillSlowdown + 2)
  })
})
