import { writeFileSync } from 'node:fs'
export async function runSequence({ send, output, logs }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await evaluate("window.PGSIMCITY.sim.reset();window.PGSIMCITY.sim.setKnob('paused',true)")
  const report = []
  for (const [width,height,quality] of [[1440,900,'high'],[1280,800,'medium'],[390,844,'low'],[768,1024,'medium']]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width===390})
    await evaluate(`window.PGSIMCITY.bus.emit('quality',{level:'${quality}'});window.PGSIMCITY.rig.home(true)`)
    for (const theme of ['day','night']) {
      await evaluate(`for(let i=0;i<3&&window.PGSIMCITY.themeMode()!=='${theme}';i++) document.querySelector('.hud-theme').click()`)
      await wait(12000)
      const path = output.replace('.png',`-${width}-${theme}.png`)
      writeFileSync(path,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
      report.push(await evaluate(`({width:innerWidth,theme:window.PGSIMCITY.themeMode(),quality:window.PGSIMCITY.gfx.quality.level,fps:window.PGSIMCITY.gfx.fps,visibleLabels:[...document.querySelectorAll('.lbl')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).opacity!=='0').map(e=>e.textContent),bodyWidth:document.body.scrollWidth})`))
    }
  }
  writeFileSync(output.replace('.png','.json'),JSON.stringify({report,logs},null,2))
}
