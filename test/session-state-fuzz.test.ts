import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { storedThemeMode } from '../src/core/theme'
import { THEME_STORAGE_KEY } from '../src/core/themes'
import type { Knobs } from '../src/core/types'
import { createAudio } from '../src/engine/audio'
import { createSim } from '../src/sim/model'
import { KNOB_GROUPS, KNOB_META } from '../src/ui/content'
import {
  createControls,
  KNOB_PREFERENCES_STORAGE_KEY,
  loadKnobPreferences,
} from '../src/ui/controls'
import { createHud } from '../src/ui/hud'
import { createInspector } from '../src/ui/panel'
import { createTour } from '../src/ui/tour'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

const STEP = 1 / 15

function advance(sim: ReturnType<typeof createSim>, seconds: number): void {
  const ticks = Math.ceil(seconds / STEP)
  for (let tick = 0; tick < ticks; tick++) sim.update(STEP)
}

function context(): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus, { maxStep: STEP, scheduledBackups: false }),
    registry: { get: () => undefined } as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 100,
      maxLabels: 20,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
  }
}

type StoredKnobSet = Record<string, unknown>

interface ProbeResult {
  commits: number
  maxTailTps: number
  modelSeconds: number
  tps: number
  throughputStayedFinite: boolean
  terminalToasts: string[]
  permanentlyBlocked: number[]
  unexpectedRejected: (keyof Knobs)[]
}

const BLOCKING_BACKEND_STATES = new Set(['blocked', 'commit_wait', 'eviction_flush'])
const TERMINAL_TOAST = /(?:pg_wal reached.*writes rejected|ERROR: no unpinned|commits (?:will|are) wait|cannot acknowledge commits)/i

const valuesFor = (meta: (typeof KNOB_META)[number]): unknown[] => {
  if (meta.kind === 'select') return meta.options?.map(({ value }) => value) ?? []
  if (meta.kind === 'toggle') return [false, true]
  return [meta.min, meta.max]
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function probeStoredKnobs(
  knobs: StoredKnobSet,
  seconds = 30,
  raw = JSON.stringify(knobs),
): ProbeResult {
  installTestDom()
  window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, raw)
  const bus = createBus()
  const toasts: string[] = []
  bus.on('toast', ({ text }) => toasts.push(text))
  const sim = createSim(bus, { maxStep: STEP, scheduledBackups: false })
  const restored = loadKnobPreferences(sim)
  const startTime = sim.state.t
  // The modeled session-pool client lifetime is fifteen seconds. Observe the
  // final two thirds so even its sparsest legal one-client share crosses a
  // complete lifecycle; permanent stalls still finish with zero tail commits.
  const tailStartsAt = Math.floor(seconds / 3 / STEP)
  const slotAlwaysBlocked = sim.state.backends.map(() => true)
  let tailCommits = sim.state.stats.commits
  let maxTailTps = 0
  let throughputStayedFinite = true

  for (let tick = 0; tick < Math.ceil(seconds / STEP); tick++) {
    sim.update(STEP)
    if (tick === tailStartsAt) tailCommits = sim.state.stats.commits
    if (tick < tailStartsAt) continue
    maxTailTps = Math.max(maxTailTps, sim.state.stats.tps)
    throughputStayedFinite &&= Number.isFinite(sim.state.stats.tps)
    for (let slot = 0; slot < sim.state.backends.length; slot++) {
      const backend = sim.state.backends[slot]
      if (!backend.active || !BLOCKING_BACKEND_STATES.has(backend.state)) {
        slotAlwaysBlocked[slot] = false
      }
    }
  }

  const statementRejections = knobs.poolMode === 'statement'
    ? new Set<keyof Knobs>(['longRunningXact', 'lockContention'])
    : new Set<keyof Knobs>()
  return {
    commits: sim.state.stats.commits - tailCommits,
    maxTailTps,
    modelSeconds: sim.state.t - startTime,
    tps: sim.state.stats.tps,
    throughputStayedFinite,
    terminalToasts: toasts.filter((text) => TERMINAL_TOAST.test(text)),
    permanentlyBlocked: sim.state.backends
      .filter((_, slot) => slotAlwaysBlocked[slot])
      .map(({ slot }) => slot),
    unexpectedRejected: restored.rejectedKeys.filter((key) => !statementRejections.has(key)),
  }
}

function expectLiveProbe(result: ProbeResult, recipe: StoredKnobSet): void {
  const label = JSON.stringify(recipe)
  expect(result.modelSeconds, `${label}: model clock did not advance`).toBeGreaterThan(0)
  expect(result.commits, `${label}: no commits completed in the final probe window`).toBeGreaterThan(0)
  expect(result.throughputStayedFinite, `${label}: throughput became non-finite`).toBe(true)
  expect(result.maxTailTps, `${label}: throughput never registered late commits`).toBeGreaterThan(0)
  expect(result.tps, `${label}: throughput became negative`).toBeGreaterThanOrEqual(0)
  expect(result.permanentlyBlocked, `${label}: backend slots stayed blocked`).toEqual([])
  expect(result.terminalToasts, `${label}: terminal toast`).toEqual([])
  expect(result.unexpectedRejected, `${label}: stored mechanisms were silently rejected`).toEqual([])
}

describe('persisted session liveness regressions', () => {
  it('does not restore a transient pause into the next visit', () => {
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({ paused: true }))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    const beforeTime = sim.state.t
    const beforeCommits = sim.state.stats.commits
    advance(sim, 10)

    expect(sim.state.knobs.paused).toBe(false)
    expect(sim.state.t).toBeGreaterThan(beforeTime)
    expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)
    expect(JSON.parse(window.localStorage.getItem(KNOB_PREFERENCES_STORAGE_KEY) ?? '{}'))
      .not.toHaveProperty('paused')
  })

  it.each([-1, 0])('rejects persisted tps=%s below the UI minimum instead of disabling work', (tps) => {
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({ tps }))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    const beforeCommits = sim.state.stats.commits
    advance(sim, 10)

    expect(sim.state.knobs.tps).toBeGreaterThanOrEqual(1)
    expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)
    expect(JSON.parse(window.localStorage.getItem(KNOB_PREFERENCES_STORAGE_KEY) ?? '{}'))
      .not.toHaveProperty('tps')
  })

  it('restores at most one persisted phone sheet', () => {
    const dom = installTestDom()
    dom.mount('hud-left')
    dom.mount('hud-right')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => Object.assign(new EventTarget(), { matches: true }),
    })
    window.localStorage.setItem('pgsimcity.console.open', '1')
    window.localStorage.setItem('pgsimcity.inspector.open', '1')
    const ctx = context()

    const controls = createControls(ctx)
    const inspector = createInspector(ctx)

    expect(document.querySelectorAll('.pgc-host.is-compact.is-open')).toHaveLength(1)
    controls.dispose()
    inspector.dispose()
  })

  it('promotes the remaining healthy standby after restoring an isolated primary', () => {
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({
      tps: 120,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      standbyAEnabled: false,
      standbyBEnabled: true,
      haPartition: 'isolate_node',
    }))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 20)
    const beforeCommits = sim.state.stats.commits
    advance(sim, 10)

    expect(sim.state.highAvailability.currentLeader).toBe('standbyB')
    expect(sim.state.highAvailability.acceptingWrites).toBe(true)
    expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)
  })

  it('does not aggregate cold sequential scans into a minutes-long commit blackout', () => {
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({
      tps: 5_000,
      seqScanRatio: 1,
      sharedBuffers: 128,
    }))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 80)
    const beforeCommits = sim.state.stats.commits
    advance(sim, 40)

    expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)
    expect(sim.state.stats.tps).toBeGreaterThan(0)
  })

  it('does not call aggregate-WAL sample pressure an unpinned-buffer error', () => {
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify({
      tps: 5_000,
      writeRatio: 1,
      sharedBuffers: 128,
      synchronousCommit: 'off',
    }))
    const bus = createBus()
    const messages: string[] = []
    bus.on('toast', ({ text }) => messages.push(text))
    const sim = createSim(bus, { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 30)

    expect(messages).not.toContain('ERROR: no unpinned buffers available')
    expect(sim.state.stats.commits).toBeGreaterThan(0)
  })
})

describe('accumulated persisted-state fuzzer', () => {
  it('keeps dense extreme-value knob sets live', { timeout: 60_000 }, () => {
    const rng = makeRng(0x5e55104e)
    const covered = new Map<string, Set<unknown>>()
    const cases: StoredKnobSet[] = []

    for (let row = 0; row < 96; row++) {
      const knobs: StoredKnobSet = {}
      for (const meta of KNOB_META) {
        if (meta.key === 'paused') continue
        const domain = valuesFor(meta)
        const value = domain[Math.floor(rng() * domain.length)]
        knobs[meta.key] = value
        let values = covered.get(meta.key)
        if (!values) covered.set(meta.key, values = new Set())
        values.add(value)
      }
      /* Availability failures have their own exhaustive rows below. Keeping
       * them safe here lets a failure identify a new interaction rather than
       * rediscovering a documented outage in almost every dense row. */
      Object.assign(knobs, {
        synchronousStandbyNames: 'none',
        standbyAEnabled: true,
        standbyBEnabled: true,
        walGArchiveCredentialsValid: true,
        haPartition: 'healthy',
        lockContention: false,
      })
      cases.push(knobs)
    }

    for (const [index, knobs] of cases.entries()) {
      const result = probeStoredKnobs(knobs)
      expectLiveProbe(result, { fuzzRow: index, ...knobs })
    }

    for (const meta of KNOB_META) {
      if (meta.key === 'paused') continue
      if (['synchronousStandbyNames', 'standbyAEnabled', 'standbyBEnabled',
        'walGArchiveCredentialsValid', 'haPartition', 'lockContention'].includes(meta.key)) continue
      expect(
        covered.get(meta.key),
        `${meta.key} did not reach every UI edge`,
      ).toEqual(new Set(valuesFor(meta)))
    }
  })

  it('exhausts synchronous-commit prerequisites as persisted sets', { timeout: 60_000 }, () => {
    const commits = ['off', 'local', 'remote_write', 'on', 'remote_apply'] as const
    const names = ['none', 'standbyA', 'standbyB'] as const
    const levels = ['minimal', 'replica', 'logical'] as const
    let cases = 0

    for (const synchronousCommit of commits) {
      for (const synchronousStandbyNames of names) {
        for (const walLevel of levels) {
          for (const standbyAEnabled of [false, true]) {
            for (const standbyBEnabled of [false, true]) {
              const knobs = {
                tps: 120,
                writeRatio: 1,
                synchronousCommit,
                synchronousStandbyNames,
                walLevel,
                standbyAEnabled,
                standbyBEnabled,
                standbyANetworkLag: cases % 2 === 0 ? 0 : 400,
                standbyBNetworkLag: cases % 3 === 0 ? 400 : 0,
                standbyASlowApply: cases % 5 === 0,
                standbyBSlowApply: cases % 7 === 0,
              } satisfies StoredKnobSet
              expectLiveProbe(probeStoredKnobs(knobs), knobs)
              cases++
            }
          }
        }
      }
    }
    expect(cases).toBe(180)
  })

  it('keeps every HA partition with a real promotion candidate live', { timeout: 60_000 }, () => {
    const partitions = ['healthy', 'isolate_node', 'isolate_dcs_majority'] as const
    const levels = ['minimal', 'replica', 'logical'] as const
    let liveCases = 0

    for (const haPartition of partitions) {
      for (const walLevel of levels) {
        for (const standbyAEnabled of [false, true]) {
          for (const standbyBEnabled of [false, true]) {
            const canFailOver = walLevel !== 'minimal' && (standbyAEnabled || standbyBEnabled)
            if (haPartition !== 'healthy' && !canFailOver) continue
            const knobs = {
              tps: 120,
              writeRatio: 1,
              synchronousStandbyNames: 'none',
              haPartition,
              walLevel,
              standbyAEnabled,
              standbyBEnabled,
            } satisfies StoredKnobSet
            expectLiveProbe(probeStoredKnobs(knobs), knobs)
            liveCases++
          }
        }
      }
    }
    expect(liveCases).toBe(24)
  })

  it('ignores corrupt, partial, wrong-typed, and stale knob records', () => {
    const wrongTypes = Object.fromEntries(KNOB_META.map((meta) => [
      meta.key,
      typeof valuesFor(meta)[0] === 'boolean'
        ? 'true'
        : typeof valuesFor(meta)[0] === 'number'
          ? '123'
          : 123,
    ]))
    const records = [
      '',
      '{',
      '{"tps": 120,',
      'null',
      '[]',
      '"old settings"',
      '42',
      '{"tps":1e999}',
      JSON.stringify(wrongTypes),
      JSON.stringify({ tps: -1, workMem: 0, timeScale: 999 }),
      JSON.stringify({ removedKnob: true, oldThemeInsideKnobs: 'neon' }),
    ]

    for (const raw of records) {
      expectLiveProbe(probeStoredKnobs({}, 20, raw), { raw })
    }

    const legacy = {
      tps: 120,
      writeRatio: 1,
      synchronousStandbyNames: false,
      replicaEnabled: false,
      replicaNetworkLag: 400,
      replicaSlowApply: true,
      standbyLongQuery: true,
      removedKnob: 'stale',
    }
    expectLiveProbe(probeStoredKnobs(legacy), legacy)
  })

  it('boots real persistence readers across auxiliary storage combinations', () => {
    const auxiliary = [
      {
        theme: 'day',
        audio: JSON.stringify({ enabled: true, volume: 1 }),
        seen: '1',
        rotate: '1',
        flag: '1',
        knobs: JSON.stringify({ tps: 120, writeRatio: 1 }),
      },
      {
        theme: 'clock',
        audio: '1',
        seen: '0',
        rotate: '0',
        flag: '0',
        knobs: JSON.stringify({
          tps: 120,
          writeRatio: 1,
          synchronousStandbyNames: 'standbyB',
          standbyBEnabled: false,
        }),
      },
      {
        theme: 'night',
        audio: JSON.stringify({ enabled: false, volume: 0 }),
        seen: '1',
        rotate: '0',
        flag: '0',
        knobs: JSON.stringify({
          tps: 5_000,
          writeRatio: 0,
          seqScanRatio: 0,
          synchronousStandbyNames: 'none',
        }),
      },
      {
        theme: 'retired-neon-theme',
        audio: '{',
        seen: 'corrupt',
        rotate: 'corrupt',
        flag: 'true',
        knobs: '{"partial":',
      },
      {
        theme: '{"mode":"night"}',
        audio: JSON.stringify({ enabled: 'yes', volume: 'loud' }),
        seen: '',
        rotate: '',
        flag: '',
        knobs: JSON.stringify({ paused: true, tps: 0, removedKnob: true }),
      },
    ]

    for (const stored of auxiliary) {
      const dom = installTestDom({ canvas2d: true })
      for (const id of [
        'tour-layer', 'canvas-root', 'hud-left', 'hud-right',
        'hud-top', 'hud-bottom', 'toast-stack', 'compass',
      ]) dom.mount(id)
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => Object.assign(new EventTarget(), { matches: true }),
      })
      window.localStorage.setItem(THEME_STORAGE_KEY, stored.theme)
      window.localStorage.setItem('pgsimcity.audio', stored.audio)
      window.localStorage.setItem('pgsimcity.seen', stored.seen)
      window.localStorage.setItem('pgsimcity.rotate-hint.dismissed', stored.rotate)
      window.localStorage.setItem('pgsimcity.console.open', stored.flag)
      window.localStorage.setItem('pgsimcity.inspector.open', stored.flag)
      for (const group of KNOB_GROUPS) {
        window.localStorage.setItem(`pgsimcity.console.group.${group.id}`, stored.flag)
      }
      window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, stored.knobs)

      const bus = createBus()
      const sim = createSim(bus, { maxStep: STEP, scheduledBackups: false })
      const audio = createAudio(bus)
      const ctx: UiContext = {
        ...context(),
        bus,
        sim,
        getAudioState: () => ({
          enabled: audio.enabled,
          preferred: audio.preferred,
          volume: audio.volume,
        }),
      }
      const hud = createHud(ctx)
      const controls = createControls(ctx)
      const inspector = createInspector(ctx)
      const tour = createTour(ctx)
      const beforeTime = sim.state.t
      const beforeCommits = sim.state.stats.commits
      advance(sim, 10)

      expect(['day', 'night', 'clock']).toContain(storedThemeMode())
      expect(Number.isFinite(audio.volume)).toBe(true)
      expect(audio.volume).toBeGreaterThanOrEqual(0)
      expect(audio.volume).toBeLessThanOrEqual(1)
      expect(document.querySelectorAll('.pgc-host.is-compact.is-open')).toHaveLength(stored.flag === '1' ? 1 : 0)
      expect(sim.state.t).toBeGreaterThan(beforeTime)
      expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)

      tour.dispose()
      inspector.dispose()
      controls.dispose()
      hud.dispose()
      audio.dispose()
    }
  })
})

describe('intentional persisted teaching states', () => {
  it('rejects open-transaction controls restored under statement pooling', () => {
    const knobs = {
      poolMode: 'statement',
      longRunningXact: true,
      lockContention: true,
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    const restored = loadKnobPreferences(sim)

    expect(new Set(restored.rejectedKeys)).toEqual(new Set(['longRunningXact', 'lockContention']))
    expect(sim.state.knobs.poolMode).toBe('statement')
    expect(sim.state.knobs.longRunningXact).toBe(false)
    expect(sim.state.knobs.lockContention).toBe(false)
  })

  it('keeps the sparsest session-pool share slow but alive', () => {
    const knobs = {
      tps: 1,
      clientConnections: 2_000,
      poolMode: 'session',
      defaultPoolSize: 1,
      maxClientConn: 2_000,
      synchronousStandbyNames: 'none',
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 30)
    const beforeCommits = sim.state.stats.commits
    advance(sim, 30)

    expect(sim.state.pooler.boundClients).toBe(1)
    expect(sim.state.pooler.waitingClients).toBe(1_999)
    expect(sim.state.stats.commits).toBeGreaterThan(beforeCommits)
  })

  it('leaves a split DCS unable to elect or accept writes', () => {
    const knobs = {
      tps: 120,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      haPartition: 'split_dcs',
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 20)
    const stoppedAt = sim.state.stats.commits
    advance(sim, 10)

    expect(sim.state.highAvailability.patroni.dcs.canCommit).toBe(false)
    expect(sim.state.highAvailability.currentLeader).toBeNull()
    expect(sim.state.highAvailability.acceptingWrites).toBe(false)
    expect(sim.state.stats.commits).toBe(stoppedAt)
  })

  it('leaves an isolated primary down when no standby is promotable', () => {
    const knobs = {
      tps: 120,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      standbyAEnabled: false,
      standbyBEnabled: false,
      haPartition: 'isolate_node',
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 20)
    const stoppedAt = sim.state.stats.commits
    advance(sim, 10)

    expect(sim.state.highAvailability.currentLeader).toBeNull()
    expect(sim.state.highAvailability.acceptingWrites).toBe(false)
    expect(sim.state.stats.commits).toBe(stoppedAt)
  })

  it('lets sustained writes demonstrate an unreleased ACCESS EXCLUSIVE lock', () => {
    const knobs = {
      tps: 5_000,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      lockContention: true,
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 30)

    expect(sim.state.locks.length).toBeGreaterThan(0)
    expect(sim.state.backends.some((backend) => backend.state === 'idle_in_xact')).toBe(true)
    expect(sim.state.backends.some((backend) => backend.state === 'blocked')).toBe(true)
  })

  it('lets a disabled standby slot fill pg_wal until writes are rejected', () => {
    const knobs = {
      tps: 5_000,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      standbyBEnabled: false,
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 180)

    expect(sim.state.replication.physicalSlots[1].active).toBe(false)
    expect(sim.state.replication.physicalSlots[1].retainedBytes).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.archive.writesBlocked).toBe(true)
    expect(sim.state.disasterRecovery.archive.rejectedWrites).toBeGreaterThan(0)
  })

  it('lets invalid archive credentials fill pg_wal until writes are rejected', () => {
    const knobs = {
      tps: 5_000,
      writeRatio: 1,
      synchronousStandbyNames: 'none',
      walGArchiveCredentialsValid: false,
    } satisfies StoredKnobSet
    installTestDom()
    window.localStorage.setItem(KNOB_PREFERENCES_STORAGE_KEY, JSON.stringify(knobs))
    const sim = createSim(createBus(), { maxStep: STEP, scheduledBackups: false })

    loadKnobPreferences(sim)
    advance(sim, 180)

    expect(sim.state.disasterRecovery.archive.failedAttempts).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.archive.queueSegments).toBeGreaterThan(0)
    expect(sim.state.disasterRecovery.archive.writesBlocked).toBe(true)
    expect(sim.state.disasterRecovery.archive.rejectedWrites).toBeGreaterThan(0)
  })
})
