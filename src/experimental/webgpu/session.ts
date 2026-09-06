export type Backend = 'webgpu' | 'webgl2'
export type LabState = { status: 'idle' | 'loading' | 'unavailable' }
  | { status: 'ready'; backend: Backend }

export function createLabSession(load: () => Promise<Backend>) {
  let current: LabState = { status: 'idle' }
  let pending: Promise<void> | undefined
  return {
    state: (): LabState => current,
    start(): Promise<void> {
      if (pending) return pending
      current = { status: 'loading' }
      pending = Promise.resolve().then(load).then(
        backend => { current = { status: 'ready', backend } },
        () => { current = { status: 'unavailable' } },
      )
      return pending
    },
  }
}
