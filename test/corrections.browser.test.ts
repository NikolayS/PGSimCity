import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import { CLAIMS, CLAIM_VALUES } from '../src/core/claims'
import {
  CORRECTION_URL_MAX_LENGTH,
  CORRECTION_ISSUE_TEMPLATE,
  buildCorrectionBody,
  correctionIssueUrl,
  createCorrectionPath,
} from '../src/core/corrections'
import { el } from '../src/ui/uikit'
import { installTestDom } from './dom'
import {
  correctionActionNameFailures,
  correctionCoverageFailures,
  measureCorrectionPages,
  versionQualificationFailures,
} from './correction-browser.mjs'
import {
  disclosureFailures,
  measureTierTouchTargetPages,
  touchTargetFailures,
} from './disclosure-browser.mjs'

const QUALITY_LEVELS = ['ultra', 'high', 'medium', 'reduced', 'low'] as const

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const SQL_SECRET = 'CORRECTION_SQL_SECRET_9E2A'

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
    expect(body).toMatch(/report(?:ing)? a problem with .*claim/iu)
    expect(body).toMatch(/close .*without submitting/iu)
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

  it('visibly truncates a constructed worst-case claim before the safe URL ceiling', () => {
    const claim = Array.from(
      { length: 12_000 },
      (_value, index) => `${index % 10} % / ? ⚠\n`,
    ).join('')
    const href = correctionIssueUrl({
      surface: 'City / Console',
      panel: 'Disaster recovery / recovery_target_time',
      source: 'src/ui/content.ts#KNOB_META[recoveryTargetAge]',
      claim,
      context: [['recoveryTargetAge', '300 s ago']],
    })
    const body = new URL(href).searchParams.get('body') ?? ''

    expect(CORRECTION_URL_MAX_LENGTH).toBe(8_000)
    expect(href.length).toBeLessThanOrEqual(CORRECTION_URL_MAX_LENGTH)
    expect(body).toMatch(/claim truncated/i)
    expect(body).not.toContain(claim)
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
    expect(link!.classList.contains('plausible-event-name--Correction+Link+Click')).toBe(true)
    const accessibleName = link!.getAttribute('aria-label') || link!.textContent || ''
    expect(link!.textContent).toMatch(/\b(?:report|file|submit)\b/iu)
    expect(link!.textContent).toMatch(/\bGitHub\b/iu)
    expect(accessibleName).toMatch(/\b(?:report|file|submit)\b/iu)
    const qualification = link!.closest<HTMLDetailsElement>('[data-version-qualification]')
    expect(qualification).not.toBeNull()
    expect(link!.parentElement).toBe(qualification)
    expect(qualification!.open).toBe(false)
    const summary = qualification!.querySelector(':scope > summary[data-disclosure]')
    expect(summary).not.toBeNull()
    expect(summary!.textContent)
      .toContain(CLAIM_VALUES.postgresqlVersion.referenceLabel)
    expect(qualification!.querySelector(':scope > [data-version-qualification-full]')?.textContent)
      .toContain(`model and explanations describe ${CLAIM_VALUES.postgresqlVersion.referenceLabel}`)

    claim.textContent = 'PostgreSQL scans usage_count and selects a zero-valued victim.'
    link!.dispatchEvent(new Event('pointerdown'))
    const decoded = new URL(link!.href).searchParams.get('body')
    expect(decoded).toContain(
      '> PostgreSQL scans usage_count and selects a zero-valued victim.',
    )
    expect(decoded).not.toContain('until it finds zero')
  })

  it('counts a correction click without exposing it to document-level auto-capture', () => {
    installTestDom()
    const plausible = vi.fn()
    Object.assign(window, { plausible })
    const panel = el('section')
    document.body.append(panel)
    const link = createCorrectionPath(panel, {
      surface: 'City / Inspector',
      panel: 'WAL writer',
      source: 'src/ui/docs-storage.ts#DOCS_STORAGE[wal.writer]',
      claim: 'The WAL writer flushes completed WAL pages.',
    })
    const click = new Event('click')
    const stopPropagation = vi.spyOn(click, 'stopPropagation')

    link.dispatchEvent(click)

    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(plausible.mock.calls).toEqual([['Correction Link Click']])
  })

  it('protects the static correction-template link with the same provider opt-out', () => {
    expect(read('index.html')).toMatch(
      /<a[^>]+class="plausible-event-name--Correction\+Link\+Click"[^>]+data-correction-link="true"/,
    )
  })

  it('keeps the issue template aligned with the generated report questions', () => {
    const template = read(`.github/ISSUE_TEMPLATE/${CORRECTION_ISSUE_TEMPLATE}`)
    expect(template).toMatch(/^name:\s+Report\b/imu)
    expect(template).toMatch(/close .*without submitting/iu)
    expect(template).toContain('## What PostgreSQL actually does')
    expect(template).toContain('## Documentation or source')
    expect(template).toContain('what PostgreSQL does instead')
    expect(template).toContain('documentation section or PostgreSQL source')
    expect(CLAIM_VALUES.appVersion.label).toMatch(/^v\d+\.\d+\.\d+ · [0-9a-f]{7}$/)
  })

  it('keeps every claim-bearing rendering family on the shared correction path', () => {
    for (const surface of CLAIMS.postgresqlVersion.claimSurfaces) {
      const count = read(surface.source).match(/createCorrectionPath\(/g)?.length ?? 0
      expect(count, `${surface.label} has no shared correction path in ${surface.source}`)
        .toBe(surface.correctionPaths)
    }
  })

  it('covers every claim-bearing panel rendered by each browser surface', async () => {
    const reports = await measureCorrectionPages([{
      name: 'City',
      path: '/',
      readySelector: '.an-overlay',
      measureDisclosures: true,
      qualityLevels: QUALITY_LEVELS,
      prepareDisclosures: `(() => {
        for (const host of document.querySelectorAll('.pgc-host')) host.classList.add('is-open')
        for (const panel of document.querySelectorAll('.pgc-panel')) {
          panel.style.transition = 'none'
          panel.style.visibility = 'visible'
          panel.style.opacity = '1'
          panel.style.transform = 'none'
        }
        document.querySelector('.control-center').hidden = false
        document.querySelector('#hud-latency-panel').hidden = false
        document.querySelector('.pg-replay').hidden = false
      })()`,
      prepare: `(() => {
        const { sim, bus } = window.PGSIMCITY
        document.querySelector('.control-center').hidden = false
        document.querySelector('#hud-latency-panel').hidden = false
        document.querySelector('.pg-replay').hidden = false
        sim.setKnob('recoveryTargetAge', 40)
        sim.setKnob('walGDownloadConcurrency', 4)
        Object.assign(sim.state.disasterRecovery.drill, {
          status: 'passed',
          level: 'cluster',
          measuredRestoreToTargetSec: 12.5,
          failureReason: '',
        })
        bus.emit('select', { id: 'recovery.ground' })
        const consoleHost = document.querySelector('.pgc-host--left')
        if (consoleHost && !consoleHost.classList.contains('is-open')) {
          consoleHost.querySelector('.pgc-tab--left')?.click()
        }
        const memory = Array.from(document.querySelectorAll('.pgc-group'))
          .find((node) => node.dataset.correctionSubject === 'city-console-memory')
        if (memory && !memory.classList.contains('is-open')) {
          memory.querySelector('.pgc-collapse__head')?.click()
        }
        memory?.querySelector('[data-knob="workMem"] input')
          ?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
        memory?.querySelector('[data-correction-link]')
          ?.dispatchEvent(new Event('pointerdown'))
      })()`,
    }, {
      name: 'Diagnose',
      path: '/observability/',
      readySelector: '[data-correction-path]',
      measureDisclosures: true,
    }, {
      name: 'Query flow',
      path: '/observability/?view=flow&statement=aggregate&setting=shared_buffers&a=4096&b=64',
      readySelector: '[data-correction-path]',
    }, {
      name: 'Machine',
      path: '/machine/',
      readySelector: '.comparison-actions [data-correction-path]',
      prepare: `(async () => {
        await window.MAGNUM.runQuery("SELECT '${SQL_SECRET}' AS private_input;")
        document.querySelector('#index-walk-open').click()
        document.querySelector('#comparison').hidden = false
        document.querySelector('#machine-version-provenance').open = true
        document.querySelector('#machine-version-provenance [data-correction-link]')
          ?.dispatchEvent(new Event('pointerdown'))
      })()`,
      sqlSecret: SQL_SECRET,
      probeMarker: true,
      measureDisclosures: true,
    }])

    expect(reports.map((report) => report.viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ])
    for (const report of reports) expect(report.subjects.length).toBeGreaterThan(0)

    const markerProbe = reports.find((report) => report.name === 'Machine')!.markerProbe
    expect(markerProbe.required).toBeDefined()
    expect(correctionCoverageFailures([{
      name: 'Required probe',
      subjects: [markerProbe.required],
      orphanPaths: [],
    }])).toEqual([
      'Required probe · TEMPORARY CLAIM-BEARING PROBE: expected 1 correction path, found 0',
    ])
    expect(correctionCoverageFailures([{
      name: 'Non-claim probe',
      subjects: markerProbe.nonClaim,
      orphanPaths: [],
    }])).toEqual([])
    expect(correctionCoverageFailures(reports)).toEqual([])
    expect(correctionActionNameFailures(reports)).toEqual([])
    expect(versionQualificationFailures(reports)).toEqual([])

    const disclosureReports = reports.flatMap(
      (report) => report.disclosureReport ? [report.disclosureReport] : [],
    )
    expect(disclosureReports.map((report) => report.name)).toEqual(['City', 'Diagnose', 'Machine'])
    expect(disclosureReports.map((report) => report.viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ])
    for (const report of disclosureReports) {
      expect(report.disclosures.length).toBeGreaterThan(0)
      expect(report.disclosures.length).toBeGreaterThanOrEqual(
        report.authoredDisclosureCount,
      )
    }
    const machineDisclosures = disclosureReports.find(
      (report) => report.name === 'Machine',
    )!
    expect(machineDisclosures.markerProbe.unmarkedIncluded).toBe(false)
    expect(disclosureFailures([{
      name: 'Marker probe',
      disclosures: [machineDisclosures.markerProbe.marked],
    }])).toEqual([
      'Marker probe · TEMPORARY DISCLOSURE PROBE: 1px is below the 9px floor',
    ])
    expect(disclosureFailures(disclosureReports)).toEqual([])

    const city = reports.find((report) => report.name === 'City')!
    const tierReports = city.tierDisclosureReports
    expect(tierReports.map((report) => report.level)).toEqual(QUALITY_LEVELS)
    expect(tierReports.map((report) => report.quality.level)).toEqual(QUALITY_LEVELS)
    for (const report of tierReports) {
      expect(report.disclosure.viewport).toEqual({ width: 390, height: 844 })
      expect(report.disclosure.disclosures.length).toBeGreaterThanOrEqual(
        report.disclosure.authoredDisclosureCount,
      )
    }
    expect(disclosureFailures(tierReports.map((report) => report.disclosure))).toEqual([])

    const inspectorBody = city.subjects
      .find((subject) => subject.label === 'city-inspector')!
      .links[0].body
    expect(inspectorBody).toContain('- Drill verdict: `passed`')
    expect(inspectorBody).toContain('- Drill level: `Full-cluster smoke (cluster)`')
    expect(inspectorBody).toContain('- Restore-to-target time: `12.5 s measured`')
    expect(inspectorBody).toContain('- recoveryTargetAge: `40 s`')
    expect(inspectorBody).toContain('- walGDownloadConcurrency: `4 workers`')
    expect(inspectorBody).not.toContain('restoreDrillFault')
    expect(inspectorBody).not.toContain('sharedBuffers')

    const consoleReports = city.subjects.filter(
      (subject) => subject.label.startsWith('city-console-'),
    )
    expect(consoleReports).toHaveLength(10)
    const memoryBody = consoleReports
      .find((subject) => subject.label === 'city-console-memory')!
      .links[0].body
    expect(memoryBody).toContain('- Panel: Simulation controls / Memory / work_mem')
    expect(memoryBody).toContain('> Per eligible executor node, never per query or connection.')
    expect(memoryBody).not.toContain('How much of the database fits in RAM')
    expect(memoryBody).not.toContain('Everything downstream scales from here')
    const poolerBody = consoleReports
      .find((subject) => subject.label === 'city-console-pooler')!
      .links[0].body
    expect(poolerBody).toContain('- Panel: Simulation controls / Connection pooler')
    expect(poolerBody).toContain('> Client admission and the PostgreSQL concurrency ceiling')

    const flowBody = reports.find((report) => report.name === 'Query flow')!
      .subjects[0].links[0].body
    expect(flowBody).toContain('- statement query parameter: `aggregate`')
    expect(flowBody).toContain('- setting query parameter: `shared_buffers`')
    expect(flowBody).toContain('- a query parameter: `4096`')
    expect(flowBody).toContain('- b query parameter: `64`')
    expect(flowBody).not.toContain('No model state included')

    const machineReport = reports.find((report) => report.name === 'Machine')!
    const machineLink = machineReport.subjects
      .find((subject) => subject.label === 'machine-workbench')!
      .links[0]
    const machineBody = machineLink.body
    expect(machineReport.sqlSecretProbe).toEqual({ transcript: true, input: false })
    expect(machineBody).toContain('Board labels: CLIENT')
    expect(machineBody).toMatch(/P measured.*shared buffer hits/i)
    expect(machineBody).toMatch(/M modelled.*stage/i)
    expect(machineBody).toMatch(/psql transcript.*not included/i)
    expect(machineBody).not.toContain(SQL_SECRET)
    expect(decodeURIComponent(machineLink.href)).not.toContain(SQL_SECRET)

    for (const report of reports) {
      for (const subject of report.subjects) {
        for (const link of subject.links) {
          expect(link.length).toBeLessThanOrEqual(CORRECTION_URL_MAX_LENGTH)
        }
      }
    }
  // Browser-slot queue time is not claim behavior; the CDP helper bounds its own waits.
  }, 0)

  it('keeps City touch targets usable at every renderer tier', async () => {
    const [tierReports] = await measureTierTouchTargetPages([{
      name: 'City',
      path: '/',
      readySelector: '.an-overlay',
      probeTouchTarget: true,
      prepare: `new Promise((resolve) => {
        document.querySelector('.tour-first__no')?.click()
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })`,
    }], QUALITY_LEVELS)

    expect(tierReports.map((report) => report.level)).toEqual(QUALITY_LEVELS)
    expect(tierReports.map((report) => report.quality.level)).toEqual(QUALITY_LEVELS)
    for (const report of tierReports) {
      expect(report.touch.viewport).toEqual({ width: 390, height: 844 })
      expect(report.touch.controls.length).toBeGreaterThan(0)
    }
    expect(touchTargetFailures(tierReports.map((report) => report.touch))).toEqual([])
    expect(touchTargetFailures([{
      name: 'Touch marker probe',
      controls: [tierReports[0].touch.probe],
    }])).toEqual([
      'Touch marker probe · #temporary-touch-target-probe: 1.00 × 1.00px is below 44 × 44px',
    ])
  // Browser-slot queue time is not touch behavior; the CDP helper bounds its own waits.
  }, 0)
})
