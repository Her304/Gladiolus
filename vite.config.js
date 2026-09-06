import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Ontario 511 does not reliably send CORS headers. Proxying in dev keeps
      // the live feed usable; a static production build falls back to the
      // bundled fixture unless you put an equivalent proxy in front of it.
      '/api/511': {
        target: 'https://511on.ca',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/511/, ''),
      },
    },
  },
})
