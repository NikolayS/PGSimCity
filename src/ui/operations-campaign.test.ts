import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import { createIncidentReplay } from '../sim/replay'
import { createSim } from '../sim/model'
import { installTestDom } from '../../test/dom'
import type { UiContext } from './uikit'
import { createOperationsCampaign } from './operations-campaign'

const modules: ReturnType<typeof createOperationsCampaign>[] = []
function fixture(withReplay = false) {
  installTestDom()
  const bus = createBus()
  const sim = createSim(bus, withReplay ? {} : { maxStep: 1 / 3, scheduledBackups: false })
  const replay = withReplay ? createIncidentReplay(sim, bus) : null
  const events: string[] = []
  const campaign = createOperationsCampaign({ bus, sim } as UiContext, { storage: null, canMutate: () => !replay?.status.seeking && !replay?.status.advancing, onProgress: p => events.push(p.event) })
  modules.push(campaign)
  return { bus, sim, campaign, events, replay }
}
const click = (name: string) => document.querySelector<HTMLButtonElement>(`[data-campaign-${name}]`)!.click()
const enabled = (name: string) => !document.querySelector<HTMLButtonElement>(`[data-campaign-${name}]`)!.disabled
function until(f: ReturnType<typeof fixture>, done: () => boolean) {
  for (let i = 0; i < 18000 && !done(); i++) { f.sim.advance(.1); f.campaign.update(.1) }
  expect(done()).toBe(true)
}
afterEach(() => { while (modules.length) modules.pop()!.dispose(); vi.useRealTimers() })

describe('operations campaign learner flow', () => {
  it('requires explicit reset before replacing the city and opens links without destroying work', () => {
    const f = fixture()
    f.sim.setKnob('tps', 123)
    const before = structuredClone(f.sim.state)
    f.campaign.open('retired-slot', 'challenge')
    expect(f.sim.state).toEqual(before)
    click('start')
    expect(f.sim.state.scenario).toBe('retired-slot')
    expect(f.sim.state.knobs.paused).toBe(true)
    expect(f.events).toEqual(['started'])
  })
  it('requires recorded evidence and actual recovery before local completion', () => {
    const f = fixture()
    f.campaign.open('retired-slot', 'challenge'); click('start')
    expect(enabled('drop')).toBe(false)
    until(f, () => f.sim.state.scenarioDecision?.phase === 'ready')
    expect(enabled('drop')).toBe(false)
    click('record')
    expect(enabled('drop')).toBe(true)
    click('drop')
    expect(enabled('verify')).toBe(false)
    until(f, () => f.sim.state.scenarioDecision?.phase === 'recovered')
    click('verify')
    expect(f.events.filter(e => e === 'completed')).toHaveLength(1)
    expect(document.querySelector('[data-campaign-status]')!.textContent).toContain('Recovery verified')
    click('verify')
    expect(f.events.filter(e => e === 'completed')).toHaveLength(1)
    click('retry')
    expect(f.sim.state.replication.physicalSlots[1].exists).toBe(true)
    expect(f.sim.state.scenarioDecision?.phase).toBe('staging')
    expect(enabled('drop')).toBe(false)
  })
  it('preserves the retired attempt when reopened or only the guidance mode changes', () => {
    const f = fixture()
    f.campaign.open('retired-slot', 'challenge'); click('start')
    until(f, () => f.sim.state.scenarioDecision?.phase === 'ready')
    click('record')
    const saved = document.querySelector('[data-campaign-saved]')!.textContent
    const note = document.querySelector('textarea') as HTMLTextAreaElement
    note.value = 'preserve this explanation'
    f.campaign.close(); f.campaign.open()
    expect(document.querySelector('[data-campaign-saved]')!.textContent).toBe(saved)
    expect(enabled('drop')).toBe(true)
    f.campaign.open('retired-slot', 'guided')
    expect(document.querySelector('[data-campaign-saved]')!.textContent).toBe(saved)
    expect(note.value).toBe('preserve this explanation')
  })

  it('allows releases to reach a camera key held before the panel opened', () => {
    const f = fixture(); f.campaign.open()
    const release = new Event('keyup', { bubbles: true })
    const stop = vi.spyOn(release, 'stopPropagation')
    document.querySelector('.operations-campaign')!.dispatchEvent(release)
    expect(stop).not.toHaveBeenCalled()
  })
  it('cancels bounded model observation on Stop and close without resetting the reached state', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.campaign.open(); click('start')
    click('advance')
    const started = f.sim.state.t
    expect(started).toBeGreaterThan(0)
    click('cancel')
    await vi.runAllTimersAsync()
    expect(f.sim.state.t).toBe(started)
    click('advance')
    const beforeClose = f.sim.state.t
    expect(beforeClose).toBeGreaterThan(started)
    f.campaign.close()
    await vi.runAllTimersAsync()
    expect(f.sim.state.t).toBe(beforeClose)
    expect(f.sim.state.knobs.paused).toBe(true)
  })

  it('blocks reset and observation while real replay reconstruction is in flight', async () => {
    const f = fixture(true)
    try {
      f.campaign.open(); click('start')
      for (let i = 0; i < 350; i++) f.sim.advance(.1)
      const point = f.replay!.checkpoint()
      for (let i = 0; i < 350; i++) f.sim.advance(.1)
      const pending = f.replay!.rewind(point)
      f.campaign.update(1)
      expect(f.replay!.status.seeking).toBe(true)
      expect(enabled('start')).toBe(false)
      expect(enabled('retry')).toBe(false)
      expect(enabled('advance')).toBe(false)
      await pending
    } finally { f.replay!.dispose() }
  })

  it('keeps legacy decision overlays suppressed on a live-city round trip', () => {
    const f = fixture(); f.campaign.open(); click('start')
    const decision = f.sim.state.scenarioDecision
    f.campaign.close()
    expect(document.body.classList.contains('pg-operations-attempt')).toBe(true)
    expect(f.sim.state.scenarioDecision).toBe(decision)
    f.sim.reset()
    expect(document.body.classList.contains('pg-operations-attempt')).toBe(false)
    f.campaign.open(); click('start'); f.campaign.close()
    f.sim.runScenario('vacuum-blockade')
    expect(document.body.classList.contains('pg-operations-attempt')).toBe(false)
  })

  it('invalidates evidence after an external reset and never awards a different incident', () => {
    const f = fixture()
    f.campaign.open(); click('start')
    until(f, () => f.sim.state.scenarioDecision?.phase === 'ready')
    click('record')
    f.sim.reset()
    f.campaign.update(1)
    expect(enabled('capacity')).toBe(false)
    expect(enabled('verify')).toBe(false)
    expect(document.querySelector('[data-campaign-status]')!.textContent).toContain('changed')
  })
})
