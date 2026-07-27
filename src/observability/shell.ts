import { MODE_IDS } from '../ui/mode-exits'
import { el } from '../ui/uikit'

export const CITY_HREF = '../'

export function createCityExit(): HTMLAnchorElement {
  return el(
    'a',
    {
      class: 'city-exit',
      href: CITY_HREF,
      data: { modeExit: MODE_IDS.diagnose },
      'aria-label': 'Back to the PGSimCity city',
    },
    el('span', { class: 'city-exit__arrow', 'aria-hidden': 'true', text: '←' }),
    el('span', { class: 'city-exit__wide', text: 'Back to city' }),
    el('span', { class: 'city-exit__short', text: 'City' }),
  )
}

export function installCityEscape(navigate: () => void = () => window.location.assign(CITY_HREF)): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    navigate()
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
