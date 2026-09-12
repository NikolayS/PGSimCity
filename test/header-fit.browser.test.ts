import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps header identity and every tool in separate visible space', async () => {
  const reports = await inspectRenderedPages([{name:'City',path:'/',readySelector:'.hud-investigate',reducedMotion:true}], async ({evaluate,send}) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));PGSIMCITY.gfx.setQuality('low');PGSIMCITY.sim.setKnob('paused',true);document.querySelector('.hud-audio__label').textContent='Walk sound ready'})()`)
    await evaluate(`document.documentElement.style.setProperty('--fs-sm','18px');document.documentElement.style.setProperty('--fs-xs','17px')`)
    const states = []
    for (const width of [1450,1536,1920,1440,1280,1081,980,794,390,320]) {
      await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false})
      states.push(await evaluate(`(async()=>{
        for(let i=0;i<200;i++) {
          const inDock=document.querySelector('.hud-tools').parentElement.classList.contains('hud-transport__dock');
          if(inDock===(${width}<=700)) break;
          await new Promise(r=>setTimeout(r,50));
        }
        await new Promise(r=>setTimeout(r,100));
        const brand=document.querySelector('.hud-brand').getBoundingClientRect();
        const checkpoint=document.querySelector('#hud-top .hud-ckpt').getBoundingClientRect();
        const tools=[...document.querySelectorAll('#hud-top .hud-tools > *')].map(e=>({name:e.className,r:e.getBoundingClientRect()})).filter(x=>x.r.width&&x.r.height);
        const rects=[{name:'hud-ckpt',r:checkpoint},...tools];
        const overlaps=rects.filter(x=>x.r.left<brand.right&&x.r.right>brand.left&&x.r.top<brand.bottom&&x.r.bottom>brand.top).map(x=>x.name);
        const outside=rects.filter(x=>x.r.left<0||x.r.right>innerWidth).map(x=>x.name);
        const checkpointSharesControlLine=tools.some(x=>x.r.top<checkpoint.bottom&&x.r.bottom>checkpoint.top);
        return {requestedWidth:${width},width:innerWidth,overlaps,outside,count:rects.length,checkpointSharesControlLine,parent:document.querySelector('.hud-tools').parentElement.className};
      })()`))
    }
    return states
  })
  console.info(JSON.stringify(reports))
  for(const state of reports[0]) {
    if (state.requestedWidth > 700) expect(state.count).toBeGreaterThan(10)
    expect(state.overlaps,JSON.stringify(state)).toEqual([])
    expect(state.outside,JSON.stringify(state)).toEqual([])
    if (state.requestedWidth >= 1081 && state.requestedWidth <= 1440) {
      expect(state.checkpointSharesControlLine,JSON.stringify(state)).toBe(true)
    }
  }
},180_000)
