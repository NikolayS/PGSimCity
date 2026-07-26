import { describe, it } from 'vitest'
import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { N_TABLES, TABLES } from '../src/world/layout'
import { clamp, clamp01, makeRng } from '../src/core/util'
import { N_VAC_WORKERS } from '../src/core/types'

const PAGES_PER_TILE = 12
const COLS = 12
const ROWS_MIN = 3
const ROWS_MAX = 44

describe('vm probe', () => {
  it('traces vmCover after boot', () => {
    const bus = createBus()
    const sim = createSim(bus)
    const rng = makeRng(0x5107a9e)

    const rowsBase = new Int32Array(N_TABLES)
    const rowCap = new Int32Array(N_TABLES)
    const tileBase = new Int32Array(N_TABLES)
    let tileCap = 0
    for (let i = 0; i < N_TABLES; i++) {
      const base = clamp(Math.ceil(TABLES[i].pages / (COLS * PAGES_PER_TILE)), ROWS_MIN, ROWS_MAX)
      rowsBase[i] = base
      rowCap[i] = Math.min(ROWS_MAX, Math.max(base * 2 + 4, 10))
      tileBase[i] = tileCap
      tileCap += rowCap[i] * COLS
    }
    const tileNoise = new Float32Array(tileCap)
    for (let i = 0; i < tileCap; i++) tileNoise[i] = rng()
    const tileVm = new Float32Array(tileCap)
    const vmCover = new Float32Array(N_TABLES)
    const insVacT = new Float32Array(N_TABLES)
    const insVacFront = new Float32Array(N_TABLES).fill(-1)
    const prevInserts = new Float32Array(N_TABLES)

    const dt = 1 / 60
    const firstCross = new Array(N_TABLES).fill(-1)
    const rows: string[] = []
    for (let step = 0; step < 60 * 300; step++) {
      sim.update(dt)
      const s = sim.state
      for (let ti = 0; ti < N_TABLES; ti++) {
        const tb = s.tables[ti]
        const wantTiles = Math.max(1, Math.ceil(tb.pages / PAGES_PER_TILE))
        const nrows = clamp(Math.ceil(wantTiles / COLS), ROWS_MIN, rowCap[ti])
        const used = Math.min(wantTiles, nrows * COLS)
        const base = tileBase[ti]
        const dIns = Math.max(0, tb.inserts - prevInserts[ti])
        prevInserts[ti] = tb.inserts

        let front = -1
        for (let w = 0; w < N_VAC_WORKERS; w++) {
          const vw = s.autovac.workers[w]
          if (!vw || !vw.active || vw.table !== ti) continue
          if (vw.phase === 'scan_heap' || vw.phase === 'vacuum_heap' || vw.phase === 'truncate') front = vw.progress
        }
        if (front < 0 && s.autovac.enabled && tb.bloat < 0.03) {
          if (insVacFront[ti] >= 0) {
            insVacFront[ti] += dt * 0.42
            if (insVacFront[ti] > 1) insVacFront[ti] = -1
          } else {
            insVacT[ti] += dt * clamp01(dIns * 0.05 + 0.08)
            if (insVacT[ti] > 6) {
              insVacT[ti] = 0
              insVacFront[ti] = 0
            }
          }
          front = insVacFront[ti]
        } else {
          insVacFront[ti] = -1
        }
        const frontTile = front >= 0 ? Math.floor(front * used) : -1
        const bloat = tb.bloat
        let vmSet = 0
        for (let r = 0; r < nrows; r++) {
          for (let c = 0; c < COLS; c++) {
            const k = r * COLS + c
            const gi = base + k
            if (k >= used) continue
            const n = tileNoise[gi]
            let dead = bloat * n * n * 2.85
            const tailFrom = used - Math.max(2, Math.min(COLS * 2, used * 0.18))
            if (k > tailFrom) dead *= 0.22
            if (dead > 1) dead = 1
            let vm = tileVm[gi]
            if (dead > 0.05) vm = 0
            else if (frontTile >= 0 && k <= frontTile) vm = vm + (1 - vm) * Math.min(1, dt * 5)
            else if (vm > 0) vm = Math.min(1, vm + dt * 0.35)
            tileVm[gi] = vm
            if (vm > 0.5) vmSet++
          }
        }
        vmCover[ti] = used ? vmSet / used : 0
        if (firstCross[ti] < 0 && vmCover[ti] > 0.5) firstCross[ti] = step * dt
      }
      if (step % (60 * 10) === 0) {
        rows.push(
          `t=${(step * dt).toFixed(0)}s ` +
            TABLES.map((d, i) => `${d.id}:${(vmCover[i] * 100).toFixed(0)}%/b${(sim.state.tables[i].bloat * 100).toFixed(1)}`).join('  '),
        )
      }
    }
    const out =
      rows.join('\n') +
      '\nfirst >50% cover: ' +
      TABLES.map((d, i) => `${d.id}=${firstCross[i] < 0 ? 'never' : firstCross[i].toFixed(1) + 's'}`).join(' ')
    // eslint-disable-next-line
    require('node:fs').writeFileSync('/tmp/claude-1000/-home-tars/bf57591f-d077-4c2a-80f3-46cf3b053fba/scratchpad/vmprobe.txt', out)
  })
})
