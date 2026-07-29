import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DETAIL_HEIGHT,
  DETAIL_WIDTH,
  MIN_DETAIL_LABEL_PX,
  RECEIPT_FOCUS,
  containBoardPoint,
  effectiveLabelPixels,
  needsCompletionFollow,
} from './mobile-board.js'

const css = readFileSync(
  fileURLToPath(new URL('./magnum.css', import.meta.url)),
  'utf8',
)
const html = readFileSync(
  fileURLToPath(new URL('./index.html', import.meta.url)),
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

  it('keeps a near-natural-scale board inside a contained pan viewport', () => {
    expect(html).toMatch(
      /class="architecture-scroll"[^>]*>\s*<div class="architecture-stage"[^>]*>\s*<canvas\s+id="machine"/,
    )
    expect(blockAfter(portrait, '.architecture-scroll')).toMatch(
      /overflow:\s*auto/,
    )
    expect(blockAfter(portrait, '.architecture-stage')).toMatch(
      new RegExp(`width:\\s*${DETAIL_WIDTH}px`),
    )
    expect(blockAfter(portrait, '.architecture-stage')).toMatch(
      new RegExp(`height:\\s*${DETAIL_HEIGHT}px`),
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
    expect(blockAfter(portrait, '.architecture-scroll.is-fit .architecture-stage'))
      .toMatch(/width:\s*100%/)
  })
})

describe('machine room mobile board camera', () => {
  it('keeps the smallest detail label at the legibility floor', () => {
    expect(effectiveLabelPixels(4, 1, false)).toBe(MIN_DETAIL_LABEL_PX)
    expect(MIN_DETAIL_LABEL_PX).toBeGreaterThanOrEqual(9)
    expect(effectiveLabelPixels(4, 0.54, true)).toBeCloseTo(2.16)
  })

  it('carries each active route point into the readable viewport', () => {
    const viewport = {
      scrollLeft: 36,
      scrollTop: 0,
      clientWidth: 390,
      clientHeight: 450,
      scrollWidth: DETAIL_WIDTH,
      scrollHeight: DETAIL_HEIGHT,
      scale: 1,
      viewX: 0,
      viewY: 0,
    }
    const output = { left: 0, top: 0 }
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
      viewport.scrollLeft = output.left
      viewport.scrollTop = output.top
      expect(x).toBeGreaterThanOrEqual(output.left)
      expect(x).toBeLessThanOrEqual(output.left + viewport.clientWidth)
      expect(y).toBeGreaterThanOrEqual(output.top)
      expect(y).toBeLessThanOrEqual(output.top + viewport.clientHeight)
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
      scrollLeft: 300,
      scrollTop: 0,
      clientWidth: 390,
      clientHeight: 410,
      scrollWidth: DETAIL_WIDTH,
      scrollHeight: DETAIL_HEIGHT,
      scale: 1,
      viewX: 0,
      viewY: 0,
    }
    const output = { left: 0, top: 0 }

    containBoardPoint(
      viewport,
      RECEIPT_FOCUS.x,
      RECEIPT_FOCUS.y,
      output,
    )

    expect(output.left).toBeLessThanOrEqual(24)
    expect(RECEIPT_FOCUS.y).toBeLessThanOrEqual(
      output.top + viewport.clientHeight,
    )
  })
})
