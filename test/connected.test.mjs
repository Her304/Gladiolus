/**
 * Phase 1 connected-scenario tests — the durable shared runtime.
 *
 * Acceptance gate (plan §5 Phase 1):
 *   - A dispatcher and driver in different sessions see the same assignment/exception.
 *   - Refresh/restart preserves shipments, visits, claims, config, audit.
 *   - Retried and out-of-order observations do not duplicate or regress state.
 *   - Two clients racing to reserve one shipment produce one winner + one conflict.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createServer, mintToken } from '../server/app.js'
import { createSimService } from '../server/sim-service.js'

const MIN = 60_000

describe('durable shared runtime — Phase 1 acceptance', () => {
  let app, sim, token, driverToken, integrationToken

  before(async () => {
    app = await createServer({ dbPath: ':memory:', secret: 'test-secret' })
    sim = createSimService({ ingest: app.ingester.ingest })
    sim.bootstrap()
    token = mintToken({ role: 'dispatch', email: 'dispatch@gladiolus.ca' }, 'test-secret')
    driverToken = mintToken({ role: 'driver', email: 'gld-101@carrier.local', driverId: 'D-101', truckId: 'GLD-101' }, 'test-secret')
    integrationToken = mintToken({ role: 'integration', email: 'eld@carrier.local' }, 'test-secret')
  })
  after(async () => { await app.close() })

  test('refresh/restart preserves ingested events', async () => {
    // Ingest one observation.
    const r = await post(app, '/api/events/ingest', {
      type: 'stop.arrived',
      providerId: 'prov-post-1',
      observedAt: 1000,
      shipmentId: 'SHP-1', stopId: 'STP-1',
    }, integrationToken)
    assert.equal(r.status, 201)
    const seq = r.body.event.seq

    // Simulate a "refresh": re-read from seq 0 — the event is still there.
    const hist = await get(app, '/api/events?since=0', token)
    assert.ok(hist.body.events.some((e) => e.seq === seq && e.type === 'stop.arrived'))
  })

  test('a retried observation does not duplicate (idempotent)', async () => {
    const e1 = await post(app, '/api/events/ingest', {
      type: 'stop.arrived', providerId: 'prov-arrive-2', observedAt: 2000, stopId: 'STP-2',
    }, integrationToken)
    const e2 = await post(app, '/api/events/ingest', {
      type: 'stop.arrived', providerId: 'prov-arrive-2', observedAt: 2000, stopId: 'STP-2',
    }, integrationToken)
    assert.equal(e1.body.ok, true)
    assert.equal(e2.body.duplicate, true)
    const hist = await get(app, '/api/events?since=0', token)
    const arrives = hist.body.events.filter((e) => e.type === 'stop.arrived' && e.stopId === 'STP-2')
    assert.equal(arrives.length, 1, 'retry must not create a second visit')
  })

  test('dispatcher and driver sessions observe the same event sequence', async () => {
    // A trusted command-side append creates an assignment event.
    await app.store.append({
      type: 'assignment.committed', providerId: 'prov-asn-3', observedAt: 3000,
      shipmentId: 'SHP-3', truckId: 'GLD-101', driverId: 'D-101',
    })
    // A driver session reads the same history.
    const dispatchView = await get(app, '/api/events?since=0', token)
    const driverView = await get(app, '/api/events?since=0', driverToken)
    const dispatchAsn = dispatchView.body.events.find((e) => e.type === 'assignment.committed')
    const driverAsn = driverView.body.events.find((e) => e.type === 'assignment.committed')
    assert.ok(dispatchAsn && driverAsn)
    assert.equal(dispatchAsn.seq, driverAsn.seq, 'both sessions see the same committed assignment')
  })

  test('simulator writes through the ingestion API as a data source', async () => {
    const before = app.store.currentSeq()
    sim.advance(2) // two sim ticks
    const after = app.store.currentSeq()
    assert.ok(after > before, 'sim ticks produced ingested events')
    const events = await app.store.all()
    // The simulator's pings/fences arrive with simulated provenance.
    assert.ok(events.some((e) => e.source === 'simulated'), 'sim observations carry simulated provenance')
  })

  test('health reports freshness and data age', async () => {
    const h = await get(app, '/api/health')
    assert.equal(h.body.ok, true)
    assert.equal(h.body.schemaVersion, 2)
    assert.equal(typeof h.body.lastSeq, 'number')
    assert.ok(h.body.lastIngestAt > 0)
  })

  test('unauthorized command is rejected', async () => {
    const r = await post(app, '/api/commands', { type: 'reserve', shipmentId: 'SHP-x' })
    assert.equal(r.status, 401)
    assert.equal(r.body.error, 'unauthorized')
  })

  test('an authorized command routes to the domain (postLoad)', async () => {
    const r = await postAuth(app, '/api/commands', {
      type: 'postLoad',
      load: { id: 'L-TEST', shipmentId: 'SHP-TEST', originId: 'milton', destinationId: 'london', revenue: 1000 },
    }, token)
    assert.equal(r.status, 201)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.load.id, 'L-TEST')
    // The shipment.posted event was emitted to the store.
    const events = await app.store.all()
    assert.ok(events.some((e) => e.type === 'shipment.posted' && e.shipmentId === 'SHP-TEST'))
  })
})

describe('durability across restart', () => {
  test('a file-backed store survives a close/reopen', async () => {
    // This is the refresh/restart acceptance gate: state on disk is not lost.
    const tmp = `/tmp/corridor-test-${process.pid}-${Date.now()}.db`
    let app1 = await createServer({ dbPath: tmp, secret: 'r-secret' })
    await app1.ingester.ingest({ type: 'shipment.posted', providerId: 'prov-dur-1', observedAt: 5000, shipmentId: 'SHP-dur' })
    const seqBefore = app1.store.currentSeq()
    await app1.close()

    let app2 = await createServer({ dbPath: tmp, secret: 'r-secret' })
    const events = await app2.store.all()
    assert.ok(events.some((e) => e.shipmentId === 'SHP-dur'), 'event survived restart')
    assert.equal(app2.store.currentSeq(), seqBefore)
    await app2.close()
  })
})

// ---- helpers: in-process HTTP against the server's ephemeral listener ----
function port(server) {
  if (!server.listening) server.listen(0)
  return server.address().port
}

function get(app, path, token) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request({ port: port(app.server), path, method: 'GET', headers }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function post(app, path, body, token) {
  return request(app.server, path, body, token)
}
function postAuth(app, path, body, token) {
  return request(app.server, path, body, token)
}

function request(server, path, body, token) {
  const data = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    if (token) headers.Authorization = `Bearer ${token}`
    const req = http.request({ port: port(server), path, method: 'POST', headers }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}
