import { describe, expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

describe('paused workload stepping', () => {
  it('supports keyboard stepping and a visible phone control without changing speed or pause', async () => {
    const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-play', reducedMotion: true }], async ({ evaluate, send }) => {
      await evaluate(`(async () => {
        while (!window.PGSIMCITY) await new Promise(r => setTimeout(r, 50))
      })()`)
      const initial = await evaluate(`(() => {
        const b = document.querySelector('.hud-step')
        if (!b) throw Error('Missing model-step control')
        b.focus()
        return { active: document.activeElement.className, hidden: b.hidden, paused: window.PGSIMCITY.sim.state.knobs.paused, t: window.PGSIMCITY.sim.state.t, speed: window.PGSIMCITY.sim.state.knobs.timeScale }
      })()`)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
      const after = await evaluate(`({ t: window.PGSIMCITY.sim.state.t, paused: window.PGSIMCITY.sim.state.knobs.paused, speed: window.PGSIMCITY.sim.state.knobs.timeScale })`)
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
      const phone = await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
        const b = document.querySelector('.hud-step'); const r = b.getBoundingClientRect()
        resolve({ text: b.textContent, visible: r.width > 0 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth, x: r.x + r.width/2, y: r.y + r.height/2 })
      }))`)
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: phone.x, y: phone.y }] })
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      const touch = await evaluate(`({ t: window.PGSIMCITY.sim.state.t, paused: window.PGSIMCITY.sim.state.knobs.paused })`)
      return { initial, after, phone, touch }
    })
    const r = reports[0]
    expect(r.after.t - r.initial.t).toBeCloseTo(0.1, 10)
    expect(r.after.paused).toBe(true)
    expect(r.after.speed).toBe(r.initial.speed)
    expect(r.phone.visible).toBe(true)
    expect(r.phone.text).toContain('0.1 model s')
    expect(r.touch.t - r.after.t).toBeCloseTo(0.1, 10)
    expect(r.touch.paused).toBe(true)
  }, 180_000)
})
