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
      await wait(18000)
      const path = output.replace('.png',`-${width}-${theme}.png`)
      writeFileSync(path,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
      report.push(await evaluate(`({width:innerWidth,theme:window.PGSIMCITY.themeMode(),quality:window.PGSIMCITY.gfx.quality.level,fps:window.PGSIMCITY.gfx.fps,visibleLabels:[...document.querySelectorAll('.lbl')].filter(e=>e.getBoundingClientRect().width&&getComputedStyle(e).opacity!=='0').map(e=>e.textContent),bodyWidth:document.body.scrollWidth})`))
    }
  }
  let interactions
  if (output.endsWith('/after.png')) {
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true})
    await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5})
    await evaluate("window.PGSIMCITY.rig.home(true);window.PGSIMCITY.bus.emit('quality',{level:'low'})")
    await wait(18000)
    await evaluate("window.PGSIMCITY.bus.emit('toast',{text:'Frame rate stayed low — bloom lighting disabled. Bright-colour fallback is active.',kind:'warn',ms:60000,action:{label:'Restore high',quality:'high'}})")
    await wait(1500)
    const point = await evaluate("(()=>{const e=document.querySelector('#city-version-provenance summary'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]})
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    await wait(1500)
    interactions = await evaluate("({qualificationOpen:document.querySelector('#city-version-provenance details').open,warningVisible:!!document.querySelector('.hud-toast--warn')})")
    writeFileSync(output.replace('.png','-390-warning-qualification.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
    if (!interactions.qualificationOpen || !interactions.warningVisible) throw new Error('Qualification touch acceptance failed')
  }
  writeFileSync(output.replace('.png','.json'),JSON.stringify({report,interactions,logs},null,2))
}
