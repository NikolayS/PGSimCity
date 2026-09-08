import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps phone metrics and normal district focuses inside the visible city space', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));PGSIMCITY.sim.setKnob('paused',true);PGSIMCITY.gfx.setQuality('low');Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Explore freely')?.click()})()`)
    const states = []
    for (const [width, height] of [[320, 740], [390, 844], [540, 960]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
      states.push(await evaluate(`(async()=>{
        await new Promise(r=>setTimeout(r,500));const p=PGSIMCITY;
        const vitals=document.querySelector('.hud-vitals');
        const readings={width:innerWidth,vitalsWidth:vitals.clientWidth,vitalsContent:vitals.scrollWidth,focuses:[]};
        for(const [id,min,max] of [['wal.vault',[152,0,-70],[184,29,70]],['shared.buffers',[-47,-3,-47],[47,12,47]]]) {
          p.bus.emit('focus',{id,instant:true});await new Promise(r=>setTimeout(r,350));p.gfx.camera.updateMatrixWorld();
          const top=document.querySelector('#hud-top').getBoundingClientRect().bottom,bottom=document.querySelector('#hud-bottom').getBoundingClientRect().top;
          const points=[];for(const x of [min[0],max[0]])for(const y of [min[1],max[1]])for(const z of [min[2],max[2]]) {
            const v=p.gfx.camera.position.clone().set(x,y,z).project(p.gfx.camera);points.push({x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2});
          }
          readings.focuses.push({id,top,bottom,points});
        }
        return readings;
      })()`))
    }
    return states
  })
  console.log(JSON.stringify(reports))
  for (const state of reports[0]) {
    expect(state.vitalsContent).toBeLessThanOrEqual(state.vitalsWidth + 1)
    for (const focus of state.focuses) {
      if (focus.id === 'wal.vault') {
        const span = Math.max(...focus.points.map(p => p.y)) - Math.min(...focus.points.map(p => p.y));
        expect(span / (focus.bottom - focus.top), 'portrait WAL uses vertical reading space').toBeGreaterThan(0.5);
      }
    }
    for (const focus of state.focuses) for (const p of focus.points) {
      expect(p.x, focus.id).toBeGreaterThanOrEqual(8)
      expect(p.x, focus.id).toBeLessThanOrEqual(state.width - 8)
      expect(p.y, focus.id).toBeGreaterThanOrEqual(focus.top + 8)
      expect(p.y, focus.id).toBeLessThanOrEqual(focus.bottom - 8)
    }
  }
}, 180_000)
