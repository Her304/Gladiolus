/**
 * Phase F tests — integration adapters (ELD, orders, billing).
 *
 * Exercises the webhook paths end-to-end: an ELD duty/position observation
 * becomes a duty.updated + truck.ping event; an order webhook posts a load;
 * the billing export emits detention.exported for reviewed claims. All through
 * the idempotent ingestion boundary.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createServer, mintToken } from '../server/app.js'

const INTEGRATION_KEY = 'test-integration-key'

function port(server) { if (!server.listening) server.listen(0); return server.address().port }
function post(server, path, body, token, integrationKey = INTEGRATION_KEY) {
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (integrationKey) headers['X-Integration-Key'] = integrationKey
    const req = http.request({ port: port(server), path, method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}

describe('Phase F — ELD adapter', () => {
  let app, token
  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'f-secret', integrationKey: INTEGRATION_KEY })
    token = mintToken({ role: 'dispatch', email: 'd@g.ca' }, 'f-secret')
  })
  after(async () => { await app.close() })

  test('an unauthenticated ELD webhook is rejected', async () => {
    const r = await post(app.server, '/api/integrations/eld/webhook', {
      truckId: 'GLD-101', timestamp: 1699999999000, latitude: 43.5, longitude: -79.9,
    }, null, null)
    assert.equal(r.status, 401)
  })

  test('an ELD duty observation ingests a duty.updated event', async () => {
    const r = await post(app.server, '/api/integrations/eld/webhook', {
      eldDriverId: 'ELD-445566', driverId: 'D-101', truckId: 'GLD-101',
      timestamp: 1700000000000, dutyStatus: 'driving',
      drivingMs: 5 * 3600_000, onDutyMs: 6 * 3600_000,
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const events = await app.store.all()
    assert.ok(events.some((e) => e.type === 'duty.updated' && e.driverId === 'D-101'), 'duty.updated emitted')
  })

  test('an ELD position ping carries shipmentId for customer scoping', async () => {
    await post(app.server, '/api/integrations/eld/webhook', {
      truckId: 'GLD-101', shipmentId: 'SHP-9001',
      timestamp: 1700000001000, latitude: 43.5, longitude: -79.9, speedKph: 90,
    })
    const events = await app.store.all()
    const ping = events.find((e) => e.type === 'truck.ping' && e.truckId === 'GLD-101')
    assert.ok(ping, 'truck.ping emitted')
    assert.equal(ping.shipmentId, 'SHP-9001', 'ping carries shipmentId')
  })

  test('a retried ELD observation is deduped (idempotent)', async () => {
    const obs = { truckId: 'GLD-102', timestamp: 1700000002000, latitude: 43.6, longitude: -79.8, speedKph: 85 }
    await post(app.server, '/api/integrations/eld/webhook', obs)
    await post(app.server, '/api/integrations/eld/webhook', obs)
    const events = await app.store.all()
    const pings = events.filter((e) => e.type === 'truck.ping' && e.truckId === 'GLD-102')
    assert.equal(pings.length, 1, 'retry did not create a second ping')
  })
})

describe('Phase F — orders adapter', () => {
  let app
  before(async () => { app = await createServer({ dbPath: ':memory:', secret: 'f-secret', integrationKey: INTEGRATION_KEY }) })
  after(async () => { await app.close() })

  test('an unauthenticated order webhook is rejected', async () => {
    const r = await post(app.server, '/api/integrations/orders/webhook', {
      externalId: 'ORD-NOAUTH', originId: 'milton', destinationId: 'london',
    }, null, null)
    assert.equal(r.status, 401)
  })

  test('an order webhook posts a load + shipment.posted event', async () => {
    const r = await post(app.server, '/api/integrations/orders/webhook', {
      externalId: 'ORD-77', originId: 'milton', destinationId: 'london',
      revenue: 1200, equipment: ['dry-van'],
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    const events = await app.store.all()
    assert.ok(events.some((e) => e.type === 'shipment.posted'), 'shipment.posted emitted')
  })
})

describe('Phase F — billing export', () => {
  let app, adminToken
  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'f-secret', integrationKey: INTEGRATION_KEY })
    adminToken = mintToken({ role: 'admin', email: 'a@g.ca' }, 'f-secret')
  })
  after(async () => { await app.close() })

  test('billing export is admin-only', async () => {
    const dispatchToken = mintToken({ role: 'dispatch', email: 'd@g.ca' }, 'f-secret')
    const r = await post(app.server, '/api/integrations/billing/export', {}, dispatchToken)
    assert.equal(r.status, 403)
  })

  test('an admin can export reviewed claims', async () => {
    // Trusted adapter-side setup: raw public ingestion does not accept
    // business-state or review events.
    await app.ingester.ingest({
      type: 'detention.calculated', providerId: 'dc-1', observedAt: 1,
      claimId: 'CLM-1', shipmentId: 'SHP-1', stopId: 'STP-1', billableMinutes: 30, amount: 37.5, currency: 'CAD',
    })
    await app.ingester.ingest({
      type: 'detention.reviewed', providerId: 'dr-1', observedAt: 2,
      claimId: 'CLM-1', shipmentId: 'SHP-1', stopId: 'STP-1', actor: 'billing',
    })
    const r = await post(app.server, '/api/integrations/billing/export', {}, adminToken)
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.exported >= 1, 'at least one claim exported')
    assert.ok(r.body.csv.includes('CLM-1'), 'CSV contains the claim')
    const events = await app.store.all()
    assert.ok(events.some((e) => e.type === 'detention.exported' && e.claimId === 'CLM-1'), 'detention.exported emitted')
  })
})

describe('Phase F — integrations health', () => {
  let app, token
  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'f-secret', integrationKey: INTEGRATION_KEY })
    token = mintToken({ role: 'admin', email: 'a@g.ca' }, 'f-secret')
  })
  after(async () => { await app.close() })

  test('GET /api/integrations/health reports all adapters', async () => {
    // Post something so the health isn't empty.
    await post(app.server, '/api/integrations/orders/webhook', { externalId: 'ORD-1', originId: 'a', destinationId: 'b' })
    const http = (await import('node:http')).default
    const r = await new Promise((res) => {
      const req = http.request({ port: port(app.server), path: '/api/integrations/health', method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (rr) => {
        let b = ''; rr.on('data', (c) => (b += c)); rr.on('end', () => res(JSON.parse(b || '{}')))
      })
      req.end()
    })
    assert.equal(r.ok, true)
    assert.ok(r.eld && r.orders && r.billing, 'all three adapters reported')
  })
})
