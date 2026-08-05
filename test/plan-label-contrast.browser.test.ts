import { describe, expect, it } from 'vitest'

import { SMALL_TEXT_CONTRAST_RATIO } from '../src/world/text-plane'
import { inspectRenderedPages } from './disclosure-browser.mjs'

const PLAN_LABEL_INK_CONTRAST_RATIO = 10.25
const PLAN_LABEL_MIN_PIXEL_HEIGHT = 17.5
const SEMANTIC_CARRIER_LUMINANCE = 0.24
const SEMANTIC_CARRIER_MIN_PIXEL_WIDTH = 6

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

interface SemanticMeasurement {
  district: string
  label: string
  surface: string
  theme: string
  tier: string
  station: string
  semanticLuminance: number
  semanticContrast: number
  semanticPixelWidth: number
  semanticPixelHeight: number
  semanticSized: boolean
  semanticProtected: boolean
  semanticBlooms: boolean
}

interface Report {
  labels: number
  semanticCarriers: number
  measurements: Measurement[]
  semanticMeasurements: SemanticMeasurement[]
}

describe('storage plan-label contrast', () => {
  it('keeps label ink and semantic carriers legible in every renderer path', async () => {
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
      const semantic = new Map<string, SemanticMeasurement>()
      for (const measurement of report.semanticMeasurements) {
        const key = [
          measurement.district,
          measurement.theme,
          measurement.label,
          measurement.surface,
        ].join('|')
        const previous = semantic.get(key)
        if (!previous || measurement.semanticLuminance < previous.semanticLuminance) {
          semantic.set(key, measurement)
        }
      }
      console.info(JSON.stringify({
        labels: report.labels,
        semanticCarriers: report.semanticCarriers,
        pairs: [...unique.values()],
        semanticPairs: [...semantic.values()],
      }, null, 2))
    }

    expect(report.labels, 'the audit must enumerate every rendered plan label').toBe(107)
    expect(report.measurements).toHaveLength(2_140)

    const inkFailures = report.measurements.filter((measurement) => (
      measurement.contrast < PLAN_LABEL_INK_CONTRAST_RATIO
      || measurement.pixelHeight < PLAN_LABEL_MIN_PIXEL_HEIGHT
    ))
    const failingPairs = [...new Set(inkFailures.map((failure) => (
      `${failure.district}/${failure.theme} ${JSON.stringify(failure.label)} on ${failure.surface}: ${failure.contrast.toFixed(2)}:1, ${failure.pixelHeight.toFixed(1)} px`
    )))]
    expect(
      inkFailures,
      `plan-label ink must remain at least ${PLAN_LABEL_INK_CONTRAST_RATIO}:1 and ${PLAN_LABEL_MIN_PIXEL_HEIGHT} px tall:\n${failingPairs.join('\n')}`,
    ).toHaveLength(0)

    expect(report.semanticCarriers, 'the audit must enumerate every meaning-bearing label colour').toBe(36)
    expect(report.semanticMeasurements).toHaveLength(report.semanticCarriers * 2 * 5 * 2)
    const semanticPhotometryFailures = report.semanticMeasurements.filter((measurement) => (
      measurement.semanticLuminance < SEMANTIC_CARRIER_LUMINANCE
      || measurement.semanticContrast < SMALL_TEXT_CONTRAST_RATIO
    ))
    const darkestSemanticPairs = new Map<string, SemanticMeasurement>()
    for (const failure of semanticPhotometryFailures) {
      const key = `${failure.district}|${failure.label}`
      const previous = darkestSemanticPairs.get(key)
      if (!previous || failure.semanticLuminance < previous.semanticLuminance) {
        darkestSemanticPairs.set(key, failure)
      }
    }
    const failingSemanticPairs = [...darkestSemanticPairs.values()].map((failure) => (
      `${failure.district} ${JSON.stringify(failure.label)}: luminance ${failure.semanticLuminance.toFixed(3)}, contrast ${failure.semanticContrast.toFixed(2)}:1`
    ))
    expect(
      semanticPhotometryFailures,
      `semantic carriers must meet the ${SEMANTIC_CARRIER_LUMINANCE} luminance and ${SMALL_TEXT_CONTRAST_RATIO}:1 backing floors:\n${failingSemanticPairs.join('\n')}`,
    ).toHaveLength(0)

    const semanticDeliveryFailures = report.semanticMeasurements.filter((measurement) => (
      measurement.semanticPixelWidth < SEMANTIC_CARRIER_MIN_PIXEL_WIDTH
      || measurement.semanticPixelHeight < SEMANTIC_CARRIER_MIN_PIXEL_WIDTH
      || !measurement.semanticSized
      || !measurement.semanticProtected
      || (measurement.theme === 'night' && measurement.tier !== 'low' && !measurement.semanticBlooms)
    ))
    const failingDeliveryPairs = [...new Set(semanticDeliveryFailures.map((failure) => (
      `${failure.district} ${JSON.stringify(failure.label)}: ${failure.semanticPixelWidth.toFixed(1)} × ${failure.semanticPixelHeight.toFixed(1)} px, sized ${failure.semanticSized}, themed ${failure.semanticProtected}, bloom ${failure.semanticBlooms}`
    )))]
    expect(
      semanticDeliveryFailures,
      `semantic carriers must remain substantial, themed, and emissive where bloom exists:\n${failingDeliveryPairs.join('\n')}`,
    ).toHaveLength(0)
  }, 360_000)
})
