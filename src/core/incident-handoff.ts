import { decodeReplay, encodeReplay, REPLAY_MAX_BYTES } from '../sim/replay'
import type { IncidentReplay, ReplayRecord } from '../sim/replay'

export const HANDOFF_KEY = 'pgsimcity.incident-handoff.v1'
export const HANDOFF_TTL = 30 * 60 * 1000
const MAX_BYTES = REPLAY_MAX_BYTES + 4096
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type StorageSource = StoragePort | (() => StoragePort)
export type IncidentDestination = 'city' | 'diagnose'
export interface IncidentContext {
  selected?: string
  diagnosis?: { symptom: string; node: string; trail: string[] } | { instrument: string }
}
export interface IncidentHandoff {
  version: 1
  destination: IncidentDestination
  created: number
  record: ReplayRecord
  context: IncidentContext
}
export type IncidentHandoffResult = { kind: 'none' } | { kind: 'error'; message: string }
  | { kind: 'ready'; value: IncidentHandoff }

function storage(source: StorageSource): StoragePort {
  return typeof source === 'function' ? source() : source
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid incident navigation data')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value)) throw new Error('Invalid incident selection')
  return value
}
function context(value: unknown): IncidentContext {
  const item = object(value, ['selected', 'diagnosis'])
  const result: IncidentContext = {}
  if (item.selected !== undefined) result.selected = id(item.selected)
  if (item.diagnosis !== undefined) {
    const entry = object(item.diagnosis, ['symptom', 'node', 'trail', 'instrument'])
    if (entry.instrument !== undefined) {
      if (Object.keys(entry).length !== 1) throw new Error('Invalid diagnostic navigation')
      result.diagnosis = { instrument: id(entry.instrument) }
    } else {
      if (!Array.isArray(entry.trail) || entry.trail.length > 30) throw new Error('Invalid diagnostic history')
      result.diagnosis = { symptom: id(entry.symptom), node: id(entry.node), trail: entry.trail.map(id) }
    }
  }
  return result
}

/** Only a fixed marker enters navigation URLs; the bounded payload stays in this tab. */
export function writeIncidentHandoff(
  source: StorageSource, replay: IncidentReplay, destination: IncidentDestination,
  selection: IncidentContext, now = Date.now(),
): void {
  const value: IncidentHandoff = { version: 1, destination, created: now,
    record: decodeReplay(encodeReplay(replay.exportRecord())), context: context(selection) }
  const text = JSON.stringify(value)
  if (text.length > MAX_BYTES) throw new Error('Incident navigation size limit exceeded')
  try { storage(source).setItem(HANDOFF_KEY, text) }
  catch { throw new Error('Tab storage is unavailable; the incident has not been transferred') }
}

export function readIncidentHandoff(
  source: StorageSource, hash: string, destination: IncidentDestination, now = Date.now(),
): IncidentHandoffResult {
  if (hash !== '#incident') return { kind: 'none' }
  try {
    const text = storage(source).getItem(HANDOFF_KEY)
    if (!text) throw new Error('Incident navigation data is missing; return to the originating tab')
    if (text.length > MAX_BYTES) throw new Error('Incident navigation size limit exceeded')
    const item = object(JSON.parse(text), ['version', 'destination', 'created', 'record', 'context'])
    if (item.version !== 1) throw new Error('Unsupported incident navigation version')
    if (item.destination !== destination) throw new Error('This incident transfer belongs to another view')
    if (typeof item.created !== 'number' || !Number.isFinite(item.created)
      || item.created > now || now - item.created > HANDOFF_TTL) throw new Error('Incident transfer expired; send it again from the originating view')
    const value: IncidentHandoff = { version: 1, destination, created: item.created,
      record: decodeReplay(encodeReplay(item.record)), context: context(item.context) }
    storage(source).removeItem(HANDOFF_KEY)
    return { kind: 'ready', value }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Incident storage is unavailable' }
  }
}
