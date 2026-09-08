import { Vector4, type WebGLRenderer } from 'three'

/** Approximate ceiling for the composer targets, excluding existing scene assets. */
export const EXPORT_MAX_PIXELS = 4_000_000
export const EXPORT_4K_MAX_PIXELS = 3840 * 2160

/** Frame callbacks are constructed once by boot, not allocated per animation frame. */
export function dispatchPresentationFrame(presenting: boolean, live: () => void, frozen: () => void): void {
  if (presenting) frozen()
  else live()
}

export function exportDimensions(width: number, height: number, scale: 1 | 2 | '4k', maxDimension: number) {
  if (![width, height, maxDimension].every((v) => Number.isFinite(v) && v >= 1) || (scale !== 1 && scale !== 2 && scale !== '4k')) {
    throw new Error('Invalid presentation dimensions')
  }
  const requested = scale === '4k' ? Math.min(3840 / Math.max(width, height), 2160 / Math.min(width, height)) : scale
  const budget = scale === '4k' ? EXPORT_4K_MAX_PIXELS : EXPORT_MAX_PIXELS
  const factor = Math.min(requested, maxDimension / width, maxDimension / height, Math.sqrt(budget / (width * height)))
  return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) }
}

export async function withPresentationPause<T>(
  getPaused: () => boolean,
  setPaused: (paused: boolean) => void,
  work: () => Promise<T>,
): Promise<T> {
  const previous = getPaused()
  setPaused(true)
  try {
    return await work()
  } finally {
    setPaused(previous)
  }
}

export function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG encoding failed. Try the smaller image size.')), 'image/png')
  })
}

export interface RasterSize { width: number; height: number; ratio: number }

/** The caller supplies its existing output pipeline, never a second ungraded renderer. */
export function captureRasterFrame(
  renderer: WebGLRenderer,
  width: number,
  height: number,
  previous: RasterSize,
  resize: (size: RasterSize) => void,
  draw: () => void,
  createCanvas = () => document.createElement('canvas'),
): HTMLCanvasElement {
  const gl = renderer.getContext()
  if (gl.isContextLost()) throw new Error('WebGL context is unavailable. Wait for the city to recover.')
  const viewportLimit = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array
  const maxDimension = Math.min(renderer.capabilities.maxTextureSize,
    gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, viewportLimit[0], viewportLimit[1])
  if (![width, height].every((v) => Number.isInteger(v) && v > 0) ||
    width * height > EXPORT_4K_MAX_PIXELS || Math.max(width, height) > maxDimension) {
    throw new Error('Presentation image exceeds the safe render size')
  }
  const target = renderer.getRenderTarget()
  const viewport = renderer.getViewport(new Vector4())
  const scissor = renderer.getScissor(new Vector4())
  const scissorTest = renderer.getScissorTest()
  const snapshot = createCanvas()
  snapshot.width = width
  snapshot.height = height
  const context = snapshot.getContext('2d')
  if (!context) {
    snapshot.width = snapshot.height = 1
    throw new Error('Presentation canvas is unavailable')
  }
  try {
    resize({ width, height, ratio: 1 })
    renderer.setRenderTarget(null)
    renderer.setScissorTest(false)
    draw()
    if (gl.isContextLost()) throw new Error('WebGL context was lost during export. Try the smaller image size.')
    context.drawImage(renderer.domElement, 0, 0)
    return snapshot
  } catch (error) {
    snapshot.width = snapshot.height = 1
    throw error
  } finally {
    try { resize(previous) } finally {
      renderer.setRenderTarget(target)
      renderer.setViewport(viewport)
      renderer.setScissor(scissor)
      renderer.setScissorTest(scissorTest)
    }
  }
}
