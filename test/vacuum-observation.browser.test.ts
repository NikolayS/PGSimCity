import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('traverses real checkpoints with keyboard control and retained notes', async () => {
  const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true }], async ({ evaluate, send }) => {
    await evaluate(`(async () => {
      for(let i=0; i<200 && !window.PGSIMCITY; i++) await new Promise(r=>setTimeout(r,50))
      document.querySelector('.hud-investigate').click()
      document.querySelector('#vacuum-personal-notes').value = 'Keep this evidence'
      document.querySelector('[data-vacuum-seek]').focus()
    })()`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    return evaluate(`(async () => {
      const wait = async (predicate) => { for(let i=0;i<1500;i++){ if(predicate()) return; await new Promise(r=>setTimeout(r,20)) } throw Error('Observation timeout') }
      const click = selector => { const b=document.querySelector(selector); if(!b || b.disabled)throw Error('Unavailable '+selector); b.click() }
      await wait(()=>document.querySelector('[data-checkpoint="pinned"]'))
      const pinned=document.querySelector('[data-checkpoint="pinned"]').textContent
      click('[data-vacuum-seek]')
      await wait(()=>document.querySelector('[data-checkpoint="constrained"]'))
      const ti=PGSIMCITY.sim.state.tables.findIndex(t=>t.def.id==='sessions');
      if(!PGSIMCITY.sim.state.autovac.workers.some(w=>w.active&&w.table===ti&&w.stalledByHorizon))throw Error('No actual constrained sessions worker')
      for(const id of ['table','worker','snapshot','owner']){click('[data-vacuum-evidence="'+id+'"]');click('[data-vacuum-record]')}
      click('[data-vacuum-cause="snapshot"]')
      click('[data-vacuum-action="terminate"]')
      if(!document.querySelector('[data-checkpoint="released"]'))throw Error('Missing release evidence')
      click('[data-vacuum-seek]')
      await wait(()=>document.querySelector('[data-checkpoint="eligible"]'))
      const eligible=document.querySelector('[data-checkpoint="eligible"]').textContent
      click('[data-vacuum-seek]')
      await wait(()=>document.querySelector('[data-checkpoint="collected"]'))
      click('[data-vacuum-verify]')
      return {phase:document.querySelector('.vacuum-lesson').dataset.phase, kinds:[...document.querySelectorAll('[data-checkpoint]')].map(b=>b.dataset.checkpoint), pinnedRetained:pinned===document.querySelector('[data-checkpoint="pinned"]').textContent, eligible, notes:document.querySelector('#vacuum-personal-notes').value, paused:PGSIMCITY.sim.state.knobs.paused}
    })()`)
  })
  expect(reports[0].phase).toBe('complete')
  expect(reports[0].kinds).toEqual(['pinned','constrained','released','eligible','collected'])
  expect(reports[0].pinnedRetained).toBe(true)
  expect(reports[0].eligible).toContain('0 versions reclaimed')
  expect(reports[0].notes).toBe('Keep this evidence')
  expect(reports[0].paused).toBe(true)
}, 180_000)
