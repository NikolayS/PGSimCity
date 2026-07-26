export interface BootStep {
  pct: number
  label: string
}

export const BOOT_STEPS = {
  renderer: { pct: 8, label: 'starting the renderer…' },
  camera: { pct: 16, label: 'placing the camera…' },
  simulation: { pct: 24, label: 'warming up the cluster…' },
  ground: { pct: 32, label: 'grading the ground…' },
  sharedMemory: { pct: 42, label: 'pouring the shared memory plaza…' },
  backends: { pct: 52, label: 'forking backends…' },
  wal: { pct: 62, label: 'laying the write-ahead log…' },
  storage: { pct: 70, label: 'excavating the data directory…' },
  maintenance: { pct: 78, label: 'opening the maintenance yard…' },
  standby: { pct: 85, label: 'connecting the standby…' },
  roads: { pct: 90, label: 'painting the roads…' },
  console: { pct: 96, label: 'wiring the console…' },
  firstFrame: { pct: 100, label: 'rendering the first frame…' },
} as const satisfies Record<string, BootStep>

export type FrameScheduler = (callback: () => void) => void

/**
 * Resume only after the updated boot state has crossed a paint boundary.
 * Resolving inside one animation frame resumes its microtasks before paint.
 */
export function waitForNextPaint(
  schedule: FrameScheduler = (callback) => requestAnimationFrame(callback),
): Promise<void> {
  return new Promise((resolve) => schedule(() => schedule(resolve)))
}

export interface BootSurface {
  root: HTMLElement | null
  fill: HTMLElement | null
  status: HTMLElement | null
}

export function presentBootStep(
  surface: BootSurface,
  step: BootStep,
  wait: () => Promise<void> = waitForNextPaint,
): Promise<void> {
  if (surface.fill) surface.fill.style.width = `${step.pct}%`
  if (surface.status) surface.status.textContent = step.label
  return wait()
}

export function finishBoot(surface: BootSurface): void {
  if (surface.fill) surface.fill.style.width = '100%'
  if (surface.status) surface.status.textContent = 'ready'
  surface.root?.classList.add('done')
}

export function failBoot(surface: BootSurface, message: string): void {
  if (surface.status) {
    surface.status.textContent = message
    surface.status.style.color = 'var(--c-crit)'
  }
  if (surface.fill) surface.fill.style.background = 'var(--c-crit)'
}
