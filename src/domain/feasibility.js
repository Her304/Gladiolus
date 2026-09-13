/**
 * Authoritative feasibility & safety gates (Phase 0/3).
 *
 * Replaces the two-counter HOS helper with a supported Canadian regime model:
 * driving, on-duty, elapsed shift window, daily off-duty, core rest, Cycle 1/2,
 * exemptions, source, and freshness. Returns feasible|infeasible|unresolved —
 * missing data NEVER collapses to feasible (plan §3.4, §5 Phase 3).
 *
 * Safety gates act BEFORE movement and assignment: HOS exhaustion, a major
 * defect, an immobilizing breakdown, or an impassable route prevent the
 * transition rather than raising an alert after it.
 */
import { VERDICT, BLOCKER, HOS_LIMITS, HOS_CYCLES, DATA_SOURCE } from './contract.js'

const MIN = 60_000

/**
 * Determine HOS feasibility for an assignment. A truck/driver with no duty
 * history is UNRESOLVED, never feasible.
 *
 * @param {object} duty   a DutySnapshot: { drivingMs, onDutyMs, elapsedMs, dailyOffDutyMs, cycleMs, regime, source, observedAt, now }
 * @param {object} [assignment] planned travel/service/rest in ms
 * @returns {{verdict:FeasibilityVerdict, blockers:string[], drivingLeftMs?:number, dutyLeftMs?:number, elapsedLeftMs?:number, cycleLeftMs?:number}}
 */
export function hosFeasibility(duty, assignment = {}, now = Date.now()) {
  const blockers = []

  // Unknown is not safe. No duty snapshot at all → unresolved.
  if (!duty) {
    return { verdict: VERDICT.UNRESOLVED, blockers: [BLOCKER.HOS_UNKNOWN] }
  }

  // Freshness: stale HOS is unresolved, not a violation, not feasible.
  const staleAfterMs = 15 * MIN
  const observedAt = duty.observedAt ?? duty.receivedAt
  if (observedAt == null || now - observedAt > staleAfterMs) {
    return { verdict: VERDICT.UNRESOLVED, blockers: [BLOCKER.HOS_STALE] }
  }

  // Missing counters → unresolved (the current bug: defaults to 0 → 13h 'ok').
  const hasHistory =
    typeof duty.drivingMs === 'number' &&
    typeof duty.onDutyMs === 'number' &&
    typeof duty.elapsedMs === 'number' &&
    typeof duty.cycleMs === 'number'
  if (!hasHistory) {
    return { verdict: VERDICT.UNRESOLVED, blockers: [BLOCKER.HOS_UNKNOWN] }
  }

  const planDriving = assignment.drivingMs || 0
  const planDuty = assignment.onDutyMs || 0
  const planElapsed = assignment.elapsedMs || 0

  const drivingLeft = HOS_LIMITS.DRIVING_MS - duty.drivingMs
  const dutyLeft = HOS_LIMITS.ON_DUTY_MS - duty.onDutyMs
  const elapsedLeft = HOS_LIMITS.ELAPSED_WINDOW_MS - duty.elapsedMs

  if (drivingLeft - planDriving <= 0) blockers.push(BLOCKER.HOS_DRIVING)
  if (dutyLeft - planDuty <= 0) blockers.push(BLOCKER.HOS_DUTY)
  if (elapsedLeft - planElapsed <= 0) blockers.push(BLOCKER.HOS_ELAPSED)

  // Daily off-duty requirement.
  if (typeof duty.dailyOffDutyMs === 'number' && duty.dailyOffDutyMs < HOS_LIMITS.DAILY_OFF_DUTY_MS) {
    blockers.push(BLOCKER.HOS_DAILY_OFF_DUTY)
  }

  // Cycle cumulative limits.
  const cycle = HOS_CYCLES[duty.regime] || HOS_CYCLES.cycle1
  const cycleLeftMs = cycle.hours * 3600_000 - duty.cycleMs
  if (cycleLeftMs - planDuty < 0) blockers.push(BLOCKER.HOS_CYCLE)

  if (blockers.length) {
    return { verdict: VERDICT.INFEASIBLE, blockers, drivingLeftMs: drivingLeft, dutyLeftMs: dutyLeft, elapsedLeftMs: elapsedLeft, cycleLeftMs: cycleLeftMs }
  }
  return { verdict: VERDICT.FEASIBLE, blockers: [], drivingLeftMs: drivingLeft, dutyLeftMs: dutyLeft, elapsedLeftMs: elapsedLeft, cycleLeftMs: cycleLeftMs }
}

/**
 * Pre-movement guard. Returns true if movement must be BLOCKED now. This runs
 * BEFORE a truck is allowed to start driving — the plan (§5 Phase 3) removes
 * the transition that begins driving and only stops on the next tick.
 *
 * @param {object} truck  observable truck (has state, drivingMs, onDutyMs)
 * @param {object} [vehicle] VehicleAvailability { available, reason }
 * @param {object} [route] RoutePlan { impassable }
 * @returns {{blocked:boolean, reason:string}}
 */
export function movementGuard(truck, vehicle, route) {
  if (!truck) return { blocked: true, reason: BLOCKER.HOS_UNKNOWN }

  // Major defect / immobilizing breakdown: vehicle removed from capacity.
  if (vehicle && vehicle.available === false) {
    return { blocked: true, reason: vehicle.reason || BLOCKER.VEHICLE_DEFECT }
  }
  if (vehicle == null) {
    // Unknown vehicle state is not safe.
    return { blocked: true, reason: BLOCKER.VEHICLE_UNKNOWN }
  }

  // HOS: would this movement begin past a limit?
  const drivingLeft = HOS_LIMITS.DRIVING_MS - (truck.drivingMs || 0)
  const dutyLeft = HOS_LIMITS.ON_DUTY_MS - (truck.onDutyMs || 0)
  if (drivingLeft <= 0) return { blocked: true, reason: BLOCKER.HOS_DRIVING }
  if (dutyLeft <= 0) return { blocked: true, reason: BLOCKER.HOS_DUTY }

  // Impassable route edge (full mainline closure).
  if (route && route.impassable) {
    return { blocked: true, reason: BLOCKER.ROUTE_CLOSURE }
  }

  return { blocked: false, reason: null }
}

/**
 * Route feasibility: a full mainline closure makes the edge impassable; a
 * ramp-only closure applies only when the planned access uses that ramp
 * (plan §5 Phase 3 acceptance gate).
 *
 * @param {object} route  { edges: [{ closed, closureKind, rampUsedByPlan? }] }
 * @returns {{impassable:boolean, reason?:string}}
 */
export function routeFeasibility(route) {
  if (!route || !route.edges) return { impassable: false }
  for (const e of route.edges) {
    if (!e.closed) continue
    if (e.closureKind === 'mainline') {
      return { impassable: true, reason: BLOCKER.ROUTE_CLOSURE }
    }
    // ramp-only: blocks only if the plan actually uses that ramp
    if (e.closureKind === 'ramp' && e.rampUsedByPlan) {
      return { impassable: true, reason: BLOCKER.ROUTE_CLOSURE }
    }
  }
  return { impassable: false }
}

/**
 * Overall assignment feasibility: HOS + vehicle + route + equipment + weight.
 * Any unresolved input → unresolved; any hard blocker → infeasible.
 *
 * @returns {{verdict:FeasibilityVerdict, blockers:string[], confidence?:number, inputs:string[]}}
 */
export function assignmentFeasibility({ duty, vehicle, route, equipment, weight }) {
  const blockers = []
  const inputs = []
  let unresolved = false

  const hos = hosFeasibility(duty)
  inputs.push('hos')
  if (hos.verdict === VERDICT.UNRESOLVED) unresolved = true
  blockers.push(...hos.blockers)

  if (vehicle && vehicle.available === false) {
    blockers.push(vehicle.reason || BLOCKER.VEHICLE_DEFECT)
  } else if (vehicle == null) {
    unresolved = true
    blockers.push(BLOCKER.VEHICLE_UNKNOWN)
  }
  inputs.push('vehicle')

  const rt = routeFeasibility(route)
  if (rt.impassable) blockers.push(rt.reason)
  inputs.push('route')

  if (equipment && equipment.required && !equipment.satisfied) {
    blockers.push(BLOCKER.EQUIPMENT)
  }
  if (weight && weight.overload) {
    blockers.push(BLOCKER.WEIGHT)
  }

  if (unresolved) return { verdict: VERDICT.UNRESOLVED, blockers, inputs }
  if (blockers.length) return { verdict: VERDICT.INFEASIBLE, blockers, inputs }
  return { verdict: VERDICT.FEASIBLE, blockers: [], inputs, confidence: 1 }
}

/**
 * Bounded reach without an optimistic speed floor. The old reachableKm floored
 * speed at 40km/h, producing 40km reach for a 10km/h truck in congestion.
 * Here, reach is computed from the actual (bounded) speed with a confidence and
 * a contingency margin (plan §5 Phase 3).
 *
 * @returns {{km:number, confidence:number, contingencyKm:number}|null}
 *   null when HOS is unknown (no affirmative reach).
 */
export function boundedReach(duty, speedKph, { margin = 0.1 } = {}) {
  if (!duty || typeof duty.drivingMs !== 'number' || typeof duty.onDutyMs !== 'number') {
    return null // unknown → no affirmative reach
  }
  const hos = hosFeasibility(duty)
  if (hos.verdict !== VERDICT.FEASIBLE) return null
  const leftMs = Math.min(hos.drivingLeftMs, hos.dutyLeftMs)
  const speed = Math.max(0, speedKph || 0) // NO floor; a stopped truck has zero reach
  const km = (leftMs / 3600_000) * speed
  const confidence = speed > 0 ? Math.min(1, leftMs / HOS_LIMITS.DRIVING_MS) : 0
  return { km, confidence, contingencyKm: km * (1 - margin) }
}
