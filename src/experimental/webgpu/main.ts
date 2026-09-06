import { createLabSession } from './session'
import './style.css'

const start = document.querySelector<HTMLButtonElement>('#start')!
const backend = document.querySelector<HTMLSelectElement>('#backend')!
const status = document.querySelector<HTMLElement>('#status')!
const session = createLabSession(async () => {
  const { startPrototype } = await import('./prototype')
  return startPrototype(document.querySelector('#viewport')!, document.querySelector('#report')!, backend.value === 'webgl2')
})
start.addEventListener('click', async () => {
  start.disabled = true
  backend.disabled = true
  status.textContent = 'Initializing renderer…'
  await session.start()
  const state = session.state()
  status.textContent = state.status === 'ready'
    ? `Active backend: ${state.backend}. Reload this page to compare the other backend.`
    : 'Renderer unavailable. Return to the complete city using the link above; it has its own WebGL2 support check.'
})
