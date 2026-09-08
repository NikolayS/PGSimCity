import { describe, expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

describe('phone heap anatomy', () => {
  it('keeps writer text and every version card within their layout cells', async () => {
    const reports = await inspectRenderedPages([{ name: 'anatomy', path: '/', readySelector: '.hud-theme', reducedMotion: true }], async ({ evaluate, send }) => {
      await evaluate(`(async () => {
        while (!window.PGSIMCITY || !document.querySelector('.an-overlay')) await new Promise(r => setTimeout(r, 50))
        const app = window.PGSIMCITY
        app.sim.runScenario('vacuum-blockade')
        for (let i = 0; i < 2400; i++) app.sim.update(1/30)
        app.sim.setKnob('paused', true)
        app.bus.emit('anatomy:open', { view: 'page', id: 'storage.table.sessions' })
        await new Promise(r => setTimeout(r, 150))
        // Stress the rendered layout with a long version chain, as in the phone report.
        const lane = document.querySelector('.an-mvcc-lane')
        const template = lane.querySelector('.an-mvcc-version')
        if (!template) throw Error('No live version card available')
        while (lane.querySelectorAll('.an-mvcc-version').length < 8) lane.append(template.cloneNode(true))
      })()`)
      const result = []
      for (const width of [390, 320, 540]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
        result.push(await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
          const writer = document.querySelector('.an-mvcc-update')
          const transition = document.querySelector('.an-mvcc-transition')
          const lane = document.querySelector('.an-mvcc-lane')
          const cards = [...lane.querySelectorAll('.an-mvcc-version')]
          const wr = writer.getBoundingClientRect(), tr = transition.getBoundingClientRect()
          const lr = lane.getBoundingClientRect()
          resolve({
            width: innerWidth,
            populated: cards.length > 1 && lr.width > 200 && tr.height > 0,
            writerFits: wr.left >= tr.left - 1 && wr.right <= tr.right + 1,
            versionsFit: cards.every(card => { const r = card.getBoundingClientRect(); return r.left >= lr.left - 1 && r.right <= lr.right + 1 }),
            noHorizontalScroll: lane.scrollWidth <= lane.clientWidth + 1,
          })
        }))`))
      }
      return result
    })
    expect(reports).toEqual([[390, 320, 540].map(width => ({ width, populated: true, writerFits: true, versionsFit: true, noHorizontalScroll: true }))])
  }, 180_000)
})
