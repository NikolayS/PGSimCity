import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { CLAIM_VALUES } from '../src/core/claims'
import { createCollector } from '../src/observability/collector'
import { CATALOG } from '../src/observability/catalog'
import { ALL_STEPS, ALL_VERDICTS } from '../src/observability/paths'
import { PROJECTIONS } from '../src/observability/views'
import { createSim } from '../src/sim/model'
import { SCENARIOS } from '../src/sim/scenarios'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'

const bodies = [...DOCS_MEMORY, ...DOCS_STORAGE]
  .flatMap((doc) => [doc.tldr, ...doc.sections.map((section) => section.body)])
  .join('\n')

const diagnosticCopy = [...ALL_STEPS, ...ALL_VERDICTS]
  .flatMap((node) => node.kind === 'step'
    ? [node.title, node.why, node.look, node.note ?? '']
    : [node.title, node.because, node.mechanism, node.fix])
  .join('\n')

describe('PostgreSQL 18 content corrections', () => {
  it('keeps every storage entry cited with current recovery section numbering', () => {
    expect(
      DOCS_STORAGE.filter((doc) => !doc.refs).map((doc) => doc.id),
    ).toEqual([])

    const recoveryLabels = DOCS_STORAGE
      .flatMap((doc) => doc.refs?.docs ?? [])
      .map((ref) => ref.label)
      .filter((label) => label.includes('Recovering Using a Continuous Archive Backup'))

    expect(recoveryLabels).not.toHaveLength(0)
    expect(new Set(recoveryLabels)).toEqual(
      new Set(['25.3.5 Recovering Using a Continuous Archive Backup']),
    )
  })

  it('records the major-version target and current bulk-read strategy durably', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const checkpointer = DOCS_STORAGE.find((doc) => doc.id === 'checkpointer')!
    const launcher = DOCS_STORAGE.find((doc) => doc.id === 'autovac.launcher')!
    const stats = DOCS_MEMORY.find((doc) => doc.id === 'stats.shmem')!
    const vacuumVerdict = ALL_VERDICTS.find((verdict) => verdict.id === 'v.av_tuning')!
    const statements = CATALOG.find((entry) => entry.id === 'pg_stat_statements')!
    const checkpointerCopy = checkpointer.sections.map((section) => section.body).join('\n')
    const launcherCopy = launcher.sections.map((section) => section.body).join('\n')
    const statsCopy = stats.sections.map((section) => section.body).join('\n')

    expect(readme).toContain('targets the PostgreSQL 18 major line')
    expect(readme).toContain('fixed 32-frame ring')
    expect(readme).toMatch(/WAL district[^\n]+archiver copies completed[^\n]+walsenders independently stream WAL as it is generated/i)
    expect(readme).not.toContain('walwriter → `pg_wal` segments → archiver → walsender')
    expect(bodies).toContain('io_combine_limit')
    expect(`${bodies}\n${diagnosticCopy}`).not.toMatch(/small (?:256 kB|256 KiB) ring/i)
    expect(CLAIM_VALUES.timelineRecovery.defaultDisclosure).toMatch(/since PostgreSQL 12/i)
    expect(CLAIM_VALUES.timelineRecovery.defaultDisclosure).toMatch(/PostgreSQL 11 and older.*current/i)
    expect(checkpointerCopy).toMatch(/PostgreSQL 14.*0\.9.*13 and older.*0\.5/is)
    for (const copy of [launcherCopy, statsCopy, vacuumVerdict.mechanism]) {
      expect(copy).toContain('autovacuum_vacuum_max_threshold')
      // Either numeral form; the fact is the cap, not its formatting.
      expect(copy).toMatch(/100,000,000|100 million/)
      // Version-dependent, so it must carry its version.
      expect(copy).toMatch(/PostgreSQL 1[78]|17 and older/i)
    }
    /*
     * The city IMPLEMENTS the cap (`AUTOVACUUM_VACUUM_MAX_THRESHOLD`,
     * `src/sim/model.ts`), so prose must not still disclose it as unmodelled.
     * That disclosure was true before the oracle round and is now false — a test
     * asserting it would pin a stale claim about our own model.
     */
    for (const copy of [launcherCopy, statsCopy, vacuumVerdict.mechanism]) {
      // Same-sentence window: `.*` would span two unrelated true statements.
      // Note ANALYZE genuinely IS uncapped -- the max threshold caps vacuum only --
      // so a bare /uncapped/ check would be a false positive on correct prose.
      expect(copy).not.toMatch(/(?:does not (?:implement|model)|uncapped)[^.]{0,90}max(?:imum)?[ _]threshold/i)
    }
    // And the scale term is reltuples, not the live-tuple counter.
    expect(`${launcherCopy}\n${statsCopy}`).toMatch(/reltuples/)
    expect(`${launcherCopy}\n${statsCopy}`).not.toMatch(/scale_factor\s*[×x]\s*n_live_tup/i)
    expect(statements.version).toMatch(/PostgreSQL 18.*wal_buffers_full.*parallel_workers/is)
    expect(statements.version).toMatch(/PostgreSQL 13.*toplevel.*JIT.*stats_since/is)
  })

  it('makes every projected setting context operational and version-correct', () => {
    const catalog = CATALOG.find((entry) => entry.id === 'pg_settings')!
    const sim = createSim(createBus())
    const projection = PROJECTIONS.settings(sim.state, createCollector(sim), 'total')
    const contexts = Object.fromEntries(projection.rows.map((row) => {
      const cell = row.cells.context
      return [row.key, typeof cell === 'string' ? cell : cell.v]
    }))

    expect(catalog.coverageNote).not.toContain('exactly as a SET or a reload would')
    expect(catalog.coverageNote).toMatch(/model.*immediately/i)
    expect(catalog.coverageNote).toMatch(/context.*SET.*reload.*restart/is)
    expect(contexts).toEqual({
      shared_buffers: 'postmaster',
      wal_buffers: 'postmaster',
      max_connections: 'postmaster',
      superuser_reserved_connections: 'postmaster',
      reserved_connections: 'postmaster',
      checkpoint_timeout: 'sighup',
      checkpoint_completion_target: 'sighup',
      max_wal_size: 'sighup',
      bgwriter_lru_maxpages: 'sighup',
      bgwriter_delay: 'sighup',
      synchronous_commit: 'user',
      wal_level: 'postmaster',
      full_page_writes: 'sighup',
      autovacuum: 'sighup',
      autovacuum_vacuum_scale_factor: 'sighup',
      autovacuum_max_workers: 'sighup',
      track_io_timing: 'superuser',
    })
    expect(projection.caption).toMatch(/PostgreSQL 18.*autovacuum_max_workers.*sighup/is)
    expect(projection.caption).toMatch(/PostgreSQL 17 and earlier.*postmaster/is)
  })

  it('separates crash-recovery server-log lines from client-only messages', () => {
    const postmaster = DOCS_MEMORY.find((doc) => doc.id === 'postmaster')!
    const production = postmaster.sections.find(
      (section) => section.heading === 'What you would see in production',
    )!.body

    expect(production).toContain('client backend (PID …) was terminated by signal 9: Killed')
    expect(production).toContain('all server processes terminated; reinitializing')
    expect(production).toContain('automatic recovery in progress')
    expect(production).toContain('redo starts at')
    expect(production).toContain('redo done at')
    expect(production).toContain('database system is ready to accept connections')
    expect(production).toMatch(/surviving clients.*WARNING: terminating connection because of crash/is)
    expect(production).toMatch(/reconnect.*during recovery.*FATAL: the database system is in recovery mode/is)
  })

  it('includes every preload and restart step before recommending gated features', () => {
    const logger = DOCS_STORAGE.find((doc) => doc.id === 'logger')!
    const stats = DOCS_STORAGE.find((doc) => doc.id === 'stats.collector')!
    const standbyBuffers = DOCS_STORAGE.find((doc) => doc.id === 'replica.buffers')!
    const planTree = DOCS_MEMORY.find((doc) => doc.id === 'planner.plantree')!
    const statements = CATALOG.find((entry) => entry.id === 'pg_stat_statements')!
    const loggerCopy = logger.sections.map((section) => section.body).join('\n')
    const statsCopy = stats.sections.map((section) => section.body).join('\n')
    const standbyCopy = standbyBuffers.sections.map((section) => section.body).join('\n')
    const planCopy = planTree.sections.map((section) => section.body).join('\n')

    expect(loggerCopy).toMatch(/logging_collector.*postmaster.*restart/is)
    expect(loggerCopy).toContain('pending_restart = t')
    expect(loggerCopy).toMatch(/auto_explain.*shared_preload_libraries.*restart/is)
    expect(planCopy).toMatch(/auto_explain.*shared_preload_libraries.*restart/is)
    expect(statsCopy).toMatch(/pg_stat_statements.*shared_preload_libraries.*restart.*CREATE EXTENSION pg_stat_statements/is)
    expect(statements.coverageNote).toMatch(/shared_preload_libraries.*restart.*CREATE EXTENSION pg_stat_statements/is)
    expect(standbyCopy).toMatch(/add `pg_prewarm` to `shared_preload_libraries` on each standby and restart/is)
    expect(standbyCopy).toMatch(/CREATE EXTENSION pg_prewarm.*alone.*does not start autoprewarm/is)
  })

  it('does not overclaim what cumulative statistics prove', () => {
    expect(diagnosticCopy).not.toContain('every miss is a real trip to storage')
    expect(diagnosticCopy).not.toContain('is on CPU — that is work')
    expect(diagnosticCopy).not.toContain('Every number here is a counter')
    expect(diagnosticCopy).toContain('not currently reporting an instrumented wait')
  })

  it('uses restart_lsn as the retention position for logical slots', () => {
    expect(bodies).toContain('For both physical and logical slots, `restart_lsn`')
    expect(bodies).not.toContain('`restart_lsn` for physical slots, `confirmed_flush_lsn` for logical ones')

    const sim = createSim(createBus())
    sim.setKnob('walLevel', 'logical')
    const result = PROJECTIONS.slots(sim.state, createCollector(sim), 'total')
    const logical = result.rows.find((row) => row.key === 'sub')

    expect(logical?.cells.restart_lsn).not.toEqual({ v: '—', tone: 'dim' })
    expect(logical?.cells.confirmed_flush_lsn).not.toBeUndefined()
    expect(result.caption).toContain('minus restart_lsn for every slot')
  })

  it('makes slot-pressure correctness depend on visible recovery evidence', () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'slot-pressure')!
    const preserve = scenario.decision!.choices.find((choice) => choice.id === 'add-wal-capacity')!
    const drop = scenario.decision!.choices.find((choice) => choice.id === 'drop-replication-slot')!
    const walVault = DOCS_STORAGE.find((doc) => doc.id === 'wal.vault')!
    const slotCopy = walVault.sections.map((section) => section.body).join('\n')

    expect(scenario.blurb).toContain('required standby')
    expect(preserve.label).toBe('Add validated 512 MiB headroom')
    expect(preserve.hint).toContain('measured WAL rate')
    expect(preserve.hint).toContain('temporary headroom')
    expect(drop.hint).toContain('retention guarantee')
    expect(drop.hint).toMatch(/pg_wal.*archive/is)
    expect(slotCopy).toMatch(/dropping.*does not delete.*WAL/is)
    expect(slotCopy).toMatch(/base backup.*only.*unavailable.*every source/is)
    expect(slotCopy).not.toContain('whatever was consuming that slot has to be rebuilt')
  })

  it('states the background-writer write-amplification trade', () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'no-bgwriter')!
    const tuning = scenario.beats.find((beat) => beat[0] === 80)![2]
    const verdict = ALL_VERDICTS.find((entry) => entry.id === 'v.backend_writes')!
    const maxPages = verdict.knobs.find((knob) => knob.key === 'bgwriterLruMaxpages')!

    for (const copy of [tuning, maxPages.help]) {
      expect(copy).toMatch(/move.*writes?.*(?:off|out of).*query.*path/is)
      expect(copy).toMatch(/(?:increase|more|extra).*total.*writes?|total.*I\/O.*increase/is)
      expect(copy).not.toMatch(/nearly free/i)
    }
  })

  it('assigns idle and statement timeouts to different failure modes', () => {
    const scenario = SCENARIOS.find((entry) => entry.id === 'xmin-horizon')!
    const prevention = scenario.beats.find((beat) => beat[0] === 126)![2]
    const verdict = ALL_VERDICTS.find((entry) => entry.id === 'v.xmin')!
    const backend = DOCS_MEMORY.find((doc) => doc.id === 'backend.slot')!
    const backendCopy = backend.sections.map((section) => section.body).join('\n')

    for (const copy of [prevention, verdict.fix, backendCopy]) {
      expect(copy).toMatch(/idle_in_transaction_session_timeout.*idle.*between statements/is)
      expect(copy).toMatch(/statement_timeout.*while a statement is (?:being )?processed/is)
      expect(copy).toMatch(/statement_timeout.*does not.*idle transaction/is)
    }
  })

  it('lists the complete PostgreSQL 18 pg_stat_replication surface', () => {
    const replication = CATALOG.find((entry) => entry.id === 'pg_stat_replication')!
    expect(replication.columns.at(-1)).toBe('reply_time')
  })

  it('treats dead-tuple statistics as pressure estimates, not measured bloat', () => {
    const first = ALL_STEPS.find((step) => step.id === 'bloat.1')!
    const noBloat = ALL_VERDICTS.find((verdict) => verdict.id === 'v.no_bloat')!
    const tableCatalog = CATALOG.find((entry) => entry.id === 'pg_stat_all_tables')!

    expect(`${first.why} ${first.look}`).toMatch(/estimated/i)
    expect(first.sql).toContain('pg_total_relation_size')
    expect(first.look).toContain('pgstattuple')
    expect(noBloat.title).not.toMatch(/not bloated/i)
    expect(tableCatalog.what).not.toMatch(/bloat becomes visible/i)
  })

  it('uses reltuples and the PostgreSQL 18 cap everywhere autovacuum is explained', () => {
    const tuning = ALL_VERDICTS.find((verdict) => verdict.id === 'v.av_tuning')!
    const scenario = SCENARIOS.find((entry) => entry.id === 'bloat-and-vacuum')!
    const scenarioCopy = scenario.beats.map((beat) => beat[2]).join('\n')
    const copy = `${bodies}\n${tuning.mechanism}\n${scenarioCopy}`

    expect(copy).toContain('pg_class.reltuples')
    expect(copy).toContain('autovacuum_vacuum_max_threshold')
    expect(copy).toContain('100 million')
    expect(copy).not.toMatch(/scale_factor × (?:n_live_tup|its live row count)/i)
  })

  it('distinguishes checkpoint timer expiries from completed checkpoints', () => {
    const checkpoint = DOCS_STORAGE.find((doc) => doc.id === 'checkpointer')!
    const stall = ALL_STEPS.find((step) => step.id === 'stall.1')!
    const copy = `${checkpoint.sections.map((section) => section.body).join('\n')}\n${stall.look}`

    expect(copy).toContain('timer expiry')
    expect(copy).toContain('num_done')
    expect(copy).toContain('skip')
    expect(copy).not.toContain('num_timed` counts timer checkpoints')
  })

  it('never converts the pg_stat_wal FPI count into a byte share', () => {
    const wal = ALL_STEPS.find((step) => step.id === 'stall.2')!
    const storm = ALL_VERDICTS.find((verdict) => verdict.id === 'v.ckpt_storm')!
    const copy = `${wal.look} ${wal.note} ${storm.because} ${storm.mechanism}`

    expect(copy).toContain('cannot be converted')
    expect(copy).toContain('wal_compression')
    expect(storm.evidence({} as never, {
      total: { ckptTimed: 0, ckptRequested: 0, walFpi: 12 },
      rate: { walFpi: 3, walBytes: 4096 },
    } as never).map((item) => item.label)).not.toContain('full-page images')
  })

  it('keeps aggregate and per-backend I/O attribution distinct', () => {
    const io = ALL_STEPS.find((step) => step.id === 'io.1')!
    const verdict = ALL_VERDICTS.find((entry) => entry.id === 'v.backend_writes')!
    const catalog = CATALOG.find((entry) => entry.id === 'pg_stat_io')!

    expect(`${io.why} ${io.look} ${io.note}`).toContain('backend type')
    expect(io.note).toContain('pg_stat_get_backend_io(pid)')
    expect(io.look).not.toContain('only writes a page when')
    expect(verdict.because).not.toContain('exactly one situation')
    expect(catalog.what).not.toMatch(/names the process/i)
  })

  it('limits pg_blocking_pids calls to lock waiters', () => {
    const locks = ALL_STEPS.find((step) => step.id === 'lock.1')!
    const verdict = ALL_VERDICTS.find((entry) => entry.id === 'v.lock_holder')!
    const noLocks = ALL_VERDICTS.find((entry) => entry.id === 'v.no_locks')!

    expect(verdict.confirm?.sql).toBe(locks.sql)
    expect(locks.sql.match(/pg_blocking_pids\(/g)).toHaveLength(1)
    expect(locks.sql).toContain('WITH waiters AS')
    expect(locks.sql).toContain('WHERE NOT l.granted')
    expect(locks.note).toMatch(/exclusive access.*lock-manager.*only.*waiter/is)
    expect(noLocks.because).toContain('ungranted')
    expect(noLocks.because).not.toContain('every session')
  })

  it('treats background-writer cleaning as a sampled rate, not a liveness check', () => {
    const baseline = ALL_STEPS.find((step) => step.id === 'normal.3')!

    expect(baseline.sql).toContain('maxwritten_clean')
    expect(baseline.sql).toMatch(/client backend[\s\S]*checkpointer/)
    expect(baseline.look).toMatch(/buffers_clean.*rate/is)
    expect(baseline.look).toMatch(/zero.*nothing needed cleaning/is)
    expect(baseline.look).not.toMatch(/buffers_clean should be non-zero/i)
  })

  it('separates PostgreSQL 15 shared-memory statistics from restart persistence', () => {
    const baseline = ALL_STEPS.find((step) => step.id === 'normal.1')!

    expect(baseline.note).toMatch(/PostgreSQL 15.*shared memory/is)
    expect(baseline.note).toMatch(/PostgreSQL 13.*clean.*restart/is)
    expect(baseline.note).toMatch(/immediate shutdown|crash/i)
    expect(baseline.note).not.toMatch(/15[\s\S]*why a restart no longer resets/i)
  })

  it('keeps PostgreSQL 18 SQL and registers executable PostgreSQL 17 forms', () => {
    const stall = ALL_STEPS.find((step) => step.id === 'stall.1')!
    const io = ALL_STEPS.find((step) => step.id === 'io.1')!
    const baseline = ALL_STEPS.find((step) => step.id === 'normal.3')!
    const checkpointConfirms = ALL_VERDICTS
      .filter((verdict) => ['v.ckpt_storm', 'v.wal_volume'].includes(verdict.id))
      .map((verdict) => verdict.confirm!)

    for (const query of [stall, baseline, ...checkpointConfirms]) {
      expect(query.sql).toContain('num_done')
      expect(query.sqlCompatibility).toMatchObject({ from: 18 })
      expect(query.sqlCompatibility?.alternatives).toContainEqual(
        expect.objectContaining({ from: 17, to: 17 }),
      )
      expect(query.sqlCompatibility?.alternatives[0].sql).not.toContain('num_done')
      expect(query.sqlCompatibility?.note).toMatch(/PostgreSQL 18.*PostgreSQL 17/is)
    }

    expect(io.sql).toContain('read_bytes')
    expect(io.sql).toContain('write_bytes')
    expect(io.sqlCompatibility).toMatchObject({ from: 18 })
    expect(io.sqlCompatibility?.alternatives[0].sql).toContain('reads * op_bytes AS read_bytes')
    expect(io.sqlCompatibility?.alternatives[0].sql).toContain('writes * op_bytes AS write_bytes')
    expect(io.sqlCompatibility?.note).toMatch(/PostgreSQL 18.*PostgreSQL 17/is)
  })

  it('shows waited locks separately from blocker activity', () => {
    const locks = ALL_STEPS.find((step) => step.id === 'lock.1')!

    expect(locks.sql).toContain('waited_mode')
    expect(locks.sql).toContain('blocker_query')
    expect(locks.sql).not.toContain('OR l.pid IN')
    expect(locks.look).toContain('does not claim which of the blocker’s locks conflicts')
  })

  it('does not infer pool size from a usage-count histogram', () => {
    const cache = ALL_STEPS.find((step) => step.id === 'io.2')!
    const churn = ALL_VERDICTS.find((verdict) => verdict.id === 'v.small_pool')!

    expect(cache.look).toContain('cannot distinguish')
    expect(cache.note).toContain('do not acquire buffer-manager locks')
    expect(churn.title).not.toContain('too small')
    expect(churn.fix).toContain('one-pass')
  })

  it('checks every documented xmin-horizon source before tuning vacuum', () => {
    const horizon = ALL_STEPS.find((step) => step.id === 'bloat.2')!

    expect(horizon.sql).toContain('backend_xid IS NOT NULL')
    expect(horizon.sql).toContain('pg_prepared_xacts')
    expect(horizon.sql).toContain('pg_replication_slots')
    expect(horizon.sql).toContain('pg_stat_replication')
    expect(horizon.look).not.toContain('**is** the horizon')
    expect(horizon.note).toContain('READ COMMITTED')
  })

  it('separates raw parsing from analysis locks and avoids planner-cost recipes', () => {
    const parser = DOCS_MEMORY.find((doc) => doc.id === 'planner.parser')!
    const planner = DOCS_MEMORY.find((doc) => doc.id === 'planner.planner')!
    const planTree = DOCS_MEMORY.find((doc) => doc.id === 'planner.plantree')!
    const parserCopy = parser.sections.map((section) => section.body).join('\n')
    const plannerCopy = planner.sections.map((section) => section.body).join('\n')
    const planTreeCopy = planTree.sections.map((section) => section.body).join('\n')

    expect(parserCopy).toContain('Raw parsing alone')
    expect(parserCopy).not.toContain('merely *parsed*')
    expect(plannerCopy).toContain('cache assumptions')
    expect(plannerCopy).toContain('representative workload')
    expect(plannerCopy).not.toMatch(/spinning disk|single most valuable|1\.1 and 2\.0/i)
    expect(planTreeCopy).toContain('cannot safely isolate')
    expect(planTreeCopy).not.toContain('subtract to see what a node cost')
  })

  it('does not repeat the planner-cost recipe on the storage surface', () => {
    const storage = DOCS_STORAGE.find((doc) => doc.id === 'disk.array')!
    const copy = storage.sections.map((section) => section.body).join('\n')

    expect(copy).toContain('workload and cache residency')
    expect(copy).not.toMatch(/calibrated for spinning disks|something like 1\.1/i)
  })
})
