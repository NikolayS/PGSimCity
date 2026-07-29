import { poolBytes } from '../core/types'
import type { BookRef, CheckpointPhase, ComponentDoc, DocRef, SimState, TableSim, VacPhase, WalSegment } from '../core/types'
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
 * the thing it points at — the manual page title, the file on master, the
 * function name inside it, the chapter number on interdb.jp. A reference
 * nobody checked is worse than no reference, so where a book genuinely has no
 * chapter on a subject, the field is simply absent.
 * -------------------------------------------------------------------------*/

const DOCS_BASE = 'https://www.postgresql.org/docs/current/'
const SRC_BASE = 'https://github.com/postgres/postgres/blob/'
const SUZUKI_BASE = 'https://www.interdb.jp/pg/'

/** A page of the PostgreSQL manual. `page` may carry a #ANCHOR. */
const manual = (page: string, label: string): DocRef => ({ label, url: DOCS_BASE + page })

/** A file on master, with the functions worth opening it for. */
const srcFile = (path: string, symbol?: string): DocRef => ({ label: path, url: `${SRC_BASE}master/${path}`, symbol })

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
        body: 'Turning `synchronous_commit` off typically transforms commit latency on write-heavy OLTP, because commits stop paying storage latency. The price is precise and worth stating plainly: after a power loss or OS crash you lose the last fraction of a second of *committed* transactions. Nothing is corrupted — the database is consistent, it is simply slightly older than the acknowledgements your application already sent. That is a business decision, not a technical one, and it can be made per transaction because `synchronous_commit` is settable inside a session.',
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
    tldr: 'A directory of 16 MiB segments holding every change, and the most common way a Postgres server dies.',
    sections: [
      {
        heading: 'What is actually in there',
        body: 'The write-ahead log is one enormous append-only byte stream, cut into files of 16 MiB (fixed at `initdb` time with `--wal-segsize`). A position in that stream is an **LSN**, printed as two hex halves like `1A/3F0C8B20`; it is simply a byte offset, so subtracting two LSNs gives you bytes of WAL, which is how every replication-lag query works. The 24-character filenames are not sequential prettiness: they are timeline, log id and segment number in hex, which is why `000000010000000000000023` follows `…22`.',
      },
      {
        heading: 'Recycled, not deleted',
        body: 'When a checkpoint finishes, the segments that lie entirely before the new redo point are no longer needed for crash recovery. Rather than delete them, the checkpointer **renames** them to the filenames they will need next, so a future write lands in a file that is already allocated at full size and never has to extend the filesystem mid-transaction. A recycled segment is not zeroed — the old bytes stay where they are and are simply overwritten as the WAL advances, which is why the tail of a partly used segment can still hold readable fragments of an earlier one. `min_wal_size` (80MB by default) is how much it keeps around for that purpose; `max_wal_size` is roughly how much it is willing to accumulate before forcing a checkpoint. Both are targets, not hard limits.',
      },
      {
        heading: 'Every way this directory fills up',
        body: 'There are three classic causes and they all look identical from the outside — `pg_wal` grows without bound. A failing `archive_command` means segments cannot be marked done, so none of them can be recycled. A **replication slot** whose consumer went away holds `restart_lsn` fixed forever, and the server will not remove WAL a slot still claims to need. And a write rate far above what checkpoints can absorb pushes WAL past `max_wal_size`, because that limit is soft: Postgres will exceed it rather than stall your writes.',
      },
      {
        heading: 'What you would see in production',
        body: 'Disk usage climbs steadily on the WAL volume while everything else looks healthy, and then the server PANICs with `could not write to file … No space left on device` and restarts. Do not delete files from `pg_wal` by hand — that is how a recoverable incident becomes an unrecoverable one. Fix the cause: repair or temporarily neuter archiving, drop the abandoned slot with `pg_drop_replication_slot`, and set `max_slot_wal_keep_size` (PostgreSQL 13 and later) so a dead slot is invalidated rather than allowed to take the primary down with it.',
      },
      {
        heading: 'How to watch it',
        body: 'Query `pg_replication_slots` and look at `active`, `wal_status` and `safe_wal_size` — `wal_status` moving from `reserved` to `extended` to `unreserved` to `lost` is the disk filling in slow motion. `unreserved` is the one to page on: the WAL that slot needs is now beyond `max_slot_wal_keep_size` and can be removed at the next checkpoint, so it is the last moment at which the slot can still be saved. By `lost` the segments are gone and whatever was consuming that slot has to be rebuilt. `pg_stat_archiver.last_failed_time` tells you whether archiving is the culprit. `SELECT pg_current_wal_lsn()` minus a slot LSN gives you exactly how many bytes one consumer is holding hostage.',
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
        body: 'When a WAL segment is filled and closed, Postgres drops a zero-length marker into `pg_wal/archive_status/` named `<segment>.ready`. The archiver process watches for those, runs your `archive_command` (or calls into an `archive_library`, available since PostgreSQL 15) once per segment, and on success renames the marker to `.done`, which is what finally permits the checkpointer to recycle the file. It works strictly one segment at a time, and it is the only thing standing between you and losing point-in-time recovery.',
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
      { label: 'Queue depth', get: (s) => fmtNum(s.wal.archiveQueue), hint: '.ready files waiting for the archiver' },
      { label: 'Segments archived', get: (s) => fmtNum(s.wal.archived) },
      { label: 'In flight', get: (s) => fmtNum(countSegs(s, 'archiving')), hint: 'the archiver copies one at a time' },
      {
        label: 'Backlog size',
        get: (s) => fmtBytes(s.wal.archiveQueue * s.wal.segmentSize),
        hint: 'WAL that exists only on the primary — still safe in pg_wal, lost only if you lose the primary\'s storage',
      },
    ],
    knobs: ['tps', 'writeRatio', 'maxWalSize'],
    see: ['archive.store', 'wal.vault', 'checkpointer', 'walsender'],
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
    id: 'archive.store',
    title: 'WAL archive',
    subtitle: 'off-cluster storage',
    tldr: 'A base backup plus every WAL segment since it — the only combination that is actually a backup.',
    sections: [
      {
        heading: 'Why it exists',
        body: 'A base backup is a copy of the data directory taken while the server is running, so it is internally inconsistent by construction: file 3000 was read minutes after file 1. What makes it usable is the WAL generated during the copy, replayed on restore, which drags every page forward to a single consistent moment. This is why a `pg_basebackup` tarball with no WAL is not a backup you can trust — it is a pile of pages from different instants.',
      },
      {
        heading: 'What it buys you',
        body: 'With a base backup and an unbroken WAL chain you can restore to **any point in time** covered by that chain. You set `restore_command`, drop a `recovery.signal` file, and give a `recovery_target_time`, `recovery_target_lsn` or `recovery_target_xid`; the startup process replays forward and stops exactly there. That is the difference between "we restore last night’s dump and lose the day" and "we restore to 14:31:59, one second before the DELETE".',
      },
      {
        heading: 'The chain is the fragile part',
        body: 'Recovery needs every segment from the backup’s start LSN to your target, in order, with no gaps. One segment lost to a failed archive command that was later "fixed" by skipping it makes every backup older than the gap unrestorable past that point. Retention arithmetic follows: if you keep 14 days of PITR you must keep 14 days of WAL *and* the base backup that precedes the oldest one. Also keep the timeline history files — after a promotion, recovery needs them to follow the branch.',
      },
      {
        heading: 'What you would see in production',
        body: 'The failure mode is not a bad backup, it is an untested one. Restores expose the things monitoring does not: a `restore_command` that cannot see the archive from the restore host, a missing tablespace symlink, a backup taken with the old exclusive-backup API that was removed in PostgreSQL 15, or simply that a full restore of 4 TiB from object storage takes six hours and your RTO said one. Restore on a schedule, into a throwaway host, and time it.',
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
        get: (s) => {
          const bytes = s.wal.archived * s.wal.segmentSize
          const rate = s.wal.bytesPerSec
          return rate > 0 ? fmtDuration(bytes / rate) : '—'
        },
        hint: 'how far back you could rewind, at the current WAL rate',
      },
      { label: 'Unarchived', get: (s) => fmtNum(s.wal.archiveQueue), hint: 'segments not yet safe off-host' },
    ],
    knobs: ['tps', 'writeRatio', 'fullPageWrites'],
    see: ['archiver', 'wal.vault', 'startup.proc', 'replica.storage'],
    source: ['src/backend/postmaster/pgarch.c', 'src/backend/access/transam/xlog.c'],
    refs: {
      docs: [
        manual('continuous-archiving.html', '25.3. Continuous Archiving and Point-in-Time Recovery (PITR)'),
        manual('app-pgbasebackup.html', 'pg_basebackup'),
      ],
      source: [
        srcFile('src/backend/access/transam/xlogrecovery.c', 'PerformWalRecovery, InitWalRecovery'),
        srcFile('src/backend/access/transam/xlogarchive.c', 'RestoreArchivedFile'),
      ],
      suzuki: suzuki(10, 'Online Backup and Point-In-Time Recovery (PITR) (§10.2)'),
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
        body: 'Without a slot, the primary has no idea what a disconnected standby still needs, so a standby that is down for longer than your WAL retention comes back to `requested WAL segment has already been removed` and must be rebuilt. A **replication slot** fixes that by storing the consumer’s position durably on the primary: `restart_lsn` for physical slots, `confirmed_flush_lsn` for logical ones. No WAL from that position onwards is ever recycled. That is the entire point of a slot, and also its entire danger.',
      },
      {
        heading: 'How a slot takes down a primary',
        body: 'A slot does not expire. A standby that was decommissioned without dropping its slot, a subscriber that crashed, a CDC pipeline someone turned off for the weekend — each pins `restart_lsn` and `pg_wal` grows at your full WAL rate until the volume is full and the primary PANICs. Set `max_slot_wal_keep_size` (PostgreSQL 13 and later) so that an abandoned slot is marked `lost` and the WAL is freed; losing one replica beats losing the primary. Monitor `pg_replication_slots` for `active = false` with a growing lag.',
      },
      {
        heading: 'What you would see in production',
        body: 'In `pg_stat_replication` the interesting columns are the four LSNs and their three lag intervals. `sent_lsn` far ahead of `write_lsn` means the network is the constraint. `flush_lsn` close behind `write_lsn` but `replay_lsn` far behind means the standby receives fine and cannot apply fast enough. `state = catchup` rather than `streaming` means it is still reading history. And if the row disappears entirely, the standby is gone and — if it had a slot — your disk clock has started.',
      },
    ],
    metrics: [
      { label: 'Sent LSN', get: (s) => fmtLsn(s.replication.sentLsn) },
      {
        label: 'Behind the primary',
        get: (s) =>
          !s.replication.enabled || !s.replication.connected
            ? 'no standby'
            : fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.sentLsn)),
        hint: 'WAL generated but not yet handed to the wire',
      },
      {
        label: 'Slot state',
        get: (s) =>
          !s.replication.enabled ? 'no standby' : s.replication.connected ? `streaming (${s.replication.mode})` : 'disconnected — holding WAL',
      },
      { label: 'Records in flight', get: (s) => fmtNum(s.replication.inFlight) },
    ],
    knobs: ['replicaEnabled', 'replicaNetworkLag', 'synchronousCommit', 'walLevel'],
    see: ['net.wire', 'walreceiver', 'wal.vault', 'logical.decoder'],
    source: ['src/backend/replication/walsender.c', 'src/backend/replication/slot.c'],
    refs: {
      docs: [
        manual('warm-standby.html', '26.2. Log-Shipping Standby Servers'),
        manual('monitoring-stats.html', '27.2. The Cumulative Statistics System — pg_stat_replication'),
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
    ],
    metrics: [
      {
        label: 'Decoding',
        get: (s) => (s.knobs.walLevel === 'logical' ? (s.replication.logicalEnabled ? 'active' : 'idle') : 'off — wal_level is not logical'),
      },
      { label: 'Changes / s', get: (s) => fmtNum(s.replication.logicalEnabled ? s.replication.logicalChangesPerSec : 0) },
      { label: 'Slot position', get: (s) => (s.replication.logicalEnabled ? fmtLsn(s.replication.logicalSlotLsn) : '—') },
      {
        label: 'WAL held by the slot',
        get: (s) =>
          !s.replication.logicalEnabled
            ? 'nothing — no slot exists'
            : fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.logicalSlotLsn)),
        hint: 'cannot be recycled until the consumer confirms it',
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
        body: 'A table has an **OID**, its permanent identity in `pg_class`, and a **relfilenode**, the number of the file currently holding its data. They usually start out equal and then diverge, because anything that rewrites a table — `VACUUM FULL`, `CLUSTER`, `TRUNCATE`, `REINDEX`, some `ALTER TABLE`s — writes a new file and swaps the pointer, which is what makes those operations crash-safe. Use `pg_relation_filepath(\'orders\')` rather than guessing. A handful of bootstrap catalogs report relfilenode 0 and are located through `pg_filenode.map` instead, because you cannot read a catalog to find the catalog.',
      },
      {
        heading: 'What you would see in production',
        body: 'You go looking for the file eating your disk, find `base/16384/24591.3`, and it tells you nothing. Map it back with `SELECT relname FROM pg_class WHERE relfilenode = 24591`. Two more habits worth having: never touch anything inside the data directory while the server is running, and remember that `du` on the directory and `pg_database_size()` can disagree because of deleted-but-still-open files.',
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
      { label: 'Relations', get: (s) => fmtNum(sumTables(s, (t) => 1 + t.def.indexes.length + (t.def.toast ? 2 : 0))) },
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
        body: 'Each tuple carries a 23-byte header, and the two fields that matter are `xmin` (the transaction that created this version) and `xmax` (the transaction that deleted or superseded it). Nothing is ever modified in place: an UPDATE writes a **new version** elsewhere and stamps `xmax` on the old one; a DELETE only stamps `xmax`. Your snapshot then decides which versions you can see, by comparing those xids against the transactions that were running when your statement began. This is why a table with 1 million rows can physically contain 40 million tuples, and why "rows" and "row versions" must never be used as synonyms when you are debugging.',
      },
      {
        heading: 'HOT updates and page pruning',
        body: 'Writing a new version normally means inserting into every index too, because every index entry points at a physical tuple. **HOT** — Heap Only Tuple — avoids that when two conditions hold: no indexed column changed, and the new version fits on the same page. The new version goes on that same page, as a **heap-only tuple**; the old version’s `t_ctid` points at it, and the two form a HOT chain; the index entries still point at the original line pointer and an index scan simply walks the chain from there. No index work happens at all. Better still, any backend that later reads a prunable page can run **page pruning** on the spot, throwing away the dead versions without waiting for vacuum — and that is when the original line pointer becomes a **redirect** to the first live tuple in the chain, which is what keeps those index entries valid without the index ever being touched. Chase `n_tup_upd` versus `n_tup_hot_upd` in `pg_stat_user_tables`; a low ratio on a hot table usually means an index on a frequently-updated column, or the default heap `fillfactor` of 100, which leaves a freshly filled page no room for the new version — lowering it to around 90 on an update-heavy table is what buys HOT that room.',
      },
      {
        heading: 'What bloat physically is',
        body: 'Bloat is dead tuples and empty line pointers occupying pages that the table still owns. It hurts in a specific way: a sequential scan reads dead space at full price, the cache holds pages that are mostly corpses, and every index over the table gets bigger too. Vacuum makes that space reusable by future inserts, but the file keeps its size — so bloat that has already happened is a permanent tax on scan cost until you rewrite the table. Note also that a line pointer cannot be freed until every index entry referencing it is gone, which is why vacuum has to visit indexes before it can finish with the heap.',
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
        hint: 'updates that avoided touching any index',
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
        body: 'A tuple cannot span pages, so with 8 KiB pages nothing could hold a 2 MiB document without a trick. **The Oversized-Attribute Storage Technique** is that trick. When a row would exceed roughly 2 KiB, Postgres works through its widest variable-length columns and, for each, first tries compression, and if the row is still too big, moves the value out of line entirely — leaving an 18-byte pointer in the tuple where the value was.',
      },
      {
        heading: 'Where the bytes go',
        body: 'Out-of-line values are chopped into roughly 2 KiB chunks and inserted into a private table in the `pg_toast` schema, keyed by (chunk_id, chunk_seq), with its own B-tree index. That table is invisible in `\\dt` but completely real: it has pages, it takes writes, it bloats, and autovacuum has to process it like anything else. `pg_relation_size(\'documents\')` does not include it — `pg_total_relation_size` does, and the gap between the two is the usual "why does the table look small but the disk is full" answer.',
      },
      {
        heading: 'What a wide column costs to read',
        body: 'A toast pointer is cheap to read and expensive to follow. Selecting a wide column means, per row, an index lookup in the toast index, several chunk reads, and decompression — so a `SELECT *` over ten thousand rows can be an order of magnitude more expensive than selecting the six columns you actually needed, without any of that showing up as extra rows in the plan. It is also the reason a query gets dramatically faster the moment someone stops asking the ORM for every column.',
      },
      {
        heading: 'What you can control',
        body: '`ALTER TABLE … ALTER COLUMN … SET STORAGE` picks the strategy: `EXTENDED` (compress then move out, the default), `EXTERNAL` (out of line, uncompressed — worth it when you constantly `substr()` the start of a large value), `MAIN` (compress, resist moving out), `PLAIN` (never). Since PostgreSQL 14 `default_toast_compression` can be `lz4` instead of `pglz`, which is usually several times faster to compress and decompress for a small loss of ratio. One useful property: an UPDATE that does not change a toasted column reuses the existing pointer rather than rewriting the value.',
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
        label: 'Writes to it',
        get: (s) => {
          const t = s.tables.find((x) => x.def.toast)
          return t ? fmtNum(t.inserts + t.updates) : '—'
        },
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
        body: 'Removing dead tuples is only half of vacuum’s job. The other half is **recording the resulting free space in the FSM**, because space that nothing knows about is space that nothing uses. Skip that step and inserts keep extending the file even though the existing pages are half empty. This is the mechanical reason autovacuum failure shows up as a table that grows without the row count growing: the free space exists, it just is not on the map.',
      },
      {
        heading: 'Deliberately approximate',
        body: 'The FSM is a hint, not a ledger. It is not WAL-logged, so after a crash it can be stale — harmless, because a wrong answer only costs a retry. It is also not maintained for very small tables (fewer than four pages), where scanning the whole thing is cheaper than maintaining a map of it. And it never shrinks pages: it reports what is free, it does not compact anything.',
      },
      {
        heading: 'What you would see in production',
        body: 'Install `pg_freespacemap` and `SELECT sum(avail) FROM pg_freespace(\'sessions\')` to see, in bytes, how much reusable space a table is sitting on. A table with 4 GiB of tracked free space is bloated but stable — inserts will refill it. A table with almost none, that is still growing, is either genuinely growing or has an old snapshot pinning its dead row versions so vacuum cannot free anything.',
      },
    ],
    metrics: [
      {
        label: 'Reusable space',
        get: (s) => fmtBytes(sumTables(s, (t) => t.deadTuples) * 120),
        hint: 'rough model estimate: dead row versions × an average tuple width',
      },
      { label: 'Dead row versions', get: (s) => fmtNum(sumTables(s, (t) => t.deadTuples)) },
      { label: 'Inserts served', get: (s) => fmtNum(sumTables(s, (t) => t.inserts)) },
      { label: 'Since last vacuum', get: (s) => fmtDuration(sinceVacuum(s)), hint: 'the FSM is only refreshed by vacuum' },
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
      { label: 'Index scans', get: (s) => fmtNum(sumTables(s, (t) => t.idxScans)), hint: 'the plans that benefit' },
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
        body: 'Sequential scans read big contiguous runs and get the full bandwidth of the device; index access jumps around and pays per-operation latency instead. The planner encodes that as `seq_page_cost = 1.0` against `random_page_cost = 4.0`, a ratio calibrated for spinning disks with a bit of caching. On NVMe the real ratio is far closer to 1, and lowering `random_page_cost` to something like 1.1 is one of the very few cost constants worth adjusting — it makes the planner stop avoiding index scans it should be choosing.',
      },
      {
        heading: 'Torn pages',
        body: 'An 8 KiB page is not written atomically by most storage, so a crash can leave half of one page from the new write and half from the old. WAL cannot repair that, because WAL records describe deltas to a page that must be intact to begin with. `full_page_writes` solves it by logging the entire page image the first time it is modified after each checkpoint, so recovery can rebuild the page from scratch and then replay deltas. That is why WAL volume surges from the moment each checkpoint begins — the redo point is stamped at the start, and from then on every page owes an image on its first modification — and why turning full page writes off is only defensible on storage that genuinely offers atomic 8 KiB writes.',
      },
      {
        heading: 'What you would see in production',
        body: 'The healthy signature is fsync latency in the low single-digit milliseconds, with a periodic bump at the end of each checkpoint. The unhealthy one is a queue depth that never drains and commit latency that tracks it — storage that cannot absorb the checkpoint’s fsyncs on top of the ordinary WAL flush rate. Under a spread checkpoint the full-page-image surge has largely decayed by the time the fsync phase arrives, so the two costs land at opposite ends of the interval; when they do collide, it is because `max_wal_size` is forcing checkpoints early. Also worth knowing: if an `fsync()` fails, Postgres deliberately PANICs rather than retrying, because on Linux a failed fsync could drop the error and let a later fsync return success on data that never landed.',
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
      { label: 'Checkpoint', get: (s) => CKPT_PHASE[s.checkpoint.phase], hint: 'fsync is where the latency spike lives' },
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
        body: "A checkpoint starts when `checkpoint_timeout` elapses (PostgreSQL's default is 5 minutes), when WAL since the last one approaches `max_wal_size` (default 1 GiB), or when something demands one — a manual `CHECKPOINT`, a shutdown, the start of a base backup. PGSimCity uses 60 seconds instead of PostgreSQL's 5-minute default so the cycle is visible; only the checkpoint clock is compressed. The distinction matters enormously: `checkpoint_completion_target` spreads the write phase over a fraction of the *expected interval*, so time-triggered checkpoints are gentle and WAL-triggered ones are not, because they arrive early and unexpectedly. Compare `num_timed` against `num_requested` in `pg_stat_checkpointer` (these counters lived in `pg_stat_bgwriter` before PostgreSQL 17). If requested checkpoints dominate, `max_wal_size` is too small for your write rate.",
      },
      {
        heading: 'Where the latency spike comes from',
        body: 'The write phase is throttled and usually invisible. The fsync phase is not: it asks the storage to durably persist everything the kernel has been lazily accumulating, all at once, and while that queue drains every commit waiting on `fsync` of WAL is stuck behind it. The other cost starts at the other end. The redo point is stamped the moment a checkpoint *begins*, and from that instant the first modification to each page logs a **full page image**, so WAL volume surges as the checkpoint starts and decays as the hot pages pay their toll — largely spent by the time the fsync phase arrives. That rhythm — a WAL surge at each checkpoint’s start, an fsync latency spike at its end, repeating at `checkpoint_timeout` intervals — is the most recognisable pattern in Postgres performance work.',
      },
      {
        heading: 'How to tune it',
        body: 'Turn on `log_checkpoints` (on by default since PostgreSQL 15) and read the lines: they give you buffers written, the time split between write and sync, and the reason. Then raise `max_wal_size` until checkpoints are time-triggered rather than requested; that costs disk in `pg_wal` and buys smooth writes. Then lengthen `checkpoint_timeout` — 15 to 30 minutes is common on busy systems — which reduces full-page-write volume substantially but lengthens crash recovery, so decide it against your actual RTO. Leave `checkpoint_completion_target` at 0.9 (its default since PostgreSQL 14); tuning it below that only helps if you want checkpoints to finish early for some external reason.',
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
      { label: 'Triggered by', get: (s) => s.checkpoint.reason, hint: 'time = healthy, wal = max_wal_size too small' },
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
        srcFile('src/backend/access/transam/xlog.c', 'CreateCheckPoint, CheckPointGuts'),
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
        body: 'The checkpointer writes the buffers that were dirty at a moment in time, on a schedule, for durability. The background writer writes the buffers that are about to be **evicted**, continuously, for latency. It walks the clock sweep slightly ahead of where allocation is happening and flushes dirty victims, so that when a backend needs a free buffer it finds a clean one and can reuse it immediately instead of writing 8 KiB to disk in the middle of your query.',
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
        body: '`bgwriter_delay` (200 ms) is how often it wakes, `bgwriter_lru_maxpages` (100) caps how many buffers it may write per round, and `bgwriter_lru_multiplier` (2.0) scales how far ahead of recent demand it tries to stay. Raising `bgwriter_lru_maxpages` to a few hundred is a reasonable first move on a write-heavy system with fast storage. Turning the writer off entirely is a good way to *see* what it was doing: backend writes climb and query latency picks up a long tail almost immediately.',
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
        body: 'A table is vacuumed when its dead tuples exceed `autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × reltuples` — by default 50 + 20% of the table. Analyze uses the same shape with a 10% factor. Since PostgreSQL 13 there is also an insert-driven trigger (`autovacuum_vacuum_insert_threshold`, 1000 plus 20%), which finally gave append-only tables a reason to get vacuumed at all, so their pages get frozen and marked all-visible before wraparound forces the issue.',
      },
      {
        heading: 'Why the defaults are too timid',
        body: 'Twenty percent is a sensible default for a 10,000-row table and a catastrophe for a 500-million-row one, where it means waiting for 100 million dead tuples before doing anything, then vacuuming for hours. Set it per table: `ALTER TABLE orders SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 1000)`. Frequent small vacuums are dramatically cheaper than rare large ones, because each pass re-reads less and has a better chance of finishing before the next one is due.',
      },
      {
        heading: 'Throttling, and the trap in it',
        body: 'Vacuum accumulates cost points as it reads and dirties pages, and sleeps for `autovacuum_vacuum_cost_delay` (2 ms since PostgreSQL 12) whenever it exceeds `autovacuum_vacuum_cost_limit` (200). That budget is shared across **all** workers, so raising `autovacuum_max_workers` from 3 to 6 without raising the cost limit gives you six workers each going half as fast, and no more throughput. On modern storage, raising the cost limit — to 1000 or more — is usually the change that matters. `max_workers` only helps when the problem is too many tables waiting, not too little bandwidth.',
      },
      {
        heading: 'What you would see in production',
        body: 'The symptom is never "autovacuum is slow". It is a table growing while its row count is flat, or `pg_stat_user_tables.last_autovacuum` hours old on your busiest table, or three workers permanently occupied by three giant tables while everything else queues behind them. Watch `n_dead_tup` against the computed threshold, and `pg_stat_progress_vacuum` to see what the running workers are actually doing.',
      },
      {
        heading: 'Where this model cheats',
        body: 'The naptime here is 12 seconds, not 60, and this city has exactly one database — otherwise the yard would sit empty for the length of a visit. The threshold formula, the shared cost budget and the phase order are the real ones; only the clock is compressed.',
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
        body: 'A vacuum moves through named phases, and `pg_stat_progress_vacuum` shows which one a worker is in. **Initializing**, then **scanning heap**: read pages (skipping all-visible ones via the visibility map), pruning and freezing along the way, and collect the TIDs of the dead line pointers left behind. **Vacuuming indexes**: for each index, remove every entry pointing at a collected TID — this is why vacuum cost scales with index count, not just table size. **Vacuuming heap**: return to the collected pages and turn those line pointers into free space, recording it in the FSM. Those two are a loop rather than a straight line: if the heap has not been fully scanned yet, the worker goes back to scanning (see "Memory and repeat passes" below). **Cleaning up indexes**: one final call per index to tidy up and refresh its statistics. **Truncating heap**: give back trailing empty pages if it can, and only those. **Performing final cleanup**: vacuum the free space map, update `pg_class`, and report to the cumulative statistics. ANALYZE is *not* one of these phases — autovacuum may run it against the same table straight afterwards, but it is a separate command with its own view, `pg_stat_progress_analyze`.',
      },
      {
        heading: 'Dead is not the same as removable',
        body: 'A tuple whose `xmax` has committed is dead, but it can only be **removed** if no snapshot anywhere could still need it. Vacuum computes a horizon from the oldest running transaction, the oldest replication slot xmin, and (if enabled) standby feedback; anything newer than that horizon stays, however dead it is. This is the mechanism behind the single most common Postgres incident: one forgotten `idle in transaction` session pins the horizon, every vacuum runs, does work, and removes nothing, and the table bloats for as long as that session stays open. `VACUUM VERBOSE` says so directly: on PostgreSQL 16 and later it prints a `tuples:` line ending "… are dead but not yet removable", followed by a `removable cutoff:` line giving the xid it was allowed to use and how many transactions old that already was when the run ended.',
      },
      {
        heading: 'Why the file usually does not shrink',
        body: 'Vacuum reclaims space *inside* pages and hands it to the free space map for reuse. It only shortens the file if the very last pages are entirely empty, and even then it needs a brief `ACCESS EXCLUSIVE` lock, which it will abandon rather than block your workload for. On a table with live rows scattered near the end — which is nearly all of them — the file stays exactly as large as it was. That is correct behaviour, not a failure: the space is not lost, it is on the map, and the next inserts will use it.',
      },
      {
        heading: 'Freezing and wraparound',
        body: 'Transaction ids are 32-bit and wrap, so every row must eventually be marked frozen — meaning "older than everything, visible to all" — before the counter laps its `xmin`. Vacuum freezes as it goes, and once a table’s oldest xid reaches `autovacuum_freeze_max_age` (200 million) an **anti-wraparound** vacuum is launched that will not be skipped and will not politely step aside for your DDL. Ignoring those is how a cluster ends up refusing new transactions with "database is not accepting commands that assign new XIDs to avoid wraparound data loss in database …". Recovery is undramatic and does not need single-user mode: read-only transactions still start and `VACUUM` still runs, and the safety margin exists precisely so that you can connect normally and vacuum the offending databases. Since PostgreSQL 14 a failsafe kicks in near the limit and abandons cost delays and index cleanup to finish freezing at any price.',
      },
      {
        heading: 'Memory and repeat passes',
        body: 'The dead TIDs collected in the heap scan have to fit in `maintenance_work_mem` (or `autovacuum_work_mem`). If they do not, vacuum stops, does a full pass over every index, empties the list and resumes — so a large table with five indexes and a small memory setting can read all five indexes several times in one vacuum. PostgreSQL 17 replaced the old flat TID array with a much more compact structure and removed the 1 GiB ceiling that used to force this, which made large-table vacuums substantially cheaper.',
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
        body: 'When vacuum removes dead tuples it records the recovered space in the free space map, and future inserts and updates land there. From the operating system’s point of view nothing happened: the file is the same size, `df` does not move. This is usually the right answer — the space will be reused within minutes on a busy table, and returning it would just mean extending the file again — but it means "I vacuumed and the disk did not shrink" is expected behaviour, not a bug.',
      },
      {
        heading: 'When you actually need the space back',
        body: 'There is one situation that justifies a rewrite: a table that grew enormously through a one-off event and will never be that big again — a bulk delete of 80% of the rows, a runaway job, a bloat incident that has since been fixed. Steady-state bloat should be fixed by vacuuming more aggressively, not by periodically rewriting the table, because a rewrite you have to repeat is a symptom.',
      },
      {
        heading: 'VACUUM FULL and the alternatives',
        body: '`VACUUM FULL` rewrites the entire table into a fresh relfilenode, tightly packed, and rebuilds every index. It gives the space back completely, and it holds an `ACCESS EXCLUSIVE` lock for the whole rewrite — reads and writes both blocked, for as long as it takes to copy the table — while needing enough free disk for a second copy. `pg_repack` and `pg_squeeze` do the same job online: each builds a tightly packed shadow copy while the table stays writable — `pg_repack` captures the concurrent changes with triggers, `pg_squeeze` decodes them out of the WAL through a replication slot, so it needs `wal_level = logical` — and swaps the copy in at the end under a brief exclusive lock. They are extensions, they need that free space too, and they are the right tool when downtime is not available.',
      },
      {
        heading: 'What you would see in production',
        body: 'Measure before you rewrite: `pgstattuple` gives an exact free-space percentage at the cost of reading the table, and `pg_freespace()` shows what the map already knows about. If a table is 60% dead space and stable, a rewrite buys real scan performance. If it is 60% dead space and climbing, rewriting it changes nothing — find the long-running transaction or the too-timid autovacuum setting first. And for delete-driven bloat, partitioning plus `DROP TABLE` on old partitions eliminates the problem instead of managing it.',
      },
    ],
    metrics: [
      { label: 'Tuples reclaimed', get: (s) => fmtNum(s.autovac.landfill) },
      {
        label: 'Space reusable',
        get: (s) => fmtBytes(sumTables(s, (t) => t.deadTuples) * 120),
        hint: 'rough model estimate of dead space still inside the files',
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
      ],
      source: [
        srcFile('src/backend/access/heap/vacuumlazy.c', 'lazy_truncate_heap'),
        srcFile('src/backend/commands/repack.c', 'cluster_rel, rebuild_relation, copy_table_data'),
        srcFileAt('REL_18_STABLE', 'PostgreSQL 18 and earlier', 'src/backend/commands/cluster.c', 'cluster_rel, rebuild_relation, copy_table_data'),
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
        body: 'Backends write log lines to stderr. With `logging_collector = on`, a dedicated process reads that pipe and writes rotated files under `log_directory`, which is what makes the server log survive restarts, rotate by size and age, and not interleave badly across processes. `log_destination` chooses the format: `stderr`, `csvlog`, or `jsonlog` (added in PostgreSQL 15), the latter two being the ones you want if anything machine-readable consumes the server log.',
      },
      {
        heading: 'log_line_prefix comes first',
        body: 'A log line without context is a log line you cannot use. Set `log_line_prefix` to something like `%m [%p] %q%u@%d app=%a ` so every line carries a timestamp with milliseconds, the process id, and — for lines from real sessions — the user, database and application name. The default is close to useless, and every log-analysis tool worth running (pgBadger among them) needs the prefix to be sane before it can tell you anything.',
      },
      {
        heading: 'The four settings that matter',
        body: '`log_min_duration_statement` logs any statement slower than a threshold; start at 1000 ms and walk it down, never set it to 0 on a busy system. `auto_explain` (a `shared_preload_libraries` module) logs the actual plan for those slow statements, which turns "this query was slow" into "this query chose a nested loop because the estimate was 1 row and reality was 400,000". `log_checkpoints` (on by default since PostgreSQL 15) prints the write/sync split of every checkpoint. `log_lock_waits` — off by default, turn it on — logs any session that waits longer than `deadlock_timeout` for a lock, with the blocker.',
      },
      {
        heading: 'What you would see in production',
        body: 'With those four on, an incident reads itself: lock waits name the blocking pid, checkpoint lines line up with the latency spikes, and slow-query entries carry plans. Two cautions. The collector is one process, so logging every statement on a high-TPS cluster makes it a bottleneck and can stall backends writing to a full pipe. And `log_temp_files = 0` plus `log_autovacuum_min_duration` are worth adding — they catch the two problems that otherwise never appear anywhere: work_mem spilling to disk, and vacuums that take longer than you assumed.',
      },
    ],
    metrics: [
      {
        label: 'Lock waits',
        get: (s) => fmtNum(s.locks.length),
        hint: 'what log_lock_waits would be printing right now',
      },
      {
        label: 'Longest wait',
        get: (s) => fmtDuration(s.locks.reduce((m, l) => (l.ageSec > m ? l.ageSec : m), 0)),
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
        body: '`pg_stat_activity` for "what is happening now", filtered on `state <> \'idle\'` and sorted by `xact_start`. `pg_stat_user_tables` for dead tuples, last autovacuum and the seq-scan-versus-index-scan ratio. `pg_stat_io` (PostgreSQL 16 and later) for who is doing the reads and writes, broken down by backend type. `pg_stat_replication` on the primary and `pg_stat_wal_receiver` on the standby. `pg_locks` joined to `pg_stat_activity` when things are blocked. And `pg_stat_statements`, which is an extension rather than core, for normalised per-query totals — install it on every cluster you own.',
      },
      {
        heading: 'Things that will catch you',
        body: 'Statistics are approximate by design: `n_live_tup` is an estimate, not a count, and `reltuples` in `pg_class` is only as fresh as the last analyze. Within one transaction, repeated reads of a stats view return the same snapshot by default (`stats_fetch_consistency`), which is helpful for consistent queries and confusing when you are polling in a loop. And `pg_stat_reset()` does more damage than people expect: it wipes the dead-tuple counts autovacuum uses to decide what to vacuum, so the next round of maintenance is scheduled on amnesia.',
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
        heading: 'Asynchronous costs nothing',
        body: 'By default the primary never waits. A commit is durable locally, the client gets its answer, and the WAL reaches the standby whenever it reaches it. Network latency then shows up purely as **lag** — the standby is some milliseconds or seconds behind — and the practical consequence is bounded data loss on failover, not slow commits. Measure it as `pg_current_wal_lsn() - replay_lsn` in bytes, and as `replay_lag` in time.',
      },
      {
        heading: 'What synchronous_standby_names really does',
        body: 'Naming a standby there, with `synchronous_commit = on`, makes every commit wait for that standby to **flush** the commit record to its own disk before the client is told yes. So every write transaction now pays at least one network round trip. On a 1 ms link that is invisible; across regions at 30 ms it caps you at well under 40 write transactions per second per session, no matter how fast your storage is. `remote_write` waits only for the standby’s OS (cheaper, weaker), and `remote_apply` waits for it to be visible to queries there — much stronger, and hostage to replay speed and query conflicts.',
      },
      {
        heading: 'The availability trap',
        body: 'Synchronous replication is a durability feature that reduces availability. If the only synchronous standby stops responding, commits **hang** — not fail, hang — until it returns or you edit `synchronous_standby_names` and reload. That is the correct behaviour for its contract, and it surprises everyone once. Configure a quorum instead of a single name: `ANY 1 (s1, s2)` keeps the guarantee while tolerating the loss of either standby, and is the shape almost everyone actually wants.',
      },
    ],
    metrics: [
      { label: 'Mode', get: (s) => (s.replication.enabled ? s.replication.mode : 'no standby') },
      { label: 'Network latency', get: (s) => `${fmtNum(s.replication.networkLagMs)} ms`, hint: 'one way' },
      {
        // synchronous_commit = 'on' is a LOCAL flush guarantee: it never puts the
        // network in the commit path. Only a genuinely synchronous standby does,
        // and only while one is actually connected.
        label: 'Commit tax',
        get: (s) =>
          s.replication.enabled && s.replication.connected && s.replication.mode === 'sync'
            ? `${fmtNum(s.replication.networkLagMs * 2)} ms per commit`
            : s.knobs.synchronousCommit === 'off'
              ? 'none — the commit does not wait at all'
              : 'none — local flush only',
        hint: 'a commit only pays the network when a synchronous standby is in the path',
      },
      { label: 'In flight', get: (s) => fmtNum(s.replication.inFlight), hint: 'WAL records on the wire' },
      {
        label: 'Lag',
        get: (s) =>
          !s.replication.enabled || !s.replication.connected
            ? '—'
            : `${fmtBytes(s.replication.lagBytes)} · ${fmtDuration(s.replication.lagSec)}`,
      },
    ],
    knobs: ['synchronousCommit', 'replicaNetworkLag', 'replicaEnabled', 'replicaSlowApply'],
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
    ],
    metrics: [
      { label: 'Link', get: (s) => (s.replication.connected ? 'streaming' : s.replication.enabled ? 'reconnecting' : 'no standby') },
      { label: 'Written', get: (s) => fmtLsn(s.replication.writeLsn) },
      { label: 'Flushed', get: (s) => fmtLsn(s.replication.flushLsn), hint: 'durable on the standby — what synchronous_commit=on waits for, once this standby is in synchronous_standby_names' },
      {
        label: 'Not yet applied',
        get: (s) => fmtBytes(Math.max(0, s.replication.flushLsn - s.replication.replayLsn)),
        hint: 'received and safe, but not yet visible to queries there',
      },
    ],
    knobs: ['replicaEnabled', 'replicaNetworkLag', 'replicaSlowApply', 'synchronousCommit'],
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
        body: 'A standby on identical hardware falling steadily behind a busy primary, with the replay LSN trailing while the flush LSN keeps pace, is the classic signature: the WAL arrives fine and cannot be applied fast enough. Big index builds, mass updates and anything that dirties a lot of pages at once make it worse. On the primary side, the corresponding number to care about is recovery time after a crash, which is bounded by how much WAL was written since the last checkpoint — that is the trade you make every time you raise `checkpoint_timeout`.',
      },
    ],
    metrics: [
      { label: 'Replay LSN', get: (s) => fmtLsn(s.replication.replayLsn) },
      {
        label: 'Behind by',
        get: (s) =>
          !s.replication.enabled || !s.replication.connected
            ? '—'
            : `${fmtBytes(s.replication.lagBytes)} · ${fmtDuration(s.replication.lagSec)}`,
      },
      { label: 'Replay activity', get: (s) => fmtPct(s.replication.applyActivity, 0) },
      {
        label: 'Crash recovery from',
        get: (s) =>
          `${fmtLsn(s.checkpoint.completedRedoLsn)} (${fmtBytes(Math.max(0, s.wal.flushLsn - s.checkpoint.completedRedoLsn))} of WAL)`,
        hint: 'how much the primary would have to replay right now',
      },
    ],
    knobs: ['replicaSlowApply', 'replicaEnabled', 'checkpointTimeout', 'maxWalSize'],
    see: ['walreceiver', 'checkpointer', 'replica.standby', 'archive.store'],
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
    tldr: 'A byte-identical copy kept current by WAL replay, readable while it replays.',
    sections: [
      {
        heading: 'What "physical" means',
        body: 'The standby is the same cluster at the block level: same relfilenodes, same page contents, same everything, because it is built from a base backup and then advanced by the same WAL records the primary wrote. You do not choose what to replicate — you get every database, table, index and sequence, plus every DDL change, automatically. That completeness is exactly what makes it the right tool for high availability and the wrong tool for "replicate these three tables into the analytics system".',
      },
      {
        heading: 'Read-only, with a catch',
        body: 'With `hot_standby = on` (the default) you can run queries while replay continues. But replay and queries want opposing things: replay wants to remove a dead row, your query wants to keep reading it. When they collide the standby is allowed to hold replay back by up to `max_standby_streaming_delay` (30 seconds by default) and then **cancels the conflicting query** — `canceling statement due to conflict with recovery`. It is a budget for how far behind replay may fall, measured from when the WAL arrived, not a grace period each query is granted: on a standby that is already lagging, the budget can be spent before your query even starts. Setting that to `-1` means replay waits forever instead, converting query cancellations into unbounded replication lag. There is no setting that avoids the trade; you choose which side pays.',
      },
      {
        heading: 'The four LSNs',
        body: '`pg_stat_replication` on the primary gives you `sent_lsn`, `write_lsn`, `flush_lsn` and `replay_lsn`, and the gaps between them localise any problem immediately. Primary ahead of `sent` means the walsender cannot keep up or the link is saturated. `sent` ahead of `write` is network. `write` ahead of `flush` is standby disk. `flush` far ahead of `replay` is replay speed — the most common case, and the only one where adding network bandwidth changes nothing. The `write_lag`, `flush_lag` and `replay_lag` columns give the same story in time rather than bytes.',
      },
      {
        heading: 'Failover',
        body: 'Promotion stops recovery, bumps the **timeline**, and opens for writes. Everything downstream of the old primary must then follow that timeline or be rebuilt, which is what timeline history files are for. Two things people learn the hard way: with asynchronous replication, promotion loses whatever WAL had not reached the standby, so measure your lag if you care about the answer; and the old primary must never be brought back up as a primary — use `pg_rewind` or re-seed it, because two writable copies of the same cluster diverge in ways nothing can merge.',
      },
    ],
    metrics: [
      { label: 'State', get: (s) => (!s.replication.enabled ? 'no standby' : s.replication.connected ? `streaming (${s.replication.mode})` : 'disconnected') },
      { label: 'sent → write', get: (s) => fmtBytes(Math.max(0, s.replication.sentLsn - s.replication.writeLsn)), hint: 'network' },
      { label: 'write → flush', get: (s) => fmtBytes(Math.max(0, s.replication.writeLsn - s.replication.flushLsn)), hint: 'standby disk' },
      { label: 'flush → replay', get: (s) => fmtBytes(Math.max(0, s.replication.flushLsn - s.replication.replayLsn)), hint: 'replay speed' },
      { label: 'Replay lag', get: (s) => (!s.replication.enabled || !s.replication.connected ? '—' : fmtDuration(s.replication.lagSec)) },
    ],
    knobs: ['replicaEnabled', 'replicaSlowApply', 'replicaNetworkLag', 'synchronousCommit'],
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
        body: 'Run representative read traffic on the standby before you need it — this is the strongest argument for using standbys for reporting even when you do not need the capacity. Use `pg_prewarm`, whose `autoprewarm` background worker periodically dumps the list of cached blocks and restores them on startup, which also fixes the unrelated problem of a cold cache after a restart. And when you plan a failover, plan for a warmup window rather than expecting instant parity.',
      },
      {
        heading: 'While it is a standby',
        body: 'The standby runs its own background writer and its own checkpointer, but the checkpointer performs **restartpoints** rather than checkpoints: it flushes dirty buffers and records a safe restart position derived from a checkpoint record it has already replayed. Restartpoints are what bound the standby’s own crash recovery time, they obey the same `checkpoint_timeout` and `max_wal_size` settings, and they can never get ahead of what replay has reached.',
      },
    ],
    metrics: [
      { label: 'Replay activity', get: (s) => fmtPct(s.replication.applyActivity, 0), hint: 'what is warming this cache' },
      { label: 'Replayed to', get: (s) => fmtLsn(s.replication.replayLsn) },
      {
        label: 'Primary hit ratio',
        get: (s) => fmtPct(s.buffers.hitRatio, 1),
        hint: 'shown for contrast — the standby cache holds a different set of pages',
      },
      { label: 'Standby', get: (s) => (s.replication.enabled ? (s.replication.connected ? 'online' : 'disconnected') : 'not running') },
    ],
    knobs: ['replicaEnabled', 'replicaSlowApply', 'sharedBuffers'],
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
    tldr: 'The same files, the same block numbers, a few WAL records behind.',
    sections: [
      {
        heading: 'A copy, not a rebuild',
        body: 'The standby’s data directory starts life as a `pg_basebackup` of the primary and stays a block-level copy forever after. Relation files carry the same relfilenodes, block 4271 of `orders` holds the same tuples in the same line pointers, and the free space and visibility maps are copies too. The only structural difference is a `standby.signal` file, which is what tells the server on startup that it should enter recovery and stay there.',
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
    ],
    metrics: [
      { label: 'Replayed to', get: (s) => fmtLsn(s.replication.replayLsn) },
      { label: 'Primary at', get: (s) => fmtLsn(s.wal.insertLsn) },
      { label: 'Divergence', get: (s) => fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.replayLsn)), hint: 'how stale the copy is right now' },
      { label: 'Copy size', get: (s) => fmtBytes(sumTables(s, (t) => t.pages) * PAGE), hint: 'same heap files as the primary' },
    ],
    knobs: ['replicaEnabled', 'replicaSlowApply', 'replicaNetworkLag'],
    see: ['storage.datadir', 'replica.standby', 'walreceiver', 'archive.store'],
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
    ],
    metrics: [
      { label: 'Standby', get: (s) => (s.replication.enabled ? (s.replication.connected ? 'accepting reads' : 'offline') : 'not running') },
      {
        label: 'Staleness',
        get: (s) =>
          !s.replication.enabled || !s.replication.connected
            ? '—'
            : `${fmtDuration(s.replication.lagSec)} · ${fmtBytes(s.replication.lagBytes)}`,
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
    knobs: ['replicaEnabled', 'replicaSlowApply', 'longRunningXact', 'seqScanRatio'],
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
    tldr: 'Applies decoded row changes from a publisher — selective, cross-version, and not a replica.',
    sections: [
      {
        heading: 'How it works',
        body: 'The publisher defines a `PUBLICATION` naming tables (or `FOR ALL TABLES`). The subscriber creates a `SUBSCRIPTION`, which opens a replication connection, creates a logical slot on the publisher, and starts an **apply worker**. Initial data is copied per table by table-sync workers running `COPY`; once a table finishes its snapshot, the apply worker takes over and streams changes from the slot as ordinary INSERT, UPDATE and DELETE statements. The subscriber is a completely normal database that happens to have a process writing into it.',
      },
      {
        heading: 'What it can do that physical replication cannot',
        body: 'Replicate a subset of tables, or a subset of rows and columns. Replicate **between major versions**, which makes it the standard near-zero-downtime upgrade path (and PostgreSQL 17 added `pg_createsubscriber` to build one from an existing physical standby instead of copying everything again). Replicate into a database that has its own extra tables, its own indexes, and its own writes. Consolidate several publishers into one subscriber. None of that is possible with a byte-identical copy.',
      },
      {
        heading: 'What it cannot do',
        body: 'DDL is not replicated: add a column on the publisher and the subscriber will not have it, and depending on order that stops replication. Sequences are not replicated, so after failing over to a subscriber you must advance them by hand or issue duplicate keys. Large objects are not replicated. Updated and deleted rows need a replica identity — a primary key, or an explicit `REPLICA IDENTITY`. And because the subscriber is writable, nothing prevents local writes from conflicting with incoming ones.',
      },
      {
        heading: 'What you would see in production',
        body: 'The characteristic failure is replication stopping dead on one conflicting row — a duplicate key, a missing row for an UPDATE — with the apply worker retrying the same transaction in a loop and lag growing without bound. You fix it by resolving the row, or by skipping the transaction, and `subscription … disable_on_error` (PostgreSQL 15) keeps it from spinning. Also watch the slot on the publisher: an unhealthy subscriber is an idle slot, and an idle slot is the primary’s WAL volume filling up. PostgreSQL 16 added parallel apply for large streamed transactions, which helps when a single apply worker is the bottleneck.',
      },
    ],
    metrics: [
      {
        label: 'Subscription',
        get: (s) => (s.knobs.walLevel !== 'logical' ? 'impossible — wal_level is not logical' : s.replication.logicalEnabled ? 'streaming' : 'idle'),
      },
      { label: 'Changes / s', get: (s) => fmtNum(s.replication.logicalEnabled ? s.replication.logicalChangesPerSec : 0), hint: 'row-level operations applied' },
      { label: 'Confirmed to', get: (s) => (s.replication.logicalEnabled ? fmtLsn(s.replication.logicalSlotLsn) : '—') },
      {
        label: 'WAL retained for it',
        get: (s) =>
          !s.replication.logicalEnabled
            ? 'nothing — no subscription exists'
            : fmtBytes(Math.max(0, s.wal.insertLsn - s.replication.logicalSlotLsn)),
        hint: 'the publisher cannot recycle this until the subscriber confirms',
      },
    ],
    knobs: ['walLevel', 'writeRatio', 'updateRatio', 'replicaNetworkLag'],
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
