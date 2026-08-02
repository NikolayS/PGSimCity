import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CLAIM_VALUES } from '../src/core/claims'
import {
  CORRECTION_ISSUE_TEMPLATE,
  buildCorrectionBody,
  correctionIssueUrl,
  createCorrectionPath,
} from '../src/core/corrections'
import { el } from '../src/ui/uikit'
import { installTestDom } from './dom'

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

describe('PostgreSQL correction reports', () => {
  it('prefills an actionable, editable report without dumping model state', () => {
    const body = buildCorrectionBody({
      surface: 'City / Scenario',
      panel: 'Checkpoint storm / WAL wins the race',
      source: 'src/sim/scenarios.ts#SCENARIOS[checkpoint-storm].beats[1]',
      claim: 'WAL wins the race\nThe vault fills faster than the clock ticks.',
      context: [
        ['Scenario', 'checkpoint-storm'],
        ['Beat', '1 at 12 model s'],
      ],
    })

    expect(body).toContain(`- App version: \`${CLAIM_VALUES.appVersion.label}\``)
    expect(body).toContain('- Surface: City / Scenario')
    expect(body).toContain('- Panel: Checkpoint storm / WAL wins the race')
    expect(body).toContain(
      '- Source: `src/sim/scenarios.ts#SCENARIOS[checkpoint-storm].beats[1]`',
    )
    expect(body).toContain(
      '> WAL wins the race\n> The vault fills faster than the clock ticks.',
    )
    expect(body).toContain('- Scenario: `checkpoint-storm`')
    expect(body).toContain('- Beat: `1 at 12 model s`')
    expect(body).toContain('## What PostgreSQL actually does')
    expect(body).toContain('## Documentation or source')
    expect(body).not.toContain('sharedBuffers')
    expect(body).not.toContain('Full knob')
  })

  it('targets the mismatch template and keeps every report field readable in the URL', () => {
    const href = correctionIssueUrl({
      surface: 'Diagnose',
      panel: 'v.backend_writes — Backends are doing the writes',
      source: 'src/observability/paths.ts#VERDICTS[v.backend_writes]',
      claim: 'Backends are doing the writes.\nClient backends own most writes.',
      context: [
        ['Staged scenario', 'cache-thrash'],
        ['Decision path', 'slow.1 → io.1 → v.backend_writes'],
      ],
    })
    const url = new URL(href)

    expect(url.origin).toBe('https://github.com')
    expect(url.pathname).toBe('/NikolayS/PGSimCity/issues/new')
    expect(url.searchParams.get('template')).toBe(CORRECTION_ISSUE_TEMPLATE)
    expect(url.searchParams.get('title')).toBe(
      '[PostgreSQL mismatch] Diagnose — v.backend_writes — Backends are doing the writes',
    )
    expect(url.searchParams.get('body')).toBe(
      buildCorrectionBody({
        surface: 'Diagnose',
        panel: 'v.backend_writes — Backends are doing the writes',
        source: 'src/observability/paths.ts#VERDICTS[v.backend_writes]',
        claim: 'Backends are doing the writes.\nClient backends own most writes.',
        context: [
          ['Staged scenario', 'cache-thrash'],
          ['Decision path', 'slow.1 → io.1 → v.backend_writes'],
        ],
      }),
    )
  })

  it('renders one honest href for a claim-bearing surface and refreshes live text', () => {
    installTestDom()
    const title = el('h2', { text: 'The clock sweep' })
    const claim = el('p', { text: 'PostgreSQL scans usage_count until it finds zero.' })
    const panel = el('section', {}, title, claim)
    document.body.append(panel)

    createCorrectionPath(panel, {
      surface: 'City / Inspector',
      panel: () => `shared_buffers / ${title.textContent}`,
      source: () => 'src/ui/docs-memory.ts#DOCS_MEMORY[shared.buffers]',
      claim: () => `${title.textContent}\n${claim.textContent}`,
      disclosure: true,
    })

    const link = panel.querySelector<HTMLAnchorElement>('a[data-correction-link]')
    expect(link).not.toBeNull()
    expect(link!.href).toContain('template=postgresql-mismatch.md')
    expect(link!.dataset.noAnalytics).toBe('true')
    expect(link!.closest('[data-disclosure]')).not.toBeNull()

    claim.textContent = 'PostgreSQL scans usage_count and selects a zero-valued victim.'
    link!.dispatchEvent(new Event('pointerdown'))
    const decoded = new URL(link!.href).searchParams.get('body')
    expect(decoded).toContain(
      '> PostgreSQL scans usage_count and selects a zero-valued victim.',
    )
    expect(decoded).not.toContain('until it finds zero')
  })

  it('keeps the issue template aligned with the generated report questions', () => {
    const template = read(`.github/ISSUE_TEMPLATE/${CORRECTION_ISSUE_TEMPLATE}`)
    expect(template).toContain('name: This does not match PostgreSQL')
    expect(template).toContain('## What PostgreSQL actually does')
    expect(template).toContain('## Documentation or source')
    expect(template).toContain('what PostgreSQL does instead')
    expect(template).toContain('documentation section or PostgreSQL source')
    expect(CLAIM_VALUES.appVersion.label).toMatch(/^v\d+\.\d+\.\d+ · [0-9a-f]{7}$/)
  })

  it('keeps every claim-bearing rendering family on the shared correction path', () => {
    const renderers = [
      ['src/ui/panel.ts', 1, 'inspector and component docs'],
      ['src/ui/controls.ts', 1, 'control console'],
      ['src/ui/anatomy.ts', 1, 'physical anatomy'],
      ['src/ui/hud.ts', 2, 'latency and operator verdict panels'],
      ['src/ui/tour.ts', 2, 'tour chapters and scenario beats'],
      ['src/ui/control-center.ts', 1, 'control center'],
      ['src/ui/help.ts', 1, 'help and reading guide'],
      ['src/observability/main.ts', 1, 'all Diagnose and Query flow cards'],
      ['machine/magnum.js', 3, 'Machine workbench, board, and comparison'],
    ] as const

    for (const [file, expectedPaths, surface] of renderers) {
      const count = read(file).match(/createCorrectionPath\(/g)?.length ?? 0
      expect(count, `${surface} has no shared correction path in ${file}`).toBe(expectedPaths)
    }
  })
})
