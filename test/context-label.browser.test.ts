import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('keeps qualified selected context readable inside narrow and desktop city space', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));const p=PGSIMCITY;p.sim.reset();p.sim.setKnob('paused',true);p.gfx.setQuality('low');Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Explore freely')?.click()})()`)
    const states = []
    for (const [width, height] of [[1280, 900], [320, 740], [390, 844]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
      states.push(await evaluate(`(async()=>{
        const p=PGSIMCITY;await new Promise(r=>setTimeout(r,300));p.bus.emit('focus',{id:'world.ground',instant:true});
        p.bus.emit('select',{id:'storage.table.sessions'});
        await new Promise(r=>setTimeout(r,500));
        document.querySelector('[aria-label="Show the inspector"]')?.click();
        await new Promise(r=>setTimeout(r,1500));
        for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
        const e=document.querySelector('.lbl[data-id="storage.table.sessions"]'),note=e.querySelector('.lbl__occlusion'),chip=e.querySelector('.lbl__chip');
        const rect=chip.getBoundingClientRect(),d=p.registry.get('storage.table.sessions'),anchor=p.gfx.camera.position.clone().set(...d.labelAt);
        const panel=document.querySelector('#pgc-inspector-panel').getBoundingClientRect();
        const selected={right:innerWidth>=600&&panel.width>0?panel.left:innerWidth,width:innerWidth,height:innerHeight,shown:e.classList.contains('is-on'),opacity:Number(getComputedStyle(e).opacity),qualified:!note.hidden,font:parseFloat(getComputedStyle(note).fontSize),rect:rect.toJSON(),top:document.querySelector('#hud-top').getBoundingClientRect().bottom,bottom:document.querySelector('#hud-bottom').getBoundingClientRect().top,occluded:p.collision.occluded(p.gfx.camera.position,anchor),t:p.sim.state.t};
        p.bus.emit('select',{id:null});for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
        return {...selected,cleared:!e.classList.contains('is-on')&&note.hidden,sameTime:p.sim.state.t===selected.t};
      })()`))
    }
    return states
  })
  for (const state of reports[0]) {
    expect(state.occluded).toBe(true)
    expect(state.shown, JSON.stringify(state)).toBe(true)
    expect(state.opacity).toBeGreaterThan(0.9)
    expect(state.qualified).toBe(true)
    expect(state.font).toBeGreaterThanOrEqual(11)
    expect(state.rect.left).toBeGreaterThanOrEqual(0)
    expect(state.rect.right).toBeLessThanOrEqual(state.right)
    expect(state.rect.top).toBeGreaterThan(state.top)
    expect(state.rect.bottom).toBeLessThan(state.bottom)
    expect(state.cleared).toBe(true)
    expect(state.sameTime).toBe(true)
  }
}, 180_000)
