import type {
  Knobs,
  PhysicalStandbyState,
  ReplicationState,
  SimState,
} from './types'

export type PhysicalStandbyId = PhysicalStandbyState['nodeId']

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
