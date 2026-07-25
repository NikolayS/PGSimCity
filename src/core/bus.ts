import type { Bus, BusEvents, BusHandler } from './types'

/** Tiny typed pub/sub. Handlers that throw are logged, never fatal. */
export function createBus(): Bus {
  const map = new Map<string, Set<(p: unknown) => void>>()

  function on<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void {
    let set = map.get(type as string)
    if (!set) map.set(type as string, (set = new Set()))
    set.add(fn as (p: unknown) => void)
    return () => off(type, fn)
  }

  function off<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): void {
    map.get(type as string)?.delete(fn as (p: unknown) => void)
  }

  function once<K extends keyof BusEvents>(type: K, fn: BusHandler<K>): () => void {
    const wrapped = ((p: BusEvents[K]) => {
      off(type, wrapped)
      fn(p)
    }) as BusHandler<K>
    return on(type, wrapped)
  }

  function emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
    const set = map.get(type as string)
    if (!set || set.size === 0) return
    for (const fn of Array.from(set)) {
      try {
        ;(fn as BusHandler<K>)(payload)
      } catch (err) {
        console.error(`[bus] handler for "${String(type)}" threw`, err)
      }
    }
  }

  return { on, off, once, emit }
}
