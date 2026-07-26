/* Plot the Slonik outline as ASCII, straight from slonik.ts — no browser, no
 * GPU, ~2 seconds. Five attempts at this shape were judged through a 70-second
 * software render with the side panels covering two thirds of the frame, which
 * is why nobody could iterate. Run this instead:
 *
 *     node tools/plot-plate.mjs [path/to/slonik.ts]
 *
 * It prints the segment count, the bounding box, the trunk fraction and the
 * silhouette. Targets, measured from the official PostgreSQL mark:
 *   trunk    >= 35% of total height, tapering, with a curl at the tip
 *   bbox     taller than wide (Slonik is not square)
 *   face     curved, not a straight vertical wall
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'src/world/slonik.ts'
const src = readFileSync(file, 'utf8')

const start = src.match(/LOGO_START[^=]*=\s*\[([-\d.,\s]+)\]/)
if (!start) throw new Error(`no LOGO_START in ${file}`)
const st = start[1].split(',').map(Number)

const body = src.slice(src.indexOf('LOGO_PATH'))
const arr = body.slice(body.indexOf('['), body.indexOf('\n]'))
const segs = [...arr.matchAll(/\[([-\d.,\s]+)\]/g)]
  .map((m) => m[1].split(',').map(Number))
  .filter((a) => a.length === 6)

/* Flatten the cubics. 20 samples a segment is far finer than the 76-column
 * grid below, so the drawing is limited by the terminal, not the sampling. */
const pts = [[...st]]
let p = st
for (const [c1x, c1y, c2x, c2y, x, y] of segs) {
  for (let i = 1; i <= 20; i++) {
    const t = i / 20
    const u = 1 - t
    pts.push([
      u * u * u * p[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
      u * u * u * p[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
    ])
  }
  p = [x, y]
}

const xs = pts.map((q) => q[0])
const ys = pts.map((q) => q[1])
const x0 = Math.min(...xs), x1 = Math.max(...xs)
const y0 = Math.min(...ys), y1 = Math.max(...ys)
const w = x1 - x0, h = y1 - y0

/* The trunk is whatever hangs below the main mass. Find the widest row, call
 * that the body, and measure how much height sits under the point where the
 * outline narrows past a third of it. */
const ROWS = 40
const widthAt = new Array(ROWS).fill(0).map((_, r) => {
  const lo = y0 + (r / ROWS) * h
  const hi = y0 + ((r + 1) / ROWS) * h
  const band = pts.filter((q) => q[1] >= lo && q[1] < hi).map((q) => q[0])
  return band.length ? Math.max(...band) - Math.min(...band) : 0
})
const widest = Math.max(...widthAt)
let trunkRows = 0
for (let r = 0; r < ROWS && widthAt[r] < widest / 3; r++) trunkRows++
const trunkPct = (trunkRows / ROWS) * 100

const W = 76, H = 34
const g = Array.from({ length: H }, () => Array(W).fill(' '))
for (const [x, y] of pts) {
  const cx = Math.round(((x - x0) / w) * (W - 1))
  const cy = Math.round((1 - (y - y0) / h) * (H - 1))
  if (g[cy]) g[cy][cx] = '#'
}

console.log(`file      ${file}`)
console.log(`segments  ${segs.length}`)
console.log(`bbox      ${w.toFixed(1)} x ${h.toFixed(1)}  (${w > h ? 'WIDER than tall — Slonik is not square' : 'taller than wide, good'})`)
console.log(`trunk     ${trunkPct.toFixed(0)}% of height  (target >= 35%)`)
console.log()
console.log(g.map((r) => r.join('')).join('\n'))
