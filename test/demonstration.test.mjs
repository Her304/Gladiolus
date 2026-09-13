/**
 * Phase 2 demonstration tests — the end-to-end detention workflow.
 *
 * Drives runDemonstrationShipment through the shipment projection and the
 * detention ledger, covering the acceptance gate: a qualifying visit produces
 * the contract-correct charge, the record survives replay, and the evidence
 * package is exportable.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { runDemonstrationShipment, emitVisit, VISIT_SCENARIOS } from '../src/engine/visit-sim.js'
import { createShipment, projectShipment } from '../src/domain/shipment.js'
import { DEFAULT_DETENTION_RULE, EVENT } from '../src/domain/contract.js'

const T0 = Date.UTC(2026, 8, 13, 13, 0, 0)
const MIN = 60_000

describe('demonstration shipment — end-to-end detention', () => {
  test('dwell-150 scenario → 30 billable min, eligible claim, exportable', () => {
    const { events, shipmentId, stopId, rule } = runDemonstrationShipment({ scenario: 'dwell-150', t0: T0 })
    const ship = createShipment({
      id: shipmentId, kind: 'ftl',
      stops: [{ id: 'STP-pu', role: 'pickup', facilityId: 'milton' }, { id: stopId, role: 'delivery', facilityId: 'london-dc' }],
    })
    const proj = projectShipment(events, ship, rule)
    assert.equal(proj.status, 'completed')
    // Service completed (or departed, which advances past it) — delivery is
    // confirmed, never merely "arrived".
    assert.ok(['service_completed', 'departed'].includes(proj.stops[1].milestone),
      `expected service_completed/departed, got ${proj.stops[1].milestone}`)
    assert.equal(proj.ledger.length, 1)
    const entry = proj.ledger[0]
    assert.equal(Math.round(entry.billableMinutes), 30)
    assert.equal(entry.state, 'eligible')
    // Exportable evidence package
    assert.ok(entry.arrived && entry.serviceComplete && entry.freeStart && entry.chargeEnd)
    assert.equal(entry.ruleId, rule.id)
    assert.equal(entry.currency, 'CAD')
  })

  test('dwell-119 scenario → 0 billable', () => {
    const { events, shipmentId, stopId, rule } = runDemonstrationShipment({ scenario: 'dwell-119', t0: T0 })
    const ship = createShipment({
      id: shipmentId, kind: 'ftl',
      stops: [{ id: 'STP-pu', role: 'pickup', facilityId: 'milton' }, { id: stopId, role: 'delivery', facilityId: 'london-dc' }],
    })
    const proj = projectShipment(events, ship, rule)
    assert.equal(proj.ledger[0].billableMinutes, 0)
  })

  test('normal scenario → 0 billable, completed shipment', () => {
    const { events, shipmentId, stopId, rule } = runDemonstrationShipment({ scenario: 'normal', t0: T0 })
    const ship = createShipment({
      id: shipmentId, kind: 'ftl',
      stops: [{ id: 'STP-pu', role: 'pickup', facilityId: 'milton' }, { id: stopId, role: 'delivery', facilityId: 'london-dc' }],
    })
    const proj = projectShipment(events, ship, rule)
    assert.equal(proj.ledger[0].billableMinutes, 0)
  })

  test('milestones are emitted independently (arrival ≠ delivery)', () => {
    const events = emitVisit('normal', { shipmentId: 'S', stopId: 'STP', truckId: 'T', t0: T0, facilityId: 'F' })
    const types = events.map((e) => e.type)
    assert.deepEqual(types, [
      EVENT.STOP_ARRIVED, EVENT.STOP_CHECKED_IN, EVENT.STOP_SERVICE_STARTED,
      EVENT.STOP_SERVICE_COMPLETED, EVENT.STOP_DEPARTED,
    ])
    // Delivery is service completion, NOT fence entry. No 'load.delivered'.
    assert.ok(!types.includes('load.delivered'))
  })

  test('the demonstration survives replay — projection is deterministic', () => {
    const { events, shipmentId, stopId, rule } = runDemonstrationShipment({ scenario: 'dwell-150', t0: T0 })
    const build = () => projectShipment(events, createShipment({
      id: shipmentId, kind: 'ftl',
      stops: [{ id: 'STP-pu', role: 'pickup', facilityId: 'milton' }, { id: stopId, role: 'delivery', facilityId: 'london-dc' }],
    }), rule)
    const p1 = build()
    const p2 = build()
    assert.equal(p1.ledger[0].billableMinutes, p2.ledger[0].billableMinutes)
    assert.equal(p1.stops[1].milestone, p2.stops[1].milestone)
    assert.equal(p1.timeline.length, p2.timeline.length)
  })

  test('every visit scenario is defined and emits arrival + service completion', () => {
    for (const key of Object.keys(VISIT_SCENARIOS)) {
      const events = emitVisit(key, { shipmentId: 'S', stopId: 'STP', truckId: 'T', t0: T0, facilityId: 'F' })
      assert.ok(events.some((e) => e.type === EVENT.STOP_ARRIVED), `${key} has arrival`)
      assert.ok(events.some((e) => e.type === EVENT.STOP_SERVICE_COMPLETED), `${key} has service completion`)
    }
  })
})
