import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'

/* Runs only through shoot.mjs, retaining its shared two-browser semaphore. */
export async function runSequence({ send, output, logs }) {
  const reports = []
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description)
    return response.result.value
  }
  const snapshot = async (name) => {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const report = await evaluate(`(() => {
      const boundary = document.querySelector('[data-disclosure="postgresql-19-boundary"]')
      const rect = boundary?.getBoundingClientRect()
      const style = boundary && getComputedStyle(boundary)
      return {
        heading: document.querySelector('h1')?.textContent,
        selected: document.querySelector('.vchip[aria-pressed="true"]')?.textContent,
        columns: [...document.querySelectorAll('.cols .col')].map(e => e.textContent),
        sql: document.querySelector('.sqlblock__code')?.textContent ?? '',
        boundary: boundary?.textContent ?? '',
        boundaryRight: rect?.right ?? 0,
        viewportWidth: window.innerWidth,
        visibleBoundary: !!rect && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        page: document.body.innerText,
      }
    })()`)
    reports.push({ name, ...report })
    writeFileSync(output.replace('.png', `-${name}.png`), Buffer.from(
      (await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    return report
  }
  const chooseVersion = major => evaluate(`(() => {
    const button = [...document.querySelectorAll('.vchip')].find(b => b.textContent === '${major}')
    if (!button) throw new Error('Version button missing')
    button.click()
  })()`)
  const chooseInstrument = id => evaluate(`(() => {
    const button = [...document.querySelectorAll('.instrument')].find(b => b.querySelector('code')?.textContent === '${id}')
    if (!button) throw new Error('Instrument button missing')
    button.click()
  })()`)

  await chooseInstrument('pg_stat_wal')
  const baseline = await snapshot('wal18')
  assert.equal(baseline.selected, '18')
  assert.ok(!baseline.columns.includes('wal_fpi_bytes'))

  await chooseVersion(19)
  const wal = await snapshot('wal19')
  assert.equal(wal.heading, 'pg_stat_wal')
  assert.ok(wal.columns.includes('wal_fpi_bytes'))
  assert.match(wal.sql, /wal_fpi_bytes/)
  assert.ok(wal.visibleBoundary)
  assert.ok(wal.boundaryRight <= wal.viewportWidth, 'PG19 qualification is clipped horizontally')
  assert.match(wal.boundary, /PostgreSQL 18\.6 teaching model/)
  assert.match(wal.boundary, /PGlite runs PostgreSQL 18\.3/)

  await chooseInstrument('pg_stat_progress_vacuum')
  const vacuum = await snapshot('vacuum19')
  assert.deepEqual(vacuum.columns.slice(-2), ['mode', 'started_by'])

  for (const id of ['pg_stat_lock', 'pg_stat_recovery', 'pg_stat_autovacuum_scores']) {
    await chooseInstrument(id)
    const report = await snapshot(id)
    assert.equal(report.heading, id)
    assert.ok(report.visibleBoundary)
    assert.match(report.page, /THIS MODEL CANNOT SHOW YOU THIS/)
    assert.ok(report.sql.includes(`FROM pg_catalog.${id};`))
  }

  await chooseVersion(18)
  const absent = await snapshot('scores18-absent')
  assert.match(absent.page, /BLIND SPOT ON PG 18/)
  assert.equal(absent.sql, '')
  await chooseInstrument('pg_stat_wal')
  const restored = await snapshot('wal18-restored')
  assert.deepEqual(restored.columns, baseline.columns)
  assert.equal(restored.boundary, '')
  assert.equal(restored.sql, '')
  assert.ok(!logs.some(line => line.includes('[EXCEPTION]')), logs.join('\n'))
  writeFileSync(output.replace('.png', '.json'), JSON.stringify(reports, null, 2))
  console.log(`PG19 reference browser: ${reports.length} states verified`)
}
