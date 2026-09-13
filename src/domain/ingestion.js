/**
 * Idempotent observation ingestion (Phase 0/1).
 *
 * Retries must not create a second visit, assignment, charge, or driver request
 * (plan §3.2). Late/out-of-order observations must not regress current state
 * (plan §3.3, §9 edge register: "duplicate or delayed telemetry"). This module
 * is the dedup + ordering layer the old append-only log lacked.
 *
 * It is environment-independent (used by both the server ingestion boundary and
 * headless tests) and wraps any append function.
 */
import { SCHEMA_VERSION } from './contract.js'

/**
 * Create an idempotent ingester. Tracks provider ids already seen so a retry
 * with the same providerId is dropped, not re-applied.
 *
 * @param {function} append  (event) => event  the underlying log append
 * @returns {{ingest:function, seen:Set, dropped:number, applied:number}}
 */
export function createIngester(append) {
  const seen = new Set()
  let dropped = 0
  let applied = 0

  async function ingest(event) {
    const providerId = event.providerId
    if (providerId && seen.has(providerId)) {
      dropped++
      return { ok: false, duplicate: true }
    }
    if (providerId) seen.add(providerId)
    const stamped = {
      schemaVersion: SCHEMA_VERSION,
      observedAt: event.observedAt ?? event.at,
      receivedAt: event.receivedAt ?? Date.now(),
      ...event,
    }
    let result
    try {
      result = await append(stamped)
    } catch (error) {
      // A failed append was not ingested. Allow the provider's retry instead
      // of poisoning the process-local dedup set forever.
      if (providerId) seen.delete(providerId)
      throw error
    }
    // The underlying store may return the event directly (in-memory) or a
    // result envelope { ok, event, duplicate } (durable). Unwrap accordingly.
    if (result && typeof result === 'object' && 'ok' in result) {
      if (result.duplicate) {
        dropped++
        return { ok: false, duplicate: true, event: result.event }
      }
      applied++
      return { ok: true, event: result.event }
    }
    applied++
    return { ok: true, event: result }
  }

  return { ingest, seen, get dropped() { return dropped }, get applied() { return applied } }
}

/**
 * Guard against milestone regression from a stale/late observation. A visit's
 * current milestone must only advance forward; a late 'arrived' must not
 * overwrite a 'service_completed'. Returns true if the event should be applied.
 *
 * @param {string} currentMilestone  current stop milestone ('none' if none)
 * @param {object} event             the incoming event
 * @returns {boolean} whether to apply the event
 */
export function shouldApplyMilestone(currentMilestone, event) {
  const rank = { none: 0, arrived: 1, checked_in: 2, service_started: 3, service_completed: 4, departed: 5 }
  const target = milestoneFromType(event.type)
  if (!target) return true // non-milestone events always apply
  return (rank[target] || 0) > (rank[currentMilestone] || 0)
}

function milestoneFromType(type) {
  const map = {
    'stop.arrived': 'arrived',
    'stop.checked_in': 'checked_in',
    'stop.service_started': 'service_started',
    'stop.service_completed': 'service_completed',
    'stop.departed': 'departed',
  }
  return map[type] || null
}
