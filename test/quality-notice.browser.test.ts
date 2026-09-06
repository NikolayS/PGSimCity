import { describe, expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

describe('quality notice placement', () => {
  it('keeps the model qualification and transport reachable while a warning is present', async () => {
    const reports = await inspectRenderedPages([{ name: 'City', path: '/', readySelector: '.hud-theme', reducedMotion: true }], async ({ evaluate }) => {
      return evaluate(`(async () => {
        while (!window.PGSIMCITY) await new Promise(r => setTimeout(r, 50))
        window.PGSIMCITY.bus.emit('toast', {text:'Frame rate stayed low — bloom lighting disabled. Bright-colour fallback is active.',kind:'warn',ms:60000,action:{label:'Restore high',quality:'high'}})
        await new Promise(r=>setTimeout(r,400))
        const summary=document.querySelector('#city-version-provenance summary')
        const warning=[...document.querySelectorAll('.hud-toast')].find(e=>e.textContent.includes('bloom lighting disabled'))
        const transport=document.querySelector('.hud-transport')
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}
        const s=rect(summary),w=rect(warning),t=rect(transport)
        const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
        const hit=document.elementFromPoint((s.left+s.right)/2,(s.top+s.bottom)/2)
        return {warningVisible:w.bottom>w.top, qualificationBlocked:intersects(s,w),transportBlocked:intersects(t,w),qualificationHit:summary===hit||summary.contains(hit)}
      })()`)
    })
    expect(reports).toEqual([{warningVisible:true,qualificationBlocked:false,transportBlocked:false,qualificationHit:true}])
  }, 180_000)
})
