import { describe, expect, it } from 'vitest'
import { createBus } from '../core/bus'
import { createSim } from './model'

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

describe('disaster recovery', () => {
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
    const targetBeforeOldestRetained = sim.state.disasterRecovery.backups[0].completedAt - 1
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
    const expiredTarget = sim.state.disasterRecovery.backups[0].completedAt - 1
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

})
