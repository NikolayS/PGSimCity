import { describe, expect, it } from 'vitest'
import { campaignRoute, campaignHref, loadCampaignProgress, saveCampaignProgress, clearCampaignProgress, trackCampaignProgress } from './operations-campaign'

describe('bounded private campaign progress and links', () => {
  it('accepts only exact authored routes', () => {
    expect(campaignRoute(campaignHref('retired-slot', 'challenge'))).toEqual({ variant: 'retired-slot', mode: 'challenge' })
    for (const hash of ['#campaign/retired-slot/challenge?sql=secret', '#campaign/unknown/guided', '#campaign/slot-pressure/%67uided']) expect(campaignRoute(hash)).toBeNull()
  })
  it('reloads bounded completion identifiers and clears without retaining evidence', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
    expect(saveCampaignProgress(storage, ['retired-slot', 'retired-slot'])).toBe(true)
    expect(loadCampaignProgress(storage)).toEqual({ available: true, completed: ['retired-slot'] })
    expect([...data.values()][0]).toBe('{"version":1,"completed":["retired-slot"]}')
    expect(clearCampaignProgress(storage)).toBe(true)
    expect(loadCampaignProgress(storage).completed).toEqual([])
    storage.setItem('pgsimcity.operations.v1', '{"version":2,"completed":["retired-slot"]}')
    expect(loadCampaignProgress(storage).completed).toEqual([])
    storage.setItem('pgsimcity.operations.v1', '{"version":1,"completed":["private"]}')
    expect(loadCampaignProgress(storage).completed).toEqual([])
  })
  it('handles unavailable storage without throwing', () => {
    const storage = { getItem() { throw Error('blocked') }, setItem() { throw Error('full') }, removeItem() { throw Error('blocked') } }
    expect(loadCampaignProgress(storage)).toEqual({ available: false, completed: [] })
    expect(saveCampaignProgress(storage, ['slot-pressure'])).toBe(false)
    expect(clearCampaignProgress(storage)).toBe(false)
  })
  it('strips free text and rejects unknown analytics identifiers', () => {
    const calls: unknown[] = []
    const tracker = { track: (...args: unknown[]) => { calls.push(args) } }
    trackCampaignProgress(tracker, { event: 'completed', variant: 'retired-slot', mode: 'challenge', notes: 'secret' })
    trackCampaignProgress(tracker, { event: 'completed', variant: 'secret', mode: 'guided' })
    expect(calls).toEqual([['Campaign Completed', { lesson: 'wal-operations', variant: 'retired-slot', mode: 'challenge' }]])
  })
})
