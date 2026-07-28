import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createTheme } from '../src/core/theme'
import type { QualitySettings, WorldContext } from '../src/core/types'
import { createSim } from '../src/sim/model'
import { installTestDom } from './dom'

class SvgElement {
  readonly nodeType = 1
  readonly style: Readonly<Record<string, string>> = {}

  constructor(
    readonly nodeName: string,
    private readonly attributes: Readonly<Record<string, string>> = {},
    readonly childNodes: readonly SvgElement[] = [],
  ) {}

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name)
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getAttributeNS(_namespace: string, name: string): string | null {
    return this.getAttribute(name)
  }

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class TestDomParser {
  parseFromString(text: string): Document {
    const paths = [...text.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
      (match) => new SvgElement('path', { d: match[1] }),
    )
    const root = new SvgElement('svg', {}, paths)
    return {
      documentElement: root,
      querySelectorAll: () => [],
    } as unknown as Document
  }
}

const nativeDomParser = globalThis.DOMParser
globalThis.DOMParser = TestDomParser as unknown as typeof DOMParser
const { createGround } = await import('../src/world/ground')
globalThis.DOMParser = nativeDomParser

const tourCss = readFileSync(fileURLToPath(new URL('../src/styles/tour.css', import.meta.url)), 'utf8')
const tokenCss = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8')

function installCanvasDom(): void {
  const dom = installTestDom()
  const originalCreate = dom.document.createElement.bind(dom.document)
  const gradient = { addColorStop() {} }
  const canvasContext = new Proxy(
    {
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: (text: string) => ({ width: text.length * 10 }),
    } as Record<PropertyKey, unknown>,
    {
      get(target, key) {
        return target[key] ?? (() => undefined)
      },
      set(target, key, value) {
        target[key] = value
        return true
      },
    },
  )

  Object.defineProperty(dom.document, 'createElement', {
    configurable: true,
    value(tag: string) {
      const element = originalCreate(tag)
      if (tag.toLowerCase() === 'canvas') {
        Object.defineProperty(element, 'getContext', {
          configurable: true,
          value: () => canvasContext,
        })
      }
      return element
    },
  })
}

function coneCount(root: THREE.Object3D): number {
  let count = 0
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.geometry instanceof THREE.ConeGeometry) count += 1
  })
  return count
}

describe('guided tour visibility', () => {
  it('has no full-viewport tour scrim in either theme', () => {
    expect(tourCss).not.toMatch(/body\.pg-tour::after\s*\{/)
    expect(tokenCss).not.toMatch(/body\.pg-tour::after\s*\{/)
  })

  it.each(['low', 'reduced'] as const)(
    'detaches light-cone geometry after quality changes to %s',
    (level) => {
      installCanvasDom()
      const bus = createBus()
      const sim = createSim(bus)
      const theme = createTheme()
      const quality: QualitySettings = {
        level: 'high',
        pixelRatio: 1,
        bloom: true,
        shadows: true,
        maxParticles: 1,
        maxLabels: 1,
        antialias: true,
      }
      const context: WorldContext = {
        scene: new THREE.Scene(),
        camera: new THREE.PerspectiveCamera(),
        bus,
        sim: sim.state,
        quality,
        register: () => undefined,
        flow: () => undefined,
        theme,
      }
      const ground = createGround(context)

      expect(coneCount(ground.group)).toBeGreaterThan(0)
      quality.level = level
      ground.update(0, sim.state, sim.state.t)
      expect(coneCount(ground.group)).toBe(0)

      ground.dispose?.()
      theme.dispose()
    },
  )
})
