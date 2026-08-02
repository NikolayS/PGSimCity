import { CLAIM_VALUES } from './claims'

export const CORRECTION_ISSUE_TEMPLATE = 'postgresql-mismatch.md'

const ISSUE_URL = 'https://github.com/NikolayS/PGSimCity/issues/new'
const NO_STATE =
  'No model state included: this displayed claim does not depend on live controls.'

export type CorrectionContext = readonly (readonly [label: string, value: string])[]

export interface CorrectionReport {
  surface: string
  panel: string
  source: string
  claim: string
  context?: CorrectionContext
}

export interface CorrectionPathOptions {
  surface: string | (() => string)
  panel: string | (() => string)
  source: string | (() => string)
  claim: string | (() => string)
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

export function correctionIssueUrl(report: CorrectionReport): string {
  const url = new URL(ISSUE_URL)
  url.searchParams.set('template', CORRECTION_ISSUE_TEMPLATE)
  url.searchParams.set(
    'title',
    `[PostgreSQL mismatch] ${oneLine(report.surface)} — ${oneLine(report.panel)}`,
  )
  url.searchParams.set('body', buildCorrectionBody(report))
  return url.href
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
    ...(context?.length ? { context } : {}),
  }
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
  anchor.dataset.correctionLink = 'true'
  anchor.dataset.noAnalytics = 'true'
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

  const path = document.createElement('p')
  path.className = 'pg-correction'
  path.dataset.correctionPath = 'true'
  if (options.disclosure) path.dataset.disclosure = 'correction-path'
  path.append(anchor)
  panel.append(path)
  return anchor
}
