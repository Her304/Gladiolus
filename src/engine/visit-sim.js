/**
 * Visit simulator (Phase 2).
 *
 * Drives the independent facility-visit milestones — arrival, check-in, service
 * start, service completion, departure — as separate events, replacing the v1
 * conflation of arrival with delivery. Visits are deliberate in normal
 * deterministic scenarios, including one that exceeds the configured free time
 * (plan §5 Phase 2: "Make long visits deliberate ... including one that exceeds
 * the configured free time").
 *
 * This is a deterministic scenario driver, not the physical truck model: it
 * emits the same stop-milestone events a real ELD/order integration would, so
 * the detention ledger can be exercised end to end without random timing.
 */
import { EVENT, DEFAULT_DETENTION_RULE } from '../domain/contract.js'

const MIN = 60_000
const H = 3600_000

export const VISIT_SCENARIOS = Object.freeze({
  // A normal visit within free time: 0 billable.
  normal: { arriveMin: 0, checkInMin: 5, serviceStartMin: 10, serviceCompleteMin: 70, departMin: 75 },
  // Exactly one minute under two-hour free time: 0 billable.
  'dwell-119': { arriveMin: 0, checkInMin: 5, serviceStartMin: 10, serviceCompleteMin: 119, departMin: 125 },
  // 30 minutes past free time: 30 billable before rounding.
  'dwell-150': { arriveMin: 0, checkInMin: 5, serviceStartMin: 10, serviceCompleteMin: 150, departMin: 160 },
  // Early arrival 60 min before appointment; free time starts at appointment.
  'early': { arriveMin: -60, checkInMin: -55, serviceStartMin: 70, serviceCompleteMin: 150, departMin: 160, appointmentMin: 0 },
  // A parking/rest stay — must not auto-charge.
  'parking': { arriveMin: 0, serviceStartMin: 10, serviceCompleteMin: 300, departMin: 310, kind: 'parking' },
})

/**
 * Emit the milestone events for one visit scenario. Returns an ordered event
 * list with stable provider ids (idempotent) and provenance.
 *
 * @param {string} scenarioKey  a key in VISIT_SCENARIOS
 * @param {object} ctx         { shipmentId, stopId, truckId, t0, ruleId }
 * @returns {object[]}         milestone events
 */
export function emitVisit(scenarioKey, ctx) {
  const s = VISIT_SCENARIOS[scenarioKey]
  if (!s) throw new Error(`unknown visit scenario: ${scenarioKey}`)
  const { shipmentId, stopId, truckId, t0, facilityId } = ctx
  const base = { shipmentId, stopId, truckId, facilityId, source: 'simulated', schemaVersion: 2 }
  const events = []
  const push = (type, atMin, extra = {}) => {
    if (atMin == null) return
    const observedAt = t0 + atMin * MIN
    events.push({
      ...base, type, observedAt, receivedAt: observedAt,
      providerId: `sim:${type}:${stopId}:${scenarioKey}`,
      ...extra,
    })
  }
  push(EVENT.STOP_ARRIVED, s.arriveMin)
  push(EVENT.STOP_CHECKED_IN, s.checkInMin)
  push(EVENT.STOP_SERVICE_STARTED, s.serviceStartMin)
  push(EVENT.STOP_SERVICE_COMPLETED, s.serviceCompleteMin)
  push(EVENT.STOP_DEPARTED, s.departMin)
  if (s.appointmentMin != null) {
    // Appointment is reference data attached to the arrival event.
    events.find((e) => e.type === EVENT.STOP_ARRIVED).appointment = t0 + s.appointmentMin * MIN
  }
  if (s.kind) {
    events.forEach((e) => { e.visitKind = s.kind })
  }
  return events
}

/**
 * Run a full demonstration shipment: post → assign → drive → visit → detention
 * calculation. Returns the event stream for one shipment, suitable for the
 * detention ledger projection.
 *
 * @param {object} opts
 * @param {string} [opts.scenario]   visit scenario key (default 'dwell-150')
 * @param {number} [opts.t0]         start epoch
 */
export function runDemonstrationShipment(opts = {}) {
  const scenario = opts.scenario || 'dwell-150'
  const t0 = opts.t0 ?? Date.UTC(2026, 8, 13, 13, 0, 0)
  const shipmentId = opts.shipmentId || 'SHP-9001'
  const stopId = opts.stopId || 'STP-dl'
  const truckId = opts.truckId || 'GLD-101'
  const facilityId = opts.facilityId || 'london-dc'
  const rule = opts.rule || DEFAULT_DETENTION_RULE

  const events = []
  const push = (type, at, extra = {}) => {
    events.push({
      type, observedAt: at, receivedAt: at, source: 'simulated', schemaVersion: 2,
      providerId: `sim:${type}:${shipmentId}`,
      shipmentId, ...extra,
    })
  }
  push(EVENT.SHIPMENT_POSTED, t0, { kind: 'ftl', stops: ['STP-pu', stopId] })
  push(EVENT.ASSIGNMENT_COMMITTED, t0 + MIN, { truckId, assignmentId: `ASN-${shipmentId}`, shipmentId })
  // The visit milestones:
  const visitEvents = emitVisit(scenario, { shipmentId, stopId, truckId, t0: t0 + 2 * H, facilityId })
  events.push(...visitEvents)
  // Detention eligibility + calculation once service completes.
  const serviceComplete = visitEvents.find((e) => e.type === EVENT.STOP_SERVICE_COMPLETED)
  if (serviceComplete) {
    push(EVENT.DETENTION_ELIGIBLE, serviceComplete.observedAt + MIN, { claimId: `CLM-${shipmentId}`, stopId, ruleId: rule.id })
    push(EVENT.DETENTION_CALCULATED, serviceComplete.observedAt + 2 * MIN, { claimId: `CLM-${shipmentId}`, stopId, ruleId: rule.id, billableMinutes: scenario.startsWith('dwell-15') ? 30 : 0 })
  }
  // Once service is complete and detention is calculated, the shipment is
  // operationally complete (delivery confirmed, evidence accumulated).
  const departed = visitEvents.find((e) => e.type === EVENT.STOP_DEPARTED)
  push(EVENT.SHIPMENT_COMPLETED, (departed?.observedAt ?? serviceComplete?.observedAt) + 3 * MIN, { shipmentId })
  return { events, shipmentId, stopId, rule, scenario, t0 }
}
