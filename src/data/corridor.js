import { measurePath, chainageOf, haversine, positionAt } from '../engine/geo.js'
import { APPROACH_KM } from '../contract.js'

/**
 * Highway 401, Windsor -> Scarborough. Ordered west to east, so chainage
 * increases eastbound. Coarse by design: a dozen vertices drives the demo and
 * keeps the map render cheap.
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

  { id: 'onr-tilbury', name: 'ONroute Tilbury', kind: 'parking', coord: [42.2596, -82.4221], radiusM: 260, spaces: 28 },
  { id: 'onr-westlorne', name: 'ONroute West Lorne', kind: 'parking', coord: [42.6258, -81.6021], radiusM: 260, spaces: 22 },
  { id: 'putnam-lot', name: 'Putnam Truck Inspection Lot', kind: 'parking', coord: [42.9928, -81.0495], radiusM: 300, spaces: 40 },
  { id: 'onr-woodstock', name: 'ONroute Woodstock', kind: 'parking', coord: [43.1339, -80.7318], radiusM: 260, spaces: 34 },
  { id: 'onr-cambridge', name: 'ONroute Cambridge North', kind: 'parking', coord: [43.3661, -80.3011], radiusM: 260, spaces: 26 },
  { id: 'onr-trafalgar', name: 'ONroute Trafalgar', kind: 'parking', coord: [43.4712, -79.9741], radiusM: 260, spaces: 18 },

  // Our own yards. Both ends of the corridor are otherwise bare — the last
  // public rest area eastbound is at km 298 of 363 — so a clock that expires
  // near Toronto or Windsor has nowhere legal to go. `owned` sites need no
  // occupancy estimate: we can count our own yard exactly.
  { id: 'yard-windsor', name: 'Gladiolus Yard, Windsor', kind: 'parking', owned: true, coord: [42.2996, -82.9401], radiusM: 300, spaces: 20 },
  { id: 'yard-etobicoke', name: 'Gladiolus Yard, Etobicoke', kind: 'parking', owned: true, coord: [43.6979, -79.5646], radiusM: 300, spaces: 24 },
]

/** Every site carries its chainage, so route projection is a scalar compare. */
export const SITES = RAW_SITES.map((s) => ({
  ...s,
  chainage: chainageOf(CORRIDOR, s.coord),
}))

export const SITE_BY_ID = Object.fromEntries(SITES.map((s) => [s.id, s]))
export const PARKING_SITES = SITES.filter((s) => s.kind === 'parking').sort(
  (a, b) => a.chainage - b.chainage,
)
export const STOP_SITES = SITES.filter((s) => s.kind === 'stop')

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
