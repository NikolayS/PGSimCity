import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps visible annotation chips outside an open investigation notebook', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));PGSIMCITY.gfx.setQuality('low')})()`)
    const states = []
    for (const [width,height] of [[1280,900],[390,844]]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600})
      states.push(await evaluate(`(async()=>{
        const p=PGSIMCITY;document.querySelector('.hud-investigate').click();p.sim.setKnob('paused',true);
        document.querySelector('[data-vacuum-evidence="snapshot"]').click();
        await new Promise(r=>setTimeout(r,2500));for(let i=0;i<8;i++)await new Promise(requestAnimationFrame);
        const panel=document.querySelector('.vacuum-lesson').getBoundingClientRect();
        const chips=Array.from(document.querySelectorAll('.lbl.is-on')).filter(e=>Number(getComputedStyle(e).opacity)>.9).map(e=>({id:e.dataset.id,r:e.querySelector('.lbl__chip').getBoundingClientRect()})).filter(e=>e.r.width>0);
        const overlaps=chips.filter(({r})=>r.left<panel.right&&r.right>panel.left&&r.top<panel.bottom&&r.bottom>panel.top).map(e=>e.id);
        document.querySelector('.vacuum-lesson__close').click();return {width:innerWidth,count:chips.length,overlaps};
      })()`))
    }
    return states
  })
  for(const state of reports[0]) { expect(state.count).toBeGreaterThan(0);expect(state.overlaps,JSON.stringify(state)).toEqual([]) }
},180_000)

it('clears first-run map onboarding while walking and restores it on exit',async()=>{
  const reports=await inspectRenderedPages([{name:'City',path:'/',readySelector:'.hud-walk',reducedMotion:true}],async({evaluate})=>evaluate(`(async()=>{
    for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));
    const p=PGSIMCITY;p.sim.setKnob('paused',true);p.gfx.setQuality('low');
    const visible=()=>document.querySelector('.tour-first').getBoundingClientRect().height>0;
    const before=visible();document.querySelector('.hud-walk').click();await new Promise(r=>setTimeout(r,400));
    const walking=document.body.classList.contains('pg-walk'),during=visible();
    document.querySelector('.hud-walk').click();await new Promise(r=>setTimeout(r,400));
    return {before,walking,during,after:visible()};
  })()`))
  expect(reports[0]).toEqual({before:true,walking:true,during:false,after:true})
},120_000)
