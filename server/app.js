/**
 * Shared server boundary (Phase 1/B).
 *
 * The server is authoritative (plan §3.1): dispatcher and driver sessions
 * observe the same event sequence. This module exposes:
 *   - POST /api/auth/login       server-enforced login (scrypt-hashed passwords)
 *   - POST /api/auth/logout
 *   - GET  /api/session          validate the signed token, return role
 *   - POST /api/tracking/:ship   mint a signed, shipment-scoped customer grant
 *   - POST /api/events/ingest    idempotent observation ingestion (provider dedup)
 *   - POST /api/commands         operational commands (offers, assignments, visits)
 *   - GET  /api/events           event history (from a sequence, with age)
 *   - GET  /api/stream           SSE realtime, reconnect from last ack, shipment-scoped
 *   - GET  /api/projections/:name   read-only folds (dispatch, driver, billing)
 *   - GET  /api/health           ingestion health, freshness, data age
 *
 * Auth is server-enforced: every route except /api/health and /api/auth/login
 * requires a valid signed token. Customer tokens are shipment-scoped (the
 * stream/projections filter to one shipment).
 */
import http from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { openStore } from './store.js'
import { createIngester } from '../src/domain/ingestion.js'
import { createSimService } from './sim-service.js'
import { EVENT, SCHEMA_VERSION } from '../src/domain/contract.js'
import { seedUsers, authenticate, ensureGrantsTable } from './auth.js'
import { SEED_USERS } from './seed-users.js'
import { handleLlm, handleIncidents, handleTrafficFlow, handleRoute } from './proxy.js'
import { createCommandProcessor, replayConfiguration, replayLoadBoard } from './commands.js'
import { createLoadBoard } from '../src/domain/loadboard.js'
import { createIntegrations } from './integrations/index.js'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const SESSION_TTL_MS = 8 * 3600_000
const CUSTOMER_GRANT_TTL_MS = 72 * 3600_000
const OBSERVATION_EVENT_TYPES = new Set([
  EVENT.TRUCK_PING, EVENT.DUTY_UPDATED, EVENT.FENCE_ENTER, EVENT.FENCE_EXIT,
  EVENT.STOP_ARRIVED, EVENT.STOP_CHECKED_IN, EVENT.STOP_SERVICE_STARTED,
  EVENT.STOP_SERVICE_COMPLETED, EVENT.STOP_DEPARTED,
])

/**
 * Create the server application. Returns an http.Server plus helpers for
 * testing (the store and ingester are exposed).
 *
 * @param {object} opts
 * @param {string} [opts.dbPath] SQLite path (':memory:' for tests)
 * @param {string} [opts.secret] HMAC secret for session tokens
 * @param {object} [opts.roles] seeded role directory {email: {role, ...}}
 */
export async function createServer({ dbPath = ':memory:', secret, roles = SEED_ROLES, seed = SEED_USERS, integrationKey } = {}) {
  // In production the secret must come from env; refuse to boot without it.
  const resolvedSecret = secret || process.env.SESSION_SECRET
  if (process.env.NODE_ENV === 'production' && !resolvedSecret) {
    throw new Error('SESSION_SECRET must be set in production')
  }
  const finalSecret = resolvedSecret || 'dev-secret'
  const store = await openStore(dbPath)
  // Seed the users table with hashed passwords on first boot.
  await seedUsers(store._db || store, seed)
  await ensureGrantsTable(store._db || store)
  // Build the durable working projection before accepting any observation.
  // It is used both by commands and to attach authoritative assignments to
  // telemetry whose provider does not know Corridor shipment ids.
  const history = await store.all()
  replayConfiguration(history, { reset: true })
  const loadBoard = createLoadBoard()
  await replayLoadBoard(loadBoard, history)
  let onIngestApplied = async () => {}
  const ingester = createIngester(async (e) => {
    let normalized = e
    if (e.type === EVENT.TRUCK_PING && e.truckId) {
      const active = loadBoard.allLoads().find((load) =>
        load.status === 'assigned' && load.acceptedTruckId === e.truckId)
      if (active) {
        normalized = {
          ...e,
          shipmentId: e.shipmentId || active.shipmentId,
          truck: {
            ...(e.truck || {}),
            loadId: active.id,
            shipmentId: active.shipmentId,
            destinationId: active.destinationId,
          },
        }
      }
    }
    const result = await store.append(normalized)
    if (result?.ok) {
      replayConfiguration([normalized])
      await replayLoadBoard(loadBoard, [normalized])
      await onIngestApplied(result.event || normalized)
    }
    return result
  })
  // The authoritative command processor: routes commands to the domain modules
  // and persists the resulting events. The loadBoard is rebuilt from the event
  // log on boot so it survives restart.
  const commandProcessor = createCommandProcessor({ store, loadBoard })
  const integrations = await createIntegrations({ ingester, store, loadBoard })
  const subscribers = new Set()
  let lastIngestAt = 0
  let lastIngestSource = 'none'

  /**
   * Authorize a request (closure over the resolved secret). Returns the session
   * or null. Customer sessions carry a shipmentId scope.
   */
  function authorize(req) {
    return authorizeToken(req, finalSecret, roles)
  }

  async function currentSequence() {
    if (store.kind === 'postgres' && store.refreshSeq) await store.refreshSeq()
    return store.currentSeq()
  }

  /** Drain all unseen events in bounded pages. The old implementation read the
   * first 100/500 records and then advanced the cursor to the database head,
   * making the skipped range unrecoverable. */
  async function pumpSubscriber(sub, initial = false) {
    if (sub.pumping) { sub.needsPump = true; return }
    sub.pumping = true
    try {
      do {
        sub.needsPump = false
        const target = await currentSequence()
        while (sub.lastSentSeq < target) {
          const batch = await store.eventsAfter(sub.lastSentSeq, 500)
          if (!batch.length) break
          for (const e of batch) {
            if (eventVisibleTo(sub, e)) {
              sub.res.write(`data: ${JSON.stringify(e)}\n\n`)
            }
          }
          // Advance by scanned sequence, including events filtered out of a
          // customer stream. No sequence is acknowledged before it is scanned.
          sub.lastSentSeq = Number(batch.at(-1).seq)
        }
      } while (sub.needsPump || sub.lastSentSeq < await currentSequence())

      const type = initial ? 'caught-up' : 'tick'
      sub.res.write(`data: ${JSON.stringify({ type, seq: sub.lastSentSeq, replayedThrough: sub.lastSentSeq })}\n\n`)
      await store.acknowledge?.(sub.clientId, sub.lastSentSeq)
    } catch {
      subscribers.delete(sub)
      try { sub.res.end() } catch {}
    } finally {
      sub.pumping = false
      if (sub.needsPump && subscribers.has(sub)) void pumpSubscriber(sub)
    }
  }

  async function notify() {
    await Promise.all([...subscribers].map((sub) => pumpSubscriber(sub)))
  }

  // A simulator tick commonly persists 40 pings together. Coalesce those
  // ingestion completions into one SSE pump instead of issuing a database scan
  // and acknowledgement per truck.
  let notifyPromise = null
  let notifyRequested = false
  function scheduleNotify() {
    notifyRequested = true
    if (notifyPromise) return notifyPromise
    notifyPromise = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          do {
            notifyRequested = false
            await notify()
          } while (notifyRequested)
        } catch (error) {
          console.error('SSE notification failed:', error?.message || error)
        } finally {
          notifyPromise = null
          resolve()
        }
      })
    })
    return notifyPromise
  }

  // Direct integration and simulator ingestion must wake SSE exactly like the
  // HTTP ingestion route. This hook also drives the freshness indicator.
  onIngestApplied = async (event) => {
    lastIngestAt = Date.now()
    lastIngestSource = event.source || 'live'
    await scheduleNotify()
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    const origin = req.headers.origin
    if (origin && corsAllowed(origin, req.headers.host)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, X-Integration-Key')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      if (origin && !corsAllowed(origin, req.headers.host)) return json(res, 403, { ok: false, error: 'origin not allowed' })
      res.statusCode = 204; return res.end()
    }

    // ---- health (open) ----
    if (path === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        backend: store.kind,
        lastSeq: store.currentSeq(),
        lastIngestAt,
        lastIngestSource,
        dataAgeMs: lastIngestAt ? Date.now() - lastIngestAt : null,
        subscribers: subscribers.size,
      })
    }

    // ---- auth: login (open) ----
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req)
      const user = await authenticate(store._db || store, body.email, body.password)
      if (!user) return json(res, 401, { ok: false, error: 'invalid credentials' })
      const token = mintToken(user, finalSecret)
      return json(res, 200, { ok: true, token, user })
    }

    // ---- auth: session ----
    if (path === '/api/session' && req.method === 'GET') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      return json(res, 200, { ok: true, user: session })
    }

    // ---- users directory (admin-only; no password hashes returned) ----
    if (path === '/api/users' && req.method === 'GET') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      if (session.role !== 'admin') return json(res, 403, { ok: false, error: 'admin only' })
      const rows = store._db?.kind === 'postgres'
        ? (await store._db.query(`SELECT id, email, role, name, driver_id, truck_id FROM users ORDER BY role, email`)).rows
        : store._db.prepare(`SELECT id, email, role, name, driver_id, truck_id FROM users ORDER BY role, email`).all()
      return json(res, 200, { ok: true, users: rows.map((r) => ({
        id: r.id, email: r.email, role: r.role, name: r.name,
        driverId: r.driver_id, truckId: r.truck_id,
      })) })
    }

    // ---- auth: logout (stateless token; client drops it) ----
    if (path === '/api/auth/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true })
    }

    // ---- revoke a tracking grant (dispatch/admin only) ----
    // Checked BEFORE the mint route so /api/tracking/<token>/revoke doesn't
    // get caught by the /api/tracking/:shipmentId mint handler.
    if (path.match(/^\/api\/tracking\/[^/]+\/revoke$/) && req.method === 'POST') {
      const session = authorize(req)
      if (!session || (session.role !== 'dispatch' && session.role !== 'admin')) {
        return json(res, 403, { ok: false, error: 'unauthorized' })
      }
      const tokenId = decodeURIComponent(path.split('/')[3])
      await revokeGrant(store._db || store, tokenId)
      return json(res, 200, { ok: true })
    }

    // ---- customer tracking grant (dispatch/admin only) ----
    // Mints a signed, shipment-scoped, expiring, revocable grant. The browser
    // never signs; the server validates the signature on the stream.
    if (path.startsWith('/api/tracking/') && req.method === 'POST') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      if (session.role !== 'dispatch' && session.role !== 'admin') {
        return json(res, 403, { ok: false, error: 'only staff may issue tracking links' })
      }
      const shipmentId = decodeURIComponent(path.split('/').pop())
      const grant = mintToken(
        { shipmentId, scope: 'customer', exp: Date.now() + CUSTOMER_GRANT_TTL_MS },
        finalSecret,
      )
      // Record the grant so it can be revoked.
      await recordGrant(store._db || store, grant, shipmentId, CUSTOMER_GRANT_TTL_MS, session.email)
      return json(res, 200, { ok: true, token: grant, shipmentId })
    }

    // ---- event stream (SSE) — shipment-scoped for customers ----
    if (path === '/api/stream' && req.method === 'GET') {
      // EventSource can't set headers, so the token comes from the query string.
      const token = url.searchParams.get('token')
      const fakeReq = { headers: { authorization: token ? `Bearer ${token}` : '' } }
      const session = authorize(fakeReq)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      // A revoked customer grant is rejected.
      if (session.scope === 'customer' && await isGrantRevoked(store._db || store, token)) {
        return json(res, 401, { ok: false, error: 'grant revoked' })
      }
      const lastAck = parseInt(url.searchParams.get('since') || '0', 10)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const sub = {
        res,
        clientId: url.searchParams.get('client') || cryptoId(),
        scope: session.scope,
        role: session.role,
        driverId: session.driverId,
        truckId: session.truckId,
        shipmentId: session.shipmentId,
        lastSentSeq: Number.isFinite(lastAck) && lastAck > 0 ? lastAck : 0,
        pumping: false,
        needsPump: false,
      }
      // Register before replay begins. Any append racing with the paged replay
      // marks this subscriber for another drain instead of falling into a gap.
      subscribers.add(sub)
      await pumpSubscriber(sub, true)
      req.on('close', () => subscribers.delete(sub))
      return
    }

    // ---- event history (authorized; shipment-scoped for customers) ----
    if (path === '/api/events' && req.method === 'GET') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      // A revoked customer grant is rejected on every read path, not just SSE.
      if (session.scope === 'customer') {
        const tok = (req.headers.authorization || '').slice(7)
        if (await isGrantRevoked(store._db || store, tok)) {
          return json(res, 401, { ok: false, error: 'grant revoked' })
        }
      }
      const since = parseInt(url.searchParams.get('since') || '0', 10)
      const limit = Math.min(1000, parseInt(url.searchParams.get('limit') || '500', 10))
      let events = await store.eventsAfter(since, limit)
      events = events.filter((e) => eventVisibleTo(session, e))
      return json(res, 200, { events, lastSeq: store.currentSeq() })
    }

    // ---- raw observation ingestion (integration role only) ----
    if (path === '/api/events/ingest' && req.method === 'POST') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      if (session.role !== 'integration') return json(res, 403, { ok: false, error: 'raw observation ingestion requires integration role' })
      const body = await readJson(req)
      if (!OBSERVATION_EVENT_TYPES.has(body.type)) return json(res, 400, { ok: false, error: 'unsupported observation type; use a command or integration adapter' })
      if (!body.providerId || !Number.isFinite(body.observedAt)) return json(res, 400, { ok: false, error: 'providerId and observedAt are required' })
      const r = await ingester.ingest(body)
      return json(res, r.ok ? 201 : 200, r)
    }

    // ---- commands (authorized) ----
    if (path === '/api/commands' && req.method === 'POST') {
      const body = await readJson(req)
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = await commandProcessor.handle(body, session)
      if (r.ok) await scheduleNotify()
      return json(res, r.ok ? 201 : r.forbidden ? 403 : r.conflict ? 409 : 400, r)
    }

    // ---- integration webhooks (Phase F) ----
    if (path === '/api/integrations/eld/webhook' && req.method === 'POST') {
      if (!authorizeIntegration(req, finalSecret, integrationKey || process.env.INTEGRATION_API_KEY)) {
        return json(res, 401, { ok: false, error: 'invalid integration credentials' })
      }
      const body = await readJson(req)
      const r = await integrations.eld.ingest(body)
      return json(res, 200, r)
    }
    if (path === '/api/integrations/orders/webhook' && req.method === 'POST') {
      if (!authorizeIntegration(req, finalSecret, integrationKey || process.env.INTEGRATION_API_KEY)) {
        return json(res, 401, { ok: false, error: 'invalid integration credentials' })
      }
      const body = await readJson(req)
      const r = await integrations.orders.ingest(body)
      return json(res, 200, r)
    }
    if (path === '/api/integrations/billing/export' && req.method === 'POST') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      if (session.role !== 'admin') return json(res, 403, { ok: false, error: 'admin only' })
      const r = await integrations.billing.exportClaims({})
      return json(res, 200, r)
    }
    if (path === '/api/integrations/health' && req.method === 'GET') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      return json(res, 200, { ok: true, ...integrations.healthReport() })
    }

    // ---- projections (authorized; role-scoped) ----
    // Row-level visibility is already enforced by eventVisibleTo (a driver sees
    // only their own truck's events; a customer only their shipment). This gate
    // adds role-level scoping: a driver may not read the dispatch/billing folds
    // even filtered, and staff do not read the driver projection. Customer tokens
    // have no business reading named projections.
    if (path.startsWith('/api/projections/') && req.method === 'GET') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      const name = path.split('/').pop()
      const allowed = projectionAllowed(name, session)
      if (!allowed.ok) return json(res, 403, allowed)
      let events = await store.all()
      events = events.filter((e) => eventVisibleTo(session, e))
      return json(res, 200, project(name, events))
    }

    // ---- LLM proxy (dispatch/admin only; key never reaches the browser) ----
    if (path === '/api/llm/ask' && req.method === 'POST') {
      const session = authorize(req)
      if (!session) return json(res, 401, { ok: false, error: 'unauthorized' })
      if (session.role !== 'dispatch' && session.role !== 'admin') {
        return json(res, 403, { ok: false, error: 'staff only' })
      }
      const body = await readJson(req)
      const r = await handleLlm(req, res, { key: process.env.LLM_KEY, body })
      return json(res, 200, r)
    }

    // ---- traffic + routing proxies (staff only; keys server-side) ----
    if (path === '/api/traffic/incidents' && req.method === 'GET') {
      const session = authorize(req)
      if (!session || (session.scope === 'customer')) return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = await handleIncidents(req, res, {})
      return json(res, 200, r)
    }
    if (path === '/api/traffic/flow' && req.method === 'GET') {
      const session = authorize(req)
      if (!session || session.scope === 'customer') return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = await handleTrafficFlow(req, res, { key: process.env.TOMTOM_KEY, points: TOMTOM_SAMPLES })
      return json(res, 200, r)
    }
    if (path === '/api/route' && req.method === 'GET') {
      const session = authorize(req)
      if (!session || session.scope === 'customer') return json(res, 401, { ok: false, error: 'unauthorized' })
      const r = await handleRoute(req, res, { osrmUrl: process.env.OSRM_URL })
      return json(res, 200, r)
    }

    // ---- static file serving (production: serve the built dist/) ----
    // A single Node process serves both the API and the frontend. Non-/api
    // paths fall back to index.html so client-side hash routing works.
    if (!path.startsWith('/api/') && req.method === 'GET') {
      return serveStatic(req, res)
    }

    return json(res, 404, { error: 'not found' })
  })

  return {
    server, store, ingester, notify, loadBoard, commandProcessor, integrations,
    close: async () => { integrations.stopPolling(); await store.close(); server.close() },
  }
}

/**
 * Authorize a request from its session token. Returns the session or null.
 * A signed token (HMAC) replaces the browser-seeded credentials (plan §10).
 */
/**
 * Authorize a request from its signed session token. Returns the session
 * payload or null. Customer tokens carry { scope: 'customer', shipmentId }.
 */
export function authorizeToken(req, secret, roles) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const [b64, sig] = token.split('.')
  if (!b64 || !sig) return null
  const expected = createHmac('sha256', secret).update(b64).digest('hex')
  const suppliedSig = Buffer.from(sig)
  const expectedSig = Buffer.from(expected)
  if (suppliedSig.length !== expectedSig.length || !timingSafeEqual(suppliedSig, expectedSig)) return null
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString())
    if (payload.exp && Date.now() > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

/** Webhooks accept only an integration/admin session or the carrier-owned API
 * key. A missing server key never degrades into anonymous write access. */
function authorizeIntegration(req, secret, configuredKey) {
  const session = authorizeToken(req, secret)
  if (session?.role === 'integration' || session?.role === 'admin') return true
  const supplied = req.headers['x-integration-key']
  if (supplied && configuredKey) {
    const a = Buffer.from(String(supplied))
    const b = Buffer.from(String(configuredKey))
    return a.length === b.length && timingSafeEqual(a, b)
  }
  return false
}

function corsAllowed(origin, host) {
  try {
    const parsed = new URL(origin)
    if (host && parsed.host === host) return true
    const configured = String(process.env.CORS_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    if (configured.includes(origin)) return true
    return process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(parsed.hostname)
  } catch {
    return false
  }
}

function eventVisibleTo(session, event) {
  if (session.scope === 'customer') return event.shipmentId === session.shipmentId
  if (session.role === 'driver') {
    return event.truckId === session.truckId || event.driverId === session.driverId
  }
  return session.role === 'dispatch' || session.role === 'admin' || session.role === 'integration'
}

// ---- tracking-grant persistence (revocation) ----

async function recordGrant(db, tokenId, shipmentId, ttlMs, issuedBy) {
  const now = Date.now()
  if (db.kind === 'postgres') {
    await db.query(
      `INSERT INTO tracking_grants (token_id, shipment_id, exp, issued_at, issued_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_id) DO NOTHING`,
      [tokenId, shipmentId, now + ttlMs, now, issuedBy],
    )
  } else {
    db.prepare(
      `INSERT INTO tracking_grants (token_id, shipment_id, exp, issued_at, issued_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(token_id) DO NOTHING`,
    ).run(tokenId, shipmentId, now + ttlMs, now, issuedBy)
  }
}

async function revokeGrant(db, tokenId) {
  if (db.kind === 'postgres') {
    await db.query(`UPDATE tracking_grants SET revoked_at = $1 WHERE token_id = $2`, [Date.now(), tokenId])
  } else {
    db.prepare(`UPDATE tracking_grants SET revoked_at = ? WHERE token_id = ?`).run(Date.now(), tokenId)
  }
}

async function isGrantRevoked(db, tokenId) {
  const rows = db.kind === 'postgres'
    ? (await db.query(`SELECT revoked_at FROM tracking_grants WHERE token_id = $1`, [tokenId])).rows
    : db.prepare(`SELECT revoked_at FROM tracking_grants WHERE token_id = ?`).all(tokenId)
  return rows.length > 0 && rows[0].revoked_at != null
}

/** Mint a signed session token for a user. */
export function mintToken(user, secret, ttlMs = SESSION_TTL_MS) {
  const now = Date.now()
  const payload = { ...user, exp: user.exp ?? now + ttlMs, iat: now }
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(b64).digest('hex')
  return `${b64}.${sig}`
}

const SEED_ROLES = {
  'dispatch@gladiolus.ca': { role: 'dispatch', name: 'Dispatch' },
  'admin@gladiolus.ca': { role: 'admin', name: 'Admin' },
}

/**
 * Read-only projections over the event log.
 */
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

/**
 * Role-level access control for named projections (the RLS boundary staff
 * cannot cross by calling a different fold). Row-level filtering is applied
 * after this; this gate exists so a driver cannot read the dispatch or billing
 * folds at all, and a customer token cannot read any named projection.
 *
 *   dispatch → staff (dispatch/admin/integration)
 *   billing  → admin only
 *   driver   → driver (their own truck, row-filtered by eventVisibleTo)
 */
function projectionAllowed(name, session) {
  if (session.scope === 'customer') return { ok: false, forbidden: true, error: 'customers may not read projections' }
  switch (name) {
    case 'dispatch':
      return session.role === 'dispatch' || session.role === 'admin' || session.role === 'integration'
        ? { ok: true }
        : { ok: false, forbidden: true, error: 'staff only' }
    case 'billing':
      return session.role === 'admin'
        ? { ok: true }
        : { ok: false, forbidden: true, error: 'admin only' }
    case 'driver':
      return session.role === 'driver'
        ? { ok: true }
        : { ok: false, forbidden: true, error: 'driver only' }
    default:
      return { ok: false, forbidden: true, error: `unknown projection: ${name}` }
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

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/**
 * Serve the built frontend from dist/. In production a single Node process
 * serves both the API (/api/*) and the static client (everything else). Non-/
 * api paths with no matching file fall back to index.html so client-side hash
 * routing works. If dist/ doesn't exist (dev), returns 404 — vite serves the
 * client in dev.
 */
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let pathname = url.pathname
  if (pathname === '/') pathname = '/index.html'
  // Guard against path traversal.
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
  const distRoot = join(process.cwd(), 'dist')
  const filePath = join(distRoot, safe)
  if (!filePath.startsWith(distRoot)) { res.writeHead(403); return res.end('forbidden') }
  try {
    const data = await readFile(filePath)
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
    return res.end(data)
  } catch {
    // SPA fallback: serve index.html for any non-file path (hash routing).
    try {
      const index = await readFile(join(distRoot, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(index)
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'not found', hint: 'build the client (npm run build) or run vite in dev' }))
    }
  }
}

/** Sample points for TomTom flow (mirrors src/services/tomtom.js SAMPLES). */
const TOMTOM_SAMPLES = [
  [42.32, -82.6], [42.6, -81.6], [42.95, -81.25], [43.13, -80.75],
  [43.36, -80.31], [43.47, -79.98], [43.59, -79.64], [43.76, -79.51],
]

function cryptoId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Default export: a convenience to start a standalone server. */
export async function start({ port = 8787, dbPath, runSim = true } = {}) {
  const { server, store, ingester, close } = await createServer({ dbPath })
  let sim = null
  if (runSim) {
    // Direct ingestion already wakes SSE through onIngestApplied.
    sim = createSimService({ ingest: ingester.ingest })
    sim.bootstrap()
    sim.start()
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, () => {
      server.off('error', onError)
      resolve()
    })
  })
  console.log(`corridor server on http://localhost:${port} (db: ${store.kind})`)
  return { server, store, ingester, sim, close: async () => { sim?.stop(); await close() } }
}
