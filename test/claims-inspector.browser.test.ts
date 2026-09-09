import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps desktop city qualifications above collapsed and open inspector controls',async()=>{
 const reports=await inspectRenderedPages([{name:'City',path:'/',readySelector:'.hud-investigate',reducedMotion:true}],async({evaluate,send})=>{
  await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));PGSIMCITY.gfx.setQuality('low');PGSIMCITY.sim.setKnob('paused',true)})()`)
  const states=[]
  for(const width of [1101,1280,1440]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:width===1101?720:900,deviceScaleFactor:1,mobile:false})
   states.push(await evaluate(`(async()=>{
    const claims=document.querySelector('#city-version-provenance'),details=claims.querySelector('details'),toggle=document.querySelector('[aria-label="Show the inspector"]');
    const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
    const read=()=>{const r=claims.getBoundingClientRect(),b=document.querySelector('#hud-right button').getBoundingClientRect();return {claims:r.toJSON(),button:b.toJSON(),overlap:overlap(r,b)}};
    await new Promise(r=>setTimeout(r,500));details.open=false;await new Promise(r=>setTimeout(r,100));const collapsed=read();
    details.open=true;await new Promise(r=>setTimeout(r,100));const expanded=read();
    toggle.click();await new Promise(r=>setTimeout(r,500));const panel=document.querySelector('#pgc-inspector-panel');const open={overlap:overlap(claims.getBoundingClientRect(),panel.getBoundingClientRect()),height:panel.getBoundingClientRect().height};
    document.querySelector('[aria-label="Hide the inspector"]').click();details.open=false;await new Promise(r=>setTimeout(r,500));return {collapsed,expanded,open};
   })()`))
  }
  return states
 })
 for(const state of reports[0]){expect(state.collapsed.overlap,JSON.stringify(state)).toBe(false);expect(state.expanded.overlap,JSON.stringify(state)).toBe(false);expect(state.open.overlap,JSON.stringify(state)).toBe(false);expect(state.open.height).toBeGreaterThan(180)}
},180_000)
