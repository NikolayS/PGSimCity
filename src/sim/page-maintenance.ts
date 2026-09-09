/** Representative heap page, not a byte decoder or relation-wide estimate.
 * Inputs are committed transactions with monotonic, non-wrapping model XIDs.
 * Index cleanup precedes reclamation here; HOT redirects and MultiXacts are absent. */
export interface SamplePageTuple {
  offset: number
  xmin: number
  xmax: number
  bytes: number
  frozen: boolean
}

export interface SampleHeapPage {
  slots: (SamplePageTuple | null)[]
  freeBytes: number
  allVisible: boolean
  allFrozen: boolean
  removed: number
  frozen: number
}

export function createSamplePage(): SampleHeapPage {
  return {
    slots: [], freeBytes: 8192 - 24,
    allVisible: false, allFrozen: false, removed: 0, frozen: 0,
  }
}

export function insertSampleTuple(
  page: SampleHeapPage, xmin: number, bytes: number,
): SamplePageTuple | null {
  if (!Number.isSafeInteger(xmin) || xmin < 3
      || !Number.isSafeInteger(bytes) || bytes < 24) return null
  const alignedBytes = Math.ceil(bytes / 8) * 8
  const reusable = page.slots.indexOf(null)
  const cost = alignedBytes + (reusable < 0 ? 4 : 0)
  if (cost > page.freeBytes) return null
  const index = reusable < 0 ? page.slots.length : reusable
  const tuple = { offset: index + 1, xmin, xmax: 0, bytes: alignedBytes, frozen: false }
  page.slots[index] = tuple
  page.freeBytes -= cost
  page.allVisible = false
  page.allFrozen = false
  return tuple
}

/** Both cutoffs are exclusive. The global horizon must include every blocker;
 * freezeBefore additionally applies the configured tuple-age policy. */
export function vacuumSamplePage(
  page: SampleHeapPage, horizon: number, freezeBefore: number,
): { removed: number; frozen: number } {
  if (!Number.isSafeInteger(horizon) || !Number.isSafeInteger(freezeBefore)
      || horizon < 3 || freezeBefore < 3) {
    throw new RangeError('Expected valid monotonic model XID cutoffs')
  }
  let removed = 0
  let frozen = 0
  let allVisible = true
  let allFrozen = true
  const freezeLimit = Math.min(horizon, freezeBefore)
  for (let i = 0; i < page.slots.length; i++) {
    const tuple = page.slots[i]
    if (!tuple) continue
    if (tuple.xmax > 0 && tuple.xmax < horizon) {
      page.freeBytes += tuple.bytes
      page.slots[i] = null
      removed++
      continue
    }
    if (!tuple.frozen && tuple.xmin < freezeLimit) {
      tuple.frozen = true
      frozen++
    }
    if (tuple.xmax !== 0 || (!tuple.frozen && tuple.xmin >= horizon)) {
      allVisible = false
    }
    if (!tuple.frozen || tuple.xmax !== 0) allFrozen = false
  }
  page.allVisible = allVisible
  page.allFrozen = allVisible && allFrozen
  page.removed += removed
  page.frozen += frozen
  return { removed, frozen }
}
