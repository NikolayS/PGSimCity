import { CLAIM_VALUES } from './claims'
import type { Bus } from './types'

interface ComponentRegistry {
  get(id: string): unknown
}

interface HashLocation {
  hash: string
}

interface HashTarget {
  addEventListener(type: 'hashchange', listener: EventListener): void
  removeEventListener(type: 'hashchange', listener: EventListener): void
}

export function cityComponentHref(id: string, base = ''): string {
  return `${base}${CLAIM_VALUES.cityComponentRoute.hashPrefix}${encodeURIComponent(id)}`
}

export function cityComponentId(hash: string): string | null {
  const prefix = CLAIM_VALUES.cityComponentRoute.hashPrefix
  if (!hash.startsWith(prefix)) return null
  const encoded = hash.slice(prefix.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export function installCityComponentRoutes(options: {
  bus: Bus
  registry: ComponentRegistry
  location: HashLocation
  target: HashTarget
}): () => void {
  const sync = (): void => {
    const id = cityComponentId(options.location.hash)
    if (!id || !options.registry.get(id)) return
    options.bus.emit('select', { id })
    options.bus.emit('focus', { id })
  }

  options.target.addEventListener('hashchange', sync)
  sync()
  return () => options.target.removeEventListener('hashchange', sync)
}

