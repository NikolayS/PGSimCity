import * as THREE from 'three'
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js'
import { afterAll, describe, expect, it } from 'vitest'

/*
 * SVGLoader only needs this small XML surface for the one-element SVG used by
 * slonik.ts. Keeping it here makes the geometry tests run in Node without a
 * browser or another DOM dependency while still exercising three.js's parser.
 */
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

class SvgDocument {
  constructor(readonly documentElement: SvgElement) {}

  querySelectorAll(_selectors: string): readonly SvgElement[] {
    return []
  }
}

class TestDomParser {
  parseFromString(text: string): Document {
    const paths = [...text.matchAll(/<path\s+[^>]*d="([^"]*)"[^>]*>/g)].map(
      (match) => new SvgElement('path', { d: match[1] }),
    )
    return new SvgDocument(new SvgElement('svg', {}, paths)) as unknown as Document
  }
}

const nativeDomParser = globalThis.DOMParser
globalThis.DOMParser = TestDomParser as unknown as typeof DOMParser

const {
  LOGO_OUTLINE_D,
  SLONIK_CONTAINMENT,
  rectClearance,
  sampleOutline,
} = await import('./slonik')
const { DISTRICT_BOUNDS } = await import('./layout')

afterAll(() => {
  globalThis.DOMParser = nativeDomParser
})

interface OutlineMeasurements {
  readonly width: number
  readonly height: number
  readonly area: number
  readonly trunkFraction: number
}

function parseOutline(pathData: string): ReturnType<SVGLoader['parse']> {
  return new SVGLoader().parse(
    `<svg xmlns="http://www.w3.org/2000/svg"><path d="${pathData}"/></svg>`,
  )
}

function flatten(shape: THREE.Shape, samplesPerCurve = 64): THREE.Vector2[] {
  const points = [shape.curves[0].getPoint(0)]
  for (const curve of shape.curves) {
    for (let sample = 1; sample <= samplesPerCurve; sample++) {
      points.push(curve.getPoint(sample / samplesPerCurve))
    }
  }
  return points
}

function measure(points: readonly THREE.Vector2[]): OutlineMeasurements {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  let area2 = 0

  for (let i = 0, previous = points.length - 1; i < points.length; previous = i++) {
    const point = points[i]
    const prior = points[previous]
    x0 = Math.min(x0, point.x)
    x1 = Math.max(x1, point.x)
    y0 = Math.min(y0, point.y)
    y1 = Math.max(y1, point.y)
    area2 += prior.x * point.y - point.x * prior.y
  }

  const width = x1 - x0
  const height = y1 - y0
  const rows = 40
  const rowWidths = Array.from({ length: rows }, (_, row) => {
    const lower = y0 + (row / rows) * height
    const upper = y0 + ((row + 1) / rows) * height
    const band = points.filter((point) => point.y >= lower && point.y < upper)
    if (band.length === 0) return 0
    const xs = band.map((point) => point.x)
    return Math.max(...xs) - Math.min(...xs)
  })

  /*
   * SVG y increases downward, so the trunk starts at the last row. Its narrow
   * run ends at the first row reaching one third of the body's maximum width.
   */
  const widest = Math.max(...rowWidths)
  let trunkRows = 0
  for (
    let row = rows - 1;
    row >= 0 && rowWidths[row] < widest / 3;
    row--
  ) {
    trunkRows++
  }

  return {
    width,
    height,
    area: Math.abs(area2) / 2,
    trunkFraction: trunkRows / rows,
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('Slonik plate outline', () => {
  it('keeps the reviewed vector data byte-for-byte', async () => {
    expect(typeof LOGO_OUTLINE_D).toBe('string')
    // 800–1,000 bytes distinguishes genuine path data from a short hand sketch.
    expect(LOGO_OUTLINE_D.length).toBeGreaterThan(800)
    expect(LOGO_OUTLINE_D.length).toBeLessThan(1_000)
    expect(LOGO_OUTLINE_D).toHaveLength(900)
    expect(await sha256(LOGO_OUTLINE_D)).toBe(
      '91da186b68256a1d14a57cc8c43db71888b12a4cfde86c92f295fafc6b611e63',
    )
  })

  it('parses as exactly one closed outline', () => {
    const parsed = parseOutline(LOGO_OUTLINE_D)
    const shapes = parsed.paths.flatMap((path) => path.toShapes())

    expect(parsed.paths).toHaveLength(1)
    expect(parsed.paths[0].subPaths).toHaveLength(1)
    expect(shapes).toHaveLength(1)
    expect(parsed.paths[0].subPaths[0].autoClose).toBe(true)

    const points = flatten(shapes[0])
    /*
     * The source path closes with `z`; its last authored cubic also finishes
     * within 0.01 SVG unit of the start, rejecting a large implicit seam while
     * allowing the source artwork's 0.002-unit rounding difference.
     */
    expect(points.at(-1)!.distanceTo(points[0])).toBeLessThan(0.01)
  })

  it('stays taller than wide without becoming unnaturally narrow', () => {
    const shape = parseOutline(LOGO_OUTLINE_D).paths[0].toShapes()[0]
    const { width, height } = measure(flatten(shape))
    const aspect = width / height

    /*
     * The reviewed mark is 0.967. The 0.90 floor allows about 7% horizontal
     * redraw while the strict 1.0 ceiling catches the wider-than-tall blob.
     */
    expect(aspect).toBeGreaterThanOrEqual(0.9)
    expect(aspect).toBeLessThan(1)
  })

  it('keeps a substantial narrow lower trunk', () => {
    const shape = parseOutline(LOGO_OUTLINE_D).paths[0].toShapes()[0]
    const { trunkFraction } = measure(flatten(shape))

    /*
     * The reviewed outline occupies 10 of 40 rows (25%). A 20% floor leaves
     * two bands for a legitimate redraw and remains twice the blob's 3–10%.
     */
    expect(trunkFraction).toBeGreaterThanOrEqual(0.2)
  })

  it('keeps the reviewed silhouette area without silent inflation', () => {
    const shape = parseOutline(LOGO_OUTLINE_D).paths[0].toShapes()[0]
    const { area } = measure(flatten(shape))

    /*
     * The reviewed area is 108,355 SVG units². A ±6% envelope tolerates small
     * curve changes but rejects roughly 3% uniform scaling or accumulated
     * outward edits of the magnitude that produced the blob.
     */
    expect(area).toBeGreaterThan(102_000)
    expect(area).toBeLessThan(115_000)
  })

  it('pins every district margin and both containment minima', () => {
    const expectedDistrictMargins: Readonly<Record<string, number>> = {
      clients: 9.16,
      backends: 33.61,
      shmem: 101.45,
      wal: 136.7,
      storage: 21.87,
      maintenance: 16.92,
      replication: 9.4,
      planner: 87.61,
    }
    const ring = sampleOutline(48)
    const actualDistricts = Object.keys(DISTRICT_BOUNDS)
      .filter((id) => id !== 'world')
      .sort()

    expect(actualDistricts).toEqual(Object.keys(expectedDistrictMargins).sort())
    for (const id of actualDistricts) {
      const bounds = DISTRICT_BOUNDS[id]
      const margin = rectClearance(
        ring,
        bounds.x[0],
        bounds.x[1],
        bounds.z[0],
        bounds.z[1],
        96,
      )
      expect(margin, `${id} must clear the kerb margin`).toBeGreaterThanOrEqual(
        SLONIK_CONTAINMENT.requiredClearance,
      )
      /*
       * Sampling is deterministic, so 0.05 m is enough numeric tolerance.
       * Pinning the values makes even a passing outward expansion visible.
       */
      expect(margin, `${id} margin changed`).toBeCloseTo(
        expectedDistrictMargins[id],
        1,
      )
    }

    expect(SLONIK_CONTAINMENT.requiredClearance).toBe(8)
    expect(SLONIK_CONTAINMENT.districtAtMinimum).toBe('clients')
    expect(SLONIK_CONTAINMENT.districtMinimum).toBeCloseTo(9.16, 1)
    expect(SLONIK_CONTAINMENT.anchorAtMinimum).toBe('objectStore')
    expect(SLONIK_CONTAINMENT.anchorMinimum).toBeCloseTo(54.11, 1)
  })
})
