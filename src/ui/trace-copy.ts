import type { TraceRecord, TraceStop } from '../core/types'
import { fmtBytes } from '../core/util'
import { TABLES } from '../world/layout'

export interface StopCopy {
  title: string
  line(trace: TraceRecord): string
  hint: string
}

function tableName(trace: TraceRecord): string {
  return TABLES[trace.table]?.name ?? 'the table'
}

function isWrite(trace: TraceRecord): boolean {
  return trace.query === 'insert' || trace.query === 'update' || trace.query === 'delete'
}

export const TRACE_COPY: Record<TraceStop, StopCopy> = {
  connect: {
    title: 'A backend takes the query',
    line: (trace) => `One PostgreSQL backend accepts this statement for ${tableName(trace)}.`,
    hint: 'Fixed slot only; process startup and memory are absent.',
  },
  parse_plan: {
    title: 'Select a model plan template',
    line: (trace) => trace.lastPlanLabel
      ? `${trace.lastPlanLabel}: ${trace.lastPlanRows} display rows at display cost ${trace.lastPlanCost}.`
      : 'The fixed statement kind selects a model plan template.',
    hint: 'The city does not parse, rewrite, or cost alternative plans.',
  },
  fetch: {
    title: 'Fetch the needed pages',
    line: (trace) =>
      `${trace.buffersHit} buffer hits; ${trace.buffersRead} pages had to enter shared_buffers.`,
    hint: 'A hit avoids a storage read; it does not avoid execution.',
  },
  work: {
    title: 'Execute the plan',
    line: (trace) => trace.lastPlanLabel
      ? `${trace.lastPlanLabel} is running against ${tableName(trace)}.`
      : `The executor applies the fixed model operations to ${tableName(trace)}.`,
    hint: 'Per-node work_mem applies to fixed Sort/HashAggregate only.',
  },
  wal: {
    title: 'Write the change to WAL',
    line: (trace) =>
      `${fmtBytes(trace.walBytes)} of WAL, including ${fmtBytes(trace.walFpiBytes)} of page images.`,
    hint: 'WAL records the change before the data page reaches disk.',
  },
  commit: {
    title: 'Wait for durable commit',
    line: () => 'The backend waits until the required WAL flush has made the commit durable.',
    hint: 'The data page itself can be written later.',
  },
  send: {
    title: 'Send the result',
    line: (trace) => isWrite(trace)
      ? 'The backend sends command status; this model does not return rows for writes.'
      : `The backend streams ${trace.rowsSent} row${trace.rowsSent === 1 ? '' : 's'} to the client.`,
    hint: 'A write acknowledgement is not a returned result row.',
  },
  done: {
    title: 'The trip is complete',
    line: (trace) =>
      `${trace.lastTripSec.toFixed(3)} simulated s; ${trace.buffersHit} hits, ${trace.buffersRead} reads, ${fmtBytes(trace.walBytes)} WAL.`,
    hint: 'Change one thing, then run the statement again.',
  },
  blocked: {
    title: 'Wait for a table lock',
    line: (trace) => `Another backend holds a conflicting lock on ${tableName(trace)}.`,
    hint: 'The backend keeps its connection slot while it waits.',
  },
}
