/* ============================================================================
 * PGCITY — GUIDED SCENARIOS
 *
 * Each scenario is a lesson: a set of knobs that provokes one specific, real
 * PostgreSQL behaviour, a place to point the camera, and narration beats timed
 * to when the city actually shows it. Beats are `[atSecond, title, body]` and
 * are fired by sim.runScenario through the bus 'narrate' event.
 *
 * Copy rules: say what is happening, say why, say what an operator would do.
 * No hedging, no marketing. The reader is a strong engineer who has simply
 * never had to run a database.
 *
 * `focus` must be one of the registered component ids:
 *   postmaster, backend.row, shared.buffers, wal.buffers, walwriter, wal.vault,
 *   checkpointer, bgwriter, autovac.launcher, storage.datadir, walsender,
 *   replica.standby, lock.manager, proc.array, clog.slru
 * ==========================================================================*/

import type { ScenarioDef } from '../core/types'

export const SCENARIOS: ScenarioDef[] = [
  /* ---------------------------------------------------------------------- */
  {
    id: 'steady-state',
    name: 'Steady state',
    blurb: 'A healthy OLTP city. Learn what "normal" looks like before you break it.',
    icon: '◈',
    focus: 'shared.buffers',
    duration: 90,
    knobs: {
      tps: 240,
      writeRatio: 0.3,
      updateRatio: 0.55,
      seqScanRatio: 0.1,
      sharedBuffers: 768,
      checkpointTimeout: 60,
      checkpointCompletionTarget: 0.9,
      maxWalSize: 256,
      bgwriterEnabled: true,
      synchronousCommit: 'on',
      walLevel: 'replica',
      fullPageWrites: true,
      autovacuum: true,
      longRunningXact: false,
      lockContention: false,
      replicaEnabled: true,
      replicaNetworkLag: 20,
      replicaSlowApply: false,
    },
    beats: [
      [0, 'A healthy database', 'Two hundred transactions a second, and almost nothing is dramatic. Watch the plaza: the blue tiles are clean pages in shared_buffers, the red ones are dirty — modified in memory, not yet on disk. That distinction is the whole game.'],
      [14, 'Where the reads come from', 'Most reads land on a tile that is already here — the hot pages of every table are resident, and index roots effectively never leave. The hit ratio still reads in the seventies rather than the 99% a tuned OLTP server shows, and the seq-scan dial is why: this workload sweeps whole relations far larger than the pool, and every one of those pages is a genuine trip down the green roads. Turn seq scans down and watch the ratio climb.'],
      [30, 'WAL first, data later', 'Every write travels east to wal_buffers before it touches anything permanent. The commit only waits for that amber stream to hit the disk — never for the data pages. That inversion is why a database can be both durable and fast.'],
      [50, 'The city breathes', 'bgwriter trickles a few dirty pages out ahead of the clock hand. The checkpointer counts down. Autovacuum sleeps. Nothing here is urgent, and that is exactly what a well-tuned system looks like from the air.'],
      [72, 'Now break it', 'You have the baseline. Every other scenario changes one thing and lets you watch the consequence propagate through the same streets.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'checkpoint-storm',
    name: 'Checkpoint storm',
    blurb: 'max_wal_size too small under a write flood: checkpoints fire back to back.',
    icon: '◐',
    focus: 'checkpointer',
    duration: 120,
    knobs: {
      tps: 1600,
      writeRatio: 0.85,
      updateRatio: 0.7,
      seqScanRatio: 0.05,
      sharedBuffers: 768,
      checkpointTimeout: 300,
      checkpointCompletionTarget: 0.9,
      maxWalSize: 48,
      bgwriterEnabled: true,
      fullPageWrites: true,
      synchronousCommit: 'on',
      autovacuum: true,
      replicaEnabled: true,
    },
    beats: [
      [0, 'checkpoint_timeout is five minutes', 'So you would expect a checkpoint every five minutes. Watch what actually happens. The write rate is high and max_wal_size is only 48 MB.'],
      [12, 'WAL wins the race', 'The vault fills faster than the clock ticks. When WAL written since the last REDO point crosses max_wal_size, Postgres starts a checkpoint immediately — reason "wal", not "time". The timer never gets a say.'],
      [26, 'The write phase', 'Pink particles stream from the checkpointer into the plaza and down to storage. It is spreading the dirty pages over checkpoint_completion_target — but the deadline it is spreading over is now "when we refill 48 MB", which is seconds away, not minutes.'],
      [42, 'And then full-page writes', 'Look at the amber flood right after each checkpoint. The first time any page is modified after a checkpoint, its entire 8 kB image goes into the WAL. Frequent checkpoints mean every page pays that toll again and again — which fills the WAL faster — which triggers the next checkpoint sooner.'],
      [62, 'That is the storm', 'Checkpoint → full-page writes → more WAL → earlier checkpoint. A feedback loop that eats your I/O budget and shows up as random latency spikes your application developers will swear are network problems.'],
      [82, 'The fix is boring', 'Raise max_wal_size until checkpoints are triggered by time, not by volume. Disk is cheap; a checkpoint storm is not. Then raise checkpoint_timeout so each one has room to spread out.'],
      [104, 'Check your own server', 'pg_stat_checkpointer tells you the ratio directly: if `num_requested` is anywhere near `num_timed`, you are living in this scenario. On PostgreSQL 16 and older the same two columns live in pg_stat_bgwriter and are called `checkpoints_req` and `checkpoints_timed`.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'cache-thrash',
    name: 'Cache thrash',
    blurb: 'shared_buffers far too small: the clock sweep never stops and backends do their own I/O.',
    icon: '▦',
    focus: 'shared.buffers',
    duration: 110,
    knobs: {
      tps: 600,
      writeRatio: 0.45,
      updateRatio: 0.6,
      seqScanRatio: 0.1,
      sharedBuffers: 96,
      bgwriterEnabled: true,
      checkpointTimeout: 90,
      maxWalSize: 256,
      autovacuum: true,
      replicaEnabled: true,
    },
    beats: [
      [0, 'Ninety-six buffers', 'The lit part of the plaza just collapsed. shared_buffers is now far smaller than the working set, and everything the workload wants is fighting for the same handful of frames.'],
      [12, 'The clock sweep', 'That rotating hand is the buffer replacement algorithm. Postgres has no LRU list; it walks the pool decrementing each frame\'s usage_count, and the first frame it finds at zero becomes the victim. Cheap, lock-free, good enough — until there is nothing worth keeping.'],
      [28, 'Read the hit ratio', 'It fell off a cliff. Every miss is a trip down the green roads to storage, and at this rate the operating system page cache is the only thing between you and the disk.'],
      [44, 'Backends doing their own writes', 'Here is the symptom nobody recognises. When the victim frame is dirty, the backend that wanted the frame has to write it out first — before it can even start its own read. Your user-facing query is now performing someone else\'s I/O.'],
      [62, 'How you would see this', 'Query pg_stat_io and filter on `backend_type = \'client backend\'`: the `writes` there are user queries doing their own I/O. If that is large next to the checkpointer\'s writes, either shared_buffers is too small or the bgwriter is not keeping up. Both show up as latency, never as an error. Before PostgreSQL 17 the same signal was `buffers_backend` in pg_stat_bgwriter, which is where most advice on the internet still points.'],
      [82, 'Turn the dial back up', 'Drag shared_buffers up and watch the plaza light back up, the sweep slow down, and the storage roads go quiet. 25% of RAM is the usual starting point — the interesting part is that the curve is not linear: it is flat, then a cliff, then flat again.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'bloat-and-vacuum',
    name: 'Bloat and vacuum',
    blurb: 'MVCC leaves dead rows behind. Watch a table bloat, then watch autovacuum reclaim it.',
    icon: '◍',
    focus: 'autovac.launcher',
    duration: 140,
    knobs: {
      tps: 900,
      writeRatio: 0.8,
      updateRatio: 0.9,
      seqScanRatio: 0.05,
      sharedBuffers: 768,
      autovacuum: false,
      autovacuumScaleFactor: 0.1,
      longRunningXact: false,
      replicaEnabled: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'An UPDATE does not update', 'Under MVCC, UPDATE writes a *new* row version and marks the old one dead. The old version stays on the page until somebody cleans it up. Autovacuum is off right now, so nobody will.'],
      [16, 'sessions is the victim', 'Small table, rewritten constantly, and at most 15% of its updates can be HOT — fewer and fewer as the pages fill up, because a HOT update needs room for the new version on the same page. Watch its bloat bar climb in the underworld while accounts — 85% HOT while it has space — barely moves.'],
      [34, 'HOT is the quiet hero', 'A Heap-Only Tuple update keeps the new version on the same page and does not touch any index. Postgres can then prune those dead versions during ordinary page access, with no vacuum at all. That is why accounts stays lean and sessions does not.'],
      [52, 'Bloat is not just size', 'The table is physically growing. Every sequential scan now reads more pages for the same live rows, every index is fatter, and the buffer pool holds more garbage. Bloat costs you cache, not just disk.'],
      [70, 'Turn autovacuum on', 'Flip the autovacuum knob. The launcher wakes, sees dead tuples above 50 + scale_factor × live rows, and dispatches a worker down the violet road.'],
      [88, 'What a worker actually does', 'Scan the heap for dead line pointers. Then one full pass per index to remove their entries — this is why a table with six indexes is six times more expensive to vacuum. Then back to the heap to free the line pointers. It finishes by trying to truncate — but only trailing pages that are completely empty ever go back to the filesystem, which in a table this busy means none of them.'],
      [112, 'Space is reused, not returned', 'Vacuum does not usually give disk back to the filesystem; it makes space reusable inside the table. That is fine. What you actually want is for vacuum to keep up, so bloat plateaus instead of climbing.'],
      [126, 'Tune it up, not down', 'The defaults are conservative for 2005 hardware. Lower autovacuum_vacuum_scale_factor on big tables, raise autovacuum_max_workers and the cost limits. Vacuum that runs often is cheap; vacuum that runs rarely is an outage.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'xmin-horizon',
    name: 'The xmin horizon',
    blurb: 'One idle transaction stops vacuum across the entire database. The most expensive mistake in Postgres.',
    icon: '◔',
    focus: 'proc.array',
    duration: 150,
    knobs: {
      tps: 900,
      writeRatio: 0.8,
      updateRatio: 0.9,
      sharedBuffers: 768,
      autovacuum: true,
      autovacuumScaleFactor: 0.1,
      longRunningXact: true,
      replicaEnabled: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'Somebody typed BEGIN', 'And then went to lunch. One session is holding an open transaction with a snapshot. It is doing no work at all. Watch what it costs.'],
      [14, 'The horizon froze', 'That snapshot may still need to read rows that other transactions have since deleted. So the xmin horizon — the oldest xid anyone can still see — stops advancing. Vacuum is not allowed to remove any row version newer than it.'],
      [30, 'Autovacuum still runs', 'This is the cruel part. The launcher still dispatches workers. They still travel to the table, still scan the whole heap, still burn the I/O. And they collect almost nothing, because nothing is removable yet.'],
      [48, 'Watch the workers stall', 'The worker reports "0 removable" while the dead tuple count keeps climbing. It will come back on the next naptime and do the same futile work again. Your monitoring says vacuum is running. Your table says otherwise.'],
      [66, 'Bloat with no brakes', 'Every table taking writes is now growing without limit. Even the HOT path is blocked: page pruning respects the same horizon, so accounts starts bloating too. The one session that is doing nothing is the one throttling the entire database.'],
      [86, 'Where to look', 'pg_stat_activity, state = "idle in transaction", ordered by xact_start. Also check for abandoned replication slots and long-running queries on a hot standby with hot_standby_feedback on — same mechanism, same damage.'],
      [108, 'Release it', 'Turn off the long-running transaction knob. The horizon jumps forward, every dead row becomes removable at once, and the next vacuum pass actually collects something.'],
      [126, 'Then prevent it', 'Set idle_in_transaction_session_timeout. Set statement_timeout. Neither is a nice-to-have: without them, one forgotten psql window can take down a production database over a weekend.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'lock-pileup',
    name: 'Lock pile-up',
    blurb: 'One ACCESS EXCLUSIVE lock, one queue, and every session behind it stops.',
    icon: '◼',
    focus: 'lock.manager',
    duration: 100,
    knobs: {
      tps: 700,
      writeRatio: 0.6,
      updateRatio: 0.75,
      sharedBuffers: 768,
      lockContention: true,
      autovacuum: true,
      replicaEnabled: true,
      checkpointTimeout: 120,
    },
    beats: [
      [0, 'ALTER TABLE, in a transaction', 'One session takes an ACCESS EXCLUSIVE lock on sessions and holds it. The DDL itself took a millisecond. The transaction around it did not commit.'],
      [12, 'The queue forms', 'Red lines in the lock manager: every backend that wants that table is now blocked. Their latency is no longer a function of their query — it is a function of somebody else\'s transaction.'],
      [26, 'Locks queue in order', 'This is the detail that surprises people. A blocked ACCESS EXCLUSIVE request also blocks every *later* request, even harmless SELECTs that would never have conflicted with each other. One waiter poisons the whole queue behind it.'],
      [42, 'It spreads beyond the table', 'Queries on other tables are still running fine — but every blocked session is still holding a connection. Watch the backend row fill up with waiters. Once they exhaust the pool, traffic that never touches this table starts failing too. One lock becomes a total outage.'],
      [58, 'lock_timeout saves you', 'After fifteen seconds the waiters give up with "canceling statement due to lock timeout" and roll back. An error your application can retry beats a connection pool that fills up and takes down everything else.'],
      [74, 'The operational rule', 'Never run DDL without SET lock_timeout first. Take the lock quickly or fail fast, and never leave a transaction open around it. pg_locks joined to pg_stat_activity tells you who the holder is; you almost always want to cancel the holder, not the waiters.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'replication-lag',
    name: 'Replication lag',
    blurb: 'sent, write, flush, replay — four different numbers, and only one of them matters.',
    icon: '◎',
    focus: 'replica.standby',
    duration: 120,
    knobs: {
      tps: 1100,
      writeRatio: 0.75,
      updateRatio: 0.6,
      sharedBuffers: 768,
      replicaEnabled: true,
      replicaNetworkLag: 45,
      replicaSlowApply: true,
      walLevel: 'replica',
      synchronousCommit: 'on',
      autovacuum: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'Four LSNs, not one', 'The walsender ships WAL. The standby receives it (write), puts it on its own disk (flush), and only then does the startup process apply it (replay). pg_stat_replication reports all four positions separately, and they mean very different things.'],
      [16, 'The wire', 'Orange packets crossing the gap are the streaming protocol. Network latency delays every one of them equally — it moves all four numbers, and it is not what people usually mean by "lag".'],
      [32, 'Replay is single-threaded', 'One startup process applies WAL records in order. Your primary generated that WAL with sixteen concurrent backends. There is no parallel redo. When the write rate exceeds what one process can apply, replay falls behind and stays behind.'],
      [50, 'Watch the gap open', 'Received and flushed are keeping up fine — the network is not the problem and the standby\'s disk is not the problem. Only replay is sliding backwards. That is the number your read replica\'s users actually experience.'],
      [68, 'Why it matters', 'A read on this standby returns data from replay_lsn, not from flush_lsn. Your "read-only replica" is now serving results that are thirty seconds old, and nothing in the connection reports that to the application.'],
      [86, 'Also: it holds WAL', 'A standby that falls far enough behind forces the primary to retain WAL segments for its replication slot. Watch pg_wal grow. A slot for a standby that never comes back will fill the primary\'s disk — that is how a replica takes down a primary.'],
      [104, 'Monitor replay, alert on bytes', 'Track pg_current_wal_lsn() minus replay_lsn in bytes, and the replay_lag interval. Set max_slot_wal_keep_size so a dead slot cannot consume the whole volume.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'wal-flood',
    name: 'The commit trade-off',
    blurb: 'synchronous_commit: off, local, on, remote_apply — durability priced in milliseconds.',
    icon: '◇',
    focus: 'walwriter',
    duration: 135,
    knobs: {
      tps: 1400,
      writeRatio: 0.9,
      updateRatio: 0.5,
      sharedBuffers: 768,
      synchronousCommit: 'on',
      walLevel: 'replica',
      fullPageWrites: true,
      replicaEnabled: true,
      replicaNetworkLag: 40,
      replicaSlowApply: false,
      autovacuum: true,
      checkpointTimeout: 90,
      maxWalSize: 384,
    },
    beats: [
      [0, 'Commit is a wait, not a write', 'A commit does not wait for your data pages to reach disk — they can sit dirty in shared_buffers for minutes. It waits for the WAL record describing the change to be flushed. That is the entire durability contract.'],
      [16, 'synchronous_commit = on', 'The default. Each committing backend waits until flush_lsn passes its own commit LSN. Watch the backends stack up in commit_wait and then release together — one fsync satisfies all of them. That is group commit, and it is why throughput does not collapse under a high commit rate.'],
      [36, 'Now try off', 'Set synchronous_commit to off. The waits disappear and latency drops immediately, because commit stops waiting for anything. The walwriter still flushes on its timer a fraction of a second later.'],
      [54, 'What you actually gave up', 'Not consistency — the database stays perfectly consistent, and it will never come up corrupt. You gave up the last few hundred milliseconds of *committed* transactions in a crash. For an audit log that is unacceptable. For a click tracker it is free performance.'],
      [74, 'And "on" is not synchronous replication', 'This is the one everyone gets wrong. synchronous_commit=on guarantees a local flush only. If the primary\'s disk survives but the machine does not, the standby may never have seen that commit. You need synchronous_standby_names for that.'],
      [92, 'remote_apply', 'Switch to remote_apply and watch commit_wait balloon. Now every commit waits for the network, the standby\'s fsync, and the standby\'s replay before returning. You get read-your-writes on the replica, and you pay a full round trip for every single transaction.'],
      [112, 'Choose per transaction', 'synchronous_commit is a per-session setting. Money moves with remote_apply; telemetry commits with off; everything else stays on the default. Setting it once in postgresql.conf is leaving performance on the table.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'index-vs-seqscan',
    name: 'Index scan vs seq scan',
    blurb: 'Four pages or four thousand. Watch the planner choose, and watch the buffer pool pay.',
    icon: '◫',
    focus: 'storage.datadir',
    duration: 110,
    knobs: {
      tps: 320,
      writeRatio: 0.15,
      updateRatio: 0.5,
      seqScanRatio: 0.75,
      sharedBuffers: 512,
      autovacuum: true,
      replicaEnabled: true,
      checkpointTimeout: 120,
    },
    beats: [
      [0, 'Three quarters of reads are seq scans', 'Watch the underworld. An index scan walks three or four pages — root, inner, leaf, then the heap tuple. A sequential scan reads every page in the relation. Same answer, three orders of magnitude apart.'],
      [16, 'Read the plan tree', 'Above the backend row, each running query shows its plan, lighting up from the leaves toward the root. That is the real order of execution: children produce rows, parents consume them. Nothing runs until something below it has emitted a tuple.'],
      [34, 'Seq scan is not the enemy', 'For a query that touches most of a table, sequential I/O beats random I/O by so much that the planner is right to choose it. Postgres estimates this with seq_page_cost = 1.0 and random_page_cost = 4.0 — a ratio calibrated for spinning rust. On NVMe, 1.1 is closer to the truth, and lowering it makes the planner willing to use indexes it currently refuses.'],
      [56, 'Bitmap scans are the middle', 'When an index matches too many rows for a plain index scan but not enough for a full sweep, the planner builds a bitmap of pages first, then reads the heap in physical order. You get index selectivity with sequential access.'],
      [74, 'The pool defends itself', 'Notice that these scans do not wipe the buffer pool. A sequential scan of a table larger than a quarter of shared_buffers uses a small ring buffer — 256 kB — and recycles its own frames. Postgres refuses to let one analytics query evict everyone\'s hot data.'],
      [94, 'Try the other direction', 'Drag the seq scan ratio down and watch the storage roads go quiet while the index structures light up. Same throughput, a fraction of the I/O.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'no-bgwriter',
    name: 'Without the bgwriter',
    blurb: 'Turn off the one process nobody thinks about, and every backend starts writing pages.',
    icon: '◒',
    focus: 'bgwriter',
    duration: 95,
    knobs: {
      tps: 450,
      writeRatio: 0.75,
      updateRatio: 0.65,
      sharedBuffers: 384,
      bgwriterEnabled: false,
      bgwriterLruMaxpages: 100,
      autovacuum: true,
      replicaEnabled: true,
      checkpointTimeout: 150,
      maxWalSize: 512,
    },
    beats: [
      [0, 'The bgwriter is off', 'It is the least glamorous process in Postgres and the easiest to ignore. It does exactly one thing: write out dirty pages that are about to be reused, so a backend never has to.'],
      [14, 'Dirty pages accumulate', 'With a long checkpoint interval and no bgwriter, dirty count climbs and stays there. Nothing is cleaning ahead of the clock hand any more.'],
      [30, 'Backends pay the bill', 'Every time the sweep lands on a dirty victim, the backend that wanted that frame writes it out first. Watch the red page-write particles now leaving the plaza on the *backend* path rather than the teal bgwriter path.'],
      [48, 'It is a latency problem', 'Throughput barely moves; the same pages get written either way. What changed is *who* waits. A synchronous write in the middle of a user query is a latency spike, and it lands on random unlucky transactions.'],
      [64, 'Turn it back on', 'The teal sweep resumes and the backend writes fall away. It never cleans the whole pool — only a short window ahead of the clock hand, sized by the recent allocation rate — which is why the checkpointer still has plenty to do.'],
      [80, 'What to tune', 'bgwriter_lru_maxpages and bgwriter_delay. In pg_stat_io, if the `writes` against `backend_type = \'client backend\'` are a large share of total writes, the bgwriter is being outrun. Raising maxpages is nearly free. On PostgreSQL 16 and older the counter to watch is `buffers_backend` in pg_stat_bgwriter.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'connection-storm',
    name: 'Connection storm',
    blurb: 'Offered load past max_connections. Forking is not free and queueing is not throughput.',
    icon: '◉',
    focus: 'postmaster',
    duration: 90,
    knobs: {
      tps: 3200,
      writeRatio: 0.4,
      updateRatio: 0.6,
      seqScanRatio: 0.1,
      sharedBuffers: 640,
      synchronousCommit: 'on',
      autovacuum: true,
      replicaEnabled: true,
      checkpointTimeout: 90,
      maxWalSize: 512,
    },
    beats: [
      [0, 'One process per connection', 'Postgres is not threaded. The postmaster forks an entire OS process for every connection, and that process gets its own memory, its own file descriptors, and its own entry in the shared ProcArray.'],
      [14, 'Watch the forks', 'Every pulse from the postmaster is a fork. Under a connection storm this is real work — and each new backend has to be visible to every existing one before it can take a snapshot.'],
      [30, 'The ProcArray is the cost', 'Taking a snapshot means scanning the array of every running backend. More connections make every transaction in the system slightly slower, including the ones that were already fast. The cost is superlinear and it is invisible in any single query\'s timing.'],
      [48, 'Saturation is not throughput', 'All slots are busy. New work queues. Throughput has flattened; only latency is still moving, and it is moving in the wrong direction. Beyond this point more connections make the database slower, not faster.'],
      [66, 'Use a pooler', 'PgBouncer in transaction mode, a few hundred client connections mapped onto a few dozen server connections. As a rule of thumb, max_connections should be a small multiple of your core count — not a number chosen to stop your application from throwing errors.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'logical-replication',
    name: 'Logical decoding',
    blurb: 'wal_level = logical: the same WAL, decoded back into rows.',
    icon: '◊',
    focus: 'wal.vault',
    duration: 95,
    knobs: {
      tps: 700,
      writeRatio: 0.7,
      updateRatio: 0.6,
      sharedBuffers: 768,
      walLevel: 'logical',
      replicaEnabled: true,
      replicaNetworkLag: 25,
      autovacuum: true,
      checkpointTimeout: 120,
      maxWalSize: 384,
    },
    beats: [
      [0, 'wal_level = logical', 'Physical replication ships byte-for-byte block changes: the standby is an exact copy, same version, same everything. Logical decoding reads the same WAL and reconstructs the *rows* that changed.'],
      [16, 'The decoder', 'A new road opens from the vault to the logical decoder and out to a subscriber. Same source of truth, completely different output: INSERT/UPDATE/DELETE per row, per table, in commit order.'],
      [32, 'It costs you upstream', 'wal_level=logical writes more WAL — extra identity information so a change can be reconstructed without the original page. Turning it on is a decision about volume and a server restart, not a free flag.'],
      [50, 'Slots are the dangerous part', 'A logical slot guarantees the subscriber will not miss anything, which means the primary must keep every WAL segment the slot has not confirmed. An inactive slot is a disk-full incident with a delay fuse. Check pg_replication_slots.active on every server you own.'],
      [70, 'What it is good for', 'Major-version upgrades with seconds of downtime, selective table replication, and streaming changes into a warehouse or a queue. It is the mechanism behind almost every "change data capture" product you have ever used.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'full-page-writes',
    name: 'Full-page writes',
    blurb: 'Why WAL volume explodes right after every checkpoint — and why you keep it on anyway.',
    icon: '▩',
    focus: 'wal.buffers',
    duration: 100,
    knobs: {
      tps: 1200,
      writeRatio: 0.85,
      updateRatio: 0.6,
      sharedBuffers: 768,
      fullPageWrites: true,
      checkpointTimeout: 35,
      checkpointCompletionTarget: 0.9,
      maxWalSize: 1024,
      autovacuum: true,
      replicaEnabled: true,
    },
    beats: [
      [0, 'Checkpoints every 35 seconds', 'Short timeout, heavy writes. Keep your eye on the WAL rate sparkline rather than the city for the first minute.'],
      [14, 'The sawtooth', 'WAL volume spikes immediately after each checkpoint and then decays. Nothing about the workload changed. This is full_page_writes.'],
      [30, 'Torn pages', 'Your disk writes in 512-byte or 4 kB sectors; Postgres pages are 8 kB. A crash mid-write can leave a page half old and half new, and WAL replay cannot repair a page it cannot trust. So the first time a page is modified after a checkpoint, its entire image goes into the WAL.'],
      [48, 'Why it decays', 'Each page only pays once per checkpoint. As the working set gets its images written, WAL volume falls back to the size of the actual changes — until the next checkpoint resets every page and it starts again.'],
      [66, 'The lever is checkpoint frequency', 'Doubling checkpoint_timeout roughly halves full-page-write overhead, because each page pays half as often. This is the single most effective WAL-volume tuning available, and it costs you a longer crash recovery.'],
      [84, 'Do not turn it off', 'full_page_writes=off is safe only on storage that guarantees atomic 8 kB writes. If you are not certain your stack does — and on a cloud volume you are not — leaving it off means a crash can produce silent corruption you discover months later.'],
    ],
  },
]

export default SCENARIOS
