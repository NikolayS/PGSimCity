import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

/* Run via tools/shoot.mjs with CDP_MOBILE=1 at 390×844. Native touch delivery
   catches invisible ancestors and stacking occlusion that CSS-string tests miss. */
export async function runSequence({ send, output, logs }) {
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const screenshot = async (suffix) => writeFileSync(output.replace(/\.png$/, `-${suffix}.png`),
    Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  const target = (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect(), style = getComputedStyle(el);
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x,y);
    return { x, y, width: r.width, height: r.height, visibility: style.visibility,
      color: style.color, background: style.backgroundColor,
      reachable: el === hit || el.contains(hit), hit: hit?.className };
  })()`)
  const tap = async (selector) => {
    const rect = await target(selector)
    assert.ok(rect?.reachable, `${selector} is not a native pointer target: ${JSON.stringify(rect)}`)
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y, id: 1 }] })
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await evaluate('new Promise(resolve => setTimeout(resolve, 600))')
  }
  // Hold the model while testing disclosure so unrelated backup/checkpoint
  // notices cannot cover it between the native tap and screenshot.
  await evaluate(`window.PGSIMCITY.sim.setKnob('paused', true)`)
  // Fixed low quality avoids new software-renderer adaptive-quality notices.
  await evaluate(`window.PGSIMCITY.gfx.setQuality('low')`)
  await evaluate(`window.PGSIMCITY.bus.emit('camera:mode', { mode: 'walk' })`)
  await evaluate(`(async () => {
    for (let i = 0; i < 120 && !document.body.classList.contains('touch-walk-active'); i++)
      await new Promise(resolve => setTimeout(resolve, 250));
    if (!document.body.classList.contains('touch-walk-active')) throw new Error('touch walk did not activate');
    for (let i = 0; i < 100 && document.querySelector('.hud-toast'); i++)
      await new Promise(resolve => setTimeout(resolve, 250));
    if (document.querySelector('.hud-toast')) throw new Error('transient notices did not settle');
  })()`)
  const selectors = ['.hud-export', '#hud-top .pg-version-qualification > summary', '.touchpad__move-zone', '.touchpad__look-zone']
  const evidence = {}
  for (const selector of selectors) evidence[selector] = await target(selector)
  await screenshot('walk')
  writeFileSync(output.replace(/\.png$/, '.json'), JSON.stringify(evidence, null, 2))
  for (const selector of selectors) assert.ok(evidence[selector]?.reachable, `${selector}: ${JSON.stringify(evidence[selector])}`)
  assert.ok(evidence['.hud-export'].height >= 44)
  const exportRect = evidence['.hud-export'], qualificationRect = evidence[selectors[1]]
  assert.ok(Math.abs(exportRect.x - qualificationRect.x) >= (exportRect.width + qualificationRect.width) / 2
    || Math.abs(exportRect.y - qualificationRect.y) >= (exportRect.height + qualificationRect.height) / 2,
    'export must not overlap the model qualification')
  await tap(selectors[1])
  assert.equal(await evaluate("document.querySelector('#hud-top .pg-version-qualification').open"), true)
  await screenshot('qualification')
  await tap(selectors[1])
  assert.equal(await evaluate("document.querySelector('#hud-top .pg-version-qualification').open"), false)
  await evaluate(`window.PGSIMCITY.sim.setKnob('paused', false)`)
  const wasPaused = await evaluate('window.PGSIMCITY.sim.state.knobs.paused')
  await tap('.hud-export')
  assert.equal(await evaluate("document.querySelector('.pg-presentation').open"), true)
  assert.equal(await evaluate('window.PGSIMCITY.sim.state.knobs.paused'), true)
  await screenshot('dialog')
  await tap('.pg-presentation__actions button:last-child')
  assert.equal(await evaluate('window.PGSIMCITY.sim.state.knobs.paused'), wasPaused)
  await evaluate(`window.PGSIMCITY.sim.setKnob('paused', true)`)
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 760, deviceScaleFactor: 1, mobile: false })
  const luminance = (rgb) => rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
  for (const theme of ['day', 'night']) {
    await evaluate(`window.PGSIMCITY.setThemeMode('${theme}', { persist: false })`)
    // A compositor capture flushes styles even when headless RAF is throttled.
    await send('Page.captureScreenshot', { format: 'png' })
    await evaluate('new Promise(resolve => setTimeout(resolve, 1000))')
    await send('Page.captureScreenshot', { format: 'png' })
    const rect = await target('.hud-export')
    assert.equal(await evaluate('document.documentElement.dataset.theme'), theme)
    if (theme === 'night') assert.notEqual(rect.color, evidence.day.color, 'night palette must finish painting')
    assert.ok(rect.reachable && rect.height >= 44)
    const light = [luminance(rect.color), luminance(rect.background)].sort((a,b) => a-b)
    const contrast = (light[1] + 0.05) / (light[0] + 0.05)
    assert.ok(contrast >= 4.5, `${theme}: export contrast ${contrast}`)
    evidence[theme] = { ...rect, contrast }
    await screenshot(`desktop-${theme}`)
  }
  writeFileSync(output.replace(/\.png$/, '.json'), JSON.stringify(evidence, null, 2))
  assert.deepEqual(logs.filter(line => line.startsWith('[EXCEPTION]')), [])
  console.log('PASS: native touch disclosure toggle, export dialog, paused state and move/look hit targets')
}
