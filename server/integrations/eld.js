/**
 * ELD integration adapter (Phase F).
 *
 * Ingests duty-status changes and GPS position pings from an ELD provider.
 * Maps external driver/vehicle ids to Corridor ids via the identity map, and
 * writes `duty.updated` + `truck.ping` events through the idempotent ingestion
 * boundary. Pings carry the active shipmentId (resolved from the current
 * assignment) so the customer portal's shipment-scoped stream receives them.
 *
 * This is a sample implementation against a representative ELD webhook shape.
 * A real Geotab/Samsara/Omnitracs integration fills in `poll()` with the
 * vendor's REST API and `ingest()` with the vendor's webhook payload shape —
 * the interface stays the same.
 */
import { createAdapterBase } from './adapter.js'
import { EVENT, DEFAULT_DETENTION_RULE } from '../../src/domain/contract.js'
import { transition } from '../../src/engine/geofence.js'

/**
 * @param {object} deps  { ingester, identityMap, health, loadBoard }
 */
export function createEldAdapter({ ingester, identityMap, health, loadBoard, store, persistIdentity }) {
  const base = createAdapterBase({ ingester, identityMap, health, persistIdentity })
  const fenceState = new Map()
  let hydratePromise = null

  async function hydrateFenceState() {
    if (!hydratePromise) hydratePromise = (async () => {
      const events = await store.all()
      for (const e of events) {
        if (e.type === EVENT.FENCE_ENTER) {
          const load = activeLoadFor(e.truckId)
          fenceState.set(e.truckId, {
            siteId: e.siteId, enteredAt: e.observedAt ?? e.at,
            shipmentId: e.shipmentId || null, stopId: e.stopId || e.siteId,
            intended: e.intended ?? Boolean(load && [load.originId, load.destinationId].includes(e.siteId)),
          })
        } else if (e.type === EVENT.FENCE_EXIT) {
          fenceState.delete(e.truckId)
        }
      }
    })()
    return hydratePromise
  }

  /**
   * Resolve the active shipmentId for a truck from the loadboard (the truck's
   * current committed assignment). Returns null if the truck is empty/
   * repositioning — the customer stream then goes quiet for that truck.
   */
  function activeLoadFor(truckId) {
    const loads = loadBoard.allLoads()
    for (const l of loads) {
      if (l.acceptedTruckId === truckId && l.status === 'assigned') return l
    }
    return null
  }

  /** Ingest a single ELD observation (duty or position). */
  async function ingestOne(obs) {
    await hydrateFenceState()
    // Map external driver id → Corridor driver id.
    const driverId = obs.driverId || base.resolve('driver', 'eld', obs.eldDriverId)
    const truckId = obs.truckId || base.resolve('tractor', 'eld', obs.eldVehicleId)
    if (!driverId && !truckId) return { ok: false, error: 'no driver or truck id' }

    const observedAt = obs.timestamp || obs.observedAt || Date.now()
    const events = []

    // Duty-status observation → duty.updated (the shape hosFeasibility expects).
    if (obs.dutyStatus || obs.drivingMs != null) {
      events.push({
        type: EVENT.DUTY_UPDATED,
        observedAt,
        receivedAt: Date.now(),
        providerId: `eld:duty:${driverId}:${observedAt}`,
        source: 'eld',
        driverId,
        truckId,
        drivingMs: obs.drivingMs,
        onDutyMs: obs.onDutyMs,
        elapsedMs: obs.elapsedMs,
        cycleMs: obs.cycleMs,
        dailyOffDutyMs: obs.dailyOffDutyMs,
        regime: obs.regime || 'cycle1',
        dutyStatus: obs.dutyStatus,
      })
    }

    // Position observations drive both tracking and the same geofence/visit
    // state machine used by simulation. Turning off RUN_SIM therefore does not
    // turn off automatic visit or detention detection.
    if (obs.coord || (obs.latitude != null && obs.longitude != null)) {
      const coord = obs.coord || [Number(obs.latitude), Number(obs.longitude)]
      const load = activeLoadFor(truckId)
      const shipmentId = obs.shipmentId ?? load?.shipmentId ?? null
      events.push({
        type: EVENT.TRUCK_PING,
        observedAt,
        receivedAt: Date.now(),
        providerId: `eld:ping:${truckId}:${observedAt}`,
        source: 'eld',
        truckId,
        shipmentId,
        truck: {
          id: truckId, driverId, coord,
          speedKph: obs.speedKph ?? 0,
          odometerKm: obs.odometerKm,
          drivingMs: obs.drivingMs,
          onDutyMs: obs.onDutyMs,
          elapsedMs: obs.elapsedMs,
          cycleMs: obs.cycleMs,
          dailyOffDutyMs: obs.dailyOffDutyMs,
          regime: obs.regime || 'cycle1',
          equipment: obs.equipment,
          tareKg: obs.tareKg,
          grossLimitKg: obs.grossLimitKg,
          axleLimitsKg: obs.axleLimitsKg,
          axleWeightsKg: obs.axleWeightsKg,
          state: obs.dutyStatus === 'driving' ? 'driving' : 'dwelling',
        },
      })

      const previous = fenceState.get(truckId)
      const crossing = transition(previous?.siteId || null, coord)
      if (crossing.kind === 'enter') {
        const stopId = obs.stopId || crossing.site.id
        const intended = Boolean(load && [load.originId, load.destinationId].includes(crossing.site.id))
        const visit = { siteId: crossing.site.id, enteredAt: observedAt, shipmentId, stopId, intended }
        fenceState.set(truckId, visit)
        events.push({
          type: EVENT.FENCE_ENTER, observedAt, receivedAt: Date.now(),
          providerId: `eld:fence-enter:${truckId}:${crossing.site.id}:${observedAt}`,
          source: 'eld', truckId, shipmentId, stopId, siteId: crossing.site.id,
          siteName: crossing.site.name, intended,
        })
        if (crossing.site.kind === 'stop' && shipmentId && intended) {
          events.push({
            type: EVENT.STOP_ARRIVED, observedAt, receivedAt: Date.now(),
            providerId: `eld:stop-arrived:${truckId}:${shipmentId}:${stopId}:${observedAt}`,
            source: 'eld-geofence', truckId, shipmentId, stopId,
            facilityId: crossing.site.id, evidence: 'gps-geofence-entry',
          })
        }
      } else if (crossing.kind === 'exit' && previous) {
        const dwellMs = Math.max(0, observedAt - previous.enteredAt)
        events.push({
          type: EVENT.FENCE_EXIT, observedAt, receivedAt: Date.now(),
          providerId: `eld:fence-exit:${truckId}:${previous.siteId}:${observedAt}`,
          source: 'eld', truckId, shipmentId: previous.shipmentId || shipmentId,
          stopId: previous.stopId, siteId: previous.siteId, dwellMin: dwellMs / 60_000,
        })
        if (previous.shipmentId && previous.intended) {
          // A geofence exit proves gate-out. In the absence of a driver service
          // confirmation, use that exact GPS timestamp as an explicitly
          // inferred service boundary so the claim is automatic but reviewable.
          events.push({
            type: EVENT.STOP_SERVICE_COMPLETED, observedAt, receivedAt: Date.now(),
            providerId: `eld:stop-complete:${truckId}:${previous.shipmentId}:${previous.stopId}:${observedAt}`,
            source: 'eld-geofence', truckId, shipmentId: previous.shipmentId,
            stopId: previous.stopId, facilityId: previous.siteId,
            evidence: 'gps-geofence-exit', inferred: true,
          })
          events.push({
            type: EVENT.STOP_DEPARTED, observedAt, receivedAt: Date.now(),
            providerId: `eld:stop-departed:${truckId}:${previous.shipmentId}:${previous.stopId}:${observedAt}`,
            source: 'eld-geofence', truckId, shipmentId: previous.shipmentId,
            stopId: previous.stopId, facilityId: previous.siteId,
            evidence: 'gps-geofence-exit',
          })
          const billableMinutes = Math.max(0, dwellMs / 60_000 - DEFAULT_DETENTION_RULE.freeTimeMs / 60_000)
          if (billableMinutes > 0) {
            const claimId = `CLM-${previous.shipmentId}-${previous.stopId}`
            const roundedMinutes = Math.ceil(billableMinutes / DEFAULT_DETENTION_RULE.roundingMinutes) * DEFAULT_DETENTION_RULE.roundingMinutes
            events.push({
              type: EVENT.DETENTION_ELIGIBLE, observedAt, receivedAt: Date.now(),
              providerId: `eld:detention-eligible:${claimId}`, source: 'eld-geofence',
              claimId, shipmentId: previous.shipmentId, stopId: previous.stopId,
              ruleId: DEFAULT_DETENTION_RULE.id,
            })
            events.push({
              type: EVENT.DETENTION_CALCULATED, observedAt, receivedAt: Date.now(),
              providerId: `eld:detention-calculated:${claimId}`, source: 'eld-geofence',
              claimId, shipmentId: previous.shipmentId, stopId: previous.stopId,
              ruleId: DEFAULT_DETENTION_RULE.id, billableMinutes, roundedMinutes,
              amount: roundedMinutes / 60 * DEFAULT_DETENTION_RULE.ratePerHour,
              currency: DEFAULT_DETENTION_RULE.currency,
              uncertainty: 'service completion inferred from GPS geofence exit; review required',
            })
          }
        }
        fenceState.delete(truckId)
      }
    }

    const results = []
    for (const e of events) results.push(await base.ingestOne(e))
    return { ok: true, ingested: results.length }
  }

  /** Webhook handler: POST /api/integrations/eld/webhook */
  async function ingest(payload) {
    const list = Array.isArray(payload) ? payload : [payload]
    let total = 0
    for (const obs of list) {
      const r = await ingestOne(obs)
      if (r.ok) total += r.ingested || 0
    }
    health.recordSuccess('eld', 'eld')
    return { ok: true, ingested: total }
  }

  /** Pull-based polling (sample: no-op without ELD_API_URL configured). */
  async function poll() {
    if (!process.env.ELD_API_URL) return
    // A real implementation polls the ELD REST API here. The sample leaves it
    // to the webhook path; a carrier wires poll() to their vendor's endpoint.
  }

  return { name: 'eld', ingest, poll, ingestOne, health: base.health }
}
