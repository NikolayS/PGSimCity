import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  disclosureFailures,
  measureDisclosurePages,
  measureTouchTargetPages,
  touchTargetFailures,
} from '../test/disclosure-browser.mjs'

import {
  BOARD_MAX_SCALE,
  DETAIL_HEIGHT,
  DETAIL_WIDTH,
  MIN_DETAIL_LABEL_PX,
  RECEIPT_FOCUS,
  clampBoardView,
  containBoardPoint,
  effectiveLabelPixels,
  fitBoardScale,
  needsCompletionFollow,
  shouldFocusBoardAfterSubmit,
  zoomBoardView,
} from './mobile-board.js'

const css = readFileSync(
  fileURLToPath(new URL('./magnum.css', import.meta.url)),
  'utf8',
)
const html = readFileSync(
  fileURLToPath(new URL('./index.html', import.meta.url)),
  'utf8',
)
const script = readFileSync(
  fileURLToPath(new URL('./magnum.js', import.meta.url)),
  'utf8',
)

function blockAfter(source, marker) {
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const openingBrace = source.indexOf('{', start)
  if (openingBrace < 0) return ''
  let depth = 1
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(openingBrace + 1, index)
  }
  return ''
}

describe('machine room portrait layout', () => {
  const portrait = blockAfter(
    css,
    '@media (max-width: 760px), (max-width: 900px) and (max-height: 500px) and (hover: none) and (pointer: coarse)',
  )

  it('replaces the desktop split with one full-width portrait column', () => {
    expect(portrait).not.toBe('')
    expect(blockAfter(portrait, '.workbench')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
    expect(portrait).not.toMatch(/44%|56%/)
  })

  it('keeps the camera canvas inside a contained gesture viewport', () => {
    expect(html).toMatch(
      /class="architecture-scroll"[^>]*>\s*<div class="architecture-stage"[^>]*>\s*<canvas\s+id="machine"/,
    )
    expect(blockAfter(portrait, '.architecture-scroll')).toMatch(
      /overflow:\s*hidden/,
    )
    expect(blockAfter(portrait, '.architecture-scroll')).toMatch(
      /touch-action:\s*none/,
    )
    expect(DETAIL_WIDTH).toBe(720)
    expect(DETAIL_HEIGHT).toBe(900)
  })

  it('accounts for every phone safe-area edge', () => {
    expect(portrait).toContain('env(safe-area-inset-top)')
    expect(portrait).toContain('env(safe-area-inset-right)')
    expect(portrait).toContain('env(safe-area-inset-bottom)')
    expect(portrait).toContain('env(safe-area-inset-left)')
  })

  it('offers both a one-to-one detail view and a whole-board overview', () => {
    expect(html).toMatch(/<button[^>]+id="board-view"[^>]*>FIT BOARD<\/button>/)
    expect(html).toMatch(
      /<button[^>]+id="board-follow"[^>]*>FOLLOW: ON<\/button>/,
    )
  })

  it('keeps the viewing-speed control thumb-sized without taking board height', () => {
    expect(html).toMatch(/aria-label="Viewing speed"/)
    expect(html).toMatch(/id="machine-slower"/)
    expect(html).toMatch(/id="machine-rate"/)
    expect(html).toMatch(/id="machine-faster"/)
    expect(blockAfter(portrait, '.viewing-rate button')).toMatch(
      /min-(?:block-size|height):\s*44px/,
    )
    expect(blockAfter(portrait, '.viewing-rate button')).toMatch(
      /margin-block:\s*-8px/,
    )
    expect(blockAfter(portrait, '.control-rack')).not.toMatch(/flex-wrap:\s*wrap/)
    expect(blockAfter(portrait, '#clock')).toMatch(/display:\s*none/)
  })

  it('documents the city rate keys beside the existing board pause hint', () => {
    expect(html).toMatch(/SPACE[^<]+PAUSES[^<]+,[^<]+\/[^<]+\.[^<]+VIEW SPEED/)
  })

  it('keeps comparison boards readable as a labelled swipe pair', () => {
    expect(html).toMatch(/id="comparison-open"/)
    expect(html).toMatch(/id="comparison"[^>]+hidden/)
    expect(html).toMatch(/class="comparison-lanes"/)
    expect(html.match(/class="comparison-board"/g)).toHaveLength(2)
    expect(html).toMatch(/aria-label="Choose comparison board"/)
    expect(html).toMatch(/id="comparison"[^>]+role="dialog"[^>]+aria-modal="true"/)
    expect(html).toMatch(/id="index-walk"[^>]+role="dialog"[^>]+aria-modal="true"/)

    const lanes = blockAfter(portrait, '.comparison-lanes')
    expect(lanes).toMatch(/grid-auto-flow:\s*column/)
    expect(lanes).toMatch(/overflow-x:\s*auto/)
    expect(lanes).toMatch(/scroll-snap-type:\s*x\s+mandatory/)
    expect(blockAfter(portrait, '.comparison-board canvas')).toMatch(/width:\s*720px/)
  })

  it('puts the persistent modelled finding and source key before either animated board', () => {
    const proofAt = html.indexOf('id="comparison-proof"')
    const boardsAt = html.indexOf('class="comparison-lanes"')
    expect(proofAt).toBeGreaterThan(0)
    expect(boardsAt).toBeGreaterThan(proofAt)
    expect(html).toMatch(/<b class="source-medallion model-source" role="img" aria-label="Modelled source">M<\/b>\s*MODELLED FINDING/)
    expect(html).toMatch(/class="comparison-source-key"[^>]+aria-label="Data source key"/)
    expect(html).toMatch(/id="comparison-pglite-disclosure"/)
    expect(html).toMatch(/id="comparison-replay-disclosure"/)
    expect(html).toMatch(/id="comparison"[^>]+aria-describedby="comparison-pglite-disclosure comparison-replay-disclosure"/)
    expect(script).toMatch(
      /comparisonPgliteDisclosure\.textContent\s*=\s*SYNCHRONOUS_COMMIT_COMPARISON_CLAIM\.pgliteDisclosure/,
    )
    expect(script).toMatch(
      /comparisonReplayDisclosure\.textContent\s*=\s*SYNCHRONOUS_COMMIT_COMPARISON_CLAIM\.replayDisclosure/,
    )
  })

  it('spells out source medallions and associates qualifications with their claims', () => {
    expect(html.match(/aria-label="PostgreSQL source"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(html.match(/aria-label="Modelled source"/g)?.length).toBeGreaterThanOrEqual(4)
    expect(html).toMatch(/id="comparison-proof"[^>]+aria-describedby="comparison-pglite-disclosure"/)
    expect(html).toMatch(/id="index-walk-finding"[^>]+aria-describedby="index-walk-sequence index-walk-model index-walk-comparison"/)
    expect(html).toMatch(/id="terminal-transcript"[^>]+role="log"/)
  })

  it('describes one measured execution replayed through two modelled policies', () => {
    expect(html).toMatch(/DOCUMENTED BEHAVIOUR \/ MODELLED REPLAY/)
    expect(html).toMatch(/ONE P EXECUTION\. TWO M COMMIT POLICIES\./)
    expect(`${html}\n${script}`).not.toMatch(
      /CONTROLLED EXPERIMENT|ONE SETTING CHANGED|RUN CONTROLLED COMPARISON|EXPERIMENT COMPLETE/,
    )
  })

  it('offers a sequential first-query walk while keeping the board visible', () => {
    expect(html).toMatch(/<button[^>]+id="index-walk-open"[^>]*>START HERE<\/button>/)
    expect(html).toMatch(/id="index-walk"[^>]+hidden/)
    expect(html.match(/data-index-walk-step=/g)).toHaveLength(4)
    expect(html).toMatch(/data-disclosure="index-walk-sequence"/)
    expect(html).toMatch(/data-disclosure="index-walk-model"/)
    expect(html).toMatch(/data-disclosure="index-walk-comparison"/)
    expect(html).toMatch(/id="index-walk"[^>]+aria-describedby="index-walk-sequence index-walk-model index-walk-comparison"/)
    expect(html).toMatch(/partial index is a path for some queries, not every query/)
    expect(html).toMatch(/OMIT THE PARTIAL-INDEX PREDICATE/)
    expect(html).toMatch(/requires the query to imply balance &gt; 0/)
    expect(script).toMatch(/matchingIndexWalkStep\(report\)/)
    expect(script).toMatch(/createIndexWalkEvidence\(step\.id, report\)/)

    const walk = blockAfter(portrait, '.index-walk')
    expect(walk).toMatch(/inset:\s*auto\s+0\s+0/)
    expect(walk).toMatch(/max-height:\s*48dvh/)
  })

  it('keeps every rendered touch control thumb-sized and hit-testable at 390px', async () => {
    const reports = await measureTouchTargetPages([{
      name: 'Machine',
      path: '/machine/',
      readySelector: '#comparison-open',
      probeTouchTarget: true,
    }, {
      name: 'City',
      path: '/',
      readySelector: '.control-center__sources',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 120 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!window.PGSIMCITY) throw new Error('city API did not become ready')
      })()`,
    }, {
      name: 'Diagnose',
      path: '/observability/',
      readySelector: '.top',
    }])

    expect(reports.map((report) => report.viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ])
    for (const report of reports) expect(report.controls.length).toBeGreaterThan(0)
    expect(touchTargetFailures([{
      name: 'Probe',
      controls: [reports[0].probe],
    }])).toEqual([
      'Probe · #temporary-touch-target-probe: 1.00 × 1.00px is below 44 × 44px',
    ])
    expect(touchTargetFailures(reports)).toEqual([])
  }, 90_000)

  it('keeps every marked honesty disclosure visible and legible at 390px', async () => {
    const reports = await measureDisclosurePages([{
      name: 'Machine',
      path: '/machine/',
      readySelector: '[data-disclosure="comparison-framing"]',
      prepare: `
        document.querySelector('#index-walk-open').click()
        document.querySelector('#comparison').hidden = false
      `,
      probeMarker: true,
    }, {
      name: 'City',
      path: '/',
      readySelector: '.control-center__sources',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 120 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!window.PGSIMCITY) throw new Error('city API did not become ready')
        document.querySelector('.control-center').hidden = false
        document.querySelector('#hud-latency-panel').hidden = false
        window.PGSIMCITY.bus.emit('select', { id: 'recovery.ground' })
      })()`,
    }, {
      name: 'City pooler',
      path: '/',
      readySelector: '.control-center__sources',
      prepare: `(async () => {
        for (let attempt = 0; attempt < 120 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (!window.PGSIMCITY) throw new Error('city API did not become ready')
        document.querySelector('.control-center').hidden = false
        document.querySelector('#hud-latency-panel').hidden = false
        window.PGSIMCITY.bus.emit('select', { id: 'client.pooler' })
      })()`,
    }])

    expect(reports.map((report) => report.viewport)).toEqual([
      { width: 390, height: 844 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ])
    for (const report of reports) {
      expect(report.disclosures.length).toBeGreaterThan(0)
      expect(report.disclosures.length).toBeGreaterThanOrEqual(
        report.authoredDisclosureCount,
      )
    }
    expect(reports[2].disclosures.map((disclosure) => disclosure.id)).toEqual(
      expect.arrayContaining([
        'connection-pooler-model-scope',
        'pooler-client-count-scope',
        'pool-mode-cost',
        'default-pool-size-scope',
        'max-client-conn-scope',
        'query-wait-timeout-semantics',
      ]),
    )
    expect(reports[0].markerProbe.unmarkedIncluded).toBe(false)
    expect(disclosureFailures([{
      name: 'Marker probe',
      disclosures: [reports[0].markerProbe.marked],
    }])).toEqual([
      'Marker probe · TEMPORARY DISCLOSURE PROBE: 1px is below the 9px floor',
    ])
    expect(disclosureFailures(reports)).toEqual([])
  }, 90_000)

  it('keeps the deferred-flush risk state readable outside the mobile canvas', () => {
    expect(html).toMatch(
      /data-comparison-note="b">EARLY ACK; CRASH CAN LOSE RECENT ACKS UNTIL WAL FLUSH/,
    )
    expect(script).toMatch(/WAL FLUSH COMPLETE; LOSS WINDOW CLOSED/)
  })
})

describe('machine room landscape layout', () => {
  const portrait = blockAfter(
    css,
    '@media (max-width: 760px), (max-width: 900px) and (max-height: 500px) and (hover: none) and (pointer: coarse)',
  )
  const landscape = blockAfter(
    css,
    '@media (max-width: 900px) and (max-height: 500px) and (orientation: landscape) and (hover: none) and (pointer: coarse)',
  )

  it('keeps the touch viewing-speed control reachable beside the board toolbar', () => {
    expect(blockAfter(landscape, '.control-rack')).toMatch(/display:\s*flex/)
    expect(blockAfter(landscape, '.architecture-readout')).toMatch(
      /padding-right:\s*216px/,
    )
  })

  it('preserves the 72px collapsed terminal without overflowing its fixed rows', () => {
    expect(blockAfter(landscape, '.terminal')).toMatch(/height:\s*72px/)
    expect(blockAfter(landscape, '.terminal')).toMatch(/min-height:\s*72px/)
    expect(blockAfter(portrait, '.terminal-header')).toMatch(/min-height:\s*32px/)
    expect(blockAfter(portrait, '.terminal-entry')).toMatch(/min-height:\s*38px/)
  })
})

describe('machine room mobile terminal', () => {
  const coarsePointer = blockAfter(css, '@media (pointer: coarse)')

  it('keeps every focusable terminal field at the iOS-safe font size', () => {
    const focusableFields = blockAfter(
      coarsePointer,
      '.terminal-entry :is(input, textarea, select, button)',
    )

    expect(focusableFields).toMatch(/font-size:\s*16px/)
  })

  it('hands successful phone statements to the board without disrupting desktop or errors', () => {
    expect(shouldFocusBoardAfterSubmit(true, true, false)).toBe(true)
    expect(shouldFocusBoardAfterSubmit(false, true, false)).toBe(false)
    expect(shouldFocusBoardAfterSubmit(true, false, false)).toBe(false)
    expect(shouldFocusBoardAfterSubmit(true, true, true)).toBe(false)
  })

  it('dismisses the phone prompt when a statement starts and applies the final focus decision', () => {
    expect(script).toMatch(
      /terminalInput\.blur\(\)[\s\S]*canvas\.focus\(\{\s*preventScroll:\s*true\s*\}\)/,
    )
    expect(script).toMatch(
      /shouldFocusBoardAfterSubmit\(\s*mobileBoard,\s*isStatement,\s*output\.classList\.contains\('error'\),?\s*\)/,
    )
  })
})

describe('machine room mobile board camera', () => {
  const phoneFit = fitBoardScale(390, 500)

  it('bounds zoom from the whole board to naturally legible smallest type', () => {
    expect(phoneFit).toBeCloseTo(390 / DETAIL_WIDTH)
    expect(BOARD_MAX_SCALE).toBe(MIN_DETAIL_LABEL_PX / 4)
    expect(BOARD_MAX_SCALE).toBeGreaterThan(1)
  })

  it('drops small detail at overview and reveals it continuously by one-to-one', () => {
    expect(effectiveLabelPixels(4, phoneFit, phoneFit)).toBe(0)
    expect(effectiveLabelPixels(9, phoneFit, phoneFit)).toBe(MIN_DETAIL_LABEL_PX)
    expect(effectiveLabelPixels(6.5, 0.75, phoneFit)).toBe(0)
    expect(effectiveLabelPixels(7, 0.75, phoneFit)).toBe(MIN_DETAIL_LABEL_PX)
    expect(effectiveLabelPixels(4, 1, phoneFit)).toBe(MIN_DETAIL_LABEL_PX)
    expect(effectiveLabelPixels(4, BOARD_MAX_SCALE, phoneFit))
      .toBeCloseTo(MIN_DETAIL_LABEL_PX)
    expect(MIN_DETAIL_LABEL_PX).toBeGreaterThanOrEqual(9)
  })

  it('keeps a pinch midpoint over the same board point while fingers move', () => {
    const viewport = {
      clientWidth: 390,
      clientHeight: 500,
      scale: 1,
      viewX: -100,
      viewY: -200,
    }
    const output = { scale: 0, viewX: 0, viewY: 0 }

    expect(zoomBoardView(
      viewport,
      1.5,
      100,
      100,
      120,
      110,
      phoneFit,
      output,
    )).toBe(output)
    expect(output.scale).toBe(1.5)
    expect((120 - output.viewX) / output.scale).toBeCloseTo(200)
    expect((110 - output.viewY) / output.scale).toBeCloseTo(300)
  })

  it('clamps drag panning without exposing space beyond the board', () => {
    const viewport = {
      clientWidth: 390,
      clientHeight: 500,
      scale: 1,
      viewX: -100,
      viewY: -200,
    }
    const output = { scale: 0, viewX: 0, viewY: 0 }

    clampBoardView(viewport, 800, -900, output)
    expect(output.viewX).toBe(0)
    expect(output.viewY).toBe(500 - DETAIL_HEIGHT)
    expect(output.scale).toBe(1)
  })

  it('carries each active route point into the readable viewport', () => {
    const viewport = {
      clientWidth: 390,
      clientHeight: 450,
      scale: 1,
      viewX: -36,
      viewY: 0,
    }
    const output = { scale: 0, viewX: 0, viewY: 0 }
    const route = [
      [124, 128],
      [277, 225],
      [600, 211],
      [252, 402],
      [245, 625],
      [245, 704],
      [RECEIPT_FOCUS.x, RECEIPT_FOCUS.y],
    ]

    for (const [x, y] of route) {
      expect(containBoardPoint(viewport, x, y, output)).toBe(output)
      viewport.viewX = output.viewX
      viewport.viewY = output.viewY
      const screenX = viewport.viewX + x
      const screenY = viewport.viewY + y
      expect(screenX).toBeGreaterThanOrEqual(0)
      expect(screenX).toBeLessThanOrEqual(viewport.clientWidth)
      expect(screenY).toBeGreaterThanOrEqual(0)
      expect(screenY).toBeLessThanOrEqual(viewport.clientHeight)
    }
  })

  it('re-arms the receipt follow when the terminal changes viewport height', () => {
    expect(needsCompletionFollow('complete')).toBe(true)
    expect(needsCompletionFollow('error')).toBe(true)
    expect(needsCompletionFollow('replaying')).toBe(false)
    expect(needsCompletionFollow('idle')).toBe(false)
  })

  it('frames the readable left edge of the receipt rather than its wide center', () => {
    const viewport = {
      clientWidth: 390,
      clientHeight: 410,
      scale: 1,
      viewX: -300,
      viewY: 0,
    }
    const output = { scale: 0, viewX: 0, viewY: 0 }

    containBoardPoint(
      viewport,
      RECEIPT_FOCUS.x,
      RECEIPT_FOCUS.y,
      output,
    )

    expect(output.viewX).toBeGreaterThanOrEqual(-24)
    expect(output.viewY + RECEIPT_FOCUS.y)
      .toBeLessThanOrEqual(viewport.clientHeight)
  })

  it('wires pointer-id gestures and cancelable wheel input on the board owner', () => {
    expect(script).toMatch(
      /architectureScroll\.addEventListener\('pointerdown',\s*onBoardPointerDown\)/,
    )
    expect(script).toMatch(
      /architectureScroll\.addEventListener\('wheel',\s*onBoardWheel,\s*\{\s*passive:\s*false\s*\}\)/,
    )
  })
})
