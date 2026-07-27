import { describe, expect, it } from 'vitest'

import { CKPT_MASS } from './maintenance'

type Box = readonly [number, number, number, number, number, number]

const x0 = (b: Box) => b[0] - b[3] / 2
const x1 = (b: Box) => b[0] + b[3] / 2
const y0 = (b: Box) => b[1] - b[4] / 2
const y1 = (b: Box) => b[1] + b[4] / 2
const z0 = (b: Box) => b[2] - b[5] / 2
const z1 = (b: Box) => b[2] + b[5] / 2

/** The engine hall itself: the largest single volume in the table. */
const hall = [...CKPT_MASS].sort((a, b) => b[3] * b[4] * b[5] - a[3] * a[4] * a[5])[0] as Box

describe('the checkpointer hall silhouette', () => {
  it('is not a crate: something breaks the plan at every height', () => {
    /* The complaint this answers is that a building reads as one box. Slice
     * the massing every four metres from grade to the roof and require the
     * plan outline to change between slices — a silhouette that is constant
     * over 25 m is a crate however it is shaded. */
    const widths: number[] = []
    for (let y = 2; y < y1(hall) + 8; y += 4) {
      let w = 0
      for (const b of CKPT_MASS) {
        if (b === hall) continue
        if (y < y0(b) || y > y1(b)) continue
        w = Math.max(w, x1(b) - x0(b))
      }
      widths.push(Math.round(w * 10) / 10)
    }
    expect(new Set(widths).size).toBeGreaterThanOrEqual(4)
  })

  it('crowns the wall with a cornice that actually projects', () => {
    // Concentric with the hall and sitting on top of it: the crown, and not
    // the sync stack that happens to reach the same height off to the west.
    const crown = CKPT_MASS.filter(
      (b) =>
        y0(b) >= y1(hall) - 0.6 &&
        y0(b) < y1(hall) + 1.2 &&
        Math.abs(b[0] - hall[0]) < 1 &&
        Math.abs(b[2] - hall[2]) < 1,
    )
    expect(crown.length).toBeGreaterThanOrEqual(2)
    // A 0.8 m projection on a 26 m hall is invisible at any distance a viewer
    // meets it from; the crown has to reach further than that, in two stages.
    const reach = crown.map((b) => x1(b as Box) - x1(hall)).sort((a, b) => a - b)
    expect(reach[0]).toBeGreaterThan(0.9)
    expect(reach[reach.length - 1]).toBeGreaterThan(reach[0])
  })

  it('stands the roofline behind a parapet on all four sides', () => {
    const top = Math.max(...CKPT_MASS.map((b) => y1(b as Box)))
    const parapet = CKPT_MASS.filter((b) => {
      const box = b as Box
      return y0(box) > y1(hall) + 0.8 && y1(box) < top && Math.min(box[3], box[5]) < 1
    })
    expect(parapet.length).toBe(4)
    // Two run in X and two in Z, or the roof is fenced on two sides only.
    expect(parapet.filter((b) => (b as Box)[3] > (b as Box)[5]).length).toBe(2)
    expect(parapet.filter((b) => (b as Box)[5] > (b as Box)[3]).length).toBe(2)
  })

  it('sits the hall on a plinth rather than on the pavement', () => {
    const base = CKPT_MASS.filter((b) => {
      const box = b as Box
      return box !== hall && y0(box) <= y0(hall) + 0.1 && y1(box) > y0(hall) + 0.3
    })
    expect(base.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...base.map((b) => x1(b as Box)))).toBeGreaterThan(x1(hall))
  })

  it('puts plant on the roof so the top is not a clean rectangle', () => {
    const roofTop = Math.max(...CKPT_MASS.filter((b) => (b as Box)[4] < 1).map((b) => y1(b as Box)))
    const plant = CKPT_MASS.filter((b) => y0(b as Box) >= roofTop - 0.2 && (b as Box)[4] > 1)
    expect(plant.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps every added volume inside the district apron', () => {
    // The apron is the widest, thinnest slab in the table; nothing the hall
    // grows may overhang it, or the building floats off its own plot.
    const apron = [...CKPT_MASS].sort((a, b) => a[4] - b[4])[0] as Box
    for (const b of CKPT_MASS) {
      const box = b as Box
      if (box === apron) continue
      expect(x0(box), `${box}`).toBeGreaterThanOrEqual(x0(apron) - 12)
      expect(x1(box), `${box}`).toBeLessThanOrEqual(x1(apron) + 6)
      expect(z0(box), `${box}`).toBeGreaterThanOrEqual(z0(apron) - 4)
      expect(z1(box), `${box}`).toBeLessThanOrEqual(z1(apron) + 4)
    }
  })

  it('articulates the long faces without overhanging the cornice', () => {
    const pilasters = CKPT_MASS.filter((b) => {
      const box = b as Box
      return box[5] < 1 && box[4] > 10 && box[3] > 1
    })
    expect(pilasters.length).toBe(10)
    const cornice = [...CKPT_MASS].sort((a, b) => b[5] - a[5])[0] as Box
    for (const p of pilasters) {
      expect(z1(p as Box)).toBeLessThanOrEqual(z1(cornice))
      expect(z0(p as Box)).toBeGreaterThanOrEqual(z0(cornice))
      // A pilaster has to stand PROUD of the wall or it is not there at all.
      const proud = Math.max(z1(p as Box) - z1(hall), z0(hall) - z0(p as Box))
      expect(proud).toBeGreaterThan(0.2)
    }
  })
})
