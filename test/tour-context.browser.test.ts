import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('reserves the guided tour for its lesson and restores close-view orientation on exit', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    const states = []
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
      states.push(await evaluate(`(async()=>{
        const p=PGSIMCITY,wait=()=>new Promise(r=>setTimeout(r,600));
        p.sim.setKnob('paused',true);
        p.bus.emit('tour:start',{chapter:10});await wait();
        const def=p.registry.get('shared.buffers');
        p.rig.focusOn({...def.focus,distance:25},{instant:true});
        const caption=document.querySelector('.zoom-context');
        for(let i=0;i<100&&caption.hidden;i++)await new Promise(r=>setTimeout(r,100));
        const available=!caption.hidden;
        const during=getComputedStyle(caption).display;
        const exit=document.querySelector('.tour-btn--exit');
        const hit=()=>{const r=exit.getBoundingClientRect();return exit.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
        for(let i=0;i<100&&!hit();i++)await new Promise(r=>setTimeout(r,100));
        const reachable=hit();
        exit.click();await wait();
        return {width:innerWidth,available,during,reachable,after:getComputedStyle(caption).display,touring:document.body.classList.contains('pg-tour')};
      })()`))
    }
    return states
  })
  console.log(JSON.stringify(reports))
  for (const state of reports[0]) {
    expect(state.available).toBe(true)
    expect(state.during).toBe('none')
    expect(state.reachable).toBe(true)
    expect(state.after).not.toBe('none')
    expect(state.touring).toBe(false)
  }
}, 180_000)
