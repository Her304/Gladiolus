/**
 * Contract-driven detention calculation (Phase 0/2).
 *
 * The single hardest business rule in the brief: a long facility visit must
 * produce the *contract-correct* charge, not merely a dwell statistic. The
 * worked cases (assessment §5, plan §5 Phase 2):
 *
 *   - 119-min qualifying visit → 0 billable minutes
 *   - 150-min qualifying visit → 30 billable minutes (before rounding)
 *
 * Arrival is not delivery and presence is not a charge. Chargeable time begins
 * after free time, on the boundary the contract names (default: appointment →
 * service-complete). Parking/rest, carrier-caused delay, transit, and uncertain
 * visits are excluded from automatic charging until reviewed.
 */
import { EVENT } from './contract.js'

const MIN = 60_000

/**
 * Determine the chargeable interval for a visit from its milestones and the
 * rule. Free time starts where the rule says (appointment by default); the
 * chargeable service ends at completion (default rule) or gate-out.
 *
 * @param {object} visit  assembled visit record (arrival, checkIn, serviceStart, serviceComplete, departed, appointment)
 * @param {object} rule    a DetentionRule
 * @returns {{freeStartMs:number, chargeEndMs:number}|null} null if the boundary milestones are missing
 */
export function chargeableInterval(visit, rule) {
  if (!visit) return null
  const freeStart =
    rule.freeTimeStart === 'appointment'
      ? visit.appointment ?? visit.arrived ?? visit.checkedIn
      : (visit.arrived ?? visit.checkedIn)
  const chargeEnd =
    rule.chargeBoundary === 'service-complete'
      ? visit.serviceComplete
      : visit.departed ?? visit.serviceComplete
  if (freeStart == null || chargeEnd == null) return null
  if (chargeEnd < freeStart) return null
  return { freeStartMs: freeStart, chargeEndMs: chargeEnd }
}

/**
 * Calculate billable minutes for a visit under a rule. Returns raw billable
 * minutes (before rounding) and the rounded minutes the invoice would carry.
 *
 * Exclusions: if the visit kind is in the rule's exclusions (parking, rest,
 * carrier-caused, transit, uncertain), billable is zero — a long stay is not an
 * automatic charge.
 *
 * @returns {{billableMinutes:number, roundedMinutes:number, freeMinutes:number, chargeableMinutes:number}|null}
 */
export function calculateDetention(visit, rule) {
  if (!visit || !rule) return null
  if (visit.kind && rule.exclusions?.includes(visit.kind)) {
    return { billableMinutes: 0, roundedMinutes: 0, freeMinutes: 0, chargeableMinutes: 0, excluded: true }
  }
  const iv = chargeableInterval(visit, rule)
  if (!iv) return null
  const chargeableMs = Math.max(0, iv.chargeEndMs - iv.freeStartMs)
  const chargeableMinutes = chargeableMs / MIN
  const freeMinutes = rule.freeTimeMs / MIN
  const billableMinutes = Math.max(0, chargeableMinutes - freeMinutes)
  const roundingMinutes = rule.roundingMinutes || 1
  const roundedMinutes = Math.ceil(billableMinutes / roundingMinutes) * roundingMinutes
  return { billableMinutes, roundedMinutes, freeMinutes, chargeableMinutes, excluded: false }
}

/**
 * Fold a visit out of stop-milestone events. Milestones are independent: arrival
 * does not imply service complete. A late/stale observation (lower milestone
 * rank) must not regress the current milestone.
 *
 * @param {object[]} events  events for one stop
 * @returns {object} a visit with milestone timestamps
 */
export function foldVisit(events) {
  const v = {
    milestone: 'none',
    arrived: null,
    checkedIn: null,
    serviceStart: null,
    serviceComplete: null,
    departed: null,
    appointment: null,
  }
  const rank = {
    'arrived': 1,
    'checked_in': 2,
    'service_started': 3,
    'service_completed': 4,
    'departed': 5,
  }
  for (const e of events) {
    switch (e.type) {
      case EVENT.STOP_ARRIVED:
        if (!v.arrived) v.arrived = e.observedAt ?? e.at
        break
      case EVENT.STOP_CHECKED_IN:
        if (!v.checkedIn) v.checkedIn = e.observedAt ?? e.at
        break
      case EVENT.STOP_SERVICE_STARTED:
        if (!v.serviceStart) v.serviceStart = e.observedAt ?? e.at
        break
      case EVENT.STOP_SERVICE_COMPLETED:
        if (!v.serviceComplete) v.serviceComplete = e.observedAt ?? e.at
        break
      case EVENT.STOP_DEPARTED:
        if (!v.departed) v.departed = e.observedAt ?? e.at
        break
      default:
        break
    }
    // Advance milestone only forward; never regress on a stale observation.
    const target = milestoneFromType(e.type)
    if (target && rank[target] > rank[v.milestone]) v.milestone = target
  }
  return v
}

function milestoneFromType(type) {
  switch (type) {
    case EVENT.STOP_ARRIVED: return 'arrived'
    case EVENT.STOP_CHECKED_IN: return 'checked_in'
    case EVENT.STOP_SERVICE_STARTED: return 'service_started'
    case EVENT.STOP_SERVICE_COMPLETED: return 'service_completed'
    case EVENT.STOP_DEPARTED: return 'departed'
    default: return null
  }
}
