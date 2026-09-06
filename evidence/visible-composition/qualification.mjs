import { writeFileSync } from 'node:fs'
export async function runSequence({send,output,logs}) {
 const wait=ms=>new Promise(r=>setTimeout(r,ms))
 const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 await ev("window.PGSIMCITY.sim.setKnob('paused',true);window.PGSIMCITY.bus.emit('quality',{level:'low'});window.PGSIMCITY.bus.emit('toast',{text:'Frame rate stayed low — bloom lighting disabled. Bright-colour fallback is active.',kind:'warn',ms:60000,action:{label:'Restore high',quality:'high'}})")
 await wait(2000)
 const point=await ev("(()=>{const e=document.querySelector('#city-version-provenance summary'),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
 await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]})
 await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
 await wait(2000)
 const result=await ev("({qualificationOpen:document.querySelector('#city-version-provenance details').open,warningVisible:!!document.querySelector('.hud-toast--warn'),quality:window.PGSIMCITY.gfx.quality.level})")
 writeFileSync(output,Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'))
 writeFileSync(output.replace('.png','.json'),JSON.stringify({result,logs},null,2))
 if(!result.qualificationOpen||!result.warningVisible)throw new Error('Qualification touch acceptance failed')
}
