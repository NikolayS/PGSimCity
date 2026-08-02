/*
 * Cross-surface facts and conventions that have drifted before. Values live
 * here; the surface list is the contract exercised by test/claims-spine.test.ts.
 * Keep this list deliberately small and evidence-led.
 */

import { MACHINE_SYNCHRONOUS_COMMIT_COMPARISON } from '../spine/machine-comparison'
import { BUILD_LABEL } from './build'

const KIB = 1024
const MIB = KIB * KIB
const MODEL_MILLISECOND_UNIT = 'model ms'
const POSTGRESQL_MAJOR = 18
const POSTGRESQL_REFERENCE_MINOR = 3

const POSTGRESQL_VERSION = {
  major: POSTGRESQL_MAJOR,
  referenceMinor: POSTGRESQL_REFERENCE_MINOR,
  majorLabel: `PostgreSQL ${POSTGRESQL_MAJOR}`,
  referenceLabel: `PostgreSQL ${POSTGRESQL_MAJOR}.${POSTGRESQL_REFERENCE_MINOR}`,
  manualBase: `https://www.postgresql.org/docs/${POSTGRESQL_MAJOR}/`,
  sourceBranch: `REL_${POSTGRESQL_MAJOR}_STABLE`,
} as const

export const CLAIM_VALUES = {
  appVersion: {
    label: BUILD_LABEL,
  },
  walSegment: {
    bytes: 16 * MIB,
    label: '16 MiB',
  },
  bufferSample: {
    gridWidth: 32,
    capacityFrames: 32 * 32,
    defaultActiveFrames: 256,
  },
  bulkReadRing: {
    modelFrames: 32,
    disclosure: 'fixed 32-frame ring',
    diagnoseDisclosure: 'fixed 32-frame approximation',
  },
  checkpointPolicy: {
    defaultTimeoutSeconds: 60,
    defaultMaxWalSizeMiB: 256,
    partners: ['maxWalSize', 'checkpointTimeout'],
  },
  standbyNames: {
    internal: ['standbyA', 'standbyB'],
    display: ['standby_a', 'standby_b'],
  },
  modelDuration: {
    shortUnit: 'model s',
    millisecondUnit: MODEL_MILLISECOND_UNIT,
    prose: 'model time',
  },
  modelLatency: {
    unit: MODEL_MILLISECOND_UNIT,
    quantiles: ['p50', 'p99'],
    windowTrips: 512,
    disclosure: 'weighted rolling window of 512 completed backend trips',
    componentDisclosure: 'each modeled component is its own weighted quantile',
    taxonomyDisclosure: 'Buffer-read phase is the synthetic exec_io phase, not accumulated DataFileRead events; dirty-victim I/O is trip attribution rather than a distinct live activity state; temp-file I/O is attributed inside the fixed sort/hash-aggregate teaching phase rather than projected as live PostgreSQL wait events; commit durability is an umbrella for WalSync or SyncRep; relation lock maps directly to Lock/relation; active / unclassified is a non-wait residual containing CPU, parse, result-send and unclassified WAL-buffer stalls, which PostgreSQL reports separately as waits such as LWLock/WALWrite',
    batchDisclosure: 'transactions carried by one backend trip share one latency observation, so within-batch variance is not modeled',
    resolutionDisclosure: '30 Hz integration quantizes observations to 33.33 model ms steps',
  },
  workMem: {
    defaultMiB: 4,
    hashMemMultiplier: 2,
    hashMemMultiplierDefaultSince: 15,
    spillExample: {
      lowMiB: 2,
      highMiB: 4,
      partialHashWorkingSetMiB: 6,
      aggregateSortWorkingSetMiB: 3,
      finalizeHashWorkingSetMiB: 1,
    },
    spillSlowdown: 10,
    nodeDisclosure: 'work_mem is a per-node allowance, not a per-query or per-connection cap; eligible nodes and concurrent backends multiply it',
    coverageDisclosure: 'The city models fixed Sort and HashAggregate nodes only. It has no join nodes, hash-join spill, parallel workers, cost-based plan selection, or planner response to work_mem.',
  },
  restoreDrill: {
    levels: {
      table: {
        label: 'One-table smoke',
        rank: 1,
        cadence: 'nightly example',
        supports: 'The retained physical backup and WAL chain reached the target, the modeled PostgreSQL recovery startup completed, and the accounts smoke check found its modeled row witness.',
        limits: 'It does not test the other tables, compare every restored file with a manifest, prove every row is correct, or measure production hardware.',
      },
      cluster: {
        label: 'Full-cluster smoke',
        rank: 2,
        cadence: 'monthly example',
        supports: 'The retained physical backup and WAL chain reached the target, the modeled PostgreSQL recovery startup completed, and every modeled table returned its smoke-check row witness.',
        limits: 'It does not compare every restored file with a manifest, prove every row or business invariant is correct, or measure production hardware.',
      },
      verified: {
        label: 'Checksums + smoke',
        rank: 3,
        cadence: 'quarterly example',
        supports: 'The modeled full-cluster restore passed its manifest check and every modeled table returned its smoke-check row witness.',
        limits: 'It does not prove every row or business invariant is correct, exercise failover, or measure production hardware.',
      },
    },
    physicalScopeDisclosure: 'All three levels fetch and replay the full WAL-G physical backup. A genuinely selective table restore needs a separate logical archive such as pg_dump custom format for pg_restore --table; that archive is not modeled here.',
    checksumDisclosure: 'The checksum phase compares a deterministic modeled manifest digest; it does not hash real files. pg_verifybackup applies to a backup_manifest, while WAL-G backup-push --verify checks PostgreSQL page checksums when data checksums are enabled.',
    smokeDisclosure: 'The smoke phase checks row-witness bits captured from the modeled tables at backup time; it does not execute PostgreSQL or reconstruct every row.',
    timeDisclosure: 'RTO is model time at fixed teaching rates, not a forecast for production hardware.',
    cadenceDisclosure: 'Nightly, monthly, and quarterly are comparison examples, not recommendations. The operator must choose, fund, record, and review the cadence against the required recovery objectives.',
  },
  vacuumReclaim: {
    plateLines: [
      'space usually stays in the table',
      'only an empty tail can truncate',
    ],
    rule: 'Vacuum reuses space inside the table and can return only trailing empty pages to the filesystem.',
  },
  cityComponentRoute: {
    hashPrefix: '#/c/',
  },
  componentNaming: {
    panelTitleOwner: 'registry.name',
  },
  eventConvention: {
    emitterMethod: 'emit',
    handlerMethods: ['on', 'once'],
    browserPrefix: 'pgsimcity:',
  },
  diagnoseBranchGates: {
    connectionSpareSlots: {
      threshold: 1,
      source: 'activity.rows',
      branches: ['slow.1→v.saturation'],
    },
    lockWaitShare: {
      threshold: 0.25,
      source: 'activity.rows',
      branches: ['slow.1→lock.1'],
    },
    ioWaitShare: {
      threshold: 0.3,
      source: 'activity.rows',
      branches: ['slow.1→io.1'],
    },
    commitWaitShare: {
      threshold: 0.25,
      source: 'activity.rows',
      branches: ['slow.1→commit.1'],
    },
    walSyncWaitFloor: {
      threshold: 1,
      source: 'activity.rows',
      branches: ['commit.1→v.sync_local', 'commit.1→v.commit_ok'],
    },
    activeWorkFloor: {
      threshold: 3,
      source: 'activity.rows',
      branches: ['slow.1→v.idle'],
    },
    requestedCheckpointShare: {
      threshold: 0.2,
      source: 'checkpointer.counters',
      branches: ['stall.1→stall.2', 'stall.1→v.ckpt_ok'],
    },
    deadTupleRatio: {
      threshold: 0.02,
      source: 'tables.rows',
      branches: ['bloat.1→bloat.2', 'bloat.1→bloat.autovacuum', 'bloat.1→v.no_bloat'],
    },
    clientBackendWriteShare: {
      threshold: 0.2,
      source: 'io.rows',
      branches: ['io.1→v.backend_writes', 'io.1→v.io_ok'],
    },
    cacheHitPercent: {
      threshold: 92,
      source: 'io.rows',
      branches: ['io.1→io.2', 'io.1→v.io_ok'],
    },
    coldBufferShare: {
      threshold: 0.55,
      source: 'buffercache.rows',
      branches: ['io.2→v.small_pool', 'io.2→v.io_ok'],
    },
    replayStageGapBytes: {
      threshold: 256 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→v.replay', 'replica.1→v.rep_ok'],
    },
    senderStageGapBytes: {
      threshold: 512 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→v.network'],
    },
    currentPositionGapBytes: {
      threshold: 512 * KIB,
      source: 'replication.standbys',
      branches: ['replica.1→v.rep_ok'],
    },
    healthyReplaySeconds: {
      threshold: 2,
      source: 'replication.standbys',
      branches: [],
    },
    resolvedSenderGapBytes: {
      threshold: 256 * KIB,
      source: 'replication.standbys',
      branches: [],
    },
  },
  postgresqlVersion: POSTGRESQL_VERSION,
  markdownRendering: {
    owner: 'mdToHtml',
  },
  reviewStatus: {
    rounds: 4,
    summary: 'Four review rounds',
    bootLabel: 'Early, reviewed prototype.',
  },
} as const

export const CLAIMS = {
  appVersion: {
    owner: 'src/core/build.ts#BUILD_LABEL',
    value: CLAIM_VALUES.appVersion,
    surfaces: ['help:build marker', 'Diagnose:build marker', 'corrections:issue body'],
  },
  walSegment: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.walSegment',
    value: CLAIM_VALUES.walSegment,
    surfaces: ['model:wal.segmentSize', 'world:wal.vault plate', 'prose:WAL segment size'],
  },
  bufferSample: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.bufferSample',
    value: CLAIM_VALUES.bufferSample,
    surfaces: ['model:default active frames', 'world:shared_buffers plate', 'prose:sample disclosure'],
  },
  bulkReadRing: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.bulkReadRing',
    value: CLAIM_VALUES.bulkReadRing,
    surfaces: ['model:bulk-read ring', 'README:bulk-read disclosure', 'Diagnose:cache verdict'],
  },
  checkpointPolicy: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.checkpointPolicy',
    value: CLAIM_VALUES.checkpointPolicy,
    surfaces: ['model:knob defaults', 'controls:checkpoint dials', 'Diagnose:checkpoint controls'],
  },
  standbyNames: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.standbyNames',
    value: CLAIM_VALUES.standbyNames,
    surfaces: ['model:physical standbys', 'controls:synchronous standby choices', 'Diagnose:replication rows'],
  },
  modelDuration: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.modelDuration',
    value: CLAIM_VALUES.modelDuration,
    surfaces: ['shared:trace duration formatter', 'Query flow:duration readout', 'Diagnose:lock duration'],
  },
  modelLatency: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.modelLatency',
    value: CLAIM_VALUES.modelLatency,
    surfaces: ['model:latency quantiles', 'HUD:latency vital', 'prose:latency observability'],
  },
  workMem: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.workMem',
    value: CLAIM_VALUES.workMem,
    surfaces: ['model:Sort and HashAggregate spill', 'controls:work_mem dial', 'world:private memory and temp files', 'prose:work_mem limits'],
  },
  restoreDrill: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.restoreDrill',
    value: CLAIM_VALUES.restoreDrill,
    surfaces: ['model:restore-drill proof rank', 'inspector:restore-drill evidence', 'prose:restore-drill limits'],
  },
  vacuumReclaim: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.vacuumReclaim',
    value: CLAIM_VALUES.vacuumReclaim,
    surfaces: ['model:vacuum truncate phase', 'world:landfill plate', 'tour:vacuum chapter', 'prose:vacuum docs'],
  },
  cityComponentRoute: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.cityComponentRoute',
    value: CLAIM_VALUES.cityComponentRoute,
    surfaces: ['Diagnose:city links', 'tour:component targets', 'scenario:focus targets', 'city:component registry'],
  },
  componentNaming: {
    owner: 'src/core/registry.ts#ComponentDef.name',
    value: CLAIM_VALUES.componentNaming,
    surfaces: ['city:component registry names', 'inspector:panel headings'],
  },
  eventConvention: {
    owner: 'src/core/types.ts#BusEvents',
    value: CLAIM_VALUES.eventConvention,
    surfaces: ['source:event emitters', 'source:event handlers', 'browser:CustomEvent bridge'],
  },
  diagnoseBranchGates: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.diagnoseBranchGates',
    value: CLAIM_VALUES.diagnoseBranchGates,
    surfaces: ['Diagnose:result-grid warning ranges', 'Diagnose:path branch predicates', 'Diagnose:verdict resolution'],
  },
  postgresqlVersion: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.postgresqlVersion',
    value: CLAIM_VALUES.postgresqlVersion,
    surfaces: ['README:target declaration', 'Diagnose:catalog and prose', 'tour:version-specific claims', 'docs:manual and source links'],
  },
  markdownRendering: {
    owner: 'src/ui/content.ts#mdToHtml',
    value: CLAIM_VALUES.markdownRendering,
    surfaces: ['inspector:document body', 'tour:chapter body'],
  },
  reviewStatus: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.reviewStatus',
    value: CLAIM_VALUES.reviewStatus,
    surfaces: ['README:trust statement', 'index:boot honesty'],
  },
  machineSynchronousCommitComparison: {
    owner: 'src/spine/machine-comparison.ts#MACHINE_SYNCHRONOUS_COMMIT_COMPARISON',
    value: MACHINE_SYNCHRONOUS_COMMIT_COMPARISON,
    surfaces: [
      'model:off bypasses commit_wait',
      'Machine:comparison experiment',
      'Machine:comparison finding and P/M disclosure',
    ],
  },
} as const

export type ClaimId = keyof typeof CLAIMS
