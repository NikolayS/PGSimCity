import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { N_TABLES } from '../core/catalog'
import { createSim, DR_ARCHIVE_SEGMENT_SECONDS } from './model'

type Sim = ReturnType<typeof createSim>

function advance(sim: Sim, seconds: number): void {
  const end = sim.state.t + seconds
  while (sim.state.t < end) sim.update(1 / 15)
}

function advanceUntil(sim: Sim, done: () => boolean, limit = 240): void {
  const end = sim.state.t + limit
  while (!done() && sim.state.t < end) sim.update(1 / 15)
  expect(done(), `condition was not reached within ${limit}s`).toBe(true)
}

function takeBackup(sim: Sim): void {
  expect(sim.startBaseBackup()).toBe(true)
  expect(sim.state.disasterRecovery.backup.status).toBe('copying')
  advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'idle')
}

function setRestoreDrillFault(
  sim: Sim,
  fault: 'none' | 'empty_other_table' | 'corrupt_object',
): void {
  sim.setKnob('restoreDrillFault', fault)
}

describe('disaster recovery', () => {
  it('makes the first real 16 MiB segment close and archive at shipped defaults during a visit', { timeout: 15_000 }, () => {
    const sim = createSim(createBus())
    const startedAt = sim.state.t

    expect(sim.state.wal.segmentSize).toBe(16 * 1024 * 1024)
    advanceUntil(sim, () => sim.state.wal.archived > 0, 6000)

    const wait = sim.state.t - startedAt
    expect(wait, `first wal-push took ${wait.toFixed(2)} simulated seconds`).toBeLessThan(60)
  })

  it('schedules one daily teaching backup from standby_a without a button press', () => {
    const sim = createSim(createBus())
    const schedule = sim.state.disasterRecovery.backupSchedule

    expect(schedule.intervalSec).toBe(60)
    expect(schedule.nextStartAt).toBeGreaterThan(sim.state.t)
    advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'copying', 60)

    expect(sim.state.disasterRecovery.backup.trigger).toBe('schedule')
    expect(sim.state.replication.standbys[0].applicationName).toBe('standby_a')
    advanceUntil(sim, () => sim.state.disasterRecovery.backups.length === 1, 60)
    expect(sim.state.disasterRecovery.backups[0].source).toBe('standby_a')
  })

  it('applies count retention as scheduled daily backups keep arriving', () => {
    const sim = createSim(createBus())
    sim.setKnob('backupRetention', 2)

    advanceUntil(sim, () => sim.state.disasterRecovery.expiredBackups === 1, 240)

    expect(sim.state.disasterRecovery.backups).toHaveLength(2)
    expect(sim.state.disasterRecovery.backups.every((backup) => backup.trigger === 'schedule')).toBe(true)
    expect(sim.state.disasterRecovery.oldestRecoverableTime)
      .toBe(sim.state.disasterRecovery.backups[0].completedAt)
    expect(sim.state.t - sim.state.disasterRecovery.backups[1].completedAt).toBeLessThan(2)
  })

  it('models WAL-G writing backups and WAL directly to object storage', () => {
    const sim = createSim(createBus())

    expect(sim.state.disasterRecovery.tool).toBe('WAL-G')
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    expect(backup.tool).toBe('WAL-G')
    expect(backup.label).toMatch(/^base_[0-9A-F]{24}$/)
    expect(backup.objectStoreBytes).toBeGreaterThan(0)
  })

  it('makes a full backup take time proportional to the data directory size', () => {
    const normal = createSim(createBus())
    expect(normal.startBaseBackup()).toBe(true)
    const normalSize = normal.state.disasterRecovery.backup.dataBytes
    const normalDuration = normal.state.disasterRecovery.backup.estimatedDurationSec

    advance(normal, normalDuration / 2)
    expect(normal.state.disasterRecovery.backup.status).toBe('copying')
    expect(normal.state.disasterRecovery.backup.progress).toBeGreaterThan(0.35)
    expect(normal.state.disasterRecovery.backup.progress).toBeLessThan(0.7)

    const larger = createSim(createBus())
    larger.state.tables[0].pages *= 2
    expect(larger.startBaseBackup()).toBe(true)

    expect(larger.state.disasterRecovery.backup.dataBytes).toBeGreaterThan(normalSize)
    expect(larger.state.disasterRecovery.backup.estimatedDurationSec).toBeGreaterThan(normalDuration)
  })

  it('waits for the stop WAL to reach the archive before completing a full backup', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 100)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('walGArchiveCredentialsValid', false)

    expect(sim.startBaseBackup()).toBe(true)
    advance(sim, sim.state.disasterRecovery.backup.estimatedDurationSec + 2)

    expect(sim.state.disasterRecovery.backup.status).toBe('waiting_wal')
    expect(sim.state.disasterRecovery.backup.progress).toBe(1)
    expect(sim.state.disasterRecovery.backups).toHaveLength(0)

    sim.setKnob('walGArchiveCredentialsValid', true)
    advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'idle')
    expect(sim.state.disasterRecovery.backups).toHaveLength(1)
  })

  it('bounds standby_a backup LSNs by its replay position', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    advance(sim, 35)
    sim.setKnob('walGArchiveCredentialsValid', false)
    const replayAtStart = sim.state.replication.standbys[0].appliedLsn

    expect(sim.startBaseBackup()).toBe(true)
    expect(sim.state.disasterRecovery.backup.startLsn).toBe(replayAtStart)
    advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'waiting_wal')

    const operation = sim.state.disasterRecovery.backup
    expect(operation.stopLsn).toBeLessThanOrEqual(
      sim.state.replication.standbys[0].appliedLsn,
    )
    sim.setKnob('walGArchiveCredentialsValid', true)
    advanceUntil(sim, () => operation.status === 'idle')
    expect(sim.state.disasterRecovery.backups[0].stopLsn).toBe(operation.stopLsn)
  })

  it('fails the strongest drill when the requested timeline excludes the backup minimum recovery point', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 30)
    sim.setKnob('standbyBNetworkLag', 400)
    advance(sim, 35)
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]

    expect(sim.startFailover('standbyB')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    const timeline = sim.state.highAvailability.timeline
    expect(backup.stopLsn).toBeGreaterThan(timeline.forkLsn)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.historyFileArchived)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startRestoreDrill('verified', 2)).toBe(true)
    const drill = sim.state.disasterRecovery.drill
    advanceUntil(sim, () => drill.status === 'passed' || drill.status === 'failed')

    expect(drill.status).toBe('failed')
    expect(drill.failureReason).toMatch(
      /requested timeline 2.*does not contain.*minimum recovery point.*timeline 1/i,
    )
  })

  it('queues completed WAL when WAL-G credentials expire, grows pg_wal, and rejects writes at the scaled safety limit', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 5000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('walGArchiveCredentialsValid', false)
    const initialBytes = sim.state.disasterRecovery.archive.pgWalBytes

    advanceUntil(sim, () => sim.state.disasterRecovery.archive.writesBlocked, 360)
    const stalled = sim.state.disasterRecovery.archive
    const stalledQueue = stalled.queueSegments

    expect(stalled.queueSegments).toBeGreaterThan(0)
    expect(stalled.pgWalBytes).toBeGreaterThan(initialBytes)
    expect(stalled.failedAttempts).toBeGreaterThan(0)

    const rejected = stalled.rejectedWrites
    advance(sim, 5)
    expect(sim.state.disasterRecovery.archive.rejectedWrites).toBeGreaterThan(rejected)

    sim.setKnob('walGArchiveCredentialsValid', true)
    advanceUntil(sim, () => !sim.state.disasterRecovery.archive.writesBlocked, 240)
    expect(sim.state.disasterRecovery.archive.queueSegments).toBeLessThan(stalledQueue)
  })

  it('expires full backups and the older WAL recovery window together', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('backupRetention', 2)

    takeBackup(sim)
    advance(sim, 8)
    takeBackup(sim)
    const targetBeforeOldestRetained = sim.state.disasterRecovery.backups[0].completedAt + 1
    advance(sim, 8)
    takeBackup(sim)

    expect(sim.state.disasterRecovery.backups).toHaveLength(2)
    expect(sim.state.disasterRecovery.expiredBackups).toBe(1)
    expect(sim.startPointInTimeRestore(sim.state.t - targetBeforeOldestRetained)).toBe(false)
    expect(sim.state.disasterRecovery.restore.status).toBe('failed')
    expect(sim.state.disasterRecovery.restore.failureReason).toMatch(/retention|oldest retained/i)

    sim.setKnob('backupRetention', 3)
    takeBackup(sim)
    expect(sim.state.disasterRecovery.backups).toHaveLength(3)
    expect(sim.state.disasterRecovery.expiredBackups).toBe(1)
  })

  it('names an expired recovery window in WAL-G delete-retain vocabulary', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('backupRetention', 1)

    takeBackup(sim)
    const expiredTarget = sim.state.disasterRecovery.backups[0].completedAt + 1
    advance(sim, 8)
    takeBackup(sim)

    expect(sim.startPointInTimeRestore(sim.state.t - expiredTarget)).toBe(false)
    expect(sim.state.disasterRecovery.restore.failureReason)
      .toMatch(/wal-g delete retain FULL/i)
  })

  it('derives a longer recovery time from an older backup and more WAL replay', () => {
    function estimateAfter(age: number): { seconds: number; walBytes: number; backupAge: number } {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1600)
      sim.setKnob('writeRatio', 0.85)
      takeBackup(sim)
      advance(sim, age)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startPointInTimeRestore(2)).toBe(true)
      const restore = sim.state.disasterRecovery.restore
      return {
        seconds: restore.estimatedDurationSec,
        walBytes: restore.walBytesRequired,
        backupAge: restore.backupAgeSec,
      }
    }

    const recent = estimateAfter(12)
    const older = estimateAfter(52)

    expect(older.backupAge).toBeGreaterThan(recent.backupAge)
    expect(older.walBytes).toBeGreaterThan(recent.walBytes)
    expect(older.seconds).toBeGreaterThan(recent.seconds)
  })

  it('measures PITR replay WAL from the backup start LSN', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1600)
    sim.setKnob('writeRatio', 0.85)
    takeBackup(sim)
    advance(sim, 24)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startPointInTimeRestore(2)).toBe(true)
    const backup = sim.state.disasterRecovery.backups[0]
    const restore = sim.state.disasterRecovery.restore

    expect(restore.walBytesRequired).toBe(restore.targetLsn - backup.startLsn)
    expect(restore.walBytesRequired).toBeGreaterThan(restore.targetLsn - backup.stopLsn)
  })

  it('makes low WALG_DOWNLOAD_CONCURRENCY object-fetch bound', () => {
    function estimateWithConcurrency(concurrency: number): { seconds: number; walBytes: number; replayed: number } {
      const sim = createSim(createBus())
      sim.setKnob('tps', 1600)
      sim.setKnob('writeRatio', 0.85)
      takeBackup(sim)
      advance(sim, 24)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      sim.setKnob('walGDownloadConcurrency', concurrency)
      expect(sim.startPointInTimeRestore(2)).toBe(true)
      advance(sim, 1)
      return {
        seconds: sim.state.disasterRecovery.restore.estimatedDurationSec,
        walBytes: sim.state.disasterRecovery.restore.walBytesRequired,
        replayed: sim.state.disasterRecovery.restore.backupBytesFetched,
      }
    }

    const serial = estimateWithConcurrency(1)
    const concurrent = estimateWithConcurrency(10)

    expect(serial.walBytes).toBe(concurrent.walBytes)
    expect(serial.seconds).toBeGreaterThan(concurrent.seconds)
    expect(serial.replayed).toBeLessThan(concurrent.replayed)
  })

  it('stops PITR at the selected target without promotion or failover state', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.7)
    takeBackup(sim)
    advance(sim, 20)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startPointInTimeRestore(2)).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.restore.status === 'complete')

    expect(sim.state.disasterRecovery.restore.progress).toBe(1)
    expect(sim.state.disasterRecovery.restore.promoted).toBe(false)
    expect(sim.state.disasterRecovery.restore.failureReason).toBe('')
  })

  it('moves recovery_target_time in the right direction and returns to its default', () => {
    const sim = createSim(createBus())
    sim.setKnob('tps', 1600)
    sim.setKnob('writeRatio', 0.85)
    takeBackup(sim)
    advance(sim, 60)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    sim.setKnob('recoveryTargetAge', 2)
    expect(sim.startPointInTimeRestore()).toBe(true)
    const recentWal = sim.state.disasterRecovery.restore.walBytesRequired
    const recentDuration = sim.state.disasterRecovery.restore.estimatedDurationSec

    sim.setKnob('recoveryTargetAge', 40)
    expect(sim.startPointInTimeRestore()).toBe(true)
    expect(sim.state.disasterRecovery.restore.walBytesRequired).toBeLessThan(recentWal)
    expect(sim.state.disasterRecovery.restore.estimatedDurationSec).toBeLessThan(recentDuration)

    sim.setKnob('recoveryTargetAge', 20)
    expect(sim.state.knobs.recoveryTargetAge).toBe(20)
  })

  it('keeps archiving on the promoted timeline and does not blame its frontier', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn
        >= sim.state.replication.standbys[0].flushedLsn,
      180,
    )

    expect(backup.startTimeline).toBe(1)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    const archivedAtPromotion = sim.state.disasterRecovery.archive.archivedThroughLsn

    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn > archivedAtPromotion,
      180,
    )
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.state.highAvailability.timeline.current).toBe(2)
    expect(sim.state.disasterRecovery.archive.timeline).toBe(2)
    expect(sim.state.disasterRecovery.archive.parentTimeline).toBe(1)
    expect(sim.state.wal.segments.find((segment) => segment.state === 'current')?.name)
      .toMatch(/^00000002/)
    expect(sim.startRestoreDrill('cluster', 2)).toBe(true)
    const drill = sim.state.disasterRecovery.drill
    advanceUntil(sim, () => drill.status === 'passed' || drill.status === 'failed')
    const restore = sim.state.disasterRecovery.restore

    expect(drill.failureReason).not.toMatch(/archive frontier|unarchived tail/i)
    expect(drill.status, drill.failureReason).toBe('passed')
    expect(restore.targetTimeline).toBe(2)
    expect(restore.followedHistoryFile).toBe(true)
    expect(restore.parentReplayEndLsn).toBe(sim.state.highAvailability.timeline.forkLsn)
    expect(sim.state.highAvailability.timeline.oldHistoryEndLsn).toBeGreaterThan(
      sim.state.highAvailability.timeline.forkLsn,
    )
    expect(restore.resultMessage).toMatch(
      /recovery_target_timeline=latest.*00000002\.history.*timeline 1.*timeline 2/i,
    )
  })

  it('does not make WAL missing from a broken archive recoverable at promotion', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    takeBackup(sim)

    sim.setKnob('walGArchiveCredentialsValid', false)
    const archivedBeforeOutage = sim.state.disasterRecovery.archive.archivedThroughLsn
    const archivedAtBeforeOutage = sim.state.disasterRecovery.archive.archivedThroughTime
    advance(sim, 15)
    const impossibleTargetTime = sim.state.t
    advance(sim, 15)
    expect(sim.state.disasterRecovery.archive.queueSegments).toBeGreaterThan(0)

    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )

    const archive = sim.state.disasterRecovery.archive
    expect(archive.parentArchivedThroughLsn).toBe(archivedBeforeOutage)
    expect(archive.parentArchivedThroughTime).toBe(archivedAtBeforeOutage)
    expect(archive.archivedThroughLsn).toBe(sim.state.highAvailability.timeline.forkLsn)
    expect(archive.archivedThroughTime).toBe(archivedAtBeforeOutage)
    const visibleMissingParentSegments = sim.state.wal.segments.filter(
      (segment) => segment.name.startsWith('00000001')
        && (segment.id + 1) * sim.state.wal.segmentSize > archivedBeforeOutage,
    )
    expect(visibleMissingParentSegments.length).toBeGreaterThan(0)
    expect(visibleMissingParentSegments.every((segment) => segment.state !== 'archived'))
      .toBe(true)

    expect(sim.startPointInTimeRestore(sim.state.t - impossibleTargetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    expect(restore.targetLsn).toBeGreaterThan(archivedBeforeOutage)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(/archive fault.*credentials.*timeline 1/i)
    expect(restore.resultMessage).toBe('')
  })

  it('does not stamp a dead timeline-2 archiver fresh at promotion', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('walGArchiveCredentialsValid', false)
    advance(sim, 30)

    expect(sim.state.disasterRecovery.archive.archivedThroughTime).toBe(0)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )

    expect(sim.state.disasterRecovery.archive.timeline).toBe(2)
    expect(sim.state.disasterRecovery.archive.archivedThroughLsn)
      .toBe(sim.state.highAvailability.timeline.forkLsn)
    expect(sim.state.disasterRecovery.archive.archivedThroughTime).toBe(0)
    expect(sim.state.disasterRecovery.archive.failedAttempts).toBeGreaterThan(0)
  })

  it('keeps a healthy parent shortfall visible after promotion', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    takeBackup(sim)
    advance(sim, 30)
    const parentFrontier = sim.state.disasterRecovery.archive.archivedThroughLsn
    const targetTime = sim.state.t - 2

    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    const forkLsn = sim.state.highAvailability.timeline.forkLsn
    expect(parentFrontier).toBeLessThan(forkLsn)
    expect(sim.state.disasterRecovery.archive.parentArchivedThroughLsn).toBe(parentFrontier)

    expect(sim.startPointInTimeRestore(sim.state.t - targetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    expect(restore.targetLsn).toBeGreaterThan(parentFrontier)
    expect(restore.targetLsn).toBeLessThanOrEqual(forkLsn)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(
      /archive gap.*timeline 1.*archive_mode=on.*archive_timeout.*cannot repair/i,
    )
    expect(restore.failureReason).not.toMatch(/healthy unarchived tail|\.ready queue/i)
  })

  it('reaches a divergent-tail time only through an archived timeline-2 crossing record', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn
        >= sim.state.replication.standbys[0].flushedLsn,
      180,
    )

    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    const timeline = sim.state.highAvailability.timeline
    expect(sim.state.highAvailability.transition.lossBytes).toBeGreaterThan(0)
    expect(sim.state.highAvailability.transition.lossTransactions).toBeGreaterThan(0)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.historyFileArchived)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn > timeline.forkLsn,
      180,
    )
    const targetTime = timeline.forkedAt - 1

    expect(sim.startRestoreDrill('cluster', sim.state.t - targetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    const drill = sim.state.disasterRecovery.drill
    expect(restore.targetRecordLsn).toBeGreaterThan(timeline.forkLsn)
    expect(restore.targetTime).toBeLessThanOrEqual(timeline.forkedAt)
    expect(restore.targetTimeline).toBe(2)
    expect(restore.crossesTimelineFork).toBe(true)
    expect(restore.parentReplayEndLsn).toBe(timeline.forkLsn)
    expect(restore.walBytesRequired).toBe(restore.targetRecordLsn - backup.startLsn)
    advanceUntil(sim, () => drill.status === 'passed' || drill.status === 'failed')

    expect(drill.status, drill.failureReason).toBe('passed')
    expect(restore.resultMessage).toMatch(/transaction-end record.*crossed recovery_target_time/i)
  })

  it('replays an archived divergent parent tail with recovery_target_timeline=current', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn
        > sim.state.replication.standbys[0].flushedLsn
        && sim.state.disasterRecovery.archive.archivedThroughTime > backup.completedAt,
      180,
    )
    const targetTime = sim.state.disasterRecovery.archive.archivedThroughTime - 0.5
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    const timeline = sim.state.highAvailability.timeline
    const archive = sim.state.disasterRecovery.archive
    expect(archive.parentArchivedThroughLsn).toBeGreaterThan(timeline.forkLsn)
    sim.setKnob('recoveryTargetTimeline', 'current')

    const started = sim.startPointInTimeRestore(sim.state.t - targetTime)
    const restore = sim.state.disasterRecovery.restore
    expect(started, restore.failureReason).toBe(true)
    expect(restore.status).toBe('fetching')
    expect(restore.targetLsn).toBeGreaterThan(timeline.forkLsn)
    expect(restore.targetTimeline).toBe(1)
    expect(restore.crossesTimelineFork).toBe(false)
    expect(restore.followedHistoryFile).toBe(false)
    expect(restore.failureReason).toBe('')
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('complete')
    expect(restore.walBytesReplayed).toBe(restore.walBytesRequired)
    expect(restore.resultMessage).toMatch(
      /complete on timeline 1.*recovery_target_timeline=current.*transaction-end record.*crossed recovery_target_time/i,
    )
  })

  it('replays the parent archive before current reports that no record crossed the target', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    takeBackup(sim)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    const archivedAtPromotion = sim.state.disasterRecovery.archive.archivedThroughLsn
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn > archivedAtPromotion,
      180,
    )
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )
    sim.setKnob('recoveryTargetTimeline', 'current')

    expect(sim.startPointInTimeRestore(2)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    const backup = sim.state.disasterRecovery.backups[0]
    const parentFrontier = sim.state.disasterRecovery.archive.parentArchivedThroughLsn
    expect(restore.status).toBe('fetching')
    expect(restore.targetTimeline).toBe(1)
    expect(restore.crossesTimelineFork).toBe(false)
    expect(restore.followedHistoryFile).toBe(false)
    expect(restore.failureReason).toBe('')
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('failed')
    expect(restore.walBytesReplayed).toBe(Math.max(0, parentFrontier - backup.startLsn))
    expect(restore.failureReason).toMatch(
      /recovery ended before configured recovery target was reached.*last transaction-end/i,
    )
    expect(restore.failureReason).not.toMatch(/timeline mismatch|before fetching/i)
  })

  it('gives four distinct current-timeline messages for four archive states', () => {
    function failureFor(
      prepare: (sim: Sim) => number | void,
    ): string {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1_200)
      sim.setKnob('writeRatio', 1)
      takeBackup(sim)
      sim.setKnob('recoveryTargetTimeline', 'current')
      const targetAge = prepare(sim) ?? 0

      expect(sim.startPointInTimeRestore(targetAge)).toBe(true)
      const restore = sim.state.disasterRecovery.restore
      advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')
      expect(restore.status).toBe('failed')
      return restore.failureReason
    }

    const messages = {
      credentials: failureFor((sim) => {
        sim.setKnob('walGArchiveCredentialsValid', false)
        advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments > 0, 120)
      }),
      minimal: failureFor((sim) => {
        const targetTime = sim.state.t
        advance(sim, 2)
        sim.setKnob('walLevel', 'minimal')
        advance(sim, 3)
        return sim.state.t - targetTime
      }),
      queue: failureFor((sim) => {
        sim.setKnob('tps', 6_000)
        advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments > 0, 120)
      }),
      healthyTail: failureFor((sim) => {
        advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments === 0)
        advance(sim, 3)
      }),
    }

    expect(new Set(Object.values(messages)).size).toBe(4)
    expect(messages.credentials).toMatch(/credentials.*invalid/i)
    expect(messages.minimal).toMatch(/wal_level=minimal/i)
    expect(messages.queue).toMatch(/\.ready queue drain|processes completed segments/i)
    expect(messages.healthyTail).toMatch(/healthy unarchived tail.*RPO floor/i)
  })

  it('does not cross the fork when latest cannot find the history file in the archive', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 2_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    takeBackup(sim)
    sim.setKnob('walGArchiveCredentialsValid', false)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.highAvailability.transition.status === 'complete',
    )
    advance(sim, 1)

    expect(sim.state.disasterRecovery.archive.historyFileArchived).toBe(false)
    expect(sim.startPointInTimeRestore(0)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    expect(restore.targetTimeline).toBe(1)
    expect(restore.crossesTimelineFork).toBe(false)
    expect(restore.followedHistoryFile).toBe(false)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')
    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(/recovery ended before configured recovery target/i)
  })

  it('earns a failed restore-drill verdict from a stalled WAL archive', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1600)
    sim.setKnob('writeRatio', 0.85)
    takeBackup(sim)
    advance(sim, 12)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    sim.setKnob('walGArchiveCredentialsValid', false)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments > 0, 120)

    expect(sim.startRestoreDrill('cluster', 0)).toBe(true)
    const drill = sim.state.disasterRecovery.drill
    advanceUntil(sim, () => drill.status === 'failed')

    expect(drill.failureReason).toMatch(/archive fault.*wal-g wal-push.*\.ready/i)
    expect(drill.failureReason).not.toMatch(/archive_timeout|padded/i)
    expect(drill.backupId).toBeGreaterThanOrEqual(0)
    expect(drill.walBytesRequired).toBeGreaterThan(0)
    expect(drill.elapsedSec).toBeGreaterThan(0)
    expect(drill.objectStoreBytesRead).toBeGreaterThanOrEqual(
      sim.state.disasterRecovery.backups[0].objectStoreBytes,
    )
  })

  it('B1 teaches the healthy unarchived tail without prescribing an archive repair', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 1)
    takeBackup(sim)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments === 0)
    advance(sim, 3)

    const archive = sim.state.disasterRecovery.archive
    expect(archive.queueSegments).toBe(0)
    expect(sim.state.knobs.walGArchiveCredentialsValid).toBe(true)
    expect(archive.failedAttempts).toBe(0)
    expect(sim.startRestoreDrill('cluster', 0)).toBe(true)
    const drill = sim.state.disasterRecovery.drill
    advanceUntil(sim, () => drill.status === 'failed')

    expect(drill.failureReason).toMatch(/unarchived tail.*RPO floor.*archive_timeout.*padded/i)
    expect(drill.failureReason).not.toMatch(/repair|invalid|drain/i)
    expect(drill.elapsedSec).toBeGreaterThan(0)
    expect(drill.objectStoreBytesRead).toBeGreaterThanOrEqual(
      sim.state.disasterRecovery.backups[0].objectStoreBytes,
    )
  })

  it('B1 does not blame retention when no older backup ever existed', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]

    expect(sim.state.disasterRecovery.expiredBackups).toBe(0)
    expect(sim.state.knobs.backupRetention).toBe(3)
    expect(sim.startRestoreDrill('cluster', sim.state.t - backup.completedAt + 1)).toBe(false)
    expect(sim.state.disasterRecovery.drill.failureReason)
      .toMatch(/no (?:retained )?full backup was taken early enough/i)
    expect(sim.state.disasterRecovery.drill.failureReason)
      .not.toMatch(/increase.*retain|window expires/i)
  })

  it('earns a failed restore-drill verdict from the retained backup inventory', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.8)
    sim.setKnob('backupRetention', 1)

    takeBackup(sim)
    const expiredTarget = sim.state.disasterRecovery.backups[0].completedAt + 1
    advance(sim, 8)
    takeBackup(sim)

    expect(sim.startRestoreDrill('cluster', sim.state.t - expiredTarget)).toBe(false)
    expect(sim.state.disasterRecovery.drill.status).toBe('failed')
    expect(sim.state.disasterRecovery.drill.failureReason).toMatch(/retention|oldest retained/i)
    expect(sim.state.disasterRecovery.drill.backupId).toBe(-1)
  })

  it('makes a passing drill occupy time and charge the bytes it actually reads', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.75)
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startRestoreDrill('verified', 2)).toBe(true)
    const drill = sim.state.disasterRecovery.drill
    expect(drill.status).toBe('restoring')
    expect(drill.estimatedRestoreToTargetSec).toBeGreaterThan(0)
    expect(drill.estimatedDurationSec).toBeGreaterThan(drill.estimatedRestoreToTargetSec)

    advance(sim, drill.estimatedRestoreToTargetSec / 2)
    expect(drill.status).not.toBe('passed')
    expect(drill.objectStoreBytesRead).toBeGreaterThan(0)

    advanceUntil(sim, () => drill.status === 'passed')
    const selected = sim.state.disasterRecovery.backups.find(
      (backup) => backup.id === drill.backupId,
    )
    expect(selected).toBeDefined()
    expect(drill.measuredRestoreToTargetSec).toBeGreaterThan(0)
    expect(drill.elapsedSec).toBeGreaterThan(drill.measuredRestoreToTargetSec)
    expect(drill.objectStoreBytesRead).toBe(
      selected!.objectStoreBytes + sim.state.disasterRecovery.restore.walBytesRequired,
    )
    expect(drill.validationBytesRead).toBeGreaterThan(0)
    expect(drill.failureReason).toBe('')
  })

  it('derives restore-to-target time from the newest usable backup age and replay volume', () => {
    function estimateAfter(age: number): {
      backupAge: number
      rto: number
      walBytes: number
    } {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1600)
      sim.setKnob('writeRatio', 0.85)
      takeBackup(sim)
      advance(sim, age)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startRestoreDrill('cluster', 2)).toBe(true)
      const drill = sim.state.disasterRecovery.drill
      return {
        backupAge: drill.backupAgeSec,
        rto: drill.estimatedRestoreToTargetSec,
        walBytes: drill.walBytesRequired,
      }
    }

    const fresh = estimateAfter(12)
    const old = estimateAfter(52)

    expect(old.backupAge).toBeGreaterThan(fresh.backupAge)
    expect(old.walBytes).toBeGreaterThan(fresh.walBytes)
    expect(old.rto).toBeGreaterThan(fresh.rto)
  })

  it('charges broader and stronger drill levels for strictly more validation work', () => {
    function estimate(level: 'table' | 'cluster' | 'verified'): {
      evidenceRank: number
      duration: number
      validationBytes: number
    } {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1200)
      sim.setKnob('writeRatio', 0.75)
      takeBackup(sim)
      advance(sim, 18)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startRestoreDrill(level, 2)).toBe(true)
      const drill = sim.state.disasterRecovery.drill
      return {
        evidenceRank: drill.evidenceRank,
        duration: drill.estimatedDurationSec,
        validationBytes: drill.validationBytesRequired,
      }
    }

    const table = estimate('table')
    const cluster = estimate('cluster')
    const verified = estimate('verified')

    expect(table.evidenceRank).toBeLessThan(cluster.evidenceRank)
    expect(cluster.evidenceRank).toBeLessThan(verified.evidenceRank)
    expect(table.validationBytes).toBeLessThan(cluster.validationBytes)
    expect(cluster.validationBytes).toBeLessThan(verified.validationBytes)
    expect(table.duration).toBeLessThan(cluster.duration)
    expect(cluster.duration).toBeLessThan(verified.duration)
  })

  it('B3 lets full-cluster smoke reject an empty restored table that one-table smoke misses', () => {
    function run(level: 'table' | 'cluster'): { status: string; reason: string } {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1200)
      sim.setKnob('writeRatio', 0.75)
      setRestoreDrillFault(sim, 'empty_other_table')
      takeBackup(sim)
      advance(sim, 18)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startRestoreDrill(level, 2)).toBe(true)
      const drill = sim.state.disasterRecovery.drill
      advanceUntil(sim, () => drill.status === 'passed' || drill.status === 'failed')
      return { status: drill.status, reason: drill.failureReason }
    }

    expect(run('table')).toEqual({ status: 'passed', reason: '' })
    expect(run('cluster')).toEqual({
      status: 'failed',
      reason: 'the restored orders table is empty; its smoke query found no row witness',
    })
  })

  it('B3 lets manifest verification reject corruption that full-cluster smoke misses', () => {
    function run(level: 'cluster' | 'verified'): { status: string; reason: string } {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1200)
      sim.setKnob('writeRatio', 0.75)
      setRestoreDrillFault(sim, 'corrupt_object')
      takeBackup(sim)
      advance(sim, 18)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startRestoreDrill(level, 2)).toBe(true)
      const drill = sim.state.disasterRecovery.drill
      advanceUntil(sim, () => drill.status === 'passed' || drill.status === 'failed')
      return { status: drill.status, reason: drill.failureReason }
    }

    expect(run('cluster')).toEqual({ status: 'passed', reason: '' })
    expect(run('verified')).toEqual({
      status: 'failed',
      reason: 'the restored object digest does not match the backup manifest',
    })
  })

  it('B5 prices a smoke witness as a targeted three-block read per checked table', () => {
    function smokeBytes(level: 'table' | 'cluster'): number {
      const sim = createSim(createBus(), { scheduledBackups: false })
      sim.setKnob('tps', 1200)
      sim.setKnob('writeRatio', 0.75)
      takeBackup(sim)
      advance(sim, 18)
      advanceUntil(
        sim,
        () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
        180,
      )
      expect(sim.startRestoreDrill(level, 2)).toBe(true)
      return sim.state.disasterRecovery.drill.smokeBytesRequired
    }

    expect(smokeBytes('table')).toBe(3 * 8192)
    expect(smokeBytes('cluster')).toBe(3 * 8192 * N_TABLES)
  })

  it('fails the strongest drill when retained object bytes disagree with its manifest', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.75)
    setRestoreDrillFault(sim, 'corrupt_object')
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startRestoreDrill('verified', 2)).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.drill.status === 'failed')

    expect(sim.state.disasterRecovery.drill.failureReason).toMatch(/digest.*manifest/i)
    expect(sim.state.disasterRecovery.drill.measuredRestoreToTargetSec).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.drill.checksumBytesRead).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.drill.smokeBytesRead).toBe(0)
  })

  it('fails when retention removes the selected backup before backup-fetch finishes', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.75)
    sim.setKnob('backupRetention', 1)
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )
    sim.setKnob('walGDownloadConcurrency', 1)
    expect(sim.startRestoreDrill('cluster', 2)).toBe(true)
    const selected = sim.state.disasterRecovery.drill.backupId

    expect(sim.startBaseBackup()).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.backups[0]?.id !== selected, 120)
    advanceUntil(sim, () => sim.state.disasterRecovery.drill.status === 'failed', 5)

    expect(sim.state.disasterRecovery.drill.failureReason)
      .toMatch(/retention.*before the restore reached its target/i)
    expect(sim.state.disasterRecovery.drill.objectStoreBytesRead).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.drill.measuredRestoreToTargetSec).toBe(0)
  })

  it('fails plain PITR when retention removes its backup during backup-fetch', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1_200)
    sim.setKnob('writeRatio', 0.75)
    sim.setKnob('backupRetention', 1)
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )
    sim.setKnob('walGDownloadConcurrency', 1)
    expect(sim.startPointInTimeRestore(2)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    const selected = restore.backupId

    expect(sim.startBaseBackup()).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.backups[0]?.id !== selected, 120)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed', 120)

    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(
      /selected full backup.*retention.*before the restore reached its target/i,
    )
    expect(restore.resultMessage).toBe('')
  })

  it('attributes an interrupted standby backup to promotion at pg_backup_stop', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    advance(sim, 35)

    expect(sim.startBaseBackup()).toBe(true)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.backup.status === 'failed')

    expect(sim.state.cluster.nodes[1].online).toBe(true)
    expect(sim.state.disasterRecovery.backup.failureReason).toMatch(
      /standby_a.*promoted.*pg_backup_stop/i,
    )
    expect(sim.state.disasterRecovery.backup.failureReason).not.toMatch(/disconnected/i)
  })

  it('detects retention expiry while WAL replay is in progress', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1600)
    sim.setKnob('writeRatio', 0.85)
    sim.setKnob('backupRetention', 1)
    takeBackup(sim)
    advance(sim, 52)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )
    expect(sim.startBaseBackup()).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.backup.progress >= 0.35)
    expect(sim.startRestoreDrill('cluster', 2)).toBe(true)
    const selected = sim.state.disasterRecovery.drill.backupId
    advanceUntil(sim, () => sim.state.disasterRecovery.restore.status === 'replaying')

    expect(sim.state.disasterRecovery.backups[0]?.id).toBe(selected)
    advanceUntil(sim, () => sim.state.disasterRecovery.backups[0]?.id !== selected, 120)
    advanceUntil(sim, () => sim.state.disasterRecovery.drill.status === 'failed', 5)

    expect(sim.state.disasterRecovery.drill.failureReason)
      .toMatch(/retention.*before the restore reached its target/i)
  })

  it('uses the selected target for the single displayed backup age', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.75)
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startRestoreDrill('table', 2)).toBe(true)
    expect(sim.state.disasterRecovery.drill.backupAgeSec)
      .toBe(sim.state.disasterRecovery.restore.backupAgeSec)
  })

  it('keeps the recovery host occupied until drill validation finishes', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1200)
    sim.setKnob('writeRatio', 0.75)
    takeBackup(sim)
    advance(sim, 18)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    expect(sim.startRestoreDrill('verified', 2)).toBe(true)
    advanceUntil(sim, () => sim.state.disasterRecovery.drill.status === 'verifying')

    expect(sim.startPointInTimeRestore(2)).toBe(false)
    expect(sim.state.disasterRecovery.drill.status).toBe('verifying')
    expect(sim.state.disasterRecovery.restore.status).toBe('complete')
  })

  it('does not call a latest target reached without a crossing record on timeline 2', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    takeBackup(sim)
    advance(sim, 20)

    sim.setKnob('tps', 0)
    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.historyFileArchived)
    const fork = sim.state.highAvailability.timeline.forkLsn

    expect(sim.state.disasterRecovery.archive.archivedThroughLsn - fork).toBe(0)
    expect(sim.startRestoreDrill('cluster', 2)).toBe(true)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.drill.status === 'passed'
        || sim.state.disasterRecovery.drill.status === 'failed',
    )

    expect(sim.state.disasterRecovery.drill.status).toBe('failed')
    expect(sim.state.disasterRecovery.drill.failureReason).toMatch(
      /recovery ended before configured recovery target was reached.*transaction-end/i,
    )
  })

  it('does not infer a time target from an unchanged archived LSN', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 1_200)
    sim.setKnob('writeRatio', 1)
    advance(sim, 12)
    sim.setKnob('tps', 0)
    advance(sim, 3)
    takeBackup(sim)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments === 0)
    const lastArchivedLsn = sim.state.disasterRecovery.archive.archivedThroughLsn
    const lastArchivedTime = sim.state.disasterRecovery.archive.archivedThroughTime
    advance(sim, 12)

    expect(sim.state.disasterRecovery.archive.archivedThroughLsn).toBe(lastArchivedLsn)
    expect(sim.state.disasterRecovery.archive.archivedThroughTime).toBe(lastArchivedTime)
    expect(sim.startPointInTimeRestore(0)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(
      /recovery ended before configured recovery target was reached.*last transaction-end.*s/i,
    )
    expect(restore.failureReason).toContain(restore.targetTime.toFixed(1))
  })

  it('uses the archive frontier reached during backup-fetch', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    takeBackup(sim)
    sim.setKnob('walGArchiveCredentialsValid', false)
    advance(sim, 12)
    const targetTime = sim.state.t - 2
    advance(sim, 3)
    sim.setKnob('walGArchiveCredentialsValid', true)
    sim.setKnob('walGDownloadConcurrency', 1)

    expect(sim.startPointInTimeRestore(sim.state.t - targetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    const frontierAtStart = sim.state.disasterRecovery.archive.archivedThroughLsn
    expect(restore.targetLsn).toBeGreaterThan(frontierAtStart)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn >= restore.targetLsn,
      180,
    )
    expect(restore.status).toBe('fetching')
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status, restore.failureReason).toBe('complete')
  })

  it('drops a stale credentials failure when wal-push is repaired during backup-fetch', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    takeBackup(sim)
    sim.setKnob('walGArchiveCredentialsValid', false)
    advance(sim, 12)
    const targetTime = sim.state.t - 2
    advance(sim, 3)
    sim.setKnob('walGDownloadConcurrency', 1)

    expect(sim.startPointInTimeRestore(sim.state.t - targetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    expect(restore.status).toBe('fetching')
    expect(sim.state.disasterRecovery.archive.archivedThroughLsn).toBeLessThan(
      restore.targetLsn,
    )
    advance(sim, 1)
    sim.setKnob('walGArchiveCredentialsValid', true)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn >= restore.targetLsn,
      180,
    )
    expect(restore.status).toBe('fetching')
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status, restore.failureReason).toBe('complete')
    expect(restore.failureReason).not.toMatch(/credentials/i)
  })

  it('attributes a restore that loses its live archive supply during backup-fetch', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    takeBackup(sim)
    sim.setKnob('walGDownloadConcurrency', 1)

    expect(sim.startPointInTimeRestore(0)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    advance(sim, 1)
    sim.setKnob('walGArchiveCredentialsValid', false)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status).toBe('failed')
    expect(restore.failureReason).toMatch(/credentials.*invalid/i)
    expect(restore.failureReason).not.toMatch(/healthy unarchived tail/i)
  })

  it('freezes the parent archive frontier as soon as the primary is declared gone', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('walGArchiveCredentialsValid', false)
    advanceUntil(sim, () => sim.state.disasterRecovery.archive.queueSegments >= 6)
    sim.setKnob('tps', 0)
    sim.setKnob('walGArchiveCredentialsValid', true)
    const frontierAtDeath = sim.state.disasterRecovery.archive.archivedThroughLsn

    expect(sim.startFailover('standbyA')).toBe(true)
    expect(sim.state.cluster.nodes[0].online).toBe(false)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')

    expect(sim.state.disasterRecovery.archive.parentArchivedThroughLsn)
      .toBe(frontierAtDeath)
  })

  it('archives a timeline history file only after an archive-command attempt', () => {
    const healthy = createSim(createBus(), { scheduledBackups: false })
    healthy.setKnob('tps', 0)
    expect(healthy.startFailover('standbyA')).toBe(true)
    advanceUntil(healthy, () => healthy.state.highAvailability.transition.status === 'complete')

    expect(healthy.state.disasterRecovery.archive.historyFileArchived).toBe(false)
    advance(healthy, DR_ARCHIVE_SEGMENT_SECONDS / 2)
    expect(healthy.state.disasterRecovery.archive.historyFileArchived).toBe(false)
    advanceUntil(healthy, () => healthy.state.disasterRecovery.archive.historyFileArchived)

    const repaired = createSim(createBus(), { scheduledBackups: false })
    repaired.setKnob('tps', 0)
    repaired.setKnob('walGArchiveCredentialsValid', false)
    expect(repaired.startFailover('standbyA')).toBe(true)
    advanceUntil(repaired, () => repaired.state.highAvailability.transition.status === 'complete')
    expect(repaired.state.disasterRecovery.archive.queueSegments).toBe(0)
    expect(repaired.state.disasterRecovery.archive.historyFileArchived).toBe(false)

    repaired.setKnob('walGArchiveCredentialsValid', true)
    repaired.update(1 / 15)
    expect(repaired.state.disasterRecovery.archive.historyFileArchived).toBe(false)
    expect(repaired.state.disasterRecovery.archive.queueSegments).toBe(0)
    advanceUntil(repaired, () => repaired.state.disasterRecovery.archive.historyFileArchived)
  })

  it('keeps latest on timeline 1 when the archive has no timeline-2 history file', () => {
    const sim = createSim(createBus(), { scheduledBackups: false })
    sim.setKnob('tps', 6_000)
    sim.setKnob('writeRatio', 1)
    sim.setKnob('synchronousCommit', 'local')
    sim.setKnob('standbyANetworkLag', 400)
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughLsn
        > sim.state.replication.standbys[0].flushedLsn
        && sim.state.disasterRecovery.archive.archivedThroughTime > backup.completedAt + 1,
      180,
    )
    const targetTime = sim.state.disasterRecovery.archive.archivedThroughTime - 0.5
    sim.setKnob('walGArchiveCredentialsValid', false)

    expect(sim.startFailover('standbyA')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    expect(sim.state.disasterRecovery.archive.parentArchivedThroughLsn)
      .toBeGreaterThan(sim.state.highAvailability.timeline.forkLsn)
    expect(sim.state.disasterRecovery.archive.historyFileArchived).toBe(false)

    expect(sim.startPointInTimeRestore(sim.state.t - targetTime)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    expect(restore.targetTimeline).toBe(1)
    expect(restore.crossesTimelineFork).toBe(false)
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status, restore.failureReason).toBe('complete')
    expect(restore.followedHistoryFile).toBe(false)
  })

  it('describes current as the timeline of the selected base backup', () => {
    const bus = createBus()
    const messages: string[] = []
    bus.on('toast', ({ text }) => messages.push(text))
    const sim = createSim(bus, { scheduledBackups: false })
    sim.setKnob('tps', 1_200)
    sim.setKnob('writeRatio', 1)
    expect(sim.startSwitchover('standbyB')).toBe(true)
    advanceUntil(sim, () => sim.state.highAvailability.transition.status === 'complete')
    takeBackup(sim)
    const backup = sim.state.disasterRecovery.backups[0]
    expect(backup.startTimeline).toBe(2)
    advance(sim, 12)
    advanceUntil(
      sim,
      () => sim.state.disasterRecovery.archive.archivedThroughTime >= sim.state.t - 2,
      180,
    )

    sim.setKnob('recoveryTargetTimeline', 'current')
    expect(messages.at(-1)).toMatch(/timeline current when the base backup was taken/i)
    expect(messages.at(-1)).not.toMatch(/cannot reach.*timeline-2/i)
    expect(sim.startPointInTimeRestore(2)).toBe(true)
    const restore = sim.state.disasterRecovery.restore
    advanceUntil(sim, () => restore.status === 'complete' || restore.status === 'failed')

    expect(restore.status, restore.failureReason).toBe('complete')
    expect(restore.backupTimeline).toBe(2)
    expect(restore.targetTimeline).toBe(2)
  })

})
