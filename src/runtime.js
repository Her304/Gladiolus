import { createStore } from './engine/events.js'
import { createSimulator } from './engine/simulator.js'
// Imported for effect, and the order matters: applying persisted administrator
// overrides onto the site objects has to happen before `bootstrap()` reads
// them, so it belongs here in the module that owns boot order rather than in
// whichever panel happens to render first.
import './admin/settings.js'

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
