import type { SimApi } from '../core/types'
import { el } from '../ui/uikit'

export function createModelSpeedControls(sim: SimApi) {
  const speeds = [1, 2, 4]
  const buttons = speeds.map((speed) => {
    const button = el('button', {
      class: 'chip', type: 'button', text: `${speed}×`,
      'aria-label': `${speed} times model speed`,
    })
    button.addEventListener('click', () => {
      sim.setKnob('timeScale', speed, 'user')
      sync()
    })
    return button
  })
  function sync(): void {
    buttons.forEach((button, index) => {
      const selected = speeds[index] === sim.state.knobs.timeScale
      button.classList.toggle('on', selected)
      button.setAttribute('aria-pressed', String(selected))
    })
  }
  sync()
  return { buttons, sync }
}
