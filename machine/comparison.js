import { MACHINE_SYNCHRONOUS_COMMIT_COMPARISON as claim } from '../src/spine/machine-comparison.ts'
import { activeStatementStageIndex, createStatementReplay } from './architecture.js'

export const COMPARISON_SQL =
  'UPDATE accounts SET updated_at = updated_at WHERE id = 42;'
export const SYNCHRONOUS_COMMIT_COMPARISON_CLAIM = claim

const OFF_ACK_VIEW_MS = 160
const OBSERVATION_AFTER_ACK_MS = 180
const FLUSH_COMPLETE_HOLD_MS = 900

function replaceCommit(replay, setting) {
  const controlCommit = replay.stages.find((stage) => stage.id === 'commit')
  const backgroundFlushDurationMs = controlCommit?.durationMs ?? 0
  const stages = replay.stages.map((stage) => {
    if (stage.id === 'commit' && setting === 'on') {
      return Object.freeze({
        ...stage,
        measurement: 'M · ACK after local WAL flush',
        flushContinuesAfterAck: false,
      })
    }
    if (stage.id === 'commit') {
      return Object.freeze({
        ...stage,
        detail: 'acknowledge before flush; recent acknowledgements at risk until flush',
        durationMs: OFF_ACK_VIEW_MS,
        measurement: 'M · ACK early; recent ACKs at risk until flush',
        flushContinuesAfterAck: true,
        backgroundFlushDurationMs,
      })
    }
    if (stage.id === 'return' && setting === 'off') {
      return Object.freeze({
        ...stage,
        clientReturnDurationMs: stage.durationMs,
        durationMs:
          Math.max(stage.durationMs, backgroundFlushDurationMs)
          + FLUSH_COMPLETE_HOLD_MS,
      })
    }
    return stage
  })
  return Object.freeze({
    ...replay,
    synchronousCommit: setting,
    acknowledgementOrigin: setting === 'off' ? 'wal_buffers' : 'durable_storage',
    backgroundFlushDurationMs:
      setting === 'off' ? backgroundFlushDurationMs : 0,
    stages: Object.freeze(stages),
    durationMs: stages.reduce(
      (total, stage) => total + (stage.skipped ? 0 : stage.durationMs),
      0,
    ),
  })
}

function elapsedBefore(replay, stageId) {
  let elapsedMs = 0
  for (const stage of replay.stages) {
    if (stage.id === stageId) return elapsedMs
    if (!stage.skipped) elapsedMs += stage.durationMs
  }
  return elapsedMs
}

export function createSynchronousCommitComparison(report) {
  const measuredReplay = createStatementReplay(report)
  if (!measuredReplay.writes) {
    throw new Error('synchronous_commit comparison requires a write statement')
  }

  const controlReplay = replaceCommit(measuredReplay, 'on')
  const treatmentReplay = replaceCommit(measuredReplay, 'off')
  const commitStartMs = elapsedBefore(controlReplay, 'commit')

  return Object.freeze({
    claimId: 'machineSynchronousCommitComparison',
    sql: measuredReplay.sql,
    modelledSetting: claim.setting,
    held: claim.held,
    evidenceSource: claim.evidenceSource,
    finding: claim.finding,
    pgliteDisclosure: claim.pgliteDisclosure,
    replayDisclosure: claim.replayDisclosure,
    commitStartMs,
    observationAtMs:
      commitStartMs + OFF_ACK_VIEW_MS + OBSERVATION_AFTER_ACK_MS,
    lanes: Object.freeze([
      Object.freeze({
        id: 'A',
        role: 'CONTROL',
        setting: Object.freeze({ synchronous_commit: claim.control }),
        replay: controlReplay,
      }),
      Object.freeze({
        id: 'B',
        role: 'MODELLED OFF POLICY',
        setting: Object.freeze({ synchronous_commit: claim.treatment }),
        replay: treatmentReplay,
      }),
    ]),
  })
}

function laneSnapshot(lane, elapsedMs) {
  const boundedElapsedMs = Math.min(Math.max(0, elapsedMs), lane.replay.durationMs)
  const stageIndex = activeStatementStageIndex(lane.replay, boundedElapsedMs)
  const stage = lane.replay.stages[stageIndex]
  let stageStartMs = 0
  for (let index = 0; index < stageIndex; index += 1) {
    if (!lane.replay.stages[index].skipped) {
      stageStartMs += lane.replay.stages[index].durationMs
    }
  }
  return Object.freeze({
    stage,
    stageIndex,
    stageElapsedMs: Math.max(0, boundedElapsedMs - stageStartMs),
    complete: elapsedMs >= lane.replay.durationMs,
  })
}

export function comparisonSnapshot(comparison, elapsedMs) {
  const lanes = comparison.lanes.map((lane) => laneSnapshot(lane, elapsedMs))
  return Object.freeze({
    elapsedMs,
    lanes: Object.freeze(lanes),
    findingVisible:
      lanes[0].stage.id === 'commit'
      && lanes[1].stage.id !== 'commit',
    complete: lanes.every((lane) => lane.complete),
  })
}
