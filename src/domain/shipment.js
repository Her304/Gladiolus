/**
 * Shipment, stop, and detention workflow (Phase 2).
 *
 * The brief's highest-value end-to-end workflow: shipment intake → feasibility
 * → assignment → driver acknowledgment → stop execution → detention calculation
 * → billing export. This module holds the domain records and the projection
 * that joins them into a detention ledger.
 *
 * Arrival is not delivery. A geofence crossing may support `arrived`; service
 * completion is its own confirmed milestone, and the load stays associated with
 * its stop while detention evidence accumulates (plan §4, §5 Phase 2).
 */
import { EVENT, STOP_TRANSITIONS, canTransition, DEFAULT_DETENTION_RULE, validateRecord } from './contract.js'
import { calculateDetention, foldVisit, chargeableInterval } from './detention.js'

/**
 * Create a shipment record with stable customer-facing identity, FTL/LTL kind,
 * commercial terms, and ordered stops. Required fields are validated so an
 * incomplete shipment cannot be constructed (plan §5 Phase 0: required data).
 *
 * @param {object} o
 * @param {string} o.id            stable customer-facing identity
 * @param {'ftl'|'ltl'} o.kind
 * @param {object[]} o.stops       ordered [{id, role:'pickup'|'delivery', facilityId, appointment?}]
 * @param {object} [o.terms]       commercial terms (rate, currency, ruleId)
 */
export function createShipment({ id, kind = 'ftl', stops, terms = {} }) {
  if (!id) throw new Error('shipment requires id')
  if (!Array.isArray(stops) || stops.length < 2) throw new Error('shipment requires >=2 ordered stops')
  const record = {
    id,
    kind,
    status: 'posted',
    stops: stops.map((s, i) => ({
      id: s.id,
      shipmentId: id,
      sequence: i,
      role: s.role,
      facilityId: s.facilityId,
      appointment: s.appointment ?? null,
      milestone: 'none',
      visit: null,
    })),
    terms,
    assignmentId: null,
    proofRefs: [],
    createdAt: null,
  }
  const v = validateRecord('Shipment', record)
  if (!v.ok) throw new Error(`invalid shipment: missing ${v.missing.join(', ')}`)
  return record
}

/**
 * Apply a shipment/stop event to a shipment record. Milestones advance forward
 * only; a stale observation never regresses the current milestone (plan §9 edge
 * register: "delayed telemetry must not regress current state").
 *
 * @param {object} shipment  mutable shipment record
 * @param {object} e         an event
 */
export function applyShipmentEvent(shipment, e) {
  if (!shipment) return shipment
  switch (e.type) {
    case EVENT.SHIPMENT_POSTED:
      shipment.status = 'posted'
      shipment.createdAt = e.observedAt ?? e.at
      break
    case EVENT.ASSIGNMENT_COMMITTED:
      if (e.shipmentId === shipment.id) {
        shipment.status = 'assigned'
        shipment.assignmentId = e.assignmentId ?? shipment.assignmentId
      }
      break
    case EVENT.SHIPMENT_COMPLETED:
      shipment.status = 'completed'
      break
    case EVENT.SHIPMENT_CANCELLED:
      shipment.status = 'cancelled'
      break
    case EVENT.STOP_ARRIVED:
    case EVENT.STOP_CHECKED_IN:
    case EVENT.STOP_SERVICE_STARTED:
    case EVENT.STOP_SERVICE_COMPLETED:
    case EVENT.STOP_DEPARTED: {
      const stop = shipment.stops.find((s) => s.id === e.stopId)
      if (!stop) break
      const target = milestoneFromEvent(e.type)
      if (target && canTransition(STOP_TRANSITIONS, stop.milestone, target)) {
        stop.milestone = target
      }
      // Accumulate the visit evidence (timestamps), independent of milestone.
      stop.visit = foldVisit([...(stop.visitEvents || []), e])
      stop.visitEvents = [...(stop.visitEvents || []), e]
      break
    }
    default:
      break
  }
  return shipment
}

function milestoneFromEvent(type) {
  switch (type) {
    case EVENT.STOP_ARRIVED: return 'arrived'
    case EVENT.STOP_CHECKED_IN: return 'checked_in'
    case EVENT.STOP_SERVICE_STARTED: return 'service_started'
    case EVENT.STOP_SERVICE_COMPLETED: return 'service_completed'
    case EVENT.STOP_DEPARTED: return 'departed'
    default: return null
  }
}

/**
 * Build a detention ledger entry for a delivery stop. This is the exportable
 * evidence package: boundary, free minutes, billable minutes, rate, rounding,
 * amount, uncertainty, and review state (plan §5 Phase 2 acceptance gate).
 *
 * Exclusions: parking/rest, carrier-caused delay, transit, and uncertain visits
 * are never automatically charged until reviewed.
 *
 * @param {object} stop       a shipment stop with accumulated visit events
 * @param {object} rule       a DetentionRule (defaults to the 2h FTL demo rule)
 * @returns {object|null}     the ledger entry, or null if not enough evidence
 */
export function detentionLedgerEntry(stop, rule = DEFAULT_DETENTION_RULE) {
  if (!stop || !stop.visitEvents || stop.visitEvents.length === 0) return null
  const visit = foldVisit(stop.visitEvents)
  if (stop.appointment) visit.appointment = stop.appointment
  const calc = calculateDetention(visit, rule)
  if (!calc) return null
  const iv = chargeableInterval(visit, rule)
  const amount = (calc.roundedMinutes / 60) * rule.ratePerHour
  return {
    stopId: stop.id,
    shipmentId: stop.shipmentId,
    facilityId: stop.facilityId,
    ruleId: rule.id,
    contractVersion: rule.contractVersion,
    state: calc.billableMinutes > 0 ? 'eligible' : 'calculated',
    // Evidence
    arrived: visit.arrived,
    checkedIn: visit.checkedIn,
    serviceStart: visit.serviceStart,
    serviceComplete: visit.serviceComplete,
    departed: visit.departed,
    appointment: visit.appointment,
    freeStart: iv?.freeStartMs ?? null,
    chargeEnd: iv?.chargeEndMs ?? null,
    // Calculated
    freeMinutes: calc.freeMinutes,
    chargeableMinutes: calc.chargeableMinutes,
    billableMinutes: calc.billableMinutes,
    roundedMinutes: calc.roundedMinutes,
    ratePerHour: rule.ratePerHour,
    currency: rule.currency,
    amount: Math.round(amount * 100) / 100,
    excluded: calc.excluded || false,
    uncertainty: visit.serviceComplete == null ? 'service-complete missing' : null,
  }
}

/**
 * Project a full shipment (with stop visits + detention ledger) from an event
 * stream filtered to one shipment. The timeline joins GPS evidence, duty state,
 * driver actions, appointment changes, and billing events.
 *
 * @param {object[]} events  all events for one shipment, in seq order
 * @param {object} shipment   the base shipment record (from createShipment)
 * @param {object} [rule]
 */
export function projectShipment(events, shipment, rule = DEFAULT_DETENTION_RULE) {
  for (const e of events) applyShipmentEvent(shipment, e)
  const ledger = shipment.stops
    .filter((s) => s.role === 'delivery')
    .map((s) => detentionLedgerEntry(s, rule))
    .filter(Boolean)
  return {
    ...shipment,
    ledger,
    timeline: events.map((e) => ({
      seq: e.seq,
      at: e.observedAt ?? e.at,
      type: e.type,
      actor: e.actor,
      source: e.source,
      summary: summarize(e),
    })),
  }
}

function summarize(e) {
  switch (e.type) {
    case EVENT.SHIPMENT_POSTED: return `shipment ${e.shipmentId} posted`
    case EVENT.ASSIGNMENT_COMMITTED: return `assignment committed: truck ${e.truckId}`
    case EVENT.STOP_ARRIVED: return `arrived at stop ${e.stopId}`
    case EVENT.STOP_CHECKED_IN: return `checked in at stop ${e.stopId}`
    case EVENT.STOP_SERVICE_STARTED: return `service started at stop ${e.stopId}`
    case EVENT.STOP_SERVICE_COMPLETED: return `service completed at stop ${e.stopId}`
    case EVENT.STOP_DEPARTED: return `departed stop ${e.stopId}`
    case EVENT.DETENTION_CALCULATED: return `detention calculated: ${e.billableMinutes} billable min`
    case EVENT.DETENTION_WAIVED: return `detention waived by ${e.actor}`
    case EVENT.DETENTION_EXPORTED: return `detention exported`
    default: return e.type
  }
}
