import { createStore } from './engine/events.js'
import { createSimulator } from './engine/simulator.js'

/**
 * Module-level singletons. React 19 StrictMode mounts effects twice in
 * development; creating the store and simulator here rather than in a component
 * means the log is never built twice and the tick loop is never doubled.
 */
export const store = createStore()
export const sim = createSimulator(store, { startHour: 14 })

const TICK_MS = 500
let started = false

export function startRuntime() {
  if (started) return
  started = true
  sim.bootstrap()
  setInterval(() => sim.advance(TICK_MS), TICK_MS)
}
