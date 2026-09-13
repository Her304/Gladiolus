/**
 * Simulator-as-a-service (Phase 1).
 *
 * The simulation is a data source, not a shortcut (plan §3.10): it emits the
 * same commands and observations expected from real integrations. This module
 * runs the existing physical simulator in a single service process and writes
 * every observation through the server's ingestion boundary, so a simulated
 * truck and a real ELD truck are indistinguishable downstream.
 *
 * In the browser, the simulator ran inside each tab with no shared authority.
 * Here it runs once, server-side, and clients observe the resulting events.
 */
import { createStore } from '../src/engine/events.js'
import { createSimulator } from '../src/engine/simulator.js'
import { INITIAL_INCIDENTS } from '../src/services/on511.js'
import { createIngester } from '../src/domain/ingestion.js'

const TICK_MS = 500

/**
 * @param {object} opts
 * @param {function} opts.ingest  ingestion sink (server.ingester.ingest or a test stub)
 * @param {number} [opts.startHour]
 * @param {number} [opts.speed]
 */
export function createSimService({ ingest, startHour = 14, speed = 30 } = {}) {
  if (typeof ingest !== 'function') throw new Error('createSimService requires an ingest sink')
  // An internal store the simulator writes to; we tee each appended event into
  // the ingestion sink so the durable log and the sim's own fold stay aligned.
  const internalStore = createStore()
  const sim = createSimulator(internalStore, { startHour })
  sim.setIncidents(INITIAL_INCIDENTS)
  sim.setSpeed(speed)

  let running = false
  let timer = null
  let tickCount = 0

  // Tee: every event the simulator appends is also ingested through the same
  // idempotent boundary as an external ELD observation.
  const origAppend = internalStore.append.bind(internalStore)
  internalStore.append = (type, at, payload = {}) => {
    const e = origAppend(type, at, payload)
    // Simulated observations carry provenance + a stable provider id so retries
    // dedup. Provider id combines truck + type + a tick-stable key for fences.
    ingest({
      type,
      observedAt: at,
      receivedAt: Date.now(),
      providerId: simProviderId(type, payload),
      source: 'simulated',
      payload,
      ...payload,
    })
    return e
  }

  function simProviderId(type, p) {
    if (p.truckId) return `sim:${type}:${p.truckId}:${tickCount}`
    return `sim:${type}:${tickCount}`
  }

  function tick() {
    sim.advance(TICK_MS)
    tickCount++
  }

  return {
    sim,
    bootstrap() { sim.bootstrap() },
    start() {
      if (running) return
      running = true
      timer = setInterval(tick, TICK_MS)
    },
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = null
    },
    /** Advance N ticks synchronously (headless tests / smoke). */
    advance(n = 1) {
      for (let i = 0; i < n; i++) tick()
    },
    get tickCount() { return tickCount },
    getClock: () => sim.getClock(),
  }
}
