/**
 * Phase 0 domain tests — the frozen contract and its corrected semantics.
 *
 * These prove the v2 contract behaves correctly (state machines, detention,
 * feasibility, idempotency, race). Run with `node --test`.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  SCHEMA_VERSION, EVENT, VERDICT, BLOCKER, HOS_LIMITS,
  SHIPMENT_TRANSITIONS, STOP_TRANSITIONS, ASSIGNMENT_TRANSITIONS,
  DETENTION_TRANSITIONS, EXCEPTION_TRANSITIONS,
  canTransition, assertTransition, observation, validateRecord, REQUIRED_FIELDS,
} from '../src/domain/contract.js'
import { calculateDetention, foldVisit, chargeableInterval } from '../src/domain/detention.js'
import {
  hosFeasibility, movementGuard, routeFeasibility, assignmentFeasibility, boundedReach,
} from '../src/domain/feasibility.js'
import { reserve, commit, runAssignmentRace } from '../src/domain/assignment.js'
import { createIngester, shouldApplyMilestone } from '../src/domain/ingestion.js'
import {
  normalDelivery, dwell119, dwell150, earlyArrival, waiver,
  duplicateEvent, delayedEvent, assignmentRace, missingHos, dockHosExpiry, closure, majorDefect,
  MILTON_LONDON, RULE,
} from '../src/domain/fixtures.js'

const MIN = 60_000
const H = 3600_000

describe('contract v2 — schema and provenance', () => {
  test('schema version is frozen at 2', () => {
    assert.equal(SCHEMA_VERSION, 2)
  })

  test('delivery is a distinct milestone, not fence entry', () => {
    assert.ok(EVENT.STOP_SERVICE_COMPLETED)
    assert.ok(EVENT.STOP_ARRIVED)
    assert.notEqual(EVENT.STOP_SERVICE_COMPLETED, EVENT.STOP_ARRIVED)
  })

  test('observation envelope carries full provenance', () => {
    const o = observation({ providerId: 'p1', observedAt: 1000, receivedAt: 2000, source: 'live' })
    assert.equal(o.providerId, 'p1')
    assert.equal(o.schemaVersion, 2)
    assert.equal(o.observedAt, 1000)
    assert.equal(o.receivedAt, 2000)
    assert.equal(o.source, 'live')
    assert.equal(o.idempotencyKey, 'p1')
  })

  test('observation rejects missing providerId and observedAt', () => {
    assert.throws(() => observation({ observedAt: 1 }), /providerId/)
    assert.throws(() => observation({ providerId: 'p' }), /observedAt/)
  })
})

describe('state machines — legal transitions', () => {
  test('shipment: posted→assigned→in_progress→completed', () => {
    assert.ok(canTransition(SHIPMENT_TRANSITIONS, 'posted', 'assigned'))
    assert.ok(canTransition(SHIPMENT_TRANSITIONS, 'assigned', 'in_progress'))
    assert.ok(canTransition(SHIPMENT_TRANSITIONS, 'in_progress', 'completed'))
    // cannot skip: posted→completed is illegal
    assert.ok(!canTransition(SHIPMENT_TRANSITIONS, 'posted', 'completed'))
  })

  test('stop milestones advance forward only', () => {
    assert.ok(canTransition(STOP_TRANSITIONS, 'none', 'arrived'))
    assert.ok(canTransition(STOP_TRANSITIONS, 'arrived', 'checked_in'))
    assert.ok(canTransition(STOP_TRANSITIONS, 'checked_in', 'service_started'))
    assert.ok(canTransition(STOP_TRANSITIONS, 'service_started', 'service_completed'))
    // cannot go backward: service_completed→arrived is illegal
    assert.ok(!canTransition(STOP_TRANSITIONS, 'service_completed', 'arrived'))
  })

  test('assignment: reserved→committed legal; double-commit illegal', () => {
    assert.ok(canTransition(ASSIGNMENT_TRANSITIONS, 'reserved', 'committed'))
    assert.ok(!canTransition(ASSIGNMENT_TRANSITIONS, 'committed', 'committed'))
  })

  test('detention review chain', () => {
    assert.ok(canTransition(DETENTION_TRANSITIONS, 'eligible', 'calculated'))
    assert.ok(canTransition(DETENTION_TRANSITIONS, 'calculated', 'reviewed'))
    assert.ok(canTransition(DETENTION_TRANSITIONS, 'reviewed', 'exported'))
    assert.ok(canTransition(DETENTION_TRANSITIONS, 'exported', 'reconciled'))
  })

  test('assertTransition returns explicit failure result', () => {
    const r = assertTransition(STOP_TRANSITIONS, 'service_completed', 'arrived')
    assert.equal(r.ok, false)
    assert.match(r.reason, /illegal transition/)
  })

  test('validateRecord enforces required fields per kind', () => {
    assert.ok(validateRecord('Shipment', { id: 'S1', kind: 'ftl', status: 'posted', stops: ['a', 'b'] }).ok)
    const bad = validateRecord('Shipment', { id: 'S1', status: 'posted' })
    assert.equal(bad.ok, false)
    assert.ok(bad.missing.includes('kind'))
    assert.ok(bad.missing.includes('stops'))
    // every required-fields entry is a non-empty array
    for (const [kind, fields] of Object.entries(REQUIRED_FIELDS)) {
      assert.ok(Array.isArray(fields) && fields.length > 0, `${kind} has required fields`)
    }
  })
})

describe('detention calculation — the worked cases', () => {
  test('119-min qualifying visit → 0 billable minutes', () => {
    const f = dwell119()
    const visit = foldVisit(f.events)
    const result = calculateDetention(visit, RULE)
    assert.equal(result.billableMinutes, 0)
  })

  test('150-min qualifying visit → 30 billable minutes before rounding', () => {
    const f = dwell150()
    const visit = foldVisit(f.events)
    const result = calculateDetention(visit, RULE)
    assert.equal(Math.round(result.billableMinutes), 30)
  })

  test('normal delivery within free time → 0 billable', () => {
    const f = normalDelivery()
    const visit = foldVisit(f.events)
    const result = calculateDetention(visit, RULE)
    assert.equal(result.billableMinutes, 0)
  })

  test('early arrival: free time starts at appointment, not arrival', () => {
    const f = earlyArrival()
    const visit = { ...foldVisit(f.events), appointment: f.events[0].at + 60 * MIN }
    const result = calculateDetention(visit, RULE)
    assert.equal(result.billableMinutes, 0)
  })

  test('parking/rest visit is excluded from automatic charging', () => {
    const visit = { arrived: 0, serviceComplete: 5 * H, kind: 'parking' }
    const result = calculateDetention(visit, RULE)
    assert.equal(result.billableMinutes, 0)
    assert.equal(result.excluded, true)
  })
})

describe('HOS feasibility — unknown is not safe', () => {
  test('missing HOS history → UNRESOLVED, never feasible', () => {
    const f = missingHos()
    const duty = { drivingMs: f.truck.drivingMs, onDutyMs: f.truck.onDutyMs, observedAt: f.clock, source: 'live' }
    const r = hosFeasibility(duty, {}, f.clock)
    assert.equal(r.verdict, VERDICT.UNRESOLVED)
    assert.ok(r.blockers.includes(BLOCKER.HOS_UNKNOWN))
  })

  test('fresh, complete HOS within limits → FEASIBLE', () => {
    const duty = {
      drivingMs: 5 * H, onDutyMs: 6 * H, elapsedMs: 7 * H, cycleMs: 20 * H,
      dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW, source: 'live',
    }
    const r = hosFeasibility(duty, { drivingMs: H, onDutyMs: H }, NOW)
    assert.equal(r.verdict, VERDICT.FEASIBLE)
  })

  test('elapsed exhaustion blocks even when driving hours remain', () => {
    const duty = {
      drivingMs: 5 * H, onDutyMs: 6 * H, elapsedMs: HOS_LIMITS.ELAPSED_WINDOW_MS, cycleMs: 20 * H,
      dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW, source: 'live',
    }
    const r = hosFeasibility(duty, {}, NOW)
    assert.equal(r.verdict, VERDICT.INFEASIBLE)
    assert.ok(r.blockers.includes(BLOCKER.HOS_ELAPSED))
  })

  test('cycle exhaustion blocks', () => {
    const duty = {
      drivingMs: 5 * H, onDutyMs: 6 * H, elapsedMs: 7 * H, cycleMs: 71 * H,
      dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW, source: 'live',
    }
    const r = hosFeasibility(duty, { onDutyMs: H }, NOW)
    assert.equal(r.verdict, VERDICT.INFEASIBLE)
    assert.ok(r.blockers.includes(BLOCKER.HOS_CYCLE))
  })

  test('stale HOS → UNRESOLVED', () => {
    const duty = {
      drivingMs: 5 * H, onDutyMs: 6 * H, elapsedMs: 7 * H, cycleMs: 20 * H,
      dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW - 60 * MIN, source: 'live',
    }
    const r = hosFeasibility(duty, {}, NOW)
    assert.equal(r.verdict, VERDICT.UNRESOLVED)
    assert.ok(r.blockers.includes(BLOCKER.HOS_STALE))
  })
})

describe('pre-movement safety gate', () => {
  test('dock HOS expiry blocks movement before it happens', () => {
    const f = dockHosExpiry()
    const truck = f.truck
    const r = movementGuard(truck, { available: true }, { impassable: false })
    // drivingMs and onDutyMs are within 5 min of limit at fixture time, then
    // duty is reported at the limit → movement must block.
    const truckAtLimit = { ...truck, drivingMs: HOS_LIMITS.DRIVING_MS, onDutyMs: HOS_LIMITS.ON_DUTY_MS }
    const r2 = movementGuard(truckAtLimit, { available: true }, { impassable: false })
    assert.equal(r2.blocked, true)
    assert.equal(f.expect.blocksMovement, true)
  })

  test('major defect blocks movement and assignment', () => {
    const f = majorDefect()
    const r = movementGuard(f.truck, { available: false, reason: BLOCKER.VEHICLE_DEFECT }, { impassable: false })
    assert.equal(r.blocked, true)
    assert.equal(r.reason, BLOCKER.VEHICLE_DEFECT)
  })

  test('unknown vehicle state is not safe', () => {
    const r = movementGuard({ drivingMs: 0, onDutyMs: 0 }, null, { impassable: false })
    assert.equal(r.blocked, true)
    assert.equal(r.reason, BLOCKER.VEHICLE_UNKNOWN)
  })
})

describe('route feasibility — closures', () => {
  test('full mainline closure makes route impassable', () => {
    const f = closure()
    const r = routeFeasibility(f.route)
    assert.equal(r.impassable, true)
  })

  test('ramp-only closure blocks only when planned access uses it', () => {
    const route = { edges: [{ closed: true, closureKind: 'ramp', rampUsedByPlan: false }] }
    assert.equal(routeFeasibility(route).impassable, false)
    const route2 = { edges: [{ closed: true, closureKind: 'ramp', rampUsedByPlan: true }] }
    assert.equal(routeFeasibility(route2).impassable, true)
  })
})

describe('bounded reach — no optimistic speed floor', () => {
  test('a 10km/h truck has proportional reach, not 40km/h floored', () => {
    // Full 13h driving left at 10km/h = 130km. The old code floored speed at
    // 40km/h, so a 10km/h truck got 520km. Here reach must track real speed.
    const duty = {
      drivingMs: 0, onDutyMs: 0, elapsedMs: 0, cycleMs: 0,
      dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW, source: 'live',
    }
    const r = boundedReach(duty, 10)
    assert.ok(r, 'expected a reach result')
    assert.ok(r.km < 200, `expected ~130km at 10km/h, got ${r.km}`)
    // contrast: a 40km/h truck reaches ~4x further
    const r40 = boundedReach(duty, 40)
    assert.ok(r40.km > r.km)
  })

  test('unknown HOS → no affirmative reach (null)', () => {
    assert.equal(boundedReach(null, 100), null)
    assert.equal(boundedReach({ drivingMs: undefined }, 100), null)
  })
})

describe('idempotent ingestion', () => {
  test('duplicate provider id does not create a second visit', async () => {
    const f = duplicateEvent()
    const log = []
    const ingester = createIngester((e) => { log.push(e); return e })
    const r1 = await ingester.ingest(f.events[0])
    const r2 = await ingester.ingest(f.events[1])
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, false)
    assert.equal(r2.duplicate, true)
    assert.equal(log.length, 1)
    assert.equal(f.expect.visitCount, 1)
  })

  test('late stale observation does not regress milestone', () => {
    const f = delayedEvent()
    // service_completed is current; a late 'arrived' must not apply
    assert.equal(shouldApplyMilestone('service_completed', { type: EVENT.STOP_ARRIVED }), false)
    assert.equal(f.expect.finalMilestone, 'service_completed')
  })

  test('forward milestone advances', () => {
    assert.equal(shouldApplyMilestone('arrived', { type: EVENT.STOP_SERVICE_COMPLETED }), true)
  })
})

describe('assignment race — atomic reservation', () => {
  test('two dispatchers racing one shipment → one winner, one conflict', () => {
    const f = assignmentRace()
    const r = runAssignmentRace(f.shipmentId, f.attempts)
    assert.ok(r.winner)
    assert.equal(r.conflictCount, 1)
    assert.equal(f.expect.winners, 1)
    assert.equal(f.expect.conflicts, 1)
  })

  test('idempotent retry returns existing reservation', () => {
    const store = new Map()
    const r1 = reserve(store, { shipmentId: 'S1', expectedVersion: 0, actor: 'A', idempotencyKey: 'k1' })
    const r2 = reserve(store, { shipmentId: 'S1', expectedVersion: 0, actor: 'A', idempotencyKey: 'k1' })
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(r2.assignment.id, r1.assignment.id)
  })

  test('commit advances reserved → committed', () => {
    const store = new Map()
    const r1 = reserve(store, { shipmentId: 'S1', expectedVersion: 0, actor: 'A', idempotencyKey: 'k1' })
    const r2 = commit(store, { shipmentId: 'S1', expectedVersion: r1.assignment.version, actor: 'driver', idempotencyKey: 'k1' })
    assert.equal(r2.ok, true)
    assert.equal(r2.assignment.status, 'committed')
  })
})

// Fixed "now" for deterministic freshness checks. Same epoch as the fixtures.
const NOW = Date.UTC(2026, 8, 13, 13, 0, 0)
