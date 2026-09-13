/**
 * Command handler with safety gates (Phase 3).
 *
 * Safety gates act BEFORE movement and assignment (plan §3.6): HOS exhaustion,
 * a major defect, an immobilizing breakdown, or an impassable route prevent the
 * transition rather than raising an alert after it. The v1 simulator checked HOS
 * *after* driving and let a truck roll ~375m before a forced stop; this module
 * is the guard that runs first.
 *
 * Every command returns an explicit result with its inputs and blocking
 * reasons, so automation is explainable and reversible (plan §3.8).
 */
import { movementGuard, assignmentFeasibility, routeFeasibility, hosFeasibility } from './feasibility.js'
import { VERDICT, BLOCKER, HOS_LIMITS } from './contract.js'
import { EVENT } from './contract.js'

const MIN = 60_000

/**
 * Gate a movement command. This is the pre-movement guard the v1 simulator
 * lacked: it returns blocked:true BEFORE the truck is allowed to start driving.
 *
 * When movement is blocked, the affected assignment is withdrawn (or escalated)
 * and a resolution is recorded (plan §5 Phase 3: "the affected assignment is
 * withdrawn or escalated and a resolution is recorded"). The exception carries
 * an owner, deadline, and resolution state so it cannot vanish silently.
 *
 * @param {object} ctx  { truck, vehicle, route, duty, assignmentId?, now? }
 * @returns {{ok:boolean, blocked?:boolean, reason?:string, events?:object[]}}
 */
export function gateMovement({ truck, vehicle, route, duty, assignmentId, now = Date.now() }) {
  const guard = movementGuard(truck, vehicle, route)
  if (guard.blocked) {
    const events = [{
      type: EVENT.EXCEPTION_OPENED,
      observedAt: now,
      severity: 'critical',
      affectedTruck: truck?.id,
      reason: guard.reason,
      detail: `Movement blocked: ${guard.reason}`,
      owner: null, // awaiting dispatch acknowledgment
      deadline: now + 30 * 60_000, // a resolution is expected within 30 min
      state: 'open',
    }]
    // Withdraw the affected assignment so the truck is not left committed to a
    // movement it cannot legally make. The withdrawal is an audited transition,
    // not a silent state change.
    if (assignmentId) {
      events.push({
        type: EVENT.ASSIGNMENT_UNASSIGNED,
        observedAt: now,
        assignmentId,
        affectedTruck: truck?.id,
        reason: `movement blocked: ${guard.reason}`,
        actor: 'safety-gate',
      })
    }
    return { ok: false, blocked: true, reason: guard.reason, events }
  }
  return { ok: true, events: [] }
}

/**
 * Gate an assignment. Feasibility is checked first; only feasible candidates are
 * ranked (plan §5 Phase 4). Returns the verdict, blockers, and the inputs used
 * so the decision is explainable.
 */
export function gateAssignment({ duty, vehicle, route, equipment, weight, assignment, now = Date.now() }) {
  const feas = assignmentFeasibility({ duty, vehicle, route, equipment, weight, assignment, now })
  return {
    ok: feas.verdict === VERDICT.FEASIBLE,
    verdict: feas.verdict,
    blockers: feas.blockers,
    inputs: feas.inputs,
  }
}

/**
 * Filter + rank a list of load candidates by feasibility. Infeasible/unresolved
 * candidates are excluded; the feasible ones are ranked (plan §5 Phase 4:
 * "Implement feasibility filtering first, then rank only feasible candidates").
 * Loads with no feasible candidate surface as exceptions.
 *
 * @param {object[]} candidates  load offers
 * @param {function} feasibilityFor  (candidate) => gateAssignment result
 * @returns {{feasible:object[], exceptions:object[]}}
 */
export function rankCandidates(candidates, feasibilityFor) {
  const feasible = []
  const exceptions = []
  for (const c of candidates) {
    const f = feasibilityFor(c)
    if (f.verdict === VERDICT.FEASIBLE) {
      feasible.push({ ...c, feasibility: f })
    } else {
      exceptions.push({
        loadId: c.id,
        verdict: f.verdict,
        blockers: f.blockers,
        reason: f.verdict === VERDICT.UNRESOLVED ? 'no feasible candidate (unresolved inputs)' : 'no feasible candidate',
      })
    }
  }
  // Rank feasible by revenue/contribution (simple: higher revenue first).
  feasible.sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
  return { feasible, exceptions }
}
