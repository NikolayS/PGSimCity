import '../styles/anatomy.css'

import type { TableSim } from '../core/types'
import { clamp, fmtBytes, fmtNum, fmtPct } from '../core/util'
import { MODE_IDS, modeTokens } from './mode-exits'
import { el, icon, setText } from './uikit'
import type { UiContext, UiModule } from './uikit'

/* ============================================================================
 * PHYSICAL ANATOMY
 *
 * Two deliberately two-dimensional instruments: a byte-scaled heap page and a
 * navigable data-directory tree. The storage renderer owns the 3D metaphor;
 * this overlay owns exact offsets, readable labels and primary-source trails.
 *
 * The world exposes relation counters and real buffer block numbers, but not
 * tuple bytes for an individual block. The diagram therefore says exactly what
 * it is: a representative page whose occupancy/deadness follows the selected
 * relation, never a forensic decoder of bytes the simulation does not have.
 * ==========================================================================*/

type AnatomyView = 'page' | 'directory'

interface LinkRef {
  label: string
  url: string
}

interface RefSet {
  docs: LinkRef[]
  source: LinkRef[]
  suzuki: LinkRef[]
  /** Owner instruction: Rogov citations are text only, never links. */
  rogov: string[]
}

interface Detail {
  eyebrow: string
  title: string
  body: string[]
  refs: RefSet
}

const PAGE_BYTES = 8192
const PAGE_HEADER_BYTES = 24
const ITEM_ID_BYTES = 4
const TUPLE_HEADER_BYTES = 23

const DOC = {
  page: 'https://www.postgresql.org/docs/current/storage-page-layout.html',
  files: 'https://www.postgresql.org/docs/current/storage-file-layout.html',
  toast: 'https://www.postgresql.org/docs/current/storage-toast.html',
  fsm: 'https://www.postgresql.org/docs/current/storage-fsm.html',
  vm: 'https://www.postgresql.org/docs/current/storage-vm.html',
  hot: 'https://www.postgresql.org/docs/current/storage-hot.html',
} as const

const SRC = {
  bufpage: 'https://github.com/postgres/postgres/blob/master/src/include/storage/bufpage.h',
  itemid: 'https://github.com/postgres/postgres/blob/master/src/include/storage/itemid.h',
  tuple: 'https://github.com/postgres/postgres/blob/master/src/include/access/htup_details.h',
  pageCode: 'https://github.com/postgres/postgres/blob/master/src/backend/storage/page/bufpage.c',
  relpath: 'https://github.com/postgres/postgres/blob/master/src/include/common/relpath.h',
  md: 'https://github.com/postgres/postgres/blob/master/src/backend/storage/smgr/md.c',
  miscinit: 'https://github.com/postgres/postgres/blob/master/src/backend/utils/init/miscinit.c',
  guc: 'https://github.com/postgres/postgres/blob/master/src/backend/utils/misc/guc.c',
  hba: 'https://github.com/postgres/postgres/blob/master/src/backend/libpq/hba.c',
  xlog: 'https://github.com/postgres/postgres/blob/master/src/include/access/xlog_internal.h',
} as const

const SUZUKI = {
  directory: 'https://www.interdb.jp/pg/pgsql01/02.html',
  page: 'https://www.interdb.jp/pg/pgsql01/03.html',
  tuple: 'https://www.interdb.jp/pg/pgsql05/02.html',
  hot: 'https://www.interdb.jp/pg/pgsql07/01.html',
} as const

const PAGE_REFS: RefSet = {
  docs: [{ label: 'PostgreSQL manual · Database Page Layout', url: DOC.page }],
  source: [
    { label: 'bufpage.h · PageHeaderData', url: SRC.bufpage },
    { label: 'bufpage.c · page operations', url: SRC.pageCode },
  ],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.3, “Heap Table Structure”', url: SUZUKI.page }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Part I · Chapter 3, “Pages and Tuples”'],
}

const POINTER_REFS: RefSet = {
  docs: [
    { label: 'PostgreSQL manual · Database Page Layout', url: DOC.page },
    { label: 'PostgreSQL manual · Heap-Only Tuples (HOT)', url: DOC.hot },
  ],
  source: [
    { label: 'itemid.h · ItemIdData and LP_* states', url: SRC.itemid },
    { label: 'bufpage.c · line-pointer operations', url: SRC.pageCode },
  ],
  suzuki: [
    { label: 'Suzuki · Chapter 1 §1.3, “Heap Table Structure”', url: SUZUKI.page },
    { label: 'Suzuki · Chapter 7 §7.1, “Heap Only Tuple (HOT)”', url: SUZUKI.hot },
  ],
  rogov: [
    'Rogov, PostgreSQL 14 Internals · Part I · Chapter 3, “Pages and Tuples”',
    'Rogov, PostgreSQL 14 Internals · Part I · Chapter 5, “Page Pruning and HOT Updates”',
  ],
}

const TUPLE_REFS: RefSet = {
  docs: [{ label: 'PostgreSQL manual · Database Page Layout / Table Row Layout', url: DOC.page }],
  source: [{ label: 'htup_details.h · HeapTupleHeaderData', url: SRC.tuple }],
  suzuki: [{ label: 'Suzuki · Chapter 5 §5.2, “Tuple Structure”', url: SUZUKI.tuple }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Part I · Chapter 3 §3.2, “Row Version Layout”'],
}

const FREE_REFS: RefSet = {
  docs: [
    { label: 'PostgreSQL manual · Database Page Layout', url: DOC.page },
    { label: 'PostgreSQL manual · Free Space Map', url: DOC.fsm },
  ],
  source: [
    { label: 'bufpage.h · pd_lower / pd_upper', url: SRC.bufpage },
    { label: 'bufpage.c · PageGetFreeSpace', url: SRC.pageCode },
  ],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.3.1, “Internal Page Layout”', url: SUZUKI.page }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Part I · Chapter 3 §3.1, “Page Structure”'],
}

const DIRECTORY_REFS: RefSet = {
  docs: [{ label: 'PostgreSQL manual · Database File Layout', url: DOC.files }],
  source: [
    { label: 'relpath.h · database, tablespace and fork paths', url: SRC.relpath },
    { label: 'md.c · relation files and segments', url: SRC.md },
  ],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.2, “Physical Structure of Database Cluster”', url: SUZUKI.directory }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Introduction · “Data Organization” (Files and Forks)'],
}

const CONFIG_REFS: RefSet = {
  docs: [{ label: 'PostgreSQL manual · Database File Layout', url: DOC.files }],
  source: [
    { label: 'miscinit.c · data directory, PG_VERSION and lock file', url: SRC.miscinit },
    { label: 'guc.c · configuration loading', url: SRC.guc },
    { label: 'hba.c · client authentication file', url: SRC.hba },
  ],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.2.1, “Layout of a Database Cluster”', url: SUZUKI.directory }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Introduction · “Data Organization”'],
}

const WAL_REFS: RefSet = {
  docs: [{ label: 'PostgreSQL manual · Database File Layout', url: DOC.files }],
  source: [{ label: 'xlog_internal.h · XLOGDIR and WAL file paths', url: SRC.xlog }],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.2.1, “Layout of a Database Cluster”', url: SUZUKI.directory }],
  rogov: ['Rogov, PostgreSQL 14 Internals · Part II · Chapter 10, “Write-Ahead Log”'],
}

const RELATION_REFS: RefSet = {
  docs: [
    { label: 'PostgreSQL manual · Database File Layout', url: DOC.files },
    { label: 'PostgreSQL manual · Free Space Map', url: DOC.fsm },
    { label: 'PostgreSQL manual · Visibility Map', url: DOC.vm },
    { label: 'PostgreSQL manual · TOAST', url: DOC.toast },
  ],
  source: [
    { label: 'relpath.h · fork names and relation paths', url: SRC.relpath },
    { label: 'md.c · 1 GiB relation segments', url: SRC.md },
  ],
  suzuki: [{ label: 'Suzuki · Chapter 1 §1.2.3, “Files Associated with Tables and Indexes”', url: SUZUKI.directory }],
  rogov: [
    'Rogov, PostgreSQL 14 Internals · Introduction · “Data Organization” (Relations, Files and Forks)',
    'Rogov, PostgreSQL 14 Internals · Part I · Chapter 3, “Pages and Tuples”',
  ],
}

const PAGE_DETAILS: Record<string, Detail> = {
  overview: {
    eyebrow: '8,192 bytes · one slotted page',
    title: 'The page fills from both ends',
    body: [
      'The 24-byte header and 4-byte line pointers advance from byte 0. Tuple bodies are allocated backward from byte 8192. The untouched interval between pd_lower and pd_upper is free space.',
      'The long strip is byte-scaled. The larger cards below it are readable controls, not a second scale.',
    ],
    refs: PAGE_REFS,
  },
  header: {
    eyebrow: 'bytes 0…23 · 24 bytes',
    title: 'PageHeaderData',
    body: [
      'The common page header records the page LSN, checksum and flags, then the three offsets that divide occupied and free space. pd_pagesize_version cross-checks the page size/layout version; pd_prune_xid is a pruning hint.',
    ],
    refs: PAGE_REFS,
  },
  pd_lsn: {
    eyebrow: 'PageHeaderData · 8 bytes',
    title: 'pd_lsn',
    body: ['PageXLogRecPtr. The LSN immediately after the WAL record for the most recent change to this page. WAL-before-data ordering compares against this value.'],
    refs: PAGE_REFS,
  },
  pd_checksum: {
    eyebrow: 'PageHeaderData · uint16 · 2 bytes',
    title: 'pd_checksum',
    body: ['The page checksum when data checksums are enabled. It helps detect a damaged page; it is not an MVCC or WAL field.'],
    refs: PAGE_REFS,
  },
  pd_flags: {
    eyebrow: 'PageHeaderData · uint16 · 2 bytes',
    title: 'pd_flags',
    body: ['Page-level flag bits. Current definitions include hints such as PD_HAS_FREE_LINES, PD_PAGE_FULL and PD_ALL_VISIBLE.'],
    refs: PAGE_REFS,
  },
  pd_lower: {
    eyebrow: 'PageHeaderData · LocationIndex · 2 bytes',
    title: 'pd_lower',
    body: ['Byte offset to the start of free space: immediately after the last allocated ItemIdData. Adding a new line pointer moves this boundary forward.'],
    refs: FREE_REFS,
  },
  pd_upper: {
    eyebrow: 'PageHeaderData · LocationIndex · 2 bytes',
    title: 'pd_upper',
    body: ['Byte offset to the end of free space and the start of tuple storage. Allocating a tuple moves this boundary backward.'],
    refs: FREE_REFS,
  },
  pd_special: {
    eyebrow: 'PageHeaderData · LocationIndex · 2 bytes',
    title: 'pd_special',
    body: ['Byte offset to access-method special space. On a heap page it equals the page size, so special space is zero bytes.'],
    refs: PAGE_REFS,
  },
  pd_pagesize_version: {
    eyebrow: 'PageHeaderData · uint16 · 2 bytes',
    title: 'pd_pagesize_version',
    body: ['Packs the compiled page size and page-layout version into one field. PostgreSQL does not mix different page sizes in one installation.'],
    refs: PAGE_REFS,
  },
  pd_prune_xid: {
    eyebrow: 'PageHeaderData · TransactionId · 4 bytes',
    title: 'pd_prune_xid',
    body: ['The oldest XMAX that may make pruning profitable, or zero. It is a hint used to avoid pointless pruning work, not a visibility verdict.'],
    refs: POINTER_REFS,
  },
  pointers: {
    eyebrow: '4 bytes per slot · grows forward →',
    title: 'ItemIdData[] · line pointers',
    body: [
      'Each 32-bit entry packs lp_off (15 bits), lp_flags (2 bits) and lp_len (15 bits). A CTID names a block plus this stable slot number, so tuple bytes may move during compaction without changing index entries.',
      'The status colours below are structural states. The representative distribution follows relation bloat, but the simulation does not expose exact per-block slot bits.',
    ],
    refs: POINTER_REFS,
  },
  lp_off: {
    eyebrow: 'ItemIdData · 15-bit field',
    title: 'lp_off',
    body: ['Offset from the beginning of the page to the tuple body. For LP_REDIRECT it stores the target offset number instead.'],
    refs: POINTER_REFS,
  },
  lp_len: {
    eyebrow: 'ItemIdData · 15-bit field',
    title: 'lp_len',
    body: ['Byte length of a normal tuple. LP_UNUSED and LP_REDIRECT entries have zero length; LP_DEAD may or may not still have storage.'],
    refs: POINTER_REFS,
  },
  lp_flags: {
    eyebrow: 'ItemIdData · 2-bit field',
    title: 'lp_flags',
    body: ['Two bits encode exactly four states: LP_UNUSED, LP_NORMAL, LP_REDIRECT and LP_DEAD. The state controls how lp_off and lp_len are interpreted.'],
    refs: POINTER_REFS,
  },
  lp_unused: {
    eyebrow: 'lp_flags = 0',
    title: 'LP_UNUSED',
    body: ['A reusable slot with lp_len = 0. It does not identify a tuple.'],
    refs: POINTER_REFS,
  },
  lp_normal: {
    eyebrow: 'lp_flags = 1',
    title: 'LP_NORMAL',
    body: ['A normal item pointer: lp_off is the tuple byte offset and lp_len is greater than zero.'],
    refs: POINTER_REFS,
  },
  lp_redirect: {
    eyebrow: 'lp_flags = 2',
    title: 'LP_REDIRECT',
    body: [
      'A HOT redirect with lp_len = 0. After pruning removes the root tuple body, the original index-referenced slot can redirect to the oldest remaining tuple in the HOT chain.',
    ],
    refs: POINTER_REFS,
  },
  lp_dead: {
    eyebrow: 'lp_flags = 3',
    title: 'LP_DEAD',
    body: ['A dead slot that may still have storage. Index cleanup must account for references before VACUUM can turn it into a reusable LP_UNUSED slot.'],
    refs: POINTER_REFS,
  },
  free: {
    eyebrow: 'pd_lower … pd_upper',
    title: 'Free space',
    body: [
      'This exact interval is available for new line pointers and tuple bodies. The relation’s _fsm fork records a lossy per-page measure of available space so an insert can find a page without scanning the heap.',
    ],
    refs: FREE_REFS,
  },
  tuples: {
    eyebrow: 'allocated from pd_upper · grows backward ←',
    title: 'Heap tuple bodies',
    body: [
      'Tuple storage is allocated from the high-address end toward the line pointers. Dead versions remain physical tuple bodies until pruning or VACUUM can reclaim them; that is why a bloated relation paints red here as well as in the slot array.',
    ],
    refs: TUPLE_REFS,
  },
  special: {
    eyebrow: 'pd_special = 8192 · 0 bytes on heap',
    title: 'Special space',
    body: ['A heap page reserves no special bytes. Index access methods can: a B-tree page stores opaque data here, including left/right sibling links and page flags.'],
    refs: PAGE_REFS,
  },
  tuple: {
    eyebrow: 'opened row version · 23-byte fixed header',
    title: 'HeapTupleHeaderData',
    body: [
      'The first 23 bytes are fixed. An optional null bitmap starts at t_bits, padding advances to the MAXALIGN t_hoff boundary, and user attributes follow. The displayed values are an explicit HOT teaching example, not decoded application data.',
    ],
    refs: TUPLE_REFS,
  },
  t_xmin: {
    eyebrow: 'HeapTupleFields · TransactionId · 4 bytes',
    title: 't_xmin',
    body: ['The inserting transaction ID, physically at t_choice.t_heap.t_xmin. Visibility checks interpret it together with hint bits and transaction status.'],
    refs: TUPLE_REFS,
  },
  t_xmax: {
    eyebrow: 'HeapTupleFields · TransactionId · 4 bytes',
    title: 't_xmax',
    body: ['The deleting or locking transaction ID, physically at t_choice.t_heap.t_xmax. Zero/invalid means there is no effective deleting or locking XID.'],
    refs: TUPLE_REFS,
  },
  t_cid: {
    eyebrow: 'HeapTupleFields.t_field3 · 4 bytes shared',
    title: 't_cid / t_xvac',
    body: ['The physical third word overlays a CommandId (t_cid) with the legacy VACUUM FULL TransactionId (t_xvac). It is one 4-byte union, not two adjacent fields.'],
    refs: TUPLE_REFS,
  },
  t_ctid: {
    eyebrow: 'HeapTupleHeaderData · ItemPointerData · 6 bytes',
    title: 't_ctid',
    body: [
      'Normally this is the tuple’s own (block, slot) TID. After UPDATE it can point to the replacement row version. When that replacement stays on the same page and no indexed value requires a new index entry, following these links is the physical HOT chain.',
    ],
    refs: POINTER_REFS,
  },
  t_infomask2: {
    eyebrow: 'HeapTupleHeaderData · uint16 · 2 bytes',
    title: 't_infomask2',
    body: ['Stores the attribute count plus flags including HEAP_HOT_UPDATED and HEAP_ONLY_TUPLE.'],
    refs: TUPLE_REFS,
  },
  t_infomask: {
    eyebrow: 'HeapTupleHeaderData · uint16 · 2 bytes',
    title: 't_infomask',
    body: ['Tuple state and visibility hint bits, including HEAP_HASNULL and cached xmin/xmax status. The bits qualify how the transaction fields must be interpreted.'],
    refs: TUPLE_REFS,
  },
  t_hoff: {
    eyebrow: 'HeapTupleHeaderData · uint8 · 1 byte',
    title: 't_hoff',
    body: ['Offset from the tuple start to user data. It includes the fixed header, optional null bitmap, optional legacy OID and alignment padding, and is MAXALIGN-aligned.'],
    refs: TUPLE_REFS,
  },
  null_bitmap: {
    eyebrow: 't_bits[] · optional · 1 bit per attribute',
    title: 'Null bitmap',
    body: ['Present only when HEAP_HASNULL is set. One means not null; zero means null. Its required bit count comes from the attribute count in t_infomask2.'],
    refs: TUPLE_REFS,
  },
  user_data: {
    eyebrow: 'begins at byte t_hoff',
    title: 'User data',
    body: ['Column datums follow alignment and length rules from pg_attribute. Large varlena values can be compressed or replaced by an 18-byte pointer to chunks in a TOAST relation.'],
    refs: {
      ...TUPLE_REFS,
      docs: [...TUPLE_REFS.docs, { label: 'PostgreSQL manual · TOAST', url: DOC.toast }],
    },
  },
}

interface DirectoryItem {
  key: string
  label: string
  kind: 'dir' | 'file' | 'link' | 'relation'
  depth: number
  note?: string
}

const DIRECTORY_ITEMS: DirectoryItem[] = [
  { key: 'datadir', label: 'data directory/', kind: 'dir', depth: 0, note: 'cluster storage root' },
  { key: 'pg_version', label: 'PG_VERSION', kind: 'file', depth: 1 },
  { key: 'base', label: 'base/', kind: 'dir', depth: 1 },
  { key: 'database_oid', label: '16384/', kind: 'dir', depth: 2, note: 'database OID · illustrative' },
  { key: 'main_fork', label: '12345', kind: 'relation', depth: 3, note: 'main fork · filenode' },
  { key: 'segments', label: '12345.1 · 12345.2', kind: 'relation', depth: 3, note: '1 GiB segments' },
  { key: 'fsm_fork', label: '12345_fsm', kind: 'relation', depth: 3, note: 'free space map' },
  { key: 'vm_fork', label: '12345_vm', kind: 'relation', depth: 3, note: 'visibility map' },
  { key: 'global', label: 'global/', kind: 'dir', depth: 1 },
  { key: 'pg_wal', label: 'pg_wal/', kind: 'dir', depth: 1 },
  { key: 'pg_xact', label: 'pg_xact/', kind: 'dir', depth: 1 },
  { key: 'pg_multixact', label: 'pg_multixact/', kind: 'dir', depth: 1 },
  { key: 'pg_subtrans', label: 'pg_subtrans/', kind: 'dir', depth: 1 },
  { key: 'pg_tblspc', label: 'pg_tblspc/', kind: 'link', depth: 1 },
  { key: 'pg_stat', label: 'pg_stat/', kind: 'dir', depth: 1 },
  { key: 'pg_stat_tmp', label: 'pg_stat_tmp/', kind: 'dir', depth: 1 },
  { key: 'pg_logical', label: 'pg_logical/', kind: 'dir', depth: 1 },
  { key: 'pg_replslot', label: 'pg_replslot/', kind: 'dir', depth: 1 },
  { key: 'pg_twophase', label: 'pg_twophase/', kind: 'dir', depth: 1 },
  { key: 'postgresql_conf', label: 'postgresql.conf', kind: 'file', depth: 1, note: 'traditional location' },
  { key: 'pg_hba_conf', label: 'pg_hba.conf', kind: 'file', depth: 1, note: 'traditional location' },
  { key: 'postmaster_pid', label: 'postmaster.pid', kind: 'file', depth: 1, note: 'while server runs' },
]

const DIRECTORY_DETAILS: Record<string, Detail> = {
  datadir: {
    eyebrow: 'one database cluster · physical storage root',
    title: 'The data directory',
    body: [
      'This directory holds the cluster’s durable state. PGDATA is an environment variable used to help locate a cluster; it is not the name of the structure. Configuration files may be elsewhere, and the data_directory setting can select a different storage location.',
      'This is a focused map of the requested entries. A current cluster also contains other state directories and files documented by the server version.',
    ],
    refs: DIRECTORY_REFS,
  },
  pg_version: {
    eyebrow: 'control file · text',
    title: 'PG_VERSION',
    body: ['Contains the PostgreSQL major version. Server startup validates it before treating the directory as a compatible cluster.'],
    refs: CONFIG_REFS,
  },
  base: {
    eyebrow: 'default tablespace',
    title: 'base/',
    body: ['Contains one subdirectory per database in the default tablespace. The directory name is the database OID from pg_database.'],
    refs: DIRECTORY_REFS,
  },
  database_oid: {
    eyebrow: 'base/<database_oid>/',
    title: 'Per-database OID directory',
    body: ['16384 is illustrative. The real directory name is the database OID, and it contains that database’s system catalogs plus relation files in the default tablespace.'],
    refs: DIRECTORY_REFS,
  },
  main_fork: {
    eyebrow: 'base/16384/12345 · illustrative names',
    title: 'Main relation fork',
    body: [
      '12345 is a filenode number, represented in pg_class.relfilenode for ordinary relations. It is not reliably the relation OID: TRUNCATE, REINDEX, CLUSTER and some ALTER TABLE operations can preserve the OID while changing the filenode.',
      'pg_relation_filepath() is the safe way to ask PostgreSQL for the first main-fork segment path.',
    ],
    refs: RELATION_REFS,
  },
  segments: {
    eyebrow: 'filenode.N',
    title: '1 GiB segment split',
    body: ['By default, a relation larger than 1 GiB continues in 12345.1, then 12345.2, and so on. The build-time --with-segsize option can change that segment size.'],
    refs: RELATION_REFS,
  },
  fsm_fork: {
    eyebrow: 'relation fork · suffix _fsm',
    title: 'Free space map',
    body: ['A tree of lossy free-space measurements used to find a page with room. Heap and most index relations have an FSM; it is separate from their main data fork.'],
    refs: {
      ...RELATION_REFS,
      docs: [{ label: 'PostgreSQL manual · Free Space Map', url: DOC.fsm }, ...RELATION_REFS.docs],
    },
  },
  vm_fork: {
    eyebrow: 'heap-only relation fork · suffix _vm',
    title: 'Visibility map',
    body: ['Stores two conservative bits per heap page: all-visible and all-frozen. Index-only scans use all-visible; VACUUM uses both. Index relations do not have visibility maps.'],
    refs: {
      ...RELATION_REFS,
      docs: [{ label: 'PostgreSQL manual · Visibility Map', url: DOC.vm }, ...RELATION_REFS.docs],
    },
  },
  global: {
    eyebrow: 'cluster-wide tablespace',
    title: 'global/',
    body: ['Holds cluster-wide relations shared by every database, including catalogs such as pg_database.'],
    refs: DIRECTORY_REFS,
  },
  pg_wal: {
    eyebrow: 'write-ahead log storage',
    title: 'pg_wal/',
    body: ['Contains WAL segment files plus archive-status state. WAL makes changes replayable and must reach durable storage before the corresponding dirty data page may be written.'],
    refs: WAL_REFS,
  },
  pg_xact: {
    eyebrow: 'transaction status · SLRU files',
    title: 'pg_xact/',
    body: ['Stores transaction commit status: in progress, committed or aborted. It was named pg_clog before PostgreSQL 10.'],
    refs: DIRECTORY_REFS,
  },
  pg_multixact: {
    eyebrow: 'shared row-lock state',
    title: 'pg_multixact/',
    body: ['Stores multitransaction status and member data, used when multiple transactions hold row locks on the same tuple.'],
    refs: DIRECTORY_REFS,
  },
  pg_subtrans: {
    eyebrow: 'subtransaction parent map',
    title: 'pg_subtrans/',
    body: ['Stores subtransaction status used to find the top-level parent transaction for nested subtransactions.'],
    refs: DIRECTORY_REFS,
  },
  pg_tblspc: {
    eyebrow: 'symbolic links · names are tablespace OIDs',
    title: 'pg_tblspc/',
    body: ['Contains symbolic links to user-defined tablespace locations outside the data directory. Each link is named for its tablespace OID.'],
    refs: DIRECTORY_REFS,
  },
  pg_stat: {
    eyebrow: 'statistics subsystem · permanent files',
    title: 'pg_stat/',
    body: ['Holds permanent files used by the statistics subsystem. It is distinct from the temporary-statistics directory.'],
    refs: DIRECTORY_REFS,
  },
  pg_stat_tmp: {
    eyebrow: 'statistics subsystem · temporary files',
    title: 'pg_stat_tmp/',
    body: ['Holds temporary files used by the statistics subsystem.'],
    refs: DIRECTORY_REFS,
  },
  pg_logical: {
    eyebrow: 'logical decoding state',
    title: 'pg_logical/',
    body: ['Stores status data used by logical decoding, including mapping and snapshot state.'],
    refs: DIRECTORY_REFS,
  },
  pg_replslot: {
    eyebrow: 'replication slot persistence',
    title: 'pg_replslot/',
    body: ['Stores persistent state for physical and logical replication slots so required WAL or catalog state is retained across restart.'],
    refs: DIRECTORY_REFS,
  },
  pg_twophase: {
    eyebrow: 'prepared transactions',
    title: 'pg_twophase/',
    body: ['Contains state files for transactions prepared with two-phase commit until COMMIT PREPARED or ROLLBACK PREPARED resolves them.'],
    refs: DIRECTORY_REFS,
  },
  postgresql_conf: {
    eyebrow: 'configuration · traditional location',
    title: 'postgresql.conf',
    body: ['The main server configuration file is traditionally stored here, but PostgreSQL permits configuration files to live elsewhere. Its presence is not what defines the data directory.'],
    refs: CONFIG_REFS,
  },
  pg_hba_conf: {
    eyebrow: 'client authentication · traditional location',
    title: 'pg_hba.conf',
    body: ['Controls host-based client authentication. Like postgresql.conf, it is traditionally colocated but can be configured at another path.'],
    refs: CONFIG_REFS,
  },
  postmaster_pid: {
    eyebrow: 'directory lock file · only while running',
    title: 'postmaster.pid',
    body: ['Records the postmaster PID and startup metadata, including the cluster data-directory path, port and shared-memory information. It is removed after a clean shutdown.'],
    refs: CONFIG_REFS,
  },
}

interface PageSnapshot {
  table: TableSim
  tableIndex: number
  block: number
  resident: boolean
  linePointers: number
  pointerBytes: number
  tupleBytes: number
  freeBytes: number
  pdLower: number
  pdUpper: number
  deadPointers: number
  redirectPointers: number
  unusedPointers: number
  normalPointers: number
  deadTuples: number
  allVisible: boolean
  tupleBytesEach: number
}

function link(ref: LinkRef): HTMLAnchorElement {
  return el('a', {
    href: ref.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    text: ref.label,
  })
}

function referenceGroup(label: string, refs: LinkRef[]): HTMLElement {
  return el(
    'div',
    { class: 'an-refs__group' },
    el('span', { class: 'an-refs__kind', text: label }),
    el('div', { class: 'an-refs__links' }, ...refs.map(link)),
  )
}

function renderDetail(host: HTMLElement, detail: Detail): void {
  host.replaceChildren(
    el('div', { class: 'an-detail__eyebrow', text: detail.eyebrow }),
    el('h3', { class: 'an-detail__title', text: detail.title }),
    ...detail.body.map((paragraph) => el('p', { text: paragraph })),
    el(
      'div',
      { class: 'an-refs' },
      el('div', { class: 'an-refs__head', text: 'Follow it to the source' }),
      referenceGroup('Documentation', detail.refs.docs),
      referenceGroup('PostgreSQL source', detail.refs.source),
      referenceGroup('Suzuki', detail.refs.suzuki),
      el(
        'div',
        { class: 'an-refs__group' },
        el('span', { class: 'an-refs__kind', text: 'Rogov · text only' }),
        el(
          'div',
          { class: 'an-refs__links an-refs__links--text' },
          ...detail.refs.rogov.map((text) => el('span', { text })),
        ),
      ),
    ),
  )
}

function anatomyHash(): AnatomyView | null {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const value = params.get('anatomy')
  if (value === 'page') return 'page'
  if (value === 'directory' || value === 'data-directory') return 'directory'
  return null
}

function setHash(view: AnatomyView | null, replace: boolean): void {
  const url = `${window.location.pathname}${window.location.search}${view ? `#anatomy=${view}` : ''}`
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
}

function fieldButton(key: string, label: string, value: string): HTMLButtonElement {
  return el(
    'button',
    {
      class: 'an-field',
      type: 'button',
      data: { explain: key },
      ariaLabel: `Explain ${label}`,
    },
    el('span', { class: 'an-field__name pg-mono', text: label }),
    el('span', { class: 'an-field__value pg-mono', text: value }),
  )
}

function regionCard(key: string, label: string, hint: string, cls: string): HTMLButtonElement {
  return el(
    'button',
    {
      class: `an-region-card ${cls}`,
      type: 'button',
      data: { explain: key },
    },
    el('span', { class: 'an-region-card__name', text: label }),
    el('span', { class: 'an-region-card__hint pg-mono', text: hint }),
  )
}

function stat(label: string): { root: HTMLElement; value: HTMLElement } {
  const value = el('strong', { class: 'pg-mono', text: '—' })
  return {
    root: el('div', { class: 'an-live__stat' }, el('span', { text: label }), value),
    value,
  }
}

function makePageView(): {
  root: HTMLElement
  detail: HTMLElement
  tableName: HTMLElement
  block: HTMLElement
  provenance: HTMLElement
  live: Record<string, HTMLElement>
  track: HTMLElement
  headerRegion: HTMLElement
  pointerRegion: HTMLElement
  freeRegion: HTMLElement
  tupleRegion: HTMLElement
  lowerTick: HTMLElement
  upperTick: HTMLElement
  cards: Record<string, HTMLElement>
  pointerGrid: HTMLElement
  pointerSummary: HTMLElement
  tupleValues: Record<string, HTMLElement>
} {
  const detail = el('aside', { class: 'an-detail pg-scroll', ariaLive: 'polite' })
  const tableName = el('strong', { class: 'an-live__relation pg-mono', text: 'sessions' })
  const block = el('span', { class: 'an-live__block pg-mono', text: 'block 0' })
  const provenance = el('span', { class: 'an-live__provenance', text: 'representative relation page' })

  const liveStats = {
    live: stat('live tuples'),
    dead: stat('dead tuples'),
    bloat: stat('relation bloat'),
    free: stat('page free'),
    vm: stat('VM signal'),
  }

  const headerRegion = el('button', {
    class: 'an-byte-region an-byte-region--header',
    type: 'button',
    data: { explain: 'header' },
    ariaLabel: 'PageHeaderData, bytes 0 through 23',
  })
  const pointerRegion = el('button', {
    class: 'an-byte-region an-byte-region--pointers',
    type: 'button',
    data: { explain: 'pointers' },
    ariaLabel: 'Line pointer array',
  })
  const freeRegion = el('button', {
    class: 'an-byte-region an-byte-region--free',
    type: 'button',
    data: { explain: 'free' },
    ariaLabel: 'Free space between pd_lower and pd_upper',
  })
  const tupleRegion = el('div', {
    class: 'an-byte-region an-byte-region--tuples',
    role: 'group',
    ariaLabel: 'Heap tuples growing backward from byte 8192',
    data: { explain: 'tuples' },
  })
  const specialMarker = el('button', {
    class: 'an-special-marker',
    type: 'button',
    data: { explain: 'special' },
    ariaLabel: 'Special space, zero bytes on a heap page',
  })

  const track = el(
    'div',
    { class: 'an-byte-track', ariaLabel: 'Byte-scaled 8192-byte PostgreSQL heap page' },
    headerRegion,
    pointerRegion,
    freeRegion,
    tupleRegion,
    specialMarker,
  )
  const lowerTick = el('span', { class: 'an-axis__tick an-axis__tick--lower pg-mono', text: 'pd_lower' })
  const upperTick = el('span', { class: 'an-axis__tick an-axis__tick--upper pg-mono', text: 'pd_upper' })

  const cards = {
    header: regionCard('header', 'PageHeaderData', '24 B · 0…23', 'is-header'),
    pointers: regionCard('pointers', 'Line pointers', 'ItemIdData[] · 4 B each', 'is-pointers'),
    free: regionCard('free', 'Free space', 'pd_lower…pd_upper', 'is-free'),
    tuples: regionCard('tuples', 'Heap tuples', 'grow backward from 8192', 'is-tuples'),
    special: regionCard('special', 'Special', '0 B on heap', 'is-special'),
  }

  const headerFields = el(
    'div',
    { class: 'an-fields' },
    fieldButton('pd_lsn', 'pd_lsn', '8 B'),
    fieldButton('pd_checksum', 'pd_checksum', '2 B'),
    fieldButton('pd_flags', 'pd_flags', '2 B'),
    fieldButton('pd_lower', 'pd_lower', '2 B'),
    fieldButton('pd_upper', 'pd_upper', '2 B'),
    fieldButton('pd_special', 'pd_special', '2 B'),
    fieldButton('pd_pagesize_version', 'pd_pagesize_version', '2 B'),
    fieldButton('pd_prune_xid', 'pd_prune_xid', '4 B'),
  )

  const pointerGrid = el('div', { class: 'an-pointer-grid', ariaLabel: 'Representative line pointer array' })
  const pointerSummary = el('span', { class: 'pg-mono', text: '—' })
  const pointerLegend = el(
    'div',
    { class: 'an-pointer-legend' },
    regionCard('lp_unused', 'LP_UNUSED', '0 · reusable', 'is-unused'),
    regionCard('lp_normal', 'LP_NORMAL', '1 · tuple', 'is-normal'),
    regionCard('lp_redirect', 'LP_REDIRECT', '2 · HOT', 'is-redirect'),
    regionCard('lp_dead', 'LP_DEAD', '3 · cleanup', 'is-dead'),
  )

  const tupleValues: Record<string, HTMLElement> = {}
  const tupleField = (key: string, label: string, bytes: string, initial: string) => {
    const value = el('span', { class: 'an-tuple-field__value pg-mono', text: initial })
    tupleValues[key] = value
    return el(
      'button',
      {
        class: `an-tuple-field an-tuple-field--${key}`,
        type: 'button',
        data: { explain: key },
      },
      el('span', { class: 'an-tuple-field__name pg-mono', text: label }),
      el('span', { class: 'an-tuple-field__bytes pg-mono', text: bytes }),
      value,
    )
  }

  const tupleDiagram = el(
    'div',
    { class: 'an-tuple-diagram', data: { explain: 'tuple' } },
    tupleField('t_xmin', 't_xmin', '4 B', 'xid 0'),
    tupleField('t_xmax', 't_xmax', '4 B', 'xid 0'),
    tupleField('t_cid', 't_cid / t_xvac', '4 B union', 'cid 0'),
    tupleField('t_ctid', 't_ctid', '6 B', '(0,2)'),
    tupleField('t_infomask2', 't_infomask2', '2 B', 'natts + HOT'),
    tupleField('t_infomask', 't_infomask', '2 B', 'xmin committed'),
    tupleField('t_hoff', 't_hoff', '1 B', '24'),
    tupleField('null_bitmap', 'null bitmap', '1 B example', '111110'),
    tupleField('user_data', 'user data', 'from t_hoff', 'id · status · payload…'),
  )

  const main = el(
    'main',
    { class: 'an-page-main pg-scroll' },
    el(
      'section',
      { class: 'an-live' },
      el(
        'div',
        { class: 'an-live__identity' },
        el('span', { class: 'pg-eyebrow', text: 'live simulation · selected relation' }),
        el('div', { class: 'an-live__name' }, tableName, block),
        provenance,
      ),
      el('div', { class: 'an-live__stats' }, ...Object.values(liveStats).map((entry) => entry.root)),
    ),
    el(
      'div',
      { class: 'an-honesty' },
      el('span', { class: 'an-honesty__mark', text: 'R' }),
      el(
        'p',
        {},
        el('strong', { text: 'Representative, not decoded.' }),
        ' Relation counters drive density and deadness; a real resident block number is used when available. The simulation does not retain each block’s tuple bytes.',
      ),
    ),
    el(
      'section',
      { class: 'an-page-scale' },
      el(
        'div',
        { class: 'an-section-head' },
        el('div', {}, el('span', { class: 'pg-eyebrow', text: 'one heap page · exact byte proportions' }), el('h3', { text: '0 → 8,192 bytes' })),
        el('span', { class: 'an-scale-badge pg-mono', text: 'BLCKSZ = 8192' }),
      ),
      el(
        'div',
        { class: 'an-byte-axis', ariaHidden: 'true' },
        el('span', { class: 'an-axis__zero pg-mono', text: '0' }),
        lowerTick,
        upperTick,
        el('span', { class: 'an-axis__end pg-mono', text: '8192' }),
      ),
      track,
      el(
        'div',
        { class: 'an-growth', ariaHidden: 'true' },
        el('span', { class: 'an-growth__forward', text: 'line pointers grow forward  →' }),
        el('span', { class: 'an-growth__backward', text: '←  tuples grow backward' }),
      ),
      el('div', { class: 'an-region-cards' }, ...Object.values(cards)),
    ),
    el(
      'section',
      { class: 'an-page-components' },
      el(
        'article',
        { class: 'an-component an-component--header' },
        el(
          'div',
          { class: 'an-component__head' },
          el('div', {}, el('span', { class: 'pg-eyebrow', text: 'bytes 0…23' }), el('h3', { text: 'PageHeaderData' })),
          el('span', { class: 'an-component__size pg-mono', text: '24 B' }),
        ),
        headerFields,
      ),
      el(
        'article',
        { class: 'an-component an-component--pointers' },
        el(
          'div',
          { class: 'an-component__head' },
          el('div', {}, el('span', { class: 'pg-eyebrow', text: 'slot array' }), el('h3', { text: 'ItemIdData[]' })),
          pointerSummary,
        ),
        el(
          'div',
          { class: 'an-pointer-bits' },
          fieldButton('lp_off', 'lp_off', '15 bits'),
          fieldButton('lp_flags', 'lp_flags', '2 bits'),
          fieldButton('lp_len', 'lp_len', '15 bits'),
        ),
        pointerGrid,
        pointerLegend,
      ),
    ),
    el(
      'section',
      { class: 'an-component an-component--tuple' },
      el(
        'div',
        { class: 'an-component__head' },
        el(
          'div',
          {},
          el('span', { class: 'pg-eyebrow', text: 'tuple opened · HOT teaching example' }),
          el('h3', { text: 'HeapTupleHeaderData → bitmap → user data' }),
        ),
        el('span', { class: 'an-component__size pg-mono', text: '23 B fixed' }),
      ),
      tupleDiagram,
      el(
        'div',
        { class: 'an-hot-chain' },
        el('span', { class: 'an-hot-chain__index pg-mono', text: 'index → LP[1]' }),
        el('span', { class: 'an-hot-chain__arrow', text: '→' }),
        el('span', { class: 'an-hot-chain__old pg-mono', text: 'old tuple · t_ctid' }),
        el('span', { class: 'an-hot-chain__arrow', text: '→' }),
        el('span', { class: 'an-hot-chain__new pg-mono', text: 'new tuple on same page' }),
      ),
    ),
  )

  return {
    root: el('div', { class: 'an-workspace an-workspace--page' }, main, detail),
    detail,
    tableName,
    block,
    provenance,
    live: Object.fromEntries(Object.entries(liveStats).map(([key, entry]) => [key, entry.value])),
    track,
    headerRegion,
    pointerRegion,
    freeRegion,
    tupleRegion,
    lowerTick,
    upperTick,
    cards,
    pointerGrid,
    pointerSummary,
    tupleValues,
  }
}

function makeDirectoryView(): {
  root: HTMLElement
  detail: HTMLElement
  totalPages: HTMLElement
  totalBytes: HTMLElement
  walSegments: HTMLElement
} {
  const detail = el('aside', { class: 'an-detail pg-scroll', ariaLive: 'polite' })
  const totalPages = el('strong', { class: 'pg-mono', text: '—' })
  const totalBytes = el('strong', { class: 'pg-mono', text: '—' })
  const walSegments = el('strong', { class: 'pg-mono', text: '—' })

  const tree = el(
    'div',
    { class: 'an-dir-tree', role: 'tree', ariaLabel: 'Data directory layout' },
    ...DIRECTORY_ITEMS.map((item) =>
      el(
        'button',
        {
          class: `an-dir-item an-dir-item--${item.kind}`,
          type: 'button',
          role: 'treeitem',
          data: { explain: item.key },
          style: { '--depth': String(item.depth) } as unknown as Partial<CSSStyleDeclaration>,
          ariaLevel: item.depth + 1,
        },
        el('span', { class: 'an-dir-item__branch', ariaHidden: 'true', text: item.depth === 0 ? '●' : item.depth === 1 ? '├' : '└' }),
        el('span', { class: 'an-dir-item__icon', ariaHidden: 'true', text: item.kind === 'dir' ? '▣' : item.kind === 'link' ? '↗' : item.kind === 'relation' ? '▤' : '·' }),
        el('span', { class: 'an-dir-item__label pg-mono', text: item.label }),
        item.note ? el('span', { class: 'an-dir-item__note', text: item.note }) : null,
      ),
    ),
  )

  const main = el(
    'main',
    { class: 'an-directory-main pg-scroll' },
    el(
      'section',
      { class: 'an-dir-intro' },
      el(
        'div',
        {},
        el('span', { class: 'pg-eyebrow', text: 'physical cluster storage' }),
        el('h3', { text: 'The data directory, opened' }),
        el('p', { text: 'Select any entry to learn what owns it and follow the documentation and source.' }),
      ),
      el(
        'div',
        { class: 'an-dir-live' },
        el('div', {}, el('span', { text: 'heap pages' }), totalPages),
        el('div', {}, el('span', { text: 'modeled heap bytes' }), totalBytes),
        el('div', {}, el('span', { text: 'WAL segments' }), walSegments),
      ),
    ),
    el(
      'div',
      { class: 'an-terminology' },
      el('span', { class: 'an-terminology__label', text: 'TERMINOLOGY' }),
      el(
        'p',
        {},
        el('strong', { text: 'Data directory' }),
        ' names the storage structure. ',
        el('code', { text: 'PGDATA' }),
        ' names an environment variable. Configuration can be elsewhere, so the two are not synonyms.',
      ),
    ),
    el(
      'section',
      { class: 'an-dir-shell' },
      el(
        'div',
        { class: 'an-dir-shell__bar' },
        el('span', { class: 'pg-mono', text: 'postgres@cluster' }),
        el('span', { class: 'an-dir-shell__path pg-mono', text: '/data/directory' }),
        el('span', { class: 'an-dir-shell__hint', text: 'focused map · illustrative OIDs' }),
      ),
      tree,
    ),
    el(
      'section',
      { class: 'an-relation-note' },
      el('span', { class: 'an-relation-note__mark', text: '≠' }),
      el(
        'div',
        {},
        el('h4', { text: 'OID is identity; filenode is a current physical name' }),
        el(
          'p',
          {},
          'A rewrite can keep relation OID ',
          el('code', { text: '18740' }),
          ' while changing ',
          el('code', { text: 'relfilenode' }),
          ' from ',
          el('code', { text: '18740' }),
          ' to ',
          el('code', { text: '18812' }),
          '. Ask ',
          el('code', { text: 'pg_relation_filepath()' }),
          '; do not infer paths from OIDs.',
        ),
      ),
    ),
  )

  return {
    root: el('div', { class: 'an-workspace an-workspace--directory' }, main, detail),
    detail,
    totalPages,
    totalBytes,
    walSegments,
  }
}

function computeSnapshot(ctx: UiContext, tableIndex: number): PageSnapshot {
  const state = ctx.sim.state
  const safeIndex = clamp(tableIndex, 0, state.tables.length - 1)
  const table = state.tables[safeIndex]
  const buffers = state.buffers
  let block = 0
  let resident = false
  let newest = -Infinity

  for (let i = 0; i < buffers.sampleFrames; i++) {
    if (!buffers.valid[i] || buffers.rel[i] !== safeIndex) continue
    if (buffers.lastTouch[i] >= newest) {
      newest = buffers.lastTouch[i]
      block = buffers.blk[i]
      resident = true
    }
  }

  const capacity = Math.max(1, table.def.tuplesPerPage)
  const physicalTuples = Math.max(1, table.liveTuples + table.deadTuples)
  const density = clamp(physicalTuples / Math.max(1, table.pages * capacity), 0.04, 1)
  const linePointers = clamp(Math.round(capacity * density), 1, capacity)
  const pointerBytes = linePointers * ITEM_ID_BYTES

  // TableDef.tuplesPerPage is intentionally rough. Reserve 10% breathing room
  // so the representative page can teach pd_lower/pd_upper even at baseline.
  const tupleBytesEach = Math.max(TUPLE_HEADER_BYTES + 1, Math.floor(((PAGE_BYTES - PAGE_HEADER_BYTES - capacity * ITEM_ID_BYTES) * 0.9) / capacity))
  const tupleBytes = Math.min(PAGE_BYTES - PAGE_HEADER_BYTES - pointerBytes, tupleBytesEach * linePointers)
  const pdLower = PAGE_HEADER_BYTES + pointerBytes
  const pdUpper = PAGE_BYTES - tupleBytes
  const freeBytes = Math.max(0, pdUpper - pdLower)
  const deadFraction = clamp(table.bloat, 0, 1)
  const deadTuples = Math.min(linePointers, Math.round(linePointers * deadFraction))
  const deadPointers = Math.min(deadTuples, Math.round(deadTuples * 0.72))
  const hotShare = table.updates > 0 ? table.hotUpdates / table.updates : 0
  const redirectPointers = Math.min(linePointers - deadPointers, hotShare > 0.01 ? Math.max(1, Math.round(linePointers * Math.min(0.04, hotShare * 0.08))) : 0)
  const unusedPointers = Math.min(linePointers - deadPointers - redirectPointers, density < 0.94 ? Math.max(1, Math.round(linePointers * (1 - density) * 0.3)) : 0)
  const normalPointers = Math.max(0, linePointers - deadPointers - redirectPointers - unusedPointers)
  const allVisible = table.deadTuples < 0.5 && table.heat < 0.08 && !table.vacuuming

  return {
    table,
    tableIndex: safeIndex,
    block,
    resident,
    linePointers,
    pointerBytes,
    tupleBytes,
    freeBytes,
    pdLower,
    pdUpper,
    deadPointers,
    redirectPointers,
    unusedPointers,
    normalPointers,
    deadTuples,
    allVisible,
    tupleBytesEach,
  }
}

export function createAnatomy(ctx: UiContext): UiModule {
  const page = makePageView()
  const directory = makeDirectoryView()
  const title = el('h2', { id: 'anatomy-title', class: 'an-overlay__title', text: 'Heap page anatomy' })
  const subtitle = el('p', { class: 'an-overlay__subtitle', text: 'One 8 KiB page · byte-scaled · live relation state' })
  const pageTab = el('button', { class: 'an-tab is-active', type: 'button', text: '8 KiB page', ariaPressed: true })
  const directoryTab = el('button', { class: 'an-tab', type: 'button', text: 'Data directory', ariaPressed: false })
  const close = el('button', {
    class: 'pg-btn pg-btn--icon an-overlay__close',
    type: 'button',
    data: { modeExit: modeTokens(MODE_IDS.anatomyPage, MODE_IDS.anatomyDirectory) },
    ariaLabel: 'Close anatomy view',
  }, icon('close', 16))

  const panel = el(
    'section',
    { class: 'an-overlay__panel pg-panel', role: 'document' },
    el(
      'header',
      { class: 'an-overlay__head pg-panel__head' },
      el('div', { class: 'an-overlay__heading' }, el('span', { class: 'pg-eyebrow', text: 'POSTGRESQL · PHYSICAL ANATOMY' }), title, subtitle),
      el('nav', { class: 'an-tabs', ariaLabel: 'Anatomy view' }, pageTab, directoryTab),
      close,
    ),
    el('div', { class: 'an-overlay__body' }, page.root, directory.root),
  )

  const overlay = el('div', {
    class: 'an-overlay',
    role: 'dialog',
    ariaModal: true,
    ariaLabelledby: 'anatomy-title',
    hidden: true,
  }, panel)

  document.body.append(overlay)

  let view: AnatomyView = 'page'
  let open = false
  let tableIndex = Math.min(3, ctx.sim.state.tables.length - 1)
  let pagePinned = 'overview'
  let directoryPinned = 'datadir'
  let lastActive: HTMLElement | null = null
  let lastUpdate = -Infinity
  let lastShape = ''

  const applyPageDetail = (key: string) => {
    const detail = PAGE_DETAILS[key] ?? PAGE_DETAILS.overview
    renderDetail(page.detail, detail)
    page.root.querySelectorAll<HTMLElement>('[data-explain]').forEach((node) => {
      node.classList.toggle('is-explained', node.dataset.explain === key)
    })
  }

  const applyDirectoryDetail = (key: string) => {
    const detail = DIRECTORY_DETAILS[key] ?? DIRECTORY_DETAILS.datadir
    renderDetail(directory.detail, detail)
    directory.root.querySelectorAll<HTMLElement>('[data-explain]').forEach((node) => {
      node.classList.toggle('is-explained', node.dataset.explain === key)
    })
  }

  function bindDisclosure(root: HTMLElement, kind: AnatomyView): void {
    const show = (key: string) => {
      if (kind === 'page') applyPageDetail(key)
      else applyDirectoryDetail(key)
    }
    root.addEventListener('pointerover', (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-explain]')
      if (target?.dataset.explain) show(target.dataset.explain)
    })
    root.addEventListener('pointerleave', () => show(kind === 'page' ? pagePinned : directoryPinned))
    root.addEventListener('focusin', (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-explain]')
      if (target?.dataset.explain) show(target.dataset.explain)
    })
    root.addEventListener('click', (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-explain]')
      const key = target?.dataset.explain
      if (!key) return
      if (kind === 'page') pagePinned = key
      else directoryPinned = key
      show(key)
    })
  }

  bindDisclosure(page.root, 'page')
  bindDisclosure(directory.root, 'directory')
  applyPageDetail(pagePinned)
  applyDirectoryDetail(directoryPinned)

  function switchView(next: AnatomyView, updateUrl = true): void {
    view = next
    page.root.hidden = next !== 'page'
    directory.root.hidden = next !== 'directory'
    pageTab.classList.toggle('is-active', next === 'page')
    directoryTab.classList.toggle('is-active', next === 'directory')
    pageTab.setAttribute('aria-pressed', String(next === 'page'))
    directoryTab.setAttribute('aria-pressed', String(next === 'directory'))
    setText(title, next === 'page' ? 'Heap page anatomy' : 'Data directory anatomy')
    setText(subtitle, next === 'page' ? 'One 8 KiB page · byte-scaled · live relation state' : 'Cluster files, relation forks and segment names')
    if (updateUrl && open) setHash(next, true)
  }

  function show(next: AnatomyView, updateUrl = true): void {
    if (!open) {
      lastActive = document.activeElement instanceof HTMLElement ? document.activeElement : null
      open = true
      overlay.hidden = false
      document.body.classList.add('pg-anatomy-open')
    }
    switchView(next, false)
    if (updateUrl) setHash(next, false)
    window.requestAnimationFrame(() => (next === 'page' ? pageTab : directoryTab).focus())
    updateLive(true)
  }

  function hide(updateUrl = true): void {
    if (!open) return
    open = false
    overlay.hidden = true
    document.body.classList.remove('pg-anatomy-open')
    if (updateUrl) setHash(null, false)
    lastActive?.focus()
  }

  function rebuildPage(snapshot: PageSnapshot): void {
    const widths = {
      header: (PAGE_HEADER_BYTES / PAGE_BYTES) * 100,
      pointers: (snapshot.pointerBytes / PAGE_BYTES) * 100,
      free: (snapshot.freeBytes / PAGE_BYTES) * 100,
      tuples: (snapshot.tupleBytes / PAGE_BYTES) * 100,
    }
    page.track.style.setProperty('--header-pct', `${widths.header}%`)
    page.track.style.setProperty('--pointer-pct', `${widths.pointers}%`)
    page.track.style.setProperty('--free-pct', `${widths.free}%`)
    page.track.style.setProperty('--tuple-pct', `${widths.tuples}%`)
    page.lowerTick.style.left = `${(snapshot.pdLower / PAGE_BYTES) * 100}%`
    page.upperTick.style.left = `${(snapshot.pdUpper / PAGE_BYTES) * 100}%`
    setText(page.lowerTick, `${snapshot.pdLower} · pd_lower`)
    setText(page.upperTick, `pd_upper · ${snapshot.pdUpper}`)

    page.cards.pointers.querySelector<HTMLElement>('.an-region-card__hint')!.textContent =
      `${snapshot.linePointers} × 4 B · ${snapshot.pointerBytes} B`
    page.cards.free.querySelector<HTMLElement>('.an-region-card__hint')!.textContent =
      `${snapshot.freeBytes.toLocaleString()} B · ${snapshot.pdLower}…${snapshot.pdUpper}`
    page.cards.tuples.querySelector<HTMLElement>('.an-region-card__hint')!.textContent =
      `${snapshot.tupleBytes.toLocaleString()} B · grow backward`

    const statuses: string[] = []
    for (let i = 0; i < snapshot.normalPointers; i++) statuses.push('normal')
    for (let i = 0; i < snapshot.redirectPointers; i++) statuses.push('redirect')
    for (let i = 0; i < snapshot.deadPointers; i++) statuses.push('dead')
    for (let i = 0; i < snapshot.unusedPointers; i++) statuses.push('unused')
    // Keep the structural distribution readable rather than grouping every
    // dead slot at one edge; the order is deterministic for stable screenshots.
    statuses.sort((a, b) => ((a.charCodeAt(0) * 17 + statuses.indexOf(a)) % 11) - ((b.charCodeAt(0) * 17 + statuses.indexOf(b)) % 11))

    page.pointerGrid.replaceChildren(
      ...statuses.map((status, i) =>
        el('button', {
          class: `an-pointer an-pointer--${status}`,
          type: 'button',
          data: { explain: `lp_${status}` },
          text: String(i + 1),
          ariaLabel: `Line pointer ${i + 1}, LP_${status.toUpperCase()}`,
        }),
      ),
    )

    const tupleCount = snapshot.linePointers
    const deadCount = snapshot.deadTuples
    page.tupleRegion.replaceChildren(
      ...Array.from({ length: tupleCount }, (_, i) => {
        const dead = i >= tupleCount - deadCount
        return el('button', {
          class: `an-tuple-block${dead ? ' is-dead' : ''}`,
          type: 'button',
          data: { explain: i === tupleCount - 1 ? 'tuple' : 'tuples' },
          ariaLabel: `${dead ? 'Unreclaimed dead' : 'Live'} tuple ${tupleCount - i}, approximately ${snapshot.tupleBytesEach} bytes`,
        })
      }),
    )

    setText(
      page.pointerSummary,
      `${snapshot.linePointers} slots · ${snapshot.normalPointers} normal · ${snapshot.deadPointers} dead`,
    )
  }

  function updateLive(force = false): void {
    const now = performance.now()
    if (!force && now - lastUpdate < 450) return
    lastUpdate = now
    const state = ctx.sim.state
    const snapshot = computeSnapshot(ctx, tableIndex)
    tableIndex = snapshot.tableIndex
    const table = snapshot.table
    setText(page.tableName, table.def.name)
    setText(page.block, `block ${snapshot.block.toLocaleString()}`)
    setText(page.provenance, snapshot.resident ? 'latest resident block · occupancy from relation counters' : 'no resident block yet · representative block 0')
    setText(page.live.live, fmtNum(table.liveTuples))
    setText(page.live.dead, fmtNum(table.deadTuples))
    setText(page.live.bloat, fmtPct(table.bloat, 1))
    setText(page.live.free, `${snapshot.freeBytes.toLocaleString()} B`)
    setText(page.live.vm, snapshot.allVisible ? 'likely set' : 'clear / unknown')

    const shape = [
      snapshot.tableIndex,
      snapshot.linePointers,
      snapshot.pointerBytes,
      snapshot.freeBytes,
      snapshot.deadPointers,
      snapshot.redirectPointers,
      snapshot.unusedPointers,
      snapshot.deadTuples,
    ].join(':')
    if (force || shape !== lastShape) {
      lastShape = shape
      rebuildPage(snapshot)
    }

    const xid = state.xid
    setText(page.tupleValues.t_xmin, `xid ${Math.max(3, xid - 8).toLocaleString()}`)
    setText(page.tupleValues.t_xmax, `xid ${Math.max(3, xid - 2).toLocaleString()} · updated`)
    setText(page.tupleValues.t_cid, 'cid 0 · shared word')
    setText(page.tupleValues.t_ctid, `(${snapshot.block.toLocaleString()},2) → newer`)
    setText(page.tupleValues.t_infomask2, 'natts 6 · HOT_UPDATED')
    setText(page.tupleValues.t_infomask, 'HASNULL · XMIN_COMMITTED')
    setText(page.tupleValues.t_hoff, '24 · MAXALIGN')
    setText(page.tupleValues.null_bitmap, '111110 · 6 attrs')

    let totalPages = 0
    for (const relation of state.tables) totalPages += relation.pages
    setText(directory.totalPages, fmtNum(totalPages))
    setText(directory.totalBytes, fmtBytes(totalPages * PAGE_BYTES))
    setText(directory.walSegments, state.wal.segmentCount.toLocaleString())
  }

  function useRelation(id: string): void {
    let found = -1
    if (id.startsWith('storage.table.')) {
      const relationId = id.slice('storage.table.'.length)
      found = ctx.sim.state.tables.findIndex((table) => table.def.id === relationId)
    } else if (id.startsWith('storage.index.')) {
      const indexId = id.slice('storage.index.'.length)
      found = ctx.sim.state.tables.findIndex((table) => table.def.indexes.some((index) => index.id === indexId))
    }
    if (found < 0) return
    tableIndex = found
    lastShape = ''
  }

  const offSelect = ctx.bus.on('select', ({ id, part, outlineOnly }) => {
    if (outlineOnly) return
    if (!id) return
    useRelation(id)
    if (part === 'page') show('page')
  })

  const offOpen = ctx.bus.on('anatomy:open', ({ view: next, id }) => {
    if (id) useRelation(id)
    show(next)
  })

  const onKey = (event: KeyboardEvent) => {
    if (open && event.key === 'Escape') {
      event.preventDefault()
      hide()
    }
  }
  const syncLocation = () => {
    const target = anatomyHash()
    if (target) show(target, false)
    else hide(false)
  }

  pageTab.addEventListener('click', () => switchView('page'))
  directoryTab.addEventListener('click', () => switchView('directory'))
  close.addEventListener('click', () => hide())
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) hide()
  })
  window.addEventListener('keydown', onKey)
  window.addEventListener('hashchange', syncLocation)
  window.addEventListener('popstate', syncLocation)

  page.root.hidden = false
  directory.root.hidden = true
  updateLive(true)
  syncLocation()

  return {
    update(): void {
      if (open) updateLive()
    },
    dispose(): void {
      offSelect()
      offOpen()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('hashchange', syncLocation)
      window.removeEventListener('popstate', syncLocation)
      document.body.classList.remove('pg-anatomy-open')
      overlay.remove()
    },
  }
}
