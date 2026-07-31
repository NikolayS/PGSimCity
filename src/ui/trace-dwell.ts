import type { TraceRecord, TraceStop } from '../core/types'
import { traceStopBit } from '../core/model-helpers'

export const MIN_DWELL_S = 2.4

export interface TraceDwell {
  readonly stop: TraceStop
  readonly wallSinceChange: number
  update(trace: TraceRecord, dt: number, wallDt: number): void
  reset(trace: TraceRecord): void
}

export function createTraceDwell(initial: TraceRecord): TraceDwell {
  let stop = initial.stop
  let wallSinceChange = 0

  return {
    get stop() {
      return stop
    },
    get wallSinceChange() {
      return wallSinceChange
    },
    update(trace: TraceRecord, dt: number, wallDt: number): void {
      void dt
      wallSinceChange += Math.max(0, wallDt)
      if (trace.stop === stop || wallSinceChange < MIN_DWELL_S) return
      if ((trace.visited & traceStopBit(trace.stop)) === 0) return
      stop = trace.stop
      wallSinceChange = 0
    },
    reset(trace: TraceRecord): void {
      stop = trace.stop
      wallSinceChange = 0
    },
  }
}
