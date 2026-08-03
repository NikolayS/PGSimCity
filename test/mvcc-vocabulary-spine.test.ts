import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CLAIMS, CLAIM_VALUES } from '../src/core/claims'
import { CATALOG } from '../src/observability/catalog'
import { ALL_STEPS } from '../src/observability/paths'
import type { SemanticFacet } from '../src/spine/mvcc-vocabulary'
import type { MvccVocabularyId } from '../src/spine/mvcc-vocabulary'
import { SCENARIOS } from '../src/sim/scenarios'
import { DOCS_MEMORY } from '../src/ui/docs-memory'
import { DOCS_STORAGE } from '../src/ui/docs-storage'
import type { ComponentDoc } from '../src/ui/content'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function sourceBlock(path: string, start: string, end: string): string {
  const source = read(path)
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error(`${path}: cannot resolve semantic surface ${start} … ${end}`)
  return source.slice(from, to)
}

function sourceLines(path: string, needles: readonly string[]): string {
  const lines = read(path).split('\n')
  return needles.map((needle) => {
    const line = lines.find((candidate) => candidate.includes(needle))
    if (!line) throw new Error(`${path}: cannot resolve semantic surface line ${needle}`)
    return line
  }).join('\n')
}

function section(docs: readonly ComponentDoc[], heading: string): string {
  const matches = docs.flatMap((entry) => entry.sections.filter((candidate) => candidate.heading === heading))
  if (matches.length !== 1) throw new Error(`expected one documentation section named ${heading}, found ${matches.length}`)
  return matches[0].body
}

function docCopy(docs: readonly ComponentDoc[], id: string): string {
  const entry = docs.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`missing documentation surface ${id}`)
  return [entry.title, entry.subtitle, entry.tldr, ...entry.sections.flatMap((item) => [item.heading, item.body])].join('\n')
}

function docSection(docs: readonly ComponentDoc[], id: string, heading: string): string {
  const entry = docs.find((candidate) => candidate.id === id)
  if (!entry) throw new Error(`missing documentation surface ${id}`)
  const matches = entry.sections.filter((candidate) => candidate.heading === heading)
  if (matches.length !== 1) throw new Error(`${id}: expected one section named ${heading}, found ${matches.length}`)
  return matches[0].body
}

function scenarioCopy(id: string, beatTitles?: readonly string[]): string {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`missing scenario surface ${id}`)
  const beats = beatTitles
    ? scenario.beats.filter(([, title]) => beatTitles.includes(title))
    : scenario.beats
  return beats.flatMap(([, title, body]) => [title, body]).join('\n')
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim()
}

function facetMatches(text: string, facet: SemanticFacet): boolean {
  const normalized = normalize(text)
  return facet.allOf.every((alternatives) =>
    alternatives.some((alternative) => normalized.includes(normalize(alternative))),
  )
}

function missingFacets(
  text: string,
  facets: Readonly<Record<string, SemanticFacet>>,
  required: readonly string[],
): string[] {
  return required.filter((facetId) => {
    const facet = facets[facetId]
    if (!facet) throw new Error(`surface names unregistered semantic facet ${facetId}`)
    return !facetMatches(text, facet)
  })
}

const anatomyPointers = sourceBlock('src/ui/anatomy.ts', '  pointers: {', '  lp_off: {')
const anatomyXmin = sourceBlock('src/ui/anatomy.ts', '  t_xmin: {', '  t_xmax: {')
const anatomyXmax = sourceBlock('src/ui/anatomy.ts', '  t_xmax: {', '  t_cid: {')
const anatomyCtid = sourceBlock('src/ui/anatomy.ts', '  t_ctid: {', '  t_infomask2: {')
const anatomyTuple = sourceBlock('src/ui/anatomy.ts', '  tuple: {', '  mvcc: {')
const anatomyHotRedirect = sourceBlock('src/ui/anatomy.ts', '  lp_redirect: {', '  lp_dead: {')
const anatomyHorizon = sourceBlock('src/ui/anatomy.ts', '  horizon: {', '  t_xmin: {')
const anatomyToast = sourceBlock('src/ui/anatomy.ts', '  user_data: {', '\n}\n\ninterface DirectoryItem')
const anatomyVisibilityMap = sourceBlock('src/ui/anatomy.ts', '  vm_fork: {', '  global: {')
const anatomyLiveLabels = sourceBlock('src/ui/anatomy.ts', '  const liveStats = {', '  const headerRegion =')
const memoryVisibility = section(DOCS_MEMORY, 'How a row version is judged')
const storageMvcc = section(DOCS_STORAGE, 'MVCC: row versions, not rows')
const storageHot = section(DOCS_STORAGE, 'HOT updates and page pruning')
const storagePage = section(DOCS_STORAGE, 'Inside one 8 KiB page')
const storageIndexLocator = section(DOCS_STORAGE, 'Why the index alone is not enough')
const storageVacuumPhases = section(DOCS_STORAGE, 'The phases, in order')
const storageDeadRemovable = section(DOCS_STORAGE, 'Dead is not the same as removable')
const storageToastTarget = docSection(DOCS_STORAGE, 'storage.toast', 'Why it exists')
const storageToastRead = docSection(DOCS_STORAGE, 'storage.toast', 'What a wide column costs to read')
const diagnoseBloat = ALL_STEPS.find((step) => step.id === 'bloat.1')
const diagnoseHorizon = ALL_STEPS.find((step) => step.id === 'bloat.2')
const catalogTables = CATALOG.find((entry) => entry.id === 'pg_stat_all_tables')

const ACTUAL_SURFACES: Record<MvccVocabularyId, Record<string, string>> = {
  xmin: {
    'anatomy:t_xmin tooltip': anatomyXmin,
    'prose:memory row-version visibility': memoryVisibility,
    'prose:storage MVCC row versions': storageMvcc,
  },
  xmax: {
    'anatomy:t_xmax tooltip': anatomyXmax,
    'prose:memory row-version visibility': memoryVisibility,
    'prose:storage MVCC row versions': storageMvcc,
    'prose:storage dead versus removable': storageDeadRemovable,
  },
  ctid: {
    'anatomy:line-pointer tooltip': anatomyPointers,
    'anatomy:t_ctid tooltip': anatomyCtid,
    'prose:storage page address': storagePage,
    'prose:storage HOT chain': storageHot,
    'prose:storage index heap locator': storageIndexLocator,
  },
  linePointers: {
    'anatomy:line-pointer tooltip': anatomyPointers,
    'prose:storage page layout': storagePage,
    'prose:storage HOT pruning': storageHot,
    'prose:storage VACUUM phases': storageVacuumPhases,
  },
  tupleHeader: {
    'anatomy:tuple-header tooltip': anatomyTuple,
    'prose:storage MVCC tuple header': storageMvcc,
  },
  hotChains: {
    'anatomy:t_ctid HOT link': anatomyCtid,
    'anatomy:HOT redirect': anatomyHotRedirect,
    'prose:storage HOT chain': storageHot,
    'scenario:bloat HOT explanation': scenarioCopy('bloat-and-vacuum', ['HOT is the quiet hero']),
    'scenario:bloat HOT index effect': scenarioCopy('bloat-and-vacuum', ['Bloat is not just size']),
  },
  tupleLiveness: {
    'anatomy:dead and removable explanation': [anatomyLiveLabels, anatomyXmax, anatomyHorizon].join('\n'),
    'prose:memory row-version visibility': memoryVisibility,
    'prose:storage MVCC row versions': storageMvcc,
    'prose:storage dead versus removable': storageDeadRemovable,
    'Diagnose:bloat tuple estimates': [diagnoseBloat?.look ?? '', diagnoseBloat?.why ?? ''].join('\n'),
    'Diagnose:catalog tuple estimates': catalogTables?.coverageNote ?? '',
    'scenario:xmin dead versus removable': scenarioCopy('xmin-horizon'),
  },
  visibilityMap: {
    'anatomy:visibility-map tooltip': anatomyVisibilityMap,
    'prose:storage index-only scan': storageIndexLocator,
    'prose:storage visibility map': docCopy(DOCS_STORAGE, 'storage.vm'),
    'prose:memory EXPLAIN heap fetches': section(DOCS_MEMORY, 'The tells worth knowing'),
  },
  xminHorizon: {
    'world:xmin-horizon label and tooltip': sourceLines('src/world/shmem.ts', [
      "const labels = ['slot / feedback xmin', 'prepared xact xmin']",
      "label('PGPROC[16] · snapshots · xmin'",
      "name: 'xmin horizon'",
      "role: 'snapshot and removal horizon'",
    ]),
    'anatomy:xmin-horizon tooltip': anatomyHorizon,
    'prose:memory xmin horizon': docCopy(DOCS_MEMORY, 'xmin.horizon'),
    'Diagnose:xmin-horizon investigation': [diagnoseHorizon?.why ?? '', diagnoseHorizon?.look ?? '', diagnoseHorizon?.note ?? ''].join('\n'),
    'scenario:xmin-horizon definition': scenarioCopy('xmin-horizon', ['The horizon froze', 'Where to look']),
  },
  toastPointers: {
    'anatomy:TOAST-pointer tooltip': anatomyToast,
    'prose:storage TOAST target': storageToastTarget,
    'prose:storage TOAST read path': storageToastRead,
  },
}

describe('MVCC and page-anatomy vocabulary spine', () => {
  it('registers every cross-surface vocabulary candidate found by the audit', () => {
    expect(Object.keys(CLAIM_VALUES.mvccVocabulary)).toEqual([
      'xmin',
      'xmax',
      'ctid',
      'linePointers',
      'tupleHeader',
      'hotChains',
      'tupleLiveness',
      'visibilityMap',
      'xminHorizon',
      'toastPointers',
    ])
  })

  it('keeps every short label or tooltip semantically compatible with its prose', () => {
    const owner = CLAIMS.mvccVocabulary.owner
    for (const [conceptId, concept] of Object.entries(CLAIM_VALUES.mvccVocabulary)) {
      const actual = ACTUAL_SURFACES[conceptId as MvccVocabularyId]
      expect(
        Object.keys(actual),
        `mvccVocabulary.${conceptId}: checked surfaces disagree with ${owner}`,
      ).toEqual(Object.keys(concept.surfaces))

      const allFacets = Object.keys(concept.facets)
      expect.soft(
        missingFacets(concept.definition, concept.facets, allFacets),
        `mvccVocabulary.${conceptId}: owned definition omits one of its semantic facets`,
      ).toEqual([])

      for (const [surface, required] of Object.entries(concept.surfaces)) {
        const missing = missingFacets(actual[surface], concept.facets, required)
        expect.soft(
          missing,
          `mvccVocabulary.${conceptId}: ${surface} disagrees with ${owner}; missing ${missing.join(', ') || 'no facets'}`,
        ).toEqual([])
      }
    }
  })

  it('rejects the shipped xmax narrowing instead of accepting shared keywords', () => {
    const concept = CLAIM_VALUES.mvccVocabulary.xmax
    const narrowed = 'xmax is the transaction that deleted or superseded the tuple; once it commits the tuple is dead.'
    expect(missingFacets(narrowed, concept.facets, ['deletingOrUpdating', 'locking']))
      .toEqual(['locking'])
  })
})
