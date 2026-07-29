import type { TraceRecord, TraceStop } from '../core/types'
import { traceStopBit } from './model'

export type TraceStageState = 'wait' | 'now' | 'done' | 'skip'

export interface PresentedTraceStage {
  stop: Exclude<TraceStop, 'blocked'>
  label: string
}

export const PRESENTED_TRACE_STAGES: readonly PresentedTraceStage[] = [
  { stop: 'connect', label: 'BACKEND' },
  { stop: 'parse_plan', label: 'PLAN' },
  { stop: 'fetch', label: 'FETCH' },
  { stop: 'work', label: 'EXECUTE' },
  { stop: 'wal', label: 'WAL' },
  { stop: 'commit', label: 'COMMIT' },
  { stop: 'send', label: 'RETURN' },
  { stop: 'done', label: 'RECEIPT' },
]

export function traceStageState(trace: TraceRecord, stop: TraceStop): TraceStageState {
  const write =
    trace.query === 'insert'
    || trace.query === 'update'
    || trace.query === 'delete'
  if (!write && (stop === 'wal' || stop === 'commit')) return 'skip'
  if (trace.stop === 'blocked' && stop === 'work') return 'now'
  if (trace.stop === stop) return 'now'
  return (trace.visited & traceStopBit(stop)) !== 0 ? 'done' : 'wait'
}
