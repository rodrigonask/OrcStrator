import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// API port is env-overridable so a worktree build can be driven against an isolated
// server (PORT=3335 ORCSTRATOR_DATA_DIR=... on the server side) without touching the
// real one on 3334. Default is unchanged, so normal `npm run dev` is unaffected.
const API_PORT = process.env.ORCSTRATOR_API_PORT || '3334'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
      '/ws': { target: `ws://localhost:${API_PORT}`, ws: true }
    }
  },
  resolve: {
    alias: { '@shared': path.resolve(__dirname, '../shared/src') }
  },
  // Explicit, so the shipped release can never carry maps of the original source.
  build: { sourcemap: false }
})
