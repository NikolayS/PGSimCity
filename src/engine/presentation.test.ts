import { describe, expect, it, vi } from 'vitest'
import { Vector4, type WebGLRenderer } from 'three'
import { captureRasterFrame, dispatchPresentationFrame, exportDimensions, pngBlob, withPresentationPause } from './presentation'

describe('presentation export bounds', () => {
  it('supersamples without changing the camera aspect', () => {
    expect(exportDimensions(1280, 760, 2, 8192)).toEqual({ width: 2560, height: 1520 })
  })
  it('bounds allocation and both GPU dimensions', () => {
    for (const [w, h] of [[7680, 4320], [100000, 10], [10, 100000], [390, 844]]) {
      const size = exportDimensions(w, h, 2, 2048)
      expect(size.width * size.height).toBeLessThanOrEqual(4_000_000)
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048)
      expect(Math.min(size.width, size.height)).toBeGreaterThanOrEqual(1)
    }
  })
  it('offers explicit 4K without raising the default memory ceiling', () => {
    expect(exportDimensions(1920, 1080, '4k', 8192)).toEqual({ width: 3840, height: 2160 })
    expect(exportDimensions(1080, 1920, '4k', 8192)).toEqual({ width: 2160, height: 3840 })
    expect(exportDimensions(1920, 1080, 2, 8192).width).toBeLessThan(3840)
    expect(exportDimensions(1920, 1080, '4k', 2048).width).toBe(2048)
  })
  it.each([0, -1, NaN, Infinity])('rejects unsafe dimensions %s', (value) => {
    expect(() => exportDimensions(value, 760, 2, 8192)).toThrow()
  })
})

describe('raster pipeline restoration', () => {
  function fixture() {
    const initial = { width: 1280, height: 760, ratio: 1.5 }
    let current = { ...initial }
    const target = { name: 'previous target' }
    const viewport = new Vector4(7, 9, 1280, 760)
    const scissor = new Vector4(2, 3, 500, 600)
    const gl = { MAX_VIEWPORT_DIMS: 1, MAX_RENDERBUFFER_SIZE: 2,
      getParameter: (key: number) => key === 1 ? new Int32Array([4096, 4096]) : 4096,
      isContextLost: vi.fn(() => false) }
    const renderer = {
      capabilities: { maxTextureSize: 8192 }, getContext: () => gl,
      getRenderTarget: () => target, getViewport: (v: Vector4) => v.copy(viewport),
      getScissor: (v: Vector4) => v.copy(scissor), getScissorTest: () => true,
      setRenderTarget: vi.fn(), setViewport: vi.fn(), setScissor: vi.fn(), setScissorTest: vi.fn(),
      domElement: { name: 'output canvas' },
    }
    const drawImage = vi.fn()
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement
    const resize = vi.fn((size) => { current = { ...size } })
    return { initial, current: () => current, target, viewport, scissor, gl, renderer, canvas, resize, drawImage }
  }

  it.each(['success', 'draw failure', 'resize failure', 'context loss'])('restores dimensions and render state after %s', (mode) => {
    const f = fixture()
    if (mode === 'resize failure') f.resize.mockImplementationOnce(() => { throw new Error('allocation failed') })
    const draw = vi.fn(() => {
      expect(f.current()).toEqual({ width: 2560, height: 1520, ratio: 1 })
      if (mode === 'draw failure') throw new Error('draw failed')
      if (mode === 'context loss') f.gl.isContextLost.mockReturnValue(true)
    })
    const capture = () => captureRasterFrame(f.renderer as unknown as WebGLRenderer, 2560, 1520,
      f.initial, f.resize, draw, () => f.canvas)
    if (mode === 'success') {
      expect(capture()).toBe(f.canvas)
      expect(f.drawImage).toHaveBeenCalledWith(f.renderer.domElement, 0, 0)
      expect(draw).toHaveBeenCalledOnce()
    } else expect(capture).toThrow()
    expect(f.current()).toEqual(f.initial)
    expect(f.renderer.setRenderTarget).toHaveBeenLastCalledWith(f.target)
    expect(f.renderer.setViewport).toHaveBeenLastCalledWith(f.viewport)
    expect(f.renderer.setScissor).toHaveBeenLastCalledWith(f.scissor)
    expect(f.renderer.setScissorTest).toHaveBeenLastCalledWith(true)
  })

  it('rejects GPU viewport overflow before allocating or drawing', () => {
    const f = fixture()
    const draw = vi.fn()
    expect(() => captureRasterFrame(f.renderer as unknown as WebGLRenderer, 5000, 1000,
      f.initial, f.resize, draw, () => f.canvas)).toThrow('safe render size')
    expect(f.resize).not.toHaveBeenCalled()
    expect(draw).not.toHaveBeenCalled()
  })

  it('reports an already-lost context before querying unavailable GPU limits', () => {
    const f = fixture()
    f.gl.isContextLost.mockReturnValue(true)
    f.gl.getParameter = () => { throw new Error('unavailable limits') }
    expect(() => captureRasterFrame(f.renderer as unknown as WebGLRenderer, 1280, 760,
      f.initial, f.resize, vi.fn(), () => f.canvas)).toThrow('WebGL context is unavailable')
    expect(f.resize).not.toHaveBeenCalled()
  })

  it('fails cleanly when PNG encoding returns no image', async () => {
    const canvas = { toBlob: (callback: BlobCallback) => callback(null) } as HTMLCanvasElement
    await expect(pngBlob(canvas)).rejects.toThrow('PNG encoding failed')
  })
})

describe('presentation pause ownership', () => {
  it('does not tick camera, tour or trace during presentation and resumes on exit', () => {
    const state = { camera: 0, tour: 0, trace: 0 }
    const live = () => { state.camera++; state.tour++; state.trace++ }
    const frozen = vi.fn()
    dispatchPresentationFrame(false, live, frozen)
    for (let i = 0; i < 30; i++) dispatchPresentationFrame(true, live, frozen)
    expect(state).toEqual({ camera: 1, tour: 1, trace: 1 })
    expect(frozen).toHaveBeenCalledTimes(30)
    dispatchPresentationFrame(false, live, frozen)
    expect(state).toEqual({ camera: 2, tour: 2, trace: 2 })
  })
  it.each([true, false])('restores original pause %s on failure', async (initial) => {
    let paused = initial
    await expect(withPresentationPause(() => paused, (v) => { paused = v }, async () => {
      expect(paused).toBe(true)
      throw new Error('PNG encoding failed')
    })).rejects.toThrow('PNG encoding failed')
    expect(paused).toBe(initial)
  })
  it('returns the export after restoring playback', async () => {
    const set = vi.fn()
    expect(await withPresentationPause(() => false, set, async () => 'image')).toBe('image')
    expect(set.mock.calls).toEqual([[true], [false]])
  })
})
