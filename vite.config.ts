import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: { host: true, port: 5173, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
})
