import { CLAIM_VALUES } from './claims'

export const CORRECTION_ISSUE_TEMPLATE = 'postgresql-mismatch.md'
export const CORRECTION_ANALYTICS_EVENT = 'Correction Link Click'
export const CORRECTION_PLAUSIBLE_CLASS =
  'plausible-event-name--Correction+Link+Click'
export const CORRECTION_URL_MAX_LENGTH = 8_000
export const CORRECTION_CLAIM_TRUNCATION_MARKER =
  '[Claim truncated: the correction link reached its safe URL limit. Quote any omitted text in the issue after opening it.]'

const ISSUE_URL = 'https://github.com/NikolayS/PGSimCity/issues/new'
const NO_STATE =
  'No model state included: this displayed claim does not depend on live controls.'
const protectedCorrectionLinks = new WeakSet<HTMLAnchorElement>()

interface CorrectionAnalyticsWindow extends Window {
  plausible?: (name: string) => void
}

export type CorrectionContext = readonly (readonly [label: string, value: string])[]

export interface CorrectionReport {
  surface: string
  panel: string
  source: string
  claim: string
  claimCaptureNote?: string
  context?: CorrectionContext
}

export interface CorrectionPathOptions {
  surface: string | (() => string)
  panel: string | (() => string)
  source: string | (() => string)
  claim: string | (() => string)
  claimCaptureNote?: string | (() => string)
  context?: CorrectionContext | (() => CorrectionContext)
  /** Mark representative always-visible explanatory paths for the 390px floor. */
  disclosure?: boolean
}

function read<T>(value: T | (() => T)): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function quotedClaim(claim: string): string {
  return claim
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => `>${line ? ` ${line}` : ''}`)
    .join('\n')
}

function code(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``
}

export function buildCorrectionBody(report: CorrectionReport): string {
  const context = report.context?.length
    ? report.context.map(([label, value]) => `- ${oneLine(label)}: ${code(value)}`).join('\n')
    : NO_STATE

  return [
    '## Where',
    '',
    `- Surface: ${oneLine(report.surface)}`,
    `- Panel: ${oneLine(report.panel)}`,
    `- Source: ${code(report.source)}`,
    `- App version: ${code(CLAIM_VALUES.appVersion.label)}`,
    '',
    '## Claim as displayed',
    '',
    quotedClaim(report.claim),
    ...(report.claimCaptureNote
      ? ['', `**Claim capture note:** ${oneLine(report.claimCaptureNote)}`]
      : []),
    '',
    '## Minimum reproduction context',
    '',
    context,
    '',
    '## What PostgreSQL actually does',
    '',
    '<!-- Please replace this comment with what PostgreSQL does instead. -->',
    '',
    '## Documentation or source',
    '',
    '<!-- Please link the PostgreSQL documentation section or source that supports the correction. -->',
    '',
    '## Anything else',
    '',
    '<!-- Optional: version differences, edge cases, or a suggested wording. -->',
  ].join('\n')
}

function unguardedCorrectionIssueUrl(report: CorrectionReport): string {
  const url = new URL(ISSUE_URL)
  url.searchParams.set('template', CORRECTION_ISSUE_TEMPLATE)
  url.searchParams.set(
    'title',
    `[PostgreSQL mismatch] ${oneLine(report.surface)} — ${oneLine(report.panel)}`,
  )
  url.searchParams.set('body', buildCorrectionBody(report))
  return url.href
}

function truncatedClaim(claim: readonly string[], length: number): string {
  if (length === 0) return CORRECTION_CLAIM_TRUNCATION_MARKER
  return `${claim.slice(0, length).join('')}\n\n${CORRECTION_CLAIM_TRUNCATION_MARKER}`
}

/** Keep GitHub's issue prefill below its practical ceiling, measured after URL encoding. */
export function correctionIssueUrl(report: CorrectionReport): string {
  const complete = unguardedCorrectionIssueUrl(report)
  if (complete.length <= CORRECTION_URL_MAX_LENGTH) return complete

  const claim = Array.from(report.claim)
  let low = 0
  let high = claim.length
  let fitted = unguardedCorrectionIssueUrl({
    ...report,
    claim: CORRECTION_CLAIM_TRUNCATION_MARKER,
  })

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = unguardedCorrectionIssueUrl({
      ...report,
      claim: truncatedClaim(claim, middle),
    })
    if (candidate.length <= CORRECTION_URL_MAX_LENGTH) {
      fitted = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (fitted.length <= CORRECTION_URL_MAX_LENGTH) return fitted

  /* Authored metadata should never approach the limit. This final fixed report
   * keeps a future bad caller from emitting a dead link while saying visibly
   * that more than the claim had to be omitted. */
  return unguardedCorrectionIssueUrl({
    surface: 'PGSimCity',
    panel: 'Correction report metadata exceeded the safe link limit',
    source: 'src/core/corrections.ts#correctionIssueUrl',
    claim: CORRECTION_CLAIM_TRUNCATION_MARKER,
    claimCaptureNote:
      'The report metadata also exceeded the safe link limit. Add the surface and disputed wording manually after opening the issue.',
  })
}

/** Read the same plain text the panel presents, keeping panel sections separate. */
export function displayedClaim(...nodes: (HTMLElement | null | undefined)[]): string {
  return nodes
    .filter((node): node is HTMLElement => node != null)
    .map((node) => {
      const rendered = 'innerText' in node ? node.innerText : ''
      return (rendered || node.textContent || '').trim()
    })
    .filter(Boolean)
    .join('\n')
}

function reportFrom(options: CorrectionPathOptions): CorrectionReport {
  const context = options.context ? read(options.context) : undefined
  return {
    surface: read(options.surface),
    panel: read(options.panel),
    source: read(options.source),
    claim: read(options.claim),
    ...(options.claimCaptureNote
      ? { claimCaptureNote: read(options.claimCaptureNote) }
      : {}),
    ...(context?.length ? { context } : {}),
  }
}

/**
 * Plausible's outboundLinks setting is dashboard-controlled, and its served custom-event
 * handler adds an anchor's full href even for named classes. Keep the provider opt-out class,
 * stop those document handlers, and submit the property-free named count ourselves.
 */
export function protectCorrectionLink(anchor: HTMLAnchorElement): void {
  anchor.dataset.correctionLink = 'true'
  anchor.dataset.noAnalytics = 'true'
  anchor.classList.add(CORRECTION_PLAUSIBLE_CLASS)
  if (protectedCorrectionLinks.has(anchor)) return
  protectedCorrectionLinks.add(anchor)

  const countWithoutHref = (event: Event): void => {
    if (event.type === 'auxclick' && (event as MouseEvent).button !== 1) return
    event.stopPropagation()
    try {
      ;(window as CorrectionAnalyticsWindow).plausible?.(CORRECTION_ANALYTICS_EVENT)
    } catch {
      // Analytics failure must not interfere with the correction path.
    }
  }
  anchor.addEventListener('click', countWithoutHref)
  anchor.addEventListener('auxclick', countWithoutHref)
}

/**
 * Add the one shared, ordinary-href correction path to a claim-bearing panel.
 * Getters are read again before navigation so live verdicts and beats stay exact.
 */
export function createCorrectionPath(
  panel: HTMLElement,
  options: CorrectionPathOptions,
): HTMLAnchorElement {
  const existing = panel.querySelector<HTMLAnchorElement>(':scope > [data-correction-path] a')
  if (existing) return existing

  const anchor = document.createElement('a')
  anchor.className = 'pg-correction__link'
  anchor.target = '_blank'
  anchor.rel = 'noreferrer noopener'
  anchor.textContent = 'This does not match PostgreSQL'

  const refresh = (): void => {
    anchor.href = correctionIssueUrl(reportFrom(options))
  }
  refresh()
  anchor.addEventListener('pointerdown', refresh)
  anchor.addEventListener('focus', refresh)
  anchor.addEventListener('keydown', refresh)
  anchor.addEventListener('click', refresh)
  protectCorrectionLink(anchor)

  const path = document.createElement('p')
  path.className = 'pg-correction'
  path.dataset.correctionPath = 'true'
  if (options.disclosure) path.dataset.disclosure = 'correction-path'
  path.append(anchor)
  panel.append(path)
  return anchor
}
