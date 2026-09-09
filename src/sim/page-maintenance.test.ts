import { expect, it } from 'vitest'
import { createSamplePage, insertSampleTuple, vacuumSamplePage } from './page-maintenance'

it('retains a deleted version at the horizon and reuses its bytes only after release', () => {
  const page = createSamplePage()
  const old = insertSampleTuple(page, 10, 200)!
  old.xmax = 20
  const initialFree = page.freeBytes
  expect(vacuumSamplePage(page, 20, 15).removed).toBe(0)
  expect(page.freeBytes).toBe(initialFree)
  expect(page.allVisible).toBe(false)
  expect(vacuumSamplePage(page, 21, 15).removed).toBe(1)
  expect(page.freeBytes).toBe(initialFree + 200)
  const replacement = insertSampleTuple(page, 22, 200)!
  expect(replacement.offset).toBe(old.offset)
  expect(page.freeBytes).toBe(initialFree)
  expect(page.allVisible).toBe(false)
  expect(page.allFrozen).toBe(false)
})

it('freezes only old globally visible committed creators and preserves original xmin', () => {
  const page = createSamplePage()
  const old = insertSampleTuple(page, 10, 100)!
  const young = insertSampleTuple(page, 30, 100)!
  vacuumSamplePage(page, 25, 40)
  expect(old.frozen).toBe(true)
  expect(old.xmin).toBe(10)
  expect(young.frozen).toBe(false)
  expect(page.allVisible).toBe(false)
  expect(page.allFrozen).toBe(false)
  vacuumSamplePage(page, 40, 30)
  expect(page.allVisible).toBe(true)
  expect(young.frozen).toBe(false)
  vacuumSamplePage(page, 40, 31)
  expect(page.allFrozen).toBe(true)
  expect(young.xmin).toBe(30)
})

it('does not mark a page with a retained deleted version all-visible or all-frozen', () => {
  const page = createSamplePage()
  insertSampleTuple(page, 10, 100)!.xmax = 40
  vacuumSamplePage(page, 30, 30)
  expect(page.allVisible).toBe(false)
  expect(page.allFrozen).toBe(false)
})

it('refuses an oversized tuple without changing the page', () => {
  const page = createSamplePage()
  const before = structuredClone(page)
  expect(insertSampleTuple(page, 10, 8192)).toBeNull()
  expect(page).toEqual(before)
})
