import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('frames live storage outside the notebook and restores the hidden layers', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async()=>{for(let i=0;i<240&&!window.PGSIMCITY;i++)await new Promise(r=>setTimeout(r,50))})()`)
    const states = []
    for (const [width, height] of [[390, 844], [1280, 900], [844, 390]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
      states.push(await evaluate(`(async()=>{
        const p=PGSIMCITY,wait=()=>new Promise(r=>setTimeout(r,300));
        document.querySelector('.hud-investigate').click();p.sim.setKnob('paused',true);await wait();
        document.querySelector('[data-vacuum-evidence="table"]').click();await wait();
        const panel=document.querySelector('.vacuum-lesson').getBoundingClientRect();
        const claims=document.querySelector('#city-version-provenance').getBoundingClientRect();
        const def=p.registry.get('storage.table.sessions'),mesh=def.object.children.find(c=>c.geometry);
        mesh.geometry.computeBoundingBox();const box=mesh.geometry.boundingBox.clone().setFromObject(def.object);
        const points=[];for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
          const v=def.object.position.clone().set(x,y,z).project(p.gfx.camera);points.push({x:(v.x+1)*innerWidth/2,y:(1-v.y)*innerHeight/2,z:v.z});
        }
        const layers=['shmem','os.cache','storage.durability'].map(n=>p.gfx.scene.getObjectByName(n));
        const hidden=layers.every(o=>!o.visible),notice=document.querySelector('.vacuum-lesson__scene').textContent;
        const clock=p.sim.state.scenarioT;document.querySelector('#vacuum-personal-notes').value='Retain this note';
        document.querySelector('[data-vacuum-evidence="snapshot"]').click();
        const restored=layers.every(o=>o.visible),notes=document.querySelector('#vacuum-personal-notes').value,sameTime=p.sim.state.scenarioT===clock;
        document.querySelector('[data-vacuum-evidence="table"]').click();document.querySelector('.vacuum-lesson__close').click();
        return {width:innerWidth,height:innerHeight,panel:{left:panel.left,top:panel.top},claimsBottom:claims.bottom,points,hidden,notice,restored,notes,closedRestored:layers.every(o=>o.visible),sameTime};
      })()`))
    }
    return states
  })
  for (const report of reports[0]) {
    expect(report.hidden).toBe(true)
    expect(report.notice).toContain('not removed from the model')
    expect(report.restored).toBe(true)
    expect(report.closedRestored).toBe(true)
    expect(report.notes).toBe('Retain this note')
    expect(report.sameTime).toBe(true)
    for (const point of report.points) {
      expect(point.x).toBeGreaterThan(0)
      expect(point.x).toBeLessThan(report.width)
      expect(point.y).toBeGreaterThan(0)
      expect(point.y).toBeLessThan(report.height)
      expect(point.z).toBeGreaterThan(-1)
      expect(point.z).toBeLessThan(1)
      if (report.width <= 640) {
        expect(point.y).toBeLessThan(report.panel.top - 8)
        expect(point.y).toBeGreaterThan(report.claimsBottom + 8)
      } else expect(point.x).toBeLessThan(report.panel.left - 8)
    }
    if (report.width <= 640) expect(report.panel.top - report.claimsBottom).toBeGreaterThan(150)
  }
}, 180_000)
