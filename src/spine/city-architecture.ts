/*
 * Pedagogical meaning for the geography owned by world/layout.ts. Coordinates,
 * footprints, anchors and route existence are joined in city-words-model.ts so
 * this spine can remain independent of the core/types -> claims import cycle.
 */

export interface CityDistrictClaim {
  name: string
  anchor?: string
  represents: string
  contains: readonly string[]
  scaleMeaning: string
}

export interface CityRelationshipClaim {
  id: string
  from: string
  to: string
  placement: string
  why: string
  evidence: {
    routes: readonly string[]
    anchors: readonly string[]
  }
}

export const CITY_ARCHITECTURE_CLAIMS = {
  scope:
    'This is a text rendering of the architecture carried by the city plan: districts, containment, relative placement, reserved footprints and the PostgreSQL reason for each connection.',
  orientation:
    'North is negative Z, south is positive Z, west is negative X, east is positive X, and Y is height. One world unit is approximately one metre.',
  overview:
    'Read the primary statement path from north to south: external clients cross the server boundary, reach one backend, and then use the central shared-memory plaza. The query lab is above the backend row. Durable storage is below the plaza; maintenance is west, WAL is east, and the two standby sites are south. Archive and recovery works sit outside the primary site.',
  limit:
    'This description does not replace the first-person walk. Movement, swimming, looking around from a 1.7 m eye height and the felt experience of distance and scale have no honest text equivalent.',
  districts: {
    clients: {
      name: 'Clients and connection approach',
      anchor: 'clientTerminal',
      represents:
        'The application tier approaching PostgreSQL from outside the server boundary. The plan places PgBouncer and a pg_hba.conf policy gatehouse on the approach to the postmaster, then carries one persistent connection to one backend. The gatehouse is a boundary metaphor, not an authentication execution-order claim.',
      contains: [
        'the external client terminal',
        'the PgBouncer gate and arrivals avenue',
        'the server-boundary pg_hba.conf policy gatehouse; authentication itself is not modeled',
        'the postmaster tower just inside the boundary',
        'sixteen connection conduits that continue toward the backend row',
      ],
      scaleMeaning:
        'The long northern approach makes the application tier visibly external to the server. Its distances are teaching distances, not connection latency.',
    },
    backends: {
      name: 'Backend row',
      represents:
        'Sixteen PostgreSQL backend process slots, one per admitted server connection in this model. Work belongs to a backend; the postmaster creates it and then leaves the query data path.',
      contains: [
        'sixteen independently state-lit backend towers',
        'private executor memory and temporary-file instruments attached to backend work',
        'the northern endpoints of routes into shared memory, WAL and storage',
      ],
      scaleMeaning:
        'The row is much wider than it is deep so the one-connection/one-backend concurrency model reads as parallel independent slots, not one shared worker building.',
    },
    shmem: {
      name: 'Buffer pool (shared_buffers) and shared memory plaza',
      anchor: 'plaza',
      represents:
        'The shared-memory region visible to every backend. The central grid is a representative sample of buffer frames, not every frame in a real shared_buffers allocation.',
      contains: [
        'the buffer pool (shared_buffers) sample and its clock-sweep hand',
        'the buffer mapping table',
        'ProcArray',
        'the lock manager',
        'CLOG/pg_xact SLRU',
        'cumulative-statistics shared memory',
        'wal_buffers on the plaza’s eastern edge',
      ],
      scaleMeaning:
        'The plaza is the central interchange because backends share it. Its tile count and footprint are a visible sample; neither is a byte-for-byte plan of a production allocation.',
    },
    wal: {
      name: 'Write-ahead log (WAL) district',
      anchor: 'walVault',
      represents:
        'The durability and change-stream pipeline: WAL records move from wal_buffers through walwriter into pg_wal, then completed segments may be archived while walsenders stream generated WAL independently.',
      contains: [
        'walwriter',
        'the pg_wal segment vault',
        'the archiver and its completed-segment path',
        'walsenders for physical replication',
        'a logical decoder and subscriber route',
      ],
      scaleMeaning:
        'The district is a pipeline stretched eastward so write, flush, archive and stream are distinguishable stages. Its length is not a WAL-retention or time scale.',
    },
    storage: {
      name: 'Storage underworld',
      anchor: 'dataDir',
      represents:
        'The layered path below volatile shared memory: the operating-system page cache, an explicit volatile/durable boundary, the PostgreSQL data directory and the storage device.',
      contains: [
        'the operating-system page-cache slab',
        'the volatile-memory/durable-storage boundary',
        'the data directory',
        'heap relations built from 8 KiB pages',
        'indexes, TOAST, free-space maps and visibility maps',
        'the disk array below the relation floor',
      ],
      scaleMeaning:
        'Its reserved footprint contains the central plaza footprint in plan and sits far below it, teaching that cached pages are an upper layer over durable files. The footprint ratio is not a database-to-RAM capacity ratio.',
    },
    maintenance: {
      name: 'Maintenance yard',
      anchor: 'checkpointer',
      represents:
        'PostgreSQL background work that acts on shared buffers and relation storage without being the foreground query path.',
      contains: [
        'the checkpointer',
        'the background writer',
        'the autovacuum launcher, worker depot and reclaim route',
        'the temporary dead-tuple teaching pile and free-space return route',
        'the logger and cumulative-statistics instruments',
      ],
      scaleMeaning:
        'The yard occupies a broad western flank because several independent maintenance processes reach into both the plaza and the data directory. Area does not encode worker cost or throughput.',
    },
    replication: {
      name: 'Physical replication and standby sites',
      anchor: 'standby',
      represents:
        'Two independently lagging physical standbys, each with received, written, flushed and replayed WAL positions and its own buffer and data-directory state.',
      contains: [
        'standby_a’s eastern apron, walreceiver, startup process, buffer deck and storage',
        'a read-only client approach to standby_a',
        'standby_b on a separate western failure-domain platform',
        'independent streaming and acknowledgement routes for both standbys',
      ],
      scaleMeaning:
        'Standby sites are separated platforms rather than small ornaments on the primary: replication preserves another node’s state and can lag or fail independently. The formal district footprint marks standby_a’s apron; standby_b deliberately occupies its own western site.',
    },
    planner: {
      name: 'Query lab',
      anchor: 'planner',
      represents:
        'The parse, rewrite, plan and execute stages of the statement owned by a selected backend.',
      contains: [
        'parse and rewrite instruments',
        'the planner and its plan tree',
        'executor nodes and backend-private work_mem teaching instruments',
      ],
      scaleMeaning:
        'The lab shares the backend row’s north/south position but floats high above it, teaching that planning and execution belong to each backend rather than to a central shared planner service.',
    },
    world: {
      name: 'City envelope and continuity quarter',
      anchor: 'cityCenter',
      represents:
        'The whole architecture plan, including the primary server site and the deliberately remote continuity works for archive, backup, recovery and high availability.',
      contains: [
        'the primary server boundary and all inner districts',
        'the eastern timeline switchyard and WAL-G object-storage estate',
        'the south-west recovery ground for point-in-time recovery and restore drills',
        'three Patroni/etcd failure-domain platforms and their leader-lease links',
        'the rejoin bay for pg_rewind or rebuild after an unplanned failover',
      ],
      scaleMeaning:
        'The 800 m by 800 m plan envelope provides a common coordinate frame. Long outer routes and separated platforms carry off-site and failure-domain meaning; they are not geographic, latency or recovery-time measurements.',
    },
  } satisfies Record<string, CityDistrictClaim>,
  relationships: [
    {
      id: 'connection-admission',
      from: 'clients',
      to: 'backends',
      placement:
        'The client terminal is north of the server fence. The drawn arrivals avenue crosses the PgBouncer and pg_hba.conf gate metaphors, reaches the postmaster, and then fans into the backend row.',
      why:
        'The real postmaster accepts the incoming connection and starts its child process; that child handles startup and authentication before becoming the session’s backend. The postmaster does not remain in the statement data path, so query and result traffic continue on the persistent client/backend connection. The gate’s position says “access policy at the boundary”, not “pg_hba.conf runs before the postmaster accepts”.',
      evidence: {
        routes: ['conn.in', 'fork.0', 'query.0', 'result.0'],
        anchors: ['clientTerminal', 'pooler', 'connGate', 'postmaster', 'postmasterDoor'],
      },
    },
    {
      id: 'backend-query-lab',
      from: 'backends',
      to: 'planner',
      placement:
        'The query lab occupies the same north/south band as the backend row but is elevated above it.',
      why:
        'Parse, rewrite, plan and execute are work performed for a statement by its backend. Raising the lab over the row keeps that ownership visible and avoids inventing a shared planner service beside shared memory.',
      evidence: {
        routes: [],
        anchors: ['planner'],
      },
    },
    {
      id: 'backend-shared-memory',
      from: 'backends',
      to: 'shmem',
      placement:
        'The backend row stands immediately north of the central shared-memory plaza, with request and return routes descending into the grid.',
      why:
        'Backend processes are independent, but they coordinate through shared structures and look up relation pages in the common buffer pool. The short repeated routes distinguish per-backend work from shared state.',
      evidence: {
        routes: ['buf.req.0', 'buf.ret.0', 'lock.wait.0', 'procarray.in', 'bufmap.in'],
        anchors: ['procArray', 'lockManager', 'bufferGrid'],
      },
    },
    {
      id: 'memory-over-storage',
      from: 'shmem',
      to: 'storage',
      placement:
        'The storage footprint lies directly below and around the central plaza; the operating-system cache is the intermediate underground slab.',
      why:
        'A shared-buffer miss descends through ordinary buffered file I/O, which may be satisfied by the operating-system page cache before reaching the device. Dirty shared buffers travel downward on the write path toward durable files.',
      evidence: {
        routes: ['io.read.0', 'io.read.cache.0', 'io.write.0'],
        anchors: ['bufferGrid', 'osCache', 'dataDir', 'diskArray'],
      },
    },
    {
      id: 'write-ahead-rule',
      from: 'shmem',
      to: 'wal',
      placement:
        'wal_buffers sits on the plaza’s eastern edge; walwriter and the WAL vault continue east, and the WAL fsync route then descends toward storage.',
      why:
        'WAL is written before the data pages it protects. That write-ahead rule is why the WAL vault sits between the buffer pool and storage in the write route: a commit can wait for WAL durability without waiting for the changed heap pages themselves.',
      evidence: {
        routes: ['wal.ins.0', 'wal.flush', 'wal.write', 'wal.fsync'],
        anchors: ['walBuffers', 'walWriter', 'walVault', 'diskArray'],
      },
    },
    {
      id: 'maintenance-flanks-data',
      from: 'maintenance',
      to: 'shmem',
      placement:
        'The maintenance yard mirrors the WAL district on the west side of the plaza and opens toward both shared memory and the storage excavation.',
      why:
        'The checkpointer and background writer clean shared buffers, while autovacuum visits relation and index storage. Keeping the yard beside both layers shows background work crossing them without placing it in the client’s foreground statement route.',
      evidence: {
        routes: ['ckpt.sweep', 'bgw.sweep', 'ckpt.fsync', 'vac.go.0', 'vac.back.0'],
        anchors: ['checkpointer', 'bgWriter', 'vacDepot', 'dataDir'],
      },
    },
    {
      id: 'streaming-replication',
      from: 'wal',
      to: 'replication',
      placement:
        'Walsenders leave the east side of the WAL vault; two cable runs travel south and split toward eastern standby_a and western standby_b.',
      why:
        'Physical standbys receive WAL as it is generated, write and flush it into their own pg_wal, and then replay it with their startup processes. Separate cables make the two lag and failure paths independent.',
      evidence: {
        routes: ['wal.stream', 'net.stream', 'net.streamB', 'replica.apply', 'replicaB.apply'],
        anchors: ['walSender', 'walReceiver', 'standbyBRecv', 'standby', 'standbyB'],
      },
    },
    {
      id: 'archive-leaves-primary',
      from: 'wal',
      to: 'world',
      placement:
        'The archiver stands east of the WAL vault. Its road crosses an ownership gate and continues farther east through the timeline yard into object storage.',
      why:
        'Archiving copies completed WAL segments out of the primary site; walsenders independently stream WAL as it is generated. The split prevents archive and replication from being taught as the same pipeline.',
      evidence: {
        routes: ['wal.archive', 'archive.ship'],
        anchors: ['walVault', 'archiver', 'archiveGate', 'timelineYard', 'objectStore'],
      },
    },
    {
      id: 'backup-is-not-replication',
      from: 'replication',
      to: 'world',
      placement:
        'A separate route runs from standby_a eastward into the base-backup prefix of the same object-storage estate used for archived WAL.',
      why:
        'WAL-G streams a physical base backup from a standby into object storage. A continuously changing standby is not a retained backup, and a base backup without the required archived WAL cannot provide point-in-time recovery; the two meet in storage but remain distinct evidence.',
      evidence: {
        routes: ['backup.push'],
        anchors: ['standby', 'backupVault', 'objectStore'],
      },
    },
    {
      id: 'remote-recovery',
      from: 'world',
      to: 'storage',
      placement:
        'The only restore road leaves the eastern object store, takes the long way around the city, and enters a separate recovery ground in the south-west.',
      why:
        'In this city plan, restore is performed onto an empty data directory on another host, not back into the live primary’s local storage. Base-backup objects are unpacked first; restore_command then fetches archived WAL for ordered replay to the recovery target.',
      evidence: {
        routes: ['restore.haul', 'restore.unpack', 'restore.replay', 'restore.apply'],
        anchors: ['objectStore', 'recoveryGate', 'recoveryPad', 'restoreWinch', 'recoveryReplay'],
      },
    },
    {
      id: 'ha-coordination',
      from: 'world',
      to: 'replication',
      placement:
        'The primary and both standbys occupy separate raised platforms. Each has a local Patroni process and etcd member; Raft links form a triangle between those platforms rather than meeting at a central building.',
      why:
        'The distributed configuration store carries leader coordination, never WAL. Co-locating one member with each failure domain makes quorum and lease ownership a separate network from physical replication and avoids inventing a fourth central machine.',
      evidence: {
        routes: ['ha.lease1', 'ha.lease2', 'ha.lease3', 'ha.raft12', 'ha.raft13', 'ha.raft23'],
        anchors: [
          'haPrimarySite',
          'haStandbyASite',
          'haStandbyBSite',
          'patroniNode1',
          'patroniNode2',
          'patroniNode3',
          'leaseNode1',
          'leaseNode2',
          'leaseNode3',
        ],
      },
    },
  ] satisfies readonly CityRelationshipClaim[],
} as const
