import {writeFileSync} from 'node:fs'
export async function runSequence({send,output,logs}) {
 const wait=ms=>new Promise(r=>setTimeout(r,ms))
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 await ev("window.PGSIMCITY.sim.reset();window.PGSIMCITY.sim.setKnob('paused',true);window.PGSIMCITY.bus.emit('quality',{level:'low'});window.PGSIMCITY.rig.home(true);window.PGSIMCITY.bus.on('select',e=>window.__selectedByTap=e.id)")
 await wait(18000)
 const target=await ev("(()=>{const e=[...document.querySelectorAll('.lbl')].find(e=>+getComputedStyle(e).opacity>.9&&e.textContent.includes('Backends'));if(!e)throw new Error('No readable backend label');const r=e.querySelector('.lbl__chip').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[target]})
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
 await wait(12000)
 const result=await ev("({selectedByTap:window.__selectedByTap,inspectorText:document.querySelector('#hud-right')?.textContent})")
 writeFileSync(output,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
 writeFileSync(output.replace('.png','.json'),JSON.stringify({result,logs},null,2))
 if(!result.selectedByTap) throw new Error('Backend label tap did not select')
}
