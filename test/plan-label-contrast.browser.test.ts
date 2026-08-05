import { describe, expect, it } from 'vitest'

import { SMALL_TEXT_CONTRAST_RATIO } from '../src/world/text-plane'
import { inspectRenderedPages } from './disclosure-browser.mjs'

interface Measurement {
  district: string
  label: string
  surface: string
  theme: string
  tier: string
  station: string
  contrast: number
  pixelHeight: number
}

interface Report {
  labels: number
  measurements: Measurement[]
  failures: Measurement[]
}

describe('storage plan-label contrast', () => {
  it('keeps every rendered plan label above the small-text floor', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'Storage plan-label contrast',
      path: '/',
      readySelector: '#canvas-root canvas',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 240 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not expose its browser handle')
        window.PGSIMCITY.sim.setKnob('paused', true)
      })()`,
    }], async ({ evaluate }) => evaluate(`(async () => {
      const audit = await import('/test/plan-label-contrast-browser.ts')
      return audit.measurePlanLabelContrast(window.PGSIMCITY)
    })()`)) as Report[]

    if (process.env.PLAN_CONTRAST_REPORT === '1') console.info(JSON.stringify(report, null, 2))
    if (process.env.PLAN_CONTRAST_REPORT === 'summary') {
      const unique = new Map<string, Measurement>()
      for (const measurement of report.measurements) {
        const key = [
          measurement.district,
          measurement.theme,
          measurement.label,
          measurement.surface,
        ].join('|')
        const previous = unique.get(key)
        if (!previous || measurement.contrast < previous.contrast) unique.set(key, measurement)
      }
      console.info(JSON.stringify({ labels: report.labels, pairs: [...unique.values()] }, null, 2))
    }

    expect(report.labels, 'the audit must enumerate the rendered plan-label class').toBeGreaterThan(60)
    expect(report.measurements).toHaveLength(report.labels * 2 * 5 * 2)
    const failingPairs = [...new Set(report.failures.map((failure) => (
      `${failure.district}/${failure.theme} ${JSON.stringify(failure.label)} on ${failure.surface}: ${failure.contrast}:1`
    )))]
    expect(
      report.failures,
      `normal-size plan labels must remain at least ${SMALL_TEXT_CONTRAST_RATIO}:1 against their rendered backing:\n${failingPairs.join('\n')}`,
    ).toHaveLength(0)
  }, 360_000)
})
