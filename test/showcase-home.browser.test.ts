import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('uses the portrait-aware Home composition from the visible action and H shortcut', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50));Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Explore freely')?.click();PGSIMCITY.sim.setKnob('paused',true);PGSIMCITY.gfx.setQuality('low')})()`)
    const states = []
    for (const [width, height] of [[320, 740], [390, 844], [540, 960]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true })
      states.push(await evaluate(`(async()=>{
        await new Promise(r=>setTimeout(r,500));const p=PGSIMCITY;
        const settle=()=>{for(let i=0;i<40;i++)p.rig.update(.1)};
        const read=()=>({position:p.gfx.camera.position.toArray(),pivot:p.rig.pivot.toArray()});
        p.rig.home(true);settle();const expected=read(),time=p.sim.state.t,actual=[];
        for(const route of ['button','key']) {
          p.bus.emit('focus',{id:'backend.row',instant:true});settle();
          if(route==='button')document.querySelector('[data-view-action="home"]').click();
          else window.dispatchEvent(new KeyboardEvent('keydown',{key:'h',code:'KeyH',bubbles:true}));
          settle();actual.push({route,...read(),lab:p.gfx.scene.getObjectByName('district:planner').visible});
        }
        return {width:innerWidth,expected,actual,unchanged:p.sim.state.t===time};
      })()`))
    }
    return states
  })
  for (const state of reports[0]) {
    expect(state.unchanged).toBe(true)
    for (const actual of state.actual) {
      expect(actual.lab).toBe(false)
      for (const key of ['position', 'pivot']) for (let i=0;i<3;i++) {
        expect(actual[key][i], `${state.width}px ${actual.route} ${key}[${i}]`).toBeCloseTo(state.expected[key][i], 4)
      }
    }
  }
}, 180_000)
