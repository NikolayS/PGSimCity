/* ============================================================================
 * UI PARTS
 *
 * Small, dumb builders. Everything that touches the DOM more than once a second
 * updates in place rather than re-rendering, because these panes sit next to a
 * 60 fps simulation and a layout thrash is visible.
 * ==========================================================================*/

import type { Knobs, SimApi } from '../core/types'
import { el, setText, sparkline } from '../ui/uikit'
import { fmtBytes, fmtNum } from '../core/util'
import type { Collector } from './collector'
import type { Cell, Projection } from './views'
import type { KnobSpec } from './paths'

/* ------------------------------ SQL block -------------------------------- */

export function sqlBlock(sql: string): HTMLElement {
  const code = el('pre', { class: 'sqlblock__code', text: sql })
  const btn = el('button', {
    class: 'sqlblock__copy',
    type: 'button',
    text: 'copy',
    title: 'Copy this statement',
    on: {
      click: () => {
        void navigator.clipboard?.writeText(sql).then(
          () => {
            btn.textContent = 'copied'
            window.setTimeout(() => (btn.textContent = 'copy'), 1400)
          },
          () => {
            btn.textContent = 'select it'
            window.setTimeout(() => (btn.textContent = 'copy'), 1400)
          },
        )
      },
    },
  })
  return el('div', { class: 'sqlblock' }, code, btn)
}

/* ------------------------------ data table ------------------------------- */

const cellOf = (c: Cell | string): Cell => (typeof c === 'string' ? { v: c } : c)

export interface LiveTable {
  root: HTMLElement
  update(p: Projection): void
}

/**
 * A result set. The header is rebuilt only when the column set changes; rows
 * are rebuilt every refresh, which for the twenty-odd rows these views produce
 * is cheaper than diffing and never goes stale.
 */
export function dataTable(): LiveTable {
  const thead = el('thead')
  const tbody = el('tbody')
  const table = el('table', { class: 'grid' }, thead, tbody)
  const scroll = el('div', { class: 'grid-scroll' }, table)
  const empty = el('p', { class: 'grid-empty' })
  const caption = el('p', { class: 'grid-caption' })
  const root = el('div', { class: 'grid-wrap' }, scroll, empty, caption)
  let sig = ''

  return {
    root,
    update(p: Projection) {
      const nextSig = p.cols.map((c) => c.key).join('|')
      if (nextSig !== sig) {
        sig = nextSig
        thead.replaceChildren(
          el(
            'tr',
            {},
            ...p.cols.map((c) => el('th', { class: c.num ? 'num' : '', text: c.label })),
          ),
        )
      }

      const rows = p.rows.map((r) =>
        el(
          'tr',
          { class: `t-${r.tone || 'none'}${r.mark ? ' marked' : ''}` },
          ...p.cols.map((c) => {
            const cell = cellOf(r.cells[c.key] ?? '')
            return el('td', {
              class: `${c.num ? 'num ' : ''}c-${cell.tone || 'none'}`,
              text: cell.v,
            })
          }),
        ),
      )
      tbody.replaceChildren(...rows)

      const isEmpty = p.rows.length === 0
      scroll.hidden = isEmpty
      empty.hidden = !isEmpty
      if (isEmpty) setText(empty, p.empty ?? 'No rows.')
      caption.hidden = !p.caption
      if (p.caption) setText(caption, p.caption)
    },
  }
}

/* ------------------------------ knob control ----------------------------- */

/** A GUC the reader can turn, labelled with its real name. */
export function knobRow(sim: SimApi, spec: KnobSpec): { root: HTMLElement; sync(): void } {
  const value = el('span', { class: 'knob__v' })
  const head = el('div', { class: 'knob__head' }, el('code', { class: 'knob__k', text: spec.guc }), value)
  const help = el('p', { class: 'knob__help', text: spec.help })
  let sync = () => {}
  let control: HTMLElement

  if (spec.kind === 'toggle') {
    const btn = el('button', { class: 'knob__toggle', type: 'button' })
    btn.addEventListener('click', () => {
      const cur = sim.state.knobs[spec.key] as unknown as boolean
      sim.setKnob(spec.key as 'bgwriterEnabled', !cur)
      sync()
    })
    control = btn
    sync = () => {
      const on = sim.state.knobs[spec.key] as unknown as boolean
      btn.classList.toggle('on', on)
      btn.textContent = on ? 'on' : 'off'
      setText(value, on ? 'on' : 'off')
    }
  } else if (spec.kind === 'choice') {
    const wrap = el('div', { class: 'knob__choices' })
    const buttons = (spec.choices ?? []).map((choice) => {
      const b = el('button', { class: 'knob__choice', type: 'button', text: choice })
      b.addEventListener('click', () => {
        sim.setKnob(spec.key as 'synchronousCommit', choice as Knobs['synchronousCommit'])
        sync()
      })
      return b
    })
    wrap.append(...buttons)
    control = wrap
    sync = () => {
      const cur = String(sim.state.knobs[spec.key])
      buttons.forEach((b) => b.classList.toggle('on', b.textContent === cur))
      setText(value, cur)
    }
  } else {
    const input = el('input', {
      class: 'knob__range',
      type: 'range',
      min: String(spec.min ?? 0),
      max: String(spec.max ?? 100),
      step: String(spec.step ?? 1),
    })
    input.addEventListener('input', () => {
      sim.setKnob(spec.key as 'tps', Number(input.value))
      sync()
    })
    control = input
    sync = () => {
      const v = Number(sim.state.knobs[spec.key])
      if (document.activeElement !== input) input.value = String(v)
      input.style.setProperty('--fill', `${((v - (spec.min ?? 0)) / ((spec.max ?? 100) - (spec.min ?? 0))) * 100}%`)
      setText(value, spec.fmt ? spec.fmt(v) : `${fmtNum(v, 2)}${spec.unit ? ` ${spec.unit}` : ''}`)
    }
  }

  sync()
  return { root: el('div', { class: 'knob' }, head, control, help), sync }
}

/* ------------------------------ vitals strip ----------------------------- */

interface Vital {
  key: string
  label: string
  color: string
  read(sim: SimApi, c: Collector): { v: string; tone: '' | 'ok' | 'warn' | 'crit' }
  history(sim: SimApi): readonly number[]
  min?: number
  max?: number
}

const VITALS: Vital[] = [
  {
    key: 'tps',
    label: 'tps',
    color: 'var(--c-backend)',
    read: (sim) => ({ v: fmtNum(sim.state.stats.tps), tone: '' }),
    history: (sim) => sim.state.stats.history.tps,
    min: 0,
  },
  {
    key: 'hit',
    label: 'cache hit',
    color: 'var(--c-buffer-clean)',
    read: (sim) => {
      const v = sim.state.stats.cacheHitPct
      return { v: `${v.toFixed(1)}%`, tone: v < 85 ? 'crit' : v < 95 ? 'warn' : 'ok' }
    },
    history: (sim) => sim.state.stats.history.hit,
    min: 0,
    max: 100,
  },
  {
    key: 'wal',
    label: 'wal',
    color: 'var(--c-wal)',
    read: (sim) => ({ v: `${fmtBytes(sim.state.wal.bytesPerSec)}/s`, tone: '' }),
    history: (sim) => sim.state.stats.history.wal,
    min: 0,
  },
  {
    key: 'dirty',
    label: 'dirty buffers',
    color: 'var(--c-buffer-dirty)',
    read: (sim) => ({ v: String(sim.state.buffers.dirtyCount), tone: '' }),
    history: (sim) => sim.state.stats.history.dirty,
    min: 0,
  },
  {
    key: 'lag',
    label: 'replay lag',
    color: 'var(--c-replication)',
    read: (sim) => {
      const v = sim.state.replication.lagSec
      return { v: `${v.toFixed(2)} s`, tone: v > 8 ? 'crit' : v > 2 ? 'warn' : 'ok' }
    },
    history: (sim) => sim.state.stats.history.lag,
    min: 0,
  },
  {
    key: 'dead',
    label: 'dead tuples',
    color: 'var(--c-vacuum)',
    read: (sim) => {
      const dead = sim.state.tables.reduce((a, t) => a + t.deadTuples, 0)
      const live = sim.state.tables.reduce((a, t) => a + t.liveTuples, 0)
      const r = live + dead > 0 ? dead / (live + dead) : 0
      return { v: fmtNum(dead), tone: r > 0.25 ? 'crit' : r > 0.12 ? 'warn' : 'ok' }
    },
    history: () => [],
    min: 0,
  },
]

/**
 * Resolve a `var(--token)` reference to its literal value once.
 *
 * tokens.css is the single source of truth for colour and the canvas API cannot
 * read a custom property, so the palette is read out of the cascade at build
 * time rather than duplicated here. Duplicating it is how the old page ended up
 * painting the WAL teal.
 */
function resolveVar(expr: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(expr.trim())
  if (!m) return expr
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim()
  return v || '#5ad1ff'
}

export function vitalsStrip(sim: SimApi, coll: Collector): { root: HTMLElement; update(): void } {
  const cells = VITALS.map((v) => {
    const val = el('div', { class: 'vital__v' })
    const canvas = el('canvas', { class: 'vital__spark' })
    const root = el(
      'div',
      { class: 'vital' },
      el('div', { class: 'vital__k', text: v.label }),
      val,
      canvas,
    )
    return { v, root, val, canvas, ink: resolveVar(v.color), last: '', lastTone: '' }
  })
  const root = el('div', { class: 'vitals' }, ...cells.map((c) => c.root))
  return {
    root,
    update() {
      for (const c of cells) {
        const r = c.v.read(sim, coll)
        if (r.v !== c.last) {
          c.val.textContent = r.v
          c.last = r.v
        }
        if (r.tone !== c.lastTone) {
          c.val.className = `vital__v c-${r.tone || 'none'}`
          c.lastTone = r.tone
        }
        const h = c.v.history(sim)
        if (h.length > 1) sparkline(c.canvas, h, { color: c.ink, fill: true, min: c.v.min, max: c.v.max })
        else c.canvas.hidden = true
      }
    },
  }
}
