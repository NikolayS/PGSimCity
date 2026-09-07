import { writeFileSync } from 'node:fs'
export async function runSequence({send,output,logs}) {
 const wait=ms=>new Promise(r=>setTimeout(r,ms))
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 const build=await ev(`document.querySelector('[aria-label^="PGSimCity build"]')?.getAttribute('aria-label')`)
 // Capture-only staging: prevent adaptive downgrade races, never benchmark this run.
 await ev(`(()=>{const p=window.PGSIMCITY;const render=p.gfx.render.bind(p.gfx);p.gfx.render=(dt)=>render(dt,1/60);p.sim.reset();p.sim.setKnob('paused',true);p.rig.home(true);})()`)
 const states=[]
 const probe=`(()=>{const p=window.PGSIMCITY;return {theme:p.themeMode(),quality:p.gfx.quality.level,camera:p.gfx.camera.position.toArray(),shadowEnabled:p.gfx.renderer.shadowMap.enabled,frame:p.gfx.renderer.info.render.frame,canvas:!!document.querySelector('#canvas-root canvas')}})()`
 const requestedStates=process.env.CAPTURE_PHONE==='1' ? [['day','low','home'],['night','low','backend.row']] : [['day','high','home'],['day','medium','home'],['day','medium','backend.row'],['day','medium','backend.7'],['night','medium','backend.row'],['night','low','home']]
 for(const [theme,quality,focus] of requestedStates) {
  await ev(`(()=>{const p=window.PGSIMCITY;for(let i=0;i<3&&p.themeMode()!=='${theme}';i++)document.querySelector('.hud-theme').click();p.gfx.setQuality('${quality}');${focus==='home'?'p.rig.home(true)':`if(!p.registry.get('${focus}'))throw Error('Missing focus');p.bus.emit('focus',{id:'${focus}',instant:true})`};})()`)
  await wait(23000)
  const before=await ev(probe)
  if(before.theme!==theme||before.quality!==quality)throw Error('Capture precondition: '+JSON.stringify(before))
  const shot=await send('Page.captureScreenshot',{format:'png'})
  const after=await ev(probe)
  if(after.theme!==theme||after.quality!==quality||JSON.stringify(before.camera)!==JSON.stringify(after.camera))throw Error('Capture state changed: '+JSON.stringify({before,after}))
  const filename=output.replace('.png',`-${theme}-${quality}-${focus}.png`)
  writeFileSync(filename,Buffer.from(shot.data,'base64'))
  states.push({requested:{theme,quality,focus},before,after,filename})
  writeFileSync(output.replace('.png','.json'),JSON.stringify({build,staging:'Test-only render rawDt=1/60 stabilizes quality; FPS, timing and performance INVALID. Product adaptive logic unchanged.',states,logs},null,2))
 }
 if(logs.some(s=>/EXCEPTION|\[error\]|unknown component/.test(s)))throw new Error('Rendering errors: '+JSON.stringify(logs))
}
