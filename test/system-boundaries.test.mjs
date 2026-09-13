/** Adversarial proof of the production boundaries called out by the review. */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createServer, mintToken } from '../server/app.js'
import { migrate } from '../server/migrate.js'
import { BASE_SITE_CAPACITIES, SITE_BY_ID } from '../src/data/corridor.js'

const SECRET = 'boundary-proof-secret'
const INTEGRATION_KEY = 'boundary-proof-integration-key'
const MIN = 60_000

describe('production boundary proof', () => {
  test('PostgreSQL migration is native PostgreSQL DDL', async () => {
    const statements = []
    await migrate({ kind: 'postgres', query: async (sql) => { statements.push(sql); return { rows: [] } } })
    const ddl = statements.join('\n')
    assert.match(ddl, /BIGSERIAL PRIMARY KEY/)
    assert.match(ddl, /JSONB NOT NULL DEFAULT '\{\}'::jsonb/)
    assert.doesNotMatch(ddl, /AUTOINCREMENT/)
  })

  test('SSE replays every event beyond the old 500-event page boundary', async (t) => {
    const app = await createServer({ dbPath: ':memory:', secret: SECRET, seed: [] })
    t.after(async () => app.close())
    for (let i = 1; i <= 1205; i++) {
      await app.store.append({
        type: 'shipment.posted', providerId: `sse-${i}`, observedAt: i,
        shipmentId: `SHP-${i}`, loadId: `L-${i}`, originId: 'london-dc',
        destinationId: 'milton-intermodal',
      })
    }
    const port = await listen(app.server)
    const token = mintToken({ role: 'dispatch', email: 'dispatch@gladiolus.ca' }, SECRET)
    const frames = await readSseUntilCaughtUp(port, token)
    const events = frames.filter((e) => e.type !== 'caught-up' && e.type !== 'tick')
    const caughtUp = frames.find((e) => e.type === 'caught-up')
    assert.equal(events.length, 1205)
    assert.equal(events[0].seq, 1)
    assert.equal(events.at(-1).seq, 1205)
    assert.equal(caughtUp.replayedThrough, 1205)
  })

  test('authenticated intake → feasible assignment → GPS detention → billing survives restart', async (t) => {
    const dbPath = `/tmp/corridor-boundary-${process.pid}-${Date.now()}.db`
    const exportPath = `/tmp/corridor-boundary-export-${process.pid}-${Date.now()}`
    const previousExportPath = process.env.BILLING_EXPORT_PATH
    process.env.BILLING_EXPORT_PATH = exportPath
    t.after(async () => {
      try { await app?.close() } catch {}
      if (previousExportPath == null) delete process.env.BILLING_EXPORT_PATH
      else process.env.BILLING_EXPORT_PATH = previousExportPath
    })

    let app = await createServer({
      dbPath, secret: SECRET, integrationKey: INTEGRATION_KEY, seed: [],
    })
    const port = await listen(app.server)
    const dispatch = mintToken({ role: 'dispatch', email: 'dispatch@gladiolus.ca' }, SECRET)
    const driver = mintToken({
      role: 'driver', email: 'gld-101@carrier.local', driverId: 'D-101', truckId: 'GLD-101',
    }, SECRET)
    const admin = mintToken({ role: 'admin', email: 'admin@gladiolus.ca' }, SECRET)
    const now = Date.now()

    const order = await request(port, '/api/integrations/orders/webhook', {
      externalId: 'PROOF-1', loadId: 'L-PROOF-1', shipmentId: 'SHP-PROOF-1',
      originId: 'london-dc', destinationId: 'milton-intermodal',
      payloadKg: 18_000, revenue: 1_850, equipment: ['dry-van'], readyAt: now,
    }, { integrationKey: INTEGRATION_KEY })
    assert.equal(order.status, 200)
    assert.equal(order.body.ok, true)

    const eld = await request(port, '/api/integrations/eld/webhook', {
      driverId: 'D-101', truckId: 'GLD-101', timestamp: now,
      dutyStatus: 'driving', drivingMs: 2 * 3600_000, onDutyMs: 3 * 3600_000,
      elapsedMs: 4 * 3600_000, cycleMs: 20 * 3600_000,
      dailyOffDutyMs: 10 * 3600_000, regime: 'cycle1',
      latitude: 43.1, longitude: -80.7, speedKph: 88, odometerKm: 100_000,
      equipment: ['dry-van'], tareKg: 15_500, grossLimitKg: 39_500,
    }, { integrationKey: INTEGRATION_KEY })
    assert.equal(eld.body.ok, true)

    const offer = await request(port, '/api/commands', {
      type: 'offerLoad', loadId: 'L-PROOF-1', driverId: 'D-101', truckId: 'GLD-101', now: now + 1,
    }, { token: dispatch })
    assert.equal(offer.status, 201)
    assert.equal(offer.body.feasibility.verdict, 'feasible')

    const accept = await request(port, '/api/commands', {
      type: 'acceptOffer', loadId: 'L-PROOF-1', idempotencyKey: 'proof-accept', now: now + 2,
    }, { token: driver })
    assert.equal(accept.status, 201)
    assert.equal(accept.body.ok, true)

    const grant = await request(port, '/api/tracking/SHP-PROOF-1', {}, { token: dispatch })
    assert.equal(grant.status, 200)
    assert.ok(grant.body.token)

    // GPS entry and exit are the real ELD path, not simulator-only helpers.
    await request(port, '/api/integrations/eld/webhook', {
      driverId: 'D-101', truckId: 'GLD-101', timestamp: now + 60 * MIN,
      latitude: 43.4731, longitude: -79.9772, speedKph: 0, odometerKm: 100_140,
    }, { integrationKey: INTEGRATION_KEY })
    await request(port, '/api/integrations/eld/webhook', {
      driverId: 'D-101', truckId: 'GLD-101', timestamp: now + 210 * MIN,
      latitude: 43.60, longitude: -79.70, speedKph: 75, odometerKm: 100_142,
    }, { integrationKey: INTEGRATION_KEY })

    let events = await app.store.all()
    const claim = events.find((e) => e.type === 'detention.calculated' && e.shipmentId === 'SHP-PROOF-1')
    assert.ok(claim, 'GPS dwell created a detention calculation')
    assert.equal(Math.round(claim.billableMinutes), 30)
    assert.equal(claim.amount, 37.5)
    assert.ok(events.some((e) => e.type === 'stop.arrived' && e.source === 'eld-geofence'))
    assert.ok(events.some((e) => e.type === 'stop.departed' && e.source === 'eld-geofence'))

    const review = await request(port, '/api/commands', {
      type: 'reviewDetention', claimId: claim.claimId,
      shipmentId: claim.shipmentId, stopId: claim.stopId, now: now + 211 * MIN,
    }, { token: dispatch })
    assert.equal(review.body.state, 'reviewed')

    const billing = await request(port, '/api/integrations/billing/export', {}, { token: admin })
    assert.equal(billing.status, 200)
    assert.equal(billing.body.exported, 1)
    assert.match(billing.body.csv, /CLM-SHP-PROOF-1-milton-intermodal/)
    assert.match(billing.body.csv, /37\.5,CAD,exported/)

    const deniedConfig = await request(port, '/api/commands', {
      type: 'setSiteCapacity', siteId: 'onr-tilbury', spaces: 37,
    }, { token: dispatch })
    assert.equal(deniedConfig.status, 403)
    const config = await request(port, '/api/commands', {
      type: 'setSiteCapacity', siteId: 'onr-tilbury', spaces: 37,
    }, { token: admin })
    assert.equal(config.status, 201)

    const customerHistory = await get(port, '/api/events?since=0&limit=1000', grant.body.token)
    assert.equal(customerHistory.status, 200)
    assert.ok(customerHistory.body.events.some((e) => e.type === 'truck.ping' && e.truckId === 'GLD-101'))
    assert.ok(customerHistory.body.events.every((e) => e.shipmentId === 'SHP-PROOF-1'))

    await closeListening(app)
    app = await createServer({ dbPath, secret: SECRET, integrationKey: INTEGRATION_KEY, seed: [] })
    events = await app.store.all()
    const restored = app.loadBoard.allLoads().find((l) => l.id === 'L-PROOF-1')
    assert.equal(restored.status, 'assigned')
    assert.equal(restored.acceptedTruckId, 'GLD-101')
    assert.ok(events.some((e) => e.type === 'detention.exported' && e.claimId === claim.claimId))
    assert.equal(app.integrations.identityMap.resolve('shipment', 'order', 'PROOF-1'), 'SHP-PROOF-1')
    assert.equal(SITE_BY_ID['onr-tilbury'].spaces, 37, 'durable configuration replayed')
    await app.commandProcessor.handle({ type: 'resetSiteCapacities' }, { role: 'admin', email: 'cleanup@local' })
    assert.equal(SITE_BY_ID['onr-tilbury'].spaces, BASE_SITE_CAPACITIES['onr-tilbury'])
    await app.close()
    app = null
  })
})

function listen(server) {
  if (server.listening) return Promise.resolve(server.address().port)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(port, path, body, { token, integrationKey } = {}) {
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (integrationKey) headers['X-Integration-Key'] = integrationKey
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function readSseUntilCaughtUp(port, token) {
  return new Promise((resolve, reject) => {
    const frames = []
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('SSE replay timed out')), 10_000)
    const req = http.get({
      hostname: '127.0.0.1', port,
      path: `/api/stream?since=0&client=boundary-proof&token=${encodeURIComponent(token)}`,
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE returned ${res.statusCode}`))
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buffer += chunk
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const line = frame.split('\n').find((item) => item.startsWith('data: '))
          if (!line) continue
          const event = JSON.parse(line.slice(6))
          frames.push(event)
          if (event.type === 'caught-up') {
            clearTimeout(timer)
            req.destroy()
            resolve(frames)
            return
          }
        }
      })
    })
    req.on('error', (error) => {
      clearTimeout(timer)
      if (!frames.some((e) => e.type === 'caught-up')) reject(error)
    })
  })
}

async function closeListening(app) {
  await new Promise((resolve) => app.server.close(resolve))
  await app.store.close()
}
