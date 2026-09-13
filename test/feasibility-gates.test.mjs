/**
 * Phase 3 acceptance-gate tests — authoritative feasibility & safety.
 *
 * Acceptance gate (plan §5 Phase 3):
 *   - Missing HOS history never produces a feasible assignment.
 *   - Elapsed or cycle exhaustion blocks an offer even when driving hours remain.
 *   - A driver whose duty expires at a dock does not move; the assignment is
 *     withdrawn/escalated and a resolution recorded.
 *   - A major defect prevents movement and assignment.
 *   - A mainline closure invalidates the route; a ramp-only closure applies only
 *     when the planned access uses it.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { gateMovement, gateAssignment, rankCandidates } from '../src/domain/command.js'
import { movementGuard, routeFeasibility, hosFeasibility, boundedReach, assignmentFeasibility } from '../src/domain/feasibility.js'
import { VERDICT, BLOCKER, HOS_LIMITS, EVENT } from '../src/domain/contract.js'

const H = 3600_000
const MIN = 60_000
const NOW = Date.UTC(2026, 8, 13, 13, 0, 0)

function duty(over = {}) {
  return {
    drivingMs: 5 * H, onDutyMs: 6 * H, elapsedMs: 7 * H, cycleMs: 20 * H,
    dailyOffDutyMs: 10 * H, regime: 'cycle1', observedAt: NOW, source: 'live',
    ...over,
  }
}

describe('Phase 3 — missing HOS never feasible', () => {
  test('missing duty snapshot → gateAssignment unresolved', () => {
    const r = gateAssignment({ duty: null, vehicle: { available: true }, route: { edges: [] } })
    assert.equal(r.verdict, VERDICT.UNRESOLVED)
    assert.ok(r.blockers.includes(BLOCKER.HOS_UNKNOWN))
    assert.equal(r.ok, false)
  })

  test('duty with undefined counters → unresolved, never feasible', () => {
    const r = gateAssignment({ duty: { drivingMs: undefined, onDutyMs: undefined, observedAt: NOW }, vehicle: { available: true }, route: { edges: [] } })
    assert.equal(r.verdict, VERDICT.UNRESOLVED)
  })
})

describe('Phase 3 — elapsed/cycle exhaustion blocks even with driving hours', () => {
  test('elapsed window exhausted → infeasible', () => {
    const r = gateAssignment({ duty: duty({ elapsedMs: HOS_LIMITS.ELAPSED_WINDOW_MS }), vehicle: { available: true }, route: { edges: [] } })
    assert.equal(r.verdict, VERDICT.INFEASIBLE)
    assert.ok(r.blockers.includes(BLOCKER.HOS_ELAPSED))
  })

  test('cycle exhausted → infeasible even with driving hours', () => {
    const r = gateAssignment({ duty: duty({ cycleMs: 71 * H }), vehicle: { available: true }, route: { edges: [] }, })
    assert.equal(r.verdict, VERDICT.INFEASIBLE)
    assert.ok(r.blockers.includes(BLOCKER.HOS_CYCLE))
  })
})

describe('Phase 3 — dock HOS expiry holds movement', () => {
  test('a driver at the HOS limit at a dock is blocked before movement', () => {
    const truck = { id: 'GLD-101', drivingMs: HOS_LIMITS.DRIVING_MS, onDutyMs: HOS_LIMITS.ON_DUTY_MS, state: 'dwelling' }
    const r = gateMovement({ truck, vehicle: { available: true }, route: { impassable: false }, assignmentId: 'ASN-1' })
    assert.equal(r.ok, false)
    assert.equal(r.blocked, true)
    assert.equal(r.reason, BLOCKER.HOS_DRIVING)
    // The guard opens an exception with an owner/deadline/resolution state
    // (plan: "a resolution is recorded"), not a silent alert.
    const opened = r.events.find((e) => e.type === EVENT.EXCEPTION_OPENED)
    assert.ok(opened, 'exception opened')
    assert.equal(opened.severity, 'critical')
    assert.ok(opened.deadline > 0, 'exception has a resolution deadline')
    assert.equal(opened.state, 'open')
    // The affected assignment is withdrawn, not left committed to an illegal move.
    const withdrawn = r.events.find((e) => e.type === EVENT.ASSIGNMENT_UNASSIGNED)
    assert.ok(withdrawn, 'assignment withdrawn')
    assert.equal(withdrawn.assignmentId, 'ASN-1')
    assert.equal(withdrawn.actor, 'safety-gate')
  })

  test('a driver with hours remaining is not blocked', () => {
    const truck = { id: 'GLD-101', drivingMs: 2 * H, onDutyMs: 3 * H, state: 'dwelling' }
    const r = gateMovement({ truck, vehicle: { available: true }, route: { impassable: false } })
    assert.equal(r.ok, true)
    assert.equal(r.blocked, undefined)
  })
})

describe('Phase 3 — major defect prevents movement and assignment', () => {
  test('a vehicle with a major defect blocks movement', () => {
    const truck = { id: 'GLD-101', drivingMs: 0, onDutyMs: 0 }
    const r = gateMovement({ truck, vehicle: { available: false, reason: BLOCKER.VEHICLE_DEFECT }, route: { impassable: false } })
    assert.equal(r.blocked, true)
    assert.equal(r.reason, BLOCKER.VEHICLE_DEFECT)
  })

  test('a major defect blocks assignment', () => {
    const r = gateAssignment({ duty: duty(), vehicle: { available: false, reason: BLOCKER.VEHICLE_DEFECT }, route: { edges: [] } })
    assert.equal(r.verdict, VERDICT.INFEASIBLE)
    assert.ok(r.blockers.includes(BLOCKER.VEHICLE_DEFECT))
  })
})

describe('Phase 3 — closures invalidate the route', () => {
  test('a full mainline closure makes the route impassable', () => {
    const route = { edges: [{ closed: true, closureKind: 'mainline' }] }
    const rf = routeFeasibility(route)
    assert.equal(rf.impassable, true)
    const r = gateMovement({ truck: { drivingMs: 0, onDutyMs: 0 }, vehicle: { available: true }, route: { impassable: rf.impassable } })
    assert.equal(r.blocked, true)
    assert.equal(r.reason, BLOCKER.ROUTE_CLOSURE)
  })

  test('a ramp-only closure does not block unless the plan uses that ramp', () => {
    const route1 = { edges: [{ closed: true, closureKind: 'ramp', rampUsedByPlan: false }] }
    assert.equal(routeFeasibility(route1).impassable, false)
    const route2 = { edges: [{ closed: true, closureKind: 'ramp', rampUsedByPlan: true }] }
    assert.equal(routeFeasibility(route2).impassable, true)
  })
})

describe('Phase 3 — rank candidates by feasibility', () => {
  test('infeasible loads surface as exceptions, not silently open', () => {
    const candidates = [
      { id: 'L1', revenue: 1000 },
      { id: 'L2', revenue: 2000 },
    ]
    const feasibilityFor = (c) =>
      c.id === 'L1'
        ? { verdict: VERDICT.FEASIBLE, blockers: [], inputs: ['hos'] }
        : { verdict: VERDICT.INFEASIBLE, blockers: [BLOCKER.HOS_CYCLE], inputs: ['hos'] }
    const r = rankCandidates(candidates, feasibilityFor)
    assert.equal(r.feasible.length, 1)
    assert.equal(r.feasible[0].id, 'L1')
    assert.equal(r.exceptions.length, 1)
    assert.equal(r.exceptions[0].loadId, 'L2')
    assert.equal(r.exceptions[0].verdict, VERDICT.INFEASIBLE)
  })

  test('unresolved inputs surface as exceptions (not feasible)', () => {
    const candidates = [{ id: 'L1', revenue: 1000 }]
    const feasibilityFor = () => ({ verdict: VERDICT.UNRESOLVED, blockers: [BLOCKER.HOS_UNKNOWN], inputs: ['hos'] })
    const r = rankCandidates(candidates, feasibilityFor)
    assert.equal(r.feasible.length, 0)
    assert.equal(r.exceptions.length, 1)
  })
})

describe('Phase 3 — no optimistic speed floor in reach', () => {
  test('a 10km/h truck does not get 40km/h-floored reach', () => {
    const r = boundedReach(duty(), 10)
    assert.ok(r.km < 200, `expected proportional reach, got ${r.km}`)
  })
  test('unknown duty → null reach (no affirmative answer)', () => {
    assert.equal(boundedReach(null, 100), null)
  })
})
