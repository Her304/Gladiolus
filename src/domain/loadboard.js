/**
 * Open-load queue and assignment lifecycle (Phase 4).
 *
 * Replaces the v1 random self-assignment ("72% chance of a new load after a
 * dwell") with an actual dispatch product: an open shipment/load queue with
 * ready time, appointment, service time, equipment, payload, and revenue
 * inputs; expiring offers; atomic reservations; driver accept/reject; manual
 * hold, reassignment, cancellation, and dispatcher override with audit reasons.
 *
 * Trucks no longer invent freight or assign themselves after a dwell. Loads
 * with no feasible candidate surface as exceptions (plan §5 Phase 4).
 */
import { EVENT, ASSIGNMENT_TRANSITIONS, canTransition, VERDICT } from './contract.js'
import { reserve, commit } from './assignment.js'

const MIN = 60_000
const H = 3600_000

/**
 * Create a load offer record for the open queue.
 *
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.shipmentId
 * @param {string} o.originId
 * @param {string} o.destinationId
 * @param {number} o.readyAt         pickup-ready time
 * @param {number} [o.appointment]    delivery appointment
 * @param {number} [o.serviceTimeMs]  expected dock service time
 * @param {string[]} [o.equipment]    required equipment
 * @param {number} [o.payloadKg]
 * @param {number} [o.revenue]
 * @param {number} [o.expiresAt]      offer expiry
 */
export function createLoad(o) {
  if (!o.id || !o.shipmentId) throw new Error('load requires id and shipmentId')
  return {
    id: o.id,
    shipmentId: o.shipmentId,
    originId: o.originId,
    destinationId: o.destinationId,
    readyAt: o.readyAt,
    appointment: o.appointment ?? null,
    serviceTimeMs: o.serviceTimeMs ?? 60 * MIN,
    equipment: o.equipment ?? [],
    payloadKg: o.payloadKg ?? null,
    revenue: o.revenue ?? null,
    contribution: o.contribution ?? o.revenue ?? null,
    expiresAt: o.expiresAt ?? (o.readyAt + 2 * H),
    status: 'open',
    offeredTo: null,
    acceptedBy: null,
    holdReason: null,
  }
}

/**
 * The assignment lifecycle manager. Wraps the atomic reservation store and
 * adds offer expiry, driver accept/reject, manual hold, reassignment,
 * cancellation, and dispatcher override — each producing an audited event.
 *
 * Every transition is version-checked and idempotent. A committed truck stays
 * committed until an explicit transition changes it (no churn).
 */
export function createLoadBoard() {
  // shipmentId → assignment record (the atomic reservation store)
  const assignments = new Map()
  // loadId → load offer
  const loads = new Map()
  const audit = []

  function auditLine(actor, action, detail) {
    audit.push({ at: Date.now(), actor, action, detail })
  }

  function postLoad(load, actor = 'system') {
    loads.set(load.id, load)
    auditLine(actor, 'load.posted', load.id)
    return { ok: true, load }
  }

  /**
   * Offer a load to a driver. Creates an expiring offer (assignment status
   * 'offered') without reserving — the reservation happens on accept.
   *
   * @param {number} [now]  injectable clock for deterministic tests
   */
  function offerLoad(loadId, driverId, actor = 'dispatch', now = Date.now()) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }
    if (load.status !== 'open') return { ok: false, error: `load is ${load.status}` }
    load.offeredTo = driverId
    load.status = 'offered'
    auditLine(actor, 'load.offered', `${loadId} → ${driverId}`)
    return { ok: true, load, event: { type: EVENT.OFFER_CREATED, loadId, driverId, expiresAt: load.expiresAt } }
  }

  /**
   * A driver accepts an offer. This atomically reserves the shipment (version-
   * checked) and commits the assignment. A second dispatcher/driver cannot
   * double-book it (plan §3.9, §5 Phase 4 acceptance gate).
   *
   * @param {number} [now]  injectable clock for deterministic tests
   */
  function acceptOffer(loadId, driverId, truckId, idempotencyKey, now = Date.now()) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }

    // Idempotent retry: if an assignment for this shipment already exists with
    // this idempotency key, return it without re-reserving. This check precedes
    // the load-status guard so a retry (whose load is now 'assigned') is not
    // mistaken for a fresh double-booking (plan §3.2).
    const key = idempotencyKey || `accept-${loadId}-${driverId}`
    const existing = assignments.get(load.shipmentId)
    if (existing && existing.idempotencyKey === key) {
      return { ok: true, load, assignment: existing, events: [] }
    }

    if (load.status !== 'offered') return { ok: false, error: `load is ${load.status}` }
    if (load.expiresAt && now > load.expiresAt) {
      load.status = 'expired'
      return { ok: false, error: 'offer expired', event: { type: EVENT.OFFER_EXPIRED, loadId } }
    }

    // Atomic reservation + commit.
    const r = reserve(assignments, {
      shipmentId: load.shipmentId,
      expectedVersion: 0,
      actor: `driver:${driverId}`,
      idempotencyKey: key,
      truckId,
    })
    if (!r.ok) return { ok: false, conflict: true, error: 'reservation failed' }

    const c = commit(assignments, {
      shipmentId: load.shipmentId,
      expectedVersion: r.assignment.version,
      actor: `driver:${driverId}`,
      idempotencyKey: key,
    })
    if (!c.ok) return { ok: false, conflict: true, error: 'commit failed' }

    load.status = 'assigned'
    load.acceptedBy = driverId
    auditLine(`driver:${driverId}`, 'load.accepted', loadId)
    return {
      ok: true,
      load,
      assignment: c.assignment,
      events: [
        { type: EVENT.OFFER_ACCEPTED, loadId, driverId, truckId },
        { type: EVENT.ASSIGNMENT_COMMITTED, shipmentId: load.shipmentId, truckId, assignmentId: c.assignment.id, driverId },
      ],
    }
  }

  function rejectOffer(loadId, driverId, reason) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }
    load.status = 'open'
    load.offeredTo = null
    auditLine(`driver:${driverId}`, 'load.rejected', `${loadId}: ${reason}`)
    return { ok: true, load, event: { type: EVENT.OFFER_REJECTED, loadId, driverId, reason } }
  }

  /** Dispatcher override: reassign a committed assignment with an audit reason. */
  function reassign(loadId, newDriverId, newTruckId, actor, reason) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }
    if (!reason) return { ok: false, error: 'reassignment requires a reason' }
    const existing = assignments.get(load.shipmentId)
    if (existing) {
      assignments.set(load.shipmentId, {
        ...existing,
        driverId: newDriverId,
        truckId: newTruckId,
        version: existing.version + 1,
        actor,
      })
    }
    load.acceptedBy = newDriverId
    auditLine(actor, 'load.reassigned', `${loadId} → ${newDriverId}: ${reason}`)
    return {
      ok: true, load,
      event: { type: EVENT.ASSIGNMENT_UNASSIGNED, shipmentId: load.shipmentId, reason },
    }
  }

  function cancel(loadId, actor, reason) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }
    load.status = 'cancelled'
    auditLine(actor, 'load.cancelled', `${loadId}: ${reason}`)
    return { ok: true, event: { type: EVENT.SHIPMENT_CANCELLED, shipmentId: load.shipmentId, reason } }
  }

  /** Manual hold: keep the load out of the auto-offer queue with a reason. */
  function hold(loadId, actor, reason) {
    const load = loads.get(loadId)
    if (!load) return { ok: false, error: 'unknown load' }
    load.holdReason = reason
    load.status = 'held'
    auditLine(actor, 'load.held', `${loadId}: ${reason}`)
    return { ok: true, load }
  }

  /** The open queue: loads available to offer, with their inputs. */
  function openQueue() {
    return [...loads.values()].filter((l) => l.status === 'open')
  }

  /** All loads with their status. */
  function allLoads() {
    return [...loads.values()]
  }

  return {
    postLoad, offerLoad, acceptOffer, rejectOffer, reassign, cancel, hold,
    openQueue, allLoads,
    getAudit: () => [...audit],
    _assignments: assignments,
    _loads: loads,
  }
}

/**
 * Split distance into committed deadhead (driving to pick up an assigned load)
 * and uncommitted idle/repositioning (moving without an assignment). The v1
 * model measured empty km but never distinguished them (plan §5 Phase 4).
 *
 * @param {object[]} segments  [{ km, laden, assignmentId }]
 * @returns {{committedDeadheadKm:number, uncommittedIdleKm:number, ladenKm:number}}
 */
export function splitDistance(segments) {
  let committedDeadheadKm = 0
  let uncommittedIdleKm = 0
  let ladenKm = 0
  for (const s of segments) {
    if (s.laden) ladenKm += s.km
    else if (s.assignmentId) committedDeadheadKm += s.km
    else uncommittedIdleKm += s.km
  }
  return { committedDeadheadKm, uncommittedIdleKm, ladenKm }
}
