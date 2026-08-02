/*
 * Cross-surface facts and conventions that have drifted before. Values live
 * here; the surface list is the contract exercised by test/claims-spine.test.ts.
 * Keep this list deliberately small and evidence-led.
 */

const KIB = 1024
const MIB = KIB * KIB

export const CLAIM_VALUES = {
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
    millisecondUnit: 'model ms',
    prose: 'model time',
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
  vacuumReclaim: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.vacuumReclaim',
    value: CLAIM_VALUES.vacuumReclaim,
    surfaces: ['model:vacuum truncate phase', 'world:landfill plate', 'tour:vacuum chapter', 'prose:vacuum docs'],
  },
  cityComponentRoute: {
    owner: 'src/core/claims.ts#CLAIM_VALUES.cityComponentRoute',
    value: CLAIM_VALUES.cityComponentRoute,
    surfaces: ['Diagnose:city links', 'city:hash consumer'],
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
} as const

export type ClaimId = keyof typeof CLAIMS
