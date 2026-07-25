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

// The observability page is only buildable once BOTH its HTML and the module
// that HTML loads exist. Checking only the page lets a half-landed feature take
// the deploy down.
const observability = entry('./observability/index.html')
if (existsSync(observability) && existsSync(entry('./src/observability/main.ts'))) {
  input.observability = observability
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
})
