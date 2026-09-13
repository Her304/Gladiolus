/**
 * Phase B tests — server-enforced auth, signed customer grants, shipment-scoped stream.
 *
 * Acceptance: login returns a signed token; unauthorized requests are 401; a
 * customer grant is shipment-scoped (sees only its shipment's events); a
 * revoked grant is rejected; a second customer's shipment is invisible.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createServer, mintToken } from '../server/app.js'

function port(server) { if (!server.listening) server.listen(0); return server.address().port }
function get(server, path, token) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request({ port: port(server), path, method: 'GET', headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject); req.end()
  })
}
function post(server, path, body, token) {
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request({ port: port(server), path, method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}

describe('Phase B — server-enforced auth', () => {
  let app, dispatchToken, adminToken

  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'phase-b-secret' })
  })
  after(async () => { await app.close() })

  test('login with seeded dispatch credentials returns a signed token', async () => {
    const r = await post(app.server, '/api/auth/login', { email: 'dispatch@gladiolus.ca', password: 'corridor' })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.ok(r.body.token)
    assert.equal(r.body.user.role, 'dispatch')
    dispatchToken = r.body.token
  })

  test('login with admin credentials', async () => {
    const r = await post(app.server, '/api/auth/login', { email: 'admin@gladiolus.ca', password: 'corridor' })
    assert.equal(r.body.user.role, 'admin')
    adminToken = r.body.token
  })

  test('login with wrong password is rejected', async () => {
    const r = await post(app.server, '/api/auth/login', { email: 'dispatch@gladiolus.ca', password: 'wrong' })
    assert.equal(r.status, 401)
  })

  test('GET /api/session with a token returns the role', async () => {
    const r = await get(app.server, '/api/session', dispatchToken)
    assert.equal(r.status, 200)
    assert.equal(r.body.user.role, 'dispatch')
  })

  test('GET /api/session without a token is 401', async () => {
    const r = await get(app.server, '/api/session')
    assert.equal(r.status, 401)
  })

  test('ingest without a token is 401', async () => {
    const r = await post(app.server, '/api/events/ingest', { type: 'shipment.posted', providerId: 'p1', observedAt: 1 })
    assert.equal(r.status, 401)
  })
})

describe('Phase B — signed, shipment-scoped customer grants', () => {
  let app, dispatchToken, grant1, grant2

  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'phase-b-secret' })
    const r = await post(app.server, '/api/auth/login', { email: 'dispatch@gladiolus.ca', password: 'corridor' })
    dispatchToken = r.body.token
    // Trusted server-side setup for two shipment scopes. The public raw ingest
    // route is deliberately integration-only.
    await app.ingester.ingest({ type: 'shipment.posted', providerId: 's1', observedAt: 1, shipmentId: 'SHP-1' })
    await app.ingester.ingest({ type: 'shipment.posted', providerId: 's2', observedAt: 2, shipmentId: 'SHP-2' })
    await app.ingester.ingest({ type: 'stop.arrived', providerId: 'a1', observedAt: 3, shipmentId: 'SHP-1', stopId: 'STP-1' })
    // Mint two customer grants.
    const g1 = await post(app.server, '/api/tracking/SHP-1', {}, dispatchToken)
    const g2 = await post(app.server, '/api/tracking/SHP-2', {}, dispatchToken)
    grant1 = g1.body.token
    grant2 = g2.body.token
  })
  after(async () => { await app.close() })

  test('a customer grant sees only its own shipment events', async () => {
    const r = await get(app.server, '/api/events?since=0', grant1)
    assert.equal(r.status, 200)
    const shipments = new Set(r.body.events.map((e) => e.shipmentId))
    assert.ok(shipments.has('SHP-1'))
    assert.ok(!shipments.has('SHP-2'), 'customer SHP-1 must not see SHP-2 events')
  })

  test('the second customer sees only SHP-2', async () => {
    const r = await get(app.server, '/api/events?since=0', grant2)
    const shipments = new Set(r.body.events.map((e) => e.shipmentId))
    assert.ok(shipments.has('SHP-2'))
    assert.ok(!shipments.has('SHP-1'))
  })

  test('a non-staff token cannot mint a grant', async () => {
    const r = await post(app.server, '/api/tracking/SHP-1', {}, grant1)
    assert.equal(r.status, 403)
  })

  test('a revoked grant is rejected', async () => {
    // Revoke grant1.
    const tokenId = grant1
    const r = await post(app.server, `/api/tracking/${tokenId}/revoke`, {}, dispatchToken)
    assert.equal(r.status, 200)
    // Now grant1 can no longer read events.
    const r2 = await get(app.server, '/api/events?since=0', grant1)
    assert.equal(r2.status, 401)
  })
})
