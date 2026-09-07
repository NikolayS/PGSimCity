import { expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps medium night HDR pixels finite after daylight', async () => {
  const [result] = await inspectRenderedPages([{
    name: 'Medium theme transition', path: '/', readySelector: '.hud-theme',
  }], async ({ evaluate, send }) => {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 760, deviceScaleFactor: 1, mobile: false,
    })
    await evaluate(`(() => {
      const p = window.PGSIMCITY
      const render = p.gfx.render.bind(p.gfx)
      // Pin the requested tier for this correctness check, not a performance test.
      p.gfx.render = dt => render(dt, 1 / 60)
      p.sim.setKnob('paused', true)
      for (let i = 0; i < 3 && p.themeMode() !== 'day'; i++) document.querySelector('.hud-theme').click()
      p.gfx.setQuality('medium')
      p.bus.emit('focus', { id: 'backend.7', instant: true })
    })()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    return evaluate(`new Promise(resolve => {
      const p = window.PGSIMCITY, r = p.gfx.renderer
      for (let i = 0; i < 3 && p.themeMode() !== 'night'; i++) document.querySelector('.hud-theme').click()
      p.bus.emit('focus', { id: 'backend.row', instant: true })
      const original = r.render.bind(r)
      let nesting = 0
      r.render = (scene, camera) => {
        nesting++
        original(scene, camera)
        nesting--
        const target = r.getRenderTarget()
        if (scene !== p.gfx.scene || nesting !== 0 || !target) return
        r.render = original
        const pixels = new Uint16Array(target.width * target.height * 4)
        r.readRenderTargetPixels(target, 0, 0, target.width, target.height, pixels)
        let nonfinite = 0, colored = 0
        for (let i = 0; i < pixels.length; i++) {
          if (i % 4 === 3) continue
          // IEEE 754 binary16: all-one exponent represents infinity or NaN.
          if ((pixels[i] & 0x7c00) === 0x7c00) nonfinite++
          if (pixels[i] > 0) colored++
        }
        resolve({ nonfinite, colored, type: target.texture.type,
          quality: p.gfx.quality.level, theme: p.themeMode() })
      }
    })`)
  })
  expect(result.quality).toBe('medium')
  expect(result.theme).toBe('night')
  expect(result.type).toBe(1016) // THREE.HalfFloatType
  expect(result.colored).toBeGreaterThan(1000)
  expect(result.nonfinite).toBe(0)
}, 180_000)
