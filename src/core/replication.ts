import type {
  Knobs,
  PhysicalStandbyState,
  ReplicationState,
  SimState,
} from './types'

export type PhysicalStandbyId = PhysicalStandbyState['nodeId']

type SynchronousCommitKnobs = Pick<
  Knobs,
  | 'synchronousCommit'
  | 'synchronousStandbyNames'
  | 'walLevel'
  | 'standbyAEnabled'
  | 'standbyBEnabled'
>

export interface SynchronousStandbyBlocker {
  standbyId: PhysicalStandbyId
  reason: 'physical-replication-disabled' | 'standby-disabled'
}

export function physicalStandby(
  replication: ReplicationState,
  nodeId: PhysicalStandbyId,
): PhysicalStandbyState {
  return replication.standbys[nodeId === 'standbyA' ? 0 : 1]
}

/** Patroni rewrites the selection after promotion so the leader is never its own follower. */
export function synchronousStandbyId(
  knobs: Pick<Knobs, 'synchronousStandbyNames'>,
  leader: SimState['highAvailability']['currentLeader'],
): PhysicalStandbyId | null {
  if (knobs.synchronousStandbyNames === 'none') return null
  if (leader === 'standbyA') return 'standbyB'
  if (leader === 'standbyB') return 'standbyA'
  return knobs.synchronousStandbyNames
}

/** The commit modes that enter SyncRep when a standby name is configured. */
export function synchronousCommitNeedsRemoteAck(
  knobs: Pick<Knobs, 'synchronousCommit' | 'synchronousStandbyNames'>,
): boolean {
  return knobs.synchronousStandbyNames !== 'none'
    && (
      knobs.synchronousCommit === 'remote_write'
      || knobs.synchronousCommit === 'on'
      || knobs.synchronousCommit === 'remote_apply'
    )
}

/** Whether this knob set can create the physical stream that supplies acknowledgements. */
export function physicalStandbyCanStream(
  knobs: Pick<Knobs, 'walLevel' | 'standbyAEnabled' | 'standbyBEnabled'>,
  standbyId: PhysicalStandbyId,
): boolean {
  if (knobs.walLevel === 'minimal') return false
  return standbyId === 'standbyA' ? knobs.standbyAEnabled : knobs.standbyBEnabled
}

/** A missing prerequisite that would leave every committing backend in SyncRep. */
export function synchronousStandbyBlocker(
  knobs: SynchronousCommitKnobs,
  leader: SimState['highAvailability']['currentLeader'],
): SynchronousStandbyBlocker | null {
  if (!synchronousCommitNeedsRemoteAck(knobs)) return null
  const standbyId = synchronousStandbyId(knobs, leader)
  if (!standbyId) return null
  if (knobs.walLevel === 'minimal') {
    return { standbyId, reason: 'physical-replication-disabled' }
  }
  return physicalStandbyCanStream(knobs, standbyId)
    ? null
    : { standbyId, reason: 'standby-disabled' }
}

export function configuredSynchronousStandby(
  state: Pick<SimState, 'knobs' | 'replication' | 'highAvailability'>,
): PhysicalStandbyState | undefined {
  const nodeId = synchronousStandbyId(state.knobs, state.highAvailability.currentLeader)
  return nodeId ? physicalStandby(state.replication, nodeId) : undefined
}

/** The laggiest connected row is the cluster-wide replication health reading. */
export function worstConnectedStandbyLag(
  state: Pick<SimState, 'replication'>,
): PhysicalStandbyState | undefined {
  let worst: PhysicalStandbyState | undefined
  for (const standby of state.replication.standbys) {
    if (!standby.enabled || !standby.connected) continue
    if (!worst || standby.lagBytes > worst.lagBytes) worst = standby
  }
  return worst
}

/** Furthest LSN delivered to every connected physical standby. */
export function allConnectedStandbysSentLsn(
  state: Pick<SimState, 'replication'>,
): number | undefined {
  let sentLsn = Infinity
  let found = false
  for (const standby of state.replication.standbys) {
    if (!standby.enabled || !standby.connected) continue
    found = true
    sentLsn = Math.min(sentLsn, standby.sentLsn)
  }
  return found ? sentLsn : undefined
}

/** Earliest restart position across every physical and active logical slot. */
export function oldestReplicationSlotLsn(
  state: Pick<SimState, 'replication'>,
): number | undefined {
  let restartLsn = Infinity
  let found = false
  for (const slot of state.replication.physicalSlots) {
    if (!slot.exists) continue
    found = true
    restartLsn = Math.min(restartLsn, slot.restartLsn)
  }
  if (state.replication.logicalEnabled) {
    found = true
    restartLsn = Math.min(restartLsn, state.replication.logicalSlotLsn)
  }
  return found ? restartLsn : undefined
}
