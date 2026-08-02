/* ============================================================================
 * PGSimCity — GUIDED SCENARIOS
 *
 * Each scenario is a lesson: a set of knobs that provokes one specific, real
 * Postgres behaviour, a place to point the camera, and narration beats timed
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

/** A beat remains readable for this many seconds on the scenario clock. */
export const SCENARIO_NARRATION_SECONDS = 9

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
      standbyAEnabled: true,
      standbyANetworkLag: 20,
      standbyASlowApply: false,
    },
    beats: [
      [0, 'A healthy database', 'Two hundred and forty transactions a second, and almost nothing is dramatic. Watch the plaza: the blue tiles are clean pages in shared_buffers, the red ones are dirty — modified in memory, not yet on disk. That distinction is the whole game.'],
      [14, 'Where the reads come from', 'Most reads land on a tile that is already here. The hit ratio still reads below a typical tuned OLTP server, and the seq-scan dial is why: this workload sweeps relations larger than the pool. Every shared-buffer miss makes PostgreSQL issue a read, but its statistics cannot say whether the operating-system cache or a physical device served it. Turn seq scans down and watch the ratio climb.'],
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
      standbyAEnabled: true,
    },
    beats: [
      [0, 'checkpoint_timeout is five minutes', 'So you would expect a checkpoint every five minutes. Watch what actually happens. The write rate is high and max_wal_size is only 48 MiB.'],
      [12, 'WAL wins the race', 'The vault fills faster than the clock ticks. This model crosses its scaled max_wal_size threshold and starts a checkpoint with reason "wal", not "time". PostgreSQL 18 uses a moving threshold rounded in whole WAL segments; the city preserves that dependency but not its exact segment arithmetic.'],
      [26, 'The write phase', 'Pink particles stream from the checkpointer into the plaza and down to storage. It spreads the dirty pages over checkpoint_completion_target, but this modeled WAL-pressure deadline is only seconds away rather than the configured five minutes.'],
      [42, 'And then full-page writes', 'Look at the amber flood that starts with each checkpoint. The first time any page is modified after the checkpoint has stamped its redo point, its entire 8 KiB image goes into the WAL. Frequent checkpoints mean every page pays that toll again and again — which fills the WAL faster — which triggers the next checkpoint sooner.'],
      [62, 'That is the storm', 'Checkpoint → full-page writes → more WAL → earlier checkpoint. The city shows that feedback in WAL, checkpoint and I/O counters; open the Latency vital to compare modeled p50 and p99 and inspect each component’s own p99 distribution. Those model-time quantiles are not production milliseconds.'],
      [82, 'The fix follows the cause', 'This scenario exposes its cause as WAL pressure, so raising max_wal_size against measured WAL rate and disk headroom is appropriate. On a real server, requested checkpoints can also come from explicit CHECKPOINT, backup and shutdown activity; verify the reason before tuning.'],
      [104, 'Check your own server', '`pg_stat_checkpointer.num_requested` counts requested checkpoints but does not encode why they were requested. Correlate its rate with WAL volume, checkpoint messages, explicit maintenance and backups. On PostgreSQL 16 and older the counters are `checkpoints_req` and `checkpoints_timed` in pg_stat_bgwriter.'],
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
      sharedBuffers: 16,
      bgwriterEnabled: true,
      checkpointTimeout: 90,
      maxWalSize: 256,
      autovacuum: true,
      standbyAEnabled: true,
    },
    beats: [
      [0, 'Sixteen MiB', 'The lit part of the plaza just collapsed. shared_buffers is now far smaller than the working set, and everything the workload wants is fighting for the same handful of frames.'],
      [12, 'The clock sweep', 'That rotating hand is the buffer replacement algorithm. Postgres has no LRU list; it walks the pool decrementing each frame\'s usage_count, and the first frame it finds at zero becomes the victim. Cheap, no global lock to fight over, good enough — until there is nothing worth keeping.'],
      [28, 'Read the hit ratio', 'It fell off a cliff. Every miss leaves shared_buffers and asks the operating system for a page; PostgreSQL’s standard block counters cannot distinguish an OS-cache hit from a device read. The green road represents that request, not proof that a disk moved.'],
      [44, 'Backends doing their own writes', 'Here is the symptom nobody recognises. When the victim frame is dirty, the backend that wanted the frame has to write it out first — before it can even start its own read. Your user-facing query is now performing someone else\'s I/O.'],
      [62, 'How you would see this', 'Open the Latency vital: modeled p99 can separate buffer-read and dirty-victim-write time from the rest of the trip. On PostgreSQL, query `pg_stat_io` and filter on `backend_type = \'client backend\'`: a large share of writes there means shared_buffers is too small or the bgwriter is not keeping up. Before PostgreSQL 17 the related signal was `buffers_backend` in pg_stat_bgwriter.'],
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
      autovacuumScaleFactor: 0.03,
      longRunningXact: false,
      standbyAEnabled: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'An UPDATE does not update', 'Under MVCC, UPDATE writes a *new* row version and marks the old one dead. Routine autovacuum is off now, so the launcher will send nobody new in this city. PostgreSQL does let a worker that was already running finish, and still forces anti-wraparound vacuums — the city does not model per-relation XID age. Until then, these dead versions accumulate.'],
      [16, 'sessions is the victim', 'Small table, rewritten constantly, and at most 15% of its updates can be HOT — fewer and fewer as the pages fill up, because a HOT update needs room for the new version on the same page. Watch its bloat bar climb in the underworld while accounts — 85% HOT while it has space — barely moves.'],
      [34, 'HOT is the quiet hero', 'A Heap-Only Tuple update keeps the new version on the same page and does not touch any index. Postgres can then prune those dead versions during ordinary page access, with no vacuum at all. That is why accounts stays lean and sessions does not.'],
      [52, 'Bloat is not just size', 'The table is physically growing. Sequential scans now read more pages for the same live rows, and non-HOT churn can bloat indexes too. HOT updates create no new index entries. Either way, a larger working set competes for cache as well as disk.'],
      [70, 'Autovacuum comes back on', 'The scenario turns autovacuum on now. The launcher wakes and dispatches a worker down the violet road — and it is the worker, not the launcher, that reads the statistics and picks out every table whose dead row versions exceed 50 + scale_factor × its live row count.'],
      [88, 'What the modeled worker does', 'The city runs heap scan, one aggregate pass per declared index, heap cleanup and a fixed truncate phase, charging representative page I/O. Its truncation uses a tail-density heuristic; it does not model ACCESS EXCLUSIVE acquisition or another session denying that lock. In this busy relation the heuristic normally leaves the file size unchanged.'],
      [112, 'Space is reused, not returned', 'PostgreSQL normally records reclaimed space for reuse inside the table. The city represents this only as aggregate spare capacity that can delay relation extension; it has no per-page FSM entries or placement path. What you want in either case is for bloat to plateau instead of climbing.'],
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
      standbyAEnabled: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'Somebody typed BEGIN', 'And then went to lunch. One session is holding an open transaction with a snapshot. It is doing no work at all. Watch what it costs.'],
      [14, 'The horizon froze', 'That snapshot may still need to read rows that other transactions have since deleted. So the xmin horizon — the oldest xmin of any snapshot still held — stops advancing. Vacuum can reclaim a deleted row version only once the transaction that deleted it has committed and fallen behind the horizon, so everything deleted from here on has to stay.'],
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
    blurb: 'One scripted ACCESS EXCLUSIVE holder and the direct waiters the model attaches to it.',
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
      standbyAEnabled: true,
      checkpointTimeout: 120,
    },
    beats: [
      [0, 'A lock taken, and a transaction left open', 'One session ran LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE — the same lock every ALTER TABLE takes — and its transaction never committed. The statement itself took a millisecond; the lock outlives it.'],
      [12, 'Direct waiters form', 'Red lines in the lock manager mark modeled backends blocked directly by the one scripted ACCESS EXCLUSIVE holder. The city counts waiters and occupied backend slots; the Lock wait readout is that component’s own rolling p99.'],
      [26, 'Queue fairness is absent', 'PostgreSQL lock queues can let an earlier incompatible waiter hold up later requests. This city does not model lock-queue fairness, lock modes, or a waiter blocking another waiter; every red waiter is attached directly to the scripted holder.'],
      [42, 'It spreads beyond the table', 'Queries on other tables are still running fine — but every blocked session is still holding a connection. Watch the backend row fill up with waiters. Once they exhaust the pool, traffic that never touches this table starts failing too. One lock becomes a total outage.'],
      [58, 'The script releases waiters', 'At this beat the scenario applies a fixed 15 model-second timeout and releases its direct waiters. There is no lock_timeout knob or general timeout model. On PostgreSQL, SET lock_timeout for DDL can make a lock attempt fail instead of waiting indefinitely.'],
      [74, 'The operational rule', 'Use SET lock_timeout for DDL so it acquires the lock quickly or fails. If an idle transaction holds the lock, pg_cancel_backend has no running query to cancel and does not end the transaction. Get the client to commit or roll back, or—after verifying the PID, owner and abort consequences—use pg_terminate_backend.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'replication-lag',
    name: 'Replication lag',
    blurb: 'standby_b falls behind while standby_a stays current: two nodes, two replay cursors.',
    icon: '◎',
    focus: 'standby.b',
    duration: 120,
    knobs: {
      tps: 1100,
      writeRatio: 0.75,
      updateRatio: 0.6,
      sharedBuffers: 768,
      standbyAEnabled: true,
      standbyANetworkLag: 45,
      standbyASlowApply: false,
      standbyBEnabled: true,
      standbyBNetworkLag: 65,
      standbyBSlowApply: true,
      walLevel: 'replica',
      synchronousCommit: 'on',
      autovacuum: true,
      checkpointTimeout: 120,
      maxWalSize: 512,
    },
    beats: [
      [0, 'Two rows, not one cluster lag', 'The primary runs one walsender per standby. Both nodes receive, write, flush and apply independently, so pg_stat_replication has two rows and neither row can stand in for “the cluster”.'],
      [16, 'The wire', 'Both orange streams carry physical WAL. Each has its own packet queue and acknowledgement path; delaying standby_b does not move standby_a’s positions.'],
      [32, 'Replay is single-threaded', 'Core PostgreSQL 18 uses one startup process to apply the ordered WAL stream; recovery prefetch can improve I/O but is not general parallel redo. Replay falls behind while sustained WAL generation exceeds replay capacity, and catches up whenever replay capacity becomes greater than the incoming rate.'],
      [50, 'Watch the disagreement open', 'standby_b received and flushed positions keep moving while applied falls behind. standby_a stays current on the same workload, proving the lag belongs to one startup process rather than to shared global state.'],
      [68, 'What replay means', 'On PostgreSQL, a standby read can see only changes through that node’s replayed LSN. The city tracks this visibility frontier but does not execute replica queries or store replica rows, so the two LSN positions—not query results—are the evidence here.'],
      [86, 'Slots hold receipt, not replay', 'standby_b’s physical slot advances with durable receive, so slow apply grows its own pg_wal. Disconnect a standby instead and its slot restart_lsn stops advancing on the primary; without a configured retention limit or idle-slot timeout, primary pg_wal can then grow until the volume fills.'],
      [104, 'Monitor replay, alert on bytes', 'Track pg_current_wal_lsn() minus replay_lsn for current byte backlog. The replay_lag interval estimates recent commit-delay impact, not current staleness or catch-up time, and can become NULL when idle. Set max_slot_wal_keep_size so a dead slot cannot consume the whole volume.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'wal-flood',
    name: 'The commit trade-off',
    blurb: 'synchronous_commit: off, local, remote_write, on, remote_apply — compare durability with stretched model time.',
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
      standbyAEnabled: true,
      standbyANetworkLag: 40,
      standbyASlowApply: false,
      autovacuum: true,
      checkpointTimeout: 90,
      maxWalSize: 384,
    },
    beats: [
      [0, 'Commit is a wait, not a write', 'A commit does not wait for your data pages to reach disk — they can sit dirty in shared_buffers for minutes. It waits for the WAL record describing the change to be flushed. That is the entire durability contract.'],
      [16, 'synchronous_commit = on', 'The default. Each committing backend waits until flush_lsn passes its own commit LSN. Watch the backends stack up in commit_wait and then release together — one fsync satisfies all of them. That is group commit, and it is why throughput does not collapse under a high commit rate.'],
      [36, 'Now try off', 'Set synchronous_commit to off. Modeled commit_wait occupancy and stretched model trip duration fall because commit stops waiting for the flush. The walwriter still flushes on its timer a fraction of a second later.'],
      [54, 'What you actually gave up', 'Not consistency — the database stays perfectly consistent, and it will never come up corrupt. You gave up the last few hundred milliseconds of *committed* transactions in a crash. For an audit log that is unacceptable. For a click tracker it is free performance.'],
      [74, 'Why "on" waits remotely here', 'synchronous_commit=on alone guarantees only the primary’s local flush. This cluster also names standby_a in synchronous_standby_names, so on waits for standby_a to flush; standby_b remains asynchronous. Remove that name and on collapses back to local durability.'],
      [92, 'remote_apply', 'Switch to remote_apply and watch modeled commit_wait occupancy grow while the acknowledgement waits for standby replay. PostgreSQL can use that guarantee for read-your-writes on the synchronous standby; the city does not execute replica reads, and its displayed statement duration is stretched model time.'],
      [112, 'Choose per transaction', 'synchronous_commit is a per-session setting. Money moves with remote_apply; telemetry commits with off; everything else stays on the default. Setting it once in postgresql.conf is leaving performance on the table.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'index-vs-seqscan',
    name: 'Index scan vs seq scan',
    blurb: 'Compare fixed index and sequential-scan templates, then watch their different buffer traffic.',
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
      standbyAEnabled: true,
      checkpointTimeout: 120,
    },
    beats: [
      [0, 'Three quarters of modeled reads use the seq template', 'The slider changes the mix of fixed statement kinds; it does not make a planner reconsider one query. Watch their different page routes. The city’s index template touches a few sampled pages, while its sequential template walks the modeled relation.'],
      [16, 'Read the plan tree', 'Above the backend row, each running query shows its plan, lighting up from the leaves toward the root. That is the real order of execution: children produce rows, parents consume them. Nothing runs until something below it has emitted a tuple.'],
      [34, 'PostgreSQL can choose differently', 'A real PostgreSQL planner may prefer a sequential scan when a query touches most of a table, using cost settings and statistics. The city does not model that decision: the statement kind already selected the template before the displayed cost cards are drawn.'],
      [56, 'The bitmap template is fixed too', 'PostgreSQL can choose a bitmap scan between plain index access and a full sweep. Here, Bitmap Heap Scan appears only in the fixed DELETE template; no selectivity or cost crossover can make the city switch to it.'],
      [74, 'The pool limits pollution', 'A sequential scan of a relation larger than a quarter of shared_buffers uses the bulk-read strategy. In PostgreSQL 18 it starts at 256 KiB, grows with io_combine_limit × effective_io_concurrency, and is capped; PostgreSQL 18.3 defaults yield about 2.25 MiB with 8 KiB blocks. The ring limits cache pollution but does not guarantee that no hot page is displaced.'],
      [94, 'Try the other direction', 'Drag the seq scan ratio down and watch the workload mix produce fewer modeled reads while the index structures light up. Offered TPS is unchanged; achieved TPS remains a separate counter.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'no-bgwriter',
    name: 'Without the bgwriter',
    blurb: 'Turn off modeled background cleaning and sampled dirty-victim writes shift to backends.',
    icon: '◒',
    focus: 'bgwriter',
    duration: 95,
    knobs: {
      tps: 450,
      writeRatio: 0.75,
      updateRatio: 0.65,
      seqScanRatio: 0,
      sharedBuffers: 384,
      bgwriterEnabled: false,
      bgwriterLruMaxpages: 100,
      autovacuum: false,
      standbyAEnabled: true,
      checkpointTimeout: 150,
      maxWalSize: 512,
    },
    beats: [
      [0, 'The bgwriter is off', 'It is the least glamorous process in Postgres and the easiest to ignore. It writes out dirty pages that are about to be reused, reducing the likelihood that a backend has to write one itself.'],
      [14, 'Dirty pages accumulate', 'With a long checkpoint interval and no bgwriter, dirty count climbs and stays there. Nothing is cleaning ahead of the clock hand any more.'],
      [30, 'Backends pay the bill', 'Every time the sweep lands on a dirty victim, the backend that wanted that frame writes it out first. Watch the red page-write particles now leaving the plaza on the *backend* path rather than the teal bgwriter path.'],
      [48, 'Measure the claim', 'Open the Latency vital and compare modeled p50, p99 and TPS. Its p99 components are independent distributions: dirty-victim wait now includes XLogFlush when the victim page LSN is ahead of durable WAL, followed by the page write. That is synchronous I/O in the middle of a user query; when the page LSN is already flushed, the WAL part costs nothing. Compare that component with sampled backend writes instead of treating the components as one total-p99 trip.'],
      [64, 'Turn it back on', 'The teal sweep resumes and the backend writes fall away. It never cleans the whole pool — only a short window ahead of the clock hand, sized by the recent allocation rate — which is why the checkpointer still has plenty to do.'],
      [80, 'What to tune', 'bgwriter_lru_maxpages and bgwriter_delay. In pg_stat_io, if the `writes` against `backend_type = \'client backend\'` are a large share of total writes, the bgwriter is being outrun. Raising maxpages is nearly free. On PostgreSQL 16 and older the counter to watch is `buffers_backend` in pg_stat_bgwriter.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'connection-storm',
    name: 'Connection storm',
    blurb: 'Offered load past the city’s fixed backend capacity: forks, occupied slots and queued work.',
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
      standbyAEnabled: true,
      checkpointTimeout: 90,
      maxWalSize: 512,
    },
    beats: [
      [0, 'One process per connection', 'Postgres is not threaded. The postmaster forks an entire OS process for every connection, and that process gets its own memory, its own file descriptors, and its own entry in the shared ProcArray.'],
      [14, 'Watch the modeled forks', 'Every pulse from the postmaster starts one modeled backend and occupies one of sixteen fixed slots. PostgreSQL does more process, authentication and snapshot work than this animation represents.'],
      [30, 'ProcArray cost is absent', 'PostgreSQL snapshots inspect shared process state, but this city does not charge ProcArray scanning, process memory, authentication, or context-switch cost. Its connection pressure comes from a fixed fork cadence and finite slots only.'],
      [48, 'Saturation is not throughput', 'All modeled slots are busy, offered load exceeds achieved TPS, and new work queues. The city’s rolling latency begins only when a backend starts a statement, so it deliberately excludes this client-side queue and cannot show the full response-time cost of excess connections.'],
      [66, 'Use a pooler', 'PgBouncer in transaction mode, a few hundred client connections mapped onto a few dozen server connections. As a rule of thumb, max_connections should be a small multiple of your core count — not a number chosen to stop your application from throwing errors.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'logical-replication',
    name: 'Logical decoding',
    blurb: 'wal_level = logical: illustrative change rate and slot progress, without decoded rows.',
    icon: '◊',
    focus: 'wal.vault',
    duration: 95,
    knobs: {
      tps: 700,
      writeRatio: 0.7,
      updateRatio: 0.6,
      sharedBuffers: 768,
      walLevel: 'logical',
      standbyAEnabled: true,
      standbyANetworkLag: 25,
      autovacuum: true,
      checkpointTimeout: 120,
      maxWalSize: 384,
    },
    beats: [
      [0, 'wal_level = logical', 'Physical replication replays WAL-logged block changes for the whole cluster; the standby is not a byte-identical data directory because local state and unlogged contents differ. Logical decoding reads WAL and reconstructs the committed *rows* that changed for selected logical consumers.'],
      [16, 'The illustrative decoder', 'A new road opens from the vault to the logical subscriber. The city derives a row-changes-per-second teaching rate and advances a slot LSN; it does not reconstruct row values, transactions, publications, commit order or subscriber table state.'],
      [32, 'It costs you upstream', 'wal_level=logical writes more WAL — extra identity information so a change can be reconstructed without the original page. Turning it on is a decision about volume and a server restart, not a free flag.'],
      [50, 'Slots are the dangerous part', 'For a logical slot, restart_lsn governs the oldest WAL still retained; confirmed_flush_lsn records consumer acknowledgement and may be further ahead. An inactive permanent slot can become a disk-full incident unless ownership is resolved or configured timeout and retention limits invalidate it.'],
      [70, 'What it is good for', 'Major-version upgrades with seconds of downtime, selective table replication, and streaming changes into a warehouse or a queue. It is the mechanism behind almost every "change data capture" product you have ever used.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'full-page-writes',
    name: 'Full-page writes',
    blurb: 'Why WAL volume explodes as each checkpoint begins — and why you keep it on anyway.',
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
      standbyAEnabled: true,
    },
    beats: [
      [0, 'Checkpoints every 35 seconds', 'Short timeout, heavy writes. Keep your eye on the WAL rate sparkline rather than the city for the first minute.'],
      [14, 'The sawtooth', 'WAL volume surges the moment each checkpoint starts and then decays. Nothing about the workload changed. This is full_page_writes.'],
      [30, 'Torn pages', 'Your disk writes in 512-byte or 4 KiB sectors; Postgres pages are 8 KiB. A crash mid-write can leave a page half old and half new, and WAL replay cannot repair a page it cannot trust. So the first time a page is modified after a checkpoint has stamped its redo point, its entire image goes into the WAL.'],
      [48, 'Why it decays', 'Each page only pays once per checkpoint. As the working set gets its images written, WAL volume falls back to the size of the actual changes — until the next checkpoint resets every page and it starts again.'],
      [66, 'The lever is checkpoint frequency', 'Doubling checkpoint_timeout roughly halves full-page-write overhead, because each page pays half as often. This is the single most effective WAL-volume tuning available, and it costs you a longer crash recovery.'],
      [84, 'Do not turn it off', 'full_page_writes=off is safe only on storage that guarantees atomic 8 KiB writes. If you are not certain your stack does — and on a cloud volume you are not — leaving it off means a crash can produce silent corruption you discover months later.'],
    ],
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'slot-pressure',
    name: 'Slot pressure',
    blurb: 'A required standby must resume from its slot. Verify ownership and recovery intent, calculate exhaustion and catch-up, then add only validated temporary headroom.',
    icon: '⌁',
    focus: 'wal.vault',
    duration: 0,
    knobs: {
      tps: 750,
      writeRatio: 1,
      updateRatio: 1,
      seqScanRatio: 0,
      sharedBuffers: 768,
      synchronousCommit: 'local',
      fullPageWrites: true,
      walLevel: 'replica',
      walGArchiveCredentialsValid: true,
      standbyAEnabled: true,
      standbyBEnabled: false,
      checkpointTimeout: 15,
      checkpointCompletionTarget: 0.5,
      maxWalSize: 512,
    },
    decision: {
      revealAt: 179,
      choices: [
        {
          id: 'add-wal-capacity',
          label: 'Add validated 512 MiB headroom',
          hint: 'The owner requires continuity without a rebuild; the measured WAL rate and catch-up plan establish this amount as adequate temporary headroom.',
        },
        {
          id: 'drop-replication-slot',
          label: 'Drop the required slot',
          hint: 'Release retained WAL now, violate the stated continuity requirement, and rebuild standby_b from a new base backup.',
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'vacuum-blockade',
    name: 'Vacuum blockade',
    blurb: 'A verified abandoned, idle transaction with no work worth preserving pins xmin; terminating it aborts the transaction and releases cleanup.',
    icon: '⌛',
    focus: 'proc.array',
    duration: 0,
    knobs: {
      tps: 1600,
      writeRatio: 0.88,
      updateRatio: 0.94,
      seqScanRatio: 0,
      sharedBuffers: 768,
      autovacuum: true,
      autovacuumScaleFactor: 0.01,
      longRunningXact: true,
      standbyAEnabled: true,
      checkpointTimeout: 120,
      maxWalSize: 768,
    },
    decision: {
      revealAt: 56,
      choices: [
        {
          id: 'terminate-transaction',
          label: 'Terminate the session',
          hint: 'The PID, owner and business impact are verified; abort the abandoned transaction and release xmin.',
        },
        {
          id: 'wait-for-transaction',
          label: 'Keep waiting',
          hint: 'Preserve the session while dead row versions and relation pages keep growing.',
        },
      ],
    },
  },

  /* ---------------------------------------------------------------------- */
  {
    id: 'failover-candidate',
    name: 'Choose the candidate',
    blurb: 'After fencing the old primary, two otherwise eligible same-system, usable-timeline candidates differ only in durable LSN.',
    icon: '⑂',
    focus: 'standby.b',
    duration: 0,
    knobs: {
      tps: 2600,
      writeRatio: 1,
      updateRatio: 0.7,
      seqScanRatio: 0,
      sharedBuffers: 768,
      synchronousCommit: 'on',
      walLevel: 'replica',
      standbyAEnabled: true,
      standbyANetworkLag: 20,
      standbyASlowApply: false,
      standbyBEnabled: true,
      standbyBNetworkLag: 900,
      standbyBSlowApply: true,
      haPartition: 'healthy',
      walLogHints: true,
      checkpointTimeout: 120,
      maxWalSize: 768,
    },
    decision: {
      revealAt: 28,
      choices: [
        {
          id: 'promote-standby-a',
          label: 'Promote standby_a',
          hint: 'Within the stated eligibility and fencing assumptions, use the later durable replay position.',
        },
        {
          id: 'promote-standby-b',
          label: 'Promote standby_b',
          hint: 'Use the more-lagged candidate and discard its missing WAL history.',
        },
      ],
    },
  },
]

export default SCENARIOS
