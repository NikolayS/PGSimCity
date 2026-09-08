import { describe, expect, it } from 'vitest'
import { createBus } from './bus'
import { createSim } from '../sim/model'
import { createIncidentReplay } from '../sim/replay'
import { readIncidentHandoff, writeIncidentHandoff, HANDOFF_KEY, HANDOFF_TTL } from './incident-handoff'

function storage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) } }
}
function model(seed = 42) {
  const bus = createBus()
  const sim = createSim(bus, { seed })
  return { sim, replay: createIncidentReplay(sim, bus) }
}
describe('tab-local incident navigation', () => {
  it('round trips the complete model, clock, actions and selected object', async () => {
    const source = model()
    source.sim.runScenario('vacuum-blockade')
    for (let i = 0; i < 90; i++) source.sim.update(1 / 30)
    const store = storage()
    writeIncidentHandoff(store, source.replay, 'diagnose', { selected: 'storage.table.sessions' }, 100)
    const read = readIncidentHandoff(store, '#incident', 'diagnose', 101)
    expect(read.kind).toBe('ready')
    if (read.kind !== 'ready') throw new Error('Missing incident')
    const target = model(read.value.record.seed)
    await target.replay.loadRecord(read.value.record)
    expect(target.sim.state).toEqual(source.sim.state)
    expect(read.value.context.selected).toBe('storage.table.sessions')
    target.sim.setKnob('tps', 100)
    writeIncidentHandoff(store, target.replay, 'city', read.value.context, 102)
    const returned = readIncidentHandoff(store, '#incident', 'city', 103)
    if (returned.kind !== 'ready') throw new Error('Missing return')
    await source.replay.loadRecord(returned.value.record)
    expect(source.sim.state).toEqual(target.sim.state)
  })
  it('does not restore or read storage without an explicit marker', () => {
    expect(readIncidentHandoff(() => { throw new Error('unavailable') }, '', 'city', 100)).toEqual({ kind: 'none' })
  })
  it('rejects stale, missing and wrong-destination records visibly', () => {
    const store = storage()
    const { replay } = model()
    expect(readIncidentHandoff(store, '#incident', 'city', 100).kind).toBe('error')
    writeIncidentHandoff(store, replay, 'city', {}, 100)
    expect(readIncidentHandoff(store, '#incident', 'diagnose', 101).kind).toBe('error')
    expect(readIncidentHandoff(store, '#incident', 'city', 101 + HANDOFF_TTL).kind).toBe('error')
  })
  it.each(['null', '{', 'x'.repeat(110_000), '{"__proto__":{}}'])('rejects malicious stored data', (raw) => {
    const store = storage()
    store.setItem(HANDOFF_KEY, raw)
    expect(readIncidentHandoff(store, '#incident', 'city', 100).kind).toBe('error')
  })
  it('reports unavailable storage and unsupported model actions', () => {
    expect(readIncidentHandoff(() => { throw new Error('disabled') }, '#incident', 'city', 100).kind).toBe('error')
    const { sim, replay } = model()
    sim.setTraceMode('step')
    expect(() => writeIncidentHandoff(storage(), replay, 'city', {}, 100)).toThrow(/Unsupported/)
    expect(() => writeIncidentHandoff(() => { throw new Error('denied') }, model().replay, 'city', {}, 100)).toThrow(/storage is unavailable/)
  })
  it('consumes a transfer so refresh cannot silently rewind to stale state', () => {
    const store = storage()
    writeIncidentHandoff(store, model().replay, 'city', {}, 100)
    expect(readIncidentHandoff(store, '#incident', 'city', 101).kind).toBe('ready')
    expect(readIncidentHandoff(store, '#incident', 'city', 102).kind).toBe('error')
  })
  it('rejects version mismatch, future creation and unbounded context', () => {
    const store = storage()
    writeIncidentHandoff(store, model().replay, 'city', {}, 100)
    const raw = JSON.parse(store.getItem(HANDOFF_KEY)!)
    raw.record.modelVersion = 'different'
    store.setItem(HANDOFF_KEY, JSON.stringify(raw))
    expect(readIncidentHandoff(store, '#incident', 'city', 101)).toMatchObject({ kind: 'error', message: 'Replay model-version mismatch' })
    writeIncidentHandoff(store, model().replay, 'city', {}, 100)
    expect(readIncidentHandoff(store, '#incident', 'city', 99).kind).toBe('error')
    expect(() => writeIncidentHandoff(store, model().replay, 'city', { selected: '<script>' }, 100)).toThrow(/selection/)
  })
  it('preserves diagnostic history and accepts the exact expiry boundary', () => {
    const store = storage()
    const context = { selected: 'storage.table.sessions', diagnosis: {
      symptom: 'bloat', node: 'bloat.2', trail: ['bloat.1'],
    } }
    writeIncidentHandoff(store, model().replay, 'city', context, 100)
    const result = readIncidentHandoff(store, '#incident', 'city', 100 + HANDOFF_TTL)
    expect(result.kind === 'ready' && result.value.context).toEqual(context)
    expect(() => writeIncidentHandoff(store, model().replay, 'city', {
      diagnosis: { symptom: 'bloat', node: 'bloat.2', trail: Array(31).fill('bloat.1') },
    }, 100)).toThrow(/history/)
  })
})
