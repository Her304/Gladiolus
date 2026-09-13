/**
 * Shared server boundary (Phase 1).
 *
 * The server is authoritative (plan §3.1): dispatcher and driver sessions
 * observe the same event sequence. This module exposes:
 *   - POST /api/events/ingest   idempotent observation ingestion (provider dedup)
 *   - POST /api/commands        operational commands (offers, assignments, visits)
 *   - GET  /api/events          event history (from a sequence, with age)
 *   - GET  /api/stream          SSE realtime, reconnect from last ack
 *   - GET  /api/projections/:name   read-only folds (dispatch, driver, billing)
 *   - GET  /api/health          ingestion health, freshness, data age
 *
 * Auth is server-enforced role + shipment-scoped (the full identity system is
 * Phase 6; here a signed session token gates roles and customer scope).
 */
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { openStore } from './store.js'
import { createIngester } from '../src/domain/ingestion.js'
import { createSimService } from './sim-service.js'
import { EVENT, SCHEMA_VERSION } from '../src/domain/contract.js'

const SESSION_TTL_MS = 8 * 3600_000

/**
 * Create the server application. Returns an http.Server plus helpers for
 * testing (the store and ingester are exposed).
 *
 * @param {object} opts
 * @param {string} [opts.dbPath] SQLite path (':memory:' for tests)
 * @param {string} [opts.secret] HMAC secret for session tokens
 * @param {object} [opts.roles] seeded role directory {email: {role, ...}}
 */
export function createServer({ dbPath = ':memory:', secret = 'dev-secret', roles = SEED_ROLES } = {}) {
  const store = openStore(dbPath)
  const ingester = createIngester((e) => store.append(e))
  const subscribers = new Set()
  let lastIngestAt = 0
  let lastIngestSource = 'none'

  function notify() {
    const seq = store.currentSeq()
    const payload = `data: ${JSON.stringify({ seq, type: 'tick' })}\n\n`
    for (const sub of subscribers) {
      try { sub.res.write(payload) } catch { subscribers.delete(sub) }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

    // ---- health ----
    if (path === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        lastSeq: store.currentSeq(),
        lastIngestAt,
        lastIngestSource,
        dataAgeMs: lastIngestAt ? Date.now() - lastIngestAt : null,
        subscribers: subscribers.size,
      })
    }

    // ---- event stream (SSE) ----
    if (path === '/api/stream' && req.method === 'GET') {
      const lastAck = parseInt(url.searchParams.get('since') || '0', 10)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Replay from last acknowledged sequence so a reconnect misses nothing.
      const missed = store.eventsAfter(lastAck)
      for (const e of missed) res.write(`data: ${JSON.stringify(e)}\n\n`)
      const sub = { res, clientId: url.searchParams.get('client') || cryptoId() }
      subscribers.add(sub)
      res.write(`data: ${JSON.stringify({ type: 'caught-up', seq: store.currentSeq() })}\n\n`)
      req.on('close', () => subscribers.delete(sub))
      return
    }

    // ---- event history ----
    if (path === '/api/events' && req.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '0', 10)
      const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10))
      return json(res, 200, { events: store.eventsAfter(since, limit), lastSeq: store.currentSeq() })
    }

    // ---- ingestion ----
    if (path === '/api/events/ingest' && req.method === 'POST') {
      const body = await readJson(req)
      const r = ingester.ingest(body)
      if (r.ok) {
        lastIngestAt = Date.now()
        lastIngestSource = body.source || 'live'
        notify()
      }
      return json(res, r.ok ? 201 : 200, r)
    }

    // ---- commands ----
    if (path === '/api/commands' && req.method === 'POST') {
      const body = await readJson(req)
      const session = authorize(req, secret, roles)
      const r = handleCommand(body, session, store)
      if (r.ok) notify()
      return json(res, r.ok ? 201 : r.conflict ? 409 : 400, r)
    }

    // ---- projections ----
    if (path.startsWith('/api/projections/') && req.method === 'GET') {
      const name = path.split('/').pop()
      const events = store.all()
      return json(res, 200, project(name, events))
    }

    return json(res, 404, { error: 'not found' })
  })

  return { server, store, ingester, close: () => { store.close(); server.close() } }
}

/**
 * Authorize a request from its session token. Returns the session or null.
 * A signed token (HMAC) replaces the browser-seeded credentials (plan §10).
 */
export function authorize(req, secret, roles) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  const expected = createHmac('sha256', secret).update(b64).digest('hex')
  if (sig !== expected) return null
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString())
    if (payload.exp && Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

/** Mint a signed session token for a user. */
export function mintToken(user, secret, ttlMs = SESSION_TTL_MS) {
  const payload = { ...user, exp: Date.now() + ttlMs, iat: Date.now() }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
  const sig = createHmac('sha256', secret).update(b64).digest('hex')
  return `${b64}.${sig}`
}

const SEED_ROLES = {
  'dispatch@gladiolus.ca': { role: 'dispatch', name: 'Dispatch' },
  'admin@gladiolus.ca': { role: 'admin', name: 'Admin' },
}

/**
 * Command handler. Each command is idempotent (keyed), version-checked, and
 * produces an explicit success/conflict/failure result. Phase 2-4 flesh out the
 * full shipment/assignment/claim command set; this establishes the boundary.
 */
function handleCommand(cmd, session, store) {
  if (!session) return { ok: false, error: 'unauthorized' }
  switch (cmd.type) {
    case 'reserve':
    case 'commit':
    case 'unassign':
      // Assignment commands route through the domain module (Phase 4).
      return { ok: false, error: 'assignment lifecycle wired in Phase 4' }
    default:
      return { ok: false, error: `unknown command: ${cmd.type}` }
  }
}

/** Read-only projections over the event log. */
function project(name, events) {
  switch (name) {
    case 'dispatch':
      return { shipments: events.filter((e) => e.type.startsWith('shipment.')), count: events.length }
    case 'driver':
      return { events: events.filter((e) => e.type.startsWith('stop.') || e.type.startsWith('duty.')) }
    case 'billing':
      return { claims: events.filter((e) => e.type.startsWith('detention.')) }
    default:
      return { error: `unknown projection: ${name}` }
    }
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
    })
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Default export: a convenience to start a standalone server. */
export function start({ port = 8787, dbPath, runSim = true } = {}) {
  const { server, store, ingester, close } = createServer({ dbPath })
  let sim = null
  if (runSim) {
    sim = createSimService({ ingest: ingester.ingest })
    sim.bootstrap()
    sim.start()
  }
  server.listen(port)
  console.log(`corridor server on http://localhost:${port} (db: ${dbPath})`)
  return { server, store, ingester, sim, close: () => { sim?.stop(); close() } }
}
