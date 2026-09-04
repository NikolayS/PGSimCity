import { describe, expect, it, vi } from 'vitest'

import {
  ANALYTICS_EVENTS,
  attributedOutboundUrl,
  createAnalyticsTracker,
  createPlausibleDispatcher,
  createPlausibleQueue,
  listenForAnalyticsInteractions,
  outboundTrackingAllowed,
  panelSlug,
  trackVacuumLessonProgress,
} from './analytics'
import { createBus } from './bus'

describe('analytics attribution', () => {
  it('adds one panel ref while preserving destination parameters and fragments', () => {
    expect(
      attributedOutboundUrl(
        'https://www.postgresql.org/docs/current/wal.html?version=18#intro',
        'WAL writer',
        'https://nikolays.github.io/PGSimCity/',
      ),
    ).toBe(
      'https://www.postgresql.org/docs/current/wal.html?version=18&ref=pgsimcity-wal-writer#intro',
    )

    expect(
      attributedOutboundUrl(
        'https://www.postgresql.org/docs/current/wal.html?ref=old',
        'WAL writer',
        'https://nikolays.github.io/PGSimCity/',
      ),
    ).toBe('https://www.postgresql.org/docs/current/wal.html?ref=pgsimcity-wal-writer')
  })

  it('does not rewrite links within the current origin or non-web protocols', () => {
    const page = 'https://nikolays.github.io/PGSimCity/'
    expect(attributedOutboundUrl('../observability/', 'city', page)).toBeNull()
    expect(attributedOutboundUrl('mailto:owner@example.com', 'city', page)).toBeNull()
  })

  it('keeps correction report bodies out of outbound analytics', () => {
    expect(outboundTrackingAllowed({ dataset: { noAnalytics: 'true' } })).toBe(false)
    expect(outboundTrackingAllowed({ dataset: {} })).toBe(true)
  })

  it('normalizes component ids into stable attribution slugs', () => {
    expect(panelSlug('shared.buffers')).toBe('shared-buffers')
    expect(panelSlug('  WAL / archive  ')).toBe('wal-archive')
  })
})

describe('analytics event queue', () => {
  it('allows only known variants and boolean outcome dimensions', () => {
    const plausible = vi.fn()
    const tracker = createAnalyticsTracker('city', plausible)
    trackVacuumLessonProgress(tracker, { event: 'recovery-verified', mode: 'challenge',
      lesson: 'vacuum-report', firstEncounter: true, unassisted: false, sql: 'private' })
    trackVacuumLessonProgress(tracker, { event: 'started', mode: 'challenge', lesson: 'private' })
    expect(plausible.mock.calls).toEqual([
      ['Lesson Recovery Verified', { props: { entrypoint: 'city', lesson: 'vacuum-report', mode: 'challenge', firstEncounter: true, unassisted: false } }],
    ])
  })
  it('allowlists lesson events and exports no notebook, SQL, or arbitrary input', () => {
    const plausible = vi.fn()
    const tracker = createAnalyticsTracker('city', plausible)
    trackVacuumLessonProgress(tracker, {
      event: 'recovery-verified', mode: 'challenge', notes: 'private note', sql: 'select secret',
    })
    trackVacuumLessonProgress(tracker, { event: 'private note', mode: 'guided' })
    trackVacuumLessonProgress(tracker, { event: 'started', mode: 'private note' })
    trackVacuumLessonProgress(tracker, { event: '__proto__', mode: 'guided' })
    expect(plausible.mock.calls).toEqual([
      ['Lesson Recovery Verified', { props: { entrypoint: 'city', lesson: 'vacuum-blockade', mode: 'challenge' } }],
    ])
  })

  it('falls back to an inert window queue when the provider is unavailable', () => {
    const target: { plausible?: ReturnType<typeof createPlausibleQueue> } = {}
    const dispatch = createPlausibleDispatcher(target)

    expect(() => dispatch(ANALYTICS_EVENTS.tourStarted)).not.toThrow()
    expect(target.plausible?.q).toEqual([['Tour Started']])
  })

  it('keeps interaction events safe and queued when the provider script is blocked', () => {
    const plausible = createPlausibleQueue()
    const tracker = createAnalyticsTracker('city', plausible)

    expect(() =>
      tracker.track(ANALYTICS_EVENTS.tourStarted, {
        source: 'keyboard',
      }),
    ).not.toThrow()
    expect(plausible.q).toEqual([
      [
        'Tour Started',
        {
          props: {
            entrypoint: 'city',
            source: 'keyboard',
          },
        },
      ],
    ])
  })

  it('sends outbound panel and destination properties under one dashboard goal', () => {
    const plausible = vi.fn()
    const tracker = createAnalyticsTracker('observability', plausible)

    tracker.track(ANALYTICS_EVENTS.outboundClick, {
      panel: 'pg-stat-activity',
      destination: 'www.postgresql.org',
      url: 'https://www.postgresql.org/docs/current/monitoring-stats.html?ref=pgsimcity-pg-stat-activity',
    })

    expect(plausible).toHaveBeenCalledWith('Outbound Link: Click', {
      props: {
        entrypoint: 'observability',
        panel: 'pg-stat-activity',
        destination: 'www.postgresql.org',
        url: 'https://www.postgresql.org/docs/current/monitoring-stats.html?ref=pgsimcity-pg-stat-activity',
      },
    })
  })

  it('maps user interactions to the documented dashboard schema', () => {
    const plausible = vi.fn()
    const tracker = createAnalyticsTracker('city', plausible)
    const bus = createBus()
    const stop = listenForAnalyticsInteractions(tracker, bus)

    bus.emit('tour:start', { source: 'keyboard' })
    bus.emit('tour:start', { source: 'button' })
    bus.emit('knob', { key: 'paused', value: true, source: 'user' })
    bus.emit('knob', { key: 'timeScale', value: 2, source: 'user' })
    bus.emit('panel:open', { panel: 'inspector', item: 'walwriter' })
    bus.emit('anatomy:open', { view: 'page', id: 'storage.table.sessions' })
    bus.emit('select', { id: 'walwriter', source: 'building' })
    bus.emit('trace:open', { source: 'button' })
    bus.emit('trace:run', { statement: 'update', table: 'sessions', playback: 'slow' })
    stop()

    expect(plausible.mock.calls).toEqual([
      ['Tour Started', { props: { entrypoint: 'city', source: 'keyboard' } }],
      ['Tour Started', { props: { entrypoint: 'city', source: 'button' } }],
      ['Pause Changed', { props: { entrypoint: 'city', paused: true } }],
      ['Speed Changed', { props: { entrypoint: 'city', speed: 2 } }],
      ['Panel Opened', { props: { entrypoint: 'city', panel: 'inspector', item: 'walwriter' } }],
      [
        'Panel Opened',
        {
          props: {
            entrypoint: 'city',
            panel: 'anatomy',
            item: 'page:storage.table.sessions',
          },
        },
      ],
      ['Building Clicked', { props: { entrypoint: 'city', building: 'walwriter' } }],
      ['Run a Query Opened', { props: { entrypoint: 'city', source: 'button' } }],
      [
        'Statement Traced',
        {
          props: {
            entrypoint: 'city',
            statement: 'update',
            table: 'sessions',
            playback: 'slow',
          },
        },
      ],
    ])
  })

  it('does not report simulation-driven pause and speed changes as user interactions', () => {
    const plausible = vi.fn()
    const tracker = createAnalyticsTracker('city', plausible)
    const bus = createBus()
    const stop = listenForAnalyticsInteractions(tracker, bus)

    bus.emit('knob', { key: 'paused', value: true })
    bus.emit('knob', { key: 'timeScale', value: 0.05 })
    stop()

    expect(plausible).not.toHaveBeenCalled()
  })

  it('dispatches through the provider function that replaces the startup queue', () => {
    const queued = createPlausibleQueue()
    const target: { plausible?: typeof queued } = { plausible: queued }
    const dispatch = createPlausibleDispatcher(target)
    const tracker = createAnalyticsTracker('city', dispatch)
    const loaded = vi.fn()

    target.plausible = loaded
    tracker.track(ANALYTICS_EVENTS.tourStarted, { source: 'button' })

    expect(queued.q).toEqual([])
    expect(loaded).toHaveBeenCalledWith('Tour Started', {
      props: { entrypoint: 'city', source: 'button' },
    })
  })
})
