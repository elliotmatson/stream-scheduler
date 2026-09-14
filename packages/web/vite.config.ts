import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Built assets are served by the core API server from packages/host/web.
  build: { outDir: '../host/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8500',
      '/ws': { target: 'ws://127.0.0.1:8500', ws: true },
    },
  },
})
