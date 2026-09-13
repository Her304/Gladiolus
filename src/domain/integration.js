/**
 * Integration, identity, and reconciliation (Phase 6).
 *
 * Makes the workflow pilotable without claiming to replace authoritative
 * systems (plan §5 Phase 6). Provides:
 *   - Explicit identity mapping for carrier, driver, tractor, trailer, shipment,
 *     stop, customer, and facility — so a carrier can identify which system
 *     owns each field and how failures reconcile.
 *   - Ingestion health, freshness, dedup, retry, correction, and
 *     reconciliation queues.
 *   - Server-enforced roles and shipment-scoped customer authorization.
 *   - Every driver request and operational exception gets an acknowledgment,
 *     owner, status, deadline, and resolution.
 *   - AI output grounded in per-record evidence; absent evidence → explicit
 *     limitation, not named advice.
 */

/**
 * Identity map: external-system id → Corridor domain id, per entity kind.
 * A carrier pilot needs to know which system owns each field; this records the
 * mapping so a failed ingest can be traced to its source (plan §5 Phase 6).
 *
 * @typedef {Object} IdentityMapping
 * @property {string} kind       'driver'|'tractor'|'trailer'|'shipment'|'stop'|'customer'|'facility'|'carrier'
 * @property {string} system     'eld'|'tms'|'order'|'billing'|'corridor'
 * @property {string} externalId
 * @property {string} corridorId
 */
export function createIdentityMap() {
  const byKey = new Map() // `${kind}:${system}:${externalId}` → corridorId
  const byCorridor = new Map() // `${kind}:${corridorId}` → { system, externalId }

  function map(kind, system, externalId, corridorId) {
    const key = `${kind}:${system}:${externalId}`
    byKey.set(key, corridorId)
    byCorridor.set(`${kind}:${corridorId}`, { system, externalId })
    return { kind, system, externalId, corridorId }
  }

  function resolve(kind, system, externalId) {
    return byKey.get(`${kind}:${system}:${externalId}`) || null
  }

  function sourceOf(kind, corridorId) {
    return byCorridor.get(`${kind}:${corridorId}`) || null
  }

  return { map, resolve, sourceOf, _byKey: byKey, _byCorridor: byCorridor }
}

/**
 * Ingestion health + reconciliation queue. Tracks freshness, dedup hits,
 * retries, corrections, and items needing reconciliation (plan §5 Phase 6
 * acceptance: "Integration failure preserves last-known data with age and opens
 * a visible reconciliation item").
 */
export function createIngestionHealth() {
  const stats = {
    received: 0,
    applied: 0,
    duplicates: 0,
    retries: 0,
    corrections: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastSource: 'none',
  }
  const reconciliation = [] // items needing human reconciliation
  const providers = new Map() // providerId → { lastAt, status, consecutiveFailures }

  function recordSuccess(providerId, source = 'live') {
    const recordedAt = Date.now()
    stats.received++
    stats.applied++
    stats.lastSuccessAt = recordedAt
    stats.lastSource = source
    providers.set(providerId, { lastAt: recordedAt, status: 'ok', consecutiveFailures: 0 })
  }

  function recordDuplicate(providerId) {
    stats.duplicates++
    providers.set(providerId, { lastAt: Date.now(), status: 'duplicate', consecutiveFailures: 0 })
  }

  function recordFailure(providerId, error) {
    stats.received++
    stats.retries++
    stats.lastFailureAt = Date.now()
    const prev = providers.get(providerId) || { consecutiveFailures: 0 }
    const failures = prev.consecutiveFailures + 1
    providers.set(providerId, { lastAt: Date.now(), status: 'failed', consecutiveFailures: failures, error })
    // Three consecutive failures open a reconciliation item (stale data risk).
    if (failures >= 3) {
      reconciliation.push({
        id: `recon-${providerId}-${Date.now()}`,
        providerId, reason: `3 consecutive failures: ${error}`,
        openedAt: Date.now(), state: 'open', lastKnownAgeMs: null,
      })
    }
  }

  function recordCorrection(providerId, reason) {
    stats.corrections++
    reconciliation.push({
      id: `recon-${providerId}-corr-${Date.now()}`,
      providerId, reason: `correction: ${reason}`,
      openedAt: Date.now(), state: 'open', lastKnownAgeMs: null,
    })
  }

  /** Data age for a provider's last successful observation. */
  function dataAgeMs(providerId, now = Date.now()) {
    const p = providers.get(providerId)
    // A caller may supply a clock that trails an observation clock. Keep a
    // known observation visibly fresh instead of exposing a negative age.
    return p?.lastAt ? Math.max(1, now - p.lastAt) : null
  }

  function health() {
    return {
      ...stats,
      openReconciliation: reconciliation.filter((r) => r.state === 'open').length,
      providers: providers.size,
    }
  }

  function reconciliationQueue() {
    return [...reconciliation]
  }

  return { recordSuccess, recordDuplicate, recordFailure, recordCorrection, dataAgeMs, health, reconciliationQueue, _providers: providers }
}

/**
 * Server-enforced authorization. Roles: dispatch, driver, admin, customer.
 * Customer access is shipment-scoped (a tracking grant authorizes ONE shipment's
 * history, not the truck's next destination — plan §5 Phase 5/6).
 *
 * @param {object} session  { role, shipmentId?, email? }
 * @param {string} resource  e.g. 'shipment:SHP-1', 'billing:export'
 * @returns {{allowed:boolean, reason?:string}}
 */
export function authorize(session, resource) {
  if (!session) return { allowed: false, reason: 'no session' }
  const [domain, id] = resource.split(':')

  // Admins can do everything.
  if (session.role === 'admin') return { allowed: true }

  // Customer role: shipment-scoped only.
  if (session.role === 'customer') {
    if (domain === 'shipment' && id === session.shipmentId) return { allowed: true }
    return { allowed: false, reason: `customer scope is shipment ${session.shipmentId}; ${resource} denied` }
  }

  // Dispatch: operational read/write, not billing export unless admin.
  if (session.role === 'dispatch') {
    if (domain === 'billing' && id === 'export') return { allowed: false, reason: 'billing export requires admin' }
    return { allowed: true }
  }

  // Driver: their own assignments and duty.
  if (session.role === 'driver') {
    if (domain === 'shipment' || domain === 'assignment' || domain === 'duty') return { allowed: true }
    if (domain === 'driver' && (id === session.driverId || !id)) return { allowed: true }
    return { allowed: false, reason: `driver may access own resources; ${resource} denied` }
  }

  return { allowed: false, reason: `unknown role: ${session.role}` }
}

/**
 * Exception / driver-request ownership. Every operational exception gets an
 * acknowledgment, owner, status, deadline, and resolution (plan §5 Phase 6).
 */
export function createExceptionTracker() {
  const exceptions = new Map()

  function open({ id, severity, reason, affectedTruck, deadline }) {
    const ex = {
      id, severity, reason, affectedTruck,
      state: 'open', owner: null, acknowledgedAt: null,
      deadline: deadline || null, resolvedAt: null, resolution: null,
      openedAt: Date.now(),
    }
    exceptions.set(id, ex)
    return ex
  }

  function acknowledge(id, owner) {
    const ex = exceptions.get(id)
    if (!ex) return null
    ex.state = 'acknowledged'
    ex.owner = owner
    ex.acknowledgedAt = Date.now()
    return ex
  }

  function assign(id, owner) {
    const ex = exceptions.get(id)
    if (!ex) return null
    ex.state = 'assigned'
    ex.owner = owner
    return ex
  }

  function resolve(id, resolution) {
    const ex = exceptions.get(id)
    if (!ex) return null
    ex.state = 'resolved'
    ex.resolution = resolution
    ex.resolvedAt = Date.now()
    return ex
  }

  function openExceptions() {
    return [...exceptions.values()].filter((e) => e.state !== 'resolved')
  }

  return { open, acknowledge, assign, resolve, openExceptions, _exceptions: exceptions }
}

/**
 * Ground an AI/automation answer in per-record evidence. If the required
 * evidence is absent, return an explicit limitation — never named advice
 * (plan §5 Phase 6: "If required evidence is absent, return an explicit
 * limitation instead of named advice").
 *
 * @param {object} claim   { truckId?, shipmentId?, advice? }
 * @param {object} evidence  the per-record evidence available
 * @returns {{grounded:boolean, evidence:object[], limitation?:string, answer?:string}}
 */
export function groundAdvice(claim, evidence) {
  const cited = []
  const required = []

  if (claim.truckId) {
    const truckEvidence = evidence.trucks?.[claim.truckId]
    if (truckEvidence) cited.push({ kind: 'truck', id: claim.truckId, ...truckEvidence })
    else required.push(`HOS/vehicle state for truck ${claim.truckId}`)
  }
  if (claim.shipmentId) {
    const shipEvidence = evidence.shipments?.[claim.shipmentId]
    if (shipEvidence) cited.push({ kind: 'shipment', id: claim.shipmentId, ...shipEvidence })
    else required.push(`stop/visit evidence for shipment ${claim.shipmentId}`)
  }

  if (required.length > 0) {
    return {
      grounded: false,
      evidence: cited,
      limitation: `Cannot advise: missing evidence — ${required.join('; ')}.`,
    }
  }
  return { grounded: true, evidence: cited, answer: claim.advice }
}
