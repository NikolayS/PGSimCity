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


it('suspends the first-run invitation while the inspector is open without dismissing it', async () => {
  const reports = await inspectRenderedPages([{name:'City',path:'/',readySelector:'.hud-investigate',reducedMotion:true}], async ({evaluate,send}) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));PGSIMCITY.gfx.setQuality('low');PGSIMCITY.sim.setKnob('paused',true)})()`)
    const states = []
    for (const [width,height] of [[1101,720],[1280,900],[390,844]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600})
      states.push(await evaluate(`(async()=>{
        for(let i=0;i<120&&document.querySelector('.pgc-host--right').classList.contains('is-compact')!==(innerWidth<=1100);i++)await new Promise(r=>setTimeout(r,250));
        const first=document.querySelector('.tour-first');
        const visible=()=>{const r=first.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(first).visibility!=='hidden'};
        await new Promise(r=>setTimeout(r,300));const before=visible();
        document.querySelector('[aria-label="Show the inspector"]').click();await new Promise(r=>setTimeout(r,500));
        const during=visible(),panel=document.querySelector('#pgc-inspector-panel');
        const panelVisible=panel.getBoundingClientRect().height>180&&!panel.inert;const openDetails={rect:panel.getBoundingClientRect().toJSON(),inert:panel.inert,host:panel.parentElement.className,body:document.body.className,display:getComputedStyle(panel).display,ancestors:[panel.parentElement,panel.parentElement.parentElement].map(e=>({id:e.id,display:getComputedStyle(e).display,rect:e.getBoundingClientRect().toJSON()}))};
        document.querySelector('[aria-label="Hide the inspector"]').click();await new Promise(r=>setTimeout(r,500));
        return {width:innerWidth,before,during,panelVisible,openDetails,after:visible()};
      })()`))
    }
    return states
  })
  for (const state of reports[0]) {
    expect(state.before,JSON.stringify(state)).toBe(true)
    expect(state.during,JSON.stringify(state)).toBe(false)
    expect(state.panelVisible,JSON.stringify(state)).toBe(true)
    expect(state.after,JSON.stringify(state)).toBe(true)
  }
},180_000)
