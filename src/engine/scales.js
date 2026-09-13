import { SCALE_SITES } from '../data/corridor.js'

/**
 * Fleet-as-sensor inspection-station status.
 *
 * The same trick as parking, pointed at a second problem. No feed publishes
 * whether an MTO scale is open — the posted hours on the ramp are a schedule
 * MTO departs from at will — but an open station is *visible in our own
 * telemetry*, because every truck that passes one must enter it. Trucks
 * decelerating at a known chainage are the signal; trucks sailing past at
 * corridor speed are the opposite signal, and just as useful.
 *
 * What makes this honest rather than a guess is the control. Congestion also
 * slows trucks, so a bare "slow trucks near the scale" test would call every
 * traffic jam an open scale. Instead the trucks in the band are compared
 * against the ambient speed of the fleet on the same stretch of corridor. Only
 * a divergence counts — slow *relative to everyone else nearby* is a ramp, slow
 * along with everyone else is traffic.
 */

/** How far either side of the station a truck is close enough to observe, km. */
const BAND_KM = 3

/**
 * The stretch the ambient speed is measured over. Wide enough to hold trucks
 * unaffected by the station, narrow enough that they are in the same weather,
 * the same construction zone and the same time of day.
 */
const AMBIENT_KM = 25

/** Below this share of ambient speed, a truck is stopping rather than rolling. */
const SLOW_RATIO = 0.6

/** Nothing on this corridor cruises faster; the fallback when no ambient exists. */
const FREE_FLOW_KPH = 95

/** Under this many observations the sample is anecdote, as with parking. */
const CONFIDENT_SAMPLE = 3

/**
 * Prior probability that a station is open, before any truck is looked at.
 *
 * A stated assumption, surfaced in the UI for the same reason FLEET_SHARE is:
 * a number this load-bearing should not be invisible. Staffed stations run
 * mostly in daylight on weekdays, and a "24 hours" sign means the station may
 * open at any hour, not that it is always open.
 */
const PRIOR_IN_HOURS = 0.55
const PRIOR_ALL_HOURS = 0.4
const PRIOR_OUT_OF_HOURS = 0.08

/** Weekend enforcement drops off sharply; commercial traffic does too. */
const WEEKEND_FACTOR = 0.45

function withinPostedHours(site, date) {
  if (site.postedHours === '24 hours') return true
  const m = /^(\d{2}):(\d{2})[–-](\d{2}):(\d{2})$/.exec(site.postedHours || '')
  if (!m) return true
  const mins = date.getHours() * 60 + date.getMinutes()
  const from = +m[1] * 60 + +m[2]
  const to = +m[3] * 60 + +m[4]
  return from <= to ? mins >= from && mins < to : mins >= from || mins < to
}

/** The time-of-day prior, before the fleet is consulted. 0-1. */
export function historicalOpen(site, date) {
  const inHours = withinPostedHours(site, date)
  const base = !inHours
    ? PRIOR_OUT_OF_HOURS
    : site.postedHours === '24 hours'
      ? PRIOR_ALL_HOURS
      : PRIOR_IN_HOURS
  const day = date.getDay()
  return day === 0 || day === 6 ? base * WEEKEND_FACTOR : base
}

/**
 * Median rather than mean: one truck stopped on the shoulder with a flat should
 * not drag the ambient speed down and make a closed station look open.
 */
function median(list) {
  if (!list.length) return null
  const s = [...list].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Status for one station.
 *
 * `history` is optional: a list of past `{ at, slowed, samples }` observations
 * the engine may accumulate as it folds pings. Views work without it — they
 * just fall back to the instantaneous sample, which is usually empty on a fleet
 * this size, which is exactly when the prior should be doing the work anyway.
 */
export function scaleStatus(site, world, date, history = []) {
  const trucks = Object.values(world.trucks || {})
  const inBand = []
  const ambientSpeeds = []

  for (const t of trucks) {
    if (!t || t.parked || t.insideSiteId) continue
    // A station serves one carriageway. A westbound truck tells us nothing
    // about the eastbound scale it is passing on the far side of the median.
    if (site.direction && t.direction !== site.direction) continue
    const gap = Math.abs(t.chainage - site.chainage)
    if (gap <= BAND_KM) inBand.push(t)
    else if (gap <= AMBIENT_KM && t.state === 'driving') ambientSpeeds.push(t.speedKph || 0)
  }

  const ambient = median(ambientSpeeds) ?? FREE_FLOW_KPH
  // Deliberately relative, with no absolute floor. A floor would re-introduce
  // the bug this control exists to prevent: in a jam every truck is under any
  // fixed speed, and the station would read as open because the corridor is
  // stopped. When ambient itself collapses, nothing is inferred — which is the
  // honest answer, because in gridlock the signal genuinely is not there.
  const threshold = ambient * SLOW_RATIO
  const liveSlowed = inBand.filter((t) => (t.speedKph || 0) < threshold).length

  // Recent history counts alongside the current instant. A station does not
  // open and close minute to minute, so an observation from twenty minutes ago
  // is still evidence — decayed, but evidence.
  const recent = history.filter((h) => date.getTime() - h.at <= 60 * 60_000)
  const samples = inBand.length + recent.reduce((n, h) => n + h.samples, 0)
  const slowed = liveSlowed + recent.reduce((n, h) => n + h.slowed, 0)

  const historical = historicalOpen(site, date)
  const confidence = Math.min(1, samples / CONFIDENT_SAMPLE)
  const observed = samples ? slowed / samples : 0
  const probability = observed * confidence + historical * (1 - confidence)

  let level = 'unknown'
  if (confidence >= 1) level = probability >= 0.5 ? 'open' : 'closed'
  else if (probability >= 0.6) level = 'likely-open'
  else if (probability <= 0.2) level = 'likely-closed'

  const lastSeenAt = recent.length ? Math.max(...recent.map((h) => h.at)) : inBand.length ? date.getTime() : null

  return { site, samples, slowed, ambient, historical, confidence, probability, level, lastSeenAt }
}

export function scaleBoard(world, date, history = {}) {
  return SCALE_SITES.map((s) => scaleStatus(s, world, date, history[s.id] || []))
}

/**
 * Stations a truck has still to pass, nearest first. A scale behind you is not
 * a decision, so it is not shown.
 */
export function scalesAhead(truck, world, date, history = {}) {
  if (!truck) return []
  return scaleBoard(world, date, history)
    .map((s) => ({ ...s, ahead: (s.site.chainage - truck.chainage) * truck.direction }))
    .filter((s) => s.ahead > 0 && (!s.site.direction || s.site.direction === truck.direction))
    .sort((a, b) => a.ahead - b.ahead)
}
