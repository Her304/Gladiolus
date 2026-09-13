import { createStore } from './engine/events.js'
import { createSimulator } from './engine/simulator.js'
import { SERVER_BASE, SERVER_ENABLED } from './services/serverConfig.js'

/**
 * Module-level singletons. React 19 StrictMode mounts effects twice in
 * development; creating the store and simulator here rather than in a component
 * means the log is never built twice and the tick loop is never doubled.
 *
 * Data-source selection (Phase E): when the server is enabled (always in a
 * production bundle; explicit VITE_SERVER_URL in development), the
 * browser does NOT start its own simulator — it reads from the server SSE
 * stream (App.jsx wires serverClient events into this same store). When unset
 * (dev), the seeded 40-truck demo sim runs locally, labelled "Demo sim".
 */
export const store = createStore()
export const SERVER_URL = SERVER_ENABLED ? (SERVER_BASE || globalThis.location?.origin || 'same-origin') : ''
export const sim = createSimulator(store, { startHour: 14 })

const TICK_MS = 500
let started = false

export function startRuntime() {
  if (started) return
  started = true
  if (SERVER_ENABLED) {
    // Production: data comes from the server stream, not a local sim. The
    // serverClient (App.jsx) feeds events into `store`; do not start the tick
    // loop. Until integrations feed the server, the production DB is empty —
    // real data enters only through ELD/order/billing adapters (Phase F).
    return
  }
  // Dev/demo: run the seeded 40-truck simulation as display-only data.
  sim.bootstrap()
  setInterval(() => sim.advance(TICK_MS), TICK_MS)
}
