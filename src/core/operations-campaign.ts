import type { AnalyticsTracker } from './analytics'

export const CAMPAIGN_VARIANTS = ['slot-pressure', 'retired-slot'] as const
export type CampaignVariant = typeof CAMPAIGN_VARIANTS[number]
export type CampaignMode = 'guided' | 'challenge'
export type CampaignStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const KEY = 'pgsimcity.operations.v1'
const validVariant = (value: unknown): value is CampaignVariant => CAMPAIGN_VARIANTS.some(id => id === value)

export function campaignHref(variant: CampaignVariant, mode: CampaignMode): string {
  return `#campaign/${variant}/${mode}`
}

export function campaignRoute(hash: string): { variant: CampaignVariant; mode: CampaignMode } | null {
  for (const variant of CAMPAIGN_VARIANTS) {
    for (const mode of ['guided', 'challenge'] as const) {
      if (hash === campaignHref(variant, mode)) return { variant, mode }
    }
  }
  return null
}

export function loadCampaignProgress(storage: CampaignStorage | null): { available: boolean; completed: CampaignVariant[] } {
  try {
    if (!storage) return { available: false, completed: [] }
    const raw = storage.getItem(KEY)
    if (!raw) return { available: true, completed: [] }
    if (raw.length > 256) return { available: true, completed: [] }
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object') return { available: true, completed: [] }
    const { version, completed } = data as { version?: unknown; completed?: unknown }
    if (version !== 1 || !Array.isArray(completed) || completed.length > 2 || !completed.every(validVariant)) return { available: true, completed: [] }
    return { available: true, completed: [...new Set(completed)] }
  } catch { return { available: false, completed: [] } }
}

export function saveCampaignProgress(storage: CampaignStorage | null, completed: CampaignVariant[]): boolean {
  try {
    if (!storage) return false
    storage.setItem(KEY, JSON.stringify({ version: 1, completed: CAMPAIGN_VARIANTS.filter(id => completed.includes(id)) }))
    return true
  } catch { return false }
}

export function clearCampaignProgress(storage: CampaignStorage | null): boolean {
  try { if (!storage) return false; storage.removeItem(KEY); return true } catch { return false }
}

export function trackCampaignProgress(tracker: AnalyticsTracker, value: { event: string; variant: string; mode: string; [key: string]: unknown }): void {
  if (!validVariant(value.variant) || (value.mode !== 'guided' && value.mode !== 'challenge')) return
  const names: Record<string, string> = { started: 'Campaign Started', 'hint-used': 'Campaign Hint Used', 'evidence-collected': 'Campaign Evidence Collected', 'recovery-verified': 'Campaign Recovery Verified', completed: 'Campaign Completed' }
  if (Object.hasOwn(names, value.event)) tracker.track(names[value.event], { lesson: 'wal-operations', variant: value.variant, mode: value.mode })
}
