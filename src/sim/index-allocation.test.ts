import { expect, it } from 'vitest'
import { createAggregateSim } from './test-support'

it('reuses vacuumed index capacity without shrinking index files', { timeout: 30_000 }, () => {
  const sim = createAggregateSim(1 / 3)
  sim.runScenario('bloat-and-vacuum')
  const dead = (i: number) => (sim.state.tables[i] as typeof sim.state.tables[number] & { deadIndexTuples: number }).deadIndexTuples
  const cleaned = new Set<number>()
  const initialPages = sim.state.tables.map(t => t.indexPages)
  let reusedTable = -1
  let reclaimed = false
  let reused = false
  for (let step = 0; step < 5400 && !reused; step++) {
    const before = sim.state.tables.map((t, i) => ({ pages: t.indexPages, dead: dead(i) }))
    sim.update(1 / 3)
    sim.state.tables.forEach((table, i) => {
      if (dead(i) < before[i].dead) {
        reclaimed = true
        cleaned.add(i)
        expect(table.indexPages, 'VACUUM must retain allocated index pages').toBe(before[i].pages)
      }
      if (cleaned.has(i) && dead(i) > before[i].dead && table.indexPages === before[i].pages) { reused = true; reusedTable = i }
    })
  }
  expect(sim.state.tables.some((t, i) => t.indexPages > initialPages[i]), 'churn must first allocate additional pages').toBe(true)
  expect(reclaimed, 'the workload must actually clean dead index entries').toBe(true)
  expect(reused, 'later churn must use retained capacity').toBe(true)
  const capacity = sim.state.tables[reusedTable].indexPages
  sim.setKnob('autovacuum', false)
  sim.setKnob('paused', false)
  sim.setKnob('tps', 5000)
  sim.setKnob('writeRatio', 1)
  for (let step = 0; step < 6000 && sim.state.tables[reusedTable].indexPages <= capacity; step++) sim.update(1 / 3)
  expect(sim.state.tables[reusedTable].indexPages, 'exhausting reusable capacity extends the index').toBeGreaterThan(capacity)
})
