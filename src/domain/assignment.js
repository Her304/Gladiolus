/**
 * Assignment lifecycle with atomic reservation (Phase 0/4).
 *
 * One shipment cannot be double-booked. Reservation and assignment use atomic
 * version checks: two clients racing to reserve one shipment produce one winner
 * and one visible conflict (plan §3.9, §5 Phase 4 acceptance gate).
 *
 * Every operational command is idempotent: a retry with the same idempotency
 * key does not create a second reservation (plan §3.2).
 */
import {
  EVENT,
  ASSIGNMENT_TRANSITIONS,
  canTransition,
  VERDICT,
} from './contract.js'

/**
 * @typedef {Object} AssignmentRecord
 * @property {string} id
 * @property {string} shipmentId
 * @property {number} version        optimistic-concurrency version
 * @property {string} status         ASSIGNMENT_STATUS
 * @property {string|null} truckId
 * @property {string|null} driverId
 * @property {string|null} actor
 * @property {string|null} idempotencyKey
 */

/**
 * Attempt an atomic reservation. Returns a result object — never throws — so a
 * command handler can produce an explicit failure result with a reason.
 *
 * The version check is the race guard: a reservation against a stale version is
 * rejected as a conflict. A retry with the same idempotency key returns the
 * existing reservation (idempotent).
 *
 * @param {Map<string,AssignmentRecord>} store  shipmentId → current assignment
 * @param {object} attempt
 * @param {string} attempt.shipmentId
 * @param {number} attempt.expectedVersion  the version the client read
 * @param {string} attempt.actor
 * @param {string} attempt.idempotencyKey
 * @returns {{ok:boolean, assignment?:AssignmentRecord, conflict?:boolean, reason?:string}}
 */
export function reserve(store, { shipmentId, expectedVersion, actor, idempotencyKey, truckId }) {
  const existing = store.get(shipmentId)

  // Idempotent retry: same key returns the existing reservation. This MUST
  // precede the version/race checks — a retry carries a stale expectedVersion
  // (the version the client read before its first, successful reserve), and
  // must not be mistaken for a conflicting writer.
  if (existing && idempotencyKey && existing.idempotencyKey === idempotencyKey) {
    return { ok: true, assignment: existing }
  }

  // Race: a different writer already reserved/committed at a later version.
  if (existing && existing.version > expectedVersion) {
    return { ok: false, conflict: true, reason: `version ${existing.version} > expected ${expectedVersion}` }
  }
  // Already committed by someone else.
  if (existing && existing.status === 'committed') {
    return { ok: false, conflict: true, reason: 'shipment already committed' }
  }

  // A posted load with no assignment record is implicitly 'offered' (an open
  // offer exists). Reservation transitions offered→reserved; a reservation
  // against an already-reserved/committed record for a *different* actor is the
  // race caught by the version check above.
  const fromStatus = existing?.status || 'offered'
  const transition = canTransition(ASSIGNMENT_TRANSITIONS, fromStatus, 'reserved')
  if (!transition) {
    return { ok: false, conflict: true, reason: `cannot reserve from ${fromStatus}` }
  }

  const next = {
    id: `ASN-${shipmentId}`,
    shipmentId,
    version: (existing?.version || 0) + 1,
    status: 'reserved',
    truckId: truckId || null,
    driverId: null,
    actor,
    idempotencyKey,
  }
  store.set(shipmentId, next)
  return { ok: true, assignment: next }
}

/**
 * Commit a reservation (driver accepted). Version-checked and idempotent.
 */
export function commit(store, { shipmentId, expectedVersion, actor, idempotencyKey }) {
  const existing = store.get(shipmentId)
  if (existing && idempotencyKey && existing.idempotencyKey === idempotencyKey && existing.status === 'committed') {
    return { ok: true, assignment: existing }
  }
  if (!existing) return { ok: false, reason: 'no reservation' }
  if (existing.version !== expectedVersion) {
    return { ok: false, conflict: true, reason: `version ${existing.version} !== expected ${expectedVersion}` }
  }
  if (!canTransition(ASSIGNMENT_TRANSITIONS, existing.status, 'committed')) {
    return { ok: false, reason: `cannot commit from ${existing.status}` }
  }
  const next = { ...existing, version: existing.version + 1, status: 'committed', actor }
  store.set(shipmentId, next)
  return { ok: true, assignment: next }
}

/**
 * Run two reservation attempts against one shipment — the race acceptance gate.
 * Exactly one wins; the other is a visible conflict.
 *
 * @returns {{winner:AssignmentRecord, loserActor:string, conflictCount:number}}
 */
export function runAssignmentRace(shipmentId, attempts) {
  const store = new Map()
  let winner = null
  let loserActor = null
  let conflictCount = 0
  for (const a of attempts) {
    const res = reserve(store, { shipmentId, expectedVersion: a.version, actor: a.actor, idempotencyKey: `key-${a.actor}`, truckId: a.actor })
    if (res.ok && !winner) {
      winner = res.assignment
    } else if (!res.ok) {
      loserActor = a.actor
      conflictCount++
    }
  }
  return { winner, loserActor, conflictCount }
}
