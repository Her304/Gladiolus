#!/usr/bin/env node
/**
 * Standalone server entry (Phase 1).
 *
 * `node scripts/start-server.mjs` runs the authoritative server with a
 * file-backed SQLite store, so state survives restart. The dev Vite proxy
 * forwards /api/* here. The simulator runs server-side and writes through the
 * ingestion API, so simulated and real ELD observations are indistinguishable.
 */
import { start } from '../server/app.js'

const port = Number(process.env.PORT) || 8787
const dbPath = process.env.DB_PATH || './data/corridor.db'

const { server, sim } = start({ port, dbPath, runSim: true })

function shutdown() {
  console.log('\nshutting down…')
  sim?.stop()
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
