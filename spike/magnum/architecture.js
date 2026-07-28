export const ARCHITECTURE_LAYOUT = Object.freeze({
  client: Object.freeze({ x: 48, y: 92, width: 152, height: 72 }),
  postmaster: Object.freeze({ x: 230, y: 92, width: 152, height: 72 }),
  privateMemory: Object.freeze({ x: 408, y: 170, width: 250, height: 96 }),
  sharedMemory: Object.freeze({ x: 48, y: 296, width: 624, height: 276 }),
  bufferPool: Object.freeze({ x: 72, y: 338, width: 330, height: 198 }),
  walBuffers: Object.freeze({ x: 424, y: 334, width: 224, height: 72 }),
  procArray: Object.freeze({ x: 424, y: 418, width: 106, height: 50 }),
  lockTable: Object.freeze({ x: 542, y: 418, width: 106, height: 50 }),
  pgXact: Object.freeze({ x: 424, y: 480, width: 224, height: 62 }),
  kernelCache: Object.freeze({ x: 48, y: 596, width: 624, height: 58 }),
  disk: Object.freeze({ x: 48, y: 674, width: 624, height: 62 }),
  rhythm: Object.freeze({ x: 24, y: 760, width: 672, height: 126 }),
})

export function contains(container, child) {
  return (
    child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height
  )
}
