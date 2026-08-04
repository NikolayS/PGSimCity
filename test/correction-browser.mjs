import {
  inspectRenderedPages,
  measureDisclosurePage,
  measureTierDisclosurePage,
} from './disclosure-browser.mjs'

const MEASURE_EXPRESSION = `(() => {
  const describe = (element) => {
    if (element.dataset.correctionSubject) return element.dataset.correctionSubject
    if (element.id) return '#' + element.id
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel
    const classes = Array.from(element.classList || []).slice(0, 2)
    return element.tagName.toLowerCase() + classes.map((name) => '.' + name).join('')
  }
  const subjects = Array.from(document.querySelectorAll('[data-correction-subject]'))
    .map((element) => {
      const links = Array.from(
        element.querySelectorAll('[data-correction-path="true"] > a[data-correction-link="true"]'),
      ).map((anchor) => {
        const url = new URL(anchor.href)
        const visibleText = (anchor.innerText || anchor.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
        return {
          href: anchor.href,
          length: anchor.href.length,
          visibleText,
          accessibleName: (
            anchor.getAttribute('aria-label')
            || visibleText
          ).replace(/\s+/g, ' ').trim(),
          title: url.searchParams.get('title'),
          body: url.searchParams.get('body'),
        }
      })
      return {
        label: describe(element),
        pathCount: links.length,
        links,
      }
    })
  const paths = Array.from(document.querySelectorAll('[data-correction-path="true"]'))
  const orphanPaths = paths
    .filter((path) => !path.closest('[data-correction-subject]'))
    .map((path) => describe(path.parentElement || path))
  const unprotectedPaths = paths
    .filter((path) => !path.querySelector('a.plausible-event-name--Correction\\\\+Link\\\\+Click'))
    .map((path) => describe(path.parentElement || path))
  return { subjects, orphanPaths, unprotectedPaths }
})()`

/** Enumerate authored correction subjects from the DOM of real rendered pages. */
export async function measureCorrectionPages(pages) {
  return inspectRenderedPages(pages, async ({ evaluate, page, viewport }) => {
    const measured = await evaluate(MEASURE_EXPRESSION)
    const disclosureReport = page.measureDisclosures
      ? await measureDisclosurePage(evaluate, page, viewport)
      : undefined
    const tierDisclosureReports = page.qualityLevels
      ? await measureTierDisclosurePage(evaluate, page, viewport, page.qualityLevels)
      : undefined
    let markerProbe
    let sqlSecretProbe
    if (page.probeMarker) {
      await evaluate(`(() => {
        const required = document.createElement('section')
        required.className = 'pg-panel'
        required.dataset.correctionSubject = 'TEMPORARY CLAIM-BEARING PROBE'
        const exempt = document.createElement('section')
        exempt.className = 'pg-panel'
        exempt.id = 'temporary-non-claim-probe'
        exempt.textContent = 'TEMPORARY NON-CLAIM PROBE'
        document.body.append(required, exempt)
      })()`)
      const probed = await evaluate(MEASURE_EXPRESSION)
      await evaluate(`
        document.querySelector('[data-correction-subject="TEMPORARY CLAIM-BEARING PROBE"]')?.remove()
        document.querySelector('#temporary-non-claim-probe')?.remove()
      `)
      markerProbe = {
        required: probed.subjects.find(
          (subject) => subject.label === 'TEMPORARY CLAIM-BEARING PROBE',
        ),
        nonClaim: probed.subjects.filter(
          (subject) => subject.label === '#temporary-non-claim-probe',
        ),
      }
    }
    if (page.sqlSecret) {
      sqlSecretProbe = await evaluate(`(() => {
        const secret = ${JSON.stringify(page.sqlSecret)}
        return {
          transcript: document.querySelector('#terminal-transcript')?.textContent.includes(secret) ?? false,
          input: document.querySelector('#terminal-input')?.value.includes(secret) ?? false,
        }
      })()`)
    }
    return {
      name: page.name,
      viewport,
      ...measured,
      markerProbe,
      sqlSecretProbe,
      disclosureReport,
      tierDisclosureReports,
    }
  })
}

export function correctionCoverageFailures(reports) {
  const failures = []
  for (const report of reports) {
    for (const subject of report.subjects) {
      if (subject.pathCount !== 1) {
        failures.push(
          `${report.name} · ${subject.label}: expected 1 correction path, found ${subject.pathCount}`,
        )
      }
    }
    for (const label of report.orphanPaths) {
      failures.push(
        `${report.name} · ${label}: correction path has no claim-bearing panel marker`,
      )
    }
    for (const label of report.unprotectedPaths ?? []) {
      failures.push(
        `${report.name} · ${label}: correction path lacks the Plausible opt-out class`,
      )
    }
  }
  return failures
}

/** Every rendered correction path must name the deliberate reporting action. */
export function correctionActionNameFailures(reports) {
  const failures = []
  for (const report of reports) {
    for (const subject of report.subjects) {
      for (const link of subject.links) {
        if (!/\b(?:report|file|submit)\b/iu.test(link.visibleText)) {
          failures.push(
            `${report.name} · ${subject.label}: visible text does not convey a reporting action`,
          )
        }
        if (!/\b(?:report|file|submit)\b/iu.test(link.accessibleName)) {
          failures.push(
            `${report.name} · ${subject.label}: accessible name does not convey a reporting action`,
          )
        }
      }
    }
  }
  return failures
}
