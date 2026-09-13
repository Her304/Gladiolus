/**
 * Deterministic domain fixtures (Phase 0).
 *
 * These are environment-independent (no React, no wall clock): every scenario
 * carries an explicit fixed `clock` so tests are reproducible. Each fixture
 * answers one of the operational edge cases the assessment identified as unsafe
 * or unimplemented (corridor-project-change-plan.md §5 Phase 0):
 *
 *   normal delivery, 119-min dwell, 150-min dwell, early arrival, waiver,
 *   dock HOS expiry, closure, major defect, duplicate event, delayed event,
 *   assignment race, missing/stale HOS.
 *
 * A fixture is a sequence of v2 events plus an expectation of what the
 * decision/result *should* be. The failing tests in `test/` drive these
 * against the current (unsafe) code to reproduce the cases, and later phases
 * make them pass.
 */
import { EVENT, DEFAULT_DETENTION_RULE, HOS_LIMITS } from './contract.js'

/** Fixed epoch for all fixtures: 2026-09-13T13:00:00Z. Never use Date.now(). */
export const T0 = Date.UTC(2026, 8, 13, 13, 0, 0)
const MIN = 60_000
const H = 3600_000

/** A stable Milton-to-London FTL shipment used by several scenarios. */
export const MILTON_LONDON = Object.freeze({
  shipmentId: 'SHP-9001',
  pickupStopId: 'STP-pu',
  deliveryStopId: 'STP-dl',
  truckId: 'GLD-101',
  driverId: 'D-101',
  tractorId: 'GLD-101',
  trailerId: 'TRL-201',
  loadId: 'L-9001',
  assignmentId: 'ASN-9001',
  offerId: 'OFR-9001',
  facilityId: 'london-dc',
  originId: 'milton-intermodal',
})

/** Two hours free time, the demonstration FTL rule. */
export const RULE = DEFAULT_DETENTION_RULE

/**
 * Normal delivery: pickup → drive → arrive → check-in → service → complete →
 * depart, within free time. Expect zero billable detention and a completed
 * shipment.
 */
export function normalDelivery() {
  const t = T0
  return {
    name: 'normal-delivery',
    clock: t + 3 * H,
    events: [
      { type: EVENT.SHIPMENT_POSTED, at: t, shipmentId: MILTON_LONDON.shipmentId, kind: 'ftl', stops: [MILTON_LONDON.pickupStopId, MILTON_LONDON.deliveryStopId] },
      { type: EVENT.STOP_ARRIVED, at: t + 2 * H, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId },
      { type: EVENT.STOP_CHECKED_IN, at: t + 2 * H + 5 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_STARTED, at: t + 2 * H + 10 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_COMPLETED, at: t + 2 * H + 70 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_DEPARTED, at: t + 2 * H + 75 * MIN, stopId: MILTON_LONDON.deliveryStopId },
    ],
    expect: { billableMinutes: 0, shipmentStatus: 'completed' },
  }
}

/**
 * 119-minute qualifying visit: exactly one minute under the two-hour free time.
 * Expect ZERO billable time. (Assessment acceptance scenario 1.)
 */
export function dwell119() {
  const t = T0
  const arrive = t + 2 * H
  return {
    name: 'dwell-119',
    clock: arrive + 119 * MIN,
    events: [
      { type: EVENT.STOP_ARRIVED, at: arrive, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId },
      { type: EVENT.STOP_CHECKED_IN, at: arrive + 5 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_STARTED, at: arrive + 10 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_COMPLETED, at: arrive + 119 * MIN, stopId: MILTON_LONDON.deliveryStopId },
    ],
    expect: { billableMinutes: 0 },
  }
}

/**
 * 150-minute qualifying visit: 30 minutes past the two-hour free time, before
 * rounding. Expect 30 billable minutes (before the 30-min rounding rule).
 */
export function dwell150() {
  const t = T0
  const arrive = t + 2 * H
  return {
    name: 'dwell-150',
    clock: arrive + 150 * MIN,
    events: [
      { type: EVENT.STOP_ARRIVED, at: arrive, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId },
      { type: EVENT.STOP_CHECKED_IN, at: arrive + 5 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_STARTED, at: arrive + 10 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_COMPLETED, at: arrive + 150 * MIN, stopId: MILTON_LONDON.deliveryStopId },
    ],
    expect: { billableMinutes: 30 },
  }
}

/** Early arrival 60 min before appointment; free time starts at appointment. */
export function earlyArrival() {
  const t = T0
  const appointment = t + 2 * H
  const arrive = appointment - 60 * MIN
  return {
    name: 'early-arrival',
    clock: arrive + 150 * MIN, // 90 min after appointment start
    events: [
      { type: EVENT.STOP_ARRIVED, at: arrive, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId },
      { type: EVENT.STOP_CHECKED_IN, at: arrive + 5 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_STARTED, at: appointment + 10 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      { type: EVENT.STOP_SERVICE_COMPLETED, at: appointment + 90 * MIN, stopId: MILTON_LONDON.deliveryStopId },
    ],
    expect: { billableMinutes: 0 }, // 90 min of service from appointment, under 120 free
  }
}

/** An approved waiver: a 150-min visit produces zero charge after waiver. */
export function waiver() {
  const f = dwell150()
  return {
    ...f,
    name: 'waiver',
    events: [
      ...f.events,
      { type: EVENT.DETENTION_CALCULATED, at: f.clock, claimId: 'CLM-1', stopId: MILTON_LONDON.deliveryStopId, billableMinutes: 30 },
      { type: EVENT.DETENTION_WAIVED, at: f.clock + MIN, claimId: 'CLM-1', actor: 'billing', reason: 'customer goodwill' },
    ],
    expect: { billableMinutes: 0, state: 'waived' },
  }
}

/**
 * Dock HOS expiry: the brief's exact edge case. A driver whose duty allowance
 * expires at the dock must NOT move afterward. The current simulator checks HOS
 * *after* driving and lets the truck roll ~375m before a forced stop.
 */
export function dockHosExpiry() {
  const t = T0
  const arrive = t + 2 * H
  return {
    name: 'dock-hos-expiry',
    clock: arrive + 30 * MIN,
    truck: {
      id: MILTON_LONDON.truckId,
      // Duty expires *during* the dock wait. drivingMs and onDutyMs both near
      // their limits so the pre-movement guard must fire.
      drivingMs: HOS_LIMITS.DRIVING_MS - 5 * MIN,
      onDutyMs: HOS_LIMITS.ON_DUTY_MS - 5 * MIN,
      state: 'dwelling',
      insideSiteId: MILTON_LONDON.facilityId,
    },
    events: [
      { type: EVENT.STOP_ARRIVED, at: arrive, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId },
      { type: EVENT.STOP_SERVICE_STARTED, at: arrive + 10 * MIN, stopId: MILTON_LONDON.deliveryStopId },
      // 30 min later, duty has expired at the dock.
      { type: EVENT.DUTY_UPDATED, at: arrive + 30 * MIN, truckId: MILTON_LONDON.truckId, drivingMs: HOS_LIMITS.DRIVING_MS, onDutyMs: HOS_LIMITS.ON_DUTY_MS },
    ],
    expect: { blocksMovement: true },
  }
}

/** A full mainline closure makes the route edge impassable (not just slow). */
export function closure() {
  return {
    name: 'closure',
    clock: T0,
    route: {
      edges: [
        { id: 'e1', from: 'milton', to: 'london', closed: true, closureKind: 'mainline' },
      ],
    },
    expect: { routeImpassable: true },
  }
}

/** A major defect must prevent movement and assignment until resolved. */
export function majorDefect() {
  const t = T0
  return {
    name: 'major-defect',
    clock: t,
    truck: {
      id: MILTON_LONDON.truckId,
      state: 'driving',
    },
    events: [
      { type: EVENT.VEHICLE_BLOCKED, at: t, truckId: MILTON_LONDON.truckId, reason: 'major-defect', category: 'air-brake' },
    ],
    expect: { blocksMovement: true, blocksAssignment: true },
  }
}

/**
 * Duplicate event: the same provider/event id appended twice must not create a
 * second visit, assignment, or charge. Idempotent by provider key.
 */
export function duplicateEvent() {
  const t = T0
  const prov = 'prov-arrive-1'
  const base = { type: EVENT.STOP_ARRIVED, at: t, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId, providerId: prov, observedAt: t }
  return {
    name: 'duplicate-event',
    clock: t + MIN,
    events: [base, { ...base, receivedAt: t + MIN }], // same providerId, late receipt
    expect: { visitCount: 1 },
  }
}

/**
 * Delayed (out-of-order) event: a late-arriving observation must not regress the
 * current milestone. A 'departed' must not be overwritten by a stale 'arrived'.
 */
export function delayedEvent() {
  const t = T0
  const arrive = t + 2 * H
  return {
    name: 'delayed-event',
    clock: arrive + 80 * MIN,
    events: [
      { type: EVENT.STOP_ARRIVED, at: arrive, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId, providerId: 'p-arr', observedAt: arrive, receivedAt: arrive + 5 * MIN },
      { type: EVENT.STOP_SERVICE_COMPLETED, at: arrive + 70 * MIN, stopId: MILTON_LONDON.deliveryStopId, providerId: 'p-svc', observedAt: arrive + 70 * MIN, receivedAt: arrive + 70 * MIN },
      // Stale 'arrived' arrives late — must NOT regress to 'arrived'.
      { type: EVENT.STOP_ARRIVED, at: arrive + 1 * MIN, stopId: MILTON_LONDON.deliveryStopId, truckId: MILTON_LONDON.truckId, providerId: 'p-arr-late', observedAt: arrive + 1 * MIN, receivedAt: arrive + 75 * MIN },
    ],
    expect: { finalMilestone: 'service_completed' },
  }
}

/**
 * Assignment race: two dispatchers reserve one shipment. Only one wins; the
 * other gets a visible conflict. Atomic version checks.
 */
export function assignmentRace() {
  const t = T0
  return {
    name: 'assignment-race',
    clock: t + MIN,
    shipmentId: MILTON_LONDON.shipmentId,
    attempts: [
      { actor: 'dispatch-A', version: 1 },
      { actor: 'dispatch-B', version: 1 }, // same base version → race
    ],
    expect: { winners: 1, conflicts: 1 },
  }
}

/**
 * Missing/stale HOS: a driver with no duty history must yield UNRESOLVED, never
 * feasible. The current two-counter helper defaults missing counters to zero,
 * producing 13h available / status 'ok'.
 */
export function missingHos() {
  const t = T0
  return {
    name: 'missing-hos',
    clock: t,
    truck: {
      id: MILTON_LONDON.truckId,
      // No drivingMs/onDutyMs at all — unknown history.
      drivingMs: undefined,
      onDutyMs: undefined,
    },
    expect: { verdict: 'unresolved' },
  }
}

export const ALL_FIXTURES = [
  normalDelivery,
  dwell119,
  dwell150,
  earlyArrival,
  waiver,
  dockHosExpiry,
  closure,
  majorDefect,
  duplicateEvent,
  delayedEvent,
  assignmentRace,
  missingHos,
]
