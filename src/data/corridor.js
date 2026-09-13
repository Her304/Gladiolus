import { measurePath, chainageOf, haversine, positionAt } from '../engine/geo.js'
import { APPROACH_KM } from '../contract.js'

/**
 * Highway 401, Windsor -> Scarborough. Ordered west to east, so chainage
 * increases eastbound. Coarse by design: these stable points are the simulation
 * spine, while the driver map uses a separate road-snapped display trace.
 */
export const CORRIDOR_POINTS = [
  [42.3149, -83.0364], // Windsor
  [42.2559, -82.4363], // Tilbury
  [42.4048, -82.191], // Chatham
  [42.4383, -81.8836], // Ridgetown
  [42.6221, -81.6134], // West Lorne
  [42.9339, -81.2497], // London (401 runs south of the city)
  [43.0392, -80.8828], // Ingersoll
  [43.1301, -80.746], // Woodstock
  [43.2557, -80.4507], // Ayr
  [43.3616, -80.3144], // Cambridge
  [43.4668, -79.9899], // Milton
  [43.589, -79.6441], // Mississauga
  [43.7615, -79.5108], // 401 & 400
  [43.777, -79.345], // Scarborough
]

export const CORRIDOR = measurePath(CORRIDOR_POINTS)

/**
 * Sites the fleet visits. `stop` sites are customer and DC geofences; `parking`
 * sites are rest areas, where the fleet-as-sensor occupancy model applies.
 * `radiusM` is the geofence radius; `spaces` means anything only for parking.
 *
 * `facilities` is static reference data, deliberately unlike everything else in
 * this file: nothing about it is sensed. It exists because a driver picking
 * between two reachable lots is choosing on showers and food once parking is
 * settled, and answering that inside the stop card saves a second app. Ids come
 * from FACILITIES below so the labels stay consistent across surfaces.
 */
const RAW_SITES = [
  { id: 'wds-xdock', name: 'Windsor Cross-Dock', kind: 'stop', coord: [42.3072, -83.0181], radiusM: 400 },
  { id: 'chatham-pt', name: 'Chatham Produce Terminal', kind: 'stop', coord: [42.4102, -82.1875], radiusM: 350 },
  { id: 'london-dc', name: 'London Distribution Centre', kind: 'stop', coord: [42.9481, -81.2312], radiusM: 450 },
  { id: 'woodstock-plant', name: 'Woodstock Assembly Plant', kind: 'stop', coord: [43.1418, -80.7331], radiusM: 500 },
  { id: 'cambridge-dc', name: 'Cambridge DC', kind: 'stop', coord: [43.3701, -80.3022], radiusM: 400 },
  { id: 'milton-intermodal', name: 'Milton Intermodal', kind: 'stop', coord: [43.4731, -79.9772], radiusM: 550 },
  { id: 'mississauga-dc', name: 'Mississauga DC', kind: 'stop', coord: [43.5951, -79.6382], radiusM: 400 },
  { id: 'scarborough-term', name: 'Scarborough Terminal', kind: 'stop', coord: [43.7801, -79.3388], radiusM: 400 },

  { id: 'onr-tilbury', name: 'ONroute Tilbury', kind: 'parking', coord: [42.2596, -82.4221], radiusM: 260, spaces: 28, facilities: ['washroom', 'food', 'coffee', 'open24', 'overnight'] },
  { id: 'onr-westlorne', name: 'ONroute West Lorne', kind: 'parking', coord: [42.6258, -81.6021], radiusM: 260, spaces: 22, facilities: ['washroom', 'food', 'coffee', 'open24', 'overnight'] },
  { id: 'putnam-lot', name: 'Putnam Truck Inspection Lot', kind: 'parking', coord: [42.9928, -81.0495], radiusM: 300, spaces: 40, facilities: ['washroom', 'overnight', 'level'] },
  { id: 'onr-woodstock', name: 'ONroute Woodstock', kind: 'parking', coord: [43.1339, -80.7318], radiusM: 260, spaces: 34, facilities: ['washroom', 'shower', 'food', 'coffee', 'open24', 'overnight', 'pullthrough'] },
  { id: 'onr-cambridge', name: 'ONroute Cambridge North', kind: 'parking', coord: [43.3661, -80.3011], radiusM: 260, spaces: 26, facilities: ['washroom', 'food', 'coffee', 'open24', 'overnight'] },
  { id: 'onr-trafalgar', name: 'ONroute Trafalgar', kind: 'parking', coord: [43.4712, -79.9741], radiusM: 260, spaces: 18, facilities: ['washroom', 'food', 'coffee', 'open24', 'overnight'] },

  // Our own yards. Both ends of the corridor are otherwise bare — the last
  // public rest area eastbound is at km 298 of 363 — so a clock that expires
  // near Toronto or Windsor has nowhere legal to go. `owned` sites need no
  // occupancy estimate: we can count our own yard exactly.
  { id: 'yard-windsor', name: 'Gladiolus Yard, Windsor', kind: 'parking', owned: true, coord: [42.2996, -82.9401], radiusM: 300, spaces: 20, facilities: ['washroom', 'shower', 'overnight', 'secure', 'level', 'pullthrough'] },
  { id: 'yard-etobicoke', name: 'Gladiolus Yard, Etobicoke', kind: 'parking', owned: true, coord: [43.6979, -79.5646], radiusM: 300, spaces: 24, facilities: ['washroom', 'shower', 'food', 'overnight', 'secure', 'level', 'pullthrough'] },
]

/**
 * Facility labels, defined once. A driver reads these as chips on a stop card,
 * so they are phrased as the thing itself ("Showers") and never as a rating.
 * `key` facilities are the ones worth surfacing in a one-line summary.
 */
export const FACILITIES = [
  { id: 'washroom', label: 'Washrooms', key: true },
  { id: 'shower', label: 'Showers', key: true },
  { id: 'food', label: 'Hot food', key: true },
  { id: 'coffee', label: 'Coffee' },
  { id: 'open24', label: 'Open 24h' },
  { id: 'overnight', label: 'Overnight OK', key: true },
  { id: 'secure', label: 'Secured yard' },
  { id: 'level', label: 'Level surface' },
  { id: 'pullthrough', label: 'Pull-through' },
]
export const FACILITY_BY_ID = Object.fromEntries(FACILITIES.map((f) => [f.id, f]))

/** Facility objects for a site, in FACILITIES order so cards stay consistent. */
export function facilitiesOf(site) {
  const have = new Set(site?.facilities || [])
  return FACILITIES.filter((f) => have.has(f.id))
}

/** Every site carries its chainage, so route projection is a scalar compare. */
export const SITES = RAW_SITES.map((s) => ({
  ...s,
  chainage: chainageOf(CORRIDOR, s.coord),
}))

/** Immutable reset values for the server-backed capacity configuration. */
export const BASE_SITE_CAPACITIES = Object.freeze(Object.fromEntries(
  RAW_SITES.filter((s) => s.kind === 'parking').map((s) => [s.id, s.spaces]),
))

export const SITE_BY_ID = Object.fromEntries(SITES.map((s) => [s.id, s]))
export const PARKING_SITES = SITES.filter((s) => s.kind === 'parking').sort(
  (a, b) => a.chainage - b.chainage,
)
export const STOP_SITES = SITES.filter((s) => s.kind === 'stop')

/**
 * MTO truck inspection stations on the corridor.
 *
 * Kept out of RAW_SITES on purpose. These are not places the fleet visits, so
 * they get no geofence, no occupancy model and no place in the dwell league
 * table — a truck passing an open scale is a thirty-second event, not a visit.
 * What matters to a driver is only whether it is open, and that is estimated
 * from how our trucks behave going past. See engine/scales.js.
 *
 * `postedHours` is the sign at the ramp. It is a schedule, not a promise: MTO
 * opens and closes these at will, which is precisely why the fleet signal is
 * worth having.
 */
const RAW_SCALES = [
  { id: 'scale-tilbury', name: 'Tilbury Inspection Station', coord: [42.2617, -82.4021], direction: 1, postedHours: '06:00–22:00' },
  { id: 'scale-westlorne', name: 'West Lorne Inspection Station', coord: [42.6142, -81.5786], direction: -1, postedHours: '06:00–22:00' },
  { id: 'scale-putnam', name: 'Putnam Inspection Station', coord: [42.9951, -81.0402], direction: 1, postedHours: '24 hours' },
  { id: 'scale-woodstock', name: 'Woodstock Inspection Station', coord: [43.1247, -80.7801], direction: -1, postedHours: '06:00–22:00' },
  { id: 'scale-milton', name: 'Milton Inspection Station', coord: [43.4791, -79.9312], direction: 1, postedHours: '24 hours' },
]

export const SCALE_SITES = RAW_SCALES.map((s) => ({
  ...s,
  kind: 'scale',
  chainage: chainageOf(CORRIDOR, s.coord),
})).sort((a, b) => a.chainage - b.chainage)

export const SCALE_BY_ID = Object.fromEntries(SCALE_SITES.map((s) => [s.id, s]))

/**
 * Roadside service the carrier actually has an account with.
 *
 * A generic "repair shops near me" list is the wrong product: on a live 401
 * shoulder a driver needs the one number the carrier will pay, not ten options
 * to evaluate. So this is a short vendor book keyed to a stretch of corridor,
 * and the breakdown flow picks from it rather than asking the driver to choose.
 *
 * `covers` is the chainage span each vendor will roll to, in km. Spans overlap
 * deliberately — a second name matters when the first one cannot come out.
 */
const RAW_VENDORS = [
  { id: 'v-windsor-tire', name: 'Windsor Commercial Tire', phone: '+1-519-555-0143', services: ['tire'], covers: [0, 95], hours: '24h', etaMin: 55 },
  { id: 'v-chatham-truck', name: 'Chatham Truck & Trailer', phone: '+1-519-555-0188', services: ['mechanical', 'tire', 'reefer'], covers: [40, 150], hours: '07:00–19:00', etaMin: 70 },
  { id: 'v-london-fleet', name: 'London Fleet Service', phone: '+1-519-555-0271', services: ['mechanical', 'tire', 'reefer'], covers: [110, 235], hours: '24h', etaMin: 50 },
  { id: 'v-401-towing', name: 'Corridor Heavy Towing', phone: '+1-800-555-0119', services: ['tow'], covers: [0, 363], hours: '24h', etaMin: 80 },
  { id: 'v-woodstock-reefer', name: 'Woodstock Reefer Service', phone: '+1-519-555-0332', services: ['reefer'], covers: [180, 280], hours: '07:00–22:00', etaMin: 60 },
  { id: 'v-cambridge-truck', name: 'Cambridge Truck Centre', phone: '+1-519-555-0404', services: ['mechanical', 'tire'], covers: [225, 305], hours: '24h', etaMin: 45 },
  { id: 'v-gta-mobile', name: 'GTA Mobile Truck Repair', phone: '+1-905-555-0166', services: ['mechanical', 'tire', 'reefer'], covers: [285, 363], hours: '24h', etaMin: 40 },
]

export const SERVICE_VENDORS = RAW_VENDORS

/**
 * Vendors that cover a point on the corridor, nearest-responding first. The
 * ordering is by stated response time, not distance: a mobile unit 60 km away
 * that is already rolling beats a shop 10 km away that closed at seven.
 */
export function vendorsNear(chainage, service = null) {
  return SERVICE_VENDORS.filter(
    (v) =>
      chainage >= v.covers[0] &&
      chainage <= v.covers[1] &&
      (!service || v.services.includes(service)),
  ).sort((a, b) => a.etaMin - b.etaMin)
}

export const VENDOR_BY_ID = Object.fromEntries(SERVICE_VENDORS.map((v) => [v.id, v]))

/** Smallest geofence on the corridor — the simulator's sub-step budget. */
export const MIN_FENCE_M = Math.min(...SITES.map((s) => s.radiusM))

/** How far off the corridor a coordinate sits, in km. Used to filter 511. */
export function offCorridorKm(coord) {
  return haversine(coord, positionAt(CORRIDOR, chainageOf(CORRIDOR, coord)))
}

/**
 * Sites a truck could never actually reach, because they sit further off the
 * driven line than the approach blend extends. An empty list is a precondition
 * for any geofence firing at all.
 */
export function unreachableSites() {
  return SITES.filter((s) => offCorridorKm(s.coord) > APPROACH_KM)
}
