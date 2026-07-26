import type { DistrictId } from './types'

export interface Destination {
  district: Exclude<DistrictId, 'world'>
  id: string
  name: string
  /** Obvious abbreviation for the 196 px minimap only. */
  shortName: string
}

/**
 * The eight places a visitor can navigate to.
 *
 * View controls, help, floating map labels, ground wayfinding, the minimap and
 * destination inspector headings all read this table. Component names remain
 * free to name the specific building at the destination.
 */
export const DESTINATIONS: readonly Destination[] = [
  { district: 'clients', id: 'client.pool', name: 'Clients', shortName: 'Clients' },
  { district: 'backends', id: 'backend.row', name: 'Backends', shortName: 'Backends' },
  {
    district: 'shmem',
    id: 'shared.buffers',
    name: 'Buffer pool (shared_buffers)',
    shortName: 'Buffer pool',
  },
  { district: 'wal', id: 'wal.vault', name: 'WAL', shortName: 'WAL' },
  { district: 'storage', id: 'storage.datadir', name: 'Storage', shortName: 'Storage' },
  { district: 'planner', id: 'planner.lab', name: 'Query lab', shortName: 'Query lab' },
  { district: 'maintenance', id: 'checkpointer', name: 'Maintenance', shortName: 'Maint.' },
  { district: 'replication', id: 'replica.standby', name: 'Standby', shortName: 'Standby' },
] as const

const BY_DISTRICT = new Map<DistrictId, Destination>(
  DESTINATIONS.map((destination) => [destination.district, destination]),
)
const BY_ID = new Map(DESTINATIONS.map((destination) => [destination.id, destination]))

export function destinationForDistrict(district: DistrictId): Destination | undefined {
  return BY_DISTRICT.get(district)
}

export function destinationForId(id: string): Destination | undefined {
  return BY_ID.get(id)
}
