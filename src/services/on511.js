import fixture from '../fixtures/on511-events.js'
import { CORRIDOR, offCorridorKm } from '../data/corridor.js'
import { chainageOf } from '../engine/geo.js'

/**
 * Ontario 511. Free, no key, throttled to 10 calls a minute — so we cache hard
 * and never poll near the ceiling. Two failure modes are expected and both fall
 * back to the bundled fixture: a dead connection, and CORS.
 *
 * CORS note: 511on.ca does not reliably send access-control headers, so a direct
 * browser fetch can fail even when the service is healthy. vite.config proxies
 * /api/511 in dev. A static production build needs an equivalent proxy (a
 * serverless function) or it runs on the fixture.
 *
 * Field casing is normalised defensively — verify against one live payload
 * before demo day rather than trusting this mapping.
 */
const BASE = import.meta.env?.DEV ? '/api/511' : 'https://511on.ca'
const TTL_MS = 5 * 60_000
const CORRIDOR_TOLERANCE_KM = 12

let cache = { at: 0, data: null, source: 'none' }

function normalise(raw) {
  const lat = Number(raw.Latitude ?? raw.latitude)
  const lon = Number(raw.Longitude ?? raw.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const coord = [lat, lon]
  // 511 covers the whole province; keep only what is on our corridor.
  if (offCorridorKm(coord) > CORRIDOR_TOLERANCE_KM) return null
  return {
    id: String(raw.ID ?? raw.id ?? Math.random()),
    road: raw.RoadwayName ?? raw.roadwayName ?? 'Unknown road',
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
  try {
    const res = await fetch(`${BASE}/api/v2/get/event?format=json&lang=en`, {
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) throw new Error(`511 responded ${res.status}`)
    const json = await res.json()
    const list = Array.isArray(json) ? json : (json?.events ?? [])
    const data = list.map(normalise).filter(Boolean)
    cache = { at: now, data, source: 'live' }
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
    const applies =
      inc.direction === 'Both' ||
      (direction === 1 && /east/i.test(inc.direction)) ||
      (direction === -1 && /west/i.test(inc.direction))
    if (!applies) continue
    const spread = inc.fullClosure ? 14 : 9
    const dist = Math.abs(chainage - inc.chainage)
    if (dist > spread) continue
    const intensity = 1 - dist / spread
    const worst = inc.fullClosure ? 0.25 : inc.type === 'roadwork' ? 0.7 : 0.55
    factor = Math.min(factor, 1 - (1 - worst) * intensity)
  }
  return factor
}
