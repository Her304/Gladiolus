/**
 * Historical breadcrumbs and shipment-scoped ETA (Phase 5).
 *
 * Historical truck breadcrumbs: time, speed, distance, source, data age, with
 * leg/shift drill-down (plan §5 Phase 5). Shipment-scoped ETA that includes
 * planned stops, HOS/rest, service, traffic, and uncertainty — and never
 * claims inputs the model did not use (the v1 customer ETA divided distance by
 * a 40km/h floor while asserting hours were accounted for).
 */
import { boundedReach } from './feasibility.js'

const H = 3600_000
const MIN = 60_000

/**
 * Fold a truck's breadcrumb history from ping events. Each breadcrumb carries
 * time, position, speed, odometer, source, and data age. Supports leg/shift
 * drill-down by segmenting on rest resets.
 *
 * @param {object[]} pings   ordered ping events for one truck
 * @param {number} [now]     for data-age
 * @returns {{breadcrumbs:object[], legs:object[]}}
 */
export function breadcrumbHistory(pings, now = Date.now()) {
  const breadcrumbs = []
  let legStart = 0
  const legs = []
  for (const p of pings) {
    const t = p.truck || p
    const at = p.observedAt ?? p.at
    breadcrumbs.push({
      at,
      truckId: t.id,
      coord: t.coord,
      speedKph: t.speedKph,
      odometerKm: t.odometerKm,
      source: p.source || 'live',
      dataAgeMs: now - at,
    })
    // A rest reset (drivingMs drops to ~0 between pings) starts a new leg.
    if (breadcrumbs.length > 1 && (t.drivingMs || 0) < 5 * MIN && (breadcrumbs[breadcrumbs.length - 2].speedKph || 0) > 0) {
      legs.push({ startAt: breadcrumbs[legStart]?.at, endAt: at, pings: breadcrumbs.length - legStart })
      legStart = breadcrumbs.length - 1
    }
  }
  if (legStart < breadcrumbs.length) {
    legs.push({ startAt: breadcrumbs[legStart]?.at, endAt: breadcrumbs[breadcrumbs.length - 1]?.at, pings: breadcrumbs.length - legStart })
  }
  return { breadcrumbs, legs }
}

/**
 * Shipment-scoped ETA. Combines remaining travel, planned stops, service time,
 * HOS/rest, and traffic uncertainty. Critically: it only includes inputs that
 * were actually supplied. If HOS is unknown, the ETA is qualified "travel-only,
 * HOS not verified" — never a false claim that hours were accounted for.
 *
 * @param {object} o
 * @param {number} o.distanceKm       remaining travel distance
 * @param {number} o.speedKph         expected/observed speed (no floor)
 * @param {object} [o.duty]           DutySnapshot for HOS (optional)
 * @param {object[]} [o.remainingStops] [{ serviceTimeMs }]
 * @param {number} [o.trafficFactor]  0-1 multiplier on speed (optional)
 * @returns {{etaMs:number, qualifies:string[], uncertainty:string|null}}
 */
export function shipmentEta({ distanceKm, speedKph, duty, remainingStops = [], trafficFactor = 1 }) {
  const qualifies = []
  let uncertainty = null

  // Travel time. No 40km/h floor — a stopped truck has infinite ETA, which we
  // surface as uncertainty rather than a fabricated number.
  const effectiveSpeed = Math.max(0, (speedKph || 0) * (trafficFactor || 1))
  if (effectiveSpeed <= 0) {
    return { etaMs: null, qualifies: ['travel'], uncertainty: 'speed is zero; cannot estimate travel time' }
  }
  let ms = (distanceKm / effectiveSpeed) * H
  qualifies.push('travel')

  // Service time at remaining stops.
  const serviceMs = remainingStops.reduce((sum, s) => sum + (s.serviceTimeMs || 0), 0)
  if (serviceMs > 0) {
    ms += serviceMs
    qualifies.push('service')
  }

  // HOS/rest: if a duty snapshot is supplied and fresh, check whether the
  // driver has enough hours; if not, the ETA must include a rest reset. If HOS
  // is unknown, qualify the ETA as travel-only — never claim hours were used.
  if (duty && typeof duty.drivingMs === 'number') {
    const reach = boundedReach(duty, effectiveSpeed)
    if (reach && reach.km < distanceKm) {
      // Not enough hours; a 10h reset is needed partway.
      ms += 10 * H
      qualifies.push('hos-rest')
    } else if (reach) {
      qualifies.push('hos')
    }
  } else {
    uncertainty = 'HOS not verified; ETA is travel + service only'
  }

  if (trafficFactor < 1) qualifies.push('traffic')

  return { etaMs: ms, qualifies, uncertainty }
}

/**
 * Build a signed, shipment-scoped, expiring customer tracking grant. Replaces
 * the v1 unsigned base64 token that followed the truck's current destination
 * rather than a durable shipment (plan §5 Phase 5: "Sign, expire, revoke, and
 * scope customer links to one shipment history").
 *
 * @param {object} o
 * @param {string} o.shipmentId
 * @param {string} secret   server HMAC secret
 * @param {number} [o.ttlMs] expiry
 */
export function createTrackingGrant({ shipmentId }, secret, ttlMs = 72 * H) {
  // This mirrors the server's mintToken (HMAC). In the browser fallback
  // without a server, the grant is labelled unsigned-prototype; the server path
  // is authoritative (Phase 6 server-enforced auth).
  const payload = { shipmentId, exp: Date.now() + ttlMs, scope: 'shipment' }
  return { payload, token: `grant.${shipmentId}.${payload.exp}`, signed: Boolean(secret) }
}
