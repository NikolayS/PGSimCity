import type { Knobs, TraceStop } from './types'

export function traceStopBit(stop: TraceStop): number {
  switch (stop) {
    case 'connect': return 1 << 0
    case 'parse_plan': return 1 << 1
    case 'fetch': return 1 << 2
    case 'work': return 1 << 3
    case 'wal': return 1 << 4
    case 'commit': return 1 << 5
    case 'send': return 1 << 6
    case 'done': return 1 << 7
    case 'blocked': return 1 << 8
  }
}

/** Scaled WAL threshold at which the model requests a checkpoint. */
export const walTriggerBytes = (knobs: Knobs): number =>
  (knobs.maxWalSize * 1024 * 1024) / (1 + knobs.checkpointCompletionTarget)
