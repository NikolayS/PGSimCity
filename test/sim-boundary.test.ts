import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(fileURLToPath(new URL('../src', import.meta.url)))
const SIM = resolve(SRC, 'sim')

const imports = (source: string): string[] => [
  ...source.matchAll(/(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g),
].map((match) => match[1])

function resolveModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  const target = resolve(dirname(from), specifier)
  return extname(target) ? target : `${target}.ts`
}

function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of imports(readFileSync(file, 'utf8'))) {
      const dependency = resolveModule(file, specifier)
      if (dependency) pending.push(dependency)
      else if (specifier === 'three') seen.add('three')
    }
  }
  return seen
}

describe('simulation dependency boundary', () => {
  it('keeps the model runtime closure out of world and three.js', () => {
    const closure = runtimeClosure(resolve(SIM, 'model.ts'))
    const violations = [...closure]
      .filter((file) => file === 'three' || file.startsWith(`${resolve(SRC, 'world')}/`))
      .map((file) => file === 'three' ? file : file.slice(SRC.length + 1))

    expect(violations).toEqual([])
  })
})
