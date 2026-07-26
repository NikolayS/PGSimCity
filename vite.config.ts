import { defineConfig } from 'vite'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

/**
 * Only build pages that actually exist on disk.
 *
 * A rollup input pointing at a missing file fails the whole build, which takes
 * down the Pages deploy for everyone. Listing an entry that is still being
 * written should degrade to "not built yet", not "nothing ships".
 */
const input: Record<string, string> = { city: entry('./index.html') }

/**
 * The observability page is a second entry that is still being written. Build it
 * only when its whole entry graph is present — the page, its module, and the
 * module's own local imports. Checking just one of those still lets a partially
 * landed feature fail the build and block the deploy, which has happened twice.
 *
 * Set PGSIMCITY_ENTRIES=city to force the city alone regardless.
 */
const allExist = (...paths: string[]) => paths.every((p) => existsSync(entry(p)))

if (
  process.env.PGSIMCITY_ENTRIES !== 'city' &&
  allExist('./observability/index.html', './src/observability/main.ts', './src/observability/style.css')
) {
  input.observability = entry('./observability/index.html')
}

export default defineConfig({
  base: './',
  server: { host: true, port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input },
  },
  /* Agent worktrees land under .claude/worktrees/, inside the repo. Without this
   * exclude, vitest globs into them and runs another agent's in-progress
   * red tests as though they were this tree's -- which reported 166 tests and
   * 12 failures in a working tree that was clean. dist/ is built output. */
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
})
