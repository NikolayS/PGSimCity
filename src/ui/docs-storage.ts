import { poolBytes } from '../core/types'
import { renderAction } from '../core/actions'
import { CLAIM_VALUES } from '../core/claims'
import type { BookRef, CheckpointPhase, ComponentDoc, DocRef, SimState, TableSim, VacPhase, WalSegment } from '../core/types'
import { configuredSynchronousStandby, physicalStandby } from '../core/replication'
import { clamp, fmtBytes, fmtDuration, fmtLsn, fmtNum, fmtPct } from '../core/util'

/* ============================================================================
 * DOCS_STORAGE — durability, storage, maintenance, replication.
 *
 * The rule for everything in this file: explain the mechanism first, then the
 * consequence you would actually see in production. The city is an honest
 * model of Postgres, not a simulator of it; where the model cheats, say so.
 * ==========================================================================*/

/* ------------------------------ tiny helpers ----------------------------- */

const PAGE = 8192
/** Sum a per-table quantity across the whole model, NaN-safe. */
function sumTables(s: SimState, pick: (t: TableSim) => number): number {
  let n = 0
  for (const t of s.tables) {
    const v = pick(t)
    if (isFinite(v)) n += v
  }
  return n
}

const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0)

const WAL_SEGMENT_POSTGRESQL_DISCLOSURE = CLAIM_VALUES.walSegment.postgresqlDisclosure.join('. ')

const standbyA = (s: SimState) => physicalStandby(s.replication, 'standbyA')

/** Bytes currently sitting in pg_wal. */
const walDirBytes = (s: SimState): number => s.wal.segmentCount * s.wal.segmentSize

/** The segment being written right now, if the visible window contains it. */
const currentSeg = (s: SimState): WalSegment | undefined => s.wal.segments.find((g) => g.state === 'current')

const countSegs = (s: SimState, state: WalSegment['state']): number =>
  s.wal.segments.reduce((n, g) => n + (g.state === state ? 1 : 0), 0)

/** Table with the worst dead-tuple ratio — the one a DBA would be staring at. */
function worstBloat(s: SimState): TableSim | undefined {
  let hit: TableSim | undefined
  for (const t of s.tables) if (!hit || t.bloat > hit.bloat) hit = t
  return hit
}

/** Seconds since anything was last vacuumed. */
function sinceVacuum(s: SimState): number {
  let last = -Infinity
  for (const t of s.tables) if (t.lastVacuum > last) last = t.lastVacuum
  if (!isFinite(last)) return 0
  return Math.max(0, s.t - last)
}

const activeWorkers = (s: SimState): number => s.autovac.workers.reduce((n, w) => n + (w.active ? 1 : 0), 0)

const CKPT_PHASE: Record<CheckpointPhase, string> = {
  idle: 'idle',
  start: 'starting',
  writing: 'writing buffers',
  syncing: 'fsync',
  finishing: 'finishing',
}

const VAC_PHASE: Record<VacPhase, string> = {
  idle: 'idle',
  travel: 'dispatching',
  scan_heap: 'scanning heap',
  vacuum_index: 'vacuuming indexes',
  vacuum_heap: 'vacuuming heap',
  truncate: 'truncating heap',
  analyze: 'analyzing',
  return: 'finishing',
}

/** Human label for the current vacuum fleet, e.g. "2 workers — scanning heap". */
function vacSummary(s: SimState): string {
  const live = s.autovac.workers.filter((w) => w.active)
  if (!s.autovac.enabled) return 'disabled'
  if (live.length === 0) return 'idle'
  const w = live[0]
  const phase = w ? VAC_PHASE[w.phase] : 'working'
  return `${live.length} × ${phase}`
}

/* ---------------------------- reference helpers ---------------------------
 * The reading list under each component. Every entry here was checked against
 * the thing it points at — the manual page title, the file on the target branch, the
 * function name inside it, the chapter number on interdb.jp. A reference
 * nobody checked is worse than no reference, so where a book genuinely has no
 * chapter on a subject, the field is simply absent.
 * -------------------------------------------------------------------------*/

const DOCS_BASE = CLAIM_VALUES.postgresqlVersion.manualBase
const SRC_BASE = 'https://github.com/postgres/postgres/blob/'
const SUZUKI_BASE = 'https://www.interdb.jp/pg/'

/** A page of the PostgreSQL manual. `page` may carry a #ANCHOR. */
const manual = (page: string, label: string): DocRef => ({ label, url: DOCS_BASE + page })

/** A file on the owned PostgreSQL branch, with the functions worth opening. */
const srcFile = (path: string, symbol?: string): DocRef => ({
  label: path,
  url: `${SRC_BASE}${CLAIM_VALUES.postgresqlVersion.sourceBranch}/${path}`,
  symbol,
})

/** The same file on a released branch, for code that has since moved on master. */
const srcFileAt = (branch: string, note: string, path: string, symbol?: string): DocRef => ({
  label: `${path} — ${note}`,
  url: `${SRC_BASE}${branch}/${path}`,
  symbol,
})

/** A chapter of Hironobu Suzuki's *The Internals of PostgreSQL*, free online. */
const suzuki = (n: number, label: string): DocRef & { chapter: string } => ({
  chapter: String(n),
  label,
  url: `${SUZUKI_BASE}pgsql${String(n).padStart(2, '0')}/index.html`,
})

/**
 * A chapter of Egor Rogov's *PostgreSQL 14 Internals*. A book: cited, never
 * linked. Chapters are named, not numbered — the publisher's own contents list
 * gives the titles, and a chapter number nobody re-checked is exactly the kind
 * of confident wrong detail this apparatus exists to avoid.
 */
const ROGOV_EDITION = 'PostgreSQL 14 Internals — Egor Rogov, Postgres Professional'
const R_MVCC = 'Part I. Isolation and MVCC'
const R_WAL = 'Part II. Buffer Cache and WAL'
const rogov = (part: string, chapter: string, confidence?: string): BookRef => ({
  edition: ROGOV_EDITION,
  part,
  chapter,
  confidence,
})

/* ============================================================================
 * The docs.
 * ==========================================================================*/

export const DOCS_STORAGE: ComponentDoc[] = [
  /* ======================================================================
   * WAL
   * ====================================================================*/
  {
    id: 'walwriter',
    title: 'WAL writer',
    subtitle: 'background process',
    tldr: 'Pushes WAL out of memory and onto disk so commits do not each have to do it alone.',
    sections: [
      {
        heading: 'Why it exists',
        body: 'Every change to a data page is described first as a WAL record, appended to a shared ring in memory called `wal_buffers`. Someone has to move those bytes to the operating system and then force them to durable storage. A committing backend can do that itself, but if every commit walks the whole path alone you pay one flush per transaction. The WAL writer runs in the background so that a large fraction of the WAL is already written, and often already flushed, by the time a commit asks for it.',
      },
      {
        heading: 'Written is not flushed',
        body: 'There are three positions in the WAL, and confusing them is the single most common misunderstanding about Postgres durability. **Insert** is how far backends have filled the buffer. **Write** is how far the bytes have been handed to the kernel with `write()` — at that point they are in the OS page cache and a Postgres crash cannot lose them, but a power cut can. **Flush** is how far `fsync()` has confirmed, and that is the only line behind which data survives losing the machine. `pg_stat_io` counts WAL `writes` and `fsyncs` separately for exactly this reason (through PostgreSQL 17 those counters lived in `pg_stat_wal`, as `wal_write` and `wal_sync`).',
      },
      {
        heading: 'What actually happens at COMMIT',
        body: 'With `synchronous_commit = on`, a committing backend calls `XLogFlush` up to its own commit record and sleeps until the fsync returns. While it sleeps, other backends pile their commit records into the same buffer, so one fsync frequently hardens dozens of transactions — this is group commit, and it is why throughput does not fall off a cliff as concurrency rises. With `synchronous_commit = off` the backend does not wait at all: it marks the LSN it needs, returns success to the client, and leaves the WAL writer to flush it. The documented bound on that window is three times `wal_writer_delay` — about 600 ms at the default 200 ms — because the WAL writer needs a full cycle to notice the record and another to flush it.',
      },
      {
        heading: 'What you would see in production',
        body: 'Turning `synchronous_commit` off can reduce commit latency on write-heavy OLTP because commits stop waiting for local WAL durability. The price is precise: after a PostgreSQL server crash, operating-system crash or power failure, the last fraction of a second of *acknowledged* transactions may be lost. Nothing is corrupted — recovery produces a consistent database that may be older than acknowledgements the application already received. That is a business decision, and it can be made per transaction because `synchronous_commit` is settable inside a session.',
      },
      {
        heading: 'The knob that matters',
        body: '`wal_writer_delay` and `wal_writer_flush_after` control how eagerly the writer works, but you will rarely touch them. `synchronous_commit` is the dial with real consequences, and `wal_buffers` matters only if it is tiny — the default of 1/32 of `shared_buffers` (capped at 16 MiB) is fine almost everywhere. If backends are spending time in `WALInsert` waits, the bottleneck is the WAL itself, not the writer.',
      },
    ],
    metrics: [
      {
        label: 'In wal_buffers',
        get: (s) => `${fmtBytes(s.wal.bufferBytes)} / ${fmtBytes(s.wal.bufferCapacity)}`,
        hint: 'WAL inserted into shared memory but not yet handed to the kernel',
      },
      {
        label: 'Written, not flushed',
        get: (s) => fmtBytes(Math.max(0, s.wal.writeLsn - s.wal.flushLsn)),
        hint: 'In the OS page cache. Survives a Postgres crash, not a power cut.',
      },
      { label: 'Flush LSN', get: (s) => fmtLsn(s.wal.flushLsn), hint: 'Everything before this is on durable storage' },
      { label: 'WAL rate', get: (s) => `${fmtBytes(s.wal.bytesPerSec)}/s` },
    ],
    knobs: ['synchronousCommit', 'fullPageWrites', 'writeRatio', 'tps'],
    see: ['wal.vault', 'checkpointer', 'disk.array', 'net.wire'],
    source: ['src/backend/postmaster/walwriter.c', 'src/backend/access/transam/xlog.c'],
    refs: {
      docs: [
        manual('wal-async-commit.html', '28.4. Asynchronous Commit'),
        manual('runtime-config-wal.html', '19.5. Write Ahead Log'),
      ],
      source: [
        srcFile('src/backend/postmaster/walwriter.c', 'WalWriterMain'),
        srcFile('src/backend/access/transam/xlog.c', 'XLogFlush, XLogBackgroundFlush'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.6)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log; WAL Modes — synchronous and asynchronous commit'),
    },
  },

  {
    id: 'wal.vault',
    title: 'pg_wal',
    subtitle: 'the write-ahead log on disk',
    tldr: `A directory holding every change, and the most common way a Postgres server dies. ${CLAIM_VALUES.walSegment.modelDisclosure}. ${WAL_SEGMENT_POSTGRESQL_DISCLOSURE}.`,
    sections: [
      {
        heading: 'What is actually in there',
        body: `The write-ahead log is one enormous append-only byte stream, cut into segment files. ${WAL_SEGMENT_POSTGRESQL_DISCLOSURE}. A position in that stream is an **LSN**, printed as two hex halves like \`1A/3F0C8B20\`; it is simply a byte offset, so subtracting two LSNs gives you bytes of WAL, which is how every replication-lag query works. The 24-character filenames are not sequential prettiness: they are timeline, log id and segment number in hex, which is why \`000000010000000000000023\` follows \`…22\`.`,
      },
      {
        heading: 'Why the opening segment is nearly full',
        body: 'The city opens 92% into the current 16 MiB segment before its silent 14-second warm-up. That staged starting LSN lets a reader watch the last few percent accumulate, close, and ship during a normal visit. It does not shrink the segment or multiply WAL: generated bytes, LSN differences, the WAL-rate readout and `max_wal_size` arithmetic stay unscaled after that initial position.',
      },
      {
        heading: 'Recycled, not deleted',
        body: 'When a checkpoint finishes, the segments that lie entirely before the new redo point are no longer needed for crash recovery. Rather than delete them, the checkpointer **renames** them to the filenames they will need next, so a future write lands in a file that is already allocated at full size and never has to extend the filesystem mid-transaction. A recycled segment is not zeroed — the old bytes stay where they are and are simply overwritten as the WAL advances, which is why the tail of a partly used segment can still hold readable fragments of an earlier one. `min_wal_size` (80MB by default) is how much it keeps around for that purpose; `max_wal_size` is roughly how much it is willing to accumulate before forcing a checkpoint. Both are targets, not hard limits.',
      },
      {
        heading: 'Every way this directory fills up',
        body: 'There are three classic causes and they look similar from the outside — `pg_wal` grows. A failing `archive_command` prevents archived segments from being recycled. A **replication slot** whose consumer went away holds `restart_lsn` until the slot advances, is dropped, expires or is invalidated under configured retention limits. A write rate far above what checkpoints can absorb can also push WAL past `max_wal_size`, because that target is soft. Check the archive and slot views rather than inferring the cause from directory size alone.',
      },
      {
        heading: 'What you would see in production',
        body: `Disk usage climbs steadily on the WAL volume while everything else looks healthy, and then the server PANICs with \`could not write to file … No space left on device\` and restarts. Do not delete files from \`pg_wal\` by hand — that is how a recoverable incident becomes an unrecoverable one. Fix the cause: repair or temporarily neuter archiving, drop the abandoned slot with \`pg_drop_replication_slot\`, and set \`max_slot_wal_keep_size\` (PostgreSQL 13 and later) so a dead slot is invalidated rather than allowed to take the primary down with it.\n\n${renderAction('limitSlotWalRetention')}`,
      },
      {
        heading: 'How to watch it',
        body: 'Query `pg_replication_slots` and look at `active`, `wal_status` and `safe_wal_size` — `wal_status` moving from `reserved` to `extended` to `unreserved` to `lost` is the disk filling in slow motion. `unreserved` is the one to page on: the WAL that slot needs is now beyond `max_slot_wal_keep_size` and can be removed at the next checkpoint, so it is the last moment at which the slot can still be saved. `lost` means the slot can no longer retain its required WAL; it does not prove that every recovery source has lost those segments. Dropping a slot removes its retention guarantee but does not delete WAL already in `pg_wal`. A physical standby continues while its required WAL is still there, or can recover missing local segments through `restore_command` when they exist in the archive. That standby needs a new base backup only when the necessary WAL is unavailable from every source. `pg_stat_archiver.last_failed_time` tells you whether archiving is the culprit. `SELECT pg_current_wal_lsn()` minus a slot LSN gives you exactly how many bytes one consumer is holding hostage.',
      },
    ],
    metrics: [
      { label: 'pg_wal size', get: (s) => fmtBytes(walDirBytes(s)), hint: 'segmentCount × 16 MiB in this model' },
      { label: 'Segments', get: (s) => fmtNum(s.wal.segmentCount) },
      {
        label: 'Current segment',
        get: (s) => {
          const g = currentSeg(s)
          return g ? `${g.name.slice(-8)} · ${fmtPct(g.fill)}` : '—'
        },
        hint: 'last 8 hex digits of the filename, and how full it is',
      },
      { label: 'Insert LSN', get: (s) => fmtLsn(s.wal.insertLsn) },
      { label: 'Awaiting archive', get: (s) => fmtNum(s.wal.archiveQueue), hint: 'segments with a .ready file' },
    ],
    knobs: ['maxWalSize', 'checkpointTimeout', 'walLevel', 'fullPageWrites'],
    see: ['walwriter', 'checkpointer', 'archiver', 'walsender'],
    source: ['src/backend/access/transam/xlog.c', 'src/backend/access/transam/xloginsert.c'],
    refs: {
      docs: [
        manual('wal-internals.html', '28.6. WAL Internals'),
        manual('wal-configuration.html', '28.5. WAL Configuration'),
      ],
      source: [srcFile('src/backend/access/transam/xlog.c', 'XLogWrite, RemoveOldXlogFiles, InstallXLogFileSegment')],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.9)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log'),
    },
  },

  {
    id: 'archiver',
    title: 'Archiver',
    subtitle: 'background process',
    tldr: 'Copies each completed WAL segment somewhere safe, one at a time, and never gives up on a failure.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'When a WAL segment fills, or a requested segment switch closes one early, Postgres drops a zero-length marker into `pg_wal/archive_status/` named `<segment>.ready`. The archiver watches for those, runs your `archive_command` (or calls into an `archive_library`, available since PostgreSQL 15) once per closed segment, and on success renames the marker to `.done`, which is what finally permits the checkpointer to recycle the file. Archiving waits for closure and works strictly one segment at a time.',
      },
      {
        heading: 'The contract your command must honour',
        body: 'The command must return zero **only** if the file is durably stored, must return non-zero if it is not, and must refuse to overwrite an existing archived file with different content rather than silently clobbering it. A command like `cp %p /archive/%f` fails all three: it does not fsync, and it will happily overwrite. Use a real tool (pgBackRest, WAL-G, barman) rather than a shell one-liner — a broken archive is only discovered on the day you need it.',
      },
      {
        heading: 'What falling behind looks like',
        body: 'Archiving is a queue, and queues fail quietly before they fail loudly. First `pg_stat_archiver.last_archived_wal` starts trailing `pg_current_wal_lsn()` by more segments each hour. Then the count of `.ready` files climbs. Then `pg_wal` starts growing because nothing can be recycled. Only at the end does the disk fill and the server PANIC. Alert on the number of `.ready` files, not on disk usage — you want to know an hour before it matters.',
      },
      {
        heading: 'Failures are sticky',
        body: 'If `archive_command` returns non-zero, the archiver retries the same segment, forever, with a short wait between attempts. That is deliberate: skipping a segment would silently break the WAL chain and quietly invalidate every backup taken before it. So a network partition to your archive store does not lose data, it accumulates it — which means the operational question during an incident is always "how much WAL can this volume hold before we run out of time".',
      },
    ],
    metrics: [
      { label: 'Queue depth', get: (s) => fmtNum(s.disasterRecovery.archive.queueSegments), hint: '.ready files waiting for the archiver' },
      { label: 'Segments archived', get: (s) => fmtNum(s.wal.archived) },
      { label: 'In flight', get: (s) => fmtNum(countSegs(s, 'archiving')), hint: 'the archiver copies one at a time' },
      {
        label: 'Backlog size',
        get: (s) => fmtBytes(s.disasterRecovery.archive.queueSegments * s.wal.segmentSize),
        hint: 'WAL that exists only on the primary — still safe in pg_wal, lost only if you lose the primary\'s storage',
      },
    ],
    knobs: ['walGArchiveCredentialsValid', 'tps', 'writeRatio'],
    see: ['archive.gate', 'object.store', 'wal.vault', 'checkpointer', 'walsender'],
    source: ['src/backend/postmaster/pgarch.c'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-in-Time Recovery (PITR)'),
        manual('runtime-config-wal.html', '19.5. Write Ahead Log — archive_command, archive_library'),
      ],
      source: [
        srcFile('src/backend/postmaster/pgarch.c', 'pgarch_ArchiverCopyLoop, pgarch_archiveXlog'),
        srcFile('src/backend/access/transam/xlogarchive.c', 'XLogArchiveNotify'),
      ],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
    },
  },

  {
    id: 'archive.status',
    title: 'pg_wal/archive_status',
    subtitle: 'the archiver’s local bookkeeping',
    tldr: 'A .ready marker means a completed WAL segment still needs archiving; .done records successful archival so PostgreSQL may recycle it.',
    sections: [
      {
        heading: 'The marker is not the archive',
        body: 'When a WAL segment becomes archivable, PostgreSQL creates a zero-length `pg_wal/archive_status/<segment>.ready` file. After `archive_command` or `archive_library` reports success, the archiver renames that marker to `.done`. The marker contains no WAL and proves only PostgreSQL’s local record of the result; the actual segment must exist durably at the archive destination. Creating or removing these files by hand can make PostgreSQL skip required archival or repeat work.',
      },
      {
        heading: 'What the city counts',
        body: 'The `.ready` count is the modeled archive queue. The city shows at most the latest six `.done` markers and keeps no marker files, archive-command exit statuses or destination objects here; those mechanisms are represented by counters and the separate archive gate and object store.',
      },
    ],
    metrics: [
      { label: '.ready', get: (s) => fmtNum(s.wal.archiveQueue), hint: 'completed segments waiting for successful archival' },
      { label: '.done shown', get: (s) => `${fmtNum(Math.min(s.wal.archived, 6))} / ${fmtNum(s.wal.archived)}`, hint: 'the drawing retains only the latest six markers' },
    ],
    knobs: ['walGArchiveCredentialsValid', 'tps', 'writeRatio'],
    see: ['archiver', 'archive.gate', 'object.store', 'wal.vault'],
    source: ['src/backend/access/transam/xlogarchive.c', 'src/backend/postmaster/pgarch.c'],
    refs: {
      docs: [
        manual('continuous-archiving.html#BACKUP-ARCHIVING-WAL', '25.3.1. Setting Up WAL Archiving'),
        manual('monitoring-stats.html#MONITORING-PG-STAT-ARCHIVER-VIEW', '27.2.12. pg_stat_archiver'),
      ],
      source: [
        srcFile('src/backend/access/transam/xlogarchive.c', 'XLogArchiveNotify, XLogArchiveCheckDone, XLogArchiveForceDone'),
        srcFile('src/backend/postmaster/pgarch.c', 'pgarch_ArchiverCopyLoop, pgarch_archiveXlog'),
      ],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and continuous archiving'),
    },
  },

  {
    id: 'object.store',
    title: 'WAL-G object storage',
    subtitle: 'WAL and base-backup objects in S3',
    tldr: 'A base backup plus every WAL segment since it — the only combination that is actually a backup.',
    sections: [
      {
        heading: 'What WAL-G sends here',
        body: 'This model follows WAL-G 3.0.8: `wal-g wal-push` sends each closed WAL segment from the primary’s PostgreSQL 18 `archive_command` to S3, and `wal-g backup-push` streams compressed base-backup objects and its stop sentinel from standby_a into another prefix in the same bucket. There is no repository host. Real PostgreSQL can also archive during standby recovery with `archive_mode = always`; this city teaches the common primary-archives pattern. The 65% compressed size is illustrative; entropy, compression, encryption and file layout decide the real result.',
      },
      {
        heading: 'Why both object sets matter',
        body: 'A base backup copies the data directory while PostgreSQL is running, so files come from different instants. WAL from the backup start checkpoint’s redo point through the stop record makes those pages consistent; WAL after that carries recovery to the chosen target. PostgreSQL 18 therefore needs one retained base backup plus an unbroken chain beginning at its start LSN. A backup is not complete until its stop WAL is safely archived.',
      },
      {
        heading: 'Object storage changes the incident',
        body: 'Expired or mis-scoped S3 credentials, a network failure, or request throttling makes `wal-push` return nonzero; PostgreSQL then retries the oldest `.ready` file and `pg_wal` grows. On restore, every WAL object requires a GET. `WALG_DOWNLOAD_CONCURRENCY` overlaps `backup-fetch`, `wal-fetch` and prefetch work, but it does not reduce request count or charges and too much parallelism can trigger throttling. The city models the throughput direction, not provider-specific quotas or money.',
      },
      {
        heading: 'Lifecycle is part of the RTO',
        body: 'An S3 Lifecycle rule can transition old objects to an archival class that is not readable in real time. The key can still exist in listings while `wal-fetch` cannot GET it until an operator issues a restore request and waits for retrieval. WAL-G’s `WALG_S3_STORAGE_CLASS` chooses the upload class, but bucket lifecycle policy is an independent control. This latency and retrieval billing are disclosed, not simulated; rehearse a restore from the oldest tier you promise.',
      },
    ],
    metrics: [
      {
        label: 'Archive size',
        get: (s) => fmtBytes(s.wal.archived * s.wal.segmentSize),
        hint: 'WAL safely off the primary in this session',
      },
      { label: 'Segments held', get: (s) => fmtNum(s.wal.archived) },
      {
        label: 'Recovery window',
        get: (s) =>
          s.disasterRecovery.backups.length > 0
            ? fmtDuration(Math.max(0, s.t - s.disasterRecovery.oldestRecoverableTime))
            : 'no base backup',
        hint: 'oldest retained full backup through the newest archived WAL',
      },
      { label: 'Unarchived', get: (s) => fmtNum(s.disasterRecovery.archive.queueSegments), hint: 'segments not yet safe off-host' },
    ],
    knobs: ['walGArchiveCredentialsValid', 'walGDownloadConcurrency', 'tps', 'writeRatio', 'fullPageWrites'],
    see: ['archiver', 'wal.vault', 'startup.proc', 'replica.storage'],
    source: ['src/backend/postmaster/pgarch.c', 'src/backend/access/transam/xlog.c'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-in-Time Recovery (PITR)'),
        manual('app-pgbasebackup.html', 'pg_basebackup'),
        { label: 'WAL-G 3.0.8 PostgreSQL commands — backup-push, backup-fetch, wal-push and wal-fetch', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
        { label: 'WAL-G S3 credentials and storage-class configuration', url: 'https://wal-g.readthedocs.io/STORAGES/' },
        { label: 'Amazon S3 — restoring archived objects', url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects.html' },
        { label: 'Amazon S3 request and retrieval pricing', url: 'https://aws.amazon.com/s3/pricing/' },
      ],
      source: [
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery, InitWalRecovery'),
        srcFile('src/backend/access/transam/xlogarchive.c', 'RestoreArchivedFile'),
      ],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR) (§10.2)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and continuous archiving'),
    },
  },

  {
    id: 'archive.gate',
    title: 'Archive ownership boundary',
    subtitle: 'archive_command → WAL-G → S3',
    tldr: 'The failure line: success makes a completed segment recyclable; failure leaves it in pg_wal and retries.',
    sections: [
      {
        heading: 'What crosses this gate',
        body: 'PostgreSQL 18 calls `archive_command` only after a WAL segment closes. In this city the command runs on the primary as `wal-g wal-push %p` and writes directly to S3. The gate’s sixteen-cell meter shows the primary’s current 16 MiB segment approaching closure; no `.ready` file and no push exists before then. A zero exit means the object is durably stored. A nonzero exit leaves `.ready` in place and retries that same oldest file rather than skipping a hole.',
      },
      {
        heading: 'Why the route starts on the primary',
        body: 'The city uses the common arrangement in which the primary generates WAL and its archiver runs `wal-push`; the road therefore starts at the primary archiver and never at standby_a. PostgreSQL also permits a standby to archive restored WAL when `archive_mode = always`. That valid alternative is stated here but is not this city’s chosen topology.',
      },
      {
        heading: 'Break it here',
        body: 'Turn **WAL-G archive credentials** off. `wal-push` fails authentication in a command log that is easy to miss; the application keeps writing, completed segments queue, and `pg_wal` grows because those files are not safe to recycle. At the city’s scaled 512 MiB safety line new writes are rejected so you can watch recovery. A real filesystem does not preserve that teaching view: when the volume containing `pg_wal` fills, PostgreSQL PANICs and remains offline until an operator frees space and restarts it.',
      },
      {
        heading: 'What to alert on',
        body: 'Disk usage is the last alarm. Alert first on `.ready` files and on the distance between `pg_current_wal_lsn()` and `pg_stat_archiver.last_archived_wal`. Those two values tell you both that archiving is broken and how quickly the remaining disk budget is disappearing.',
      },
    ],
    metrics: [
      {
        label: 'Current segment',
        get: (s) => {
          const segment = currentSeg(s)
          return segment ? `${fmtBytes(segment.bytes)} / ${fmtBytes(s.wal.segmentSize)} · ${fmtPct(segment.fill, 1)}` : '—'
        },
        hint: 'nothing is queued for wal-push until this segment closes',
      },
      { label: '.ready queue', get: (s) => fmtNum(s.disasterRecovery.archive.queueSegments) },
      { label: 'pg_wal', get: (s) => `${fmtBytes(s.disasterRecovery.archive.pgWalBytes)} / ${fmtBytes(s.disasterRecovery.archive.pgWalCapacityBytes)}` },
      { label: 'Failed attempts', get: (s) => fmtNum(s.disasterRecovery.archive.failedAttempts) },
      { label: 'Write admission', get: (s) => s.disasterRecovery.archive.writesBlocked ? 'blocked at scaled limit' : 'open' },
    ],
    knobs: ['walGArchiveCredentialsValid', 'tps', 'writeRatio'],
    see: ['archiver', 'object.store', 'backup.vault'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-In-Time Recovery (PITR)'),
        { label: 'WAL-G 3.0.8 wal-push', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
        { label: 'WAL-G S3 credentials', url: 'https://wal-g.readthedocs.io/STORAGES/' },
      ],
      source: [srcFile('src/backend/postmaster/pgarch.c', 'pgarch_ArchiverCopyLoop, pgarch_archiveXlog')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and continuous archiving'),
    },
  },

  {
    id: 'timeline.yard',
    title: 'Timeline switchyard',
    subtitle: 'WAL history, not a mergeable branch',
    tldr: 'This promotion leaves one live history; a concurrent split-brain would leave two unmergeable live histories, and fencing is why the city cannot show one.',
    sections: [
      {
        heading: 'The fork in front of you is sequential',
        body: 'The old primary stopped before this standby was promoted, so only one history is accepting writes. Promotion made timeline 2 at the selected standby’s durable LSN. The former primary needs `pg_rewind` because it has a tail on timeline 1. Any other follower that already replayed past the fork cannot silently move backward either: PostgreSQL rejects timeline 2 because it does not contain that data directory’s minimum recovery point, so Patroni must rewind or reinitialise that follower too. The PostgreSQL manual’s failover and timeline sections describe the branch; the recovery code enforces the minimum recovery point.',
      },
      {
        heading: 'Restore follows history; it never merges it',
        body: `${CLAIM_VALUES.timelineRecovery.crossingDisclosure} ${CLAIM_VALUES.timelineRecovery.defaultDisclosure} ${CLAIM_VALUES.timelineRecovery.coverageDisclosure}`,
      },
      {
        heading: 'A concurrent fork is split-brain',
        body: 'True split-brain is different: the old primary and the promoted node both keep accepting writes after the same divergence point. Loss is then every transaction committed on whichever side a human rejects, for the full duration of the split—possibly hours—not only the last replication gap. The histories cannot be merged. A human must choose the authoritative history and extract anything salvageable from the loser by hand. Running `pg_rewind` on that loser is destructive rather than merely corrective: it discards work clients were told had committed while both histories were live.',
      },
      {
        heading: 'Fencing prevents the concurrent fork',
        body: 'Patroni holds a leader lock in the DCS with a time-to-live (`ttl`) and renews it during each HA cycle (`loop_wait`). If the leader cannot renew the lock, Patroni demotes PostgreSQL before the lease expires; only after the lock is free may a candidate acquire it and promote. A watchdog device is the backstop: Patroni arms it before promotion, and if Patroni crashes, stalls, or cannot stop PostgreSQL in time, the watchdog resets the machine instead of letting an unfenced primary keep serving. **Fencing means making the old primary unable to write before another can become primary.** That is why split-brain is not a normal failover outcome and why the city leaves it unreachable.',
      },
      {
        heading: 'What would have to fail',
        body: 'The old leader would have to lose the DCS yet continue accepting writes until a rival acquired the expired lock, **and** its watchdog would have to fail to stop the machine. In practice that chain comes from an absent watchdog, `ttl`, `loop_wait`, and retry timing that leaves too little real margin to demote, a watchdog device not actually wired to reset the host, or an operator overriding the leader lock or starting PostgreSQL outside Patroni. Clients must then reach both writable nodes for conflicting commits to accumulate. In a correctly configured and tested cluster this requires multiple independent failures. The realistic cause is misconfiguration—especially a fence that was never verified—not bad luck. No percentage is shown because there is no defensible public base rate from which to calculate one.',
      },
    ],
    metrics: [
      {
        label: 'Leader',
        get: (s) => s.highAvailability.currentLeader ?? 'none',
      },
      {
        label: 'Follower behind',
        get: (s) =>
          `standby_b · ${fmtBytes(s.replication.standbys[1].lagBytes)}`,
      },
      { label: 'Live timeline', get: (s) => String(s.highAvailability.timeline.current) },
      {
        label: 'Divergence point',
        get: (s) => s.highAvailability.timeline.forkLsn > 0
          ? fmtLsn(s.highAvailability.timeline.forkLsn)
          : 'no promotion yet',
      },
      {
        label: 'Loss bytes',
        get: (s) =>
          `${s.highAvailability.transition.lossBytes.toLocaleString()} bytes (${fmtBytes(s.highAvailability.transition.lossBytes)})`,
      },
      {
        label: 'Lost transactions',
        get: (s) => fmtNum(s.highAvailability.transition.lossTransactions),
      },
      {
        label: 'Former history',
        get: (s) => s.highAvailability.timeline.forkLsn > 0
          ? fmtLsn(s.highAvailability.timeline.oldHistoryEndLsn)
          : 'timeline 1 live',
      },
      {
        label: 'New history',
        get: (s) => s.highAvailability.timeline.forkLsn > 0
          ? fmtLsn(s.highAvailability.timeline.newHistoryEndLsn)
          : 'not forked',
      },
      {
        label: 'History file',
        get: (s) => s.disasterRecovery.archive.historyFileName
          ? `${s.disasterRecovery.archive.historyFileName} · ${s.disasterRecovery.archive.historyFileArchived ? 'archived' : 'missing from archive'}`
          : 'not created',
      },
    ],
    see: ['ha.dcs', 'ha.rejoin', 'object.store'],
    refs: {
      docs: [
        manual('continuous-archiving.html#BACKUP-TIMELINES', '25.3.6 Timelines'),
        manual('app-pgrewind.html', 'pg_rewind'),
        { label: 'Patroni watchdog support — split-brain fencing', url: 'https://patroni.readthedocs.io/en/latest/watchdog.html' },
        { label: 'Patroni FAQ — leader lock, ttl, loop_wait and retry_timeout', url: 'https://patroni.readthedocs.io/en/latest/faq.html' },
      ],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery'),
    },
  },

  {
    id: 'ha.dcs',
    title: 'Patroni agents and etcd consensus',
    subtitle: 'Raft, the leader key, and its renewable lease',
    tldr: 'Raft consensus gives every Patroni agent one linearizable answer about the leader key; a majority is how etcd commits that answer.',
    sections: [
      {
        heading: 'Consensus makes the key authoritative',
        body: 'One Patroni agent runs beside every PostgreSQL node. Each agent watches its local server and uses etcd’s Raft consensus for the leader key. Raft commits one ordered value in a term, so a candidate can acquire the key only through a successful compare-and-swap; the attached lease has a TTL and the holder renews it on each HA cycle. A majority is the mechanism Raft needs to commit, not a separate cluster-wide vote by Patroni. The DCS carries coordination state, not table data or WAL.',
      },
      {
        heading: 'Orderly versus unplanned',
        body: 'A planned switchover first closes write admission, lets accepted work finish, flushes the old primary, and waits until the selected standby has every byte. Only then does a compare-and-swap move the leader key and service address: downtime costs the measured wait, but data loss is zero. Unplanned failover starts with the primary gone. After the old lease expires, the candidate promotes at whatever durable LSN it already owns, so the byte gap and the committed transactions inside it are lost.',
      },
      {
        heading: 'A minority cannot commit',
        body: 'A partitioned minority is not outvoted: it cannot commit at all. Its compare-and-swap and lease renewal cannot enter the Raft log, so an isolated candidate never observes itself holding the leader key; an isolated holder demotes PostgreSQL when its last observed lease reaches its TTL. If no side has a majority, every agent clears its expired view and the cluster has no writable leader. This preserves `splitBrain = false` by giving up availability; the Timeline switchyard explains the concurrent fork that this fence prevents.',
      },
      {
        heading: 'Timing and election simplifications',
        body: 'The city runs all three Patroni HA cycles on one compressed teaching clock and deterministically chooses standby_a when a partition requires promotion. It models three etcd members, terms, commit indexes, the leader-key compare-and-swap, lease TTL, and the three stated network cuts; it does not model packet retry schedules, randomized Raft election timeouts, candidate scoring, `maximum_lag_on_failover`, synchronous-mode rules, watchdog hardware, a frozen Patroni process, or Patroni’s DCS failsafe mode. Real `ttl`, `loop_wait`, retry and consensus timing depend on configuration; the city compresses them to seconds so the lease can be watched.',
      },
    ],
    metrics: [
      {
        label: 'Leader key',
        get: (s) => s.highAvailability.patroni.dcs.leaderKey.leaseValid
          ? s.highAvailability.patroni.dcs.leaderKey.value ?? 'none'
          : 'no valid lease',
      },
      {
        label: 'Lease TTL remaining',
        get: (s) => s.highAvailability.patroni.dcs.leaderKey.leaseValid
          ? fmtDuration(s.highAvailability.patroni.dcs.leaderKey.leaseRemainingSec)
          : 'expired',
      },
      {
        label: 'Raft position',
        get: (s) => `term ${s.highAvailability.patroni.dcs.term} · commit ${s.highAvailability.patroni.dcs.commitIndex}`,
      },
      {
        label: 'Consensus',
        get: (s) => s.highAvailability.patroni.dcs.canCommit
          ? 'can commit · majority connected'
          : 'cannot commit · no majority',
      },
      { label: 'Write admission', get: (s) => s.highAvailability.acceptingWrites ? 'open' : 'closed' },
      {
        label: 'Last handover',
        get: (s) => s.highAvailability.transition.kind === 'none'
          ? 'none'
          : `${s.highAvailability.transition.kind} · ${s.highAvailability.transition.status}`,
      },
      {
        label: 'Last loss',
        get: (s) =>
          `${s.highAvailability.transition.lossBytes.toLocaleString()} bytes · ${fmtNum(s.highAvailability.transition.lossTransactions)} tx`,
      },
    ],
    knobs: ['haPartition', 'standbyANetworkLag', 'tps', 'writeRatio'],
    actions: ['start-switchover', 'trigger-failover'],
    see: ['timeline.yard', 'ha.endpoint', 'ha.rejoin', 'replica.standby'],
    refs: {
      docs: [
        { label: 'Patroni FAQ — ttl, loop_wait and retry_timeout', url: 'https://patroni.readthedocs.io/en/latest/faq.html' },
        { label: 'Patroni watchdog support — split-brain fencing', url: 'https://patroni.readthedocs.io/en/latest/watchdog.html' },
        { label: 'Patroni DCS failsafe mode and split-brain prevention', url: 'https://patroni.readthedocs.io/en/latest/dcs_failsafe_mode.html' },
        { label: 'etcd — how Raft works', url: 'https://etcd.io/docs/v3.6/learning/how-to-deal-with-membership/' },
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers — failover'),
      ],
      source: [
        { label: 'patroni/ha.py', url: 'https://github.com/patroni/patroni/blob/master/patroni/ha.py', symbol: 'Ha.run_cycle, Ha.demote' },
      ],
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery', 'the nearest honest chapter; Rogov does not cover Patroni or distributed consensus'),
    },
  },

  {
    id: 'ha.endpoint',
    title: 'Service address',
    subtitle: 'one stable client destination for the writable node',
    tldr: 'A proxy, virtual IP, DNS name or service must direct new client connections to the node that currently holds Patroni’s leader lock.',
    sections: [
      {
        heading: 'PostgreSQL does not move this address',
        body: 'PostgreSQL can promote a standby, but it does not detect primary failure or migrate a client address. A Patroni deployment normally puts a separate routing layer in front: for example, HAProxy can health-check each Patroni REST API and admit only a node whose `/primary` or `/read-write` endpoint confirms that PostgreSQL is primary and holds the leader lock. Other deployments update a virtual IP, DNS record or Kubernetes Service. The routing mechanism and its failure semantics belong to that surrounding system, not to PostgreSQL itself.',
      },
      {
        heading: 'What the city compresses',
        body: 'The city points this address at `currentLeader` when a valid leader exists and makes it dark when no node may accept writes. It treats leader-key change and endpoint movement as one visible transition. It does not model proxy health-check intervals, DNS caching, virtual-IP convergence, load-balancer configuration, connection draining or client retries. Moving an endpoint affects new connections; it cannot move an already established TCP session to another server.',
      },
    ],
    metrics: [
      { label: 'Routes writes to', get: (s) => s.highAvailability.currentLeader ?? 'no node' },
      { label: 'Leader-key lease', get: (s) => s.highAvailability.patroni.dcs.leaderKey.leaseValid ? 'valid' : 'expired' },
      { label: 'Write admission', get: (s) => s.highAvailability.acceptingWrites ? 'open' : 'closed' },
    ],
    knobs: ['haPartition', 'standbyANetworkLag'],
    actions: ['start-switchover', 'trigger-failover'],
    see: ['ha.dcs', 'timeline.yard', 'ha.rejoin', 'replica.standby'],
    refs: {
      docs: [
        manual('warm-standby-failover.html', '26.3. Failover'),
        { label: 'Patroni REST API — primary health checks for load balancers', url: 'https://patroni.readthedocs.io/en/latest/rest_api.html' },
      ],
    },
  },

  {
    id: 'ha.rejoin',
    title: 'Rejoin bay',
    subtitle: 'pg_rewind or reinitialise every node ahead of the fork',
    tldr: 'Find every data directory past the fork; rewind it when possible, otherwise copy a fresh base backup.',
    sections: [
      {
        heading: 'What pg_rewind repairs',
        body: '`pg_rewind` compares timeline history, finds the last common checkpoint, identifies data blocks changed on the former primary after divergence, and replaces those blocks from the new primary. It then prepares recovery so the repaired data directory can replay the new timeline. This is usually much smaller than copying a whole base backup, but it is not a merge: changes unique to the old primary are discarded.',
      },
      {
        heading: 'A follower can need the same decision',
        body: 'Promoting the most-lagged candidate can put every other follower past the new fork. PostgreSQL refuses to start recovery on the new timeline when it does not contain the follower’s minimum recovery point. Patroni therefore checks each ahead follower and uses `pg_rewind` when its prerequisites hold or reinitialises it from a fresh base backup. The city’s candidate drill deliberately shows the conservative full-copy path: immediately after promotion it has zero healthy standbys, not one.',
      },
      {
        heading: 'Three ways it can be impossible',
        body: 'The former primary’s data directory must still exist. Changed blocks must have been detectable: either data checksums were enabled at `initdb` time or `wal_log_hints = on` was already active; this city declares checksums off so the knob is the deciding prerequisite. Finally, the WAL needed to reach the divergence checkpoint must still be available. If any condition fails, use a fresh base backup instead.',
      },
      {
        heading: 'What the clock means',
        body: 'The city spends two teaching seconds finding the common point and checking prerequisites, then copies the measured divergent byte range at a fixed 8 MiB/s with a four-second minimum. Those values make the operation visible; they are not a production estimate. Real duration depends on database size, changed blocks, storage and network throughput, source load, archive retrieval and the WAL replay that follows.',
      },
    ],
    metrics: [
      { label: 'Required', get: (s) => s.highAvailability.rejoin.required ? 'yes — histories diverged' : 'no' },
      { label: 'Status', get: (s) => s.highAvailability.rejoin.status },
      { label: 'Diverged bytes', get: (s) => fmtBytes(s.highAvailability.rejoin.bytesRewound) },
      {
        label: 'Follower rebuild',
        get: (s) => s.highAvailability.rejoin.reinitializeNode
          ? `${s.cluster.nodes[s.highAvailability.rejoin.reinitializeNode === 'standbyA' ? 1 : 2].name} · ${fmtBytes(s.highAvailability.rejoin.reinitializeCopiedBytes)} / ${fmtBytes(s.highAvailability.rejoin.reinitializeBytes)}`
          : 'not required',
      },
      { label: 'Elapsed', get: (s) => fmtDuration(s.highAvailability.rejoin.elapsedSec) },
      {
        label: 'Result',
        get: (s) => s.highAvailability.rejoin.failureReason || (
          s.highAvailability.rejoin.status === 'complete'
            ? `following timeline ${s.highAvailability.timeline.current}`
            : 'not run'
        ),
      },
    ],
    knobs: ['walLogHints', 'oldPrimaryDataIntact', 'rewindWalRetained'],
    actions: ['start-pg-rewind'],
    see: ['timeline.yard', 'ha.dcs', 'backup.vault'],
    refs: {
      docs: [
        manual('app-pgrewind.html', 'pg_rewind'),
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers — failover'),
        { label: 'Patroni rewind and reinitialise decision', url: 'https://github.com/patroni/patroni/blob/master/patroni/postgresql/rewind.py' },
      ],
      source: [
        srcFile('src/bin/pg_rewind/pg_rewind.c', 'main'),
        srcFile('src/backend/access/transam/xlogrecovery.c', 'checkTimeLineSwitch, rescanLatestTimeLine'),
      ],
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery', 'the nearest honest chapter; Rogov does not cover pg_rewind'),
    },
  },

  {
    id: 'backup.vault',
    title: 'WAL-G base-backup objects',
    subtitle: 'backup-push → the same S3 store',
    tldr: 'Archived WAL has nothing to replay onto without a retained base backup.',
    sections: [
      {
        heading: 'The other half of PITR',
        body: 'A streaming replica and a backup answer different failures. The replica applies a bad `DELETE FROM accounts` just as faithfully as a good transaction; it protects availability when a machine dies, not history from human error. A retained full backup plus an unbroken archived WAL chain can rebuild a separate cluster to the instant before that DELETE, but only after the restore finishes.',
      },
      {
        heading: 'What this backup-push means',
        body: 'WAL-G 3.0.8 runs locally on this city’s standby_a and pushes compressed tar objects, backup-label material, metadata and the backup-stop sentinel directly to S3. The model reads the logical data-directory size at a fixed 384 MiB/s teaching rate and stores an illustrative 65% compressed size. PostgreSQL 18 still coordinates backup start and stop; at 100% copied the operation remains `waiting_wal` until the stop WAL is archived.',
      },
      {
        heading: 'Daily, on a compressed teaching clock',
        body: 'A scheduled `backup-push` starts every 60 simulated seconds; the continuity quarter calls that one day so backup age can grow and reset, three retained daily backups can expire an older one during a visit, and replay volume can grow between them. This is a cadence compression, not a recommendation to back up every minute. The fixed schedule is deliberately not another knob. Starting a manual backup begins the next 60-second interval from that start.',
      },
      {
        heading: 'WAL-G retention is an explicit command',
        body: 'The control represents `wal-g delete retain FULL n --confirm`: with only full backups modeled, it keeps the newest n full backups and deletes older recovery history. Real WAL-G defaults to a dry run without `--confirm`; it also has `delete before`, delta dependencies, permanent backups and sentinel-time ordering, none of which the city simulates. Moving the control acts as an immediate confirmed policy run, and the model reruns that scheduled policy after each successful backup.',
      },
      {
        heading: 'pgBackRest is the alternative, not a loser',
        body: 'pgBackRest 2.59.0 is a widely used alternative with `backup`, `archive-push`, `archive-get`, `expire` and `repo1-retention-full` vocabulary. A dedicated repository host is common and supported, but optional; pgBackRest can also write directly to S3, Azure or GCS. The tools differ in commands and retention mechanics. This city chooses WAL-G and does not claim either tool is universally better.',
      },
      {
        heading: 'Make the window fail',
        body: 'Lower retention, take enough full backups to expire the oldest, then select a target before the new oldest backup. The restore refuses to start. Raising the count afterwards changes future deletion but cannot recreate an object already deleted; neither can a streaming replica recreate that history.',
      },
    ],
    metrics: [
      { label: 'Full backups', get: (s) => fmtNum(s.disasterRecovery.backups.length) },
      { label: 'Expired', get: (s) => fmtNum(s.disasterRecovery.expiredBackups) },
      {
        label: 'Oldest target',
        get: (s) =>
          s.disasterRecovery.backups.length > 0
            ? `${fmtDuration(Math.max(0, s.t - s.disasterRecovery.oldestRecoverableTime))} ago`
            : 'none',
      },
      { label: 'Retention command', get: (s) => `delete retain FULL ${s.knobs.backupRetention}` },
      { label: 'Cadence', get: (s) => `daily = ${fmtDuration(s.disasterRecovery.backupSchedule.intervalSec)} teaching time` },
      {
        label: 'Next scheduled',
        get: (s) => `in ${fmtDuration(Math.max(0, s.disasterRecovery.backupSchedule.nextStartAt - s.t))}`,
        hint: 'backup-push originates on standby_a',
      },
      { label: 'Data directory', get: (s) => fmtBytes(s.disasterRecovery.dataDirectoryBytes) },
      {
        label: 'Backup progress',
        get: (s) => s.disasterRecovery.backup.status === 'copying'
          ? fmtPct(s.disasterRecovery.backup.progress)
          : s.disasterRecovery.backup.status,
      },
      { label: 'Logical bytes', get: (s) => fmtBytes(s.disasterRecovery.backup.dataBytes) },
      {
        label: 'Newest backup timeline',
        get: (s) => s.disasterRecovery.backups.length > 0
          ? String(s.disasterRecovery.backups[s.disasterRecovery.backups.length - 1].startTimeline)
          : 'no retained backup',
      },
      { label: 'Estimated copy', get: (s) => fmtDuration(s.disasterRecovery.backup.estimatedDurationSec) },
    ],
    knobs: ['backupRetention'],
    actions: ['start-full-backup'],
    see: ['replica.standby', 'object.store', 'recovery.clock'],
    refs: {
      docs: [
        { label: 'WAL-G 3.0.8 PostgreSQL commands — backup-push and delete', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
        { label: 'WAL-G delete command modes and confirmation', url: 'https://github.com/wal-g/wal-g/blob/v3.0.8/docs/README.md#delete' },
        { label: 'pgBackRest 2.59.0 user guide — backup, repositories and retention', url: 'https://pgbackrest.org/user-guide.html' },
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-In-Time Recovery (PITR)'),
        manual('app-pgbasebackup.html', 'pg_basebackup — taking a base backup from a standby'),
      ],
      source: [srcFile('src/backend/backup/basebackup.c', 'SendBaseBackup')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and continuous archiving'),
    },
  },

  {
    id: 'recovery.ground',
    title: 'Recovery ground',
    subtitle: 'a different host rebuilt from object storage',
    tldr: 'A restore drill earns evidence from the retained backup and WAL chain, then says exactly what that evidence supports.',
    sections: [
      {
        heading: 'The restore sequence',
        body: 'The recovery host begins with an empty data directory. WAL-G 3.0.8 `backup-fetch` restores the selected full backup from S3, PostgreSQL 18 sees `recovery.signal`, and `restore_command` runs `wal-g wal-fetch` while the startup process replays toward the target. A full backup without the WAL chain cannot reach the target; WAL without a full backup has no page files to start from.',
      },
      {
        heading: 'Why backup age becomes recovery time',
        body: 'Fetching the full backup costs roughly the same for two restores of the same data directory. The variable part is WAL from that backup’s start LSN through the target: it includes WAL generated while the files were copied because that WAL is required to make the backup consistent. An older backup generally means more objects to fetch and more bytes for PostgreSQL’s startup process to replay.',
      },
      {
        heading: 'Crossing the one modeled fork',
        body: `${CLAIM_VALUES.timelineRecovery.crossingDisclosure} current does not seek a newer history file: it replays the timeline current when the base backup was taken to a crossing transaction-end record when that timeline’s archived WAL contains one, or to the archived frontier before reporting that the target was not reached. ${CLAIM_VALUES.timelineRecovery.coverageDisclosure}`,
      },
      {
        heading: 'Three drills, three claims',
        body: `**${CLAIM_VALUES.restoreDrill.levels.table.label} supports:** ${CLAIM_VALUES.restoreDrill.levels.table.supports} **It does not:** ${CLAIM_VALUES.restoreDrill.levels.table.limits}

**${CLAIM_VALUES.restoreDrill.levels.cluster.label} supports:** ${CLAIM_VALUES.restoreDrill.levels.cluster.supports} **It does not:** ${CLAIM_VALUES.restoreDrill.levels.cluster.limits}

**${CLAIM_VALUES.restoreDrill.levels.verified.label} supports:** ${CLAIM_VALUES.restoreDrill.levels.verified.supports} **It does not:** ${CLAIM_VALUES.restoreDrill.levels.verified.limits}`,
      },
      {
        heading: 'Checksum names matter',
        body: `${CLAIM_VALUES.restoreDrill.checksumDisclosure} ${CLAIM_VALUES.restoreDrill.smokeDisclosure} A checksum match detects changed or missing bytes covered by that manifest; it does not prove the application’s data is semantically correct. A real smoke query adds one expected-result claim, not a proof about every row. WAL-G’s \`wal-verify integrity\` checks whether the required WAL objects exist. pgBackRest’s \`check\` validates its repository and archive path, forces a WAL switch, and confirms that the new segment reaches the repository.`,
      },
      {
        heading: 'Cost and cadence are policy',
        body: `The restore-to-target time starts before \`backup-fetch\` and stops only after archived-WAL replay encounters a transaction-end record whose timestamp crosses the selected target. If the selected history ends first, recovery fails instead of inferring time from an unchanged LSN. This is not RTO: promotion, \`recovery_target_action\`, endpoint cutover, client reconnection, and service restoration are outside it. The drill continues while validation reads local restored bytes. Object-store reads and recovery-host I/O are counted; this off-site ground never reads from the primary. ${CLAIM_VALUES.restoreDrill.physicalScopeDisclosure} ${CLAIM_VALUES.restoreDrill.cadenceDisclosure}`,
      },
      {
        heading: 'Replication is not this',
        body: 'A replica continuously replays the newest WAL and can take traffic quickly after separate HA work promotes it. This recovery host intentionally walks backward into retained history, so it can escape a destructive transaction that every replica already applied. It protects data history at the cost of recovery time; it does not provide failover, and this PITR operation never promotes it.',
      },
    ],
    metrics: [
      {
        label: 'Drill verdict',
        get: (s) => s.disasterRecovery.drill.status === 'idle'
          ? 'not run'
          : s.disasterRecovery.drill.status,
      },
      {
        label: 'Last result level',
        get: (s) => s.disasterRecovery.drill.status === 'idle'
          ? 'not run'
          : CLAIM_VALUES.restoreDrill.levels[s.disasterRecovery.drill.level].label,
      },
      {
        label: 'Restore-to-target time',
        get: (s) => s.disasterRecovery.drill.measuredRestoreToTargetSec > 0
          ? `${fmtDuration(s.disasterRecovery.drill.measuredRestoreToTargetSec)} measured`
          : s.disasterRecovery.drill.status === 'restoring'
              || s.disasterRecovery.drill.status === 'verifying'
              || s.disasterRecovery.drill.status === 'querying'
            ? `${fmtDuration(s.disasterRecovery.drill.estimatedRestoreToTargetSec)} estimate`
            : 'not measured',
        hint: CLAIM_VALUES.restoreDrill.timeDisclosure,
      },
      { label: 'Backup age', get: (s) => fmtDuration(s.disasterRecovery.drill.backupAgeSec) },
      { label: 'WAL to replay', get: (s) => fmtBytes(s.disasterRecovery.drill.walBytesRequired) },
      {
        label: 'Timeline path',
        get: (s) => s.disasterRecovery.restore.crossesTimelineFork
          ? `${s.disasterRecovery.restore.backupTimeline} → ${s.disasterRecovery.restore.targetTimeline} via ${s.disasterRecovery.restore.historyFileName}`
          : s.disasterRecovery.restore.targetTimeline > 0
            ? `timeline ${s.disasterRecovery.restore.targetTimeline} · no fork crossed`
            : 'not selected',
      },
      { label: 'Object reads', get: (s) => fmtBytes(s.disasterRecovery.drill.objectStoreBytesRead) },
    ],
    knobs: ['recoveryTargetAge', 'recoveryTargetTimeline', 'walGDownloadConcurrency', 'restoreDrillFault'],
    actions: ['start-restore-drill'],
    see: ['backup.vault', 'recovery.clock', 'restore.winch', 'recovery.replay'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3.5 Recovering Using a Continuous Archive Backup'),
        manual('app-pgverifybackup.html', 'pg_verifybackup — backup-manifest verification'),
        manual('app-pgrestore.html', 'pg_restore — selective logical-archive restore'),
        { label: 'WAL-G 3.0.8 backup-fetch, wal-fetch, wal-verify and backup-push', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
        { label: 'pgBackRest 2.59.0 restore, verify, and archive-get alternative', url: 'https://pgbackrest.org/user-guide.html' },
      ],
      source: [srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery, InitWalRecovery')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and checkpoint mechanics'),
    },
  },

  {
    id: 'recovery.clock',
    title: 'recovery_target_time',
    subtitle: 'the selected stop point for PITR',
    tldr: 'Choose history still covered by a retained backup, the requested timeline, and an unbroken archived WAL chain.',
    sections: [
      {
        heading: 'Choosing the point',
        body: 'Set the target to a number of seconds before now, then start the restore. The model chooses the newest retained full backup that completed before that target and computes the WAL distance from the backup’s **start LSN** to the first transaction-end record on the selected history whose timestamp crosses the target. That includes WAL written during the copy, which is what makes the files consistent. In production use PostgreSQL 18’s timestamp including its time-zone offset, and investigate the destructive transaction carefully: finding the right instant is often harder than running the restore.',
      },
      {
        heading: 'Three distinct gaps',
        body: 'A target before the oldest retained full backup has two modeled causes. If older backups expired, a larger future `wal-g delete retain FULL` count can preserve a wider window; if no backup was ever taken early enough, changing retention cannot create that missing history. A target newer than the live archive frontier also has two causes. With a healthy empty queue and valid credentials, it is inside the current unarchived 16 MiB segment: that normal tail is the archive-only RPO floor, and `archive_timeout` shortens it at the cost of padded segments. Invalid credentials or a disabled archive-recovery chain are actual archive faults that need repair and `.ready`-queue drainage. After failover, PostgreSQL copies the partial fork segment into timeline 2; once that timeline-2 segment is archived, a history following the fork can read its timeline-1 parent records through the fork. Any earlier complete timeline-1 segments missing from object storage remain a real gap: this archive_mode=on standby did not archive them during recovery, and neither the copied fork segment nor a streaming replica can recreate them.',
      },
      {
        heading: 'Choosing the history',
        body: `${CLAIM_VALUES.timelineRecovery.defaultDisclosure} ${CLAIM_VALUES.timelineRecovery.crossingDisclosure} ${CLAIM_VALUES.timelineRecovery.coverageDisclosure}`,
      },
      {
        heading: 'Where this restore stops',
        body: 'The belt stops only when replay encounters a transaction-end record whose timestamp crosses the target. A history file alone is not that evidence: if the selected history ends first, PostgreSQL reports that recovery ended before the configured recovery target was reached. PostgreSQL could then pause, shut down, or promote according to recovery settings and operator procedure after a successful stop, but promotion would fork another timeline and is a separate HA action. The city records `promoted = false` for this restore and does not move the service endpoint.',
      },
    ],
    metrics: [
      { label: 'Target', get: (s) => `${s.knobs.recoveryTargetAge}s ago` },
      { label: 'Timeline setting', get: (s) => `recovery_target_timeline=${s.knobs.recoveryTargetTimeline}` },
      { label: 'Selected backup age', get: (s) => fmtDuration(s.disasterRecovery.restore.backupAgeSec) },
      {
        label: 'Timeline result',
        get: (s) => s.disasterRecovery.restore.targetTimeline > 0
          ? `backup ${s.disasterRecovery.restore.backupTimeline} → target ${s.disasterRecovery.restore.targetTimeline}`
          : 'not selected',
      },
      { label: 'Progress', get: (s) => fmtPct(s.disasterRecovery.restore.progress) },
      {
        label: 'Result',
        get: (s) => {
          const restore = s.disasterRecovery.restore
          return restore.failureReason || restore.resultMessage || restore.status
        },
      },
    ],
    knobs: ['recoveryTargetAge', 'recoveryTargetTimeline'],
    actions: ['start-pitr'],
    see: ['backup.vault', 'object.store', 'recovery.ground', 'recovery.replay'],
    refs: {
      docs: [
        manual('runtime-config-wal.html#RUNTIME-CONFIG-WAL-RECOVERY-TARGET', 'Recovery Target Settings'),
        { label: 'WAL-G 3.0.8 PostgreSQL restore commands', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
      ],
      source: [srcFile('src/backend/access/transam/xlogrecovery.c', 'recoveryStopsAfter, recoveryStopsBefore')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR) (§10.2)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery'),
    },
  },

  {
    id: 'restore.winch',
    title: 'restore_command',
    subtitle: 'archived WAL retrieval',
    tldr: 'Retrieves the next segment PostgreSQL asks for; a missing segment breaks the chain.',
    sections: [
      {
        heading: 'Tool command and PostgreSQL contract',
        body: 'For the modeled WAL-G 3.0.8 object store, PostgreSQL 18’s `restore_command` calls `wal-g wal-fetch %f %p`. PostgreSQL supplies the requested object name and destination path, then replays the returned segment. WAL-G distinguishes a missing object from other I/O failures; the wrapper must return an exit status PostgreSQL handles correctly rather than inventing success.',
      },
      {
        heading: 'One chain, no gaps',
        body: 'Recovery consumes WAL records in order from the backup start checkpoint’s redo point toward the target, but object GETs need not be serial. WAL-G uses `WALG_DOWNLOAD_CONCURRENCY` for concurrent `backup-fetch` work and `wal-fetch` prefetch. The city’s one hook means ordered PostgreSQL replay; the control changes modeled fetch supply while replay itself remains capped at one 24 MiB/s teaching stream.',
      },
    ],
    metrics: [
      { label: 'WAL required', get: (s) => fmtBytes(s.disasterRecovery.restore.walBytesRequired) },
      { label: 'WAL replayed', get: (s) => fmtBytes(s.disasterRecovery.restore.walBytesReplayed) },
      {
        label: 'WAL object GETs',
        get: (s) => {
          const backup = s.disasterRecovery.backups.find((item) => item.id === s.disasterRecovery.restore.backupId)
          if (!backup || s.disasterRecovery.restore.targetLsn <= 0) return '0'
          const replayEndLsn = backup.startLsn + s.disasterRecovery.restore.walBytesRequired
          return fmtNum(Math.max(
            0,
            Math.floor(replayEndLsn / s.wal.segmentSize)
              - Math.floor(backup.startLsn / s.wal.segmentSize)
              + 1,
          ))
        },
        hint: 'segment-object GETs from backup start through the actual replay end; retries, metadata and base-backup objects add more requests',
      },
      {
        label: 'Live-timeline frontier',
        get: (s) => `timeline ${s.disasterRecovery.archive.timeline} · ${fmtLsn(s.disasterRecovery.archive.archivedThroughLsn)}`,
      },
      {
        label: 'Parent frontier',
        get: (s) => s.disasterRecovery.archive.parentTimeline > 0
          ? `timeline ${s.disasterRecovery.archive.parentTimeline} · ${fmtLsn(s.disasterRecovery.archive.parentArchivedThroughLsn)}`
          : 'no fork',
        hint: 'what object storage actually held at promotion; a shortfall to the fork remains a real recovery gap',
      },
    ],
    knobs: ['walGDownloadConcurrency'],
    see: ['object.store', 'recovery.replay', 'recovery.clock'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3.5 Recovering Using a Continuous Archive Backup'),
        { label: 'WAL-G 3.0.8 wal-fetch and download concurrency', url: 'https://wal-g.readthedocs.io/PostgreSQL/' },
        { label: 'pgBackRest 2.59.0 archive-get alternative', url: 'https://pgbackrest.org/user-guide.html' },
      ],
      source: [srcFile('src/backend/access/transam/xlogarchive.c', 'RestoreArchivedFile')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery'),
    },
  },

  {
    id: 'recovery.replay',
    title: 'Recovery replay belt',
    subtitle: 'PostgreSQL startup process',
    tldr: 'Replays WAL from the restored backup to the selected point, then stops.',
    sections: [
      {
        heading: 'What PostgreSQL does',
        body: 'The startup process reads each WAL record in order and applies the recorded page changes to the restored data directory. This is the same fundamental replay mechanism used for crash recovery and a physical standby, but the source here is an archive and the configured target tells recovery where to stop.',
      },
      {
        heading: 'The measured simplification',
        body: 'Replay is capped at a fixed 24 MiB/s teaching rate after a 640 MiB/s base-backup fetch cap. Lower `WALG_DOWNLOAD_CONCURRENCY` can make object-fetch supply slower than either cap. These scaled rates do not estimate production hardware. What is real is the dependency: required replay bytes are the target LSN minus the selected backup’s **start LSN**, so the calculation includes WAL written during the copy.',
      },
    ],
    metrics: [
      { label: 'Replay progress', get: (s) => fmtPct(s.disasterRecovery.restore.walBytesRequired > 0 ? s.disasterRecovery.restore.walBytesReplayed / s.disasterRecovery.restore.walBytesRequired : 0) },
      { label: 'Target LSN', get: (s) => fmtLsn(s.disasterRecovery.restore.targetLsn) },
      { label: 'Promoted', get: (s) => s.disasterRecovery.restore.promoted ? 'yes' : 'no — separate HA action' },
    ],
    see: ['restore.winch', 'recovery.clock', 'recovery.ground'],
    refs: {
      docs: [manual('continuous-archiving.html', '25.3.5 Recovering Using a Continuous Archive Backup')],
      source: [srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and checkpoint mechanics'),
    },
  },

  {
    id: 'walsender',
    title: 'WAL sender',
    subtitle: 'background process, one per consumer',
    tldr: 'Streams WAL to a standby or subscriber, and holds WAL segments on disk on that consumer’s behalf.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'A standby connects to the primary on the normal port with a replication connection, and the postmaster forks a **walsender** dedicated to it. That process reads WAL — since PostgreSQL 17 straight out of `wal_buffers` when the data is still hot, otherwise from the segment files — and pushes it down the socket as it is produced, rather than waiting for a segment to fill. One walsender exists per connected standby or logical subscriber, and each appears as a row in `pg_stat_replication`.',
      },
      {
        heading: 'Replication slots',
        body: 'Without a slot, the primary has no durable record of what a disconnected consumer still needs, so one that is down beyond available WAL may require a rebuild. For both physical and logical slots, `restart_lsn` is the oldest WAL that might still be required and therefore governs retention. A logical slot’s separate `confirmed_flush_lsn` records how far its consumer has acknowledged receiving decoded data; it can be ahead of `restart_lsn` and must not be used to estimate retained WAL. See `pg_replication_slots` before deciding that a slot is safe to remove.',
      },
      {
        heading: 'How a slot takes down a primary',
        body: `By default, inactive permanent slots do not expire: in PostgreSQL 18, \`idle_replication_slot_timeout\` defaults to zero (disabled). An abandoned consumer can pin \`restart_lsn\` while \`pg_wal\` grows toward a full volume, but the retention guard spends continuity to protect the primary.\n\n${renderAction('limitSlotWalRetention')}`,
      },
      {
        heading: 'What you would see in production',
        body: `In \`pg_stat_replication\`, compare the four LSNs as stage boundaries. A primary-to-sent gap focuses on transmission; sent-to-write focuses between sender and receiver; flush ahead of replay focuses on apply. If the row disappears, the walsender is gone and any surviving slot may retain WAL.\n\n${renderAction('restoreReplayCapacity')}`,
      },
      {
        heading: 'What the city models',
        body: 'The city advances independent sent LSNs, delayed acknowledgement queues and physical-slot retention for two followers. It does not fork a walsender, read WAL buffers or segment files, open replication-protocol sockets, schedule a process or expose a real pg_stat_replication row.',
      },
    ],
    metrics: [
      { label: 'standby_a sent', get: (s) => fmtLsn(s.replication.standbys[0].sentLsn) },
      { label: 'standby_b sent', get: (s) => fmtLsn(s.replication.standbys[1].sentLsn) },
      {
        label: 'standby_a slot',
        get: (s) => s.replication.physicalSlots[0].exists
          ? `${s.replication.physicalSlots[0].active ? 'active' : 'inactive'} · ${fmtBytes(s.replication.physicalSlots[0].retainedBytes)} retained`
          : 'dropped · no retention guarantee',
      },
      {
        label: 'standby_b slot',
        get: (s) => s.replication.physicalSlots[1].exists
          ? `${s.replication.physicalSlots[1].active ? 'active' : 'inactive'} · ${fmtBytes(s.replication.physicalSlots[1].retainedBytes)} retained`
          : 'dropped · no retention guarantee',
      },
      {
        label: 'Records in flight',
        get: (s) => fmtNum(s.replication.standbys[0].inFlight + s.replication.standbys[1].inFlight),
      },
    ],
    knobs: ['standbyAEnabled', 'standbyBEnabled', 'standbyANetworkLag', 'standbyBNetworkLag', 'synchronousCommit', 'walLevel'],
    see: ['net.wire', 'walreceiver', 'standby.b.receiver', 'wal.vault', 'logical.decoder'],
    source: ['src/backend/replication/walsender.c', 'src/backend/replication/slot.c'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_replication'),
        manual('view-pg-replication-slots.html', 'pg_replication_slots'),
        manual('runtime-config-replication.html', 'Replication configuration — slot retention and timeout'),
      ],
      source: [
        srcFile('src/backend/replication/walsender.c', 'XLogSendPhysical, WalSndLoop'),
        srcFile('src/backend/replication/slot.c', 'ReplicationSlotCreate, ReplicationSlotsComputeRequiredLSN'),
      ],
      suzuki: suzuki(11, 'Streaming Replication (§11.4 Replication Slots)'),
    },
  },

  {
    id: 'logical.decoder',
    title: 'Logical decoding',
    subtitle: 'WAL turned into rows',
    tldr: 'Reads physical WAL and reconstructs the row-level INSERT/UPDATE/DELETE stream behind it.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'Physical WAL says "on page 1274 of relfilenode 16391, put these bytes at line pointer 7". That is useless to anything but an identical copy of the database. Logical decoding walks the same WAL, uses the system catalogs to work out that page 1274 belongs to `public.orders` and that those bytes are a row, and hands an **output plugin** a clean stream of tuples: table, operation, old and new values. `pgoutput` is the built-in plugin that native logical replication uses; `wal2json` and `test_decoding` are the ones you use to look at the stream by hand.',
      },
      {
        heading: 'What it needs from you',
        body: 'It requires `wal_level = logical`, which is a restart, and which makes WAL bigger because extra information has to be logged for decoding to be possible at all. It also requires a **replica identity** on any table you UPDATE or DELETE: by default that is the primary key, and a table with no primary key will error out unless you set `REPLICA IDENTITY FULL` (which logs the entire old row into WAL — correct, and expensive). Finally, it needs a logical slot, with all the disk-filling risk that carries.',
      },
      {
        heading: 'The reorder buffer',
        body: 'WAL is written in the order changes happened, interleaved across concurrent transactions, and it contains work from transactions that later rolled back. Consumers want committed transactions, whole, in commit order. The **reorder buffer** is what bridges that: it spools each transaction’s changes in memory until it sees the commit record, then emits them as a unit and discards aborted ones. Transactions bigger than `logical_decoding_work_mem` spill to disk, which is why one enormous batch UPDATE can stall an otherwise healthy CDC pipeline. PostgreSQL 14 added streaming of in-progress transactions to soften that.',
      },
      {
        heading: 'What it is used for',
        body: 'Everything that calls itself CDC: native publications and subscriptions, Debezium, cross-major-version upgrades with near-zero downtime, selective replication into a data warehouse. The catch is that decoding is single-threaded per slot and runs on the machine holding the slot, so a busy primary with three CDC consumers is doing that reconstruction work three times.',
      },
      {
        heading: 'What the city models',
        body: 'The city derives an illustrative changes-per-second rate from modeled writes, adds representative logical-WAL overhead and advances one collapsed slot LSN. It does not decode WAL into row values, group changes into transactions, filter publications, preserve commit order, spill a reorder buffer or maintain subscriber tables.',
      },
    ],
    metrics: [
      {
        label: 'Decoding',
        get: (s) => (s.knobs.walLevel === 'logical' ? (s.replication.logicalEnabled ? 'active' : 'idle') : 'off — wal_level is not logical'),
      },
      { label: 'Changes / s', get: (s) => fmtNum(s.replication.logicalEnabled ? s.replication.logicalChangesPerSec : 0), hint: 'derived rate projection; no WAL rows are decoded' },
      { label: 'Confirmed flush (model)', get: (s) => (s.replication.logicalEnabled ? fmtLsn(s.replication.logicalSlotLsn) : '—'), hint: 'the model collapses logical restart_lsn to this same position; real slots expose both' },
      {
        label: 'WAL held by the slot',
        get: (s) =>
          !s.replication.logicalEnabled
            ? 'nothing — no slot exists'
            : fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.logicalSlotLsn)),
        hint: 'model estimate from a collapsed slot position; real retention is measured from restart_lsn',
      },
    ],
    knobs: ['walLevel', 'writeRatio', 'updateRatio', 'tps'],
    see: ['subscriber', 'walsender', 'wal.vault', 'replica.standby'],
    source: [
      'src/backend/replication/logical/decode.c',
      'src/backend/replication/logical/reorderbuffer.c',
      'src/backend/replication/slot.c',
    ],
    refs: {
      docs: [manual('logicaldecoding.html', 'Chapter 47. Logical Decoding')],
      source: [
        srcFile('src/backend/replication/logical/decode.c', 'LogicalDecodingProcessRecord'),
        srcFile('src/backend/replication/logical/reorderbuffer.c', 'ReorderBufferProcessTXN, ReorderBufferCommit'),
      ],
      suzuki: suzuki(12, 'Logical Replication (§12.3 ReorderBuffer Structure — the author still marks this chapter beta)'),
    },
  },

  /* ======================================================================
   * Storage
   * ====================================================================*/
  {
    id: 'storage.datadir',
    title: 'Data directory',
    subtitle: 'the data directory on disk',
    tldr: 'Every byte the cluster owns, arranged as numbered files that deliberately do not carry table names.',
    sections: [
      {
        heading: 'The layout',
        body: '`base/` holds one subdirectory per database, named by the database OID, and inside it one set of files per relation. `global/` holds the objects shared by every database — `pg_database`, `pg_authid`, the control file. `pg_wal/` is the write-ahead log, `pg_xact/` the commit-status bitmap, `pg_tblspc/` symlinks to tablespaces. `PG_VERSION` is a one-line text file, and `pg_control` is the small binary file holding the redo point and cluster state that recovery reads first.',
      },
      {
        heading: 'What a relation file really is',
        body: 'A table is a file whose name is a number, containing 8 KiB pages back to back with no header and no metadata: block 0 starts at byte 0, block N at byte 8192×N. When a file reaches 1 GiB, Postgres starts a new one with a `.1`, `.2`, … suffix, because that limit predates large-file support everywhere and is now simply how it works. Alongside the main fork sit `_fsm` (free space map), `_vm` (visibility map) and, for unlogged relations, `_init`.',
      },
      {
        heading: 'relfilenode is not oid',
        body: 'A table has an **OID**, its permanent identity in `pg_class`, and a **relfilenode**, the number of the file currently holding its data. They usually start out equal and then diverge: `VACUUM FULL` and `CLUSTER` rewrite the heap, `TRUNCATE` replaces it with an empty file, and some `ALTER TABLE`s also replace its storage. Those operations write a new file and swap the pointer, which makes them crash-safe. `REINDEX TABLE` is different: it rebuilds the table’s indexes and can change their filenodes, but does not rewrite or replace the heap or change its relfilenode. Use `pg_relation_filepath(\'orders\')` rather than guessing. A handful of bootstrap catalogs report relfilenode 0 and are located through `pg_filenode.map` instead, because you cannot read a catalog to find the catalog.',
      },
      {
        heading: 'What you would see in production',
        body: 'You go looking for the file eating your disk, find `base/16384/24591.3`, and it tells you nothing. Map it back with `SELECT relname FROM pg_class WHERE relfilenode = 24591`. Two more habits worth having: never touch anything inside the data directory while the server is running, and remember that `du` on the directory and `pg_database_size()` can disagree because of deleted-but-still-open files.',
      },
      {
        heading: 'What the city models',
        body: 'The engine keeps aggregate heap and index page counts per table plus WAL segment state. It does not create a data-directory tree, relation forks, relfilenodes, 1 GiB segments, database OIDs, tablespaces, pg_control, deleted files or filesystem allocation. The declared relation total below includes illustrative schema metadata such as a TOAST sidecar even though no TOAST relation state exists.',
      },
    ],
    metrics: [
      {
        label: 'Heap files',
        get: (s) => fmtBytes(sumTables(s, (t) => t.pages) * PAGE),
        hint: 'sum of all table main forks in the model',
      },
      {
        label: 'Index files',
        get: (s) => fmtBytes(sumTables(s, (t) => t.indexPages) * PAGE),
      },
      { label: 'pg_wal', get: (s) => fmtBytes(walDirBytes(s)) },
      { label: 'Declared relation shapes', get: (s) => fmtNum(sumTables(s, (t) => 1 + t.def.indexes.length + (t.def.toast ? 2 : 0))), hint: 'schema/renderer count; not stored relation objects' },
    ],
    see: ['storage.table', 'storage.index', 'wal.vault', 'disk.array'],
    source: ['src/backend/storage/smgr/md.c'],
    refs: {
      docs: [
        manual('storage-file-layout.html', '66.1. Database File Layout'),
        manual('storage.html', 'Chapter 66. Database Physical Storage'),
      ],
      source: [
        srcFile('src/backend/storage/smgr/md.c', 'mdextend, mdwritev, register_dirty_segment'),
        srcFile('src/backend/catalog/storage.c', 'RelationCreateStorage, RelationDropStorage'),
      ],
      suzuki: suzuki(1, 'Database Cluster, Databases and Tables (§1.2)'),
      rogov: rogov(R_MVCC, 'Introduction — data organization'),
    },
  },

  {
    id: 'storage.tempfiles',
    title: 'base/pgsql_tmp',
    subtitle: 'executor spill files',
    tldr: 'Sort and hash operations write temporary files when their working data exceeds the memory allowed to that operation.',
    sections: [
      {
        heading: 'Why files appear here',
        body: '`work_mem` is a base limit per query operation, not per query or server. A Sort can spill after crossing it; a hash operation uses `work_mem × hash_mem_multiplier` as its limit. With the default tablespace, PostgreSQL creates these files under the data directory’s `base/pgsql_tmp`; a non-default temporary tablespace gets its own `pgsql_tmp` directory. `pg_stat_database.temp_files` and `temp_bytes` are cumulative database-wide counters, while `EXPLAIN (ANALYZE)` shows the spill for one executed plan.',
      },
      {
        heading: 'What the city models',
        body: 'Only fixed Sort and HashAggregate nodes spill here; join nodes and their spills are absent. The model compares fixed teaching working sets with the Sort or hash allowance, charges one illustrative write-and-read pass to shared storage pressure, and increments counters shaped like `temp_files` and `temp_bytes`. It creates no files, does not choose a different plan when `work_mem` changes, and does not model multi-pass external sorts, temporary tables, tablespaces or `temp_file_limit` cancellation.',
      },
    ],
    metrics: [
      { label: 'Spilling now', get: (s) => fmtNum(s.workMem.spillingNodes), hint: 'modeled Sort and HashAggregate nodes' },
      { label: 'Live spill bytes', get: (s) => fmtBytes(s.workMem.liveTempBytes) },
      { label: 'Cumulative', get: (s) => `${fmtNum(s.workMem.tempFiles)} files · ${fmtBytes(s.workMem.tempBytes)}` },
    ],
    knobs: ['workMem', 'tps'],
    see: ['backend.localmem', 'planner.plantree', 'disk.array'],
    source: ['src/backend/utils/sort/tuplesort.c', 'src/backend/executor/nodeAgg.c', 'src/backend/storage/file/buffile.c'],
    refs: {
      docs: [
        manual('runtime-config-resource.html#GUC-WORK-MEM', '19.4.1. Memory — work_mem'),
        manual('runtime-config-resource.html#GUC-TEMP-FILE-LIMIT', '19.4.2. Disk — temp_file_limit'),
        manual('monitoring-stats.html#MONITORING-PG-STAT-DATABASE-VIEW', '27.2.17. pg_stat_database — temp_files and temp_bytes'),
        manual('storage-file-layout.html', '66.1. Database File Layout'),
      ],
      source: [
        srcFile('src/backend/utils/sort/tuplesort.c', 'tuplesort_performsort'),
        srcFile('src/backend/executor/nodeAgg.c', 'hash_agg_enter_spill_mode, hashagg_spill_tuple'),
        srcFile('src/backend/storage/file/buffile.c', 'BufFileCreateTemp, BufFileWrite'),
      ],
    },
  },

  {
    id: 'storage.table',
    title: 'Heap file',
    subtitle: 'a table on disk',
    tldr: 'A stack of 8 KiB pages holding row versions, where an UPDATE writes a new one and leaves the old behind.',
    sections: [
      {
        heading: 'Inside one 8 KiB page',
        body: 'Every page has the same shape. A 24-byte header at the front records the page’s LSN and where its free space begins and ends. Immediately after it grows an array of 4-byte **line pointers**, one per tuple slot, added front to back. Tuples themselves are written from the **end** of the page backwards. Free space is the shrinking gap in the middle, and a tuple is addressed by its `ctid` — the pair (block number, line pointer index) — which is why `ctid` is stable only until something moves the row.',
      },
      {
        heading: 'MVCC: row versions, not rows',
        body: 'Each tuple carries a 23-byte header, including `xmin` (the transaction that created this version) and `xmax`, which can record a transaction ID or MultiXact involved in deleting, updating, or locking it. Only an effective committed deleting or updating XID makes the old version dead. A lock-only `xmax` does not: `HEAP_XMAX_LOCK_ONLY` means the header records only a row lock, so the tuple remains live even after that locker commits. If `heap_page_items` shows a MultiXact, inspect its members and the tuple flags rather than treating the raw `xmax` as a deleting transaction. An UPDATE does not overwrite the old tuple’s user-column values: it writes a **new version** and modifies the old tuple header, including `xmax`, in place; DELETE likewise changes the existing header. Hint bits and page metadata are also updated in place. Your snapshot decides which versions you can see. This is why a table with 1 million logical rows can physically contain many more tuple versions, and why "rows" and "row versions" are not synonyms when debugging.',
      },
      {
        heading: 'HOT updates and page pruning',
        body: 'Writing a new version normally means inserting into every ordinary index too, because each entry points at a physical tuple. **HOT** — Heap Only Tuple — avoids those new entries when the new version fits on the same page and no changed column is referenced by an ordinary non-summarizing index. In PostgreSQL 18 — a rule introduced in PostgreSQL 16 — a changed column covered only by a summarizing index does not block HOT; the core summarizing index method is **BRIN**. That exception does not make the update index-free: the summarizing index may still require maintenance. The new version goes on the same heap page as a **heap-only tuple**; the old version’s `t_ctid` points at it, the two form a HOT chain, and existing ordinary index entries keep pointing at the original line pointer so an index scan can walk the chain. Any backend that later reads a prunable page can run **page pruning** on the spot, throwing away dead versions without waiting for vacuum — and that is when the original line pointer becomes a **redirect** to the first live tuple, keeping those ordinary index entries valid without adding replacements. Chase `n_tup_upd` versus `n_tup_hot_upd` in `pg_stat_user_tables`; a low ratio on a hot table usually means an ordinary index references a frequently-updated column, or the default heap `fillfactor` of 100 leaves a freshly filled page no room for the new version — lowering it to around 90 on an update-heavy table buys HOT that room.',
      },
      {
        heading: 'What bloat physically is',
        body: `Bloat is dead tuples and empty line pointers occupying pages that the table still owns. It hurts because a sequential scan reads dead space and the cache holds pages with fewer useful rows. A HOT update creates no new ordinary-index tuple-pointer entries; a non-HOT update creates new entries, but reuse and cleanup mean no single update guarantees that every index file grows. Over time, non-HOT churn can still bloat heap and indexes and enlarge the working set. ${CLAIM_VALUES.vacuumReclaim.rule} Rewriting tools are needed when returning most of the table's allocation matters.`,
      },
      {
        heading: 'In the real thing',
        body: 'The city draws each table as a slab whose height is its page count and whose colour shows the dead-tuple ratio, which is honest about proportions and silent about detail. It does not model column order and alignment padding (real tables waste several percent to it), or per-tuple null bitmaps, or the fact that `pg_stat_user_tables.n_dead_tup` is a statistics estimate rather than a count. For the real numbers on a suspect table, use `pgstattuple`, and expect it to read every page.',
      },
    ],
    metrics: [
      { label: 'Total size', get: (s) => fmtBytes(sumTables(s, (t) => t.pages) * PAGE) },
      { label: 'Live rows', get: (s) => fmtNum(sumTables(s, (t) => t.liveTuples)) },
      {
        label: 'Dead row versions',
        get: (s) => {
          const dead = sumTables(s, (t) => t.deadTuples)
          const live = sumTables(s, (t) => t.liveTuples)
          return `${fmtNum(dead)} (${fmtPct(ratio(dead, dead + live), 1)})`
        },
        hint: 'superseded versions waiting for vacuum',
      },
      {
        label: 'HOT share',
        get: (s) => fmtPct(ratio(sumTables(s, (t) => t.hotUpdates), sumTables(s, (t) => t.updates)), 0),
        hint: 'updates with no new ordinary-index entries; PostgreSQL 18 may still maintain BRIN summaries',
      },
      {
        label: 'Worst table',
        get: (s) => {
          const w = worstBloat(s)
          return w ? `${w.def.name} · ${fmtPct(w.bloat, 1)} dead` : '—'
        },
      },
    ],
    knobs: ['updateRatio', 'writeRatio', 'autovacuum', 'autovacuumScaleFactor', 'longRunningXact'],
    see: ['storage.index', 'storage.toast', 'autovac.worker', 'storage.fsm'],
    source: [
      'src/backend/access/heap/heapam.c',
      'src/backend/access/heap/hio.c',
      'src/backend/access/heap/pruneheap.c',
    ],
    refs: {
      docs: [
        manual('storage-page-layout.html', '66.6. Database Page Layout'),
        manual('storage-hot.html', '66.7. Heap-Only Tuples (HOT)'),
      ],
      source: [
        srcFile('src/backend/access/heap/heapam.c', 'heap_update'),
        srcFile('src/backend/access/heap/pruneheap.c', 'heap_page_prune_opt, heap_page_prune_and_freeze, heap_prune_record_redirect'),
      ],
      suzuki: suzuki(1, 'Database Cluster, Databases and Tables (§1.3 Heap Table Structure; HOT itself is ch. 7)'),
      rogov: rogov(R_MVCC, 'Pages and Tuples; Page Pruning and HOT Updates'),
    },
  },

  {
    id: 'storage.index',
    title: 'Index',
    subtitle: 'a separate file pointing back at the heap',
    tldr: 'A sorted structure of keys and heap pointers — fast lookups, paid for on every write.',
    sections: [
      {
        heading: 'What a B-tree looks like',
        body: 'A Postgres B-tree is a shallow tree of 8 KiB pages: a root, one or two internal levels, and the leaves that hold the actual keys. Even a table with a billion rows is typically four levels deep, so a unique lookup is a handful of page reads, usually all cached above the leaf. The leaf level is a **doubly linked list** in key order, which is the part people forget: it is why `ORDER BY id LIMIT 10` can be free, why range predicates are cheap, and why a backwards `ORDER BY … DESC` costs the same as forwards.',
      },
      {
        heading: 'Why the index alone is not enough',
        body: 'Index entries store the key and a heap `ctid`, and nothing about visibility. So a normal index scan must fetch the heap tuple to find out whether that row version is visible to you — the index can tell you where, never whether. An **index-only scan** escapes that by consulting the visibility map: if the whole heap page is marked all-visible, the heap fetch is skipped. That is why index-only scans quietly degrade into ordinary index scans on a heavily-updated table, and why `EXPLAIN (ANALYZE)` prints `Heap Fetches` — a high number there means vacuum is not keeping up, not that your index is wrong.',
      },
      {
        heading: 'Bloat and rebuilding',
        body: 'Index pages do not compact themselves. Deletes and non-HOT updates leave entries that vacuum must remove, and pages that end up half empty stay half empty unless they become completely empty. A 40 GiB index over a 30 GiB table is a normal sight on an update-heavy workload. Since PostgreSQL 14, **bottom-up index deletion** cleans version churn before a page is allowed to split, which dramatically reduces this on tables whose updates repeatedly touch the same indexed values. When you do need to fix it, `REINDEX INDEX CONCURRENTLY` rebuilds without blocking writes; it needs room for a second copy and it can fail, leaving an invalid index behind for you to drop.',
      },
      {
        heading: 'When the planner refuses to use it',
        body: 'Usually it is right, and it is right for one of a few reasons. The predicate is not sargable — `WHERE lower(email) = $1` needs an expression index on `lower(email)`. The types do not match an operator class, or a `LIKE \'abc%\'` is on a column in a non-C collation without `text_pattern_ops`. Or the query genuinely selects 30% of the table, at which point a sequential scan is cheaper and forcing the index would be slower. If you disagree with the planner, look at the row estimates first: a bad plan is almost always a statistics problem, not a cost-constant problem.',
      },
      {
        heading: 'When it is not a B-tree',
        body: '`documents_body_gin` is a **GIN** index, which is a different animal: it stores one entry per *element* — each lexeme of a `tsvector`, each key of a `jsonb` — with a posting list of the rows containing it. That makes containment and full-text search fast and makes writes expensive, since one row insert can touch dozens of keys. GIN softens that with a pending list (`fastupdate`), which batches new entries and folds them in later, so an insert-heavy period can leave searches temporarily slower until the list is merged.',
      },
      {
        heading: 'What the city models',
        body: 'The engine keeps aggregate index pages and scan counts per table, charges representative pages to fixed index-plan templates, and distinguishes HOT from non-HOT update counts. Individual index kinds are cosmetic: there are no B-tree keys, GIN entries or pending list, index-only scans, bottom-up deletion, page splits, per-index bloat, selectivity or cost-driven plan choice.',
      },
    ],
    metrics: [
      {
        label: 'Index files',
        get: (s) => fmtBytes(sumTables(s, (t) => t.indexPages) * PAGE),
      },
      { label: 'Indexes', get: (s) => fmtNum(sumTables(s, (t) => t.def.indexes.length)) },
      { label: 'Index scans', get: (s) => fmtNum(sumTables(s, (t) => t.idxScans)) },
      {
        label: 'Index vs seq',
        get: (s) => {
          const idx = sumTables(s, (t) => t.idxScans)
          const seq = sumTables(s, (t) => t.seqScans)
          return fmtPct(ratio(idx, idx + seq), 0)
        },
        hint: 'share of scans that went through an index',
      },
      {
        label: 'Index churn',
        get: (s) => fmtNum(sumTables(s, (t) => t.updates - t.hotUpdates)),
        hint: 'updates that had to write new index entries',
      },
    ],
    knobs: ['seqScanRatio', 'updateRatio', 'autovacuum', 'autovacuumScaleFactor'],
    see: ['storage.table', 'storage.vm', 'autovac.worker', 'os.cache'],
    source: ['src/backend/access/nbtree/nbtree.c', 'src/backend/access/gin/gininsert.c'],
    refs: {
      docs: [
        manual('btree.html', '65.1. B-Tree Indexes'),
        manual('indexes-index-only-scans.html', '11.9. Index-Only Scans and Covering Indexes'),
        manual('gin.html', '65.4. GIN Indexes'),
      ],
      source: [
        srcFile('src/backend/access/nbtree/nbtsearch.c', '_bt_search, _bt_first'),
        srcFile('src/backend/access/nbtree/nbtdedup.c', '_bt_bottomupdel_pass'),
        srcFile('src/backend/access/gin/ginfast.c', 'ginHeapTupleFastInsert, ginInsertCleanup'),
        srcFile('src/backend/access/gin/ginget.c', 'scanPostingTree, entryGetItem'),
      ],
      suzuki: suzuki(7, 'HOT and Index-Only Scans (§7.2)'),
      rogov: rogov('Parts IV and V. Query Execution; Types of Indexes', 'Index Access Methods; Index Scan; B-Tree; GIN'),
    },
  },

  {
    id: 'storage.toast',
    title: 'TOAST',
    subtitle: 'the oversized-attribute sidecar',
    tldr: 'Values too big for a page get compressed, then moved to a hidden side table and fetched on demand.',
    sections: [
      {
        heading: 'Why it exists',
        body: 'A tuple cannot span pages, so with 8 KiB pages nothing could hold a 2 MiB document without a trick. **The Oversized-Attribute Storage Technique** is that trick. PostgreSQL aims to keep a row within `toast_tuple_target`: roughly 2 KiB is the default tuple target for a standard 8 KiB build, not a fixed threshold. When a row exceeds its target, Postgres works through the widest variable-length columns and, for each, first tries compression, then moves the value out of line if the row is still too big — leaving an 18-byte pointer in the tuple where the value was.',
      },
      {
        heading: 'Where the bytes go',
        body: 'Out-of-line values are chopped into roughly 2 KiB chunks and inserted into a private table in the `pg_toast` schema, keyed by (chunk_id, chunk_seq), with its own B-tree index. That table is invisible in `\\dt` but completely real: it has pages, it takes writes, it bloats, and autovacuum has to process it like anything else. `pg_relation_size(\'documents\')` does not include it — `pg_total_relation_size` does, and the gap between the two is the usual "why does the table look small but the disk is full" answer.',
      },
      {
        heading: 'What a wide column costs to read',
        body: 'Width alone does not determine the read path. An inline uncompressed datum needs no TOAST-index or chunk reads and no decompression. An inline compressed datum needs decompression but no TOAST fetch. An out-of-line datum requires a lookup in the TOAST index and reads its chunks; it needs decompression only if that external representation was stored compressed. Avoiding an unneeded wide column is still valuable because PostgreSQL can leave an external pointer unfollowed, but a wide value does not automatically imply chunk reads plus decompression.',
      },
      {
        heading: 'What you can control',
        body: '`ALTER TABLE … SET (toast_tuple_target = 4000)` changes the tuple target per table, so a value that would go external at the roughly 2 KiB default can remain inline under a higher target. `ALTER TABLE … ALTER COLUMN … SET STORAGE` separately picks the strategy: `EXTENDED` (compress then move out, the default), `EXTERNAL` (out of line, uncompressed — worth it when you constantly `substr()` the start of a large value), `MAIN` (compress, resist moving out), `PLAIN` (never). Since PostgreSQL 14 `default_toast_compression` can be `lz4` instead of `pglz`, which is usually several times faster to compress and decompress for a small loss of ratio. One useful property: an UPDATE that does not change a toasted column reuses the existing pointer rather than rewriting the value.',
      },
      {
        heading: 'What the city models',
        body: 'The TOAST yard is an illustrative renderer animation. The engine marks one table as wide and adds representative WAL for its writes, but it does not store TOAST chunks, out-of-line bytes, pointers, compression state, reads, bloat or vacuum cost. The animated chunk count is not database state.',
      },
    ],
    metrics: [
      {
        label: 'TOASTed relation',
        get: (s) => {
          const t = s.tables.find((x) => x.def.toast)
          return t ? t.def.name : 'none'
        },
      },
      {
        label: 'Main fork',
        get: (s) => {
          const t = s.tables.find((x) => x.def.toast)
          return t ? fmtBytes(t.pages * PAGE) : '—'
        },
        hint: 'the visible table — the toast table is extra',
      },
      {
        label: 'Rows per page',
        get: (s) => {
          const t = s.tables.find((x) => x.def.toast)
          return t ? fmtNum(t.def.tuplesPerPage) : '—'
        },
        hint: 'wide rows pack badly; big values are already out of line',
      },
      {
        label: 'Owning-table writes',
        get: (s) => {
          const t = s.tables.find((x) => x.def.toast)
          return t ? fmtNum(t.inserts + t.updates) : '—'
        },
        hint: 'not a TOAST write counter; the model has none',
      },
    ],
    knobs: ['writeRatio', 'updateRatio', 'seqScanRatio'],
    see: ['storage.table', 'storage.index', 'os.cache', 'autovac.worker'],
    source: ['src/backend/access/common/toast_internals.c', 'src/backend/access/common/detoast.c'],
    refs: {
      docs: [manual('storage-toast.html', '66.2. TOAST')],
      source: [
        srcFile('src/backend/access/heap/heaptoast.c', 'heap_toast_insert_or_update'),
        srcFile('src/backend/access/common/detoast.c', 'detoast_attr'),
      ],
      suzuki: suzuki(1, 'Database Cluster, Databases and Tables (§1.3.2 TOAST)'),
      rogov: rogov(R_MVCC, 'Pages and Tuples — the TOAST section', 'a section, not a chapter of its own'),
    },
  },

  {
    id: 'storage.fsm',
    title: 'Free space map',
    subtitle: 'relation fork _fsm',
    tldr: 'A coarse index of which pages have room, and the reason vacuumed space ever gets reused.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'When an INSERT needs somewhere to put a tuple, it does not scan the table looking for a gap. It asks the free space map, which is a small tree stored in the `_fsm` fork holding **one byte per heap page** — free space quantised to about 1/256 of a page, so roughly 32-byte granularity. Postgres descends that tree, gets a candidate page, pins it, and checks for real; if the page turns out to be full it retries, and if nothing has room it extends the relation by appending new pages.',
      },
      {
        heading: 'Why vacuum matters here',
        body: 'Vacuum is important because it scans broadly, removes eligible dead tuples and records the resulting reusable space in the FSM. It is not the map’s only writer: ordinary backends also update FSM information during insertion and relation-extension paths. The distinction matters operationally — vacuum discovers reusable space comprehensively, while foreground updates are opportunistic hints. If cleanup cannot remove dead versions, inserts may extend the relation even though obsolete tuples still occupy existing pages.',
      },
      {
        heading: 'Deliberately approximate',
        body: 'The FSM is a hint, not a ledger. It is not WAL-logged, so after a crash it can be stale — harmless, because a wrong answer only costs a retry. It is also not maintained for very small tables (fewer than four pages), where scanning the whole thing is cheaper than maintaining a map of it. And it never shrinks pages: it reports what is free, it does not compact anything.',
      },
      {
        heading: 'What you would see in production',
        body: 'Install `pg_freespacemap` and `SELECT sum(avail) FROM pg_freespace(\'sessions\')` to see, in bytes, how much reusable space a table is sitting on. A table with 4 GiB of tracked free space is bloated but stable — inserts will refill it. A table with almost none, that is still growing, is either genuinely growing or has an old snapshot pinning its dead row versions so vacuum cannot free anything.',
      },
      {
        heading: 'What the city models',
        body: 'The `_fsm` panel derives a capacity illustration from aggregate page and tuple counts. The engine has no FSM bytes, tree, stale hints, lookup, retry or page-placement path, so this panel does not decide where an INSERT lands or whether a relation extends.',
      },
    ],
    metrics: [
      {
        label: 'Dead-version bytes estimate',
        get: (s) => fmtBytes(sumTables(s, (t) => t.deadTuples) * 120),
        hint: 'rough illustration only; not modeled FSM free space',
      },
      { label: 'Dead row versions', get: (s) => fmtNum(sumTables(s, (t) => t.deadTuples)) },
      { label: 'Inserts served', get: (s) => fmtNum(sumTables(s, (t) => t.inserts)) },
      { label: 'Since last vacuum', get: (s) => fmtDuration(sinceVacuum(s)), hint: 'vacuum refreshes the map comprehensively; foreground backends update it too' },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor', 'updateRatio', 'longRunningXact'],
    see: ['storage.table', 'autovac.worker', 'landfill', 'storage.vm'],
    source: ['src/backend/storage/freespace/freespace.c', 'src/backend/access/heap/hio.c'],
    refs: {
      docs: [
        manual('storage-fsm.html', '66.3. Free Space Map'),
        manual('pgfreespacemap.html', 'F.27. pg_freespacemap'),
      ],
      source: [
        srcFile('src/backend/storage/freespace/freespace.c', 'GetPageWithFreeSpace, RecordPageWithFreeSpace, FreeSpaceMapVacuum'),
        srcFile('src/backend/access/heap/hio.c', 'RelationGetBufferForTuple'),
      ],
      rogov: rogov(R_MVCC, 'Vacuum and Autovacuum', 'where the free space map is discussed; it has no chapter of its own'),
    },
  },

  {
    id: 'storage.vm',
    title: 'Visibility map',
    subtitle: 'relation fork _vm',
    tldr: 'Two bits per page saying "everyone can see all of this" and "none of this needs freezing".',
    sections: [
      {
        heading: 'Two bits, enormous leverage',
        body: 'The `_vm` fork stores two bits per heap page. **All-visible** means every tuple on that page is visible to every possible transaction — nothing there is in-flight or newly dead. **All-frozen** means every tuple has been frozen and can never need freezing again. Two bits per 8 KiB page means the map for a 100 GiB table is a couple of megabytes, small enough to stay resident, which is the whole point.',
      },
      {
        heading: 'What all-visible buys',
        body: 'It is what makes **index-only scans** possible. If a scan finds a key in an index and the visibility map says the target heap page is all-visible, it can return the indexed columns without touching the heap at all — the visibility question is already answered. This is why the same index-only plan is fast on a static table and mediocre on a churning one, and why `EXPLAIN (ANALYZE)` reporting large `Heap Fetches` is a vacuum problem rather than an index problem.',
      },
      {
        heading: 'What all-frozen buys',
        body: 'Freezing exists because transaction ids are 32 bits and must be reused, so old rows have to be marked "older than everything" before the counter laps them. Without the all-frozen bit, every anti-wraparound vacuum would have to read every page of every table forever. With it, vacuum skips pages that are already frozen, so the work becomes proportional to what changed rather than to how big the table is. That is the difference between a 10 TiB archive table being fine and being an outage.',
      },
      {
        heading: 'How the bits move',
        body: 'Vacuum sets them, with one exception: since PostgreSQL 14, `COPY … WITH (FREEZE)` into a table created or truncated in the same transaction marks each page all-visible and all-frozen as it fills it, so a freshly bulk-loaded table is ready for index-only scans without a vacuum. Any modification to a page clears both bits immediately, and the clearing is WAL-logged so a standby stays correct. A page can therefore lose all-visible status because of one UPDATE and stay that way until the next vacuum pass. Use the `pg_visibility` extension to see the real distribution: `pg_visibility_map_summary(\'orders\')` returns how many pages are all-visible and how many are all-frozen, which tells you honestly how much of your table index-only scans can actually skip.',
      },
      {
        heading: 'What the city models',
        body: 'The colored caps are a derived illustration based on churn and vacuum animation. The engine has no per-page visibility-map bits and no index-only plan, heap-fetch counter or timing path, so changing this visual cannot make a query cheaper.',
      },
    ],
    metrics: [
      {
        label: 'Pages likely all-visible',
        get: (s) => {
          const dead = sumTables(s, (t) => t.deadTuples)
          const live = sumTables(s, (t) => t.liveTuples)
          return fmtPct(clamp(1 - ratio(dead, dead + live) * 4, 0, 1), 0)
        },
        hint: 'model estimate only — real numbers come from pg_visibility',
      },
      { label: 'Index scans', get: (s) => fmtNum(sumTables(s, (t) => t.idxScans)), hint: 'ordinary model index templates; there is no index-only plan' },
      { label: 'Since last vacuum', get: (s) => fmtDuration(sinceVacuum(s)) },
      { label: 'Vacuum', get: (s) => vacSummary(s) },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor', 'updateRatio', 'longRunningXact'],
    see: ['storage.index', 'autovac.worker', 'storage.fsm', 'storage.table'],
    source: ['src/backend/access/heap/visibilitymap.c', 'src/backend/access/heap/vacuumlazy.c'],
    refs: {
      docs: [
        manual('storage-vm.html', '66.4. Visibility Map'),
        manual('indexes-index-only-scans.html', '11.9. Index-Only Scans and Covering Indexes'),
      ],
      source: [
        srcFile('src/backend/access/heap/visibilitymap.c', 'visibilitymap_set, visibilitymap_clear, visibilitymap_get_status'),
        srcFile('src/backend/access/heap/vacuumlazy.c', 'lazy_scan_prune'),
      ],
      suzuki: suzuki(6, 'VACUUM Processing (§6.2 Visibility Map)'),
      rogov: rogov(R_MVCC, 'Vacuum and Autovacuum; Freezing — the all-frozen bit'),
    },
  },

  {
    id: 'os.cache',
    title: 'OS page cache',
    subtitle: 'kernel memory',
    tldr: 'The second cache under shared_buffers — the reason a "disk read" is usually not a disk read.',
    sections: [
      {
        heading: 'Two caches, not one',
        body: 'Postgres reads and writes through ordinary buffered file I/O, so every page that misses in `shared_buffers` goes to the kernel, which very often serves it from its own page cache. That means `blks_read` in `pg_stat_database` counts *reads that missed shared_buffers*, not reads that touched a disk. A cluster reporting a 92% cache hit ratio may be running at effectively 100%, or may be doing real I/O on every miss; the counter cannot tell you which, and `pg_stat_io` (PostgreSQL 16 and later) gives you the far more useful breakdown by backend type and context.',
      },
      {
        heading: 'Double buffering',
        body: 'A page can sit in both caches at once, so RAM is spent twice on the same 8 KiB. This is the main reason the usual advice caps `shared_buffers` around 25% of memory rather than 80%: past a point you are not adding cache, you are moving it from a cache with a good replacement policy and free readahead to one with a clock sweep. It is also why the answer to "should I raise shared_buffers" is almost always "measure the ratio of shared hits to reads first".',
      },
      {
        heading: 'effective_cache_size is a lie you tell the planner',
        body: 'It allocates nothing. It is a single number saying "assume roughly this much of the database is cached between shared_buffers and the OS", and the planner uses it to decide how expensive repeated index access will be. Set it too low and the planner avoids nested-loop-with-index plans it should have chosen; set it absurdly high and it will choose them when they are genuinely slow. Something around half to three-quarters of RAM is the usual starting point, and it is a plan-shape knob, not a memory knob.',
      },
      {
        heading: 'Where this is going',
        body: 'Relying on the kernel is convenient and imprecise: Postgres cannot control readahead well, cannot see what the kernel evicted, and pays a copy on every read. `debug_io_direct` exists to bypass the cache but is a development setting, not a production one, because Postgres does not yet do its own prefetching well enough to cover the loss. PostgreSQL 18 added a real asynchronous I/O subsystem (`io_method`, with a worker-based default and `io_uring` on Linux), which is the groundwork for a future where the database manages its own I/O depth instead of hoping the kernel guesses right.',
      },
      {
        heading: 'What the city models',
        body: 'The OS-cache route animation is illustrative: each shared-buffer miss is randomly drawn along a cache-hit or storage route. That draw does not change model time, counters, plan choice or device work, and the engine has no kernel-cache capacity, residency or eviction state.',
      },
    ],
    metrics: [
      { label: 'shared_buffers hit ratio', get: (s) => fmtPct(s.buffers.hitRatio, 1), hint: 'misses may still be RAM hits in the OS cache' },
      { label: 'shared_buffers', get: (s) => fmtBytes(poolBytes(s.knobs)) },
      { label: 'Misses', get: (s) => fmtNum(s.buffers.misses), hint: 'reads that left shared_buffers — not necessarily disk' },
      { label: 'Sample evictions', get: (s) => fmtNum(s.buffers.evictions) },
    ],
    knobs: ['sharedBuffers', 'seqScanRatio', 'tps'],
    see: ['disk.array', 'storage.table', 'bgwriter', 'storage.datadir'],
    source: ['src/backend/storage/smgr/md.c', 'src/backend/storage/buffer/bufmgr.c'],
    refs: {
      docs: [
        manual('runtime-config-query.html#GUC-EFFECTIVE-CACHE-SIZE', '19.7. Query Planning — effective_cache_size'),
        manual('runtime-config-resource.html#GUC-IO-COMBINE-LIMIT', '19.4. Resource Consumption — io_method, io_combine_limit'),
      ],
      source: [
        srcFile('src/backend/storage/smgr/md.c', 'mdreadv, mdwritev, register_dirty_segment'),
        srcFile('src/backend/storage/aio/read_stream.c', 'read_stream_begin_relation, read_stream_next_buffer'),
      ],
      suzuki: suzuki(8, 'Buffer Manager (§8.5 Asynchronous I/O)'),
      rogov: rogov(R_WAL, 'Buffer Cache — choosing the buffer cache size, and double buffering'),
    },
  },

  {
    id: 'storage.durability',
    title: 'Durability boundary',
    subtitle: 'volatile kernel memory above, persistent storage below',
    tldr: 'A successful write reaches the operating system; durability begins only when the required bytes have been forced to nonvolatile storage.',
    sections: [
      {
        heading: 'Written is not durable',
        body: 'Ordinary buffered writes can return while bytes remain in the operating system page cache, where a PostgreSQL process crash will not erase them but a machine or power failure can. PostgreSQL uses `fsync()` or an equivalent method to force the required WAL and data files through that volatile layer. Write-ahead logging adds the ordering rule: WAL describing a changed page must be durable before that data page may be written to durable storage.',
      },
      {
        heading: 'What the line means in this city',
        body: 'This is a static conceptual plane between the illustrative OS cache and storage. The city tracks WAL insert, write and flush positions and representative page writes, but it has no kernel-cache contents, filesystem, device cache, power-loss event or calibrated flush latency. Crossing the drawn line is not itself a simulated `fsync()`; the WAL flush frontier is the model’s durability fact.',
      },
    ],
    metrics: [
      { label: 'WAL durable through', get: (s) => fmtLsn(s.wal.flushLsn) },
      { label: 'WAL not yet durable', get: (s) => fmtBytes(Math.max(0, s.wal.insertLsn - s.wal.flushLsn)) },
      { label: 'Commit mode', get: (s) => s.knobs.synchronousCommit },
    ],
    knobs: ['synchronousCommit', 'fullPageWrites'],
    see: ['os.cache', 'disk.array', 'walwriter', 'wal.vault'],
    source: ['src/backend/access/transam/xlog.c', 'src/backend/storage/file/fd.c'],
    refs: {
      docs: [
        manual('wal-reliability.html', '28.1. Reliability'),
        manual('runtime-config-wal.html#GUC-FSYNC', '19.5.1. Settings — fsync'),
      ],
      source: [
        srcFile('src/backend/access/transam/xlog.c', 'XLogFlush'),
        srcFile('src/backend/storage/file/fd.c', 'pg_fsync'),
      ],
      rogov: rogov(R_WAL, 'Write-Ahead Log — durability and the WAL-before-data rule'),
    },
  },

  {
    id: 'disk.array',
    title: 'Storage',
    subtitle: 'the hardware everything ends at',
    tldr: 'The device Postgres trusts to keep a promise: when fsync returns, the bytes survive a power cut.',
    sections: [
      {
        heading: 'The entire contract is fsync',
        body: 'Postgres’s durability rests on one guarantee: when `fsync()` returns success, those bytes are on media that survives losing power. Write-ahead logging, checkpoints, crash recovery — all of it is built on that single promise. Everything else in the storage stack is allowed to reorder, buffer and delay, provided fsync is a real barrier. This is why `fsync = off` is not a performance setting but a "this cluster is disposable" setting.',
      },
      {
        heading: 'Lying storage corrupts databases',
        body: 'A device or virtualisation layer with a volatile write cache that acknowledges writes it has not persisted breaks the contract silently, and you find out at the next unclean power loss. What you get is not a clean older database: it is WAL that references pages whose earlier writes vanished, or a data file with a page from the future. Consumer SSDs without power-loss protection, RAID controllers with a dead BBU cache battery still in write-back mode, and some layered filesystem stacks have all shipped this behaviour. Postgres cannot detect it and cannot recover from it.',
      },
      {
        heading: 'Random versus sequential',
        body: 'Sequential scans often benefit from contiguous access and read-ahead, while index access can pay more per operation. The planner represents that distinction with relative estimates: `seq_page_cost` defaults to 1.0 and `random_page_cost` to 4.0. The latter also incorporates an assumption that many random reads are cached; it is not a direct benchmark of one device class. If sound row estimates still produce the wrong access paths, compare representative plans and timings for the real workload and cache residency, then calibrate the page, CPU and cache assumptions together. An SSD or NVMe label alone does not prescribe a truthful constant.',
      },
      {
        heading: 'Torn pages',
        body: 'An 8 KiB page is not written atomically by most storage, so a crash can leave half of one page from the new write and half from the old. WAL cannot repair that, because WAL records describe deltas to a page that must be intact to begin with. `full_page_writes` solves it by logging the entire page image the first time it is modified after each checkpoint, so recovery can rebuild the page from scratch and then replay deltas. That is why WAL volume surges from the moment each checkpoint begins — the redo point is stamped at the start, and from then on every page owes an image on its first modification — and why turning full page writes off is only defensible on storage that genuinely offers atomic 8 KiB writes.',
      },
      {
        heading: 'What you would see in production',
        body: 'The healthy signature is fsync latency in the low single-digit milliseconds, with a periodic bump at the end of each checkpoint. The unhealthy one is a queue depth that never drains and commit latency that tracks it — storage that cannot absorb the checkpoint’s fsyncs on top of the ordinary WAL flush rate. Under a spread checkpoint the full-page-image surge has largely decayed by the time the fsync phase arrives, so the two costs land at opposite ends of the interval; when they do collide, it is because `max_wal_size` is forcing checkpoints early. Also worth knowing: if an `fsync()` fails, Postgres deliberately PANICs rather than retrying, because on Linux a failed fsync could drop the error and let a later fsync return success on data that never landed.',
      },
      {
        heading: 'What the city models',
        body: 'The storage model combines sampled read/write demand into one pressure scalar used by backend phases, and exposes representative rates, WAL positions and checkpoint state. It has no device queue, calibrated read or fsync latency, failure result, random-versus-sequential service time, media durability state or link from device cost constants to plan selection. OS-cache route draws do not alter device work.',
      },
    ],
    metrics: [
      { label: 'WAL fsynced to', get: (s) => fmtLsn(s.wal.flushLsn) },
      { label: 'WAL rate', get: (s) => `${fmtBytes(s.wal.bytesPerSec)}/s` },
      {
        label: 'Dirty sample evictions',
        get: (s) => fmtNum(s.buffers.dirtyEvictions),
        hint: 'a backend had to write a page before it could reuse the buffer',
      },
      { label: 'Checkpoint', get: (s) => CKPT_PHASE[s.checkpoint.phase], hint: `correlate with the rolling p99 in ${CLAIM_VALUES.modelLatency.unit}` },
      { label: 'Full-page burst', get: (s) => fmtPct(s.wal.fpwBurst, 0), hint: 'extra WAL from the full-page images owed since this checkpoint began' },
    ],
    knobs: ['fullPageWrites', 'synchronousCommit', 'checkpointTimeout', 'maxWalSize'],
    see: ['checkpointer', 'os.cache', 'walwriter', 'wal.vault'],
    source: ['src/backend/storage/smgr/md.c', 'src/backend/access/transam/xlog.c'],
    refs: {
      docs: [
        manual('wal-reliability.html', '28.1. Reliability'),
        manual('runtime-config-wal.html#GUC-FSYNC', '19.5. Write Ahead Log — fsync, full_page_writes'),
      ],
      source: [
        srcFile('src/backend/storage/file/fd.c', 'pg_fsync, data_sync_elevel'),
        srcFile('src/backend/access/transam/xlog.c', 'issue_xlog_fsync, XLogFlush'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) — full-page writes'),
      rogov: rogov(R_WAL, 'WAL Modes — fault tolerance'),
    },
  },

  /* ======================================================================
   * Checkpointing and background writing
   * ====================================================================*/
  {
    id: 'checkpointer',
    title: 'Checkpointer',
    subtitle: 'background process',
    tldr: 'Guarantees everything before a point in the WAL is on disk, so recovery never reads further back.',
    sections: [
      {
        heading: 'Why it exists',
        body: 'Postgres modifies pages in `shared_buffers` and writes only the WAL record immediately; the page itself can stay dirty in memory for a long time. That makes writes fast and makes crash recovery unbounded, because after a crash you must replay from the last point at which you know the on-disk files were complete. A **checkpoint** creates that point. It writes out every buffer that was dirty when it started, then records that fact in `pg_control`, and from then on recovery can begin at the checkpoint’s **redo point** instead of the beginning of time. Checkpoint frequency is therefore a direct trade of steady-state write cost against recovery time.',
      },
      {
        heading: 'What actually happens',
        body: 'The checkpointer notes the current insert position as the redo point, takes the list of buffers dirty at that instant, and writes them — nothing more. Buffers dirtied *during* the checkpoint are the next checkpoint’s problem. Once the writes are issued it enters the **fsync phase**, calling `fsync()` on every file that has been modified, including the ones ordinary backends touched and handed off via the fsync request queue. Only then does it update `pg_control` and recycle the WAL segments older than the new redo point — the position a crash recovery would now start replaying from.',
      },
      {
        heading: 'Time-triggered or WAL-triggered',
        body: "When `checkpoint_timeout` elapses PostgreSQL records a timer expiry, but it can skip the checkpoint if nothing changed. WAL volume approaching the moving `max_wal_size` threshold or an explicit request — including `CHECKPOINT`, base-backup activity and shutdown — can also start one. PGSimCity uses 60 seconds instead of PostgreSQL's 5-minute default so the cycle is visible; only the checkpoint clock is compressed. In PostgreSQL 18, `pg_stat_checkpointer.num_timed` counts timer expiries and `num_done` counts completed checkpoints; `num_requested` aggregates requests and does **not** identify their cause. If requests are frequent, correlate their rate with WAL volume, PostgreSQL checkpoint messages and maintenance or backup activity before changing `max_wal_size`. In this city the model records its own reason separately, so a scenario can know that WAL pressure caused a request even though the real counter alone cannot.",
      },
      {
        heading: 'Where the latency spike comes from',
        body: 'The write phase is throttled and usually invisible. The fsync phase is not: it asks the storage to durably persist everything the kernel has been lazily accumulating, all at once, and while that queue drains every commit waiting on `fsync` of WAL is stuck behind it. The other cost starts at the other end. The redo point is stamped the moment a checkpoint *begins*, and from that instant the first modification to each page logs a **full page image**, so WAL volume surges as the checkpoint starts and decays as the hot pages pay their toll — largely spent by the time the fsync phase arrives. That rhythm — a WAL surge at each checkpoint’s start, an fsync latency spike at its end, repeating at `checkpoint_timeout` intervals — is the most recognisable pattern in Postgres performance work.',
      },
      {
        heading: 'How to tune it',
        body: 'Read PostgreSQL checkpoint messages and correlate them with WAL generation, `num_requested`, explicit maintenance and backup activity. If WAL pressure is the verified cause, raise `max_wal_size` against measured peak WAL rate and available disk; if explicit requests are the cause, changing it will not help. Lengthening `checkpoint_timeout` can reduce full-page-image frequency but may lengthen crash recovery, so decide it against the actual RTO. On PostgreSQL 14 and later, leave `checkpoint_completion_target` at its 0.9 default unless measurements establish a reason to finish writes earlier; PostgreSQL 13 and older default to 0.5.',
      },
      {
        heading: 'What the city measures',
        body: `The city computes sampled dirty-page writes, checkpoint phases, request reasons, full-page-image WAL and shared storage pressure. It retains a ${CLAIM_VALUES.modelLatency.disclosure} and reports weighted p50/p99 in ${CLAIM_VALUES.modelLatency.unit}; ${CLAIM_VALUES.modelLatency.componentDisclosure}. In this scale model, ${CLAIM_VALUES.modelLatency.batchDisclosure}, and ${CLAIM_VALUES.modelLatency.resolutionDisclosure}. This is model time, not a calibrated device or production response-time histogram.`,
      },
    ],
    metrics: [
      { label: 'Phase', get: (s) => CKPT_PHASE[s.checkpoint.phase] },
      {
        label: 'Sample progress',
        get: (s) =>
          s.checkpoint.phase === 'idle'
            ? `next in ${fmtDuration(Math.max(0, s.checkpoint.nextInSec))}`
            : `${fmtNum(s.checkpoint.buffersWritten)} / ${fmtNum(s.checkpoint.buffersToWrite)} sampled frames`,
      },
      { label: 'Last duration', get: (s) => fmtDuration(s.checkpoint.lastDuration) },
      { label: 'Model trigger', get: (s) => s.checkpoint.reason, hint: 'the model knows its cause; PostgreSQL num_requested alone does not' },
      { label: 'Redo point', get: (s) => fmtLsn(s.checkpoint.completedRedoLsn), hint: 'recovery would start here' },
    ],
    knobs: ['checkpointTimeout', 'maxWalSize', 'checkpointCompletionTarget', 'fullPageWrites', 'sharedBuffers'],
    see: ['bgwriter', 'wal.vault', 'disk.array', 'startup.proc'],
    source: [
      'src/backend/postmaster/checkpointer.c',
      'src/backend/access/transam/xlog.c',
      'src/backend/storage/buffer/bufmgr.c',
    ],
    refs: {
      docs: [
        manual('wal-configuration.html', '28.5. WAL Configuration'),
        manual('runtime-config-wal.html#GUC-CHECKPOINT-TIMEOUT', '19.5. Write Ahead Log — checkpoint_timeout, checkpoint_completion_target'),
      ],
      source: [
        srcFile('src/backend/postmaster/checkpointer.c', 'CheckpointerMain, CheckpointWriteDelay, IsCheckpointOnSchedule, AbsorbSyncRequests'),
        srcFile('src/backend/access/transam/xlog.c', 'CalculateCheckpointSegments, CreateCheckPoint, CheckPointGuts'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.7 Checkpoint Processing)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — checkpoints'),
    },
  },

  {
    id: 'bgwriter',
    title: 'Background writer',
    subtitle: 'background process',
    tldr: 'Cleans buffers just ahead of the clock sweep so queries rarely have to write a page themselves.',
    sections: [
      {
        heading: 'What it does that the checkpointer does not',
        body: 'The checkpointer writes the buffers that were dirty at a moment in time, on a schedule, for durability. The background writer writes the buffers that are about to be **evicted**, continuously, for latency. It walks the clock sweep slightly ahead of where allocation is happening and flushes dirty victims, so that when a backend needs a free buffer it is more likely to find a clean one instead of issuing an 8 KiB buffered write to the filesystem in the middle of your query. That write normally lands in the kernel cache rather than immediately reaching durable media; writeback pressure determines whether it becomes a long stall.',
      },
      {
        heading: 'It does not reduce I/O',
        body: 'This surprises people: the background writer usually increases total writes, because a page it cleans may be dirtied again before the next checkpoint and written twice. Its value is entirely about *who* pays and *when*. Moving a write off the critical path of a user query and onto a background process is worth a modest amount of extra I/O, in the same way that garbage collecting early is worth it if it keeps pauses out of request handling.',
      },
      {
        heading: 'How to tell if it is working',
        body: 'The number to look at is how many buffers **backends** write for themselves. Historically that was `buffers_backend` in `pg_stat_bgwriter`; PostgreSQL 17 removed those columns in favour of `pg_stat_io`, where you filter on `backend_type = \'client backend\'` and look at `writes`. If ordinary backends are doing a large share of the writing, one of three things is true: `shared_buffers` is too small for the working set, the background writer is capped too low, or a checkpoint is behind and everything is dirty at once.',
      },
      {
        heading: 'The knobs',
        body: '`bgwriter_delay` (200 ms) is how often it wakes, `bgwriter_lru_maxpages` (100) caps how many buffers it may write per round, and `bgwriter_lru_multiplier` (2.0) scales how far ahead of recent demand it tries to stay. Raising `bgwriter_lru_maxpages` to a few hundred is a reasonable first move on a write-heavy system with fast storage. On PostgreSQL, turning the writer off moves dirty-victim writes onto query critical paths and can create a long latency tail.',
      },
      {
        heading: 'What the city measures',
        body: `The city models FlushBuffer’s write-ahead rule: a backend evicting a dirty page requests WAL durability through the shared group-flush path and waits when that page’s LSN is ahead of flush_lsn; an already-durable page skips that wait. It then charges the page write to the same query. Sampled client-backend writes, bgwriter cleans, dirty frames, route particles and weighted rolling p50/p99 are shown in ${CLAIM_VALUES.modelLatency.unit}; ${CLAIM_VALUES.modelLatency.componentDisclosure}. ${CLAIM_VALUES.modelLatency.taxonomyDisclosure}. In this scale model, ${CLAIM_VALUES.modelLatency.batchDisclosure}, and ${CLAIM_VALUES.modelLatency.resolutionDisclosure}.`,
      },
    ],
    metrics: [
      { label: 'State', get: (s) => (s.bgwriter.enabled ? `cleaning (${fmtPct(s.bgwriter.activity, 0)} busy)` : 'disabled') },
      { label: 'Sample cleaned / s', get: (s) => fmtNum(s.bgwriter.cleanedPerSec) },
      { label: 'Sample cleaned total', get: (s) => fmtNum(s.bgwriter.cleanedTotal) },
      {
        label: 'Sample backend writes',
        get: (s) => fmtNum(s.buffers.dirtyEvictions),
        hint: 'dirty buffers a query had to write itself — the number to keep low',
      },
      {
        label: 'Latency p50 / p99',
        get: (s) => `${fmtNum(s.stats.latency.p50.totalMs)} / ${fmtNum(s.stats.latency.p99.totalMs)} ${CLAIM_VALUES.modelLatency.unit}`,
        hint: `${CLAIM_VALUES.modelLatency.batchDisclosure}; ${CLAIM_VALUES.modelLatency.resolutionDisclosure}`,
      },
      {
        label: 'p99 dirty-victim wait',
        get: (s) => `${fmtNum(s.stats.latency.p99.waits.dirtyWriteMs)} ${CLAIM_VALUES.modelLatency.unit}`,
        hint: 'the p99 of dirty-victim wait itself, including any required WAL flush; not one total-p99 trip’s component',
      },
      { label: 'Dirty sample frames', get: (s) => `${fmtNum(s.buffers.dirtyCount)} / ${fmtNum(s.buffers.sampleFrames)}` },
    ],
    knobs: ['bgwriterEnabled', 'bgwriterLruMaxpages', 'sharedBuffers', 'writeRatio'],
    see: ['checkpointer', 'os.cache', 'disk.array', 'storage.table'],
    source: [
      'src/backend/postmaster/bgwriter.c',
      'src/backend/storage/buffer/freelist.c',
      'src/backend/storage/buffer/bufmgr.c',
    ],
    refs: {
      docs: [
        manual('runtime-config-resource.html#RUNTIME-CONFIG-RESOURCE-BACKGROUND-WRITER', '19.4. Resource Consumption — Background Writer'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_bgwriter, pg_stat_checkpointer, pg_stat_io'),
        manual('pgstatstatements.html', 'F.32. pg_stat_statements — mean and standard deviation, not percentiles'),
        { label: 'pg_stat_monitor — response-time histogram', url: 'https://docs.percona.com/pg-stat-monitor/user_guide.html#histogram' },
      ],
      source: [
        srcFile('src/backend/postmaster/bgwriter.c', 'BackgroundWriterMain'),
        srcFile('src/backend/storage/buffer/bufmgr.c', 'BgBufferSync'),
        srcFile('src/backend/storage/buffer/freelist.c', 'StrategySyncStart'),
      ],
      suzuki: suzuki(8, 'Buffer Manager (§8.6 Dirty Pages Flushing)'),
      rogov: rogov(R_WAL, 'Buffer Cache; Write-Ahead Log', 'the background writer is covered inside both, with no section of its own'),
    },
  },

  /* ======================================================================
   * Maintenance
   * ====================================================================*/
  {
    id: 'autovac.launcher',
    title: 'Autovacuum launcher',
    subtitle: 'background process',
    tldr: 'Decides which tables need vacuuming and asks the postmaster to fork a worker for them.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'The launcher itself vacuums nothing. Every `autovacuum_naptime` (60 seconds by default) it wakes, picks the database that has waited longest, and asks the postmaster to fork a **worker** for it. The worker is what reads the statistics, builds the list of tables over threshold, and processes them. With N databases the launcher wakes every `autovacuum_naptime`/N and starts one worker per wakeup, so each database is still visited about once per naptime — not more often. On a cluster with dozens of databases the wakeups get closer together, the per-database interval does not, and it stretches further whenever all `autovacuum_max_workers` are already busy.',
      },
      {
        heading: 'The threshold formula',
        body: 'A table is vacuumed when its dead-tuple estimate exceeds `min(autovacuum_vacuum_max_threshold, autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × pg_class.reltuples)`. PostgreSQL 18 defaults make that the smaller of 100 million and 50 + 20% of `reltuples`; PostgreSQL 17 and older have no maximum. This is the planner estimate refreshed by `VACUUM` or `ANALYZE`, not the live-tuple estimate in `pg_stat_user_tables`. Analyze uses the uncapped base-plus-scale shape with a 10% factor. Since PostgreSQL 13 there is also an insert-driven trigger (`autovacuum_vacuum_insert_threshold`, 1000 plus 20% of `reltuples` times the unfrozen-page share), which finally gave append-only tables a reason to get vacuumed at all, so their pages get frozen and marked all-visible before wraparound forces the issue.',
      },
      {
        heading: 'Why the defaults are too timid',
        body: `Twenty percent is a sensible default for a 10,000-row table and a catastrophe for a 500-million-row one, where it means waiting for 100 million dead tuples before doing anything, then vacuuming for hours. Set it per table: \`ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000)\`. Frequent small vacuums are dramatically cheaper than rare large ones, because each pass re-reads less and has a better chance of finishing before the next one is due.\n\n${renderAction('tuneAutovacuum')}`,
      },
      {
        heading: 'Throttling, and the trap in it',
        body: `Vacuum accumulates cost points as it reads and dirties pages, and sleeps for \`autovacuum_vacuum_cost_delay\` (2 ms since PostgreSQL 12) whenever it exceeds \`autovacuum_vacuum_cost_limit\` (200). That budget is shared across **all** workers, so the worker count and cost capacity must be diagnosed together.\n\n${renderAction('tuneAutovacuum')}`,
      },
      {
        heading: 'What you would see in production',
        body: `The symptom is a table growing while its row count is flat, \`pg_stat_user_tables.last_autovacuum\` hours old on a busy table, or every worker occupied while eligible relations queue. Read \`pg_class.reloptions\` before calling that a capacity problem.\n\n${renderAction('enableRelationAutovacuum')}`,
      },
      {
        heading: 'Where this model cheats',
        body: 'The naptime here is 12 seconds, not 60, and this city has exactly one database — otherwise the yard would sit empty for the length of a visit. The city keeps `reltuples` separate from its live-tuple counter, refreshes it when the folded-in `ANALYZE` phase completes, and applies PostgreSQL 18’s 100-million maximum threshold; it does not model sampling error or a separate manual ANALYZE. The phase order follows PostgreSQL. The city does not implement individual page cost points or dynamic rebalancing of the shared worker budget; it gives each worker an equal share of one quarter of modeled device throughput and realizes that ceiling as alternating work and `VacuumDelay` sleep slices.',
      },
    ],
    metrics: [
      { label: 'Autovacuum', get: (s) => (s.autovac.enabled ? 'enabled' : 'DISABLED'), hint: 'never disable this in production' },
      { label: 'Workers busy', get: (s) => `${fmtNum(activeWorkers(s))} / ${fmtNum(s.autovac.workers.length)}` },
      { label: 'Next launch', get: (s) => fmtDuration(Math.max(0, s.autovac.nextLaunchSec)) },
      { label: 'Runs so far', get: (s) => fmtNum(s.autovac.totalRuns) },
      {
        label: 'Over threshold',
        get: (s) => fmtNum(s.tables.reduce((n, t) => n + (t.deadTuples > t.vacuumThreshold ? 1 : 0), 0)),
        hint: 'tables currently eligible for vacuum',
      },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor', 'updateRatio', 'writeRatio'],
    see: ['autovac.worker', 'storage.table', 'landfill', 'storage.fsm'],
    source: ['src/backend/postmaster/autovacuum.c'],
    refs: {
      docs: [
        manual('runtime-config-vacuum.html', '19.10. Vacuuming'),
        manual('routine-vacuuming.html', '24.1. Routine Vacuuming'),
      ],
      source: [srcFile('src/backend/postmaster/autovacuum.c', 'AutoVacLauncherMain, do_start_worker, AutoVacuumUpdateCostLimit')],
      suzuki: suzuki(6, 'VACUUM Processing (§6.5 Autovacuum Daemon)'),
      rogov: rogov(R_MVCC, 'Vacuum and Autovacuum'),
    },
  },

  {
    id: 'autovac.worker',
    title: 'Vacuum worker',
    subtitle: 'short-lived background process',
    tldr: 'Finds dead row versions, removes their index entries, frees their space, and freezes old rows.',
    sections: [
      {
        heading: 'The phases, in order',
        body: `A vacuum moves through named phases, and \`pg_stat_progress_vacuum\` shows which one a worker is in. **Initializing**, then **scanning heap**: read pages (skipping all-visible ones via the visibility map), pruning and freezing along the way, and collect the TIDs of the dead line pointers left behind. **Vacuuming indexes**: for each index, remove every entry pointing at a collected TID — this is why vacuum cost scales with index count, not just table size. **Vacuuming heap**: return to the collected pages and turn those line pointers into free space, recording it in the FSM. Those two are a loop rather than a straight line: if the heap has not been fully scanned yet, the worker goes back to scanning (see "Memory and repeat passes" below). **Cleaning up indexes**: one final call per index to tidy up and refresh its statistics. **Truncating heap**: give back trailing empty pages if it can, and only those; this is the brief ${CLAIM_VALUES.vacuumReclaim.truncationLock.mode}, ${CLAIM_VALUES.vacuumReclaim.truncationLock.attempt} attempt, so no lock means no truncation and the space stays in the table. **Performing final cleanup**: vacuum the free space map, update \`pg_class\`, and report to the cumulative statistics. ANALYZE is *not* one of these phases — autovacuum may run it against the same table straight afterwards, but it is a separate command with its own view, \`pg_stat_progress_analyze\`.`,
      },
      {
        heading: 'Dead is not the same as removable',
        body: 'A tuple is dead when the effective deleting or updating XID recorded through `xmax` has committed, but a committed `xmax` alone is not enough. `HEAP_XMAX_LOCK_ONLY` means `xmax` records only a row lock, so the tuple remains live after that locker commits; a MultiXact must likewise be interpreted from its members and flags rather than mistaken for one deleting transaction. A genuinely dead tuple can only be **removed** if no snapshot anywhere could still need it. Vacuum computes a horizon from the oldest running transaction, the oldest replication slot xmin, and (if enabled) standby feedback; anything newer than that horizon stays, however dead it is. This is the mechanism behind the single most common Postgres incident: one forgotten `idle in transaction` session pins the horizon, every vacuum runs, does work, and removes nothing, and the table bloats for as long as that session stays open. `VACUUM VERBOSE` says so directly: on PostgreSQL 16 and later it prints a `tuples:` line ending "… are dead but not yet removable", followed by a `removable cutoff:` line giving the xid it was allowed to use and how many transactions old that already was when the run ended.',
      },
      {
        heading: 'Why the file usually does not shrink',
        body: `${CLAIM_VALUES.vacuumReclaim.rule} On a table with live rows scattered near the end — which is nearly all of them — the file stays exactly as large as it was. That is correct behaviour, not a failure: the space remains on the map, and the next inserts will use it.`,
      },
      {
        heading: 'Freezing and wraparound',
        body: 'Transaction ids are 32-bit and wrap, so every row must eventually be marked frozen — meaning "older than everything, visible to all" — before the counter laps its `xmin`. Vacuum freezes as it goes, and once a table’s oldest xid reaches `autovacuum_freeze_max_age` (200 million) an **anti-wraparound** vacuum is launched that will not be skipped and will not politely step aside for your DDL. Ignoring those is how a cluster ends up refusing new transactions with "database is not accepting commands that assign new XIDs to avoid wraparound data loss in database …". Recovery is undramatic and does not need single-user mode: read-only transactions still start and `VACUUM` still runs, and the safety margin exists precisely so that you can connect normally and vacuum the offending databases. Since PostgreSQL 14 a failsafe kicks in near the limit and abandons cost delays and index cleanup to finish freezing at any price.',
      },
      {
        heading: 'Memory and repeat passes',
        body: 'The dead TIDs collected in the heap scan have to fit in `maintenance_work_mem` (or `autovacuum_work_mem`). If they do not, vacuum stops, does a full pass over every index, empties the list and resumes — so a large table with five indexes and a small memory setting can read all five indexes several times in one vacuum. PostgreSQL 17 replaced the old flat TID array with a much more compact structure and removed the 1 GiB ceiling that used to force this, which made large-table vacuums substantially cheaper.',
      },
      {
        heading: 'What the city models',
        body: 'The worker follows one fixed pass through heap scan, one pass per declared index, heap cleanup, truncation, a folded-in analyze stage and return, with representative page I/O and WAL. Its scaled per-worker I/O ceiling alternates active work with explicit cost-delay sleeps, shown in `pg_stat_activity` as `Timeout / VacuumDelay`; it does not reproduce individual page cost values or PostgreSQL’s real 2 ms delay. It also does not model `maintenance_work_mem`, repeated index passes, per-page visibility bits, freeze age, anti-wraparound launches, lock acquisition for truncation or FSM updates. File truncation is a tail-density heuristic, not a lock outcome.',
      },
    ],
    metrics: [
      { label: 'Fleet', get: (s) => vacSummary(s) },
      {
        label: 'Current table',
        get: (s) => {
          const w = s.autovac.workers.find((x) => x.active)
          if (!w) return '—'
          const t = s.tables[w.table]
          return t ? `${t.def.name} · ${fmtPct(w.progress, 0)}` : `${fmtPct(w.progress, 0)}`
        },
      },
      {
        label: 'Blocked by horizon',
        get: (s) => (s.autovac.workers.some((w) => w.active && w.stalledByHorizon) ? 'YES — an old snapshot pins xmin' : 'no'),
        hint: 'dead row versions exist but cannot be removed yet',
      },
      {
        label: 'Oldest snapshot',
        get: (s) => `${fmtDuration(s.oldestSnapshotAge)} · ${fmtNum(Math.max(0, s.xid - s.xminHorizon))} xids`,
      },
      { label: 'Dead rows removed', get: (s) => fmtNum(s.autovac.workers.reduce((n, w) => n + w.deadCollected, 0)) },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor', 'longRunningXact', 'updateRatio'],
    see: ['autovac.launcher', 'storage.table', 'landfill', 'storage.vm'],
    source: [
      'src/backend/access/heap/vacuumlazy.c',
      'src/backend/commands/vacuum.c',
      'src/backend/access/heap/visibilitymap.c',
    ],
    refs: {
      docs: [
        manual('sql-vacuum.html', 'VACUUM'),
        manual('progress-reporting.html', '27.4. Progress Reporting — pg_stat_progress_vacuum'),
      ],
      source: [
        srcFile('src/backend/access/heap/vacuumlazy.c', 'heap_vacuum_rel, lazy_scan_prune, lazy_vacuum_all_indexes, lazy_vacuum_heap_rel, lazy_truncate_heap'),
        srcFile('src/backend/commands/vacuum.c', 'vacuum_get_cutoffs, vacuum_delay_point, vac_truncate_clog'),
        srcFile('src/backend/postmaster/autovacuum.c', 'do_autovacuum, relation_needs_vacanalyze'),
      ],
      suzuki: suzuki(6, 'VACUUM Processing (§6.1, §6.3)'),
      rogov: rogov(R_MVCC, 'Vacuum and Autovacuum; Freezing — wraparound'),
    },
  },

  {
    id: 'landfill',
    title: 'Reclaimed space',
    subtitle: 'what vacuum actually gives back',
    tldr: 'Freed space returns to the table for reuse, almost never to the filesystem.',
    sections: [
      {
        heading: 'Reused, not returned',
        body: `When vacuum removes dead tuples it records the recovered space in the free space map, and future inserts and updates land there. From the operating system’s point of view nothing happened: the file is the same size, \`df\` does not move. This is usually the right answer — the space will be reused within minutes on a busy table, and returning it would just mean extending the file again — but it means "I vacuumed and the disk did not shrink" is expected behaviour, not a bug. ${CLAIM_VALUES.vacuumReclaim.rule}`,
      },
      {
        heading: 'When you actually need the space back',
        body: 'There is one situation that justifies a rewrite: a table that grew enormously through a one-off event and will never be that big again — a bulk delete of 80% of the rows, a runaway job, a bloat incident that has since been fixed. Steady-state bloat should be fixed by vacuuming more aggressively, not by periodically rewriting the table, because a rewrite you have to repeat is a symptom.',
      },
      {
        heading: 'VACUUM FULL and the alternatives',
        body: '`VACUUM FULL` rewrites the entire table into a fresh relfilenode and rebuilds every index while holding `ACCESS EXCLUSIVE` for the whole rewrite. `pg_repack` builds a shadow copy while the table remains usable, but it is not lock-free: it takes brief `ACCESS EXCLUSIVE` locks during setup and the final swap and holds `SHARE UPDATE EXCLUSIVE` through much of the copy. `pg_squeeze` decodes concurrent changes from WAL through a replication slot, so it needs `wal_level = logical`. These extensions shorten blocking windows rather than eliminate them, and still need room for another copy.',
      },
      {
        heading: 'What you would see in production',
        body: 'Measure before you rewrite: `pgstattuple` gives an exact free-space percentage at the cost of reading the table, and `pg_freespace()` shows what the map already knows about. If a table is 60% dead space and stable, a rewrite buys real scan performance. If it is 60% dead space and climbing, rewriting it changes nothing — find the long-running transaction or the too-timid autovacuum setting first. And for delete-driven bloat, partitioning plus `DROP TABLE` on old partitions eliminates the problem instead of managing it.',
      },
      {
        heading: 'What the city models',
        body: 'The landfill is a cumulative teaching pile driven by the model’s removed-tuple count. Removing dead rows increases aggregate spare capacity and can delay relation extension, but the engine has no per-page free-space or FSM placement path and no reclaimed byte count.',
      },
    ],
    metrics: [
      { label: 'Tuples reclaimed', get: (s) => fmtNum(s.autovac.landfill) },
      {
        label: 'Dead bytes remaining estimate',
        get: (s) => fmtBytes(sumTables(s, (t) => t.deadTuples) * 120),
        hint: 'rough dead-version estimate, not reusable-space state',
      },
      {
        label: 'Worst table',
        get: (s) => {
          const w = worstBloat(s)
          return w ? `${w.def.name} · ${fmtPct(w.bloat, 1)} dead` : '—'
        },
      },
      { label: 'Vacuum runs', get: (s) => fmtNum(s.autovac.totalRuns) },
    ],
    knobs: ['autovacuum', 'autovacuumScaleFactor', 'longRunningXact', 'updateRatio'],
    see: ['autovac.worker', 'storage.fsm', 'storage.table', 'autovac.launcher'],
    source: ['src/backend/access/heap/vacuumlazy.c', 'src/backend/storage/freespace/freespace.c'],
    refs: {
      docs: [
        manual('sql-vacuum.html', 'VACUUM — VACUUM FULL'),
        manual('pgstattuple.html', 'F.33. pgstattuple'),
        { label: 'pg_repack documentation — locking and operation', url: 'https://reorg.github.io/pg_repack/' },
      ],
      source: [
        srcFile('src/backend/access/heap/vacuumlazy.c', 'lazy_truncate_heap'),
        srcFile('src/backend/commands/repack.c', 'cluster_rel, rebuild_relation, copy_table_data'),
        srcFileAt(CLAIM_VALUES.postgresqlVersion.sourceBranch, `${CLAIM_VALUES.postgresqlVersion.majorLabel} and earlier`, 'src/backend/commands/cluster.c', 'cluster_rel, rebuild_relation, copy_table_data'),
      ],
      suzuki: suzuki(6, 'VACUUM Processing (§6.6 Reclaiming Bloated Space)'),
      rogov: rogov(R_MVCC, 'Rebuilding Tables and Indexes'),
    },
  },

  {
    id: 'logger',
    title: 'Logging collector',
    subtitle: 'background process',
    tldr: 'Captures the server log, and four of its settings are the difference between diagnosable and not.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'Backends write log lines to stderr. With `logging_collector = on`, a dedicated process reads that pipe and writes rotated files under `log_directory`, which is what makes the server log survive restarts, rotate by size and age, and not interleave badly across processes. Enabling it is a maintenance change: `logging_collector` has postmaster context, so set it in configuration and restart the server; a reload alone leaves `pending_restart = t`. `log_destination` chooses the format: `stderr`, `csvlog`, or `jsonlog` (added in PostgreSQL 15), the latter two being the ones you want if anything machine-readable consumes the server log.',
      },
      {
        heading: 'log_line_prefix comes first',
        body: 'A log line without context is a log line you cannot use. Set `log_line_prefix` to something like `%m [%p] %q%u@%d app=%a ` so every line carries a timestamp with milliseconds, the process id, and — for lines from real sessions — the user, database and application name. The default is close to useless, and every log-analysis tool worth running (pgBadger among them) needs the prefix to be sane before it can tell you anything.',
      },
      {
        heading: 'The four settings that matter',
        body: '`log_min_duration_statement` logs any statement slower than a threshold; start at 1000 ms and walk it down, never set it to 0 on a busy system. For cluster-wide `auto_explain`, first add `auto_explain` to `shared_preload_libraries` and restart; only then will its duration threshold capture plans from every session. That turns "this query was slow" into "this query chose a nested loop because the estimate was 1 row and reality was 400,000". `log_checkpoints` (on by default since PostgreSQL 15) prints the write/sync split of every checkpoint. `log_lock_waits` — off by default, turn it on — logs any session that waits longer than `deadlock_timeout` for a lock, with the blocker.',
      },
      {
        heading: 'What you would see in production',
        body: 'With those four on, an incident reads itself: lock waits name the blocking pid, checkpoint lines line up with the latency spikes, and slow-query entries carry plans. Two cautions. The collector is one process, so logging every statement on a high-TPS cluster makes it a bottleneck and can stall backends writing to a full pipe. And `log_temp_files = 0` plus `log_autovacuum_min_duration` are worth adding — they catch the two problems that otherwise never appear anywhere: work_mem spilling to disk, and vacuums that take longer than you assumed.',
      },
      {
        heading: 'What the city models',
        body: 'The logging building animates a derived teaching rate from modeled locks, checkpoints and activity. The engine has no log messages, pipe, rotation, thresholds, searchable history, collector backpressure, slow-query timing or auto_explain plans.',
      },
    ],
    metrics: [
      {
        label: 'Lock waits',
        get: (s) => fmtNum(s.locks.length),
        hint: 'what log_lock_waits would be printing right now',
      },
      {
        label: 'Longest model wait',
        get: (s) => `${fmtDuration(s.locks.reduce((m, l) => (l.ageSec > m ? l.ageSec : m), 0))} model time`,
      },
      { label: 'Checkpoints logged', get: (s) => fmtNum(s.checkpoint.count) },
      { label: 'Autovacuum runs', get: (s) => fmtNum(s.autovac.totalRuns) },
    ],
    knobs: ['lockContention', 'longRunningXact', 'tps'],
    see: ['stats.collector', 'checkpointer', 'autovac.launcher', 'backend.slot'],
    source: ['src/backend/postmaster/syslogger.c'],
    refs: {
      docs: [
        manual('runtime-config-logging.html', '19.8. Error Reporting and Logging'),
        manual('auto-explain.html', 'F.3. auto_explain'),
      ],
      source: [
        srcFile('src/backend/postmaster/syslogger.c', 'SysLoggerMain, logfile_rotate'),
        srcFile('src/backend/utils/error/elog.c', 'send_message_to_server_log'),
      ],
    },
  },

  {
    id: 'stats.collector',
    title: 'Cumulative statistics',
    subtitle: 'shared memory',
    tldr: 'Every counter the server keeps about itself, and the views that turn them into answers.',
    sections: [
      {
        heading: 'How activity becomes numbers',
        body: 'As backends work they bump counters — tuples read, blocks hit, index scans, transactions committed. Until PostgreSQL 14 those were sent over UDP to a dedicated **stats collector** process, which was lossy under load and wrote temporary files. PostgreSQL 15 removed that process entirely and moved cumulative statistics into shared memory, where they are updated directly and persisted at shutdown. That is why you will find plenty of blog posts referring to a stats collector process that no longer exists on a modern server.',
      },
      {
        heading: 'Two different kinds of view',
        body: 'This distinction causes a lot of confusion. `pg_stat_activity` is a **live** view built from the process array: one row per backend, showing what it is doing right now, its state, its wait event, and how long it has been in that state. Everything named "cumulative" — `pg_stat_user_tables`, `pg_stat_database`, `pg_stat_io`, `pg_stat_wal` — is a counter since the last reset. A counter tells you nothing on its own; the useful quantity is always the difference between two readings, which is what monitoring systems exist to compute.',
      },
      {
        heading: 'The views worth knowing by heart',
        body: '`pg_stat_activity` for "what is happening now", filtered on `state <> \'idle\'` and sorted by `xact_start`. `pg_stat_user_tables` for dead tuples, last autovacuum and the seq-scan-versus-index-scan ratio. `pg_stat_io` (PostgreSQL 16 and later) for who is doing the reads and writes, broken down by backend type. `pg_stat_replication` on the primary and `pg_stat_wal_receiver` on the standby. `pg_locks` joined to `pg_stat_activity` when things are blocked. And `pg_stat_statements` for normalised per-query totals — add it to `shared_preload_libraries`, restart, then run `CREATE EXTENSION pg_stat_statements` in every database where you will query it. Creating the extension without the preload produces an error instead of collecting statistics.',
      },
      {
        heading: 'Things that will catch you',
        body: 'Statistics are approximate by design: `n_live_tup` is an estimate, not a count, and `reltuples` in `pg_class` is only as fresh as the last `VACUUM` or `ANALYZE`. Autovacuum compares its cumulative dead-tuple estimate with a scale threshold derived from that separate `reltuples` value, so the two sources can diverge sharply on a fast-changing table. Within one transaction, repeated reads of a stats view return the same snapshot by default (`stats_fetch_consistency`), which is helpful for consistent queries and confusing when you are polling in a loop. And `pg_stat_reset()` does more damage than people expect: it wipes the dead-tuple counts autovacuum uses to decide what to vacuum, so the next round of maintenance is scheduled on amnesia.',
      },
    ],
    metrics: [
      { label: 'Transactions / s', get: (s) => fmtNum(s.stats.tps) },
      { label: 'Commits', get: (s) => fmtNum(s.stats.commits) },
      {
        label: 'Cache hit ratio',
        get: (s) => fmtPct(ratio(s.stats.blksHit, s.stats.blksHit + s.stats.blksRead), 1),
        hint: 'shared_buffers hits over hits plus reads',
      },
      { label: 'Active backends', get: (s) => `${fmtNum(s.stats.runningBackends)} running` },
      { label: 'Tuples returned', get: (s) => fmtNum(s.stats.tupReturned) },
    ],
    knobs: ['tps', 'writeRatio', 'seqScanRatio'],
    see: ['logger', 'backend.slot', 'checkpointer', 'autovac.launcher'],
    source: ['src/backend/utils/activity/pgstat.c'],
    refs: {
      docs: [
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System'),
        manual('pgstatstatements.html', 'F.32. pg_stat_statements'),
      ],
      source: [
        srcFile('src/backend/utils/activity/pgstat.c', 'pgstat_report_stat'),
        srcFile('src/backend/utils/activity/pgstat_shmem.c'),
      ],
    },
  },

  /* ======================================================================
   * Replication
   * ====================================================================*/
  {
    id: 'net.wire',
    title: 'Replication link',
    subtitle: 'network',
    tldr: 'A TCP connection carrying WAL one way and LSN acknowledgements the other.',
    sections: [
      {
        heading: 'What travels on it',
        body: 'Streaming replication uses the ordinary Postgres port and protocol, opened with a special `replication` connection option. The walsender pushes WAL as it is generated, wrapped in `CopyData` messages, and the standby answers with feedback: the LSNs it has written, flushed and applied. Feedback goes out every `wal_receiver_status_interval` (10 seconds by default), or immediately when the sender asks. `wal_sender_timeout` decides how long silence is tolerated before the connection is torn down and retried.',
      },
      {
        heading: 'Asynchronous replication stays off the commit path',
        body: 'By default the primary does not wait for a standby. A commit is durable locally and WAL travels asynchronously, so failover can lose the byte gap that had not reached the promoted node. Measure current backlog with LSN differences such as `pg_current_wal_lsn() - replay_lsn`. PostgreSQL’s `write_lag`, `flush_lag` and `replay_lag` intervals instead estimate recent commit-delay impact at those stages; they are not a conversion of the current byte gap, a catch-up forecast or a reliable current-staleness clock, and may retain a value before becoming NULL when idle.',
      },
      {
        heading: 'What synchronous_standby_names really does',
        body: 'Naming a standby there, with `synchronous_commit = on`, makes every commit wait for that standby to **flush** the commit record to its own disk before the client is told yes. So every write transaction now pays at least one network round trip. On a 1 ms link that is invisible; across regions at 30 ms it caps you at well under 40 write transactions per second per session, no matter how fast your storage is. `remote_write` waits only for the standby’s OS (cheaper, weaker), and `remote_apply` waits for it to be visible to queries there — much stronger, and hostage to replay speed and query conflicts.',
      },
      {
        heading: 'The availability trap',
        body: 'Synchronous replication is a durability feature that reduces availability. If the only synchronous standby stops responding, commits wait until it returns or the configuration changes. PostgreSQL’s `ANY 1 (s1, s2)` is **quorum-based synchronous replication**: a commit needs one eligible standby acknowledgement. It is not a leader-election or consensus quorum and does not make PostgreSQL a consensus system. That commit quorum is separate from the DCS voting majority used by etcd and from Patroni’s ownership of the DCS leader lock.',
      },
      {
        heading: 'What the city models',
        body: 'The link is a bounded queue of modeled WAL positions with a configurable one-way delay and acknowledgement paths. It has no TCP packets, PostgreSQL protocol, bandwidth, congestion, reconnect timing or socket failures. The network setting can hold modeled commits in commit_wait, but displayed statement time remains deliberately stretched model time rather than production latency.',
      },
    ],
    metrics: [
      {
        label: 'Mode',
        get: (s) => s.knobs.synchronousStandbyNames !== 'none'
          ? configuredSynchronousStandby(s)?.connected
            ? 'synchronous'
            : 'synchronous · waiting for standby'
          : 'asynchronous · names empty',
      },
      {
        label: 'Network latency',
        get: (s) => {
          const standby = configuredSynchronousStandby(s)
          return standby ? `${fmtNum(standby.networkLagMs)} ms` : '—'
        },
        hint: 'one way to the configured synchronous follower',
      },
      {
        label: 'Configured round-trip floor',
        get: (s) => {
          if (s.knobs.synchronousCommit === 'off') return 'none — the commit does not wait at all'
          if (
            (s.knobs.synchronousCommit === 'remote_write'
              || s.knobs.synchronousCommit === 'on'
              || s.knobs.synchronousCommit === 'remote_apply')
            && s.knobs.synchronousStandbyNames !== 'none'
          ) {
            const standby = configuredSynchronousStandby(s)
            return standby?.connected
              ? `${fmtNum(standby.networkLagMs * 2)} ms per commit`
              : 'unbounded · IPC / SyncRep'
          }
          return 'none — local flush only'
        },
        hint: 'input-derived teaching figure; not measured statement latency',
      },
      {
        label: 'In flight',
        get: (s) => fmtNum(configuredSynchronousStandby(s)?.inFlight ?? 0),
        hint: 'WAL records on the configured synchronous follower’s wire',
      },
      {
        label: 'Lag',
        get: (s) => {
          const standby = configuredSynchronousStandby(s)
          return !standby?.enabled || !standby.connected
            ? '—'
            : `${fmtBytes(standby.lagBytes)} · ${fmtDuration(standby.lagSec)}`
        },
      },
    ],
    knobs: ['synchronousCommit', 'synchronousStandbyNames', 'standbyAEnabled', 'standbyANetworkLag', 'standbyASlowApply', 'standbyBEnabled', 'standbyBNetworkLag', 'standbyBSlowApply'],
    see: ['walsender', 'walreceiver', 'replica.standby', 'walwriter'],
    source: ['src/backend/replication/walsender.c', 'src/backend/replication/walreceiver.c'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers — synchronous replication'),
        manual('protocol-replication.html', '54.4. Streaming Replication Protocol'),
      ],
      source: [
        srcFile('src/backend/replication/walsender.c', 'WalSndLoop'),
        srcFile('src/backend/replication/syncrep.c', 'SyncRepWaitForLSN'),
      ],
      suzuki: suzuki(11, 'Streaming Replication (§11.3)'),
    },
  },

  {
    id: 'walreceiver',
    title: 'WAL receiver',
    subtitle: 'background process on the standby',
    tldr: 'Pulls WAL off the socket and onto the standby’s disk — receiving, writing and flushing are three positions.',
    sections: [
      {
        heading: 'What it actually does',
        body: 'On a standby, the startup process launches a **walreceiver**, which connects to the primary, requests a stream from the position it needs, and writes what arrives into the standby’s own `pg_wal`. It does not replay anything — that is the startup process’s job, reading the same files back. So a standby has a real, growing write-ahead log of its own, with its own disk requirements, and its own capacity to fill up.',
      },
      {
        heading: 'Three positions, three guarantees',
        body: '**Received** means the bytes are in the standby’s memory. **Written** means they have gone to the kernel with `write()`, so a Postgres crash on the standby will not lose them. **Flushed** means `fsync()` has returned and they survive the standby losing power. These map onto the `synchronous_commit` levels that involve a standby at all — which only happens once this standby is named in `synchronous_standby_names`: `remote_write` then waits for written, plain `on` for flushed, `remote_apply` for applied. Without that setting, `on` means a local flush on the primary and nothing here is in the commit path at all. The difference is not academic — a synchronous standby that only ever writes is not protecting you against the failure mode where both machines lose power together.',
      },
      {
        heading: 'When the link breaks',
        body: 'If the connection drops, the receiver simply exits — what happens next is the startup process’s decision. It waits `wal_retrieve_retry_interval` and starts a fresh walreceiver, and if a `restore_command` is configured it can pull the missing segments out of the archive instead, which is how a standby that was offline for a day catches up without a rebuild. If neither source can supply the needed segment — because the primary recycled it and there was no slot — the standby stops with `requested WAL segment has already been removed` and must be re-seeded.',
      },
      {
        heading: 'What you would see in production',
        body: '`pg_stat_wal_receiver` on the standby shows `status`, the latest received LSN, and the primary’s host. Compare its received LSN with the startup process’s replay position: if receive is current and replay is far behind, the network is fine and replay is the bottleneck, which is a completely different problem with completely different fixes. `recovery_min_apply_delay` deliberately creates that gap when you want a time-delayed standby as protection against a bad DELETE.',
      },
      {
        heading: 'What the city models',
        body: 'The city advances received, written and flushed LSNs through delayed queues and uses those frontiers for modeled acknowledgements. It does not run a walreceiver, write standby pg_wal files, call write or fsync, retry a broken socket, use restore_command or model a standby disk.',
      },
    ],
    metrics: [
      { label: 'Link', get: (s) => (standbyA(s).connected ? 'streaming' : standbyA(s).enabled ? 'reconnecting' : 'no standby') },
      { label: 'Received', get: (s) => fmtLsn(s.replication.standbys[0].receivedLsn) },
      { label: 'Written', get: (s) => fmtLsn(standbyA(s).writtenLsn) },
      { label: 'Flushed', get: (s) => fmtLsn(standbyA(s).flushedLsn), hint: 'durable on the standby — what synchronous_commit=on waits for, once this standby is in synchronous_standby_names' },
      {
        label: 'Not yet applied',
        get: (s) => fmtBytes(Math.max(0, standbyA(s).flushedLsn - standbyA(s).appliedLsn)),
        hint: 'modeled visibility frontier; no standby query results are executed',
      },
    ],
    knobs: ['standbyAEnabled', 'standbyANetworkLag', 'standbyASlowApply', 'synchronousCommit'],
    see: ['startup.proc', 'walsender', 'net.wire', 'replica.storage'],
    source: ['src/backend/replication/walreceiver.c'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_wal_receiver'),
      ],
      source: [srcFile('src/backend/replication/walreceiver.c', 'WalReceiverMain, XLogWalRcvFlush, XLogWalRcvSendHSFeedback')],
      suzuki: suzuki(11, 'Streaming Replication (§11.1)'),
    },
  },

  {
    id: 'lsn.ruler',
    title: 'Replication LSN ruler',
    subtitle: 'five frontiers on one WAL byte scale',
    tldr: 'Primary flush, sent, standby write, standby flush and replay positions show which replication stage owns each byte gap.',
    sections: [
      {
        heading: 'Read the positions, then subtract',
        body: 'An LSN is a byte position in the WAL stream. The ruler adds the primary’s local flush position as a reference to the four positions PostgreSQL 18 exposes for each directly connected standby in `pg_stat_replication`: `sent_lsn`, `write_lsn`, `flush_lsn` and `replay_lsn`. Subtract adjacent LSNs to count bytes waiting at a stage. A sent-to-write gap focuses investigation on transport or receipt; write-to-flush on standby durability; flush-to-replay on recovery apply. Those gaps localise work but do not prove why it is slow.',
      },
      {
        heading: 'What the ruler cannot tell you',
        body: 'Byte distance is not elapsed time or a catch-up prediction. The `write_lag`, `flush_lag` and `replay_lag` columns are measurements of recent acknowledgement delay and can become NULL when an idle standby is caught up. The city dynamically rescales this ruler to keep gaps visible and advances a fixed teaching pipeline; it does not measure a socket, standby filesystem, WAL records or production replay throughput.',
      },
    ],
    metrics: [
      { label: 'Primary flush', get: (s) => fmtLsn(s.wal.flushLsn) },
      { label: 'Sent', get: (s) => fmtLsn(standbyA(s).sentLsn) },
      { label: 'Written', get: (s) => fmtLsn(standbyA(s).writtenLsn) },
      { label: 'Flushed', get: (s) => fmtLsn(standbyA(s).flushedLsn) },
      { label: 'Replayed', get: (s) => fmtLsn(standbyA(s).appliedLsn) },
    ],
    knobs: ['standbyAEnabled', 'standbyANetworkLag', 'standbyASlowApply', 'synchronousCommit'],
    see: ['walsender', 'net.wire', 'walreceiver', 'startup.proc', 'replica.standby'],
    source: ['src/backend/replication/walsender.c', 'src/backend/replication/walreceiver.c'],
    refs: {
      docs: [
        manual('datatype-pg-lsn.html', '8.20. pg_lsn Type'),
        manual('monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW', '27.2.4. pg_stat_replication'),
      ],
      source: [
        srcFile('src/backend/replication/walsender.c', 'WalSndLoop'),
        srcFile('src/backend/replication/walreceiver.c', 'WalReceiverMain, XLogWalRcvFlush'),
      ],
    },
  },

  {
    id: 'startup.proc',
    title: 'Startup process',
    subtitle: 'the process that replays WAL',
    tldr: 'Reads WAL records and applies them to pages, one at a time, forever on a standby.',
    sections: [
      {
        heading: 'What recovery is',
        body: 'On start, Postgres reads `pg_control`, finds the last checkpoint’s **redo point**, and hands control to the startup process, which reads WAL forward from there. For each record it locates the target page, pulls it into `shared_buffers`, compares the page’s LSN against the record’s, and applies the change if the page is older. That LSN comparison is what makes replay idempotent, so replaying the same WAL twice is harmless — the foundation of both crash recovery and streaming replication.',
      },
      {
        heading: 'Crash recovery and streaming are the same code',
        body: 'A standby is simply a server that never finishes recovery. It replays to the end of what it has, waits for the walreceiver to bring more, and continues. That is why a standby’s data files are always in a valid crash-recoverable state, why promotion is fast (stop replaying, write a new timeline, open for writes), and why an archive-only replica and a streaming replica differ mainly in where the bytes come from.',
      },
      {
        heading: 'Replay is essentially single-threaded',
        body: 'One primary can have two hundred backends generating WAL in parallel. One standby has one startup process applying it in strict LSN order, because the records were written assuming that order. The bottleneck is rarely CPU — it is the read I/O of pulling in each page the records refer to, one page fault at a time. PostgreSQL 15 added `recovery_prefetch`, which reads ahead in the WAL and asks the OS to fetch the pages it will need next, and that helps considerably; it does not change the fundamental serialisation.',
      },
      {
        heading: 'What you would see in production',
        body: `A flush-to-replay gap only localises investigation to apply. Before calling it insufficient replay capacity, inspect paused recovery, the startup process and wait event, the walreceiver, and the standby log.\n\n${renderAction('resumePausedRecovery')}`,
      },
      {
        heading: 'What the city models',
        body: 'The city moves one applied-LSN frontier at a fixed teaching rate and touches representative standby buffer frames as bytes are applied. It does not parse WAL records, identify target relation blocks, compare page LSNs, prefetch pages, charge replay I/O or maintain replica row contents.',
      },
    ],
    metrics: [
      { label: 'Replay LSN', get: (s) => fmtLsn(standbyA(s).appliedLsn) },
      {
        label: 'Behind by',
        get: (s) =>
          !standbyA(s).enabled || !standbyA(s).connected
            ? '—'
            : `${fmtBytes(standbyA(s).lagBytes)} · ${fmtDuration(standbyA(s).lagSec)}`,
      },
      { label: 'Replay activity', get: (s) => fmtPct(standbyA(s).applyActivity, 0) },
      {
        label: 'Crash recovery from',
        get: (s) =>
          `${fmtLsn(s.checkpoint.completedRedoLsn)} (${fmtBytes(Math.max(0, s.wal.flushLsn - s.checkpoint.completedRedoLsn))} of WAL)`,
        hint: 'how much the primary would have to replay right now',
      },
    ],
    knobs: ['standbyASlowApply', 'standbyAEnabled', 'checkpointTimeout', 'maxWalSize'],
    see: ['walreceiver', 'checkpointer', 'replica.standby', 'object.store'],
    source: ['src/backend/postmaster/startup.c', 'src/backend/access/transam/xlog.c'],
    refs: {
      docs: [
        manual('wal-intro.html', '28.3. Write-Ahead Logging (WAL)'),
        manual('wal-configuration.html', '28.5. WAL Configuration — restartpoints'),
      ],
      source: [
        srcFile('src/backend/postmaster/startup.c', 'StartupProcessMain'),
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery, WaitForWALToBecomeAvailable'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.8 Database Recovery)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and checkpoint mechanics', 'the nearest honest chapter; Rogov does not cover replication'),
    },
  },

  {
    id: 'replica.standby',
    title: 'Physical standby',
    subtitle: 'a second cluster replaying the first',
    tldr: 'A block-level replay of the WAL-logged cluster, readable while recovery continues.',
    sections: [
      {
        heading: 'What "physical" means',
        body: 'A physical standby starts from a base backup and replays WAL at the block level for the whole WAL-logged cluster rather than selected logical tables. It is not byte-for-byte identical to the primary: unlogged-table contents are not replicated, temporary objects are local, and WAL files, control state, runtime statistics, configuration and other host-local files differ. Relation blocks affected by replay normally converge through the same WAL history, which is the useful high-availability contrast with selective logical replication.',
      },
      {
        heading: 'Read-only, with a catch',
        body: 'With `hot_standby = on` (the default) you can run queries while replay continues. But replay and queries want opposing things: replay wants to remove a dead row, your query wants to keep reading it. When they collide the standby is allowed to hold replay back by up to `max_standby_streaming_delay` (30 seconds by default) and then **cancels the conflicting query** — `canceling statement due to conflict with recovery`. It is a budget for how far behind replay may fall, measured from when the WAL arrived, not a grace period each query is granted: on a standby that is already lagging, the budget can be spent before your query even starts. Setting that to `-1` means replay waits forever instead, converting query cancellations into unbounded replication lag. There is no setting that avoids the trade; you choose which side pays.',
      },
      {
        heading: 'The four LSNs',
        body: '`pg_stat_replication` exposes `sent_lsn`, `write_lsn`, `flush_lsn` and `replay_lsn`; byte gaps localise the stage where backlog has accumulated, but not a root cause by themselves. A primary-to-sent gap points at or before WAL transmission, including walsender scheduling, WAL availability/read throughput or the link. Later gaps focus investigation on receipt, durable write or replay. The lag interval columns measure recent commit-delay impact at their stages; they are neither current byte gaps expressed as time nor catch-up predictions, and may become NULL on an idle system.',
      },
      {
        heading: 'Failover',
        body: 'Promotion stops recovery, bumps the **timeline**, and opens for writes. Everything downstream of the old primary must then follow that timeline or be rebuilt, which is what timeline history files are for. Two things people learn the hard way: with asynchronous replication, promotion loses whatever WAL had not reached the standby, so measure your lag if you care about the answer; and the old primary must never be brought back up as a primary — use `pg_rewind` or re-seed it, because two writable copies of the same cluster diverge in ways nothing can merge.',
      },
      {
        heading: 'What the city models',
        body: 'The standby is an independent receive/write/flush/apply LSN pipeline with an aggregate data-directory projection and representative buffer sample. It has no copied heap or index pages, replica catalog, row visibility checks, hot-standby SELECT execution, recovery conflicts, query cancellation, restartpoint scheduler or standby-local background processes.',
      },
    ],
    metrics: [
      { label: 'State', get: (s) => (!standbyA(s).enabled ? 'no standby' : standbyA(s).connected ? `streaming (${standbyA(s).mode})` : 'disconnected') },
      { label: 'sent → write', get: (s) => fmtBytes(Math.max(0, standbyA(s).sentLsn - standbyA(s).writtenLsn)), hint: 'network' },
      { label: 'write → flush', get: (s) => fmtBytes(Math.max(0, standbyA(s).writtenLsn - standbyA(s).flushedLsn)), hint: 'standby disk' },
      { label: 'flush → replay', get: (s) => fmtBytes(Math.max(0, standbyA(s).flushedLsn - standbyA(s).appliedLsn)), hint: 'replay speed' },
      { label: 'Model replay delay', get: (s) => (!standbyA(s).enabled || !standbyA(s).connected ? '—' : fmtDuration(standbyA(s).lagSec)), hint: 'simulation gauge; not pg_stat_replication.replay_lag' },
    ],
    knobs: ['standbyAEnabled', 'standbyASlowApply', 'standbyANetworkLag', 'synchronousCommit'],
    see: ['startup.proc', 'replica.client', 'walsender', 'replica.buffers'],
    source: [
      'src/backend/postmaster/startup.c',
      'src/backend/replication/walreceiver.c',
      'src/backend/storage/ipc/procarray.c',
    ],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('hot-standby.html', '26.4. Hot Standby'),
        manual('sql-createtable.html#SQL-CREATETABLE-UNLOGGED', 'CREATE TABLE — UNLOGGED'),
      ],
      source: [
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery'),
        srcFile('src/backend/replication/walreceiver.c', 'WalReceiverMain'),
      ],
      suzuki: suzuki(11, 'Streaming Replication'),
    },
  },

  {
    id: 'replica.buffers',
    title: 'Standby buffer cache',
    subtitle: 'shared memory on the standby',
    tldr: 'Warmed by replay instead of by queries, which is why a fresh failover target is slow.',
    sections: [
      {
        heading: 'Same structure, different contents',
        body: 'The standby has its own `shared_buffers` with the same clock sweep and the same eviction rules. What differs is what fills it. On the primary, buffers hold whatever queries touched. On the standby, the startup process pulls in every page a WAL record modifies, so the cache fills with the primary’s **write set**. Add whatever read-only queries run locally and you get a cache shaped by writes plus local reads, not by the primary’s read pattern.',
      },
      {
        heading: 'Why failover is slow',
        body: 'Consider a table that is read constantly and written rarely. On the primary it is entirely cached; on the standby it was never read, so it is not there at all. The moment you promote, that traffic arrives against a cold cache and every lookup becomes storage I/O — index root pages, branch pages, catalog rows, all of it. The database is up, correct, and several times slower, and it stays that way until the working set is faulted back in. On a large instance that recovery period can be tens of minutes.',
      },
      {
        heading: 'What to do about it',
        body: 'Run representative read traffic on the standby before you need it — this is the strongest argument for using standbys for reporting even when you do not need the capacity. To enable automatic cache restoration, add `pg_prewarm` to `shared_preload_libraries` on each standby and restart it. `CREATE EXTENSION pg_prewarm` makes the manual prewarm function available, but creating the extension alone does not start autoprewarm. Its background worker periodically dumps the list of cached blocks and restores them on startup, which also fixes the unrelated problem of a cold cache after a restart. And when you plan a failover, plan for a warmup window rather than expecting instant parity.',
      },
      {
        heading: 'While it is a standby',
        body: 'The standby runs its own background writer and its own checkpointer, but the checkpointer performs **restartpoints** rather than checkpoints: it flushes dirty buffers and records a safe restart position derived from a checkpoint record it has already replayed. Restartpoints are what bound the standby’s own crash recovery time, they obey the same `checkpoint_timeout` and `max_wal_size` settings, and they can never get ahead of what replay has reached.',
      },
    ],
    metrics: [
      { label: 'Replay activity', get: (s) => fmtPct(standbyA(s).applyActivity, 0), hint: 'what is warming this cache' },
      { label: 'Replayed to', get: (s) => fmtLsn(standbyA(s).appliedLsn) },
      {
        label: 'Primary hit ratio',
        get: (s) => fmtPct(s.buffers.hitRatio, 1),
        hint: 'shown for contrast — the standby cache holds a different set of pages',
      },
      { label: 'Standby', get: (s) => (standbyA(s).enabled ? (standbyA(s).connected ? 'online' : 'disconnected') : 'not running') },
    ],
    knobs: ['standbyAEnabled', 'standbyASlowApply', 'sharedBuffers'],
    see: ['replica.standby', 'startup.proc', 'os.cache', 'checkpointer'],
    source: ['src/backend/storage/buffer/bufmgr.c', 'src/backend/storage/buffer/freelist.c'],
    refs: {
      docs: [
        manual('pgprewarm.html', 'F.30. pg_prewarm'),
        manual('wal-configuration.html', '28.5. WAL Configuration — restartpoints'),
      ],
      source: [
        srcFile('src/backend/storage/buffer/bufmgr.c', 'BufferAlloc'),
        srcFile('src/backend/access/transam/xlog.c', 'CreateRestartPoint'),
      ],
      suzuki: suzuki(8, 'Buffer Manager'),
      rogov: rogov(R_WAL, 'Buffer Cache'),
    },
  },

  {
    id: 'replica.storage',
    title: 'Standby data directory',
    subtitle: 'a physical copy of the primary data directory',
    tldr: 'WAL-replayed relation blocks plus standby-local WAL, control, runtime and configuration state.',
    sections: [
      {
        heading: 'A copy, not a rebuild',
        body: 'The standby’s data directory starts from `pg_basebackup`, and recovery applies WAL-logged block changes to its relation files. `standby.signal` tells startup to enter standby recovery, but it is not the only difference from the primary: the standby owns different WAL files, `pg_control` state, runtime statistics and configuration; temporary objects are local, and unlogged relations are not maintained as replicated table contents. Physical replication means whole-cluster WAL replay, not byte identity of two directories.',
      },
      {
        heading: 'Why you cannot just cp the directory',
        body: 'Copying a running cluster with `cp` or `rsync` yields files from different instants with no record of which WAL would reconcile them. The backup API — `pg_backup_start()` and `pg_backup_stop()`, renamed in PostgreSQL 15 when the old exclusive-backup mode was removed — exists to bracket that copy, forces a checkpoint, and returns the starting LSN and backup label recovery needs. `pg_basebackup` does all of it for you, streams the WAL generated during the copy, and is what you should use unless you have a good reason not to.',
      },
      {
        heading: 'Its own WAL, its own bookkeeping',
        body: 'The standby writes everything it receives into its own `pg_wal`, so it needs comparable WAL space to the primary, and it can fill its disk in all the same ways — particularly if it is itself the source for a cascading standby with a slot. It also maintains its own `pg_control` (with a different state field), its own statistics, and its own restartpoint history. Tablespaces are the usual practical snag: they are symlinks, and a standby on a host with different mount points needs them remapped.',
      },
      {
        heading: 'What you would see in production',
        body: 'A standby’s file sizes track the primary’s closely but not instantly, because the extension records have not all been replayed yet. If they diverge permanently, something is wrong — most often the standby was promoted at some point, wrote its own data, and is now a fork rather than a copy. That is what `pg_rewind` is for: it uses WAL to find the blocks that changed since divergence and copies just those back, which is far cheaper than a full re-seed.',
      },
      {
        heading: 'What the city models',
        body: 'This building reports the primary model’s aggregate data-directory byte estimate together with the standby applied LSN. It does not copy or extend relation files, keep per-fork sizes, store standby-local WAL/control/configuration, or make the byte total lag behind replay.',
      },
    ],
    metrics: [
      { label: 'Replayed to', get: (s) => fmtLsn(standbyA(s).appliedLsn) },
      { label: 'Primary at', get: (s) => fmtLsn(s.wal.insertLsn) },
      { label: 'Divergence', get: (s) => fmtBytes(Math.max(0, s.wal.insertLsn - standbyA(s).appliedLsn)), hint: 'how stale the copy is right now' },
      { label: 'Aggregate size projection', get: (s) => fmtBytes(sumTables(s, (t) => t.pages) * PAGE), hint: 'primary relation-size estimate; no replica files are stored' },
    ],
    knobs: ['standbyAEnabled', 'standbyASlowApply', 'standbyANetworkLag'],
    see: ['storage.datadir', 'replica.standby', 'walreceiver', 'object.store'],
    source: ['src/backend/storage/smgr/md.c', 'src/backend/postmaster/startup.c'],
    refs: {
      docs: [
        manual('app-pgbasebackup.html', 'pg_basebackup'),
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-in-Time Recovery (PITR)'),
      ],
      source: [srcFile('src/backend/backup/basebackup.c', 'SendBaseBackup')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR) (§10.1 Base Backup)'),
    },
  },

  {
    id: 'standby.b',
    title: 'standby_b — an independent node',
    subtitle: 'the second physical standby',
    tldr: 'Its own server state, not a second drawing of standby_a: its own buffer pool, WAL, data directory, replay position, slot, and leader opinion.',
    sections: [
      {
        heading: 'Three servers, not one shared truth',
        body: 'The primary, `standby_a`, and `standby_b` each own a separate buffer pool (`shared_buffers`), `pg_wal`, and data directory. Each standby has its own primary-side walsender, network stream, walreceiver, and startup process. A fast standby cannot advance the slow one’s applied LSN, and disconnecting one does not disconnect the other. The city gives every node the same 1,024-frame sample capacity; at the default 2 GiB setting 256 frames are active on each node. It does not emulate three operating systems, storage controllers, or PostgreSQL postmasters.',
      },
      {
        heading: 'Received, flushed, and applied are different facts',
        body: '`received_lsn` here is the furthest byte delivered to that node’s walreceiver. `flush_lsn` is durable in that standby’s own `pg_wal`. `applied_lsn` is the last record its startup process has replayed into data pages, so only applied data is visible to reads. The model also retains `written_lsn` between receive and flush. Timing and packet travel are visually stretched 6×, while every displayed duration is converted back to configured time; replay throughput is a bounded teaching rate, not a benchmark of any hardware.',
      },
      {
        heading: 'Two physical slots, two independent disk clocks',
        body: 'The primary owns `standby_a_slot` and `standby_b_slot`. While a standby is connected, its slot’s `restart_lsn` follows the standby’s durable progress. Disconnect it and the slot remains inactive at that position, forcing the primary to keep every later WAL segment. This city gives the primary WAL volume a scaled 512 MiB safety limit so the failure is observable quickly; real capacity is installation-specific, and real PostgreSQL PANICs on a full filesystem rather than politely rejecting only new writes.',
      },
      {
        heading: 'Opinion becomes action through Patroni',
        body: 'Every node still stores its own observed leader, but its local Patroni agent acts only through the linearizable DCS leader key. A committed compare-and-swap updates the reachable agents’ opinions and moves the service address. After unplanned failover, the offline former primary keeps its stale opinion and divergent WAL until `pg_rewind` repairs it; that disagreement is evidence of the fork, not authority to accept writes.',
      },
    ],
    metrics: [
      { label: 'Received', get: (s) => fmtLsn(s.replication.standbys[1].receivedLsn) },
      { label: 'Flushed', get: (s) => fmtLsn(s.replication.standbys[1].flushedLsn) },
      { label: 'Applied', get: (s) => fmtLsn(s.replication.standbys[1].appliedLsn) },
      {
        label: 'Lag',
        get: (s) => `${fmtBytes(s.replication.standbys[1].lagBytes)} · ${fmtDuration(s.replication.standbys[1].lagSec)}`,
      },
      {
        label: 'Physical slot',
        get: (s) => s.replication.physicalSlots[1].exists
          ? `${s.replication.physicalSlots[1].active ? 'active' : 'inactive'} · ${fmtBytes(s.replication.physicalSlots[1].retainedBytes)} retained`
          : 'dropped · no retention guarantee',
      },
      {
        label: 'Leader opinion',
        get: (s) => s.cluster.nodes[2].leaderOpinion ?? 'unknown',
        hint: 'the linearizable DCS leader key, not this local observation, authorizes writes',
      },
    ],
    knobs: ['standbyBEnabled', 'standbyBNetworkLag', 'standbyBSlowApply', 'standbyBLongQuery'],
    see: ['standby.b.receiver', 'standby.b.wal', 'standby.b.startup', 'standby.b.buffers', 'standby.b.storage', 'replica.standby'],
    source: [
      'src/backend/replication/walsender.c',
      'src/backend/replication/walreceiver.c',
      'src/backend/access/transam/xlogrecovery.c',
    ],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('view-pg-replication-slots.html', 'pg_replication_slots'),
      ],
      source: [
        srcFile('src/backend/replication/walsender.c', 'WalSndLoop'),
        srcFile('src/backend/replication/walreceiver.c', 'WalReceiverMain'),
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery'),
      ],
      suzuki: suzuki(11, 'Streaming Replication'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and checkpoint mechanics', 'the nearest honest chapter; Rogov does not cover replication'),
    },
  },

  {
    id: 'standby.b.receiver',
    title: 'standby_b walreceiver',
    subtitle: 'background process on standby_b',
    tldr: 'Receives standby_b’s stream and writes it into standby_b’s own pg_wal.',
    sections: [
      {
        heading: 'An independent receiver',
        body: 'This is not standby_a’s receiver mirrored across the city. It has its own connection, received and written positions, status replies, and failure state. Turning off `standby_b connected` stops this process alone while its physical slot remains on the primary.',
      },
      {
        heading: 'The model boundary',
        body: 'The city separates socket receipt, `write()` progress, and `fsync()` progress with bounded rates so their ordering is visible. It does not model kernel page-cache size, WAL receiver wakeups, partial system calls, compression, SSL, or network bandwidth; configured one-way delay and the resulting acknowledgement path are the teaching inputs.',
      },
    ],
    metrics: [
      { label: 'Process', get: (s) => s.replication.standbys[1].walReceiver },
      { label: 'Received', get: (s) => fmtLsn(s.replication.standbys[1].receivedLsn) },
      { label: 'Written', get: (s) => fmtLsn(s.replication.standbys[1].writtenLsn) },
      { label: 'In flight', get: (s) => fmtNum(s.replication.standbys[1].inFlight) },
    ],
    knobs: ['standbyBEnabled', 'standbyBNetworkLag'],
    see: ['standby.b.wal', 'standby.b.startup', 'walsender'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_wal_receiver'),
      ],
      source: [srcFile('src/backend/replication/walreceiver.c', 'WalReceiverMain, XLogWalRcvFlush, XLogWalRcvSendHSFeedback')],
      suzuki: suzuki(11, 'Streaming Replication (§11.1)'),
    },
  },

  {
    id: 'standby.b.wal',
    title: 'standby_b write-ahead log',
    subtitle: 'a separate pg_wal directory',
    tldr: 'Durable received WAL on standby_b, distinct from both the primary and standby_a.',
    sections: [
      {
        heading: 'What lives here',
        body: 'The walreceiver writes physical records into this node’s own 16 MiB segment files. A record can be durable here while the startup process has not applied it yet; that is the flush-to-apply gap. Slowing replay therefore grows standby_b’s own WAL working set without making standby_a lag.',
      },
      {
        heading: 'What the primary slot protects',
        body: 'The physical slot lives on the primary, not here. It protects the primary’s copy of WAL until standby_b confirms durable progress. Once this node disconnects, its local files stop moving while the primary’s retained WAL grows from the frozen `restart_lsn`.',
      },
    ],
    metrics: [
      { label: 'Flushed', get: (s) => fmtLsn(s.replication.standbys[1].flushedLsn) },
      { label: 'Applied', get: (s) => fmtLsn(s.replication.standbys[1].appliedLsn) },
      { label: 'pg_wal', get: (s) => fmtBytes(s.cluster.nodes[2].wal.diskBytes) },
    ],
    knobs: ['standbyBEnabled', 'standbyBSlowApply'],
    see: ['standby.b.receiver', 'standby.b.startup', 'wal.vault'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('wal-internals.html', '28.6. WAL Internals'),
      ],
      source: [srcFile('src/backend/replication/walreceiver.c', 'XLogWalRcvWrite, XLogWalRcvFlush')],
      suzuki: suzuki(11, 'Streaming Replication (§11.1)'),
    },
  },

  {
    id: 'standby.b.startup',
    title: 'standby_b startup process',
    subtitle: 'single ordered WAL replay',
    tldr: 'Applies standby_b’s durable WAL without advancing standby_a.',
    sections: [
      {
        heading: 'One replay cursor per standby',
        body: 'Each standby startup process advances only its own applied LSN and data pages. With `standby_b slow replay` on, receive and flush can remain close to the primary while this cursor falls behind. That is why a row in `pg_stat_replication` belongs to one standby rather than to “the cluster”.',
      },
      {
        heading: 'Scaled replay',
        body: 'Healthy replay is capped at a visible teaching rate and slow replay at 35% of the current WAL production rate, with a small floor so recovery can continue after writes stop. PostgreSQL replay speed depends on record mix, storage, prefetch, CPU, and conflicts; the direction and independent queues are the lesson, not the absolute MiB/s.',
      },
    ],
    metrics: [
      { label: 'Process', get: (s) => s.replication.standbys[1].startupProcess },
      { label: 'Applied', get: (s) => fmtLsn(s.replication.standbys[1].appliedLsn) },
      {
        label: 'Waiting',
        get: (s) => fmtBytes(Math.max(0, s.replication.standbys[1].flushedLsn - s.replication.standbys[1].appliedLsn)),
      },
    ],
    knobs: ['standbyBSlowApply', 'standbyBEnabled'],
    see: ['standby.b.wal', 'standby.b.buffers', 'startup.proc'],
    refs: {
      docs: [
        manual('wal-intro.html', '28.3. Write-Ahead Logging (WAL)'),
        manual('wal-configuration.html', '28.5. WAL Configuration — restartpoints'),
      ],
      source: [
        srcFile('src/backend/postmaster/startup.c', 'StartupProcessMain'),
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery, WaitForWALToBecomeAvailable'),
      ],
      suzuki: suzuki(9, 'Write Ahead Logging (WAL) (§9.8 Database Recovery)'),
      rogov: rogov(R_WAL, 'Write-Ahead Log — recovery and checkpoint mechanics', 'the nearest honest chapter; Rogov does not cover replication'),
    },
  },

  {
    id: 'standby.b.buffers',
    title: 'standby_b buffer pool',
    subtitle: 'standby_b shared_buffers',
    tldr: 'A separate representative cache, with 256 of its 1,024-frame capacity active at the default setting, warmed by standby_b replay.',
    sections: [
      {
        heading: 'Independent cache contents',
        body: 'Replay touches this node’s buffer frames only. The sample uses the same fixed upper bound as the primary plaza and standby_a, but the valid, dirty, usage, relation, block, and last-touch arrays are separate objects. A tile lit here says standby_b replay touched it; it says nothing about residency on either other node.',
      },
      {
        heading: 'Restartpoint simplification',
        body: 'The model cleans a small bounded number of replay-dirtied sample frames per tick to represent standby restartpoint writeback. It does not run a second full checkpointer state machine or model standby-local read traffic. Real standby buffer contents and restartpoint timing are workload- and hardware-dependent.',
      },
    ],
    metrics: [
      { label: 'Sample frames', get: (s) => fmtNum(s.cluster.nodes[2].buffers.sampleFrames) },
      { label: 'Used', get: (s) => fmtNum(s.cluster.nodes[2].buffers.usedCount) },
      { label: 'Dirty', get: (s) => fmtNum(s.cluster.nodes[2].buffers.dirtyCount) },
      { label: 'Replay activity', get: (s) => fmtPct(s.replication.standbys[1].applyActivity, 0) },
    ],
    knobs: ['sharedBuffers', 'standbyBSlowApply'],
    see: ['standby.b.startup', 'standby.b.storage', 'replica.buffers'],
    refs: {
      docs: [
        manual('pgprewarm.html', 'F.30. pg_prewarm'),
        manual('wal-configuration.html', '28.5. WAL Configuration — restartpoints'),
      ],
      source: [
        srcFile('src/backend/storage/buffer/bufmgr.c', 'BufferAlloc'),
        srcFile('src/backend/access/transam/xlog.c', 'CreateRestartPoint'),
      ],
      suzuki: suzuki(8, 'Buffer Manager'),
      rogov: rogov(R_WAL, 'Buffer Cache'),
    },
  },

  {
    id: 'standby.b.storage',
    title: 'standby_b data directory',
    subtitle: 'a separate physical copy',
    tldr: 'Its files are current through standby_b’s applied LSN, not through either other node’s opinion.',
    sections: [
      {
        heading: 'A separate directory',
        body: 'This node begins as a physical base backup and replay changes its own pages in WAL order. The model reports the same logical relation size for all three nodes and a different applied frontier; it does not duplicate every table and index counter or model filesystem allocation differences.',
      },
      {
        heading: 'Lag is not promotion',
        body: 'Falling behind changes what a read on this data directory can see. It does not by itself promote the node or make the copy writable. The local Patroni agent must commit a compare-and-swap that acquires the DCS leader key and then explicitly promote PostgreSQL; if that happens while this node is behind, the missing durable interval on the old primary is exactly the failover loss.',
      },
    ],
    metrics: [
      { label: 'Size', get: (s) => fmtBytes(s.cluster.nodes[2].dataDirectory.bytes) },
      { label: 'Applied through', get: (s) => fmtLsn(s.cluster.nodes[2].dataDirectory.appliedLsn) },
      { label: 'Primary at', get: (s) => fmtLsn(s.cluster.nodes[0].dataDirectory.appliedLsn) },
    ],
    knobs: ['standbyBEnabled', 'standbyBSlowApply'],
    see: ['standby.b', 'standby.b.buffers', 'storage.datadir'],
    refs: {
      docs: [
        manual('app-pgbasebackup.html', 'pg_basebackup'),
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-in-Time Recovery (PITR)'),
      ],
      source: [srcFile('src/backend/backup/basebackup.c', 'SendBaseBackup')],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR) (§10.1 Base Backup)'),
    },
  },

  {
    id: 'replica.client',
    title: 'Standby clients',
    subtitle: 'read-only traffic',
    tldr: 'Reads offloaded to the standby — with lag you must design for and a vacuum bill you may pay.',
    sections: [
      {
        heading: 'What works and what does not',
        body: 'On a hot standby, `SELECT` works normally, including temporary use of `work_mem`, sorts and parallel query. Anything that writes fails with `cannot execute … in a read-only transaction`, and that includes the non-obvious cases: `nextval()` on a sequence, `CREATE TEMP TABLE`, and any function that writes. Advisory locks work but are local to that server. Plan for these at the connection-routing layer, not by catching errors.',
      },
      {
        heading: 'Read-your-writes does not hold',
        body: 'Asynchronous replication means a client that inserts on the primary and immediately reads from the standby can legitimately fail to see its own row. This breaks a surprising amount of application code, and the fixes are all architectural: route a session to the primary for a period after it writes, use `pg_wal_lsn_diff` against a captured LSN to wait for the standby to catch up, or accept staleness explicitly for read paths where it is safe. Load balancing reads is not transparent, and treating it as transparent is how the subtle bugs get in.',
      },
      {
        heading: 'hot_standby_feedback and what it costs the primary',
        body: 'Long analytical queries on a standby get cancelled when replay needs to remove rows they are still reading. `hot_standby_feedback = on` fixes that by having the standby report its oldest snapshot xmin back to the primary through the walreceiver’s feedback message; the primary’s vacuum then refuses to remove anything newer. The bug is gone and the cost has moved: a two-hour report on the standby now holds the primary’s vacuum horizon for two hours, and the primary bloats. It is the long-running-transaction problem, executed remotely.',
      },
      {
        heading: 'What you would see in production',
        body: 'Tables bloating on the primary with no long transactions visible in its own `pg_stat_activity` — check `backend_xmin` in `pg_stat_replication`, which is the standby holding the horizon. The usual compromise is to leave `hot_standby_feedback` off and raise `max_standby_streaming_delay` on a standby dedicated to reporting, so long queries survive without the primary paying, at the cost of that standby lagging while they run. Keep the failover standby separate from the reporting standby, and give them different settings.',
      },
      {
        heading: 'What the city models',
        body: 'The read-only client emits illustrative traffic and the standby-long-query control can pin the primary xmin horizon through modeled feedback. The city does not execute a standby SELECT, return replica rows, maintain a replica catalog or buffer query, detect recovery conflicts, cancel queries or measure standby-query time. Replay LSN is only a visibility frontier here.',
      },
    ],
    metrics: [
      { label: 'Standby route', get: (s) => (standbyA(s).enabled ? (standbyA(s).connected ? 'illustrative reads active' : 'offline') : 'not running'), hint: 'no replica query results are modeled' },
      {
        label: 'Staleness',
        get: (s) =>
          !standbyA(s).enabled || !standbyA(s).connected
            ? '—'
            : `${fmtDuration(standbyA(s).lagSec)} · ${fmtBytes(standbyA(s).lagBytes)}`,
      },
      {
        label: 'Vacuum horizon held',
        get: (s) => `${fmtDuration(s.oldestSnapshotAge)} · ${fmtNum(Math.max(0, s.xid - s.xminHorizon))} xids`,
        hint: 'what feedback from a long standby query would look like on the primary',
      },
      {
        label: 'Dead rows on primary',
        get: (s) => fmtNum(sumTables(s, (t) => t.deadTuples)),
      },
    ],
    knobs: ['standbyAEnabled', 'standbyASlowApply', 'standbyALongQuery', 'seqScanRatio'],
    see: ['replica.standby', 'autovac.worker', 'net.wire', 'replica.buffers'],
    source: ['src/backend/storage/ipc/procarray.c', 'src/backend/replication/walsender.c'],
    refs: {
      docs: [
        manual('hot-standby.html', '26.4. Hot Standby'),
        manual('runtime-config-replication.html', '19.6. Replication — standby servers'),
      ],
      source: [
        srcFile('src/backend/storage/ipc/standby.c', 'ResolveRecoveryConflictWithSnapshot'),
        srcFile('src/backend/replication/walreceiver.c', 'XLogWalRcvSendHSFeedback'),
      ],
    },
  },

  {
    id: 'subscriber',
    title: 'Logical subscriber',
    subtitle: 'a separate, writable database',
    tldr: 'A logical replica: selective and cross-version, but not a physical standby or block-level copy.',
    sections: [
      {
        heading: 'How it works',
        body: 'The publisher defines a `PUBLICATION` naming tables (or `FOR ALL TABLES`). The subscriber creates a `SUBSCRIPTION`, which opens a replication connection, creates a logical slot on the publisher, and starts an **apply worker**. Initial data is copied per table by table-sync workers running `COPY`; once a table finishes its snapshot, the apply worker takes over and streams changes from the slot as ordinary INSERT, UPDATE and DELETE statements. The subscriber is a completely normal database that happens to have a process writing into it.',
      },
      {
        heading: 'What it can do that physical replication cannot',
        body: 'Replicate a subset of tables, rows or columns. Replicate **between major versions**, which supports near-zero-downtime upgrades (PostgreSQL 17 added `pg_createsubscriber` to build one from an existing physical standby). A logical replica can have extra tables, different indexes and local writes, or consolidate several publishers. Those are differences from a physical standby, not reasons to say it is not a replica.',
      },
      {
        heading: 'What it cannot do',
        body: 'DDL is not replicated: add a column on the publisher and the subscriber will not have it, and depending on order that stops replication. Sequences are not replicated, so after failing over to a subscriber you must advance them by hand or issue duplicate keys. Large objects are not replicated. Updated and deleted rows need a replica identity — a primary key, or an explicit `REPLICA IDENTITY`. And because the subscriber is writable, nothing prevents local writes from conflicting with incoming ones.',
      },
      {
        heading: 'What you would see in production',
        body: 'The characteristic failure is replication stopping dead on one conflicting row — a duplicate key, a missing row for an UPDATE — with the apply worker retrying the same transaction in a loop and lag growing without bound. You fix it by resolving the row, or by skipping the transaction, and `subscription … disable_on_error` (PostgreSQL 15) keeps it from spinning. Also watch the slot on the publisher: an unhealthy subscriber is an idle slot, and an idle slot is the primary’s WAL volume filling up. PostgreSQL 16 added parallel apply for large streamed transactions, which helps when a single apply worker is the bottleneck.',
      },
      {
        heading: 'What the city models',
        body: 'The subscriber is an illustrative endpoint for the decoder’s derived changes-per-second rate and collapsed logical-slot LSN. It has no publications, table sync, decoded transactions, row values, apply worker, subscriber tables, conflicts, DDL, sequences or acknowledgement independent of that one slot position.',
      },
    ],
    metrics: [
      {
        label: 'Illustrative route',
        get: (s) => (s.knobs.walLevel !== 'logical' ? 'off — wal_level is not logical' : s.replication.logicalEnabled ? 'active' : 'idle'),
      },
      { label: 'Changes / s', get: (s) => fmtNum(s.replication.logicalEnabled ? s.replication.logicalChangesPerSec : 0), hint: 'derived rate projection; no row-level operations are applied' },
      { label: 'Confirmed to', get: (s) => (s.replication.logicalEnabled ? fmtLsn(s.replication.logicalSlotLsn) : '—'), hint: 'confirmed_flush_lsn; real retention can begin earlier at restart_lsn' },
      {
        label: 'WAL retained for it',
        get: (s) =>
          !s.replication.logicalEnabled
            ? 'nothing — no subscription exists'
            : fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.logicalSlotLsn)),
        hint: 'model estimate from a collapsed slot position; query restart_lsn for real retained WAL',
      },
    ],
    knobs: ['walLevel', 'writeRatio', 'updateRatio', 'standbyANetworkLag'],
    see: ['logical.decoder', 'walsender', 'replica.standby', 'wal.vault'],
    source: [
      'src/backend/replication/logical/decode.c',
      'src/backend/replication/logical/reorderbuffer.c',
      'src/backend/replication/slot.c',
    ],
    refs: {
      docs: [
        manual('logical-replication.html', 'Chapter 29. Logical Replication'),
        manual('logical-replication-restrictions.html', '29.8. Restrictions'),
      ],
      source: [
        srcFile('src/backend/replication/logical/worker.c', 'ApplyWorkerMain'),
        srcFile('src/backend/replication/logical/tablesync.c', 'LogicalRepSyncTableStart'),
      ],
      suzuki: suzuki(12, 'Logical Replication (§12.7 Apply Worker and Transaction Replay — the author still marks this chapter beta)'),
    },
  },
]
