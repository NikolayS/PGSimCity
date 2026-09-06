import * as THREE from 'three/webgpu'
import { createBus } from '../../core/bus'
import { frameAppearance } from './sample'
import { createSim } from '../../sim/model'
import { CITY, bufferTilePos } from '../../world/layout'
import type { Backend } from './session'

export async function startPrototype(host: HTMLElement, report: HTMLElement, forceWebGL: boolean): Promise<Backend> {
  const started = performance.now()
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL })
  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  let observer: ResizeObserver | undefined
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    renderer.setAnimationLoop(null)
    observer?.disconnect()
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
    renderer.dispose()
    renderer.domElement.remove()
  }
  try {
    await renderer.init()
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.info.autoReset = false
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    const backend: Backend = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xc2d7e5)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 500)
    camera.position.set(-80, 85, 105)
    camera.lookAt(0, 0, 0)
    const daylight = new THREE.HemisphereLight(0xe8f4ff, 0x6e675a, 2)
    scene.add(daylight)
    const sun = new THREE.DirectionalLight(0xfff0d4, 3)
    sun.position.set(-45, 75, 30)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    sun.shadow.camera.left = sun.shadow.camera.bottom = -65
    sun.shadow.camera.right = sun.shadow.camera.top = 65
    sun.shadow.camera.far = 200
    sun.shadow.bias = -0.0002
    scene.add(sun)
    const box = new THREE.BoxGeometry(1, 1, 1)
    geometries.push(box)
    const stone = new THREE.MeshStandardNodeMaterial({ color: 0xc9c3af, roughness: 0.85 })
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.15 })
    materials.push(stone, material)
    const plinth = new THREE.Mesh(box, stone)
    plinth.scale.set(CITY.buf.span + 8, 2, CITY.buf.span + 8)
    plinth.position.y = CITY.buf.baseY - 1
    plinth.receiveShadow = true
    scene.add(plinth)
    /* A fresh model's warm state is frozen so backend comparisons cannot drift
     * with rendering speed. No alternate simulation or live performance claim. */
    const buffers = createSim(createBus()).state.buffers
    const columns = new THREE.InstancedMesh(box, material, buffers.sampleFrames)
    const transform = new THREE.Object3D()
    const color = new THREE.Color()
    for (let i = 0; i < buffers.sampleFrames; i++) {
      const [x, y, z] = bufferTilePos(i)
      const { height, color: tint } = frameAppearance(!!buffers.valid[i], !!buffers.pinned[i], !!buffers.dirty[i], buffers.usage[i], CITY.buf.maxRise)
      transform.position.set(x, y + height / 2, z)
      transform.scale.set(CITY.buf.tile, height, CITY.buf.tile)
      transform.updateMatrix()
      columns.setMatrixAt(i, transform.matrix)
      color.setHex(tint)
      columns.setColorAt(i, color)
    }
    columns.castShadow = columns.receiveShadow = true
    scene.add(columns)
    host.append(renderer.domElement)
    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    resize()
    observer = new ResizeObserver(resize)
    observer.observe(host)
    renderer.info.reset()
    await renderer.renderAsync(scene, camera)
    const firstFrameMs = performance.now() - started
    let previous = performance.now()
    let elapsed = 0
    let frames = 0
    let maximum = 0
    let reports = 0
    renderer.setAnimationLoop(() => {
      if (disposed || document.hidden) { previous = performance.now(); return }
      const now = performance.now()
      const interval = now - previous
      previous = now
      elapsed += interval
      frames++
      maximum = Math.max(maximum, interval)
      renderer.info.reset()
      try { renderer.render(scene, camera) } catch {
        report.textContent = 'Rendering stopped after a device or context failure. Return to the complete city or reload to retry.'
        dispose()
        return
      }
      if (elapsed >= 1000) {
        reports++
        report.textContent = `Backend: ${backend}\nWebGPU API exposed: ${'gpu' in navigator}\nFirst frame including model initialization: ${firstFrameMs.toFixed(1)} ms\nPresentation interval mean / maximum: ${(elapsed / frames).toFixed(1)} / ${maximum.toFixed(1)} ms (${frames} frames; window ${reports})\nWhole-frame draw calls / triangles: ${renderer.info.render.drawCalls} / ${renderer.info.render.triangles}\nRenderer-estimated memory: ${(renderer.info.memory.total / 1048576).toFixed(2)} MiB\nCanvas: ${renderer.domElement.width} × ${renderer.domElement.height}\nFrozen representative frames: ${buffers.sampleFrames}; model seed: 0xc0ffee\nHardware: not identified. Do not compare software rendering with a named hardware target.`
        elapsed = frames = maximum = 0
      }
    })
    window.addEventListener('pagehide', dispose, { once: true })
    return backend
  } catch (error) {
    dispose()
    throw error
  }
}
