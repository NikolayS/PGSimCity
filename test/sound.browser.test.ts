import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'

const INSTALL_AUDIO_PROBE = `(() => {
  const probe = {
    analysers: [],
    contexts: new Set(),
    sourceStarts: 0,
    bufferSourceStarts: 0,
    peak: 0,
    samples: 0,
  }
  window.__pgAudioProbe = probe

  const connect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function(destination, ...args) {
    probe.contexts.add(this.context)
    if (destination === this.context.destination) {
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 256
      probe.analysers.push(analyser)
      connect.call(this, analyser)
      connect.call(analyser, destination)
      return destination
    }
    return connect.call(this, destination, ...args)
  }

  for (const SourceClass of [window.AudioBufferSourceNode, window.OscillatorNode, window.ConstantSourceNode]) {
    if (!SourceClass) continue
    const start = SourceClass.prototype.start
    SourceClass.prototype.start = function(...args) {
      probe.contexts.add(this.context)
      probe.sourceStarts += 1
      if (this instanceof AudioBufferSourceNode) probe.bufferSourceStarts += 1
      return start.apply(this, args)
    }
  }

  probe.measure = async (milliseconds) => {
    const startedAt = performance.now()
    let peak = 0
    let samples = 0
    while (performance.now() - startedAt < milliseconds) {
      for (const analyser of probe.analysers) {
        const values = new Float32Array(analyser.fftSize)
        analyser.getFloatTimeDomainData(values)
        for (const value of values) peak = Math.max(peak, Math.abs(value))
        samples += values.length
      }
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
    probe.peak = Math.max(probe.peak, peak)
    probe.samples += samples
    return { peak, samples }
  }

  probe.report = () => ({
    contexts: probe.contexts.size,
    contextStates: [...probe.contexts].map((context) => context.state),
    sourceStarts: probe.sourceStarts,
    bufferSourceStarts: probe.bufferSourceStarts,
    analysers: probe.analysers.length,
  })
})()`

describe('movement sound in a rendered city', () => {
  it('measures silence in orbit and signal from walking, with mode-honest copy', async () => {
    const [report] = await inspectRenderedPages([{
      name: 'City sound',
      path: '/',
      readySelector: '.hud-audio',
    }], async ({ evaluate, keyPress, send }) => {
      await evaluate(INSTALL_AUDIO_PROBE)
      /* Reproduce a quality notification arriving after the sound notification,
       * without relying on software-renderer load or disabling quality control. */
      await evaluate(`window.PGSIMCITY.bus.on('toast', ({ text }) => {
        if (/sound on/i.test(text)) window.PGSIMCITY.bus.emit('toast', {
          text: 'Frame rate stayed low — reduced antialiasing; quality is now medium.',
          kind: 'info',
          ms: 10000,
        })
      })`)

      const waitFor = (condition: string) => evaluate(`new Promise((resolve, reject) => {
        const startedAt = performance.now()
        const timer = setInterval(() => {
          if (${condition}) {
            clearInterval(timer)
            resolve(true)
          } else if (performance.now() - startedAt > 15000) {
            clearInterval(timer)
            reject(new Error('timed out waiting for ${condition.replaceAll("'", "\\'")}'))
          }
        }, 50)
      })`)
      const setWalkingKey = (type: 'keyDown' | 'keyUp') => send('Input.dispatchKeyEvent', {
        type,
        key: 'w',
        code: 'KeyW',
        text: type === 'keyDown' ? 'w' : '',
        unmodifiedText: type === 'keyDown' ? 'w' : '',
        nativeVirtualKeyCode: 87,
        windowsVirtualKeyCode: 87,
      })
      const copy = () => evaluate(`(() => {
        const button = document.querySelector('.hud-audio')
        return {
          label: button.querySelector('.hud-audio__label').textContent,
          title: button.title,
          ariaLabel: button.getAttribute('aria-label'),
        }
      })()`)

      const enabledSoundToast = async () => {
        const expression = `Array.from(document.querySelectorAll('.hud-toast__txt')).map((node) => node.textContent).find((text) => /sound on/i.test(text)) ?? ''`
        await waitFor(expression)
        return evaluate(expression)
      }

      await keyPress('M', { code: 'KeyM' })
      await waitFor(`window.PGSIMCITY.audio.enabled`)
      const orbitToast = await enabledSoundToast()
      await waitFor(`document.querySelector('.hud-audio').getAttribute('aria-pressed') === 'true'`)
      const orbitCopy = { ...await copy(), toast: orbitToast }
      await setWalkingKey('keyDown')
      const orbitSignal = await evaluate(`window.__pgAudioProbe.measure(2200)`)
      await setWalkingKey('keyUp')
      const orbit = {
        ...await evaluate(`window.__pgAudioProbe.report()`),
        ...orbitSignal,
        copy: orbitCopy,
      }

      await keyPress('M', { code: 'KeyM' })
      await waitFor(`!window.PGSIMCITY.audio.enabled`)
      await keyPress('G', { code: 'KeyG' })
      await waitFor(`window.PGSIMCITY.rig.mode === 'walk' && window.PGSIMCITY.walk.enabled`)
      await evaluate(`(() => {
        window.PGSIMCITY.walk.setPose({ x: 0, y: 3.75, z: 48, yaw: 0, pitch: 0 })
      })()`)
      await waitFor(`window.PGSIMCITY.walk.grounded`)
      await keyPress('M', { code: 'KeyM' })
      await waitFor(`window.PGSIMCITY.audio.enabled`)
      const walkToast = await enabledSoundToast()
      await waitFor(`document.querySelector('.hud-audio').getAttribute('aria-pressed') === 'true'`)
      const beforeWalk = await evaluate(`window.__pgAudioProbe.report()`)
      const beforeMovement = await evaluate(`({
        distance: window.PGSIMCITY.walk.distance,
        speed: window.PGSIMCITY.walk.speed,
        grounded: window.PGSIMCITY.walk.grounded,
        position: window.PGSIMCITY.walk.position.toArray(),
      })`)
      const walkCopy = { ...await copy(), toast: walkToast }
      const walkSignal = await evaluate(`(async () => {
        const measurement = window.__pgAudioProbe.measure(800)
        window.PGSIMCITY.walk.setTouchMove(1, 0)
        for (let frame = 0; frame < 30; frame += 1) window.PGSIMCITY.walk.update(0.05)
        window.PGSIMCITY.walk.setTouchMove(0, 0)
        return measurement
      })()`)
      const afterWalk = await evaluate(`window.__pgAudioProbe.report()`)
      const afterMovement = await evaluate(`({
        distance: window.PGSIMCITY.walk.distance,
        speed: window.PGSIMCITY.walk.speed,
        grounded: window.PGSIMCITY.walk.grounded,
        position: window.PGSIMCITY.walk.position.toArray(),
      })`)

      return {
        orbit,
        walk: {
          contexts: afterWalk.contexts,
          contextStates: afterWalk.contextStates,
          analysers: afterWalk.analysers,
          sourceStarts: afterWalk.sourceStarts - beforeWalk.sourceStarts,
          bufferSourceStarts: afterWalk.bufferSourceStarts - beforeWalk.bufferSourceStarts,
          distance: afterMovement.distance - beforeMovement.distance,
          beforeMovement,
          afterMovement,
          ...walkSignal,
          copy: walkCopy,
        },
      }
    })

    if (process.env.AUDIO_AUDIT_REPORT === '1') {
      console.info('rendered audio audit', JSON.stringify(report))
    }

    expect(report.orbit.contexts).toBe(1)
    expect(report.orbit.contextStates).toEqual(['running'])
    expect(report.orbit.analysers).toBeGreaterThan(0)
    expect(report.orbit.samples).toBeGreaterThan(0)
    expect(report.orbit.sourceStarts).toBe(0)
    expect(report.orbit.bufferSourceStarts).toBe(0)
    expect(report.orbit.peak).toBe(0)
    expect(report.orbit.copy.toast).toBe('Walk sound on — enter Walk to hear it')
    for (const copy of Object.values(report.orbit.copy)) expect(copy).toMatch(/walk/i)

    expect(report.walk.contexts).toBe(1)
    expect(report.walk.contextStates).toEqual(['running'])
    expect(report.walk.analysers).toBeGreaterThan(0)
    expect(report.walk.samples).toBeGreaterThan(0)
    expect(report.walk.distance).toBeGreaterThan(0.75)
    expect(report.walk.sourceStarts).toBeGreaterThan(0)
    expect(report.walk.bufferSourceStarts).toBe(report.walk.sourceStarts)
    expect(report.walk.peak).toBeGreaterThan(0)
    expect(report.walk.copy.toast).toBe('Walk sound on')
    for (const copy of Object.values(report.walk.copy)) expect(copy).toMatch(/walk/i)
  }, 180_000)
})
