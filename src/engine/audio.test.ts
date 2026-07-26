import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBus } from '../core/bus'
import hudSource from '../ui/hud.ts?raw'

class FakeParam {
  value = 0
  cancelScheduledValues(): void {}
  setValueAtTime(value: number): void {
    this.value = value
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value
  }
  exponentialRampToValueAtTime(value: number): void {
    this.value = value
  }
  setTargetAtTime(value: number): void {
    this.value = value
  }
}

class FakeNode {
  readonly connections: FakeNode[] = []
  connect(node: FakeNode): FakeNode {
    this.connections.push(node)
    return node
  }
  disconnect(): void {
    this.connections.length = 0
  }
}

class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeParam()
  readonly Q = new FakeParam()
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam()
}

class FakeSource extends FakeNode {
  buffer: AudioBuffer | null = null
  readonly playbackRate = new FakeParam()
  onended: ((this: AudioScheduledSourceNode, event: Event) => unknown) | null = null
  start(): void {}
  stop(): void {}
}

class FakeContext {
  static latest: FakeContext | null = null
  state: AudioContextState = 'suspended'
  readonly sampleRate = 100
  readonly currentTime = 0
  readonly destination = new FakeNode()
  readonly resume = vi.fn(async () => {
    this.state = 'running'
  })
  readonly suspend = vi.fn(async () => {
    this.state = 'suspended'
  })
  readonly close = vi.fn(async () => {
    this.state = 'closed'
  })
  sourceCount = 0
  readonly nodes: FakeNode[] = []

  constructor() {
    FakeContext.latest = this
  }

  createBiquadFilter(): BiquadFilterNode {
    const filter = new FakeFilter()
    this.nodes.push(filter)
    return filter as unknown as BiquadFilterNode
  }
  createGain(): GainNode {
    const gain = new FakeGain()
    this.nodes.push(gain)
    return gain as unknown as GainNode
  }
  createBuffer(_channels: number, length: number): AudioBuffer {
    const samples = new Float32Array(length)
    return { getChannelData: () => samples } as unknown as AudioBuffer
  }
  createBufferSource(): AudioBufferSourceNode {
    this.sourceCount++
    const source = new FakeSource()
    this.nodes.push(source)
    return source as unknown as AudioBufferSourceNode
  }
}

function installAudioWindow(): void {
  const stored = new Map<string, string>()
  const fakeWindow = {
    AudioContext: FakeContext,
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    matchMedia: () => ({
      matches: true,
      addEventListener: () => {},
    }),
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: fakeWindow,
  })
}

afterEach(() => {
  vi.resetModules()
  Reflect.deleteProperty(globalThis, 'window')
  FakeContext.latest = null
})

describe('movement audio', () => {
  it('resumes in the enabling gesture and creates source nodes in step with distance', async () => {
    installAudioWindow()
    vi.resetModules()
    const { createAudio } = await import('./audio')
    const audio = createAudio(createBus())

    await audio.enable()
    const context = FakeContext.latest!
    expect(context.state).toBe('running')
    expect(context.resume).toHaveBeenCalledOnce()
    expect(context.nodes.some((node) => node.connections.includes(context.destination))).toBe(true)
    expect(audio.volume).toBeGreaterThan(0)

    const step = (distance: number) =>
      audio.step(0.1, {
        distance,
        speed: 2.4,
        gait: 'walk',
        grounded: true,
        surface: 'deck',
        submerged: false,
      })
    step(0)
    step(0.74)
    expect(context.sourceCount).toBe(0)
    step(0.76)
    expect(context.sourceCount).toBe(1)
    step(3.01)
    expect(context.sourceCount).toBe(4)
    audio.dispose()
  })

  it('keeps a labelled, stateful sound control in the always-visible HUD', () => {
    expect(hudSource).toContain("class: 'pg-btn hud-tool hud-audio'")
    expect(hudSource).toContain("text: 'Sound off'")
    expect(hudSource).toContain("enabled ? 'Sound on'")
    expect(hudSource).toMatch(/toolCluster[\s\S]*audioBtn/)
  })
})
