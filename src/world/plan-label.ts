export interface PlanLabelRecord {
  readonly text: string
  readonly x: number
  readonly z: number
  readonly size: number
  readonly rotation: number
  readonly ratio: Readonly<Record<'day' | 'night', number>>
  readonly backing: Readonly<Record<'day' | 'night', string>>
}

interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

interface Veil {
  readonly color: number
  readonly opacity: number
  readonly name: string
}

export interface PlanLabelPainterOptions {
  readonly pixelsPerUnit: number
  readonly x: (worldX: number) => number
  readonly y: (worldZ: number) => number
  readonly surfaceName: string
  readonly dayVeil?: Veil
  readonly plate?: {
    readonly background: string
    readonly ink: string
    readonly name: string
    readonly paddingX: number
    readonly paddingY: number
  }
}

export interface PlanLabelPainter {
  readonly records: readonly PlanLabelRecord[]
  draw(
    text: string,
    worldX: number,
    worldZ: number,
    size: number,
    color: string,
    align?: CanvasTextAlign,
    rotation?: number,
  ): void
}

function parseColor(css: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim())
  if (hex) {
    const value = Number.parseInt(hex[1], 16)
    return { r: value >> 16, g: (value >> 8) & 0xff, b: value & 0xff, a: 1 }
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(css.trim())
  if (!rgba) throw new Error(`Unsupported plan-label colour: ${css}`)
  return {
    r: Number(rgba[1]),
    g: Number(rgba[2]),
    b: Number(rgba[3]),
    a: rgba[4] === undefined ? 1 : Number(rgba[4]),
  }
}

function fromHex(color: number, opacity: number): Rgba {
  return { r: color >> 16, g: (color >> 8) & 0xff, b: color & 0xff, a: opacity }
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a)
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  }
}

function linear(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(color: Rgba): number {
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

function contrastRatio(a: Rgba, b: Rgba): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
}

function rotatedBounds(
  centerX: number,
  centerY: number,
  width: number,
  height: number,
  align: CanvasTextAlign,
  rotation: number,
): readonly [number, number, number, number] {
  const left = align === 'right' || align === 'end' ? -width : align === 'center' ? -width / 2 : 0
  const right = left + width
  const top = -height / 2
  const bottom = height / 2
  const cosine = Math.cos(rotation)
  const sine = Math.sin(rotation)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const [x, y] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
    const px = centerX + x * cosine - y * sine
    const py = centerY + x * sine + y * cosine
    minX = Math.min(minX, px)
    minY = Math.min(minY, py)
    maxX = Math.max(maxX, px)
    maxY = Math.max(maxY, py)
  }
  return [Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY)]
}

function measuredContrast(
  context: CanvasRenderingContext2D,
  bounds: readonly [number, number, number, number],
  ink: Rgba,
  veil?: Veil,
): number {
  const left = Math.max(0, bounds[0])
  const top = Math.max(0, bounds[1])
  const right = Math.min(context.canvas.width, bounds[2])
  const bottom = Math.min(context.canvas.height, bounds[3])
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  if (width === 0 || height === 0) return 1
  const image = context.getImageData(left, top, width, height) as ImageData | undefined
  if (!image) return 1
  const pixels = image.data
  const overlay = veil ? fromHex(veil.color, veil.opacity) : null
  let minimum = Number.POSITIVE_INFINITY
  for (let offset = 0; offset < pixels.length; offset += 4) {
    let backing: Rgba = {
      r: pixels[offset],
      g: pixels[offset + 1],
      b: pixels[offset + 2],
      a: pixels[offset + 3] / 255,
    }
    let foreground = composite(ink, backing)
    if (overlay) {
      backing = composite(overlay, backing)
      foreground = composite(overlay, foreground)
    }
    minimum = Math.min(minimum, contrastRatio(foreground, backing))
  }
  return Number.isFinite(minimum) ? minimum : 1
}

/** Draw and register every canvas label through the same measurable path. */
export function createPlanLabelPainter(
  context: CanvasRenderingContext2D,
  options: PlanLabelPainterOptions,
): PlanLabelPainter {
  const records: PlanLabelRecord[] = []
  return {
    records,
    draw(text, worldX, worldZ, size, color, align = 'center', rotation = 0): void {
      context.save()
      context.translate(options.x(worldX), options.y(worldZ))
      if (rotation) context.rotate(rotation)
      context.textAlign = align
      context.textBaseline = 'middle'
      context.font = `600 ${Math.round(size * options.pixelsPerUnit)}px ui-monospace, SFMono-Regular, Menlo, monospace`
      const width = context.measureText(text).width
      const height = size * options.pixelsPerUnit * 1.2
      const left = align === 'right' || align === 'end' ? -width : align === 'center' ? -width / 2 : 0
      if (options.plate) {
        const paddingX = options.plate.paddingX * options.pixelsPerUnit
        const paddingY = options.plate.paddingY * options.pixelsPerUnit
        const plateLeft = left - paddingX
        const plateTop = -height / 2 - paddingY
        const plateWidth = width + paddingX * 2
        const plateHeight = height + paddingY * 2
        context.fillStyle = options.plate.background
        context.beginPath()
        context.roundRect(plateLeft, plateTop, plateWidth, plateHeight, paddingY * 0.7)
        context.fill()
        /* The mechanism keeps its authored hue in a rule outside the ink box;
         * the neutral label itself never impersonates semantic neon. */
        context.fillStyle = color
        context.fillRect(
          plateLeft + paddingX * 0.3,
          plateTop + paddingY * 0.45,
          Math.max(2, options.pixelsPerUnit * 0.12),
          plateHeight - paddingY * 0.9,
        )
      }
      const bounds = rotatedBounds(
        options.x(worldX),
        options.y(worldZ),
        width,
        height,
        align,
        rotation,
      )
      const ink = parseColor(options.plate?.ink ?? color)
      const plateBacking = options.plate ? parseColor(options.plate.background) : null
      const authoredPlateRatio = plateBacking
        ? contrastRatio(composite(ink, plateBacking), plateBacking)
        : 1
      /* Pixel readback exists only for the Vite/Vitest audit. A phone should
       * not pay to prove a construction-time invariant already enforced in CI. */
      const night = import.meta.env.DEV
        ? measuredContrast(context, bounds, ink)
        : authoredPlateRatio
      const day = import.meta.env.DEV
        ? measuredContrast(context, bounds, ink, options.dayVeil)
        : authoredPlateRatio
      context.fillStyle = options.plate?.ink ?? color
      context.fillText(text, 0, 0)
      context.restore()
      const renderedWidth = Math.min(context.canvas.width, bounds[2]) - Math.max(0, bounds[0])
      const renderedHeight = Math.min(context.canvas.height, bounds[3]) - Math.max(0, bounds[1])
      if (renderedWidth <= 0 || renderedHeight <= 0) return
      records.push({
        text,
        x: worldX,
        z: worldZ,
        size,
        rotation,
        ratio: { day, night },
        backing: {
          day: options.plate?.name ?? options.dayVeil?.name ?? options.surfaceName,
          night: options.plate?.name ?? options.surfaceName,
        },
      })
    },
  }
}
