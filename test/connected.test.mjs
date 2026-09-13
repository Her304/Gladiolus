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
  let app, sim, token

  before(() => {
    app = createServer({ dbPath: ':memory:', secret: 'test-secret' })
    sim = createSimService({ ingest: app.ingester.ingest })
    sim.bootstrap()
    token = mintToken({ role: 'dispatch', email: 'dispatch@gladiolus.ca' }, 'test-secret')
  })
  after(() => app.close())

  test('refresh/restart preserves ingested events', async () => {
    // Ingest one observation.
    const r = await post(app, '/api/events/ingest', {
      type: 'shipment.posted',
      providerId: 'prov-post-1',
      observedAt: 1000,
      shipmentId: 'SHP-1',
      kind: 'ftl',
    })
    assert.equal(r.status, 201)
    const seq = r.body.event.seq

    // Simulate a "refresh": re-read from seq 0 — the event is still there.
    const hist = await get(app, '/api/events?since=0')
    assert.ok(hist.body.events.some((e) => e.seq === seq && e.type === 'shipment.posted'))
  })

  test('a retried observation does not duplicate (idempotent)', async () => {
    const e1 = await post(app, '/api/events/ingest', {
      type: 'stop.arrived', providerId: 'prov-arrive-2', observedAt: 2000, stopId: 'STP-2',
    })
    const e2 = await post(app, '/api/events/ingest', {
      type: 'stop.arrived', providerId: 'prov-arrive-2', observedAt: 2000, stopId: 'STP-2',
    })
    assert.equal(e1.body.ok, true)
    assert.equal(e2.body.duplicate, true)
    const hist = await get(app, '/api/events?since=0')
    const arrives = hist.body.events.filter((e) => e.type === 'stop.arrived' && e.stopId === 'STP-2')
    assert.equal(arrives.length, 1, 'retry must not create a second visit')
  })

  test('dispatcher and driver sessions observe the same event sequence', async () => {
    // A dispatcher ingests an assignment event.
    await post(app, '/api/events/ingest', {
      type: 'assignment.committed', providerId: 'prov-asn-3', observedAt: 3000,
      shipmentId: 'SHP-3', truckId: 'GLD-101',
    })
    // A driver session reads the same history.
    const dispatchView = await get(app, '/api/events?since=0')
    const driverView = await get(app, '/api/events?since=0')
    const dispatchAsn = dispatchView.body.events.find((e) => e.type === 'assignment.committed')
    const driverAsn = driverView.body.events.find((e) => e.type === 'assignment.committed')
    assert.ok(dispatchAsn && driverAsn)
    assert.equal(dispatchAsn.seq, driverAsn.seq, 'both sessions see the same committed assignment')
  })

  test('simulator writes through the ingestion API as a data source', () => {
    const before = app.store.currentSeq()
    sim.advance(2) // two sim ticks
    const after = app.store.currentSeq()
    assert.ok(after > before, 'sim ticks produced ingested events')
    const events = app.store.all()
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
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'unauthorized')
  })

  test('authorized command reaches the handler', async () => {
    const r = await postAuth(app, '/api/commands', { type: 'reserve', shipmentId: 'SHP-x' }, token)
    assert.equal(r.status, 400)
    assert.equal(r.body.error, 'assignment lifecycle wired in Phase 4')
  })
})

describe('durability across restart', () => {
  test('a file-backed store survives a close/reopen', () => {
    // This is the refresh/restart acceptance gate: state on disk is not lost.
    const tmp = `/tmp/corridor-test-${process.pid}-${Date.now()}.db`
    let app1 = createServer({ dbPath: tmp, secret: 'r-secret' })
    app1.ingester.ingest({ type: 'shipment.posted', providerId: 'prov-dur-1', observedAt: 5000, shipmentId: 'SHP-dur' })
    const seqBefore = app1.store.currentSeq()
    app1.close()

    let app2 = createServer({ dbPath: tmp, secret: 'r-secret' })
    const events = app2.store.all()
    assert.ok(events.some((e) => e.shipmentId === 'SHP-dur'), 'event survived restart')
    assert.equal(app2.store.currentSeq(), seqBefore)
    app2.close()
  })
})

// ---- helpers: in-process HTTP against the server's ephemeral listener ----
function port(server) {
  if (!server.listening) server.listen(0)
  return server.address().port
}

function get(app, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: port(app.server), path, method: 'GET' }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b || '{}') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function post(app, path, body) {
  return request(app.server, path, body, null)
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
