/**
 * Versioned domain contract (v2).
 *
 * The product's central workflow is now a shipment/exception lifecycle, not a
 * browser-local telemetry loop. This module freezes the records, events,
 * state machines, and provenance rules every other layer must obey. The engine
 * implements it, the server enforces it, the views are read-only projections of
 * it, and tests assert it.
 *
 * Non-negotiable system rules encoded here (see corridor-project-change-plan.md
 * §3):
 *   - The server is authoritative; browsers observe the same event sequence.
 *   - Every operational command is idempotent.
 *   - Observations preserve provenance (provider id, schema version, observed
 *     vs received time, source).
 *   - Unknown is not safe: missing/stale HOS, vehicle, route, contract, or
 *     appointment data yields an unresolved decision, never feasible.
 *   - Presence is not completion: a geofence crossing may support a milestone;
 *     it must not silently mean delivered or billable.
 *   - Safety gates act before movement and assignment.
 *   - Commercial rules are versioned and reconstructible.
 *   - Automation is explainable and reversible.
 *   - One shipment cannot be double-booked (atomic version checks).
 *   - The simulation is a data source, not a shortcut: it emits the same
 *     commands and observations expected from real integrations.
 */

/** Contract schema version. Bumped on any breaking record/event change. */
export const SCHEMA_VERSION = 2

/**
 * Outcome of a feasibility or command decision. A tri-state is required
 * because "unknown" must never collapse into "feasible" — missing HOS, vehicle,
 * route, or contract data produces `unresolved`, never an affirmative result.
 *
 * @typedef {'feasible'|'infeasible'|'unresolved'} FeasibilityVerdict
 */
export const VERDICT = Object.freeze({
  FEASIBLE: 'feasible',
  INFEASIBLE: 'infeasible',
  UNRESOLVED: 'unresolved',
})

/**
 * The event vocabulary (v2). Each domain lifecycle has its own namespace.
 *
 * Delivery/service completion is its own confirmed milestone; arrival at a
 * geofence only *supports* it. The old `load.delivered`-at-fence-entry meaning
 * is deliberately not preserved.
 *
 * @typedef {Object} EventVocab
 */
export const EVENT = Object.freeze({
  // Shipment lifecycle
  SHIPMENT_POSTED: 'shipment.posted',
  SHIPMENT_CHANGED: 'shipment.changed',
  SHIPMENT_CANCELLED: 'shipment.cancelled',
  SHIPMENT_COMPLETED: 'shipment.completed',

  // Stop / facility visit milestones (independent, not collapsed)
  STOP_ARRIVED: 'stop.arrived',
  STOP_CHECKED_IN: 'stop.checked_in',
  STOP_SERVICE_STARTED: 'stop.service_started',
  STOP_SERVICE_COMPLETED: 'stop.service_completed',
  STOP_DEPARTED: 'stop.departed',

  // Offer lifecycle
  OFFER_CREATED: 'offer.created',
  OFFER_EXPIRED: 'offer.expired',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_REJECTED: 'offer.rejected',

  // Assignment lifecycle
  ASSIGNMENT_RESERVED: 'assignment.reserved',
  ASSIGNMENT_COMMITTED: 'assignment.committed',
  ASSIGNMENT_UNASSIGNED: 'assignment.unassigned',
  ASSIGNMENT_CONFLICTED: 'assignment.conflicted',

  // Duty state
  DUTY_UPDATED: 'duty.updated',
  DUTY_STALE: 'duty.stale',

  // Vehicle availability
  VEHICLE_BLOCKED: 'vehicle.blocked',
  VEHICLE_CLEARED: 'vehicle.cleared',

  // Route
  ROUTE_INVALIDATED: 'route.invalidated',
  ROUTE_REPLANNED: 'route.replanned',

  // Detention
  DETENTION_ELIGIBLE: 'detention.eligible',
  DETENTION_CALCULATED: 'detention.calculated',
  DETENTION_REVIEWED: 'detention.reviewed',
  DETENTION_ADJUSTED: 'detention.adjusted',
  DETENTION_WAIVED: 'detention.waived',
  DETENTION_EXPORTED: 'detention.exported',
  DETENTION_RECONCILED: 'detention.reconciled',

  // Exception
  EXCEPTION_OPENED: 'exception.opened',
  EXCEPTION_ACKNOWLEDGED: 'exception.acknowledged',
  EXCEPTION_ASSIGNED: 'exception.assigned',
  EXCEPTION_RESOLVED: 'exception.resolved',

  // Telemetry / observations (retain the physical-simulation/observation split)
  TRUCK_PING: 'truck.ping',
  FENCE_ENTER: 'fence.enter',
  FENCE_EXIT: 'fence.exit',

  // Audit / correction
  CORRECTION_RECORDED: 'correction.recorded',
  CONFIG_CHANGED: 'config.changed',
  ADMIN_ACTION: 'admin.action',
})

/**
 * All v2 event types as a set, for validation and "is this a known event".
 */
export const EVENT_TYPES = new Set(Object.values(EVENT))

/**
 * Feasibility-relevant data domains. Each maps to a `reason` category so a
 * blocker can explain itself ("Automation is explainable", plan §3.8).
 */
export const BLOCKER = Object.freeze({
  HOS_DRIVING: 'hos.driving',
  HOS_DUTY: 'hos.duty',
  HOS_ELAPSED: 'hos.elapsed',
  HOS_DAILY_OFF_DUTY: 'hos.daily_off_duty',
  HOS_CYCLE: 'hos.cycle',
  HOS_STALE: 'hos.stale',
  HOS_UNKNOWN: 'hos.unknown',
  VEHICLE_DEFECT: 'vehicle.defect',
  VEHICLE_BREAKDOWN: 'vehicle.breakdown',
  VEHICLE_UNKNOWN: 'vehicle.unknown',
  ROUTE_CLOSURE: 'route.closure',
  ROUTE_UNKNOWN: 'route.unknown',
  EQUIPMENT: 'equipment',
  WEIGHT: 'weight',
  WEIGHT_UNKNOWN: 'weight.unknown',
  APPOINTMENT: 'appointment',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  MISSING_EVIDENCE: 'missing_evidence',
})

/**
 * HOS regimes supported by the decision model. The plan (§3, §5, §6) requires a
 * supported Canadian regime rather than two counters: driving, on-duty,
 * elapsed shift window, daily off-duty/core rest, Cycle 1 or Cycle 2, exemptions,
 * source, and freshness.
 *
 * @typedef {'cycle1'|'cycle2'} HosRegime
 */

/** Federal south-of-60 daily/shift limits (SOR/2005-313 ss. 12-14). */
export const HOS_LIMITS = Object.freeze({
  DRIVING_MS: 13 * 3600_000,
  ON_DUTY_MS: 14 * 3600_000,
  ELAPSED_WINDOW_MS: 16 * 3600_000, // 16-hour elapsed window
  CORE_REST_MS: 8 * 3600_000, // 8 consecutive hours of core rest
  DAILY_OFF_DUTY_MS: 10 * 3600_000, // 10 hours off duty per day
})

/** Cycle cumulative limits. Cycle 1: 70h/7d. Cycle 2: 120h/14d. */
export const HOS_CYCLES = Object.freeze({
  cycle1: { hours: 70, days: 7, resetMs: 36 * 3600_000 },
  cycle2: { hours: 120, days: 14, resetMs: 72 * 3600_000 },
})

/**
 * The default demonstration detention rule: two hours free time for live FTL,
 * then billable. This is the explicit contract the brief's worked cases assume
 * (119-min visit → 0 billable; 150-min visit → 30 billable before rounding).
 * It is *one* rule, not a universal rate; real contracts are versioned
 * DetentionRule records.
 */
export const DEFAULT_DETENTION_RULE = Object.freeze({
  id: 'demo-ftl-2h',
  contractVersion: 'demo-1',
  freeTimeMs: 2 * 3600_000,
  ratePerHour: 75, // currency units; the demonstration rate
  currency: 'CAD',
  roundingMinutes: 30, // round billable minutes up to half-hour increments
  chargeBoundary: 'service-complete', // chargeable service ends at completion
  freeTimeStart: 'appointment', // free time begins at appointment
  exclusions: ['parking', 'rest', 'carrier-caused', 'transit', 'uncertain'],
})

/**
 * Shipment statuses (the head of the shipment state machine).
 * @typedef {'posted'|'assigned'|'in_progress'|'completed'|'cancelled'} ShipmentStatus
 */
export const SHIPMENT_STATUS = Object.freeze([
  'posted',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
])

/**
 * Stop milestones — the independent visit milestones the plan (§4) requires:
 * arrival, check-in, service start, service completion, delivery, gate-out.
 * A geofence crossing may *support* `arrived`; it must never silently mean
 * `service_completed` or billable.
 *
 * @typedef {'none'|'arrived'|'checked_in'|'service_started'|'service_completed'|'departed'} StopMilestone
 */
export const STOP_MILESTONE = Object.freeze([
  'none',
  'arrived',
  'checked_in',
  'service_started',
  'service_completed',
  'departed',
])

/** Ordered milestone ranks, for predecessor checks. */
export const MILESTONE_RANK = Object.fromEntries(
  STOP_MILESTONE.map((m, i) => [m, i]),
)

/** Assignment statuses. */
export const ASSIGNMENT_STATUS = Object.freeze([
  'offered', // an offer exists, awaiting driver response
  'reserved', // atomically reserved, not yet committed
  'committed', // driver + tractor + trailer committed
  'unassigned', // released
  'conflicted', // lost a reservation race
])

/** Detention claim review states (plan §4 DetentionClaim). */
export const DETENTION_STATE = Object.freeze([
  'eligible', // detected, not yet calculated
  'calculated', // amount computed
  'reviewed', // a reviewer signed off
  'adjusted', // amount manually changed (original preserved)
  'waived', // no charge
  'exported', // sent to billing destination
  'reconciled', // payment reconciled
])

/** Exception case lifecycle. */
export const EXCEPTION_STATE = Object.freeze([
  'open',
  'acknowledged',
  'assigned',
  'resolved',
])

/**
 * Data source labels, carried on every observation so a surface can always state
 * which source is in use (live, cached/stale-last-known, estimated, fixture).
 *
 * @typedef {'live'|'cached'|'estimated'|'fixture'} DataSource
 */
export const DATA_SOURCE = Object.freeze({
  LIVE: 'live',
  CACHED: 'cached',
  ESTIMATED: 'estimated',
  FIXTURE: 'fixture',
})

/**
 * Build an observation envelope carrying full provenance. Every observation —
 * simulated or real — carries provider id, schema version, observed time,
 * received time, source, and an idempotency key so retries cannot create a
 * second visit, assignment, charge, or driver request (plan §3.2, §3.3).
 *
 * @param {object} o
 * @param {string} o.providerId   stable provider/event identifier for dedup
 * @param {number} o.observedAt   when the physical event happened
 * @param {number} [o.receivedAt] when we received it (defaults to observedAt)
 * @param {DataSource} [o.source] live/cached/estimated/fixture
 * @param {string} [o.idempotencyKey] dedup key; defaults to providerId
 */
export function observation({
  providerId,
  observedAt,
  receivedAt,
  source = DATA_SOURCE.LIVE,
  idempotencyKey,
}) {
  if (!providerId) throw new Error('observation requires providerId')
  if (observedAt == null || !Number.isFinite(observedAt)) {
    throw new Error('observation requires a finite observedAt')
  }
  return {
    providerId,
    schemaVersion: SCHEMA_VERSION,
    observedAt,
    receivedAt: receivedAt ?? observedAt,
    source,
    idempotencyKey: idempotencyKey ?? providerId,
  }
}

/**
 * State machine tables. Each transition lists allowed predecessors, required
 * data, idempotency behaviour, and the explicit failure result (plan §5 Phase 0
 * acceptance gate). A transition with no allowed predecessors from the current
 * state is rejected; a missing required field yields `unresolved`.
 *
 * The keys are the *target* status. The value lists the statuses from which the
 * target may be reached.
 */
export const SHIPMENT_TRANSITIONS = Object.freeze({
  posted: [], // created, not a transition
  assigned: ['posted'],
  in_progress: ['assigned'],
  completed: ['in_progress'],
  cancelled: ['posted', 'assigned', 'in_progress'],
})

export const STOP_TRANSITIONS = Object.freeze({
  none: [],
  arrived: ['none'],
  checked_in: ['arrived'],
  service_started: ['checked_in', 'arrived'], // service may start without formal check-in
  service_completed: ['service_started'],
  departed: ['service_completed', 'service_started', 'arrived'], // gate-out may follow any post-arrival milestone
})

export const ASSIGNMENT_TRANSITIONS = Object.freeze({
  offered: [],
  reserved: ['offered'],
  committed: ['reserved'],
  unassigned: ['offered', 'reserved', 'committed'],
  conflicted: ['offered', 'reserved'],
})

export const DETENTION_TRANSITIONS = Object.freeze({
  eligible: [],
  calculated: ['eligible'],
  reviewed: ['calculated'],
  adjusted: ['calculated', 'reviewed'],
  waived: ['calculated', 'reviewed', 'adjusted'],
  exported: ['reviewed', 'adjusted', 'waived'],
  reconciled: ['exported'],
})

export const EXCEPTION_TRANSITIONS = Object.freeze({
  open: [],
  acknowledged: ['open'],
  assigned: ['acknowledged'],
  resolved: ['acknowledged', 'assigned'],
})

/**
 * Is `to` a legal transition from `from` under the given table? `none` is a
 * valid pre-arrival stop status. An unknown current status is never a legal
 * predecessor (unknown is not safe).
 *
 * @param {Object} table one of the *_TRANSITIONS maps
 * @param {string} from current status (use '' or undefined for "none"/initial)
 * @param {string} to target status
 * @returns {boolean}
 */
export function canTransition(table, from, to) {
  const allowed = table[to]
  if (!allowed) return false
  const f = from || 'none'
  return allowed.includes(f)
}

/**
 * Assert a transition is legal, returning a result object instead of throwing
 * so command handlers can produce an explicit failure result.
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function assertTransition(table, from, to) {
  if (canTransition(table, from, to)) return { ok: true }
  return {
    ok: false,
    reason: `illegal transition: ${from || 'none'} -> ${to}`,
  }
}

/**
 * Required fields for each record, so a builder/validator can refuse to
 * construct a record that a downstream decision would treat as complete.
 */
export const REQUIRED_FIELDS = Object.freeze({
  Shipment: ['id', 'kind', 'status', 'stops'],
  Stop: ['id', 'shipmentId', 'sequence', 'role', 'milestone'],
  LoadOffer: ['id', 'shipmentId', 'expiresAt'],
  Assignment: ['id', 'shipmentId', 'version', 'status'],
  FacilityVisit: ['id', 'stopId', 'milestone'],
  DetentionRule: ['id', 'contractVersion', 'freeTimeMs', 'ratePerHour'],
  DetentionClaim: ['id', 'stopId', 'ruleId', 'state'],
  DutySnapshot: ['driverId', 'regime', 'source'],
  VehicleAvailability: ['truckId', 'available', 'reason'],
  RoutePlan: ['id', 'version'],
  ExceptionCase: ['id', 'severity', 'state'],
  TrackingGrant: ['id', 'shipmentId', 'expiresAt'],
})

/**
 * Validate that a record carries every required field for its kind. Returns an
 * explicit failure result (never throws) so command handlers can surface a
 * missing-data reason rather than treating an incomplete record as complete
 * (plan §3.4: "unknown is not safe"; §5 Phase 0: "required data" per record).
 *
 * @param {string} kind  a key in REQUIRED_FIELDS
 * @param {object} record
 * @returns {{ok:boolean, missing?:string[]}}
 */
export function validateRecord(kind, record) {
  const required = REQUIRED_FIELDS[kind]
  if (!required) return { ok: false, missing: [`unknown record kind: ${kind}`] }
  if (!record || typeof record !== 'object') return { ok: false, missing: [...required] }
  const missing = required.filter((f) => record[f] == null || (Array.isArray(record[f]) && record[f].length === 0 && f === 'stops'))
  return missing.length ? { ok: false, missing } : { ok: true }
}
