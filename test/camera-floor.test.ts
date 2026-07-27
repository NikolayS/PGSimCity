import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* A Hacker News visitor reported the screen going blank when they zoomed in.
 * The camera was dollying inside the buildings it was looking at, so every
 * surface in frame was back-faced. The manual dolly is now clamped at
 * MIN_DOLLY_DIST, but six other paths -- focus, presets, tweens, the plan
 * framing -- clamp at MIN_DIST, which is well inside the range the city stops
 * rendering in. No authored spec is currently that close. This keeps it that
 * way, because the failure is silent and total: you do not get a glitch, you
 * get nothing, with no clue how to get back. */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

function constant(src: string, name: string): number {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`).exec(src)
  if (!m) throw new Error(`${name} not found`)
  return Number(m[1])
}

describe('camera never reaches the blank range', () => {
  const camera = read('../src/engine/camera.ts')
  const floor = constant(camera, 'MIN_DOLLY_DIST')

  it('keeps a readable floor on the manual dolly', () => {
    // Measured: the readable city disappears from about 16 units inward.
    expect(floor).toBeGreaterThanOrEqual(16)
  })

  it('has no authored focus spec closer than that floor', () => {
    const sources = ['../src/world/layout.ts', '../src/world/shmem.ts', '../src/world/storage.ts']
    const tooClose: string[] = []
    for (const rel of sources) {
      let src: string
      try {
        src = read(rel)
      } catch {
        continue
      }
      for (const m of src.matchAll(/distance:\s*([0-9.]+)/g)) {
        const d = Number(m[1])
        // distance: 0 appears in non-camera contexts; only flag real framings.
        if (d > 0 && d < floor) tooClose.push(`${rel} -> distance: ${d}`)
      }
    }
    expect(tooClose, 'a focus spec inside the blank range').toEqual([])
  })
})
