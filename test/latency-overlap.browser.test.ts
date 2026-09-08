import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps the latency explanation above close-view chrome and its close reachable after scrolling', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50))})()`)
    const states = []
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
      states.push(await evaluate(`(async()=>{
        const p=PGSIMCITY,wait=()=>new Promise(r=>setTimeout(r,600));p.sim.setKnob('paused',true);
        const def=p.registry.get('backend.0');p.bus.emit('select',{id:def.id,outlineOnly:true});
        p.rig.focusOn({...def.focus,distance:25},{instant:true});await wait();
        const caption=document.querySelector('.zoom-context');
        for(let i=0;i<100&&caption.hidden;i++)await new Promise(r=>setTimeout(r,100));
        const before=!caption.hidden;
        document.querySelector('[data-vital="latency"]').click();await wait();
        const panel=document.querySelector('#hud-latency-panel'),close=panel.querySelector('.hud-latency__close');
        const rect=panel.getBoundingClientRect(),cap=caption.getBoundingClientRect();
        const x=Math.max(rect.left,cap.left)+20,y=Math.min(rect.bottom,cap.bottom)-20;
        const overlap=y>=Math.max(rect.top,cap.top)&&x<Math.min(rect.right,cap.right);
        const hit=overlap?panel.contains(document.elementFromPoint(x,y)):true;
        panel.scrollTop=panel.scrollHeight;await wait();
        const end=panel.scrollTop+panel.clientHeight>=panel.scrollHeight-2;
        const c=close.getBoundingClientRect();const closeHit=close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2));
        close.click();await wait();
        return {before,overlap,hit,end,closeHit,bottom:rect.bottom,height:innerHeight,restored:!caption.hidden,closed:panel.hidden};
      })()`))
    }
    return states
  })
  console.log(JSON.stringify(reports))
  for (const state of reports[0]) {
    expect(state.before).toBe(true)
    expect(state.hit).toBe(true)
    expect(state.end).toBe(true)
    expect(state.closeHit).toBe(true)
    expect(state.bottom).toBeLessThan(state.height)
    expect(state.restored).toBe(true)
    expect(state.closed).toBe(true)
  }
}, 180_000)
