import { PARKING_SITES } from '../data/corridor.js'
import { clockLeftMs, reachableKm } from './hos.js'

/**
 * Fleet-as-sensor parking occupancy.
 *
 * No live truck-parking occupancy feed exists for Ontario, so we build one. Our
 * own trucks inside a rest-area geofence are a *sample* of everything parked
 * there. Scale that sample by our share of corridor traffic and you have an
 * occupancy estimate; where the sample is thin, fall back to the historical
 * curve for that site and hour. Live signal plus learned pattern — the same
 * blend a traffic layer uses, at a scale where forty trucks make it achievable.
 *
 * The share is a stated assumption, not a measurement. It is surfaced in the UI
 * on purpose: a number this load-bearing should not be invisible.
 */
export const FLEET_SHARE = 0.06

/** Our own units are counted, not inferred. Below this the sample is anecdote. */
const CONFIDENT_SAMPLE = 5

/**
 * Baseline utilisation by hour. Rest areas empty out overnight as drivers roll
 * at dawn, fill through the afternoon, and are effectively full from mid-evening
 * — the shape every driver on the 401 already knows.
 */
const BASE_CURVE = [
  0.92, 0.94, 0.95, 0.93, 0.86, 0.7, 0.48, 0.32, 0.25, 0.22, 0.24, 0.28, 0.33,
  0.38, 0.45, 0.53, 0.62, 0.71, 0.79, 0.86, 0.9, 0.92, 0.93, 0.93,
]

export function historicalUtilisation(site, date) {
  const h = date.getHours()
  const t = date.getMinutes() / 60
  const blended = BASE_CURVE[h] * (1 - t) + BASE_CURVE[(h + 1) % 24] * t
  // Small sites saturate sooner; the big inspection lots run cooler.
  const bias = site.spaces <= 22 ? 1.08 : site.spaces >= 34 ? 0.94 : 1
  return Math.min(1, blended * bias)
}

/**
 * Trucks that have not claimed a space but whose hours-of-service clock runs
 * out within reach of this site. These are the arrivals nobody has counted yet,
 * and they are why a lot that looks fine now is full in an hour.
 */
export function projectedArrivals(site, trucks, horizonMin = 90) {
  const out = []
  for (const t of Object.values(trucks)) {
    if (!t || t.insideSiteId || t.parked) continue
    if (t.direction !== 1 && t.direction !== -1) continue
    const ahead = (site.chainage - t.chainage) * t.direction
    if (ahead <= 0) continue
    const speed = Math.max(t.speedKph || 0, 40)
    const etaMin = (ahead / speed) * 60
    if (etaMin > horizonMin) continue
    // Only an arrival if the clock actually forces a stop by then.
    if (clockLeftMs(t) / 60_000 > horizonMin) continue
    if (ahead > reachableKm(t)) continue
    out.push({ truckId: t.id, etaMin, clockMin: clockLeftMs(t) / 60_000 })
  }
  return out.sort((a, b) => a.etaMin - b.etaMin)
}

export function pressureFor(site, world, date) {
  const state = world.sites[site.id] || { occupants: [], claims: [] }
  // Assessment §7: "The estimator counts all recorded geofence occupants,
  // including passing trucks, rather than only confirmed parked vehicles."
  // Exclude occupants that are still driving (passing through the fence) — only
  // trucks actually parked/resting/dwelling here count toward occupancy.
  const parkedOccupants = state.occupants.filter((id) => {
    const t = world.trucks[id]
    return t && t.state !== 'driving'
  })
  const observed = parkedOccupants.length
  const claims = state.claims.length
  const inbound = projectedArrivals(site, world.trucks)
  const historical = historicalUtilisation(site, date)

  // Scaling the sample up by our traffic share is only a good estimator when
  // the sample means something, so it is capped at capacity and blended with
  // the historical curve by confidence.
  const sampled = Math.min(site.spaces, observed / FLEET_SHARE)
  // Our own yard is not a sample of anything — nobody else parks in it, so the
  // occupancy is simply the count, at full confidence.
  const confidence = site.owned ? 1 : Math.min(1, observed / CONFIDENT_SAMPLE)
  const blended = site.owned
    ? observed
    : sampled * confidence + historical * site.spaces * (1 - confidence)

  // Never estimate fewer trucks than we can directly see. Our own units are
  // counted; only the rest of the lot is a guess.
  const occupied = Math.round(Math.max(observed, Math.min(site.spaces, blended)))
  const estimatedUtil = occupied / site.spaces
  const free = site.spaces - occupied
  // Assessment §7: "One claimed inbound truck is also counted both as a claim
  // and as projected demand." A truck that has already claimed this site is in
  // `claims`; don't also subtract it from `inbound`. Dedupe by truck id.
  const claimTruckIds = new Set(state.claims.map((c) => c.truckId))
  const netInbound = inbound.filter((t) => !claimTruckIds.has(t.truckId))
  const projectedFree = Math.max(0, free - claims - netInbound.length)

  let level = 'open'
  if (projectedFree === 0) level = 'full'
  else if (projectedFree <= 2 || estimatedUtil > 0.85) level = 'tight'
  else if (estimatedUtil > 0.65) level = 'filling'

  return {
    site,
    observed,
    claims,
    inbound: netInbound,
    historical,
    confidence,
    estimatedUtil,
    occupied,
    free,
    projectedFree,
    level,
  }
}

export function pressureBoard(world, date) {
  return PARKING_SITES.map((s) => pressureFor(s, world, date))
}

/**
 * Best rest area for a truck: ahead of it and inside the remaining clock.
 *
 * Returns null only when nothing at all is reachable — that is the genuine
 * alert, the driver is going to run out of hours between rest areas. When every
 * reachable site is projected full we still return the least-bad one with
 * `viable: false`, because "Putnam at 88%, and it is your only chance" is a
 * decision a dispatcher can act on and null is not.
 */
export function recommendParking(truck, world, date) {
  if (!truck) return null
  const reach = reachableKm(truck)
  const options = pressureBoard(world, date)
    .map((p) => ({ ...p, ahead: (p.site.chainage - truck.chainage) * truck.direction }))
    .filter((p) => p.ahead > 0 && p.ahead <= reach)

  if (!options.length) return null

  const scored = options.map((p) => ({
    ...p,
    // Prefer slack, then prefer using more of the available clock so the driver
    // is not stopping two hours early for no reason.
    score: p.projectedFree * 10 + (p.ahead / reach) * 6 - p.estimatedUtil * 8,
  }))
  scored.sort((a, b) => b.score - a.score)

  return {
    best: scored[0],
    alternatives: scored.slice(1, 3),
    reach,
    viable: scored[0].projectedFree > 0,
  }
}
