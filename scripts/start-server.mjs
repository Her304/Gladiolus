#!/usr/bin/env node
/**
 * Standalone server entry (Phase 1/A).
 *
 * `node scripts/start-server.mjs` runs the authoritative server. Production
 * uses PostgreSQL (DATABASE_URL); dev falls back to SQLite (DB_PATH). The dev
 * Vite proxy forwards /api/* here. The simulator runs server-side (dev/demo)
 * and writes through the ingestion API, so simulated and real ELD observations
 * are indistinguishable.
 */
import { start } from '../server/app.js'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const port = Number(process.env.PORT) || 8787
const dbPath = process.env.DB_PATH || './data/corridor.db'
if (!process.env.DATABASE_URL && dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
// Production gets data from integrations, not the synthetic sim. RUN_SIM=true
// overrides for a demo deploy that wants synthetic data server-side.
const runSim = process.env.RUN_SIM === 'true' || process.env.NODE_ENV !== 'production'

start({ port, dbPath, runSim }).then(({ server, sim }) => {
  function shutdown() {
    console.log('\nshutting down…')
    sim?.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}).catch((e) => {
  console.error('failed to start:', e)
  process.exit(1)
})
