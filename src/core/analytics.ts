import type { Bus } from './types'

export const ANALYTICS_EVENTS = {
  tourStarted: 'Tour Started',
  pauseChanged: 'Pause Changed',
  speedChanged: 'Speed Changed',
  panelOpened: 'Panel Opened',
  buildingClicked: 'Building Clicked',
  queryOpened: 'Run a Query Opened',
  statementTraced: 'Statement Traced',
  outboundClick: 'Outbound Link: Click',
} as const

export type AnalyticsEntrypoint = 'city' | 'observability'
export type AnalyticsProperty = string | number | boolean
export type AnalyticsProperties = Record<string, AnalyticsProperty>

interface PlausibleOptions {
  props?: AnalyticsProperties
  interactive?: boolean
}

type PlausibleCall = [name: string, options?: PlausibleOptions]

export interface PlausibleFunction {
  (...args: PlausibleCall): void
  q?: PlausibleCall[]
  l?: boolean
}

export interface AnalyticsTracker {
  track(name: string, props?: AnalyticsProperties, interactive?: boolean): void
}

export interface Analytics extends AnalyticsTracker {
  listen(bus: Bus): () => void
  dispose(): void
}

interface AnalyticsWindow extends Window {
  plausible?: PlausibleFunction
}

/**
 * Plausible replaces this queue when its script arrives. If a blocker prevents
 * that forever, calls remain inert data in memory and the application proceeds.
 */
export function createPlausibleQueue(): PlausibleFunction {
  const queue = ((...args: PlausibleCall) => {
    queue.q?.push(args)
  }) as PlausibleFunction
  queue.q = []
  return queue
}

export function createPlausibleDispatcher(
  target: { plausible?: PlausibleFunction },
): PlausibleFunction {
  const dispatch = ((...args: PlausibleCall) => {
    if (!target.plausible) target.plausible = createPlausibleQueue()
    target.plausible(...args)
  }) as PlausibleFunction
  return dispatch
}

export function createAnalyticsTracker(
  entrypoint: AnalyticsEntrypoint,
  plausible: PlausibleFunction,
): AnalyticsTracker {
  return {
    track(name, props = {}, interactive = true) {
      const options: PlausibleOptions = {
        props: { entrypoint, ...props },
      }
      if (!interactive) options.interactive = false
      plausible(name, options)
    },
  }
}

export function panelSlug(panel: string): string {
  return panel
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown'
}

/**
 * Return an attributed external URL, or null when a link must remain local.
 * URLSearchParams owns encoding and makes a second pass idempotent.
 */
export function attributedOutboundUrl(
  href: string,
  panel: string,
  currentHref: string,
): string | null {
  let destination: URL
  let current: URL
  try {
    destination = new URL(href, currentHref)
    current = new URL(currentHref)
  } catch {
    return null
  }
  if (
    (destination.protocol !== 'http:' && destination.protocol !== 'https:')
    || destination.origin === current.origin
  ) {
    return null
  }
  destination.searchParams.set('ref', `pgsimcity-${panelSlug(panel)}`)
  return destination.href
}

function installProvider(): PlausibleFunction {
  const target = window as AnalyticsWindow
  if (!target.plausible) target.plausible = createPlausibleQueue()
  return createPlausibleDispatcher(target)
}

function installOutboundTracking(
  tracker: AnalyticsTracker,
  defaultPanel: string,
): () => void {
  const panelFor = (anchor: HTMLAnchorElement): string =>
    panelSlug(
      anchor.closest<HTMLElement>('[data-analytics-panel]')?.dataset.analyticsPanel
      ?? defaultPanel,
    )

  const decorate = (anchor: HTMLAnchorElement): string | null => {
    const href = attributedOutboundUrl(anchor.href, panelFor(anchor), window.location.href)
    if (href && anchor.href !== href) anchor.href = href
    return href
  }

  const decorateTree = (node: Node): void => {
    if (!(node instanceof Element)) return
    if (node instanceof HTMLAnchorElement) decorate(node)
    for (const anchor of node.querySelectorAll<HTMLAnchorElement>('a[href]')) decorate(anchor)
  }

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) decorate(anchor)

  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) decorateTree(node)
        }
      })
  observer?.observe(document.body, { childList: true, subtree: true })

  const onOutbound = (event: Event): void => {
    if (event.type === 'auxclick' && (event as MouseEvent).button !== 1) return
    if (!(event.target instanceof Element)) return
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const href = decorate(anchor)
    if (!href) return
    const url = new URL(href)
    tracker.track(ANALYTICS_EVENTS.outboundClick, {
      panel: panelFor(anchor),
      destination: url.hostname,
      url: href,
    })
  }
  document.addEventListener('click', onOutbound, true)
  document.addEventListener('auxclick', onOutbound, true)

  return () => {
    observer?.disconnect()
    document.removeEventListener('click', onOutbound, true)
    document.removeEventListener('auxclick', onOutbound, true)
  }
}

function interactionValue(value: unknown): AnalyticsProperty {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

export function listenForAnalyticsInteractions(
  tracker: AnalyticsTracker,
  bus: Bus,
): () => void {
  const off = [
    bus.on('tour:start', ({ source }) => {
      if (source) tracker.track(ANALYTICS_EVENTS.tourStarted, { source })
    }),
    bus.on('knob', ({ key, value, source }) => {
      if (source !== 'user') return
      if (key === 'paused') {
        tracker.track(ANALYTICS_EVENTS.pauseChanged, { paused: interactionValue(value) })
      } else if (key === 'timeScale') {
        tracker.track(ANALYTICS_EVENTS.speedChanged, { speed: interactionValue(value) })
      }
    }),
    bus.on('panel:open', ({ panel, item }) => {
      tracker.track(ANALYTICS_EVENTS.panelOpened, {
        panel,
        ...(item ? { item } : {}),
      })
    }),
    bus.on('anatomy:open', ({ view, id }) => {
      tracker.track(ANALYTICS_EVENTS.panelOpened, {
        panel: 'anatomy',
        item: id ? `${view}:${id}` : view,
      })
    }),
    bus.on('select', ({ id, source }) => {
      if (id && source === 'building') {
        tracker.track(ANALYTICS_EVENTS.buildingClicked, { building: id })
      }
    }),
    bus.on('trace:open', ({ source }) => {
      tracker.track(ANALYTICS_EVENTS.queryOpened, { source: source ?? 'other' })
    }),
    bus.on('trace:run', ({ statement, table, playback }) => {
      tracker.track(ANALYTICS_EVENTS.statementTraced, { statement, table, playback })
    }),
  ]
  return () => {
    for (const stop of off) stop()
  }
}

export function startAnalytics(entrypoint: AnalyticsEntrypoint): Analytics {
  const tracker = createAnalyticsTracker(entrypoint, installProvider())
  const stopOutbound = installOutboundTracking(tracker, entrypoint)
  return {
    ...tracker,
    listen: (bus) => listenForAnalyticsInteractions(tracker, bus),
    dispose: stopOutbound,
  }
}
