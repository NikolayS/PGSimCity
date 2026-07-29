import type { TraceStop } from '../core/types'
import { ANCHOR, CITY } from './layout'

export type ControlPlanPoint = readonly [x: number, y: number, z: number]

export interface ControlTraceRoute {
  id: string
  stop: Exclude<TraceStop, 'done'>
  points: readonly ControlPlanPoint[]
  /** A storage descent only exists when the model recorded a shared read. */
  requiresRead?: boolean
}

/* Offset one occupied tower from the centre mullion so the foreground path is
 * visible from the room; it still lands on the real backend row. */
const BACKEND: ControlPlanPoint = [18, 14, CITY.backend.z]
const BUFFER_POOL: ControlPlanPoint = [0, 8, ANCHOR.bufferGrid[2]]
const PLANNER: ControlPlanPoint = [ANCHOR.planner[0], ANCHOR.planner[1], ANCHOR.planner[2]]

/**
 * One route grammar feeds both representations: SVG drops Y for the plan,
 * while the 3D layer keeps it and lights the same stages outside the window.
 */
export const CONTROL_TRACE_ROUTES: readonly ControlTraceRoute[] = [
  {
    id: 'backend',
    stop: 'connect',
    points: [
      [ANCHOR.clientTerminal[0], 8, ANCHOR.clientTerminal[2] + 10],
      [ANCHOR.postmasterDoor[0], 8, ANCHOR.postmasterDoor[2]],
      BACKEND,
    ],
  },
  {
    id: 'plan',
    stop: 'parse_plan',
    points: [BACKEND, PLANNER],
  },
  {
    id: 'fetch',
    stop: 'fetch',
    points: [PLANNER, BACKEND, [0, 10, -72], BUFFER_POOL],
  },
  {
    id: 'storage-read',
    stop: 'fetch',
    requiresRead: true,
    points: [
      BUFFER_POOL,
      [0, -8, -8],
      [0, CITY.osCache.y, -34],
      [0, CITY.storage.y + 8, -60],
      BUFFER_POOL,
    ],
  },
  {
    id: 'execute',
    stop: 'work',
    points: [BUFFER_POOL, [0, 12, -76], BACKEND],
  },
  {
    id: 'wal',
    stop: 'wal',
    points: [
      BACKEND,
      [48, 18, -84],
      [ANCHOR.walBuffers[0], 8, ANCHOR.walBuffers[2]],
    ],
  },
  {
    id: 'commit',
    stop: 'commit',
    points: [
      [ANCHOR.walBuffers[0], 8, ANCHOR.walBuffers[2]],
      [ANCHOR.walWriter[0], 10, ANCHOR.walWriter[2]],
      [ANCHOR.walVault[0], 15, ANCHOR.walVault[2]],
    ],
  },
  {
    id: 'return',
    stop: 'send',
    points: [
      BACKEND,
      [-22, 9, -184],
      [-22, 8, -248],
      [ANCHOR.clientTerminal[0], 8, ANCHOR.clientTerminal[2] + 10],
    ],
  },
  {
    id: 'blocked',
    stop: 'blocked',
    points: [
      BACKEND,
      [30, 16, -86],
      [ANCHOR.lockManager[0], 9, ANCHOR.lockManager[2]],
    ],
  },
]

export interface ControlPlanRegion {
  id: string
  label: string
  x: readonly [number, number]
  z: readonly [number, number]
  below?: boolean
}

export const CONTROL_PLAN_REGIONS: readonly ControlPlanRegion[] = [
  { id: 'clients', label: 'CLIENT APPLICATIONS', x: [-112, 112], z: [-350, -274] },
  { id: 'backends', label: 'BACKEND PROCESSES', x: [-124, 124], z: [-150, -110] },
  { id: 'shmem', label: 'SHARED MEMORY', x: [-84, 84], z: [-68, 68] },
  { id: 'storage', label: 'DATA DIRECTORY ↓', x: [-156, 156], z: [-96, 96], below: true },
  { id: 'wal', label: 'WAL', x: [108, 268], z: [-92, 120] },
  { id: 'maintenance', label: 'MAINTENANCE', x: [-256, -108], z: [-70, 110] },
  { id: 'replication', label: 'REPLICATION', x: [40, 280], z: [150, 350] },
]

export interface ControlPlanLandmark {
  id: string
  label: string
  x: number
  z: number
}

export const CONTROL_PLAN_LANDMARKS: readonly ControlPlanLandmark[] = [
  { id: 'postmaster', label: 'POSTMASTER / YOU', x: ANCHOR.postmaster[0], z: ANCHOR.postmaster[2] },
  { id: 'planner', label: 'PLANNER', x: ANCHOR.planner[0], z: ANCHOR.planner[2] },
  { id: 'archive', label: 'ARCHIVE', x: ANCHOR.objectStore[0], z: ANCHOR.objectStore[2] },
  { id: 'backup', label: 'BASE BACKUPS', x: ANCHOR.backupVault[0], z: ANCHOR.backupVault[2] },
  { id: 'recovery', label: 'PITR', x: ANCHOR.recoveryPad[0], z: ANCHOR.recoveryPad[2] },
  { id: 'ha', label: 'HA / DCS', x: ANCHOR.consensus[0], z: ANCHOR.consensus[2] },
]
