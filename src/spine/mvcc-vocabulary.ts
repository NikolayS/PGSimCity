export interface SemanticFacet {
  readonly meaning: string
  readonly allOf: readonly (readonly string[])[]
}

function vocabularyEntry<const Facets extends Record<string, SemanticFacet>>(entry: {
  readonly definition: string
  readonly facets: Facets
  readonly surfaces: Readonly<Record<string, readonly (keyof Facets & string)[]>>
}) {
  return entry
}

/*
 * Semantic anchors deliberately use several accepted phrasings. A short
 * tooltip and a long operational explanation need not share copy, but neither
 * may drop a load-bearing part of the owned definition.
 */
export const MVCC_VOCABULARY = {
  xmin: vocabularyEntry({
    definition: 'xmin identifies the transaction that inserted or created this tuple version. Visibility interprets xmin with transaction status and tuple hint bits.',
    facets: {
      createsVersion: {
        meaning: 'xmin identifies the creator of this physical row version',
        allOf: [['xmin'], ['insert', 'creat'], ['version', 'tuple']],
      },
      statusQualifies: {
        meaning: 'visibility also depends on transaction status or cached hint bits',
        allOf: [['visibility', 'visible', 'snapshot'], ['status', 'hint bit', 'hint bits']],
      },
    },
    surfaces: {
      'anatomy:t_xmin tooltip': ['createsVersion', 'statusQualifies'],
      'prose:memory row-version visibility': ['createsVersion', 'statusQualifies'],
      'prose:storage MVCC row versions': ['createsVersion', 'statusQualifies'],
    },
  }),
  xmax: vocabularyEntry({
    definition: 'xmax can identify a transaction or MultiXact that deletes, updates, or locks a tuple. A lock-only xmax does not delete it, so the tuple remains live after the locker commits; MultiXact members and tuple flags determine the effective meaning.',
    facets: {
      deletingOrUpdating: {
        meaning: 'xmax can record deletion or update of the version',
        allOf: [['xmax'], ['delet', 'updat', 'supersed']],
      },
      locking: {
        meaning: 'xmax can record a row lock as well',
        allOf: [['xmax'], ['lock']],
      },
      lockOnlyStaysLive: {
        meaning: 'a committed lock-only xmax does not make the tuple dead',
        allOf: [['lock-only', 'heap_xmax_lock_only'], ['remain live', 'remains live', 'does not delete', 'not enough']],
      },
      multiXactNeedsFlags: {
        meaning: 'MultiXact members and tuple flags qualify the raw field',
        allOf: [['multixact'], ['member'], ['flag']],
      },
    },
    surfaces: {
      'anatomy:t_xmax tooltip': ['deletingOrUpdating', 'locking'],
      'prose:memory row-version visibility': ['deletingOrUpdating', 'locking', 'lockOnlyStaysLive', 'multiXactNeedsFlags'],
      'prose:storage MVCC row versions': ['deletingOrUpdating', 'locking', 'lockOnlyStaysLive', 'multiXactNeedsFlags'],
      'prose:storage dead versus removable': ['deletingOrUpdating', 'locking', 'lockOnlyStaysLive', 'multiXactNeedsFlags'],
    },
  }),
  ctid: vocabularyEntry({
    definition: 'ctid is a physical heap address made from a block number and line-pointer slot. A tuple t_ctid normally names itself and can link an updated version to its replacement; indexes use the physical TID, and movement can change ctid even though page compaction preserves the stable slot.',
    facets: {
      physicalAddress: {
        meaning: 'ctid is a block plus line-pointer slot physical address',
        allOf: [['ctid', 't_ctid'], ['block'], ['slot', 'line pointer']],
      },
      updateLink: {
        meaning: 't_ctid can link an updated version to its replacement',
        allOf: [['ctid', 't_ctid'], ['updat'], ['replacement', 'new version', 'points at it']],
      },
      indexAnchor: {
        meaning: 'indexes use the physical heap TID or original line pointer',
        allOf: [['index'], ['ctid', 'tid', 'line pointer'], ['heap', 'physical', 'original', 'tuple bytes']],
      },
      movementLimit: {
        meaning: 'ctid is not a permanent logical identifier',
        allOf: [['move', 'compaction'], ['stable', 'until']],
      },
    },
    surfaces: {
      'anatomy:line-pointer tooltip': ['physicalAddress', 'indexAnchor', 'movementLimit'],
      'anatomy:t_ctid tooltip': ['physicalAddress', 'updateLink', 'indexAnchor'],
      'prose:storage page address': ['physicalAddress', 'movementLimit'],
      'prose:storage HOT chain': ['updateLink', 'indexAnchor'],
      'prose:storage index heap locator': ['indexAnchor'],
    },
  }),
  linePointers: vocabularyEntry({
    definition: 'A line pointer is a 4-byte ItemIdData page-slot entry for a tuple. Its stable indirection lets indexes retain a TID while tuple bytes move, and its normal, redirect, dead, and reusable states participate in HOT pruning and VACUUM cleanup.',
    facets: {
      pageSlots: {
        meaning: 'line pointers are tuple-slot entries in the page array',
        allOf: [['line pointer', 'itemiddata'], ['tuple'], ['slot', 'array']],
      },
      fourBytes: {
        meaning: 'each line pointer occupies four bytes',
        allOf: [['4-byte', '4 bytes', '32-bit'], ['line pointer', 'itemiddata']],
      },
      stableIndirection: {
        meaning: 'the slot anchors index TIDs while tuple bytes can move',
        allOf: [['line pointer', 'slot'], ['index', 'ctid'], ['redirect', 'stable', 'move']],
      },
      lifecycle: {
        meaning: 'dead or redirected slots become reusable only through cleanup',
        allOf: [['line pointer', 'slot'], ['dead', 'lp_dead'], ['reusable', 'free space', 'lp_unused', 'redirect']],
      },
    },
    surfaces: {
      'anatomy:line-pointer tooltip': ['pageSlots', 'fourBytes', 'stableIndirection'],
      'prose:storage page layout': ['pageSlots', 'fourBytes'],
      'prose:storage HOT pruning': ['stableIndirection', 'lifecycle'],
      'prose:storage VACUUM phases': ['lifecycle'],
    },
  }),
  tupleHeader: vocabularyEntry({
    definition: 'HeapTupleHeaderData has a 23-byte fixed portion containing xmin, xmax, command/transaction union data, t_ctid, infomasks, and t_hoff; an optional null bitmap and aligned user attributes follow.',
    facets: {
      fixedSize: {
        meaning: 'the heap tuple header has a 23-byte fixed portion',
        allOf: [['23-byte', '23 bytes'], ['header', 'heaptupleheaderdata']],
      },
      mvccFields: {
        meaning: 'the fixed header carries xmin and xmax',
        allOf: [['header'], ['xmin'], ['xmax']],
      },
      variableTail: {
        meaning: 'the optional bitmap, alignment, and user data follow the fixed portion',
        allOf: [['bitmap'], ['user', 'attribute'], ['align', 'padding', 't_hoff']],
      },
    },
    surfaces: {
      'anatomy:tuple-header tooltip': ['fixedSize', 'variableTail'],
      'prose:storage MVCC tuple header': ['fixedSize', 'mvccFields'],
    },
  }),
  hotChains: vocabularyEntry({
    definition: 'A HOT update keeps the replacement on the same heap page and avoids new ordinary-index tuple-pointer entries. t_ctid links the versions, pruning can redirect the original line pointer, and PostgreSQL 18 can still maintain a summarizing BRIN index without that changed column blocking HOT.',
    facets: {
      samePage: {
        meaning: 'the replacement version stays on the same heap page',
        allOf: [['hot', 'heap-only tuple'], ['same page', 'same heap page']],
      },
      noOrdinaryIndexEntry: {
        meaning: 'HOT avoids new ordinary-index tuple-pointer entries',
        allOf: [['hot'], ['ordinary index', 'ordinary-index'], ['no new', 'avoids new', 'avoids those new']],
      },
      ctidLink: {
        meaning: 't_ctid links the versions in the HOT chain',
        allOf: [['t_ctid'], ['chain', 'points at', 'replacement']],
      },
      pruningRedirect: {
        meaning: 'pruning can redirect the original index-referenced slot',
        allOf: [['prun'], ['redirect'], ['original line pointer', 'original index']],
      },
      summarizingIndexNuance: {
        meaning: 'summarizing indexes do not block HOT but may need maintenance',
        allOf: [['brin', 'summarizing'], ['maintain', 'maintenance', 'does not block', 'do not block']],
      },
    },
    surfaces: {
      'anatomy:t_ctid HOT link': ['samePage', 'ctidLink'],
      'anatomy:HOT redirect': ['pruningRedirect'],
      'prose:storage HOT chain': ['samePage', 'noOrdinaryIndexEntry', 'ctidLink', 'pruningRedirect', 'summarizingIndexNuance'],
      'scenario:bloat HOT explanation': ['samePage', 'noOrdinaryIndexEntry', 'summarizingIndexNuance'],
      'scenario:bloat HOT index effect': ['noOrdinaryIndexEntry', 'summarizingIndexNuance'],
    },
  }),
  tupleLiveness: vocabularyEntry({
    definition: 'A tuple becomes dead only when its effective deleting or updating XID commits; lock-only xmax leaves it live. Dead is not the same as removable because cleanup must also pass the visibility horizon. PostgreSQL n_live_tup and n_dead_tup are estimates, unlike the city model counters.',
    facets: {
      effectiveTerminator: {
        meaning: 'dead requires an effective committed deleting or updating XID',
        allOf: [['dead'], ['delet', 'updat', 'supersed'], ['commit']],
      },
      lockOnlyLive: {
        meaning: 'a lock-only xmax leaves the tuple live',
        allOf: [['lock-only', 'heap_xmax_lock_only'], ['live', 'does not delete']],
      },
      deadNotRemovable: {
        meaning: 'dead versions still wait for the removal horizon',
        allOf: [['dead'], ['remov', 'collect'], ['horizon', 'snapshot']],
      },
      statisticsAreEstimates: {
        meaning: 'PostgreSQL live/dead tuple counters are estimates',
        allOf: [['n_live_tup'], ['n_dead_tup'], ['estimate']],
      },
    },
    surfaces: {
      'anatomy:dead and removable explanation': ['effectiveTerminator', 'deadNotRemovable'],
      'prose:memory row-version visibility': ['lockOnlyLive'],
      'prose:storage MVCC row versions': ['effectiveTerminator', 'lockOnlyLive'],
      'prose:storage dead versus removable': ['effectiveTerminator', 'lockOnlyLive', 'deadNotRemovable'],
      'Diagnose:bloat tuple estimates': ['statisticsAreEstimates'],
      'Diagnose:catalog tuple estimates': ['statisticsAreEstimates'],
      'scenario:xmin dead versus removable': ['effectiveTerminator', 'deadNotRemovable'],
    },
  }),
  visibilityMap: vocabularyEntry({
    definition: 'The visibility map stores conservative all-visible and all-frozen bits per heap page. All-visible permits index-only scans to skip heap fetches; all-frozen permits VACUUM to skip freezing work. VACUUM sets the bits and page modification clears them.',
    facets: {
      twoBits: {
        meaning: 'the map stores all-visible and all-frozen per heap page',
        allOf: [['all-visible'], ['all-frozen'], ['heap page', 'per page']],
      },
      indexOnly: {
        meaning: 'all-visible enables index-only scans to avoid heap access',
        allOf: [['all-visible', 'visibility map'], ['index-only', 'index only'], ['skip', 'without touching', 'heap fetch', 'use all-visible']],
      },
      vacuum: {
        meaning: 'all-frozen lets VACUUM skip already-frozen pages',
        allOf: [['all-frozen'], ['vacuum'], ['skip', 'uses']],
      },
      clearing: {
        meaning: 'VACUUM sets the bits and page changes clear them',
        allOf: [['modification', 'write', 'update'], ['clear'], ['vacuum', 'copy']],
      },
    },
    surfaces: {
      'anatomy:visibility-map tooltip': ['twoBits', 'indexOnly', 'vacuum'],
      'prose:storage index-only scan': ['indexOnly'],
      'prose:storage visibility map': ['twoBits', 'indexOnly', 'vacuum', 'clearing'],
      'prose:memory EXPLAIN heap fetches': ['indexOnly'],
    },
  }),
  xminHorizon: vocabularyEntry({
    definition: 'The xmin horizon is a snapshot and removal cutoff, not the oldest visible creator. Active snapshots, assigned XIDs, prepared transactions, replication-slot xmins, and standby feedback can constrain it; a dead version is removable only after its deleting transaction commits and no relevant cutoff can still need it.',
    facets: {
      removalPurpose: {
        meaning: 'the horizon is a snapshot/removal cutoff',
        allOf: [['horizon'], ['snapshot'], ['remov', 'cleanup', 'reclaim']],
      },
      activeSnapshots: {
        meaning: 'active snapshot xmin values can constrain it',
        allOf: [['snapshot'], ['xmin']],
      },
      assignedXids: {
        meaning: 'assigned transaction XIDs can constrain it',
        allOf: [['assigned', 'backend_xid', 'backend xid'], ['xid']],
      },
      preparedTransactions: {
        meaning: 'prepared transactions can constrain it',
        allOf: [['prepared transaction', 'prepared xact', 'pg_prepared_xacts']],
      },
      slotsAndFeedback: {
        meaning: 'replication slots and standby feedback can constrain it',
        allOf: [['slot'], ['standby feedback', 'feedback']],
      },
      deadSafety: {
        meaning: 'committed-dead and removable are separate states',
        allOf: [['dead', 'delet'], ['commit'], ['remov', 'collect', 'reclaim']],
      },
    },
    surfaces: {
      'world:xmin-horizon label and tooltip': ['removalPurpose', 'activeSnapshots', 'preparedTransactions', 'slotsAndFeedback'],
      'anatomy:xmin-horizon tooltip': ['deadSafety'],
      'prose:memory xmin horizon': ['removalPurpose', 'activeSnapshots', 'assignedXids', 'preparedTransactions', 'slotsAndFeedback', 'deadSafety'],
      'Diagnose:xmin-horizon investigation': ['removalPurpose', 'activeSnapshots', 'assignedXids', 'preparedTransactions', 'slotsAndFeedback'],
      'scenario:xmin-horizon definition': ['removalPurpose', 'activeSnapshots', 'assignedXids', 'preparedTransactions', 'slotsAndFeedback', 'deadSafety'],
    },
  }),
  toastPointers: vocabularyEntry({
    definition: 'A large varlena datum can be replaced by an 18-byte pointer to chunks in a TOAST relation. The roughly 2 KiB default toast_tuple_target is a target, not a fixed threshold. Inline values need no TOAST fetch; an external value needs TOAST-index and chunk reads and is decompressed only when its stored representation is compressed.',
    facets: {
      externalPointer: {
        meaning: 'an out-of-line datum leaves an 18-byte TOAST pointer',
        allOf: [['18-byte'], ['pointer'], ['toast', 'chunk', 'out of line']],
      },
      targetNotThreshold: {
        meaning: 'the roughly 2 KiB default is a configurable target, not a fixed threshold',
        allOf: [['toast_tuple_target'], ['2 kib', 'roughly 2'], ['not a fixed', 'default tuple target']],
      },
      readPath: {
        meaning: 'inline, external, and compressed values have different read costs',
        allOf: [['inline'], ['out-of-line', 'external'], ['toast index', 'chunks'], ['decompress', 'compressed']],
      },
    },
    surfaces: {
      'anatomy:TOAST-pointer tooltip': ['externalPointer'],
      'prose:storage TOAST target': ['externalPointer', 'targetNotThreshold'],
      'prose:storage TOAST read path': ['readPath'],
    },
  }),
} as const

export type MvccVocabularyId = keyof typeof MVCC_VOCABULARY
