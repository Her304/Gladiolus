import { createStore } from './engine/events.js'
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

// Keep the large physical model out of the normal server-backed browser
// bundle. The facade also accepts feed updates while the local-only simulator
// chunk is still loading.
let simulator = null
let requestedSpeed = 30
let pendingIncidents = []
let pendingFlow = []
export const sim = {
  setIncidents(list) {
    pendingIncidents = list || []
    simulator?.setIncidents(pendingIncidents)
  },
  setFlow(list) {
    pendingFlow = list || []
    simulator?.setFlow(pendingFlow)
  },
  setSpeed(value) {
    requestedSpeed = Math.max(1, Math.min(240, value))
    simulator?.setSpeed(requestedSpeed)
  },
  getSpeed: () => simulator?.getSpeed() ?? requestedSpeed,
  getClock: () => simulator?.getClock() ?? 0,
  getTruck: (id) => simulator?.getTruck(id),
  driverParking: (...args) => simulator
    ? simulator.driverParking(...args)
    : { ok: false, error: 'Simulator is still loading.' },
}

const TICK_MS = 500
let started = false

export async function startRuntime() {
  if (started) return
  started = true
  if (SERVER_ENABLED) {
    // Production: data comes from the server stream, not a local sim. The
    // serverClient (App.jsx) feeds events into `store`; do not start the tick
    // loop. Until integrations feed the server, the production DB is empty —
    // real data enters only through ELD/order/billing adapters (Phase F).
    return
  }
  // Dev/demo: load the physical model only when this browser is actually the
  // data source. Server-backed clients never download or parse this chunk.
  const { createSimulator } = await import('./engine/simulator.js')
  simulator = createSimulator(store, { startHour: 14 })
  simulator.setSpeed(requestedSpeed)
  simulator.setIncidents(pendingIncidents)
  simulator.setFlow(pendingFlow)
  simulator.bootstrap()
  setInterval(() => simulator.advance(TICK_MS), TICK_MS)
}
