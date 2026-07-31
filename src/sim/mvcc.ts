import type {
  MvccRowStory,
  MvccSnapshot,
  MvccTupleVersion,
} from '../core/types'

const MAX_REPRESENTATIVE_VERSIONS = 24

/*
 * This is the committed-transaction path of HeapTupleSatisfiesMVCC. The city
 * does not model aborted creators, MultiXact lockers, command IDs, subxids, or
 * 32-bit XID wraparound. It does model the snapshot bounds and in-progress set
 * that decide which committed physical version a reader can see.
 */
export function takeMvccSnapshot(
  xmax: number,
  takenAt: number,
  inProgress: readonly number[] = [],
): MvccSnapshot {
  let xmin = xmax
  const copied: number[] = []
  for (let i = 0; i < inProgress.length; i++) {
    const xid = inProgress[i]
    copied.push(xid)
    if (xid < xmin) xmin = xid
  }
  return {
    xmin,
    xmax,
    inProgress: copied,
    takenAt,
    active: false,
    visibleRevision: 0,
  }
}

function xidWasInProgress(snapshot: MvccSnapshot, xid: number): boolean {
  for (let i = 0; i < snapshot.inProgress.length; i++) {
    if (snapshot.inProgress[i] === xid) return true
  }
  return false
}

export function mvccVersionVisible(
  version: MvccTupleVersion,
  snapshot: MvccSnapshot,
): boolean {
  if (version.xmin >= snapshot.xmax || xidWasInProgress(snapshot, version.xmin)) {
    return false
  }
  if (version.xmax === 0) return true
  return version.xmax >= snapshot.xmax || xidWasInProgress(snapshot, version.xmax)
}

export function visibleVersion(
  versions: readonly MvccTupleVersion[],
  snapshot: MvccSnapshot,
): MvccTupleVersion | undefined {
  for (let i = versions.length - 1; i >= 0; i--) {
    if (mvccVersionVisible(versions[i], snapshot)) return versions[i]
  }
  return undefined
}

/**
 * GlobalVisTestIsRemovableXid uses TransactionIdPrecedes: equality with the
 * cutoff is not removable. Model XIDs are monotonic numbers and do not wrap.
 */
export function mvccVersionCollectable(
  version: MvccTupleVersion,
  xminHorizon: number,
): boolean {
  return version.xmax > 0 && version.xmax < xminHorizon
}

function refreshSnapshot(
  versions: readonly MvccTupleVersion[],
  snapshot: MvccSnapshot,
): void {
  snapshot.visibleRevision = visibleVersion(versions, snapshot)?.revision ?? 0
}

export function refreshRepresentativeRow(
  row: MvccRowStory,
  xminHorizon: number,
): void {
  for (let i = 0; i < row.versions.length; i++) {
    row.versions[i].collectable = mvccVersionCollectable(
      row.versions[i],
      xminHorizon,
    )
  }
  refreshSnapshot(row.versions, row.earlierSnapshot)
  refreshSnapshot(row.versions, row.laterSnapshot)
}

export function createRepresentativeRow(
  initialXid: number,
  block: number,
): MvccRowStory {
  const snapshot = takeMvccSnapshot(initialXid + 1, 0)
  const laterSnapshot = takeMvccSnapshot(initialXid + 1, 0)
  const row: MvccRowStory = {
    versions: [{
      revision: 1,
      xmin: initialXid,
      xmax: 0,
      createdAt: 0,
      hot: false,
      nextHot: false,
      block,
      offset: 1,
      indexBlock: block,
      indexOffset: 1,
      ctidBlock: block,
      ctidOffset: 1,
      nextRevision: 0,
      collectable: false,
    }],
    earlierSnapshot: snapshot,
    laterSnapshot,
    nextSampleAt: 0,
    collectedVersions: 0,
    omittedVersions: 0,
    omittedThroughXmax: 0,
  }
  refreshRepresentativeRow(row, initialXid)
  return row
}

export function recordRepresentativeUpdate(
  row: MvccRowStory,
  updateXid: number,
  at: number,
  hot: boolean,
): boolean {
  const previous = row.versions[row.versions.length - 1]
  if (!previous || updateXid <= previous.xmin) return false

  if (!row.earlierSnapshot.active) {
    row.earlierSnapshot = takeMvccSnapshot(updateXid, at)
  }

  previous.xmax = updateXid
  const revision = previous.revision + 1
  const block = hot ? previous.block : previous.block + 1
  const offset = hot ? previous.offset + 1 : 1
  previous.ctidBlock = block
  previous.ctidOffset = offset
  previous.nextRevision = revision
  previous.nextHot = hot
  row.versions.push({
    revision,
    xmin: updateXid,
    xmax: 0,
    createdAt: at,
    hot,
    nextHot: false,
    block,
    offset,
    indexBlock: hot ? previous.indexBlock : block,
    indexOffset: hot ? previous.indexOffset : offset,
    ctidBlock: block,
    ctidOffset: offset,
    nextRevision: 0,
    collectable: false,
  })
  if (row.versions.length > MAX_REPRESENTATIVE_VERSIONS) {
    let remove = -1
    for (let i = 0; i < row.versions.length - 1; i++) {
      const revision = row.versions[i].revision
      if (
        revision !== row.earlierSnapshot.visibleRevision
        && revision !== row.laterSnapshot.visibleRevision
      ) {
        remove = i
        break
      }
    }
    if (remove >= 0) {
      const omitted = row.versions[remove]
      row.omittedVersions++
      row.omittedThroughXmax = Math.max(
        row.omittedThroughXmax,
        omitted.xmax,
      )
      for (let i = remove + 1; i < row.versions.length; i++) {
        row.versions[i - 1] = row.versions[i]
      }
      row.versions.length--
    }
  }
  row.laterSnapshot = takeMvccSnapshot(updateXid + 1, at)
  refreshSnapshot(row.versions, row.earlierSnapshot)
  refreshSnapshot(row.versions, row.laterSnapshot)
  return true
}

export function holdRepresentativeSnapshot(
  row: MvccRowStory,
  nextXid: number,
  at: number,
  inProgress: readonly number[] = [],
): void {
  row.earlierSnapshot = takeMvccSnapshot(nextXid, at, inProgress)
  row.earlierSnapshot.active = true
  refreshSnapshot(row.versions, row.earlierSnapshot)
}

export function releaseRepresentativeSnapshot(row: MvccRowStory): void {
  row.earlierSnapshot.active = false
}

export function collectRepresentativeVersions(
  row: MvccRowStory,
  xminHorizon: number,
): number {
  let write = 0
  let collected = 0
  const latest = row.versions.length - 1
  for (let read = 0; read < row.versions.length; read++) {
    const version = row.versions[read]
    if (read !== latest && mvccVersionCollectable(version, xminHorizon)) {
      collected++
      continue
    }
    row.versions[write++] = version
  }
  row.versions.length = write
  if (
    row.omittedVersions > 0
    && row.omittedThroughXmax < xminHorizon
  ) {
    collected += row.omittedVersions
    row.omittedVersions = 0
    row.omittedThroughXmax = 0
  }
  row.collectedVersions += collected
  refreshRepresentativeRow(row, xminHorizon)
  return collected
}
