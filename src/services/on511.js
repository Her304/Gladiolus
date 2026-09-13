import fixture from '../fixtures/on511-events.js'
import { CORRIDOR, offCorridorKm } from '../data/corridor.js'
import { chainageOf } from '../engine/geo.js'
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

/**
 * Ontario 511 (Phase C). The browser calls the server proxy
 * (/api/traffic/incidents); the server fetches 511on.ca so CORS and rate-limit
 * burden never reach the client. Field casing is normalised defensively and has
 * been checked against a live payload: all nine fields read below are present,
 * PascalCase, on all province-wide records. The lowercase fallbacks are
 * belt-and-braces, not a guess.
 *
 * Note: getToken is imported lazily inside fetchIncidents so this module can be
 * imported by the server (which only uses INITIAL_INCIDENTS + the helpers)
 * without pulling in the React AuthContext (.jsx).
 */
const TTL_MS = 5 * 60_000
const CORRIDOR_TOLERANCE_KM = 12

/**
 * Proximity alone is not enough. In southwestern Ontario the 401 runs within a
 * few kilometres of HWY 3, HWY 4, the 403 and the QEW, so a purely geometric
 * filter turns a ramp closure on another highway into a speed penalty on ours.
 * Measured against a live payload: 93 records pass the 12 km test and only 49
 * are actually on the 401.
 *
 * Matching the bare number rather than a spelling — the live feed says
 * "HWY 401", the bundled fixture says "Highway 401", other Ontario feeds say
 * "ON-401". The word boundaries are what keep "HWY 400" and "HWY 4" out, and
 * the geometry test still runs alongside this, so an exotic false positive
 * somewhere else in the province is caught by the other half of the filter.
 */
const ON_401 = /\b401\b/

let cache = { at: 0, data: null, source: 'none' }

function normalise(raw) {
  if (Array.isArray(raw?.coord) && Number.isFinite(raw.chainage)) return raw
  const lat = Number(raw.Latitude ?? raw.latitude)
  const lon = Number(raw.Longitude ?? raw.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const coord = [lat, lon]
  const road = raw.RoadwayName ?? raw.roadwayName ?? 'Unknown road'
  // 511 covers the whole province. Keep only what is on our corridor, by
  // geometry *and* by road name — see ON_401 above for why both are needed.
  if (offCorridorKm(coord) > CORRIDOR_TOLERANCE_KM) return null
  if (!ON_401.test(road)) return null
  return {
    id: String(raw.ID ?? raw.id ?? Math.random()),
    road,
    direction: raw.DirectionOfTravel ?? raw.directionOfTravel ?? 'Both',
    description: raw.Description ?? raw.description ?? '',
    type: raw.EventType ?? raw.eventType ?? 'unknown',
    fullClosure: Boolean(raw.IsFullClosure ?? raw.isFullClosure),
    updated: Number(raw.LastUpdated ?? raw.lastUpdated ?? 0) * 1000,
    coord,
    chainage: chainageOf(CORRIDOR, coord),
  }
}

const fromFixture = () => fixture.map(normalise).filter(Boolean)

/** Synchronous seed so the first render is never empty. */
export const INITIAL_INCIDENTS = fromFixture()

export async function fetchIncidents({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.data && now - cache.at < TTL_MS) return cache
  if (!SERVER_ENABLED) { cache = { at: now, data: fromFixture(), source: 'cached', reason: 'no server (local sim)' }; return cache }
  // Lazy import so the server (which imports INITIAL_INCIDENTS) doesn't pull in
  // the React AuthContext (.jsx). Only the browser fetch path needs the token.
  const { getToken } = await import('../auth/AuthContext.jsx')
  try {
    // The browser calls the server proxy (Phase C); the server fetches 511on.ca
    // so the key/CORS burden never reaches the client.
    const res = await fetch(apiUrl('/api/traffic/incidents'), {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`server responded ${res.status}`)
    const r = await res.json()
    const list = Array.isArray(r.data) ? r.data : []
    const data = list.map(normalise).filter(Boolean)
    cache = { at: now, data, source: r.source || 'cached' }
  } catch (err) {
    cache = { at: now, data: fromFixture(), source: 'cached', error: String(err) }
  }
  return cache
}

/**
 * Incidents become speed multipliers on a stretch of corridor. This is the
 * live edge weight from the routing model, applied to our one long edge: the
 * same two roads can swap from best to worst option within minutes.
 */
export function speedFactorAt(chainage, incidents, direction) {
  let factor = 1
  for (const inc of incidents) {
    if (!incidentApplies(inc, direction)) continue
    const spread = inc.fullClosure ? 14 : 9
    const dist = Math.abs(chainage - inc.chainage)
    if (dist > spread) continue
    const intensity = 1 - dist / spread
    const worst = inc.fullClosure ? 0.25 : inc.type === 'roadwork' ? 0.7 : 0.55
    factor = Math.min(factor, 1 - (1 - worst) * intensity)
  }
  return factor
}

/**
 * Does an incident apply to a truck's direction? The 511 vocabulary includes
 * "Both Directions" and "All Directions" (assessment §8: the old matcher only
 * recognized the bare word "Both" plus east/west text). This recognizes the full
 * documented set.
 */
export function incidentApplies(inc, direction) {
  const d = String(inc.direction || '').toLowerCase()
  if (/^(both|all)/.test(d)) return true
  if (direction === 1 && /east/.test(d)) return true
  if (direction === -1 && /west/.test(d)) return true
  return false
}

/**
 * Classify a full mainline closure as an impassable route edge, distinguishing
 * mainline from ramp-only (assessment §8: "A ramp closure and a mainline
 * closure cannot safely be treated as the same corridor penalty"). A full
 * closure makes the edge impassable; a non-closure incident only slows traffic.
 *
 * @returns {{impassable:boolean, closureKind?:'mainline'|'ramp', chainage:number}[]}
 */
export function closureEdges(incidents) {
  return (incidents || [])
    .filter((inc) => inc.fullClosure)
    .map((inc) => {
      // 511 event descriptions distinguish mainline from ramp; absent a parsed
      // ramp field, treat a full closure as mainline (the conservative read).
      const desc = String(inc.description || '').toLowerCase()
      const closureKind = /ramp|exit|entrance/.test(desc) ? 'ramp' : 'mainline'
      return { impassable: closureKind === 'mainline', closureKind, chainage: inc.chainage, direction: inc.direction }
    })
    .filter((e) => e.impassable)
}

/**
 * Incidents a truck has still to drive through, nearest first.
 *
 * These are already fetched, already filtered to the 401 and already folded
 * into the simulator's edge weights — the driver was simply never shown them.
 * Surfacing the same list costs nothing and answers the question a driver
 * actually has, which is not "how fast is the corridor" but "what is between me
 * and my stop".
 */
export function incidentsAhead(truck, incidents, withinKm = 120) {
  if (!truck) return []
  return incidents
    .filter((inc) => {
      if (!incidentApplies(inc, truck.direction)) return false
      const ahead = (inc.chainage - truck.chainage) * truck.direction
      return ahead > 0 && ahead <= withinKm
    })
    .map((inc) => ({ ...inc, ahead: (inc.chainage - truck.chainage) * truck.direction }))
    .sort((a, b) => a.ahead - b.ahead)
}

/** Shorter, human labels for the 511 event taxonomy. */
export function incidentLabel(type) {
  if (/closure/i.test(type)) return 'Closure'
  if (/accident|incident/i.test(type)) return 'Collision'
  if (/construction|roadwork/i.test(type)) return 'Construction'
  if (/weather|condition/i.test(type)) return 'Conditions'
  if (/special|event/i.test(type)) return 'Event'
  return 'Advisory'
}
