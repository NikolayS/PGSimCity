import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { createBus } from '../src/core/bus'
import { createSim } from '../src/sim/model'
import { APP_KEYS } from '../src/ui/help'
import { createHud } from '../src/ui/hud'
import { MOVEMENT_SOUND_MODE } from '../src/ui/sound'
import type { UiContext } from '../src/ui/uikit'
import { installTestDom } from './dom'

const ROOT = resolve(import.meta.dirname, '..')

interface CopySurface {
  file: string
  line: number
  text: string
}

interface SoundControlMarkers {
  actions: ReadonlySet<string>
  keys: readonly string[]
  nouns: ReadonlySet<string>
  scopes: ReadonlySet<string>
}

const SOUND_COPY_MODULE = 'src/ui/sound.ts'

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

function trackedDocumentationFiles(): string[] {
  // Git's index is the source of truth; ignored and untracked developer notes are not repository docs.
  return execFileSync('git', ['ls-files', '--cached', '-z', '--', '*.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean)
}

function words(text: string): string[] {
  return text.match(/[A-Za-z]+/g)?.map((word) => word.toLowerCase()) ?? []
}

function identifierWords(identifier: string): string[] {
  return words(identifier.replace(/([a-z\d])([A-Z])/g, '$1 $2'))
}

let cachedSoundControlMarkers: SoundControlMarkers | undefined

function soundControlMarkers(): SoundControlMarkers {
  if (cachedSoundControlMarkers) return cachedSoundControlMarkers

  const controlId = SOUND_COPY_MODULE.split('/').at(-1)?.replace(/\.ts$/, '')
  const help = APP_KEYS.find((row) => row.id === controlId)
  if (!controlId || !help) throw new Error(`${SOUND_COPY_MODULE} must own a keyboard-help control`)

  const keys = help.keys.flatMap((key) => key.match(/[A-Za-z\d]+/g) ?? [])
  const actions = new Set<string>()
  const nouns = new Set<string>([controlId])
  const scopes = new Set<string>([MOVEMENT_SOUND_MODE.toLowerCase()])

  /* The M switch calls toggleAudio. Splitting the bound production handler
     yields both the action and the audio alias without maintaining synonyms. */
  for (const path of sourceFiles('src')) {
    const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isSwitchStatement(node)) {
        for (const clause of node.caseBlock.clauses) {
          if (
            !ts.isCaseClause(clause)
            || !ts.isStringLiteralLike(clause.expression)
            || !keys.some((key) => key.toLowerCase() === clause.expression.text.toLowerCase())
          ) continue

          for (const statement of clause.statements) {
            if (
              !ts.isExpressionStatement(statement)
              || !ts.isCallExpression(statement.expression)
              || !ts.isIdentifier(statement.expression.expression)
            ) continue
            const tokens = identifierWords(statement.expression.expression.text)
            if (tokens.length < 2) continue
            actions.add(tokens[0])
            nouns.add(tokens.at(-1)!)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  /* Accessible copy contributes verbs such as "turn" only when they directly
     precede this control's derived scope and noun. */
  const copy = ts.createSourceFile(
    SOUND_COPY_MODULE,
    source(SOUND_COPY_MODULE),
    ts.ScriptTarget.Latest,
    true,
  )
  const visitCopy = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const tokens = words(node.text)
      for (const [index, token] of tokens.entries()) {
        if (!nouns.has(token)) continue
        let previous = index - 1
        while (previous >= 0 && scopes.has(tokens[previous])) previous -= 1
        if (previous >= 0) actions.add(tokens[previous])
      }
    }
    ts.forEachChild(node, visitCopy)
  }
  visitCopy(copy)

  if (actions.size === 0 || nouns.size < 2 || keys.length === 0) {
    throw new Error('sound-control markers must remain derivable from production wiring')
  }
  cachedSoundControlMarkers = { actions, keys, nouns, scopes }
  return cachedSoundControlMarkers
}

function hasActionNounPair(text: string, markers: SoundControlMarkers): boolean {
  const tokens = words(text)
  return tokens.some((token, index) => {
    if (!markers.actions.has(token)) return false
    let next = index + 1
    if (tokens[next] === 'the') next += 1
    while (markers.scopes.has(tokens[next])) next += 1
    return markers.nouns.has(tokens[next])
  })
}

function mentionsKey(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^A-Za-z\\d])${escaped}(?:[^A-Za-z\\d]|$)`).test(text)
}

function hasKeyNounAssociation(text: string, markers: SoundControlMarkers): boolean {
  const cells = text.split('|').map((cell) => cell.replace(/[`*_]/g, '').trim())
  const keyCell = cells.some((cell) => markers.keys.includes(cell))
  if (keyCell && cells.some((cell) => words(cell).some((word) => markers.nouns.has(word)))) {
    return true
  }

  const clauses = text.split(/[.;!?]|\b(?:while|whereas)\b|,\s*(?:and|but)\b/i)
  return clauses.some((clause) => (
    markers.keys.some((key) => mentionsKey(clause, key))
    && words(clause).some((word) => word !== 'sound' && markers.nouns.has(word))
  ))
}

function describesSoundControl(text: string, path?: string): boolean {
  const markers = soundControlMarkers()
  if (
    path === SOUND_COPY_MODULE
    && words(text).some((word) => markers.nouns.has(word))
  ) return true
  return hasActionNounPair(text, markers) || hasKeyNounAssociation(text, markers)
}

function productionCopySurfaces(): CopySurface[] {
  const surfaces: CopySurface[] = []
  for (const path of sourceFiles('src')) {
    const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && describesSoundControl(node.text, path)) {
        surfaces.push({
          file: path,
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: node.text,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return surfaces
}

function documentationCopySurfaces(): CopySurface[] {
  const surfaces: CopySurface[] = []
  for (const path of trackedDocumentationFiles()) {
    const lines = source(path).split('\n')
    let paragraph: string[] = []
    let paragraphLine = 1
    const inspect = (text: string, line: number): void => {
      if (describesSoundControl(text)) surfaces.push({ file: path, line, text })
    }
    const flush = (): void => {
      if (paragraph.length > 0) inspect(paragraph.join(' '), paragraphLine)
      paragraph = []
    }

    for (const [index, line] of lines.entries()) {
      if (/^\s*\|/.test(line)) {
        flush()
        inspect(line, index + 1)
      } else if (line.trim() === '') {
        flush()
      } else {
        if (paragraph.length === 0) paragraphLine = index + 1
        paragraph.push(line.trim())
      }
    }
    flush()
  }
  return surfaces
}

function formatSurfaces(surfaces: readonly CopySurface[]): string {
  return surfaces.map(({ file, line, text }) => `${file}:${line} ${text}`).join('\n')
}

function cameraModes(): string[] {
  const file = ts.createSourceFile(
    'src/core/types.ts',
    source('src/core/types.ts'),
    ts.ScriptTarget.Latest,
    true,
  )
  const alias = file.statements.find((statement): statement is ts.TypeAliasDeclaration => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'CameraMode'
  ))
  expect(alias, 'CameraMode must remain the control-mode source of truth').toBeDefined()
  const members = alias && ts.isUnionTypeNode(alias.type) ? alias.type.types : []
  return members.flatMap((member) => (
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
      ? [member.literal.text]
      : []
  ))
}

function producingAudioMethods(): Set<string> {
  const file = ts.createSourceFile(
    'src/engine/audio.ts',
    source('src/engine/audio.ts'),
    ts.ScriptTarget.Latest,
    true,
  )
  const factory = file.statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'createAudio'
  ))
  expect(factory?.body, 'createAudio must remain inspectable production code').toBeDefined()

  const functions = new Map<string, ts.FunctionDeclaration>()
  for (const statement of factory?.body?.statements ?? []) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement)
    }
  }

  const calls = new Map<string, Set<string>>()
  const signalFunctions = new Set<string>()
  for (const [name, declaration] of functions) {
    const callees = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) callees.add(node.expression.text)
        if (
          ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'start'
        ) {
          signalFunctions.add(name)
        }
      }
      ts.forEachChild(node, visit)
    }
    if (declaration.body) visit(declaration.body)
    calls.set(name, callees)
  }

  let changed = true
  while (changed) {
    changed = false
    for (const [name, callees] of calls) {
      if (signalFunctions.has(name)) continue
      if ([...callees].some((callee) => signalFunctions.has(callee))) {
        signalFunctions.add(name)
        changed = true
      }
    }
  }

  const publicMethods = new Set<string>()
  for (const statement of factory?.body?.statements ?? []) {
    if (!ts.isReturnStatement(statement) || !statement.expression) continue
    if (!ts.isObjectLiteralExpression(statement.expression)) continue
    for (const property of statement.expression.properties) {
      if (ts.isShorthandPropertyAssignment(property) && signalFunctions.has(property.name.text)) {
        publicMethods.add(property.name.text)
      }
    }
  }
  return publicMethods
}

function producingCallSites(methods: ReadonlySet<string>): { file: string; line: number }[] {
  const sites: { file: string; line: number }[] = []
  for (const path of sourceFiles('src')) {
    if (path === 'src/engine/audio.ts') continue
    const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'audio'
        && methods.has(node.expression.name.text)
      ) {
        sites.push({
          file: relative(ROOT, resolve(ROOT, path)),
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return sites
}

function context(audioState: { enabled: boolean; preferred: boolean; volume: number }): UiContext {
  const bus = createBus()
  return {
    bus,
    sim: createSim(bus),
    registry: { all: () => [], get: () => undefined } as unknown as UiContext['registry'],
    getFps: () => 60,
    getQuality: () => ({
      level: 'high',
      pixelRatio: 1,
      bloom: true,
      shadows: true,
      maxParticles: 1,
      maxLabels: 1,
      antialias: true,
    }),
    getFlowStats: () => ({ active: 0, dropped: 0 }),
    getAudioState: () => audioState,
  }
}

describe('honest movement sound controls', () => {
  it.each([
    [
      'PostgreSQL version assessment',
      'Lock-holder advice is sound on PostgreSQL 13, 17, and 18.',
    ],
    [
      'an unrelated M key in the same sentence',
      'Use the M key to mark model evidence; the resulting advice is sound on supported releases.',
    ],
    [
      'an M-key sentence with adjectival sound',
      'The M key is a sound choice for marking modelled evidence.',
    ],
    [
      'separate M-key and audio clauses',
      'The M key marks model evidence while the legal audit inventories audio assets.',
    ],
    [
      'a legal inventory of media',
      'The project contains no SimCity audio or game content.',
    ],
  ])('does not mistake %s for the sound control', (_case, text) => {
    expect(describesSoundControl(text)).toBe(false)
  })

  it.each([
    ['the README key row', '| `M` | Toggle sound |'],
    ['an indirect key description', '`M` changes the audio preference.'],
    ['a non-key action', 'Turn audio off.'],
  ])('recognises %s as the sound control', (_case, text) => {
    expect(describesSoundControl(text)).toBe(true)
  })

  it('ignores untracked Markdown when inventorying documentation surfaces', () => {
    const file = `.sound-honesty-untracked-${process.pid}.md`
    const path = resolve(ROOT, file)
    writeFileSync(path, 'Toggle sound.\n', { encoding: 'utf8', flag: 'wx' })
    try {
      expect(documentationCopySurfaces()).not.toContainEqual(
        expect.objectContaining({ file }),
      )
    } finally {
      unlinkSync(path)
    }
  })

  it('qualifies every production and documentation surface that describes the control', () => {
    const production = productionCopySurfaces()
    const documentation = documentationCopySurfaces()
    expect(production, 'production sources must describe the sound control').not.toHaveLength(0)
    expect(documentation, 'documentation must describe the sound control').not.toHaveLength(0)

    const unqualified = [...production, ...documentation].filter(({ text }) => !/\bwalk\b/i.test(text))
    expect(
      unqualified,
      `sound-control surfaces must disclose their walk-only scope:\n${formatSurfaces(unqualified)}`,
    ).toEqual([])
  })

  it('keeps production sound-control copy in the shared module', () => {
    const scattered = productionCopySurfaces().filter(({ file }) => file !== SOUND_COPY_MODULE)
    expect(
      scattered,
      `route production sound-control copy through src/ui/sound.ts:\n${formatSurfaces(scattered)}`,
    ).toEqual([])
  })

  it('qualifies an enabled control outside its producing mode and stays truthful inside it', () => {
    const dom = installTestDom()
    for (const id of ['hud-top', 'hud-bottom', 'toast-stack', 'compass']) dom.mount(id)
    const ctx = context({ enabled: true, preferred: true, volume: 0.35 })
    const hud = createHud(ctx)

    const control = (): { label: string; title: string; ariaLabel: string; pressed: string | null } => {
      hud.update(0.13, 0.13)
      const button = document.querySelector<HTMLButtonElement>('.hud-audio')!
      return {
        label: button.querySelector<HTMLElement>('.hud-audio__label')!.textContent ?? '',
        title: button.title,
        ariaLabel: button.getAttribute('aria-label') ?? '',
        pressed: button.getAttribute('aria-pressed'),
      }
    }

    const orbit = control()
    for (const copy of [orbit.label, orbit.title, orbit.ariaLabel]) expect(copy).toMatch(/walk/i)
    expect(orbit.pressed).toBe('true')

    ctx.bus.emit('camera:mode', { mode: 'walk' })
    const walk = control()
    expect(walk.label).toMatch(/walk/i)
    expect(walk.label).not.toMatch(/off|ready/i)
    expect(walk.pressed).toBe('true')

    hud.dispose()
  })

  it('keeps the documented mode aligned with every production signal call site', () => {
    const help = APP_KEYS.find((row) => row.id === 'sound')
    expect(help, 'the sound control must stay documented').toBeDefined()
    const declaredModes = cameraModes().filter((mode) => (
      new RegExp(`\\b${mode}\\b`, 'i').test(help?.what ?? '')
    ))
    expect(declaredModes, 'sound help must name the mode that owns its sources').toHaveLength(1)

    const methods = producingAudioMethods()
    expect(
      methods.size,
      'the audio implementation must still expose a signal-producing path',
    ).toBeGreaterThan(0)
    const sites = producingCallSites(methods)
    expect(
      sites.length,
      'the production app must still call a signal-producing audio method',
    ).toBeGreaterThan(0)

    const sourceMode = declaredModes[0]
    expect(
      sourceMode,
      'help and live control must describe the same sound scope',
    ).toBe(MOVEMENT_SOUND_MODE)
    const expectedFile = `src/engine/${sourceMode}.ts`
    expect(
      [...new Set(sites.map((site) => site.file))],
      `signal calls ${sites.map((site) => `${site.file}:${site.line}`).join(', ')} disagree with the ${sourceMode}-scoped control`,
    ).toEqual([expectedFile])
  })
})
