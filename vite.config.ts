import { defineConfig } from 'vite'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const pkg = JSON.parse(readFileSync(entry('./package.json'), 'utf8')) as { version: string }

function shortGitSha(): string {
  const supplied = process.env.PGSIMCITY_GIT_SHA ?? process.env.GITHUB_SHA
  if (supplied && /^[0-9a-f]{7,40}$/i.test(supplied)) return supplied.slice(0, 7).toLowerCase()
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: entry('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

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
  define: {
    __PGSIMCITY_VERSION__: JSON.stringify(pkg.version),
    __PGSIMCITY_GIT_SHA__: JSON.stringify(shortGitSha()),
  },
  /* PGlite locates its data and WASM with import.meta.url. Vite's dependency
   * pre-bundler rewrites that relationship and serves an HTML fallback where
   * the filesystem bundle should be, so the package must remain unoptimised. */
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  server: { host: true, port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    /* ES modules still load imported chunks when an older browser ignores the
     * preload hint. Omitting Vite's preload polyfill keeps the observability
     * entry's dynamic database loader out of the city's shared critical path. */
    modulePreload: { polyfill: false },
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
