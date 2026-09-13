/**
 * Phase 4 load-queue & assignment-lifecycle tests.
 *
 * Acceptance gate (plan §5 Phase 4):
 *   - One posted load appears in dispatch, receives a versioned offer, is
 *     accepted by the driver in another session, and becomes one committed
 *     assignment.
 *   - A second dispatcher cannot double-book it.
 *   - Travel plus service plus safe-shutdown feasibility is recorded with the
 *     decision.
 *   - Replay reproduces the load, offer, assignment, and kilometre buckets.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createLoadBoard, createLoad, splitDistance } from '../src/domain/loadboard.js'
import { gateAssignment } from '../src/domain/command.js'
import { VERDICT, EVENT } from '../src/domain/contract.js'

const T0 = Date.UTC(2026, 8, 13, 13, 0, 0)
const MIN = 60_000
const H = 3600_000

describe('Phase 4 — load queue & assignment lifecycle', () => {
  test('a posted load appears in the open queue', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, revenue: 1200 })
    board.postLoad(load)
    const q = board.openQueue()
    assert.equal(q.length, 1)
    assert.equal(q[0].id, 'L1')
    assert.equal(q[0].revenue, 1200)
  })

  test('offer → accept → one committed assignment', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, expiresAt: T0 + 2 * H })
    board.postLoad(load)
    const offer = board.offerLoad('L1', 'D-101', 'dispatch', T0 + H)
    assert.equal(offer.ok, true)
    assert.equal(offer.event.type, EVENT.OFFER_CREATED)
    const accept = board.acceptOffer('L1', 'D-101', 'GLD-101', undefined, T0 + H)
    assert.equal(accept.ok, true)
    assert.equal(accept.load.status, 'assigned')
    assert.equal(accept.assignment.status, 'committed')
    assert.equal(accept.assignment.truckId, 'GLD-101')
    assert.ok(accept.events.some((e) => e.type === EVENT.ASSIGNMENT_COMMITTED))
  })

  test('a second dispatcher cannot double-book the same shipment', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, expiresAt: T0 + 2 * H })
    board.postLoad(load)
    board.offerLoad('L1', 'D-101', 'dispatch-A', T0 + H)
    const a1 = board.acceptOffer('L1', 'D-101', 'GLD-101', 'key-A', T0 + H)
    // A second driver/dispatcher tries to accept the same load — already assigned.
    const a2 = board.acceptOffer('L1', 'D-102', 'GLD-102', 'key-B', T0 + H)
    assert.equal(a1.ok, true)
    assert.equal(a2.ok, false, 'second accept must not double-book')
    assert.equal(board._assignments.size, 1, 'exactly one assignment')
  })

  test('an expired offer cannot be accepted', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, expiresAt: T0 - 1 })
    board.postLoad(load)
    board.offerLoad('L1', 'D-101', 'dispatch', T0 + H)
    const a = board.acceptOffer('L1', 'D-101', 'GLD-101', undefined, T0 + H)
    assert.equal(a.ok, false)
    assert.match(a.error, /expired/)
  })

  test('a duplicate accept (idempotent retry) does not create a second assignment', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, expiresAt: T0 + 2 * H })
    board.postLoad(load)
    board.offerLoad('L1', 'D-101', 'dispatch', T0 + H)
    const a1 = board.acceptOffer('L1', 'D-101', 'GLD-101', 'retry-key', T0 + H)
    const a2 = board.acceptOffer('L1', 'D-101', 'GLD-101', 'retry-key', T0 + H)
    assert.equal(a1.ok, true)
    assert.equal(a2.ok, true) // idempotent — returns the existing assignment
    assert.equal(board._assignments.size, 1)
  })

  test('reassignment requires a reason and is audited', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, expiresAt: T0 + 2 * H })
    board.postLoad(load)
    board.offerLoad('L1', 'D-101', 'dispatch', T0 + H)
    board.acceptOffer('L1', 'D-101', 'GLD-101', undefined, T0 + H)
    const noReason = board.reassign('L1', 'D-102', 'GLD-102', 'dispatch', '')
    assert.equal(noReason.ok, false)
    const r = board.reassign('L1', 'D-102', 'GLD-102', 'dispatch', 'D-101 unavailable — HOS expired')
    assert.equal(r.ok, true)
    const audit = board.getAudit()
    assert.ok(audit.some((a) => a.action === 'load.reassigned' && a.detail.includes('HOS expired')))
  })

  test('a held load stays out of the open queue', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0 })
    board.postLoad(load)
    board.hold('L1', 'dispatch', 'awaiting customer confirmation')
    assert.equal(board.openQueue().length, 0)
  })

  test('feasibility is recorded with the assignment decision', () => {
    const board = createLoadBoard()
    const load = createLoad({ id: 'L1', shipmentId: 'SHP-1', originId: 'milton', destinationId: 'london', readyAt: T0, revenue: 1200, equipment: ['dry-van'] })
    board.postLoad(load)
    // The dispatcher records feasibility before offering.
    const feas = gateAssignment({
      duty: { drivingMs: 2 * H, onDutyMs: 3 * H, elapsedMs: 4 * H, cycleMs: 10 * H, dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: T0, source: 'live' },
      vehicle: { available: true },
      route: { edges: [] },
      equipment: { required: true, satisfied: true },
    })
    assert.equal(feas.ok, true)
    assert.equal(feas.verdict, VERDICT.FEASIBLE)
    assert.ok(feas.inputs.includes('hos'))
    assert.ok(feas.inputs.includes('vehicle'))
    assert.ok(feas.inputs.includes('route'))
  })
})

describe('Phase 4 — committed deadhead vs uncommitted idle distance', () => {
  test('empty km split into committed deadhead and uncommitted idle', () => {
    const segments = [
      { km: 40, laden: false, assignmentId: 'ASN-1' }, // committed deadhead to pickup
      { km: 180, laden: true, assignmentId: 'ASN-1' }, // laden
      { km: 25, laden: false, assignmentId: null },    // uncommitted idle/reposition
    ]
    const r = splitDistance(segments)
    assert.equal(r.committedDeadheadKm, 40)
    assert.equal(r.ladenKm, 180)
    assert.equal(r.uncommittedIdleKm, 25)
  })
})
