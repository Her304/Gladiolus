import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The authoritative Corridor server (Phase 1): commands, events, SSE
      // stream. All operational state lives here, not in each browser.
      '/api/events': 'http://localhost:8787',
      '/api/commands': 'http://localhost:8787',
      '/api/stream': {
        target: 'http://localhost:8787',
        // SSE needs the ws:false + changeOrigin, and no buffering.
        changeOrigin: true,
      },
      '/api/projections': 'http://localhost:8787',
      '/api/health': 'http://localhost:8787',
      // Ontario 511 does not reliably send CORS headers. Proxying in dev keeps
      // the live feed usable; a static production build falls back to the
      // bundled fixture unless you put an equivalent proxy in front of it.
      '/api/511': {
        target: 'https://511on.ca',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/511/, ''),
      },
      // The browser talks only to the local app. In production this path should
      // point at a carrier-owned OSRM instance or serverless routing function.
      '/api/route': {
        target: 'https://router.project-osrm.org',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/route/, ''),
      },
    },
  },
})
