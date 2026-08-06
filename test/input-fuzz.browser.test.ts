import { describe, expect, it } from 'vitest'

import { inspectRenderedPages } from './disclosure-browser.mjs'
import type { InputAction, InputFinding } from './input-fuzz-browser'

interface SequenceFinding {
  seed: string
  step: number
  action: InputAction
  observedPrefix: InputAction[]
  shortestSequence?: InputAction[]
  findings: InputFinding[]
}

interface SequenceReport {
  seed: string
  steps: number
  counts: Record<string, number>
  frameCount: { before: number; after: number }
  findings: SequenceFinding[]
}

interface FuzzReport {
  regressions: SequenceFinding[]
  sequences: SequenceReport[]
  backgroundBlurs: number
}

const DEFAULT_SEEDS = [0x1a2b3c4d, 0xc0ffee42]
const DEFAULT_STEPS = 128
const INPUT_FUZZ_TIMEOUT_MS = Number.parseInt(
  process.env.INPUT_FUZZ_TIMEOUT_MS ?? '360000',
  10,
)

function parseSeeds(): number[] {
  const raw = process.env.INPUT_FUZZ_SEEDS
  if (!raw) return DEFAULT_SEEDS
  return raw.split(',').map((part) => Number.parseInt(part.trim(), 0) >>> 0)
}

function seedLabel(seed: number): string {
  return `0x${seed.toString(16).padStart(8, '0')}`
}

function randomSource(seed: number): () => number {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function choose<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function integer(random: () => number, min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min
}

function randomAction(random: () => number): InputAction {
  const kind = integer(random, 0, 14)
  if (kind === 0) return { kind: 'mode', mode: choose(random, ['orbit', 'fly', 'walk'] as const) }
  if (kind === 1) {
    return {
      kind: 'pointer-drag',
      gesture: choose(random, ['pan', 'orbit', 'look'] as const),
      dx: integer(random, -90, 90) || 31,
      dy: integer(random, -70, 70) || -23,
    }
  }
  if (kind === 2) {
    return {
      kind: 'touch-gesture',
      gesture: choose(random, ['pan', 'pinch', 'twist'] as const),
      amount: integer(random, 18, 56),
    }
  }
  if (kind === 3) {
    const key = choose(random, [
      ['w', 'KeyW'],
      ['a', 'KeyA'],
      ['ArrowUp', 'ArrowUp'],
      ['ArrowLeft', 'ArrowLeft'],
      ['PageUp', 'PageUp'],
    ] as const)
    return {
      kind: 'keyboard-move',
      key: key[0],
      code: key[1],
      frames: integer(random, 1, 8),
      shift: random() < 0.25,
    }
  }
  if (kind === 4) return { kind: 'walk-touch', dx: integer(random, -42, 42), dy: integer(random, -58, -22) }
  if (kind === 5) {
    return {
      kind: 'touch-gesture',
      gesture: choose(random, ['pan', 'pinch', 'twist'] as const),
      amount: integer(random, 18, 56),
    }
  }
  if (kind === 6) {
    return {
      kind: 'panel',
      panel: choose(random, ['console', 'inspector', 'help', 'palette', 'city-words'] as const),
      open: random() < 0.55,
    }
  }
  if (kind === 7) return { kind: 'tour', running: random() < 0.5 }
  if (kind === 8) return { kind: 'scenario', id: random() < 0.45 ? null : 'connection-storm' }
  if (kind === 9) {
    return { kind: 'quality', level: choose(random, ['reduced', 'low', 'medium', 'high'] as const) }
  }
  if (kind === 10) return { kind: 'theme' }
  if (kind === 11) return { kind: 'reset' }
  if (kind === 12) return { kind: 'theme' }
  if (kind === 13) return { kind: 'reset' }
  return { kind: 'pointer-drag', gesture: 'pan', dx: integer(random, -64, 64) || 27, dy: integer(random, -40, 40) || 19 }
}

function coveragePrelude(): InputAction[] {
  return [
    { kind: 'viewport', width: 390, height: 844, mobile: true },
    { kind: 'mode', mode: 'orbit' },
    { kind: 'pointer-drag', gesture: 'pan', dx: 53, dy: 19 },
    { kind: 'pointer-drag', gesture: 'orbit', dx: -47, dy: 31 },
    { kind: 'touch-gesture', gesture: 'pan', amount: 34 },
    { kind: 'touch-gesture', gesture: 'pinch', amount: 29 },
    { kind: 'touch-gesture', gesture: 'twist', amount: 38 },
    { kind: 'mode', mode: 'fly' },
    { kind: 'pointer-drag', gesture: 'look', dx: 41, dy: -28 },
    { kind: 'keyboard-move', key: 'w', code: 'KeyW', frames: 7 },
    { kind: 'mode', mode: 'walk' },
    { kind: 'keyboard-move', key: 'w', code: 'KeyW', frames: 7 },
    { kind: 'walk-touch', dx: 18, dy: -52 },
    { kind: 'pool', direction: 'enter' },
    { kind: 'pool', direction: 'leave' },
    { kind: 'mode', mode: 'walk' },
    { kind: 'walk-touch', hold: true, dx: 0, dy: -58 },
    { kind: 'background' },
    { kind: 'walk-touch', dx: 22, dy: -48 },
    { kind: 'mode', mode: 'walk' },
    { kind: 'tour', running: true },
    { kind: 'tour', running: false },
    { kind: 'mode', mode: 'walk' },
    { kind: 'scenario', id: 'connection-storm' },
    { kind: 'scenario', id: null },
    { kind: 'panel', panel: 'console', open: true },
    { kind: 'panel', panel: 'inspector', open: true },
    { kind: 'panel', panel: 'help', open: true },
    { kind: 'panel', panel: 'help', open: false },
    { kind: 'panel', panel: 'palette', open: true },
    { kind: 'panel', panel: 'palette', open: false },
    { kind: 'panel', panel: 'city-words', open: true },
    { kind: 'panel', panel: 'city-words', open: false },
    { kind: 'quality', level: 'medium' },
    { kind: 'theme' },
    { kind: 'reset' },
    { kind: 'viewport', width: 1280, height: 760, mobile: false },
    { kind: 'viewport', width: 390, height: 844, mobile: true },
  ]
}

function generateSequence(seed: number, steps: number): InputAction[] {
  const random = randomSource(seed)
  const sequence = coveragePrelude()
  while (sequence.length < steps) sequence.push(randomAction(random))
  return sequence.slice(0, steps)
}

const PRELOAD = `(() => {
  const telemetry = window.__PG_INPUT_FUZZ_TELEMETRY__ = {
    appFrames: 0,
    blurs: 0,
    errors: [],
    rejections: [],
  }
  const nativeRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (callback) => nativeRaf((time) => {
    if (callback.name === 'frame') telemetry.appFrames += 1
    callback(time)
  })
  window.addEventListener('blur', () => { telemetry.blurs += 1 })
  window.addEventListener('error', (event) => {
    telemetry.errors.push(String(event.error?.stack || event.message || event.error))
  })
  window.addEventListener('unhandledrejection', (event) => {
    telemetry.rejections.push(String(event.reason?.stack || event.reason))
  })
})()`

describe('seeded real-browser input sequences', () => {
  it('keeps camera, walker, UI input, and the frame loop coherent', async () => {
    const seeds = parseSeeds()
    const steps = Number.parseInt(process.env.INPUT_FUZZ_STEPS ?? String(DEFAULT_STEPS), 10)
    process.stdout.write(`[input-fuzz] seeds=${seeds.map(seedLabel).join(',')} steps=${steps}\n`)

    const [report] = await inspectRenderedPages([{
      name: 'City input fuzz',
      path: '/',
      readySelector: '#canvas-root canvas',
      beforeLoad: PRELOAD,
      prepare: `(async () => {
        for (let attempt = 0; attempt < 240 && !window.PGSIMCITY; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        if (!window.PGSIMCITY) throw new Error('PGSimCity did not expose its browser handle')
        window.PGSIMCITY.sim.setKnob('paused', true)
        window.PGSIMCITY.bus.emit('quality', { level: 'low' })
      })()`,
    }], async ({ evaluate, send }) => {
      const moduleCall = (body: string) => evaluate(`(async () => {
        const fuzz = await (window.__PG_INPUT_FUZZ_MODULE__ ??= import('/test/input-fuzz-browser.ts'))
        ${body}
      })()`)
      const inspect = (full = false) => moduleCall(
        `return fuzz.inspectInputState(window.PGSIMCITY, ${full})`,
      ) as Promise<InputFinding[]>
      const reset = () => moduleCall(
        `return fuzz.resetInputState(window.PGSIMCITY)`,
      ) as Promise<InputFinding[]>
      const perform = (action: InputAction, full = false) => moduleCall(
        `return fuzz.performInputAction(window.PGSIMCITY, ${JSON.stringify(action)}, ${full})`,
      ) as Promise<InputFinding[]>
      const frameCount = () => moduleCall('return fuzz.frameLoopCount()') as Promise<number>
      const blurCount = () => moduleCall('return fuzz.blurCount()') as Promise<number>

      const viewport = async (action: Extract<InputAction, { kind: 'viewport' }>): Promise<void> => {
        await send('Emulation.setDeviceMetricsOverride', {
          width: action.width,
          height: action.height,
          deviceScaleFactor: 1,
          mobile: action.mobile,
        })
        await send('Emulation.setTouchEmulationEnabled', {
          enabled: action.mobile,
          maxTouchPoints: 5,
        })
        await evaluate('window.dispatchEvent(new Event(\'resize\'))')
      }

      const background = async (): Promise<void> => {
        const current = await send('Target.getTargetInfo') as { targetInfo: { targetId: string } }
        const created = await send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
        await send('Target.activateTarget', { targetId: created.targetId })
        await new Promise((resolve) => setTimeout(resolve, 80))
        await send('Target.activateTarget', { targetId: current.targetInfo.targetId })
        await send('Target.closeTarget', { targetId: created.targetId })
      }

      const runAction = async (action: InputAction, full = false): Promise<InputFinding[]> => {
        if (action.kind === 'viewport') {
          await viewport(action)
          return inspect(full)
        }
        if (action.kind === 'background') {
          await background()
          return inspect(full)
        }
        return perform(action, full)
      }

      const regression = async (
        seed: string,
        sequence: InputAction[],
      ): Promise<SequenceFinding | null> => {
        const resetFindings = await reset()
        if (resetFindings.length > 0) {
          return {
            seed,
            step: -1,
            action: sequence[0],
            observedPrefix: [],
            shortestSequence: [],
            findings: resetFindings,
          }
        }
        let latest: InputFinding[] = []
        for (let index = 0; index < sequence.length; index++) {
          latest = await runAction(sequence[index], index === sequence.length - 1)
        }
        return latest.length > 0
          ? {
              seed,
              step: sequence.length - 1,
              action: sequence[sequence.length - 1],
              observedPrefix: sequence,
              shortestSequence: sequence,
              findings: latest,
            }
          : null
      }

      const regressions = (await (async () => [
        await regression('0x57414c4b', [
          { kind: 'mode', mode: 'walk' },
          { kind: 'tour', running: true },
        ]),
      ])()).filter((finding): finding is SequenceFinding => finding !== null)

      // Stop here on a known two/four-action regression: the shortest replay is
      // already in the report and a long tail would only obscure its cause.
      if (regressions.length > 0) {
        return { regressions, sequences: [], backgroundBlurs: await blurCount() } satisfies FuzzReport
      }

      const sequences: SequenceReport[] = []
      for (const seed of seeds) {
        await reset()
        await viewport({ kind: 'viewport', width: 390, height: 844, mobile: true })
        const actions = generateSequence(seed, steps)
        const counts: Record<string, number> = {}
        const findings: SequenceFinding[] = []
        const before = await frameCount()
        for (let index = 0; index < actions.length; index++) {
          if (index > 0 && index % 32 === 0) {
            process.stdout.write(`[input-fuzz] seed=${seedLabel(seed)} progress=${index}/${actions.length}\n`)
          }
          const action = actions[index]
          counts[action.kind] = (counts[action.kind] ?? 0) + 1
          const actionFindings = await runAction(action, index % 12 === 0)
          if (actionFindings.length > 0) {
            findings.push({
              seed: seedLabel(seed),
              step: index,
              action,
              observedPrefix: actions.slice(0, index + 1),
              findings: actionFindings,
            })
            break
          }
        }
        if (findings.length === 0) {
          const recovery = await moduleCall('return fuzz.proveInputRecovery(window.PGSIMCITY)') as InputFinding[]
          if (recovery.length > 0) {
            findings.push({
              seed: seedLabel(seed),
              step: actions.length,
              action: actions[actions.length - 1],
              observedPrefix: actions,
              findings: recovery,
            })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        const after = await frameCount()
        if (after - before < 2) {
          findings.push({
            seed: seedLabel(seed),
            step: actions.length,
            action: actions[actions.length - 1],
            observedPrefix: actions,
            findings: [{
              invariant: 'frame-loop',
              detail: `production frame callback advanced ${after - before} times`,
            }],
          })
        }
        sequences.push({
          seed: seedLabel(seed),
          steps: actions.length,
          counts,
          frameCount: { before, after },
          findings,
        })
      }
      return { regressions, sequences, backgroundBlurs: await blurCount() } satisfies FuzzReport
    }) as [FuzzReport]

    if (report.regressions.length > 0 || report.sequences.some((sequence) => sequence.findings.length > 0)) {
      console.info(`[input-fuzz] findings=${JSON.stringify(report, null, 2)}`)
    }
    for (const sequence of report.sequences) {
      process.stdout.write(
        `[input-fuzz] seed=${sequence.seed} actions=${sequence.steps}`
        + ` frames=${sequence.frameCount.after - sequence.frameCount.before}`
        + ` counts=${JSON.stringify(sequence.counts)}\n`,
      )
    }

    expect(report.backgroundBlurs, 'the background action never blurred the production tab').toBeGreaterThan(0)
    expect(report.regressions).toEqual([])
    expect(report.sequences.map((sequence) => ({
      seed: sequence.seed,
      steps: sequence.steps,
      missing: [
        'background',
        'keyboard-move',
        'mode',
        'panel',
        'pointer-drag',
        'pool',
        'quality',
        'reset',
        'scenario',
        'theme',
        'touch-gesture',
        'tour',
        'viewport',
        'walk-touch',
      ].filter((kind) => !sequence.counts[kind]),
    }))).toEqual(seeds.map((seed) => ({
      seed: seedLabel(seed),
      steps,
      missing: [],
    })))
    expect(report.sequences.flatMap((sequence) => sequence.findings)).toEqual([])
  // Browser-slot queue time and software WebGL are host contention, not input behavior.
  }, INPUT_FUZZ_TIMEOUT_MS)
})
