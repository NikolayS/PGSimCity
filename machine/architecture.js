export const ARCHITECTURE_LAYOUT = Object.freeze({
  client: Object.freeze({ x: 48, y: 92, width: 152, height: 72 }),
  postmaster: Object.freeze({ x: 230, y: 92, width: 152, height: 72 }),
  privateMemory: Object.freeze({ x: 408, y: 170, width: 250, height: 96 }),
  sharedMemory: Object.freeze({ x: 48, y: 296, width: 624, height: 276 }),
  bufferPool: Object.freeze({ x: 72, y: 338, width: 330, height: 198 }),
  walBuffers: Object.freeze({ x: 424, y: 334, width: 224, height: 72 }),
  procArray: Object.freeze({ x: 424, y: 418, width: 106, height: 50 }),
  lockTable: Object.freeze({ x: 542, y: 418, width: 106, height: 50 }),
  pgXact: Object.freeze({ x: 424, y: 480, width: 224, height: 62 }),
  kernelCache: Object.freeze({ x: 48, y: 596, width: 624, height: 58 }),
  disk: Object.freeze({ x: 48, y: 674, width: 624, height: 62 }),
  rhythm: Object.freeze({ x: 24, y: 760, width: 672, height: 126 }),
})

export function contains(container, child) {
  return (
    child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height
  )
}

const STATEMENT_STAGE_SPECS = Object.freeze([
  Object.freeze({
    id: 'client',
    label: 'Client',
    detail: 'submitted SQL',
    durationMs: 650,
    source: 'model',
  }),
  Object.freeze({
    id: 'backend',
    label: 'Backend B2',
    detail: 'single connection',
    durationMs: 700,
    source: 'model',
  }),
  Object.freeze({
    id: 'parse',
    label: 'Parse',
    detail: 'check syntax',
    durationMs: 650,
    source: 'model',
  }),
  Object.freeze({
    id: 'rewrite',
    label: 'Rewrite',
    detail: 'apply query rules',
    durationMs: 650,
    source: 'model',
  }),
  Object.freeze({
    id: 'plan',
    label: 'Plan',
    detail: 'choose operations',
    durationMs: 0,
    source: 'postgres',
  }),
  Object.freeze({
    id: 'execute',
    label: 'Execute',
    detail: 'run the plan',
    durationMs: 0,
    source: 'postgres',
  }),
  Object.freeze({
    id: 'buffer',
    label: 'Buffer pool',
    detail: 'shared_buffers lookup',
    durationMs: 1350,
    source: 'postgres',
  }),
  Object.freeze({
    id: 'kernel',
    label: 'Kernel',
    detail: 'read below shared_buffers',
    durationMs: 800,
    source: 'model',
  }),
  Object.freeze({
    id: 'disk',
    label: 'Storage',
    detail: 'possible physical I/O',
    durationMs: 850,
    source: 'model',
  }),
  Object.freeze({
    id: 'return',
    label: 'Rows → client',
    detail: 'send the result',
    durationMs: 900,
    source: 'postgres',
  }),
])

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function modifiesRows(plan) {
  if (!plan?.root) return false
  const pending = [plan.root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (['insert', 'update', 'delete', 'merge'].includes(node?.operation?.toLowerCase())) {
      return true
    }
    pending.push(...(node?.children ?? []))
  }
  return false
}

function resultMeasurement(report) {
  const result = report.results?.at(-1)
  if (modifiesRows(report.plan)) {
    return {
      count: finiteNumber(result?.affectedRows),
      stageLabel: 'row affected',
      receiptLabel: 'ROWS AFFECTED',
    }
  }
  if ((result?.fields?.length ?? 0) > 0) {
    return {
      count: result.rows?.length ?? 0,
      stageLabel: 'result row',
      receiptLabel: 'RESULT ROWS',
    }
  }
  const actualRows = finiteNumber(report.plan?.root?.actualRows)
  const actualLoops = Math.max(1, finiteNumber(report.plan?.root?.actualLoops))
  return {
    count: actualRows * actualLoops,
    stageLabel: 'plan-root tuple',
    receiptLabel: 'PLAN-ROOT TUPLES',
  }
}

function measuredPacing(plan) {
  const planning = Math.max(0, finiteNumber(plan?.planningTimeMs))
  const execution = Math.max(0, finiteNumber(plan?.executionTimeMs))
  const total = planning + execution
  const planningShare = total > 0 ? planning / total : 0.5
  return {
    plan: 700 + planningShare * 1400,
    execute: 700 + (1 - planningShare) * 1400,
  }
}

/**
 * Build the human-paced route from one authoritative PostgreSQL report.
 * Durations scale the presentation only; the receipt preserves measured data.
 */
export function createStatementReplay(report) {
  const plan = report.plan
  const sharedHits = finiteNumber(plan?.buffers?.sharedHits)
  const sharedReads = finiteNumber(plan?.buffers?.sharedReads)
  const pacing = measuredPacing(plan)
  const rowMeasurement = resultMeasurement(report)
  const rows = rowMeasurement.count
  const stages = STATEMENT_STAGE_SPECS.map((spec) => {
    const skipped = (spec.id === 'kernel' || spec.id === 'disk') && sharedReads === 0
    let durationMs = spec.durationMs
    let measurement = null
    if (spec.id === 'plan') {
      durationMs = pacing.plan
      measurement = plan
        ? `${finiteNumber(plan.planningTimeMs)} ms planning`
        : 'no measured plan'
    } else if (spec.id === 'execute') {
      durationMs = pacing.execute
      measurement = plan
        ? `${finiteNumber(plan.executionTimeMs)} ms execution`
        : 'timing unavailable'
    } else if (spec.id === 'buffer') {
      measurement = plan
        ? `${sharedHits} hits · ${sharedReads} reads`
        : 'buffer counts unavailable'
    } else if (spec.id === 'kernel' || spec.id === 'disk') {
      measurement = skipped
        ? 'skipped · 0 shared reads'
        : `${sharedReads} shared reads · route modelled`
    } else if (spec.id === 'return') {
      measurement = `${rows} ${rowMeasurement.stageLabel}${rows === 1 ? '' : 's'}`
    }
    return Object.freeze({
      ...spec,
      durationMs,
      measurement,
      skipped,
    })
  })
  const durationMs = stages.reduce(
    (total, stage) => total + (stage.skipped ? 0 : stage.durationMs),
    0,
  )
  return Object.freeze({
    sql: String(report.sql ?? ''),
    stages: Object.freeze(stages),
    durationMs,
    receipt: plan
      ? Object.freeze({
          source: 'postgres',
          sharedHits,
          sharedReads,
          planningTimeMs: finiteNumber(plan.planningTimeMs),
          executionTimeMs: finiteNumber(plan.executionTimeMs),
          rows,
          rowLabel: rowMeasurement.receiptLabel,
          planNode: String(plan.root?.nodeType ?? 'Plan'),
        })
      : null,
  })
}

export function nextStatementStageIndex(replay, currentIndex) {
  for (let index = currentIndex + 1; index < replay.stages.length; index += 1) {
    if (!replay.stages[index].skipped) return index
  }
  return replay.stages.length - 1
}

export function activeStatementStageIndex(replay, elapsedMs) {
  let remaining = Math.max(0, finiteNumber(elapsedMs))
  let last = 0
  for (let index = 0; index < replay.stages.length; index += 1) {
    const stage = replay.stages[index]
    if (stage.skipped) continue
    last = index
    if (remaining < stage.durationMs) return index
    remaining -= stage.durationMs
  }
  return last
}
